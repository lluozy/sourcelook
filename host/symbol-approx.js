'use strict';
/* 未知语言的默认规则执行器（REQUIREMENTS-GAP.md G.4）。
 *
 * 「通用词法 + 近似符号 + 低置信度」：文件没有注册条目时，用一张**数据表**
 * （renderer/lang/default-rules.js）做一行内粗筛。规则不自带语言名单——
 * 词都在表里，这里只有执行。
 *
 * 为什么不在核心写死：默认规则是"最后一个语言"的规则，和 C 的规则表是同一类
 * 东西。放在数据里，将来补一门语言只需要注册条目，不需要改这里。
 *
 * 产出的符号**不带** refs / includes / conds —— 粗筛不建立绑定，也不猜条件。
 * 置信度由文件级 lang=0 表达（fs-service 给行打 approx 标记），因为索引的
 * 符号记录里没有逐符号置信度字段，也不值得为它升一次格式。
 */
require('../renderer-lib/lang/default-rules');

const RULES = (typeof globalThis !== 'undefined' && globalThis.LangDefaultRules) || null;

let compiled = null;
function table() {
  if (!compiled) {
    const patterns = ((RULES && RULES.patterns) || []).map((p) => ({
      kind: p.kind,
      re: new RegExp(p.re, 'u')
    }));
    compiled = {
      confidence: (RULES && RULES.confidence) || 'approx',
      stop: new Set((RULES && RULES.stop) || []),
      patterns
    };
  }
  return compiled;
}

/** 一轮线性扫描；每行至多一个符号，先到先得。 */
function extract(text) {
  const t = table();
  const out = [];
  if (!t.patterns.length) return out;
  const seen = new Set();
  const lines = String(text || '').split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    /* 超长行（压缩产物、数据块）不参与：命中率和精度都不值得。 */
    if (!line || line.length > 400) continue;

    for (const p of t.patterns) {
      const m = p.re.exec(line);
      if (!m) continue;
      const name = m[1];
      if (!name || t.stop.has(name)) break;
      const key = p.kind + ':' + name + ':' + (i + 1);
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ name, kind: p.kind, line: i + 1 });
      }
      break;
    }
  }
  return out;
}

module.exports = {
  extract,
  confidence: () => table().confidence
};
