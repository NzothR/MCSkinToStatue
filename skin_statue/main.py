"""FastAPI 本地服务：皮肤解析、雕像编辑、工程与草稿。"""

import base64
import hashlib
import json
import logging
from collections import OrderedDict
from datetime import datetime
from pathlib import Path
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from skin_statue.core.editing import (
    block_at,
    open_project,
    project_bytes,
    ranked_candidates,
    replace_material,
)
from skin_statue.core.palette import Palette
from skin_statue.core.schematic import PROFILES, export_bundle, placement, schematic_bytes
from skin_statue.core.skin import parse_skin
from skin_statue.core.statue import GeneratedStatue, generate_statue
from skin_statue.resources.instance import InstanceResources
from skin_statue.resources.java_skin import fetch_skin
from skin_statue.resources.registry import import_runtime_index, vanilla_palette

WEB = Path(__file__).parent / "web"
app = FastAPI(title="Skin Statue · 皮肤预览", docs_url=None, redoc_url=None)
PALETTES: dict[str, Palette] = {}
STATUES: OrderedDict[str, GeneratedStatue] = OrderedDict()
PROJECT = WEB.parents[1]
DRAFTS = PROJECT / "drafts"


class Replacement(BaseModel):
    """整类替换按注册名和 Metadata 精确指定源与目标。"""

    source: str
    target: str


class UsernameRequest(BaseModel):
    """公开档案查询只需要 Java 用户名。"""

    username: str


@app.exception_handler(ValueError)
async def invalid_input(request, exc):
    """向编辑和工程界面传递输入错误的具体原因。"""
    return JSONResponse(status_code=422, content={"detail": str(exc)})


def get_statue(identity: str) -> GeneratedStatue:
    """访问最近快照时更新缓存顺序，防止连续编辑淘汰正在查看的结果。"""
    if identity not in STATUES:
        raise HTTPException(410, "雕像快照已过期，请打开草稿或工程。")
    STATUES.move_to_end(identity)
    return STATUES[identity]


def remember(statue: GeneratedStatue) -> dict:
    """登记独立快照，保留最近 20 次生成或编辑用于撤销。"""
    identity = uuid4().hex
    statue.preview["statue_id"] = identity
    STATUES[identity] = statue
    while len(STATUES) > 20:
        STATUES.popitem(last=False)
    return statue.preview


@app.post("/api/skin/username")
async def username_skin(request: UsernameRequest) -> dict:
    """查询正版 Java 皮肤并携带官方手臂模型信息。"""
    return await run_in_threadpool(fetch_skin, request.username.strip())


@app.get("/api/statue/{identity}/snapshot")
def snapshot(identity: str) -> dict:
    """恢复编辑历史中的已有预览。"""
    return get_statue(identity).preview


@app.get("/api/statue/{identity}/block")
def selected_block(identity: str, x: int, y: int, z: int) -> dict:
    """查询点击位置的实际方块状态及该类方块总数。"""
    return block_at(get_statue(identity), (x, y, z))


@app.get("/api/statue/{identity}/candidates")
async def candidates(identity: str, key: str) -> dict:
    """返回完整稳定排序的轻量候选表，浏览器按批显示且不随切换重新排序。"""
    statue = get_statue(identity)
    rows = await run_in_threadpool(
        ranked_candidates, statue, get_palette(statue.preview["palette_id"]), key
    )
    return {
        "candidates": [
            {
                "cost": row["cost"],
                "entry": {
                    **{
                        k: row["entry"].get(k)
                        for k in (
                            "key",
                            "display_name",
                            "registry_name",
                            "numeric_id",
                            "metadata",
                            "connected_texture",
                        )
                    },
                    "faces": {"south": row["entry"]["faces"]["south"]},
                },
            }
            for row in rows
        ]
    }


@app.post("/api/statue/{identity}/replace")
async def replace(identity: str, request: Replacement) -> dict:
    """批量替换一个状态并返回可直接导出的新快照。"""
    statue = get_statue(identity)
    result = await run_in_threadpool(
        replace_material,
        statue,
        get_palette(statue.preview["palette_id"]),
        request.source,
        request.target,
    )
    return remember(result)


