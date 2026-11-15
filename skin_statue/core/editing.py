"""整类材料编辑、原色候选排序和可独立恢复的工程 ZIP。"""

import copy
import hashlib
import json
import logging
from io import BytesIO
from zipfile import ZIP_DEFLATED, BadZipFile, ZipFile

import numpy as np

from skin_statue.core.palette import FACES, Palette, rgb_to_lab
from skin_statue.core.skin import parse_skin
from skin_statue.core.statue import GeneratedStatue, greedy_mesh, texture_atlas

LOGGER = logging.getLogger(__name__)


def rebuild(statue: GeneratedStatue, palette: Palette) -> None:
    """从实际体素刷新纹理、合并网格和材料数量，编辑不再执行颜色映射。"""
    blocks = statue.state_indices
    counts = np.bincount(blocks[blocks >= 0], minlength=len(statue.states))
    lookup, atlas = texture_atlas(palette, statue.states, counts)
    statue.preview["atlas"] = atlas
    statue.preview["mesh"] = greedy_mesh(blocks, lookup, statue.preview["bounds"][0])
    statue.preview["materials"] = sorted(
        [
            {
                **{
                    k: e.get(k)
                    for k in ("key", "registry_name", "numeric_id", "metadata", "display_name")
                },
                "count": int(counts[i]),
            }
            for i, e in enumerate(statue.states)
            if counts[i]
        ],
        key=lambda e: -e["count"],
    )


def block_at(statue: GeneratedStatue, position: tuple[int, int, int]) -> dict:
    """使用裁剪包围盒内的整数坐标查询一个实际体素。"""
    if any(
        p < 0 or p >= size for p, size in zip(position, statue.state_indices.shape, strict=True)
    ):
        raise ValueError("所选坐标超出雕像范围。")
    index = int(statue.state_indices[position])
    if index < 0:
        raise ValueError("所选位置是空气。")
    entry = statue.states[index]
    count = next(m["count"] for m in statue.preview["materials"] if m["key"] == entry["key"])
    LOGGER.debug("Selected voxel: position=%s key=%s count=%s", position, entry["key"], count)
    return {"entry": entry, "count": count, "position": position}


def ranked_candidates(statue: GeneratedStatue, palette: Palette, key: str) -> list[dict]:
    """用这类材料原先覆盖的皮肤颜色共同评分；排序固定后供前端来回切换。"""
    source = next((e for e in statue.states if e["key"] == key), None)
    if source is None or not any(m["key"] == key for m in statue.preview["materials"]):
        raise ValueError("雕像中没有该材料。")
    options = statue.preview["options"]
    entries = palette.candidates(options["prefer_connected"], options["excluded"])
    labs = np.array([[e["faces"][f]["lab"] for f in FACES] for e in entries])
    noise = np.sqrt([[e["faces"][f]["variance"] for f in FACES] for e in entries]) / 2.55
    scores = np.zeros(len(entries))
    samples = statue.match_targets.get(key)
    if samples:
        total = sum(count for _, count in samples)
        for signature, count in samples:
            colors = np.asarray(signature[:18]).reshape(6, 3)
            target = np.array([rgb_to_lab(row) for row in colors])
            weights = (int(signature[18]) >> np.arange(6)) & 1
            delta = np.linalg.norm(labs - target, axis=2)
            scores += ((delta + options["smoothness"] * noise) * weights).sum(axis=1) * (
                count / (total * weights.sum())
            )
    else:
        # 仅内部填充材料没有皮肤表面目标，按其六面颜色排列替代项。
        target = np.array([source["faces"][f]["lab"] for f in FACES])
        scores = (np.linalg.norm(labs - target, axis=2) + options["smoothness"] * noise).mean(
            axis=1
        )
    if options["prefer_connected"]:
        scores -= np.array([3 if e["connected_texture"] else 0 for e in entries])
    return [
        {"entry": entries[int(i)], "cost": round(float(scores[i]), 3)}
        for i in np.argsort(scores, kind="stable")
    ]


