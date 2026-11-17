# SourceLook 位域成员缺失与旧索引问题修复方案

## 0. 文档目的

这份文档给接手修复的 AI 使用，目标是系统性解决：

- 位域成员（`has_rxtstamp:1`）无法从索引解析
- 旧 `.crdb` / `.idx.json` 缓存不随解析器升级失效
- 成员缺失时 `memberFromTypeText()` fallback 没有可靠救回
- 后续同类字段/位域/多声明成员问题

当前版本：**1.5.73**。

---

## 1. 现象

点击：

```c
TCP_SKB_CB(skb)->has_rxtstamp
```

位置：

```text
net/ipv4/tcp_ipv4.c:1879
```

定义区显示：

```text
未解析
`tcp_skb_cb` 里没有成员 `has_rxtstamp`
```

### 1.1 相关源码

宏：

```c
include/net/tcp.h:889
#define TCP_SKB_CB(__skb) ((struct tcp_skb_cb *)&((__skb)->cb[0]))
```

结构体：

```c
include/net/tcp.h:828
struct tcp_skb_cb {
    ...
    __u8 txstamp_ack:1,
         eor:1,
         has_rxtstamp:1,
         unused:5;
    ...
};
```

`has_rxtstamp` 是：

```text
include/net/tcp.h:859
member of struct tcp_skb_cb
```

---

## 2. 已确认的事实

### 2.1 宏接收者类型是对的

错误信息里的 base 是 `tcp_skb_cb`，说明：

```c
TCP_SKB_CB(skb)
```

已经被解析为：

```c
struct tcp_skb_cb *
```

**问题不在 `TCP_SKB_CB` 宏，不在接收者类型推导。**

### 2.2 当前 tree-sitter 提取器能找到全部位域名

直接用当前 `host/ts-indexer.js` 的 `extract()` 解析 `include/net/tcp.h`：

```text
txstamp_ack   member line 857
eor           member line 858
has_rxtstamp  member line 859
unused        member line 860
```

所以当前解析器代码是能提取全部位域名的。

### 2.3 当前加载的旧索引只有第一个位域名

对当前索引调用 `findSymbols()`：

| 名字 | 结果 |
|---|---|
| `txstamp_ack` | `tcp_skb_cb:857` 有 |
| `eor` | 只有其他结构体的 `eor`，没有 `tcp_skb_cb` |
| `has_rxtstamp` | 完全没有 |
| `unused` | 只有其他变量，没有 `tcp_skb_cb` |

`txstamp_ack` 正好是这条位域声明的第一个名字。

结论：

> 磁盘上的索引是用旧版字段提取逻辑构建的，只记录了第一个位域名。  
> 当前解析器已经修好，但旧索引没有失效。

### 2.4 成员 fallback 没有救回来

`findDefinition()` 成员分支逻辑是：

1. `mapSymbols(parent=tcp_skb_cb, name=has_rxtstamp)`
2. 找不到 → 调 `memberFromTypeText()`
3. 还找不到 → 返回 unresolved

实际错误是 unresolved，说明：

- 要么 fallback 没有触发
- 要么 `memberFromTypeText()` 对位域 `has_rxtstamp:1` 没识别

这是第二层系统性问题，不能只重建索引了事。

---

## 3. 根因

### 3.1 索引缓存没有解析器版本

旧索引格式/内容与新解析器代码不一致，但加载器只校验索引格式号，不校验解析器版本。

于是：

- 解析器修了位域
- 旧 `.idx.json` / `.crdb` 仍然被加载
- 用户看到的还是旧结果

### 3.2 位域字段提取历史缺陷

`field_declaration` 可能只处理第一个 declarator：

```c
__u8 txstamp_ack:1, eor:1, has_rxtstamp:1, unused:5;
```

只记录 `txstamp_ack`。

当前 `ts-indexer.extract()` 已经能提取全部，但旧索引是旧逻辑生成的。

### 3.3 成员 fallback 不够健壮

