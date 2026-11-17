'use strict';
/*
 * E1 规则推导器（2026-10-23）—— 从 `#define` 原文反推增强包规则。
 *
 * WHY. 报告里几百个宏，让 AI 逐条写规则既慢又容易拼错（前缀/后缀一猜错，
 * 造出来的名字源码里根本不存在）。而**大部分规则是可以机器推出来的**：
 * 宏体长什么样，规则就长什么样。推不出来的才进待解析台账（不猜）。
 *
 * 本模块是**纯函数**：只吃 `{ params, body }`，不碰索引、不碰文件。
 * "名字在索引里真的存在"这条交叉验证由 fs-service 做（要查二进制索引），
 * 它是本模块结论的唯一验收关。
 *
 * 判据（全满足才产出）：
 *   ① 至少一处 `##`，一侧是形参、一侧是字面量 → pattern（多处则多条 declare）
 *   ② 或：形参以**裸名字**出现在声明位置（`struct mutex name`） → arg
 *   ③ 每一处 `##` 前面都要读得到类型 —— 读不到就判"在引用已有名字"，不推导
 *   ④ 交叉验证（调用方做）
 *
 * 语言数据（哪些词是类型 / 存储类）来自语言表 `syntax.macroDerive`。
 */

const enhance = require('./enhance');

const IDENT = /^[A-Za-z_]\w*$/;

/** 把 `$N` 模板按参数渲染（只做纯拼接，非标识符就放弃）。 */
function fillPattern(p, args) {
  let ok = true;
  const out = String(p).replace(/\$(\d+)/g, (_m, n) => {
    const v = args[Number(n)];
    if (!v || !IDENT.test(v)) { ok = false; return ''; }
    return v;
  });
  return ok ? out : '';
}

/**
 * 宏体里所有「`##` 拼名」的位置。
 *
 * 为什么不复用 `enhance.derivePatterns`：那边只回模板字符串，没有位置；
 * 而"这个名字前面有没有类型"必须按**位置**看（`SIGN_##s` 前面是 `((expr`，
 * 不是类型 —— 那是引用，不是声明）。2026-10-23 实测踩到。
 *
 * @returns {Array<{pattern:string,start:number,end:number,after:string}>}
 */
function gluedGroups(body, params) {
  const out = [];
  const src = String(body || '');
  const re = /([A-Za-z0-9_]+)\s*##\s*([A-Za-z0-9_]+)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const L = m[1];
    const R = m[2];
    const li = params.indexOf(L);
    const ri = params.indexOf(R);
    let pattern = '';
    if (li >= 0 && ri < 0) pattern = '$' + li + R;
    else if (li < 0 && ri >= 0) pattern = L + '$' + ri;
    if (!pattern) continue;
    const end = m.index + m[0].length;
    out.push({ pattern, start: m.index, end, after: src.slice(end).trimStart() });
  }
  return out;
}

/** 这个位置前面那段（去掉存储类后）是不是一个类型；读不出返回 ''。 */
function typeBeforeAt(body, start, table) {
  const storage = new Set(table.storage || []);
  const specs = new Set(table.typeSpecs || []);
  const scalars = new Set(table.scalars || []);
  const words = String(body || '').slice(0, start).trim().split(/\s+/).filter(Boolean);
  while (words.length && storage.has(words[0])) words.shift();
  if (!words.length) return '';
  const lastSpec = words.findIndex((w, i) => specs.has(w) && i + 1 < words.length);
  if (lastSpec >= 0) {
    return (words[lastSpec] + ' ' + words[lastSpec + 1]).replace(/[^\w *]/g, '');
  }
  let i = words.length - 1;
  let stars = '';
  while (i >= 0 && /^\*+$/.test(words[i])) { stars = words[i] + stars; i--; }
  if (i < 0) return '';
  const w = words[i].replace(/[^\w]/g, '');
  const isType = scalars.has(w) || (table.typeSuffix && w.endsWith(table.typeSuffix));
  if (!isType) return '';
  let type = w;
  if (i > 0) {
    const prev = words[i - 1].replace(/[^\w]/g, '');
    if (scalars.has(prev) && (w === 'long' || w === 'int' || w === 'short')) type = prev + ' ' + type;
  }
  return (stars ? type + ' ' + stars : type).trim();
}

/**
 * 没有 `##` 时：宏体是不是「类型 + 形参」的声明形状。
 * 例：`struct mutex name = __MUTEX_INITIALIZER(name)` → { arg:0, kind:'variable', type:'struct mutex' }
 */
