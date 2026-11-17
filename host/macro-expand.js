'use strict';
/*
 * 有限递归宏展开（2026-10-23）—— 只回答一个问题：**这个宏站点会拼出哪些名字**。
 *
 * WHY. 有些宏要展开两三层才看得见符号：
 *
 *     ATOMIC_OPS(add)
 *       → ATOMIC_OP(add) ATOMIC_OP_RETURN(add) …
 *           → static inline int atomic_##op(...)   ← 名字在这里才拼出来
 *     MODULE_DEVICE_TABLE(of, arc_pmu_match)
 *       → extern typeof(name) __mod_##type##__##name##_device_table …
 *
 * 只读一层 `#define` 永远看不见 `atomic_add`。所以需要**有限**递归展开：深度 ≤3、
 * 结果 ≤4KB、每个站点最多取 8 个名字。
 *
 * 语义照抄 tcc / mcpp 的那一套（不是自己发明）：
 *   · `##` 两侧**不预先展开**参数（先粘贴，再整体替换）
 *   · `#param` 是字符串化，产出不是符号 → 这一支直接放弃
 *   · `__VA_ARGS__` / `##__VA_ARGS__`（GNU 逗号吞并）→ 放弃，不猜
 *   · hide-set（蓝集合）：正在展开的宏名进集合，同名不再展开 —— 这是 `#define X X`
 *     这类自我递归唯一正确的终止方式
 *
 * 本模块是**纯函数**：吃"定义候选 + 实参原文"，吐"名字集合"。不碰索引、不碰文件。
 * 不做条件编译、不做 include、不做 pragma —— 那些是编译器的事。
 */

const IDENT = /^[A-Za-z_]\w*$/;

/** 按顶层逗号切（括号/方括号/花括号内的逗号不算），与 ts-indexer 的 splitTop 同义。 */
function splitTop(text) {
  const s = String(text || '');
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((t) => t.trim()).filter((t) => t.length > 0);
}

/** 把宏体按 token 切开，`##` / `#` 各算一个 token（其余按标识符/其它分块）。 */
function tokenize(body) {
  const out = [];
  const re = /\s*(##|#|[A-Za-z_]\w*|\S)/g;
  let m;
  while ((m = re.exec(String(body || ''))) !== null) {
    if (!m[1]) continue;
    out.push(m[1]);
  }
  return out;
}

/**
 * 一次替换：把 `params` 里的形参换成实参，处理 `##` 粘贴与 `#` 字符串化。
 *
 * @returns {{text:string, hasStringify:boolean, hasVa:boolean}}
 */
function substituteOnce(body, params, args) {
  const toks = tokenize(body);
  let hasStringify = false;
  let hasVa = false;
  const out = [];
  const at = new Map(params.map((p, i) => [p, i]));

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === '__VA_ARGS__') { hasVa = true; out.push(t); continue; }
    if (t === '#') {
      const nx = toks[i + 1];
      if (nx && at.has(nx)) {
        hasStringify = true;
        out.push('"' + String(args[at.get(nx)] || '').replace(/"/g, '\\"') + '"');
        i++;
      } else {
        out.push(t);
      }
      continue;
    }
    if (t === '##') { out.push('##'); continue; }
    if (at.has(t)) { out.push(String(args[at.get(t)] || '')); continue; }
    out.push(t);
  }

  /* `##` 粘贴：把前一段与后一段直接接起来（两侧都不再单独展开，符合标准语义）。 */
  const glued = [];
  for (let i = 0; i < out.length; i++) {
    if (out[i] === '##' && glued.length && i + 1 < out.length) {
      glued[glued.length - 1] = glued[glued.length - 1] + out[i + 1];
      i++;
    } else {
      glued.push(out[i]);
    }
  }
  return { text: glued.join(' ').replace(/\s+/g, ' ').trim(), hasStringify, hasVa };
}

/**
 * 展开一段文本里所有"能在表里找到定义"的宏调用（深度优先，带 hide-set）。
 *
 * @param {string} text
 * @param {Map<string, Array<{params:string[], body:string}>>} table
 * @param {Set<string>} hide 正在展开的宏名
 * @param {{maxDepth:number, maxBytes:number}} opt
 * @returns {string[]} 所有可能的最终文本（多候选定义 → 多个文本）
 */
function expandCalls(text, table, hide, opt, depth) {
  if (depth > opt.maxDepth || String(text).length > opt.maxBytes) return [String(text)];

  const src = String(text);
  /* 找第一个可展开的调用：`NAME(...)`，NAME 在表里且不在 hide 中。 */
  const re = /\b([A-Za-z_]\w*)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    if (hide.has(name) || !table.has(name)) continue;
    const open = m.index + m[0].length - 1;
    /* 括号配对：找到与 `open` 匹配的 `)` */
    let depthP = 0;
    let close = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '(') depthP++;
      else if (src[i] === ')') {
        depthP--;
        if (depthP === 0) { close = i; break; }
      }
    }
    if (close < 0) return [src];
    const rawArgs = splitTop(src.slice(open + 1, close));
    const prefix = src.slice(0, m.index);
    const suffix = src.slice(close + 1);

    const results = [];
    for (const def of table.get(name)) {
      const params = def.params || [];
      /* 参数个数对不上就跳过这一份定义（`ATOMIC_OPS` 在 alpha 有两份：一份 1 参、
         一份 2 参，正好靠这个区分）。 */
      if (params.length !== rawArgs.length) continue;
      const one = substituteOnce(def.body, params, rawArgs);
      /* 字符串化不致命：`#asm_op` 只是变成字符串字面量，body 里别的声明照样有效
         （`ATOMIC_OP(op, asm_op)` 的 body 里就有 `#asm_op`）。只有 `__VA_ARGS__`
         是真的没法推 —— 参数个数未知。 */
      if (one.hasVa) continue;
      const nextHide = new Set(hide);
      nextHide.add(name);
      /* **一次只展开一个调用**，然后把整段（含前后的兄弟调用）再递归一遍：
         宏体里往往有好几个调用（ATOMIC_OPS 一口气 6 个），只展开第一个就停，
         剩下的名字永远出不来；而用"整段重扫"就不需要维护偏移。 */
      const joined = (prefix + ' ' + one.text + ' ' + suffix).replace(/\s+/g, ' ').trim();
      for (const more of expandCalls(joined, table, nextHide, opt, depth + 1)) {
        results.push(more);
        if (results.length >= 8) break;
      }
    }
    if (!results.length) return [src];        /* 展开不了就原样返回 */
    return results;
  }
  return [src];
}

