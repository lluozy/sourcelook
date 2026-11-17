# SourceLook 交接文档（新任务从这里开始）

> 更新时间：2026-11-17 · 版本 **1.5.109** · 逐版历史见同目录 `HANDOFF.md`（每版一节，含实测数据）

---

## 0. 一句话现状

1.5.105 把 §3.6 剩下的 16 个未解析**全部收口**（`calls=802 unresolved=0 explained=6`）：
11 个 tracepoint 生成名修成真符号（宏表加规则 + `PARSER_REV` 升版 + 全量重建），
4 个"源码里确实没有定义"的改为**准确说明屏**（宏体形参 `ORDER`、`##` 片段
`__SCHED_FEAT_`、原型形参 `timeo`/`how`），标注宏实参 `lock` 直接解析到
`struct rq::lock`；另 2 个 `__func__` 仍是内建说明屏（1.5.104 已做）。

**做法要点**：四种能力**全部按"语法/宏特征"触发，不判断项目**（没有
`if (project == kernel)` 这类分支）。tracepoint 只是宏表里一条普通规则，
换项目只是不命中，引擎完全一样；规则表的 `note` 字段写清"典型场景"，
但**不参与执行**。

索引已全量重建（317s / 67,834 文件 / **6,930,621 符号** / `parserStale=false`）。
符号比 1.5.104 少 20,749（−0.3%）：旧解析器把 `TRACE_EVENT` / `DEFINE_EVENT`
当未知宏做递归展开，吐出一批 `__tracepoint_*` 之类的**假符号**；现在按规则只造
"名字参数"这一个真符号，噪声消失。11 个名字的引用全部落到
`include/trace/events/*.h` 的 `DECLARE_TRACE` / `DEFINE_EVENT` 声明上。

**1.5.108 / 1.5.109（同日，标题栏入口改成图标）**：D 模式的 SourceLook 入口从
文字按钮换成图标，28×28 方形，位置仍按 DSH 菜单右边缘 +14px 计算（比文字版省
约 60px 宽度），`title` / `aria-label` 保留"打开 SourceLook"。1.5.108 先用的是
插件品牌图标（`icon.svg`）；1.5.109 按用户要求换成**原版 KernelSight 标题栏左侧
那张 app 图标** —— 源文件 `code-reader/app/src/renderer/assets/icon.png`，
缩成 64px 存为 `vendor/kernelsight.png`（5.5KB），经已有的
`/api/sourcelook/vendor/` 静态路由发出，不额外加路由。

**1.5.107（同日，单击响应优化）**：主因是 `/references` 的**全量遍历**——
`dev` 这类名字有上万条引用，过去每条都要构造对象 + 3 次字符串表查找（实测 1778 ms）。
现在索引层支持 `accept` / `limit`：按 kind 先筛、够量即停；`symbolsWhere` 的
`parent` 改成惰性解析（只对通过筛选的少数记录查字符串表）。实测 `dev` 引用
1778→256 ms、定义 718→144 ms，`skb` 引用 256→109 ms。客户端两处预览
（结果窗 / 底部上下文窗）共用一份 in-flight，同一文件不再读两遍。
**端到端单击约 150–250 ms**（原来 host 侧就要 400–560 ms）。

**1.5.106（同日，两处修复）**：
① 「选中整个函数」的结束行改成**花括号配对**（原来是"下一个函数符号 - 1"）；
② D 模式标题栏的 SourceLook 入口原来写死 `left:136px`，而 DSH「应用 / 编辑」
菜单右边缘在 **146px** —— 按钮其实**压在菜单上 10px**；现在按菜单实际右边缘
`+14px` 定位（`--sl-pill-left`，实测 gap=14），换语言/字号也不会贴住。

---

## 1. 项目坐标

| 项 | 值 |
|---|---|
| 项目根 | `C:\Users\luban\Documents\deepseek-harness\default-workspace\SourceLook` |
| 宿主程序 | `D:\DeepSeekHarness\DeepSeek Harness.exe`（简称 DSH） |
| Node | `C:\Users\luban\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe` |
| 被索引的样例工程 | `D:\source_projects\linux-5.10.239`（内核，67,834 文件 / 6,973,622 符号） |
| 索引缓存 | `data/index/<hash>.crdb`（1.18 GB）+ `<hash>.idx.json`（14.7 MB） |
| CDP 调试脚本 | `d:\sourcelook\codebuddy\`（`bench.cjs` / `tools.cjs` / `s-*.cjs`，读 `$env:CDP_PORT`） |

### 目录结构（改代码只看这几处）

```
src/client/            客户端源码分片，由 scripts/build.mjs 拼成 client.js（**别直接改 client.js**）
  00-header.js         版本号 PLUGIN_VERSION / BUILD_TAG
  55-icons.js          图标表（case 'search' / 'back' / 'forward' / 'close' …）
  80-app.js            主组件（~5000 行：标题栏、编辑区、索引面板、查找、定义卡…）
  styles.css           样式（1.5.x 新规则多追加在文件末尾；C 模式单独一段）
