# SourceLook 交接说明

更新时间：2026-11-16  
当前版本：**1.5.104**  
唯一源码/安装路径：`C:\Users\luban\Documents\deepseek-harness\default-workspace\SourceLook`

> 旧 `D:\DeepSeekHarness\SourceLook` 已不存在。DSH profile 通过 link 指向本目录；
> 旧 D 盘路径的快捷方式、脚本、数据都不能再用。

---

## 0. 当前状态

- DSH 桌面端正在运行，插件已安装并在 `desktop` profile 中启用。
- 索引：**6,951,370 符号 / 67,834 文件**（1.5.104 解析器全量重建，`parserStale=false`）。
- 没有定时任务/自动继续看门狗；`89-probe.js` 默认关闭（`localStorage['sourcelook.probe']='1'` 才发诊断数据）。
- 当前截图的界面：模式 2（插件 + DSH 覆盖式子窗口），DSH 子窗口在 y=40。
- 1.1.78 已在开发会话里通过 client HMR 生效并截图验证：深色整窗 + DSH 一起变暗、
  浅色回退、结果窗口布局都正常。HMR 有时会连续几次不触发，仍以“完全重启 DSH”
  作为兜底。验收截图 `tmp/final-1178.png`（深色，DSH 同步变暗）。

### 改完 client.js 的生效方式

DSH 在宿主启动时缓存插件客户端 bundle 的 revision；改完 `client.js` 后：
1. 先等 3~5 秒，本次实测 client HMR 多数会热替换；
2. 没变化时**完全退出并重启 DSH 桌面端**；
3. 手动刷新网页可能请求旧 rev 并 404（“应用无法启动”），不要只刷新。

`styles.css` 构建时内联进 `client.js`，同样要重新构建。
自检脚本（node 22+）：
```
node scripts/build.mjs
node --check client.js
node tmp/simulate.mjs      # 工厂能否加载
node tmp/check-render.mjs  # 真正跑一遍组件体，抓 TDZ/顺序错误
```

---

## 0.5 1.1.78 新增（本轮）

### 1.5.104 原版 2026-11-16 那批改进移植（六项）

原版 app（`code-reader`）当天改的内核宏/汇编/内建处理，逐条搬到插件（详细表格见
`HANDOFF-NEXT.md` §3.5）：

1. **属性宏连参数抹除**：`blankAttrSpans()` 把 `__printf(3, 0)` / `__aligned(8)` 整段
   换成等长空格（以前只抹名字 → `static inline (3, 0)` 不是 C，整棵树从那行崩）。
   `include/linux/dev_printk.h` 的宏 **4/39 → 39/39**，`dev_dbg`/`dev_err`/`dev_warn`
   恢复定义。**预处理指令行一律不抹**（抹 `#define` 的宏名等于删掉这条定义，
   反过来会把下面的声明一起解析成宏体）。
2. **per-cpu 宏变体**：补 `DECLARE_PER_CPU_ALIGNED/SHARED_ALIGNED/READ_MOSTLY/
   SECTION/PAGE_ALIGNED`、`DEFINE_PER_CPU_*`；`arch/x86/include/asm/tlbflush.h:154`
   的 `cpu_tlbstate` 终于有定义。
3. **裸 `macro_type_specifier`**：外层没有 `declaration` 时也按 `typeSpec` 兑现
   （`macroSiteOf` 新增 ③.5 分支）。
4. **typedef 到 `primitive_type`**：`typedef u16 uint16_t;` 的声明符是 primitive_type，
   `declNameOf` 拿不到名字 → `typedefDeclaratorName()` 兜底，`uint16_t`/`uint8_t`/
   `ssize_t` 一类定宽整型恢复定义。
5. **编译器内建不当符号**：`syntax.refIgnore` 不产引用（`__func__` 全树数万处）、
   `symbols.builtinIdentifiers` 给逐个说明、`findDefinition` 尽头返回
   `status:'builtin'`，定义卡显示说明屏而不是"外部符号 / 未解析"。
6. **汇编内容的 `.h` 早退**：`lexical.asmSniff`（行首汇编伪指令）+ `asmSniffMin`=3；
   `arch/m68k/fpsp040/fpsp.h`（5 符号 + 1417 垃圾引用）与
   `arch/mips/include/asm/asmmacro.h`（69 个假符号）现在都是 0/0。
7. **`##` 拼接参数不记前缀引用**：`gluedMacroArgOf()` —— 形参在宏体里只以 `##x`/`x##`
   出现时不记该实参；只要还独立用过就照记（`EXPORT_SYMBOL(f)` 不受影响）。

`PARSER_REV` → `2026-11-16-01`（符号集合变了，必须全量重建；已用
`tmp/rebuild-kernel-index.cjs` 重建）。回归：新增 `tmp/plugin-fixes-check.cjs`（16 项），
既有 10 套全绿。

### 1.5.103 未解析审计后的三修（typedef 别名 / 链式成员 / 属性宏 #define）
审计方法：从 10 个内核文件抓 802 个"代码里的标识符"（注释/字符串/预处理行先抹掉），
逐个 `findDefinition`，失败的再查"这个名字索引里到底有没有定义"。
**802 → 32 未解析（4%）**，按类别修掉三类真缺口：

1. **typedef 别名**（`bv_len` ×4）：`frag->bv_len` 的 `frag` 是 `skb_frag_t`，
   成员挂在 `struct bio_vec` 下。新增 `typedefTargetOf()`（读 typedef 的 `type`，
   `struct bio_vec` → `bio_vec`），成员查不到时跟随一次再查 + 再走文本兜底；
   `memberFromTypeText` 也放宽：`typedef struct { … }` 这种内联正文允许直接扫。
2. **链式成员**（`skb->dev->name`）：两处修。
   - `baseTypeOfExpr` 在链式递归里取成员类型时，优先挑"类型能被化成单个名字"的那条
     记录 —— 匿名 union 里的 `dev` 那条 `type` 是一整段内联 union 文本，以前直接
     放弃并退回外层类型（于是 `name` 去 `sk_buff` 里找，报"没有成员"）。
   - `findDefinition` 的成员分支改成**两条推导路都试**：AST shape（数组/调用/cast 最准）
     与文本推导（沿 `->` 走得深）都算出 owner，哪个能查到成员用哪个。
3. **属性宏自己的 `#define`**（`__read_mostly` / `__ro_after_init` / `__acquires`）：
   `blankAttributes()` 为了不让 AST 被撕碎，会在解析前把这些名字抹成空格，
   于是它们自己的定义也一起没了。`extract()` 现在按**原文**补一遍
   `#define <ATTR 名>` → macro 符号（ATTR 96 个名字里 59 个内核确实有定义）。

`PARSER_REV` → `2026-11-15-03`（属性宏是新增符号，必须重建才进索引）。

**效果（同一份审计脚本）**：未解析 **32 → 27**（`bv_len` ×4 + `name` 已修，无需重建）；
重建后属性宏 8 条也会消失 → **预计 19**。剩下的全是"源码里确实没有定义"：
tracepoint 宏生成名 11、`__func__` 2、宏体参数/记号拼接 2（`ORDER`、`__SCHED_FEAT_`）、
函数原型形参 2（`timeo`、`how`）。

回归 `tmp/unresolved-fixes-check.cjs` **7 项全过**（内核 typedef/链式/单级不回退 +
自造工程属性宏/typedef 成员/两级链式/内联 typedef）；其余 8 套全绿
（smoke-host、smoke-index、local-scope 22、member-expr 21、bitfield 15、global-symbol 12、
macro-field 13、index-bugs 7、prefetch 4）。

### 1.5.102 本地预读（主进程异步读，随批送进 worker）
worker 里原来是同步 `readFile`（一批 48 个文件串行阻塞），读盘和解析没法重叠。
新增 `prefetchLocal()`：主进程异步 IO、32 并发把整批文本读进来，随批发给 worker
（worker 早就支持 `f.text`/`f.size`/`f.mtimeMs`，那条路原本只给远程 SFTP 用）。
**建索引和宏表预扫两条路都接上了。**

实测（400 个内核头文件，同样 6 个 worker）：914ms → **789ms**。

两个不变量必须守住，已写成回归 `tmp/prefetch-check.cjs`（4 项全过）：
- **同一棵树连建两次，索引内容逐字节一致**（只排除头部时间戳）→ 说明预读没有改变
  fileId 顺序 / 符号顺序；
- **建完立刻 `loadIndexFromDisk()`，`stale === false`、`changedFiles === 0`**
  → 说明 `mtimeMs` 没丢（漏了它，changedSince 会把 6.8 万文件全判成"变过"）。

用户决定：**不做增量重建，每次全量**。所以剩余的固有成本（解析 1.3GB 源码 ≈ 5–6 分钟）
就保持现状，只把可避免的等待（串行 stat、看不见的宏预扫、worker 抢核、同步读盘）修掉。

### 1.5.101 刷新索引的流程体检（3 处修复 + 实测数据）
用户反馈"点刷新索引还是有点慢"。先量，再改。

**实测（6 核 12 线程，内核 67,834 文件）**
| 阶段 | 现状 |
|---|---|
| 扫描目录（`buildTree`，本地串行 readdir） | 几秒 |
| **宏表预扫描**（`scanMacroTable`，把 6.8 万文件再读一遍收集 `#define`） | 10–20s，**以前界面上停在这一段显示 "解析符号 0/67834"** |
| 解析（worker 池） | 5.2ms/文件 × 6.8 万 ≈ **5–6 分钟**（大头） |
| 写 1.2GB 索引 | 30–60s |
| `loadIndexFromDisk`（打开项目/建完后） | **1.87s → 0.78s**（修复后） |

**修的三处**
1. **`changedSince` 6.7 万次 `stat` 串行 await** → 64 并发（结果按文件序回收，`changed` 顺序不变）。
   `loadIndexFromDisk` 实测 1871ms → **782ms**，打开项目、重建完成都受益。
2. **宏表预扫描没有独立阶段**：新增 `reportMacros(done,total)` + `phase: 'macros'`，
   客户端面板/状态栏显示「预扫描宏定义 12,000/67,834」和进度条 —— 不再是"卡在 0%"。
3. **worker 数 = 逻辑核−1（12 线程 → 11 个）**：解析是纯 CPU，超线程无收益，
   多出来的 worker 只会和 DSH 主进程/渲染进程抢核（构建期间界面发卡）。
   改成**按物理核**（`ceil(cpus/2)`，本机 6 个）。实测 2000 文件：11 worker 10.4s、
   6 worker 11.6s（+11%），但空出 6 个线程给界面。仍可用 `CR_INDEX_WORKERS` 覆盖。

**没有改的（需要用户拍板）**：解析本身是固有成本。真正的提速只能靠**增量重建**
（只重解析 mtime/size 变了的文件；`buildIndex` 目前是全量，`prevByRel` 参数曾被传但从未使用，
1.5.93 已删）。解析器升级（`PARSER_REV` 变化）时仍然必须全量。

### 1.5.100 C 模式下路径被挤成 `n… › i… › t…`
**原因**：1.5.96 给 `.sl-crumbbar` 加过
`padding-right: calc(var(--sl-visible-w) - var(--sl-dsh-left) + 8px)`。这两个变量是**窗口级**的
（1279 − 848 = 431），但这一行并不是从窗口左边缘开始，而是从符号窗右边（345px）开始 ——
等于多扣了 345px：602px 的行只剩 153px 内容区，查找条自己就占 263px，路径被压成 **0 宽**，
crumbs 每个只剩 10px，显示成 `n… › i… › t…`。

**修法**：删掉那条整行 padding，改成只限制路径本身：
`html[data-sourcelook-mode="C"] .sl-layer .sl-crumb-path { flex: 0 1 auto; max-width: 200px; }`
—— 路径不会伸到 DSH 面板下面，超长时正常省略。

实测（1279px，C 模式，DSH 面板从 848 起）：查找条 355–618、路径 624–753
（`net › ipv4 › tcp_ipv4.c` 完整可读）；P 模式不变（路径 624–939）。

### 1.5.99 路径回到"紧跟查找框"；左侧符号窗滚动修复
1. 面包屑行：路径改回 `justify-content: flex-start` —— 紧贴查找框右侧（实测 find 右缘 618、
   路径首字符 624，间距 6px）。1.5.98 的"贴行右边缘"只保留在 HANDOFF 里做记录。
2. **左侧符号窗滚不动**：
   - 实测列表本身是可滚的（`client 495 / scroll 2964`，`scrollTop` 0→1858，行也正常重绘），
     问题出在两点：**滚动条只有 5px（overlay 条）几乎点不中**；指针压在头部/按钮/外沿时
     滚轮事件不落在列表上。
   - 修法一（CSS）：`.sl-sym-list` / `.sl-glb-body` / `.sl-rw-list` / `.sl-results-preview`
     统一 10px 可见滚动条（thumb 语义色 + hover 加深），并加 `overscroll-behavior: contain`
     防止滚动链到页面。实测滚动条宽度 5 → **10**。
   - 修法二（JS，`68-outline.js`）：给 `.sl-sym-pane` 挂 `wheel`（passive），**指针不在列表内时**
     手动把 `deltaY` 转发给 `.sl-sym-list`；列表内不拦，保持原生滚动。
     实测：指针压在头部滚轮 3 次 → 列表 0 → 450；再在列表上滚 3 次 → 900。

### 1.5.98 路径改为靠右
`.sl-crumb-path` 加 `justify-content: flex-end`：当前文件路径贴着行的右边缘（查找条在左）。
路径太长时溢出从**左边**裁掉，留下的正好是文件名那一段。实测 P 模式路径 1049–1178
（行右缘 1186 − 8px padding），C 模式仍被 `padding-right` 让位、不会被 DSH 面板压住。

### 1.5.97 本文件查找：顺序调整 + 去掉大小写/全词
按用户要求：
- **查找条放左、当前文件路径放右**（`.sl-crumbbar` 里 `.sl-filefind` 在前、`.sl-crumb-path` 在后，
  路径 `flex: 1 1 auto; min-width: 0`）。实测 P 模式：查找条 355–639、路径 645–939（紧接其后）。
- **删掉 `Aa`（区分大小写）和 `全词` 两个开关**，固定 `findMatches(query, false, false, false, null, …)`
  —— 不区分大小写、不做全词匹配。`fileFindCase` / `fileFindWord` 状态与相关 CSS 一并移除。
- `Ctrl+F` 预填**也会当场算一次**（原来只 setState，计数/高亮会停在上一轮查询上，要等下一次输入）。
- C 模式仍只保留 `padding-right` 让位；查找条本身在左侧，天然不会被 DSH 面板压住
  （实测 C 模式 355–639，DSH 从 848 起）。

### 1.5.96 本文件查找（面包屑行右侧）
需求：主编辑区要能"查找当前文件内容"。方案 A（用户拍板）：放在**当前文件路径那一行的右端**，
不占顶栏中缝（那里是全局索引搜索，且 C 模式下会被 DSH 面板压住）。

- 路径行 `.sl-crumbbar` 高度 22 → 30，左侧新增 `.sl-crumb-path`（可省略），右侧
  `.sl-filefind` 胶囊：`🔍 | 输入框 | 1/329 | ↑ ↓ | Aa | 全词 | ✕`。
- 搜的是**当前缓冲区**（含未保存修改），`model.findMatches(query, false, isRegex=false,
  matchCase, wordSeparators, false, 2000)`；大小写/全词两个开关；上限 2000 个高亮。
- 交互：`Ctrl+F` / 点放大镜 → 聚焦并预填"选区或光标下的词"（全选便于覆盖）；**输入即在 onChange 里
  同步计算并跳第一个匹配**（不走 setTimeout —— 窗口被遮挡时定时器会被节流到 1s+，打字会"不跟手"）；
  `Enter` 下一个、`Shift+Enter` 上一个（到头循环）；`Esc` 清空高亮、查询一并清掉并回编辑器；
  缓冲区编辑（含撤销）后 160ms 重算重绘，**不动光标**。
- 菜单「编辑」：`查找（本文件）` = Ctrl+F（抢掉原 Monaco 浮窗绑定，那个浮窗在 C 模式被 DSH 盖住）；
  `查找（全项目）` = Ctrl+Shift+F（左栏符号/索引搜索）。
- C 模式：`padding-right` 让位 `--visible-w - --dsh-left`，并把计数/开关收成精简版
  （只留输入 + 前后 + 关闭），避免被 DSH 面板压住。

**踩到的坑（重要，写进 HANDOFF）**：这份裁剪过的 monaco 里
`editor.deltaDecorations()` 是**空壳** —— 装饰进了 model（`getAllDecorations()` 数得到）却
**永远不渲染**（DOM 里一个 span 都没有，`className`/`inlineClassName`/`beforeContentClassName`
全试过）。改用 `editor.createDecorationsCollection([...])` 正常；且 `set([])` 有时不回收旧装饰，
清空要用 `collection.clear()`。以后凡是要加装饰，一律用集合 API。

实测（1279px，P 模式）：输入 `tcp_v4` → 250ms 内 `1/102`，首个匹配 86:25，可见区高亮 3 段；
`Enter` → `2/102`、`Shift+Enter` → `1/102`；`Esc` → 查询清空、高亮 0；`Ctrl+F` 预填
`tcp_v4_connect`；C 模式查找条 361–527（DSH 从 848 起，完全可见）。

### 1.5.95 全局符号可见性统一（GLOBAL-SYMBOL-VISIBILITY-PLAN.md 落地）
`case TCP_TW_SYN:` 点出来"没有"：索引里明明有 `enum_member @ include/net/tcp.h:369 / tcp_tw_status`，
但 `findDefinition` 汇总全局符号时用 `!s.parent` 过滤，而**枚举常量的 parent 是枚举名** —— 被当成
"成员"排除了。C 的枚举常量是非限定标识符（`TCP_TW_SYN` 直接写），parent 只表示"属于哪个枚举"。

做法（按方案 Phase 1–3）：
- 新增模块级 `isGloballyVisibleSymbol(sym, langId)`：`member/field/parameter/local/label` 恒不可见；
  `variable` 看 parent（有 parent = 局部）；**`enum_member` 恒全局可见**（含匿名枚举，parent 为空）；
  其余无 parent 即可见。`langId` 预留给 C++ `enum class`。
- 把散落的可见性过滤全部改成调用它：`findDefinition` 的 `fileDefs` / `plainHits` / 全局汇总 /
  最终 fallback，`findDefinitionGeneric` 的 fileLevel 与 global，`resolveIdentifierType` 的
  file/global 兜底（局部优先顺序不变）。文件级 `static` 逻辑（`withScope(..., 'file')`）保持原样。
- 索引格式、排序（`definitionRank`）、UI 一律没动。

验证 `node tmp/global-symbol-check.cjs` **12 项全过**：
`TCP_TW_SYN` @ `tcp_ipv4.c:2158` 与 `tcp_minisocks.c:226` → `enum_member @ include/net/tcp.h:369 /
tcp_tw_status`；`TCP_TW_RST/ACK/SUCCESS` → 367/368/366；**`TCP_ESTABLISHED` → `include/net/tcp_states.h:13`**
（真实匿名枚举，parent 为空）；反向用例：`has_rxtstamp` 仍是 `member/tcp_skb_cb`、`rt` 仍是 `local`；
自造工程里匿名枚举 `ANON_A/ANON_B` 与具名枚举 `NAMED_X/NAMED_Y` 都能解析。

顺带修了 `tmp/bitfield-check.cjs` 里两条过期断言（内核索引已重建：`parserStale=false`、
`has_rxtstamp` 现在走索引而不是文本兜底），改成"两条路都接受、只断言位置与来源"→ 15 项全过。

### 1.5.94 索引实时进度"看不到"（客户端轮询的洞）
现象：点「刷新索引」后没有任何实时状态/文件列表，但**宿主其实在正常上报**
（实测直连 `/api/sourcelook/index/status`：`building:true, phase:parse, done:42480/67842`，
`active` 里还有 `drivers/net/wireless` 这类正在解析的目录）。

原因（客户端）：进度面板只在 `indexInfo.building === true` 时才打开，而状态轮询的 effect 也是
**只按 `building` 启动**（`if (indexInfo?.building !== true) return`）。于是形成一个洞：
界面挂载时的第一次 `/index/status` 若没拿到、或构建是从别处发起的、或 `indexInfo` 还是 null，
`building` 就永远是 false → 轮询根本不启动 → 面板永远不出现，看起来"没有实时状态"。

修法：
1. 轮询改成**有项目就心跳**：构建中 900ms、空闲 4s；不再以 `built/building` 为前置条件，
   任何来源的构建都能在 4s 内被发现。
