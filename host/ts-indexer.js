'use strict';
/*
 * tree-sitter indexer - the L1 engine of the dual-engine design (SPEC 9.8).
 *
 * Per file it produces:
 *   symbols[]   name / kind / line / type / parent / params / config / source
 *   includes[]  header names this file pulls in (feeds L2 compile args)
 *   conds[]     every conditional-compilation macro this file branches on
 *
 * Why an AST instead of the regex prototype: a regex cannot see conditional
 * branches, cannot tell a parameter from a global, and cannot report a
 * variable's type. All three are structural facts. "Which branches exist" is
 * also precisely what a single-configuration compiler (clang) cannot tell us -
 * which is why the two engines complement each other.
 *
 * IMPORTANT tree-sitter detail: `declarator`, `type`, `name`, `body` are
 * FIELD names, not node types. Use childForFieldName()/childrenForFieldName();
 * looking for a node whose *type* is "declarator" silently finds nothing.
 *
 * Spike result (SPEC 9.4.2): 5.11 MB/s on kernel sources - one thread is plenty,
 * so no native binding and no worker pool.
 */

const path = require('path');

/* 语言数据来自规则表（lang/*.js）——核心不认识任何具体语言：tree-sitter 的
   节点名 / 字段名 / token / 判定上下文 / 引用角色都在表里。多语言 = 按文件
   所属语言换表，引擎只有这一份。 */
require('../renderer-lib/lang/registry.js');
require('../renderer-lib/lang/c.js');
require('../renderer-lib/lang/cpp.js');
require('../renderer-lib/lang/text-assets.js');
require('../renderer-lib/lang/rust.js');
require('../renderer-lib/lang/go.js');
require('../renderer-lib/lang/python.js');
require('../renderer-lib/lang/javascript.js');
require('../renderer-lib/lang/java.js');
const LANG = globalThis.Lang;

/* 当前文件所用的表。extract() 是同步的（语法文件在 ensureReady 里一次装全），
   所以这几个绑定在提取过程中不会被别的文件打断。 */
/* 解析器「内容版本」。**只要字段/成员/符号的提取逻辑有变化就改这里**：
   索引里会记下建它时用的版本，加载时不一致就标记过期（提示重建），
   避免"解析器修好了、磁盘上还是旧索引"这种静默错答（2026-11-15 位域成员问题）。 */
const PARSER_REV = '2026-11-17-03';

let SYN = {};
/* 词法块（lexical）：语言自己的"内容长相"判据（如汇编伪指令行数）住在表里。 */
let LEX = {};
let NN = {};
let ROLES = {};
let KINDS = {};
let DECL_CONTEXT = new Set();
let USE_CONTEXT = new Set();
let ELIF_RE = /(?!)/;
let DECLARATORISH_RE = /(?!)/;
/* 节点类型 → nt 键（同一个键可以是多个节点类型，见 C++ 的
   `struct_specifier|class_specifier`）；switch 按「角色」分支而不是节点名，
   多语言才不会变成几十个 case 的并集。 */
let ROLE_OF = new Map();
/* 名字直接挂在声明节点 `name` 字段上的节点（Rust 的 item 形状）。 */
let DECL_NODES = new Set();
/* `pattern` 字段里的 identifier 是声明名（Rust 的 let / for / 参数）。 */
let DECL_PATTERNS = new Set();
/* 导入语句（第五块能力）：表里声明哪些节点是导入、路径怎么从文本里取。 */
let IMPORT_NODES = new Set();
let IMPORTS = {};
/* 调用路径的包装节点（`M::f` 的 scoped_identifier）：被它包住的最后一个
   名字是调用目标，判定「是不是调用」时要沿着它上溯。 */
let CALLEE_WRAPPERS = new Set();
/* 一条声明给多个名字（Go `var x, y int`）：`name` 字段重复出现，
   childForFieldName 只给第一个，其余的要按字段名扫全部子节点。 */
let MULTI_NAMES = new Set();
/* kind 由内部类型节点决定（Go `type Foo struct` 的 kind 写在 `type` 字段里）。 */
let KIND_FROM_CHILD = {};
/* 名字藏在某个字段里（Go `x, y := f()` 的 left 表达式表）：只取该字段的
   直接 identifier 子节点，避免把 `p.x, ok := m[k]` 里的 p/x 当成新变量。 */
let DECL_NAMES_FROM = {};
/* 参数表直接挂在声明节点上的节点（Go 接口方法 `Encode() []byte`）。 */
let DECL_PARAMS = new Set();
/* 数据驱动符号是否继承当前 parent（Go 的接口方法属于接口类型）。 */
let DECL_PARENT = false;
/* 这些名字在引用里没有意义（Go 的空白标识符 `_`），不产引用。 */
let REF_IGNORE = new Set();
/* 方法归属：从 receiver 字段里的类型名推 parent（Go）。 */
let RECEIVER = null;

const esc = (s) => String(s).replace(/[.*+?^$|(){}\[\]\\]/g, '\\$&');

/** 切到某个语言的生效表（不给就是默认语言）。 */
function useTable(table) {
  const t = table || LANG.defaultTable() || {};
  SYN = t.syntax || {};
  LEX = t.lexical || {};
  NN = SYN.nt || {};
  ROLES = SYN.roles || {};
  KINDS = (t.symbols && t.symbols.kinds) || {};
  DECL_CONTEXT = new Set(SYN.declContext || []);
  USE_CONTEXT = new Set(SYN.useContext || []);
  ELIF_RE = NN.elifDirective ? new RegExp('^' + esc(NN.elifDirective)) : /(?!)/;
  DECLARATORISH_RE = (SYN.patterns && SYN.patterns.declaratorish)
    ? new RegExp(SYN.patterns.declaratorish) : /(?!)/;

  ROLE_OF = new Map();
  for (const key of Object.keys(NN)) {
    const v = NN[key];
    for (const type of (Array.isArray(v) ? v : [v])) {
      if (typeof type === 'string' && !ROLE_OF.has(type)) ROLE_OF.set(type, key);
    }
  }
  DECL_NODES = new Set(SYN.declNodes || []);
  DECL_PATTERNS = new Set(SYN.declPatterns || []);

  IMPORTS = t.imports || {};
  IMPORT_NODES = new Set(IMPORTS.nodeTypes || []);
  CALLEE_WRAPPERS = new Set(SYN.calleeWrappers || []);
  MULTI_NAMES = new Set(SYN.multiNames || []);
  KIND_FROM_CHILD = SYN.kindFromChild || {};
  DECL_NAMES_FROM = SYN.declNamesFrom || {};
  DECL_PARAMS = new Set(SYN.declParamsNodes || []);
  DECL_PARENT = SYN.declParent === true;
  REF_IGNORE = new Set(SYN.refIgnore || []);
  RECEIVER = SYN.receiver || null;
}
useTable(LANG.defaultTable());

/** 这个节点在表里叫什么角色（没有 = 普通节点）。 */
const roleOf = (type) => ROLE_OF.get(type) || '';

/** `nt` 的某个键是否包含这个节点类型（值可以是字符串或字符串数组）。 */
function isNT(type, key) {
  const v = NN[key];
  return Array.isArray(v) ? v.indexOf(type) >= 0 : v === type;
}

/* What the kernel's house macros DO with their arguments. A syntax tree cannot
   carry this, and neither can a lexical scanner - it is knowledge about the
   kernel, written down as knowledge about the kernel (SPEC F1.16 坑 2).

   2026-10-21: 知识有了第二个来源 —— 项目自己的增强包（L4，见 enhance.js）。
   两条路合成一张表：**内置永远在，包只能覆盖或新增**。没有包时原样走内置，
   所以默认行为一个字节都不变（回归基线依赖这条）。 */
const KM = require('./kernel-macros');

let ENH = null;              // 当前生效的增强包（归一化之后的 macros[]）
let SPEC = KM.MACROS;        // name -> 规则（v2 形状，见下）
let ATTR = KM.ATTR;          // Set<string>
let ATTR_RE = null;          // 有包时按合并后的属性名重建

/* 有限递归展开（2026-10-23）：宏表由建索引前**先扫一遍 `#define`** 得到（只留
   可能拼出新名字的那些），worker 启动时一次性发过来。为空 = 不展开，
   行为与以前逐字节一致。 */
const macroExpand = require('./macro-expand');
let MACRO_TABLE = null;      // Map<name, [{params, body}]>
let MACRO_LANG = null;       // 语言词表（判"类型 + 名字"用）

/**
 * 装宏表（建索引时每个 worker 收到一次）。
 * @param {Array<{name:string, params:string[], body:string}>} list
 * @param {object} langTable `syntax.macroDerive`（类型词表）
 */
function setMacroTable(list, langTable) {
  MACRO_TABLE = Array.isArray(list) && list.length ? macroExpand.buildTable(list) : null;
  MACRO_LANG = langTable || MACRO_LANG
    || { scalars: ['int', 'void', 'char'], typeSpecs: ['struct', 'union', 'enum'], typeSuffix: '_t' };
}

/**
 * 一条规则（v2）的形状：
 *   { name, when:'', mask:false,
 *     declare: [{ arg?|pattern?, kind, type }],
 *     container: null | { typeArg, member },
 *     relate: [{ arg, as }] }        // 只有内置表用（E3：AI 不再写 relate）
 * 内置表（kernel-macros.js）在加载时**转成同一个形状**，两条路共用一套消费代码。
 * 包里的 `note` 是纯备注，不参与解析（见 setEnhance）。
 */
function builtinRule(name, spec) {
  /* 内置表可以用两种写法：老的「第 N 个参数是名字」({decl,declKind,declType})，
     以及新的 declare[]（需要 pattern 拼名字时用，例如 `DEFINE_SHOW_ATTRIBUTE`
     真实生成的是 `x_open` / `x_fops`，不是 `x`）。 */
  const declare = Array.isArray(spec && spec.declare) ? spec.declare.slice() : [];
  if (spec && spec.decl !== undefined) {
    declare.push({
      arg: spec.decl,
      kind: spec.declKind || 'variable',
      type: spec.declType || ''
    });
  }
  return {
    name,
    when: '',
    mask: false,
    declare,
    container: (spec && spec.typeArg !== undefined && spec.member !== undefined)
      ? { typeArg: spec.typeArg, member: spec.member } : null,
    relate: (spec && Array.isArray(spec.ref))
      ? spec.ref.map((a) => ({ arg: a, as: spec.refAs || 'ref' })) : []
  };
}

/**
 * 切换生效的增强包。传 null 回到内置表（每个项目开始时调用一次）。
 * 归一化在 main/enhance.js 做，这里假定 macros[] 已经合法。
 */
function setEnhance(pack) {
  const rules = new Map();
  for (const [n, sp] of KM.MACROS) rules.set(n, builtinRule(n, sp));
  const attr = new Set(KM.ATTR);
  if (pack) {
    for (const r of (pack.macros || [])) {
      /* **只有"有效果"的规则才进 SPEC**（2026-10-22 E3）：SPEC 是"我们认识这个宏"
         的名单 —— 进了它，宏就不再进"没看懂"清单（macroCallOf 直接返回）。
         只有 note 的规则是**备注**，不是知识：让它进 SPEC 等于悄悄抹掉一条
         未知记录（这正是 silent 被废掉的原因）。所以先判效果，再覆盖。 */
      if (!r.mask && !(r.declare && r.declare.length) && !r.container) continue;
      /* 包**覆盖**内置同名规则（不是合并）：一条规则该说清全部效果，
         合并只会让"我明明改了却不生效"变成常事。 */
      rules.set(r.name, r);
      if (r.mask) attr.add(r.name);
    }
  }
  ENH = pack || null;
  SPEC = rules;
  ATTR = attr;
  PACK_MASK.clear();
  if (pack) for (const r of (pack.macros || [])) if (r.mask) PACK_MASK.add(r.name);
  const names = Array.from(attr).filter((a) => /^[A-Za-z_]\w*$/.test(a));
  ATTR_RE = names.length ? new RegExp('\\b(' + names.join('|') + ')\\b', 'g') : null;
}

/* 规则命中计数（2026-10-22）：每条规则在当前文件里命中了多少次。
 * `extract` 开始时建表、结束时取走；解析是串行的（每进程一次一个文件），
 * 所以用模块级变量安全。目的只有一个：让"这条规则到底生效没有"看得见 ——
 * AI 给一堆规则，命中 0 的那条必须自己跳出来。 */
let HITS = null;
/* 包里声明了 `mask` 的规则名：只有它们计入命中（内置属性表太长了）。 */
const PACK_MASK = new Set();
const bumpHit = (name) => {
  if (!HITS || !name) return;
  HITS.set(name, (HITS.get(name) || 0) + 1);
};

const specOf = (name) => SPEC.get(name) || null;
const isAttr = (name) => ATTR.has(name);

/**
 * 参数列表的**原文切片**：每个顶层逗号分段带自己的 [start,end) 偏移（相对
 * argument_list 起点）。节点树在这里不可靠 —— `struct foo` 会被拆成 ERROR +
 * identifier 两个节点，按节点数位置就错了；按原文切才和"第几个参数"一致。
 * @returns {Array<{text:string, start:number, end:number}>}
 */
function argPartsOf(list, src) {
  const out = [];
  if (!list) return out;
  const raw = textOf(list, src);
  let depth = 0;
  let start = 1;                      // 跳过开头的 '('
  for (let i = 1; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) {              // 收尾的 ')'
        const t = raw.slice(start, i).trim();
        if (t) out.push({ text: t, start, end: i });
        return out;
      }
      depth--;
    } else if (ch === ',' && depth === 0) {
      const t = raw.slice(start, i).trim();
      if (t) out.push({ text: t, start, end: i });
      start = i + 1;
    }
  }
  return out;
}

/** 按顶层逗号切分（括号/花括号里的逗号不算）。 */
function splitTop(s) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

/**
 * 声明形状里的"参数表"：`static FOO(a, b);` 在树里是
 * `declaration(type=FOO, declarator=(a, b))` —— 括号里那串**没有** argument_list，
 * 但对规则来说它就是参数表。按位置切开，`arg: 1` 才说得清。
 * @returns {Array<{text:string, ident:boolean}>|null}
 */
function declaratorArgs(d, src) {
  if (!d || !isNT(d.type, 'parenthesizedDeclarator')) return null;
  const raw = textOf(d, src).trim();
  const m = /^\(([\s\S]*)\)$/.exec(raw);
  if (!m) return null;
  const body = m[1].trim();
  if (!body) return [];
  return splitTop(body).map((t) => {
    const s = t.trim();
    return { text: s, ident: /^[A-Za-z_]\w*$/.test(s) };
  });
}

/**
 * 声明宏的某个参数**声明的名字**。
 *
 * 大多数是裸标识符；但 `DEFINE_PER_CPU(struct perf_event *, bp_on_reg[N])`
 * 这种数组声明参数也合法（真实内核里有），取前面的名字。判不出就返回 ''。
 */
