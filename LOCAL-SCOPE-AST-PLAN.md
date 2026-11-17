# SourceLook 局部变量作用域解析方案（C / AST）

## 1. 目标

用 tree-sitter AST 替换当前“向上文本扫描”的局部变量解析，使点击一个 C 局部变量/参数时，稳定返回**当前作用域内最近的前置声明**。

目标行为：

- `tcp_v4_connect` 里的 `rt` → `tcp_ipv4.c:217` 的局部变量
- 函数参数 → 参数声明
- 嵌套块内变量 → 块内声明
- 已经关闭的兄弟块里的同名变量 → 不返回
- `for (int i = ...)` 的 `i` → 循环作用域内有效，循环外无效
- 找不到 AST 或解析失败 → 回退到现有文本扫描
- 首次点击不阻塞 UI；后台解析完成后，后续点击走 AST

只做 **C**。C++ 可以后续扩展，但不要在本轮顺手改。

---

## 2. 当前代码与问题

### 2.1 插件位置

```
C:\Users\luban\Documents\deepseek-harness\default-workspace\SourceLook
```

### 2.2 当前局部变量解析

`host/fs-service.js`：

- `stripCNoise()`：去注释/字符串
- `functionBodyAt()`：找点击所在函数
- `localDeclarationInFile()`：从点击行向上扫描声明
- `findDefinition()` 中 “3) 局部变量 / 参数” 分支：

```js
if (rel !== '' && line > 0) {
  const local = await localDeclarationInFile(d, rel, want, line, pool);
  if (local !== null) return result([{ ...local, scope: 'local' }]);
}
```

当前实现是**文本启发式**：

- 能处理常见的函数顶部声明
- 已能穿过嵌套 `if` 块
- 已能跳过已关闭的兄弟块
- 但仍是 O(文件大小) 的文本扫描
- 多声明、for 初始化、函数指针、C++、复杂宏等仍可能出错
- 每次点击都要读文件 + 扫描

### 2.3 已有 tree-sitter 能力

- `host/ts-indexer.js`
  - 已加载 C grammar
  - `extract(text, rel)` 能返回局部变量/参数，带 `parent`、`type`
  - 但 `extract` 是同步的，使用全局语言表，不适合在 Host 主线程为每次点击调用
- `host/index-pool.js`
  - 已有 worker_threads 并行解析索引的参考实现
- `vendor/tree-sitter/tree-sitter-c.wasm`
- `renderer-lib/lang/registry.js`
  - 语言 → grammar 的映射

**不要**在 Host 主线程直接调用 `tsIndex.extract()` 做点击查询；会阻塞其他请求。

---

## 3. 总体架构

```
点击 C 标识符
   │
   ▼
findDefinition()
   │
   ├─ 有 AST local scope cache ──► queryLocalScope() 直接返回
   │
   └─ 无 cache
         ├─ localDeclarationInFile() 立即兜底返回
         └─ 后台 enqueue local-scope worker
                    │
                    ▼
             解析 AST，生成 LocalFileScope
                    │
                    ▼
             写入 LRU cache
                    │
                    ▼
             后续点击使用 AST
```

### 原则

- AST 是主路径
- 文本扫描只做 fallback
- 首次点击不等待 AST
- 文件变更后缓存失效
- worker 崩溃/超时不影响功能

---

## 4. 数据模型

每个文件生成一份可序列化的 `LocalFileScope`：

```ts
type LocalFileScope = {
  file: string;          // rel path
  version: string;       // mtimeMs:size
  functions: FunctionScope[];
  blocks: BlockScope[];
  declarations: Declaration[];
};

type FunctionScope = {
  id: number;
  name: string;
  startLine: number;     // 签名起始行，1-based
  endLine: number;       // 函数结束行
  bodyBlockId: number;   // 函数体 compound_statement 的 block id
};

type BlockScope = {
  id: number;
  parentId: number | null;   // 父块，函数体 parent=null
  functionId: number;
  startLine: number;
  endLine: number;
};

type Declaration = {
  name: string;
  kind: 'variable' | 'parameter' | 'for_variable' | 'local_typedef';
  type: string;          // 例如 "struct rtable *"
  line: number;          // 1-based
  column: number;        // 1-based
  startOffset: number;   // 文件内字符偏移，用于比较先后
  blockId: number;
  functionId: number;
};
```

