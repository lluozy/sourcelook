'use strict';
/* 记录 → 列。worker 用它在出口压包；自检脚本用它给「顺序路径 vs 列式」对拍。
 *
 * 为什么不在 worker 里直接写成对象数组：
 *   3000 个内核文件 → 378k 符号 + 1.79M 引用。每条 ref 8 个字段、全部走
 *   structured clone，主线程光反序列化就是 13.1s，而 11 个 worker 并行解析
 *   只要 5.1s —— 天花板在主线程的克隆上，不在 CPU 上。
 *
 * 为什么字典的入表顺序必须与 sid() 一致：
 *   全局字符串 id 是按「首次出现」分配的。顺序路径每个符号依次
 *   name→type→parent→config→value、每个引用 name→to→fn→config 调 sid()，
 *   这里就按同一顺序 intern，于是两条路径产出的索引逐字节相同。
 *   kind / conf **不进字典**：kind 是语言表的词（`macro`…），进了字典就会
 *   改变字符串 id 的分配顺序；conf 本来就是三态枚举。
 */

const SYM_COLS = 8;   // name, kind, line, type, parent, config, value, proto
const REF_COLS = 8;   // name, line, col, kind, conf, to, fn, config
const EMPTY_ID = 0xFFFFFFFF;
const CONF_CODE = { exact: 0, 'name-only': 1, unresolved: 2 };

/** 把一个文件的 `{symbols, refs}` 压成 `{dict, kinds, rkinds, sym, ref}`。 */
function columnize(got) {
  const dict = [];
  const ids = new Map();
  const intern = (v) => {
    if (v === null || v === undefined || v === '') return EMPTY_ID;
    const s = typeof v === 'string' ? v : String(v);
    let id = ids.get(s);
    if (id === undefined) {
      id = dict.length;
      ids.set(s, id);
      dict.push(s);
    }
    return id;
  };

  const kinds = [];
  const kindId = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    const i = kinds.indexOf(s);
    if (i >= 0) return i;
    kinds.push(s);
    return kinds.length - 1;
  };

  const rkinds = [];
  const refKindId = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    const i = rkinds.indexOf(s);
    if (i >= 0) return i;
    rkinds.push(s);
    return rkinds.length - 1;
  };

  const sym = [];
  for (const s of (got.symbols || [])) {
    if (!s || !s.name) continue;
    /* 顺序敏感：name → type → parent → config → value（对齐 sid 的调用顺序）。 */
    sym.push(intern(s.name));
    sym.push(kindId(s.kind));
    sym.push(s.line >>> 0);
    sym.push(intern(s.type));
    sym.push(intern(s.parent));
    sym.push(intern(s.config));
    sym.push(intern(s.value));
    sym.push(s.prototype ? 1 : 0);
  }

  const ref = [];
  for (const r of (got.refs || [])) {
    if (!r || !r.name) continue;
    ref.push(intern(r.name));
    ref.push(r.line >>> 0);
    ref.push((r.column || r.col || 0) >>> 0);
    ref.push(refKindId(r.kind));
    ref.push(CONF_CODE[r.conf] || 0);
    ref.push(intern(r.to));
    ref.push(intern(r.fn));
    ref.push(intern(r.config));
  }

  return {
    dict,
    kinds,
    rkinds,
    sym: Uint32Array.from(sym),
    ref: Uint32Array.from(ref)
  };
}

module.exports = { columnize, SYM_COLS, REF_COLS, EMPTY_ID, CONF_CODE };
