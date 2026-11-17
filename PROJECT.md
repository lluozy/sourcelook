# SourceLook 项目总览

> 最后更新：2026-11-17 · 版本 **1.5.113** · 许可证 Apache-2.0
>
> 这份文档是「接手新任务」的入口：项目是什么、现在能做什么、代码在哪、怎么改、有哪些坑。
> 逐版历史见 `docs/dev/HANDOFF-NEXT.md`；更早的原始交接见 `docs/dev/HANDOFF.md`（部分描述已过时）。

---

## 1. 这是什么

**SourceLook** 是运行在 **DeepSeek Harness（DSH）** 里的全窗口源码阅读器，面向 **Linux 内核和大型 C 工程**。

它自己建二进制符号索引（不依赖 ctags/clangd/LSP），点一下就跳定义、看引用、查调用链；
**看不懂的代码，直接让旁边的 DSH 讲给你听** —— 这是它和普通阅读器最大的区别。

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/lluozy/sourcelook |
| 当前版本 | 1.5.113（`PARSER_REV = 2026-11-17-02`） |
| 索引规模（本机内核） | 67,834 文件 / **6,929,491 符号** |
| 本地目录 | `D:\dsh-sourcelook` |
| 安装包 | Release 附件 `SourceLook-1.5.113.zip`（6.8 MB，解压即用） |

## 2. 三种界面模式

| 模式 | 样子 | 切换 |
|---|---|---|
| **P**（overlay） | 只有插件，占满整窗 | 顶栏 `DSH` 按钮 |
| **C**（dock，默认） | 插件全宽 + DSH 浮在右侧 | 顶栏 `DSH` 按钮 |
| **D**（dsh-only） | 只有 DSH，左上角留插件图标 | `Ctrl+Alt+S`；或 `文件 → 关闭 SourceLook` |

## 3. 能力清单（已实现）

**导航**
- `F12` / `Ctrl+点击` 跳定义（多结果进结果窗）
- 单击任意词 → 底部三栏：**定义 / 代码 / 引用**
- `Shift+F12` 查引用（按 kind 过滤）
- 右键：我调用谁 / 谁调用我 / 选中整个函数（花括号配对）/ **展开宏**
- `Ctrl+Alt+P` 符号搜索；`Ctrl+F` / `Ctrl+Shift+F` 查找
- 后退/前进、结果窗逐条（`F4`）、字号调整

**看得懂 C**
- 宏生成的名字：`DEFINE_PER_CPU` / `DECLARE_TRACE` / `DEFINE_EVENT` / `LIST_HEAD`
- typedef 别名成员、链式成员（`skb->dev->name`）、位域、匿名 union、`__attribute__((...))`
- 说不清的给**准确说明**而不是「未解析」：宏体形参（`ORDER`）、`##` 片段、原型形参（`timeo`）、
  编译器内建（`__func__`）、标注宏实参（`__acquires(rq->lock)` 的 `lock`）
- 多行宏体里的块注释不再打断解析（1.5.110 修复）

**和 DSH 协同**
- 选中代码 `Ctrl+I` / 右键 → 问题发到右侧 DSH 面板
- 定义卡上有按类型的提问按钮（这个函数做什么 / 参数含义 / 风险点 / 这个宏展开成什么）

**性能**
- 多线程并行建索引，大型工程几分钟；打开工程秒级加载
- 单击即时响应（引用查询在索引层按 kind/file 过滤并早停）

## 4. 架构

```
DSH 宿主
 ├─ index.js            ← host 入口：注册 /api/sourcelook 路由 + 全窗口插槽
 │   ├─ host/fs-service.js   查询服务（findDefinition / findReferences / outline / expandMacro …）
 │   ├─ host/ts-indexer.js   tree-sitter 解析 → 符号 + 引用（表驱动）
 │   ├─ host/index-store.js  二进制索引读写（.crdb，按名字排序 + 二分）
 │   ├─ host/index-pool.js   worker_threads 并行建索引
 │   └─ host/enhance.js      L4 增强包（宏规则配置、报告、体检）
 └─ client.js           ← 构建产物：src/client/*.js + renderer-lib/editor/* + CSS
     ├─ 55-icons / 58-menus / 59-context-menu
     ├─ 60-tree / 65-quickopen / 66-symbols / 67-symbol-search
     ├─ 68-outline / 68-global / 69-results
     └─ 80-app.js           主组件（单文件 277 KB，改它要小心）
```

**语言层**：`renderer-lib/lang/*.js` 是数据表（词法 / 符号识别 / 使用位置 / 读者语义），
`registry.js` 负责文件→语言。**核心代码不允许出现具体语言字面量**（有扫描测试守）。

## 5. 代码地图

| 文件 | 职责 |
|---|---|
| `index.js` | host 入口、HTTP 路由、静态资源、AI 桥 |
| `host/fs-service.js` (182 KB) | 所有查询逻辑（定义/引用/大纲/成员推导/宏展开/增强包） |
| `host/ts-indexer.js` (118 KB) | C/C++ 及表驱动语言的符号提取 |
| `host/index-store.js` (69 KB) | 索引格式与查询（`symbolsWhere` / `references` / `poolMask`） |
| `host/kernel-macros.js` (18 KB) | 内核宏知识表（属性宏、per-cpu、tracepoint…） |
| `host/macro-expand.js` | 有限递归宏展开（找名字，不是展示） |
| `host/local-scope.js` / `local-scope-worker.js` | 局部作用域 AST 缓存 |
| `host/symbol-approx.js` | 未知语言的近似符号 |
| `renderer-lib/lang/*.js` | 语言规则表（c / cpp / rust / go / java / javascript / python / text-assets） |
| `src/client/80-app.js` | 界面主组件（状态机、三栏、菜单、快捷键） |
| `src/client/69-results.js` | 结果窗渲染 |
| `scripts/build.mjs` | 拼 `client.js`（改界面只改 `src/client/`，不改产物） |