function argIdentOf(a) {
  if (!a) return '';
  if (a.ident) return a.text;
  const m = /^([A-Za-z_]\w*)\s*\[/.exec(String(a.text || ''));
  return m ? m[1] : '';
}

/** `$0_fops` + ['foo'] -> 'foo_fops'；替换值不是标识符就整条放弃（返回 ''）。 */
function fillPattern(p, values) {
  let ok = true;
  const out = String(p).replace(/\$(\d+)/g, (_m, n) => {
    const v = values[Number(n)];
    const txt = (v && typeof v === 'object') ? (v.ident ? v.text : '') : String(v || '');
    if (!txt || !/^[A-Za-z_]\w*$/.test(txt)) { ok = false; return ''; }
    return txt;
  });
  return ok ? out : '';
}

/**
 * 属性宏等长空格化。没有增强包时直接用内置实现（含它的早早返回，行为不变）；
 * 有包时用合并后的正则 —— 包可能加入 `__` 以外的名字（`notrace`），内置那条
 * `indexOf('__') < 0` 的早退会漏掉它们。
 */
function blankAttributes(text) {
  if (!ENH) return KM.blankAttributes(text);
  if (!text || !ATTR_RE) return text;
  /* 属性是 `NAME` 或 `NAME(...)`：**连参数一起**抹（见 kernel-macros 的
     blankAttrSpans）。只抹名字会把 `static inline __printf(3, 0)` 变成一句
     没闭合的调用，整棵树从那行起崩掉 —— dev_printk.h 的 39 个宏只剩 4 个。 */
  return KM.blankAttrSpans(text, ATTR_RE, (m) => {
    /* 只有**包里**的 mask 规则才记账：内置属性表（`__init` 等）几百条，
       记进来只会把命中列表撑满，而用户关心的是自己写的那几条。 */
    if (PACK_MASK.has(m)) bumpHit(m);
  });
}

/**
 * 块注释等长空格化（只动注释，别的一概不碰）。
 *
 * 为什么必须在解析前做：多行宏体里夹注释会让 tree-sitter 的
 * `preproc_function_def` 断掉。实测 `include/drm/drm_atomic.h`：
 * 14 个带续行的宏只认出 11 个，其中 3 个名字被错取成宏**参数名**
 * （`old_connector_state`），`for_each_new_connector_in_state` 整个丢失。
 * 注释在预处理阶段本来就被删掉，这里提前抹平后 15 个宏全部正确。
 *
 * 逐字符扫描而不是正则：正则会把字符串里的 `"/*"` 当作注释开头，
 * 一直吃到下一个星号斜杠，把正常代码抹成空白。
 */
function maskBlockComments(text) {
  if (!text || text.indexOf('/*') < 0) return text;
  const n = text.length;
  let out = '';
  let last = 0;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < n) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === quote) { i += 1; break; }
        if (text[i] === '\n') break;          /* 未闭合字面量：留给解析器去抱怨 */
        i += 1;
      }
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i = Math.min(n, i + 2);
      out += text.slice(last, start);
      out += text.slice(start, i).replace(/[^\n]/g, ' ');
      last = i;
      continue;
    }
    i += 1;
  }
  if (last === 0) return text;
  out += text.slice(last);
  return out;
}

/** 上界：一个大写名字的宏调用 —— 用来发现「没登记的宏」，不是判断语义。 */
const MACRO_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

let Parser = null;
let ready = null;
const langCache = new Map();        // grammar 文件名 -> Language

/** app/src/main -> app/node_modules/...（src/main 往上两级） */
function wasmPathOf(name) {
  return path.join(__dirname, '..', 'vendor', 'tree-sitter', name);
}

/** 装 WASM 运行时 + 所有「有语法规则」的已注册语言的 grammar。可重复调用。
 *
 *  一次全装是刻意的：extract() 必须同步（worker 一文件一次调用），语言不能
 *  等到用的时候才去 await。多语言的代价就是启动时多 load 几个 wasm。 */
let initPromise = null;
function ensureReady(names) {
  /* 只加载项目实际出现的语言；不传 = 全部（自检/单文件测试用）。 */
  const list = Array.isArray(names) && names.length > 0 ? names : LANG.grammars();
  return (async () => {
    if (!initPromise) {
      initPromise = (async () => {
        /* web-tree-sitter 0.20 exports the Parser class directly; 0.27 moved
         * init() around and needs a newer language ABI than the prebuilt WASMs. */
        Parser = require('../vendor/tree-sitter/tree-sitter.js');
        await Parser.init();
      })();
    }
    await initPromise;
    for (const name of list) {
      if (!name || langCache.has(name)) continue;
      langCache.set(name, await Parser.Language.load(wasmPathOf(name)));
    }
  })();
}

function isReady() {
  return !!(Parser && langCache.size);
}

const textOf = (node, src) => (node ? src.slice(node.startIndex, node.endIndex) : '');
const field = (node, name) => (node ? node.childForFieldName(name) : null);

/**
 * Are these two handles the same node?
 *
 * NOT `a === b`. web-tree-sitter wraps native nodes in fresh JS objects, so
 * `parent.child(0) === parent.child(0)` is false and every identity check
 * silently took the wrong branch - which is why no reference was ever reported
 * as a `call`. Position is the reliable identity.
 */
const sameNode = (a, b) => !!a && !!b
  && a.startIndex === b.startIndex && a.endIndex === b.endIndex;

/* ============================================================== references

   SPEC F1.12 / D16 L1. The index has always carried `binds: []` and never
   filled it, so "find references" had to fall back to a full-text grep: it finds
   TEXT, not uses. Two functions with a local `i` are indistinguishable, and a
   name inside a comment counts as a hit.

   Two passes and three confidence levels replace that:

   Pass 1 learns which names are TYPES. Without it `a * b;` is genuinely
   undecidable, and a typedef'd name used as a type looks like a value use.

   Pass 2 walks the tree again and records every identifier that is a USE,
   resolved in C's own order - function-local, then file scope. A name that
   resolves nowhere is still kept, but LABELLED. Dropping it would hide real
   uses; calling it certain would be a lie (D16 "边界显形").
*/

/** Pass 1: every name that may stand where a type is expected. */
function typeNamesOf(tree, src) {
  const out = new Set();
  const visit = (node) => {
    if (!node) return;
    if (node.type === NN.typeDefinition) {
      const n = declNameOf(node, src);
      if (n) out.add(n);
    } else if (node.type === NN.structSpecifier
      || node.type === NN.unionSpecifier || node.type === NN.enumSpecifier) {
      const n = field(node, NN.name) || childrenOfType(node, NN.typeIdentifier)[0];
      if (n) out.add(textOf(n, src));
    }
    for (let i = 0; i < node.childCount; i++) visit(node.child(i));
  };
  visit(tree.rootNode);
  return out;
}

/** Where a name may be declared: inside one function, or at file scope. */
function scopeTableOf(symbols) {
  const local = new Map();     // `fn \0 name`
  const file = new Map();      // name
  const member = new Map();    // `struct \0 name`

  for (const s of symbols) {
    if (s.kind === KINDS.parameter || (s.kind === KINDS.variable && s.parent)) {
      local.set(s.parent + '\u0000' + s.name, s);
    }
    if (s.kind === KINDS.member && s.parent) {
      member.set(s.parent + '\u0000' + s.name, s);
    }
    const topLevel = s.kind === KINDS.function || s.kind === KINDS.variable
      || s.kind === KINDS.macro || s.kind === KINDS.typedef
      || s.kind === KINDS.struct || s.kind === KINDS.union || s.kind === KINDS.enum;
    if (topLevel && !file.has(s.name)) file.set(s.name, s);
  }
  return { local, file, member };
}

/* DECL_CONTEXT / USE_CONTEXT 由 useTable() 按语言装 —— 各语言的名单不同
   （G.4「用哪些节点算声明」是规则表的一部分）。 */

/**
 * Is this identifier a DECLARATION rather than a use?
 *
 * Walks UP the tree, because one level is not enough: in `struct ctx_entry
 * *table` the identifier's parent is a `pointer_declarator`, and the thing that
 * makes it a declaration - `parameter_declaration` - is two levels further up.
 * Checking only the direct parent left phantom references sitting on the
 * declaration lines of parameters and functions nobody had referenced.
 */
function isDeclarationName(node) {
  let p = node.parent;
  for (let i = 0; i < 5 && p; i++, p = p.parent) {
    if (USE_CONTEXT.has(p.type)) return false;

    if (isNT(p.type, 'initDeclarator')) return sameNode(p.child(0), node);

    /* 名字直接是声明节点的 `name` 字段（Rust/Go 的 item 形状：`fn name()`,
       `struct Name {}`, `type Name = ...`）。只认这几类节点，否则 `S { .. }`
       这种表达式里的类型名也会被当成声明。 */
    /* 一条声明可能给多个名字（Go `var x, y int`、`x, y := f()`），名字也
       可能藏在 `left` 之类的字段里 —— 统一问 declNamesOf。 */
    if (DECL_NODES.has(p.type)
      && declNameNodesOf(p).some((it) => sameNode(it.node, node))) return true;

    /* `pattern` 字段里的 identifier 是声明名（`let x = ..` / `for x in ..` /
       参数里的 `x: T`）。用区间判断，因为 pattern 可能是元组或结构体模式。 */
    if (DECL_PATTERNS.has(p.type)) {
      const pat = field(p, NN.pattern);
      if (pat && pat.startIndex <= node.startIndex && node.endIndex <= pat.endIndex) return true;
    }

    /* A `declaration` is BOTH: `int local = base_value;` has one name that is
       being declared and one that is being read, side by side under the same
       node. The `=` is the boundary - everything before it is a name being
       introduced, everything after belongs to the initialiser. Treating the
       whole declaration as "a declaration" swallowed `base_value`; treating it
       as a use swallowed `local` and left it referencing itself. */
    if (isNT(p.type, 'declaration')) {
      let sawAssign = false;
      for (let k = 0; k < p.childCount; k++) {
        const c = p.child(k);
        if (c.type === NN.eq) { sawAssign = true; continue; }
        if (sameNode(c, node)) return !sawAssign;
      }
      return false;
    }

    if (DECL_CONTEXT.has(p.type)) return true;
  }
  return false;
}

/** `read` / `write` / `call` / `address` - what the use DOES. */
function refKindOf(node) {
  const p = node.parent;
  if (!p) return ROLES.read;

  if (isNT(p.type, 'callExpression') && sameNode(field(p, NN.function), node)) return ROLES.call;

  /* `M::f(...)`：callee 是路径节点，名字在外面一层。沿表里声明的包装节点
     上溯，命中 call_expression 的 function 字段就算调用。 */
  let w = p;
  while (w && CALLEE_WRAPPERS.has(w.type)) {
    const gp = w.parent;
    if (gp && isNT(gp.type, 'callExpression') && sameNode(field(gp, NN.function), w)) {
      return ROLES.call;
    }
    w = gp;
  }

  /* `&x` —— 取址。节点名两种：老版 tree-sitter-c 用 unary_expression，新版用
     pointer_expression。只认前者会让「取址」全部落成 read（2026-10-21 发现）。
     运算符仍然取子节点文本，所以两个节点名走同一段判断。 */
  if (isNT(p.type, 'unaryExpression') || isNT(p.type, 'pointerExpression')) {
    /* 这里没有 src，用节点自带的 text —— 以前传的是空串，所以「取址」永远
       判不出来（2026-10-21 修）。 */
    const first = p.child ? p.child(0) : null;
    if (first && first.text === NN.amp) return ROLES.address;
  }

  /* Walk up while we are still part of a plain operand, and decide from the
   * assignment we land in. Comparing nodes for equality is not enough: for
   * `a.b = x` the left side is the field_expression, not the identifier. */
  let up = p;
  while (up && !isNT(up.type, 'assignmentExpression')
    && !isNT(up.type, 'expressionStatement') && !isNT(up.type, 'returnStatement')) {
    if (isNT(up.type, 'binaryExpression') || isNT(up.type, 'argumentList')) return ROLES.read;
    up = up.parent;
  }
  if (up && isNT(up.type, 'assignmentExpression')) {
    const left = field(up, NN.left);
    if (left && left.startIndex <= node.startIndex && node.endIndex <= left.endIndex) {
      return ROLES.write;
    }
  }
  return ROLES.read;
}

/** 这个节点是不是躺在初始化器里（`{ .f = X }` / `{ A(1,2), B(3) }`）——
 *  那里的大写宏是**值**，不是声明。向上找几层就够：初始化器不会套太深。 */
function inInitializer(node) {
  let q = node.parent;
  for (let i = 0; q && i < 12; i++) {
    if (isNT(q.type, 'initializerList') || isNT(q.type, 'initializerPair')) return true;
    if (isNT(q.type, 'declaration') || isNT(q.type, 'functionDefinition')) return false;
    q = q.parent;
  }
  return false;
}

/**
 * 「这个标识符被登记到哪个字段」——`.ndo_start_xmit = e1000_xmit_frame` 的右值。
 *
 * 只认**指定初始化器里的字面量赋值**：那一条在编译期就是常量，说"它被登记为
 * 这个字段"不会错。运行期赋值（`ops->f = fn`、参数注入、memcpy）一概不认——
 * 那种边猜出来也比没有更糟（user rule 2026-10-21：不许给错误结论）。
 *
 * 返回字段名（不带点），不是登记点就返回 ''。
 */
function regSiteOf(node, src) {
  let p = node.parent;
  /* `.cb = &fn`：`&` 包了一层，往外走一层就是初始化器。 */
  if (p && (isNT(p.type, 'unaryExpression') || isNT(p.type, 'pointerExpression'))) p = p.parent;
  if (!p || !NN.initializerPair || !isNT(p.type, 'initializerPair')) return '';
  const d = field(p, NN.designator);
  if (!d) return '';
  /* 设计器自己（`.open` 里的 `open`）不是"值"，跳过。用位置判断而不是节点
     相等：web-tree-sitter 每次都包一层新对象（见 sameNode 的注释）。 */
  if (node.startIndex >= d.startIndex && node.endIndex <= d.endIndex) return '';
  const txt = textOf(d, src).trim().replace(/^\./, '');
  const name = txt.split('.').pop().trim();
  return /^[A-Za-z_]\w*$/.test(name) ? name : '';
}

/**
 * 「这个标识符是容器宏的**成员参数**吗」——是就返回类型参数的原文。
 *
 *   container_of(priv, struct foo_priv, work)   → 'struct foo_priv'
 *
 * 规则来自增强包/内置表的 `container: {typeArg, member}`。索引里把它记成一条
 * `field` 引用（`to: 'field container:<类型>'`），查询侧就能把同名成员按所属
 * 结构体分开 —— 这正是 `container_of` 这类宏存在的意义（2026-10-22）。
 */
function containerMemberOf(node, src) {
  const list = node.parent;
  if (!list || !isNT(list.type, 'argumentList')) return '';
  const call = list.parent;
  if (!call || !isNT(call.type, 'callExpression')) return '';
  const fnNode = field(call, NN.function);
  if (!fnNode || !isNT(fnNode.type, 'identifier')) return '';
  const rule = SPEC.get(textOf(fnNode, src));
  if (!rule || !rule.container) return '';

  /* 参数按**原文顶层逗号**切，不按子节点数：`struct foo_priv` 在树里是
     `ERROR("struct") + identifier("foo_priv")`，按节点数会把一个参数数成两个，
     位置全错（2026-10-22 实测）。 */
  const parts = argPartsOf(list, src);
  const rel = node.startIndex - list.startIndex;
  const at = parts.findIndex((p) => rel >= p.start && rel < p.end);
  if (at < 0 || at !== rule.container.member) return '';
  const typeText = parts[rule.container.typeArg] ? parts[rule.container.typeArg].text : '';
  const t = typeText.replace(/\s+/g, ' ').trim();
  /* 只认真正的类型形状：`struct x` / `union x` / `enum x` / 单个标识符（typedef）。 */
  if (!/^(?:struct|union|enum)\s+[A-Za-z_]\w*(?:\s*\*)?$/.test(t) && !/^[A-Za-z_]\w*$/.test(t)) return '';
  bumpHit(rule.name);
  return t;
}

