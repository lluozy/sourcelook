'use strict';
/*
 * kernel-macros - what the Linux kernel's house macros MEAN (SPEC F1.16 坑 2).
 *
 * WHY A TABLE IS NEEDED. `preproc_function_def` already tells the parser that
 * `likely` is a macro rather than a function, which is more than cscope knows.
 * But that only helps the macro's OWN name. The interesting information is in
 * the ARGUMENTS, and arguments are just identifiers to a parser:
 *
 *     LIST_HEAD(my_list);                    -> `my_list` is a new SYMBOL
 *     DEFINE_MUTEX(foo_lock);                -> `foo_lock` is a new SYMBOL
 *     container_of(p, struct task, pid)      -> `task` and `pid` are a TYPE
 *                                               and one of its MEMBERS
 *     EXPORT_SYMBOL(foo);                    -> `foo` is a REFERENCE
 *     module_init(my_driver_init);           -> `my_driver_init` is a REFERENCE
 *
 * None of that is visible in the syntax tree, and none of it is visible to a
 * lexical scanner either. It is knowledge about the kernel, so it is written
 * down as knowledge about the kernel.
 *
 * SCOPE. This is deliberately not exhaustive - a complete list would be a
 * maintenance burden with little return. It covers the macros that account for
 * the overwhelming majority of real occurrences. Anything missing degrades to
 * plain parsing, which is exactly what cscope would have done anyway.
 */

/* ------------------------------------------------------------- the table

   Each entry says how to read the macro's ARGUMENTS (0-based):

     decl      index of the argument that NAMES A NEW SYMBOL
     declKind  what kind of symbol it is
     declType  its type, when the macro implies one
     typeArg   index of an argument that names a TYPE
     member    index of an argument that names a MEMBER of `typeArg`'s type
     memberOf  index of an argument that names the object `member` belongs to
     ref       indices of arguments that REFERENCE existing symbols

   A macro may have several of these (DEFINE_PER_CPU names a symbol AND takes a
   type); nothing here is exclusive. */

const MACROS = new Map();
const def = (name, spec) => MACROS.set(name, spec);

/* ---- declaration macros: the argument becomes a NEW symbol ---- */

def('LIST_HEAD', { decl: 0, declKind: 'variable', declType: 'struct list_head' });
def('LIST_HEAD_INIT', { ref: [0] });
def('DEFINE_MUTEX', { decl: 0, declKind: 'variable', declType: 'struct mutex' });
def('DEFINE_SPINLOCK', { decl: 0, declKind: 'variable', declType: 'spinlock_t' });
def('DEFINE_RWLOCK', { decl: 0, declKind: 'variable', declType: 'rwlock_t' });
def('DEFINE_SEMAPHORE', { decl: 0, declKind: 'variable', declType: 'struct semaphore' });
/* 2026-10-22 审计：`DECLARE_MUTEX` / `DECLARE_BITMAP_ATOMIC` / `DEFINE_RADIX_TREE` /
   `DEFINE_STATIC_KEY_MAYBE` 在现代内核里已经不存在（全树 grep 无此 `#define`），
   留着只会让"内置知识"看起来比实际多。命中永远是 0，删掉。 */
def('DECLARE_WAIT_QUEUE_HEAD', { decl: 0, declKind: 'variable', declType: 'wait_queue_head_t' });
def('DECLARE_COMPLETION', { decl: 0, declKind: 'variable', declType: 'struct completion' });
def('DECLARE_COMPLETION_ONSTACK', { decl: 0, declKind: 'variable', declType: 'struct completion' });
def('DECLARE_BITMAP', { decl: 0, declKind: 'variable', declType: 'unsigned long[]' });
def('DECLARE_FLEX_ARRAY', { decl: 0, declKind: 'member' });
def('DECLARE_KFIFO', { decl: 0, declKind: 'variable', declType: 'struct kfifo' });
def('DECLARE_KFIFO_PTR', { decl: 0, declKind: 'variable', declType: 'struct kfifo' });
def('DEFINE_KFIFO', { decl: 0, declKind: 'variable', declType: 'struct kfifo' });
def('DEFINE_STATIC_KEY_TRUE', { decl: 0, declKind: 'variable', declType: 'struct static_key_true' });
def('DEFINE_STATIC_KEY_FALSE', { decl: 0, declKind: 'variable', declType: 'struct static_key_false' });
def('DEFINE_IDA', { decl: 0, declKind: 'variable', declType: 'struct ida' });
def('DEFINE_IDR', { decl: 0, declKind: 'variable', declType: 'struct idr' });
def('DEFINE_XARRAY', { decl: 0, declKind: 'variable', declType: 'struct xarray' });
def('DEFINE_XARRAY_ALLOC', { decl: 0, declKind: 'variable', declType: 'struct xarray' });

