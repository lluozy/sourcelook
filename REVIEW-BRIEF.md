# SourceLook 插件审查与优化任务说明

## 1. 任务目标

请审查并优化 **SourceLook**：一个移植自桌面程序 **KernelSight** 的 DeepSeek Harness（DSH）全窗口源码阅读/编辑插件。

本轮重点是：

1. **正确性**：对照原版，找出功能偏差、回归风险、边界问题。
2. **性能**：大工程（Linux 内核级，约 690 万符号）、4K/高 DPI、触摸板快速滚动、面板切换。
3. **稳定性**：P/C/D 三种窗口模式切换、窗口最大化/还原、编辑器生命周期。
4. **可维护性**：当前几个超大文件需要给出拆分建议，但不要为了拆分而重写。

不要先做大重构。先读原版和插件，形成问题清单、证据和收益评估，再给分阶段修改方案。

---

## 2. 源码位置

### 2.1 插件（主要工作目录）

```
C:\Users\luban\Documents\deepseek-harness\default-workspace\SourceLook
```

关键入口：

- `index.js`：Host 入口，注册 `/api/sourcelook` 路由、项目根目录、索引服务。
- `src/client/00-header.js` ~ `90-export.js`：客户端源码，构建时按顺序拼成 `client.js`。
- `client.js`：构建产物，**不要手改**。
- `styles.css`：客户端全部样式，构建时内联进 `client.js`。
- `host/`：从原版移植的 Node/CJS 服务（索引、解析、查询、宏、BTF、增强包等）。
- `renderer-lib/`：Monaco adapter、语言规则表。
- `vendor/monaco/`、`vendor/tree-sitter/`：本地 Monaco 与 tree-sitter wasm。
- `scripts/build.mjs`：无依赖构建脚本。

当前版本：**1.5.70**。

### 2.2 原版 KernelSight（对照源码）

```
C:\Users\luban\WorkBuddy\2026-10-10-10-26-21\code-reader
```

主要文件：

- `app/src/renderer/app.js`：原版渲染主逻辑（约 11,304 行）。
- `app/src/renderer/context-analyzer.js`：点击位置分类（注释/字符串/数字/关键字/标签/符号/类型/预处理等）。
- `app/src/renderer/actions.js`：右键、浮动条、上下文窗口动作表。
- `app/src/renderer/editor/monaco-adapter.js`：Monaco 装饰、view zone、编辑器行为。
- `app/src/main/fs-service.js`：树、grep、索引构建/加载、定义/引用查询、L2/L3/L4。
- `app/src/main/ts-indexer.js`：tree-sitter 符号/引用/条件编译提取。
- `app/src/main/index-store.js`、`index-pool.js`、`index-worker.js`：二进制索引与并行解析。
- `app/src/main/main.js`、`ipc.js`、`preload.js`：Electron 窗口与 IPC。
- `app/src/renderer/style.css`：原版全部样式与主题。

### 2.3 原版功能清单（强烈建议先读）

```
C:\Users\luban\Documents\deepseek-harness\default-workspace\SourceLook\tmp\feature-inventory-original.md
```

这是一份约 1,263 行的原版功能清单，带 `file:line` 引用，按功能、触发方式、Host 数据、复杂度整理。审查时用它作为功能基准，不要只看插件 README。

### 2.4 备份与发行包

```
D:\sourcelook\
```

- `SourceLook-20261108-211250.zip`：1.5.48 源码/运行包备份。
- `SourceLook-1.5.48-release.zip`：可分发安装包。
- `SourceLook-backup-20261107-2325\`：更早完整目录备份。

这些是历史备份，不要修改；最新代码以工作区 `SourceLook` 为准。

---

## 3. 产品目标与定位

SourceLook 不是通用 IDE，而是**离线优先的 C/C++ 源码阅读器**，同时支持编辑。

核心体验：

- 打开一个项目根目录，建立符号索引。
- 左侧：当前文件符号窗（函数/宏/类型/伪预处理行）。
- 中间：Monaco 代码编辑器。
- 右侧：全局符号 / 文件树 / 文件列表。
- 底部：定义 / 代码 / 引用三张上下文卡片。
- 顶部：项目路径、前进后退、查找、DSH、帮助。
- 单击代码里的词：底部上下文窗口显示定义/代码/引用。
- 双击：浮动动作条（查找调用、定义、高亮、AI、复制等）。
- 右键：完整动作菜单。
- 支持跳定义、查引用、宏展开、条件编译、`#include` 解析、`CONFIG_*` 开关、按类型过滤、排序、主题、字号。
- AI 是可选能力，移除 AI 后仍应是一个好用的阅读器。

三种窗口模式：

- **P**：纯插件窗口，SourceLook 占满窗口。
- **C**：插件全宽，DSH 作为右侧浮动子窗口从标题栏下方开始覆盖。
- **D**：只显示 DSH，插件层隐藏但保持挂载，点击标题栏 `SourceLook` 返回上一次 P/C 布局。

模式选择持久化在 localStorage。

---

