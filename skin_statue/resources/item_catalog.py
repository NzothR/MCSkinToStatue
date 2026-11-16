"""单个后台线程分批读取物品，方块调色板完成后可立即使用。"""

import logging
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from threading import Event
from zipfile import BadZipFile, ZipFile
from zlib import error as ZlibError

from skin_statue.core.item_images import group_appearances

LOGGER = logging.getLogger(__name__)
WORKER = ThreadPoolExecutor(max_workers=1, thread_name_prefix="skin-items")
JOBS = []


def start_item_import(palette, data: bytes, items: list, block_textures: dict) -> None:
    """保留原 ZIP 内存引用，纹理按路径读取一次，64 个变体发布一次进度。"""
    if not items:
        return
    cancel = Event()
    JOBS.append(cancel)
    palette.item_loading = {
        "active": True,
        "processed": 0,
        "total": len(items),
        "error": None,
        "complete": False,
    }
    textures = {path: info["texture_id"] for path, info in block_textures.items()}

    def progress(count):
        palette.item_loading = {**palette.item_loading, "processed": count}

    def read():
        try:
            with ZipFile(BytesIO(data)) as archive:

                def entries():
                    for index, item in enumerate(items):
                        if cancel.is_set():
                            return
                        layers = []
                        for layer in item["layers"]:
                            path = layer["texture"]["path"]
                            if path not in textures:
                                textures[path] = palette.item_texture(archive.read(path))
                            layers.append({"texture_id": textures[path], "tint": layer["tint"]})
                        yield {
                            **{k: v for k, v in item.items() if k != "layers"},
                            "key": f"{item['registry_name']}@{item['damage']}#{index}",
                            "layers": layers,
                        }

                group_appearances(palette, entries(), progress)
            palette.item_loading = {
                **palette.item_loading,
                "active": False,
                "cancelled": cancel.is_set(),
                "complete": not cancel.is_set(),
            }
        except (ValueError, OSError, KeyError, TypeError, BadZipFile, ZlibError) as exc:
            palette.item_loading = {**palette.item_loading, "active": False, "error": str(exc)}
            LOGGER.debug("Item catalog import failed", exc_info=True)

    WORKER.submit(read)


def stop_item_imports() -> None:
    """服务退出时取消自己启动的物品任务，不等待整个大索引读完。"""
    for cancel in JOBS:
        cancel.set()
    WORKER.shutdown(wait=False, cancel_futures=True)