2. `startIndex()` 里**立刻** `setIndexPanelOpen(true)`（不等第一次轮询、不等响应），
   用户一点就该看到面板。

宿主侧确认无问题：`/index/status` 的 `progress` 一直有 `phase/done/total/active`。

**同轮修掉一个我自己引入的回归**：1.5.93 为解决"查询中途 fd 被关（EBADF）"引入的
`retireAuxiliary()`（推迟 15s 再 close）在 Windows 上会阻塞 `rename(tmpDb, finalDb)` ——
替换一个仍被打开的文件 → EBUSY/EPERM → **重建在写入阶段失败**（实测 `phase=failed`）。
已回退成 `closeAuxiliary()`（rename 前必须关），EBADF 改由 `index-store` 的
"读失败就重开一次"（`reopen()` + `readSyncRetry`）兜底；`close()` 也改成幂等
（`fd = -1`，避免重复关一个可能被复用的 fd 号）。
修复后用同一个宿主 API 触发完整重建：`phase=done`、`parserStale=false`，
`has_rxtstamp` 现在**从索引**解析（`synthetic` 为空、`type=__u8`、`include/net/tcp.h:859`）。

### 1.5.93 索引相关代码体检（7 个 bug，6 修 + 1 澄清）
重建索引前先审了一遍索引相关路径，修掉：

1. **P1 查询抛 TypeError**：`findDefinition` / `findSymbols` / `findSymbolsMany` / `findReferences`
   的回退分支写 `idx.symbols.filter(...)`，但 `fromDiskShape()` 早就不带 `symbols`
   （数组不再落盘）。当 `.crdb` 缺失/打不开（AUX_NONE）时 `db === null`、`indexCache` 却非空 →
   用户点任何符号都 500 `Cannot read properties of undefined`。四处改成 `(idx.symbols || [])`。
2. **P1 查询中途 fd 被关（EBADF）**：`saveIndex` / `saveRemoteIndex` 在 rename 前 `closeAuxiliary()`，
   而正在飞的查询还握着旧 store 的引用（`findReferences` 在 `await narrowMemberRaw` 里逐接收者
   推导类型，之后继续用同一个 `d`）→ `readSync` 抛 EBADF。新增 `retireAuxiliary()`：立刻从全局摘掉
   （新查询不会再用），**15s 后**才 `close()`，并 `unref()` 不阻塞退出。
3. **P1 全局符号页永远空**：`index-store.symbolsPage` 用 `let more = cand.length >= CAND_CAP` 预置
   `more`，候选被截到 5 万时循环第一步就 `break` → `rows: []`、`names` 上千、翻页永远空
   （内核索引输入 `de` 这类常见子串必现）。改成 `let more = false`，只由"真的取够 take 条"置位。
4. **P1 旧构建的 finally 清掉新构建状态**：切项目时 `setProjectRoot` 置 `indexBuilding = null`
   但旧 job 仍在跑，它的 `finally` 会无条件把新 job 的 `indexBuilding/buildSink/buildCancel` 全清 →
   状态栏显示"没在构建"、取消失效、还能再起一个 builder 同时写同一份 `.tmp`（两份构建字节混合、
   仍能通过 magic/format 校验）。新增 `buildGen` 世代号：只有"自己仍是最新一任"才允许清。
5. **P2 截断/半写索引不校验**：`index-store.openFromReader` 只校验 64 字节头；段越界要等到**查询期**
   才抛 RangeError。现在打开时校验 `off + len <= size`，越界按"索引不可用"处理。
6. **P2 UI 不显示截断**：`MAX_FILES` 截断时状态栏追加「文件数超上限，仅索引了前 12 万」。
7. **P2（澄清而非改行为）**：`buildIndex(root, prevByRel)` 的第二个参数从未被使用 —— 所谓
   "未改动文件复用符号、刷新近乎瞬时"并不存在。删掉参数与那句假注释，明确写成**全量重建**
   （这也是 PARSER_REV 升级后必须全量的原因）。

验证 `node tmp/index-bugs-check.cjs` **7 项全过**：常见子串的符号页有行且可翻页；`.crdb` 缺失时
`findDefinition` 不抛异常；截断的 `.crdb` 打开即被拒（`segment ... out of range`）。
回归：smoke-host / smoke-index / local-scope 22 / member-expr 21 / bitfield 16 / 渲染检查 全绿。

### 1.5.92 位域成员 + 索引解析器版本（BITFIELD-INDEX-PLAN.md 落地）
`TCP_SKB_CB(skb)->has_rxtstamp` 以前显示"未解析"。三层原因，全部处理：

1. **索引没有解析器版本**。`ts-indexer.js` 新增 `PARSER_REV`（内容版本，提取逻辑一变就改），
   构建时写进侧车 `.idx.json`（`toDiskShape`），加载时比对（`fromDiskShape` + `loadIndexFromDisk`）：
   不一致 → `idx.parserStale = true`、`idx.stale = true`，`indexState()` 多返回
   `parserRev` / `parserStale`，状态栏显示「解析器已更新，建议重建」。
   **不静默按旧索引回答**，但也不禁用（成员兜底会补），旧索引文件不删。
2. **成员文本兜底重写**（`memberFromTypeText`）：不再是"类型关键字白名单 + 上一行逗号续行"。
   现在按 C 声明结构扫：定位结构体块 `{}` → 只在该块自己那一层收集以 `;` 结束的声明 →
   按逗号拆声明符（识别 `name:N` 位域、`name[N]` 数组、`(*fp)` 函数指针、`*name` 指针），
   `blankNoise()` 把注释/预处理行替换成等长空格（偏移不变，类型前缀不会被注释带脏）。
   返回的 synthetic 成员带 `type`（实测 `__u8`）与 `synthetic: true`。
   另外加 8 条正文 LRU（按 mtime+size 校验，换项目时清空）。
3. **解析器提取本身**：`ts-indexer.extract()` 早已能提取同一声明里的多个位域名（回归用例
   确认 11 个成员全部入索引），所以旧索引才是问题来源 —— 重建一次即可。

验证 `node tmp/bitfield-check.cjs` **16 项全过**：
- A 提取器：`u8 a:1,b:1,c:1` / `u16 d,e` / `__u8 txstamp_ack:1,eor:1,has_rxtstamp:1,unused:5`
  / `unsigned long flags` / `char *name` 共 11 个成员全部在 `struct bits` 下；
- B 内核旧索引：`parserStale=true`；点 `has_rxtstamp` → `member @ include/net/tcp.h:859 / tcp_skb_cb`，
  `synthetic=true`、`type="__u8"`（走文本兜底补出来的）；
- C 小工程重建：侧车 JSON 写入 `parserRev`；位域成员 `a/c/d/e` 从**索引**解析（非 synthetic）。

真机 UI 实测：点击 `net/ipv4/tcp_ipv4.c:1879` 的 `has_rxtstamp` → 定义卡显示
「成员：include/net/tcp.h:859 · 859: has_rxtstamp:1, /* SKB has a RX timestamp */」，
状态栏「已索引 6,886,396 符号 / 67,834 文件 · 缓存 · 解析器已更新，建议重建」。

注：`buildIndexNow` 传了 `prevByRel` 但 `buildIndex` 并未使用 → **重建是全量重新提取**，
所以点「刷新索引」后位域成员会真正进索引（之后不再走 synthetic）。

### 1.5.91 "左上角小框框"的真凶：没有模型就被亮出来的空编辑器
**推导 + 定位**：Monaco 先就绪、恢复文件后完成时，旧代码里有一条"1.2s 后无论如何亮出编辑区"的
兜底（`setTimeout(() => setEditorVisible(true), 1200)`）。它会在**模型还没设上**时移除
`is-priming`，露出**一台空编辑器**——只有行号槽 + 光标，看着就是左上角一个小空框；随后文件读到、
`setContent` 执行，代码才顶上来。这也解释了"偶尔才看得到"：取决于 Monaco 与读文件谁先完成。

修法：**只有模型真的设上才亮**（`editorVisible` 只在 model effect 里、`setContent` 之后置真），
删掉那条 1.2s 兜底；加载页的撤页条件相应变成
`error` / `ready && editorVisible(+150ms 稳定期)` / `bootReady && 无标签（走欢迎页）` / 6s 上限。
其余时间编辑区保持隐藏（`.sl-main` 的纯背景），不会再出现任何"半成品"。

**实测**：连续 3 次冷启动（端口 9390/9391/9392），撤页那一刻的采样全部是
`model=true, lines=34, top=1647, priming=false` —— **加载页消失时代码已经在正确位置**，中间没有空档。

### 1.5.90 亮出编辑区前强制同步重绘（`render(true)`）
在 1.5.89 的 150ms 稳定期之上再加一层：`editorVisible` 置真之前调
`adapter.raw.render(true)`，让 Monaco **立刻按当前 scrollTop 同步重画**，而不是等它自己的
rAF 队列 —— 这样撤掉 `visibility:hidden` 时不可能再露出上一帧（第 1 行的空编辑器）。
实测：撤页后连拍 5 帧，第 1 帧即完整界面（1646 行、无多余框）。

### 1.5.89 撤加载页后再压 150ms（左上角残影）
用户反馈撤页瞬间主界面左上角仍会闪一个空框。查证：
- **DOM 层面没有残留**：从撤页那一刻起每 30ms 采样左上角 16×12 个点（`elementFromPoint` 链路），
  撤页瞬间与 1.5s 后的元素集合**完全相同**（12 条链路），编辑器首行也已经是 1647；
- **连拍 5 帧**（撤页后立即截图，间隔约 60ms）：第 1 帧就是完整界面，没有多余框。
=> 说明它最多是**合成阶段的一帧残影**（Monaco 首帧描画），DOM 采样抓不到。

修法（按用户要求"等主代码区完全就绪再撤页"）：撤页条件在 `ready && editorVisible` 之后再
`setTimeout(150ms)`，把首帧/次帧绘制彻底压掉。成本 150ms（本来就在等加载页，感知不到）。

### 1.5.88 标题栏三段式：前进/后退永远在窗口正中
需求：标题栏分左/中/右三段，**前进后退这一组的中心线 = 窗口中心线**，查找框紧跟其后；
不论是否最大化、P 还是 C 模式都一样。

原因：中间区原来是"绝对居中 + 查找框按 `left: calc(50% + 42px)` 手算偏移"，但有两条历史规则
在窄窗把它推翻 —— `@media (max-width: 1360px)` 把 nav 改成 `position: static; margin-left: auto`
（于是被推到右侧 DSH 旁边），C 模式另有一套 `!important` 补丁。1279px 窗口正好落在 1360 以下。

改法：
- JSX 新增 `.sl-top-center` 包住 `nav + find`；该容器 `position:absolute; left:50%; transform:translateX(-50%)`，
  容器宽度**只等于前进/后退的宽度**（查找框 `position:absolute; left: calc(100% + 8px)`，不参与居中），
  所以居中线就是前进后退的中心线。
- 删掉 ≤1360px 那条响应式改写与 C 模式的居中补丁；新规则用 `.sl-layer .sl-topbar .sl-top-center …`
  （4 个类名 + !important）压过其余历史规则。
- ≤1080px 隐藏查找框（再窄会撞到右侧 DSH/帮助），前进后退仍居中。

实测（1279px 窗口，P/C 两种模式各测一遍，切换三次）：`nav.center = 640 = innerWidth/2`，
与窗口中心 **delta = 0px**；查找框与 nav 间距 **8px**；左侧路径尾部到 nav **≈247px**、
查找框到 DSH **132px**，均无重叠；右侧留白仍是 `--sl-win-controls` 150px。

### 1.5.87 索引状态上色 + 路径弹层重排
**路径显示方式（决定）**：标题栏只显示项目目录的**最后一段**（`linux-5.10.239`），不是压缩路径
也不是两段：两段要 29 字符≈200px，太挤；完整路径在 tooltip 和弹层里都有。目录名本身 >24 字符
才从前面压掉（`…` + 末尾 24）。**括号去掉了**（颜色已经承担语义）。

**索引状态色**（新增 CSS 变量，三处共用）：未建=`--sl-idx-none` 红、
已建=`--sl-idx-ready` 蓝（品牌色）、构建中=`--sl-idx-building` 橙。
- 标题栏路径按状态上色（实测蓝 `rgb(0,95,184)`、未建时 `rgb(176,74,60)`）；
- 路径弹层里路径同样上色，**索引按钮就排在路径右边**（`刷新索引`=蓝底白字，
  `创建索引`=红描边，构建中=橙`取消索引`）；
- 项目图标菜单里新增同款入口（`刷新索引 / 已建索引`，文字带状态色）→ 两个入口齐了。

**弹层重排**：标题行 `项目目录 … 复制路径 ✕`（复制变轻量文字按钮放右上）；
中间行 `完整路径 + 索引按钮`；底部行恢复 `切换项目目录…` / `打开文件…` 两个入口。
宽度 380px、贴着路径按钮弹出。

### 1.5.86 标题栏系统性整理（区域/优先级/路径/弹层）
**Bug**：1279px 窗口下"项目目录"图标消失、"帮助"被窗口按钮盖住。原因两条：
1. `@media (max-width: 1400px)` 有一条 `.sl-top-action.project, .sl-top-path { display: none !important }`
   （还有 1280 那一档把 project/find/nav 一起隐藏）——**空间其实够**，属于历史规则误伤。
2. 右内边距散落成 116/122/146/148/150/158 六种写法，1279 下命中的是 122px，而三个窗口按钮要 ~138px。

修法：
- 新增变量 `--sl-win-controls: 150px`，**标题栏右内边距统一用它**（P 模式、≤1280 档全改）→ 实测
  `help.right + 150 = 1279`，正好不重叠。
- 删掉 ≤1400 的隐藏规则；≤1280 那档不再隐藏 project/nav/find，只让路径宽度收缩。
- 标题栏结构（左→右）：`品牌 | 菜单 | 分隔 | 项目图标 | 路径 | spacer | 前进/后退 | 查找 | DSH | 帮助`，
  窗口按钮区由 `--sl-win-controls` 预留；≤1000 才隐藏项目图标、≤900 隐藏品牌文字。

**路径文本**：`tailChars(root, 20)` —— 超过 20 字符就压前面，只留最后 20 个（带前导 `…`），
`title` 里始终是全路径；C 模式的 `max-width: 120px` 放宽到 190px，避免 CSS 抢先截断 JS 的裁剪结果。
实测 `D:\source_projects\linux-5.10.239` → `(…jects\linux-5.10.239)`。

**刷新按钮移入路径弹层**：标题栏的索引按钮删掉；点路径弹出的菜单里只剩
`复制路径` + `创建索引/刷新索引/取消索引`（按 `indexInfo` 状态），并改成**贴着路径按钮下方弹出**
（`pathAnchor` 取按钮 rect，left 夹在可视区内），宽度 380px，像菜单而不是居中大卡片。

### 1.5.85 加载页不盖标题栏
`.sl-boot-splash` 从 `inset: 0` 改成 `top: 40px; right/bottom/left: 0` —— `.sl-layer .sl-topbar`
是 `height: 40px !important`（早期写法里的 56px 被后面这条覆盖，实测 topbar=40、content.top=40；
一开始按 56 留边会把 crumb 条露出一条缝）。现在标题栏在加载期间完整可见、可点。

### 1.5.84 撤加载页时不再露出"左上角小空框"
**根因**：Monaco `create()` 之后**先画的是"第 1 行的空白编辑器"**（行号 `1` + 空行 + 光标，
看着就是一个左上角小空框）。我们在同一帧里 `setModel` + `revealLine` + `setScrollTop`，
但 **Monaco 要等它自己的下一帧才重绘**；而撤 `visibility:hidden` 是**立即**生效的 ——
1.5.82 把撤页条件放松成"`monacoStatus === 'ready'` 就撤"，正好会把**那张旧帧**露出来，
然后才跳到恢复位置。（数据佐证：早期采样里出现过 `lines=1, top=1, scroll=0` 的帧。）

修法：
1. 撤页条件改回 **`ready && editorVisible`**（代码真的就位才撤）；
2. `editorVisible` 再多等 **60ms**（双 rAF 之后 + setTimeout），让 Monaco 的重绘落地，
   而不是"两帧后就把旧帧亮出来"。

代价：加载页回到 ~3.7s（那 0.4s 就是这块框的价钱）。验收脚本 `d:\sourcelook\codebuddy\s-check-tail.cjs`
（纯状态采样，不截图）：撤页后每个样本都是 `lines=34 / top=1647 / caret=1648`，
**badSamples = 0**（不存在"撒页了但代码没就位"的帧）。

### 1.5.82 加载页显示项目目录 + 缩短覆盖时间
- **显示当前项目目录**：`rootInfo.root` 出来了就在“正在加载编辑器…”下面加一行等宽小字
  （`.sl-boot-splash-path`，70% 宽、超长省略、`title` 带全路径）。目录是 `/info` 回来才有的，
  所以前 0.5s 只有转环和文字，之后补上路径。
- **没有项目就跳过加载页**：`/info` 解析完（新增 `infoResolved`）若没有 root，立即撤页 ——
  没有代码可等，直接给欢迎页。
- **缩短覆盖时间**：撤页条件从 `ready && editorVisible` 放松成 **`ready` 就撤**，
  把最后那 ~0.3–0.4s（模型 + 滚动位置就位）放到代码页上完成。实测加载页
  **3.71s → 3.31s**，代码页尾部只有 ≤0.4s（通常和撤页同一帧）。

### 1.5.81 启动加载页（盖住 Monaco 那 3.7s）
DSH 自己的"加载插件"页撤掉后（约 5.1s），我们的外壳已出、代码还没就位，中间 3.7s 是半截画面。
用户拍板：自己加一张加载页盖住，**不做假延迟**。
- `.sl-boot-splash`：`.sl-layer` 里最后一个节点，`position:absolute; inset:0; z-index:999`，
  铺满整窗（同底色，无边框/无卡片），居中一个 18px 细环 + 一行 `bootLoading`（中英都有）。
- 撤页条件：`monacoStatus === 'ready' && editorVisible`（代码 + 上次滚动位置都已就位）→ 同一帧撤，
  整屏一次性到位；`monacoStatus === 'error'` 立即撤；另留 **6s 硬上限**，绝不锁屏。
- 只在本次进程第一次激活时出现（splash 是组件 state，切文件/切模式不会重来）。

实测（CDP 逐 60ms 采样）：**5.14s 出现 → 8.85s 撤掉**，同一帧代码出现在 1647 行；
之后再开文件 `splashCount = 0`。截图：`d:\sourcelook\codebuddy\shot-splash.png`。

### 1.5.80 启动代码出得更快（Monaco 加载提速 ~1.7s）
**先测清楚时间去哪了**（打开 `DIAG_ENABLED`，读 `GET /diag/state` 的 beacons）：
`apply` → `monaco-load` 瞬间 → `loader.js` 就绪 → **`monaco-ready` 要 4.5–5.6s**。
页面侧 `fetch` 验证：2.4MB 的 `editor-*.js` 只要 **51ms**、1.26MB 的 `toggleHighContrast` **29ms**
（≈47MB/s），`/file` 读盘 40ms。所以瓶颈是 **Monaco 自己的 4.3MB JS 的编译/执行**，不是网络、不是读文件。

两处改动：
1. **提前预热**：`90-export.js` 的 `apply()` 开头就 `void ensureMonaco()`，与 React 挂载（实测约 1.0s）、
   `/info`、读文件并行，不再等编辑器 effect。
2. **vendor 补丁**（`vendor/monaco/vs/editor/editor.main.js`，**注意：vendor 重新生成后必须重打**）：
   上游 shim 会连带加载 `index-DZH_zysX`（75KB）+ `toggleHighContrast-*`（**1.26MB**）+
   4 个语言服务 contribution（json/css/html/ts，共 11KB），这些我们用不到；C/C++ 的高亮来自
   `vs/basic-languages/monaco.contribution`（15KB，只依赖 editor 核心）。
   补丁后 shim 只保留：editor 核心 + basic-languages + nls + css + 默认 editor worker，
   `MonacoEnvironment.getWorker` 一律返回默认 worker（我们不用 json/ts/css worker）。
   `globalThis.monaco` 由补丁自己按需拼（`editor/languages/KeyCode/KeyMod/Range/Uri/...` 都有）。