`memberFromTypeText()` 依赖：

- 类型关键字白名单
- 上一行逗号续行
- 行文本扫描

对位域、`__u8`、一行多字段、注释等容易漏。

而且成员分支的 fallback 调用条件需要确认，不能保证索引缺失时一定进入文本补全。

---

## 4. 修复目标

### 必须

1. 当前项目重建索引后，`has_rxtstamp` 能进入索引。
2. 以后解析器字段提取逻辑变化时，旧索引自动标记过期，不静默使用。
3. 索引缺成员时，`memberFromTypeText()` 能识别位域并补出 synthetic 成员。
4. `TCP_SKB_CB(skb)->has_rxtstamp` 返回：

```text
member @ include/net/tcp.h:859 / tcp_skb_cb
```

### 不应该

- 不修改 DSH
- 不改 Monaco/UI
- 不重写整个索引格式
- 不只为 `has_rxtstamp` 写死特例
- 不因重建索引把用户工程改坏
- 不把位域/宏逻辑散落到 `findDefinition` 里

---

## 5. 方案

### 5.1 索引解析器版本

在索引元数据中增加：

```json
{
  "parserRev": "2026-11-15-01"
}
```

定义位置建议：

- `host/ts-indexer.js` 导出 `PARSER_REV`
- 或 `host/fs-service.js` 常量

规则：

- 构建索引时写入 `parserRev`
- 加载 `.idx.json` 时比较当前 `PARSER_REV`
- 不一致：
  - 标记 `stale` / `parserStale`
  - 不要静默按旧索引回答
  - 状态栏显示“索引过期（解析器已更新）”
  - 用户点击重建；或后台重建（二选一，建议先提示）

不要直接删除用户索引，先保留可回退。

### 5.2 位域/多声明字段完整入索引

检查 `host/ts-indexer.js`：

- `declaratorsOf()`（约 1047 行）
- `fieldDeclaration` 分支（约 2142 行）

要求：

- 一条 `field_declaration` 中所有 `field_identifier` 都入索引
- 每个 `bitfield_clause` 前的名字都入索引
- 同一行多个字段：
  ```c
  u8 a, b, c;
  ```
- 匿名 struct/union 里的字段归属正确
- 多行声明
- 注释不干扰

当前 `extract()` 已经能提取四个位域名；需要：

- 确认 worker/索引构建路径使用同一版本
- 增加回归测试
- 修改 `PARSER_REV`

### 5.3 成员 fallback

#### 5.3.1 确认调用条件

检查 `findDefinition()` 成员分支：

```js
let members = mapSymbols(...);
if (members.length === 0 || rank > 1) {
  const synthetic = await memberFromTypeText(...);
  ...
}
```

必须保证：

- 索引里没有该成员时一定调用 `memberFromTypeText`
- 调用后 synthetic 被加入结果
- 不能被 `rank` 条件或空数组判断绕过

建议加日志/单测，而不是只靠阅读。

#### 5.3.2 强化 `memberFromTypeText()`

要求支持：

- 位域：
  ```c
  has_rxtstamp:1,
  ```
- 一行多个字段：
  ```c
  u8 a, b, c;
  ```
- 内核 typedef 类型：
  ```c
  __u8, __u16, __u32, __be32, u8, u16, u32
  ```
- 注释/空行/预处理行
- 多行字段声明
- 结构体嵌套（至少不误匹配到其他结构体）

实现建议：

- 不再只用 `hasType` 类型白名单
- 识别 `name\s*:\s*\d+` 直接作为位域成员
- 按结构体 body 范围扫描，按字段声明分组
- 对每个声明收集所有字段名
- 返回 synthetic 成员时带：
  ```json
  {
    "kind": "member",
    "file": "include/net/tcp.h",
    "line": 859,
    "column": ...,
    "type": "__u8",
    "parent": "tcp_skb_cb",
    "synthetic": true
  }
  ```

### 5.4 索引与成员查询的分层

