'use strict';
/*
 * AST-backed local variable / parameter resolution for C (host side).
 *
 * Design notes (see LOCAL-SCOPE-AST-PLAN.md):
 *  - Parsing happens in a worker thread; the host main thread never runs
 *    tree-sitter for click queries.
 *  - `lookup()` only ever *reads* the cache (plus one cheap stat for the
 *    version check) and never waits for a worker, so the first click on a file
 *    still returns the text-scan result immediately.
 *  - Every failure path degrades silently to the text scanner in fs-service.
 */

const path = require('path');
const { Worker } = require('worker_threads');

const WORKER_PATH = path.join(__dirname, 'local-scope-worker.js');
const CACHE_LIMIT = 24;
const JOB_TIMEOUT_MS = 5000;
const MAX_FAILURES = 3;
const DEFAULT_MAX_BYTES = 1024 * 1024;

let hooks = null;                 /* { readText(rel), stat(rel) } */
let maxBytes = DEFAULT_MAX_BYTES;

const cache = new Map();          /* rel -> { version, scope, parsedAt, index } */
const queued = new Set();         /* rel waiting in the queue */
const skipped = new Set();        /* too large / unreadable: do not retry */
let worker = null;
let workerGen = 0;                /* bumped on every teardown: stale handlers must not fire */
let seq = 0;
let job = null;                   /* { id, rel } currently running */
const queue = [];
let failures = 0;
let disabled = false;
let timer = 0;

function configure(next) {
  hooks = next || null;
  maxBytes = Number(next && next.maxBytes) > 0 ? Number(next.maxBytes) : DEFAULT_MAX_BYTES;
}

function versionOf(stat) {
  const mtime = Number(stat && stat.mtimeMs);
  const size = Number(stat && stat.size);
  return `${Number.isFinite(mtime) ? Math.round(mtime) : 0}:${Number.isFinite(size) ? size : 0}`;
}

/* ------------------------------------------------------------------ worker */

function teardownWorker() {
  if (timer !== 0) { clearTimeout(timer); timer = 0; }
  const current = worker;
  worker = null;
  job = null;
  workerGen += 1;
  if (!current) return;
  try { current.postMessage({ type: 'quit' }); } catch { /* already gone */ }
  try { current.terminate(); } catch { /* already gone */ }
}

function fail(reason) {
  failures += 1;
  if (failures >= MAX_FAILURES && !disabled) disabled = true;
  job = null;
  teardownWorker();
  return reason;
}

function ensureWorker() {
  if (worker !== null) return worker;
  const created = new Worker(WORKER_PATH);
  const gen = workerGen;
  try { created.unref(); } catch { /* older node */ }
  created.on('message', (msg) => {
    if (gen !== workerGen) return;      /* reply from a retired worker */
    if (!msg || typeof msg !== 'object') return;
    const current = job;
    if (!current || msg.id !== current.id) return;
    if (timer !== 0) { clearTimeout(timer); timer = 0; }
    job = null;
    const entry = { rel: current.rel, text: current.text, stat: current.stat };
    if (msg.ok === true && msg.scope && typeof msg.scope === 'object') {
      const stored = {
        version: versionOf(entry.stat),
        scope: msg.scope,
        parsedAt: Date.now(),
        index: null,
      };
      remember(entry.rel, stored);
      failures = 0;
    } else {
      failures += 1;
      if (failures >= MAX_FAILURES) disabled = true;
      skipped.add(entry.rel);
    }
    if (current.resolve) current.resolve();
    pump();
  });
  created.on('error', () => {
    if (gen !== workerGen) return;
    const current = job;
    fail('worker error');
    if (current && current.resolve) current.resolve();
    pump();
  });
  created.on('exit', () => {
    if (gen !== workerGen) return;
    if (worker === created) worker = null;
    if (job !== null) {
      const current = job;
      fail('worker exited');
      if (current && current.resolve) current.resolve();
      pump();
    }
  });
  worker = created;
  return created;
}

