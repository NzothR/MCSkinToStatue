"""导入辅助模组索引，或从准确的原版映射创建起步调色板。"""

import hashlib
import json
from io import BytesIO
from zipfile import BadZipFile, ZipFile

from skin_statue.core.palette import FACES, Palette
from skin_statue.resources.ctm import affected_by_ctm
from skin_statue.resources.gravity import affected_by_gravity
from skin_statue.resources.instance import InstanceResources

COLORS = (
    "white",
    "orange",
    "magenta",
    "light_blue",
    "yellow",
    "lime",
    "pink",
    "gray",
    "silver",
    "cyan",
    "purple",
    "blue",
    "brown",
    "green",
    "red",
    "black",
)
# 仅收录 1.7.10 注册代码中确定的完整、不染色、无 TileEntity 方块。
VANILLA = (
    ("stone", 1, "stone"),
    ("dirt", 3, "dirt"),
    ("cobblestone", 4, "cobblestone"),
    (
        "sandstone",
        24,
        {"up": "sandstone_top", "down": "sandstone_bottom", "side": "sandstone_normal"},
    ),
    ("gold_block", 41, "gold_block"),
    ("iron_block", 42, "iron_block"),
    ("brick_block", 45, "brick"),
    ("obsidian", 49, "obsidian"),
    ("diamond_block", 57, "diamond_block"),
    ("clay", 82, "clay"),
    ("emerald_block", 133, "emerald_block"),
    (
        "quartz_block",
        155,
        {"up": "quartz_block_top", "down": "quartz_block_bottom", "side": "quartz_block_side"},
    ),
    ("hardened_clay", 172, "hardened_clay"),
    ("coal_block", 173, "coal_block"),
)


def vanilla_palette(resources: InstanceResources) -> Palette:
    """使用实例实际纹理覆盖和已知原版 ID 创建初始候选，不猜测模组 ID。"""
    palette = Palette("vanilla_1_7_10_static", resources.id, resources.packs)
    specs = [(name, number, 0, textures) for name, number, textures in VANILLA]
    specs += [("wool", 35, meta, f"wool_colored_{color}") for meta, color in enumerate(COLORS)]
    specs += [
        ("stained_hardened_clay", 159, meta, f"hardened_clay_stained_{color}")
        for meta, color in enumerate(COLORS)
    ]
    specs += [
        ("planks", 5, meta, f"planks_{wood}")
        for meta, wood in enumerate(("oak", "spruce", "birch", "jungle", "acacia", "big_oak"))
    ]
    resolved = {}
    for name, number, meta, textures in specs:
        faces = {}
        issues = []
        for face in FACES:
            texture = (
                textures if isinstance(textures, str) else textures.get(face, textures["side"])
            )
            path = f"assets/minecraft/textures/blocks/{texture}.png"
            try:
                if path not in resolved:
                    data, provider = resources.resolve(path)
                    resolved[path] = {
                        **palette.texture(data),
                        "icon_name": f"minecraft:{texture}",
                        "provider": provider,
                        "animated": False,
                    }
                faces[face] = resolved[path]
            except (ValueError, OSError, KeyError) as exc:
                issues.append("missing_texture")
                palette.errors.append(
                    {"key": f"minecraft:{name}@{meta}", "face": face, "error": str(exc)}
                )
        if affected_by_ctm(
            f"minecraft:{name}",
            number,
            meta,
            [f["icon_name"] for f in faces.values()],
            resources.ctm_files,
        ):
            issues.append("connected_texture")
        palette.add_state(
            f"minecraft:{name}",
            number,
            {
                "metadata": meta,
                "status": "captured" if len(faces) == 6 else "unresolved",
                "creative_confirmed": True,
                "normal_cube": True,
                "opaque": True,
                "render_type": 0,
                "has_tile_entity": False,
            },
            faces,
            issues,
        )
    palette.registry_count = len({entry["registry_name"] for entry in palette.entries})
    palette.context = {
        "instance": str(resources.root),
        "scan": resources.summary(),
        "numeric_ids": "vanilla_static_not_target_world_mapping",
    }
    palette.id = hashlib.sha256(
        (resources.id + "".join(sorted(palette.textures))).encode()
    ).hexdigest()[:20]
    return palette


