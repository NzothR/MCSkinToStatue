"""FastAPI 本地服务：无持久化的皮肤解析接口和离线前端。"""

import logging
from pathlib import Path
from typing import Annotated, Literal

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from skin_statue.core.skin import parse_skin

WEB = Path(__file__).parent / "web"
app = FastAPI(title="Skin Statue · 皮肤预览", docs_url=None, redoc_url=None)


@app.get("/")
def index() -> FileResponse:
    """打开本地预览界面。"""
    return FileResponse(WEB / "index.html")


@app.post("/api/skin")
async def import_skin(
    file: Annotated[UploadFile, File()],
    model: Annotated[Literal["steve", "alex"], Form()] = "steve",
) -> dict:
    """读取上传的 PNG 并解析；图片不写入服务器磁盘。"""
    try:
        data = await file.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024:
            raise HTTPException(413, "皮肤文件需小于 2 MB。")
        try:
            return await run_in_threadpool(parse_skin, data, model)
        except ValueError as exc:
            logging.getLogger(__name__).debug("Skin import rejected: %s", exc)
            raise HTTPException(422, str(exc)) from exc
    finally:
        await file.close()


app.mount("/static", StaticFiles(directory=WEB), name="static")
