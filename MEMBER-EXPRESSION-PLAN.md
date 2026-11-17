# SourceLook 成员/类型解析系统化方案

## 0. 文档目的

这份文档给接手优化的 AI 使用。

目标不是再补一个“数组下标”正则，而是把 **C 成员访问的类型推导**做成一个小而完整的子系统，覆盖：

- `arr[i].field`
- `ptr[i].field`
- `(*ptr).field`
- `foo()->field`
- `(struct foo *)p->field`
- `a.b.c[i].d`
- 常见返回结构体指针的宏

当前版本：**1.5.73**。

---

## 1. 当前问题

### 1.1 现象

点击：

```c
err = icmp_err_convert[code].errno;
```

定义区显示“未解析”。

### 1.2 根因

- `icmp_err_convert` 是：

```c
include/net/icmp.h:28
extern const struct icmp_err icmp_err_convert[];
```

- `errno` 是 `struct icmp_err` 的成员，定义在：

```c
include/net/icmp.h:24
```

但旧的类型推导先取了表达式末尾标识符：

```c
icmp_err_convert[code]
```

错误地取到 `code`，按 `int` 去找 `errno`，所以找不到。

### 1.3 已经做的修复

`host/fs-service.js` 的 `baseTypeOfExpr()` 现在会先剥离末尾数组下标：

```js
for (let guard = 0; guard < 4; guard += 1) {
  const next = s.replace(/\s*\[[^\]]*\]\s*$/u, '').trim();
  if (next === s) break;
  s = next;
}
```

结果：

```text
errno @ net/ipv4/tcp_ipv4.c:572
-> member @ include/net/icmp.h:24 / icmp_err
```

`raw.c:267` 同样通过。`rt` / `daddr` / `net` 回归不变。

这个修复是正确的，但它只处理了“接收者末尾是数组下标”这一种形态。

---

## 2. 为什么这是“一类问题”

`baseTypeOfExpr()` 目前是文本 + 正则推导，已经处理：

- 函数调用返回类型
- `->` / `.` 成员链
- cast
- 指针/取地址
- 括号

但还未系统覆盖：

| 表达式 | 需要的能力 |
|---|---|
| `arr[i].field` | 数组元素类型 |
| `arr[i][j].field` | 多维数组 |
| `ptr[i].field` | 指针下标 |
| `(*ptr).field` | 显式解引用 |
| `foo()->field` | 调用返回指针 |
| `(struct foo *)p->field` | cast 优先级 |
| `a.b.c[i].d` | 混合链 |
| `container_of(...)->field` | 宏返回类型 |
| `rcu_dereference(...)->field` | 宏返回类型 |
| `skb_shinfo(skb)->field` | 宏/函数返回指针 |
| `&arr[i]`、`*p` | 取址/解引用 |

每遇到一种就补一个正则，会继续反复出问题。

---

## 3. 当前架构与不一致点

相关代码：

```text
host/fs-service.js
  receiverExprAt()      文本截取 . / -> 左侧表达式
  baseTypeOfExpr()      文本/正则推导类型
  baseTypeName()        去 qualifier/指针/数组，取基类型
  memberPathBase()      成员链
  findDefinition()      成员分支：receiverExprAt + baseTypeOfExpr + mapSymbols

host/local-scope.js
  lookup / query / enqueue / invalidate / clear

host/local-scope-worker.js
  buildScope()          生成函数/块/局部声明（含 type）
```

不一致点：

1. 局部变量定义解析已经走 AST local scope；
2. 但成员接收者的类型仍走文本 `baseTypeOfExpr`；
3. 全局符号类型走索引 `mapSymbols`；
4. 宏返回类型靠宏体 cast 猜测；
5. 表达式语法解析不完整。

需要统一，而不是继续给 `baseTypeOfExpr` 加分支。

---

## 4. 目标设计

### 4.1 归一化表达式树

不要序列化 tree-sitter AST；在 worker 中把成员访问归一成简单 JSON。

示例：

```json
{
  "kind": "member",
  "operator": ".",
  "member": "errno",
  "base": {
    "kind": "subscript",
    "base": { "kind": "identifier", "name": "icmp_err_convert" },
    "index": { "kind": "identifier", "name": "code" }
  }
}
```

支持的 shape：

```ts
type ExprShape =
  | { kind: 'identifier'; name: string }
  | { kind: 'member'; operator: '.' | '->'; member: string; base: ExprShape }
  | { kind: 'subscript'; base: ExprShape; index?: ExprShape }
  | { kind: 'call'; function: string; args?: ExprShape[] }
  | { kind: 'cast'; type: string; value: ExprShape }
  | { kind: 'pointer'; operator: '*' | '&'; value: ExprShape }
  | { kind: 'parenthesized'; value: ExprShape }
  | { kind: 'unknown'; text: string };
```

