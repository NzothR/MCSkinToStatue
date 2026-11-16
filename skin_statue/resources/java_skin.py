"""通过 Mojang 的公开玩家档案和纹理服务读取正版 Java 皮肤。"""

import base64
import json
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from skin_statue.core.cape import read_cape
from skin_statue.core.skin import parse_skin, png_url


def fetch_skin(username: str) -> dict:
    """用户名→UUID→档案纹理；网络查询不需要微软登录凭据。"""
    if not re.fullmatch(r"[A-Za-z0-9_]{1,16}", username):
        raise ValueError("Java 用户名由 1～16 个英文字母、数字或下划线组成。")

    def read(url: str, limit: int) -> bytes:
        """读取官方服务的有界响应，向界面报告账户与网络错误。"""
        try:
            with urlopen(
                Request(url, headers={"User-Agent": "SkinStatue/1.0"}), timeout=20
            ) as response:
                if response.status == 204:
                    raise ValueError("没有找到这个 Java 玩家。")
                data = response.read(limit + 1)
                if len(data) > limit:
                    raise ValueError("皮肤服务返回的数据过大。")
                return data
        except HTTPError as exc:
            message = (
                "没有找到这个 Java 玩家。"
                if exc.code in (404, 400)
                else (
                    "官方服务请求过于频繁，请稍后再试。"
                    if exc.code == 429
                    else f"官方皮肤服务返回 HTTP {exc.code}。"
                )
            )
            raise ValueError(message) from exc
        except (URLError, TimeoutError) as exc:
            raise ValueError(f"连接官方皮肤服务失败：{exc}") from exc

    profile = json.loads(read(f"https://api.mojang.com/users/profiles/minecraft/{username}", 65536))
    session = json.loads(
        read(f"https://sessionserver.mojang.com/session/minecraft/profile/{profile['id']}", 262144)
    )
    textures_property = next(p for p in session["properties"] if p["name"] == "textures")
    textures = json.loads(base64.b64decode(textures_property["value"]))["textures"]
    if "SKIN" not in textures:
        raise ValueError("该玩家尚未设置自定义皮肤，请导入本地皮肤文件。")
    skin = textures["SKIN"]
    location = urlsplit(skin["url"])
    if location.hostname != "textures.minecraft.net" or not re.fullmatch(
        r"/texture/[0-9a-f]+", location.path
    ):
        raise ValueError("官方档案中的皮肤纹理地址无效。")
    data = read("https://textures.minecraft.net" + location.path, 2 * 1024 * 1024)
    model = "alex" if skin.get("metadata", {}).get("model") == "slim" else "steve"
    parsed = parse_skin(data, model)
    capes = []
    if "CAPE" in textures:
        cape_url = urlsplit(textures["CAPE"]["url"])
        if cape_url.hostname != "textures.minecraft.net" or not re.fullmatch(
            r"/texture/[0-9a-f]+", cape_url.path
        ):
            raise ValueError("官方档案中的披风纹理地址无效。")
        cape = read_cape(read("https://textures.minecraft.net" + cape_url.path, 2 * 1024 * 1024))
        capes.append(
            {
                "id": cape_url.path.rsplit("/", 1)[-1],
                "name": f"{profile['name']} · 官方当前披风",
                "image": png_url(cape),
            }
        )
    return {
        "username": profile["name"],
        "uuid": profile["id"],
        "model": model,
        "image": parsed["images"]["normalized"],
        "capes": capes,
    }
