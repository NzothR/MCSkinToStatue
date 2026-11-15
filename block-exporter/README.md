# Skin Statue Index 0.1.3

用于 GTNH 2.9.0（Minecraft 1.7.10／Forge 10.13.4.1614）的客户端辅助模组。导出当前世界连接后的真实方块和物品注册表、数字 ID、Metadata／Damage 与 NBT 变体、本地化名称、六面静态图标、多层物品图标和已加载纹理，供本地工具建立调色板。

## 安装与导出

构建产物：项目根目录 `output/skinstatueindex-0.1.3.jar`，或者本目录 `build/libs/skinstatueindex-0.1.3.jar`。安装发布 JAR；`-dev.jar` 和 `-sources.jar` 用于开发。更新时替换旧版 JAR，重启客户端。现有 0.1.0／0.1.1 索引仍能导入；方块本地化名称需要 0.1.2+，物品映射需要 0.1.3 重新导出。

关闭游戏，把发布 JAR 放入客户端 `.minecraft/mods/` 后重启。无需安装到服务器。选择你真正使用的资源包，进入世界后保持客户端运行；默认等待 60 个客户端 tick 后自动开始导出。任务按客户端 tick 分段执行，单次约 6 ms 工作预算，每个状态的纹理读取不可再拆分。

聊天栏显示开始和完成信息。完成 ZIP 位于：

```text
.minecraft/skin-statue-index/block-index-yyyyMMdd-HHmmss-SSS.zip
```

把完整 ZIP 导入 Skin Statue 工具的“实例方块与调色板”面板。请保留 ZIP，它包含颜色报告未内嵌的 PNG。重复导出创建新时间戳文件。

| 命令 | 行为 |
|---|---|
| `/skinindex export` | 在世界内开始导出，不要求服务器 OP 权限 |
| `/skinindex status` | 显示已处理注册方块数和纹理数 |
| `/skinindex cancel` | 取消任务，移除该任务未完成的 `.zip.part` |

离开世界、切换维度或重载资源时取消当前任务。稳定后重新执行 `/skinindex export`。完成后切换资源包不会改变旧 ZIP，需重新导出。发生解析问题时，清单保留状态、错误类型及阶段；详细堆栈可通过调试日志查看。

## 0.1.3 物品映射

原命令和配置保持兼容。方块阶段完成后，继续读取 Item 注册表和每个注册项各创造栏的 `getSubItems`，按 Damage 与 NBT 去重；每个变体记录 `getDisplayName()`、语言键、实际物品 ID、Damage、NBT、多层图标、逐层颜色、是否 Full3D／弓、是否自定义装备渲染，以及物品方块的注册名与 Metadata。未进创造栏的注册物品保存 Damage 0 探测项，并用 `creative_confirmed=false` 标记。物品 Damage 不受方块 0～15 限制。

物品 sprite 从对应物品图集捕获；方块物品仍从方块图集捕获，缓存按图集区分同名图标。动态纹理取首帧。无法读取的变体仍保留注册身份、可获得的名字、失败状态和错误；工具不为它们伪造纹理。名称跟随导出时的客户端语言，图片包含当前加载的资源包覆盖。自定义装备渲染的图标不等于完整装备模型，工具明确以图标近似显示。

ZIP 协议仍为 schema 1，新增可选 `items` 和 `item_registry_count`，旧索引可继续导入。完整项目会保存物品 PNG 与映射，工程重开后可离线选择。导出工作仍按 tick 的约 6 ms 预算推进，每次至少处理一个状态／物品变体，单次创造栏枚举不可拆分；`/skinindex status` 同时显示方块与物品注册项进度。更新 JAR 后重启客户端，再运行 `/skinindex export`。

项目还提供 `python tools/export_item_map.py 索引.zip --output output/item-mapping.json` 提取脚本，只依赖标准库，读取实际导出的映射并保存 JSON。脚本不会启动游戏或猜测 GTNH 动态注册关系。

## 配置

首次启动创建 `config/skinstatueindex.cfg`：

- `general.exportOnFirstWorld=true`：每次客户端启动，在第一次进入世界后自动导出一次。关闭后仅使用命令导出。
- `general.debugLogging=false`：逐状态错误堆栈日志，默认关闭。即使关闭，ZIP 的 `errors` 仍保留每个失败状态的简要信息。

修改上述配置、安装或移除模组后重启游戏。模组没有 Mixin，不新增方块、物品、配方、游戏规则或网络消息，不放置方块或编辑存档数据。输出位于客户端目录；模组按客户端使用场景实现。

