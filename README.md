# Skin Statue · Minecraft 皮肤工作台

本地运行的 Minecraft Java 版皮肤 3D 预览工具。Python 解析皮肤，Three.js 渲染标准站姿，皮肤数据与预览资源均保留在本机。

当前提供皮肤解析、实例资源扫描、运行时方块索引导入、逐面调色板、可调尺寸的方块雕像生成、双模式 3D 预览和 `.schematic` 结构导出。辅助模组从 GTNH 客户端导出真实注册信息与已加载纹理。

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
python run.py --index block-index-20261115-173345-890.zip
```

`--port` 修改监听端口；`--debug` 开启解析结果、UV、生成统计和服务调试日志，默认关闭；`--index` 在启动时载入指定运行时索引，界面自动使用唯一预载的调色板。修改启动参数或 Python 代码后重启服务，修改界面文件后刷新浏览器。皮肤预览中的模型和图层控制立即生效；修改雕像生成参数后点击重新生成。

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

用户放在项目根目录的 `block-index-*.zip` 可直接从面板点击“读取项目索引”，无需再次选择上传文件；这些索引通过 `.gitignore` 排除。运行时方块数字 ID 按索引原值保留，支持 GTNH 扩展 ID，不再施加原版 4095 上限。Metadata 仍使用索引协议 v1 的 0～15 范围。没有修改辅助模组协议，无需重新导出已有 ZIP。

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

## 生成与查看雕像

先导入皮肤，读取项目中的 GTNH 索引或载入其他调色板，再使用左侧“生成方块雕像”面板。点击生成后自动切换“方块雕像”；上方按钮可以随时切回“原始皮肤”对照，原有旋转、缩放、平移和固定视角继续可用。

| 选项 | 行为与默认值 |
|---|---|
| 主体高度 | 1～6 整数倍，32／64／96／128／160／192 格，默认 96；不含第二层外凸量 |
| 颜色细节 | 逐像素、2×2 或 4×4 像素平均，默认逐像素；平均会简化皮肤颜色图案，几何格数继续由高度决定 |
| 内部结构 | 默认空心，可选实心 |
| 壳厚 | 空心主体保留 1～4 格外壳，默认 1；对主体并集做六邻域腐蚀 |
| 外层偏移 | 第二层表面相对各部位主体外凸 1～3 格，默认 1 |
| Alpha 阈值 | 外层像素 Alpha 达到阈值才生成实体，范围 1～255，默认 128 |
| 匹配策略 | 颜色优先、平衡、平滑优先，改变纹理起伏惩罚，默认平衡 |
| 部位与图层 | 按现有六个部位的基础／第二层开关生成；只关闭主体也能单独生成外层 |
| 方块禁用 | 调色板卡片中取消“允许用于雕像”，下一次生成会排除该状态 |

生成期间浏览器仍可操作。参数、皮肤、模型、图层或调色板变化后保留上次结果，界面提示重新生成。生成失败时保留上次可查看的雕像。

主体使用整数长方体并集；第二层逐面离散投影，透明区域留空，主体占据的位置不被外层覆盖。相邻外层在整数网格发生碰撞时按头部、身体、右臂、左臂、右腿、左腿的固定顺序保留先生成部位。壳厚和外层偏移均以实际方块为单位。

表面匹配同时比较同一个体素所有外露方向的纹理色，按唯一颜色／可见面组合复用结果。外层内侧或边缘没有直接 UV 样本时，使用该体素已投影表面的平均目标色。未暴露的实心内部与空心内壁使用表面最常见材料填充。材料报告包括全部实际非空气方块，平均色差为表面体素的可见面平均 CIE76，最大色差为所有匹配可见面的最大 CIE76。

预览从实际匹配后的方块数组提取可见面，剔除相邻不透明体素内面，再贪心合并同方向同纹理矩形。前端使用纹理图集与单个网格批处理，合并后的矩形仍每格重复方块纹理。图集中的每张预览纹理最高使用 64×64 像素，纹理较多时降低采样尺寸以保持图集不超过 4096；原始索引纹理不被修改。“方块代表色”可查看纯色效果，“原始颜色”可关闭预览方向明暗。

不同高度以相同屏幕玩家比例显示，实际尺寸、体素数、第二层方块数、材料数量和色差显示在“雕像材料与匹配统计”中；雕像模式地面网格间距对应一格。现有 PNG 功能继续用于皮肤和视角截图。

## 导出结构并在游戏中查看

生成后，左侧“导出雕像结构”提供 `.schematic` 和“结构与材料对照包 ZIP”。导出严格使用当前已生成预览的体素快照，保留所有内外方块、空气和 Metadata，不重新选择材料。调整参数后可以导出上次已生成结果，也可以重新生成后再导出新结果。

| 导出模式 | 编码与适用范围 |
|---|---|
| GTNH WorldEdit · 扩展 ID（默认） | `Blocks` 低 8 位、`AddBlocks` 中间 4 位、`AddBlocks2` 高 4 位，支持 0～65535；针对实例中的 `worldedit-v0.0.10` 读取器核对 |
| 传统 MCEdit / WorldEdit | `Blocks` 与 `AddBlocks`，支持 0～4095；当前雕像使用超限 ID 时明确拒绝导出，不截断或替换方块 |
| GTNH Schematica · SchematicPlus | `Blocks` 低 8 位与每格一个字节的 `AddBlocks`；实例中的 `Schematica-1.12.6-GTNH` 需开启 `useSchematicplusFormat=true`；按该读取器有符号 Short 映射行为限定 ID≤32767 |

三种模式均是 GZip 压缩的 NBT Alpha Schematic，扩展名为 `.schematic`。GTNH WorldEdit 与 SchematicPlus 的高位编码不同，按目标加载器选择模式。现代 Sponge `.schem` 不用于本项目的 MC 1.7.10 客户端。

文件同时包含 `BlockMapping` 和 `SchematicaMapping` 注册名映射，供支持它们的读取器转换目标环境的数字 ID。生成报告保留来源索引和资源包顺序。模型仅使用静态完整方块候选，`Entities` 和 `TileEntities` 均为空。

每次导出都将 NBT 实际读回，比较尺寸、数组长度、全部 ID／Metadata、注册名映射和粘贴偏移。数组采用 `index = x + (y * Length + z) * Width`，每层 X 最快、其次 Z、最后 Y。校验失败时不返回文件。这里是导出功能自身的数据校验，游戏加载效果由用户验收。

### I 点与粘贴方位

从正面看，I 是整个雕像实际包围盒的右下角方块坐标。顶面为 ABCD，正面为 CDGI，背面为 ABEF，八点对应如下：

```text
       B--------A
      /|       /|
     C--------D |
     | F------|-E
     |/       |/
     G--------I  ← 玩家粘贴参考点
