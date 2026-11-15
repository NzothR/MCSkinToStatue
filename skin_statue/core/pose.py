"""皮肤关节与手持物品共用的变换；单位为皮肤像素，Y 向上、+Z 为正面。"""

import base64
import logging
from io import BytesIO
from itertools import product

import numpy as np
from PIL import Image, UnidentifiedImageError

LOGGER = logging.getLogger(__name__)


def translation(x=0, y=0, z=0):
    """创建列向量约定的齐次平移矩阵。"""
    matrix = np.eye(4)
    matrix[:3, 3] = (x, y, z)
    return matrix


def rotation(angles):
    """按模型部件的 Z/Y/X 次序应用角度，与客户端 ModelRenderer 一致。"""
    x, y, z = np.radians(angles)
    cx, cy, cz = np.cos((x, y, z))
    sx, sy, sz = np.sin((x, y, z))
    rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    matrix = np.eye(4)
    matrix[:3, :3] = rz @ ry @ rx
    return matrix


def scaling(x, y, z):
    """创建物品渲染使用的非均匀缩放矩阵。"""
    return np.diag([x, y, z, 1.0])


def item_image(data):
    """读取工程内的手持 PNG，保留 Alpha 并限制单张输入的采样规模。"""
    raw = base64.b64decode(data.split(",", 1)[1])
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError("手持纹理需不超过 2 MB。")
    try:
        with Image.open(BytesIO(raw)) as source:
            if source.format != "PNG" or max(source.size) > 256:
                raise ValueError("手持物品需要最大 256×256 的 PNG。")
            image = source.convert("RGBA")
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("无法读取手持物品 PNG。") from exc
    image.thumbnail((32, 32), Image.Resampling.NEAREST)
    return image


def held_matrix(kind, rotate_around=False):
    """复现 1.7.10 RenderPlayer + ItemRenderer 第三人称静态持物变换。"""
    matrix = scaling(1, -1, -1) @ translation(-1, 7, 1)
    if kind == "block":
        return (
            matrix
            @ translation(0, 3, -5)
            @ rotation([20, 0, 0])
            @ rotation([0, 45, 0])
            @ scaling(-0.375, -0.375, 0.375)
        )
    if kind == "bow":
        matrix = (
            matrix @ translation(0, 2, 5) @ rotation([0, -20, 0]) @ scaling(0.625, -0.625, 0.625)
        )
        matrix = matrix @ rotation([-100, 0, 0]) @ rotation([0, 45, 0])
    elif kind == "tool":
        if rotate_around:
            matrix = matrix @ rotation([0, 0, 180]) @ translation(0, -2, 0)
        matrix = matrix @ translation(0, 3, 0) @ scaling(0.625, -0.625, 0.625)
        matrix = matrix @ rotation([-100, 0, 0]) @ rotation([0, 45, 0])
    else:
        matrix = matrix @ translation(4, 3, -3) @ scaling(0.375, 0.375, 0.375)
        matrix = matrix @ rotation([0, 0, 60]) @ rotation([-90, 0, 0]) @ rotation([0, 0, 20])
    return (
        matrix
        @ translation(0, -4.8, 0)
        @ scaling(1.5, 1.5, 1.5)
        @ rotation([0, 50, 0])
        @ rotation([0, 0, 335])
        @ translation(-15, -1, 0)
    )


