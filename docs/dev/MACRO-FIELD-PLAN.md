# SourceLook 宏包装字段缺失修复方案（`saddr` / `__struct_group`）

## 0. 文档目的

这份文档给接手修复的 AI 使用，目标是系统性解决：

- `struct iphdr` 的 `saddr` 在定义区显示未解析
- `daddr` 正常，但同一结构体里的 `saddr` 索引不到
- `__struct_group` / `__attribute__` / `__aligned` 等宏包装字段漏索引
- 与位域、多声明字段、匿名 struct/union 同类的字段提取问题

当前版本：**1.5.74**。

---

## 1. 现象

点击：

```c
net/ipv4/tcp_ipv4.c:99
ip_hdr(skb)->saddr
```

定义区显示：

```text
未解析
`iphdr` 里没有成员 `saddr`
```

同一函数上一行：

```c
net/ipv4/tcp_ipv4.c:98
ip_hdr(skb)->daddr
```

可以正常解析到：

```text
member @ include/uapi/linux/ip.h:106 / iphdr
```

---

## 2. 源码现场

```c
include/uapi/linux/ip.h:87
struct iphdr {
#if defined(__LITTLE_ENDIAN_BITFIELD)
    __u8 ihl:4,
         version:4;
#elif defined(__BIG_ENDIAN_BITFIELD)
    ...
#endif
    __u8 tos;
    __be16 tot_len;
    __be16 id;
    __be16 frag_off;
    __u8 ttl;
    __u8 protocol;
    __sum16 check;
    __struct_group(/* no tag */, addrs, /* no attrs */,
        __be32 saddr;
        __be32 daddr;
    );
    /* options... */
};
```

`saddr` 和 `daddr` 在同一个 `__struct_group` 宏里。

---

## 3. 已确认的事实

### 3.1 `ip_hdr` 宏本身没有问题

调用点是：

```c
ip_hdr(skb)->saddr
```

`ip_hdr(skb)` 返回：

```c
struct iphdr *
```

接收者类型解析正确，错误信息本身是：

```text
`iphdr` 里没有成员 `saddr`
```

说明不是 `ip_hdr` 宏的问题。

### 3.2 `daddr` 在索引里，`saddr` 不在

当前 `.crdb` 索引中：

```text
daddr -> member @ include/uapi/linux/ip.h:106 / iphdr
saddr -> 没有
```

### 3.3 当前 `ts-indexer.extract()` 也找不到 `saddr`

不是单纯旧索引问题。

直接调用当前提取器解析 `include/uapi/linux/ip.h`：

```text
saddr -> []
daddr -> member @ include/uapi/linux/ip.h:106 / iphdr
```

所以即使重建索引，当前代码仍然会漏 `saddr`。

### 3.4 tree-sitter 的 AST 形状

`saddr` 附近的 AST 不是普通：

```text
field_declaration
  type: __be32
  declarator: saddr
```

而是：

```text
field_declaration
  macro_type_specifier: "__struct_group(... __be32"
  field_identifier: "saddr"
ERROR: ");"
```

`daddr` 则被解析成正常的 `field_declaration`。

---

## 4. 根因

`host/ts-indexer.js` 对 `field_declaration` 有一个特殊处理：

- 它识别 `macro_type_specifier`
- 把这类节点当成“宏类型声明/宏站点”
- 本意是处理：

```c
static LIST_HEAD(foo);
static FOO(bar);
```

但在结构体字段上下文里：

```c
__struct_group(..., __be32 saddr;)
```

`macro_type_specifier` 只是**布局宏包装**，`saddr` 仍然是 `iphdr` 的成员。

当前逻辑把整个 `field_declaration` 当成宏类型站点，跳过了后面的 `field_identifier`，于是：

- `daddr` 是普通字段 → 入索引
- `saddr` 被 `__struct_group` 包住 → 漏掉

---

## 5. 这不是单点问题

同类宏/字段形状还会导致：

- `__struct_group` 内部多个字段
- `__attribute__((...))` 包住字段
- `__aligned(...)` / `__packed`
- `__randomize_layout`
- 位域：`has_rxtstamp:1`
- 一行多个字段：`u8 a, b, c;`
- 匿名 struct/union 内部字段
- 声明宏：`LIST_HEAD(x)`
- 宏类型：`static FOO(bar)`

继续为每个宏写一个特例，会不断复发。

---

## 6. 修复目标

### 必须

1. `iphdr.saddr` 能进入索引：
   ```text
   member @ include/uapi/linux/ip.h:105 / iphdr
   ```
2. `iphdr.daddr` 保持 106。
3. `__struct_group` 内部所有字段都入索引。
4. 同类宏包装字段不漏。
5. 索引解析器版本变化时旧缓存失效。
6. 成员 fallback 能补出宏包装字段。

### 不应该

- 不修改 DSH
- 不改 UI/Monaco
- 不重写整个索引格式
- 不只为 `saddr` / `__struct_group` 写死一个特例
- 不把结构体成员当全局符号
- 不把宏展开器写成完整 C 预处理器

---

## 7. 方案

### 7.1 字段上下文优先于宏类型判断

修改 `ts-indexer.js` 的 `fieldDeclaration` 分支：