## 4. 插件架构（纲领）

### 4.1 Host 侧

- `index.js` 是 ESM，注册 webServer 路由和 `shell.overlay` 插槽。
- Host **没有 Electron**，不能调用 `dialog`、窗口控制、原生菜单。
- `host/` 下是 CommonJS；`host/package.json` 使这些文件按 CJS 解析。
- 文件访问限制在会话工作目录/项目根内，做 realpath、路径逃逸、大小、UTF-8/GB18030 处理。
- 索引缓存在 `data/index/*.crdb`，当前项目索引可达约 1.2 GB，**不要提交/打包**。
- 主要服务：文件树、读文件、保存（版本冲突 409）、grep、索引构建/加载/查询、定义、引用、宏、include、配置开关、大纲、语义信息。

### 4.2 Client 侧

- 按 `src/client/*.js` 顺序拼接到 `client.js`，形成一个模块工厂。
- `80-app.js` 是主组件和绝大多数状态/交互（约 245 KB），是当前最大维护风险。
- `styles.css` 是单一全局样式（约 170 KB），历史层叠很多，选择器覆盖关系复杂。
- `40-monaco.js`：Monaco 加载、主题、光标对比、worker。
- `50-shell.js`：P/C/D 布局、根窗口几何、DSH 标题栏联动。
- `58-menus.js` / `59-context-menu.js`：菜单和右键动作。
- `60-tree.js` / `65-quickopen.js` / `66-symbols.js` / `67-symbol-search.js`：文件树、快速打开、符号徽标、符号搜索。
- `68-outline.js` / `68-global.js`：左右符号窗，已用 `React.memo` 降低无关重渲染。
- `69-results.js`：底部上下文三卡、结果窗口、代码预览虚拟滚动。
- `70-semantic.js`：声明行语义着色。
- `85-boundary.js`：渲染错误边界。
- `90-export.js`：挂载/注册。

### 4.3 编辑器

- `renderer-lib/editor/monaco-adapter.js` 封装 Monaco。
- 主编辑器当前使用 Monaco，不是普通 textarea。
- 支持：模型复用/切换、装饰集合（语义色、函数/宏强调、临时高亮、AI 插入标记）、光标、滚动位置、右键命中、字号、主题。
- 多语言规则在 `renderer-lib/lang/`：C/C++ 为主，另含 Go/Rust/Python/JavaScript/Java 与默认规则。
- tree-sitter wasm 在 `vendor/tree-sitter/`。

---

## 5. 当前已实现能力（审查基准）

- 项目打开/切换/恢复，本地目录浏览器（插件自绘，跨平台一致）。
- 符号索引：构建、缓存、增量/过期提示、状态栏、取消/重建。
- 当前文件大纲、全局符号分页、文件树、文件列表。
- 定义/引用、跳转、历史前进后退、按类型/父级过滤。
- 上下文窗口：定义、代码、引用三卡，拖动列宽/高度，双击打开主窗口。
- 单击临时高亮全部同名（嫩绿色，最多 400 处）。
- 持久高亮（黄色）。
- 函数定义紫色加粗/阴影，函数调用加粗/轻阴影（视觉要求，**不要随意删除**）。
- 多主题：跟随 DSH/浅色/深色/羊皮纸/薄荷/石墨；自定义代码配色。
- 字号调整、保存/冲突处理、草稿、上次文件/光标/滚动恢复。
- DSH 子窗口联动：P/C/D、右侧尺寸、隐藏按钮、标题栏三组布局。
- D 模式保持插件挂载，只 CSS 隐藏，避免 Monaco 重建导致空白/掉色/丢位置。
- 光标颜色按编辑器**实际背景**测量，浅底黑、深底白（目前仍在观察偶发问题）。

---

## 6. 已知问题与风险（优先审查）

### 6.1 主代码区滚动手感

- 左侧符号窗是原生 DOM 滚动，主代码区是 Monaco 虚拟渲染，快速触摸板滑动时不如原生跟手。
- 已尝试过自定义 wheel 接管、直接 `setScrollTop`、`smoothScrolling`、灵敏度调整；**1.5.60 已全部撤回自定义接管**，当前交给 Monaco（`smoothScrolling: true`、灵敏度 2.2）。
- 不要为了“跟手”再次盲目接管滚轮，也不要删除函数阴影/颜色。若要优化，请先做可量化 A/B：
  - 记录 wheel 事件、scrollTop、rAF 帧间隔、装饰数量。
  - 区分“输入→scrollTop 慢”还是“scrollTop→重绘慢”。
- 注意：VSCode 也用 Monaco 且滚动流畅，差异可能来自逐词 inline decoration、文字阴影、超高分屏、Electron GPU，而不是 Monaco 本身。审查时请区分。

### 6.2 光标颜色偶发同色

