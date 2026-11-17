# SourceLook

SourceLook 是 DeepSeek Harness 的一个全窗口源码阅读/编辑插件。界面按 KernelSight 原版
重做：**40px 顶栏**（品牌/文件·编辑·视图/刷新索引/项目目录/路径/居中后退前进/查找/
DSH/帮助）、左侧当前文件符号窗、中间 Monaco、右侧全局符号窗（符号/文件树/文件列表）、
底部定义·代码·引用三张等宽圆角卡片、26px 状态栏。三种界面模式：

- **模式 1（P）**：只有插件窗口，SourceLook 占满整窗；顶栏右侧是固定宽度的 `DSH` 按钮
  （打开/收起模式 2）。DSH 正在工作时按钮右侧的状态圈旋转（宽度不变），
  不打开 DSH 也能看到状态。目前没有关闭插件的按钮（方案待定）。
- **模式 2（C，默认，覆盖式）**：插件保持**全宽、不重排**；DSH 作为**右侧浮动子窗口**
  从顶栏下方 **40px（与标题栏齐平）**开始，盖住插件右侧区域，底部/右侧与窗口边缘对齐；标题栏底部的 1px 线在原生按钮下方继续横贯整窗。
  子窗口 40px 标题带：最左是 DSH 自己的侧栏开关，接着 `新会话`、`应用 / 编辑` 菜单，
  最右是插件画的 **`→` 隐藏按钮**（无关闭）。点隐藏回模式 1；左缘可拖宽度。
- **模式 3（D）**：只有 DSH 窗口；右上角 `打开 SourceLook` 胶囊 → 回到模式 1。
  目前没有从插件进入模式 3 的入口（等关闭按钮方案）。

> 当前状态：**1.5.31**。在 V3（KernelSight 外壳 + DSH 子窗口联动）之上补齐了
> 整窗主题（深色/羊皮纸/薄荷/石墨全生效，暗色时 DSH 子窗口一起变暗）、字号调节、
> 整词高亮、双击浮动动作条、真正的浮动结果窗口（4 种查找范围、F4 逐条、
> 定义/调用单命中直跳）、同类型定义过滤与权威排序、`#include` 目标解析、
> `CONFIG_*` 编译开关面板、索引刷新确认与 ETA、每文件光标记忆/上次位置恢复、
> 编辑器面包屑、AI 按类提示按钮。
>
> 仍未移植：宏局部展开浮层、AI 行内编辑（view zone）、L2/L3/L4 完整面板、
> 工程切换/最近工程（Host 单根限制）。
>
> ⚠ 改完 `client.js` 后先等几秒看 DSH 的 client HMR 是否热替换；没变化或刷新网页
> 报 404 时，完全重启 DSH 桌面端。宿主会缓存插件 bundle 的 revision，手动刷新网页
> 可能请求旧 rev（“应用无法启动”）。CSS 构建时内联进 client.js，同样要重新构建。
> **1.1.78 这批改动在开发会话里没有热替换成功，必须完全重启 DSH 才能看到。**

> 开发提示：DSH 在宿主启动时缓存插件客户端 bundle 的 revision。**改完 `client.js`
> 或 `styles.css` 先等几秒看 client HMR 是否热替换；没变化或刷新网页报 404 时，
> 完全退出并重启 DSH 桌面端**再验收。当前任务已停用自动继续看门狗，也没有定时任务。

## 快速操作