```

坐标约定为 +X 东、+Y 上、+Z 南。导出的正面固定朝南（+Z），I 位于包围盒东南侧底部。局部尺寸 `(W,H,L)` 下，I 为 `(W-1,0,L-1)`，WorldEdit 偏移写为 `(1-W,0,1-L)`；`WEOriginX/Y/Z` 均为 0。使用普通粘贴时，玩家所在方块坐标就是 I，结构从此向西、向北、向上展开，底部与玩家脚部同一层。面朝西北可从 I 看向雕像正面。

WorldEdit 的普通 `//paste` 不随玩家视线自动旋转，预览相机也不会改变导出朝向。界面的“I 点与包围盒”仅辅助显示，不会添加到结构中。Schematica GUI 使用自身定位方式，不应用 WorldEdit 的 I 点粘贴偏移。

把默认模式下载的文件放入 WorldEdit 的结构目录。已核对当前实例配置，实际位置为 `.minecraft/config/worldedit/schematics/`；多人游戏则使用服务器的对应目录。以 `statue.schematic` 为例，站在预定 I 点执行：

```text
//schem load mcedit statue
//paste -a
```

直接下载的文件名会包含生成快照短 ID 与模式名，加载时使用实际文件名；ZIP 内固定为 `statue.schematic`。`//paste -a` 只放非空气块，适合先观察生成的雕像；需要按完整包围盒替换空气时使用 `//paste`，空心内部和透明外层留下的空气也会参与粘贴。

### 对照包与快照

ZIP 包含 `statue.schematic`、`report.json`、`materials.csv`、`skin-normalized.png` 和使用说明。报告包含源皮肤文件名／哈希、模型、参数、资源包、材料注册名、数字 ID、Metadata、数量、六面图标名、代表颜色及纹理像素来源。颜色与预览有差异时，可据此在游戏中核对具体方块。

服务内存保留最近四次完整生成快照，重启后清空。当前页面使用的快照过期时，下载会提示重新生成，不会静默生成另一个结果。导出文件由浏览器下载，不自动写入游戏实例、服务器或存档。更新 Python 代码或依赖后重启本地服务；界面刷新后重新生成一次，即可使用带导出数据的快照。

## 开发

