"""将物品层和染色合成为静态外观，只合并同注册项里最终图像相同的变体。"""

import hashlib
from io import BytesIO

import numpy as np
from PIL import Image


def compose_item(palette, entry) -> Image.Image:
    """原版多层图标及自定义渲染截帧共用透明合成，不叠加耐久数字。"""
    result = Image.new("RGBA", (32, 32))
    for layer in entry["layers"]:
        with Image.open(BytesIO(palette.textures[layer["texture_id"]])) as source:
            image = source.convert("RGBA").resize((32, 32), Image.Resampling.NEAREST)
        pixels = np.array(image)
        tint = layer["tint"]
        pixels[..., :3] = (
            pixels[..., :3].astype(np.uint16)
            * np.array([(tint >> 16) & 255, (tint >> 8) & 255, tint & 255], dtype=np.uint16)
            // 255
        ).astype(np.uint8)
        result = Image.alpha_composite(result, Image.fromarray(pixels))
    return result


def group_appearances(palette, entries=None, on_batch=None) -> None:
    """分批发布不可变记录；同一纹理层组合只解码合成一次，NBT 数值不影响外观。"""
    source = palette.items if entries is None else entries
    palette.items = []
    palette.item_images = {}
    groups, slots, changed, appearance_cache = {}, {}, {}, {}
    count = 0

    def publish():
        for slot, record in changed.items():
            exposed = {
                **record,
                "search_aliases": sorted(record["search_aliases"]),
                "search_texts": sorted(record["search_texts"]),
            }
            if slot == len(palette.items):
                palette.items.append(exposed)
            else:
                palette.items[slot] = exposed
        changed.clear()
        if on_batch is not None:
            on_batch(count)

    for count, entry in enumerate(source, 1):
        captured = entry["status"] == "captured" and entry["layers"]
        if captured:
            layer_key = tuple((layer["texture_id"], layer["tint"]) for layer in entry["layers"])
            if layer_key not in appearance_cache:
                image = compose_item(palette, entry)
                buffer = BytesIO()
                image.save(buffer, format="PNG")
                appearance_cache[layer_key] = (
                    hashlib.sha256(image.tobytes()).hexdigest(),
                    buffer.getvalue(),
                )
            visual, png = appearance_cache[layer_key]
        else:
            visual = (entry["damage"], entry.get("display_name"), entry.get("error"))
        signature = (
            entry["registry_name"],
            entry.get("render_kind", "flat"),
            entry.get("rotate_around", False),
            entry.get("block_registry_name"),
            entry.get("block_metadata"),
            visual,
        )
        aliases = entry.get(
            "search_aliases",
            [
                f"{entry.get('display_name') or ''} {entry['registry_name']}@{entry['damage']} {entry['numeric_id']}:{entry['damage']}"
            ],
        )
        search_texts = [
            *entry.get("search_texts", entry.get("search_text", [])),
            *entry.get("material_names", []),
        ]
        if signature in groups:
            record = groups[signature]
            record["variant_count"] += entry.get("variant_count", 1)
            record["search_aliases"].update(aliases)
            record["search_texts"].update(search_texts)
        else:
            record = {
                **entry,
                "variant_count": entry.get("variant_count", 1),
                "search_aliases": set(aliases),
                "search_texts": set(search_texts),
            }
            if not captured:
                record["status"] = "unresolved"
            slots[signature] = len(groups)
            groups[signature] = record
            if captured:
                palette.item_images[entry["key"]] = png
        changed[slots[signature]] = record
        if count % 64 == 0:
            publish()
    publish()


def search_items(entries, query: str):
    """空白词为 AND；!词排除名称／ID，正向词还能匹配真实工具材料说明。"""
    tokens = query.casefold().split()
    if not tokens:
        yield from entries
        return
    positive = [t for t in tokens if not t.startswith("!") or t == "!"]
    negative = [t[1:] for t in tokens if t.startswith("!") and len(t) > 1]
    for entry in entries:
        names = " ".join(
            [
                entry["key"],
                str(entry["numeric_id"]),
                entry.get("display_name") or "",
                *entry.get("search_aliases", []),
            ]
        ).casefold()
        indexed = names + " " + " ".join(entry.get("search_texts", [])).casefold()
        if all(t in indexed for t in positive) and not any(t in names for t in negative):
            yield entry