@app.get("/api/statue/{identity}/project")
async def save_project(identity: str) -> Response:
    """下载自带纹理与皮肤的工程文件。"""
    statue = get_statue(identity)
    data = await run_in_threadpool(project_bytes, statue, get_palette(statue.preview["palette_id"]))
    return Response(
        data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="statue-{identity[:8]}.skinproj"'},
    )


def restore_project(data: bytes) -> dict:
    """恢复工程并登记自带调色板，供预览、替换与重新生成共用。"""
    statue, palette = open_project(data)
    PALETTES[palette.id] = palette
    return {
        "statue": remember(statue),
        "palette": palette.summary(),
        "skin": "data:image/png;base64," + base64.b64encode(statue.normalized_skin).decode("ascii"),
    }


@app.post("/api/projects/open")
async def load_project(file: Annotated[UploadFile, File()]) -> dict:
    """打开工程而不通过结构格式丢失编辑上下文。"""
    try:
        data = await file.read(128 * 1024 * 1024 + 1)
        if len(data) > 128 * 1024 * 1024:
            raise HTTPException(413, "工程需不超过 128 MB。")
        return await run_in_threadpool(restore_project, data)
    finally:
        await file.close()


@app.get("/api/drafts")
def drafts() -> dict:
    """列出项目目录中持久保存的手动草稿。"""
    return {
        "drafts": [
            {"id": p.stem, "name": p.stem, "size": p.stat().st_size}
            for p in sorted(DRAFTS.glob("*.skinproj"), reverse=True)
        ]
    }


@app.post("/api/statue/{identity}/draft")
async def save_draft(identity: str) -> dict:
    """每次保存独立草稿，服务重启后仍可打开。"""
    statue = get_statue(identity)

    def save() -> dict:
        data = project_bytes(statue, get_palette(statue.preview["palette_id"]))
        DRAFTS.mkdir(exist_ok=True)
        name = datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid4().hex[:8]
        target = DRAFTS / f"{name}.skinproj"
        temporary = target.with_suffix(".part")
        temporary.write_bytes(data)
        temporary.replace(target)
        return {"id": name}

    return await run_in_threadpool(save)


@app.post("/api/drafts/{identity}/open")
async def load_draft(identity: str) -> dict:
    """只打开草稿列表中的文件。"""
    files = {p.stem: p for p in DRAFTS.glob("*.skinproj")}
    if identity not in files:
        raise HTTPException(404, "草稿不存在。")
    return await run_in_threadpool(lambda: restore_project(files[identity].read_bytes()))


class StatueOptions(BaseModel):
    """与实际体素分辨率关联的生成参数。"""

    palette_id: str
    scale: int = Field(default=3, ge=1, le=6)
    detail: Literal[1, 2, 4] = 1
    hollow: bool = True
    shell_thickness: int = Field(default=1, ge=1, le=4)
    overlay_offset: int = Field(default=1, ge=1, le=3)
    alpha_threshold: int = Field(default=128, ge=1, le=255)
    smoothness: float = Field(default=0.2, ge=0, le=1)
    prefer_connected: bool = False
    excluded: set[str] = Field(default_factory=set)
    layers: list[str]


class ScanRequest(BaseModel):
    """用户指定的只读实例路径及可选的原版 JAR 路径。"""

    directory: str = Field(min_length=1)
    vanilla_jar: str | None = None


class MatchRequest(BaseModel):
    """一个颜色与表面朝向的静态匹配请求。"""

    rgb: tuple[int, int, int]
    face: Literal["east", "west", "up", "down", "south", "north"] = "south"
    smoothness: float = Field(default=0.2, ge=0, le=1)
    prefer_connected: bool = False
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


@app.get("/api/resources/local")
def local_indexes() -> dict:
    """列出用户放在项目根目录的运行时索引，文件内容不随 Git 提交。"""
    return {
        "files": [
            {"name": path.name, "size": path.stat().st_size}
            for path in sorted(PROJECT.glob("block-index-*.zip"))
        ]
    }


@app.get("/api/resources/loaded")
def loaded_palettes() -> dict:
    """让界面使用启动参数预载的调色板。"""
    return {"palettes": [palette.summary() for palette in PALETTES.values()]}


