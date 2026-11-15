"""MCEdit／GTNH WorldEdit／Schematica 的 Alpha Schematic 编码与诊断包。"""

import csv
import gzip
import json
import logging
from io import BytesIO, StringIO
from zipfile import ZIP_DEFLATED, ZipFile

import nbtlib as nbt
import numpy as np

from skin_statue.core.palette import FACES
from skin_statue.core.statue import GeneratedStatue

LOGGER = logging.getLogger(__name__)
PROFILES = {
    "worldedit_gtnh": "GTNH WorldEdit · AddBlocks + AddBlocks2",
    "mcedit": "MCEdit / WorldEdit 传统 12-bit",
    "schematica_gtnh": "GTNH Schematica · SchematicPlus 16-bit",
}


def placement(dimensions: tuple | list) -> dict:
    """以正面右下角方块 I 为锚点，X 东、Y 上、Z 南，雕像正面朝南。"""
    w, h, length = (int(value) for value in dimensions)
    corners = {
        "A": [w - 1, h - 1, 0],
        "B": [0, h - 1, 0],
        "C": [0, h - 1, length - 1],
        "D": [w - 1, h - 1, length - 1],
        "E": [w - 1, 0, 0],
        "F": [0, 0, 0],
        "G": [0, 0, length - 1],
        "I": [w - 1, 0, length - 1],
    }
    return {
        "anchor": "I",
        "anchor_local": corners["I"],
        "offset": [1 - w, 0, 1 - length],
        "front": "south (+Z)",
        "corners": corners,
        "top_face": "ABCD",
        "front_face": "CDGI",
        "back_face": "ABEF",
        "note": "I 为包围盒正面右下角的方块坐标；普通 //paste 不按玩家视线自动旋转。",
    }