```text
run.py                     启动入口
skin_statue/core/skin.py    UV、旧皮肤转换、图层解析、PNG 编码
skin_statue/core/palette.py 逐面颜色、候选筛选和单色匹配
skin_statue/core/statue.py  整数体素、多面匹配、空心处理、贪心网格和图集
skin_statue/core/schematic.py Alpha Schematic、扩展 ID、I 点偏移、读回校验和诊断 ZIP
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
node --check skin_statue/web/statue.js
```

按项目 skill，当前开发执行构建和静态检查，不运行自动化或冒烟测试。皮肤双层预览、辅助模组导出和雕像预览已由用户实际使用。当前人工验收请在 GTNH 中加载默认扩展格式，站在预定 I 点粘贴，对照正背面、左右肢体、头顶脚底、空心与第二层，并核对报告中的高 ID 材料是否是游戏中实际放置的方块。

资源接口：

| 接口 | 功能 |
|---|---|
| `POST /api/resources/scan` | JSON `directory`、可选 `vanilla_jar`；只读扫描并建立原版候选 |
| `POST /api/resources/index` | multipart `file`；导入辅助模组 ZIP |
| `GET /api/palettes/{id}/entries` | `search`、`eligible_only`、`offset`、`limit` 查询 |
| `GET /api/palettes/{id}/textures/{texture_id}` | 颜色计算使用的 PNG |
| `GET /api/palettes/{id}/export` | 调色板及完整问题报告 JSON |
| `POST /api/palettes/{id}/match` | JSON `rgb`、`face`、可选 `smoothness` 和 `excluded` |
| `GET /api/resources/local` | 列出项目根目录内的索引 ZIP |
| `POST /api/resources/local/{filename}` | 直接载入项目索引 |
| `GET /api/resources/loaded` | 返回当前已载入调色板的概要 |
| `POST /api/statue/generate` | multipart `file`、`model`、JSON 字符串 `options`；返回图集、材料统计及批处理网格 |
| `GET /api/statue/{id}/export` | `profile=worldedit_gtnh/mcedit/schematica_gtnh`，`bundle=true` 时返回结构及诊断 ZIP |
| `GET /api/statue/capabilities` | 返回生成、预览、导出模式及支持的高度 |

每张不同纹理只分析一次，时间与纹理像素总量线性相关。索引状态建立与状态／表面数量线性相关；单色匹配遍历可用候选，时间 O(P)。索引 ZIP 上限 128 MB，总展开大小上限 512 MB，直接读取且不解压到游戏目录。

雕像体素与目标色缓冲区空间 O(V)；唯一颜色／可见面组合数为 U、可用候选数为 P 时，匹配计算 O(U×P)。隐藏面剔除和空心腐蚀线性遍历体素，网格合并按二维切片连续矩形处理。返回网格以 little-endian Int32 的 Base64 表示，每条记录为 `[x,y,z,face,width,height,tile]`；面顺序为 east／west／up／down／south／north。

导出在同一份裁剪后的状态数组上进行，序列化和读回校验时间与体素数线性相关，额外空间 O(V)。完整体素快照仅保留在服务端，浏览器通过 `statue_id` 下载对应结果。

## 参考与第三方资源

皮肤六面展开和旧版镜像方向参考 [skinview3d 模型源码](https://github.com/bs-community/skinview3d/blob/master/src/model.ts) 与 [skinview-utils 旧皮肤转换源码](https://github.com/bs-community/skinview-utils/blob/master/src/process.ts)，本项目在 Python 中独立解析，前端使用返回的 UV 和几何数据。

Three.js 与 OrbitControls 使用 MIT 许可证，版本与资源来源见 [第三方说明](skin_statue/web/vendor/README.md)，许可证随资源保留。内置 `demo.png` 为本项目绘制的示例。

结构编码依据 [GTNH WorldEdit SchematicWriter](https://github.com/GTNewHorizons/worldedit-gtnh/blob/master/src/main/java/com/sk89q/worldedit/extent/clipboard/io/SchematicWriter.java)、[SchematicReader](https://github.com/GTNewHorizons/worldedit-gtnh/blob/master/src/main/java/com/sk89q/worldedit/extent/clipboard/io/SchematicReader.java) 与 [GTNH Schematica SchematicAlpha](https://github.com/GTNewHorizons/Schematica/blob/master/src/main/java/com/github/lunatrius/schematica/world/schematic/SchematicAlpha.java)，并只读检查了用户实例已安装 JAR 的对应读取器。NBT 由 nbtlib 编码和读回。