实测（同一台机、冷启动、窗口前置）：`apply` → `monaco-ready` **5.58s → 3.87s**；
编辑器功能正常（34 行可见、119 个 token span、光标回到 1648 行、`monaco.Uri/Range/KeyCode` 齐备）。
端到端（外壳→代码）约 5.4s → 8.9s 的区间里波动 ±0.5s（CDP 轮询本身有开销），趋势一致。

### 1.5.79 启动不留任何中间态（1.5.78 的正文预览已撤）
用户反馈：1.5.78 的正文预览虽然快，但它是**从第 1 行开始**的，"先看到文件开头、再跳到上次的位置"，
而且那块预览看起来就像个"临时的框框"。要求：**宁可慢，也不要中间态**。
- 删掉 `bootPreview` / `.sl-boot-text` / `.sl-boot-gutter` 全部代码与样式。
- 改为**就位后再亮**：新增 `editorVisible`（ref + state），模型、caret、scrollTop 都在 model effect
  里同步设好之后，用双 rAF 把 `.sl-editor-host` 从 `is-priming`（`visibility: hidden`）切到可见。
  于是第一眼看到的就是"上次的位置"，不会出现"文件开头 → 跳过去"。
- `editorVisible` 只在 `monacoStatus !== 'ready'`（Monaco 重新加载）时复位，切文件不重新藏；
  另有 1.2s 兜底（空项目/文件全没了也不会一直藏着）。
- 顺手去掉启动时那句 `已回到上次的位置：…` 的 flashHint（也是一块临时文字）。
- 实测截图（`d:\sourcelook\codebuddy\shot-primed.png`）：第一帧即恢复到 tcp_ipv4.c 1646 行附近，
  DOM 里没有 `.sl-boot-text`，`is-priming` 与首行代码同一帧结束。

**硬规则（用户明确要求）**：启动路径上不要再加任何"临时画面/占位文字/预览"；要么空白背景，
要么就绪后的真界面。

### 1.5.78 启动不再有"空白编辑器"（正文预览）
**实测（CDP Network + DOM 轮询，冷启动）**：外壳 4.3s 出现 → **到 9.9s 才有第一行代码**，
中间 5.6s 的编辑器区是空白框。时间几乎全花在 Monaco：`vs/editor-*.js` 2.6–3.1s、
`basic-languages/monaco.contribution.js` 2.1s（`editor.main` 会把全部基础语言一起拉），
本地 `/file` 只要 40ms。这属于 Monaco 自身的加载/解析，插件这边砍不动（除非换精简构建）。

修法：**Monaco 就绪前先把正文铺上**（`bootPreview` + `.sl-boot-text`）：
- 取活动文件前 160 行，左侧自画行号、正文走 `highlightC` 上色；字号/行高用当前 `fontSize`
  算，和 Monaco 一致；换行保持 `pre`、不接收鼠标事件。
- 块注释状态在预览里自己维护（`highlightC` 是逐行的），所以注释整段是绿的，不会把注释里的
  `for`/`the` 当关键字染色、切换时跳色。
- `.sl-editor-host` 是绝对定位 + 不透明背景，Monaco 一挂上就盖住预览；`monacoStatus==='ready'`
  时预览直接卸载 —— 实测"预览消失"与"代码出现"同一帧（8290ms），没有空窗。

**效果**：正文 **4.7s** 出现（外壳 4.3s + 0.36s），比原来的 9.9s 早 **5.2 秒**；
`node scripts/build.mjs` → 634.1 KB。

### 1.5.77 启动不再闪"开始阅读代码"
**原因**：欢迎页的渲染条件是 `tabs.length === 0 && monacoStatus === 'ready'`。启动顺序是
`/info` → 恢复标签（**按存储顺序逐个 `GET /file`，读完才 `setTabs`**）→ 才有关闭标签；
那么 Monaco 一就绪（约 1–3s）到标签恢复完成（多标签时更久）之间，`tabs` 还是空数组 → 欢迎页
先出现，随后被代码顶掉。**不是**"恢复太慢"本身，而是欢迎页在"还不知道要不要它"的时候就先画了。

修法（`src/client/80-app.js`）：
- 新增启动闸门 `bootReady`（ref + state，`markBootReady()` 幂等）：`/info` 落定且**第一个文件**
  恢复完成之前不渲染 `.sl-empty`。无项目 / `/info` 失败 / 8 秒兜底 都会直接放行（这时欢迎页是正确内容）。
- 恢复改成**活动文件优先 + 逐个补齐**：先 `GET` 上次活动的那个文件 → `setTabs` + `setActivePath`
  → `markBootReady()`，其余标签在后台依次加载并 `setTabs(ordered())`（保持存储顺序）。
  `hydratedRef` 仍只在全部加载完后置真，避免把半截标签表写回 localStorage。
- 极端情况（活动文件读不出来、其它标签读出来）用 `loaded[0]` 兜底 activePath，不留空屏。

实测（CDP 从启动前就开始轮询 `.sl-empty`）：两次冷启动 **`sawEmpty = 0`**，先出现侧栏
（≈4.9s / 5.4s），随后直接出代码（≈8.0s / 8.7s，39 行），全程没有欢迎页。
**踩坑记录**：用 `--remote-debugging-port=9222` 启动 DSH 时连续两次报
`desktop welcome: Web authentication failed` 并退出（main 进程启动阶段，与插件无关）；
换 9333 端口即正常。看起来是上一次进程残留仍占着该端口/`DevToolsActivePort`。
以后反复重启调试时**每次换一个端口**，或先确认端口已释放。

### 1.5.75 光标/鼠标系统性梳理（颜色 + 形状 + 移动开销）
**真 bug（白底白光标）**：`--sl-cursor-color` 以前由 `applyCursorContrast()` 用
`getComputedStyle(.monaco-editor-background)` **测量**得到。主题切换是 `setTheme()` 之后下一帧才重绘，
测量很容易落在**旧主题**上（深色→浅色的中间帧）→ 把变量写成 `#ffffff` 并**一直保留**，
浅色下就成了白底白光标（"偶尔"的由来）。现在：
- 新增 `themeBackground()`（与 `defineMonacoTheme` 读同一份 token）与 `syncCursorColor(bg)`，
  光标色**只由主题背景亮度算**，和 `editorCursor.foreground` 同源同值；
  `defineMonacoTheme` 里同步写 + 下一帧再写一次，不再测量。
- 额外同步点：`data-sourcelook-mode` 变化（P/C/D）、`visibilitychange`、Monaco 重新加载。
- CSS 兜底仍是中灰 `#8a8a8a`，变量丢失也不会和底色同色。
- 实测五套主题（light/dark/sepia/graphite/mint）+ 深→浅往返：变量与光标背景始终一致
  （浅色 `#1f2328`/白底、深色 `#e8eef8`/`rgb(32,35,41)`）。

**鼠标指针（I 形）**：全仓 555 条 `cursor:` 声明、**0 条 `url()`** → 文字区的指针一直是系统 `text`
（Windows 的 I 形是白色主体 + 细黑描边，白底上确实"贴白"）。
1.5.75 曾试过自绘双描边 SVG I 形（`--sl-ibeam`），**1.5.76 已撤回**：用户认为形状不自然。
现在 `.monaco-editor .view-lines/.view-line` 显式写回 `cursor: text`，`--sl-ibeam` 与生成代码一并删除；
自动对比色逻辑（`--sl-cursor-color`）保留。**不要再改系统指针形状**——要解决"白底看不见"只能靠
系统光标方案，应用侧改形状会显得怪。

**形状审计**（网格采样 + 逐类 computed cursor）：按钮/符号行/面包屑/浮条/DHS 尺寸钮 = `pointer`；
左右分栏 = `col-resize`；底部窗高度条 = `row-resize`；行号区 = `default`；输入框 = `text`；
`.sl-nav-btn` 仅在禁用态为 `default`（正确）。未发现异常。

**移动开销**：CDP 真实 `mouseMoved` 40 次扫过编辑器，rAF 帧间隔 p50 11ms / p90 13ms / max 19ms
（= 空闲 vsync 基线，无长帧）；扫符号窗 p50 3ms。客户端代码里没有任何 `mousemove` 监听，
指针移动没有额外 JS 成本。

### 1.5.74 成员访问按 AST 表达式解析（MEMBER-EXPRESSION-PLAN.md 落地）
`x->field` / `a.b[i].c` 的**接收者类型**不再靠文本正则猜，改由 worker 归一化表达式后推导。

worker（`host/local-scope-worker.js`）buildScope 增补：
- `members[]`：每个 `field_expression` 一条 `{name, line, column, endColumn, operator, shape}`，
  其中 `shape` 是归一化表达式树（`identifier` / `member` / `subscript` / `call` / `cast` /
  `pointer` / `parenthesized` / `unknown`）；subscript 的 index、call 的实参**故意丢弃**
  （主机用不到），单文件 payload 因此只有 ~360KB / 823 条（tcp_ipv4.c）。上限 6000 条。
- `declarations[]` 增 `ptrDepth` / `arrayDepth`（从声明符链数出来，`struct foo *p`、`char *a[4]`）。

host：
- `local-scope.js` 增 `findMemberAt(scope, line, column)`（按字段标识符自身列区间匹配，
  `a.b.c` 三个字段各自独立，天然选对最内层）。
- `fs-service.js` 新增 `resolveReceiverType` / `resolveShapeType` / `resolveIdentifierType` /
  `resolveMemberType` / `resolveCallType` / `elementTypeOf` / `stripOnePointer` / `declTypeText`，
  `findDefinition` 成员分支改成：AST 命中 → 推类型；推不出 → 原 `baseTypeOfExpr` 兜底。
- 类型来源优先级：当前函数 AST 局部声明（带 ptr/array 层数）→ 索引里“带类型”的符号
  （同文件优先、点击行之前优先）→ `baseTypeOfExpr` 文本推导。

**踩到的坑（都写进代码注释了）**：
1. 不能直接解析点击那个 member 的 shape —— 那得到的是**成员自己**的类型（`...b.g` 得到 `int`），
   要找的是它的**接收者**：取 `shape.base`，`->` 再解一层指针（`resolveReceiverType`）。
2. 索引里会混进“把使用行当声明”的噪音行（`type` 为空），直接 `mapSymbols` 取第一条会拿到空类型；
   只认 `type` 非空的符号。这就是 `(*g_ptr).b.g` 最初解析成 `int` 的原因。
3. 缓存里的 worker 被 `terminate()` 后，旧 worker 的 `exit` 事件会误杀**新** worker 的在跑任务
   （连续 3 次就把 AST 永久降级）→ 加 `workerGen` 世代号，陈旧事件直接丢弃。

验证：`node tmp/member-expr-check.cjs` **21 项全过** ——
A) 表达式归一化 + 列命中（`arr[i].f`、`ptr[i].f`、`(*ptr).b.g`、`make_bar()->g`、cast 优先级）；
B) 建了索引的小工程（`tmp/fixture-member/`）端到端：`g_arr[1].f`、`g_ptr[2].f`、`(*g_ptr).b.g`、
`make_foo()->f`、`((struct foo *)g_ptr)->f`、局部变量链 `local.b.g` 全部落到 `foo.h` 对应成员；
不存在的成员仍返回“未解析”；
C) 内核回归：`errno`@`tcp_ipv4.c:572`、`errno`@`raw.c:267` → `include/net/icmp.h:24 / icmp_err`，
`rt`@241→217、`net`@104→参数。
另有 `tmp/local-scope-check.cjs` 22/22（局部作用域回归）。

### 1.5.73 局部变量作用域改用 AST（LOCAL-SCOPE-AST-PLAN.md 落地）
点击 C 局部变量/参数时，先查 **tree-sitter 生成的 LocalFileScope**（缓存命中零解析），
未命中/失败再回退原来的文本扫描，并在后台补建 AST。

新增文件：
- `host/local-scope-worker.js`（CJS worker）：接收 `{type:'build', id, rel, text}`，用
  `vendor/tree-sitter/tree-sitter.js` + `tree-sitter-c.wasm` 解析，产出纯 JSON：
  `{ functions:[{id,name,startLine,endLine,bodyBlockId}],
     blocks:[{id,parentId,functionId,depth,startLine,startColumn,endLine,endColumn}],
     declarations:[{name,kind,type,line,column,startOffset,blockId,functionId,text}] }`。
  支持：函数体/嵌套 `compound_statement` 各自成块、`for (int i…)` 合成块（不泄漏到循环外）、
  多声明符（`int a, b;` / `struct foo *x, *y;` / `int a[4];`）、参数。
- `host/local-scope.js`：worker 客户端 + LRU(24) 缓存 + 查询。
  `configure({readText,stat,maxBytes})` / `lookup(rel)`（只读缓存 + 一次 stat 版本校验，
  **绝不等 worker**）/ `enqueue` / `warm` / `invalidate` / `clear` / `shutdown` / `query`。
  worker 懒启动、`unref()`、单任务队列、5s 超时、连续 3 次失败即永久降级到文本扫描、
  >1MB 文件跳过。

接线（`host/fs-service.js`）：
- `findDefinition` 第 3 步：`lookup` 命中 → `query` 命中即返回（`astDefinition()` 转成与文本扫描同形的行）；
  否则文本扫描兜底，并 `enqueue` 补 AST。
- `writeFile` 成功后 `invalidate(rel)`；`setProjectRoot` 里 `clear()`；新增导出
  `warmLocalScope(rel)` / `shutdownLocalScope()`。
- `index.js`：新增 `POST /api/sourcelook/local-scope/warm`（只排队，立即返回
  `{ok:true,queued:true}`）；dispose 里 `svc.shutdownLocalScope()`。
- `src/client/80-app.js`：activePath 变化时对 `.c/.h` fire-and-forget 调 warm（404/失败静默）。

与设计文档的差异（都是有意的）：
1. Block 记 `startColumn/endColumn/depth`，按 (line,column) 判包含 + 取 depth 最深；只用行区间在
   “单行 if / 同名嵌套块”上会判错。
2. 查询用 (line,column) 比较先后，`startOffset`（tree-sitter 是字节偏移）只作为同行并列时的
   tiebreak —— Monaco 列号是 UTF-16，混用字节偏移会在非 ASCII 行错位。
3. Declaration 多带一个 `text`（声明行 trim 后 200 字符）：底部定义卡显示的就是这个字段，
   文本扫描路径也有，缺了会从“有代码片段”变成空。
4. `for_variable` 对外一律报 `kind: 'variable'`（界面 kind 词表里没有 for_variable）。
5. 点在签名/参数行（不在任何块内）时回退到该函数的 body block，参数也能走 AST；文档原本让这种
   情况走文本兜底。
6. 统一一个 1MB 上限（文档里 1MB/2MB 两个数字并存）。
7. 缓存放在独立模块 `host/local-scope.js` 而不是塞进 fs-service（fs-service 已 3500 行）。

验证：`node tmp/local-scope-check.cjs` 22 项全过 —— fixture（嵌套块遮蔽、兄弟块不泄漏、
for 变量出循环、多声明符、数组、参数）＋ 真实内核 `net/ipv4/tcp_ipv4.c`
（`rt`@241→217、`daddr`@228→215、`daddr`@232→215、`net`@104→参数 104；解析+传输 200ms，4 次查询 0ms）。
端到端（页面内打插件自己的 HTTP 接口）：`/local-scope/warm` 200 `{ok,queued}`；
`/definition` 返回 `rt`→217 `type:"struct rtable"`、`parent:"tcp_v4_connect"`、`scope:"local"`
（`type` 有值即证明走的是 AST 路径，文本扫描该字段恒为空），`daddr`→215、`net`→104 参数。

新增自检脚本：`tmp/local-scope-check.cjs`（`node tmp/local-scope-check.cjs`）。

### 1.5.72 AI 全部转交 DSH（插件内 AI 面板下线）
用户决定：插件不再自带 AI 弹框/API Key/本地模型，**所有 AI 动作统一交给 DSH 小窗（C 模式）**。
- 新增 `promptToDsh(text)`（80-app.js）：`ctx.get('sessions')` → `sessions.using(sessionId, {source:'gateway'})` →
  `binding.session.prompt([...], 'queue')` → `setMode('C')` + notice「已发送到 DSH」；没有会话时降级为
  复制到剪贴板并提示。这是原先"发送到 DSH"按钮的同一条通路，只是现在成了唯一通路。
- `openAi(kind, word)`（浮条 AI / 右键 AI / Ctrl+I 共用）不再 `setAiOpen(true)`，改为构造提示词后
  `promptToDsh` 直接发出。`applyAiPrompt` 同样改为直发。
- `askAiRaw`（双击空白的行内 AI 编辑带）也改走 `promptToDsh`：回车=发送到 DSH，带子自动收起并提示；
  原来的回答 textarea/插入行不再出现（插件拿不到 DSH 的流式结果）。
- `aiPanel` 的 JSX 仍在文件里但**永远不可达**（`setAiOpen(true)` 已无调用点），界面上不会再出现
  `.sl-ai-panel`。可后续整块删除（含 `askAi/copyAiText/sendAiToDsh/aiConfig` 等）。
- 实测：Ctrl+I → DSH 会话里出现「符号 `skb_unref`…上下文：net/core/skbuff.c:708」并被处理；模式自动转 C。

### 1.5.72 上下文窗定义区确认无按钮
实测 `.sl-cw-card` 内 `button/[role=button]` **数量为 0**：定义卡只有「标题行（展开/折叠 + 跳预览）」、
`[-]`/`[+]` 与条件 chips（`[!_LINUX_SKBUFF_H]` 等，纯 `title` 悬浮说明）、行（单击预览/双击打开）。
没有 AI/复制等动作按钮，符合"定义区不出现按钮"的要求，本轮无需改动。

### 1.5.72 顺手修的 bug
- 右键菜单的「选中整个函数」「打开 #include 的头文件」「谁引用了这个头文件」以前读**旧光标行**；
  现在这些函数接受 `lineOverride`，右键菜单传 `editorMenu.line`（菜单栏命令仍用光标）。
- 已知未解：`选中整个函数` 在 `net/core/skbuff.c:3225 skb_queue_tail` 上只选中签名 1 行
  （大纲里下一个函数是 3245），疑似 `outlineRef.symbols` 里存在界面上不可见的重复/误判 function 条目，
  待查；不影响其它功能。

