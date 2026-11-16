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
    parser.add_argument("--instance", type=Path, help="只读载入实例的手持物品与连接纹理资源")
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
        data = args.index.read_bytes()
        palette = import_runtime_index(data)
        PALETTES[palette.id] = palette
        from skin_statue.preferences import remember_index

        remember_index(data)
        logging.info(
            "Loaded %s registry blocks, %s states, %s static candidates",
            palette.registry_count,
            len(palette.entries),
            sum(entry["eligible"] for entry in palette.entries),
        )
    if args.instance:
        from skin_statue.main import load_scene_resources

        result = load_scene_resources(str(args.instance))
        logging.info(
            "Loaded scene resources: items=%s connected faces=%s",
            len(result["items"]),
            result["connected_textures"],
        )
    server = uvicorn.Server(
        uvicorn.Config(
            app, host="127.0.0.1", port=args.port, log_level="debug" if args.debug else "info"
        )
    )
    app.state.server = server
    try:
        server.run()
    finally:
        from skin_statue.resources.item_catalog import stop_item_imports

        stop_item_imports()


if __name__ == "__main__":
    main()