/**
 * 「这个标识符是某个宏的**被登记参数**吗」——是就返回那个关系的名字。
 *
 *   EXPORT_SYMBOL(e1000_xmit_frame)        → 'exported'
 *   module_init(e1000_init_module)          → 'init'
 *   MODULE_DEVICE_TABLE(pci, e1000_pci_tbl) → 'registered'（取第 1 个参数）
 *
 * 规则来自增强包/内置表的 `relate: [{arg, as}]`。这里只**标注**引用（`to` 记成
 * `reg <关系>`），不产生新符号 —— 符号本来就存在（2026-10-22）。
 */
function relateArgOf(node, src) {
  const list = node.parent;
  if (!list || !isNT(list.type, 'argumentList')) return '';
  const call = list.parent;
  if (!call || !isNT(call.type, 'callExpression')) return '';
  const fnNode = field(call, NN.function);
  if (!fnNode || !isNT(fnNode.type, 'identifier')) return '';
  const rule = SPEC.get(textOf(fnNode, src));
  if (!rule || !rule.relate || !rule.relate.length) return '';
  const parts = argPartsOf(list, src);
  const rel = node.startIndex - list.startIndex;
  const at = parts.findIndex((p) => rel >= p.start && rel < p.end);
  if (at < 0) return '';
  const hit = rule.relate.find((r) => r.arg === at);
  return hit ? String(hit.as || 'ref') : '';
}

/* 宏体里不记引用的词：关键字 + 宏自身的形参由调用方另给。 */
const MACRO_BODY_SKIP = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'return',
  'sizeof', 'typeof', '__typeof__', '__typeof', 'defined', '__VA_ARGS__',
  'void', 'int', 'long', 'char', 'short', 'float', 'double', 'unsigned', 'signed',
  'const', 'volatile', 'static', 'extern', 'inline', 'register', 'struct', 'union',
  'enum', 'goto', 'break', 'continue', 'NULL', 'true', 'false'
]);

/**
 * 宏体里的标识符也是**引用**。
 *
 * 为什么单独做：tree-sitter 把 `#define` 的身体当**一整块原文**（`preproc_arg`），
 * 里面没有 identifier 节点，所以遍历永远走不到。后果是"只出现在别的宏体里"的宏
 * （`__UNIQUE_ID`、`__stringify`、`likely`…）引用列表永远是空的 —— 右键看"调用"
 * 只有定义那一行（用户 2026-10-22 实测）。
 *
 * 这里对宏体做一次词法扫描：紧跟 `(` 的记成 call，其余 read。形参和关键字跳过。
 */
function collectMacroBodyRefs(node, src, scope, out) {
  const val = field(node, NN.value);
  if (!val) return;
  const text = textOf(val, src);
  if (!text) return;
  const params = new Set();
  const list = field(node, NN.parameters) || childrenOfType(node, NN.preprocParams)[0];
  if (list) for (const c of childrenOfType(list, NN.identifier)) params.add(textOf(c, src));

  const re = /[A-Za-z_]\w*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (out.length >= MAX_REFS_PER_FILE) return;
    const name = m[0];
    if (params.has(name) || MACRO_BODY_SKIP.has(name) || isAttr(name)) continue;
    /* 位置：宏体可能跨行（`\` 续行），按 `\n` 数出真实的行列。 */
    const before = text.slice(0, m.index);
    const nl = before.split('\n');
    const line = val.startPosition.row + 1 + (nl.length - 1);
    const column = (nl.length === 1 ? val.startPosition.column + m.index : nl[nl.length - 1].length) + 1;
    const after = text.slice(m.index + name.length);
    const isCall = /^\s*\(/.test(after);
    const hit = scope.file.get(name) || null;
    out.push({
      name, line, column,
      kind: isCall ? ROLES.call : ROLES.read,
      fn: '',
      config: '',
      to: hit ? (hit.kind + ' ' + hit.name + '@' + (hit.line || 0)) : '',
      conf: hit ? 'exact' : 'name-only'
    });
  }
}

/**
 * 接收者表达式的形状 —— 待解析台账第四节（2026-10-22 E2）的分组依据。
 *
 * 查询侧靠接收者表达式**推断**成员所属类型（`baseTypeOfExpr`）：下标剥层、
 * 强制转换、调用返回类型、多级成员逐层。下面这些形状的推断链上任一环的名字
 * 或类型不在索引里，就推断不出 —— 记录数量与样本，不假装能修。
 */
function recvShapeOf(recv) {
  const s = String(recv || '').trim();
  if (!s) return 'other';
  if (s.charAt(0) === '(') return 'cast';
  if (/^[A-Za-z_]\w*\s*\(/.test(s)) return 'call';
  if (s.indexOf('[') >= 0) return 'index';
  if (s.indexOf('->') >= 0 || s.indexOf('.') >= 0) return 'chain';
  if (/^[A-Za-z_]\w*$/.test(s)) return 'plain';
  return 'other';
}

/**
 * Go 的包名选择子：`pkg.Fn` / `pkg.T`。
 *
 * `pkg` 不是接收者（不是变量），`Fn` 也不是它的字段 —— 以前前者被记成 call、
 * 后者被记成 `field pkg`，于是 `Fn` 永远找不到定义（2026-10-23 用户点名）。
 * 判定用的是**本文件的 import 包名表**（`pkgNames`），拿不到就什么都不改。
 *
 * @returns {null|{pkg:string, call:boolean}}
 */
function pkgSelectorOf(node, src, pkgNames, scope, fn) {
  if (!NN.selectorExpression || !NN.selectorField) return null;
  const p = node.parent;
  if (!p || !isNT(p.type, 'selectorExpression')) return null;
  const fld = field(p, NN.selectorField);
  if (!fld || !sameNode(fld, node)) return null;
  const operand = field(p, NN.selectorOperand || NN.memberRecv || 'operand');
  const pkg = operand ? textOf(operand, src).trim() : '';
  if (!pkg) return null;
  /* ① 包名表里有它（`import "net/http"` → http）；
     ② 或者是**别名导入**（`import h "net/http"`）—— 拿不到名字，但它的特征是
        「这个标识符在本文件里没有任何声明」：既不是文件级符号，也不是当前函数的
        参数/局部变量。`s.Buffer.Write` 里的 s 是参数 → 仍然按字段处理。 */
  const known = !!(pkgNames && pkgNames.has(pkg));
  if (!known) {
    if (!scope || !/^[A-Za-z_]\w*$/.test(pkg)) return null;
    if (scope.file.has(pkg)) return null;
    if (fn && scope.local.has(fn + '\u0000' + pkg)) return null;
  }
  const gp = p.parent;
  const call = !!(gp && isNT(gp.type, 'callExpression')
    && sameNode(field(gp, NN.function), p));
  return { pkg, call };
}

/**
 * 复合字面量的键：`T{Field: v}` → 返回 `T`（Go）。不是这种形状返回 ''。
 *
 * tree-sitter-go 的形状是 `composite_literal(type=T, literal_value(keyed_element(
 * literal_element(identifier "Field"), literal_element(value))))` —— 没有 `key`
 * 字段，**第一个子节点就是键**（2026-10-23 实测）。
 */
function keyedElementOwnerOf(node, src) {
  if (!NN.compositeLiteral || !NN.keyedElement || !NN.literalElement) return '';
  if (!isNT(node.type, 'identifier') && !isNT(node.type, 'fieldIdentifier')) return '';
  const le = node.parent;
  if (!le || !isNT(le.type, 'literalElement')) return '';
  const ke = le.parent;
  if (!ke || !isNT(ke.type, 'keyedElement')) return '';
  if (ke.childCount && !sameNode(ke.child(0), le)) return '';
  let q = ke.parent;
  for (let i = 0; q && i < 5; i++) {
    if (isNT(q.type, 'compositeLiteral')) {
      const t = field(q, NN.type);
      return t ? textOf(t, src).replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    }
    q = q.parent;
  }
  return '';
}

/**
 * 「这个标识符是宏的**拼接参数**吗」。
 *
 *   XGMAC_SET_BITS(desc, RX_PACKET_ATTRIBUTES, CSUM_DONE)
 *     #define … reg##_##field …     → 真正被用到的是 RX_PACKET_ATTRIBUTES_CSUM_DONE
 *
 * `RX_PACKET_ATTRIBUTES` 只是**前缀**：它自己既不是符号也没有定义，把它记成
 * 普通 read 引用，零定义名单里就会堆出成千上万个假名字（2026-11-16）。拼出来
 * 的完整名字在源码里有 `#define`，本来就是可解析的符号 —— 所以这里只**不记前缀**。
 *
 * 判据只认"这个形参在宏体里**只**以 `##x` / `x##` 的形式出现"：只要它还作为
 * 独立名字被用过一次（`EXPORT_SYMBOL(f)`、`container_of(p, T, m)` 这类），
 * 就照旧记引用 —— 那些参数是真的符号，抑制掉会丢边。
 */
function gluedMacroArgOf(node, src) {
  if (!MACRO_TABLE || !MACRO_TABLE.size) return false;
  const list = node.parent;
  if (!list || !isNT(list.type, 'argumentList')) return false;
  const call = list.parent;
  if (!call || !isNT(call.type, 'callExpression')) return false;
  const callee = field(call, NN.function);
  if (!callee) return false;
  const macroName = textOf(callee, src).trim();
  const defs = macroName ? MACRO_TABLE.get(macroName) : null;
  if (!defs || !defs.length) return false;

  /* 这个标识符是**第几个实参**（实参可能被括号 / 取址包一层，先上溯到顶层）。 */
  let top = node;
  while (top.parent && !sameNode(top.parent, list)) top = top.parent;
  let argIndex = -1;
  let k = 0;
  for (let i = 0; i < list.childCount; i++) {
    const c = list.child(i);
    if (!c || !c.type || /^[(),]$/.test(c.type)) continue;
    if (sameNode(c, top)) { argIndex = k; break; }
    k++;
  }
  if (argIndex < 0) return false;

  for (const def of defs) {
    const params = (def && def.params) || [];
    const p = params[argIndex];
    if (!p) continue;
    const body = String((def && def.body) || '');
    if (!body) continue;
    const e = esc(p);
    const glue = new RegExp('##\\s*' + e + '(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])' + e + '\\s*##', 'g');
    if (!glue.test(body)) continue;
    /* 去掉拼接处的出现，还剩独立出现 = 这个形参同时是"真符号"。 */
    const rest = body.replace(new RegExp('##\\s*' + e + '(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])' + e + '\\s*##', 'g'), ' ');
    if (!new RegExp('(^|[^A-Za-z0-9_])' + e + '($|[^A-Za-z0-9_])').test(rest)) return true;
  }
  return false;
}

/** Pass 2: every use, resolved as far as a single file can go.
 *  @param pkgNames 本文件 import 进来的包名（Go；空集 = 不做包名判定） */
function refsOf(tree, src, scope, typeNames, pkgNames) {
  const out = [];
  /* 接收者形状普查（E2 台账）：只计数 + 少量样本，不进索引主体。 */
  const recvStats = {
    total: 0, plain: 0, chain: 0, call: 0, index: 0, cast: 0, other: 0, samples: []
  };
  /* 字段访问(`x->field` / `x.field`)单独收集、单独上限。
   *
   * WHY ITS OWN BUDGET: field accesses are far more numerous than identifier uses
   * in a big file, and the identifier cap exists so a pathological file cannot
   * produce an index nobody can load. Sharing one budget would let the fields
   * evict the calls and reads - exactly the references a click on a function or a
   * variable depends on. So fields go in their own array and are appended after
   * (2026-10-14). */
  const fields = [];

  const visit = (node, fn, cfg) => {
    if (!node) return;

    let nextFn = fn;
    if (isNT(node.type, 'functionDefinition')) {
      /* Same rule as the symbol pass: a function_definition without a
         parameter list is a macro block, and its contents belong to the
         ENCLOSING function, not to a scope named after the loop variable. */
      const d = field(node, NN.declarator);
      if (hasParameterList(d) || field(node, NN.parameters)) {
        nextFn = declNameOf(node, src) || declaratorName(d, src) || fn;
      }
    }

    /* Conditional-compilation context, tracked exactly as pass 1 tracks it. A
       reference inside `#ifdef CONFIG_SMP` is a different animal from one
       outside it, and the answer has to be able to say which
       (SPEC F1.16 坑 1). */
    const nextCfg = condChainOf(node, cfg, src);

    /* 宏体（`#define` 的身体）在树里是一整块原文，遍历走不到里面的名字。
       单独扫一遍，否则 `__UNIQUE_ID` 这类只在宏体里出现的宏永远没有引用。 */
    if (isNT(node.type, 'preprocDef') || isNT(node.type, 'preprocFunctionDef')) {
      collectMacroBodyRefs(node, src, scope, out);
      return;
    }

    /* `x->field` / `x.field`: the use of a MEMBER. The receiver's expression
       travels WITH the row (in the `to` column, as "field <expr>") because which
       struct's member this is cannot be decided inside one file - the query side
       resolves the receiver with the whole index behind it and keeps only the
       matching struct's uses (2026-10-14). */
    if (isNT(node.type, 'fieldIdentifier')) {
      /* Go 的包名选择子（`pkg.Fn` / `pkg.T`）：不是字段，按名字查 —— 以前记成
         `field pkg`，于是 `Fn` 永远找不到定义（2026-10-23）。 */
      const pkgSel = pkgSelectorOf(node, src, pkgNames, scope, nextFn);
      if (pkgSel) {
        out.push({
          name: textOf(node, src),
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1,
          kind: pkgSel.call ? ROLES.call : ROLES.read,
          fn: nextFn || '',
          config: nextCfg || '',
          /* 名字级：包内那个符号由查询侧按名字找（索引里有它的定义）。 */
          to: '',
          conf: 'name-only'
        });
        for (let i = 0; i < node.childCount; i++) visit(node.child(i), nextFn, nextCfg);
        return;
      }
      /* Go 的复合字面量键：`T{Field: v}` —— 归属类型写进 to 列，
         以前 `Field` 一条引用都不产（2026-10-23）。 */
      const keyedOwner = keyedElementOwnerOf(node, src);
      if (keyedOwner && fields.length < MAX_FIELD_REFS_PER_FILE) {
        fields.push({
          name: textOf(node, src),
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1,
          kind: ROLES.field,
          fn: nextFn || '',
          config: nextCfg || '',
          to: ROLES.field + ' ' + keyedOwner,
          conf: 'exact'
        });
        for (let i = 0; i < node.childCount; i++) visit(node.child(i), nextFn, nextCfg);
        return;
      }
      /* 接收者字段名各语言不同（C 的 field_expression 叫 argument，
         Rust 叫 value），表里用 memberRecv 声明，缺省沿用 C 的 argument。 */
      const recvField = NN.memberRecv || NN.argument;
      const owner = node.parent ? field(node.parent, recvField) : null;
      const recv = textOf(owner, src).replace(/\s+/g, ' ').trim().slice(0, 120);
      if (recv && fields.length < MAX_FIELD_REFS_PER_FILE) {
        fields.push({
          name: textOf(node, src),
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1,
          kind: ROLES.field,
          fn: nextFn || '',
          config: nextCfg || '',
          to: ROLES.field + ' ' + recv,
          conf: 'exact'
        });
        /* 台账第四节：接收者形状普查（见 recvShapeOf）。样本只留前 8 条，
           带源码行 —— 台账要能直接看懂"哪里推不出"。 */
        const shape = recvShapeOf(recv);
        recvStats.total++;
        recvStats[shape]++;
        if (shape !== 'plain' && recvStats.samples.length < 12) {
          recvStats.samples.push({
            shape,
            recv: recv.slice(0, 100),
            name: textOf(node, src),
            line: node.startPosition.row + 1,
            sample: String(src).split(/\r?\n/)[node.startPosition.row] || ''
          });
        }
      }
    }

    /* Refs are capped per file: an index that cannot be loaded is worse than one
     * with a few thousand fewer edges. */
    const isTypeNode = isNT(node.type, 'typeIdentifier');
    if ((isNT(node.type, 'identifier') || isTypeNode) && !isDeclarationName(node)
      && !isAttr(textOf(node, src)) && !REF_IGNORE.has(textOf(node, src))
      /* `reg##_##field` 的实参只是名字前缀，不是符号（见 gluedMacroArgOf）。 */
      && !(isTypeNode ? false : gluedMacroArgOf(node, src))
      && out.length < MAX_REFS_PER_FILE) {
      const name = textOf(node, src);
      const hit = (isTypeNode ? null : (fn && scope.local.get(fn + '\u0000' + name)))
        || scope.file.get(name)
        || null;
      /* 指定初始化器 `{ .field = name }`：把字段名记进 to 列（见 regSiteOf）。
         这一条不改变 kind —— 它是 read，但"被登记"这件事本身值得单独回答。 */
      const reg = regSiteOf(node, src);
      /* 容器宏的**成员参数**：`container_of(priv, struct foo_priv, work)` 里的
         `work` 不是普通的读，而是 `struct foo_priv` 的一个成员使用。记成 field
         并把类型带在 to 里，查询侧就能按所属结构体收窄（2026-10-22）。 */
      const containerType = isTypeNode ? '' : containerMemberOf(node, src);
      /* 被登记的符号（`EXPORT_SYMBOL(f)` / `module_init(f)` / `MODULE_DEVICE_TABLE(p, tbl)`）：
         它仍然是那个符号，只是"在这里被登记了"。记成 `reg <关系>`。 */
      const relateAs = (isTypeNode || containerType) ? '' : relateArgOf(node, src);
      /* Go：`pkg.Fn` 里的 `pkg` 是包名，不是"被调用的函数"。
         refKindOf 会因为 selector 包着它而判成 call —— 这里改回 module。 */
      const isPkgOperand = !!(NN.selectorExpression && node.parent
        && isNT(node.parent.type, 'selectorExpression')
        && sameNode(field(node.parent, NN.selectorOperand || NN.memberRecv || 'operand'), node)
        && ((pkgNames && pkgNames.has(name))
          /* 别名导入：本文件里没有任何声明的标识符，当包名看（与 pkgSelectorOf 同口径）。 */
          || (!scope.file.has(name) && !(fn && scope.local.has(fn + '\u0000' + name)))));
      /* Go 复合字面量的键（`Item{Name: "a"}`）：`Name` 是 `Item` 的成员，
         归属写进 to 列 —— 以前它只是一条普通 read，点不出归属（2026-10-23）。 */
      const keyedOwner = isTypeNode ? '' : keyedElementOwnerOf(node, src);
      if (keyedOwner && fields.length < MAX_FIELD_REFS_PER_FILE) {
        fields.push({
          name,
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1,
          kind: ROLES.field,
          fn: fn || '',
          config: nextCfg || '',
          to: ROLES.field + ' ' + keyedOwner,
          conf: 'exact'
        });
      } else {
        out.push({
          name,
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1,
          /* A typedef'd name used where a type belongs reads as a type use, not as
           * a value use - which is what Pass 1's table is for. */
          kind: isPkgOperand ? 'module'
            : (containerType ? ROLES.field
              : ((isTypeNode || typeNames.has(name)) ? ROLES.type : refKindOf(node))),
          fn: fn || '',
          config: nextCfg || '',
          /* A stable, human-readable target id: kind + name + declaration line.
           * No counter to maintain, and it survives a re-index of a file. */
          to: containerType ? ('field container:' + containerType.slice(0, 80))
            : relateAs ? ('reg ' + relateAs)
              : (reg ? ('reg ' + reg) : (hit ? (hit.kind + ' ' + hit.name + '@' + (hit.line || 0)) : '')),
          conf: (containerType || relateAs || hit) ? 'exact' : 'name-only'
        });
      }
    }

    for (let i = 0; i < node.childCount; i++) visit(node.child(i), nextFn, nextCfg);
  };

  visit(tree.rootNode, null, null);
  /* 字段访问接在普通引用之后:同一个文件里,`sk->x` 与 `sk` 是两回事,前者按成员
     回答,后者按名字回答(2026-10-14)。 */
  return { refs: out.concat(fields), recvStats };
}

const MAX_REFS_PER_FILE = 4000;
/* 字段访问的上限(见 refsOf):单独计数,不与普通引用抢额度。 */
const MAX_FIELD_REFS_PER_FILE = 5000;

/**
 * The macro call at this node, if the callee is a kernel house macro.
 *
 * `LIST_HEAD(my_list)` is syntactically a call taking one identifier, and
 * nothing in the tree says "this DECLARES my_list" - so the tree reports a use
 * where there is a definition. The name has to be looked up in the kernel's own
 * vocabulary (see kernel-macros.js).
 */
function macroCallOf(node, src) {
  const f = field(node, NN.function);
  if (!f || !isNT(f.type, 'identifier')) return null;
  const name = textOf(f, src);
  if (!SPEC.has(name)) return null;
  const list = field(node, NN.arguments) || childrenOfType(node, NN.argumentList)[0];
  /* **按源码位置**收集参数（0 起），不是"第几个标识符"。而且按**原文切片**数，
     不按子节点数：`struct foo` 在树里是 `ERROR + identifier` 两个节点，按节点
     数会把一个参数数成两个，位置全错（2026-10-22 实测）。 */
  const args = argPartsOf(list, src).map((p) => ({
    text: p.text,
    ident: /^[A-Za-z_]\w*$/.test(p.text)
  }));
  return { name, args };
}

/**
 * 参数节点（按位置，过滤掉括号与逗号）。macroCallOf 只留标识符、按「第几个
 * 标识符」索引；识别「没登记的宏」时要看参数**长什么样**，所以需要节点本身。
 */
function rawArgsOf(node) {
  const list = field(node, NN.arguments) || childrenOfType(node, NN.argumentList)[0];
  if (!list) return [];
  const out = [];
  for (let i = 0; i < list.childCount; i++) {
    const c = list.child(i);
    if (!c) continue;
    if (c.type === ',' || c.type === '(' || c.type === ')') continue;
    out.push(c);
  }
  return out;
}

/** Is this declaration one of the `extern` kind?
 *
 *  `extern int x;` is a DECLARATION: it tells the compiler the name exists, and
 *  the definition lives in another translation unit. Everything downstream that
 *  already distinguishes a prototype from a body - the `prototype` flag - applies
 *  to it unchanged (user requirement 2026-10-14). */
function isExternDecl(node, src) {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type === NN.storageClassSpecifier && textOf(c, src) === NN.externKeyword) return true;
  }
  return false;
}