@app.post("/api/resources/local/{filename}")
async def load_local_index(filename: str) -> dict:
    """读取用户提供的项目内索引，重复读取同一内容复用已解析调色板。"""
    files = {path.name: path for path in PROJECT.glob("block-index-*.zip")}
    if filename not in files:
        raise HTTPException(404, "项目目录中没有该索引。")

    def load() -> dict:
        data = files[filename].read_bytes()
        identity = hashlib.sha256(data).hexdigest()[:20]
        if identity not in PALETTES:
            PALETTES[identity] = import_runtime_index(data)
        return {"palette": PALETTES[identity].summary()}

    try:
        return await run_in_threadpool(load)
    except (ValueError, OSError) as exc:
        raise HTTPException(422, str(exc)) from exc


@app.post("/api/statue/generate")
async def build_statue(
    file: Annotated[UploadFile, File()],
    options: Annotated[str, Form()],
    model: Annotated[Literal["steve", "alex"], Form()] = "steve",
) -> dict:
    """生成并保留同源预览与体素快照，供用户导出当前已查看的结果。"""
    try:
        settings = StatueOptions.model_validate_json(options)
        palette = get_palette(settings.palette_id)
        data = await file.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024:
            raise HTTPException(413, "皮肤文件需小于 2 MB。")

        def build() -> dict:
            parsed = parse_skin(data, model)
            statue = generate_statue(parsed, palette, settings.model_dump(exclude={"palette_id"}))
            statue.preview.update(
                {
                    "source": {
                        "filename": file.filename,
                        "sha256": hashlib.sha256(data).hexdigest(),
                        "model": parsed["model"],
                    },
                    "palette_source": palette.source,
                    "resource_packs": palette.resource_packs,
                    "placement": placement(statue.state_indices.shape),
                }
            )
            return remember(statue)

        return await run_in_threadpool(build)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    finally:
        await file.close()


@app.get("/api/statue/{identity}/export")
async def export_statue(
    identity: str,
    profile: Literal["worldedit_gtnh", "mcedit", "schematica_gtnh"] = "worldedit_gtnh",
    bundle: bool = False,
) -> Response:
    """下载指定预览快照的 Schematic 或结构／材料诊断 ZIP。"""
    statue = get_statue(identity)
    try:
        payload = await run_in_threadpool(
            export_bundle if bundle else schematic_bytes, statue, profile
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    extension = "zip" if bundle else "schematic"
    filename = f"statue-{identity[:8]}-{profile}.{extension}"
    return Response(
        payload,
        media_type="application/zip" if bundle else "application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/palettes/{identity}/entries")
def palette_entries(
    identity: str,
    search: str = "",
    eligible_only: bool = False,
    include_connected: bool = False,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=40, ge=1, le=100),
) -> dict:
    """按名称和候选状态分页浏览方块，避免一次传输完整注册表。"""
    palette = get_palette(identity)
    needle = search.casefold()
    entries = [
        entry
        for entry in palette.entries
        if needle
        in (
            entry["key"] + " " + (entry.get("display_name") or "") + " " + str(entry["numeric_id"])
        ).casefold()
        and (
            not eligible_only
            or entry["eligible"]
            or include_connected
            and entry["connected_eligible"]
        )
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
    """提供与雕像共用调色板的单色、单朝向 Lab 候选匹配。"""
    if any(channel < 0 or channel > 255 for channel in request.rgb):
        raise HTTPException(422, "RGB 分量必须为 0～255。")
    try:
        return get_palette(identity).match(
            request.rgb,
            request.face,
            request.smoothness,
            request.excluded,
            request.prefer_connected,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get("/api/statue/capabilities")
def statue_capabilities() -> dict:
    """返回可用的生成尺寸和预览能力。"""
    return {
        "generation_available": True,
        "status": "preview_available",
        "structure_export_available": True,
        "export_profiles": PROFILES,
        "scales": [1, 2, 3, 4, 5, 6],
        "base_heights": [32, 64, 96, 128, 160, 192],
        "palette_match_available": True,
    }


app.mount("/static", StaticFiles(directory=WEB), name="static")