host/
  fs-service.js        索引构建 / 查询 / 成员解析（findDefinition、memberFromTypeText…）
  ts-indexer.js        tree-sitter 提取（符号/引用/字段），PARSER_REV 在这里
  index-store.js       二进制索引格式（写 assembleToFile；读 openFromReader + 查询 API）
  index-pool.js / index-worker.js   并行解析（worker 池）
  local-scope*.js      局部作用域 AST（成员接收者 shape 推导）
  kernel-macros.js     ATTR 属性宏表 + 内核宏规则表
index.js              插件 HTTP 路由（/index/*、/definition…）
tmp/*.cjs             回归与探针脚本（见 §2）
```

---

## 2. 30 秒上手（构建 + 全量验证）

```powershell
cd 'C:\Users\luban\Documents\deepseek-harness\default-workspace\SourceLook'
$n='C:\Users\luban\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'

& $n scripts/build.mjs                  # 拼 client.js
& $n --check client.js                  # 语法
& $n tmp/check-render.mjs               # 渲染冒烟
& $n scripts/smoke-host.mjs             # host 文件读写
& $n scripts/smoke-index.cjs            # 建索引 / 查询 / 重载
& $n tmp/local-scope-check.cjs          # 22 项
& $n tmp/member-expr-check.cjs          # 21 项
& $n tmp/bitfield-check.cjs             # 15 项
& $n tmp/global-symbol-check.cjs        # 12 项
& $n tmp/macro-field-check.cjs          # 13 项
& $n tmp/index-bugs-check.cjs           #  7 项
& $n tmp/prefetch-check.cjs             #  4 项
& $n tmp/unresolved-fixes-check.cjs     #  7 项
& $n tmp/plugin-fixes-check.cjs         # 16 项（1.5.104 新增：属性宏参数/per-cpu/typedef/内建/汇编/拼接）
& $n tmp/explain-check.cjs             #  9 项（1.5.105 新增：tracepoint/宏参数/原型形参/标注宏）
```

无界面全量重建（`PARSER_REV` 一变就要跑；DSH 关掉再做，写盘会替换 1.18GB 文件）：
```
node tmp/rebuild-kernel-index.cjs       # 后台跑，日志 tmp/rebuild.log
```

重启 DSH 才会加载 host 改动（客户端改动也要重启：页面 reload 不会重新注入插件）：

```powershell
Get-Process | Where-Object { $_.ProcessName -like 'DeepSeek*' } | Stop-Process -Force
Start-Sleep 5; Start-Process 'D:\DeepSeekHarness\DeepSeek Harness.exe'
# 需要 CDP 时加： -ArgumentList '--remote-debugging-port=94xx'
#   **每轮换端口**，9222 残留会报 Web authentication failed
```

---

## 3. 本轮任务：未解析符号审计（已完成）

### 3.1 方法

脚本 `tmp/unresolved-audit.cjs`（可重跑：`node tmp/unresolved-audit.cjs 80`，参数 = 每文件取样数）：

1. 取 10 个代表性文件（tcp_ipv4.c / skbuff.c / tcp_output.c / tcp_timer.c / tcp_ipv6.c /
   skbuff.h / tcp.h / ip.h / sched/core.c / mm/slub.c）；
2. **先抹掉注释、字符串、预处理行**（等长空格，偏移不变），只留代码标识符；
3. 跳过 C 关键字与基本类型名，每文件最多 80 个位置 → 共 **802 次点击**；
4. 对每个位置调用与界面完全相同的 `findDefinition(word, file, {line, column})`；
5. 失败的再查 `findSymbols(name)`：索引里到底有没有定义（区分"没解析到"与"确实没有"）。

### 3.2 结果

| | 未解析 | 占比 |
|---|---|---|
| 修复前 | 32 / 802 | 4.0% |
| **修复后（索引已重建，实测）** | **19 / 802** | **2.4%** |

### 3.3 修掉的三类（代码位置）

| # | 缺口 | 修法 | 位置 |
|---|---|---|---|
| 1 | **typedef 别名成员**：`frag->bv_len`，`frag` 是 `skb_frag_t` → `struct bio_vec` | 新增 `typedefTargetOf()`（读 typedef 的 `type`，`struct bio_vec` → `bio_vec`），成员查不到时跟随一次再查；`memberFromTypeText` 允许 `typedef struct { … }` 内联正文直接扫 | `host/fs-service.js` |
| 2 | **链式成员**：`skb->dev->name` 报「sk_buff 里没有成员 name」 | ① `baseTypeOfExpr` 链式递归取成员类型时优先"能化成单个名字"的记录（匿名 union 那条 `type` 是整段内联文本，以前直接退回外层类型）；② `findDefinition` 成员分支改成 **AST shape 与文本推导两条路都试**，哪条能查到成员用哪条 | 同上 |
| 3 | **属性宏自己的 `#define`**：`__read_mostly` / `__ro_after_init` / `__acquires`… | `blankAttributes()` 为防 AST 被撕碎会把这些名字抹成空格，定义也随之消失；`extract()` 现在按**原文**补一遍 `#define <ATTR 名>` → macro 符号（ATTR 96 个名字里 59 个内核确有定义） | `host/ts-indexer.js` |

`PARSER_REV` 已升到 `2026-11-15-03`（属性宏是新增符号，必须重建）。**索引已重建完成**。

### 3.4 剩余 19 个（全部"确实没有定义"，实测明细）

| 类别 | 数量 | 例子 | 说明 |
|---|---|---|---|
| tracepoint 宏生成名 | 11 | `pelt_cfs_tp`、`sched_cpu_capacity_tp`（sched/core.c:34–44） | `DEFINE_EVENT()` / `TRACE_EVENT()` 展开出来的，源码无字面定义 |
| 编译器内建 | 2 | `__func__`（skbuff.c:116/121） | C 标准预定义标识符 |
| 宏体参数 / `##` 拼接 | 2 | `ORDER`（skbuff.h:232 宏体内）、`__SCHED_FEAT_`（core.c:57） | 宏体里的标识符不是符号 |
| 函数原型形参 / 标注宏实参 | 4 | `timeo`、`how`（tcp.h:54/312）、`lock`、`pi_lock`（core.c:182/206） | 形参的"定义"在函数体所在文件；后两个是 `__acquires(rq->lock)` 的宏实参 |

明细导出：`node tmp/dump-remaining.cjs`（读 `tmp/unresolved-audit.json`）。

---

## 3.5 本轮 1.5.104：原版 2026-11-16 那批改进移植（六项，全部落地）

做法：先把原版改动逐条对照插件**实测复现**（`tmp/probe-gaps.cjs`，改前数值见括号），
再按语言表/索引器分层实现，最后写成回归 `tmp/plugin-fixes-check.cjs`（16 项）。

| # | 缺口 | 修法 | 落点 | 实测（内核 5.10.239） |
|---|---|---|---|---|
| 1 | 属性宏只抹名字，`__printf(3, 0)` 变成没闭合的调用 → 整棵树从那行崩 | `blankAttrSpans()`：`NAME` 或 `NAME(...)` **整段**等长空格；**预处理指令行一律不抹**（抹 `#define` 的宏名等于删掉这条定义） | `host/kernel-macros.js`、`host/ts-indexer.js`（增强包那条路共用） | `include/linux/dev_printk.h` 宏 **4/39 → 39/39**，`dev_dbg`/`dev_err` 恢复定义 |
| 2 | per-cpu 宏变体缺失（只有 `DECLARE_PER_CPU`/`DEFINE_PER_CPU`/`_SECTION`） | 补 `DECLARE_PER_CPU_ALIGNED/SHARED_ALIGNED/READ_MOSTLY/SECTION/PAGE_ALIGNED`、`DEFINE_PER_CPU_*`（类型在 0、名字在 1） | `host/kernel-macros.js` | `arch/x86/include/asm/tlbflush.h:154` 的 `cpu_tlbstate` 有定义（variable/per-cpu） |
| 3 | 裸 `macro_type_specifier`（外层没有 `declaration`）无人接 | 新增 ③.5 分支：外层是 declaration/field_declaration 时不重复，否则按 `typeSpec` 兑现 | `host/ts-indexer.js`（`macroSiteOf`） | 同 #2（两种树形都覆盖） |
| 4 | `typedef u16 uint16_t;` 的声明符是 `primitive_type`，`declNameOf` 拿不到名字 | `typedefDeclaratorName()` 兜底（取最后一个类型节点，ERROR 里的裸标识符也认） | `host/ts-indexer.js`（`typeDefinition`） | `include/linux/types.h`：`uint16_t`(typedef/u16)、`uint8_t` 都有了 |
| 5 | 编译器内建被当成符号：`__func__` 记引用、点开是"未解析" | ① `syntax.refIgnore` 不产引用；② `symbols.builtinIdentifiers` 给逐个说明；③ `findDefinition` 兜底返回 `status:'builtin'`；④ 定义卡显示说明屏 | `renderer-lib/lang/c.js`、`host/fs-service.js`（`builtinNoteOf`）、`src/client/80-app.js` | `net/core/skbuff.c` 的 `__func__` 引用 **5 → 0**；查询返回 builtin 说明 |
| 6 | 内容是汇编的 `.h` 按 C 解析，吐出 `same`/`the`/`of` 这类假符号 | `lexical.asmSniff` + `asmSniffMin`：行首汇编伪指令达阈值就早退（零符号零引用） | `renderer-lib/lang/c.js`、`host/ts-indexer.js`（`extract` 开头） | `arch/m68k/fpsp040/fpsp.h` **5 符号 + 1417 引用 → 0/0**；`arch/mips/.../asmmacro.h` **69 → 0** |
| 7 | `reg##_##field` 的实参（如 `RX_PACKET_ATTRIBUTES`）被记成引用 → 零定义噪声 | `gluedMacroArgOf()`：形参在宏体里**只**以 `##x`/`x##` 出现时，不记该实参；只要还独立用过就照记（`EXPORT_SYMBOL(f)`、`container_of(p,T,m)` 不受影响） | `host/ts-indexer.js`（`refsOf`） | fixture 4 项：前后缀不记、独立形参照记、非拼接宏照记 |

`PARSER_REV` → `2026-11-16-01`（#1/#2/#3/#4 都会改变符号集合，必须全量重建）。

**重建结果（392s，67,834 文件）**：`parserStale=false`，符号 **6,973,622 → 6,951,370（−22k，−0.3%）**。
减的那部分是**旧解析器的假符号**：以前 `#define __xxx __attribute__((…))` 的宏名被抹掉，
每行都变成一个叫 `__attribute__` 的假宏；现在指令行不抹，这些记录消失（新增的
per-cpu / typedef / dev_printk 宏抵掉了一部分，所以净减不大）。

**未解析审计（同一脚本、同样 802 次点击）**：`unresolved 19 → 16`（2.4% → **2.0%**），
另有 **2 个 `__func__` 转成 builtin 说明屏**（不再算"未解析"）。剩下 16 个仍是
"源码里确实没有定义"：tracepoint 宏生成名 11、宏体参数 `ORDER`/`__SCHED_FEAT_` 2、
函数原型形参 `timeo`/`how` 2、标注宏实参 `lock`/`pi_lock` 2（后者索引里有同名成员/参数，
是**同形不同物**，属正常）。

**别踩**：`blankAttrSpans` 抹 `#` 指令行会把那条 `#define` 撕掉，进而把**下面的声明**一起
解析成宏体（fixture 里 `struct base` 曾变成 `macro struct`，成员全丢）。判据就是"匹配位置
所在行是预处理指令"。

---

## 3.6 已完成（1.5.105）：剩余 16 个未解析，逐类怎么处理的

重建后的审计（`tmp/unresolved-audit.cjs 80`）：`calls=802 unresolved=16 explained=2`，
明细 `node tmp/dump-remaining.cjs`。四类，**性质不同、修法也不同**（下表是当时的评估，
落地结果见表格之后的"实际做法"）：

| 类 | 数量 | 样例 | 代码事实 | 能不能修 | 代价 |
|---|---|---|---|---|---|
| tracepoint 生成名 | 11 | `pelt_cfs_tp` … `sched_update_nr_running_tp`（`kernel/sched/core.c:34-44`） | 这 11 个名字在源码里**只出现在** `EXPORT_TRACEPOINT_SYMBOL_GPL(name)` 的参数位；真正的对象是宏拼出来的 `__tracepoint_##name`（`tracepoint.h` 的 `__DECLARE_TRACE`）。`DEFINE_EVENT(template, name, proto, args)`（`define_trace.h:56`）→ `DEFINE_TRACE(name, …)` | **能**：给 `DEFINE_EVENT` / `DEFINE_EVENT_FN` / `TRACE_EVENT` / `DECLARE_TRACE` 加规则，参数 `name` 声明成一个符号（kind=variable，type 标 tracepoint）；`EXPORT_TRACEPOINT_SYMBOL*` 登记成引用 | 改 `host/kernel-macros.js`（宏表）+ `PARSER_REV` 升版 + **全量重建 6.5 分钟**。开工前先确认每个名字的声明点（`grep -rn "pelt_cfs_tp" kernel/sched/`，上一轮这一条 grep 被中断，**未确认**） |
| 宏体形参 / `##` 片段 | 2 | `ORDER`（`include/linux/skbuff.h:232`，是 `SKB_MAX_ORDER(X, ORDER)` 的形参）、`__SCHED_FEAT_`（`kernel/sched/core.c:57`，`#define SCHED_FEAT(name, enabled)` 里的 `##` 前缀） | 两者都在 `preproc_function_def` 体内，**本来就不是符号** | **能**（说明屏）：点击处若落在 `#define` 区域内，且词是该宏的形参或 `##` 相邻片段，返回一句"这是 X 的宏参数/拼接片段，不是符号"（对称于 1.5.104 的 `status:'builtin'`）。可选追加：解析期不把宏体内形参/`##` 片段记成引用 | 新增 `status:'macroParam'`（host + 定义卡一个分支），**不需要重建**（纯查询期）。若要做解析期抑制，才需要升 `PARSER_REV` |
| 函数原型形参 | 2 | `timeo`（`include/net/tcp.h:54` `tcp_time_wait` 原型）、`how`（`tcp.h:312` `tcp_shutdown` 原型） | 原型形参在头文件里**没有"定义"**，函数体在 .c 里；索引只给函数体里的形参建符号 | **半能**：说明屏 + **跳到函数定义**（`tcp_time_wait` 在索引里有函数定义，可给 `file:line`）。要真"解析成定义"只能把原型形参也建符号（内核量级大，未量化，暂不做） | 查询期识别"这一行是函数原型、词在其参数表内"（文本启发式：行尾 `;`、`(` 前的标识符是函数名），再查索引拿函数定义位置。中等工作量 |
| 标注宏实参 | 1 | `lock`（`kernel/sched/core.c:182` `__acquires(rq->lock)`） | 是成员表达式，owner 应是外层函数的第一个参数 `rq`（`struct rq *`）；`findDefinition` 的成员分支只处理普通表达式，不认 `__acquires(...)` 这种"宏包着的参数" | **能**（推测，未验证）：把 `__acquires/__releases/__cond_acquires…` 的参数当普通表达式交给成员推导（它们在 `kernel-macros.js` 的 ATTR 里，目前只被抹名） | 需先做一次探针确认 `rq->lock` 能解析到 `struct rq::lock`；再决定是否值得 |

**实际做法（1.5.105，全部落地，`explain-check.cjs` 9 项 + 审计 `unresolved=0`）**：

| 类 | 落点 | 做法 |
|---|---|---|
| tracepoint ×11 | `host/kernel-macros.js` | `DECLARE_TRACE`/`DEFINE_TRACE`/`TRACE_EVENT*` 参数 0、`DEFINE_EVENT*` 参数 1 → 声明为 `variable`/`struct tracepoint`；`EXPORT_TRACEPOINT_SYMBOL*` → `ref`。**规则带 `note`，不判断项目** |
| 宏体形参 / `##` ×2 | `host/fs-service.js` `macroParamNoteOf()` | 向上定位 `#define` 块（认 `\` 续行）→ 词在形参表或紧邻 `##` → `status:'macroParam'` + 一句话 |
| 原型形参 ×2 | `host/fs-service.js` `protoParamAt()` | 文件作用域 + 单行 + 行尾 `;` + 取最内层 `(` 前的函数名 → `status:'protoParam'`，并查索引给 `items`（跳函数定义） |
| 标注宏实参 ×1 | `host/fs-service.js` `signatureBodyEnd()` | 成员类型推不出、且点击行在"函数签名延续区"（到 `{` 之间无 `;`）→ 把作用域基准推到函数体末尾重试。**纯结构判定，不认 `__acquires` 名字** |

UI：`src/client/80-app.js` 增加 `macroParam` / `protoParam` 两个 `status` 分支
（说明屏 + 可跳转项），不再落到「未解析」。

**未做（评估过、有意不做）**：原型形参**不建符号**（内核量级大，收益低）；
宏体内形参/`##` 片段的**引用抑制**也没做（要升 `PARSER_REV`，噪声不大）。

### 踩到的坑（1.5.105）

- 审计脚本原来只把 `status === 'builtin'` 当"已解释"，`macroParam`/`protoParam`
  仍被算成 unresolved —— 口径要一起改，否则"修了但数字不动"。
- 新写的探针脚本如果全通过就走到结尾：`fs-service` 会留下 worker / 定时器，
  **event loop 不空 → node 不退出**（看起来像卡死）。回归脚本末尾要**无条件** `process.exit()`。
- 宏表注释里别写 `*.h` 这种带 `*/` 的字面量，会提前结束块注释。

---

## 4. 下一步（按优先级任选）

1. ~~UI 措辞~~ ✅ 1.5.105 完成：`macroParam`（宏参数）、`protoParam`（原型形参）两个
   `status` 分支已在 `src/client/80-app.js`，tracepoint 有真符号、不再是"未解析"。
2. **扩大审计样本**（还没做）：改 `tmp/unresolved-audit.cjs` 的 `FILES` 或每文件取样数，
   覆盖 `drivers/`、`fs/`，确认没有新类别。审计口径已改成 `explained`
   （`builtin` / `macroParam` / `protoParam` 都不算 unresolved）。
3. ~~tracepoint 支持~~ ✅ 1.5.105 完成（`host/kernel-macros.js` 的 tracepoint 规则块）。
4. 遗留功能问题见 §7。

---

## 5. 硬规则 / 坑（踩过的，别再踩）

1. **不要加任何"临时画面/占位"**（用户两次否决：正文预览、假加载）。编辑区只在**模型真的设上**后才亮
   （`editorVisible` 只在 model effect 里置真）；加载页撤页条件 = `ready && editorVisible` + 150ms 稳定期。
2. `client.js` 是 `scripts/build.mjs` 的产物，**改源码分片**再 build；直接改 `client.js` 会被覆盖。
3. **vendor 补丁**：`vendor/monaco/vs/editor/editor.main.js` 被裁过（砍掉 1.35MB 语言服务），
   vendor 重新生成后**必须重打**，否则启动慢 1.7s。
4. **这份裁剪过的 Monaco 里 `editor.deltaDecorations()` 是空壳**：装饰进了 model 但 DOM 不渲染。
   一律用 `editor.createDecorationsCollection()`；清空用 `collection.clear()`（`set([])` 有时不回收）。
5. **标题栏三段式**：`.sl-top-center` 绝对居中（前进/后退中心线 = 窗口中心，查找框挂它右侧、不参与居中）；
   右留白统一 `--sl-win-controls: 150px`；**不要**再用 `@media` 隐藏 `.project` / `.sl-top-path`。
6. **索引永远全量重建**（用户明确要求，不做增量）。`PARSER_REV` 一改必须重建；`buildIndex()` 无增量参数
   （历史 `prevByRel` 从未生效，1.5.93 已删）。
7. **`mtimeMs` 必须写对**：索引里存的是它，漏了会让 `changedSince` 把 6.8 万文件全判成"变过"
   （永久"索引过期"）。`tmp/prefetch-check.cjs` 守着这条 + "两次重建逐字节一致"。
8. 查询回退分支**不能**写 `idx.symbols.filter(...)`：磁盘索引不带 `symbols`（用 `(idx.symbols || [])`）。
9. Windows 上 `rename` 覆盖仍被打开的文件会 EBUSY/EPERM：保存索引前必须 `closeAuxiliary()`
   （**不要**改成"推迟关闭"，试过，写入阶段直接失败）；查询端 EBADF 由 `index-store` 的
   "读失败就重开"兜底。
10. 调试：**每轮换 CDP 端口**；页面 reload 不会重新注入插件 → 客户端改动用整进程重启验证。

---

## 6. 代码地图（按任务找落点）

| 我要改… | 去哪 |
|---|---|
| 定义/成员解析 | `host/fs-service.js`：`findDefinition` 成员分支（`if (recv !== '')`）、`baseTypeOfExpr`、`typedefTargetOf`、`memberFromTypeText`、`findMemberInTypeBody` |
| 索引提取（符号/字段/宏） | `host/ts-indexer.js`：`fieldDeclaration` 分支、`looseFieldIdentifiers`、`recoverFieldFromText`、`macroSiteOf`、`extract()` 末尾的属性宏 pass |
| 属性宏抹除（`__printf(3,0)`） | `host/kernel-macros.js`：`blankAttrSpans` / `ATTR` / `ATTR_RE`；`host/ts-indexer.js`：`blankAttributes`（增强包合并正则那条路） |
| 编译器内建 / 标准库说明 | `renderer-lib/lang/c.js`：`symbols.builtinIdentifiers`、`syntax.refIgnore`；`host/fs-service.js`：`builtinNoteOf`；`src/client/80-app.js`：`status === 'builtin'` |
| 汇编内容的 `.h` | `renderer-lib/lang/c.js`：`lexical.asmSniff`/`asmSniffMin`；`host/ts-indexer.js`：`extract()` 开头早退 |
| 索引二进制格式 | `host/index-store.js`：`assembleToFile`（写）、`openFromReader`（读 + 段越界校验）、`symbolsPage` |
| 建索引流程/进度 | `host/fs-service.js`：`buildIndexNow` / `buildIndex` / `reportScan|reportMacros|reportParsed|reportWriting` / `saveIndex` / `loadIndexFromDisk` / `changedSince` / `prefetchLocal` |
| 并行解析 | `host/index-pool.js`（worker 数按**物理核** `ceil(cpus/2)`，`CR_INDEX_WORKERS` 可覆盖）|
| HTTP 路由 | `index.js`（`/index/status`、`/index/build`、`/definition`…）|
| 界面 | `src/client/80-app.js` + `styles.css`（新规则追加末尾；C 模式段单独一块）|

### 索引数据结构要点

- `.crdb` 头部 64 字节：magic / format / builtAt / 五个段（strtab、strIdx、files、sym、ref）的 off+len。
- 符号记录定长；字符串表按字典序重排、记录按名字 id 排序 → 查询是二分查找。
- 侧车 `.idx.json`：`root / fileCount / symbolCount / engine / builtAt / parserRev / files[{rel,path,size,mtime}] / issues / …`
- 成员符号：`kind='member'`，`parent` = 所属 struct/union 名，`type` = 声明类型文本。

### 性能现状（内核全量重建 ≈ 5–6 分钟）

| 阶段 | 耗时 | 备注 |
|---|---|---|
| 扫描目录 | 几秒 | 本地串行 readdir（刻意保持 fileId 顺序稳定）|
| 宏表预扫描 | 10–20s | 有自己的进度阶段 `macros` |
| 解析 | **≈5 分钟**（5.2ms/文件，6 个 worker） | 固有成本；`ceil(cpus/2)` 留出核给界面 |
| 写 1.2GB 索引 | 30–60s | 流式写 |
| `loadIndexFromDisk` | **0.78s** | 6.7 万次 stat 已改 64 并发 |

---

## 7. 遗留问题（不在本轮范围）

1. ~~**右键「选中整个函数」只选中签名 1 行**~~ ✅ **1.5.106 已修**（两个原因叠加）：
   - **真凶**：`adapter.revealLine()` 内部会 `editor.setPosition({line})`，把刚设好的
     选区冲成单行 —— 边界其实一直算对了。已把调用顺序改成「先 revealLine、后 setSelection」。
   - 顺带把结束行从"符号表里下一个函数 - 1"换成**花括号配对**（跳过字符串/行注释/块注释），
     不再依赖索引里相邻符号的行号是否连续。
   实测（CDP 真实点击菜单项）：`skb_queue_tail` 选中 **3225–3232**；算法另测
   `skb_queue_head` 3204→3211、`skb_unlink` 3245→3252 全对。
2. ~~**C 模式布局**~~ **不是缺陷，是刻意设计**（用户 2026-11-17 明确）：C 模式下
   DSH 面板盖住右侧约 200px 编辑区 + 右符号窗，就是这么设计的 —— **不要去"修"**。
3. **DSH 的 `:has()` 规则**导致 Files 页填充模式有副作用（插件已在运行期改写选择器绕过，建议上报 DSH 根治）。
4. 文件标签栏：用户明确不修。

---

## 8. 本轮改动清单（便于回滚/对照）

| 文件 | 改了什么 |
|---|---|
| `host/fs-service.js` | 新增 `typedefTargetOf()`；成员分支改为多 owner 候选（AST + 文本）逐个试；`memberFromTypeText` 支持内联 typedef |
| `host/ts-indexer.js` | `extract()` 末尾补属性宏 `#define` 符号；`PARSER_REV` → `2026-11-15-03` |
| `tmp/unresolved-audit.cjs` | 新增：未解析审计（802 次点击）|
| `tmp/unresolved-cases.cjs` | 新增：逐案核对（bv_len / name / ORDER / __func__…）|
| `tmp/unresolved-fixes-check.cjs` | 新增：7 项回归（内核 + 自造工程）|
| `tmp/dump-remaining.cjs` | 新增：导出剩余未解析明细 |
| `HANDOFF.md` | 追加 `1.5.103` 一节 |
| `package.json` / `src/client/00-header.js` | 版本 → 1.5.103 |