/**
 * Every declarator of a declaration.
 *
 * web-tree-sitter 0.20 offers childForFieldName() but neither
 * childrenForFieldName() nor fieldNameForChild(), so the extra declarators of
 * `int a, *b, c[8];` cannot be found by asking for fields. Take the first via
 * the field API and the rest from the direct identifier/declarator children -
 * the type node is excluded, so `struct Foo x;` does not yield `Foo`.
 */
function declaratorsOf(node) {
  const out = [];
  if (!node || typeof node.childForFieldName !== 'function') return out;

  const first = node.childForFieldName(NN.declarator);
  const typeNode = node.childForFieldName(NN.type);
  if (first) out.push(first);

  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    /* sameNode, NOT `===`. Handles are fresh wrapper objects every time, so an
       identity test never matches the field nodes and the declarator gets
       pushed twice - which showed up as `LIST_HEAD(x)` declaring `x` two times
       at the same line. Same trap as the `call` classification, different
       symptom. */
    if (!c || sameNode(c, first) || sameNode(c, typeNode)) continue;
    if (c.type === NN.identifier || c.type === NN.fieldIdentifier || /declarator$/.test(c.type)) out.push(c);
  }
  return out;
}

/**
 * All children carrying a given FIELD name (best effort, see above).
 */
function fields(node, name) {
  const out = [];
  if (!node) return out;

  if (typeof node.fieldNameForChild === 'function') {
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c && node.fieldNameForChild(i) === name) out.push(c);
    }
  }

  /* Fallback for builds without fieldNameForChild: at least the first one. */
  if (!out.length && typeof node.childForFieldName === 'function') {
    const one = node.childForFieldName(name);
    if (one) out.push(one);
  }
  return out;
}

/** Stars that belong to a pointer declarator itself (not to its subtree). */
function ownStars(node) {
  let n = 0;
  if (!node) return 0;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type === NN.star) n++;
  }
  return n;
}

function childrenOfType(node, type) {
  const out = [];
  if (!node) return out;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type === type) out.push(c);
  }
  return out;
}

/**
 * Descend through declarator wrappers to the naming identifier.
 * `int (*fp)(void)` -> fp, `int a[8]` -> a, `struct s *p` -> p.
 */
function declaratorName(node, src) {
  if (!node) return '';
  switch (node.type) {
    case NN.identifier:
    case NN.typeIdentifier:
    case NN.fieldIdentifier:
      return textOf(node, src);
    default:
      break;
  }
  /* prefer the declarator field, then fall back to the first declarator-ish
   * child (array/pointer/function declarators all nest this way) */
  const d = field(node, NN.declarator);
  if (d) {
    const n = declaratorName(d, src);
    if (n) return n;
  }
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && DECLARATORISH_RE.test(c.type)) {
      const n = declaratorName(c, src);
      if (n) return n;
    }
  }
  return '';
}

/** `pattern` 字段里声明出来的名字（`let (a, b) = x;` / `for i in ..`）。
 *  只收 `identifier`（表里的键），元组/结构体模式展开到叶子。 */
function patternIdentifiers(pat, NT, src) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (isNT(n.type, 'identifier')) {
      const name = textOf(n, src);
      /* `_` 是通配符，不是名字；`_x` 这样的才是。 */
      if (name !== '_') out.push({ name, line: n.startPosition.row + 1 });
      return;
    }
    /* `Some(v)` / `Packet { len, .. }` 的 `type` 字段是路径（类型名），
       不是绑定。 */
    const typeChild = field(n, NN.type);
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (typeChild && sameNode(c, typeChild)) continue;
      walk(c);
    }
  };
  walk(pat);
  return out;
}

/** 导入语句要引入的路径（表里 imports.line 的正则捕获组 1）。 */
function importsOf(node, src) {
  const out = [];
  if (!node) return out;
  const re = IMPORTS.line ? new RegExp(IMPORTS.line) : null;
  const m = re ? re.exec(textOf(node, src)) : null;
  if (m && m[1]) {
    out.push(m[1].replace(/\s+/g, ' ').trim());
    return out;
  }
  /* 表里没写正则时退回 C 形状的 path / 字符串字面量。 */
  const p = field(node, NN.path)
    || childrenOfType(node, NN.stringLiteral)[0]
    || childrenOfType(node, NN.systemLibString)[0];
  if (p) out.push(textOf(p, src).replace(/^[<"]|[>"]$/g, ''));
  return out;
}

/** 声明节点的名字：`name` 字段 → `pattern` 字段 → 声明符链。
 *
 *  C 的 item 把名字埋在 declarator 里（`int (*fp)(void)`），Rust/Go 的 item
 *  直接给 `name`，参数给 `pattern`。先问字段，再退回声明符 —— 对 C 不变，
 *  因为 C 的声明节点没有 name/pattern 字段。 */
function declNameOf(node, src) {
  const one = declNamesOf(node, src)[0];
  return one ? one.name : '';
}

/**
 * `typedef` 的声明符名 —— `declNameOf` 的兜底。
 *
 * tree-sitter-c 把标准定宽整型当成 `primitive_type`：`typedef u16 uint16_t;`
 * 里 `uint16_t` 是 primitive_type 而不是 type_identifier，于是 `declNameOf`
 * 找不到名字，`uint16_t` / `ssize_t` / `uint64_t` / `uint8_t` 等**全都没有定义**
 * （2026-11-16 实测：10 个名字 / 2,272 条引用零定义，`u_int16_t` 反而正常）。
 *
 * 取**最后一个**类型节点当名字：`typedef struct { … } my_type;` 的 struct 是
 * 一个不透明子节点，内部成员不会泄漏进来。少数写法会被归进 ERROR
 * （`typedef __signed__ char __s8;` 的 `__s8`），那段原文是裸标识符时也认。
 */
function typedefDeclaratorName(node, src) {
  let last = null;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (isNT(c.type, 'typeIdentifier') || isNT(c.type, 'primitiveType')) { last = c; continue; }
    if (isNT(c.type, 'errorNode')) {
      const t = textOf(c, src).trim();
      if (/^[A-Za-z_]\w*$/.test(t)) last = c;
    }
  }
  return last ? textOf(last, src).trim() : '';
}

/** 一条声明可能给出**多个**名字节点：`name` 字段重复（Go `var x, y int`），
 *  或名字藏在 `left` 之类的字段里（Go `x, y := f()`）。返回节点本身，不取
 *  文本 —— 判定「这个标识符是不是声明」时只需要节点同一性。 */
function declNameNodesOf(node) {
  if (!node) return [];
  /* web-tree-sitter 的 Node 是包装对象：同一个语法节点两次 child() 拿到的是
     不同对象，去重必须用 sameNode（比较区间），不能用 ===。 */
  const push = (out, n, pattern) => {
    if (n && !out.some((x) => sameNode(x.node, n))) out.push({ node: n, pattern: !!pattern });
  };
  const from = DECL_NAMES_FROM[node.type];
  if (from) {
    const holder = field(node, from.field || NN.left);
    const want = new Set(from.types || ['identifier']);
    const out = [];
    if (holder) {
      if (want.has(holder.type)) push(out, holder);
      /* 只取该字段的**直接**标识符子节点：`x, y := f()` 的表达式表里
         `x`/`y` 是直接子节点，`p.x` 里的 `p` 在 selector 里面，不动。 */
      if (from.direct !== false && holder.childCount) {
        for (let i = 0; i < holder.childCount; i++) {
          const c = holder.child(i);
          if (want.has(c.type)) push(out, c);
        }
      }
    }
    if (out.length) return out;
  }
  if (MULTI_NAMES.has(node.type)) {
    const out = [];
    for (const n of fields(node, NN.name)) push(out, n);
    /* 语法通常只给第一个名字打 `name` 字段，后面的 `, y` 没有字段标记：
       扫描**直接** identifier 子节点补齐（类型是 type_identifier，不冲突）。 */
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c.type === NN.identifier) push(out, c);
    }
    if (out.length) return out;
  }
  const n = field(node, NN.name);
  if (n) return [{ node: n }];
  const pat = field(node, NN.pattern);
  if (pat) return [{ node: pat, pattern: true }];
  return [];
}