def('DEFINE_SEQLOCK', { decl: 0, declKind: 'variable', declType: 'seqlock_t' });
def('DEFINE_WW_CLASS', { decl: 1, declKind: 'variable', declType: 'struct lock_class' });
def('DEFINE_PER_CPU', { decl: 1, declKind: 'variable', declType: 'per-cpu', typeArg: 0 });
def('DEFINE_PER_CPU_SECTION', { decl: 1, declKind: 'variable', declType: 'per-cpu', typeArg: 0 });
def('DECLARE_PER_CPU', { decl: 1, declKind: 'variable', declType: 'per-cpu', typeArg: 0 });
/* per-cpu 的其它变体（2026-11-16）。它们的宏体最终都落到
   `*_PER_CPU_SECTION(type, name, sec)`，参数位一致：类型在 0、名字在 1。
   少一个变体，整类变量就零定义 —— 实测 `DECLARE_PER_CPU_SHARED_ALIGNED(
   struct tlb_state, cpu_tlbstate)` 在 arch/x86/include/asm/tlbflush.h:154，
   文件、结构体、宏名全在索引里，唯独 `cpu_tlbstate` 查不到（几十处引用悬空）。 */
def('DECLARE_PER_CPU_ALIGNED', { decl: 1, declKind: 'variable', declType: 'per-cpu', typeArg: 0 });
def('DECLARE_PER_CPU_SHARED_ALIGNED', { decl: 1, declKind: 'variable', declType: 'per-cpu', typeArg: 0 });
def('DECLARE_PER_CPU_READ_MOSTLY', { decl: 1, declKind: 'variable', declType: 'per-cpu', typeArg: 0 });
def('DECLARE_PER_CPU_SECTION', { decl: 1, declKind: 'variable', declType: 'per-cpu', typeArg: 0 });
def('DECLARE_PER_CPU_PAGE_ALIGNED', { decl: 1, declKind: 'variable', declType: 'per-cpu', typeArg: 0 });
def('DEFINE_PER_CPU_ALIGNED', { decl: 1, declKind: 'variable', declType: 'per-cpu', typeArg: 0 });
def('DEFINE_PER_CPU_SHARED_ALIGNED', { decl: 1, declKind: 'variable', declType: 'per-cpu', typeArg: 0 });
def('DEFINE_PER_CPU_READ_MOSTLY', { decl: 1, declKind: 'variable', declType: 'per-cpu', typeArg: 0 });
def('DEFINE_PER_CPU_PAGE_ALIGNED', { decl: 1, declKind: 'variable', declType: 'per-cpu', typeArg: 0 });
/* 这三个宏**不**造 `__name` 这个符号，而是拼出两个：

     DEFINE_SHOW_ATTRIBUTE(foo)  →  static int foo_open(...);
                                    static const struct file_operations foo_fops = {...};

   以前写成 `decl: 0` 造出一个叫 `foo` 的**幽灵函数**（没有类型、源码里也不存在），
   点进去只能看到 `#define` 那一行（2026-10-22 审计发现）。 */
def('DEFINE_SHOW_ATTRIBUTE', {
  declare: [
    { pattern: '$0_fops', kind: 'variable', type: 'struct file_operations' },
    { pattern: '$0_open', kind: 'function', type: 'int' }
  ]
});
/* 2026-10-23 补的三条：它们在内核里合计约 1,200 处，以前全落在"未看懂"台账里。
   `DECLARE_TLV_DB_SCALE(name, …)` → `unsigned int name[]`（ALSA 音量表）
   `MESON_GATE(_name, …)`        → `struct clk_regmap _name`（amlogic 时钟门）
   `MACHINE_START(_type, _name)` → `__mach_desc_##_type`（arm/arc 机器描述） */
def('DECLARE_TLV_DB_SCALE', {
  declare: [{ arg: 0, kind: 'variable', type: 'unsigned int' }]
});
def('MESON_GATE', {
  declare: [{ arg: 0, kind: 'variable', type: 'struct clk_regmap' }]
});
def('MACHINE_START', {
  declare: [{ pattern: '__mach_desc_$0', kind: 'variable', type: 'struct machine_desc' }]
});