### 1.5.104 改动清单

| 文件 | 改了什么 |
|---|---|
| `host/kernel-macros.js` | 新增 `blankAttrSpans()`（属性连参数抹、预处理指令行跳过、等长空格），`blankAttributes()` 改走它；导出 `blankAttrSpans`/`ATTR_RE`；补 9 个 per-cpu 宏变体 |
| `host/ts-indexer.js` | 增强包路径共用 `blankAttrSpans`；`LEX`（词法块）随 `useTable` 切换；`extract()` 开头汇编 `.h` 早退；`macroSiteOf` 新增裸 `macro_type_specifier` 分支；`typedefDeclaratorName()` 兜底；`gluedMacroArgOf()` 抑制 `##` 前缀引用；`PARSER_REV` → `2026-11-16-01` |
| `host/fs-service.js` | 新增 `builtinNoteOf()`；`findDefinition` 尽头返回 `status:'builtin'` |
| `renderer-lib/lang/c.js` | `lexical.asmSniff`/`asmSniffMin`、`notes.kinds.builtin`、`symbols.builtinIdentifiers`（10 个）、`syntax.refIgnore`（10 个） |
| `src/client/80-app.js` | 定义卡新增 `status === 'builtin'` 分支（一句说明，不做符号查找） |
| `tmp/plugin-fixes-check.cjs` | 新增：16 项回归（内核真文件 + fixture + 查询侧） |
| `tmp/probe-gaps.cjs` | 新增：六项缺口的"改前/改后"实测探针 |
| `tmp/rebuild-kernel-index.cjs` | 新增：无界面全量重建（后台跑，日志 `tmp/rebuild.log`） |
| `package.json` / `src/client/00-header.js` | 版本 → 1.5.104 |

