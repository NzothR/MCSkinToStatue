"""FastAPI 本地服务：皮肤解析、雕像编辑、工程与草稿。"""

import base64
import hashlib
import json
import logging
from collections import OrderedDict
from dataclasses import replace as replace_snapshot
from datetime import datetime
from pathlib import Path
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from skin_statue.core.cape import read_cape
from skin_statue.core.editing import (
    block_at,
    open_project,
    project_bytes,
    ranked_candidates,
    rebuild,
    replace_material,
)
from skin_statue.core.palette import DEFAULT_MATCHING, Palette
from skin_statue.core.pose import pose_preview
from skin_statue.core.schematic import PROFILES, export_bundle, placement, schematic_bytes
from skin_statue.core.skin import PARTS, parse_skin, png_url
from skin_statue.core.statue import GeneratedStatue, generate_statue
from skin_statue.preferences import INDEX, read_matching, remember_index, save_matching
from skin_statue.resources.instance import InstanceResources
from skin_statue.resources.java_skin import fetch_skin
from skin_statue.resources.registry import import_runtime_index, vanilla_palette
from skin_statue.resources.scene_resources import attach_connections, item_catalog, runtime_item

WEB = Path(__file__).parent / "web"
app = FastAPI(title="Skin Statue · 皮肤预览", docs_url=None, redoc_url=None)
app.state.server = None
app.state.preferred_palette = None
PALETTES: dict[str, Palette] = {}
STATUES: OrderedDict[str, GeneratedStatue] = OrderedDict()
PROJECT = WEB.parents[1]
DRAFTS = PROJECT / "drafts"
SCENE_RESOURCES = {}
Angle = Annotated[float, Field(ge=-180, le=180)]
Offset = Annotated[float, Field(ge=-64, le=64)]
AxisScale = Annotated[float, Field(ge=0.01, le=16)]


@app.post("/api/shutdown")
async def shutdown(background: BackgroundTasks) -> dict:
    """响应发出后停止当前 run.py 的 Uvicorn 服务，使 Python 进程正常退出。"""
    if app.state.server is None:
        raise HTTPException(409, "请通过 run.py 或 start.bat 启动服务以使用页面退出按钮。")
    background.add_task(setattr, app.state.server, "should_exit", True)
    return {"status": "stopping"}


class HeldItem(BaseModel):
    """纹理与持握类型分别保存，左右手可以独立配置。"""

    image: str = Field(max_length=3 * 1024 * 1024)
    kind: Literal["tool", "flat", "bow", "block"] = "tool"
    block_faces: dict[str, str] = Field(default_factory=dict)
    name: str = "自定义物品"
    offset: tuple[Offset, Offset, Offset] = (0, 0, 0)
    rotation: tuple[Angle, Angle, Angle] = (0, 0, 0)
    scale: float = Field(default=1, ge=0.1, le=4)
    stretch: tuple[AxisScale, AxisScale, AxisScale] = (1, 1, 1)
    thickness: float = Field(default=0, ge=0, le=8)
    rotate_around: bool = False


PartName = Literal["head", "body", "left_arm", "right_arm", "left_leg", "right_leg"]


class CapeTexture(BaseModel):
    """候选披风存入工程，切换时无需再次联网。"""

    id: str
    name: str
    image: str = Field(max_length=3 * 1024 * 1024)


class CapeSettings(BaseModel):
    """一份人物选择一件披风，只开放肩背铰链的局部 Z 轴。"""

    library: list[CapeTexture] = Field(default_factory=list, max_length=32)
    selected: str | None = None
    enabled: bool = True
    angle: float = Field(default=10, ge=0, le=120)


class SceneOptions(BaseModel):
    """静态姿势和独立持物配置；角度单位为度。"""

    pose: dict[PartName, tuple[Angle, Angle, Angle]] = Field(default_factory=dict)
    held: dict[Literal["left", "right"], HeldItem] = Field(default_factory=dict)
    cape: CapeSettings = Field(default_factory=CapeSettings)


class PoseRequest(SceneOptions):
    """皮肤即时姿势预览所需的几何信息。"""

    model: Literal["steve", "alex"] = "steve"
    alpha_threshold: int = Field(default=128, ge=1, le=255)