建议顺序：

1. 当前文件 AST local scope（如果存在）
2. 索引中的成员
3. `memberFromTypeText()` 文本 fallback
4. 返回 unresolved

成员索引缺失不能直接变成“未解析”，必须经过 fallback。

---

## 6. 实施步骤

### Phase 1：验证/extend 提取器

- 确认 `ts-indexer.extract()` 对 `has_rxtstamp` 能输出
- 给 `fieldDeclaration` 加位域回归测试
- 如果 worker 路径使用旧逻辑，统一
- 设置 `PARSER_REV`

### Phase 2：索引版本

- 构建时写 `parserRev`
- 加载时比较
- 不一致标记过期
- 状态栏提示
- 不要静默加载旧索引

### Phase 3：成员 fallback

- 修 `memberFromTypeText()` 位域/多字段
- 确认调用条件
- synthetic 结果去重
- 测试 `TCP_SKB_CB(skb)->has_rxtstamp`

### Phase 4：重建与验收

- 重建当前项目索引
- 确认索引包含：
  - `txstamp_ack`
  - `eor`
  - `has_rxtstamp`
  - `unused`
- 确认定义结果指向 `include/net/tcp.h:859`

---

## 7. 测试清单

### 7.1 直接用例

| 文件 | 行 | 符号 | 期望 |
|---|---:|---|---|
| `net/ipv4/tcp_ipv4.c` | 1879 | `has_rxtstamp` | member @ include/net/tcp.h:859 / tcp_skb_cb |
| `include/net/tcp.h` | 857 | `txstamp_ack` | member @ 857 |
| `include/net/tcp.h` | 858 | `eor` | member @ 858 |
| `include/net/tcp.h` | 860 | `unused` | member @ 860 |

### 7.2 位域/多字段

构造或找：

```c
struct bits {
    u8 a:1, b:1, c:1;
    u16 d, e;
};
```

验证：

- 三个位域都入索引
- `d/e` 都入索引
- 成员访问能解析

### 7.3 fallback

- 模拟索引缺 `has_rxtstamp`
- 直接调用成员分支
- 应通过 `memberFromTypeText` 返回 synthetic
- 不返回 unresolved

### 7.4 版本

- 旧 `parserRev` 索引加载 → 标记过期
- 重建后 `parserRev` 更新
- 不静默使用旧索引

### 7.5 回归

- `tmp/test-rt.cjs`
- `tmp/test-daddr.cjs`
- `tmp/test-net.cjs`
- `tmp/test-errno.cjs`
- `scripts/smoke-host.mjs`
- `scripts/smoke-index.cjs`
- `tmp/check-render.mjs`
- 手动：单击、双击、F12、Shift+F12、上下文定义卡

---

## 8. 性能

- 重建索引是一次性成本，大约当前项目规模需要等待
- 加载时只读 `parserRev`，无额外开销
- `memberFromTypeText()` 只读取目标结构体所在文件，限制扫描行数
- fallback 只在成员缺失时触发
- 不要为每次成员查询重读整个大文件；可加小 LRU

---

## 9. 验收标准

1. `has_rxtstamp` 返回 `include/net/tcp.h:859`。
2. `eor` / `unused` / `txstamp_ack` 在 `tcp_skb_cb` 下完整。
3. 索引缺成员时 fallback 能补 synthetic 成员。
4. 解析器版本变化后旧索引被标记过期，不静默返回旧结果。
5. `rt` / `daddr` / `net` / `errno` 回归不变。
6. 不影响现有索引、定义、引用、上下文窗口功能。

---

## 10. 一句话总结

这不是 `TCP_SKB_CB` 宏的问题，而是：

> **旧索引只记录了第一个位域名，且索引缺少解析器版本导致旧缓存不失效；成员缺失时文本 fallback 又没有可靠补位。**

修复要同时做：位域完整入索引、索引解析器版本、成员文本 fallback。只重建一次索引只能解决当前现象，不能防止下次再发生。
