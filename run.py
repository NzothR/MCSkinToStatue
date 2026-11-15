"""启动绑定 127.0.0.1 的皮肤预览服务。"""

import argparse
import logging
from pathlib import Path

import uvicorn


def main() -> None:
    """解析启动配置并运行本地服务，调试日志默认关闭。"""
    parser = argparse.ArgumentParser(description="Minecraft Skin Statue 本地皮肤预览")
    parser.add_argument("--port", type=int, default=8765, help="本地端口，默认 8765")
    parser.add_argument("--debug", action="store_true", help="开启解析和服务调试日志")
    parser.add_argument("--index", type=Path, help="启动时载入指定的运行时方块索引 ZIP")
    args = parser.parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )
    print(f"\n皮肤预览界面：http://127.0.0.1:{args.port}\n按 Ctrl+C 停止服务。\n")
    from skin_statue.main import PALETTES, app
    from skin_statue.resources.registry import import_runtime_index

    if args.index:
        logging.info("Loading runtime block index: %s", args.index)
        palette = import_runtime_index(args.index.read_bytes())
        PALETTES[palette.id] = palette
        logging.info(
            "Loaded %s registry blocks, %s states, %s static candidates",
            palette.registry_count,
            len(palette.entries),
            sum(entry["eligible"] for entry in palette.entries),
        )
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=args.port,
        log_level="debug" if args.debug else "info",
    )


if __name__ == "__main__":
    main()
