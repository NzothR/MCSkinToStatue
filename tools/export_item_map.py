"""从辅助模组 ZIP 导出可供脚本处理的真实名称映射；不按语言键猜测注册 ID。"""

import argparse
import json
from pathlib import Path
from zipfile import ZipFile


def main():
    """只读取索引清单，保存物品变体、NBT 和方块 Metadata 对应的名字。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("index", type=Path)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "output/item-mapping.json",
    )
    args = parser.parse_args()
    with ZipFile(args.index) as archive:
        source = json.loads(archive.read("registry.json"))
    if source.get("format") != "skin-statue-block-index":
        raise ValueError("请选择辅助模组导出的索引 ZIP。")
    fields = (
        "registry_name",
        "numeric_id",
        "damage",
        "display_name",
        "unlocalized_name",
        "nbt",
        "status",
        "error",
    )
    result = {
        "format": "skin-statue-item-map",
        "schema_version": 1,
        "language": source.get("language"),
        "exporter_version": source.get("exporter_version"),
        "items": [{k: e[k] for k in fields if k in e} for e in source.get("items", [])],
        "blocks": [
            {
                "registry_name": b["registry_name"],
                "numeric_id": b["numeric_id"],
                "metadata": s["metadata"],
                "display_name": s.get("display_name"),
                "creative_confirmed": s.get("creative_confirmed", False),
            }
            for b in source["blocks"]
            for s in b["states"]
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf8")
    print(
        f"已保存 {len(result['items'])} 个物品变体、{len(result['blocks'])} 个方块探测状态：{args.output}"
    )
    if "items" not in source:
        print("当前 ZIP 不含物品映射；完整物品数据需要用辅助模组 0.1.3 重新导出。")


if __name__ == "__main__":
    main()
