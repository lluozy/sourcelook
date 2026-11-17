'use strict';
/* 索引解析池（worker_threads）。
 *
 * WHY. 建索引的时间几乎全是 tree-sitter 解析：实测 20.5 ms/文件，内核全树
 * （约 51k 个 .c/.h）外推 **17.4 分钟**，而这台机器有 12 个核 —— 单线程把
 * 92% 的机器闲置。池化之后这一项线性下降（理论 1.5 分钟，含读盘与回流开销
 * 实测分钟级）。这是索引侧最大的一笔，也是「超越 cscope / Source Insight」
 * 最直接的一项：cscope 全树数分钟且信息浅得多，SI 更慢。
 *
 * 两条硬约束：
 *   1. **保序**：fileId = 添加顺序，并行回流必须与输入顺序一致 —— 否则同一棵树
 *      两次构建的索引字节不同，回归基线就没法逐字节比对了。所以结果先进
 *      「待回流表」，按批号顺序 flush。
 *   2. **有界内存**：只驻留「在飞的批」+ 乱序到的批（≤ worker 数 个），
 *      不攒全量 —— builder 的流式内存特性不能因为并行丢掉。
 *
 * 不值得并行的情况（小树 / 单核 / 显式指定 1 个 worker）返回 false，
 * 调用方走原来的顺序路径，行为逐字节一致（回归基线依赖这条）。
 */
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const WORKER = path.join(__dirname, 'index-worker.js');
/* 活着的 worker：退出程序时要能一次性收掉，否则线程会把进程拖住。 */
const liveWorkers = new Set();
/* 小树没必要起 worker：启动 + 加载 grammar 本身就要几百毫秒。 */
const MIN_FILES = 128;
const BATCH = 48;

function workerCount(fileCount) {
  const env = Number(process.env.CR_INDEX_WORKERS || 0);
  if (env > 0) return Math.max(1, Math.min(env, 64));
  /* 按**物理核**开 worker（`cpus-1` 是逻辑核）。
     实测（6 核 12 线程，2000 个内核文件）：2→19.9s、4→12.5s、6→10.9s、11→10.4s
     —— 6 个之后基本不再变快（超线程对纯解析没帮助），但多出来的 worker 会和
     DSH 主进程/渲染进程抢核，构建期间整个界面发卡。取一半留出余量。 */
  const physical = Math.max(2, Math.ceil(os.cpus().length / 2));
  return Math.max(1, Math.min(physical, Math.ceil(fileCount / BATCH)));
}

/**
 * 并行解析 `paths`，按输入顺序对每个文件回调一次 `onFile(record)`。
 *
 * @returns {Promise<boolean>} true = 池跑完了；false = 不值得/不适合并行，
 *                             调用方应走顺序路径（此时**一个回调都没发生**）。
 * @throws  池启动或中途失败（调用方需丢弃已喂进 builder 的记录并重来）。
 */