### 1.5.105 改动清单

| 文件 | 改了什么 |
|---|---|
| `host/kernel-macros.js` | 新增 tracepoint 规则块：`DECLARE_TRACE`/`DEFINE_TRACE`/`TRACE_EVENT*`（参数 0）与 `DEFINE_EVENT*`（参数 1）→ `struct tracepoint` 变量；`EXPORT_TRACEPOINT_SYMBOL*` → 引用。规则带 `note`，不判断项目 |
| `host/ts-indexer.js` | `PARSER_REV` → `2026-11-17-01`（新增 tracepoint 符号，必须重建） |
| `host/fs-service.js` | 新增 `macroDefineBlockAt` / `macroParamNoteOf` / `atFileScope` / `protoParamAt` / `signatureBodyEnd` / `tableFor`；`findDefinition` 在索引回退之后给 `status:'macroParam'` / `'protoParam'`（后者带 `items` 可跳函数定义）；成员分支解析失败时用 `signatureBodyEnd` 放宽作用域重试（标注宏实参） |
| `src/client/80-app.js` | 定义卡新增 `macroParam` / `protoParam` 两个 `status` 分支 |
| `tmp/explain-check.cjs` | 新增：9 项回归（tracepoint 3 + 宏参数 2 + 原型形参 3 + 标注宏 1） |
| `tmp/unresolved-audit.cjs` | 口径改为 `explained`（`builtin`/`macroParam`/`protoParam` 都不算 unresolved） |
| `package.json` / `src/client/00-header.js` | 版本 → 1.5.105（`BUILD_TAG` → `2026-11-17-a1`） |

