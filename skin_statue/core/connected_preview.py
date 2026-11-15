"""根据真实邻接图标拼接 MyCTMLib 4×4 四象限连接纹理。"""

import logging
from io import BytesIO

import numpy as np
from PIL import Image

from skin_statue.core.palette import FACES

LOGGER = logging.getLogger(__name__)

# 每个面的 UV 上、右方向；次序为 east/west/up/down/south/north。
UV_AXES = [
    ((0, 1, 0), (0, 0, -1)),
    ((0, 1, 0), (0, 0, 1)),
    ((0, 0, -1), (1, 0, 0)),
    ((0, 0, -1), (1, 0, 0)),
    ((0, 1, 0), (1, 0, 0)),
    ((0, 1, 0), (-1, 0, 0)),
]


def composite(base, sheet, mask):
    """按 MyCTMLib iconIdx 的四象限索引选择基础角或连接角，不做模糊平滑。"""
    connected = [(mask >> i) & 1 for i in range(8)]
    indices = []
    for a, b, diagonal, full, corner, side_a, side_b, isolated in (
        (3, 0, 7, 1, 11, 9, 3, 17),
        (0, 1, 4, 2, 12, 4, 10, 18),
        (2, 3, 6, 5, 15, 7, 13, 19),
        (1, 2, 5, 6, 16, 14, 8, 20),
    ):
        indices.append(
            full
            if connected[a] and connected[b] and connected[diagonal]
            else corner
            if connected[a] and connected[b]
            else side_a
            if connected[a]
            else side_b
            if connected[b]
            else isolated
        )
    result = Image.new("RGBA", (64, 64))
    for quadrant, index in enumerate(indices):
        source, grid, tile = (base, 2, index - 17) if index >= 17 else (sheet, 4, index - 1)
        size = source.width // grid
        patch = source.crop(
            (
                (tile % grid) * size,
                (tile // grid) * size,
                (tile % grid + 1) * size,
                (tile // grid + 1) * size,
            )
        )
        result.paste(
            patch.resize((32, 32), Image.Resampling.NEAREST),
            ((quadrant % 2) * 32, (quadrant // 2) * 32),
        )
    return result


def preview_mesh(blocks, states, palette, origin, connected=True):
    """按实际图标邻接替换暴露面的材质，再与普通面一起贪心合并。"""
    from skin_statue.core.statue import DIRECTIONS, exposure, greedy_mesh, texture_atlas

    counts = np.bincount(blocks[blocks >= 0], minlength=len(states))
    virtual = list(states)
    extra_counts = list(counts)
    overrides = {}
    variants = {}
    connected_faces = 0
    unresolved = set()
    occupied = blocks >= 0
    for f, face in enumerate(FACES):
        if not connected:
            break
        images = {}
        icon_ids = {}
        state_icons = np.array(
            [icon_ids.setdefault(e["faces"][face]["icon_name"], len(icon_ids)) for e in states]
            + [-1]
        )
        for i, e in enumerate(states):
            descriptor = e["faces"][face]
            if not counts[i]:
                continue
            if descriptor.get("ctm_texture_id"):
                images[i] = descriptor
            elif e["connected_texture"] and (
                descriptor.get("connected_texture")
                or not any(d.get("ctm_texture_id") for d in e["faces"].values())
            ):
                unresolved.add(e["key"])
        if not images:
            continue
        visible = exposure(occupied, *DIRECTIONS[f])
        points = np.argwhere(visible & np.isin(blocks, list(images)))
        if not len(points):
            continue
        world_icons = state_icons[blocks]
        up, right = (np.array(v) for v in UV_AXES[f])
        directions = [up, right, -up, -right, up + right, right - up, -up - right, up - right]
        masks = np.zeros(len(points), dtype=np.uint8)
        icons = world_icons[tuple(points.T)]
        for bit, vector in enumerate(directions):
            neighbor = points + vector
            valid = np.all((neighbor >= 0) & (neighbor < blocks.shape), axis=1)
            indices = np.nonzero(valid)[0]
            masks[indices] |= (world_icons[tuple(neighbor[valid].T)] == icons[valid]).astype(
                np.uint8
            ) << bit
        choices = np.empty(len(points), dtype=np.int32)
        cell_states = blocks[tuple(points.T)]
        for state_index, mask in np.unique(np.column_stack((cell_states, masks)), axis=0):
            descriptor = images[int(state_index)]
            cache_key = (descriptor["texture_id"], descriptor["ctm_texture_id"], int(mask))
            if cache_key not in variants:
                with (
                    Image.open(BytesIO(palette.textures[cache_key[0]])) as base,
                    Image.open(BytesIO(palette.textures[cache_key[1]])) as sheet,
                ):
                    image = composite(base.convert("RGBA"), sheet.convert("RGBA"), int(mask))
                stream = BytesIO()
                image.save(stream, format="PNG")
                stats = palette.texture(stream.getvalue())
                variants[cache_key] = len(virtual)
                virtual.append({"faces": {face: stats for face in FACES}})
                extra_counts.append(1)
            choices[(cell_states == state_index) & (masks == mask)] = variants[cache_key]
        overrides[f] = (points, choices)
        connected_faces += len(points)
    lookup, atlas = texture_atlas(palette, virtual, extra_counts)
    overrides = {f: (points, lookup[choices, f]) for f, (points, choices) in overrides.items()}
    LOGGER.debug(
        "CTM preview: enabled=%s connected_faces=%s variants=%s unsupported=%s",
        connected,
        connected_faces,
        len(variants),
        sorted(unresolved),
    )
    return (
        atlas,
        greedy_mesh(blocks, lookup, origin, overrides),
        {
            "enabled": connected,
            "connected_faces": connected_faces,
            "unsupported_materials": sorted(unresolved),
        },
    )
