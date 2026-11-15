"""逐面分析方块纹理，保留静态候选和排除原因。"""

import hashlib
from collections import Counter
from io import BytesIO
from math import sqrt

from PIL import Image, ImageStat, UnidentifiedImageError

FACES = ("east", "west", "up", "down", "south", "north")


def rgb_to_lab(rgb: tuple | list) -> tuple[float, float, float]:
    """将 sRGB 转为 D65 CIELAB，供颜色候选匹配使用。"""
    r, g, b = [v / 3294.6 if v <= 10.31475 else ((v / 255 + 0.055) / 1.055) ** 2.4 for v in rgb]
    xyz = (
        (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047,
        r * 0.2126729 + g * 0.7151522 + b * 0.072175,
        (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883,
    )
    x, y, z = [v ** (1 / 3) if v > 216 / 24389 else v * 841 / 108 + 4 / 29 for v in xyz]
    return (116 * y - 16, 500 * (x - y), 200 * (y - z))


def analyze_texture(data: bytes) -> dict:
    """分析单帧 PNG 的可见像素均值、色彩起伏和透明比例。"""
    try:
        with Image.open(BytesIO(data)) as source:
            if source.format != "PNG":
                raise ValueError("索引纹理必须为 PNG。")
            image = source.convert("RGBA")
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("无法读取索引中的 PNG 纹理。") from exc
    alpha = image.getchannel("A")
    histogram = alpha.histogram()
    total = image.width * image.height
    visible = total - histogram[0]
    # 忽略完全透明像素中的 RGB，默认候选进一步要求所有像素不透明。
    stats = ImageStat.Stat(image.convert("RGB"), alpha)
    rgb = [round(v, 3) for v in stats.mean] if visible else [0.0, 0.0, 0.0]
    return {
        "width": image.width,
        "height": image.height,
        "rgb": rgb,
        "lab": [round(v, 5) for v in rgb_to_lab(rgb)],
        "variance": round(sum(stats.var) / 3, 3) if visible else 0,
        "opaque": histogram[255] == total,
        "transparent_fraction": round((total - histogram[255]) / total, 6),
    }


class Palette:
    """保存运行时或已知原版映射的状态、逐面纹理与颜色。"""

    def __init__(self, source: str, identity: str, resource_packs: list):
        """使用来源签名标识调色板，便于后续缓存失效。"""
        self.source = source
        self.id = identity
        self.resource_packs = resource_packs
        self.entries = []
        self.textures: dict[str, bytes] = {}
        self.stats: dict[str, dict] = {}
        self.errors = []
        self.registry_count = 0
        self.context = {}
        self.items = []

    def texture(self, data: bytes) -> dict:
        """按 PNG 内容去重；颜色分析与缩略图共用同一纹理。"""
        key = hashlib.sha256(data).hexdigest()[:24]
        if key not in self.textures:
            stats = analyze_texture(data)
            self.textures[key] = data
            self.stats[key] = {"texture_id": key, **stats}
        return self.stats[key]

    def add_state(
        self, registry_name: str, numeric_id: int, state: dict, faces: dict, reasons: list
    ) -> None:
        """记录真实映射，并用逐面属性决定是否能进入默认静态调色板。"""
        reasons = list(reasons)
        if state.get("status") != "captured":
            reasons.append("unresolved")
        if not state.get("creative_confirmed", False):
            reasons.append("unconfirmed_metadata")
        if not state.get("normal_cube", False) or not state.get("opaque", False):
            reasons.append("non_opaque_cube")
        if state.get("render_type") != 0:
            reasons.append("custom_renderer")
        if state.get("has_tile_entity", False):
            reasons.append("tile_entity")
        if state.get("render_color", 0xFFFFFF) != 0xFFFFFF:
            reasons.append("tinted")
        if state.get("light_value", 0) != 0:
            reasons.append("emissive")
        if state.get("gravity_affected", False):
            reasons.append("gravity_affected")
        if len(faces) != 6:
            reasons.append("missing_faces")
        if any(not face["opaque"] for face in faces.values()):
            reasons.append("transparent_texture")
        if any(face.get("animated", False) for face in faces.values()):
            reasons.append("animated")
        if registry_name in (
            "minecraft:air",
            "minecraft:water",
            "minecraft:flowing_water",
            "minecraft:lava",
            "minecraft:flowing_lava",
        ):
            reasons.append("air_or_fluid")
        self.entries.append(
            {
                "key": f"{registry_name}@{state['metadata']}",
                "registry_name": registry_name,
                "numeric_id": numeric_id,
                "metadata": state["metadata"],
                "display_name": state.get("display_name"),
                "faces": faces,
                "eligible": not reasons,
                "connected_texture": "connected_texture" in reasons,
                "connected_eligible": set(reasons) == {"connected_texture"},
                "exclusions": list(dict.fromkeys(reasons)),
                "status": state.get("status", "unresolved"),
                "error": state.get("error"),
            }
        )

    def summary(self) -> dict:
        """返回适合界面展示的调色板统计。"""
        counts = Counter(reason for entry in self.entries for reason in entry["exclusions"])
        return {
            "id": self.id,
            "source": self.source,
            "registry_count": self.registry_count,
            "states": len(self.entries),
            "textures": len(self.textures),
            "eligible": sum(entry["eligible"] for entry in self.entries),
            "connected_eligible": sum(entry["connected_eligible"] for entry in self.entries),
            "exclusions": dict(counts),
            "resource_packs": self.resource_packs,
            "errors": self.errors,
            "context": self.context,
            "item_variants": len(self.items),
        }

    def candidates(self, prefer_connected: bool, excluded) -> list[dict]:
        """连接纹理选项只放开这一项排除，重力和其他排除条件始终保留。"""
        return [
            entry
            for entry in self.entries
            if entry["key"] not in excluded
            and (entry["eligible"] or prefer_connected and entry["connected_eligible"])
        ]

    def match(
        self,
        rgb: tuple,
        face: str,
        smoothness: float = 0.2,
        excluded: set | None = None,
        prefer_connected: bool = False,
    ) -> dict:
        """按指定朝向，用 Lab 欧氏距离与纹理起伏寻找静态候选；复杂度 O(P)。"""
        target = rgb_to_lab(rgb)
        blocked = excluded or set()
        candidates = self.candidates(prefer_connected, blocked)

        def cost(entry: dict) -> float:
            color = entry["faces"][face]
            delta = sqrt(sum((a - b) ** 2 for a, b in zip(target, color["lab"], strict=True)))
            return (
                delta
                + smoothness * sqrt(color["variance"]) / 2.55
                - (3 if prefer_connected and entry["connected_texture"] else 0)
            )

        result = min(candidates, key=cost, default=None)
        if result is None:
            raise ValueError("调色板没有可用的静态完整方块候选。")
        return {"key": result["key"], "cost": round(cost(result), 4), "entry": result}