function paramDeclOf(body, params, table) {
  const storage = new Set(table.storage || []);
  const specs = new Set(table.typeSpecs || []);
  const scalars = new Set(table.scalars || []);
  const words = String(body || '').split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && storage.has(words[i])) i++;
  if (i >= words.length) return null;

  let type = '';
  if (specs.has(words[i])) {
    if (i + 1 >= words.length) return null;
    type = words[i] + ' ' + words[i + 1].replace(/[^\w]/g, '');
    i += 2;
  } else {
    const first = words[i].replace(/[^\w]/g, '');
    const isType = scalars.has(first) || (table.typeSuffix && first.endsWith(table.typeSuffix));
    if (!isType) return null;
    while (i < words.length && scalars.has(words[i].replace(/[^\w]/g, ''))) {
      type += (type ? ' ' : '') + words[i].replace(/[^\w]/g, '');
      i++;
    }
  }
  let stars = '';
  while (i < words.length && /^\*+$/.test(words[i])) { stars += words[i]; i++; }
  if (i >= words.length) return null;
  /* `*p` / `**p` 写成同一个词时（`struct sock *p`）也要拆出星号。 */
  let nm = words[i];
  const glued = /^(\*+)([A-Za-z_]\w*)$/.exec(nm);
  if (glued) { stars += glued[1]; nm = glued[2]; } else { nm = nm.replace(/[^\w]/g, ''); }
  const arg = params.indexOf(nm);
  if (arg < 0) return null;
  const after = String(body || '').slice(String(body || '').indexOf(nm) + nm.length).trimStart();
  const kind = after.charAt(0) === '(' ? 'function' : 'variable';
  return { arg, kind, type: (stars ? type + ' ' + stars : type).trim() };
}

/**
 * 推导一条规则。
 * @param {{name:string, params:string[], body:string}} def
 * @param {object} table 语言表的 `syntax.macroDerive`
 * @returns {{rule: null|object, why: string, evidence: string}}
 */
function deriveFromDef(def, table) {
  const t = table || {};
  const body = String((def && def.body) || '').replace(/\s+/g, ' ').trim();
  const params = Array.isArray(def && def.params) ? def.params : [];
  if (!body) return { rule: null, why: '宏体为空' };
  /* 先抹掉 `##` 再判字符串化：`##name` 里的 `#n` 不是 `#x`。 */
  if (/#[A-Za-z_(]/.test(body.split('##').join(' '))) {
    return { rule: null, why: '字符串化 #x，产出是字符串不是符号' };
  }
  if (/__VA_ARGS__/.test(body)) {
    return { rule: null, why: '__VA_ARGS__，名字要靠变参展开' };
  }

  const groups = gluedGroups(body, params);
  if (groups.length) {
    /* 每一处 ## 都必须"前面是类型"，否则它很可能在**引用**已有名字：
         `MAKE_REG(s,…) { … (SIGN_##s != 0) … }`   → SIGN_POS 早就有
         `AUD_TDM_SCLK_MUX(_name,_reg) AUD_MUX(tdm##_name##_sclk_sel, …)` → 引用
       照抄成 declare 会在每个调用点造一个假符号（2026-10-23 实测抓到）。 */
    const declare = [];
    const seen = new Set();
    for (const g of groups) {
      if (seen.has(g.pattern)) continue;
      seen.add(g.pattern);
      const type = typeBeforeAt(body, g.start, t);
      if (!type) {
        return { rule: null, why: '## 前面看不到类型（' + g.pattern + '）：可能是在引用已有名字，不是在声明' };
      }
      declare.push({
        pattern: g.pattern,
        kind: g.after.charAt(0) === '(' ? 'function' : 'variable',
        type
      });
    }
    return {
      rule: { declare },
      evidence: '## 拼名：' + declare.map((d) => d.pattern).join(' / ')
    };
  }

  const decl = paramDeclOf(body, params, t);
  if (decl) {
    return {
      rule: { declare: [{ arg: decl.arg, kind: decl.kind, type: decl.type }] },
      evidence: '形参在声明位置：' + (decl.type || '?') + ' ' + params[decl.arg]
    };
  }
  return { rule: null, why: '宏体既不是"名字模板"，也不是"类型 + 形参"' };
}

module.exports = {
  deriveFromDef, fillPattern, gluedGroups, typeBeforeAt, paramDeclOf, paramDecl: paramDeclOf,
  derivePatternsFor: (body, params) => gluedGroups(body, params).map((g) => g.pattern)
};
