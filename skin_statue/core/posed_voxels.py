"""在世界体素中心逆变换采样旋转部件，避免正向旋转散点造成孔洞。"""

from itertools import product

import numpy as np
from PIL import Image

from skin_statue.core.palette import FACES
from skin_statue.core.pose import scene_objects


def sample_face(points, face, size, patch):
    """按现有六面 UV 朝向采样局部坐标，包含顶底面的 Z 方向。"""
    x, y, z = (points / size + 0.5).T
    u, v = {
        "south": (x, 1 - y),
        "north": (1 - x, 1 - y),
        "east": (1 - z, 1 - y),
        "west": (z, 1 - y),
        "up": (x, z),
        "down": (x, z),
    }[face]
    px = np.clip((u * patch.shape[1]).astype(int), 0, patch.shape[1] - 1)
    py = np.clip((v * patch.shape[0]).astype(int), 0, patch.shape[0] - 1)
    return patch[py, px]


def posed_voxels(parsed, image, options):
    """按部位分片逆采样实体和透明外层，输出与站姿生成相同的颜色缓冲区。"""
    scale = options["scale"]
    objects = scene_objects(parsed, options)
    # 薄片也需要至少一格的几何厚度；按逆变换后的格宽覆盖斜放的物品表面。
    for obj in objects:
        if "image" in obj and "cube_faces" not in obj:
            inverse = np.linalg.inv(obj["matrix"][:3, :3])
            # 给边界一个数值余量，避免一格薄片恰好落在两排体素中心之间而全部落空。
            minimum = np.abs(inverse[2]).sum() / scale * (1 + 1e-6)
            obj["size"][2] = max(obj["size"][2], minimum)
            obj["center"][2] = -obj["size"][2] / 2
    boxes = []
    corner = np.array(list(product((-0.5, 0.5), repeat=3)))
    for obj in objects:
        size = obj["size"] + (2 * options["overlay_offset"] / scale if "part" in obj else 0)
        world = (corner * size + obj.get("center", 0)) @ obj["matrix"][:3, :3].T + obj["matrix"][
            :3, 3
        ]
        boxes.append(
            (
                np.floor(world.min(axis=0) * scale).astype(int) - 1,
                np.ceil(world.max(axis=0) * scale).astype(int) + 1,
            )
        )
    low = np.min([b[0] for b in boxes], axis=0)
    high = np.max([b[1] for b in boxes], axis=0)
    shape = tuple(high - low)
    if np.prod(shape) > 12_000_000 or max(shape) > 2048:
        raise ValueError(
            "这个姿势的体素范围过大，请降低主体高度或物品缩放（单轴上限 2048 格、总量 1200 万格）。"
        )
    occupied = np.zeros(shape, dtype=bool)
    base = np.zeros(shape, dtype=bool)
    targets = np.zeros((*shape, 6, 4), dtype=np.uint8)
    directions = np.array([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]])
    # 基础实体先合并，外层仅覆盖空气；以分片限制逆采样的临时坐标内存。
    for layer in ("base", "overlay"):
        for obj, (start, end) in zip(objects, boxes, strict=True):
            item = "image" in obj
            if item and layer == "overlay":
                continue
            if not item and f"{obj['id']}:{layer}" not in options["layers"]:
                continue
            size = obj["size"] + (
                2 * options["overlay_offset"] / scale if layer == "overlay" else 0
            )
            inverse = np.linalg.inv(obj["matrix"][:3, :3])
            center = obj.get("center", np.zeros(3))
            if "cube_faces" in obj:
                patches = {face: np.asarray(patch) for face, patch in obj["cube_faces"].items()}
            elif not item:
                patches = {}
                for face in FACES:
                    patch = image.crop(obj["part"]["layers"][layer]["faces"][face])
                    if options["detail"] > 1:
                        patch = patch.resize(
                            (
                                max(1, patch.width // options["detail"]),
                                max(1, patch.height // options["detail"]),
                            ),
                            Image.Resampling.BOX,
                        )
                    patches[face] = np.asarray(patch)
            for sy in range(start[1], end[1], 16):
                world = np.stack(
                    np.meshgrid(
                        np.arange(start[0], end[0]),
                        np.arange(sy, min(sy + 16, end[1])),
                        np.arange(start[2], end[2]),
                        indexing="ij",
                    ),
                    axis=-1,
                ).reshape(-1, 3)
                points = ((world + 0.5) / scale - obj["matrix"][:3, 3]) @ inverse.T - center
                active = np.all(np.abs(points) < size / 2, axis=1)
                if not active.any():
                    continue
                world, points = world[active], points[active]
                index = tuple((world - low).T)
                available = ~occupied[index]
                if not available.any():
                    continue
                world, points = world[available], points[available]
                if item and "cube_faces" not in obj:
                    pixels = np.asarray(obj["image"])
                    px = np.clip(
                        ((0.5 - points[:, 0] / 16) * pixels.shape[1]).astype(int),
                        0,
                        pixels.shape[1] - 1,
                    )
                    py = np.clip(
                        ((0.5 - points[:, 1] / 16) * pixels.shape[0]).astype(int),
                        0,
                        pixels.shape[0] - 1,
                    )
                    colors = np.repeat(pixels[py, px, None, :], 6, axis=1)
                    keep = colors[:, 0, 3] >= options["alpha_threshold"]
                else:
                    distance = size / 2 - np.abs(points)
                    closest_axis = distance.argmin(axis=1)
                    nearest_face = 2 * closest_axis + (
                        points[np.arange(len(points)), closest_axis] < 0
                    )
                    nearest = np.empty((len(points), 4), dtype=np.uint8)
                    for f, face in enumerate(FACES):
                        mask = nearest_face == f
                        nearest[mask] = sample_face(points[mask], face, size, patches[face])
                    keep = (
                        np.ones(len(points), dtype=bool)
                        if layer == "base"
                        else (
                            (distance.min(axis=1) < 1 / scale)
                            & (nearest[:, 3] >= options["alpha_threshold"])
                        )
                    )
                    colors = np.empty((len(points), 6, 4), dtype=np.uint8)
                    for direction, normal in enumerate(directions):
                        ray = inverse @ normal
                        times = np.full(points.shape, np.inf)
                        moving = np.abs(ray) > 1e-8
                        times[:, moving] = (
                            np.sign(ray[moving]) * size[moving] / 2 - points[:, moving]
                        ) / ray[moving]
                        axis = times.argmin(axis=1)
                        faces = 2 * axis + (ray[axis] < 0)
                        hits = points + times.min(axis=1)[:, None] * ray
                        for f, face in enumerate(FACES):
                            mask = faces == f
                            colors[mask, direction] = sample_face(
                                hits[mask], face, size, patches[face]
                            )
                    invisible = colors[..., 3] < options["alpha_threshold"]
                    colors[invisible] = np.broadcast_to(nearest[:, None, :], colors.shape)[
                        invisible
                    ]
                index = tuple((world[keep] - low).T)
                occupied[index] = True
                if layer == "base":
                    base[index] = True
                targets[index] = colors[keep]
    return low, occupied, base, targets
