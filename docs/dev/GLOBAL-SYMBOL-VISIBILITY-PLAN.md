# SourceLook 全局符号可见性系统化方案（C 枚举常量）

## 0. 文档目的

这份文档给接手修复/审查的 AI 使用。

目标是系统性解决：

- `TCP_TW_SYN` 这类 **C 枚举常量**在定义区显示“没有/未解析”
- 全局符号可见性判断散落在多个分支，规则不一致
- 不要把“有 parent 的符号”一律当成非全局符号
- 后续同类问题（匿名枚举、跨文件枚举、同名枚举、C/C++ 差异）继续复发

当前版本：**1.5.74**。

---

## 1. 现象

点击：

```c
net/ipv4/tcp_ipv4.c:2158
case TCP_TW_SYN: {
```

定义区没有结果。

`TCP_TW_SYN` 实际定义：

```c
include/net/tcp.h:365
enum tcp_tw_status {
    TCP_TW_SUCCESS = 0,
    TCP_TW_RST = 1,
    TCP_TW_ACK = 2,
    TCP_TW_SYN = 3
};
```

索引里实际已经有：

```text
kind   = enum_member
file   = include/net/tcp.h
line   = 369
parent = tcp_tw_status
```

但 `findDefinition()` 返回空。

---

## 2. 根因

`findDefinition()` 最后汇总全局符号时使用了：

```js
.filter((s) => !s.parent)
```

`enum_member` 的 `parent` 是枚举名 `tcp_tw_status`，于是被排除。

这背后是一个错误的全局符号模型：

> 认为“有 parent 的符号 = 成员，不是全局符号”。

对 C 不成立：

- C 的 `enum` 常量是**无作用域限定的全局标识符**
- `TCP_TW_SYN` 可以直接写，不需要 `tcp_tw_status.TCP_TW_SYN`
- 它的 `parent` 只是“属于哪个枚举”，不是访问作用域

而 `struct` 成员：

```c
struct foo { int field; };
field;  // 不能直接这样用
```

才是真正的成员，必须通过 `obj.field` 访问。

---

## 3. 当前已做的修复

版本 **1.5.74** 在 `host/fs-service.js` 增加了局部 helper：

```js
const globallVisible = (s) =>
  !s.parent || String(s.kind || '').toLowerCase() === 'enum_member';
```

并替换了：

- `plainHits` 的 `!s.parent`
- 全局汇总循环里的 `if (s.parent) continue`
- 最终 fallback 的 `!s.parent`

结果：

```text
TCP_TW_SYN
-> enum_member @ include/net/tcp.h:369 / tcp_tw_status
```

`tcp_ipv4.c:2158` 和 `tcp_minisocks.c:226` 都通过。

这个修复方向正确，但仍然是**局部 helper + 三处替换**，还没有统一全局符号可见性模型。

---

## 4. 系统性问题

### 4.1 过滤逻辑分散

当前至少这些地方各自做“是否全局”的判断：

- `findDefinition()` 全局汇总
- `findDefinitionGeneric()` 非 C 语言
- `baseTypeOfExpr()` 标识符类型解析
- 最终 fallback
- 可能还有 `findReferences` / 搜索/结果展示

每个地方都写一次 `!s.parent`，规则容易再次分叉。

### 4.2 用 parent 判断作用域不成立

符号种类与可见性不是简单对应：

| kind | parent | C 中是否全局可见 |
|---|---|---|
| `function` | 空 | 是 |
| `macro` | 空 | 是 |
| `struct/union/enum/typedef` | 空 | 是 |
| 全局变量 | 空 | 是 |
| `enum_member` | 枚举名 | **是（C 非限定枚举）** |
| `member` / `field` | 结构体名 | 否 |
| `parameter` | 函数名 | 否 |
| 局部变量 | 函数名 | 否 |

只看 `parent` 会把 `enum_member` 误判成成员。

### 4.3 C/C++ 差异

- C：枚举常量无作用域限定，名字进入普通标识符命名空间
- C++：`enum class` 是限定作用域；`enum`（非 class）仍可无限定访问
- 当前索引的 `kind=enum_member` 没有记录 `enum class` 的 scoped 属性
- 本轮先保证 C；C++ 后续需要 `scoped` 元数据

### 4.4 匿名枚举

```c
enum {
    FOO = 1,
    BAR = 2
};
```

`enum_member` 的 `parent` 可能为空或匿名枚举名。  
如果只按 `parent` 判断，也可能被误处理。

### 4.5 同名 enum 常量

不同枚举里可能有同名常量。  
全局查询应返回多个候选，并按当前文件/包含关系排序，而不是只取第一个。