约束：

- 只返回普通对象/数组/数字/字符串
- **不要**返回 tree-sitter 的 Tree/Node
- 行号、列号统一 1-based
- 列号对 UTF-8 多字节字符可能不精确；内核 C 基本 ASCII，可接受；有 offset 时优先 offset

---

## 5. Worker 设计

### 5.1 新文件

```
host/local-scope-worker.js
```

CommonJS（`host/package.json` 已设置 CJS）。

职责：

- 自己加载 tree-sitter 运行时和 C grammar
- 接收 `{ id, rel, text }`
- 解析 AST
- 返回 `{ id, ok, scope }`
- 不访问项目文件；文本由主线程读取后传入，避免 worker 再做路径/权限判断

### 5.2 消息协议

主 → worker：

```json
{ "id": 1, "rel": "net/ipv4/tcp_ipv4.c", "text": "..." }
```

worker → 主：

```json
{ "id": 1, "ok": true, "scope": { ... } }
```

失败：

```json
{ "id": 1, "ok": false, "error": "parse failed" }
```

### 5.3 生命周期

- 懒启动，最多 1～2 个 worker
- 同一文件只允许一个 in-flight 解析
- 超时 5 秒
- worker `error` / `exit` 时：
  - 清空 in-flight
  - 记录一次错误
  - 下次点击回退文本扫描
  - 可重建 worker，但不要无限重启
- 插件 dispose 时 `worker.terminate()`
- **不要**让 worker 阻止 Host 退出

---

## 6. AST 遍历规则（C）

使用 `tree-sitter-c`。

### 6.1 函数

节点：`function_definition`

- 函数名：`declarator` 下的 `identifier` / `function_declarator`
- 函数体：`body`（`compound_statement`）
- 签名起始行：函数定义起始行
- 结束行：函数体 `}`

为函数体创建一个 `BlockScope(parentId=null, functionId=fn)`。

### 6.2 代码块

节点：`compound_statement`

- 每个 `{...}` 对应一个 BlockScope
- 父子关系按 AST 包含关系
- 函数体是最外层 block
- 嵌套 `if/for/while/switch/do` 的 compound_statement 都是子 block

### 6.3 声明

节点：`declaration`

从 `declaration` 中提取：

- 类型：`type` 字段/`type_identifier`/`struct_specifier`/`primitive_type` 等
- 声明符：`declarator`、`init_declarator`、`pointer_declarator`、`array_declarator`
- 名字：声明符内的 `identifier`

需要支持：

- `struct rtable *rt;`
- `int err;`
- `int a, b;`
- `struct foo *a, *b;`
- `int arr[4];`
- `char *p = NULL;`
- `static int x;`
- `for (int i = 0; ...)`（见 6.5）

不支持的复杂 declarator 可以跳过，交给文本 fallback，不要阻塞。

### 6.4 参数

节点：`parameter_list` / `parameter_declaration`

- 每个参数名写入 `Declaration(kind='parameter')`
- blockId = 函数体 block
- functionId = 当前函数
- startOffset = 参数名字符位置

### 6.5 for 初始化声明

节点：`for_statement`

- 如果 `initializer` 是 `declaration`，其中变量只在 `for` 语句范围内有效
- 为 `for_statement` 建一个合成 BlockScope：
  - startLine = for 起始行
  - endLine = for 语句结束行
  - parentId = 当前 block
- 把初始化声明放入该合成 block
- `for` 循环体 compound_statement 的 parent 指向这个合成 block

### 6.6 其他

- `local_typedef` 可以记录为 kind=`local_typedef`，点击类型时可用；不做也行
- `#define` 不当作局部变量
- 宏展开后的代码不解析
- `#if/#ifdef` 分支：tree-sitter 会保留 preproc 节点；局部作用域可能近似；无法确定时 fallback 文本扫描

---

## 7. 缓存设计

### 7.1 位置

Host `fs-service.js` 内模块级：