/** 声明节点的全部名字（文本形式）。 */
function declNamesOf(node, src) {
  const nodes = declNameNodesOf(node);
  if (nodes.length) {
    return nodes.map((it) => ({
      name: it.pattern
        ? textOf(it.node, src).replace(/\s+/g, ' ').trim()
        : textOf(it.node, src),
      node: it.node
    }));
  }
  const name = declaratorName(field(node, NN.declarator), src);
  return name ? [{ name, node }] : [];
}

/**
 * 嵌入字段（Go）：没有名字，只有类型 —— `Foo` / `io.Reader` / `*T`。
 * 名字取类型里的**最后一段标识符**（`io.Reader` → `Reader`），归属由
 * `declParent` 记成外层类型（2026-10-23）。
 */
function embedFieldNamesOf(node, src) {
  const t = field(node, NN.type);
  if (!t) return [];
  let last = null;
  (function dig(n) {
    if (!n) return;
    if (isNT(n.type, 'identifier') || isNT(n.type, 'typeIdentifier')) last = n;
    for (let i = 0; i < n.childCount; i++) dig(n.child(i));
  })(t);
  return last ? [{ name: textOf(last, src), node: last }] : [];
}

/** 节点 → kind。表里可以写死（`declKinds`），也可以交给内部类型节点决定
 *  （`kindFromChild`：Go 的 `type Foo struct` 是 struct、`type Foo int` 是别名）。 */
function declKindOf(node) {
  const direct = SYN.declKinds && SYN.declKinds[node.type];
  if (direct) return direct;
  const spec = KIND_FROM_CHILD[node.type];
  if (!spec) return '';
  const c = field(node, spec.field || NN.type);
  const t = c ? c.type : '';
  return (spec.map && spec.map[t]) || spec.default || '';
}

/** 方法归属：receiver 字段里的类型名（`func (p *Packet) Encode()` → Packet）。 */
function receiverNameOf(node, src) {
  if (!RECEIVER) return '';
  const recv = field(node, RECEIVER.field || 'receiver');
  if (!recv) return '';
  const want = new Set(RECEIVER.nameNodes || []);
  let found = '';
  const visit = (n) => {
    if (!n || found) return;
    if (want.has(n.type)) {
      found = textOf(n, src);
      return;
    }
    for (let i = 0; i < n.childCount; i++) visit(n.child(i));
  };
  visit(recv);
  return found;
}

/** Pointer depth written between the type and the name. */
function pointerStars(node) {
  if (!node) return 0;
  if (node.type === NN.pointerDeclarator) {
    const own = (textOf(node, node.text ? '' : '') || '').length; // unused, kept simple below
    void own;
  }
  return 0;
}

/**
 * The type as written, e.g. `struct sock *`, `unsigned long`, `char **`.
 * The stars live inside the declarator, so they are counted there.
 */
function typeTextOf(node, src) {
  const t = field(node, NN.type)
    || (NN.returnType ? field(node, NN.returnType) : null)
    || childrenOfType(node, NN.primitiveType)[0]
    || childrenOfType(node, NN.typeIdentifier)[0]
    || childrenOfType(node, NN.sizedTypeSpecifier)[0]
    || childrenOfType(node, NN.structSpecifier)[0]
    || childrenOfType(node, NN.unionSpecifier)[0]
    || childrenOfType(node, NN.enumSpecifier)[0];

  let base = t ? textOf(t, src) : '';

  const d = field(node, NN.declarator) || childrenOfType(node, NN.initDeclarator)[0];
  let stars = 0;
  let probe = d;
  while (probe) {
    if (probe.type === NN.pointerDeclarator) {
      /* only the stars this declarator owns - counting the subtree would also
       * pick up the `*` in parameters, giving `struct sock **` for a function
       * that returns a single pointer. */
      stars += ownStars(probe);
      probe = field(probe, NN.declarator);
    } else if (probe.type === NN.initDeclarator || probe.type === NN.arrayDeclarator
      || probe.type === NN.functionDeclarator || probe.type === NN.parenthesizedDeclarator) {
      probe = field(probe, NN.declarator);
    } else {
      break;
    }
  }

  /* 有的语法把箭头写进了返回类型字段的文本里（表里声明要剥的前缀）。 */
  for (const p of (SYN.stripTypePrefix || [])) {
    if (base.indexOf(p) === 0) base = base.slice(p.length).trim();
  }
  base = base.replace(/\s+/g, ' ').trim();
  if (!base && !stars) {
    /* 没有任何类型来源时不要拿整行文本冒充类型：`let x = f();` 的 type
       会变成 "let x = f"，`fn main()` 会变成 "fn main"（2026-10-19）。 */
    return '';
  }
  return (base + (stars ? ' ' + NN.star.repeat(stars) : '')).trim();
}

/** Does this declarator chain carry a parameter list? Every real function
 * definition has one - that is where the parameters live, so it is the line
 * between a function and `MACRO(loop_var) { ... }`: the C grammar parses the
 * latter exactly like `type (declarator) { body }` (type = the macro name,
 * declarator = the loop variable, no parameter list anywhere), which used to
 * be indexed as a function named after the loop variable - the ghost
 * "function cpu" of for_each_possible_cpu(cpu) { ... } (2026-10-15). */
function hasParameterList(node) {
  if (!node) return false;
  if (isNT(node.type, 'functionDeclarator') || isNT(node.type, 'parameters')
    || isNT(node.type, 'parameterList')) return true;
  for (let i = 0; i < node.childCount; i++) {
    if (hasParameterList(node.child(i))) return true;
  }
  return false;
}

/** Parameters of a function definition / declarator. */
function paramsOf(declaratorNode, src) {
  let probe = declaratorNode;
  let list = null;
  /* 直接给的就是参数表（Rust 的 function_item 把 `parameters` 挂在函数上，
     中间没有 function_declarator 那一层）。 */
  if (probe && (isNT(probe.type, 'parameters') || isNT(probe.type, 'parameterList'))) list = probe;
  while (probe && !list) {
    if (isNT(probe.type, 'functionDeclarator')) list = field(probe, NN.parameters);
    probe = probe.childCount ? field(probe, NN.declarator) : null;
  }
  if (!list) return [];
  const out = [];
  const addParams = (p) => {
    const dec = field(p, NN.declarator);
    /* The parameter's OWN line, not the function's. A kernel signature is
       routinely spread over five lines and starts at the return type, so
       `unsigned int\ndecompress_kernel(...)\n  size_t ksize,` reported `ksize`
       as living on the `unsigned int` line (user report 2026-10-13).

       ...and the DECLARATOR's line, not the parameter declaration's, because a
       kernel signature also wraps a single parameter across lines:

           unsigned long find_next_zero_bit_le(const void *addr, unsigned
                           long size, unsigned long offset)

       The parameter starts on the `unsigned` line; `size` is on the next one.
       Taking the declaration's row left 18 such records in a 349,731-record
       sweep (0.005%) pointing one line early (measured 2026-10-14). */
    const paramNames = declNamesOf(p, src).filter((it) => it && it.name);
    for (const it of paramNames) {
      out.push({
        name: it.name,
        type: typeTextOf(p, src),
        line: dec && dec.startPosition ? dec.startPosition.row + 1
          : (it.node && it.node.startPosition ? it.node.startPosition.row + 1
            : p.startPosition.row + 1)
      });
    }
    /* Python/JS 的参数直接是 identifier（或 typed_parameter 里包一个
       identifier），没有 C 的 parameter_declaration 包装；取不到名字时
       向下找一个 identifier 补一条，参数才能进作用域。 */
    if (paramNames.length === 0) {
      let idNode = null;
      const findId = (n) => {
        if (!n || idNode) return;
        if (isNT(n.type, 'identifier')) { idNode = n; return; }
        for (let i = 0; i < n.childCount && !idNode; i += 1) findId(n.child(i));
      };
      findId(p);
      if (idNode) {
        out.push({
          name: textOf(idNode, src),
          type: typeTextOf(p, src),
          line: idNode.startPosition.row + 1
        });
      }
    }
  };
  const declaredParams = childrenOfType(list, NN.parameterDeclaration);
  if (declaredParams.length > 0) {
    for (const p of declaredParams) addParams(p);
  } else {
    /* Python / JS / Java 的参数表直接挂 identifier / typed_parameter /
       formal_parameter，没有 C 的 parameter_declaration 包装。 */
    for (let i = 0; i < list.childCount; i += 1) {
      const p = list.child(i);
      if (!p) continue;
      if (p.type === '(' || p.type === ')' || p.type === ',') continue;
      addParams(p);
    }
  }
  /* Go 的可变参数自带名字（`args ...string`）：C 的裸 `...` 才补一个省略号
     占位参数。 */
  const variadics = NN.variadicParameter
    ? childrenOfType(list, NN.variadicParameter) : [];
  for (const p of variadics) addParams(p);
  if (variadics.length && !variadics.some((p) => declNameOf(p, src))) {
    out.push({ name: NN.ellipsis, type: '' });
  }
  return out;
}

/** Which conditional-compilation branch does this node sit in? */
function conditionOf(node, src) {
  switch (node.type) {
    case NN.preprocIfdef: {
      const n = field(node, NN.name) || childrenOfType(node, NN.identifier)[0];
      if (!n) return null;
      /* `#ifdef` and `#ifndef` can both arrive as `preproc_ifdef` (the keyword
         is a child token), so the negation has to be read off the token. Taking
         the node type as the answer filed every include guard backwards:
         `#ifndef _H` came out as `[_H]`, i.e. "the body is live when _H IS
         defined" - the opposite of what the file means. */
      const kw = node.child(0) ? textOf(node.child(0), src) : '';
      return { name: textOf(n, src), negated: kw === NN.ifndefDirective };
    }
    case NN.preprocIfndef: {
      const n = field(node, NN.name) || childrenOfType(node, NN.identifier)[0];
      return n ? { name: textOf(n, src), negated: true } : null;
    }
    case NN.preprocElse:
      return { name: NN.elseDirective, negated: false };
    case NN.preprocElif:
    case NN.preprocIf: {
      const c = field(node, NN.condition) || childrenOfType(node, NN.identifier)[0];
      const t = c ? textOf(c, src).trim() : '';
      const m = /^!?\s*([A-Za-z_]\w*)\s*$/.exec(t);
      return m ? { name: m[1], negated: t.startsWith('!') } : (t ? { name: t, negated: false } : null);
    }
    default:
      return null;
  }
}

/**
 * The condition a branch is the ALTERNATIVE of, as a label: `#else` of
 * `#ifdef A` is `[!A]`, and `#else` of `#ifndef _H` is `[_H]` - the guard being
 * DEFINED is what that branch means. A `preproc_else` node's parent is the
 * conditional that owns it, and that is where the positive condition lives.
 */
function alternateLabelOf(node, src) {
  const p = node && node.parent;
  if (!p) return null;
  const c = conditionOf(p, src);
  if (!c || !c.name || c.name === NN.elseDirective || ELIF_RE.test(c.name)) return null;
  return labelOf({ name: c.name, negated: !c.negated });
}

function labelOf(cond) {
  if (!cond || !cond.name) return null;
  if (cond.name === NN.elseDirective) return '[#else]';
  return (cond.negated ? '[!' : '[') + cond.name + ']';
}

/** Drop the innermost label, to make room for its `#else` / `#elif` successor. */
function dropLastLabel(cfg) {
  return cfg ? cfg.replace(/\s*\[[^\]]*\]\s*$/, '') : '';
}

/**
 * The condition label a nested node contributes to the chain `[A] [B] ...`.
 *
 * THIS IS THE ONE PLACE THE CHAIN IS BUILT, and it is shared by both passes -
 * a definition and its own reference filed under different configurations was
 * 坑 1 of SPEC F1.16, and two copies of this rule is how they drift apart.
 *
 * The rule has three cases, and getting them confused is what made every
 * NESTED conditional in the kernel wrong (`[!A]` for code under a plain
 * `#ifdef A`, with its own name missing entirely):
 *
 *   `#ifdef B` nested inside `#ifdef A`   APPEND  → `[A] [B]`
 *   `#else` of that                        REPLACE the `[B]` → `[A] [!B]`
 *   `#elif C` of that                      REPLACE with TWO labels → `[A] [!B] [C]`
 *
 * The old code asked "does my parent have a condition" instead of "am I an
 * #else", so EVERY nested `#if`/`#ifdef` was read as its parent's else-branch:
 * the nested name vanished and the outer one came out negated. Measured on
 * include/net/tcp.h: the definition at 1661 (inside `#ifndef _TCP_H` +
 * `#ifdef CONFIG_TCP_MD5SIG`) was filed as `[!_TCP_H]`, and the `#else` branch
 * at 1672 as `[!CONFIG_TCP_MD5SIG]` - both missing a level.
 */
function condChainOf(node, cfg, src) {
  const cond = conditionOf(node, src);
  if (!cond || !cond.name) return cfg;

  const alt = (cond.name === NN.elseDirective || node.type === NN.preprocElif)
    ? alternateLabelOf(node, src) : null;
  if (alt) {
    const parts = [dropLastLabel(cfg), alt];
    /* `#elif C` holds only when the earlier branch did not AND C holds. */
    if (node.type === NN.preprocElif) parts.push(labelOf(cond));
    return parts.filter(Boolean).join(' ') || cfg;
  }

  const l = labelOf(cond);
  return l ? (cfg ? cfg + ' ' + l : l) : cfg;
}

/**
 * Parse one file and collect everything the index needs.
 * @returns {{symbols: Array, includes: Array<string>, conds: Array<string>}}
 */
