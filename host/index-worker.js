'use strict';
/* 索引解析 worker —— 一个 worker 一个 tree-sitter 实例。
 *
 * 批进批出：摊薄 postMessage 的开销；**读盘也在 worker 里**，
 * 于是「读 + 解析」一起并行（解析是纯 CPU，实测 20.5ms/文件）。
 *
 * 回流的不是对象数组，而是「字典 + 定长 u32 列」（见 index-columns.js）：
 * 实测 3000 个内核文件，主线程光 structured clone 就花掉 13.1s —— 1.79M 条
 * ref、每条 8 个字段全走对象克隆；而 11 个 worker 并行解析只要 5.1s。
 * 列式之后过 IPC 的是整块 TypedArray，文件内重复的字符串只过一次。
 *
 * 字典入表顺序与顺序路径的 `sid()` 调用顺序一致，所以全局字符串 id 相同 ——
 * 两条路径产出的索引可逐字节对拍（.tmp/cr/pool-check.js）。
 */
const fsp = require('fs').promises;
const { parentPort } = require('worker_threads');
const tsIndex = require('./ts-indexer');
const approx = require('./symbol-approx');
const asm = require('./asm-extract');
const { columnize } = require('./index-columns');

let ready = null;
let projectGrammars = null;
function ensureReady() {
  if (!ready) ready = tsIndex.ensureReady(projectGrammars || undefined).then(() => tsIndex.isReady());
  return ready;
}

parentPort.on('message', async (msg) => {
  if (!msg) return;
  if (msg.type === 'quit') { process.exit(0); return; }
  /* 建索引开始前一次性把宏表发过来（只在开启有限递归展开时）。 */
  if (msg.type === 'init') {
    projectGrammars = msg.grammars || null;
    try { tsIndex.setMacroTable(msg.macros, msg.macroLang); } catch { /* 表坏了就退回不展开 */ }
    return;
  }

  const { id, files, maxSize } = msg;
  const out = [];

  /* 增强包（L4）随批送来：worker 没有项目上下文，也不该自己去读盘。 */
  if (msg.enhance !== undefined) {
    try { tsIndex.setEnhance(msg.enhance); } catch { /* 表有问题就退回内置 */ }
  }

  /* 本批里有要解析的文件才加载 grammar（纯文本资产批次不必付这个成本）。 */
  try {
    if (files.some((f) => f.mode === 'tree')) await ensureReady();
  } catch (err) {
    parentPort.postMessage({ id, error: 'tree-sitter unavailable: ' + ((err && err.message) || err) });
    return;
  }

  for (const f of files) {
    try {
      /* 远程项目：主进程已经用 SFTP 把文本读进来了（worker 看不到那台机器）。
         `size` 随批送达，于是这里也不必再 stat 一次 —— 一批 48 个文件省 48 个
         往返。`skip` 表示主进程读失败（与本地「读不了就跳过」等价）。 */
      if (f.skip) continue;
      let st;
      if (typeof f.size === 'number') {
        st = { size: f.size, mtimeMs: f.mtimeMs || 0 };
      } else {
        st = await fsp.stat(f.abs);
      }
      /* 与顺序路径同一条闸门：超大文件不进索引。 */
      if (st.size > maxSize) continue;

      const readText = () => (typeof f.text === 'string' ? f.text : fsp.readFile(f.abs, 'utf8'));

      /* 预扫模式：只抓 `#define`，不做语法解析（宏表就是这样建起来的）。 */
      if (f.mode === 'defines') {
        const text = await readText();
        out.push({ rel: f.rel, defines: require('./macro-expand').extractDefines(text) });
        continue;
      }
      let got = { symbols: [], refs: [], includes: [], conds: [] };
      if (f.mode === 'tree') {
        got = tsIndex.extract(await readText(), f.rel);
      } else if (f.mode === 'asm') {
        /* 汇编：只认标签（`foo:` / `ENTRY(foo)` / `.globl foo`），不建引用。 */
        got = { symbols: asm.extract(await readText()), refs: [], includes: [], conds: [] };
      } else if (f.mode === 'approx') {
        /* 未知语言：默认规则（近似符号，不建绑定、不猜条件）。 */
        got = { symbols: approx.extract(await readText()), refs: [], includes: [], conds: [] };
      }

      const cols = columnize(got);
      out.push({
        rel: f.rel,
        size: st.size,
        mtimeMs: st.mtimeMs,
        lang: f.lang,
        dict: cols.dict,
        kinds: cols.kinds,
        rkinds: cols.rkinds,
        sym: cols.sym,
        ref: cols.ref,
        includes: got.includes || [],
        conds: got.conds || [],
        issues: got.issues || [],
        symStats: got.symStats || null,
        recvStats: got.recvStats || null,
        ruleHits: got.ruleHits || null
      });
    } catch { /* 读不了 / 解析失败：跳过这个文件（与顺序路径一致） */ }
  }

  parentPort.postMessage({ id, files: out });
});