## 6. 开发流程

```powershell
cd D:\dsh-sourcelook
node scripts/build.mjs          # 改 src/client 后必跑
node --check client.js
node tmp/check-render.mjs       # 渲染冒烟
node scripts/smoke-host.mjs     # 文件服务
node scripts/smoke-index.cjs    # 索引/大纲/定义/引用
# 改完必须重启 DSH（宿主缓存 bundle revision）
```

**回归脚本**（`tmp/*.cjs`，按改动挑）：
`explain-check`（四类说明 + tracepoint）、`plugin-fixes-check`（20 项宏/属性/内建）、
`member-expr-check`（21 项）、`global-symbol-check`、`bitfield-check`、`macro-field-check`、
`index-bugs-check`、`unresolved-fixes-check`、`prefetch-check`、`alg-check`（选函数边界）、
`unresolved-audit`（未解析普查）、`perf-ctx2`（单击耗时）。

## 7. 索引

- 格式 `.crdb`：文件记录 32 B、符号记录 40 B、引用记录，字符串表 + 分块；
  按名字 id 排序，`rangeOf()` 二分。
- `PARSER_REV` 一变，旧索引立刻 `parserStale=true`，**必须全量重建**。
- **永远不做增量索引**（明确的硬规则）。重建脚本：`tmp/rebuild-kernel-index.cjs`（后台跑，日志 `tmp/rebuild*.log`）。
- 重建前必须关 DSH（1.2 GB 文件被占用）。
- 缓存目录：`<插件目录>/data/index`，文件名 = `sha1(被索引源码根)`。

## 8. 语言支持

| 语言 | 状态 |
|---|---|
| C / C++ | 完整（专用规则 + 宏知识表） |
| Rust / Go | 完整（表驱动） |
| Java / JavaScript / Python | 可用（表已启用；Java 字段会重复记 member/variable） |
| TypeScript | **走近似符号**（TS grammar 的节点形状未适配，宁可不标也不标错） |
| 其它（Makefile/Kconfig/JSON…） | 文本资产：可浏览可搜索，零符号 |

## 9. 已知限制

- 一次服务一个工程根；换工程要重选目录（索引按工程缓存）。
- 语义着色只标声明行；缓冲区有未保存修改时清空（避免错位）。
- 原型形参不建符号（只给说明 + 跳转）。
- 宏体形参 / `##` 片段的引用没有全量抑制（只压了前缀那种）。
- `80-app.js` 是一个 277 KB 的单文件，改动要按函数定位、不要整体重排。
- Kconfig 符号不解析（`CONFIG_*` 查不到定义属预期）。

## 10. 建议的下一步

**功能**
1. 引用分组的更细粒度（按文件 / 按类型折叠）
2. TypeScript 规则表适配（`export_statement` / `required_parameter` / `type_identifier`）
3. 原型形参建符号（让"查原型形参的引用"可用）

**工程**
4. 更多语言（C# / Kotlin / Swift 视需求）
5. `80-app.js` 拆分（当前单文件过大，风险高）

## 11. 环境与路径

| 项 | 路径 |
|---|---|
| 插件源码 | `D:\dsh-sourcelook` |
| DSH 程序 | `D:\DeepSeekHarness\DeepSeek Harness.exe` |
| 插件挂载点 | `.dsh\profiles\desktop\node_modules\@local\sourcelook`（junction → D 盘） |
| 被索引的内核 | `D:\source_projects\linux-5.10.239` |
| Node | `C:\Users\luban\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe` |
| CDP 调试 | 启动加 `--remote-debugging-port=94xx`；探针脚本在 `d:\sourcelook\codebuddy` |

## 12. 硬规则

1. **不自动发版**：只做 `commit` + `push`；**不打 tag、不建 release**，除非明确要求。
   CI（`.github/workflows/release.yml`）已改成仅手动触发。
2. **不做增量索引**：格式一变就整体重建。
3. **核心零语言字面量**：语言相关的词、扩展名、节点名都在 `lang/*.js`，核心只查表。
4. **宁可没有，不要错**：解析不确定时给说明或走近似符号，不产假符号。
5. `client.js` 是构建产物，永远改 `src/client/`。
6. 改完 JS 先 `node --check`；改界面后重启 DSH。

## 13. 目录约定

```
根目录（正式内容，全部入库）
  index.js  client.js  icon.svg  cordis.patch.yml  package.json
  README.md  README.en.md  PROJECT.md  LICENSE  NOTICE
  src/  host/  renderer-lib/  vendor/  locale/     源码与资源
  scripts/                                         构建与冒烟
  test/fixture/                                    测试夹具（CI 依赖，必须入库）
  docs/screenshots/                                README 截图
  docs/dev/                                        历史决策与交接（HANDOFF*.md / *PLAN.md / PLUGIN-RULES.md）

工作区（本地，不入库）
  tmp/      临时脚本、日志、一次性探针  ← 所有临时物都放这里
  data/     索引缓存（约 1.2 GB）
  dist/     打包产物
  tools/    本机工作流脚本（三个 .cmd，CodeBuddy 用）
```

**规则**：新产生的临时文件一律进 `tmp/`；根目录不再落 `.md` / `.cjs` / `.log` / `.png`。
`tmp/`、`data/`、`dist/`、`tools/` 都已写进 `.gitignore`，`git status` 应永远干净。