function extract(text, relPath) {
  /* 按文件所属语言换表 + 换语法。取不到就退回默认语言（C）——只有
     注册表与 ensureReady 不同步时才会走到，此时宁可解析成 C 的形状，
     也不要把整个索引停掉。 */
  useTable(LANG.tableForRel(relPath));
  /* 命中计数必须在**抹名之前**开表：`mask` 规则是在 blankAttributes 里计数的。 */
  HITS = new Map();

  /* 内容其实是汇编的 `.h`（arch/m68k/fpsp040/*.h、arch/mips/include/asm/
     asmmacro.h）：按 C 解析只会吐出 `$31` / `xorl` / `If` / `need` 这类垃圾
     名字，外加成百上千条同样垃圾的引用。判据与阈值都在语言表里
     （lang/c.js 的 lexical.asmSniff / asmSniffMin，2026-11-16）—— 只认行首的
     汇编伪指令，宽松到不会误伤正常 C 头。 */
  if (LEX.asmSniff) {
    const asmHits = String(text || '').match(new RegExp(LEX.asmSniff, 'gm'));
    if (asmHits && asmHits.length >= (LEX.asmSniffMin || 3)) {
      return {
        symbols: [], includes: [], conds: [], refs: [], issues: [], ruleHits: {},
        symStats: { total: 0, weakDef: 0, noType: 0, noOwner: 0, samples: [] },
        recvStats: {
          total: 0, plain: 0, chain: 0, call: 0, index: 0, cast: 0, other: 0, samples: []
        },
        typeNames: []
      };
    }
  }

  const lang = langCache.get(SYN.grammar) || langCache.get(LANG.grammarForRel(''));
  const parser = new Parser();
  parser.setLanguage(lang);

  /* Attributes are blanked BEFORE parsing; the replacement is the same length,
     so every node offset still indexes the original text. Without it
     `static int __init f(void)` is torn into a variable named `__init` plus a
     definition whose "type" is `f` - and `f` is then never a function at all
     (see blankAttributes). */
  const tree = parser.parse(blankAttributes(maskBlockComments(text)));
  const src = text;      // node offsets index the ORIGINAL text

  /* Pass 1 first: without the set of type names, a typedef'd name used as a type
   * is indistinguishable from a value use. */
  const typeNames = typeNamesOf(tree, src);

  const symbols = [];
  const includes = [];
  const conds = new Set();

  /* ---- 解析降级记账 ------------------------------------------------
   * 这些不是「报错」，是「我认出来了，但我不知道怎么归类」。它们构成索引报告
   * （enhance.reportText）的全部内容 —— 用户拿这份清单去问 AI，回来的是增强包。
   * 按名字聚合（`WARN_ON ×1204` 比 1204 行更有用），每个文件最多记 40 个名字。
   */
  const issues = new Map();
  let srcLines = null;
  const rawLineAt = (ln) => {
    if (!srcLines) srcLines = text.split(/\r?\n/);
    return srcLines[ln - 1] || '';
  };
  const lineTextAt = (ln) => rawLineAt(ln).trim().replace(/\s+/g, ' ').slice(0, 110);

  /* ---- 符号级自检（2026-10-22）--------------------------------------
     和上面的 `issues` 不是一回事：`issues` 记的是**解析器自己知道的错**
     （名字被当成类型之类）；这里记的是**解析器不知道自己做错了**的那一类 ——
     符号是造出来了，但讲不清它是什么。三个信号都能用源码直接验证：

       weakDef  定义那一行找不到这个名字  → 位置是猜的，点过去会落到别处
       noType   类型为空（变量/函数）      → 知道名字，不知道是什么
       noOwner  成员没有所属结构体          → 不知道它是谁的成员

     只出计数 + 少量样例，不进索引主体（6.8M 符号不能每人带一条记录）。 */
  const symStats = { total: 0, weakDef: 0, noType: 0, noOwner: 0, samples: [] };
  const weak = (kind, s, lt) => {
    /* 每文件最多留 20 条（全局 4000）：台账要"全量"，但病态文件不能无限膨胀。 */
    if (symStats.samples.length < 20) {
      symStats.samples.push({ kind, name: s.name, line: s.line, sample: lt.slice(0, 110) });
    }
  };
  const note = (kind, name, ln) => {
    const key = kind + '|' + name;
    const e = issues.get(key);
    if (e) { e.count++; return; }
    /* 每文件最多记多少个**不同名字**。以前 40，是"报告别太长"的产物；现在
       报告给 agent 读，截断只会让回路看不见问题 —— 提到 200（真正病态的文件
       仍然有上限，不至于让一个文件把索引撑爆）。 */
    if (issues.size >= 200) return;
    issues.set(key, { kind, name, count: 1, line: ln, sample: lineTextAt(ln) });
  };

  const push = (s, endLine) => {
    if (!s || !s.name) return;
    /* Attributes are not symbols. `__init`, `__user`, `__rcu` parsed as plain
       identifiers turn into bogus variables that then pollute symbol search and
       the context handed to the model (SPEC F1.16 坑 2). */
    if (isAttr(s.name)) return;
    s.file = relPath;
    s.source = s.source || 'tree-sitter';
    s.binds = [];
    symbols.push(s);

    /* 符号级自检（见上面 symStats 的说明）：用**整行原文**判，不能用截断过的
       样例文本 —— 名字可能落在 110 字之后。 */
    symStats.total++;
    const raw = rawLineAt(s.line);
    /* 名字在**下一行**是常态，不是缺陷：

         static void              <- 行号记的是这一行（声明起始）
         usage(int argc)          <- 名字在这儿

       以前只看"这一行里有没有这个名字"，于是 96.9% 的多行签名全被判成
       "定义回读失败"（2026-10-22 实测：1,080 条里 1,046 条是这种情况）。
       现在接受"上一行没结束、名字在下一行"。真问题（匿名 typedef 的名字在
       很多行以后）仍然会记下来。 */
    const nextRaw = rawLineAt(s.line + 1);
    const openDecl = !!raw && !/[;{}]\s*$/.test(raw);
    /* 宏生成的符号（`DEFINE_SHOW_ATTRIBUTE(foo)` → `foo_fops`）名字**本来就不在源码里**，
       那是规则算出来的，不是定位失败。不加这一条，每装一条规则就多一批假的 weakDef。 */
    const fromMacro = typeof s.source === 'string' && s.source.indexOf('macro') === 0;
    let nameNear = fromMacro || (openDecl && nextRaw.indexOf(s.name) >= 0);
    /* 匿名 typedef：名字在**收尾的 `}` 那一行**，可能离声明开头十几行。

         typedef struct {      <- 行号记这里（读者点进去就是想看整段）
             int a;
         } my_type;            <- 名字在这儿

       调用方把声明的结束行传进来，就按整段找一次；这不改跳转（跳开头才对），
       只是别让自检把它算成"回读失败"。 */
    /* 名字也可能在**上几行**：`} __aligned(8);` 这种收尾行被当成起点（实测
       `ccm_base` 就是这样），往前看 3 行就能把这类假 weakDef 消掉。 */
    if (!nameNear && s.line > 1) {
      for (let ln = Math.max(1, s.line - 3); ln < s.line; ln++) {
        if (rawLineAt(ln).indexOf(s.name) >= 0) { nameNear = true; break; }
      }
    }
    if (!nameNear && endLine && endLine > s.line) {
      const last = Math.min(endLine, s.line + 80);
      for (let ln = s.line + 1; ln <= last; ln++) {
        if (rawLineAt(ln).indexOf(s.name) >= 0) { nameNear = true; break; }
      }
    }
    if (raw && raw.indexOf(s.name) < 0 && !nameNear) {
      symStats.weakDef++;
      weak('weakDef', s, raw);
    } else if (!s.type && s.kind === KINDS.variable
      /* 展开产物（`macro-expand`）的"类型"本来就不在源码里：能推就推（见
         macro-expand 的 types），推不出也不该算成"解析缺陷" —— 否则内核一次
         +6.7 万个 noType，指标就废了（2026-10-23 实测）。 */
      && s.source.indexOf('macro-expand') !== 0) {
      /* **函数不算**：`atomic_add` 这种，知道它是函数就够了，返回值类型对
         "读代码 / 跳转"没有用（用户 2026-10-23 定）。只有变量缺类型才是
         真缺陷 —— 那会影响"这个变量的值是什么"。 */
      symStats.noType++;
      weak('noType', s, raw);
    } else if (s.kind === KINDS.member && !s.parent) {
      symStats.noOwner++;
      weak('noOwner', s, raw);
    }
  };

  /* ---- 「一段宏站点原文 → 规则效果」的唯一入口 --------------------------
     两个消费者共用：① `macro_type_specifier` 形状（`static FOO(a, b);` 里
     `FOO(a, b)` 整段被当成类型）② ERROR 区扫描（整条声明没解析出来）。
     参数一律按**原文**切（括号里的逗号在树里是 ERROR 节点，按子节点会错位）。 */

  /** `FOO(a, b)` 里括号内的原文；没有括号返回 ''。 */
  const innerParen = (raw) => {
    const s = String(raw || '');
    const open = s.indexOf('(');
    if (open < 0) return '';
    let depth = 0;
    for (let i = open; i < s.length; i++) {
      const ch = s[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return s.slice(open + 1, i);
      }
    }
    return '';
  };

  /**
   * 把一段宏站点按规则表兑现：已知宏 → 造符号；未知 → 记一笔台账。
   * @returns {boolean} true = 规则兑现过了（调用方可以停止下探）
   */
  const applyInlineMacro = (nm, body, ln, cfg, parent, opts) => {
    const args = String(body || '').trim()
      ? splitTop(body).map((t) => {
        const s = t.trim();
        return { text: s, ident: /^[A-Za-z_]\w*$/.test(s) };
      })
      : [];
    const rule = specOf(nm);
    /* `declare` 可能是空数组（容器 / 只备注的规则）；旧代码假定它一定存在，
       一条 container-only 规则就能把建索引整个打断。 */
    const decls = (rule && rule.declare) || [];
    if (rule && decls.length && rule.when !== 'call' && rule.when !== 'statement') {
      bumpHit(rule.name);
      for (const spec of decls) {
        const picked = spec.pattern ? fillPattern(spec.pattern, args) : argIdentOf(args[spec.arg]);
        if (!picked) continue;
        push({
          name: picked,
          kind: spec.kind || KINDS.variable,
          line: ln,
          config: cfg,
          type: spec.type || '',
          parent,
          source: 'macro ' + nm
        });
      }
      return true;
    }
    /* 规则表没有 → 试**有限递归展开**（`ATOMIC_OPS(add)` → `atomic_add`）。 */
    if (expandUnknown(nm, body, ln, cfg, parent)) return true;
    /* 仍未识别的：只记"像宏的名字"（大写），且**不在函数体内**（里面的基本是
       语句宏，`for_each_online_node(nid)` 这种记进来只会淹掉报告）。
       这两条与老路径的判据一致，不额外放宽。 */
    if (!(opts && opts.inFn) && MACRO_NAME_RE.test(nm)) note('macroDecl', nm, ln);
    return true;
  };

  /**
   * 未知宏 → 有限递归展开 → 造符号。
   *
   * @returns {boolean} true = 展开出了名字（已造符号，调用方不必再记账）
   */
  /* 展开结果按「宏名 + 实参原文」缓存（同一个文件里同类站点常常重复几十次）。 */
  const expandCache = new Map();
  const expandUnknown = (nm, argsText, ln, cfg, parent) => {
    if (!MACRO_TABLE || !MACRO_TABLE.has(nm)) return false;
    /* 调用形状传进来的是**整段** `(a, b)`，声明形状传的是括号内原文 ——
       统一成"括号内"，再按顶层逗号切。 */
    const raw = String(argsText || '');
    const body = raw.trim().charAt(0) === '(' ? innerParen(raw) : raw;
    const key = nm + '\u0000' + body;
    let r = expandCache.get(key);
    if (!r) {
      r = macroExpand.expandSiteToNames(MACRO_TABLE.get(nm), splitTop(body), MACRO_TABLE, MACRO_LANG);
      if (expandCache.size < 4000) expandCache.set(key, r);
    }
    if (!r.names.length) {
      /* 只有 `alias(...)` 别名、没有可用名字：这类宏**是看懂了**（它只给 modpost
         造符号，源码里没人引用），不该再进"未看懂"台账，否则 6,832 处
         MODULE_DEVICE_TABLE 又会把台账淹掉（2026-10-23）。 */
      return (r.reasons || []).some((x) => String(x).indexOf('alias') === 0);
    }
    let made = 0;
    for (const name of r.names) {
      if (isAttr(name)) continue;
      push({
        name,
        kind: r.kinds[name] === 'function' ? KINDS.function : KINDS.variable,
        line: ln,
        config: cfg,
        type: (r.types && r.types[name]) || '',
        parent,
        source: 'macro-expand ' + nm
      });
      made++;
    }
    if (made) bumpHit(nm);
    return made > 0;
  };

  /** ERROR/缺失片段是否在函数体内（里面的宏基本是语句宏，别记）。 */
  const insideFn = (n) => {
    let p = n.parent;
    while (p) {
      if (isNT(p.type, 'functionDefinition')) return true;
      p = p.parent;
    }
    return false;
  };
  /* ERROR 区最多记几个名字：坏头文件里的碎片不能把报告淹掉。 */
  let errSites = 0;

  /**
   * 宏站点的**唯一识别入口**（C Step 1，2026-10-23）。
   *
   * 现在覆盖三处：声明形状的两小类（`type_identifier` / `macro_type_specifier`）
   * 与 `ERROR` 片段 —— 它们识别出的东西完全同形（名字 + 参数原文 + 行号），
   * 交给同一个 `applyInlineMacro()` 兑现。
   *
   * **还没搬的**：调用形状（`call_expression`）与字段/初始化器。调用形状的
   * "容器宏判定 / 初始化器跳过"和记账逻辑缠在一起，单独一轮再搬（见 HANDOFF）。
   *
   * @returns {null|{shape:'declType'|'typeSpec'|'error', ...}}
   */
  const macroSiteOf = (node, parent) => {
    /* 调用形状：`LIST_HEAD(x)` 长得像普通调用，树里没有任何"这是宏"的标记，
       只能查规则表。认识的 → 造符号；不认识的按形状记一笔（见下）。 */
    if (isNT(node.type, 'callExpression')) {
      const m = macroCallOf(node, src);
      if (m) return { shape: 'call', name: m.name, args: m.args };
      /* 初始化器里的调用是**值**：`{ PCI_VDEVICE(INTEL, X), … }` 长得像文件作用域
         调用，其实是给表填值（实测 intel 目录一片 1214 处，全记会把报告淹掉）。 */
      if (inInitializer(node)) return null;
      const f = field(node, NN.function);
      const nm = (f && isNT(f.type, 'identifier')) ? textOf(f, src) : '';
      if (!nm || !MACRO_NAME_RE.test(nm) || nm.length < 3) return null;
      const args = rawArgsOf(node);
      const argText = textOf(field(node, NN.arguments)
        || childrenOfType(node, NN.argumentList)[0] || node, src);
      /* 「参数里带一个类型」是容器宏最强的信号（`container_of(p, struct s, m)`）——
         但判据必须**精确**：`struct s` 必须是**第 2 个参数的全文**。
         以前只要求"任意参数里出现 struct X"，于是
         `TP_PROTO(unsigned long vcpu_id, struct timer_map *map)`、
         `ACPI_CAST_PTR(struct acpi_namespace_node, h)` 这类全被误记成容器宏
         （内核实测 1,461 处噪声，2026-10-23）。 */
      const argParts = splitTop(argText);
      const second = String(argParts[1] || '').trim();
      const containerish = args.length >= 3
        && /^(?:const\s+)?(?:volatile\s+)?(?:struct|union|enum)\s+[A-Za-z_]\w*$/.test(second);
      if (containerish) {
        return { shape: 'callNote', kind: 'containerCall', name: nm, argText };
      }
      /* 文件作用域的调用才可能是"声明宏"；函数体里的大写宏基本是语句宏。 */
      if (!parent && args.some((a) => a.type === NN.identifier)) {
        return { shape: 'callNote', kind: 'macroCall', name: nm, argText };
      }
      return null;
    }

    if (isNT(node.type, 'errorNode')) {
      if (errSites >= 5 || insideFn(node)) return null;
      const raw = textOf(node, src);
      const re = /\b([A-Z][A-Z0-9_]{2,})\s*\(/g;
      const hits = [];
      let m;
      while ((m = re.exec(raw)) !== null && hits.length < 5) {
        const nm = m[1];
        if (isAttr(nm)) continue;
        /* 容器 / 只登记的宏已经在别处解释过，别在这里报成"声明没解析出来"。 */
        const rule = specOf(nm);
        if (rule && !(rule.declare || []).length) continue;
        hits.push({
          name: nm,
          body: innerParen(raw.slice(m.index)),
          line: node.startPosition.row + 1 + (raw.slice(0, m.index).split('\n').length - 1)
        });
      }
      return hits.length ? { shape: 'error', hits } : null;
    }

    /* ③ 字段位置的宏：这里**故意不再当成宏站点**。
       以前把 `struct s { FOO(a, b) m; }` 的整个 field_declaration 交给
       applyInlineMacro 后直接 return，于是 `__struct_group(…, __be32 saddr;)` 这种
       "宏只是包了一层"的字段整个被吃掉（`iphdr.saddr` 就是这么丢的，2026-11-15）。
       字段上下文优先：`fieldDeclaration` 分支自己会把声明符和裸 field_identifier
       都收进索引（宏调用名除外），类型文本照旧保留。 */
    if (isNT(node.type, 'fieldDecl')) return null;

    /* ③.5 裸的 `macro_type_specifier`（文件作用域，外层没有 declaration）：
       `DECLARE_PER_CPU_SHARED_ALIGNED(struct tlb_state, cpu_tlbstate);`
       整条语句就是它自己 —— 而且名字常常落在 ERROR 里（tree-sitter 只把第一个
       参数认成 `type_descriptor`，`", cpu_tlbstate"` 成了 ERROR）。外层是
       declaration / field_declaration 时不重复处理：那两处已经接过这一棒，
       walk 还会下探到这个子节点（2026-11-16，per-cpu 变量零定义的真因）。 */
    if (isNT(node.type, 'macroTypeSpecifier')) {
      const par = node.parent;
      if (par && (isNT(par.type, 'declaration') || isNT(par.type, 'fieldDecl'))) return null;
      const n = childrenOfType(node, NN.identifier)[0];
      const nm = n ? textOf(n, src) : '';
      return nm ? { shape: 'typeSpec', name: nm, body: innerParen(textOf(node, src)) } : null;
    }

    if (!isNT(node.type, 'declaration')) return null;
    const typeNode = field(node, NN.type);
    if (!typeNode) return null;

    /* ① `static FOO(a, b);`：多参数声明宏被当成一个"类型说明符" */
    if (isNT(typeNode.type, 'macroTypeSpecifier')) {
      const nmNode = childrenOfType(typeNode, NN.identifier)[0];
      const nm = nmNode ? textOf(nmNode, src) : '';
      if (!nm) return null;
      return { shape: 'typeSpec', name: nm, body: innerParen(textOf(typeNode, src)) };
    }

    /* ② 类型位置就是一个宏名：`static LIST_HEAD(x);`（单参数） */
    const name = textOf(typeNode, src).trim();
    if (!name) return null;
    const rule = specOf(name);
    if (rule && (rule.declare || []).length) {
      return { shape: 'declType', name, rule, decls: declaratorsOf(node) };
    }
    /* 不认识的：只有"像宏的名字 + 这一行确实是 `static FOO(`"才算站点 */
    if (MACRO_NAME_RE.test(name)
      && new RegExp('^\\s*(?:static\\s+|extern\\s+|inline\\s+)*'
        + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(').test(lineTextAt(node.startPosition.row + 1))) {
      return { shape: 'declType', name, rule: null, decls: [] };
    }
    return null;
  };

  /* ---- 宏包装字段（2026-11-15，`iphdr.saddr`） ----------------------------------
   * tree-sitter 遇到布局/属性宏会把声明形状打乱，两种典型：
   *   ① `__struct_group(…, __be32 saddr;)`：整个宏被当成**类型**（macro_type_specifier），
   *      字段名只是紧跟其后的裸 `field_identifier` —— declaratorsOf() 拿不到；
   *   ② `int d __aligned(4);`：名字被塞进 ERROR 节点，declarator 反而变成了
   *      `__aligned(4)` 这个"函数"。
   * 两种都按"这个 field_declaration 里所有 field_identifier"兜一遍；宏调用名
   * （`__aligned(4)`）挂在 function_declarator 里，跳过。类型取名字前面最后一个
   * 类型词序列（`__be32` / `int`）。
   */
  const stripBlockComments = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

  const typeBeforeIdentifier = (node, idNode, src) => {
    const cut = stripBlockComments(src.slice(node.startIndex, idNode.startIndex))
      .replace(/\s+/g, ' ')
      .trim();
    const m = /([A-Za-z_]\w*(?:\s+[A-Za-z_]\w*)*)$/.exec(cut);
    return m ? m[1] : '';
  };

  const looseFieldIdentifiers = (node) => {
    const out = [];
    const walkIds = (n, insideFn) => {
      const isFn = n.type === 'function_declarator';
      const skip = insideFn || isFn;
      for (const child of n.children) {
        if (!child) continue;
        if (child.type === 'field_identifier') {
          if (!skip) out.push(child);
          continue;
        }
        if (child.children && child.children.length) walkIds(child, skip);
      }
    };
    walkIds(node, false);
    return out;
  };

  /* 尾随属性宏（`int d __aligned(4);`）会让 tree-sitter 把 `__aligned(4)` 当成声明符，
     真正的名字 `d` 连节点都不剩。这类声明只能按文本恢复：去掉括号组后取最后一个
     标识符；如果最后一个是 `__xxx` 属性宏，就取它前面那个。 */
  /* 只有这些名字才当"尾随属性宏"。（不能见 `__` 就当属性：内核里 `__unused`、
     `__cloned_offset` 都是正常字段名。） */
  const ATTR_MACRO_RE = /^(?:__attribute__|__aligned(?:_largest)?|__packed|__randomize_layout|__ro_after_init|__read_mostly)$/u;

  const recoverFieldFromText = (raw) => {
    let s = stripBlockComments(raw);
    for (let i = 0; i < 5; i += 1) s = s.replace(/\([^()]*\)/g, ' ');
    s = s.replace(/[;,]/g, ' ').replace(/\s+/g, ' ').trim();
    if (s === '') return null;
    const tokens = s.split(' ').filter((t) => t !== '' && t !== '*');
    if (tokens.length < 2) return null;
    let name = tokens[tokens.length - 1];
    if (ATTR_MACRO_RE.test(name)) name = tokens[tokens.length - 2] || '';
    if (!/^[A-Za-z_]\w*$/u.test(name)) return null;
    return { name, type: tokens[0] };
  };

  const walk = (node, parent, cfg) => {
    if (!node) return;

    const cond = conditionOf(node, src);
    if (cond) {
      /* An `#else` branch is live when the branch before it was NOT, so its
         label REPLACES the one it is the alternative of; a nested `#ifdef`
         APPENDS. See condChainOf - including why the old
         "does my parent have a condition" test got every nested conditional in
         the kernel wrong. */
      const next = condChainOf(node, cfg, src);
      for (const m of next.match(/\[[^\]]*\]/g) || []) conds.add(m);
      for (let i = 0; i < node.childCount; i++) walk(node.child(i), parent, next);
      return;
    }

    /* 导入语句按表识别（第五块能力）：哪些节点是导入来自 imports.nodeTypes，
       路径怎么取来自 imports.line。语句内部没有符号，抓完就返回。 */
    if (IMPORT_NODES.has(node.type)) {
      for (const inc of importsOf(node, src)) includes.push(inc);
      return;
    }

    let nextParent = parent;
    const line = node.startPosition.row + 1;

    /* 宏站点：识别与兑现分两处 —— 识别全在这里（`macroSiteOf`），兑现只有一个
       入口（`applyInlineMacro`）。三种形状同形：名字 + 参数原文 + 行号。 */
    const site = macroSiteOf(node, parent);
    if (site) {
      if (site.shape === 'call') {
        /* 认识的宏（调用形状）：按规则造符号。参数照旧继续下探 —— 里面的名字
           仍然是普通引用（`container_of(p, struct s, m)` 的 p/m 要能被点到）。 */
        const rule = specOf(site.name);
        const decls = (rule && rule.declare) || [];
        if (rule && ((rule.relate && rule.relate.length)
          || (decls.length && rule.when !== 'declaration' && rule.when !== 'statement'))) {
          bumpHit(rule.name);
        }
        if (decls.length && rule.when !== 'declaration' && rule.when !== 'statement') {
          for (const spec of decls) {
            const picked = spec.pattern
              ? fillPattern(spec.pattern, site.args)
              : argIdentOf(site.args[spec.arg]);
            if (!picked) continue;
            push({
              name: picked,
              kind: spec.kind || KINDS.variable,
              line,
              config: cfg,
              type: spec.type || '',
              parent,
              source: 'macro ' + site.name
            });
          }
        }
      } else if (site.shape === 'callNote') {
        /* 不认识的大写宏：先试有限递归展开（`MODULE_DEVICE_TABLE` 就是这条），
           展开出名字就造符号；否则只记账，**继续下探**（参数里的名字仍是引用）。 */
        if (!expandUnknown(site.name, site.argText, line, cfg, parent)) {
          note(site.kind, site.name, line);
        }
      } else if (site.shape === 'error') {
        /* ERROR 区：整段没解析出来（`#ifdef` 包住的声明），扫到的每个站点都兑现。 */
        for (const h of site.hits) {
          if (errSites >= 5) break;
          applyInlineMacro(h.name, h.body, h.line, cfg, parent);
          errSites++;
        }
      } else if (site.shape === 'typeSpec') {
        /* 多参数声明形状（`static FOO(a, b);`）—— 括号里是宏的输入，不再下探。 */
        applyInlineMacro(site.name, site.body, line, cfg, parent, { inFn: insideFn(node) });
        return;
      } else {
        /* 类型位置就是一个宏名（`static LIST_HEAD(x);`）。 */
        const rule = site.rule;
        if (rule) {
          bumpHit(rule.name);
          /* 声明形状：`(x)` 是 parenthesized_declarator，没有 argument_list，
             但括号里那串对规则来说**就是参数表**，按位置取（`arg` / `$N`）。 */
          for (const d of site.decls) {
            const n = declaratorName(d, src);
            if (!n || isAttr(n)) continue;
            const inner = declaratorArgs(d, src);
            for (const spec of rule.declare) {
              let name;
              if (spec.pattern) {
                name = fillPattern(spec.pattern, (inner && inner.length) ? inner : [n]);
              } else if (inner && inner.length > spec.arg) {
                name = argIdentOf(inner[spec.arg]);
              } else if (spec.arg === 0) {
                name = n;
              } else {
                name = '';
              }
              if (!name) continue;
              push({
                name,
                kind: spec.kind || KINDS.variable,
                line: d.startPosition ? d.startPosition.row + 1 : line,
                config: cfg, type: spec.type || '', parent,
                source: 'macro ' + site.name
              });
            }
          }
          /* RETURN, do not break: `static LIST_HEAD(x);` also contains a
             `call_expression` for the same macro, and walking into it declared
             `x` a second time. The arguments of a declaration macro are names -
             nothing below this node needs visiting. */
          return;
        }
        /* 不认识（或规则只对调用形状成立）：记一笔给报告 / 台账，别让它消失。 */
        note('macroDecl', site.name, line);
        return;
      }
    }
    /* 按「角色」分支，不按节点名：同一个角色可以对应多个节点类型（Rust 的
       fn 实体与 fn 签名、Go 的函数与方法），C 的表里角色与节点名一一对应，
       所以 C 的行为不变。 */
    const role = roleOf(node.type);

    switch (role) {
      case 'preprocInclude': {
        const p = field(node, NN.path)
          || childrenOfType(node, NN.stringLiteral)[0]
          || childrenOfType(node, NN.systemLibString)[0];
        if (p) includes.push(textOf(p, src).replace(/^[<"]|[>"]$/g, ''));
        break;
      }

      case 'preprocDef': {
        const n = field(node, NN.name) || childrenOfType(node, NN.identifier)[0];
        if (n) {
          push({
            name: textOf(n, src), kind: KINDS.macro, line, config: cfg,
            params: [], value: textOf(field(node, NN.value), src).trim()
          });
        }
        break;
      }

      case 'preprocFunctionDef': {
        const n = field(node, NN.name) || childrenOfType(node, NN.identifier)[0];
        if (n) {
          const list = field(node, NN.parameters) || childrenOfType(node, NN.preprocParams)[0];
          const params = list
            ? Array.from({ length: list.childCount }, (_, i) => list.child(i))
                .filter((c) => c && c.type === NN.identifier)
                .map((c) => textOf(c, src))
            : [];
          push({
            name: textOf(n, src), kind: KINDS.macro, line, config: cfg,
            params, value: textOf(field(node, NN.value), src).trim()
          });
        }
        break;
      }

      case 'functionDefinition': {
        const d = field(node, NN.declarator);
        /* Rust / Go 把名字直接挂在函数节点上，没有 declarator 这一层。 */
        const name = declNameOf(node, src) || declaratorName(d, src);
        /* NO parameter list in the declarator chain -> not a function, however
           much the shape looks like one: `for_each_possible_cpu(cpu) { ... }`
           is a macro invocation over a block. Skipping the record also keeps
           the block's locals under the ENCLOSING function instead of under a
           function named after the loop variable (2026-10-15). */
        if (name && (hasParameterList(d) || field(node, NN.parameters))) {
          const params = paramsOf(d || field(node, NN.parameters), src);
          /* Go 的接收者（`func (p *Packet) Encode()`）也是方法作用域里的变量，
             但它不属于调用签名，只作为参数符号登记。 */
          const extra = [];
          for (const f of (SYN.extraParamFields || [])) {
            const lst = field(node, f);
            if (lst) for (const p of paramsOf(lst, src)) extra.push(p);
          }
          const rec = {
            name, kind: KINDS.function, line, config: cfg,
            type: typeTextOf(node, src), params
          };
          /* 方法归谁：Go 由 receiver 的类型名决定（`func (p *Packet) Encode()`
             属于 Packet）；Rust 由 containerNodes（impl）提供。C/C++ 的函数都是
             顶层的，加了会让旧快照多一个空键。 */
          const owner = receiverNameOf(node, src);
          if (owner) rec.parent = owner;
          else if (parent && ((SYN.containerNodes && SYN.containerNodes.length) || DECL_PARENT)) rec.parent = parent;
          push(rec);
          nextParent = name;
          for (const p of params.concat(extra)) {
            if (p.name !== NN.ellipsis) {
              push({
                name: p.name, kind: KINDS.parameter, line: p.line || line,
                config: cfg, type: p.type, parent: name
              });
            }
          }
        }
        break;
      }

      case 'structSpecifier':
      case 'unionSpecifier':
      case 'enumSpecifier': {
        /* Only a DEFINITION (it has a body) becomes a symbol. `struct sock *p`
         * mentions the specifier too, and indexing those produced three copies
         * of the same struct name. */
        const body = field(node, NN.body) || childrenOfType(node, NN.fieldDeclarationList)[0]
          || childrenOfType(node, NN.enumeratorList)[0];
        const nameNode = field(node, NN.name) || childrenOfType(node, NN.typeIdentifier)[0];
        const name = nameNode ? textOf(nameNode, src) : '';
        if (name && body) {
          const kind = role === 'structSpecifier' ? KINDS.struct
            : role === 'unionSpecifier' ? KINDS.union : KINDS.enum;
          push({ name, kind, line, config: cfg, params: [] });
          nextParent = name;
        }
        break;
      }

      case 'fieldDeclaration': {
        /* 一条字段声明可能声明多个名字：`unsigned char *head, *data;`
           （struct sk_buff）。以前只取第一个声明符，`data` 永远不进索引，
           于是 `skb->data` 只能按名字撞到别处的同名变量 —— 用户 2026-11-08 报的
           264 行就是这一类。这里按声明符逐个入索引，名字、行号、指针层数都各算各的。 */
        const decs = declaratorsOf(node);

        if (decs.length === 0) {
          const one = field(node, NN.name) || field(node, NN.declarator);
          if (one) decs.push(one);
        }
        const rawType = typeTextOf(node, src);
        const baseType = rawType.replace(/\s*\*+\s*$/, '').trim();
        /* 类型本身是包装宏时（`__struct_group(…, __be32 saddr;)`），rawType 是整段
           宏文本，不能当成员类型；逐个成员按"名字前面最后一个类型词"重算。 */
        const typeNodeOfField = field(node, NN.type);
        const typeIsMacroField = !!(typeNodeOfField && isNT(typeNodeOfField.type, 'macroTypeSpecifier'));
        const seen = new Set();
        let emitted = 0;
        for (const dec of decs) {
          let name = declaratorName(dec, src);
          if (!name && dec && dec.type === NN.identifier) name = textOf(dec, src);
          /* Go 的嵌入字段没有名字（`struct { io.Reader }`）：名字取类型最后一段。 */
          if (!name && SYN.declNamesFromType && SYN.declNamesFromType.indexOf(node.type) >= 0) {
            const emb = embedFieldNamesOf(node, src);
            if (emb.length) name = emb[0].name;
          }
          if (!name || seen.has(name)) continue;
          seen.add(name);

          /* `void foo(int a);` 写在结构体里是原型，不是成员；但 `int d __aligned(4);`
             会被解析成"类型 int + 函数声明符 __aligned(4)"—— 属性宏不是函数，跳过，
             留给下面的文本恢复。 */
          const fnDecl = dec && isNT(dec.type, 'functionDeclarator') ? field(dec, NN.declarator) : null;
          const bareName = fnDecl && (isNT(fnDecl.type, 'identifier') || isNT(fnDecl.type, 'fieldIdentifier'));
          if (bareName) {
            if (/^__/u.test(name) || isAttr(name)) continue;
            push({
              name, kind: KINDS.function, config: cfg, type: baseType, parent: '',
              line: fnDecl.startPosition ? fnDecl.startPosition.row + 1 : line
            });
            continue;
          }
          const stars = ownStars(dec);
          const resolvedType = typeIsMacroField
            ? (typeBeforeIdentifier(node, dec, src) || baseType)
            : baseType;
          const memberType = resolvedType + (stars > 0 ? ` ${'*'.repeat(stars)}` : '');
          push({
            name,
            kind: KINDS.member,
            config: cfg,
            type: memberType,
            parent,
            line: dec && dec.startPosition ? dec.startPosition.row + 1 : line
          });
          emitted += 1;
        }

        /* 宏包装/属性宏里漏掉的字段（见上面 looseFieldIdentifiers 的注释）。 */
        for (const idNode of looseFieldIdentifiers(node)) {
          const looseName = textOf(idNode, src);
          if (!looseName || seen.has(looseName)) continue;
          seen.add(looseName);
          push({
            name: looseName,
            kind: KINDS.member,
            config: cfg,
            type: typeBeforeIdentifier(node, idNode, src) || baseType,
            parent,
            line: idNode.startPosition ? idNode.startPosition.row + 1 : line
          });
          emitted += 1;
        }

        /* 声明符被属性宏吃掉、AST 里连名字节点都没有的（`int d __aligned(4);`）：
           按文本恢复一次，避免整个字段消失。 */
        if (emitted === 0) {
          const recovered = recoverFieldFromText(textOf(node, src));
          /* 不要看 `seen`：属性宏的名字可能已经被当成"函数"记过一笔（emitted 仍是 0），
             那不影响这里补一个成员。 */
          if (recovered !== null) {
            push({
              name: recovered.name,
              kind: KINDS.member,
              config: cfg,
              type: recovered.type,
              parent,
              line
            });
          }
        }
        break;
      }

      case 'enumerator': {
        const n = field(node, NN.name) || childrenOfType(node, NN.identifier)[0];
        if (n) {
          const name = textOf(n, src);
          push({
            name, kind: KINDS.enumMember, config: cfg, parent,
            line: n.startPosition.row + 1
          });
          /* 变体自己的字段属于变体（`Failed { code }` 的 code 不该挂到枚举上）。 */
          nextParent = name;
        }
        break;
      }

      case 'typeDefinition': {
        /* `declNameOf` 拿不到名字时（`typedef u16 uint16_t;` 的声明符是
           primitive_type，不是 identifier）走声明符兜底 —— 少了这一步，
           uint16_t / uint8_t / ssize_t 这一类标准定宽整型全都没有定义。 */
        const name = declNameOf(node, src) || typedefDeclaratorName(node, src);
        if (name) {
          /* 结束行交给自检：匿名 typedef 的名字在收尾的 `}` 那一行，离开头可能十几行。
             跳转仍用开头（读者要的是整段声明），只是别把它算成"回读失败"。 */
          push({ name, kind: KINDS.typedef, line, config: cfg, type: typeTextOf(node, src) },
            node.endPosition ? node.endPosition.row + 1 : 0);
          /* 匿名 struct/union/enum 的 typedef：成员没有标签可挂，只能挂到 typedef
             的名字上。

                 typedef struct { int a; } my_type;   →  a 属于 my_type

             有标签的（`typedef struct tag {…} T;`）**不抢** —— 那些成员属于 `tag`，
             抢过来会让 `p->a`（p 的类型解析成 tag）找不到成员（2026-10-22）。 */
          const inner = field(node, NN.type);
          if (inner && !field(inner, NN.name)) nextParent = name;
        }
        break;
      }

      case 'declaration': {
        /* `let x = v;` 的形状：名字在 `pattern` 字段里，`=` 后面的都是使用。
           必须在下面的 C 形状逻辑之前处理 —— declaratorsOf 会把初始化器里的
           identifier 也当成声明（它只会跳过 type 字段）。 */
        const pat = field(node, NN.pattern);
        if (pat) {
          for (const id of patternIdentifiers(pat, NN, src)) {
            push({
              name: id.name, kind: KINDS.variable, line: id.line,
              config: cfg, type: typeTextOf(node, src), parent
            });
          }
          break;
        }

        /* `int a = 1, *b, c[8];` declares three names: the declarator field
         * repeats, so childrenForFieldName is the only way to see them all. */
        const type = typeTextOf(node, src);

        /* `static const struct { char *n; } arr[] = …`：类型**没有名字**，成员只能
           挂到**变量**上 —— 在这个文件里 `arr` 就是这个匿名类型的唯一实例，挂给谁
           都比挂空强（用户 2026-10-22 指出：static 的东西本文件内查就够了）。
           有标签的 `struct tag {…} x;` 不走这条 —— 那些成员属于 `tag`。 */
        const tNode = field(node, NN.type);
        if (tNode && !field(tNode, NN.name)
          && (isNT(tNode.type, 'structSpecifier') || isNT(tNode.type, 'unionSpecifier')
            || isNT(tNode.type, 'enumSpecifier'))) {
          const first = declaratorsOf(node)[0];
          const own = first ? declaratorName(first, src) : '';
          if (own) nextParent = own;
        }

        /* 声明位置上的宏站点（`static LIST_HEAD(x);` / `static FOO(a, b);` /
           不认识的声明宏）已经在 walk 顶部由 `macroSiteOf()` 统一识别并返回 ——
           走到这里的 declaration 一定不是宏站点，按普通 C 声明继续。 */

        const decls = declaratorsOf(node);
        const seen = new Set();
        for (const d of decls) {
          const name = declaratorName(d, src);
          if (!name || seen.has(name)) continue;
          seen.add(name);
          /* ...and the same rule here: a declarator that sits on its own line
             inside a multi-line declaration gets ITS line. */
          const dLine = d.startPosition ? d.startPosition.row + 1 : line;

          /* A declaration whose declarator is a function declarator is a
           * prototype, not a variable: `struct s *lookup(int key);` */
          const isProto = d.type === NN.functionDeclarator
            || (d.type === NN.pointerDeclarator
                && field(d, NN.declarator) && field(d, NN.declarator).type === NN.functionDeclarator);

          if (isProto) {
            /* A prototype keeps the DECLARATION's line on purpose: a function's
               line is where its signature starts (the return type), which is what
               the panel opens and what the reader expects. */
            push({
              name, kind: KINDS.function, line, config: cfg, type,
              params: paramsOf(d, src), prototype: true
            });
          } else {
            /* `extern struct inet_hashinfo tcp_hashinfo;` DECLARES the variable -
               the definition is in another translation unit. Filed as a
               declaration (the same flag a function prototype uses) so the panel
               can say so and rank the real definition first (user requirement
               2026-10-14). `extern` itself stays visible in the code line. */
            push({
              name, kind: KINDS.variable, line: dLine, config: cfg, type, parent,
              prototype: isExternDecl(node, src)
            });
          }
        }
        break;
      }

      case 'callExpression': {
        /* 调用形状的宏站点已经由 walk 顶部的 macroSiteOf() 统一识别并处理
           （认识的造符号、不认识的记账），这里只剩普通调用，继续下探即可。 */
        break;
      }

      default: {
        /* 数据驱动的 item：表里声明「这个节点是个符号，kind 是 X」(
           `syntax.declKinds`)，引擎不为每种语言写一个 case。kind 也可以由内部
           类型节点决定（`syntax.kindFromChild`：Go 的 `type Foo struct`）。 */
        const kind = declKindOf(node);
        if (kind && DECL_NODES.has(node.type)) {
          let names = declNamesOf(node, src);
          /* Go 的嵌入字段没有名字（`struct { io.Reader }`）：名字取类型的最后
             一段（表里用 declNamesFromType 声明哪些节点适用，2026-10-23）。 */
          if (!names.length && SYN.declNamesFromType
            && SYN.declNamesFromType.indexOf(node.type) >= 0) {
            names = embedFieldNamesOf(node, src);
          }
          if (names.length) {
            /* Go 的接口方法把参数表挂在 method_spec 自己身上。 */
            const params = DECL_PARAMS.has(node.type)
              ? paramsOf(field(node, NN.parameters) || node, src) : [];
            for (const it of names) {
              const rec = {
                name: it.name, kind, line: it.node.startPosition.row + 1, config: cfg,
                /* 只有变量/别名/函数才有"类型"：宏体、trait 自己的名字都不能算类型。
                   函数的返回类型也走这里（Go 接口方法 `Encode() []byte`）。 */
                type: (kind === KINDS.variable || kind === KINDS.typedef
                  || kind === KINDS.function)
                  ? typeTextOf(node, src) : '',
                params: params.slice()
              };
              /* Go：接口方法属于接口类型（`type Codec interface { Encode() }`）。 */
              if (DECL_PARENT && parent) rec.parent = parent;
              push(rec);
            }
            nextParent = names[0].name;
          }
        } else if (SYN.containerNodes && SYN.containerNodes.indexOf(node.type) >= 0) {
          /* 只给成员提供 parent（`impl Foo { fn bar() }` 里的 bar 属于 Foo），
             自身不出符号。 */
          const owner = field(node, NN.type) || field(node, NN.name);
          if (owner) nextParent = textOf(owner, src).replace(/\s+/g, ' ').trim();
        }
        break;
      }
    }

    for (let i = 0; i < node.childCount; i++) walk(node.child(i), nextParent, cfg);
  };

  walk(tree.rootNode, null, null);

  /* 属性宏自己的 `#define`：`blankAttributes()` 在解析前把这些名字抹成等长空格
     （否则 `static int __init f(void)` 会被撕成"变量 __init + 定义 f"），
     于是它们的**定义**也一起消失了 —— 用户点 `__read_mostly` 看到"没有定义"，
     可内核明明 `#define` 了（实测 ATTR 96 个名字里 59 个真的有定义）。
     这里按原文补一遍，只补 `#define <ATTR 名>`，不改变解析结果。 */
  {
    const ATTR_DEFINE_RE = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)/gm;
    const seenAttr = new Set();
    let m = ATTR_DEFINE_RE.exec(text);
    while (m !== null) {
      const name = m[1];
      if (KM.ATTR.has(name) && !seenAttr.has(name)) {
        seenAttr.add(name);
        symbols.push({
          name,
          kind: KINDS.macro,
          line: text.slice(0, m.index).split('\n').length,
          config: null,
          type: '',
          parent: '',
          source: 'attribute macro'
        });
      }
      m = ATTR_DEFINE_RE.exec(text);
    }
  }

  /* Pass 2: uses. Collected before the tree is released, of course. */
  const scope = scopeTableOf(symbols);
  /* Go 的包名表：`import "net/http"` → `http`。表格语言里没有 selector_expression
     的（C/Rust）根本不会建这个集合，行为不变。 */
  const pkgNames = new Set();
  if (NN.selectorExpression) {
    for (const inc of includes) {
      const seg = String(inc).replace(/[\\/]+$/, '').split('/').pop() || '';
      if (/^[A-Za-z_]\w*$/.test(seg)) pkgNames.add(seg);
    }
  }
  const pass2 = refsOf(tree, src, scope, typeNames, pkgNames);
  const refs = pass2.refs;

  tree.delete();
  parser.delete();

  return {
    symbols,
    includes,
    conds: Array.from(conds),
    refs,
    /* 解析降级清单（按名字聚合）：索引报告与增强包的输入。 */
    issues: Array.from(issues.values()),
    /* 每条规则在本文件命中多少次（`declare` / `container` / `relate` / `mask`）。 */
    ruleHits: HITS ? Object.fromEntries(HITS) : {},
    /* 符号级自检：只出计数与少量样例（衡量"讲不清的符号"有多少）。 */
    symStats,
    /* 接收者形状普查（待解析台账第四节）。 */
    recvStats: pass2.recvStats,
    /* Kept so the resolver can tell a type use from a value use later on
     * (SPEC F1.12 / D16 L1). */
    typeNames: Array.from(typeNames)
  };
}

module.exports = {
  PARSER_REV,
  setMacroTable,
  ensureReady, isReady, extract, setEnhance,
  /* KINDS 现在是「当前语言的 kind 词汇」，按取用时刻读 —— 导出成 getter，
     免得调用方拿到某一门语言的快照。 */
  get KINDS() { return KINDS; }
};