def('DEFINE_SEQ_ATTRIBUTE', {
  declare: [
    { pattern: '$0_fops', kind: 'variable', type: 'struct file_operations' },
    { pattern: '$0_open', kind: 'function', type: 'int' }
  ]
});
def('DEFINE_PROC_SHOW_ATTRIBUTE', {
  declare: [
    { pattern: '$0_proc_ops', kind: 'variable', type: 'struct proc_ops' },
    { pattern: '$0_open', kind: 'function', type: 'int' }
  ]
});
/* 这两个的 arg0 **就是** fops 本身，写法是对的，只是补上类型。 */
def('DEFINE_DEBUGFS_ATTRIBUTE', { decl: 0, declKind: 'variable', declType: 'struct file_operations' });
def('DEFINE_SIMPLE_ATTRIBUTE', { decl: 0, declKind: 'variable', declType: 'struct file_operations' });

/* ---- container macros: a TYPE argument and a MEMBER of it ----

   `container_of(ptr, struct task_struct, pid)` is why this file exists: the
   member `pid` belongs to `struct task_struct`, and neither an AST nor cscope
   can infer that from the call alone. */

const CONTAINER = ['container_of', 'container_of_const',
  'list_entry', 'list_first_entry', 'list_last_entry', 'list_next_entry',
  'list_prev_entry', 'list_first_entry_or_null', 'list_next_entry_circular',
  'list_prev_entry_circular', 'hlist_entry', 'hlist_entry_safe',
  'rb_entry', 'rb_entry_safe', 'xa_entry', 'page_zone'];
for (const n of CONTAINER) def(n, { typeArg: 1, member: 2 });

/* ---- registration macros: the arguments REFERENCE existing symbols ---- */

const INITCALL = ['module_init', 'module_exit',
  'early_initcall', 'core_initcall', 'postcore_initcall', 'arch_initcall',
  'subsys_initcall', 'fs_initcall', 'rootfs_initcall', 'device_initcall',
  'late_initcall', 'late_initcall_sync', '__initcall', 'console_initcall'];
/* `refAs` 是"被登记成什么"：报告和引用区用它区分 导出 / 入口 / 参数。 */
for (const n of INITCALL) def(n, { ref: [0], refAs: 'entry' });

const EXPORTS = ['EXPORT_SYMBOL', 'EXPORT_SYMBOL_GPL', 'EXPORT_SYMBOL_NS',
  'EXPORT_SYMBOL_NS_GPL', 'EXPORT_SYMBOL_FOR_TESTS_ONLY',
  'EXPORT_UNUSED_SYMBOL', 'EXPORT_UNUSED_SYMBOL_GPL'];
for (const n of EXPORTS) def(n, { ref: [0], refAs: 'exported' });

const PARAMS = ['__setup', 'early_param', 'core_param', 'module_param',
  'module_param_named', 'module_param_cb', 'MODULE_PARM_DESC'];
for (const n of PARAMS) def(n, { ref: [0] });

/* ---- tracepoint 生成的名字 ----
 *
 * 规则是**按宏名命中**的普通规则，不判断项目：任何代码里出现这些宏，都按同一
 * 语义读它的参数。写得出来的场景是 Linux 内核的 tracepoint 机制
 * （include/trace/events 下的头文件与 kernel 各子目录的导出点），但规则本身
 * 不认"内核"这个身份 —— 别的项目即便自己定义了同名宏，也走同一条路。
 *
 * 为什么需要它：`DEFINE_TRACE(name, …)` 展开出的是 `__tracepoint_##name`，
 * 名字在源码里**只作为宏参数出现过一次**。没有这条规则，6 万多次引用全部指向
 * 一个"源码中不存在"的符号（2026-11-16 审计剩下的 11 个就是它们）。
 *
 * 参数位：`DECLARE_TRACE` / `DEFINE_TRACE` / `TRACE_EVENT*` 名字在 0；
 * `DEFINE_EVENT*` 是 `(template, name, proto, args)`，名字在 1。
 * 导出宏只登记引用，不造符号。 */
const TP_NAME_AT_0 = ['DECLARE_TRACE', 'DEFINE_TRACE',
  'TRACE_EVENT', 'TRACE_EVENT_FN', 'TRACE_EVENT_CONDITION',
  'TRACE_EVENT_FN_CONDITION'];