### 1.5.106 改动清单

| 文件 | 改了什么 |
|---|---|
| `src/client/80-app.js` | ① `selectFunction()` 的结束行改为**花括号配对**（跳过字符串/行注释/块注释），不再用"符号表里下一个函数 - 1"；② 把 `revealLine` 调到 `setSelection` **之前** —— `revealLine` 内部 `setPosition` 会清掉选区，这是"只选中 1 行"的真凶 |
| `src/client/50-shell.js` | `syncDshMenu()` 的 D 模式分支：按 `[data-windows-menu]` 的实际右边缘写 `--sl-pill-left`（+14px），值未变时不重复写 |
| `src/client/styles.css` | `.sl-pill` 的 `left: 136px` → `left: var(--sl-pill-left, 144px)` |
| `tmp/alg-check.cjs` | 新增：括号配对在 `skbuff.c` 三个函数上的验证（3225→3232 / 3204→3211 / 3245→3252） |
| `package.json` / `src/client/00-header.js` | 版本 → 1.5.106（`BUILD_TAG` → `2026-11-17-a2`） |

### 1.5.107 改动清单（单击响应）

| 文件 | 改了什么 |
|---|---|
| `host/index-store.js` | `symbolsWhere()` 的 `parent` 改惰性 getter（accept 通过才查字符串表）；`references()` 新增可选 `accept({kind,fileId})` / `limit` / `onStop`，过滤在**构造对象之前**、够量即停 |
| `host/fs-service.js` | `findReferences()` 把 kind/fileOnly 过滤下沉成 `accept`，非成员/非 fileOnly 时给 `limit*4` 上限；因早停而截断时 `truncated=true` |
| `src/client/80-app.js` | 新增 `previewPendingRef`：`previewResult` 与 `loadResultPreview` 共用同一份"正在读"，同一文件不再并发读两遍 |
| `tmp/perf-ctx.cjs` / `perf-ctx2.cjs` | 新增：单击链路 host 侧耗时探针（改前/改后对照） |
| `package.json` / `src/client/00-header.js` | 版本 → 1.5.107（`BUILD_TAG` → `2026-11-17-a3`） |