/**
 * 从展开结果里挑出"声明形状"的名字。
 *
 * 只认两种：`struct/union/enum X name` 与 `类型 name`（类型来自语言表的标量词表或
 * `_t` 后缀）。名字后面必须紧跟 `=` / `;` / `[` / `(` 之一 —— 这样 `return x`
 * 这类不会混进来。
 */
function declaredNamesIn(text, table, outKinds, outTypes) {
  const scalars = new Set((table && table.scalars) || []);
  const specs = new Set((table && table.typeSpecs) || []);
  const suffix = (table && table.typeSuffix) || '_t';
  const out = new Set();
  const src = String(text || '');
  /* kind：名字后面紧跟 `(` 的是函数，其余按变量。宏展开时我们没有语法树，
     这条文本判据够用（`atomic_##op(...)` 就是函数）。 */
  const add = (name, at, type) => {
    if (!IDENT.test(name)) return;
    out.add(name);
    if (outKinds && outKinds[name] === undefined) {
      outKinds[name] = src.charAt(at) === '(' ? 'function' : 'variable';
    }
    if (outTypes && type && !outTypes[name]) outTypes[name] = type;
  };
  /* 只看**顶层**（花括号深度 0）：宏体里常有局部变量（`unsigned long temp;`），
     它们不是这个宏产出的符号 —— 实测 ATOMIC_OP 的展开里就混进了 `temp`。
     深度**预先算一次前缀和**：早先每个匹配都从 0 扫到匹配位置，宏体一大就是
     O(n²)（内核全树建索引实测被它拖慢两分多钟，2026-10-23）。 */
  const depthAt = new Int32Array(src.length + 1);
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    depthAt[i + 1] = depthAt[i] + (c === '{' ? 1 : (c === '}' ? -1 : 0));
  }
  const topLevel = (idx) => depthAt[idx] === 0;

  /* `struct X name` / `union X name` / `enum X name` */
  const specRe = /\b(struct|union|enum)\s+([A-Za-z_]\w*)\s*\**\s*([A-Za-z_]\w*)\s*(?=[=;[(])/g;
  let m;
  while ((m = specRe.exec(src)) !== null) {
    if (topLevel(m.index)) add(m[3], m.index + m[0].length, m[1] + ' ' + m[2]);
  }

  /* `extern typeof(x) name __attribute__…`（`MODULE_DEVICE_TABLE` 的展开形状）：
     类型写成 `typeof(...)` 时上面的标量表判不出来，单独认一次。 */
  const typeofRe = /\btypeof\s*\(\s*[A-Za-z_]\w*\s*\)\s*\**\s*([A-Za-z_]\w*)\s*(?=[=;[(]|\s|$)/g;
  while ((m = typeofRe.exec(src)) !== null) {
    if (topLevel(m.index)) add(m[1], m.index + m[0].length);
  }

  /* `类型 name`：类型在标量表里或以 `_t` 结尾 */
  const tokRe = /\b([A-Za-z_]\w*)\s*\**\s*([A-Za-z_]\w*)\s*(?=[=;[(])/g;
  while ((m = tokRe.exec(src)) !== null) {
    if (!topLevel(m.index)) continue;
    const t = m[1];
    if (!scalars.has(t) && !(suffix && t.endsWith(suffix))) continue;
    if (specs.has(t)) continue;
    add(m[2], m.index + m[0].length, t);
  }
  return Array.from(out);
}

/**
 * 一个宏站点展开后**可能拼出的所有名字**。
 *
 * @param {Array<{params:string[], body:string}>} defs 该宏在项目里的全部候选定义
 * @param {string[]} args 站点实参原文
 * @param {Map} table 全局宏表（用于递归展开体内调用的其它宏）
 * @param {object} langTable 语言词表（`syntax.macroDerive`，判类型用）
 * @param {object} opts {maxDepth, maxBytes, maxNames}
 * @returns {{names:string[], variants:number, reasons:string[]}}
 */
function expandSiteToNames(defs, args, table, langTable, opts) {
  const o = Object.assign({ maxDepth: 3, maxBytes: 4096, maxNames: 8 }, opts || {});
  const reasons = [];
  if (!Array.isArray(defs) || !defs.length) return { names: [], variants: 0, reasons: ['没有可用的定义'] };
  if (!table || !table.size) return { names: [], variants: 0, reasons: ['宏表为空'] };

  const names = new Set();
  const kinds = {};
  const types = {};
  let variants = 0;
  const argList = (args || []).map((a) => String(a).trim()).filter((a) => a.length > 0);

  for (const def of defs) {
    const params = def.params || [];
    if (params.length !== argList.length) continue;   /* 参数个数不符：这份不适用 */
    variants++;
    const one = substituteOnce(def.body, params, argList);
    if (one.hasVa) { reasons.push('__VA_ARGS__'); continue; }
    /* `alias(...)` 别名声明只服务构建系统（`modpost` 扫 ELF 符号表），源码里
       永远没人引用它 —— 造出来是死符号（2026-10-23 实测：
       `__mod_pnp__el3_pnp_ids_device_table` 定义 1 条、引用 0 条，
       而 `atomic_add` 是 19 定义 / 237 引用）。 */
    if (/\balias\s*\(/.test(one.text)) { reasons.push('alias 别名（源码无人引用）'); continue; }
    if (one.hasStringify) reasons.push('含字符串化');
    const hide = new Set();
    for (const text of expandCalls(one.text, table, hide, o, 0)) {
      for (const n of declaredNamesIn(text, langTable, kinds, types)) {
        if (!IDENT.test(n)) continue;
        names.add(n);
        if (names.size >= o.maxNames) return { names: [...names], kinds, types, variants, reasons };
      }
    }
  }
  if (!names.size && !reasons.length) reasons.push('展开结果里没有声明形状');
  return { names: [...names], kinds, types, variants, reasons };
}

/**
 * 从"文件列表 → 定义记录"建全局宏表（同名的全部保留为候选）。
 * @param {Array<{name:string, params:string[], body:string, file?:string, line?:number}>} records
 */
function buildTable(records) {
  const t = new Map();
  for (const r of records || []) {
    if (!r || !r.name) continue;
    if (!t.has(r.name)) t.set(r.name, []);
    t.get(r.name).push({ params: r.params || [], body: r.body || '', file: r.file || '', line: r.line || 0 });
  }
  return t;
}

/**
 * 从一段源码里抓 `#define`（纯文本，不走语法树）。
 *
 * 这是"并行预扫宏表"的取数口径：只需要 名字 / 形参 / 宏体，`\` 续行要接起来。
 * 刻意**不**处理注释里的假 `#define`（行首的 `#define` 在内核里基本不会出现在
 * 注释或字符串中；真出现也只是一条多余的定义，不会造成错名字）。
 *
 * @returns {Array<{name:string, params:string[], body:string, line:number}>}
 */
function extractDefines(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*#\s*define\s+([A-Za-z_]\w*)\s*(\(([^)]*)\))?\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let body = m[4] || '';
    let j = i;
    while (/\\\s*$/.test(body) && j + 1 < lines.length) {
      body = body.replace(/\\\s*$/, ' ') + lines[++j];
    }
    out.push({
      name: m[1],
      params: m[2] === undefined ? [] : String(m[3] || '').split(',').map((s) => s.trim()).filter(Boolean),
      body: body.replace(/\s+/g, ' ').trim(),
      line: i + 1
    });
  }
  return out;
}

/**
 * 只留下"可能拼出新名字"的定义：宏体里含 `##`，以及**间接**调用到它们的那些
 * （一层闭包）。宏表只给展开器用，全量塞过去会让每个 worker 多背十几 MB。
 */
function relevantDefines(defs) {
  const byName = new Map();
  for (const d of defs) {
    if (!byName.has(d.name)) byName.set(d.name, []);
    byName.get(d.name).push(d);
  }
  const keep = new Set();
  for (const d of defs) if (d.body.indexOf('##') >= 0) keep.add(d.name);
  /* 一层闭包：body 里调用到的宏名也留下（`ATOMIC_OPS` 调用 `ATOMIC_OP`）。 */
  for (const d of defs) {
    if (keep.has(d.name)) continue;
    const re = /\b([A-Za-z_]\w*)\s*\(/g;
    let m;
    while ((m = re.exec(d.body)) !== null) {
      if (keep.has(m[1])) { keep.add(d.name); break; }
    }
  }
  return defs.filter((d) => keep.has(d.name));
}

module.exports = {
  buildTable, expandSiteToNames, expandCalls, substituteOnce, declaredNamesIn, splitTop,
  extractDefines, relevantDefines
};
