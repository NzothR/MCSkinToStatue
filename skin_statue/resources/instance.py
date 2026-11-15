"""只读扫描 1.7.10 实例，按启用顺序解析资源包覆盖。"""

import hashlib
import json
import logging
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from threading import RLock
from zipfile import BadZipFile, ZipFile

LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class ResourceSource:
    """一个 JAR、ZIP 或文件夹资源来源。"""

    path: Path
    kind: str

    def entries(self) -> list[str]:
        """枚举资源名，不加载 PNG 像素。"""
        if self.path.is_dir():
            return [
                p.relative_to(self.path).as_posix() for p in self.path.rglob("*") if p.is_file()
            ]
        with ZipFile(self.path) as archive:
            return archive.namelist()

    def read(self, name: str) -> bytes:
        """读取指定资源，文件夹条目限制在资源来源目录内。"""
        if self.path.is_dir():
            target = (self.path / name).resolve()
            if not target.is_relative_to(self.path.resolve()):
                raise ValueError("资源路径超出来源目录。")
            return target.read_bytes()
        with ZipFile(self.path) as archive:
            return archive.read(name)


class InstanceResources:
    """记录资源候选和覆盖顺序；重复的模组资源不推测其加载优先级。"""

    def __init__(self, directory: str, vanilla_jar: str | None = None):
        """读取实例设置和资源目录，所有修改均由调用方在项目内保存。"""
        self.root = Path(directory).expanduser().resolve()
        self._archives = None
        self._read_lock = RLock()
        if not (self.root / "mods").is_dir() or not (self.root / "options.txt").is_file():
            raise ValueError("请选择包含 mods 和 options.txt 的 .minecraft 实例目录。")
        options = (self.root / "options.txt").read_text(encoding="utf-8")
        pack_line = next(
            (
                line.partition(":")[2]
                for line in options.splitlines()
                if line.startswith("resourcePacks:")
            ),
            "[]",
        )
        self.packs = json.loads(pack_line)
        self.sources = []
        self.providers: dict[str, list[ResourceSource]] = {}
        self.ctm_files = []
        self.errors = []
        self.vanilla = self._find_vanilla(vanilla_jar)
        if self.vanilla:
            self.sources.append(ResourceSource(self.vanilla, "vanilla"))
        mods = self.root / "mods"
        candidates = list(mods.glob("*.jar")) + list(mods.glob("*.zip"))
        candidates += list((mods / "1.7.10").glob("*.jar")) + list((mods / "1.7.10").glob("*.zip"))
        self.sources.extend(ResourceSource(path, "mod") for path in sorted(candidates))
        for name in self.packs:
            path = (self.root / "resourcepacks" / name).resolve()
            if (
                not path.is_relative_to((self.root / "resourcepacks").resolve())
                or not path.exists()
            ):
                raise ValueError(f"启用的资源包不存在或路径无效：{name}")
            self.sources.append(ResourceSource(path, "pack"))
        for source in self.sources:
            try:
                entries = source.entries()
            except (BadZipFile, OSError) as exc:
                if source.kind == "pack":
                    raise ValueError(f"无法读取启用的资源包 {source.path.name}：{exc}") from exc
                self.errors.append({"source": str(source.path), "error": str(exc)})
                continue
            rule_bytes = {}
            if source.kind == "pack" and source.path.is_file():
                with ZipFile(source.path) as archive:
                    rule_bytes = {
                        name: archive.read(name)
                        for name in entries
                        if name.endswith(".properties") and "/ctm/" in name
                    }
            for name in entries:
                if (
                    name.startswith("assets/")
                    and name.endswith((".png", ".png.mcmeta"))
                    and ("/textures/blocks/" in name or "/textures/items/" in name)
                ):
                    self.providers.setdefault(name, []).append(source)
                if source.kind == "pack" and name.endswith(".properties") and "/ctm/" in name:
                    text = (
                        rule_bytes[name] if source.path.is_file() else source.read(name)
                    ).decode("latin-1")
                    properties = {}
                    for line in text.splitlines():
                        line = line.strip()
                        if line and not line.startswith(("#", "!")) and "=" in line:
                            key, _, value = line.partition("=")
                            properties[key.strip()] = value.strip()
                    self.ctm_files.append({"pack": source.path.name, "path": name, **properties})
        signature = [
            (str(s.path), s.path.stat().st_mtime_ns, s.path.stat().st_size) for s in self.sources
        ]
        self.id = hashlib.sha256(json.dumps(signature).encode()).hexdigest()[:20]
        LOGGER.debug(
            "Scanned %s: %s sources, %s textures", self.root, len(self.sources), len(self.providers)
        )

    def _find_vanilla(self, explicit: str | None) -> Path | None:
        """定位实例内或 PrismLauncher 共享库中的 1.7.10 客户端 JAR。"""
        if explicit:
            path = Path(explicit).resolve()
            if not path.is_file():
                raise ValueError("指定的原版客户端 JAR 不存在。")
            return path
        candidates = [self.root / "versions/1.7.10/1.7.10.jar"]
        for parent in self.root.parents:
            candidates.append(
                parent / "libraries/com/mojang/minecraft/1.7.10/minecraft-1.7.10-client.jar"
            )
        return next((path for path in candidates if path.is_file()), None)

    def resolve(self, name: str) -> tuple[bytes, str]:
        """选择最后启用的覆盖包；模组之间重复且没有覆盖包时明确报告歧义。"""
        providers = self.providers.get(name, [])
        packs = [source for source in providers if source.kind == "pack"]
        if packs:
            source = packs[-1]
        elif len(providers) == 1:
            source = providers[0]
        elif not providers:
            raise ValueError(f"找不到纹理：{name}")
        else:
            raise ValueError(f"多个基础资源提供同一纹理，请使用运行时索引确认：{name}")
        if self._archives is not None and source.path.is_file():
            if source.path not in self._archives:
                self._archives[source.path] = ZipFile(source.path)
            return self._archives[source.path].read(name), str(source.path)
        return source.read(name), str(source.path)

    @contextmanager
    def reading(self):
        """批量读取期间复用 ZIP 中央目录，用完关闭，避免每张物品图都重新打开大资源包。"""
        with self._read_lock:
            if self._archives is not None:
                yield
                return
            self._archives = {}
            try:
                yield
            finally:
                for archive in self._archives.values():
                    archive.close()
                self._archives = None

    def summary(self) -> dict:
        """输出扫描统计，强调纹理清单和真实注册表各自的来源。"""
        return {
            "id": self.id,
            "directory": str(self.root),
            "vanilla_jar": str(self.vanilla) if self.vanilla else None,
            "resource_packs": self.packs,
            "sources": len(self.sources),
            "textures": sum(
                n.endswith(".png") and "/textures/blocks/" in n for n in self.providers
            ),
            "overridden_textures": sum(
                any(s.kind == "pack" for s in p) and len(p) > 1
                for n, p in self.providers.items()
                if n.endswith(".png") and "/textures/blocks/" in n
            ),
            "ambiguous_base_textures": sum(
                len(p) > 1 and not any(s.kind == "pack" for s in p)
                for n, p in self.providers.items()
                if n.endswith(".png") and "/textures/blocks/" in n
            ),
            "contextual_pack_rules": len(self.ctm_files),
            "errors": self.errors,
            "registry_available": False,
        }