def replace_material(
    statue: GeneratedStatue, palette: Palette, source: str, target: str
) -> GeneratedStatue:
    """复制体素快照并替换同 registry+metadata 的全部方块，原快照可撤销恢复。"""
    source_index = next((i for i, e in enumerate(statue.states) if e["key"] == source), None)
    if source_index is None or not np.any(statue.state_indices == source_index):
        raise ValueError("雕像中没有待替换的材料。")
    options = statue.preview["options"]
    destination = next(
        (
            e
            for e in palette.candidates(options["prefer_connected"], options["excluded"])
            if e["key"] == target
        ),
        None,
    )
    if destination is None:
        raise ValueError("请选择可用候选；重力方块和已禁用材料不能用于替换。")
    states = list(statue.states)
    target_index = next((i for i, e in enumerate(states) if e["key"] == target), len(states))
    if target_index == len(states):
        states.append(destination)
    blocks = statue.state_indices.copy()
    count = int(np.count_nonzero(blocks == source_index))
    blocks[blocks == source_index] = target_index
    targets = copy.deepcopy(statue.match_targets)
    preview = {k: copy.deepcopy(v) for k, v in statue.preview.items() if k not in ("mesh", "atlas")}
    if source != target:
        targets.setdefault(target, []).extend(targets.pop(source, []))
        preview.setdefault("edits", []).append({"source": source, "target": target, "count": count})
    result = GeneratedStatue(preview, blocks, states, statue.normalized_skin, targets)
    rebuild(result, palette)
    LOGGER.debug("Material replacement: %s -> %s, count=%s", source, target, count)
    return result


def project_bytes(statue: GeneratedStatue, palette: Palette) -> bytes:
    """保存实际编辑结果、皮肤及可用候选的全部纹理，工程无需依赖原索引。"""
    entries = {e["key"]: e for e in palette.candidates(True, set())}
    entries.update({e["key"]: e for e in statue.states})
    textures = {face["texture_id"] for e in entries.values() for face in e["faces"].values()}
    manifest = {
        "format": "skin-statue-project",
        "schema_version": 1,
        "preview": {
            k: v for k, v in statue.preview.items() if k not in ("mesh", "atlas", "statue_id")
        },
        "shape": list(statue.state_indices.shape),
        "states": [e["key"] for e in statue.states],
        "match_targets": statue.match_targets,
        "palette": {
            "source": palette.source,
            "resource_packs": palette.resource_packs,
            "context": palette.context,
            "registry_count": palette.registry_count,
            "entries": list(entries.values()),
        },
    }
    output = BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED, compresslevel=6) as archive:
        archive.writestr("project.json", json.dumps(manifest, ensure_ascii=False))
        archive.writestr("blocks.i32", statue.state_indices.astype("<i4").tobytes())
        archive.writestr("skin.png", statue.normalized_skin)
        for key in sorted(textures):
            archive.writestr(f"textures/{key}.png", palette.textures[key])
    return output.getvalue()


def open_project(data: bytes) -> tuple[GeneratedStatue, Palette]:
    """读取版本化工程；固定成员直接读入内存，不解压外部路径。"""
    try:
        with ZipFile(BytesIO(data)) as archive:
            if sum(i.file_size for i in archive.infolist()) > 512 * 1024 * 1024:
                raise ValueError("工程展开大小超过 512 MB。")
            root = json.loads(archive.read("project.json"))
            if root["format"] != "skin-statue-project" or root["schema_version"] != 1:
                raise ValueError("不支持的工程版本。")
            identity = "project-" + hashlib.sha256(data).hexdigest()[:20]
            info = root["palette"]
            palette = Palette(info["source"], identity, info["resource_packs"])
            palette.entries = info["entries"]
            palette.context = info["context"]
            palette.registry_count = info["registry_count"]
            by_key = {e["key"]: e for e in palette.entries}
            states = [by_key[e] for e in root["states"]]
            texture_ids = {f["texture_id"] for e in palette.entries for f in e["faces"].values()}
            for key in texture_ids:
                palette.textures[key] = archive.read(f"textures/{key}.png")
            palette.stats = {
                f["texture_id"]: f for e in palette.entries for f in e["faces"].values()
            }
            shape = root["shape"]
            if len(shape) != 3 or any(s < 1 or s > 512 for s in shape):
                raise ValueError("工程尺寸必须在 1～512 格内。")
            blocks = np.frombuffer(archive.read("blocks.i32"), dtype="<i4").reshape(shape).copy()
            if blocks.min() < -1 or blocks.max() >= len(states) or not np.any(blocks >= 0):
                raise ValueError("工程体素引用了无效的材料。")
            preview = root["preview"]
            if preview["dimensions"] != shape or any(
                high - low != size
                for low, high, size in zip(*preview["bounds"], shape, strict=True)
            ):
                raise ValueError("工程包围盒与体素尺寸不符。")
            preview["palette_id"] = palette.id
            parse_skin(archive.read("skin.png"), preview["source"]["model"])
            statue = GeneratedStatue(
                preview, blocks, states, archive.read("skin.png"), root["match_targets"]
            )
            rebuild(statue, palette)
            LOGGER.debug(
                "Opened project: dimensions=%s materials=%s", shape, len(preview["materials"])
            )
            return statue, palette
    except (BadZipFile, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise ValueError(f"工程文件不完整：{exc}") from exc