@app.get("/api/poses")
def pose_presets() -> dict:
    """返回参考基岩版盔甲架的静态预设，标准站立始终可恢复。"""
    return json.loads((WEB.parent / "poses.json").read_text(encoding="utf8"))


@app.post("/api/pose")
async def preview_pose(request: PoseRequest) -> dict:
    """返回与雕像生成共用的关节及持握矩阵。"""
    parts = [
        {
            "id": key,
            "size": (3, 12, 4) if "arm" in key and request.model == "alex" else size,
            "position": ((-5.5 if key == "right_arm" else 5.5), 18, 0)
            if "arm" in key and request.model == "alex"
            else position,
        }
        for key, _, size, position, _, _ in PARTS
    ]
    return await run_in_threadpool(pose_preview, {"parts": parts}, request.model_dump())


@app.get("/api/statue/{identity}/render")
async def render_statue(identity: str, connected: bool = True) -> dict:
    """只切换连接纹理显示，体素、材料与导出保持当前编辑结果。"""
    from skin_statue.core.connected_preview import preview_mesh

    statue = get_statue(identity)
    atlas, mesh, ctm = await run_in_threadpool(
        preview_mesh,
        statue.state_indices,
        statue.states,
        get_palette(statue.preview["palette_id"]),
        statue.preview["bounds"][0],
        connected,
    )
    return {"atlas": atlas, "mesh": mesh, "ctm": ctm}


class Replacement(BaseModel):
    """按固定生成分组及当前状态精确指定替换范围。"""

    source: str
    target: str
    group: int = Field(ge=0)


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


@app.post("/api/cape")
async def import_cape(file: Annotated[UploadFile, File()]) -> dict:
    """导入披风图集并返回与官方查询相同的候选描述。"""
    try:
        data = await file.read(2 * 1024 * 1024 + 1)
        image = read_cape(data)
        return {
            "id": hashlib.sha256(data).hexdigest(),
            "name": file.filename or "本地披风",
            "image": png_url(image),
        }
    finally:
        await file.close()


@app.get("/api/statue/{identity}/snapshot")
def snapshot(identity: str) -> dict:
    """恢复编辑历史中的已有预览。"""
    return get_statue(identity).preview


@app.get("/api/statue/{identity}/block")
def selected_block(identity: str, x: int, y: int, z: int) -> dict:
    """查询点击位置的实际方块状态、原始分组及其数量。"""
    return block_at(get_statue(identity), (x, y, z))


@app.get("/api/statue/{identity}/candidates")
async def candidates(identity: str, key: str, group: int = Query(ge=0)) -> dict:
    """返回完整稳定排序的轻量候选表，浏览器按批显示且不随切换重新排序。"""
    statue = get_statue(identity)
    rows = await run_in_threadpool(
        ranked_candidates, statue, get_palette(statue.preview["palette_id"]), key, group
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
                            "building_rank",
                            "building_label",
                            "building_source",
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
        request.group,
    )
    return remember(result)


@app.get("/api/statue/{identity}/project")
@app.post("/api/statue/{identity}/project")
async def save_project(identity: str, workspace: SceneOptions | None = None) -> Response:
    """下载自带纹理与皮肤的工程文件。"""
    statue = get_statue(identity)
    if workspace is not None:
        statue = replace_snapshot(
            statue, preview={**statue.preview, "workspace": workspace.model_dump()}
        )
    data = await run_in_threadpool(project_bytes, statue, get_palette(statue.preview["palette_id"]))
    return Response(
        data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="statue-{identity[:8]}.skinproj"'},
    )


def restore_project(data: bytes) -> dict:
    """恢复工程并登记自带调色板，供预览、替换与重新生成共用。"""
    statue, palette = open_project(data)
    attach_scene_resources(palette)
    rebuild(statue, palette)
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
async def save_draft(identity: str, workspace: SceneOptions | None = None) -> dict:
    """每次保存独立草稿，服务重启后仍可打开。"""
    statue = get_statue(identity)
    if workspace is not None:
        statue = replace_snapshot(
            statue, preview={**statue.preview, "workspace": workspace.model_dump()}
        )

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


