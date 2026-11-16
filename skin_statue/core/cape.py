"""官方 Java 披风 64×32 图集及其等比例高清版本。"""

import base64
from io import BytesIO

from PIL import Image, UnidentifiedImageError

from skin_statue.core.skin import face_rects


def read_cape(data: bytes) -> Image.Image:
    """披风使用独立图集，不能按玩家皮肤或普通物品裁切。"""
    if len(data) > 2 * 1024 * 1024:
        raise ValueError("披风 PNG 需不超过 2 MB。")
    try:
        with Image.open(BytesIO(data)) as source:
            if (
                source.format != "PNG"
                or source.width % 64
                or not 64 <= source.width <= 512
                or source.height * 2 != source.width
            ):
                raise ValueError("披风需要 64×32 的 PNG，或最大 512×256 的等比例高清图集。")
            return source.convert("RGBA")
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("无法读取披风 PNG。") from exc


def cape_faces(uri: str) -> tuple[Image.Image, dict]:
    """按 10×16×1 披风盒的六面 UV 裁切，保留两面的图案和窄边。"""
    image = read_cape(base64.b64decode(uri.split(",", 1)[1]))
    factor = image.width // 64
    faces = {
        face: image.crop(tuple(v * factor for v in box))
        for face, box in face_rects(0, 0, 10, 16, 1).items()
    }
    return image, faces
