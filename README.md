# Skin Statue · Minecraft 皮肤工作台

本地运行的 Minecraft Java 版皮肤 3D 预览工具。Python 解析皮肤，Three.js 渲染标准站姿，皮肤数据与预览资源均保留在本机。

当前实现设计文档中的皮肤导入、解析、双层显示和 PNG 导出。方块匹配、雕像体素生成和 `.schematic` 导出将在后续开发。

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

## 开发

```text
run.py                     启动入口
skin_statue/core/skin.py    UV、旧皮肤转换、图层解析、PNG 编码
skin_statue/main.py         FastAPI 解析接口和静态资源服务
skin_statue/web/            本地界面、Three.js、原创示例
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
```

按项目 skill，本轮不新增或运行自动化测试。人工验收请使用自己的不对称皮肤查看正背面、双手、双腿、头顶和脚底；分别查看基础层、透明帽子／衣服、Alex 手臂和旧版镜像，并检查导出的 PNG 和视角截图。游戏内兼容性验证留待雕像导出阶段。

## 参考与第三方资源

皮肤六面展开和旧版镜像方向参考 [skinview3d 模型源码](https://github.com/bs-community/skinview3d/blob/master/src/model.ts) 与 [skinview-utils 旧皮肤转换源码](https://github.com/bs-community/skinview-utils/blob/master/src/process.ts)，本项目在 Python 中独立解析，前端使用返回的 UV 和几何数据。

Three.js 与 OrbitControls 使用 MIT 许可证，版本与资源来源见 [第三方说明](skin_statue/web/vendor/README.md)，许可证随资源保留。内置 `demo.png` 为本项目绘制的示例。