class MatchingParameters(BaseModel):
    """可调纹理偏好与相对最佳颜色的最大额外 CIE76 色差。"""

    uniformity: float = Field(default=DEFAULT_MATCHING["uniformity"], ge=0, le=10)
    border: float = Field(default=DEFAULT_MATCHING["border"], ge=0, le=10)
    grain: float = Field(default=DEFAULT_MATCHING["grain"], ge=0, le=10)
    connection: float = Field(default=DEFAULT_MATCHING["connection"], ge=0, le=3)
    color_tolerance: float = Field(default=DEFAULT_MATCHING["color_tolerance"], ge=0, le=30)
    building: float = Field(default=DEFAULT_MATCHING["building"], ge=0, le=3)


class StatueOptions(SceneOptions):
    """与实际体素分辨率关联的生成参数。"""

    palette_id: str
    scale: int = Field(default=3, ge=1, le=6)
    detail: Literal[1, 2, 4] = 1
    hollow: bool = True
    shell_thickness: int = Field(default=1, ge=1, le=4)
    overlay_offset: int = Field(default=1, ge=1, le=3)
    alpha_threshold: int = Field(default=128, ge=1, le=255)
    smoothness: float = Field(default=0.2, ge=0, le=1)
    matching: MatchingParameters = Field(default_factory=MatchingParameters)
    prefer_connected: bool = False
    excluded: set[str] = Field(default_factory=set)
    layers: list[str]


class MatchingPreferences(BaseModel):
    """跨启动只恢复算法偏好，不保存其他工作区设置。"""

    smoothness: float = Field(default=0.2, ge=0, le=1)
    prefer_connected: bool = False
    matching: MatchingParameters = Field(default_factory=MatchingParameters)


@app.get("/api/preferences")
def preferences() -> dict:
    """初始化上次成功读取的索引；失败通过正常错误响应提示，可重新导入。"""
    settings = MatchingPreferences.model_validate(read_matching()).model_dump()
    if INDEX.is_file():
        data = INDEX.read_bytes()
        identity = hashlib.sha256(data).hexdigest()[:20]
        if identity not in PALETTES:
            palette = import_runtime_index(data)
            attach_scene_resources(palette)
            PALETTES[palette.id] = palette
        app.state.preferred_palette = identity
    return {"algorithm": settings}


@app.put("/api/preferences")
def update_preferences(request: MatchingPreferences) -> dict:
    """允许随时覆盖和恢复算法默认值，保存值经过与生成接口相同的范围校验。"""
    save_matching(request.model_dump())
    return {"saved": True}


class ScanRequest(BaseModel):
    """用户指定的只读实例路径及可选的原版 JAR 路径。"""

    directory: str = Field(min_length=1)
    vanilla_jar: str | None = None


def attach_scene_resources(palette):
    """仅从相同资源包栈补充连接图，工程自带的其他材质不会被覆盖。"""
    resources = SCENE_RESOURCES.get("resources")
    if resources and palette.resource_packs == resources.packs:
        with resources.reading():
            attach_connections(palette, resources)


def load_scene_resources(directory, vanilla_jar=None):
    """只读加载实例物品与连接图，供正在编辑和后续导入的调色板使用。"""
    resources = InstanceResources(directory, vanilla_jar)
    with resources.reading():
        items = item_catalog(resources)
        SCENE_RESOURCES.update(resources=resources, items=items)
        for palette in PALETTES.values():
            attach_scene_resources(palette)
    return scene_catalog()


@app.get("/api/scene/resources")
def scene_catalog() -> dict:
    """列出已加载的物品和实例路径，重开网页无需重复扫描。"""
    resources = SCENE_RESOURCES.get("resources")
    return {
        "directory": str(resources.root) if resources else "",
        "items": [
            {k: v for k, v in item.items() if k != "image"}
            for item in SCENE_RESOURCES.get("items", {}).values()
        ],
        "connected_textures": sum(
            bool(f.get("ctm_texture_id"))
            for p in PALETTES.values()
            for e in p.entries
            for f in e["faces"].values()
        ),
    }


@app.post("/api/scene/resources")
async def scene_resources(request: ScanRequest) -> dict:
    """读取玩家选定实例中的启用资源包和原版物品。"""
    return await run_in_threadpool(load_scene_resources, request.directory, request.vanilla_jar)