---

## 5. 目标设计

### 5.1 统一的可见性函数

在 `host/fs-service.js` 模块级增加：

```js
function isGloballyVisibleSymbol(s, langId) {
  const kind = String(s && s.kind || '').toLowerCase();
  if (!s) return false;
  if (kind === 'member' || kind === 'field'
      || kind === 'parameter' || kind === 'local') return false;
  if (kind === 'variable') {
    /* 有 parent 的是局部变量；无 parent 才是全局变量。 */
    return !s.parent;
  }
  if (kind === 'enum_member') {
    /* C 的非限定枚举常量：全局可见。
       C++ enum class 后续用 scoped 元数据区分，本轮不处理。 */
    return true;
  }
  return !s.parent;
}
```

要求：

- 不直接改所有 `!s.parent` 为 `!parent || enum_member`，要统一调用这个函数
- `langId` 先保留，给后续 C++ 使用
- 函数只判断可见性，不负责排序/去重

### 5.2 使用位置

至少替换：

1. `findDefinition()` 的 `plainHits`
2. `findDefinition()` 的全局汇总循环
3. `findDefinition()` 的最终 fallback
4. `findDefinitionGeneric()` 的全局候选
5. `baseTypeOfExpr()` 的标识符类型候选（如果它需要 enum 常量作为类型？通常不需要，但应统一）
6. 搜索结果/引用结果里如果有“只显示全局”的过滤

### 5.3 文件级 static

`static` 函数/变量的可见性是“当前文件”，不是“全局”：

- 当前文件命中 → 返回 file scope
- 其他文件不能作为全局候选
- 现有 `fileHits` / `statics` 分支保留
- 统一 helper 只处理“符号种类”，不要吞掉文件级规则

### 5.4 排序

多个 enum 常量同名时：

- 当前文件优先
- 当前项目 include 路径优先
- 头文件优先于驱动私有副本
- 保持现有 `definitionRank()`

---

## 6. 测试

### 6.1 必测

| 文件 | 行 | 符号 | 期望 |
|---|---:|---|---|
| `net/ipv4/tcp_ipv4.c` | 2158 | `TCP_TW_SYN` | `enum_member @ include/net/tcp.h:369 / tcp_tw_status` |
| `net/ipv4/tcp_minisocks.c` | 226 | `TCP_TW_SYN` | 同上 |

### 6.2 同类

- `TCP_TW_RST`
- `TCP_TW_ACK`
- `TCP_TW_SUCCESS`
- 其他头文件 enum 常量，例如 `TCP_ESTABLISHED`

### 6.3 不能误报

- `struct` 成员 `has_rxtstamp` 不能因为 enum 规则被当成全局
- 局部变量 `rt` / `daddr` 不能变全局
- 参数 `net` 不能变全局
- 同名 struct 成员与 enum 常量同名时，普通点击应返回 enum；成员访问 `obj.x` 仍走成员分支

### 6.4 匿名枚举

```c
enum {
    ANON_A = 1,
    ANON_B = 2
};
```

- 点击 `ANON_A` 返回 enum_member
- parent 为空也正常

### 6.5 回归

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

## 7. 实施阶段

### Phase 1：统一 helper

- 新增 `isGloballyVisibleSymbol`
- 替换 `findDefinition` 三处
- 替换 `findDefinitionGeneric`
- 保留文件级 static 逻辑

### Phase 2：审计

- 全局搜索 `!s.parent` / `if (s.parent)` / `.parent` 过滤
- 区分：
  - 可见性过滤 → 用 helper
  - 成员/局部过滤 → 保持
  - 文件级 static → 保持

### Phase 3：测试

- enum 常量
- 匿名 enum
- 同名成员/枚举
- 现有局部变量/成员回归

---

## 8. 明确不做

- 不把所有 `parent` 符号都当全局（会泄漏 struct 成员/局部变量）
- 不修改索引格式
- 不重写 `findDefinition`
- 不同时做 C++ `enum class` 作用域（需要额外元数据）
- 不改 UI/Monaco/DSH

---

## 9. 验收标准

1. `TCP_TW_SYN` 在 `tcp_ipv4.c:2158`、`tcp_minisocks.c:226` 正确解析。
2. 其他 `TCP_TW_*` 枚举常量正确。
3. `has_rxtstamp` 仍然按成员解析，不被全局规则误报。
4. `rt` / `daddr` / `net` / `errno` 回归不变。
5. 全局过滤逻辑统一调用一个 helper，不再散落 `!s.parent`。
6. 匿名枚举可用。
7. 文件级 static 不被错误提升为跨文件全局。