def pack_nibbles(values: np.ndarray) -> np.ndarray:
    """偶数索引放低半字节，奇数索引放高半字节，与 GTNH WorldEdit 一致。"""
    padded = np.zeros(((len(values) + 1) // 2) * 2, dtype=np.uint8)
    padded[: len(values)] = values & 15
    return padded[::2] | (padded[1::2] << 4)


def unpack_nibbles(tag, length: int) -> np.ndarray:
    """恢复导出文件中的 nibble 数组，供每次导出的读回校验使用。"""
    packed = np.asarray(tag).view(np.uint8)
    values = np.empty(len(packed) * 2, dtype=np.uint32)
    values[::2] = packed & 15
    values[1::2] = packed >> 4
    return values[:length]


def validate_file(payload: bytes, ids, metadata, dimensions, anchor, profile, mapping):
    """实际导出时读回 NBT，验证尺寸、全体 ID／Metadata、映射及粘贴原点。"""
    root = nbt.File.parse(BytesIO(gzip.decompress(payload)))
    sizes = tuple(int(root[name]) for name in ("Width", "Height", "Length"))
    expected_length = len(ids)
    block_tag = np.asarray(root["Blocks"]).view(np.uint8)
    data_tag = np.asarray(root["Data"]).view(np.uint8)
    if (
        root.root_name != "Schematic"
        or sizes != tuple(dimensions)
        or len(block_tag) != expected_length
        or len(data_tag) != expected_length
    ):
        raise ValueError("Schematic 读回失败：根标签、尺寸或数组长度不一致。")
    restored = block_tag.astype(np.uint32)
    if profile == "schematica_gtnh":
        restored |= np.asarray(root["AddBlocks"]).view(np.uint8).astype(np.uint32) << 8
    else:
        if "AddBlocks" in root:
            restored |= unpack_nibbles(root["AddBlocks"], expected_length) << 8
        if "AddBlocks2" in root:
            restored |= unpack_nibbles(root["AddBlocks2"], expected_length) << 12
    if not np.array_equal(restored, ids) or not np.array_equal(data_tag, metadata):
        raise ValueError("Schematic 读回失败：方块 ID 或 Metadata 未被完整保留。")
    offset = [int(root["WEOffset" + axis]) for axis in "XYZ"]
    origin = [int(root["WEOrigin" + axis]) for axis in "XYZ"]
    stored_mapping = {name: int(value) & 65535 for name, value in root["BlockMapping"].items()}
    schematica_mapping = {
        name: int(value) & 65535 for name, value in root["SchematicaMapping"].items()
    }
    if (
        offset != anchor["offset"]
        or origin != [0, 0, 0]
        or stored_mapping != mapping
        or schematica_mapping != mapping
    ):
        raise ValueError("Schematic 读回失败：粘贴锚点或注册名称映射不一致。")


def schematic_bytes(statue: GeneratedStatue, profile: str) -> bytes:
    """序列化当前预览的实际状态；GTNH 的扩展 ID 不截断，也不自动替换材料。"""
    indices = statue.state_indices
    # -1 是空气；查表末项显式保留为空气 ID／Metadata 0。
    id_table = np.array([state["numeric_id"] for state in statue.states] + [0], dtype=np.int64)
    meta_table = np.array([state["metadata"] for state in statue.states] + [0], dtype=np.uint8)
    ids = id_table[indices].transpose(1, 2, 0).ravel()
    metadata = meta_table[indices].transpose(1, 2, 0).ravel()
    maximum = int(ids.max())
    limit = 4095 if profile == "mcedit" else 32767 if profile == "schematica_gtnh" else 65535
    if maximum > limit:
        raise ValueError(
            f"该导出模式最多支持 ID {limit}，本雕像使用 ID {maximum}。请选择 GTNH WorldEdit 扩展格式，或禁用超限材料后重新生成。"
        )
    w, h, length = indices.shape
    anchor = placement(indices.shape)
    mapping = {
        material["registry_name"]: material["numeric_id"]
        for material in statue.preview["materials"]
    }
    mapping["minecraft:air"] = 0
    tags = {
        "Width": nbt.Short(w),
        "Height": nbt.Short(h),
        "Length": nbt.Short(length),
        "Materials": nbt.String("Alpha"),
        "Blocks": nbt.ByteArray((ids & 255).astype(np.uint8).view(np.int8)),
        "Data": nbt.ByteArray(metadata.view(np.int8)),
        "Entities": nbt.List[nbt.Compound]([]),
        "TileEntities": nbt.List[nbt.Compound]([]),
        "BlockMapping": nbt.Compound(
            {name: nbt.Short((number + 32768) % 65536 - 32768) for name, number in mapping.items()}
        ),
        "SchematicaMapping": nbt.Compound(
            {name: nbt.Short((number + 32768) % 65536 - 32768) for name, number in mapping.items()}
        ),
        "SkinStatue": nbt.Compound(
            {
                "Anchor": nbt.String("I"),
                "Front": nbt.String("south"),
                "Profile": nbt.String(profile),
                "PaletteId": nbt.String(statue.preview["palette_id"]),
            }
        ),
    }
    for axis, offset in zip("XYZ", anchor["offset"], strict=True):
        tags["WEOrigin" + axis] = nbt.Int(0)
        tags["WEOffset" + axis] = nbt.Int(offset)
    if profile == "schematica_gtnh":
        # GTNH Schematica 的 useSchematicplusFormat 模式使用每格完整高 8 位。
        tags["AddBlocks"] = nbt.ByteArray((ids >> 8).astype(np.uint8).view(np.int8))
    else:
        if maximum > 255:
            tags["AddBlocks"] = nbt.ByteArray(pack_nibbles(ids >> 8).view(np.int8))
        if maximum > 4095:
            tags["AddBlocks2"] = nbt.ByteArray(pack_nibbles(ids >> 12).view(np.int8))
    stream = BytesIO()
    nbt.File(tags, root_name="Schematic").write(stream)
    payload = gzip.compress(stream.getvalue(), mtime=0)
    validate_file(payload, ids, metadata, indices.shape, anchor, profile, mapping)
    LOGGER.debug(
        "Exported %s: dimensions=%s max_id=%s offset=%s bytes=%s",
        profile,
        indices.shape,
        maximum,
        anchor["offset"],
        len(payload),
    )
    return payload


def export_bundle(statue: GeneratedStatue, profile: str) -> bytes:
    """把结构、逐面材质对照、生成参数和同源皮肤一起打包，方便游戏内排查。"""
    payload = schematic_bytes(statue, profile)
    preview = statue.preview
    by_key = {entry["key"]: entry for entry in statue.states}
    materials = [
        {**material, "faces": by_key[material["key"]]["faces"]} for material in preview["materials"]
    ]
    report = {
        "format": "skin-statue-export-report",
        "schema_version": 1,
        "profile": profile,
        "statue_id": preview["statue_id"],
        "source": preview["source"],
        "palette_id": preview["palette_id"],
        "palette_source": preview["palette_source"],
        "resource_packs": preview["resource_packs"],
        "dimensions": preview["dimensions"],
        "block_count": preview["block_count"],
        "options": preview["options"],
        "matching": preview["matching"],
        "edits": preview.get("edits", []),
        "placement": placement(preview["dimensions"]),
        "materials": materials,
        "validation": "NBT dimensions, block IDs, metadata, registry mappings and anchor read back successfully",
    }
    csv_stream = StringIO(newline="")
    writer = csv.writer(csv_stream)
    writer.writerow(
        ["registry_name", "numeric_id", "metadata", "count", *[f"{face}_icon" for face in FACES]]
    )
    for material in materials:
        writer.writerow(
            [
                material["registry_name"],
                material["numeric_id"],
                material["metadata"],
                material["count"],
                *[material["faces"][face]["icon_name"] for face in FACES],
            ]
        )
    usage = (
        "在 GTNH Schematica 中启用 useSchematicplusFormat=true，重启后通过 GUI 加载与定位。\n"
        "此模式的 AddBlocks 编码供 SchematicPlus 使用；WorldEdit 的 I 点偏移不作用于 Schematica GUI。\n"
        if profile == "schematica_gtnh"
        else "WorldEdit：将 statue.schematic 放进实例 config/worldedit/schematics 目录；\n"
        "//schem load mcedit statue\n//paste -a\n"
        "站在计划的 I 点，朝西北看向雕像；普通粘贴不会随视线自动旋转。\n"
        "//paste -a 只放非空气块；若需要完整替换包围盒中的空气，使用 //paste。\n"
    )
    instructions = (
        "Skin Statue 导出包\n"
        f"模式：{PROFILES[profile]}\n尺寸：{preview['dimensions']}\n"
        "默认锚点为从正面看包围盒的右下角方块 I，正面朝南（+Z）。\n"
        + usage
        + "report.json 包含材料的六面图标、代表颜色与 ID，用于对照游戏实际方块。\n"
    )
    stream = BytesIO()
    with ZipFile(stream, "w", ZIP_DEFLATED) as archive:
        archive.writestr("statue.schematic", payload)
        archive.writestr("report.json", json.dumps(report, ensure_ascii=False, indent=2))
        archive.writestr("materials.csv", csv_stream.getvalue().encode("utf-8-sig"))
        archive.writestr("skin-normalized.png", statue.normalized_skin)
        archive.writestr("README.txt", instructions)
    return stream.getvalue()