```js
const LOCAL_SCOPE_CACHE = new Map();
const LOCAL_SCOPE_LIMIT = 24;
```

### 7.2 Key / 失效

Key 用：

```
rel
```

缓存值：

```js
{
  version: `${mtimeMs}:${size}`,
  scope,
  parsedAt
}
```

每次查询前：

1. `fs.stat` 当前文件
2. 比较 `mtimeMs:size`
3. 不一致 → 删除旧缓存，重新后台解析

主动失效：

- `writeFile()` 成功保存后删除该 rel
- `setProjectRoot()` 时清空
- 文件删除/重命名时删除

### 7.3 LRU

- 最多 24 个文件
- 超限删除最久未使用
- 不要缓存超大文件（例如 > 2MB，直接 fallback）

---

## 8. 查询算法

函数：

```js
function queryLocalScope(scope, name, line, column)
```

步骤：

1. 找到点击位置所在的最内层 block
   - `block.startLine <= line <= block.endLine`
   - 多个取 startLine/endLine 最紧的
2. 沿 `parentId` 向上遍历 block 链，直到 null
3. 对每个 block：
   - 找 `declarations` 中：
     - `blockId === block.id`
     - 名字相同
     - `startOffset < clickOffset`
   - 取 `startOffset` 最大（最近前置）的那个
   - 找到立即返回
4. 当前 block 没有，再检查函数参数
5. 都没有 → 返回 null，交给文本 fallback

注意事项：

- 内层块声明遮蔽外层，所以从内向外找
- 只有当前 block 链上的声明才有效，兄弟块声明不在链上
- 同一行声明和点击：比较列/offset
- 函数参数属于函数体 block，但优先级低于函数体局部变量
- `for` 合成 block 的变量不会泄漏到循环外

---

## 9. Host 接入

### 9.1 `findDefinition` 局部分支

当前：

```js
if (rel !== '' && line > 0) {
  const local = await localDeclarationInFile(d, rel, want, line, pool);
  if (local !== null) return result([{ ...local, scope: 'local' }]);
}
```

改为：

```js
if (rel !== '' && line > 0) {
  const ast = lookupLocalScope(rel); // 只读缓存，不阻塞
  if (ast) {
    const hit = queryLocalScope(ast, want, line, column);
    if (hit) return result([{ ...hit, scope: 'local' }]);
  }

  // 缓存未命中或 AST 无结果：文本兜底
  const local = await localDeclarationInFile(d, rel, want, line, pool);
  if (local !== null) {
    enqueueLocalScopeBuild(rel); // 后台补 AST
    return result([{ ...local, scope: 'local' }]);
  }

  // 没找到也补一次，后续点击可用
  enqueueLocalScopeBuild(rel);
}
```

要求：

- `lookupLocalScope` 绝不等待 worker
- `enqueueLocalScopeBuild` 去重
- 后台完成后只写缓存，不主动改 UI
- worker 失败静默回退，不向用户报错

### 9.2 阅读文件时预热

推荐增加内部函数：

```js
warmLocalScope(rel)
```

由以下位置调用：

- 用户打开文件后（client 调 `/local-scope/warm`）
- 或 Host 的 `readFile()` 被主动打开时

不要把 `readFile()` 变成所有文件都解析；只对当前活动文件预热。

### 9.3 HTTP 路由

建议新增：

```
POST /api/sourcelook/local-scope/warm
body: { "path": "net/ipv4/tcp_ipv4.c" }
response: { ok: true, queued: true }
```

- 验证路径在项目内
- 只排队，不等待解析
- 老 Host 没有该路由时，client 忽略 404
- 这是可选优化；没有也能工作，只是首次点击会多一次文本兜底

---

## 10. Client 改动

只加一个很小的预热：

在 `src/client/80-app.js` 的 activePath 变化 effect 中：

```js
void api('/local-scope/warm', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ path: activePath }),
}, sessionRef.current).catch(() => { /* old host */ });
```

要求：

- fire-and-forget
- 400/404/超时都忽略
- 不改变 UI
- 不要阻塞文件打开

如果暂时不想改 client，第一阶段可以不做预热；Host 首次点击时后台补。

---

## 11. 文本 fallback

保留现有：

