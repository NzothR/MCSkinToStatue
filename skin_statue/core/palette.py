"""逐面分析方块纹理，保留静态候选和排除原因。"""

import hashlib
from collections import Counter
from io import BytesIO
from math import sqrt

import numpy as np
from PIL import Image, ImageStat, UnidentifiedImageError

from skin_statue.core.building import DEFAULT_PDIM, classify

FACES = ("east", "west", "up", "down", "south", "north")
DEFAULT_MATCHING = {
    "uniformity": 3.0,
    "border": 3.0,
    "grain": 0.75,
    "connection": 0.5,
    "color_tolerance": 10.0,
    "building": 1.0,
}


def pixel_labs(rgb):
    """批量转换采样像素，保留暗色纹理里肉眼可见的明暗差异。"""
    linear = np.where(rgb <= 10.31475, rgb / 3294.6, ((rgb / 255 + 0.055) / 1.055) ** 2.4)
    xyz = (
        linear
        @ np.array(
            [
                [0.4124564, 0.2126729, 0.0193339],
                [0.3575761, 0.7151522, 0.119192],
                [0.1804375, 0.072175, 0.9503041],
            ]
        )
        / [0.95047, 1, 1.08883]
    )
    f = np.where(xyz > 216 / 24389, np.cbrt(xyz), xyz * 841 / 108 + 4 / 29)
    return np.stack(
        (116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])),
        axis=-1,
    )


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
    return analyze_image(image)


def analyze_image(image: Image.Image) -> dict:
    """比较边带与中心色，并在统一 16×16 尺度测量颗粒，避免高分辨率偏差。"""
    alpha = image.getchannel("A")
    histogram = alpha.histogram()
    total = image.width * image.height
    visible = total - histogram[0]
    # 忽略完全透明像素中的 RGB，默认候选进一步要求所有像素不透明。
    stats = ImageStat.Stat(image.convert("RGB"), alpha)
    rgb = [round(v, 3) for v in stats.mean] if visible else [0.0, 0.0, 0.0]
    pixels = np.asarray(image.resize((16, 16), Image.Resampling.BOX), dtype=np.float32)
    border = np.ones((16, 16), dtype=bool)
    border[2:-2, 2:-2] = False

    def mean(mask):
        weights = pixels[..., 3][mask]
        return (
            np.average(pixels[..., :3][mask], axis=0, weights=weights)
            if weights.sum()
            else np.zeros(3)
        )

    border_contrast = np.linalg.norm(np.array(rgb_to_lab(mean(border))) - rgb_to_lab(mean(~border)))
    labs = pixel_labs(pixels[..., :3])
    weights = pixels[..., 3]
    mean_lab = np.average(labs, axis=(0, 1), weights=weights) if weights.sum() else np.zeros(3)
    uniformity = (
        sqrt(float(np.average(((labs - mean_lab) ** 2).sum(axis=2), weights=weights)))
        if weights.sum()
        else 0
    )
    seams = []
    for axis in (0, 1):
        first, last = np.take(labs, 0, axis=axis), np.take(labs, -1, axis=axis)
        valid = np.minimum(np.take(weights, 0, axis=axis), np.take(weights, -1, axis=axis))
        seams.append(
            float(np.average(np.linalg.norm(first - last, axis=1), weights=valid))
            if valid.sum()
            else 0
        )
    # 只统计两端都可见的相邻像素，透明区域不制造假边缘。
    gradients = []
    for axis in (0, 1):
        difference = np.abs(np.diff(pixels[..., :3], axis=axis)).mean(axis=2)
        valid = np.minimum(
            np.take(pixels[..., 3], range(15), axis=axis),
            np.take(pixels[..., 3], range(1, 16), axis=axis),
        )
        gradients.append(float(np.average(difference, weights=valid)) if valid.sum() else 0)
    return {
        "width": image.width,
        "height": image.height,
        "rgb": rgb,
        "lab": [round(v, 5) for v in rgb_to_lab(rgb)],
        "variance": round(sum(stats.var) / 3, 3) if visible else 0,
        "border_contrast": round(float(border_contrast), 4),
        "grain": round(sum(gradients) / 5.1, 4),
        "uniformity": round(uniformity, 4),
        "seam": round(max(seams), 4),
        "opaque": histogram[255] == total,
        "transparent_fraction": round((total - histogram[255]) / total, 6),
    }