def import_runtime_index(data: bytes) -> Palette:
    """直接读取索引 ZIP，无需解压；每个失败状态均保留诊断信息。"""
    try:
        with ZipFile(BytesIO(data)) as archive:
            if sum(info.file_size for info in archive.infolist()) > 512 * 1024 * 1024:
                raise ValueError("索引解压总大小超过 512 MB。")
            root = json.loads(archive.read("registry.json"))
            if root.get("format") != "skin-statue-block-index" or root.get("schema_version") != 1:
                raise ValueError("不支持的方块索引格式或版本。")
            if root.get("minecraft_version") != "1.7.10":
                raise ValueError("此索引不属于 Minecraft 1.7.10。")
            palette = Palette(
                "runtime_index", hashlib.sha256(data).hexdigest()[:20], root["resource_packs"]
            )
            palette.registry_count = len(root["blocks"])
            palette.errors = root.get("errors", [])
            palette.context = {
                key: root.get(key)
                for key in (
                    "created_at",
                    "exporter_version",
                    "capture_scope",
                    "language",
                    "server_resource_pack",
                )
            }
            texture_cache = {}
            for block in root["blocks"]:
                gravity = affected_by_gravity(block)
                reasons = [
                    flag
                    for flag in ("world_dependent_icon", "world_dependent_color")
                    if block.get(flag)
                ]
                number = block["numeric_id"]
                if number < 0:
                    raise ValueError(f"方块 ID 不能为负数：{number}")
                for state in block["states"]:
                    if not 0 <= state["metadata"] <= 15:
                        raise ValueError("索引 Metadata 必须为 0～15。")
                    faces = {}
                    for face, descriptor in state.get("faces", {}).items():
                        if face not in FACES:
                            raise ValueError(f"索引包含未知表面：{face}")
                        path = descriptor["path"]
                        if path not in texture_cache:
                            texture_cache[path] = palette.texture(archive.read(path))
                        icon_name = descriptor["icon_name"]
                        if ":" not in icon_name:
                            icon_name = "minecraft:" + icon_name
                        faces[face] = {
                            **texture_cache[path],
                            "icon_name": icon_name,
                            "animated": descriptor["animated"],
                            "pixel_source": descriptor.get("pixel_source"),
                            "connected_texture": descriptor.get("connected_texture", False)
                            or descriptor["sprite_class"].startswith(
                                "com.github.wohaopa.MyCTMLib."
                            ),
                        }
                    state_reasons = list(reasons)
                    if any(f["connected_texture"] for f in faces.values()) or affected_by_ctm(
                        block["registry_name"],
                        number,
                        state["metadata"],
                        [f["icon_name"] for f in faces.values()],
                        root.get("contextual_rules", []),
                    ):
                        state_reasons.append("connected_texture")
                    if root.get("server_resource_pack"):
                        state_reasons.append("server_pack_rules_unreviewed")
                    palette.add_state(
                        block["registry_name"],
                        number,
                        {
                            **state,
                            "gravity_affected": gravity,
                            "creative_tab": block.get("creative_tab"),
                        },
                        faces,
                        state_reasons,
                    )
            palette.context["item_registry_count"] = root.get("item_registry_count", 0)
            from skin_statue.resources.item_catalog import start_item_import

            start_item_import(palette, data, root.get("items", []), texture_cache)
    except (BadZipFile, KeyError, json.JSONDecodeError, TypeError) as exc:
        raise ValueError(f"索引 ZIP 的结构不完整：{exc}") from exc
    return palette
