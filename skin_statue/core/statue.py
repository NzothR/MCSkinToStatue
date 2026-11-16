"""皮肤到整数体素、逐面方块匹配及隐藏面剔除／贪心网格。"""

import base64
import logging
from dataclasses import dataclass
from io import BytesIO
from math import ceil, sqrt

import numpy as np
from PIL import Image

from skin_statue.core.palette import FACES, Palette, matching_cost, rgb_to_lab
from skin_statue.core.posed_voxels import posed_voxels
from skin_statue.core.skin import png_url

LOGGER = logging.getLogger(__name__)
# 数组按 X/Y/Z 排列；顺序与六面调色板及前端顶点生成一致。
DIRECTIONS = ((0, 1), (0, -1), (1, 1), (1, -1), (2, 1), (2, -1))


@dataclass
class GeneratedStatue:
    """同一次生成的预览、实际状态数组和来源，供导出复用而不重新匹配。"""

    preview: dict
    state_indices: np.ndarray
    states: list[dict]
    normalized_skin: bytes
    # 每种材料对应的原皮肤颜色签名及频次，用于编辑时重新排列候选。
    match_targets: dict
    # 生成时的材质槽位固定为替换分组；后续材质相同也不会合并范围。
    group_indices: np.ndarray


def exposure(occupied: np.ndarray, axis: int, sign: int) -> np.ndarray:
    """返回指定方向面向空气的体素，外边界视为空气。"""
    padded = np.pad(occupied, 1)
    neighbor = [slice(1, -1)] * 3
    neighbor[axis] = slice(2, None) if sign == 1 else slice(None, -2)
    return occupied & ~padded[tuple(neighbor)]


