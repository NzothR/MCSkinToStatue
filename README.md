# Skin Statue · Minecraft 皮肤工作台

本地运行的 Minecraft Java 版皮肤 3D 预览工具。Python 解析皮肤，Three.js 渲染标准站姿，皮肤数据与预览资源均保留在本机。

当前提供皮肤解析与预览、实例资源扫描、运行时方块索引导入、逐面调色板浏览和单色匹配。辅助模组用于从 GTNH 客户端导出真实注册信息与已加载纹理。雕像体素生成、雕像 3D 预览和 `.schematic` 导出将在 GTNH 索引验收后开发。

## 启动

使用 Windows、Conda 和 Python 3.12。项目当前使用 `mc_env` 环境。

```powershell
conda activate mc_env
python -m pip install -r requirements.txt
python run.py
```

打开 [本地预览界面](http://127.0.0.1:8765)。也可以双击项目根目录的 `start.bat`，该脚本通过 Conda 使用 `mc_env`。终端按 `Ctrl+C` 停止服务。

```powershell
python run.py --port 8766
python run.py --debug
```

`--port` 修改监听端口；`--debug` 开启解析结果、UV 和服务调试日志，默认关闭。修改启动参数或 Python 代码后重启服务，修改界面文件后刷新浏览器。皮肤、模型和图层控制立即生效。

Three.js 0.170.0 和 OrbitControls 已随项目保存，运行时无需访问 CDN。浏览器需要支持 WebGL 2，建议使用开启硬件加速的 Edge 或 Chrome。当前预览不依赖 Minecraft 安装，也不需要启动游戏。

## 使用

1. 打开界面即可查看原创双层示例，也可点击或拖入自己的皮肤 PNG。
2. 标准皮肤手动选择 Steve（4 像素手臂）或 Alex（3 像素手臂），默认 Steve。
3. 左键旋转、滚轮缩放、右键平移；上方按钮切换正面、背面、左侧、右侧、顶部及初始视角。
4. 使用基础层／第二层主开关，或单独切换每个部位。空第二层显示为禁用开关，悬停可以查看有效像素与半透明像素数量。
5. 查看右下角的完整／基础／外层纹理图集，选择导出内容并点击“导出 PNG”。

“原始颜色”关闭光照对颜色的影响；“地面网格”和“自动旋转”独立开关。背景可切换深色、浅色、棋盘。左右方向以角色自身为准。

## 支持的皮肤与图层规则

| 项目 | 当前行为 |
|---|---|
| 64×64 PNG | 标准布局，独立左右四肢，支持 Steve 和 Alex |
| 64×32 PNG | 按旧版 Steve 布局读取，逐面镜像右肢生成左肢，统一为 64×64 |
| 基础层 | 头部、身体、左右手臂、左右腿共六个独立长方体，按 Java 版规则强制不透明 |
| 第二层 | 逐面保留完全透明和半透明像素，独立于基础层；头部每侧外凸 0.5，其他部位每侧外凸 0.25 个纹理单位 |
| 旧版帽子 | 旧格式上方右半区全部 Alpha ≥128 时，按旧皮肤兼容规则清除帽子背景；已有透明区域时保留帽子 |
| 模型判断 | 手动指定；PNG 尺寸无法确定标准皮肤的手臂类型；旧格式固定 Steve |
| 输入限制 | PNG，64×64 或 64×32，文件不超过 2 MB |

现代标准皮肤的不透明第二层按文件保留。基础层强制不透明只应用于当前模型实际使用的六面区域。半透明第二层使用 Alpha 混合显示。未使用的图集区域不会生成模型表面。

该工具展示现代双层皮肤布局，支持为后续面向 MC 1.7.10／GTNH 2.9.0 的雕像生成准备皮肤；原版 MC 1.7.10 的玩家皮肤本身仅使用旧布局。

## 导出

| 选项 | 内容 |
|---|---|
| 完整皮肤 | 解析后的 64×64 RGBA PNG；旧皮肤已补全，基础层已规范化 |
| 仅基础层 | 保留基础层各个面，其余位置透明的 64×64 PNG |
| 仅第二层 | 保留第二层各个面，其余位置透明的 64×64 PNG |
| 原始皮肤 | 与导入文件逐字节相同的原文件，保留原尺寸与文件元数据 |
| 当前 3D 视角 | 当前相机、光照和图层开关对应的 PNG 截图；背景透明，可关闭网格获得纯角色图 |

模型选择会影响纹理区域的解释，导出文件名包含 `steve` 或 `alex`，PNG 自身不记录模型类型。基础层和第二层分图用于图层处理；重新导入独立第二层图片时，仍会执行完整皮肤的基础层规则。

预览中的部位开关不改变皮肤 PNG 导出内容。文件通过浏览器下载，遵循浏览器配置的保存位置；上传皮肤不在服务端持久化，也不修改游戏实例或存档。

## 实例方块与调色板

在皮肤预览下方的“实例方块与调色板”面板填写 `.minecraft` 路径并点击“只读扫描实例”。扫描原版客户端 JAR、`mods/`、`mods/1.7.10/`，以及 `options.txt` 中启用的资源包；资源包列表后项优先，未启用的包不参与覆盖。支持 ZIP 资源包与文件夹资源包。

PrismLauncher 的共享 1.7.10 客户端 JAR 会自动定位；其他目录布局可展开“原版 JAR 路径”填写。资源包覆盖优先于基础资源；若多个基础资源提供同名纹理且没有明确覆盖包，会报告歧义，等待运行时索引确认。

静态起步调色板包含 52 个已知原版状态，包括羊毛、染色黏土、木板、石头和金属块等。逐面读取实际资源，不把 PNG 文件数量当作注册方块数量，也不从纹理文件名推测模组 ID。原版起步 ID 来自 1.7.10 固定映射，尚未绑定目标存档。

完整 GTNH 方块信息通过辅助模组导出后，在同一面板点击“导入游戏导出的索引 ZIP”。界面支持按注册名查询、分页查看六面纹理和代表色、查看排除原因、选择颜色和朝向匹配单个方块，以及导出调色板 JSON。调色板保存在本次服务的内存中，重启服务后重新扫描或导入原始 ZIP。

颜色统计只计算可见像素的 RGB 均值、D65 Lab、纹理方差和透明比例，完全透明像素不参与均值。匹配按指定面的 Lab 欧氏距离（CIE76）和纹理方差惩罚排序，目前用于候选查看；整雕像匹配阶段将继续处理多面一致性与色差策略。

默认静态候选需要创造栏确认 Metadata、六面纹理完整、不透明完整立方体、普通渲染、无 TileEntity、无染色／自发光／动画，并排除依赖世界的纹理或颜色，以及匹配到连接纹理规则的状态。被排除的方块仍保留在注册表中，可关闭“仅静态候选”查看原因。

Modernity 等包的 CTM 规则会保留并按 `matchBlocks`、`matchTiles`、数字 ID／Metadata 区间和纹理名筛出相关候选。连接环境、特殊渲染、多层贴图、着色器和动态机器外观需要后续专门适配；当前静态六面数据不表示这些渲染已经复现。存在服务器资源包时，运行时像素仍含其覆盖，但相关外部规则待确认，默认候选会排除。

## 获取 GTNH 运行时索引

辅助模组源码、安装和构建说明见 [block-exporter/README.md](block-exporter/README.md)。本轮构建产物位于 `output/skinstatueindex-0.1.0.jar`。

1. 关闭游戏，把 JAR 放入 GTNH 2.9.0 客户端实例的 `.minecraft/mods/`，然后重新启动游戏。
2. 选择实际使用的资源包并进入世界。默认等待 60 个客户端 tick 后自动导出一次；保持在世界中，完成后聊天栏显示完整路径。
3. 从 `.minecraft/skin-statue-index/` 取出完成的 `block-index-时间戳.zip`。未完成的 `.zip.part` 不能导入。
4. 在本地工具导入该 ZIP，并提供该文件以便继续检查 GTNH 状态和开发雕像生成。

手动命令：`/skinindex export` 开始导出，`/skinindex status` 查看进度，`/skinindex cancel` 取消。改变资源包或切换世界时取消当前任务，资源加载稳定后重新执行导出。修改资源包后需要重新导出以更新调色板。

辅助模组面向 Forge 1.7.10／GTNH 2.9.0 客户端，无 Mixin，不注册方块、物品、配方或网络协议。运行时不放置或更改世界方块。新增／移除 JAR 需要重启客户端。`config/skinstatueindex.cfg` 中 `exportOnFirstWorld` 默认开启，`debugLogging` 默认关闭，修改配置后重启游戏。每个客户端会话只自动导出一次；后续可以手动重复导出。

## 开发

```text
run.py                     启动入口
skin_statue/core/skin.py    UV、旧皮肤转换、图层解析、PNG 编码
skin_statue/core/palette.py 逐面颜色、候选筛选和单色匹配
skin_statue/resources/      实例扫描、CTM 规则、运行时注册表导入
skin_statue/main.py         FastAPI 解析接口和静态资源服务
skin_statue/web/            本地界面、Three.js、原创示例
block-exporter/             Forge 1.7.10 辅助模组
```

前后端通过 `POST /api/skin` 通信，提交 multipart 字段 `file`、`model`（`steve` / `alex`）。返回尺寸、布局类型、各部位位置和尺寸、逐面 UV、双层像素统计，以及完整／基础／外层 PNG 数据 URL。后端使用左上角原点的像素矩形；场景采用 Y 向上、+Z 正面、-X 角色右侧，底面 UV 单独反向。模型和文件处理不依赖前端。

固定 64×64 图集下解析耗时与像素数量线性相关，图像及解析存储量与像素数量线性相关。预览最多使用 12 个身体部位图层网格，无逐像素 Mesh。

安装开发检查工具并运行静态检查：

```powershell
python -m pip install -r requirements-dev.txt
python -m ruff check .
python -m ruff format --check .
python -m compileall -q run.py skin_statue
node --check skin_statue/web/app.js
node --check skin_statue/web/resources.js
```

按项目 skill，当前开发执行构建和静态检查，不运行自动化或冒烟测试。皮肤预览已由用户确认正常。本轮人工验收包括辅助模组在 GTNH 中进入世界并导出 ZIP，导入后的注册数量与排除报告，以及羊毛／石头／金属块纹理是否符合当前资源包。

资源接口：

| 接口 | 功能 |
|---|---|
| `POST /api/resources/scan` | JSON `directory`、可选 `vanilla_jar`；只读扫描并建立原版候选 |
| `POST /api/resources/index` | multipart `file`；导入辅助模组 ZIP |
| `GET /api/palettes/{id}/entries` | `search`、`eligible_only`、`offset`、`limit` 查询 |
| `GET /api/palettes/{id}/textures/{texture_id}` | 颜色计算使用的 PNG |
| `GET /api/palettes/{id}/export` | 调色板及完整问题报告 JSON |
| `POST /api/palettes/{id}/match` | JSON `rgb`、`face`、可选 `smoothness` 和 `excluded` |
| `GET /api/statue/capabilities` | 明确返回整雕像生成尚不可用，记录后续 1～6 倍、32～192 格的生成约定 |

每张不同纹理只分析一次，时间与纹理像素总量线性相关。索引状态建立与状态／表面数量线性相关；单色匹配遍历可用候选，时间 O(P)。索引 ZIP 上限 128 MB，总展开大小上限 512 MB，直接读取且不解压到游戏目录。

## 参考与第三方资源

皮肤六面展开和旧版镜像方向参考 [skinview3d 模型源码](https://github.com/bs-community/skinview3d/blob/master/src/model.ts) 与 [skinview-utils 旧皮肤转换源码](https://github.com/bs-community/skinview-utils/blob/master/src/process.ts)，本项目在 Python 中独立解析，前端使用返回的 UV 和几何数据。

Three.js 与 OrbitControls 使用 MIT 许可证，版本与资源来源见 [第三方说明](skin_statue/web/vendor/README.md)，许可证随资源保留。内置 `demo.png` 为本项目绘制的示例。