## 捕获范围

方块注册表在进入世界后读取，包含注册名和当前连接下的数字 ID。遍历每个方块的 0～15 Metadata，同时读取 `getSubBlocks`，通过物品 Metadata 映射标记创造栏确认的状态。探测到图标表示该调用可读取，最终可放置候选还需要通过筛选。

0.1.1 增加 `class_hierarchy` 和 `gravity_affected`：通过 `BlockFalling`／`BlockDragonEgg` 实例判断及已确认的 AmunRa 自定义重力类识别下落方块，本地调色板排除所有被标记状态。纹理描述同时记录所加载 PNG 的 `.mcmeta` 是否具有 `myctmlib.connection`，供连接纹理偏好筛选。均为协议 v1 的可选扩展字段，基础索引格式保持兼容。

0.1.2 增加状态 `display_name` 和清单 `language`：名称读取真实创造栏 ItemStack 的 `getDisplayName()`，保留当前游戏语言和变体名称；没有对应创造栏物品的探测状态不伪造名称。更换游戏语言后需重新导出索引。

每个状态记录 `getIcon(side, metadata)` 六面图标、普通立方体／不透明标志、渲染类型、TileEntity、静态染色和发光信息。通过 MCP／SRG 方法名和参数签名识别是否重写世界环境图标或染色方法。草地生物群系色、机器外观、连接环境、复杂模型等保留诊断，默认不进入静态调色板。

纹理优先读取加载后的 sprite 像素。Minecraft 会在上传静态纹理后清除 CPU 数据，因此在 OpenGL 3.0+ 下通过只读帧缓冲读取 sprite 对应的 GPU 图集区域；读取后恢复原有 read framebuffer 和 pixel-pack 状态，并移除各向异性过滤添加的边框。此路径包含启用资源包及游戏生成的纹理。低版本 OpenGL 仅可通过资源管理器恢复标准 sprite；不能解析的生成纹理明确记录为未解析。

动态纹理只留静态帧信息并标记动画。缺失图标不替换成假定的方块纹理。启用资源包的 CTM `.properties` 一并导出，Python 端排除匹配的连接纹理候选。当前没有复现 CTM 选片、多层叠加、自定义渲染、机器状态、生物群系染色、着色器或光照。服务器资源包的基础图集覆盖会被捕获，其连接规则需要额外确认。

## ZIP 协议 v1

```text
registry.json
textures/0.png
textures/1.png
...
```

`registry.json` 包含 `format=skin-statue-block-index`、`schema_version=1`、Minecraft／导出器版本、时间、资源包顺序、服务器资源包标志、CTM 规则、`blocks` 和 `errors`。

方块条目包含 `registry_name`、`numeric_id`、`class_name`、`metadata_source`、世界依赖标志和 `states`。状态包含 Metadata、创造栏确认标志、分类属性、六面 `faces`、`status` 和可选错误。面名称采用 `down/up/north/south/west/east`；每面指向 ZIP 内的 PNG，并记录原始 icon 名、像素来源、尺寸、sprite 类和动画标志。

数字 ID 属于导出时的当前注册映射。以后向其他存档导出结构时仍需核对目标存档映射，注册名称继续作为稳定标识。

## 构建与静态检查

使用指定的 Java 25 构建；源码使用 Java 8 API／字节码以兼容目标实例 Java 17～26 的运行选择。未使用系统 `JAVA_HOME`。

```powershell
# 在项目根目录运行
.\block-exporter\build.ps1

# 使用其他 Java 25 安装位置
.\block-exporter\build.ps1 -JdkPath 'D:\CustomLib\your-jdk25'
```

脚本为当前进程设置 `JAVA_HOME`，Gradle 用户缓存和临时目录均指向项目 `.cache/`，不修改系统环境变量。构建任务为 `assemble -x test`。Minecraft 的反编译／编译辅助任务也显式使用 Java 25，`--release 8` 保留旧 Forge 所需的 API 编译视图。构建不会启动游戏或自动安装模组。

Java 静态检查任务为 `spotlessCheck checkstyleMain`。Gradle 使用 GTNH 官方模板的 convention 插件；来源：[ExampleMod1.7.10](https://github.com/GTNewHorizons/ExampleMod1.7.10)、[GTNHGradle](https://github.com/GTNewHorizons/GTNHGradle)。模板的 MIT 许可见 `TEMPLATE-LICENSE`，Gradle Wrapper 的许可证见 `GRADLE-LICENSE`。游戏和 Forge 源码由构建工具下载到忽略的缓存目录，不随项目提交。
