"""识别 CTM 规则影响的静态候选；连接纹理本身由游戏渲染器处理。"""

import fnmatch
import re
from pathlib import PurePosixPath


def number_matches(value: int, selector: str) -> bool:
    """匹配数字、逗号列表和闭区间。"""
    for token in selector.split(","):
        if re.fullmatch(r"\d+", token) and value == int(token):
            return True
        if re.fullmatch(r"\d+-\d+", token):
            low, high = map(int, token.split("-"))
            if low <= value <= high:
                return True
    return False


def affected_by_ctm(name: str, number: int, meta: int, icons: list[str], rules: list[dict]) -> bool:
    """按 matchBlocks／matchTiles 和 Metadata 筛出依赖连接环境的候选。"""
    for rule in rules:
        if rule.get("metadata") and not number_matches(meta, rule["metadata"]):
            continue
        selectors = rule.get("matchBlocks", "").split()
        for selector in selectors:
            segments = selector.split(":")
            if segments[0][0:1].isdigit():
                matches = number_matches(number, segments[0])
                metadata = segments[1] if len(segments) > 1 else None
            else:
                if len(segments) == 1:
                    registry, metadata = "minecraft:" + segments[0], None
                elif segments[1][0:1].isdigit():
                    registry, metadata = "minecraft:" + segments[0], segments[1]
                else:
                    registry = ":".join(segments[:2])
                    metadata = segments[2] if len(segments) > 2 else None
                matches = name == registry
            if matches and (not metadata or number_matches(meta, metadata)):
                return True
        tiles = rule.get("matchTiles", "").split()
        if not selectors and not tiles:
            tiles = [PurePosixPath(rule["path"]).stem]
        for tile in tiles:
            tile = tile.removesuffix(".png").replace("textures/blocks/", "")
            if ":" not in tile:
                tile = "minecraft:" + tile
            if any(fnmatch.fnmatchcase(icon, tile) for icon in icons):
                return True
    return False
