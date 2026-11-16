"""按 GTNH 私人维度允许清单、装饰系列和运行时创造标签归类材料。"""

import json
import re
from pathlib import Path

CATALOG = json.loads(Path(__file__).with_name("building_materials.json").read_text(encoding="utf8"))
PRIMARY = set(CATALOG["primary_blocks"])
VANILLA_BUILDING = {"minecraft:" + name for name in CATALOG["vanilla_building_blocks"]}


def parse_specs(specs: list[str]) -> dict[str, list[int]]:
    """读取 PersonalSpace 的 metadata 范围和 !排除，未指定时只含 metadata 0。"""
    result = {}
    for spec in specs:
        parts = spec.split(":")
        name = ":".join(parts[:2])
        tokens = [t.strip() for t in parts[2].split(",")] if len(parts) == 3 else ["0"]
        included = set(range(16)) if all(t.startswith("!") for t in tokens) else set()
        for token in tokens:
            exclude = token.startswith("!")
            bounds = token.lstrip("!").split("-")
            values = range(int(bounds[0]), int(bounds[-1]) + 1)
            if exclude:
                included.difference_update(values)
            else:
                included.update(values)
        result.setdefault(name, set()).update(included)
    return {name: sorted(values) for name, values in result.items()}


DEFAULT_PDIM = parse_specs(CATALOG["personal_space"])


def classify(entry: dict, rules: dict) -> dict:
    """只给予明确来源的建筑材料优先权，不以显示名或模糊的 concrete 子串判断。"""
    name = entry["registry_name"]
    if name == "minecraft:bedrock":
        rank, label, source = 2, "其他材料（基岩）", "unobtainable"
    elif entry["metadata"] in rules.get(name, []):
        rank, label, source = 0, "私人维度建筑材料", "personalspace"
    elif name in PRIMARY or name.startswith("Ztones:"):
        rank, label, source = 0, "常用建筑／Ztones", "building_catalog"
    elif entry.get("creative_tab") == "buildingBlocks" or (
        not entry.get("creative_tab") and name in VANILLA_BUILDING
    ):
        rank, label, source = (
            1,
            "建筑方块分类",
            "creative_tab" if entry.get("creative_tab") else "vanilla_1.7.10",
        )
    elif name.startswith("chisel:"):
        rank, label, source = 1, "Chisel 建筑系列", "building_catalog"
    else:
        rank, label, source = 2, "其他材料", "unclassified"
    return {"building_rank": rank, "building_label": label, "building_source": source}


def load_instance_rules(palette, root: Path) -> None:
    """只读使用实例实际允许的分层、边界、中心、路网间隙清单，保存到工程。"""
    path = root / "config/personalspace.cfg"
    if not path.is_file():
        return
    content = path.read_text(encoding="utf8")
    specs = []
    for body in re.findall(
        r"(?ms)^allowed(?:blocks|boundaryblocks|centerblocks|gapblocks)\s*\{(.*?)^\}", content
    ):
        for block in re.findall(r"S:general\s*<([^>]*)>", body):
            specs.extend(
                line.split("#", 1)[0].strip()
                for line in block.splitlines()
                if line.split("#", 1)[0].strip()
            )
    palette.building_rules = parse_specs(specs)
    for entry in palette.entries:
        entry.update(classify(entry, palette.building_rules))