async function parseAll(paths, opts, onFile) {
  const n = workerCount(paths.length);
  if (paths.length < MIN_FILES || n <= 1) return false;

  const batches = [];
  const batchEnds = [];            // 第 i 批回流后「已处理文件数」的累计值
  for (let i = 0; i < paths.length; i += BATCH) {
    const files = paths.slice(i, i + BATCH).map((abs) => {
      /* 远程项目的根是 URI，path.relative 在 Windows 上会把它当成 "ssh:" 盘符；
         调用方的 relOf 知道该怎么算（见 fs-service 的 prel）。 */
      const rel = typeof opts.relOf === 'function'
        ? opts.relOf(abs)
        : path.relative(opts.root, abs).replace(/\\/g, '/');
      /* mode 决定 worker 里怎么取符号（'tree' | 'approx' | 'none'）：
         有 grammar → tree-sitter；登记过的文本资产 → 无符号；其余（未注册
         语言）→ 默认规则。判断在主进程做一次（语言层是数据），worker 只执行。 */
      return { abs, rel, lang: opts.langOf(rel), mode: opts.modeOf(rel) };
    });
    batches.push({ id: batches.length, files });
    batchEnds.push(Math.min((batches.length) * BATCH, paths.length));
  }

  const dirOf = (rel) => {
    const i = rel.lastIndexOf('/');
    return i < 0 ? '.' : (rel.slice(0, i) || '.');
  };
  /* 每个目录在整个待解析清单里有多少文件。进度行说的是"正在处理哪个目录",
     数字就该是这个目录的真实文件数,而不是批大小 —— 以前取批首目录 + 整批
     48,界面上每个目录后面都跟着 48(用户 2026-10-19 报的就是这个)。 */
  const dirTotals = new Map();
  for (const b of batches) {
    for (const f of b.files) {
      const d = dirOf(f.rel);
      dirTotals.set(d, (dirTotals.get(d) || 0) + 1);
    }
  }
  /* 一批 48 个文件可能横跨几个目录:按目录去重,每个目录带它自己的总量。 */
  const groupByDir = (files) => {
    const seen = new Set();
    const rows = [];
    for (const f of files) {
      const d = dirOf(f.rel);
      if (seen.has(d)) continue;
      seen.add(d);
      rows.push({ dir: d, files: dirTotals.get(d) || 0 });
    }
    return rows;
  };
  const abortErr = () => {
    const e = new Error('index build canceled');
    e.code = 'INDEX_ABORTED';
    return e;
  };

  const workers = [];
  const pending = new Map();       // 批号 → 记录（等前面的批先回流）
  const active = new Map();        // worker 下标 → 当前批次的目录分组（只用于进度显示）
  /* 同一目录可能同时被几个 worker 处理(大目录横跨多批):只留一行 —— 数字是
     该目录的总量,不该因为几个 worker 同时在跑就相加。 */
  const snapshot = () => {
    const byDir = new Map();
    for (const wi of [...active.keys()].sort((a, b) => a - b)) {
      for (const g of active.get(wi)) {
        if (!byDir.has(g.dir)) byDir.set(g.dir, { dir: g.dir, files: g.files });
      }
    }
    return [...byDir.values()];
  };
  const reportActive = () => {
    if (typeof opts.onActive === 'function') opts.onActive(snapshot());
  };
  let nextSend = 0;
  let nextFlush = 0;
  let done = false;

  await new Promise((resolve, reject) => {
    const settle = (err) => {
      if (done) return;
      done = true;
      for (const w of workers) {
        liveWorkers.delete(w);
        try { w.postMessage({ type: 'quit' }); } catch { /* already gone */ }
        try { w.terminate(); } catch { /* already gone */ }
      }
      active.clear();
      reportActive();
      if (err) reject(err); else resolve();
    };

    const flush = () => {
      let advanced = false;
      while (pending.has(nextFlush)) {
        const rows = pending.get(nextFlush);
        pending.delete(nextFlush);
        nextFlush++;
        for (const r of rows) onFile(r);
        advanced = true;
      }
      if (advanced && typeof opts.onProgress === 'function') {
        opts.onProgress(batchEnds[nextFlush - 1]);
      }
      if (nextFlush === batches.length) settle(null);
    };

    const dispatch = (w, wi) => {
      if (done) return;
      if (typeof opts.shouldAbort === 'function' && opts.shouldAbort()) {
        settle(abortErr());
        return;
      }
      if (nextSend >= batches.length) {
        active.delete(wi);
        reportActive();
        return;
      }
      const b = batches[nextSend++];
      active.set(wi, groupByDir(b.files));
      reportActive();

      const send = () => {
        if (done) return;
        /* 增强包随批走：worker 看不到项目目录，也不该自己读盘。 */
        w.postMessage({ id: b.id, files: b.files, maxSize: opts.maxSize, enhance: opts.enhance || null });
      };
      /* 远程项目的文件在另一台机器上，worker 读不到：由主进程在派发前把这一批
         并发读进来（SFTP 往返在批内并行，才可能跑满带宽）。读失败的文件带
         skip 标记过去，语义与本地「读不了就跳过」一致。 */
      if (typeof opts.prefetch !== 'function') { send(); return; }
      Promise.resolve()
        .then(() => opts.prefetch(b.files, opts.maxSize))
        .then(send)
        .catch((err) => settle(err));
    };

    for (let i = 0; i < n; i++) {
      const wi = i;
      const w = new Worker(WORKER);
      workers.push(w);
      liveWorkers.add(w);
      try { w.unref(); } catch { /* older node */ }
      /* 宏表一次性发给每个 worker（不随批重复克隆）。 */
      if ((opts.macros && opts.macros.length) || (opts.grammars && opts.grammars.length)) {
        try {
          w.postMessage({
            type: 'init', macros: opts.macros || [], macroLang: opts.macroLang,
            grammars: opts.grammars || []
          });
        } catch { /* 发不过去就当作不展开 */ }
      }
      w.on('message', (msg) => {
        if (done) return;
        if (typeof opts.shouldAbort === 'function' && opts.shouldAbort()) {
          settle(abortErr());
          return;
        }
        if (!msg || msg.error) {
          settle(new Error((msg && msg.error) || 'index worker failed'));
          return;
        }
        active.delete(wi);
        pending.set(msg.id, msg.files || []);
        flush();
        /* flush 可能已经 settle（最后一批），此时不要再派发。 */
        if (!done) dispatch(w, wi);
      });
      w.on('error', (err) => settle(err));
      w.on('exit', (code) => {
        if (!done && nextFlush < batches.length) settle(new Error('index worker exited early: ' + code));
      });
      dispatch(w, wi);
    }
  });

  return true;
}

function shutdown() {
  for (const w of liveWorkers) {
    try { w.postMessage({ type: 'quit' }); } catch { /* gone */ }
    try { w.terminate(); } catch { /* gone */ }
  }
  liveWorkers.clear();
}

module.exports = { parseAll, workerCount, shutdown, MIN_FILES, BATCH };