约束：

- 只返回普通对象/字符串
- 不返回 node/tree
- 无法解析的节点用 `unknown`，Host 回退文本解析

### 4.2 成员访问表

在 `local-scope-worker.js` 构建 scope 时，同时遍历所有 `field_expression`，生成：

```json
{
  "members": [
    {
      "name": "errno",
      "line": 572,
      "column": 35,
      "endColumn": 40,
      "operator": ".",
      "shape": { ... }
    }
  ]
}
```

点击位置匹配：

- `line === clickLine`
- `column <= clickColumn <= endColumn`
- 多个嵌套时取范围最小/最内层

这样不需要第二次 worker 查询，也不需要把 AST 留在 worker。

### 4.3 类型解析规则

新增 Host 端：

```js
resolveShapeType(shape, context) -> string
resolveIdentifierType(name, context) -> string
resolveMemberType(baseType, name) -> string
elementTypeOf(typeText) -> string
```

`context` 包含：

- `scope`：当前文件 `localScope.lookup(rel)` 结果
- `rel`
- `line`
- `pool`
- `d`

规则：

1. `identifier`
   - 当前函数 AST local scope 的变量/参数类型
   - 当前文件全局变量/函数
   - 全局索引变量/函数
   - 宏（按宏体 cast / 返回值）
2. `subscript`
   - 解析 base 类型
   - 去掉一层数组或指针（`elementTypeOf`）
3. `member`
   - 解析 base 类型
   - `->` 先解一层指针
   - 在 `mapSymbols` 中按 `parent=baseType` 查成员
   - 找不到再尝试 `memberFromTypeText`
4. `call`
   - 函数返回类型
   - 宏：宏体 cast / 已知返回类型
5. `cast`
   - 使用 cast 中的类型
6. `pointer`
   - `*` 解一层，`&` 加一层
7. `parenthesized`
   - 解析内部
8. `unknown`
   - 返回空，让调用方回退文本 `baseTypeOfExpr`

### 4.4 与现有 local scope 的关系

当前 `local-scope.js` 的声明已经带 `type`：

```json
{
  "name": "rt",
  "kind": "variable",
  "type": "struct rtable *",
  "line": 217,
  "blockId": 3,
  "functionId": 1
}
```

类型解析优先用它，而不是 `mapSymbols` 猜测局部变量类型。

---

## 5. 数据与协议改动

### 5.1 worker 输出扩展

`local-scope-worker.js` 的 `buildScope()` 增加：

```js
return { file: rel, functions, blocks, declarations, members };
```

`members` 可为空数组；老缓存没有该字段时视为 `[]`。

### 5.2 缓存 schema

`local-scope.js` 内存缓存条目已有 `version`；无需磁盘迁移。

注意：

- 解析表变大，`CACHE_LIMIT=24` 可保留，但建议评估内存
- 单文件 `members` 超过上限（例如 20000）时停止收集，保留 fallback
- 文件 > `DEFAULT_MAX_BYTES`（1MB）不建 AST，继续文本 fallback

### 5.3 不需要新的 worker 消息类型

第一阶段直接随 `build` 返回 `members`。

如果后续 members 太多/需要按需查询，再增加 `memberAt` 消息；本轮不必。

---

## 6. Host 接入

### 6.1 `findDefinition` 成员分支

当前大致：

```js
const expr = receiverExprAt(...);
const base = await baseTypeOfExpr(...);
const members = mapSymbols(...);
```

改为：

```js
const scope = await localScope.lookup(rel); // 只读缓存
const memberInfo = findMemberAt(scope, line, column);
const expr = memberInfo ? memberInfo.shape : receiverExprAt(...);

let base = '';
if (memberInfo && scope) {
  base = await resolveShapeType(memberInfo.shape, context);
}
if (base === '') {
  base = await baseTypeOfExpr(d, expr, rel, line, pool, 0); // fallback
}
```

要求：

- AST 不可用 → 仍走现有文本逻辑
- AST 可用但 shape 解析失败 → 文本 fallback
- **不要**在成员分支里再全文件扫描

### 6.2 点击位置匹配

`findMemberAt(scope, line, column)`：

- 过滤 `line === clickLine`
- `column <= clickColumn <= endColumn`
- 多个候选按 `endColumn - column` 最小
- 嵌套成员访问时选最内层字段（click 在 `errno` 上，不是外层）

### 6.3 类型来源优先级

1. 当前函数 AST local scope（变量/参数）
2. 当前文件全局 AST/索引
3. 全局索引
4. 宏表
5. 文本 fallback

---

## 7. 覆盖规则

### 7.1 数组/指针

