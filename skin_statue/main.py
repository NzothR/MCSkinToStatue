"""FastAPI 本地服务：无持久化的皮肤解析接口和离线前端。"""

import json
import logging
from pathlib import Path
from typing import Annotated, Literal

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from skin_statue.core.palette import Palette
from skin_statue.core.skin import parse_skin
from skin_statue.resources.instance import InstanceResources
from skin_statue.resources.registry import import_runtime_index, vanilla_palette

WEB = Path(__file__).parent / "web"
app = FastAPI(title="Skin Statue · 皮肤预览", docs_url=None, redoc_url=None)
PALETTES: dict[str, Palette] = {}


class ScanRequest(BaseModel):
    """用户指定的只读实例路径及可选的原版 JAR 路径。"""

    directory: str = Field(min_length=1)
    vanilla_jar: str | None = None


class MatchRequest(BaseModel):
    """一个颜色与表面朝向的静态匹配请求。"""

    rgb: tuple[int, int, int]
    face: Literal["east", "west", "up", "down", "south", "north"] = "south"
    smoothness: float = Field(default=0.2, ge=0, le=1)
    excluded: set[str] = Field(default_factory=set)


def get_palette(identity: str) -> Palette:
    """读取本次服务运行中导入的调色板。"""
    if identity not in PALETTES:
        raise HTTPException(404, "调色板尚未加载，请重新扫描实例或导入索引。")
    return PALETTES[identity]


@app.get("/")
def index() -> FileResponse:
    """打开本地预览界面。"""
    return FileResponse(WEB / "index.html")


@app.post("/api/skin")
async def import_skin(
    file: Annotated[UploadFile, File()],
    model: Annotated[Literal["steve", "alex"], Form()] = "steve",
) -> dict:
    """读取上传的 PNG 并解析；图片不写入服务器磁盘。"""
    try:
        data = await file.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024:
            raise HTTPException(413, "皮肤文件需小于 2 MB。")
        try:
            return await run_in_threadpool(parse_skin, data, model)
        except ValueError as exc:
            logging.getLogger(__name__).debug("Skin import rejected: %s", exc)
            raise HTTPException(422, str(exc)) from exc
    finally:
        await file.close()


@app.post("/api/resources/scan")
async def scan_instance(request: ScanRequest) -> dict:
    """只读扫描实例并创建原版起步调色板，报告资源包覆盖。"""

    def scan() -> dict:
        resources = InstanceResources(request.directory, request.vanilla_jar)
        palette = vanilla_palette(resources)
        PALETTES[palette.id] = palette
        return {"scan": resources.summary(), "palette": palette.summary()}

    try:
        return await run_in_threadpool(scan)
    except (ValueError, OSError) as exc:
        raise HTTPException(422, str(exc)) from exc


@app.post("/api/resources/index")
async def load_index(file: Annotated[UploadFile, File()]) -> dict:
    """读取游戏辅助模组导出的 ZIP，并计算逐面颜色。"""
    try:
        data = await file.read(128 * 1024 * 1024 + 1)
        if len(data) > 128 * 1024 * 1024:
            raise HTTPException(413, "索引 ZIP 文件需不超过 128 MB。")
        try:
            palette = await run_in_threadpool(import_runtime_index, data)
        except (ValueError, OSError) as exc:
            raise HTTPException(422, str(exc)) from exc
        PALETTES[palette.id] = palette
        return {"palette": palette.summary()}
    finally:
        await file.close()


@app.get("/api/palettes/{identity}/entries")
def palette_entries(
    identity: str,
    search: str = "",
    eligible_only: bool = False,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=40, ge=1, le=100),
) -> dict:
    """按名称和候选状态分页浏览方块，避免一次传输完整注册表。"""
    palette = get_palette(identity)
    needle = search.casefold()
    entries = [
        entry
        for entry in palette.entries
        if needle in entry["key"].casefold() and (not eligible_only or entry["eligible"])
    ]
    return {"entries": entries[offset : offset + limit], "total": len(entries), "offset": offset}


@app.get("/api/palettes/{identity}/textures/{texture_id}")
def palette_texture(identity: str, texture_id: str) -> Response:
    """返回生成颜色统计时读取的原始纹理 PNG。"""
    palette = get_palette(identity)
    if texture_id not in palette.textures:
        raise HTTPException(404, "纹理不存在。")
    return Response(palette.textures[texture_id], media_type="image/png")


@app.get("/api/palettes/{identity}/export")
def export_palette(identity: str) -> Response:
    """下载逐面调色板和排除报告 JSON，原纹理仍由原始索引 ZIP 保留。"""
    palette = get_palette(identity)
    payload = {
        "format": "skin-statue-palette",
        "schema_version": 1,
        **palette.summary(),
        "entries": palette.entries,
    }
    return Response(
        json.dumps(payload, ensure_ascii=False, indent=2),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="palette-{identity}.json"'},
    )


@app.post("/api/palettes/{identity}/match")
def match_color(identity: str, request: MatchRequest) -> dict:
    """提供朝向相关的 Lab 颜色匹配接口；整雕像生成在 GTNH 索引确认后接入。"""
    if any(channel < 0 or channel > 255 for channel in request.rgb):
        raise HTTPException(422, "RGB 分量必须为 0～255。")
    try:
        return get_palette(identity).match(
            request.rgb, request.face, request.smoothness, request.excluded
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get("/api/statue/capabilities")
def statue_capabilities() -> dict:
    """声明下一步生成约定，当前接口如实报告尚未实现整雕像生成。"""
    return {
        "generation_available": False,
        "status": "awaiting_gtnh_runtime_index_verification",
        "planned_scales": [1, 2, 3, 4, 5, 6],
        "planned_base_heights": [32, 64, 96, 128, 160, 192],
        "palette_match_available": True,
    }


app.mount("/static", StaticFiles(directory=WEB), name="static")