def matching_cost(
    raw, penalty, connection, smoothness: float, prefer_connected: bool, tuning=None, building=None
):
    """限定可牺牲色差，再以边框、颗粒和逐面连接能力排序；输入均为候选向量。"""
    tuning = tuning if tuning is not None else DEFAULT_MATCHING
    costs = (
        raw
        + smoothness * penalty
        - tuning["connection"] * (4 + 6 * smoothness) * connection * prefer_connected
    )
    if building is not None:
        costs = costs + building
    tolerance = tuning["color_tolerance"]
    # 超出颜色预算的候选仍可手选，但排在预算内候选之后。
    outside = max(1000, float(costs.max()) + 1)
    return np.where(raw <= raw.min() + tolerance, costs, outside + costs - costs.min())


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
        self._connected_profiles = {}
        self.building_rules = DEFAULT_PDIM

    def face_profile(self, face: dict, prefer_connected: bool, tuning=None) -> tuple:
        """缓存实际连接图的完整连接区域；缺图时仅给予较弱的声明偏好。"""
        key = face["texture_id"]
        base = self.stats[key]
        tuning = tuning if tuning is not None else DEFAULT_MATCHING
        if "seam" not in base:
            base = self.stats[key] = {"texture_id": key, **analyze_texture(self.textures[key])}
        strength = 0.35 if prefer_connected and face.get("connected_texture") else 0
        sheet = face.get("ctm_texture_id") if prefer_connected else None
        if sheet:
            pair = (key, sheet)
            if pair not in self._connected_profiles:
                from skin_statue.core.connected_preview import composite

                with (
                    Image.open(BytesIO(self.textures[key])) as original,
                    Image.open(BytesIO(self.textures[sheet])) as connected,
                ):
                    interior = analyze_image(
                        composite(original.convert("RGBA"), connected.convert("RGBA"), 255)
                    )
                # 主体平面以连接后的内部为主，保留边界的基础纹理影响。
                blended = {
                    k: 0.8 * interior[k] + 0.2 * base[k]
                    for k in ("variance", "border_contrast", "grain", "uniformity", "seam")
                }
                rgb = 0.8 * np.array(interior["rgb"]) + 0.2 * np.array(base["rgb"])
                self._connected_profiles[pair] = {**blended, "lab": rgb_to_lab(rgb)}
            base = self._connected_profiles[pair]
            strength = 1
        penalty = (
            tuning["uniformity"] * (sqrt(base["variance"]) / 2.55 + base["uniformity"])
            + tuning["border"] * max(base["border_contrast"], base["seam"])
            + tuning["grain"] * base["grain"]
        )
        # CTM 只代表连接能力；有明显渐变或接缝的连接图会削弱奖励。
        return base["lab"], penalty, strength / (1 + penalty / 4)

    def matching_profiles(self, entries: list, prefer_connected: bool, tuning=None) -> tuple:
        """一次准备 P×6 的颜色、平滑惩罚与连接权重，供所有目标颜色复用。"""
        profiles = [
            [self.face_profile(e["faces"][f], prefer_connected, tuning) for f in FACES]
            for e in entries
        ]
        arrays = tuple(
            np.asarray([[face[i] for face in entry] for entry in profiles], dtype=np.float32)
            for i in range(3)
        )
        return (*arrays, self.building_penalties(entries, tuning))

    def building_penalties(self, entries: list, tuning=None):
        """每个建筑等级增加 12×偏好强度代价，颜色预算仍然单独生效。"""
        strength = (tuning or DEFAULT_MATCHING).get("building", DEFAULT_MATCHING["building"])
        return np.asarray(
            [classify(e, self.building_rules)["building_rank"] * 12 * strength for e in entries],
            dtype=np.float32,
        )

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
                "creative_tab": state.get("creative_tab"),
            }
        )
        self.entries[-1].update(classify(self.entries[-1], self.building_rules))

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
        tuning: dict | None = None,
    ) -> dict:
        """按指定朝向，用 Lab 欧氏距离与纹理起伏寻找静态候选；复杂度 O(P)。"""
        target = np.asarray(rgb_to_lab(rgb))
        blocked = excluded or set()
        candidates = self.candidates(prefer_connected, blocked)

        if not candidates:
            raise ValueError("调色板没有可用的静态完整方块候选。")
        profiles = [
            self.face_profile(e["faces"][face], prefer_connected, tuning) for e in candidates
        ]
        labs = np.asarray([p[0] for p in profiles])
        raw = np.linalg.norm(labs - target, axis=1)
        costs = matching_cost(
            raw,
            np.array([p[1] for p in profiles]),
            np.array([p[2] for p in profiles]),
            smoothness,
            prefer_connected,
            tuning,
            self.building_penalties(candidates, tuning),
        )
        best = int(costs.argmin())
        return {
            "key": candidates[best]["key"],
            "cost": round(float(costs[best]), 4),
            "entry": candidates[best],
        }
