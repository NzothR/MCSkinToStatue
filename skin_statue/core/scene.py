"""多人共用方块表，原始替换分组按人物分别保留。"""

import base64
import logging

import numpy as np

from skin_statue.core.editing import rebuild
from skin_statue.core.skin import parse_skin
from skin_statue.core.statue import GeneratedStatue, generate_statue

LOGGER = logging.getLogger(__name__)


def generate_scene(palette, options: dict, document: dict) -> GeneratedStatue:
    """逐个人物采样并匹配，只为最终并集构建网格；重叠位置按列表先后保留。"""
    children = []
    for actor in document["actors"]:
        skin = parse_skin(base64.b64decode(actor["image"].split(",", 1)[1]), actor["model"])
        settings = {
            **options,
            **{
                k: actor[k] for k in ("pose", "held", "cape", "placement", "scale_factor", "layers")
            },
            "head_only": document["mode"] == "head",
        }
        children.append(generate_statue(skin, palette, settings, build_mesh=False))
    low = np.min([c.preview["bounds"][0] for c in children], axis=0)
    high = np.max([c.preview["bounds"][1] for c in children], axis=0)
    shape = high - low
    if max(shape) > 2048 or np.prod(shape) > 12_000_000:
        raise ValueError(
            "整个场景范围超过单轴 2048 格或 1200 万体素，请缩小人物尺寸、间距或生成倍率。"
        )
    blocks = np.full(tuple(shape), -1, dtype=np.int32)
    groups = np.full(tuple(shape), -1, dtype=np.int32)
    states, state_keys, descriptors, targets = [], {}, {}, {}
    overlaps = 0
    for actor, child in zip(document["actors"], children, strict=True):
        state_map = np.full(len(child.states), -1, dtype=np.int32)
        group_map = np.full(len(child.states), -1, dtype=np.int32)
        for index in np.flatnonzero(
            np.bincount(child.group_indices[child.group_indices >= 0], minlength=len(child.states))
        ):
            entry = child.states[int(index)]
            if entry["key"] not in state_keys:
                state_keys[entry["key"]] = len(states)
                states.append(entry)
            state_map[index] = state_keys[entry["key"]]
            group = len(descriptors)
            group_map[index] = group
            descriptors[str(group)] = {
                "key": entry["key"],
                "actor_id": actor["id"],
                "actor_name": actor["name"],
            }
            if entry["key"] in child.match_targets:
                targets[str(group)] = child.match_targets[entry["key"]]
        start = np.asarray(child.preview["bounds"][0]) - low
        region = tuple(
            slice(int(v), int(v + size))
            for v, size in zip(start, child.state_indices.shape, strict=True)
        )
        occupied = child.state_indices >= 0
        overlaps += int(np.count_nonzero(occupied & (blocks[region] >= 0)))
        visible = occupied & (blocks[region] < 0)
        blocks[region][visible] = state_map[child.state_indices[visible]]
        groups[region][visible] = group_map[child.group_indices[visible]]
    report = dict(children[0].preview["matching"])
    weights = [c.preview["matching"]["surface_voxels"] for c in children]
    report["mean_color_error"] = round(
        float(
            np.average(
                [c.preview["matching"]["mean_color_error"] for c in children], weights=weights
            )
        ),
        3,
    )
    report["surface_voxels"] = sum(weights)
    report["unique_color_groups"] = sum(
        c.preview["matching"]["unique_color_groups"] for c in children
    )
    report["ctm_selected"] = sum(
        any(f.get("ctm_texture_id") for f in entry["faces"].values()) for entry in states
    )
    report["max_color_error"] = max(c.preview["matching"]["max_color_error"] for c in children)
    report["interior_block"] = (
        children[0].preview["matching"]["interior_block"]
        if len(children) == 1
        else "按各人物分别填充"
    )
    preview = {
        "palette_id": palette.id,
        "scale": options["scale"],
        "base_height": (8 if document["mode"] == "head" else 32) * options["scale"],
        "bounds": [low.tolist(), high.tolist()],
        "dimensions": shape.tolist(),
        "block_count": int(np.count_nonzero(blocks >= 0)),
        "overlay_blocks": sum(c.preview["overlay_blocks"] for c in children),
        "materials": [],
        "options": {**options, "excluded": sorted(options["excluded"])},
        "matching": report,
        "groups": descriptors,
        "scene": document,
        "overlap_blocks": overlaps,
    }
    result = GeneratedStatue(preview, blocks, states, children[0].normalized_skin, targets, groups)
    rebuild(result, palette)
    LOGGER.debug(
        "Generated scene: mode=%s actors=%s groups=%s overlaps=%s",
        document["mode"],
        len(children),
        len(descriptors),
        overlaps,
    )
    return result