| 操作 | 行为 |
|---|---|
| 顶栏 `文件/编辑/视图/帮助` | 打开、保存、查找/替换/跳转行、显隐窗格、索引、关于 |
| 左侧符号窗 | 收起、按行号/类型/名称排序、过滤、点符号跳转 + 出上下文；追加 `#ifdef/#if/#else/#endif` 伪符号行 |
| 右侧全局窗 | `符号 / 树 / 文件` 三种模式；过滤；符号按名分组；**200 行/页，滚到底自动加载**；单击预览、双击打开 |
| 顶栏 `后退` `前进` / `Alt+←` `Alt+→` | 打开历史后退/前进 |
| `Ctrl+Alt+P` / `Cmd+Option+P` | 符号搜索（Web 再加 Shift；需要索引） |`n| `Ctrl+I` | 对选中文本或光标处的词打开 AI 解释 |
| `F12` / `Ctrl+点击` | 跳定义：唯一结果直接跳，多个结果进浮动结果窗口 |
| `Shift+F12` | 查引用 → 浮动结果窗口 |
| 双击代码里的词 | 选中该词（**不跳转**），并弹出浮动动作条（查找/调用/定义/高亮/AI/复制） |
| 单击代码里的词 | 上下文三窗 + 顶栏查找框自动填入该词 |
| 顶栏 `查找` / 回车 | 浮动结果窗口；`本文件 / 本目录 / 索引 / 全文` 四种范围；单击预览、双击打开、`F4` 逐条、类型胶囊可切 调用/定义/查找 |
| `F4` / `Shift+F4` | 结果窗口逐条预览、跳到下/上一条 |
| 底部上下文窗 | 定义 / 代码 / 引用三张等宽卡片；列间拖动、高度拖动、跨重启保存；定义卡片顶部有 `查找引用` / `跳到定义` / 按符号类型的 AI 问题 |`n| `Esc` | 关闭当前打开的对话框（关于/配色/增强/文件选择/符号搜索/路径） |
| 顶栏路径 | 打开路径浮层：完整路径、复制、文件树定位、打开文件 |
| 面包屑（编辑器上方） | 点目录段切到文件树模式 |
| 顶栏 `DSH` | 打开/收起模式 2；70×30 科技蓝按钮，左侧 DSH、右侧 16px 状态圈 |
| DSH 子窗口标题带 | 最左是 DSH 侧栏开关，接着 `新会话`、`应用/编辑`，最右是 `→` 隐藏键 |
| 模式 3 的 `打开 SourceLook` 胶囊 | 回到模式 1 |
| 右键代码 | 查找、调用、我调用谁、定义、高亮、AI、**展开（代入实参）**、选中整个函数、复制（带位置）、include、进制转换 |
| `Shift+F8` / `Esc` | 整词高亮切换 / 取消 |
| `Ctrl+=` `Ctrl+-` `Ctrl+0` | 放大 / 缩小 / 重置字号（9–30，跨重启保存） |
| 视图 → 主题 | 跟随 DSH / 浅色 / 深色 / 羊皮纸 / 薄荷 / 石墨（整套界面换色） |
| 视图 → 自定义代码配色… | 按主题改注释/关键字/类型/数字/字符串/函数/宏颜色 |
| 视图 → 解析与增强… | L1–L4 状态；生成解析报告并导出；粘贴增强包 → 预演 → 应用并重建索引 |
| 状态栏 `索引 …` | 建立/重建索引；刷新前确认，构建中显示阶段/ETA/活动目录，可取消 |
| 状态栏 `高亮 …` | 点一下取消当前整词高亮 |
| `Ctrl+S` / `Ctrl+W` | 保存 / 关闭当前文件 |`n| 右键 `AI 助手` / 顶栏 AI | AI 面板：模型设置（Ollama / OpenAI 兼容）、消息记录、9 个按类按钮、提示词库、发送 / 复制 / 发送到 DSH |`n| 行尾空白处双击 | AI 行内编辑（单行）：写要求 → 回车生成 → 可编辑答案 → 插入（一次撤销、AI 底色）；空内容点外面自动收起，有内容时不会另开新框 |`n| 行尾空白处双击（行中还有内容） | 提示先回车，不会插到行中间 |

索引建立后会写入 `data/index/<sha1(root)[:16]>.crdb` 与 `.idx.json`；不会写用户工程。
索引过期（文件修改后）状态栏显示“索引过期”，点击重建。

> 快捷键说明：DSH 已把 `Ctrl+P` 绑给 Files 页面，所以符号搜索用 `Ctrl+Alt+P`
> （Web 上用 `Ctrl+Alt+Shift+P`，macOS 对应 Cmd+Option[+Shift]+P），并通过
> `ctx.shortcuts` 注册（会出现在 Settings → Shortcuts，Desktop 原生拦截也生效）。
> 大纲标题栏的搜索图标也能打开同一个搜索框。

## 目录

```
index.js                 Host 入口（ESM）：/api/sourcelook 路由、会话根目录、索引服务
host/files.mjs           工作区文件服务（树/读/写/版本/路径防逃逸）
host/static.mjs          Monaco 静态资源（按扩展名白名单）
host/fs-service.js       KernelSight 移植的索引/查询服务（CommonJS）
host/index-store.js      二进制索引（CRIX/FORMAT 2）
host/index-pool.js       worker_threads 并行解析
host/index-worker.js     单文件提取 worker
host/index-columns.js    列式 ingest
host/ts-indexer.js       tree-sitter 提取符号/引用/include
host/macro-*.js kernel-macros.js symbol-approx.js asm-extract.js compile-db.js btf-reader.js enhance.js
host/remote-fs.js        本地 only 的 remote-fs stub（SSH 不移植）
host/package.json        让 host/ 下的移植文件按 CommonJS 解析
client.js                生成的浏览器 bundle（不要手改）
src/client/00-header.js  bundle 外壳、常量
src/client/20-i18n.js    中英文文案
src/client/30-api.js     fetch/脚本加载/路径与语言工具/本地存储
src/client/40-monaco.js  Monaco 加载、主题、worker
src/client/50-shell.js   P/C/D 的窗口几何 + 侧栏/大纲尺寸
src/client/55-icons.js   内联 SVG 图标
src/client/58-menus.js   顶栏下拉菜单
src/client/59-context-menu.js 编辑器右键动作菜单
src/client/60-tree.js    懒加载文件树（右侧全局窗的“树”模式）src/client/65-quickopen.js 打开文件面板
src/client/66-symbols.js 符号 kind 徽标
src/client/67-symbol-search.js 符号搜索（Ctrl+Alt+P）
src/client/68-global.js  右侧全局窗（符号/树/文件 + 过滤）
src/client/68-outline.js 左侧当前文件符号窗（排序/过滤/路径）
src/client/69-results.js 底部定义·代码·引用三栏上下文窗
src/client/70-semantic.js 声明行语义着色
src/client/80-app.js     主组件（顶栏、标签、编辑、保存、冲突、索引、跳转、状态栏）
src/client/85-boundary.js 渲染错误边界（上报 + 关闭）
src/client/90-export.js  插槽注册
src/client/styles.css    全部样式（构建时内联）
renderer-lib/editor/     从 KernelSight 移植的 EditorAdapter / MonacoAdapter
renderer-lib/lang/       语言规则表（C/C++/Rust/Go/文本资产）
renderer-lib/package.json 让 lang/ 按 CommonJS 解析（Host 侧 require）
vendor/monaco/           Monaco 0.57 本地包（24 MB）
vendor/tree-sitter/      web-tree-sitter + C/Rust/Go wasm
scripts/build.mjs        无依赖构建脚本
scripts/smoke-host.mjs   文件服务 smoke test
scripts/smoke-index.cjs  索引/大纲/定义/引用 smoke test
data/                    运行期索引/错误日志（不要提交）
tmp/                     开发夹具与临时脚本
```

## 构建

需要 Node 22+：

```powershell
node scripts/build.mjs
node --check client.js
node scripts/smoke-host.mjs
node scripts/smoke-index.cjs
```

`client.js` 由 `src/client/*` 与 `renderer-lib/editor/*` 顺序拼接而成；CSS 在构建时转成
字符串内联。改界面只改 `src/client`，不要改 `client.js`。

`host/` 下的 KernelSight 移植文件是 CommonJS（`host/package.json`），`index.js` 与
`files.mjs`/`static.mjs` 是 ESM；`renderer-lib/lang` 也被 Host 用 `require` 加载，
所以 `renderer-lib/package.json` 标成 CommonJS。

## 安装

开发副本在 `C:\Users\luban\Documents\deepseek-harness\default-workspace\SourceLook`；
交付副本在 `D:\DeepSeekHarness\SourceLook`。安装 D 盘副本：

```text
plugin_manager install_bundle  D:\DeepSeekHarness\SourceLook
```

安装后从 Settings → Plugins 可禁用/启用。启用状态对当前 profile 的所有会话可见。

## 设计约束

- **不修改 DSH 安装目录**：只注册一个 `webServer` 路由和一个 `shell.overlay` 插槽条目。
- **文件范围**：Host 按 `session → workingDirectory` 解析根目录；所有路径做 `realpath`
  包含检查，拒绝 `..`、绝对路径和符号链接逃逸；单文件上限 4 MB；拒绝二进制。
- **写盘冲突**：`version = mtimeMs*1000:size`；保存带 `expectedVersion`，不一致返回 409，
  界面提供“重新加载/覆盖保存”。
- **索引**：移植 `fs-service + index-store/pool/worker/columns + ts-indexer`；缓存
  `data/index/<sha1(root)[:16]>.crdb`；语言表 C/C++（C++ 借 C 表）、Rust、Go，文本资产
  零符号，未知语言近似符号。**不启用** KernelSight 的“建完索引自动推导并写回
  `.kernelscope/`”流程（`autoDeriveAfterBuild` 已置空），所以索引构建不会改用户工程。
- **索引与根目录**：`fs-service` 是单项目服务；当前会话根目录变化时会重置并加载该根
  的缓存。同一时间只服务一个根（多会话交替会重建服务状态，缓存仍在磁盘）。
- **语义着色**：只给索引里 `macro / type / function` 的声明行上色；缓冲区有未保存
  修改时清空着色（索引行号对应磁盘版本，不能画到编辑后的代码上）；样式表复用一份。
- **P/C/D 的 DSH 耦合**：只读写 `#root` 的 inline `width`/`margin-left`，并在卸载时逐字恢复；
  P 模式用 CSS 隐藏 DSH 标题栏控件。DSH 升级若改这些 DOM/属性，只需改
  `src/client/50-shell.js` 与 `styles.css` 的 `data-sourcelook-mode` 段。
- **编码**：UTF-8（含 BOM）可编辑；非 UTF-8 按 GB18030 只读打开（Node 无内置编码器，
  避免保存破坏文件）。
- **语言范围**：索引只覆盖注册了 grammar 的语言；JS/TS/Java/Python 等只有 Monaco 高亮，
  没有符号索引。

## 诊断

Host 暴露一个只读诊断面（需要 `x-sourcelook: 1`）：

```
GET  /api/sourcelook/diag/state        # 请求计数、Monaco 资源命中、客户端错误
POST /api/sourcelook/diag/reset
POST /api/sourcelook/diag/client-error # 渲染错误（同时写 data/client-errors.log）
```

客户端阶段 beacon（factory/apply/mounted/monaco-*）默认关闭：把
`src/client/30-api.js` 的 `DIAG_ENABLED` 改为 `true` 后重新构建，即可在
`/diag/state` 的 `beacons` 里看到“bundle 没加载 / 组件没挂载 / Monaco 没起来”的区别。
beacon 不包含任何文件内容。`getModel` 生命周期与 `setModel(null)` 的坑见
`src/client/80-app.js` 的注释。

## 后续

- 跨文件符号大纲/工作区符号总览、引用分组、查找范围细化；
- 语义着色的作用域修正（当前只给声明行上色，且缓冲区不干净时跳过）；
- 远程项目、增强包、AI 解释（按需求后置）。

## 许可

SourceLook 的移植代码来自 KernelSight（作者：luban）。Monaco 为 MIT；tree-sitter 为 MIT。