1. 判断当前节点是否在 `struct/union` 的字段列表里
2. 收集该节点的所有 `field_identifier`（包括 `macro_type_specifier` 后面的）
3. 对每个字段名：
   - `parent` = 当前 struct/union
   - `kind` = member
   - `type` = 宏内部最后一个类型标记，例如 `__be32`
4. 不要因为看到 `macro_type_specifier` 就整个跳过

`__struct_group` 的 AST 中：

```text
field_declaration
  macro_type_specifier: "__struct_group(... __be32"
  field_identifier: "saddr"
```

应提取：

```text
saddr, member, __be32, parent=iphdr
```

### 7.2 识别布局/属性宏

对常见宏：

- `__struct_group`
- `__attribute__`
- `__aligned`
- `__packed`
- `__randomize_layout`

把它们当“包装”而不是“类型”：

- 优先解析内部的真实字段声明
- 支持一行/多行
- 支持多个字段
- 支持位域

不要只写死 `__struct_group`；先做通用字段上下文处理，再补常见宏。

### 7.3 成员 fallback

`memberFromTypeText()` 需要能从结构体正文中识别：

```c
__struct_group(..., __be32 saddr; __be32 daddr;)
```

- 去掉宏包装前缀
- 按结构体 body 范围扫描
- 识别 `type name;`、`name:bits`、`a, b, c;`
- 返回 synthetic 成员

即使索引缺失，也不能直接显示未解析。

### 7.4 索引解析器版本

新增：

```json
{
  "parserRev": "2026-11-15-01"
}
```

- 构建索引时写入
- 加载时比较
- 不一致 → 标记过期，提示/触发重建
- 不静默使用旧索引

这是为了防止“代码修了但旧索引还在”的问题重演。

### 7.5 长期方案：AST 字段表

更彻底的方案：

- 用 tree-sitter 构建 struct/union 成员表
- 包括宏包装字段、位域、多声明、匿名 struct/union
- 索引或缓存该成员表
- `findDefinition` 成员查询优先 AST 表
- 文本 fallback 只做兜底

这与 `MEMBER-EXPRESSION-PLAN.md`、`BITFIELD-INDEX-PLAN.md` 可以合并成同一个“成员模型”子系统。

---

## 8. 测试

### 8.1 必测

| 文件 | 符号 | 行 | 期望 |
|---|---|---:|---|
| `include/uapi/linux/ip.h` | `saddr` | 105 | `member @ 105 / iphdr` |
| `include/uapi/linux/ip.h` | `daddr` | 106 | `member @ 106 / iphdr` |
| `net/ipv4/tcp_ipv4.c` | `saddr` | 99 | 上述 member |
| `net/ipv4/tcp_ipv4.c` | `daddr` | 98 | 上述 member |

### 8.2 宏包装

构造或找：

```c
struct foo {
    __struct_group(/* no tag */, addrs,
        int a;
        int b;
    );
    __attribute__((aligned(8))) int c;
};
```

验证 a/b/c 都入索引。

### 8.3 位域/多字段

```c
struct bits {
    u8 a:1, b:1, c:1;
    u16 d, e;
};
```

验证全部成员。

### 8.4 回归

- `tmp/test-rt.cjs`
- `tmp/test-daddr.cjs`
- `tmp/test-net.cjs`
- `tmp/test-errno.cjs`
- `tmp/test-twsyn.cjs`
- `scripts/smoke-host.mjs`
- `scripts/smoke-index.cjs`
- `tmp/check-render.mjs`
- 手动：单击、双击、F12、Shift+F12、上下文定义卡

---

## 9. 实施阶段

### Phase 1：字段上下文提取

- 修 `ts-indexer` 的 `fieldDeclaration`
- 支持 `macro_type_specifier` + `field_identifier`
- 加 `saddr` 用例

### Phase 2：布局/属性宏

- 支持 `__struct_group`
- 支持 `__attribute__`/`__aligned`/`__packed`
- 支持多字段/位域

### Phase 3：索引版本与 fallback

- 增加 `parserRev`
- 加载时失效
- `memberFromTypeText` 支持宏包装
- 重建索引验证

### Phase 4：长期成员表

- 评估 AST 字段表
- 合并位域/宏/多声明逻辑
- 保留文本 fallback

---

## 10. 验收标准

1. `iphdr.saddr` 返回 `include/uapi/linux/ip.h:105`。
2. `iphdr.daddr` 仍返回 106。
3. `__struct_group` 内部字段全部入索引。
4. 宏包装/位域/多字段/匿名 struct 不再漏。
5. 旧 `parserRev` 索引被标记过期。
6. 成员 fallback 能补出缺失字段。
7. 现有定义/引用/索引功能无回归。

---

## 11. 一句话总结

`saddr` 不是 `ip_hdr` 宏的问题，而是：

> **`saddr` 被 `__struct_group` 包装，tree-sitter 生成 `macro_type_specifier + field_identifier`；当前 `ts-indexer` 把整个字段声明当宏类型站点跳过，只把后面的 `daddr` 当普通字段入索引。**

修复方向是：字段上下文优先、宏包装字段完整提取、成员 fallback、索引解析器版本。只重建索引不够，因为当前提取器本身就还漏 `saddr`。