@app.get("/api/scene/item")
def scene_item(key: str, palette_id: str | None = None) -> dict:
    """返回应用资源包覆盖后的物品纹理。"""
    if palette_id:
        palette = get_palette(palette_id)
        entry = next((e for e in palette.items if e["key"] == key), None)
        if entry:
            return runtime_item(palette, entry)
    items = SCENE_RESOURCES.get("items", {})
    if key not in items:
        raise HTTPException(404, "请先从实例载入物品纹理。")
    return items[key]


@app.get("/api/palettes/{identity}/items")
def palette_items(
    identity: str,
    search: str = "",
    offset: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=200),
) -> dict:
    """按本地化名称、注册 ID、数字 ID 查找真实物品变体，分页控制浏览器开销。"""
    palette = get_palette(identity)
    needle = search.casefold()
    rows = [
        e
        for e in palette.items
        if needle
        in (e["key"] + " " + str(e["numeric_id"]) + " " + (e.get("display_name") or "")).casefold()
    ]
    return {
        "items": [
            {
                "id": e["key"],
                "label": f"{e.get('display_name') or e['registry_name']} · {e['registry_name']} · ID {e['numeric_id']}:{e['damage']}"
                + (" · 图标未解析" if e["status"] != "captured" else ""),
                "status": e["status"],
            }
            for e in rows[offset : offset + limit]
        ],
        "total": len(rows),
        "offset": offset,
        "runtime": bool(palette.items),
    }


@app.get("/api/palettes/{identity}/items/export")
def export_item_mapping(identity: str) -> Response:
    """下载物品与方块的名称映射，图标 PNG 保留在原始索引。"""
    palette = get_palette(identity)
    return Response(
        json.dumps(
            {
                "format": "skin-statue-item-map",
                "schema_version": 1,
                "context": palette.context,
                "items": palette.items,
                "blocks": [
                    {
                        k: e.get(k)
                        for k in ("key", "registry_name", "numeric_id", "metadata", "display_name")
                    }
                    for e in palette.entries
                ],
            },
            ensure_ascii=False,
            indent=2,
        ),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="item-map-{identity}.json"'},
    )


class MatchRequest(BaseModel):
    """一个颜色与表面朝向的静态匹配请求。"""

    rgb: tuple[int, int, int]
    face: Literal["east", "west", "up", "down", "south", "north"] = "south"
    smoothness: float = Field(default=0.2, ge=0, le=1)
    matching: MatchingParameters = Field(default_factory=MatchingParameters)
    prefer_connected: bool = False
    excluded: set[str] = Field(default_factory=set)


def get_palette(identity: str) -> Palette:
    """读取本次服务运行中导入的调色板。"""
    if identity not in PALETTES:
        raise HTTPException(404, "调色板尚未加载，请重新扫描实例或导入索引。")
    return PALETTES[identity]


@app.get("/")
def index() -> HTMLResponse:
    """用同一内容版本发布入口、样式和整个模块图，避免新页面加载旧缓存脚本。"""
    assets = sorted(path for path in WEB.rglob("*") if path.suffix in {".js", ".css"})
    digest = hashlib.sha256()
    for path in assets:
        digest.update(path.relative_to(WEB).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    version = digest.hexdigest()[:20]
    imports = {
        "/static/" + path.relative_to(WEB).as_posix(): "/static/"
        + path.relative_to(WEB).as_posix()
        + "?v="
        + version
        for path in assets
        if path.suffix == ".js"
    }
    imports["three"] = imports["/static/vendor/three.module.min.js"]
    html = (WEB / "index.html").read_text(encoding="utf-8")
    html = html.replace(
        '<script type="importmap">{"imports":{"three":"/static/vendor/three.module.min.js"}}</script>',
        '<script type="importmap">' + json.dumps({"imports": imports}) + "</script>",
    )
    html = html.replace('href="/static/style.css"', f'href="/static/style.css?v={version}"')
    html = html.replace('src="/static/app.js"', f'src="/static/app.js?v={version}"')
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


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
        attach_scene_resources(palette)
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
        attach_scene_resources(palette)
        PALETTES[palette.id] = palette
        await run_in_threadpool(remember_index, data)
        app.state.preferred_palette = palette.id
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
    return {
        "palettes": [palette.summary() for palette in PALETTES.values()],
        "preferred": app.state.preferred_palette,
    }


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
            attach_scene_resources(PALETTES[identity])
        remember_index(data)
        app.state.preferred_palette = identity
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
            request.matching.model_dump(),
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