for (const n of TP_NAME_AT_0) {
  def(n, {
    decl: 0, declKind: 'variable', declType: 'struct tracepoint',
    note: 'tracepoint：名字由宏拼成 __tracepoint_<name>，源码里只有这一处字面量'
  });
}
const TP_NAME_AT_1 = ['DEFINE_EVENT', 'DEFINE_EVENT_FN', 'DEFINE_EVENT_PRINT',
  'DEFINE_EVENT_CONDITION', 'DEFINE_EVENT_FN_CONDITION'];
for (const n of TP_NAME_AT_1) {
  def(n, {
    decl: 1, declKind: 'variable', declType: 'struct tracepoint',
    note: 'tracepoint：第二个参数才是名字（第一个是 template）'
  });
}
for (const n of ['EXPORT_TRACEPOINT_SYMBOL', 'EXPORT_TRACEPOINT_SYMBOL_GPL']) {
  def(n, { ref: [0], refAs: 'exported', note: 'tracepoint 导出点：参数引用已声明的 tracepoint' });
}

/* `module_param_named(name, value, type, perm)` binds the user-visible `name`
   to the C variable `value`. */
def('module_param_named', { ref: [0, 1] });
def('module_param_string', { ref: [0, 2] });
def('module_param_array', { ref: [0, 3] });
def('module_param_array_named', { ref: [0, 1] });

/* ---- annotation / attribute macros ----

   Not symbols at all. Parsed as identifiers they become dozens of bogus
   "variables" in the tree - `__init`, `__user`, `__rcu` - which then show up
   in symbol searches and in the AI context. Filtered out wholesale. */

const ATTR = new Set([
  /* section / lifetime */
  '__init', '__exit', '__initdata', '__initconst', '__initconst_or_exit',
  '__exitdata', '__initdata_or_module', '__init_or_module', '__devexit',
  '__devinit', '__meminit', '__memexit', '__cpuinit', '__cpuexit',
  '__head', '__ref', '__read_mostly', '__ro_after_init', '__rodata',
  /* address-space annotations - the sparse ones */
  '__user', '__kernel', '__iomem', '__rcu', '__percpu', '__force', '__bitwise',
  '__nocast', '__safe', '__private', '__pgo',
  /* calling convention / optimisation */
  '__always_inline', '__inline', 'noinline', '__always_unused',
  '__maybe_unused', '__used', '__unused', '__cold', '__hot', '__pure',
  '__const', '__noreturn', '__weak', '__visible', '__noclone', '__optimize',
  'noinline_for_stack', 'asmlinkage', 'asmlinkage_protect', 'notrace',
  'noinstr', 'noinstr_or_nmisafe', '__no_kcsan', '__no_sanitize_address',
  '__no_sanitize_thread', '__nocoverage', '__latent_entropy',
  '__no_instrument_function', 'no_profile_instrument_function',
  '__flatten', '__no_sanitize', '__no_sanitize_ptr_array',
  /* layout */
  '__packed', '__aligned', '__section', '__uninitialized', '__randomize_layout',
  '__designated_init', '__no_randomize_layout',
  /* diagnostics */
  '__must_check', '__deprecated', '__deprecated_for_modules',
  '__printf', '__scanf', '__malloc', '__malloc_like', '__acquires',
  '__releases', '__acquires_shared', '__releases_shared',
  '__releases_exclusive', '__cond_acquires', '__cond_releases',
  '__weak_alias', '__printf__',
  '__section__', '__aligned__', '__packed__', '__visible__',
  /* type checking shorthands */
  '__same_type', '__builtin_choose_expr', '__is_constexpr',
  '__must_be', '__must_be_array',
  /* per-cpu / section helpers that never name a symbol themselves */
  '__percpu_ref', '__cacheline_aligned', '__read_mostly'
]);

/**
 * How to read this macro's arguments, or null if nothing special is known.
 * Callers must handle null by doing nothing - unknown is the normal case.
 */
function specOf(name) {
  return MACROS.get(name) || null;
}

/** Is this identifier an attribute rather than a symbol? */
function isAttr(name) {
  return ATTR.has(name);
}

/* `__attribute_*__` 是 GCC 属性的统一命名模式（`__attribute_const__`、
   `__attribute_pure__`…），逐个列进 ATTR 会永远漏；按模式抹掉。 */