- `stripCNoise`
- `functionBodyAt`
- `localDeclarationInFile`

改名为：

```js
localDeclarationByText(...)
```

仅在以下情况调用：

- AST cache 不存在
- AST 解析中
- AST 解析失败/超时
- AST 查询无结果
- 文件超大，不建 AST

这样当前 1.5.72 的所有修复不会丢。

---

## 12. 性能目标

- 主线程不执行全文件 AST 解析
- 单次 `findDefinition` 在缓存命中的情况下 < 5ms
- 首次点击文本兜底不增加明显延迟
- 后台 AST 每文件只解析一次
- 24 个文件上限，避免内存无限增长
- 1MB 以上文件可跳过 AST，直接文本 fallback
- worker 并发限制 1～2

---

## 13. 测试清单

### 13.1 必测 C 用例

用 `D:\source_projects\linux-5.10.239`：

| 文件 | 符号 | 行 | 期望 |
|---|---|---:|---|
| `net/ipv4/tcp_ipv4.c` | `rt` | 241 | `variable @ 217 / tcp_v4_connect` |
| `net/ipv4/tcp_ipv4.c` | `daddr` | 228 | `variable @ 215 / tcp_v4_connect` |
| `net/ipv4/tcp_ipv4.c` | `net` | 104 | `parameter @ 104 / tcp_v4_init_ts_off` |
| `net/ipv4/tcp_ipv4.c` | `daddr` | 232 | `variable @ 215 / tcp_v4_connect` |

### 13.2 嵌套块用例

构造或找：

```c
int f(void) {
    int outer;
    if (1) { int inner; inner = 1; }
    outer = 2;
    return outer;
}
```

- `inner` 在块内 → 块内声明
- `inner` 在块外 → 不返回该局部变量
- `outer` 在块内/块外 → 函数顶部声明

### 13.3 参数/for

- 函数参数
- 多行签名
- `for (int i = 0; ...)` 内 `i` 有效，循环外无效
- 一条语句多个声明：`int a, b;`
- 指针/数组：`struct foo *p; int a[4];`

### 13.4 fallback

- worker 不可用 → 文本 fallback 仍返回
- AST 解析失败 → 不报错
- 缓存过期 → 重新解析
- 文件修改后保存 → 旧缓存失效

### 13.5 回归

- `tmp/test-rt.cjs`
- `tmp/test-daddr.cjs`
- `tmp/test-net.cjs`
- `scripts/smoke-host.mjs`
- `scripts/smoke-index.cjs`
- 客户端 `tmp/check-render.mjs`
- 手动：单击、双击、右键、F12、Shift+F12、上下文三卡、P/C/D 切换

---

## 14. 实施阶段

### Phase 1：worker + AST 表

- 新增 `host/local-scope-worker.js`
- 实现 C AST 遍历
- 输出 `LocalFileScope`
- 单文件测试：`tcp_ipv4.c` 的 `rt`

### Phase 2：Host 缓存/查询

- `LOCAL_SCOPE_CACHE`
- `lookupLocalScope`
- `queryLocalScope`
- `enqueueLocalScopeBuild`
- `findDefinition` 接入
- 文本 fallback

### Phase 3：预热

- `/local-scope/warm` 路由（可选）
- client activePath fire-and-forget（可选）

### Phase 4：测试与性能

- 上述测试清单
- 首次/二次点击耗时
- 主线程无阻塞

---

## 15. 明确不做

- 不改索引格式
- 不把局部符号写入 `.crdb`
- 不改 Monaco / UI 布局
- 不改 DSH
- 不同时做 C++/Rust/Go
- 不删除现有文本 fallback
- 不让 worker 阻止 Host 退出
- 不在主线程同步解析大文件

---

## 16. 验收标准

1. `rt`、`daddr`、`net` 等现有用例结果正确。
2. 嵌套块外的变量不再返回块内声明。
3. 参数、`for` 变量、多声明符在支持范围内正确。
4. 首次点击不因 AST 解析阻塞。
5. 缓存命中时无全文件扫描。
6. worker 失败时功能自动降级，不出现空白/报错。
7. 现有定义、引用、索引、上下文窗口无回归。
