"""将物品层和染色合成为静态外观，只合并同注册项里最终图像相同的变体。"""

import hashlib
from io import BytesIO

import numpy as np
from PIL import Image


def compose_item(palette, entry, decoded: dict, tinted: dict) -> Image.Image:
    """已确认非空的物品层：每张 PNG 解码一次，每个染色组合计算一次。"""
    result = None
    for layer in entry["layers"]:
        key, tint = layer["texture_id"], layer["tint"]
        if key not in decoded:
            with Image.open(BytesIO(palette.textures[key])) as source:
                decoded[key] = source.convert("RGBA").resize((32, 32), Image.Resampling.NEAREST)
        pair = (key, tint)
        if pair not in tinted:
            if tint == 0xFFFFFF:
                tinted[pair] = decoded[key]
            else:
                pixels = np.array(decoded[key])
                pixels[..., :3] = (
                    pixels[..., :3].astype(np.uint16)
                    * np.array([(tint >> 16) & 255, (tint >> 8) & 255, tint & 255], dtype=np.uint16)
                    // 255
                ).astype(np.uint8)
                tinted[pair] = Image.fromarray(pixels)
        image = tinted[pair]
        result = image if result is None else Image.alpha_composite(result, image)
    return result


def search_document(entry):
    """构建一次完整搜索文本，保留多词 AND 与名称排除的不同匹配域。"""
    names = " ".join(
        [
            entry["key"],
            str(entry["numeric_id"]),
            entry.get("display_name") or "",
            *entry.get("search_aliases", []),
        ]
    ).casefold()
    return names, names + " " + " ".join(entry.get("search_texts", [])).casefold()


def group_appearances(palette, entries=None, on_batch=None) -> None:
    """分批发布不可变记录；同一纹理层组合只解码合成一次，NBT 数值不影响外观。"""
    source = palette.items if entries is None else entries
    palette.items = []
    palette.item_images = {}
    palette.item_search = {}
    decoded, tinted = {}, {}
    groups, slots, changed, appearance_cache = {}, {}, {}, {}
    count = 0

    def publish():
        for slot, record in changed.items():
            exposed = {
                **record,
                "search_aliases": sorted(record["search_aliases"]),
                "search_texts": sorted(record["search_texts"]),
            }
            palette.item_search[exposed["key"]] = search_document(exposed)
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
                image = compose_item(palette, entry, decoded, tinted)
                buffer = BytesIO()
                image.save(buffer, format="PNG")
                # 完全透明像素的隐藏 RGB 不应把同一可见外观拆成不同组。
                pixels = np.array(image)
                pixels[pixels[..., 3] == 0] = 0
                appearance_cache[layer_key] = (
                    hashlib.sha256(pixels.tobytes()).hexdigest(),
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


def search_items(entries, query: str, search_index):
    """空白词为 AND；!词排除名称／ID，正向词还能匹配真实工具材料说明。"""
    tokens = query.casefold().split()
    if not tokens:
        yield from entries
        return
    positive = [t for t in tokens if not t.startswith("!") or t == "!"]
    negative = [t[1:] for t in tokens if t.startswith("!") and len(t) > 1]
    for entry in entries:
        names, indexed = search_index[entry["key"]]
        if all(t in indexed for t in positive) and not any(t in names for t in negative):
            yield entry