### 1.5.108 改动清单（标题栏入口）

| 文件 | 改了什么 |
|---|---|
| `src/client/55-icons.js` | 新增 `case 'sourcelook'`：内联 `icon.svg` 的品牌图形（蓝底 + 白色 `< >` + 绿色镜头），颜色写死不随主题变 |
| `src/client/80-app.js` | D 模式 pill 的文本换成 `h(Icon, { name: 'sourcelook', size: 20 })`，补 `aria-label` |
| `src/client/styles.css` | `.sl-pill` 从文字按钮（`padding: 0 10px`）改成 28×28 方形、内容居中 |
| `package.json` / `src/client/00-header.js` | 版本 → 1.5.108（`BUILD_TAG` → `2026-11-17-a4`） |

### 1.5.109 改动清单（换成原版 app 图标）

| 文件 | 改了什么 |
|---|---|
| `vendor/kernelsight.png` | 新增：原版 `code-reader/app/src/renderer/assets/icon.png` 的 64px 缩放版（5.5KB） |
| `src/client/80-app.js` | D 模式 pill 内容改成 `<img class="sl-pill-icon" src="${API}/vendor/kernelsight.png">` |
| `src/client/55-icons.js` | 删掉 1.5.108 临时加的 `case 'sourcelook'`（不再用内联 SVG） |
| `src/client/styles.css` | 新增 `.sl-pill-icon`（20×20、圆角 4px、`pointer-events: none`） |
| `package.json` / `src/client/00-header.js` | 版本 → 1.5.109（`BUILD_TAG` → `2026-11-17-a5`） |

---

## 9. 新会话开场提示（直接粘贴）

```text
阅读 C:\Users\luban\Documents\deepseek-harness\default-workspace\SourceLook\HANDOFF-NEXT.md，
继续 SourceLook 1.5.105 之后的工作。

- 现状：1.5.105 已完成（PARSER_REV=2026-11-17-01），索引已全量重建
  （67,834 文件 / 6,930,621 符号，parserStale=false），未解析审计 `unresolved=0 explained=6`。
- 已完成：11 个 tracepoint 生成名修成真符号；宏体形参/`##` 片段与函数原型形参改为说明屏；
  标注宏实参 `lock` 能解析到 `struct rq::lock`。四种能力全部按"语法/宏特征"触发，不判断项目。
- 待办：§4 只剩「扩大审计样本」（drivers/fs）与 §7 四个遗留功能问题。
- 规则不变：索引永远全量重建、不做增量；改完跑 `node tmp/explain-check.cjs`、
  `node tmp/plugin-fixes-check.cjs` 与既有回归；host 改动要重启 DSH 才生效。
```
