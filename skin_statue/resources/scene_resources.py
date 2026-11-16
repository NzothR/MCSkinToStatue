"""从实际启用的实例资源补充持物图片和 MyCTMLib 的连接图。"""

import base64
import json
from io import BytesIO

import numpy as np
from PIL import Image

from skin_statue.core.skin import png_url


def runtime_item(palette, entry):
    """合成真实创造栏变体的多层图标及逐层染色，并保留自定义渲染提示。"""
    if entry["status"] != "captured" or not entry["layers"]:
        raise ValueError(entry.get("error") or "该物品图标尚未捕获。")
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
    data = {
        "id": entry["key"],
        "label": entry.get("display_name") or entry["registry_name"],
        "kind": entry["render_kind"],
        "image": png_url(result),
        "rotate_around": entry.get("rotate_around", False),
        "custom_renderer": entry.get("custom_equipped_renderer", False),
    }
    block = next(
        (
            b
            for b in palette.entries
            if b["registry_name"] == entry.get("block_registry_name")
            and b["metadata"] == entry.get("block_metadata")
        ),
        None,
    )
    if block and set(block["exclusions"]) <= {"gravity_affected", "connected_texture"}:
        data["kind"] = "block"
        data["block_faces"] = {
            face: "data:image/png;base64,"
            + base64.b64encode(palette.textures[f["texture_id"]]).decode("ascii")
            for face, f in block["faces"].items()
        }
    elif entry.get("block_registry_name"):
        data["custom_renderer"] = True
    return data


def item_catalog(resources):
    """提供原版单层物品图标，沿用实例资源包覆盖，不猜测模组自定义渲染模型。"""
    items = {}
    for path in sorted(resources.providers):
        if not path.startswith("assets/minecraft/textures/items/") or not path.endswith(".png"):
            continue
        name = path.rsplit("/", 1)[1][:-4]
        if name.endswith("_overlay") or name.startswith(("empty_", "map_", "clock_", "compass_")):
            continue
        data, _ = resources.resolve(path)
        with Image.open(BytesIO(data)) as source:
            image = source.convert("RGBA")
            if image.height > image.width:
                image = image.crop((0, 0, image.width, image.width))
            image.thumbnail((32, 32), Image.Resampling.NEAREST)
        kind = (
            "bow"
            if name.startswith("bow")
            else "tool"
            if name.endswith(("sword", "pickaxe", "axe", "shovel", "hoe"))
            or name in ("stick", "bone", "blaze_rod", "fishing_rod_uncast")
            else "flat"
        )
        items["minecraft:" + name] = {
            "id": "minecraft:" + name,
            "label": name,
            "kind": kind,
            "image": png_url(image),
        }
    return items


def attach_connections(palette, resources):
    """读取有效 .mcmeta 和 MyCTMLib 配置，附加连接图而不改变原基础颜色。"""
    from skin_statue.core.building import load_instance_rules

    load_instance_rules(palette, resources.root)
    config = resources.root / "config/MyCTMLib.cfg"
    configured = set()
    if config.is_file():
        content = config.read_text(encoding="utf8")
        if "S:textures <" in content:
            configured = {
                s.strip()
                for s in content.split("S:textures <", 1)[1].split(">", 1)[0].splitlines()
                if s.strip() and not s.strip().startswith(("#", "//"))
            }
    cache = {}
    for entry in palette.entries:
        if not (entry["eligible"] or entry["connected_eligible"]):
            continue
        for face in entry["faces"].values():
            icon = face["icon_name"]
            if icon not in cache:
                namespace, name = icon.split(":", 1)
                metadata = f"assets/{namespace}/textures/blocks/{name}.png.mcmeta"
                connection = icon + "_ctm" if icon in configured else None
                if metadata in resources.providers:
                    raw, _ = resources.resolve(metadata)
                    connection = (
                        json.loads(raw.decode("utf-8-sig"))
                        .get("myctmlib", {})
                        .get("connection", connection)
                    )
                info = None
                if connection:
                    ns, texture = (
                        connection.split(":", 1) if ":" in connection else (namespace, connection)
                    )
                    path = f"assets/{ns}/textures/blocks/{texture}.png"
                    raw, _ = resources.resolve(path)
                    with Image.open(BytesIO(raw)) as source:
                        image = source.convert("RGBA")
                        if image.width % 4 or image.height < image.width:
                            raise ValueError(f"MyCTMLib 连接图不是 4×4 布局：{path}")
                        image = image.crop((0, 0, image.width, image.width))
                    stream = BytesIO()
                    image.save(stream, format="PNG")
                    info = palette.texture(stream.getvalue())["texture_id"]
                cache[icon] = info
            if cache[icon]:
                face["ctm_texture_id"] = cache[icon]
    return sum(bool(v) for v in cache.values())