### 1.5.71 主编辑器滚动迟钝的真正原因（已修）
**现象**：Monaco 主代码区滚动"没有跟随感/偏迟钝"，左侧符号窗（原生 DOM 滚动）却很跟手。
**实测方法**（`d:\sourcelook\codebuddy\` 下的 CDP 探针，DSH 用 `--remote-debugging-port=9222` 启动）：
`bench-scroll.cjs`（连续滚动的帧间隔）+ `tracerecalc.cjs`（CSS 追踪：UpdateLayoutTree 的
elementCount/耗时）+ `profscroll.cjs`（CPU profile）。
**数据（修复前，4661 行 `include/linux/skbuff.h`，200% DPI）**：
- 滚动帧间隔 p50 **68–70 ms（约 14fps）**，空闲 11 ms；
- 每帧一次 `UpdateLayoutTree`，**elementCount 8290 / 55 ms**（整文档样式重算）；
- 删掉全部 5194 条装饰、去掉函数阴影，帧率**完全不变** → 装饰/阴影/DPI 都不是原因；
- CPU profile 里 90% 时间在 `getPropertyValue` / `getBoundingClientRect`（都是"强制样式+布局刷新"的落地函数）。
**根因**：宿主（DSH 的 Files 页插件）样式表里有**主体无约束的 `:has()`**：
`:has(> ._4EiRdG_navigator._4EiRdG_fill) > :not(._4EiRdG_navigator)`。
Blink 无法为它算出收窄的 invalidation set，于是文档里**任何一次 DOM 增删**都会让整棵文档重新算样式；
Monaco 每帧滚动都要重写可见行 → 每帧 55 ms 样式重算。用一张 22 条规则的样式表逐条删除验证：
删掉这条规则 → 单次 DOM 改动 57 ms → **2.5 ms**，滚动帧间隔 68 ms → **12 ms**。
**修法**：新增 `src/client/45-host-css.js`（`installHostCssGuard`，在 `90-export.js` 的
`ctx.effect` 里安装）。只做运行期处理，不动宿主文件：扫描同源样式表，把"以 `:has(` 开头"的
选择器片段换成永不匹配的 `.sl-hostcss-guard-off-N`，卸载时原样写回；`<style>`/`<link>` 变化时
重扫（有"数量未变则跳过"的短路）。
**代价**：宿主 Files 页 navigator 的 "fill" 模式不再隐藏兄弟面板（该规则唯一用途）。
**修复后**：滚动帧间隔 p50 **11 ms（= vsync，与空闲一致）**；单次 DOM 改动 4 ms。

同时修掉的每帧开销（都在滚动时每帧命中）：
1. `syncDshMenu` 每帧被 ResizeObserver 自反馈循环触发：回调里 `observeChrome()` 会
   `disconnect()+observe()`，而 ResizeObserver 对每次新 observe 都会补发一次初始通知 →
   无限循环；每次调用还 `getComputedStyle(documentElement).getPropertyValue('--dsh-windows-menu-start')`
   + `getBoundingClientRect()`。现在：re-observe 只在锚点节点真的换了时做；CSS 变量按
   `applyShell` 周期缓存（`readDshMenuStart/resetDshMenuStartCache`）；几何写入走 `put()`（值相同不写）。
2. DSH 忙碌状态探测器（`#root` 子树 childList+characterData observer）每次回调 3 个全树
   `querySelector`。现在缓存命中节点（`isConnected`+`matches` 校验）并把重扫节流到 250ms。
3. `smoothScrolling: true → false`：Monaco 只对**物理滚轮**走 125ms 缓动动画（内部 `MG=125`），
   触摸板像素增量本来直写 scrollTop。关掉后滚轮才 1:1 跟手（灵敏度 2.2 保持，实测 ≈1:1）。

### 1.5.71 顺手修的正确性缺陷
- Monaco 初始化 effect 的 cleanup 写在 `ensureMonaco().then()` 里 → React 不会调用，
  `monacoReload` 每次都会在同一 host 上再挂一份 contextmenu/dblclick 监听（闭包还持有已 dispose
  的 adapter）。改为外层 `detach` 变量 + effect 同步返回的清理。
- AI 行内编辑：`run()` 在 `await askAiRaw` 之后无条件 `resize()`；等待期间 Esc/点外面/换文件会
  已经移除 view zone，迟到的 resize 把脱离 DOM 的节点重新挂成一条**删不掉的空白带**。
  现在 await 后校验 `aiZoneRef.current === zone`。
- `saveActive`：`content` 在 await 前取、`savedAltVersion` 在 await 后取 → 保存期间继续输入
  时磁盘落旧文本、tab 却被标记已保存（关标签不提示，输入静默丢失）。现在同一时刻快照，
  并按"保存后是否又改过"重算 dirty；`clearDraft` 只在不脏时清。
- `showContext` 无请求序号：连点两个词时旧应答覆盖新词（标题新、内容旧）。加 `contextSeqRef`；
  底部代码预览 `previewResult` 也加独立序号 `contextPreviewSeqRef`（与结果窗的 `previewSeqRef` 分开）。
- `openFile`：await 之后复查 tabs，避免双击同一个文件开出两个标签（共用草稿/dirty 键）。
- `ContextCodePane` 的滚动 rAF 未在卸载时取消 → 对已卸载组件 setState。
- 草稿 `writeJsonStorage` 现在返回成功/失败；配额满时清掉该草稿并提示一次，不再假装存了。
- 光标颜色：主题里的 `editorCursor.foreground` 原本写死 `#000000`（深色主题下 CSS 覆盖失效时
  就看不见），改为按编辑器背景亮度算；CSS 兜底从黑改成中灰。

### 1.5.71 验证
- `node scripts/build.mjs` → 625.4 KB；`node --check client.js`；`tmp/check-render.mjs`
  `OK render: components=17`；`scripts/smoke-host.mjs` / `scripts/smoke-index.cjs` 全过。
- 真机（DSH 桌面端 + CDP）：滚动 11 ms/帧；P↔C 切换后 `#root` 几何与 DSH 菜单锚点正确；
  单击 `refcount_read` 出 2 条定义 + 代码 + 引用分组；双击出浮动条；深色主题下
  `--sl-cursor-color`=#ffffff（编辑器背景 rgb(32,35,41)）。

### 主题（全套）
- 1.2 外壳里硬编码的浅色（标题栏/符号窗/状态栏/卡片/弹层/输入框/右键菜单）
  全部改成 `--sl-*` token；深色、羊皮纸、薄荷、石墨现在都是**整窗**生效，
  `data-sl-theme` 与 `body[data-ds-dark-theme]` 两条路径都覆盖。
- 暗色插件 + 浅色 DSH 时，`syncHostDark()`（50-shell.js）会把 DSH 一起变暗：
  加 `body[data-ds-dark-theme]`，并把 DSH 自己 dark 规则里的 `--dsw-*` token
  以 `!important` 写回 body；DSH preload 侦听到 body 变化后自动重绘 Windows
  原生 caption 按钮（颜色取自 `--dsw-specific-sidebar-fill` / label-primary）。
  切回浅色/跟随/其它主题时逐字恢复。`auto` 不动 DSH。
- DSH 子窗口的 40px 标题带与边框改用 `--sl-dsh-band / --sl-dsh-border`，
  跟随 body 的深浅。

### DSH 按钮
- 尺寸 **70×30**（原来 78×32，高度与前进/后退一致），科技蓝渐变、白字、
  内高光；状态圈改 `currentColor`（白环 + 白弧），工作中仍 1.4s 旋转。

### 编辑器
- 字号 9–30，半磅步进；菜单 `视图 → 放大/缩小/重置字号`，快捷键
  `Ctrl+=` / `Ctrl+-` / `Ctrl+0`，跨重启保存。
- `Shift+F8` 整词高亮切换（状态栏显示 `高亮 word · N`，点它或再按一次取消，
  `Esc` 取消）。
- 双击词 → **浮动动作条**：查找 · 调用 · 定义 · 高亮 · AI · 复制
  （单击任意处关闭；双击仍然只选中、不跳转）。
- 右键菜单扩充：我调用谁（本文件扫描）、选中整个函数、复制、复制（带位置）、
  打开 `#include` 头文件、谁引用了这个头文件、转十六进制/十进制。

### 结果窗口（原版「查找结果」，按原版重做）
- 结构照原版：**32px 标题栏**（左侧 3px accent 竖条 → `调用/定义/查找` 胶囊 →
  查找词输入框 → 标题 → `共 N 处` → 弹簧 → 范围按钮（仅查找）→ `×`）+ **列表卡片**
  （42% 高、16px 圆角、独立投影）+ **代码卡片**（整文件、`file:line` 小标题、
  命中行高亮并滚到 1/3、超过 6000 行截断提示）+ 右下角缩放把手。
- 行形状照原版：`badge? 调用者()? 文件 [来自 pool] [近似] 行号 命中行原文 [conf]`；
  悬停提示带 `fn / file:line / 声明 / 结构体 parent / 编译条件`；单击选中并在下方
  代码卡片预览（**不跳转**），双击才打开文件。
- 类型胶囊点开是小菜单（调用/定义/查找，当前项带 ✓）；查找窗口才有四个范围
  （本文件/本目录/索引/全文匹配），默认本目录；改词回车按**原类型/原范围**重跑。
- 标题规则：`本文件 · rel` / `本目录 · dir` / `索引 · 调用 N，读取 M…` /
  `全文匹配 · …` / 定义与调用给 `类型 · 定义于 file:line · 另有 N 条…`。
- 单命中直接跳（定义/调用）、0 命中只提示不弹窗；索引行会回读命中行原文；
  当前文件有未保存修改时预览用**编辑器缓冲**而不是磁盘。
- `F4` / `Shift+F4` 逐条并滚动到可见；关闭后 `查找结果` 按钮可重新调出。
- 几何默认照原版：宽 `min(1180, 94%)`、高 `min(640, 82%)`、水平居中、
  顶部 `max(46, 9%)`，拖动/缩放后记住。

### 全局符号窗（分页）
- 符号/文件列表改成 `/symbols-page`、`/files-page`：首屏 200 行，滚到底自动加载
  下一页（距底 160px 触发），底部显示「滚动到底继续加载 / 加载中…」；
  分组跨页合并，过滤词变化时从第 0 页重来。

### 宏展开（原版「展开（代入实参）」）
- 右键菜单与双击浮条里出现「展开」的条件与原版一致：这一行是 `name(...)` 调用，
  且索引里 `name` 是宏（异步判定，菜单先出、条件成立再补这一项）。
- 浮层显示 `调用文本` 和代入实参后的宏体；宏体的每一行可点，跳到 `#define`
  对应行；底部注明「只做参数替换 · 不展开 include、不求值条件编译」。
- 多行宏用 `\` 续行保留换行；点定义自身（实参=形参）不弹。

### 解析与增强
- 面板新增「生成解析报告」（`/enhance/report`）：显示未看懂处数/类数、
  旧索引提示、完整报告文本（可选中复制）。
- 「导出到 .kernelscope/」（`/enhance/export`）：写到 `<项目>/.kernelscope/report.txt`，
  面板显示写入路径。
- 增强包闭环：粘贴 `ks-enhance/2` JSON →「预演」（`/enhance/preview`）显示
  取样文件数、+/- 符号数、影响文件数、体检错误与前 8 个样例；「应用并重建索引」
  （`/enhance/apply`）写 `enhance.json` 后带确认重建。
### 全局符号窗
- 单击符号 = 预览（填顶栏查找 + 出底部上下文），双击 = 打开文件；
  与原版右栏一致。

### AI（原版 AI 助手 + 行内编辑）
- Host 新增 `host/ai-service.js`（OpenAI 兼容，`stream:false`，180 秒超时，Key 只按请求
  转发、不落盘）与 `/ai/chat`、`/ai/models` 路由。
- AI 面板此前是**死代码**（`const aiPanel` 从未挂进返回树），1.1.78 修好并重做：
  模型徽标、⚙ 设置（本地 Ollama / OpenAI 兼容、Base URL、模型 + ↻ 读取、
  API Key）、消息记录（你 / AI · 模型 / 错误，自动滚到底）、9 个按类按钮、
  提示词框（Ctrl+Enter 发送）、发送 / 复制提示词 / 发送到 DSH。
  发送时若提示词里没有代码块，自动补上光标附近 ±8 行与 `file:line`；只在你点
  发送时请求。C 模式下 AI 面板停在 DSH 面板左侧，不再盖住子窗口。
- AI 行内编辑（原版 view zone）：**行尾空白处双击**打开编辑带；写要求 →
  「生成」（Ctrl+Enter）→ 可编辑答案 → 「插入」。插入只产生一次撤销点、
  带 AI 底色（保存后消失）；`Esc`/取消不碰文档。行中间有内容时拒绝并提示。
- **Host 代码没有 HMR**：本轮新增的 `/symbols-page`、`/files-page`、
  `/config-value`、`/kconfig`、`/enhance/*`、`/ai/*` 都要**完全重启 DSH** 才生效。
  客户端分页已对旧宿主回退到 `/symbols`、`/files`；CONFIG/增强/AI 在重启前会 404。
### 上下文窗 AI（原版 Context Window 的 AI 动作）
- 底部定义列顶部新增动作行：`查找引用`、`跳到定义`，以及按符号类型给的 AI 问题：
  函数 → 它做什么 / 参数与返回值 / 风险点；类型 → 字段含义 / 该怎么用 / 风险点；
  宏 → 展开与语义 / 风险点；变量 → 作用与取值 / 风险点。
- 点 AI 按钮：追加一个 pending 块，请求 `/ai/chat`，成功后把回答写回块里；
  同一词最多保留 8 条，失败显示红色错误块。AI 未配置时按钮禁用并提示。

### 1.5.31 函数调用改为 600
- 400 就是正常字重，看不出加粗；函数调用改 600，定义仍 800。
### 1.5.30 函数定义/调用字重分开
- 函数定义 `.syn-fn-def`：800 粗体 + 阴影；函数调用 `.syn-fn`：400 正常字重、无阴影。
### 1.5.29 函数名加粗 + 阴影
- `.syn-fn-def`（函数定义）和 `.syn-fn`（函数调用）统一 700 粗体、0.1px 字距，
  加 `0 1px 1px rgba(0,0,0,.22)` 阴影；函数名比普通标识符更突出。
### 1.5.28 状态栏去掉“加载 N ms”
- 用户看到的“加载 4313 ms”是内核索引缓存的加载耗时（6.9M 符号），不是编辑器加载失败/卡住。
- 状态栏只保留“已索引 N 符号 / N 文件 · 缓存/构建”，不再显示加载毫秒数。
- 客户端改动，刷新页面生效。
### 1.5.27 标签判定兼容 `failure:` 和 `goto failure`
- 之前只匹配行首 `name:`；在 `goto failure;` 上点 `failure` 仍会走索引并发“类型/未找到”。
- 现在同时匹配行首标签和 goto 目标；定义区只显示 `标签 failure`，不发定义请求。
- 客户端改动，刷新页面生效。
### 1.5.26 C 标签显示类型名“标签”
- `failure:` 定义区显示 `标签 failure`（goto 标签的实际类型名）。
### 1.5.25 C 标签只显示标签名
- 定义区不再出现“类型”两个字；`failure:` 只显示 `failure`。
### 1.5.24 C 标签显示“类型 failure”
- 点 `failure:` 这类 goto 标签时，索引没有标签符号，之前显示“没有”。
- C/C++ 行首 `name:` 匹配时，定义区只显示 `类型 failure`，不查索引。
- 客户端改动，刷新页面生效。
### 1.5.23 定义区提示统一缩短
- 注释/字符串只显示“注释”/“字符串”；数字 `数字 65535`；预处理显示“预处理”；
  C 关键字/其他语言关键字只显示“C 关键字”/“Java 关键字”等。
- 未解析只显示“未解析”；找不到定义只显示“未找到”；不再写长句解释。
- 客户端改动，刷新页面生效。
### 1.5.22 数字定义区只显示“数字 + 数字”
- 不再写“是数字字面量，不是符号…”；定义区只显示 `数字 65535`。
### 1.5.21 数字判断简化为“数字开头”
- 用户要求不要枚举 0x/0b/浮点/后缀；`/^\d/` 即以数字开头即数字常量。
- 客户端改动，刷新页面生效。
### 1.5.20 数字字面量不再查索引
- 点 `65535` 时上下文误报“未在索引里找到 65535 的定义”；数字不是符号。
- `showContext` 在注释/字符串之后、预处理/关键字之前识别数字字面量：
  十进制/浮点/指数、`0x`、`0b`、`0o`、以及 `u/l/f` 后缀，统一显示“数字常量”。
- 不再发 `/definition` 请求，也不会出现“没有符号索引”的误导。
- 客户端改动，刷新页面生效。
### 1.5.19 左右边缘悬停隐藏/展开 + DSH 菜单同步节流
- 左右 `.sl-pane-hot` 不再只在收起时渲染：开着时悬停显示“隐藏”箭头（左 fold-left，
  右 fold-right），收起时显示相反方向“展开”。热区 10→16px，z-index 30，右侧按钮
  不再被折叠栏/DSH 面板盖住。
- DSH 菜单同步改用 `put()` 值相等就跳过，减少每次 rAF 重复写 7 个内联属性；
  ResizeObserver 只在 mode C 启用，P/D 不再反复观察 root 触发布局。
- 这两项降低模式切换时的样式重算；DSH 子窗口本身的 Electron 布局/重绘仍由宿主决定。
- 客户端改动，刷新页面生效。
### 1.5.18 临时高亮覆盖全部同名 + 嫩绿色
- 单击后不再只标一个 token：`transientHighlightWord` 用 `model.findMatches(\bword\b)`
  找出当前文件全部同名，最多 400 处，统一淡绿 `rgba(88,190,120,.26)`。
- 持久高亮仍是黄色；临时集合独立，切文件清空，点空白清空。
- 客户端改动，刷新页面生效。
### 1.5.17 单击临时高亮 + 恢复普通光标
- 主编辑器单击词：新增 `transientHighlight` 装饰，只标当前这个词，淡蓝
  `rgba(59,142,240,.16)`；点空白/别的词自动替换；切文件清空。
- 持久高亮仍是黄色，两套装饰集合互不影响。
- 光标不再用红色：`editorCursor.foreground` 回到按背景亮度的中性色
  （浅底 `#1f2328`，深底 `#e8eef8`），并去掉 CSS 固定红/粉背景，只留极淡灰描边。
- 客户端改动，刷新页面生效。
### 1.5.16 后退位置与光标颜色最终修正
- 后退丢位置：历史行的更新之前放在 activePath 变化后的 effect 里，此时编辑器已经切到新文件，
  读到的是新文件行；普通切 tab 时把“A 的历史”写成了 B 的行，后退自然回错位置。
- 现在在 `openFile` / `openFileAt` / 关闭标签前调用 `rememberCurrentHistory()`，在切换前
  从 Monaco 取实时行写回**当前文件自己的历史项**；`goBack`/`goForward` 也在移动索引前
  再捕获一次当前行。
- 光标白：实测 Monaco 的 cursor DOM 是 `.monaco-editor .cursor`，之前只匹配
  `.cursors-layer .cursor` 没有覆盖到。现在直接给 `.monaco-editor .cursor` 固定
  `background-color:#ff4d6d !important` + 白色半像素描边。
- 客户端改动，刷新页面生效。
### 1.5.15 光标固定高对比 + 位置从 Monaco 实时取
- 光标颜色不再依赖主题 token：`editorCursor.foreground` 固定 `#ff4d6d`，CSS 再给
  `.monaco-editor .cursors-layer .cursor` 固定背景色 + 半像素白描边，任何底色下都可见。
- caret 保存改为启动时直接读 caret 表/lastPos；保存时向 `adapter.raw.getPosition()` /
  `getScrollTop()` 取实时值，不再依赖可能停在文件第 1 行的 rAF 光标 state。
- 增加 `onDidScrollChange` 180ms 节流保存，滚轮阅读不移动光标也会记 scrollTop。
- `pagehide`/`visibilitychange` + hydration `pendingScrollRef`，启动恢复行与视口。
- 客户端改动，刷新页面生效。
### 1.5.14 位置同时保存滚动高度
- 1.5.13 只保存了光标行；如果用户是滚轮浏览、光标没动，重启仍像“从头开始”。
- caret/lastPos 现在同时保存 `scrollTop`；启动 hydration 设置 `pendingScrollRef`，
  `revealLine` 后恢复 `setScrollTop`，回到离开时的视口。
- `pagehide`/`visibilitychange` flush 会读当前 `getScrollTop()`；tab hydration 先清空旧
  pendingScroll，避免跨文件误用。
- 客户端改动，刷新页面生效。
### 1.5.13 重启恢复打开文件的行号
- 之前启动 hydration 只读 `caretMapRef`，它由另一个 root effect 异步填充；和 tabs
  恢复存在先后竞态，读不到就回到第 1 行。
- 现在 hydration 直接 `readCarets(root)`，并增加 `readLastPos()` 兜底（同 root/同一
  rel）；两者都没有才从第 1 行开始。
- 光标保存增加 `pagehide` / `visibilitychange` flush：关闭时 300ms 防抖没落盘也能保存。
- 客户端改动，刷新页面生效。
### 1.5.12 DSH 标题栏“应用/编辑”跟随侧边栏按钮
- `syncDshMenu` 之前用固定 `dshLeft + 48` 定位，和 DSH 的侧边栏/新建按钮
  （CSS 也放在 dshLeft+48）重叠；侧边栏展开后加号移动也不会重新算。
- 现在以 `button[class*="newSession"]` / `[data-sidebar-toggle]` 的实际右边缘 +6px
  为菜单 left；宽度按新的 left 重算。
- 菜单 effect 增加 ResizeObserver 观察 #root / 侧边栏 / 菜单，侧边栏展开或收起时
  立即重排，不用等下一次 DOM 变更。
- 客户端改动，刷新页面生效。
### 1.5.11 DSH 独占模式不再挂载插件层
- 只靠 CSS/内联 display 隐藏插件层，在模式切换/HMR/启动时仍可能留下旧层：
  实测强制 D 时仍能看到完整插件 UI 和“打开 SourceLook”胶囊并存。
- 现在 `mode === 'D'` 直接提前返回：只渲染 `<style>` + 胶囊按钮，不创建 `.sl-layer`。
- 这样 DSH 独占启动时不会再出现两个界面重叠；胶囊仍可切回 P。
- 窗口大小/最大化仍无法由插件 Host 设置（DSH 固定 createWindow、无窗口状态文件）；
  需要 DSH 桌面端自己保存。
- 客户端改动，刷新页面生效。
### 1.5.10 DSH 独占模式重叠：root 内联几何完整还原
- `applyShell('C')` 会写 `position/top/left/right/width/max-width/min-width/height/margin/z-index`，
  但旧的 `saveRootStyle/restoreRootStyle` 只保存 width/height/position/z-index/margin-left/top，
  切到 D 后 top/left/right/max-width/min-width/margin 仍是子窗口几何 → 重叠。
- 现在按 `ROOT_STYLE_PROPS` 保存并还原全部 13 个内联属性，C→D 切回真正全窗。
- 窗口最大化/大小的持久化：DSH 桌面端 `createWindow` 固定 1280×820，且没有窗口状态文件；
  插件 Host 拿不到 Electron，无法可靠设置外窗大小/最大化。按插件铁律不改 DSH，这部分
  只能由 DSH 自身支持；插件侧没有可靠的替代实现，不做 Win32 强制改窗。
- 客户端改动，刷新页面生效。
### 1.5.9 记住上次关闭时的三种模式
- `writeMode` 一直在写 localStorage，但 `readMode` 被硬编码成 `'C'`，所以每次启动都回到
  插件 + DSH 子窗口模式。
- 现在 `readMode` 读取 `sourcelook.mode`，只接受 `P` / `D` / `C`；非法值才回退 `C`。
- 关闭时 P/D/C，下次启动就是 P/D/C。
- 客户端改动，刷新页面生效。
### 1.5.8 菜单打开时让开 DSH 四个悬浮按钮
- 四个尺寸按钮是 body 级 `z-index: 2147483000`，会盖住帮助菜单。
- `SlMenu` 打开时给 body 加 `data-sl-menu-open`，关闭时移除；已有 CSS 会隐藏
  `.sl-dsh-size` / `.sl-dsh-hide`，菜单因此不再被挡。
- 客户端改动，刷新页面生效。
### 1.5.7 符号窗顶部工具收紧，中间图标改紫
- 两个符号窗 header gap 2px、tools gap 1px、工具按钮 32→26px、过滤框贴近。
- 左侧“按类型”和右侧“树”模式原来都是 tone-red；改成 tone-violet `#7c6cf0`，
  中间图标不再红色。
- 客户端改动，刷新页面生效。
### 1.5.6 过滤框高度回落、导航按钮加宽
- 左右符号过滤 `.sl-sym-field` / `.sl-glb-field`：28px → 24px，input 22px；
  仍保留单层胶囊。
- 前进/后退按钮：26×26 → 30×26，只加宽不加高；图标仍 13。
- 搜索框起点同步从 `50% + 32px` 调到 `+36px`，保持 4px 间距。
- 客户端改动，刷新页面生效。
### 1.5.5 搜索框丢失边框修复 + 过滤框单层胶囊
- 顶栏 `.sl-top-find` 在 2586 行的规则里是 `border:0; background:transparent`；
  1.5.4 只补了圆角，所以框看不见。现在外层明确画 1px 边框 + 白底 + 999px 圆角。
- 符号/全局过滤的 `.sl-sym-field`/`.sl-glb-field` 原来 input 自带 9px 圆角和白底；
  现在外层画胶囊，input 透明无边框，只显示一层半圆端。
- 客户端改动，刷新页面生效。
### 1.5.4 胶囊圆角真正只留一层
- 顶栏查找：去掉内部 input 的边框/白底/13px 圆角，只保留外层 `.sl-top-find`
  的 999px 边；聚焦改到容器 `:focus-within`，不再出现内外两层圆角。
- 弹窗搜索 `.sl-modal-search` 也只画外层一层胶囊。
- 符号/全局过滤的 input 统一 999px；容器已有胶囊，视觉上就是半圆端。
- 客户端改动，刷新页面生效。
### 1.5.3 所有输入/过滤框胶囊形 + 顶栏提示“查找索引”
- 所有 text/search/url/number/password/无 type 的 input，以及 `.sl-filter-input`、
  `.sl-top-find`、`.sl-symbol-field`、`.sl-sym-field`、`.sl-global-field`、
  `.sl-glb-field`、`.sl-modal-search`、`.sl-rw-query` 等容器统一 `border-radius: 999px`。
- 顶栏查找框无内容时 placeholder 改为“查找索引”，不再写“回车查找”。
- 客户端改动，刷新页面生效。
### 1.5.2 前进后退略放大、搜索框靠近、放大镜可点
- 导航按钮 24→26px，图标 12→13px。
- 搜索框从 `left: 50% + 90px` 移到 `+32px`，紧贴导航按钮右侧。
- 放大镜从装饰 span 改成 button，点击直接执行 `runTopFind()`；回车行为不变。
- 客户端改动，刷新页面生效。
### 1.5.1 前进后退：无文字、缩小、回到离开时行号
- 标题栏两个按钮只保留左右箭头，去掉“前进/后退”文字；24×24，图标 12。
- 历史记录在离开文件时把该文件当前光标行写回上一条历史，返回时恢复到离开时的行，
  而不是文件打开时的行。
- 后退/前进仍通过 `openFileAt(path,line)` 的 pendingReveal 定位。
- 客户端改动，刷新页面生效。
### 1.5.0 多语言索引与通用解析
- 语言表新增：Python、JavaScript/TypeScript、Java；C++ 改用真正的 cpp grammar 并补 class/namespace。
- grammar 新增：python / javascript / java / cpp（vendor/tree-sitter），已实测 ABI 可加载。
- **按项目语言懒加载**：构建前只加载项目实际出现的 grammar；worker 通过 init 的
  `grammars` 只装对应 wasm，Linux C 项目不再加载 Python/JS/Java。
- **一次索引多语言**：同一索引按文件记录 lang；混合项目只建一次。
- 定义解析分发：C 继续专用解析；C++/Go/Rust/Python/JS/Java 走通用解析
  （索引里的局部/父级/文件级符号），C 行为不变。
- 自动补参数：Python/JS/Java 的 identifier/typed_parameter/formal_parameter 进入索引。
- 客户端按扩展名做语言词法：Python `#` 注释、各语言关键字不再报“C 关键字”。
- 已验证：混合项目 C/Py/JS/Java/Go/Rust/C++ 一次建索引 27 符号；
  Python/JS/Java/C++ 函数/类/字段/参数能定位；C 的 daddr/net/tw_daddr 等未回归。
- 仍未做：各语言深度成员类型推断、跨语言 FFI、非 C 的精确引用（先保持索引/文本兜底）。
### 1.4.28 上下文只读 + 双击代码打开主区 + 局部声明不再白名单类型
- 上下文三窗只读：代码区 `contentEditable=false` / `aria-readonly`，左定义和右引用本就是文本。
- 双击上下文代码区：按鼠标位置算出行号，`onOpen({file,line})` 切到主编辑器对应文件/行。
- `daddr@228` 被列成全文件变量：`localDeclarationInFile` 的类型白名单没有 `__be32`，
  于是跳过 `__be32 daddr, nexthop;`，退回全文件同名符号。
- 改成通用声明判定：不枚举 C 类型；排除 `=`、`return/if/...`、`(`、`.`、`->`
  等表达式前缀；`__be32`、自定义 typedef、`struct foo *` 都识别。
- 实测：`daddr@228` → 1 条 `variable tcp_ipv4.c:215 parent=tcp_v4_connect`；
  `net@104` 参数仍 1 条；`tw_daddr` / `data` / `cwr` 未回归。
- Host 改动，需要重启 DSH；客户端双击/只读刷新页面。
### 1.4.27 最大化改双向水平箭头
- 之前的单向右箭头仍会让人以为只向右扩；改成水平双向箭头 `↔`，
  不画竖边、不倾斜，明确是横向调整宽度（实际 DSH 在右侧，向左扩）。
- 客户端改动，刷新页面生效。
### 1.4.26 尺寸按钮：只画分隔线，最大化箭头水平
- 1/2 / 1/3 的图形不再填充，只画 18×12 圆角矩形 + 一条竖线：
  - 1/2：竖线在 50%；
  - 1/3：竖线在 66.666%（从右边算三分之一，靠右）。
- 最大化图标改成水平：左侧竖条 + 向右箭头，不再用斜向的四个角箭头。
- 四个按钮统一 8px 圆角、图标 92% 不透明度、hover 变实；毛玻璃保留。
- 客户端改动，刷新页面生效。
### 1.4.25 1/2、1/3 改成“屏幕填充比例”图形
- 纯文字 1/2 / 1/3 不好看；改成 17×11 的圆角小屏幕，左侧按比例填充：
  - 1/2 → 填充 50%
  - 1/3 → 填充 33.333%
- 外框用 currentColor，填充块同色，hover/深色主题自动跟着变色；比旧分栏图标直观，
  也比文字更像“窗口宽度”而不是分数。
- 客户端改动，刷新页面生效。
### 1.4.24 DSH 尺寸按钮：半透明毛玻璃 + 1/2、1/3 文字
- 四个按钮统一 `rgba` 半透明背景 + `backdrop-filter: blur(14px) saturate(1.5)`；
  深色主题单独用深色半透明，hover/active 提高不透明度。
- 1/2、1/3 两个按钮不再用分栏图标，直接显示文字 `1/2`、`1/3`；全屏仍用图标，
  隐藏仍用右箭头。理由：分栏小图标在 30×24 里难以分辨，文字一眼就知道宽度。
- 毛玻璃只作用于 4 个 30×24 的小按钮，开销可忽略。
- 客户端改动，刷新页面生效。
### 1.4.23 撤掉自定义鼠标指针，回到系统默认
- 自定义 SVG 指针效果不好；整段 CSS 删除，编辑器回到系统 I-beam。
- 符号窗/全局窗的行改为 `cursor: default`（普通箭头），不再出现手型指针。
- 文本插入符仍是 1.5px 细线 + 亮度安全颜色；鼠标指针交还系统，性能也回到原生。
- 客户端改动，刷新页面生效。
### 1.4.22 鼠标指针：顶部三窗改成小号高对比
- 用户说的“光标太大”是**鼠标指针**，不是 Monaco 文本插入符。
- 顶部三窗改用内联 SVG 指针：
  - 编辑器：11×17 细 I-beam，白色 3.4px 描边 + 黑色 1.2px 芯；
  - 符号/全局窗：12×17 小箭头，同样白描边黑芯。
- 指针不依赖主题 token，深底/浅底都能看见；按钮的 pointer 子样式仍然优先。
- Monaco 文本插入符仍是 1.5px 细线（1.4.21）。
- 客户端改动，刷新页面生效。
### 1.4.21 光标变细 + 主题安全颜色
- `cursorWidth: 1.5`、`cursorStyle: 'line'`：默认 2px 在 200% DPI 下太粗。
- `editorCursor.foreground` 不再写死：按实际 `editor.background` 的亮度选色：
  - 深底（luminance < .45）→ `#e8eef8` 近白
  - 浅底 → `#0b57d0` 深蓝
  这样即使某个主题 token 缺失或明暗判断错误，也不会和背景/行高亮同色。
- 仍保持 `cursorBlinking: solid`，不新增光标动画开销。
- 客户端改动，刷新页面生效。
### 1.4.20 双击浮动条按钮失效 + 调用结果默认展开
- 浮动条按钮全部点不动：外层 `pointerdown` 捕获判断的是 `.sl-float-actions`，
  但实际组件类名是 `.sl-float-bar`，所以按下按钮时先把 floatBar 置空、组件卸载，
  click 永远不会触发。改为同时匹配 `.sl-float-bar`。
- 调用结果框：`openCallers` 默认空，第一项不展开；现在 tree 变化时默认展开索引 0，
  与下方自动预览的第一处调用一致。
- 结果行更紧凑：`.sl-rw-row` / `.sl-rw-caller` padding 4→2，`.sl-rw-site` 2→1，
  root 6→4。定义/查找/调用结果框共用。
- 客户端改动，刷新页面生效。
### 1.4.19 前进/后退：所有文件切入口都记历史
- 现象：切换文件后“后退”仍不可用。
- 根因：历史只在 `openFileAt` 里记录，而标签切换、文件树、快速打开走的是
  `openFile`/`setActivePath`，不经过 `openFileAt`，所以 history 只有一条。
- 修复：新增 `useEffect([activePath])`，当前文件一变就记历史（行号取该文件记住的
  光标位置）；`openFileAt` 同步更新 caret 后再跳，避免重复条目。
- 效果：标签、文件树、快速打开、定义跳转都可后退；后退恢复到原文件及行号。
### 1.4.18 定义/调用必须用点击位置，不用光标位置
- 现象：右键“定义/调用”有时解析成局部变量（光标还停在上一个位置）。
- 根因：`runSymbolResult` 取定义时用 `cursorRef.current`，但右键菜单不会移动光标；
  点击位置只存在 `editorMenu.line/column`，没有传给 Host。
- 修复：`gotoDefinition` / `findReferences` / `runSymbolResult` 接受位置参数；
  右键菜单和浮动条都传 `{line,column}`；单键点击本来就走 `showContext(word, position)`。
- 这是“先确定点击的符号和位置，再解析类型/定义”的统一入口；F12 仍用光标位置。
- 客户端改动，刷新页面生效；Host 的 1.4.17 成员链修复需重启 DSH。
### 1.4.17 `sock_net(sk)->ipv4.tcp_death_row` 成员链解析
- 现象：点 `tcp_death_row`，定义区报“`net` 里没有成员 `tcp_death_row`”。
- 根因：`baseTypeOfExpr` 遇到 `sock_net(sk)->ipv4` 时，只取了 `sock_net()` 的返回类型
  `net`，把后面的 `->ipv4` 整个忽略了，于是拿 `net` 去查 `tcp_death_row`。
- 修复：函数调用解析出返回类型后，继续解析调用表达式后面的 `->a.b` 成员路径
  （新增 `memberPathBase`）；这是通用规则，适用于所有 `foo(x)->a.b`。
- 同时去掉合成成员和索引成员在同一行重复的条目（`tcp_death_row` 原来显示两条）。
- 实测：`tcp_death_row` → `include/net/netns/ipv4.h:178 parent=netns_ipv4` 一条。
- Host 改动，需要重启 DSH。
### 1.4.16 上下文定义区只留定义
- 删除定义区顶部四个按钮：查找引用 / 跳到定义 / AI·它做什么 / AI·风险点。
- 定义区只渲染 `defGroups`；没有定义时显示“没有”；注释/字符串/关键字继续用
  `results.note` 显示（注释 / 字符串 / C 关键字）。
- 同时删掉上下文里的 AI 状态、提问函数和按钮代码；AI 功能整体暂停，等 DSH 接入。
- 客户端改动，刷新页面生效。
### 1.4.15 上下文代码区文件名不显示
- 原来 `.sl-cw-path` 放在可滚动的 `.sl-cw-card` 里，靠 `position: sticky` 贴顶；
  在 flex + overflow:auto + 虚拟滚动下会被滚出/裁掉，文件名看不到。
- 改成三段结构：`.sl-cw-card`（overflow:hidden）→ `.sl-cw-path`（固定头部）→
  `.sl-cw-scroll`（唯一滚动容器）。路径头不再依赖 sticky，始终在代码上方。
- 滚动 ref/onScroll 移到 `.sl-cw-scroll`，虚拟列表逻辑不变。
### 1.4.14 查找/定义结果框预览复查
- 审计：查找的 file/dir/global/idx 四个分支、定义多结果分支都已有
  `loadResultPreview(hits[0])`；只有调用层级之前漏了（1.4.13 已补）。
- 发现两个相关稳定性问题并修：
  1. `openResultWindow` / `fillResultWindow` 不清空旧 preview，新查找无结果时会残留上一次代码。
  2. 预览请求无序号，快速连续点击时旧请求可能后返回并覆盖新代码。
- 现在 open/fill 都清 preview；`loadResultPreview` 用 `previewSeqRef` 只提交最新一次。
- 客户端改动，刷新页面生效。
### 1.4.13 调用层级：单条直接跳，多条自动预览第一个
- 右键“调用”现在和“定义”一致：
  - `refs.length === 1` 且非 keep → 关闭结果框，直接跳到唯一调用点。
  - 多条 → 打开调用层级结果框，并自动 `loadResultPreview(firstSite)`，
    下方代码区立刻显示第一个调用者第一处调用的代码。
- `firstSite` 取调用者按 count 排序后的第一个 `sites[0]`，与结果列表顺序一致。
- 客户端改动，刷新页面生效。
### 1.4.12 `net` 参数被列成 5 个：同一行多次出现
- 现象：`static u32 f(const struct net *net, ...)` 点参数 `net`，定义区列出文件里
  5 个 `net` 参数。
- 根因两层：
  1. `localDeclarationInFile` 每行只看**第一个** `net`；这里第一个是类型名
     `struct net`，被 guard 跳过后没有继续看第二个（参数），于是局部声明查找失败。
  2. 失败后 `fileDefs` 把带 `parent` 的参数符号也当“本文件定义”，一次返回 5 个。
- 修复：
  - 同一行扫描**所有** `\bname\b` 出现；类型位置跳过，参数位置接受，返回 1 条。
  - `fileDefs` / 全局兜底只接受 `parent === ''` 的文件级符号；参数/成员不再冒充。
- 实测：`net@104:49` → 1 条 `parameter tcp_ipv4.c:104 parent=tcp_v4_init_ts_off`；
  点类型位置的 `net` → `struct net_namespace.h:56`。
- Host 改动，需要重启 DSH。
### 1.4.11 稳定性复查
- 生命周期：全仓无 `beforeunload`、无 `window.close`、无 `app.quit` 调用；
  插件只保留 `ctx.effect` 里 `cancelBuild`，不再注册 `process.on` 或窗口钩子。
- 内存：结果窗 `fileTexts` 原来会缓存所有引用文件的全文（几百个文件）；
  改为最多 24 个的 LRU，并且只在展开分组时按需加载；读取失败缓存 null 可重试。
- 结果窗代码只渲染命中附近 800 行；上下文代码虚拟列表；Monaco 关闭文件时 disposeModel。
- 退出诊断代码（quit.log / 强制 process.exit / 句柄日志）已全部删除。
- 索引 worker 仍 `unref`，解析结束 terminate；dispose 不再调用可能阻塞的 shutdown。
### 1.4.10 退出阻断全面清查
- 全仓搜索 `beforeunload` / `onbeforeunload` / `window.close` / `app.quit`：
  除已删除的 beforeunload 外没有第二处阻断窗口关闭的代码。
- 其余 `preventDefault()` 都是拖拽、右键菜单、输入框等局部 UI，不影响宿主关闭。
- PLUGIN-RULES 新增第 6 条：禁止 beforeunload/窗口 close 接管；未保存内容只走草稿，
  不允许因此卡住 DSH 退出。
- 1.4.4–1.4.8 的 quit.log / process.exit 诊断代码已删除，只留生命周期 cancelBuild。
### 1.4.9 真正原因：beforeunload 阻止 DSH 关闭窗口
- 日志证明 Host 子进程已经正常 `process exit code=0`；残留的是 Electron 主/GPU/渲染进程。
- 客户端有一份 `beforeunload` 监听：只要有 dirty tab 就 `preventDefault()`。
  Electron 在 `app.quit()` 关闭窗口时被它拦住，于是主进程和帮助进程一直留着。
- 已删除这个 `beforeunload` 监听。草稿本来就由 `scheduleDraft` 在编辑时自动写入，
  不依赖 beforeunload，所以不会丢未保存内容。
- 同时删除了 1.4.4–1.4.8 的 quit.log / 强制 process.exit 诊断代码，避免影响性能。
### 1.4.8 卡点找到：indexPool.shutdown 卡住 Host
- 复现日志停在：
  `plugin dispose` → `plugin cleanup`（有 pid/handles），没有 `cleanup done`/`force exit`。
- 说明卡在 cleanup 里的 `indexPool.shutdown()`（worker 回流回调里 postMessage/terminate），
  不是 DSH 主进程。
- 现在 dispose 只 cancelBuild，然后 **100ms 后直接 `process.exit(0)`**，
  让操作系统回收 worker 线程；不再调用 blocking 的 shutdown。
- 预计 Host 子进程先退出，DSH 主进程随后结束；若仍残留，日志会显示 `plugin exit`。
### 1.4.7 dispose 后强制子进程退出 + 更细日志
- 现有日志：16:25:32 出现 `plugin dispose`，16:25:50 才 `plugin apply`（重启）。
  说明那次 dispose 发生在新代码加载之前；当前这轮尚未复现。
- cleanup 现在记录：
  - `plugin cleanup pid=… handles=…`
  - `plugin cleanup done handles=…`
  - `process beforeExit` / `process exit code=…`
  - 2 秒后 `plugin force exit` 并 `process.exit(0)`
- 目的：若 DSH 主进程在等 Host 子进程退出，强制退出后进程组应消失；
  若仍残留，则主进程根本没在等子进程，问题在 DSH 主进程。
### 1.4.6 接住 Host 子进程的 disconnect/SIGTERM
- quit.log 证据：只有 `plugin apply`，没有 `plugin dispose`。说明 DSH 退出时
  **没有走到插件的 dispose**；Host 是独立子进程，卡在子进程关闭阶段。
- 插件现在除 `ctx.effect` dispose 外，还监听 `process` 的：
  - `disconnect`（Electron 主进程关闭 IPC）
  - `SIGTERM` / `SIGINT`
  收到就 `cancelBuild` + `indexPool.shutdown()` + `process.exit(0)`，并写日志。
- 这是插件自己的进程清理，不接管 DSH 窗口/托盘；若这样仍残留，就是 DSH 主进程
  没有断开 IPC 或后端 close 卡在插件之外。
### 1.4.5 关键发现：插件 Host 没有 Electron
- 实测 `/project/pick-support` 返回 `{"ok":true,"dialog":false}`：
  Host 里 `require('electron')` 不可用。
- 因此 1.4.1–1.4.4 里的 `app.on('before-quit')` / `will-quit` / `BrowserWindow`
  全部是**死代码**，从未执行；这也是 quit.log 没有生成的原因。
- 已删除这些 Electron 依赖；只保留插件生命周期的 `ctx.effect` dispose：
  `cancelBuild` + `indexPool.shutdown`，并写 `data/quit.log`（plugin apply/dispose）。
- 结论：DSH 托盘退出的确认/后端 dispose 在宿主侧，插件 Host **无法接管**；
  不改 DSH 的前提下，插件只能保证 dispose 时收干净 worker。
- 下一次重启后看 quit.log 是否有 `plugin dispose`：
  - 有且进程仍残留 → DSH 后端 close 卡住，非插件；
  - 没有 → DSH 没调用插件 dispose，仍然是宿主退出流程。
### 1.4.4 退出路径日志（定位无确认框的残留）
- 复现：X 隐藏 → 托盘退出，无确认框，剩 4 个进程。
- 说明 `finishQuit` 很可能卡在 `backend.close()` / `platformView.dispose()`，也可能
  before-quit 没走到；不再靠猜。
- 插件在 `before-quit` / `will-quit` / `window-all-closed` 写 `data/quit.log`：
  - 事件时间与窗口状态（visible/hidden）
  - before-quit 后 4 秒的残留 active handles
- 复现一次后看 `data/quit.log`：只有 before-quit 没有 will-quit = 卡在 DSH 后端关闭；
  连 before-quit 都没有 = 托盘菜单没有触发 app.quit。
### 1.4.3 托盘退出前把隐藏窗口显示出来
- 复现路径：先点 X 隐藏到托盘 → 托盘右键退出。DSH 的 `quitConfirmation`
  用 `dialog.showMessageBox` 且没有父窗口，主窗口隐藏时确认框会停在后台，
  进程不退出。
- 插件在 `before-quit`（prepend）里只做一件事：如果主窗口隐藏，`show()+focus()`，
  让 DSH 的退出确认框可见；不调用 preventDefault，不改 DSH 文件。
- `will-quit` 里仍然 cancelBuild + terminate worker。
- 如果这样仍残留 4 个进程，说明 DSH 在确认框之后的 dispose 流程有问题，
  需要记录确认框是否出现。
### 1.4.2 改到 will-quit 收 worker
- 1.4.1 完全去掉清理后仍复现托盘退出残留，说明索引 worker 线程可能拖住主进程。
- 现在只在 `will-quit`（DSH 退出确认之后、真正退出阶段）调用 `cancelBuild` +
  `index-pool.shutdown()`；不在 `before-quit` 里和确认框竞争。
- 仍不修改 DSH：只监听 Electron 的公开生命周期事件。
- 若 will-quit 后仍残留 4 个进程，则是 DSH 的退出确认/后端 dispose 未完成，
  需要记录确认框是否出现。
### 1.4.1 去掉 before-quit 里的插件清理（排查托盘退出残留）
- 现场：托盘“退出”后 `DeepSeek Harness` 主/渲染两个进程仍在（15:58 启动，无窗口），
  再启动被单实例挡住。
- 插件里唯一参与退出的代码是 `electron.app.on('before-quit')` 里取消索引 + 终止 worker；
  已整段删除，避免与 DSH 的退出确认/后端 dispose 竞争。
- 索引 worker 本身已 `unref()`，且 parseAll 结束时 terminate，不依赖 before-quit 清理。
- 仍需用户在下一次启动后实测托盘退出；若仍残留，则问题在 DSH 的退出流程
  （native 确认框/后端 dispose），按插件铁律不直接改 DSH，只记录复现条件。
### 1.4.0 字段式宏：`tw_daddr` 这类成员宏可解析
- 现象：`tw->tw_daddr` 报“`inet_timewait_sock` 里没有成员 tw_daddr”。
- 实际：`#define tw_daddr __tw_common.skc_daddr`，是字段式宏，成员不在结构体直属。
- 统一处理：成员按 owner 查不到时，查同名宏；宏体是 `a.b.c` 路径时，从接收者
  类型出发逐段解析成员，返回 **宏定义 + 真实成员** 两条。
- 实测：`tw_daddr` → `include/net/inet_timewait_sock.h:51`（宏）+
  `sock_common` 里的 `skc_daddr` 成员。
- 这是通用规则，不针对 tw_*；所有 `#define field __common.member` 都走同一条。
### 1.3.11 查找每次默认索引
- `runFind` 不再回退到 `resultQueryRef.current.scope`：没有显式 scope 时一律 `idx`。
- 顶栏查找、结果框里改查询词都重新走索引；范围按钮点击才切换文本匹配。
- 关闭结果框后再查，也不会记住上一次点过“本目录/本文件”。
### 1.3.10 DSH 状态图标改成 Windows 四格
- 方框改为 2×2 四个圆角小方块（Windows 标志形状），去掉所有圆环/中心点。
- 空闲：静态四格；忙碌：四格按 0 / .18 / .36 / .54s 延迟依次明暗闪烁。
- 动画只改 4 个 16×16 小矩形的 `opacity`，不旋转、不改布局，开销可忽略。
### 1.3.9 DSH 状态图标改成方形
- 去掉圆圈中心点；外层改为圆角方框（11.2×11.2，rx 2.9）。
- 忙碌动画从“旋转整个 SVG”改为方框描边的 dashoffset 流动（26/74，1.4s），
  只重绘 16×16 的描边，不做整块 transform，开销更低。
- 图标尺寸保持 14–17px，不影响布局。
### 1.3.8 查找结果增加“索引”范围按钮
- 结果窗范围按钮改为四个：**索引（默认高亮）** / 本文件 / 本目录 / 本项目。
- 默认索引查找，所以“索引”按钮带 active；点后三个才切到文本匹配。
- 索引分支已修 `kind is not defined`，固定 `limit=1000`。
### 1.3.7 滚动/光标性能收尾
- Monaco：滚动条 12→10、`lineDecorationsWidth` 4、`stopRenderingLineAfter` 5000、
  `maxTokenizationLineLength` 20000；减少每帧行装饰与超长行绘制。
- 光标位置更新改为 rAF 合并：快速移动/翻页时不再每个事件都重渲染整个 React 树。
- 结果窗代码仍只渲染命中附近 800 行；上下文代码区虚拟列表（16px 行高）。
- 说明：主代码区滚动瓶颈主要是 Monaco 在 200% DPI、几千行文件下的可见行渲染，
  插件侧已去掉非 passive wheel 监听、平滑滚动、逐光标装饰；再往下只能牺牲语法
  着色（改为可视区着色）或降 DPI。
### 1.3.6 菜单清理 + 查找范围语义修正
- 右键菜单去掉“我调用谁”；“查找 / 调用 / 定义 / 高亮 / AI / 展开”标签不再带括号解释。
- 查找弹出框默认“本项目（索引）”，此时三个范围按钮都不高亮；
  点“本文件 / 本目录 / 本项目”才切到**文本匹配**（不用索引）。
- 修复索引查找报错 `kind is not defined`：`runFind` 的索引分支不再引用不存在的
  `kind` 变量，固定 `limit=1000`。
- 范围按钮标签：本文件 / 本目录 / 本项目（全文匹配）。
### 1.3.5 主代码区 11.5px，符号窗保持 10px
- 主编辑器默认 10 → **11.5px**（行高 15px）；旧默认 10 自动迁移。
- 左侧符号窗、右侧全局窗仍保持 10px 和紧凑行距。
- 上下文窗字体保持 11px、行高 16px。
### 1.3.4 上方三窗 10px，行距更紧
- 编辑器默认字号 13 → **10px**；旧默认 14.5/13 自动迁移到 10，手调其它字号保留。
  行高随之为 13px（0.31 倍）。
- 左侧符号窗：行高 20px、字号 10px、行号 9px。
- 右侧全局窗：字号 10px、行高 16px、文件/位置 9px。
- 上下文窗字体保持 11px 不动，仅行高 17 → **16px**（虚拟列表常量同步）。
- 状态/标签等其它窗口不再继续缩小，避免影响可读性。
### 1.3.3 查找不再自动高亮主代码区
- `searchCode` 里原来在查找后会调用 `adapter.highlightMatches(...)`，把主代码区
  所有匹配词都标黄；已删除。
- 高亮只保留用户主动动作：右键/悬浮条“高亮”、`Shift+F8` 整词高亮切换。
- 查找仍会弹结果窗；点结果行只预览/跳转，不再顺手改主编辑器高亮。
### 1.3.2 查找范围回到原版三档；include 头文件；紧凑排版
- 去掉顶栏 `Aa` / `.*` / `W` 三个按钮；查找默认 **本项目（索引）**，
  结果窗顶部只在“本文件 / 本目录 / 本项目”三档之间切换（与用户确认的三档一致）。
- `#include <...>` 里的头文件名走单独分支：不再先查符号定义，直接列头文件并
  在中间代码区打开它；点 `include` 指令词仍显示预处理说明。
- 上下文中间代码区顶部新增文件路径条（sticky，`文件:行`）；行高 19 → 17px。
- 其它窗口字号整体再降一档（符号 11.5、全局 10.5、上下文 11、状态 10.5 等）。
- 结果窗代码区仍只渲染命中附近 800 行，完整文件在底部上下文窗看。
### 1.3.1 结果窗代码按命中窗口化
- 1.3.0 的调用树已实测：根 `tcp_measure_rcv_mss` → 调用者
  `tcp_event_data_recv()` 1 处，可展开到调用点。
- 查找 `Aa` / `.*` / `W` 已加到顶栏；Host 单测：
  `tcp_.*mss` 正则 5 条 3ms；`[` 返回 `invalid_regex`；大小写与整词生效。
- 结果窗代码区不再渲染整个文件（原来最多 6000 行 DOM，搜索/跳转容易卡），
  改成命中行附近最多 800 行（窗口 400 行）；完整文件仍由底部上下文窗显示。
- 结果窗头部统计对调用树显示“N 处调用”，不再显示“共 0 处”。
### 1.3.0 调用层级树 + 查找选项
- 调用：结果窗改为两层树——根符号 → 调用者函数（按调用次数排序）→ 展开后的调用点
  （文件:行）。单击调用者展开/收起，双击打开第一处；点调用点预览代码。
  数据来自同一次 `/references`（`fn` 字段），不额外请求。
- 查找选项：顶栏查找框增加 `Aa`（区分大小写）、`.*`（正则）、`W`（整词，默认开）。
  Host `/grep` 支持 `regex` / `case`；正则非法返回 `invalid_regex`，窗口提示“正则表达式无效”。
  本文件 / 本目录 / 全文三个范围都遵守这些选项；索引范围不受影响。
- **Host 改动（grep 选项）需要重启 DSH**；调用树和查找按钮是客户端，刷新页面即生效。
### 1.2.12 撤回宿主窗口接管 + 插件铁律
- 审计：`D:\DeepSeekHarness\resources\app.asar` 仍为 2026-11-04 17:30:40，
  最近两天 DSH 安装目录没有任何文件被修改；SourceLook 只写插件目录和宿主 API。
- 1.2.11 的 `BrowserWindow` close 接管虽然写在插件里，但属于改变宿主行为，
  不符合“官方 DSH 直接安装插件”的要求，已**整段删除**。
- 新增 `PLUGIN-RULES.md`：不改 DSH、不接管宿主窗口/托盘/退出流程；
  必须改 DSH 时先书面说明并取得同意。
- 点 X 的行为恢复为 DSH 默认（隐藏到托盘）。这是 DSH 自身的策略，
  插件不越权修改。
- `before-quit` 里只保留“取消索引任务 / 收 worker”的清理监听，不阻止退出。
### 1.2.11 关闭窗口即退出（不再隐藏到托盘）
- DSH 主窗口默认在 close 时 `preventDefault` 并 `hide()` 到托盘。
- Host 启动时接管主窗口 close：移除 DSH 的隐藏监听，改成 `app.quit()`。
  DSH 自己的退出确认仍会执行；取消退出时窗口保持可见，不会先藏到托盘。
- 只绑定没有 parent 的 BrowserWindow（主窗口），不碰对话框/确认框。
- 需要重启 DSH 加载 Host 改动。
### 1.2.10 cwr 找不到定义：接收者边界 + 位域索引
- `cwr` 的直接原因：`th->cwr` 的接收者被解析成 `!th->ece || !th`
  （`receiverExprAt` 只会在括号处停，不会在 `||`、`!`、空格处停），
  类型自然解析失败。
- 现在接收者表达式在运算符/空白处截断：`!th->cwr` → `th`，
  `a->b->c` 仍保留链，`func(x)->f` 保留调用。
- 另一个系统性缺口：位域 `__u16 res1:4, doff:4, …, cwr:1;` 在 tree-sitter 里
  名字是 `field_identifier` 兄弟节点，`declaratorsOf` 只认 `identifier`，
  所以 `ece`/`cwr` 这类位域成员根本没进索引。现在两者都收，位域全部入索引。
- 旧索引也能定位：成员缺失时按结构体文本兜底（`cwr` 实测 → `include/uapi/linux/tcp.h:40`）。
- 建议有空重建一次索引，让位域成员直接来自索引。
### 1.2.9 代码区独立组件（修滚动卡顿 + 定位）
- 1.2.8 的滚动 state 放在 ResultsPanel 顶层：每滚一像素就重渲染整个上下文窗口，
  左边定义/右边引用/AI 区都跟着重排，所以仍然卡。
- 现在代码区拆成 `ContextCodePane` 子组件：滚动只在它内部 setState，父组件
  （定义列/引用列）完全不参与。
- 行仍然绝对定位、只渲染约 30 行；定位用 `scrollTop=(行号-1)*19-高度/2`，
  在 `useLayoutEffect` 里绘制前完成。
- 用真实文件 `include/linux/tcp.h:271` 自动预览验证：中间代码区稳定停在
  262–279 行，271 行高亮。
### 1.2.8 绝对定位虚拟列表（稳定版）
- 1.2.7 一次构建 7000 行 DOM 后，滚动/点击依旧要由浏览器排版全部行，所以还是卡。
- 现在：外层容器高度 = 总行数 × 19px，行用 `position:absolute; top=(行号-1)*19`
  只渲染可视窗口（约 50 行）；滚动只改变窗口起点，不重建整文件。
- 定位：切定义时 `scrollTop = (行号-1)*19 - 高度/2`，行绝对定位与滚动公式一致，
  不再依赖 offsetTop/padding，也不会有上下占位块导致的跳动/闪烁。
- `onScroll` 用 rAF 节流，仅当起始行变化时 setState。
### 1.2.7 代码区改回“一次构建、DOM 定位”
- 1.2.6 的虚拟滚动在滚动事件/ResizeObserver 之间来回 setState，表现为代码区闪烁，
  且定位不稳定。
- 现在整个文件的代码行**只构建一次**（`useMemo` 依赖文件内容），滚动是原生滚动；
  当前行高亮和定位用 DOM 直接改：
  `pane.scrollTop = (行号-1)*19 - 高度/2`，不再触发整块重渲染。
- 点击定义/引用时，同一文件内容不重建，只移动高亮和滚动位置，所以不会闪、也不会
  把视图拉回顶部。
### 1.2.6 上下文代码区虚拟滚动（修卡顿 + 定位）
- 1.2.5 把整个文件都渲染成 DOM，几千行 × 两个 span，任何一次上下文更新都会重建
  几千个节点 —— 这就是“卡得要命”的来源。
- 现在只渲染可视窗口（上下各 8 行缓冲），用上下两个占位 div 撑出总高度；
  滚动时按 19px 固定行高计算窗口，DOM 始终只有几十行。
- 定位改为直接 `scrollTop = (行号-1)*19 - 高度/2`，不再依赖 `offsetTop`；
  切换定义/引用时中间代码区会稳定滚到对应行。
- `.cw-line` 固定 19px 行高，保证虚拟滚动的位置和实际渲染一致。
### 1.2.5 上下文代码区显示整个文件
- 之前代码区只渲染 `previewLine ± 6/9` 共十几行；现在渲染整个文件（`1..行数`），
  容器可滚动，并在预览切换时自动把当前行滚到中间。
- 行号、当前行高亮、关键字着色都保留；内容仍来自 `/file`，不额外请求。
- 大文件会一次渲染全部行（内核文件通常几千行）；如果以后遇到超大文件卡顿，
  再换虚拟滚动。
### 1.2.4 系统性类型解析（不再逐个符号打补丁）
- **索引完整性**：`fieldDeclaration` 以前只取第一个声明符，`unsigned char *head, *data;`
  里的 `data` 永远不进索引。现在按全部声明符入索引（名字/行号/指针层数各算各的）。
  直接解析 `include/linux/skbuff.h` 已能拿到 `data member@920 parent=sk_buff`。
- **索引缺口兜底**：若索引里某个成员缺失（旧索引），按 owner 结构体定义的文本再找一次；
  跨行 `*data;` 也认。`skb->data` 实测 → `include/linux/skbuff.h:920`（1 条）。
- **权威排序**：成员/定义的来源按 `同文件 > include/linux > include/uapi > include > .h > 其他`
  排序；同一 owner 有内核副本和 tools/selftests 副本时只保留最权威的一档。
- **不再静默猜错**：识别出成员访问但接收者类型解析不出来时，返回 `status:"unresolved"`，
  客户端显示“未解析 + 原因”，不再退回到同名局部变量。
- 解析管道固定为：词法分类 → 角色（类型位/调用点/成员/普通标识）→ 表达式类型
  → 作用域（局部/static/全局）→ 权威排序 → 未解析状态。
- 旧索引仍可用（文本兜底）；重建索引后成员直接来自索引，会更快。
### 1.2.3 词法分类 + 链式成员类型（用户实测的 232 行问题）
- 链式接收者：`baseTypeOfExpr` 支持 `skb`、`icsk->icsk_ack`、`skb_shinfo(skb)`、
  `tcp_sk(sk)->advmss`；匿名 struct 的成员按外层类型归并；宏体的 `(struct X *)`
  强制转换用来取返回类型。实测：
  - `last_seg_size` → `include/net/inet_connection_sock.h:119`（**1 条**，不再是两条）
  - `gso_size` → `include/linux/skbuff.h:518`
  - `advmss` → `include/linux/tcp.h:224`
- 客户端点击先做**词法分类**（对应原版 `ContextAnalyzer`）：
  - 注释、字符串 → 只显示“这是注释/字符串，不是符号”，不发定义/引用请求；
  - `#define/#include/#ifdef…` 指令词 → 预处理指令说明；
  - C 关键字（`unsigned`、`struct`、`static`…）→ 关键字说明，不列变量定义。
- 宏展开与原版 `macroExpansionOf` 一致：只做一层实参代入；原版源码本身也不递归
  展开嵌套宏（`expandMacroOnce` 只替换一次），所以没有额外造多层。
- 仍需重启 DSH 加载 Host 的链式类型解析。
### 1.2.2 原版优先级 + 运行中 Host 验证
- 全局定义顺序补齐原版优先级：非原型优先、`include/` 优先、头文件次之；
  `sock` 仍稳定落在 `include/net/sock.h:345`。
- 在运行中的 Host（56787）实测：
  - `skb->len` 定义 252ms → `include/linux/skbuff.h:761`；
  - `sock` 类型 14ms → `include/net/sock.h:345`；
  - 局部 `len` 11ms → `tcp_input.c:230`；
  - static 函数 9ms → `tcp_input.c:226`（只本文件）；
  - 函数引用按 kind 过滤后 1 条；
  - 成员引用 `kind=member&parent=sk_buff`：287 条，前 50 条全部 `field skb`。
- 仍需重启一次加载“定义排序”微调。
### 1.2.1 成员引用的接收者收窄（narrowMemberRefs）
- 对照原版 `fieldReceiverOf` / `narrowMemberRefs`：成员引用先只留
  `to="field …"`，再按「接收者表达式 + 所在文件」解析类型，只保留
  `接收者类型 == 成员 parent` 的记录；解析不出的不冒充。
- 频率优先（`skb` 这类常见接收者先算），预算 30 组 / 250ms；全被滤掉时退回全部。
- 实测 `skb->len`：引用从 2.3 万条收窄到 **256 条，全部 `field skb`**（约 640ms，
  第一次；之后有客户端历史缓存）。
- 客户端对 member 定义自动带上 `kind=member&parent=类型名`。
- 已在运行中的 Host 上验证：`skb->len` → `include/linux/skbuff.h:761`，
  `sock` → `include/net/sock.h:345`，local `len` → `tcp_input.c:230`。
- **需要再次重启 DSH** 加载这一轮 Host 收窄逻辑。
### 1.2.0 按原版 resolveDefTarget 移植：角色优先
- 对照原版 `resolveDefTarget` 实现了四条角色规则（Host 侧，读点击行文本）：
  1. **成员访问** `x->field` / `x.field`：先解析接收者类型（局部/参数/函数返回类型），
     再按 `parent=类型名` 查成员。实测 `skb->len` → `include/linux/skbuff.h:761`
     `member parent=sk_buff`（115ms）。
  2. **类型位置**（`struct sock *sk` 点 `sock`）：只查类型家族，实测 →
     `include/net/sock.h:345`（65ms）。
  3. **调用点**（`foo(`）：只可能是函数/宏，`static` 则只在本文件；实测 static
     `tcp_measure_rcv_mss` → `tcp_input.c:226`（8ms）。
  4. **局部变量/参数**：当前函数内点击行上方最近的声明；`len@238` → `tcp_input.c:230`
     （8ms）。
- 全局多份定义（宏副本、多处函数定义）在定义区全部列出，类型/函数/宏优先，
  非原型优先，`文件:行` 去重，上限 200。
- 引用按原版 `CW_REF_KINDS` 过滤：函数只看 `call/address`、变量/参数/成员看
  `read/write/address`、类型看 `type`；滤空自动退回全部。
- 局部引用仍走文本、按函数范围（`fn` + 行号）过滤；`skb->len` 这类成员引用
  暂按成员名 + owner 筛选，未做接收者二次收窄。
- 结果窗「定义 / 调用」也使用 scoped 定义和 kind 过滤。
- **需要重启 DSH** 加载新的 Host 查询逻辑。
### 1.1.99 定义/调用/查找的准确性与作用域（对齐原版）
- **定义**（`/definition`）现在按原版规则分层：
  1. 局部变量/参数 → 当前函数内、点击行上方最近的声明（优先用索引里的
     `kind=variable/parameter + parent=当前函数`，实测 `len` 在
     `tcp_input.c:230`，2–56ms）；
  2. `static` 函数/变量 → 只在本文件里找，返回 `scope:"file"`；
  3. 全局函数/宏/类型/全局变量 → 返回**所有**同名定义（按文件:行去重，
     上限 200 条），类型/函数/宏优先于普通符号。`sock` → `include/net/sock.h:345`。
  4. 索引里没有时才退回文本声明扫描。
- 修了 `symbolsWhere` 的文件过滤（谓词之前拿不到 `fileId`，导致按文件查永远为空）。
- **调用**（调用者列表）走 `/references`，每行带调用者函数名；上限提到 1000。
- **查找/引用**：局部变量/参数只扫当前函数（`localText=1&fn=...&line=...`），
  实测 `len` 1ms、19 处；`static` 只扫本文件；全局引用上限 400/1000。
- 上下文缓存的 key 加入行号，同名局部变量在不同函数不再串缓存。
- 结果窗的「定义」动作改用 `/definition` 的 scoped 定义，而不是旧的全库定义列表。
- **需要重启 DSH** 才加载新的 Host 查询逻辑。
### 1.1.98 点击变量慢 / 定义不准（实测修复）
- 实测 `len`：`/definition` 1,983ms（返回 18,888 条）、`/references` 6,513ms；
  根因是局部变量**不在符号索引里**，旧实现只能把全项目同名记录全部读出来。
- 现在：
  1. `/definition` 先做**当前文件文本声明查找**（点击行向上 400 行、遇函数结束 `}`
     停止，要求类型词 + `=;,)`），命中直接返回。实测 `len@238 → 56ms`，
     定义是 `tcp_input.c:230 unsigned int len;`，parent `tcp_measure_rcv_mss`。
  2. `/references` 新增 `localText=1`：局部变量只扫当前文件的文本，实测 **1ms**，
     77 处；不再查 8 万条索引。
  3. 全局引用默认 `limit=400`，定义默认 40 条；响应里带 `truncated/counts`。
  4. 客户端先取定义、再按定义类型取引用；上下文缓存的 key 加入行号，
     避免同名局部变量在不同函数里复用错误缓存。
- 全局兜底按“类型/函数/宏”优先：`sock` 解析到 `include/net/sock.h:345`（struct），\n  而不是 `arch/um` 里某个同名成员。\n- **需要重启 DSH** 才加载新的 Host 查询逻辑。
### 1.1.97 子窗口字号统一
- 编辑器默认 13px 后，其它面板原本仍偏大（符号名 14px、上下文 13px 继承）。
  统一压到与 DSH 接近的一档：
  - 左侧符号：行 12px、名称 12.5、行号 10；
  - 右侧全局：行 11.5、名称 12、文件/位置 10.5；
  - 底部上下文：代码行 11.5、折叠头 11；
  - AI 面板：消息 11、标题 12.5、输入 11.5；
  - 标签 12、状态栏 11、面包屑 11、结果窗行 11.5、标题 12。
- 只改字号，行高/间距不变；编辑器仍是 13px。
### 1.1.96 默认字号与滚动手感定稿
- 默认字号 **14.5 → 13px**（与 DSH 界面文字接近）；lineHeight 随之为 17px。
  旧版本存下的 14.5 视为“没设置过”，自动迁移到 13；手动调过的其它字号保留。
  Ctrl+= / Ctrl+- / Ctrl+0 仍可改。
- 不做开关：性能相关选项直接取“流畅优先”：
  `renderWhitespace:none`、`occurrencesHighlight:off`、`selectionHighlight:false`、
  `matchBrackets:never`、`bracketPairColorization:off`、`renderValidationDecorations:off`、
  `cursorBlinking:solid`、`stickyScroll:off`、`overviewRulerLanes:0`、
  `scrollbar.useShadows:false`、`smoothScrolling:false`、缩进参考线关闭。
- 滚轮 `mouseWheelScrollSensitivity: 3.2`、`fastScrollSensitivity: 9`，每格覆盖更多行。
- 字号变小本身也减少了每帧字形渲染量，滚动会更顺一些。
### 1.1.95 滚动实测与手感
- 实测（7036 行文件）：总装饰 10,575 条；全部移除后滚动帧率仍是 20fps → **不是装饰的锅**。
- 隐藏 DSH 子窗口后 26→28fps → 也不是 DSH 覆盖层。
- 当前瓶颈是 Monaco 在该窗口 200% DPI + 大文件下的渲染本身；插件侧已去掉
  非 passive wheel 监听、收窄 MutationObserver、关闭 smoothScrolling。
- 本轮把 `mouseWheelScrollSensitivity` 调到 2.2、`fastScrollSensitivity` 6，
  让滚轮每一格覆盖更多行，手感更跟手（原始为默认 1）。
- 客户端改动不需要重启 DSH；若页面还是旧手感，刷新一次页面。
### 1.1.94 代码区滚动卡顿
- 原因 1：编辑器 host 上挂了**非 passive 的 wheel 监听**（Ctrl+滚轮调字号）。即使是普通
  滚动，浏览器也要先等 JS 处理完才滚 → 每一格都慢半拍。改成 Monaco 自己的
  `editor.onMouseWheel`，普通滚动完全不经过 DOM 监听。
- 原因 2：DSH 子窗口菜单同步用了 `MutationObserver(document.body, {subtree:true})`。
  Monaco 滚动时不断重绘行节点，会触发这个 observer 去重排 DSH 菜单 → 主线程抖动。
  现在只观察 body / #root 的**直接子节点**，并用 rAF 合并。
- 菜单打开状态 observer 也从整个 body 收窄到 `.sl-menubar`。
- `smoothScrolling` 关闭（原来是 true，滚轮有动画延迟）。
- 结果：滚轮响应走 Monaco 原生路径，滚动期间不再触发 DSH 菜单重排。
### 1.1.93 建立索引进度面板 / 退出清理
- 进度面板改成**原版样式**：浮动卡片、无遮罩、不挡阅读、标题栏可拖动，居中偏上。
- 阶段显示对齐原版：
  - 扫描：标题「扫描目录」、不显示 0%、进度条来回扫、`已发现 N 个文件`、
    当前目录一行；
  - 解析：百分比 + 进度条 + `done / total 个文件` + 目录/文件数行 + ETA；
  - 写入：来回扫、取消禁用；
  - 完成：100%，4 秒后自动关闭；
  - 取消：显示「已取消」，2.6 秒后自动关闭；
  - 失败：显示错误，6.5 秒后关闭。
- 取消：点击后立即显示「正在取消…」并禁用，Host 的 `cancelBuild()` 会中断
  扫描/解析；实测 `cancel → {"canceled":true}`、状态 2 秒内变为 `canceled`。
- 修掉「取消后显示索引完成 100%」：取消/失败阶段优先于旧的 built 状态。
- **退出清理**：索引 worker 线程 `unref()`（不再拖住进程）；Host 在
  `app.on('before-quit')` 里 `cancelBuild()` + `indexPool.shutdown()` 终止全部
  worker。需要重启 DSH 才会加载这段 Host 代码。
### 1.1.92 项目菜单严格照抄原版
- 菜单只保留原版三项：`本地目录…`、`远程目录…`（Ctrl+Shift+O）、分隔线 + `最近项目`。
  删掉了自创的「打开本机项目…」「浏览本地目录…」「输入项目路径…」。
- `本地目录…` = 原版 `projMenuLocal`：调用系统目录选择器（Host `/project/pick`）；
  宿主没有 dialog 时才在内部回退到目录浏览器（不再是菜单项）。
- `远程目录…` = 原版第二项，当前提示「远程目录暂未移植（只支持本地项目）」。
- 文件菜单同步为 `本地目录…`。
- 仍需重启 DSH 一次以启用 `/project/pick`、`/project/dirs`。
### 1.1.91 项目目录：真正可选本地文件夹（去掉上传框）
- 删掉 `<input webkitdirectory>` 兜底（它只会触发浏览器的“上传文件夹”，
  拿不到绝对路径，用户看到的就是上传流程）。
- 新增两条可选路径：
  1. `打开本机项目…` → Host `/project/pick`：Electron 原生目录选择器；
  2. `浏览本地目录…` → Host `/project/dirs` + 内置目录浏览器：磁盘列表、
     上一级 / 主目录 / 刷新、子目录列表、路径框（可直接粘贴绝对路径）。
- 项目菜单现在为：打开本机项目… / 浏览本地目录… / 输入项目路径… / 最近项目。
- 内置浏览器完全走 Node fs，不依赖 Electron dialog；即使原生框不可用也能选。
- 兜底：如果宿主还没有新路由（404），对话框会明确提示
  「目录浏览需要重启一次 DSH 才生效；也可以直接输入绝对路径。」
### 1.1.90 项目菜单（对齐原版 projMenu）
- 点「项目目录」不再弹自定义对话框，而是**下拉菜单**（对齐原版）：
  - `打开本机项目…`
  - `输入项目路径…`
  - 分隔线 + `最近项目`：名称 + 完整路径 + `×` 移除；最多 30 条，显示 8 条 +
    「显示其余 N 项 / 收起」
- 当前项目自动置顶到最近项目（切换工程后也会写入）。
- `打开本机项目…` 的路径：
  1. Host 新增 `/project/pick-support`、`/project/pick`，用 Electron
     `dialog.showOpenDialog({ properties: ['openDirectory'] })` 弹**系统目录选择器**；
  2. 宿主没有 dialog（旧宿主/浏览器）→ 退回 `<input webkitdirectory>` 目录选择框，
     从 `File.path` 取绝对路径；
  3. 两条都不可用 → 提示改用「输入项目路径…」。
- 文件菜单同步改为 `打开本机项目…` / `输入项目路径…`。
- **`/project/pick*` 是 Host 新路由，需要重启一次 DSH**；重启前点击会走 input 兜底。
### 1.1.89 项目图标：立方体
- 「项目目录」按钮的图标从“窗口/布局”改成**立体立方体（项目包）**：
  六边形外框 + 顶面折线 + 竖棱，14px 下仍清晰。
- 语义是“项目/工程”，不再像普通文件夹或布局图标；路径文字不变。
### 1.1.88 反隐藏按钮：浅蓝、苗条、居中
- 形状从 22×28 的方块改成 **14×68 的竖向小条**（圆角 7），尽量不挡正文。
- 颜色：浅蓝半透明底（`#7dc3ff` 24% 混白）+ 蓝边 + 蓝色箭头，hover 加深到 40%。
- 位置：不再贴顶部，改为**垂直居中**（`top:50%`），避免压住面包屑/文件路径。
- 交互不变：左右各 10px 贴边热区，鼠标移到最左/最右才滑出；带 8px 滑入动画，
  `focus-visible` 也能显示；右侧在 DSH 打开时位置仍按窗口右缘（P 模式下最实用）。
### 1.1.87 菜单不再被 DSH 悬浮按钮遮挡
- DSH 四个尺寸/隐藏按钮是 body 级、`z-index:2147483000`，会盖住顶栏“帮助”等
  下拉菜单。
- 现在 MutationObserver 监听 `.sl-menu.open`：任一顶栏菜单展开时给 body 加
  `data-sl-menu-open`，四个按钮 `display:none`；菜单关闭自动恢复。
- 实测：点“帮助”后 `open=1`、`fullDisplay=none`，菜单完整显示（1415,40 212×72），
  不再被按钮挡住。
### 1.1.86 尺寸按钮真正修复：no-drag
- 真正根因：DSH 的 `body` 是窗口拖动区（`-webkit-app-region: drag`）。
  body 级浮层必须显式声明 `no-drag`，否则鼠标事件被当成“拖动窗口”，
  hover 和 click 都不会到按钮上。
- 隐藏键一直带 `-webkit-app-region: no-drag`，所以它正常；三个尺寸键
  （1/3、1/2、全宽）漏了这条 → 鼠标移上去无反应、点了也不生效。
- 现在 `.sl-dsh-size` 与 `.sl-dsh-hide` 都设置 `-webkit-app-region: no-drag`
  和 `pointer-events: auto`；全宽按钮仍是「点一下铺满、再点还原」。
### 1.1.85 全宽按钮修复
- 根因：`#root` 被 DSH 自身样式限制 `max-width`，只改 width 不生效。
  1.1.84 起已加 `max-width:none !important`；本轮再把「全宽」做成**开关**：
  - 未全宽 → 记录当前宽度，铺到 `viewport - 12`；
  - 已全宽（≥ viewport-60）→ 点一下还原到上次宽度（没有记录则退到一半）。
- 实测：程序化点击后 `#root` 从 `x=1067,w=533` 变为 `x=12,w=1588`；再点回到原宽度。
- 标题提示改为「占满整窗（再点还原）」。
### 1.1.84 滚动固定 / 四个尺寸按钮 / 路径 32 字 / 边缘悬停恢复
- **滚动位移修复**：`#root`（DSH 子窗口）从 `position:relative` 改为 `position:fixed`
  + `top/left/right/height` 全部 `!important`。实测 `window.scrollTo(0,200)` 后
  `#root` 的 top 仍是 40，不再被文档滚动拖走。
- DSH 四个尺寸按钮统一为同一个 `.sl-dsh-size` 外观（隐藏键也加了该类），
  相同 22×24、圆角、hover 蓝色底；`#root` 同时清掉 `max-width`，
  「全宽」不再被宿主样式限制。
- 项目路径**固定最多 32 字符**：超过就从前面按目录段折叠（不再随窗口宽度伸展）；
  点击路径按钮弹出的是**项目根目录**（复制路径 / 切换项目目录… / 打开文件…），
  不再是当前文件路径。
- 索引窗恢复改为**边缘悬停**：左右各 10px 的透明热区，鼠标移到最左/最右边
  才在 `top:40px`、贴边 2px 处滑出 22×28 的反隐藏按钮；平时完全不占位、不可见。
  当前持久化状态若为收起，两侧就是完全隐藏的，需要时把鼠标贴边即可。
### 1.1.83 三分之一按钮 / 全隐藏 / 底边线 / 状态环 / 路径与图标
- DSH 子窗口尺寸新增「三分之一」按钮（三栏图标，`right:112px`），
  与一半/占满/隐藏并排。
- 左右索引窗收起后**不再保留竖条**（组件返回 null）；只在原隐藏按钮位置
  悬浮一个 22×22 的展开按钮（`.sl-pane-restore`），编辑器补满整宽。
- 主编辑区与左右窗格的**底边线**：`.sl-body::after` 画 1px 线，覆盖在内容之上。
- DSH 状态环：改为跟随按钮文字颜色（浅色主题蓝色），并加中心实心点 + 描边阴影，
  浅色主题下清晰可见；标题带按钮去掉默认黑色焦点框，focus-visible 用蓝色。
- 项目路径：用隐藏 span 实测文字宽度，**空间够就显示完整路径**；不够才按目录段
  从前面折叠，并设置 maxWidth 防止压到「后退」。
- 「项目目录」图标从文件夹换成**工作区/窗口图标**（顶栏 + 左栏线），不再用普通文件夹。
### 1.1.82 AI 编辑带收起规则 / DSH 底色
- **空内容点外面自动收起**：document 捕获阶段 pointerdown，点在编辑带之外且输入框为空
  → 关闭 AI 编辑带（实测 open=1 → emptyClick=0）。
- **有内容则保留**：输入框非空时点外面不关；再双击别处也不会新开，只提示
  「先把当前的 AI 编辑框处理完（Esc 取消）」（实测 filledClick=1）。
- 路径浮层、浮动操作条也补了点外面收起；对话框/菜单沿用原有 Esc/遮罩行为。
- DSH 按钮改为**嫩蓝半透明底**：`rgba(125,195,255,.14)`，hover 加深到 `.24`，
  无边框/阴影，仍与帮助按钮同高同圆角。
### 1.1.81 查找 / DSH / 滚动 / AI 行内编辑
1. 顶栏删掉“查找”按钮，输入框左侧内嵌放大镜；回车查找。
   “查找结果”改成图标按钮：有结果显示科技蓝底，没有结果保持灰色；title 带“（N 处）”。
2. DSH 与帮助整体左移（右内边距 116→146），避开原生命令按钮；DSH 改成与菜单
   按钮同一套结构：透明底、蓝字、26px 高、hover 时蓝色加深（不再是特殊的大胶囊）。
3. **滚轮位移修复**：所有列表/结果滚动容器加 `overscroll-behavior: contain`，
   `.sl-layer / .sl-body / .sl-content` 强制 `overflow: hidden`。滚到底不再带动
   整个界面上下挪，不会再遮住 DSH 子窗口标题栏。
4. 前进/后退宽度 82→74（高度仍 30，比其它按钮略突出）。
5. AI 行内编辑改成**单行**：`第 N 行 · AI [输入框] 生成 取消`，回车生成、Esc 取消；
   生成后才展开答案与“插入/重新生成”。View zone 宽度按可见区域夹取，DSH 模式下
   不会被右侧子窗口盖住（按钮实测落在 800px 边界内）。
6. 标题栏路径改成**项目根目录**（保留尾部 `…\default-workspace`），不再显示当前
   文件路径；文件路径仍在面包屑和路径浮层里，只有切换工程时标题栏才变。
### 1.1.80 标题栏与输入框调整（按用户 7 条）
1. **所有文本输入框胶囊形**：过滤、顶栏查找、结果窗查询、路径、AI 输入等统一
   `border-radius: 999px`（textarea 与颜色选择器除外）。
2. **标题栏左侧紧凑**：品牌只留 `SourceLook` 文字；文件/编辑/视图间距 4px；
   `刷新索引`、`项目目录` 去掉文字只留图标——未建索引用 `＋`，已建用 `↻`，
   建造中显示 `×`（取消）；按钮宽 30、与菜单同高 26。
3. **路径折叠保留尾部**：超过 26 字符显示 `…` + 末尾，title 仍是完整路径；
   不再出现“结尾省略号把目录名吃掉”。
4. **右侧紧凑**：DSH 与帮助同高 26px、间距 4px；标题栏右内边距 116px，
   “帮助”右缘距原生最小化约 11px；只有前进/后退保持 30px 高、82px 宽。
   DSH 仍是科技蓝，但宽高与其它按钮一致（68×26）。
5. **索引框完全收起**：左右窗格收起后不再保留 22px 头，而是 16px 竖栏
   （箭头 + 竖排“符号/全局”），点竖栏恢复；补上缺失的 `fold-left` 图标。
6. 左上角大括号图标已删除。
7. **DSH 子窗口尺寸**：隐藏箭头左边新增「一半」「占满」两个按钮
   （split / expand 图标），分别把 DSH 宽度设为 50% 与整窗宽（留 24px）。
### 定义行标记 / 提示词库 / 版本信息
- 底部定义折叠头与行：`（声明）`（prototype）、`未编入` 红标（live=false）、
  每行的条件编译 chip；行 title 也带声明/条件/未编入。
- AI 面板新增**提示词库**（10 条：这处调用/用途与坑/内存布局/这一行/预处理/
  运算符/补注释/优化注释/翻译注释/浓缩一句话），选中即把题目+光标附近代码
  填进提示词框。
- `Ctrl+I` = 对选中文本或光标处词打开 AI 解释（原版快捷键）。
- 编辑菜单补 剪切 / 粘贴 / 全选。
- 关于对话框显示宿主 `Electron/Chromium/Node` 版本与构建标签；Host `/info`
  增加 `versions`（需重启）。
### 工程切换（原版 proj.*）
- Host 新增 `/project/open`、`/project/reset`：切换只改 SourceLook 自己的根
  （`fs-service` 重置 + 载入该根索引缓存），不动 DSH 会话工作区；选择写入
  `data/settings.json` 的 `projectRoot`，重启后仍停在上次的项目。
- 客户端「文件 → 打开项目目录…」对话框：绝对路径输入、回车打开、
  「回到会话工作区」；最近工程列表（`localStorage` 最多 30 个，显示 8 个 +
  「显示其余 N 项」，每项可 × 移除）。
- 切换后 `/info` 的 root 变化会触发标签页/索引/文件树按新工程重新加载，
  每个工程各自保留标签与草稿（key 里带 root）。
- **需要重启 DSH** 这两个路由才生效（Host 代码没有 HMR）。
### 本轮补充（符号窗 / AI 记录 / 窄屏）
- 左符号窗追加**预处理伪符号**：从缓冲区扫 `#if/#ifdef/#ifndef/#elif/#else/#endif`，
  与真实符号一起按当前排序显示，单击只跳到该行（不查索引）。文件 >2MB 时不扫。
- AI 面板消息记录持久化（`sourcelook.aiLog`，最多 40 条、单条 12k 字符），
  设置里有「清空记录」。
- 结果窗窄屏适配：<1180px 隐藏标题/统计、收窄输入框；<900px 缩小范围按钮与字号；
  最小宽度从 420 降到 320，拖动/缩放/几何恢复同步放宽。
### 本轮交互补充
- 面板状态持久化：左符号窗收起、右全局窗收起/模式、底部上下文窗开合，
  重启后恢复（`sourcelook.panes`）。
- `Esc` 关闭任意打开的对话框（关于/配色/解析与增强/文件选择/符号搜索/路径浮层）。
- 上下文窗 20 条**回放缓存**：同词同文件再次单击立即显示（不重复请求索引）；
  任何编辑/保存会清空缓存，避免行号过期。
- 顶栏查找框宽度跟随内容（`field-sizing: content`，150–240px），不挤 DSH 按钮。
- 本次 DSH 已重启，`/symbols-page`、`/config-value` 等新路由已实测可用。
### 交互细节（对齐原版）
- 左符号窗过滤框回车跳到第一条匹配并清空过滤；右全局窗过滤框回车打开第一行。
- 右全局窗文件列表：单击选中（状态栏提示「双击打开」），双击才打开。
- 上下文窗：点击 C 关键字/限定符（static/const/volatile/restrict/inline/extern…）
  给一句含义（原版 basic 面板）；`x->field` 解析不到时给「成员未解析」而不是空列表；
  单句结果会同时写到状态栏（关掉结果窗仍看得到）。
- 菜单项过滤 `null`（模式 P/D 时「隐藏 DSH 面板」那项是 null，原实现会崩）。
### 其它（本轮补充）
- `Ctrl+滚轮` 在编辑器上改字号（阻止浏览器页面缩放）。

### 上下文窗 / 定义
- 定义按原版规则排序：真定义优先于声明，`include/linux` → `include/uapi`
  → `include` → `arch/*/include` → 其它 `.h` → 源文件。
- 点击类型名时只保留同类型（struct/union/enum/typedef/type/class）定义，
  被过滤数量写进提示。
- `#include` 行：显示头文件 + 在项目里解析到的相对路径，可跳。
- 找不到定义时给出「外部符号 / 未建索引」说明，而不是什么都不显示。
- `CONFIG_*`：编译开关面板（当前值 / 是否编入当前配置 / Kconfig 声明位置 /
  受它控制的引用列表）。Host 新增 `/config-value`、`/kconfig`。

### 索引
- 刷新已有索引前弹确认（文件数 + 上次用时 + 写入阶段不能取消）。
- 进度卡：扫描/解析/写入阶段、活动目录（最多 8 行）、3 秒后按 5% 估算 ETA、
  写入阶段取消按钮禁用。
- Host 新增 `/symbols-page`、`/files-page`（给大项目分页用）。

### 其它
- 打开文件恢复上次光标（每个工程按文件记），启动恢复上次阅读位置并提示。
- 编辑器上方新增面包屑（点目录段切到文件树模式）。
- AI 面板 9 个按类按钮：解释用途/解释逻辑/风险点/找 bug/整段流程/展开宏/
  谁调用了它/导读本文件/加注释。

### 仍未移植（下一轮）
- 调用树/关系图/继承图（原版本身也明确“不做”）、索引 include 反向图。
- 窗口标题带工程名/未保存标记：**不移植**（会改 DSH 窗口标题，与宿主冲突）。
- 语言切换 zh/en（文案量很大，暂缓）。
- 结果窗的极窄屏（<800px）下代码卡与列表卡堆叠（现在只缩字号/隐藏标题）。

---
## 1. 三种模式（1.5.31 覆盖式）
| 模式 | 名称 | 行为 |
|---|---|---|
| **1 / P** | 只有插件 | SourceLook 占满整窗；顶栏右侧 `DSH` 按钮（70×30 科技蓝，左侧文字、右侧 16px 白色状态圈；空闲静态圆环，工作时 90° 圆头弧以 1.4s/圈旋转）。点击 → 模式 2。**没有关闭键**（如何进入模式 3 待定）。 |
| **2 / C** | 插件 + DSH 子窗口（覆盖式） | 插件**保持全宽、完全不重排**；DSH 作为右侧浮动子窗口，**从 y=40 开始**（高度 = 窗口高 − 40，底部/右侧贴窗口边缘），盖住插件右侧。子窗口标题带 40..80px：最左是 DSH 侧栏开关（`+12px`），接着 `新会话`（`+48px`）、`应用/编辑`（portal `+84px`），最右是插件的 **`→` 隐藏按钮**（`right:10px; top:46px`）。左缘 6px 可拖宽度。点隐藏 → 模式 1。 |
| **3 / D** | 只有 DSH | DSH 完整窗口；右上角 `打开 SourceLook` 胶囊 → 模式 1。**目前没有从插件进入模式 3 的入口**（等关闭按钮方案）。 |

### 模式 2 的实现要点（改之前先读）

- **顶层不重排**：插件 layer 仍是整窗宽；`.sl-content` 的宽度设为 `--sl-dsh-left` 并
  `overflow:hidden`，其子元素仍按 `--sl-visible-w`（整窗宽）布局。所以 Monaco、三栏、
  上下文三窗尺寸/布局不变，只是右侧被 DSH 盖住。
- **窗口几何**：
  - `applyShell(mode, dshWidth, viewportWidth, owner)` 设置 `#root` 的
    width / margin-left / margin-top=40 / height=calc(100%-40) / z-index=20；
  - 同时 CSS 里再钉一遍（`html[data-sourcelook-mode="C"] #root { ... !important }`），
    即使宿主或旧实例改写内联样式，子窗口也不会再上移；
  - `restoreShell(owner)` 只有在 `owner === shellOwner` 时才恢复；没有 token 的旧实例
    一律忽略（修复过 1.1.74 前的偶发上移）。
- **标题带**：`html[data-windows-titlebar][data-sourcelook-mode="C"] #root .mP3x-q_frame`
  强制 `padding-top:40px !important`，`::before` 强制显示、height 40、背景 #eef4fb。
  旧 1.1.68 的注入样式曾把它清成 0，导致 DSH 会话标题压在标题带上；现在有
  `#sourcelook-dsh-panel` 清理 + 强制覆盖两层保护。
- **DSH 菜单**：`syncDshMenu(mode, dshLeft, dshWidth)` 把 body 级的 `[data-windows-menu]`
  portal 移到子窗口标题带（`left = dshLeft + menuStart`，`top=40`，`z-index` 高，
  `width` 留出左侧开关和右侧隐藏键）。P 模式隐藏，D 模式还原。
- **DSH 侧栏开关/新会话**：CSS 在 C 模式把 `[data-sidebar-toggle]` 与
  `button[class*="newSession"]` 固定到 `dshLeft + 12/+48`、`top=46`；这是 DSH 自己的
  功能，只挪位置，不复制。
- **隐藏键/拖拽条**：这两个控件在 DSH 窗口之上（插件 layer 在 DSH 下方），所以由
  body 级 DOM 创建（`#sourcelook-dsh-hide`、`#sourcelook-dsh-grip`），每次 mode 变化
  重建、卸载时删除；不要改成放进 `.sl-layer`，会被 DSH 面板盖住。
- **顶栏与系统按钮**：顶栏底色 **#f9fafb**（等于 Windows 原生 caption overlay 底色）；
  分隔线用 `.sl-topbar::after` 画在 **y=40**（40px 标题栏正下方），横贯整窗，所以线会
  从左侧一直延续到最小化/最大化/关闭三个按钮下面。原生按钮无法删除/改映射。
- **DSH 工作状态**：观察 DSH 自己的 DOM：
  - composer 出现 `[aria-label="停止生成"]` → 正在跑回合；
  - 会话头 `[aria-label*="后台任务运行中"]` → 解析数量；
  - 结果驱动 `DSH` 按钮的 17px 状态圈（SVG，浅色圆环 + 90° 圆头弧，1.4s 旋转）。
- **模式 2 的代价**：插件的右全局符号栏、编辑器右缘、底部右引用卡被 DSH 盖住；
  点 `→` 回模式 1 使用。

---

## 2. 顶栏（左 → 右）

品牌（`SourceLook`，S 红 / L 绿）· 文件 / 编辑 / 视图 · 分隔线 · 刷新索引 ·
项目目录 · 当前文件相对路径（最长 210px 自动省略）· 弹簧 ·
**后退 / 前进**（80×30 圆角胶囊，居中）· 查找 + 输入框 + 查找结果 ·
**`DSH`（70×30，状态圈）** · 帮助。
- 查找输入框 190px，点代码/符号时自动填入当前词。
- 右侧 158px 留给系统按钮，插件内容不再进入该区域。
- 顶栏分隔线在 y=40（`.sl-topbar::after`），不在 40px 内部。

---

## 3. 左符号栏 / 编辑器 / 右全局栏 / 底部三窗

（1.1.68 已完成，保持）

- 左符号栏：380/1600 比例，22px 行高，类型徽标、按类型着色、过滤、排序；
  单击符号 = 跳转 + 填查找框 + 出上下文。
- 编辑器：Monaco 14.5/19，行号 #b3bac3、当前行 #4a5159、行高亮 #f6f8fa、
  选区 #add6ff；单击词出上下文，双击选中词（不跳转），Ctrl+点击/F12 跳定义，
  Shift+F12 查引用，右键自绘动作菜单。
- 右全局栏：符号/树/文件三模式，过滤、同名分组、折叠。
- 底部上下文窗：定义/代码/引用三张等宽卡片，10px 可拖列缝，高度可拖/折叠，
  跨重启保存。
- 状态栏 26px：索引统计（可点击重建）、已修改、当前路径行列、Alt+←/→ 提示。

---

## 4. 功能对照（原版 → SourceLook）

| 原版 | SourceLook |
|---|---|
| 单击词出上下文 | ✅ 同时填顶栏查找 |
| 双击选中词（不跳转）+ 浮动动作条 | ✅ 1.1.78 |
| Ctrl+点击 / F12 跳定义 | ✅ 多命中进结果窗口 |
| Shift+F12 查引用 | ✅ 结果窗口 |
| 我调用谁 / 谁调用我 | ✅ 本文件扫描 / 索引引用 |
| 右键动作菜单 | ✅ 自绘，含复制带位置、选中函数、include、进制转换 |
| 左/右栏、过滤、树/文件 | ✅ |
| 查找 + 查找结果浮动窗口 | ✅ 1.1.78（拖动/缩放/记忆几何） |
| 查找范围：本文件/本目录/索引/全文 | ✅ 1.1.78 |
| F4 / Shift+F4 逐条 | ✅ |
| 前进后退 Alt+←/→ | ✅ |
| 索引重建/进度/取消 | ✅ 含刷新确认、ETA、阶段、活动目录 |
| 定义/代码/引用三窗 | ✅ |
| 上下文窗高度/列宽拖动 | ✅ |
| 同类型定义过滤 / 权威排序 | ✅ 1.1.78 |
| #include 目标解析 | ✅ |
| CONFIG_* 编译开关面板 | ✅ 1.1.78（值/是否编入/Kconfig/引用） |
| 外部符号 / 未建索引说明 | ✅ |
| 字号放大缩小（Ctrl+=/-/0） | ✅ 1.1.78 |
| 整词高亮 Shift+F8 | ✅ 1.1.78 |
| 上次阅读位置 / 每文件光标 | ✅ 1.1.78 |
| 面包屑 | ✅ 1.1.78（点目录切文件树） |
| AI 按类提示 | ✅ 9 个按钮 |
| 宏局部展开浮层 | ❌ 未移植（下一轮） |
| AI 行内编辑（view zone） | ❌ 未移植（下一轮） |
| 调用树/关系图/继承图 | ❌ 原版明确不做 |
| 多标签 | ❌ 原版没有标签栏 |

---

## 5. 快捷键

F12 / Ctrl+点击 跳定义；Shift+F12 查引用；Shift+F8 整词高亮；`Esc` 取消高亮/浮条；
`F4` / `Shift+F4` 结果窗口逐条；Ctrl+Alt+P 符号搜索；
Ctrl+O / Ctrl+S / Ctrl+W 打开/保存/关闭；Ctrl+F / Ctrl+H / Ctrl+G 查找/替换/跳行；
Ctrl+= / Ctrl+- / Ctrl+0 字号；Alt+←/→ 后退/前进。

> `Ctrl+Alt+B` 已删除（与 DSH `sidebar.right.toggle` 冲突）。
> `Ctrl+P` 被 DSH Files 占用，符号搜索用 `Ctrl+Alt+P`（Web 上要再加 Shift）。

---

## 6. 关键文件

- `client.js` 构建产物（1.1.78）
- `index.js` 宿主路由/索引/settings（新增 `/symbols-page` `/files-page` `/config-value` `/kconfig` `/enhance/report` `/enhance/export`）
- `src/client/00-header.js` 存储 key、BUILD_TAG（2026-11-07-l）
- `src/client/50-shell.js` P/C/D 几何、CSS pin、owner token、DSH 菜单/标题带、
  `syncHostDark()`（插件暗色→DSH 同步暗色）、字号/光标记忆
- `src/client/80-app.js` 顶栏、布局、DSH 按钮/状态、结果窗口、上下文、事件
- `src/client/59-context-menu.js` 右键菜单 + **浮动动作条**
- `src/client/69-results.js` 底部三窗 + **`SlResultWindow` 浮动结果窗口**
- `src/client/68-outline.js` / `68-global.js` / `60-tree.js` / `65-quickopen.js` / `67-symbol-search.js`
- `src/client/styles.css` 样式（末尾：主题统一层、浮条、结果窗、面包屑）
- `renderer-lib/editor/monaco-adapter.js` 双击/右键/行高/`setFontSize`/`highlightMatches`
- `tmp/check-render.mjs` 组件体冒烟（抓 TDZ/顺序错误；本轮就是靠它发现的）
- `tmp/feature-inventory-original.md` 原版 KernelSight 全量功能清单（1,263 行）
- `tmp/feature-map-current.md` 1.1.78 前的能力地图（885 行，行号已过时，按锚点查）
- 旧截图 `tmp/final-1177.png` 等只代表 1.1.77 外观

---

## 7. 构建

```powershell
$node='C:\Users\luban\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node 'C:\Users\luban\Documents\deepseek-harness\default-workspace\SourceLook\scripts\build.mjs'
& $node --check 'C:\Users\luban\Documents\deepseek-harness\default-workspace\SourceLook\client.js'
& $node 'C:\Users\luban\Documents\deepseek-harness\default-workspace\SourceLook\tmp\simulate.mjs'
& $node 'C:\Users\luban\Documents\deepseek-harness\default-workspace\SourceLook\tmp\check-render.mjs'
```

安装/重装（profile 已 link，一般不需要）：plugin_manager remove `@local/sourcelook`，
再 install 本目录。

---

## 8. 已知问题 / 下一步

1. **交互没有自动点击验证**：沙箱禁止 SetCursorPos / Chrome headless，鼠标点击测不了。
   已用“临时演示态 + 截图”验证结果窗口/主题；F4、浮条、右键菜单需要你实际点一下。
   若 HMR 连续不生效，完全重启 DSH。
2. **强制 DSH 变暗的风险**：只依赖 DSH 样式表里的 `body[data-ds-dark-theme]`
   规则；若 DSH 版本改了选择器或 token 名，最坏情况是 DSH 面板不变暗（插件仍正常）。
   切回浅色会恢复原 token；如果 DSH 自己在你强制期间换了主题，恢复值可能落后一次。
3. **模式 3 没有入口**：关闭键已按要求删除（用户会再想）。
4. **DSH 子窗口仍是完整 DSH 应用**：会话头、目录图标、对话/轨迹都在。
5. **系统原生按钮不可改**：caption 颜色由 DSH preload 按 body 计算，插件只负责
   让 body 变暗；顶栏底色用 `--sl-topbar-bg`（浅 #f9fafb / 深 #1b1b1c）。
6. **模式 2 会盖住插件右全局栏/编辑器右缘/底部右卡**（覆盖式，布局不变）。
7. **JS/TS 文件没有引用索引**（只有 C/C++/Rust/Go/asm 有）。
8. **待排查**：用户报告点击插件 `视图`、`编辑` 等菜单可能导致 DSH 崩溃，
   等界面定稿后一起排查（本轮未复现，无法注入点击）。
9. **结果窗口的查询/类型切换**在“定义”类型下忽略 scope（原版也是）。
10. **宏展开/AI 行内编辑/L2-L4 面板**仍未移植，见 0.5 末尾清单。

---

## 9. 新任务开场提示

```text
阅读 C:\Users\luban\Documents\deepseek-harness\default-workspace\SourceLook\HANDOFF.md，
继续 SourceLook 1.5.31 的功能移植与验收。

- 唯一路径 C:\Users\luban\Documents\deepseek-harness\default-workspace\SourceLook
- 不要创建定时任务/自动继续；不要用旧 D 盘路径
- 改完 client.js：先等 HMR；1.1.78 会话里 HMR 已失效，需完全重启 DSH 才生效
- 验收顺序：深色整窗 + DSH 子窗口是否一起变暗 → DSH 按钮 → 结果窗口/范围/F4
  → 字号/高亮/浮条 → 面包屑/上次位置 → CONFIG 面板
- 下一批：宏局部展开、AI 行内编辑、L2/L3/L4 面板、include/关系视图（按需）
- 原版功能清单：tmp/feature-inventory-original.md（以此为准）
```