const ATTR_RE = new RegExp(
  '\\b(?:' + Array.from(ATTR).filter((a) => /^[A-Za-z_]\w*$/.test(a)).join('|')
  + '|__attribute_\\w+__)\\b', 'g'
);

/**
 * Blank attribute macros out of the source, PRESERVING LENGTH.
 *
 * This is not cosmetic. `static int __init foo(void)` does not parse as a
 * function definition at all - tree-sitter-c turns it into
 *
 *     declaration          "static int __init"      (a VARIABLE named __init)
 *     function_definition  "foo(void)"
 *       type_identifier    "foo"                    (the return TYPE)
 *       parenthesized_declarator "(void)"
 *
 * i.e. ONE attribute macro tears the function in half: its name is filed as a
 * type (so it never appears as a function), its parameters become top-level
 * names, and everything below it shifts meaning. Verified against the wasm
 * build, not inferred (SPEC F1.16 坑 2).
 *
 * Replacing each attribute with spaces of the SAME width puts the tree back
 * together while moving no character at all, so every node offset still indexes
 * the original source exactly - `textOf(node)` keeps returning real code.
 */
/**
 * Blank every attribute span, INCLUDING a function-like argument list.
 *
 * WHY THE ARGUMENTS MATTER (2026-11-16). Blanking only the NAME turns
 *
 *     static inline __printf(3, 0)
 *     int dev_printk(const char *level, ...)
 *
 * into `static inline         (3, 0)` - an unterminated call that is not C at
 * all. From that line on the tree collapses and every `#define` below it is
 * lost: `include/linux/dev_printk.h` yielded 4 of its 39 macros, and with them
 * vanished `dev_dbg`/`dev_err`/`dev_warn`/`dev_notice`/`dev_info` (tens of
 * thousands of uses filed as "no definition"). An attribute is `NAME` or
 * `NAME(...)`; the span is the whole thing, so that is what gets blanked.
 *
 * Length is preserved (spaces), so every node offset still indexes the original
 * source - the same invariant the name-only version relied on.
 *
 * @param {string} text
 * @param {RegExp} re  global regex matching the attribute names
 * @param {(name:string)=>void} [onHit]  called once per blanked attribute
 */
function blankAttrSpans(text, re, onHit) {
  const s = String(text || '');
  if (!s || !re) return s;
  let out = '';
  let last = 0;
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(s)) !== null) {
    const start = m.index;
    const nameEnd = start + m[0].length;
    /* 预处理指令行（`#define __printf(a,b) …`）**一律不抹**：
       ① 抹掉指令行的宏名，等于把这条 `#define` 本身删掉（属性自己的定义只剩
          "原文补一遍"那条路能救回来，同文件其它符号反而跟着塌）；
       ② 指令体不是 C，不参与语法树，抹不抹对声明解析没有影响。 */
    const lineStart = s.lastIndexOf('\n', start - 1) + 1;
    if (/^[ \t]*#/.test(s.slice(lineStart, start))) {
      re.lastIndex = nameEnd;
      continue;
    }
    let end = nameEnd;
    /* Skip spaces/tabs only: `__printf (3,0)` is legal, `__printf\n(x)` is not
       an attribute call (nothing writes that, and crossing a newline would risk
       swallowing the next statement). */
    let j = nameEnd;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
    if (s[j] === '(') {
      let depth = 0;
      let k = j;
      let quote = '';
      for (; k < s.length; k++) {
        const c = s[k];
        if (quote) {
          if (c === '\\') { k++; continue; }
          if (c === quote) quote = '';
          continue;
        }
        if (c === '"' || c === "'") { quote = c; continue; }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) { k++; break; } }
      }
      /* Only consume the call when the parentheses actually balanced; an
         unbalanced run would mean the match is inside a string or a comment. */
      if (depth === 0) end = k;
    }
    if (start < last) continue;
    out += s.slice(last, start) + ' '.repeat(end - start);
    last = end;
    re.lastIndex = end;
    if (onHit) onHit(m[1]);
  }
  out += s.slice(last);
  return out;
}

function blankAttributes(text) {
  if (!text) return text;
  /* 早退只看 `__`，会漏掉增强包里 `__` 以外的属性名（`notrace`），所以由调用方
     （ts-indexer）在合并正则时自己决定是否走这里。 */
  if (text.indexOf('__') < 0) return text;
  return blankAttrSpans(text, ATTR_RE);
}

module.exports = { specOf, isAttr, blankAttributes, blankAttrSpans, ATTR_RE, MACROS, ATTR };
