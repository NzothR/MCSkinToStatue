"""解析 Java 版标准皮肤，统一为 64×64 RGBA 和独立的双层六面数据。"""

import base64
import logging
from io import BytesIO
from typing import Literal

from PIL import Image, UnidentifiedImageError

LOGGER = logging.getLogger(__name__)
Model = Literal["steve", "alex"]

# UV 原点是 PNG 左上角；坐标使用玩家右手为 -X、正面为 +Z、向上为 +Y。
PARTS = (
    ("head", "头部", (8, 8, 8), (0, 28, 0), (0, 0), (32, 0)),
    ("body", "身体", (8, 12, 4), (0, 18, 0), (16, 16), (16, 32)),
    ("right_arm", "右臂", (4, 12, 4), (-6, 18, 0), (40, 16), (40, 32)),
    ("left_arm", "左臂", (4, 12, 4), (6, 18, 0), (32, 48), (48, 48)),
    ("right_leg", "右腿", (4, 12, 4), (-2, 6, 0), (0, 16), (0, 32)),
    ("left_leg", "左腿", (4, 12, 4), (2, 6, 0), (16, 48), (0, 48)),
)


def face_rects(u: int, v: int, w: int, h: int, d: int) -> dict:
    """返回六个面的像素边界；顺序与 Three.js BoxGeometry 的面顺序一致。"""
    return {
        "east": (u + d + w, v + d, u + 2 * d + w, v + d + h),
        "west": (u, v + d, u + d, v + d + h),
        "up": (u + d, v, u + d + w, v + d),
        "down": (u + d + w, v, u + d + 2 * w, v + d),
        "south": (u + d, v + d, u + d + w, v + d + h),
        "north": (u + 2 * d + w, v + d, u + 2 * d + 2 * w, v + d + h),
    }


def mirror_limb(image: Image.Image, source: tuple, target: tuple) -> None:
    """将旧皮肤的右肢逐面镜像到左肢，并交换内侧和外侧纹理。"""
    src = face_rects(*source, 4, 12, 4)
    dst = face_rects(*target, 4, 12, 4)
    for face, rect in dst.items():
        other = {"east": "west", "west": "east"}.get(face, face)
        patch = image.crop(src[other]).transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        image.paste(patch, rect[:2])


def png_url(image: Image.Image) -> str:
    """编码无损 PNG，供预览和下载共同使用。"""
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def parse_skin(data: bytes, model: Model = "steve") -> dict:
    """校验并解析标准皮肤；基础层按 Java 规则强制不透明，外层保留 Alpha。"""
    try:
        with Image.open(BytesIO(data)) as source:
            if source.format != "PNG":
                raise ValueError("请选择 PNG 格式的 Minecraft 皮肤。")
            if source.size not in ((64, 64), (64, 32)):
                raise ValueError("支持 64×64 标准皮肤和 64×32 旧版皮肤。")
            source_size = source.size
            image = source.convert("RGBA")
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("无法读取 PNG，请检查文件是否完整。") from exc

    legacy = source_size == (64, 32)
    notes = []
    if legacy:
        model = "steve"
        normalized = Image.new("RGBA", (64, 64))
        normalized.paste(image, (0, 0))
        image = normalized
        mirror_limb(image, (0, 16), (16, 48))
        mirror_limb(image, (40, 16), (32, 48))
        # Java 旧格式兼容规则：上方右半区没有 Alpha <128 时，清除旧帽子背景。
        if image.getchannel("A").crop((32, 0, 64, 32)).getextrema()[0] >= 128:
            image.paste((0, 0, 0, 0), (32, 0, 64, 16))
            notes.append("已清除旧格式的不透明帽子背景。")
        notes.append("旧版左右肢体已逐面镜像补全；旧格式使用 Steve 模型。")

    layers = {name: Image.new("RGBA", (64, 64)) for name in ("base", "overlay")}
    parts = []
    for key, label, size, position, base_uv, outer_uv in PARTS:
        if "arm" in key and model == "alex":
            size = (3, 12, 4)
            position = (-5.5 if key == "right_arm" else 5.5, 18, 0)
        part = {"id": key, "label": label, "size": size, "position": position, "layers": {}}
        for layer, uv in (("base", base_uv), ("overlay", outer_uv)):
            rects = face_rects(*uv, *size)
            visible = translucent = 0
            for rect in rects.values():
                patch = image.crop(rect)
                if layer == "base":
                    patch.putalpha(255)
                    image.paste(patch, rect[:2])
                layers[layer].paste(patch, rect[:2])
                histogram = patch.getchannel("A").histogram()
                visible += sum(histogram[1:])
                translucent += sum(histogram[1:255])
            part["layers"][layer] = {
                "faces": rects,
                "pixels": visible,
                "translucent_pixels": translucent,
                "inflate": 0 if layer == "base" else (0.5 if key == "head" else 0.25),
            }
        parts.append(part)

    LOGGER.debug(
        "Parsed skin: size=%s model=%s legacy=%s parts=%s", source_size, model, legacy, parts
    )
    return {
        "source_size": source_size,
        "size": [64, 64],
        "legacy": legacy,
        "model": model,
        "notes": notes,
        "parts": parts,
        "images": {"normalized": png_url(image), **{k: png_url(v) for k, v in layers.items()}},
    }
