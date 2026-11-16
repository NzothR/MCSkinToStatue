"""仅在项目缓存中保存最近运行时索引和选材偏好。"""

import json
from pathlib import Path
from threading import Lock

CACHE = Path(__file__).resolve().parents[1] / ".cache" / "preferences"
INDEX = CACHE / "runtime-index.zip"
SETTINGS = CACHE / "matching.json"
LOCK = Lock()


def remember_index(data: bytes) -> None:
    """保存已成功解析的索引副本，原 ZIP 移动后仍可恢复。"""
    with LOCK:
        CACHE.mkdir(parents=True, exist_ok=True)
        temporary = INDEX.with_suffix(".tmp")
        temporary.write_bytes(data)
        temporary.replace(INDEX)


def save_matching(settings: dict) -> None:
    """原子替换白名单算法参数，不记录姿势、皮肤或尺寸。"""
    with LOCK:
        CACHE.mkdir(parents=True, exist_ok=True)
        temporary = SETTINGS.with_suffix(".tmp")
        temporary.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf8")
        temporary.replace(SETTINGS)


def read_matching() -> dict:
    """首次启动没有设置文件，使用接口定义的默认值。"""
    with LOCK:
        return json.loads(SETTINGS.read_text(encoding="utf8")) if SETTINGS.is_file() else {}