```c
arr[i].field          -> elementType(arr)
ptr[i].field          -> elementType(ptr)
arr[i][j].field       -> elementType(elementType(arr))
(*ptr).field          -> elementType(ptr)
```

`elementTypeOf`：

- 去掉一个末尾 `[...]`
- 或者去掉一个 `*`
- 保留 struct/union/enum 名称

### 7.2 调用

```c
foo()->field
```

- `foo` 是函数：返回类型
- `foo` 是宏：宏体 cast / 已知返回类型
- 返回 `struct foo *` → 解一层指针 → `foo`

### 7.3 cast

```c
(struct foo *)p->field
```

按 C 优先级，cast 作用于 `p->field` 还是 `p` 要看 AST，不要用正则猜。

### 7.4 宏

`container_of(...)`、`rcu_dereference(...)`、`skb_shinfo(...)` 等：

- 第一阶段可返回 `unknown`，走文本 fallback
- 第二阶段再按宏表/cast 规则扩展
- 不要为了这些宏一次性写死大量特例

---

## 8. 性能与缓存

- 解析仍在 `local-scope-worker`
- 主线程只做 shape 查询和类型查找
- `members` 随 scope 一起缓存
- 文件 mtime/size 变化 → `localScope.invalidate`
- 保存文件后已有失效逻辑
- 项目根切换 → `localScope.clear()`
- 大文件超过 1MB → 不做 AST，保持文本 fallback
- 不在 Host 主线程同步解析 AST

---

## 9. 测试

### 9.1 当前已知

| 文件 | 符号 | 行 | 期望 |
|---|---|---:|---|
| `net/ipv4/tcp_ipv4.c` | `errno` | 572 | `member @ include/net/icmp.h:24 / icmp_err` |
| `net/ipv4/raw.c` | `errno` | 267 | 同上 |
| `net/ipv4/tcp_ipv4.c` | `rt` | 241 | `variable @ 217` |
| `net/ipv4/tcp_ipv4.c` | `daddr` | 228 | `variable @ 215` |
| `net/ipv4/tcp_ipv4.c` | `net` | 104 | `parameter @ 104` |

### 9.2 新增表达式用例

构造临时 C 文件或找现有代码：

```c
struct foo { int field; };
struct foo arr[4];
struct foo *ptr;

void f(void) {
    arr[1].field;
    ptr[2].field;
    (*ptr).field;
    arr[1][2].field;
}
```

以及：

```c
struct bar *make_bar(void);
void g(void) {
    make_bar()->field;
}
```

### 9.3 反向用例

- 成员不存在 → 仍返回未解析，不能误报
- 非成员访问 → 不进入成员分支
- 表达式无法解析 → 文本 fallback 正常
- AST 解析失败 → 不崩溃
- 保存文件后缓存失效

### 9.4 回归

- `tmp/test-rt.cjs`
- `tmp/test-daddr.cjs`
- `tmp/test-net.cjs`
- `tmp/test-errno.cjs`（如果保留）
- `scripts/smoke-host.mjs`
- `scripts/smoke-index.cjs`
- `tmp/check-render.mjs`
- 手动：单击、双击、F12、Shift+F12、上下文定义卡

---

## 10. 实施阶段

### Phase 1：worker 收集成员访问

- 扩展 `local-scope-worker.js` 的 `buildScope`
- 增加 `members` 数组
- 归一化 `field_expression`
- 只支持 `identifier` / `member` / `subscript` / `parenthesized` / `cast`
- 加单测

### Phase 2：Host 类型解析

- `findMemberAt`
- `resolveShapeType`
- `resolveIdentifierType`
- `resolveMemberType`
- `elementTypeOf`
- 接入 `findDefinition` 成员分支
- 文本 fallback 保留

### Phase 3：调用/宏/边界

- `call_expression`
- 常见宏返回类型
- 多维数组/函数指针
- 不支持的 shape 继续 fallback

---

## 11. 明确不做

- 不重写整个定义解析器
- 不改索引格式
- 不做完整 C 编译器类型系统
- 不同时做 C++
- 不删除文本 fallback
- 不在主线程解析 AST
- 不为每个宏写一个硬编码特例

---

## 12. 验收标准

1. `errno` 在 `tcp_ipv4.c:572`、`raw.c:267` 正确解析。
2. `arr[i].field`、`ptr[i].field`、`(*ptr).field` 正确。
3. `foo()->field` 在函数返回类型可用时正确。
4. AST 不可用或 shape 解析失败时，原有文本解析仍能工作。
5. 缓存命中时无全文件文本扫描。
6. 成员不存在时仍显示“未解析”，不误报。
7. `rt` / `daddr` / `net` 等现有局部变量回归不变。
8. `findDefinition` 在缓存命中时无明显额外延迟。