function remember(rel, stored) {
  if (cache.has(rel)) cache.delete(rel);
  cache.set(rel, stored);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function pump() {
  if (job !== null || queue.length === 0 || disabled || hooks === null) return;
  const next = queue.shift();
  queued.delete(next.rel);
  if (cache.has(next.rel) || skipped.has(next.rel)) { void pump(); return; }
  let stat = null;
  try {
    stat = await hooks.stat(next.rel);
  } catch {
    skipped.add(next.rel);
    void pump();
    return;
  }
  if (!stat || Number(stat.size) > maxBytes) {
    skipped.add(next.rel);
    void pump();
    return;
  }
  let text = '';
  try {
    text = await hooks.readText(next.rel);
  } catch {
    skipped.add(next.rel);
    void pump();
    return;
  }
  if (typeof text !== 'string' || text === '') {
    skipped.add(next.rel);
    void pump();
    return;
  }
  seq += 1;
  const id = seq;
  job = { id, rel: next.rel, text, stat, resolve: next.resolve };
  const active = ensureWorker();
  try {
    active.postMessage({ type: 'build', id, rel: next.rel, text });
  } catch {
    fail('postMessage failed');
    if (next.resolve) next.resolve();
    void pump();
    return;
  }
  timer = setTimeout(() => {
    timer = 0;
    const current = job;
    fail('timeout');
    if (current && current.resolve) current.resolve();
    void pump();
  }, JOB_TIMEOUT_MS);
}

/** Queue a background parse. Deduplicated; safe to call on every click. */
function enqueue(rel) {
  if (typeof rel !== 'string' || rel === '' || hooks === null || disabled) return;
  if (cache.has(rel) || queued.has(rel) || skipped.has(rel) || (job !== null && job.rel === rel)) return;
  queued.add(rel);
  queue.push({ rel });
  void pump();
}

/**
 * Cache-only read. Returns the scope when the cached version still matches the
 * file on disk; never waits for the worker. A stale entry is dropped and a
 * rebuild is queued.
 */
async function lookup(rel) {
  if (typeof rel !== 'string' || rel === '' || hooks === null) return null;
  const entry = cache.get(rel);
  if (!entry) return null;
  let stat = null;
  try {
    stat = await hooks.stat(rel);
  } catch {
    return entry.scope;   /* stat hiccup: keep serving the cached parse */
  }
  if (versionOf(stat) !== entry.version) {
    cache.delete(rel);
    enqueue(rel);
    return null;
  }
  /* touch for LRU */
  cache.delete(rel);
  cache.set(rel, entry);
  return entry.scope;
}

/** Warm the cache for a file the user just opened (fire and forget). */
async function warm(rel) {
  if (typeof rel !== 'string' || rel === '' || hooks === null || disabled) return false;
  if (cache.has(rel)) {
    const scope = await lookup(rel);
    if (scope !== null) return true;
  }
  enqueue(rel);
  return true;
}

function invalidate(rel) {
  if (typeof rel !== 'string') return;
  cache.delete(rel);
  skipped.delete(rel);
}

function clear() {
  cache.clear();
  queued.clear();
  skipped.clear();
  queue.length = 0;
  failures = 0;
  disabled = false;
  teardownWorker();
}

function shutdown() {
  teardownWorker();
}

/* ------------------------------------------------------------------- query */

function indexOf(entry) {
  if (entry.index !== null) return entry.index;
  const blocksById = new Map();
  for (const block of entry.scope.blocks || []) blocksById.set(block.id, block);
  const byName = new Map();
  for (const decl of entry.scope.declarations || []) {
    if (!byName.has(decl.name)) byName.set(decl.name, []);
    byName.get(decl.name).push(decl);
  }
  entry.index = { blocksById, byName };
  return entry.index;
}

function contains(block, line, column) {
  const afterStart = line > block.startLine
    || (line === block.startLine && column >= block.startColumn);
  const beforeEnd = line < block.endLine
    || (line === block.endLine && column <= block.endColumn);
  return afterStart && beforeEnd;
}

function innermostBlock(scope, line, column) {
  let best = null;
  for (const block of scope.blocks || []) {
    if (!contains(block, line, column)) continue;
    if (best === null) { best = block; continue; }
    if (block.depth > best.depth) { best = block; continue; }
    if (block.depth === best.depth) {
      const span = (block.endLine - block.startLine) - (best.endLine - best.startLine);
      if (span < 0) best = block;
    }
  }
  if (best !== null) return best;
  /* Click on the signature (parameters, multi-line declarator): fall back to
     the function body block so parameters still resolve through the AST. */
  for (const fn of scope.functions || []) {
    if (line < fn.startLine || line > fn.endLine) continue;
    const body = (scope.blocks || []).find((block) => block.id === fn.bodyBlockId);
    if (body) return body;
  }
  return null;
}

function precedes(decl, line, column) {
  if (decl.line < line) return true;
  if (decl.line > line) return false;
  return decl.column <= column;
}

function later(a, b) {
  if (a.line !== b.line) return a.line > b.line;
  if (a.column !== b.column) return a.column > b.column;
  return (a.startOffset || 0) > (b.startOffset || 0);
}

/**
 * Resolve `name` used at (line, column) to the nearest preceding declaration in
 * the enclosing block chain. Returns a plain declaration object or null.
 */
function query(scope, name, line, column) {
  if (!scope || typeof name !== 'string' || name === '') return null;
  const clickLine = Math.max(1, Math.round(Number(line) || 0));
  const clickColumn = Math.max(1, Math.round(Number(column) || 1));
  const entry = cache.get(scope.file);
  const index = entry && entry.scope === scope ? indexOf(entry) : null;
  const blocksById = index ? index.blocksById : new Map((scope.blocks || []).map((b) => [b.id, b]));
  const candidates = index ? (index.byName.get(name) || []) : (scope.declarations || []);
  let block = innermostBlock(scope, clickLine, clickColumn);
  for (let guard = 0; block && guard < 64; guard += 1) {
    let best = null;
    for (const decl of candidates) {
      if (decl.blockId !== block.id) continue;
      if (decl.name !== name) continue;
      if (!precedes(decl, clickLine, clickColumn)) continue;
      if (best === null || later(decl, best)) best = decl;
    }
    if (best !== null) return best;
    block = block.parentId === null ? null : blocksById.get(block.parentId);
  }
  return null;
}

/**
 * Click → member entry `{ name, operator, shape }` from the AST member table.
 * The field identifier's own span decides the match (`a.b.c` yields three
 * entries, one per field), so nesting needs no extra disambiguation.
 */
function findMemberAt(scope, line, column) {
  if (!scope || !Array.isArray(scope.members)) return null;
  const clickLine = Math.max(1, Math.round(Number(line) || 0));
  const clickColumn = Math.max(1, Math.round(Number(column) || 1));
  let best = null;
  for (const item of scope.members) {
    if (item.line !== clickLine) continue;
    if (clickColumn < item.column || clickColumn > item.endColumn) continue;
    if (best === null || (item.endColumn - item.column) < (best.endColumn - best.column)) best = item;
  }
  return best;
}

module.exports = {
  configure,
  lookup,
  enqueue,
  warm,
  invalidate,
  clear,
  shutdown,
  query,
  findMemberAt,
  /* exposed for tests */
  _cache: cache,
  _setDisabled: (value) => { disabled = value === true; },
};