def paint_faces(targets, occupied, base, owners, box, part, layer, image, options, owner):
    """外层逐面沿法线填到主体边界，各面的 Alpha 独立决定棱角处的占据。"""
    lo, hi = box
    base_lo, base_hi = lo, hi
    if layer == "overlay":
        inflation = max(
            options["overlay_offset"], part["layers"][layer]["inflate"] * options["scale"]
        )
        # 采样格中心，半格边界使用左闭右开，与旋转路径一致。
        lo = np.ceil(lo - inflation - 0.5).astype(int)
        hi = np.ceil(hi + inflation - 0.5).astype(int)
    for direction, face in enumerate(FACES):
        axis, sign = DIRECTIONS[direction]
        plane = [slice(lo[i], hi[i]) for i in range(3)]
        plane[axis] = (
            (slice(base_hi[axis], hi[axis]) if sign == 1 else slice(lo[axis], base_lo[axis]))
            if layer == "overlay"
            else (hi[axis] - 1 if sign == 1 else lo[axis])
        )
        plane = tuple(plane)
        shape = tuple(hi[i] - lo[i] for i in range(3) if i != axis)
        # 侧面图集横向对应 Z，顶底面横向对应 X，正背面横向对应 X。
        width, height = (shape[1], shape[0]) if axis == 0 else shape
        patch = image.crop(part["layers"][layer]["faces"][face])
        detail = options["detail"]
        if detail > 1:
            patch = patch.resize(
                (max(1, patch.width // detail), max(1, patch.height // detail)),
                Image.Resampling.BOX,
            )
        pixels = np.asarray(patch.resize((width, height), Image.Resampling.NEAREST))
        if face in ("east", "west", "south", "north"):
            pixels = pixels[::-1]
        if face in ("east", "north"):
            pixels = pixels[:, ::-1]
        # 底面的几何 Z 方向与 UV 的翻转相互抵消，和顶面一样按 PNG 行顺序取色。
        if axis != 0:
            pixels = pixels.transpose(1, 0, 2)
        if layer == "overlay":
            pixels = np.broadcast_to(np.expand_dims(pixels, axis), (*occupied[plane].shape, 4))
        if layer == "base":
            targets[plane + (direction,)] = pixels
        else:
            allowed = (pixels[..., 3] >= options["alpha_threshold"]) & ~base[plane]
            allowed &= (owners[plane] < 0) | (owners[plane] == owner)
            occupied[plane] |= allowed
            owners[plane][allowed] = owner
            targets[plane + (direction,)][allowed] = pixels[allowed]


def match_surface(occupied, targets, palette, options):
    """对唯一的可见面颜色组合批量匹配，同一体素的所有外露面共同计分。"""
    candidates = palette.candidates(options["prefer_connected"], options["excluded"])
    if not candidates:
        raise ValueError("没有可用的完整方块候选，请载入调色板或调整禁用列表。")
    visible = np.stack([exposure(occupied, axis, sign) for axis, sign in DIRECTIONS], axis=-1)
    surface = visible.any(axis=-1)
    samples = targets[surface]
    provided = samples[..., 3] > 0
    colors = samples[..., :3].astype(np.float32)
    # 每个已占据的表面体素都来自至少一个已绘制的 UV 面。
    average = colors.sum(axis=1) / provided.sum(axis=1)[:, None]
    colors = np.where(provided[..., None], colors, average[:, None, :])
    flags = visible[surface]
    colors = np.rint(colors).astype(np.uint8)
    colors[~flags] = 0
    signatures = np.concatenate(
        (colors.reshape(-1, 18), np.packbits(flags, axis=1, bitorder="little")), axis=1
    )
    unique, inverse = np.unique(signatures, axis=0, return_inverse=True)
    labs, penalty, connection = palette.matching_profiles(
        candidates, options["prefer_connected"], options.get("matching")
    )
    selected = np.empty(len(unique), dtype=np.int32)
    errors = np.empty(len(unique), dtype=np.float32)
    maxima = np.empty(len(unique), dtype=np.float32)
    for index, signature in enumerate(unique):
        target = np.array(
            [rgb_to_lab(row) for row in signature[:18].reshape(6, 3)], dtype=np.float32
        )
        weights = ((int(signature[18]) >> np.arange(6)) & 1).astype(np.float32)
        delta = np.sqrt(((labs - target) ** 2).sum(axis=2))
        raw = (delta * weights).sum(axis=1) / weights.sum()
        costs = matching_cost(
            raw,
            (penalty * weights).sum(axis=1) / weights.sum(),
            (connection * weights).sum(axis=1) / weights.sum(),
            options["smoothness"],
            options["prefer_connected"],
            options.get("matching"),
        )
        best = int(costs.argmin())
        selected[index] = best
        errors[index] = (delta[best] * weights).sum() / weights.sum()
        maxima[index] = delta[best][weights > 0].max()
    result = np.full(occupied.shape, -1, dtype=np.int32)
    result[surface] = selected[inverse]
    dominant = int(np.bincount(selected[inverse], minlength=len(candidates)).argmax())
    result[occupied & ~surface] = dominant
    frequencies = np.bincount(inverse, minlength=len(unique))
    material_targets = {}
    for signature, choice, count in zip(unique, selected, frequencies, strict=True):
        material_targets.setdefault(candidates[int(choice)]["key"], []).append(
            [signature.tolist(), int(count)]
        )
    return (
        result,
        candidates,
        {
            "unique_color_groups": len(unique),
            "method": "uniform-seam-ctm-v3",
            "ctm_available": sum(
                any(f.get("ctm_texture_id") for f in e["faces"].values()) for e in candidates
            ),
            "ctm_selected": sum(
                any(f.get("ctm_texture_id") for f in candidates[int(i)]["faces"].values())
                for i in np.unique(selected)
            ),
            "mean_color_error": round(float(errors[inverse].mean()), 3),
            "max_color_error": round(float(maxima.max()), 3),
            "interior_block": candidates[dominant]["key"],
        },
        material_targets,
    )


def hollow_base(occupied, base, thickness):
    """对主体并集做六邻域腐蚀，保留指定厚度外壳；第二层体素保持独立。"""
    interior = base.copy()
    for _ in range(thickness):
        boundary = np.zeros(base.shape, dtype=bool)
        for axis, sign in DIRECTIONS:
            boundary |= exposure(interior, axis, sign)
        interior &= ~boundary
    return occupied & ~interior


def texture_atlas(palette, candidates, counts):
    """只打包本次用到的六面纹理；保留像素边界和一像素采样边框。"""
    keys = sorted(
        {
            entry["faces"][face]["texture_id"]
            for i, entry in enumerate(candidates)
            if counts[i]
            for face in FACES
        }
    )
    columns = ceil(sqrt(len(keys)))
    tile_size = 64
    while columns * (tile_size + 2) > 4096:
        tile_size //= 2
    stride = tile_size + 2
    atlas = Image.new("RGBA", (columns * stride, ceil(len(keys) / columns) * stride))
    indices = {key: i for i, key in enumerate(keys)}
    for key, index in indices.items():
        with Image.open(BytesIO(palette.textures[key])) as source:
            tile = source.convert("RGBA").resize((tile_size, tile_size), Image.Resampling.NEAREST)
        x, y = (index % columns) * stride + 1, (index // columns) * stride + 1
        atlas.paste(tile, (x, y))
        atlas.paste(tile.crop((0, 0, 1, tile_size)), (x - 1, y))
        atlas.paste(tile.crop((tile_size - 1, 0, tile_size, tile_size)), (x + tile_size, y))
        atlas.paste(tile.crop((0, 0, tile_size, 1)), (x, y - 1))
        atlas.paste(tile.crop((0, tile_size - 1, tile_size, tile_size)), (x, y + tile_size))
    lookup = np.full((len(candidates), 6), -1, dtype=np.int32)
    for i, entry in enumerate(candidates):
        if counts[i]:
            lookup[i] = [indices[entry["faces"][face]["texture_id"]] for face in FACES]
    rgb = [palette.stats[key]["rgb"] for key in keys]
    return lookup, {
        "image": png_url(atlas),
        "columns": columns,
        "tile_size": tile_size,
        "width": atlas.width,
        "height": atlas.height,
        "colors": rgb,
    }


def greedy_mesh(blocks, lookup, origin, overrides=None):
    """剔除不透明方块内面，并将同纹理同方向的连续面合并为矩形。"""
    occupied = blocks >= 0
    quads = []
    exposed_count = 0
    for face, (axis, sign) in enumerate(DIRECTIONS):
        tiles = None
        if overrides and face in overrides:
            tiles = lookup[blocks, face].copy()
            points, choices = overrides[face]
            tiles[tuple(points.T)] = choices
        faces = exposure(occupied, axis, sign)
        exposed_count += int(faces.sum())
        for plane_index in range(blocks.shape[axis]):
            plane = [slice(None)] * 3
            plane[axis] = plane_index
            plane = tuple(plane)
            state = blocks[plane]
            mask = np.full(state.shape, -1, dtype=np.int32)
            active = faces[plane]
            mask[active] = lookup[state[active], face] if tiles is None else tiles[plane][active]
            if axis != 0:
                mask = mask.T.copy()
            height, width = mask.shape
            for v in range(height):
                u = 0
                while u < width:
                    tile = int(mask[v, u])
                    if tile < 0:
                        u += 1
                        continue
                    w = 1
                    while u + w < width and mask[v, u + w] == tile:
                        w += 1
                    h = 1
                    while v + h < height and np.all(mask[v + h, u : u + w] == tile):
                        h += 1
                    mask[v : v + h, u : u + w] = -1
                    local = (
                        [plane_index, v, u]
                        if axis == 0
                        else [u, plane_index, v]
                        if axis == 1
                        else [u, v, plane_index]
                    )
                    quads.append([*(local[i] + int(origin[i]) for i in range(3)), face, w, h, tile])
                    u += w
    packed = np.asarray(quads, dtype="<i4")
    return {
        "quads": base64.b64encode(packed.tobytes()).decode("ascii"),
        "quad_count": len(quads),
        "exposed_faces": exposed_count,
    }


def generate_statue(parsed: dict, palette: Palette, options: dict) -> GeneratedStatue:
    """生成实际方块体素并返回批处理预览网格、材料统计与生成参数。"""
    scale = options["scale"]
    parts = parsed["parts"]
    offset = max(
        options["overlay_offset"],
        ceil(max(p["layers"]["overlay"]["inflate"] for p in parts) * scale),
    )
    with Image.open(
        BytesIO(base64.b64decode(parsed["images"]["normalized"].split(",", 1)[1]))
    ) as source:
        image = source.convert("RGBA")
    articulated = any(any(v for v in angle) for angle in options.get("pose", {}).values()) or any(
        h.get("image") for h in options.get("held", {}).values()
    )
    articulated |= bool(
        options.get("cape", {}).get("enabled", True) and options.get("cape", {}).get("selected")
    )
    if articulated:
        low, occupied, base, targets = posed_voxels(parsed, image, options)
    else:
        low = (
            np.floor(
                np.min(
                    [
                        np.array(p["position"]) * scale - np.array(p["size"]) * scale / 2
                        for p in parts
                    ],
                    axis=0,
                )
            ).astype(int)
            - offset
            - 1
        )
        high = (
            np.ceil(
                np.max(
                    [
                        np.array(p["position"]) * scale + np.array(p["size"]) * scale / 2
                        for p in parts
                    ],
                    axis=0,
                )
            ).astype(int)
            + offset
            + 1
        )
        shape = tuple(high - low)
        base = np.zeros(shape, dtype=bool)
        targets = np.zeros((*shape, 6, 4), dtype=np.uint8)
        boxes = []
        for part in parts:
            size = np.array(part["size"]) * scale
            lo = np.rint(np.array(part["position"]) * scale - size / 2).astype(int) - low
            hi = lo + size
            boxes.append((lo, hi))
            if f"{part['id']}:base" in options["layers"]:
                base[tuple(slice(lo[i], hi[i]) for i in range(3))] = True
        occupied = base.copy()
        owners = np.full(shape, -1, dtype=np.int8)
        for layer in ("base", "overlay"):
            for owner, (part, box) in enumerate(zip(parts, boxes, strict=True)):
                if f"{part['id']}:{layer}" not in options["layers"]:
                    continue
                paint_faces(
                    targets, occupied, base, owners, box, part, layer, image, options, owner
                )
    if not occupied.any():
        raise ValueError("没有可生成的皮肤图层，请至少启用一个含像素的图层。")
    blocks, candidates, report, material_targets = match_surface(
        occupied, targets, palette, options
    )
    if options["hollow"]:
        occupied = hollow_base(occupied, base, options["shell_thickness"])
        blocks[~occupied] = -1
    positions = np.argwhere(occupied)
    bounds = [positions.min(axis=0) + low, positions.max(axis=0) + low + 1]
    counts = np.bincount(blocks[occupied], minlength=len(candidates))
    from skin_statue.core.connected_preview import preview_mesh

    atlas, mesh, ctm = preview_mesh(blocks, candidates, palette, low)
    materials = [
        {
            "key": entry["key"],
            "registry_name": entry["registry_name"],
            "numeric_id": entry["numeric_id"],
            "metadata": entry["metadata"],
            "display_name": entry.get("display_name"),
            "count": int(counts[i]),
        }
        for i, entry in enumerate(candidates)
        if counts[i]
    ]
    materials.sort(key=lambda row: -row["count"])
    result = {
        "palette_id": palette.id,
        "scale": scale,
        "base_height": 32 * scale,
        "bounds": [b.tolist() for b in bounds],
        "dimensions": (bounds[1] - bounds[0]).tolist(),
        "block_count": int(occupied.sum()),
        "overlay_blocks": int((occupied & ~base).sum()),
        "materials": materials,
        "options": {**options, "excluded": sorted(options["excluded"])},
        "matching": report,
        "atlas": atlas,
        "mesh": mesh,
        "ctm": ctm,
    }
    LOGGER.debug(
        "Generated statue: scale=%s dimensions=%s blocks=%s quads=%s matching=%s",
        scale,
        result["dimensions"],
        result["block_count"],
        mesh["quad_count"],
        report,
    )
    minimum = positions.min(axis=0)
    maximum = positions.max(axis=0) + 1
    cropped = blocks[tuple(slice(minimum[i], maximum[i]) for i in range(3))].copy()
    return GeneratedStatue(
        result,
        cropped,
        candidates,
        base64.b64decode(parsed["images"]["normalized"].split(",", 1)[1]),
        material_targets,
        cropped.copy(),
    )
