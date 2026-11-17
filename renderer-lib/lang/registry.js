(function (root) {
'use strict';
/* ------------------------------------------------------------------ 语言注册表
 *
 * 核心与各语言之间的唯一接口：核心只认这张表，不认任何具体语言
 * （REQUIREMENTS-GAP.md G.4「插件式注册」）。规则：
 *
 *   - 语言数据 = 一个注册条目（本块先落「读者语义」数据；grammar / 哨兵槽
 *     随对应改造块补齐）；
 *   - 文本资产 = 条目自己声明 textAsset（可浏览可搜索，零符号）；
 *   - 「未知」= 没有条目 → 走默认规则（lang/default-rules.js：通用词法，
 *     近似符号 + 低置信度）。**它与文本资产的区别就在产出**：未知语言给出
 *     「可能是定义」的行，文本资产不凭空长符号。执行器在 main/symbol-approx.js。
 *
 * 本文件属于**核心**：不许出现任何具体语言的字面量（零字面量测试会扫它）。
 * 语言名与各语言的词都在 lang/<id>.js 里。
 */

const registered = new Map();
const order = [];

/** 「未知语言」的 lang id —— 没有条目（或条目没声明 indexId）的文件都是它。
 *  0 是格式层常量（不属于任何语言），所以留在核心。 */
const LANG_UNKNOWN = 0;

function register(id, table) {
  if (!registered.has(id)) order.push(id);
  registered.set(id, table);
  byIndexId = null;                 /* 索引里的 lang id 反查表要重算 */
}

/* 索引存的是数字 lang id，注册表按字符串键存条目 —— 这张反查表把两者接上。
   条目自己声明 indexId（核心不持名单），懒建，注册之后失效重算。 */
let byIndexId = null;
function entryByIndexId(id) {
  if (!byIndexId) {
    byIndexId = new Map();
    for (const k of order) {
      const t = registered.get(k);
      if (t && typeof t.indexId === 'number') byIndexId.set(t.indexId, t);
    }
  }
  return byIndexId.get(id) || null;
}

/* 精确取某语言的表；没有就返回 null（调用方自己决定怎么兜底）。 */
function tableFor(id) {
  return registered.get(id) || null;
}

/* 当前默认语言的表 —— 文件带 lang 之后，只有「不知道文件语言」的调用方
   才该用 defaultTable()。 */
function defaultTable() {
  return registered.has(order[0]) ? registered.get(order[0]) : null;
}

/* ---- 文件 → 语言：条目自己声明 extensions / names，核心不持有任何名单 ------

   一个条目可以「借用」另一个条目的规则（borrows）——C++ 借 C 就是这条路径；
   借用链用于回答「有没有 grammar 槽」，规则数据也沿借用链回退。 */

/** 沿 borrows 链找 grammar 槽里的 grammar 文件名（找不到返回空串）。 */
function grammarOf(entry) {
  let e = entry;
  let hops = 0;
  while (e && hops < 8) {
    const g = e.syntax && e.syntax.grammar;
    if (g) return g;
    e = e.borrows ? tableFor(e.borrows) : null;
    hops++;
  }
  return '';
}

/** 沿 borrows 链找符号槽：文本资产没有 → 它不构成符号池。 */
function symbolsOf(entry) {
  let e = entry;
  let hops = 0;
  while (e && hops < 8) {
    if (e.symbols) return e.symbols;
    e = e.borrows ? tableFor(e.borrows) : null;
    hops++;
  }
  return null;
}

/** 沿 borrows 链把条目合并成**生效规则表**（子条目覆盖父条目）。
 *
 *  引擎要的不是「这个条目自己写了什么」，而是「这个文件该用哪套
 *  nt / roles / kinds」——C++ 借 C 就是这条路径（它自己只有名字和扩展名）。
 *  块级浅合并足够：每个块（syntax / symbols / imports / conditions / lexical）
 *  都是整块覆盖，不做块内逐键合并——半张表比没有表更危险。 */
function effectiveTable(entry) {
  const chain = [];
  let e = entry;
  let hops = 0;
  while (e && hops < 8) {
    chain.unshift(e);
    e = e.borrows ? tableFor(e.borrows) : null;
    hops++;
  }
  const out = {};
  for (const t of chain) {
    for (const k of Object.keys(t)) {
      if (k === 'syntax' || k === 'symbols' || k === 'imports'
        || k === 'conditions' || k === 'lexical') {
        out[k] = Object.assign({}, out[k], t[k]);
      } else {
        out[k] = t[k];
      }
    }
  }
  return out;
}

/** 文件 → 生效规则表（没有条目 = 默认语言的表：只有「不知道文件语言」的
 *  调用方才走这条兜底，例如启动自检）。 */
function tableForRel(rel) {
  return effectiveTable(entryFor(rel) || defaultTable());
}

/** 文件 → grammar 文件名（没有条目 = 默认语言的）。 */
function grammarForRel(rel) {
  return grammarOf(entryFor(rel) || defaultTable());
}

/** 「有语法规则」：grammar 槽 + syntax.nt 都齐了才交给 tree-sitter。
 *  只填了 grammar 的条目（规则表还没写）不算——否则 C 的遍历规则会套到
 *  别的语言上，产出的是垃圾而不是"没有"（宁可走默认规则的近似符号）。 */
function hasRules(entry) {
  const t = effectiveTable(entry);
  return !!(t && t.syntax && t.syntax.nt && Object.keys(t.syntax.nt).length);
}

/** 所有 indexable 条目的 grammar 文件名（去重）——ensureReady 一次全装。 */
function grammars() {
  const out = [];
  for (const id of order) {
    const t = registered.get(id);
    if (!t || !hasRules(t)) continue;
    const g = grammarOf(t);
    if (g && out.indexOf(g) < 0) out.push(g);
  }
  return out;
}

/** 这个 lang id 是不是「符号池」——符号类查询按它收窄（G.4）。
 *  文本资产与未知语言不是池：它们的符号点击走跨池兜底。 */
function isPoolLang(id) {
  const t = entryByIndexId(id);
  return !!(t && !t.textAsset && symbolsOf(t));
}

/** 文本资产（条目自己声明 textAsset）：可浏览可搜索，但**没有符号**。
 *  与「未知语言」的区别正是这里——未知语言要走默认规则产出近似符号，
 *  文本资产（Kconfig / JSON / Makefile …）不该凭空长出符号。 */
function isTextAsset(rel) {
  const e = entryFor(rel);
  return !!(e && e.textAsset);
}

/** 语言显示名（兜底结果标注「来自 X 池」用）。数据来自条目，核心不持名字。 */
function nameOf(id) {
  const t = entryByIndexId(id);
  return (t && t.name) || '';
}

/** 文件 → 注册条目（文件名优先，其次扩展名）。无条目 = 未知语言。 */
function entryFor(rel) {
  const base = String(rel || '').split('/').pop() || '';
  if (!base) return null;
  for (const id of order) {
    const t = registered.get(id);
    if (t && (t.names || []).indexOf(base) >= 0) return t;
  }
  const m = /\.([A-Za-z0-9]+)$/.exec(base);
  if (m) {
    const ext = m[1].toLowerCase();
    for (const id of order) {
      const t = registered.get(id);
      if (t && (t.extensions || []).indexOf(ext) >= 0) return t;
    }
  }
  return null;
}

/** 文件写进索引的 lang id（未知 = 0）。 */
function langIdOf(rel) {
  const e = entryFor(rel);
  return e && typeof e.indexId === 'number' ? e.indexId : LANG_UNKNOWN;
}

/** 这个文件该不该交给 tree-sitter：grammar 槽与语法规则块都得有
 *  （只有 grammar 的条目按未知语言走默认规则，见 hasRules）。 */
function isIndexable(rel) {
  const e = entryFor(rel);
  return !!(e && grammarOf(e) && hasRules(e));
}

root.Lang = {
  register, tableFor, defaultTable, ids: () => order.slice(),
  entryFor, langIdOf, isIndexable, grammarOf,
  effectiveTable, tableForRel, grammarForRel, hasRules, grammars,
  isPoolLang, nameOf, isTextAsset,
  LANG_UNKNOWN
};

})(typeof window !== 'undefined' ? window : globalThis);