- 历史上多次出现：主题 token 与实际编辑器背景不一致，导致光标白底白/深底黑。
- 当前方案：`applyCursorContrast()` 读取 `.monaco-editor-background` 的实际背景，写入 `--sl-cursor-color`；CSS 光标背景使用该变量。
- 需要检查：主题切换、DSH 暗色切换、窗口失焦/切回、局部重绘时是否仍会回退到旧颜色；CSS 选择器是否覆盖所有 Monaco 光标 DOM。

### 6.3 标题栏与窗口

- 最小化/最大化/关闭是 **Electron/Windows 原生按钮**，网页遮罩盖不住；弹窗遮罩固定从 48px 开始。
- 原生按钮不能替换；插件不修改 DSH 窗口实现。
- 顶栏分三组：左（品牌/菜单/刷新/项目/路径）、中（前进后退/查找）、右（DSH/帮助，紧挨原生按钮）。
- 窗口还原后曾触发窄屏媒体查询，隐藏了导航和项目按钮；已在 1.5.68+ 做 C 模式覆盖。
- 当前 48px/146px 是 Windows 假设，**跨平台时需要抽象标题栏高度和右侧保留宽度**，不要继续增加 Win32 hack。

### 6.4 维持性

- `80-app.js`、`styles.css`、`host/fs-service.js`、`host/ts-indexer.js` 都很大。
- 需要评估：拆分边界、重复 CSS 层、Hook 依赖、Monaco 生命周期、模式切换副作用。
- 不要为了“文件拆小”做大规模重写；先找高收益、低风险的切分点。

### 6.5 语言支持

- C/C++ 是主路径，语义/定义/引用必须优先保证不回归。
- Go/Rust 较完整；Python/JavaScript/Java/C++ 是后来补的通用规则，深成员/继承/闭包/`self.x` 等可能不精确。
- 非 C 的引用查询可能近似或为空，属于已知限制。

---

## 7. 审查要求

### 7.1 必须遵守

1. **不修改 DSH 安装目录/源码**。只改插件工作区。
2. **不改功能语义**，除非明确是 bug；不要为了性能删除视觉高亮、阴影、主题、交互。
3. **不替换原生窗口按钮**，不做 Win32/DWM 窗口样式修改。
4. **不手改 `client.js`**；改 `src/client/*`、`renderer-lib/*`、`host/*` 后重新构建。
5. **不提交 `data/index`、`tmp` 截图/测试产物**。
6. 不要引入重型新依赖；当前构建是无依赖 Node 脚本。

### 7.2 建议审查顺序

1. 读 `tmp/feature-inventory-original.md`，建立原版功能基准。
2. 读插件 `README.md`、`HANDOFF.md` 最近章节、`PLUGIN-RULES.md`。
3. 抽查原版与插件对应实现：ContextWindow、定义/引用、索引、Monaco 装饰、主题、菜单。
4. 用实际工程验证：打开、索引、单击、双击、右键、跳转、后退、滚动、P/C/D 切换、最大/还原、弹窗。
5. 输出问题清单，按“正确性 / 性能 / 稳定性 / 可维护性”分级，附文件:行号、复现步骤、预期/实际、建议。

### 7.3 性能审查方法

不要凭感觉改参数。至少做一类量化：

- Chrome Performance / React Profiler / 自建 `performance.now()` + rAF 采样。
- wheel 事件数、`scrollTop` 变化、长任务、帧间隔。
- 面板切换时 React render 时间、Monaco `layout()` 时间。
- 装饰数量（函数/宏/语义）与可见行 DOM 数量。
- 对照：同一文件、同一窗口尺寸、关闭某类装饰前后。

### 7.4 交付物

请给出一份审查报告，包含：

- 结论摘要（哪些是真问题，哪些是 Monaco/Electron 固有限制）。
- 分级问题清单（P0/P1/P2），每条有证据、影响、建议。
- 推荐的第一批修改（不超过 3~5 项），说明风险与验证方法。
- 不建议做的改动及原因。
- 需要用户确认的产品取舍（例如是否接受“滚动时临时降绘制”）。

---

## 8. 构建与验证

Node 22+：

```powershell
cd C:\Users\luban\Documents\deepseek-harness\default-workspace\SourceLook
node scripts/build.mjs
node --check client.js
node scripts/smoke-host.mjs
node scripts/smoke-index.cjs
```

开发辅助脚本在 `tmp/`：

- `check-render.mjs`：组件渲染冒烟。
- `bench-find.cjs`：查找性能。
- `test-daddr.cjs` / `test-net.cjs`：定义查询回归。
- `test-index-timing.cjs` 等。

不要把这些临时脚本当生产代码。

---

## 9. 安装背景

当前开发 profile 以 link 方式指向：

```
C:\Users\luban\Documents\deepseek-harness\default-workspace\SourceLook
```

通过 DSH 的本地 bundle 安装机制加载；修改 Host 代码通常需要重启 DSH，客户端改动需要刷新页面/等待 HMR。

---

## 10. 一句话总结

请把它当成一个**功能已经基本齐备、但性能和大文件维护性需要系统审查的 KernelSight 移植版**：先对照原版找真问题，再量化性能瓶颈，最后做小步、可验证、不破坏现有视觉和交互的优化。