def scene_objects(parsed, options):
    """输出各部位和独立左右手物品的同源世界矩阵，作为预览及体素化输入。"""
    pose = options.get("pose", {})
    torso = translation(0, 24, 0) @ rotation(pose.get("body", [0, 0, 0])) @ translation(0, -24, 0)
    objects = []
    for part in parsed["parts"]:
        name = part["id"]
        pivot = (
            [0, 24, 0]
            if name in ("head", "body")
            else [-5 if name.startswith("right") else 5, 22, 0]
            if "arm" in name
            else [-2 if name.startswith("right") else 2, 12, 0]
        )
        joint = (
            torso
            if name == "body"
            else torso
            @ translation(*pivot)
            @ rotation(pose.get(name, [0, 0, 0]))
            @ translation(*(-np.array(pivot)))
        )
        objects.append(
            {
                "id": name,
                "part": part,
                "matrix": joint @ translation(*part["position"]),
                "size": np.array(part["size"], dtype=float),
            }
        )
        hand = "right" if name == "right_arm" else "left" if name == "left_arm" else None
        held = options.get("held", {}).get(hand) if hand else None
        if held and held.get("image"):
            image = item_image(held["image"])
            if not np.any(np.asarray(image)[..., 3] >= options.get("alpha_threshold", 128)):
                raise ValueError(f"{'右' if hand == 'right' else '左'}手物品没有可体素化的像素。")
            transform = held_matrix(held["kind"], held.get("rotate_around", False))
            slim = part["size"][0] == 3
            if slim:
                transform = translation(0.5, 0, 0) @ transform
            if hand == "left":
                transform = scaling(-1, 1, 1) @ transform
            grip = np.array([(-0.5 if slim else -1) * (1 if hand == "right" else -1), -10, -1])
            factor = held.get("scale", 1)
            transform = (
                translation(*(grip + held.get("offset", [0, 0, 0])))
                @ rotation(held.get("rotation", [0, 0, 0]))
                @ scaling(factor, factor, factor)
                @ translation(*(-grip))
                @ transform
            )
            thickness = held.get("thickness", 0)
            cube = held["kind"] == "block"
            cube_faces = (
                {
                    face: item_image(held.get("block_faces", {}).get(face, held["image"]))
                    for face in ("east", "west", "up", "down", "south", "north")
                }
                if cube
                else {}
            )
            if cube and any(
                np.any(np.asarray(face)[..., 3] != 255) for face in cube_faces.values()
            ):
                raise ValueError("立方体持物需要不透明纹理；透明 PNG 请使用普通物品或工具类型。")
            objects.append(
                {
                    "id": hand + "_item",
                    "image": image,
                    "matrix": joint @ translation(*pivot) @ transform,
                    "size": np.array([16.0, 16.0, 16.0 if cube else thickness]),
                    "center": np.zeros(3) if cube else np.array([8.0, 8.0, -thickness / 2]),
                    **({"cube_faces": cube_faces} if cube else {}),
                }
            )
    # 任意姿势都以最低点落地；物品只随手臂及躯干变换，不改写姿势角度。
    corners = np.array(list(product((-0.5, 0.5), repeat=3)))
    lowest = min(
        ((corners * o["size"] + o.get("center", 0)) @ o["matrix"][:3, :3].T + o["matrix"][:3, 3])[
            :, 1
        ].min()
        for o in objects
        if "part" in o
    )
    for obj in objects:
        obj["matrix"][1, 3] -= lowest
    LOGGER.debug(
        "Pose scene: rotations=%s held=%s floor_offset=%s",
        pose,
        [o["id"] for o in objects if "image" in o],
        -lowest,
    )
    return objects


def pose_preview(parsed, options):
    """将统一矩阵和物品像素打包给浏览器，物品网格使用实例化绘制。"""
    result = []
    for obj in scene_objects(parsed, options):
        row = {"id": obj["id"], "matrix": obj["matrix"].T.reshape(-1).tolist()}
        if "cube_faces" in obj:
            row["cube"] = {
                face: {
                    "width": image.width,
                    "height": image.height,
                    "pixels": np.asarray(image).reshape(-1).tolist(),
                }
                for face, image in obj["cube_faces"].items()
            }
        elif "image" in obj:
            pixels = np.asarray(obj["image"])
            y, x = np.nonzero(pixels[..., 3] >= options.get("alpha_threshold", 128))
            row.update(
                {
                    "thickness": float(obj["size"][2]),
                    "width": obj["image"].width,
                    "height": obj["image"].height,
                    "pixels": np.column_stack((x, y, pixels[y, x, :3])).tolist(),
                }
            )
        result.append(row)
    return {"objects": result}
