'use strict';
/*
 * NOTE: this module reads the index through a page cache instead of loading it
 * whole (see "access layer" below), so it is the only main-process module that
 * touches the filesystem directly.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const fsp = fs.promises;

/* 语言数据（kind 词汇 / 编号顺序 / 全局 kind 名单）来自规则表。 */
require('../renderer-lib/lang/registry.js');
require('../renderer-lib/lang/c.js');
const SYMS = ((globalThis.Lang && globalThis.Lang.defaultTable()) || {}).symbols || {};

/*
 * index-store - the on-disk symbol / reference index (SPEC F1.12).
 *
 * WHY THIS EXISTS. The index used to be JSON. JSON is an exchange format, not a
 * storage format: it has no ordering, no random access, and reading it means
 * materialising every record as a JS object - about 100 bytes of overhead per
 * record. At kernel scale (millions of references) that is hundreds of megabytes
 * before a single query is answered.
 *
 * WHAT REPLACES IT. One flat binary file plus zero-copy TypedArray views. The
 * layout follows what cscope and GNU Global have always done, because there is
 * nothing better to do: keep records FIXED-SIZE, keep them SORTED BY NAME, and
 * answer a query with a binary search followed by a sequential read.
 *
 *   header        magic / version / segment offsets
 *   strtab        every string, laid out in DICTIONARY ORDER
 *   strIdx[]      fixed 8B: (offset, length) - one per string id
 *   files[]       fixed 32B: path id / mtime / size / symbol range / ref range / lang
 *   symbols[]     fixed 40B, sorted by nameId
 *   refs[]        fixed 32B, sorted by nameId
 *
 * THE ONE INVARIANT THAT MATTERS. String ids are assigned AFTER sorting the
 * strings, so "same name" implies "same id" implies "contiguous range in
 * refs[]". Binary search over refs[] is only valid because of this; assign ids
 * in first-seen order instead and the whole scheme silently returns wrong
 * answers rather than failing loudly.
 *
 * REFERENCES ARE RESOLVED AT QUERY TIME, NOT AT WRITE TIME. A record stores
 * `toNameId` - the NAME of the symbol it binds to, not a verdict about whether
 * that symbol exists. Resolving during the build would mean rewriting a sorted
 * binary afterwards, which is not possible; deferring it means cross-file
 * linking costs nothing but a lookup, and the confidence level falls out of the
 * result for free (found => exact, absent => name-only).
 *
 * NO OBJECTS ARE CREATED WHEN READING. Everything below hands back TypedArray
 * views over the same Buffer. Iterating a million references must not allocate a
 * million objects.
 */

const MAGIC = 0x58495243;      // 'CRIX' little-endian
/* v2 —— 文件记录加 `lang`（文件级语言 id，0 = 未知/未识别）。
   **零旧索引兼容（永久硬规则）**：格式一变即作废重建，不写迁移代码。 */
const FORMAT = 2;

/* Fixed record sizes. Multiples of 4 so the views can be typed arrays. */
const REC_SYMBOL = 40;
const REC_REF = 32;
/* 8 fields (32B): file id, mtime, size, first symbol, symbol count, first
   reference, reference count, lang. (7 fields at 24 bytes had two of them
   collide and the second write silently erased the first — the layout is
   spelled out field by field below precisely because of that.) */
const REC_FILE = 32;
const REC_STRIDX = 8;

/* Header layout, in bytes. */
const HDR = {
  magic: 0,
  version: 4,
  builtAt: 8,
  strtabOff: 12, strtabLen: 16,
  strIdxOff: 20, strCount: 24,
  filesOff: 28, fileCount: 32,
  symOff: 36, symCount: 40,
  refOff: 44, refCount: 48,
  /* Room to grow without moving anything: the reader only trusts what the
     version number tells it to trust. */
  reserved: 52,
  size: 64
};

/* Symbol flags. */
const SF_PROTOTYPE = 1;

/* Reference kinds - what the use DOES. Ordered so the hot ones are first. */
const REF_READ = 0;
const REF_WRITE = 1;
const REF_CALL = 2;
const REF_ADDRESS = 3;
const REF_TYPE = 4;
/* `x->field` / `x.field`: a use of a MEMBER, carrying its receiver in `to`
   ("field ip_hdr(skb)") - the only fact that says WHICH struct's member it is
   (2026-10-14). */
const REF_FIELD = 5;

const REF_KIND_NAME = ['read', 'write', 'call', 'address', 'type', 'field'];
const REF_KIND_ID = {
  read: REF_READ, write: REF_WRITE, call: REF_CALL,
  address: REF_ADDRESS, type: REF_TYPE, field: REF_FIELD
};

/* ------------------------------------------------------------ string table

   Strings are collected, sorted, de-duplicated, and then concatenated. The id
   of a string is its position in that sorted order - see the invariant note at
   the top of this file for why the ORDER and not just the de-duplication is
   what makes the rest of the design legal. */

function buildStrings(values) {
  const seen = new Map();
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    const s = String(v);
    if (!seen.has(s)) seen.set(s, 0);
  }
  const sorted = Array.from(seen.keys()).sort();
  const id = new Map();
  for (let i = 0; i < sorted.length; i++) id.set(sorted[i], i);

  let len = 0;
  for (const s of sorted) len += Buffer.byteLength(s, 'utf8');

  return { id, sorted, len };
}

function writeStrings(sorted) {
  const strIdx = Buffer.allocUnsafe(sorted.length * REC_STRIDX);
  const parts = [];
  let off = 0;

  for (let i = 0; i < sorted.length; i++) {
    const b = Buffer.from(sorted[i], 'utf8');
    parts.push(b);
    strIdx.writeUInt32LE(off, i * REC_STRIDX);
    strIdx.writeUInt32LE(b.length, i * REC_STRIDX + 4);
    off += b.length;
  }
  return { strtab: Buffer.concat(parts, off), strIdx };
}

/* ---------------------------------------------------------------- sorting

   Counting sort by a 32-bit key, done over an index permutation rather than by
   moving records. `Array.prototype.sort` on a few million composite records is
   both slow and allocation-heavy; this is two linear passes.

   The result is an Int32Array of source indices in key order. */

function orderByKey(keys) {
  const n = keys.length;
  const order = new Int32Array(n);
  if (n === 0) return order;

  let max = 0;
  for (let i = 0; i < n; i++) if (keys[i] > max) max = keys[i];

  const count = new Uint32Array(max + 2);
  for (let i = 0; i < n; i++) count[keys[i] + 1]++;
  for (let i = 1; i < count.length; i++) count[i] += count[i - 1];
  for (let i = 0; i < n; i++) order[count[keys[i]]++] = i;
  return order;
}

/* --------------------------------------------------------- streaming build

   WHY A BUILDER AND NOT A FUNCTION. The old `encode({files})` had to hold every
   record as a JS object before it could lay anything out. At kernel scale that
   is ~12M symbol objects and ~40M reference objects - about 2 GB of object
   headers alone, before a single field is counted (SPEC F1.17).

   The builder collects into COLUMNS instead: one flat Uint32Array per chunk,
   N columns to a record, so a record costs exactly its stored bytes and
   nothing else - no object, no property, no hidden class.

   WHY CHUNKS AND NOT DOUBLING. Growing a single 1.28 GB array by doubling needs
   1.92 GB at the moment of the last copy. Chunks of ~64 MB are appended to a
   list, so the transient cost is one chunk and the retained cost is the data.

   Chunking also decides the write path: each chunk is a contiguous run of
   records, which is exactly what has to be sorted and streamed out. */

const SYM_COLS = 8;    // nameId, kind|flags, fileId, line, typeId, parentId, configId, valueId
const REF_COLS = 8;    // nameId, fileId, line, col, kind|conf, toNameId, fnNameId, configId
const CHUNK_RECS = 1 << 21;      // 2,097,152 records per chunk
const EMPTY_U32 = new Uint32Array(0);

/** A chunked column store: `push` appends one record of `cols` u32 values. */
function makeColumns(cols) {
  const chunks = [];
  let cur = null;
  let used = 0;
  let total = 0;

  return {
    cols,
    chunks,
    get length() { return total; },

    /** Append one record. `vals` is a plain array of `cols` numbers. */
    push(vals) {
      if (!cur || used === CHUNK_RECS) {
        cur = new Uint32Array(CHUNK_RECS * cols);
        chunks.push({ buf: cur, count: 0 });
        used = 0;
      }
      const base = used * cols;
      for (let i = 0; i < cols; i++) cur[base + i] = vals[i] >>> 0;
      used++;
      total++;
      chunks[chunks.length - 1].count = used;
    },

    /** Read record `i` of a chunk as `cols` numbers. Used by the sorters. */
    columnAt(chunk, i, c) { return chunk.buf[i * cols + c]; }
  };
}

/**
 * Collect an index, then write it.
 *
 * Records are appended per file as parsing produces them, so nothing waits for
 * the whole tree: memory tracks the data, not the call structure.
 */
function createBuilder(root) {
  /* ---- string interning: the one table that cannot be sharded or avoided.
     ~2.5M unique names at kernel scale, ~300 MB including the Map itself. */
  const strIds = new Map();
  const strList = [];

  const sid = (v) => {
    if (v === null || v === undefined || v === '') return 0xFFFFFFFF;
    const s = String(v);
    let id = strIds.get(s);
    if (id === undefined) {
      id = strList.length;
      strIds.set(s, id);
      strList.push(s);
    }
    return id;
  };

  const syms = makeColumns(SYM_COLS);
  const refs = makeColumns(REF_COLS);
  const filesMeta = [];
  let rootId = sid(root || '');

  const KINDS_LOCAL = KINDS;

  /* ---- 列式入口（并行池的回流形状，见 index-columns.js）-----------------
   *
   * worker 已经把每个文件的字符串收进字典，这里只需**按字典顺序**给每个
   * 字符串分配一次全局 id —— 与逐条 sid() 的首次出现顺序完全相同，所以
   * 索引与顺序路径逐字节一致（pool-check 对拍）。逐字段的 Map 查找没了：
   * 每条记录只是一次数组下标 + 一次列写入。
   *
   * `M` 把本地 id 翻成全局 id，0xFFFFFFFF（空串）原样保留 —— sid('') 的语义。 */

  const symScratch = new Uint32Array(SYM_COLS);
  const refScratch = new Uint32Array(REF_COLS);

  function addFileColumns(f) {
    const dict = f.dict;
    const map = new Uint32Array(dict.length);
    for (let i = 0; i < dict.length; i++) map[i] = sid(dict[i]);
    const M = (v) => (v === 0xFFFFFFFF ? 0xFFFFFFFF : map[v]);

    /* kind 不进字典（会改变字符串 id 顺序），所以每文件带一张小表。 */
    const kinds = f.kinds || [];
    const kindIds = new Int32Array(kinds.length);
    for (let i = 0; i < kinds.length; i++) kindIds[i] = kindIdOf(kinds[i]);

    const rkinds = f.rkinds || [];
    const refKindIds = new Int32Array(rkinds.length);
    for (let i = 0; i < rkinds.length; i++) {
      refKindIds[i] = REF_KIND_ID[rkinds[i]] === undefined ? REF_READ : REF_KIND_ID[rkinds[i]];
    }

    const fileId = filesMeta.length;
    filesMeta.push({
      pathId: sid(f.rel),
      mtime: Math.floor((f.mtimeMs || 0) / 1000),
      size: f.size || 0,
      firstSym: syms.length,
      symCount: 0,
      firstRef: refs.length,
      refCount: 0,
      lang: (typeof f.lang === 'number' ? f.lang : 0) >>> 0
    });

    const sym = f.sym || EMPTY_U32;
    for (let o = 0; o < sym.length; o += SYM_COLS) {
      let k = kindIds[sym[o + 1]] >>> 0;
      if (sym[o + 7]) k = (k | (SF_PROTOTYPE << 8)) >>> 0;
      symScratch[0] = M(sym[o]);
      symScratch[1] = k;
      symScratch[2] = fileId;
      symScratch[3] = sym[o + 2];
      symScratch[4] = M(sym[o + 3]);
      symScratch[5] = M(sym[o + 4]);
      symScratch[6] = M(sym[o + 5]);
      symScratch[7] = M(sym[o + 6]);
      syms.push(symScratch);
      filesMeta[fileId].symCount++;
    }

    const ref = f.ref || EMPTY_U32;
    for (let o = 0; o < ref.length; o += REF_COLS) {
      const conf = ref[o + 4];
      refScratch[0] = M(ref[o]);
      refScratch[1] = fileId;
      refScratch[2] = ref[o + 1];
      refScratch[3] = ref[o + 2];
      refScratch[4] = (refKindIds[ref[o + 3]]
        | (conf === 1 ? 0x100 : (conf === 2 ? 0x200 : 0))) >>> 0;
      refScratch[5] = M(ref[o + 5]);
      refScratch[6] = M(ref[o + 6]);
      refScratch[7] = M(ref[o + 7]);
      refs.push(refScratch);
      filesMeta[fileId].refCount++;
    }
  }

  function addFileRows(f) {
    const fileId = filesMeta.length;
    filesMeta.push({
      pathId: sid(f.rel),
      mtime: Math.floor((f.mtimeMs || 0) / 1000),
      size: f.size || 0,
      firstSym: syms.length,
      symCount: 0,
      firstRef: refs.length,
      refCount: 0,
      /* 文件级语言 id（语言注册表给的固定枚举；调用方不传就是「未知」）。 */
      lang: (typeof f.lang === 'number' ? f.lang : 0) >>> 0
    });

    for (const s of (f.symbols || [])) {
      if (!s || !s.name) continue;
      syms.push([
        sid(s.name),
        (kindIdOf(s.kind) | (s.prototype ? (SF_PROTOTYPE << 8) : 0)) >>> 0,
        fileId,
        s.line >>> 0,
        sid(s.type),
        sid(s.parent),
        sid(s.config),
        sid(s.value)
      ]);
      filesMeta[fileId].symCount++;
    }

    for (const r of (f.refs || [])) {
      if (!r || !r.name) continue;
      refs.push([
        sid(r.name),
        fileId,
        r.line >>> 0,
        (r.column || r.col || 0) >>> 0,
        (REF_KIND_ID[r.kind] ?? REF_READ) | (r.conf === 'name-only' ? 0x100 : (r.conf === 'unresolved' ? 0x200 : 0)),
        sid(r.to),
        sid(r.fn),
        sid(r.config)
      ]);
      filesMeta[fileId].refCount++;
    }
  }

  /** 两条入口：并行池给列（dict + sym + ref），顺序路给记录数组。 */
  function addFile(f) {
    if (!f || !f.rel) return;
    if (f.dict) addFileColumns(f);
    else addFileRows(f);
  }

  return {
    addFile,
    entry: (rel) => sid(rel),
    counts: () => ({ strings: strList.length, files: filesMeta.length, symbols: syms.length, refs: refs.length }),
    /** Write the finished index straight to disk, one block at a time.
     *  This is the only assembly path - the Buffer variant is built on it, so
     *  there is no second implementation to drift out of step. */
    finishFile: (file) => assembleToFile({ rootId, strList, syms, refs, filesMeta }, file),
    /** Same thing, handed back as a Buffer: tests and probes want one, and at
     *  their sizes the whole-table allocation is a few kilobytes. */
    finishBuffer: async () => {
      const tmp = path.join(os.tmpdir(), `crix-${process.pid}-${(seq++)}.bin`);
      await assembleToFile({ rootId, strList, syms, refs, filesMeta }, tmp);
      const buf = await fsp.readFile(tmp);
      try { await fsp.unlink(tmp); } catch { /* the OS will get it */ }
      return buf;
    }
  };
}

let seq = 0;

/**
 * Write the finished index to `file`.
 *
 * PEAK MEMORY IS ONE BLOCK. The old implementation allocated a full table for
 * symbols and another for references and handed both to Buffer.concat, so the
 * entire index existed twice at the moment of writing. Here every table is
 * streamed out in 256 KB blocks, and the only whole-table structures are the
 * sort orders (4 bytes per record, not 32).
 */
async function assembleToFile(collected, file) {
  const { strList, syms, refs, filesMeta } = collected;

  /* ---- 1. string ids re-assigned in DICTIONARY ORDER ----
     The builder's ids are first-seen order, which is a fine handle but useless
     as a sort key; this is the invariant the whole layout rests on. */
  const order = new Array(strList.length);
  for (let i = 0; i < strList.length; i++) order[i] = i;
  order.sort((a, b) => (strList[a] < strList[b] ? -1 : strList[a] > strList[b] ? 1 : 0));

  const mapId = new Uint32Array(strList.length);
  for (let i = 0; i < order.length; i++) mapId[order[i]] = i;

  let strBytes = 0;
  for (const s of strList) strBytes += Buffer.byteLength(s, 'utf8');

  const strtab = Buffer.allocUnsafe(strBytes);
  const strIdx = Buffer.allocUnsafe(strList.length * REC_STRIDX);
  let so = 0;
  for (let i = 0; i < order.length; i++) {
    const n = strtab.write(strList[order[i]], so, 'utf8');
    strIdx.writeUInt32LE(so, i * REC_STRIDX);
    strIdx.writeUInt32LE(n, i * REC_STRIDX + 4);
    so += n;
  }

  /* ---- 2. records in name order ---- */
  const symOrder = nameOrder(syms, mapId, 0);
  const refOrder = nameOrder(refs, mapId, 0);

  /* ---- 3. per-file ranges ----
     The sort moved every record, so the ranges noted while collecting point
     into the pre-sort order and are now meaningless. They are recomputed by
     walking the sort order once - sequential, one fileId per record. */
  const firstSym = new Int32Array(filesMeta.length).fill(-1);
  const cntSym = new Uint32Array(filesMeta.length);
  for (let i = 0; i < symOrder.length; i++) {
    const src = symOrder[i];
    const f = syms.chunks[(src / CHUNK_RECS) | 0].buf[(src % CHUNK_RECS) * SYM_COLS + 2];
    if (firstSym[f] < 0) firstSym[f] = i;
    cntSym[f]++;
  }
  const firstRef = new Int32Array(filesMeta.length).fill(-1);
  const cntRef = new Uint32Array(filesMeta.length);
  for (let i = 0; i < refOrder.length; i++) {
    const src = refOrder[i];
    const f = refs.chunks[(src / CHUNK_RECS) | 0].buf[(src % CHUNK_RECS) * REF_COLS + 1];
    if (firstRef[f] < 0) firstRef[f] = i;
    cntRef[f]++;
  }

  const filesBuf = Buffer.allocUnsafe(filesMeta.length * REC_FILE);
  for (let i = 0; i < filesMeta.length; i++) {
    const m = filesMeta[i];
    const o = i * REC_FILE;
    filesBuf.writeUInt32LE(mapId[m.pathId], o);
    filesBuf.writeUInt32LE(m.mtime, o + 4);
    filesBuf.writeUInt32LE(m.size, o + 8);
    filesBuf.writeUInt32LE(firstSym[i] < 0 ? 0 : firstSym[i], o + 12);
    filesBuf.writeUInt32LE(cntSym[i], o + 16);
    filesBuf.writeUInt32LE(firstRef[i] < 0 ? 0 : firstRef[i], o + 20);
    filesBuf.writeUInt32LE(cntRef[i], o + 24);
    filesBuf.writeUInt32LE(m.lang >>> 0, o + 28);
  }

  /* ---- 4. offsets: every length is known before a byte is written, which is
     what makes the streaming write possible at all. */
  const seg = {};
  let cursor = HDR.size;
  const place = (key, len) => {
    cursor = (cursor + 3) & ~3;      // tables start 4-byte aligned
    seg[key] = { off: cursor, len };
    cursor += len;
  };
  place('strtab', strtab.length);
  place('strIdx', strIdx.length);
  place('files', filesBuf.length);
  place('sym', symOrder.length * SYM_BYTES);
  place('ref', refOrder.length * REC_REF);

  const header = Buffer.alloc(HDR.size);
  header.writeUInt32LE(MAGIC, HDR.magic);
  header.writeUInt32LE(FORMAT, HDR.version);
  header.writeUInt32LE(Math.floor(Date.now() / 1000), HDR.builtAt);
  header.writeUInt32LE(seg.strtab.off, HDR.strtabOff);
  header.writeUInt32LE(seg.strtab.len, HDR.strtabLen);
  header.writeUInt32LE(seg.strIdx.off, HDR.strIdxOff);
  header.writeUInt32LE(seg.strIdx.len, HDR.strCount);
  header.writeUInt32LE(seg.files.off, HDR.filesOff);
  header.writeUInt32LE(seg.files.len, HDR.fileCount);
  header.writeUInt32LE(seg.sym.off, HDR.symOff);
  header.writeUInt32LE(seg.sym.len, HDR.symCount);
  header.writeUInt32LE(seg.ref.off, HDR.refOff);
  header.writeUInt32LE(seg.ref.len, HDR.refCount);

  /* ---- 5. write ---- */
  const fd = await fsp.open(file, 'w');
  try {
    await fd.write(header, 0, header.length, 0);
    await fd.write(strtab, 0, strtab.length, seg.strtab.off);
    await fd.write(strIdx, 0, strIdx.length, seg.strIdx.off);
    await fd.write(filesBuf, 0, filesBuf.length, seg.files.off);

    const sm = (id) => (id === 0xFFFFFFFF ? 0xFFFFFFFF : mapId[id]);

    await streamTable(fd, seg.sym.off, symOrder, syms, SYM_BYTES, (out, o, s) => {
      out.writeUInt32LE(mapId[s[0]], o);
      out.writeUInt32LE(s[1], o + 4);          // kind | flags
      out.writeUInt32LE(s[2], o + 8);          // fileId
      out.writeUInt32LE(s[3], o + 12);         // line
      out.writeUInt32LE(sm(s[4]), o + 16);     // type
      out.writeUInt32LE(sm(s[5]), o + 20);     // parent
      out.writeUInt32LE(sm(s[6]), o + 24);     // config
      out.writeUInt32LE(sm(s[7]), o + 28);     // value
    });

    await streamTable(fd, seg.ref.off, refOrder, refs, REC_REF, (out, o, s) => {
      out.writeUInt32LE(mapId[s[0]], o);
      out.writeUInt32LE(s[1], o + 4);          // fileId
      out.writeUInt32LE(s[2], o + 8);          // line
      out.writeUInt32LE(s[3], o + 12);         // column
      out.writeUInt32LE(s[4] & 0xFFFF, o + 16);// kind | conf
      out.writeUInt32LE(sm(s[5]), o + 20);     // to
      out.writeUInt32LE(sm(s[6]), o + 24);     // fn
      out.writeUInt32LE(sm(s[7]), o + 28);     // config
    });
  } finally {
    await fd.close();
  }

  return {
    bytes: cursor,
    strings: strList.length,
    symbols: symOrder.length,
    refs: refOrder.length,
    files: filesMeta.length
  };
}

/* ------------------------------------------------------ ordering + layout

   TWO THINGS HAPPEN HERE THAT THE QUERY PATH DEPENDS ON.

   1. String ids are re-assigned in DICTIONARY ORDER. The builder's ids are
      first-seen order, which is a fine handle but useless as a sort key - see
      the invariant at the top of this file.

   2. Records are re-ordered by their new name id. That is what turns a query
      into a binary search instead of a scan.

   HOW THE REORDER IS DONE, AND WHY IT MATTERS. A comparator sort over 40M
   records is not an option. Counting sort needs, for each output slot, the
   record that belongs there - held in a single Int32Array of length n. Because
   the source is chunked, filling that array is a SEQUENTIAL walk (chunks in
   order), and reading it back for the write is random only within a chunk
   lookup that costs one shift. */

/** Counting sort: returns `order` where order[i] is the source record at output i. */
function nameOrder(cols, mapId, srcCol) {
  const n = cols.length;
  const maxId = mapId.length;
  const count = new Uint32Array(maxId + 1);

  for (const chunk of cols.chunks) {
    const buf = chunk.buf;
    for (let i = 0; i < chunk.count; i++) {
      const id = mapId[buf[i * cols.cols + srcCol]];
      if (id !== 0xFFFFFFFF) count[id]++;
    }
  }

  let acc = 0;
  for (let i = 0; i < count.length; i++) { const c = count[i]; count[i] = acc; acc += c; }

  const order = new Int32Array(acc);
  let global = 0;
  for (const chunk of cols.chunks) {
    const buf = chunk.buf;
    for (let i = 0; i < chunk.count; i++, global++) {
      const id = mapId[buf[i * cols.cols + srcCol]];
      if (id !== 0xFFFFFFFF) order[count[id]++] = global;
    }
  }
  return order;
}

/** Byte size of one symbol record in the finished file. */
const SYM_BYTES = REC_SYMBOL;

/**
 * Write one table, in output order, a block at a time.
 *
 * `emit` receives the destination buffer and the block's first record index and
 * fills it. Blocks are written and released, so the peak is one block - not the
 * 1.28 GB table the old code allocated to hand to Buffer.concat.
 */
async function streamTable(fd, at, order, cols, stride, emit) {
  const perBlock = 1 << 13;                 // 8192 records = 256 KB at 32 B
  const n = order.length;
  const scratch = new Uint32Array(cols.cols);
  let first = 0;

  for (let start = 0; start < n; start += perBlock) {
    const count = Math.min(perBlock, n - start);
    /* `alloc`, not `allocUnsafe`: a symbol record is 40 bytes while只有 8 列 (32B)
       被写，尾巴那 8 字节以前是堆上残留 —— 索引因此不可复现（也会把别人
       的内存写进文件）。Ref 表 32B 正好写满，但两条路共用这里，统一零填。 */
    const out = Buffer.alloc(count * stride);
    for (let j = 0; j < count; j++) {
      const src = order[start + j];
      const chunk = cols.chunks[(src / CHUNK_RECS) | 0];
      const o = (src % CHUNK_RECS) * cols.cols;
      for (let c = 0; c < cols.cols; c++) scratch[c] = chunk.buf[o + c];
      emit(out, j * stride, scratch);
    }
    /* `fd` is a FileHandle, so the call is write(buffer, offset, length,
       position) - NOT the fs.write(fd, buffer, ...) form. Passing a FileHandle
       to fs.promises.write does not exist and fails at the first block, which
       is why an entire index once came out at 0 bytes. */
    await fd.write(out, 0, out.length, at + first * stride);
    first += count;
  }
  return n;
}

/* ------------------------------------------------------------- encoding */

/**
 * Build the index file.
 *
 * @param {object} input
 * @param {string} input.root        project root (stored for validation)
 * @param {Array}  input.files       [{ rel, mtimeMs, size, symbols, refs }]
 * @param {Array}  input.parsed      legacy shape: [{ rel, symbols, includes, conds, refs }]
 * @returns {Buffer}
 */
/**
 * Build an index Buffer from a list of files.
 *
 * A thin wrapper over the builder, kept so tests and probes can hand over a
 * plain array. The real path is `createBuilder(...).finishFile(path)`, which
 * never holds the whole index in memory - THIS ONE DOES, and is only suitable
 * at the sizes the tests work with.
 *
 * @param {object} input
 * @param {string} input.root
 * @param {Array}  input.files   [{ rel, mtimeMs, size, symbols, refs }]
 * @returns {Promise<Buffer>}
 */
async function encode(input) {
  const b = createBuilder((input && input.root) || '');
  for (const f of ((input && (input.files || input.parsed)) || [])) b.addFile(f);
  return b.finishBuffer();
}

/* kind 编号顺序由语言表给定（改顺序 = 格式变更 = 重建索引）。 */
const KINDS = SYMS.indexKinds || [];

function kindIdOf(kind) {
  const i = KINDS.indexOf(kind);
  return i < 0 ? KINDS.length - 1 : i;
}

/* ------------------------------------------------------------ access layer

   The index is opened through a RANDOM-ACCESS abstraction; it is not read into
   memory. At kernel scale (tens of thousands of files, millions of symbols, tens
   of millions of references) the tables run to hundreds of megabytes, and
   loading them whole is not an option.

     openBuffer(buf)  - resident. Tests, and trees small enough not to care.
     openFile(path)   - reads on demand through a page cache. The real path.

   Everything above talks only to readAt(offset, length) and cannot tell which
   one it got, so the query code is written once (SPEC F1.17).

   ALIGNMENT IS LOAD-BEARING. Records are multiples of 4 bytes and the writer
   pads every table to a 4-byte boundary, so a table-aligned offset is always
   safe to view as u32. PAGE is a multiple of 4 for the same reason: a
   page-cached window at a table-aligned offset stays aligned. */

const COLS_SYM = REC_SYMBOL / 4;      // 10
const COLS_REF = REC_REF / 4;         // 8
const COLS_FILE = REC_FILE / 4;       // 8

/* 页缓存的大小 —— 原来 24 页(192 KB)在 1.1 GB 的内核索引上是灾难性的:
   `idOf` 是用字符串表做的二分查找,每一步都要读一个字符串,而那 200 MB 的字符串表
   和 6 MB 的 strIdx 表都远在缓存之外,于是**每一次符号查询 = 二十来次随机盘读 ≈
   50 ms**。实测:解析 206 个接收者的类型要 9.2 秒,点一次成员的首次渲染 30 秒
   (2026-10-14)。2048 页 = 16 MB,对今天的机器是零成本,而它把热区留在内存里 ——
   同一个查询第二次就降到 1~2 ms。 */
const PAGE_CACHE_DEFAULT = 2048;

const PAGE = 8192;
const PAGE_CACHE = PAGE_CACHE_DEFAULT;

function makeBufferReader(buf) {
  return {
    size: buf.length,
    readAt(off, len) { return buf.subarray(off, off + len); },
    readBulk(off, len) { return buf.subarray(off, off + len); },
    close() {}
  };
}

function makeFileReader(file) {
  let fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const pages = new Map();            // page index -> Buffer; insertion order = LRU

  /* 重建索引收尾会 close 掉旧 store（Windows 上必须先关才能 rename 覆盖）。
     那一刻仍在飞的查询会拿到 EBADF —— 这里就地重开一次再读，而不是让接口 500。
     重开后拿到的是新索引（或同一份旧文件），内容自洽。 */
  const reopen = () => {
    if (fd >= 0) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    pages.clear();
    fd = fs.openSync(file, 'r');
  };
  const readSyncRetry = (buf, offset, length, position) => {
    try {
      return fs.readSync(fd, buf, offset, length, position);
    } catch (err) {
      if (err && (err.code === 'EBADF' || err.code === 'ERR_INVALID_ARG_TYPE')) {
        reopen();
        return fs.readSync(fd, buf, offset, length, position);
      }
      throw err;
    }
  };

  const page = (i) => {
    let p = pages.get(i);
    if (p) return p;
    /* allocUnsafeSlow, NOT allocUnsafe: the pooled allocator hands back a slice
       of a shared ArrayBuffer whose byteOffset is arbitrary, and Uint32Array
       refuses a misaligned base. A dedicated buffer starts at 0. */
    const b = Buffer.allocUnsafeSlow(PAGE);
    const n = readSyncRetry(b, 0, PAGE, i * PAGE);
    p = n === PAGE ? b : b.subarray(0, n);
    if (pages.size >= PAGE_CACHE) pages.delete(pages.keys().next().value);
    pages.set(i, p);
    return p;
  };

  return {
    size,
    readAt(off, len) {
      const first = Math.floor(off / PAGE);
      const last = Math.floor((off + len - 1) / PAGE);
      if (first === last) {
        const base = first * PAGE;
        return page(first).subarray(off - base, off - base + len);
      }
      const out = Buffer.allocUnsafeSlow(len);
      let done = 0;
      for (let i = first; i <= last && done < len; i++) {
        const p = page(i);
        const from = Math.max(0, off - i * PAGE);
        const n = Math.min(p.length - from, len - done);
        if (n > 0) { p.copy(out, done, from, from + n); done += n; }
      }
      return out;
    },
    /* Bulk sequential read. `readAt` above goes through the 8 KB page cache
       because lookups want a few dozen bytes; scanning a hundred megabytes that
       way would be tens of thousands of tiny reads and dozens of thousands of
       allocations. This reads straight into one buffer. */
    readBulk(off, len) {
      const out = Buffer.allocUnsafeSlow(len);
      let done = 0;
      while (done < len) {
        const n = readSyncRetry(out, done, len - done, off + done);
        if (n <= 0) break;
        done += n;
      }
      return done === len ? out : out.subarray(0, done);
    },
    /* 幂等：重复 close 不能再去关一个可能已被系统复用的 fd 号。 */
    close() {
      if (fd < 0) return;
      try { fs.closeSync(fd); } catch { /* already closed */ }
      fd = -1;
      pages.clear();
    }
  };
}

/**
 * Open an index. `source` is a path (read on demand) or a Buffer (resident).
 *
 * The heavy tables are never materialised: a binary search reads ONE record per
 * step through the page cache, and only the matching range is walked. The memory
 * footprint is O(answer), not O(index) - which is the difference between this
 * working on a kernel tree and not.
 */
function open(source) {
  const rd = (typeof source === 'string') ? makeFileReader(source) : makeBufferReader(source);
  try {
    return openFromReader(rd);
  } catch (err) {
    /* 校验失败（格式号属于旧版本、文件截断…）也必须松开句柄。Windows 上
       泄漏的句柄会让紧接着的「建立索引」在 rename 覆盖同一个文件时 EPERM。 */
    rd.close();
    throw err;
  }
}

function openFromReader(rd) {
  const hdr = rd.readAt(0, HDR.size);
  if (hdr.length < HDR.size) throw new Error('index: truncated');
  if (hdr.readUInt32LE(HDR.magic) !== MAGIC) throw new Error('index: bad magic');
  const version = hdr.readUInt32LE(HDR.version);
  if (version !== FORMAT) throw new Error('index: format ' + version + ', expected ' + FORMAT);

  const seg = {
    strtab: { off: hdr.readUInt32LE(HDR.strtabOff), len: hdr.readUInt32LE(HDR.strtabLen) },
    strIdx: { off: hdr.readUInt32LE(HDR.strIdxOff), len: hdr.readUInt32LE(HDR.strCount) },
    files: { off: hdr.readUInt32LE(HDR.filesOff), len: hdr.readUInt32LE(HDR.fileCount) },
    syms: { off: hdr.readUInt32LE(HDR.symOff), len: hdr.readUInt32LE(HDR.symCount) },
    refs: { off: hdr.readUInt32LE(HDR.refOff), len: hdr.readUInt32LE(HDR.refCount) }
  };
  /* 段越界校验：头合法但文件被截断（复制中断、rename 只完成一半）时，
     下面任何一次 readAt 都会拿到短 buffer，`readUInt32LE` 直接抛 RangeError，
     而且是在**查询期**抛。这里一次挡掉，让上层按"索引不可用"处理。 */
  const size = rd.size;
  for (const key of ['strtab', 'strIdx', 'files', 'syms', 'refs']) {
    const s = seg[key];
    if (!Number.isFinite(s.off) || !Number.isFinite(s.len) || s.off + s.len > size) {
      throw new Error(`index: segment ${key} out of range (off=${s.off} len=${s.len} size=${size})`);
    }
  }

  const strCount = Math.floor(seg.strIdx.len / REC_STRIDX);

  /** One whole record in one call; cheaper than reading column by column. */
  const rec = (s, stride, i) => rd.readAt(s.off + i * stride, stride);

  const strAt = (id) => {
    if (id === 0xFFFFFFFF || id >= strCount) return '';
    const e = rd.readAt(seg.strIdx.off + id * REC_STRIDX, REC_STRIDX);
    const off = e.readUInt32LE(0);
    const len = e.readUInt32LE(4);
    if (!len) return '';
    return rd.readAt(seg.strtab.off + off, len).toString('utf8');
  };

  /* The string table is stored in dictionary order, so resolving a name is a
     binary search whose comparison reads the string - not a hash map, and not a
     linear scan. */
  const idOf = (name) => {
    if (name === null || name === undefined || name === '') return 0xFFFFFFFF;
    const want = String(name);
    let lo = 0;
    let hi = strCount;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (strAt(m) < want) lo = m + 1; else hi = m;
    }
    return (lo < strCount && strAt(lo) === want) ? lo : 0xFFFFFFFF;
  };

  /** Project-relative path of a file ordinal. */
  const fileRelOf = (fileId) => strAt(rec(seg.files, REC_FILE, fileId).readUInt32LE(0));

  /**
   * One symbol record, decoded - INCLUDING its file path.
   *
   * The record stores a fileId, but every caller works with paths: the renderer
   * matches symbols against the open file by name, and the search list prints
   * `file:line`. Leaving the path out meant `sym.file` was undefined and a
   * symbol could never be recognised as belonging to the current file, which is
   * why the context window showed every name as unresolved.
   */
  const symAt = (i) => {
    const b = rec(seg.syms, REC_SYMBOL, i);
    const kf = b.readUInt32LE(4);
    const fileId = b.readUInt32LE(8);
    return {
      name: strAt(b.readUInt32LE(0)),
      kind: KINDS[kf & 0xFF] || 'variable',
      prototype: !!(kf & (SF_PROTOTYPE << 8)),
      fileId,
      file: fileRelOf(fileId),
      line: b.readUInt32LE(12),
      type: strAt(b.readUInt32LE(16)),
      parent: strAt(b.readUInt32LE(20)),
      config: strAt(b.readUInt32LE(24)),
      value: strAt(b.readUInt32LE(28)),
      id: i
    };
  };

  /* Built on first use; the file table is small enough to keep. */
  let relIndex = null;

  /* 池过滤后的符号总数（按「全局/全部 + 池」缓存，见 symbolsPage）。 */
  const poolTotalCache = new Map();

  /** Half-open [first, first + count) of records whose name column equals `id`. */
  const rangeOf = (s, stride, id) => {
    const n = Math.floor(s.len / stride);
    const keyAt = (i) => rd.readAt(s.off + i * stride, 4).readUInt32LE(0);
    let lo = 0;
    let hi = n;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (keyAt(m) < id) lo = m + 1; else hi = m; }
    const first = lo;
    hi = n;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (keyAt(m) <= id) lo = m + 1; else hi = m; }
    return { first, count: lo - first };
  };

  const fileCount = Math.floor(seg.files.len / REC_FILE);

  /* ---- 池过滤（G.4「语言分离」）---------------------------------------
   *
   * 符号类查询只在**当前文件所属语言**内回答：C 的宏 `X` 不该把 C++ 文件里
   * 同名定义算进来。语言 id 存在文件记录里（第 8 个 u32），所以这里是纯数据，
   * 索引层不认识"池"以外的东西——传进来的是 lang id 数组，不是语言名。
   *
   * `pool = null` 表示不限制（跨池兜底 / 没有上下文的调用方）。掩码只建一次，
   * `langByFile` 也是懒建的 Uint8Array（几万个文件 → 几十 KB），逐记录判断
   * 就是一次数组下标，热路径上没有分配。 */

  let langByFile = null;
  const langTable = () => {
    if (!langByFile) {
      langByFile = new Uint8Array(fileCount);
      for (let i = 0; i < fileCount; i++) {
        langByFile[i] = rec(seg.files, REC_FILE, i).readUInt32LE(28);
      }
    }
    return langByFile;
  };

  const poolMask = (pool) => {
    if (!pool) return null;
    const ids = Array.isArray(pool) ? pool : [pool];
    const m = new Uint8Array(256);
    let any = false;
    for (const v of ids) {
      const n = Number(v) | 0;
      if (n > 0 && n < 256) { m[n] = 1; any = true; }
    }
    return any ? m : null;
  };

  /* ---- per-file symbol grouping, built on first use ----

     THE FILE TABLE'S first/count FIELDS CANNOT ANSWER THIS. They record where a
     file's first symbol sits and how many it has - but the symbol table is
     sorted by NAME, so the records between those two points belong to every
     file at once. Reading the range as "this file's symbols" returned an
     arbitrary slice of the alphabet: outline('ctx.c') came back with symbols
     from four different files, with line numbers pointing at unrelated code,
     and the semantic colouring painted nothing because not one of those names
     appeared on the line it was told to look at. A wrong answer, delivered
     silently - the worst kind.

     One sequential pass builds the real grouping. Read in blocks rather than
     record by record: at kernel scale that is 6.8M records, and one call per
     record would cost more in overhead than in bytes. Every later outline is
     then O(symbols in that file). */
  let byFile = null;
  const symbolIndex = () => {
    if (byFile) return byFile;
    const n = Math.floor(seg.syms.len / REC_SYMBOL);
    const BLK = 4096;                       // records per read (128 KB)
    const first = new Uint32Array(fileCount + 1);

    for (let base = 0; base < n; base += BLK) {
      const cnt = Math.min(BLK, n - base);
      const buf = rd.readAt(seg.syms.off + base * REC_SYMBOL, cnt * REC_SYMBOL);
      for (let i = 0; i < cnt; i++) {
        const f = buf.readUInt32LE(i * REC_SYMBOL + 8);
        if (f < fileCount) first[f + 1]++;
      }
    }
    for (let f = 0; f < fileCount; f++) first[f + 1] += first[f];

    const slots = new Int32Array(n);
    const cursor = first.slice();
    for (let base = 0; base < n; base += BLK) {
      const cnt = Math.min(BLK, n - base);
      const buf = rd.readAt(seg.syms.off + base * REC_SYMBOL, cnt * REC_SYMBOL);
      for (let i = 0; i < cnt; i++) {
        const f = buf.readUInt32LE(i * REC_SYMBOL + 8);
        if (f < fileCount) slots[cursor[f]++] = base + i;
      }
    }
    byFile = { first, slots };
    return byFile;
  };

  /* ------------------------------------------------------ substring search

     Names live in the string table: one concatenated run of UTF-8, in DICTIONARY
     order. Two things follow, and both are used below.

       1. Ids are ordered by name, and the symbol table is ordered by name id - so
          the symbol table IS an alphabetical listing of every symbol, and "show
          all symbols" is a page of records rather than a search. Paging over it
          costs nothing but the records read.

       2. A substring search cannot binary-search, but it does not have to test
          six million strings one at a time either. The whole table is scanned as
          RAW BYTES - one native scan over ~120 MB - and each hit is mapped back
          to the string that owns it. Strings are concatenated with NO separator,
          so a hit really can land across a boundary; the ownership check is what
          discards those, and it is not optional.

     The offset column is monotonic, so it is materialised once and binary-
     searched. That is the price of substring search over a dictionary-ordered
     table; a prefix search needs none of it, which is why the old prefix path is
     still here and still cheap. */
  let strOffsets = null;
  const offsetsOf = () => {
    if (strOffsets) return strOffsets;
    const out = new Uint32Array(strCount);
    const CH = 1 << 22;                            // 4 MB
    let id = 0;
    for (let off = 0; off < seg.strIdx.len && id < strCount; off += CH) {
      const n = rd.readBulk(seg.strIdx.off + off, Math.min(CH, seg.strIdx.len - off));
      for (let i = 0; i + REC_STRIDX <= n.length && id < strCount; i += REC_STRIDX) {
        out[id++] = n.readUInt32LE(i);
      }
    }
    strOffsets = out;
    return out;
  };

  /** One byte per string id: does that string's text contain `token`? */
  const markContaining = (token) => {
    const bits = new Uint8Array(strCount);
    const needle = Buffer.from(token, 'utf8');
    if (!needle.length) return bits;

    const offs = offsetsOf();
    const total = seg.strtab.len;
    const CH = 4 << 20;
    /* Chunks OVERLAP by one byte less than the needle, so no match can straddle
       a boundary. Overlap means a hit can be seen twice; it only ever sets the
       same bit, so duplicates cost nothing. */
    const step = Math.max(1, CH - (needle.length - 1));

    for (let base = 0; base < total; base += step) {
      const buf = rd.readBulk(seg.strtab.off + base, Math.min(CH, total - base));
      let from = 0;
      for (;;) {
        const at = buf.indexOf(needle, from);
        if (at < 0) break;
        from = at + 1;
        const abs = base + at;

        let lo = 0;
        let hi = strCount - 1;
        let id = -1;
        while (lo <= hi) {
          const m = (lo + hi) >> 1;
          if (offs[m] <= abs) { id = m; lo = m + 1; } else hi = m - 1;
        }
        if (id < 0) continue;
        const end = id + 1 < strCount ? offs[id + 1] : total;
        if (abs + needle.length <= end) bits[id] = 1;
      }
    }
    return bits;
  };

  /* The current query's bitmap, kept so paging does not re-scan 120 MB per page. */
  let cachedKey = null;
  let cachedBits = null;
  const matchBits = (terms) => {
    const key = terms.join('\u0000');
    if (cachedKey === key && cachedBits) return cachedBits;
    let acc = null;
    for (const t of terms) {
      const bits = markContaining(t);
      if (!acc) acc = bits;
      else for (let i = 0; i < strCount; i++) if (acc[i] && !bits[i]) acc[i] = 0;
    }
    cachedKey = key;
    cachedBits = acc;
    return acc;
  };

  /* Project-relative paths by file ordinal, built once. The file table is small
     (tens of thousands), and filtering it needs every name anyway. */
  let relList = null;
  const relsOf = () => {
    if (relList) return relList;
    const out = new Array(fileCount);
    for (let i = 0; i < fileCount; i++) out[i] = strAt(rec(seg.files, REC_FILE, i).readUInt32LE(0));
    relList = out;
    return out;
  };

  /* ------------------------------------------------- the GLOBAL symbol list

     SI's symbol windows list the GLOBAL symbols - functions, macros, types and
     file-scope variables. Locals and parameters are not navigation targets:
     they are read where they are written, which is why no other tool puts them
     in a symbol list either. Listing them turned a 600-symbol outline into a
     3,000-row pile with the function you wanted buried inside it, and at kernel
     scale it made `i` the largest "symbol" in the project (57,337 declarations).

     Ordinals, built lazily exactly like the per-file grouping: one pass over the
     symbol table (about 1.4 s at kernel scale) and every page after it is O(1)
     instead of a scan from row zero. `globalName` marks the names that have at
     least one global declaration, so a filtered count counts names that can
     actually produce a row. */
  let globalOrd = null;
  let globalName = null;
  const globalsIndex = () => {
    if (globalOrd) return globalOrd;
    const n = Math.floor(seg.syms.len / REC_SYMBOL);
    const BLK = 4096;
    const ord = [];
    const names = new Uint8Array(strCount);
    for (let base = 0; base < n; base += BLK) {
      const cnt = Math.min(BLK, n - base);
      const buf = rd.readAt(seg.syms.off + base * REC_SYMBOL, cnt * REC_SYMBOL);
      for (let i = 0; i < cnt; i++) {
        const o = i * REC_SYMBOL;
        const k = buf.readUInt32LE(o + 4) & 0xFF;
        /* 0..4 = struct/union/enum/typedef/macro, 9 = function, and a variable
           with no enclosing function is a file-scope one. */
        const isGlobal = k <= 4 || k === 9
          || (k === 5 && buf.readUInt32LE(o + 20) === 0xFFFFFFFF);
        if (!isGlobal) continue;
        ord.push(base + i);
        const nm = buf.readUInt32LE(o);
        if (nm < strCount) names[nm] = 1;
      }
    }
    globalName = names;
    globalOrd = Uint32Array.from(ord);
    return globalOrd;
  };

  /** The same rule, applied to a record that is already decoded. */
  const GLOBAL_KINDS = new Set(SYMS.globalKinds || []);
  const isGlobalRow = (s) => GLOBAL_KINDS.has(s.kind)
    || (s.kind === 'variable' && !s.parent);

  const termsOf = (tokens) => (tokens || [])
    .map((t) => String(t).trim())
    .filter(Boolean)
    /* Longest first: a longer term rejects more, and the loop below can stop on
       the shortest match sooner. Purely a cost detail. */
    .sort((a, b) => b.length - a.length);

  /* ------------------------------------------------- 过滤结果的匹配度排序

     (user request 2026-10-15: "关于匹配,优先显示那些最匹配的项目,比如输入 sk buff,
     先是 sk_buff,然后是 __sk_buff 依次类推";文件名同理,`tcp ipv4` 要先把
     tcp_ipv4.c 排出来,再是 ipv4/tcp.c)

     规则(每个词单独打分再累加,多词全部命中是过滤的前提):

       名字            完全相等 1000
                       前缀命中 700 − 名字比词长出的部分(越短越前)
                       词首命中(下划线之后)500 − 偏移
                       其它子串 300 − 命中位置(越靠左越前)
       路径            basename 完全相等 1000 / 前缀 700 / 子串 500
                       目录段命中 300,只在完整路径里出现 100

     最后减一个很小的长度惩罚(名字/路径越短越前),排序稳定:同分时按名字/路径
     字典序 —— 分页靠这个顺序推进,不稳定就会出现重页或漏页。
     大小写按原样(与索引的子串匹配一致:C 标识符本身区分大小写)。 */

  const scoreName = (name, terms) => {
    let total = 0;
    for (const t of terms) {
      if (name === t) { total += 1000; continue; }
      if (name.startsWith(t)) { total += 700 - Math.min(200, name.length - t.length); continue; }
      const seg = name.indexOf('_' + t);
      if (seg >= 0) { total += 500 - Math.min(100, seg); continue; }
      total += 300 - Math.min(200, Math.max(0, name.indexOf(t)));
    }
    return total - Math.min(60, name.length);
  };

  const scorePath = (rel, terms) => {
    const cut = rel.lastIndexOf('/');
    const base = cut >= 0 ? rel.slice(cut + 1) : rel;
    const dir = cut >= 0 ? rel.slice(0, cut) : '';
    let total = 0;
    for (const t of terms) {
      if (base === t) { total += 1000; continue; }
      if (base.startsWith(t)) { total += 700 - Math.min(200, base.length - t.length); continue; }
      const inBase = base.indexOf(t);
      if (inBase >= 0) { total += 500 - Math.min(200, inBase); continue; }
      const inDir = dir.indexOf(t);
      if (inDir >= 0) { total += 300 - Math.min(200, inDir); continue; }
      total += 100 - Math.min(80, Math.max(0, rel.indexOf(t)));
    }
    return total - Math.min(80, rel.length);
  };

  /* 打分的候选封顶:精确匹配与前缀匹配在名字序里天然挨着(都在词的邻域),所以取
     名字序的前 5 万个不会漏掉"最匹配"的那些;封顶只影响超长尾部的排序。 */
  const CAND_CAP = 50000;

  const api = {
    bytes: rd.size,
    builtAt: hdr.readUInt32LE(HDR.builtAt),
    counts: {
      strings: strCount,
      files: Math.floor(seg.files.len / REC_FILE),
      symbols: Math.floor(seg.syms.len / REC_SYMBOL),
      refs: Math.floor(seg.refs.len / REC_REF)
    },
    strAt,
    idOf,
    close: () => rd.close(),

    /**
     * Symbols with this name, read one record at a time and stopped as soon as
     * the caller has enough.
     *
     * WHY THE FILTER IS APPLIED WHILE READING (2026-10-14). `symbols('p')` in a
     * kernel index decodes tens of thousands of records and does five
     * string-table lookups on each; `symbols('hdr')` four and a half thousand.
     * The receiver resolver asks for a TYPE - it wants eight rows - and it asks
     * dozens of times per member click, once per distinct receiver name. Reading
     * the whole record set every time cost 3.4 seconds for a single `dest` click,
     * all of it on rows nobody ever looked at. `accept` is checked before the
     * expensive part (`strAt`), and `limit` stops the walk.
     *
     * A null `accept` with no limit is the old behaviour: everything, eagerly -
     * which is what a caller that really needs the whole set (a name-completion
     * list) still gets.
     */
    symbolsWhere(name, accept, limit, pool) {
      const id = idOf(name);
      if (id === 0xFFFFFFFF) return [];
      const r = rangeOf(seg.syms, REC_SYMBOL, id);
      const cap = Number(limit) > 0 ? Number(limit) : 0;
      const mask = poolMask(pool);
      const langs = mask ? langTable() : null;
      const out = [];
      for (let i = r.first; i < r.first + r.count; i++) {
        if (cap && out.length >= cap) break;
        const b = rec(seg.syms, REC_SYMBOL, i);
        /* Pool check before anything expensive: one array read, no strAt. */
        if (mask && !mask[langs[b.readUInt32LE(8)]]) continue;
        const kf = b.readUInt32LE(4);
        const kind = KINDS[kf & 0xFF] || 'variable';
        const parent = strAt(b.readUInt32LE(20));
        const fileId = b.readUInt32LE(8);
        /* Cheap fields first: the predicate looks at kind/parent/fileId only. */
        if (accept && !accept({ kind, parent, fileId })) continue;
        out.push({
          name,
          kind,
          prototype: !!(kf & (SF_PROTOTYPE << 8)),
          fileId,
          line: b.readUInt32LE(12),
          type: strAt(b.readUInt32LE(16)),
          parent,
          config: strAt(b.readUInt32LE(24)),
          value: strAt(b.readUInt32LE(28)),
          id: b.readUInt32LE(32)
        });
      }
      return out;
    },

    /** Symbols with this name. Confidence is stated, never assumed.
     *  `pool` = 语言 id 数组（G.4 池过滤）；null = 所有池。 */
    symbols(name, pool) {
      return api.symbolsWhere(name, null, 0, pool);
    },

    /**
     * References to this name, with the binding resolved on the spot.
     *
     * `to` holds the target's NAME, not a verdict. Whether it binds is decided
     * here: a symbol of that name in the index means the reference is exact,
     * otherwise it is a name-only hit and says so (SPEC F1.12 / D16).
     */
    references(name, pool) {
      const id = idOf(name);
      if (id === 0xFFFFFFFF) return [];
      /* 池内的"定义"与"引用"是同一件事的两面：绑定判定也只认本池的定义，
         否则跨语言同名（Go 的 `foo` 与 C 的 `foo`）会把引用误判成 exact。 */
      const mask = poolMask(pool);
      const langs = mask ? langTable() : null;

      /* THE CROSS-FILE STEP, and it belongs here rather than in the parser.
       *
       * A file can only see its own symbols while it is being parsed, so
       * `printk` used in net/core/dev.c is filed as name-only even though
       * include/linux/printk.h defines it - the parser has never read that file
       * yet, and the order of files is arbitrary. Deferring the binding to query
       * time is what the design called for (SPEC F1.12); this is that step, and
       * it was missing.
       *
       * TWO KINDS OF SYMBOL SHARE ONE NAME, and they must be judged differently:
       *
       *   GLOBAL  a function, a type, a macro, a file-scope variable. Unique in
       *           the program, so a reference from ANY file binds to it.
       *
       *   LOCAL   a variable or parameter inside a function. It belongs to that
       *           function alone. `i` has 57,337 definitions across the kernel,
       *           and calling every use of `i` an exact match against all of
       *           them is worse than admitting we only know the name.
       *
       * The `parent` column says which it is: a local records the function it
       * lives in, a global has none. Doing this once per query - not once per
       * reference - is what keeps it cheap. */
      const decl = rangeOf(seg.syms, REC_SYMBOL, id);
      let hasGlobalKind = false;
      const fileScope = new Set();     // files declaring this name at file scope
      const scoped = new Set();        // fileId + '\0' + enclosing function
      for (let i = decl.first; i < decl.first + decl.count; i++) {
        const s = rec(seg.syms, REC_SYMBOL, i);
        const f0 = s.readUInt32LE(8);
        if (mask && !mask[langs[f0]]) continue;
        const k = s.readUInt32LE(4) & 0xFF;
        /* struct / union / enum / typedef / macro / function are UNIQUE IN THE
           PROGRAM by the language's own rules, so a reference to one binds to it
           from any file. `variable` and `parameter` are not: `i` has 57,337
           declarations across the kernel and no reference to `i` can be said to
           bind to any particular one. Treating a file-scope `static int i;`
           as a program-global symbol (the first attempt) made every one of
           366,665 `i` references "exact", which is a worse lie than admitting
           the name alone. */
        if (k <= 4 || k === 9) hasGlobalKind = true;
        const fid = f0;
        const par = strAt(s.readUInt32LE(20));
        if (par) scoped.add(fid + '\u0000' + par); else fileScope.add(fid);
      }
      const noSymbol = decl.count === 0;

      const r = rangeOf(seg.refs, REC_REF, id);
      const out = [];
      for (let i = r.first; i < r.first + r.count; i++) {
        const b = rec(seg.refs, REC_REF, i);
        const flags = b.readUInt32LE(16);
        const fileId = b.readUInt32LE(4);
        if (mask && !mask[langs[fileId]]) continue;
        out.push({
          name,
          fileId,
          line: b.readUInt32LE(8),
          column: b.readUInt32LE(12),
          kind: REF_KIND_NAME[flags & 0xFF] || 'read',
          /* Exactness is claimed at three levels of evidence, strongest first:
           *   - a name that C makes unique in the program (function / type /
           *     macro) binds wherever it appears;
           *   - declared at file scope in the SAME file: visible to the whole
           *     file, so a reference in it binds;
           *   - declared inside the SAME function: the tightest case, and the
           *     one that separates `i` in foo from `i` in bar.
           * Everything else is name-only, which is what it is. */
          conf: noSymbol
            ? ((flags & 0x200) ? 'unresolved' : 'name-only')
            : ((hasGlobalKind
                || fileScope.has(fileId)
                || scoped.has(fileId + '\u0000' + strAt(b.readUInt32LE(24))))
              ? 'exact' : 'name-only'),
          fn: strAt(b.readUInt32LE(24)),
          config: strAt(b.readUInt32LE(28)),
          to: strAt(b.readUInt32LE(20))
        });
      }
      return out;
    },

    file(i) {
      const b = rec(seg.files, REC_FILE, i);
      return {
        rel: strAt(b.readUInt32LE(0)),
        mtime: b.readUInt32LE(4),
        size: b.readUInt32LE(8),
        symbols: { first: b.readUInt32LE(12), count: b.readUInt32LE(16) },
        refs: { first: b.readUInt32LE(20), count: b.readUInt32LE(24) },
        lang: b.readUInt32LE(28)
      };
    },

    /**
     * Symbols whose name matches `q` - exact hit first, then the prefix run.
     *
     * The table is sorted by name, so this is a binary search to the lower
     * bound plus a short forward read. Scanning was fine at fixture scale and
     * hopeless at kernel scale: twelve million records per keystroke.
     */
    symbolsMatching(q, cap, pool) {
      const want = String(q || '');
      const limit = Math.max(1, Math.min(Number(cap) || 80, 500));
      const mask = poolMask(pool);
      const langs = mask ? langTable() : null;
      const out = [];

      /* An empty query has no prefix to search for; take the head of the table,
         which is at least deterministic. */
      if (!want) {
        const n = Math.floor(seg.syms.len / REC_SYMBOL);
        for (let i = 0; i < n && out.length < limit; i++) {
          if (mask && !mask[langs[symAt(i).fileId]]) continue;
          out.push(symAt(i));
        }
        return out;
      }

      /* Lower bound: the first string >= `want`, which is where a prefix run
         begins. A case-insensitive second pass is not attempted - the table is
         case-sensitive and pretending otherwise would return a wrong ordering. */
      let lo = 0;
      let hi = strCount;
      while (lo < hi) {
        const m = (lo + hi) >>> 1;
        if (strAt(m) < want) lo = m + 1; else hi = m;
      }

      const symCount = Math.floor(seg.syms.len / REC_SYMBOL);
      const seen = new Set();
      for (let id = lo; id < strCount && out.length < limit; id++) {
        const name = strAt(id);
        if (!name.startsWith(want)) break;
        const r = rangeOf(seg.syms, REC_SYMBOL, id);
        for (let i = r.first; i < r.first + r.count && out.length < limit; i++) {
          const s = symAt(i);
          if (mask && !mask[langs[s.fileId]]) continue;
          if (seen.has(s.id)) continue;
          seen.add(s.id);
          out.push(s);
        }
      }
      return out;
    },

    /** The ordinal of a file by its project-relative path, or null.
     *  Built lazily and kept: the file table is small (tens of thousands). */
    fileIdOf(rel) {
      if (!relIndex) {
        relIndex = new Map();
        const n = Math.floor(seg.files.len / REC_FILE);
        for (let i = 0; i < n; i++) {
          relIndex.set(strAt(rec(seg.files, REC_FILE, i).readUInt32LE(0)), i);
        }
      }
      const id = relIndex.get(String(rel || ''));
      return id === undefined ? null : id;
    },

    /** 文件的语言 id（0 = 未知 / 未识别）——池化查询按它选池。 */
    langOf(rel) {
      const id = api.fileIdOf(rel);
      return id === null ? 0 : rec(seg.files, REC_FILE, id).readUInt32LE(28);
    },

    /** Every symbol declared by one file, in declaration order. */
    symbolsOfFile(fileId) {
      if (fileId === null || fileId < 0 || fileId >= fileCount) return [];
      const ix = symbolIndex();
      const out = [];
      for (let k = ix.first[fileId]; k < ix.first[fileId + 1]; k++) out.push(symAt(ix.slots[k]));
      return out;
    },

    /**
     * One page of the symbol list, filtered by space-separated substrings.
     *
     * `start` counts SYMBOL RECORDS, not names, so a page boundary does not shift
     * when one name happens to own more records than the rest. With no terms this
     * is the alphabetical listing of the whole table - which is what "show all
     * symbols" means at kernel scale: six million rows, delivered a page at a
     * time, because delivering them all at once is exactly what the old
     * project-wide list died of.
     *
     * `total` is null when filtering: an exact record count would need a lookup
     * per matching name, and the honest cheap answer is the number of matching
     * NAMES plus "there is more". A made-up total would be worse than no total.
     */
    symbolsPage(tokens, start, limit, globalsOnly, pool) {
      const symCount = Math.floor(seg.syms.len / REC_SYMBOL);
      const skip = Math.max(0, Number(start) || 0);
      const take = Math.max(1, Math.min(Number(limit) || 200, 2000));
      const terms = termsOf(tokens);
      const rows = [];

      const mask = poolMask(pool);
      const langs = mask ? langTable() : null;
      const inPool = (fileId) => !mask || !!mask[langs[fileId]];
      const fileOfSym = (i) => rec(seg.syms, REC_SYMBOL, i).readUInt32LE(8);

      if (!terms.length) {
        if (!mask) {
          if (globalsOnly) {
            const ord = globalsIndex();
            for (let i = skip; i < Math.min(skip + take, ord.length); i++) rows.push(symAt(ord[i]));
            return { rows, total: ord.length, names: null, more: skip + rows.length < ord.length };
          }
          for (let i = skip; i < Math.min(skip + take, symCount); i++) rows.push(symAt(i));
          return { rows, total: symCount, names: null, more: skip + rows.length < symCount };
        }

        /* 池过滤：`skip` 数的是**过滤后**的行，所以只能边扫边数。
           total 每页重数在内核规模上是 600 万次记录读——第一页数完就按池缓存。 */
        const ord = globalsOnly ? globalsIndex() : null;
        const n = ord ? ord.length : symCount;
        const key = (globalsOnly ? 'g|' : 'a|') + (Array.isArray(pool) ? pool.join(',') : String(pool));
        let total = poolTotalCache.has(key) ? poolTotalCache.get(key) : -1;
        let counted = 0;
        let seen = 0;
        for (let i = 0; i < n; i++) {
          if (total >= 0 && rows.length >= take) break;
          const si = ord ? ord[i] : i;
          if (!inPool(fileOfSym(si))) continue;
          if (total < 0) counted++;
          if (total >= 0 && seen < skip) { seen++; continue; }
          if (rows.length >= take) continue;
          rows.push(symAt(si));
          if (total >= 0) seen++;
        }
        if (total < 0) { total = counted; poolTotalCache.set(key, total); }
        return { rows, total, names: null, more: skip + rows.length < total };
      }

      const bits = matchBits(terms);
      if (globalsOnly) globalsIndex();
      const filter = globalsOnly ? globalName : null;

      /* 命中的名字:统计总数,并把前 CAND_CAP 个连名字一起收下来打分排序
         (见上面的匹配度规则)。 */
      const cand = [];
      let names = 0;
      for (let id = 0; id < strCount; id++) {
        if (!bits[id] || (filter && !filter[id])) continue;
        names++;
        if (cand.length < CAND_CAP) {
          const name = strAt(id);
          cand.push({ score: scoreName(name, terms), id, name });
        }
      }
      cand.sort((a, b) => (b.score - a.score)
        || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

      let seen = 0;
      /* 不能因为"候选被截到 CAND_CAP"就认为第一页已经取满：那会让 rows 恒为空
         （内核级索引输入常见子串时 names 上千、rows 却 []）。只有真的取够 take 条
         才算 more，见下面 `rows.length >= take`。 */
      let more = false;
      for (const c of cand) {
        if (more) break;
        const r = rangeOf(seg.syms, REC_SYMBOL, c.id);
        for (let i = r.first; i < r.first + r.count; i++) {
          const row = symAt(i);
          if (!inPool(row.fileId)) continue;
          if (globalsOnly && !isGlobalRow(row)) continue;
          if (seen < skip) { seen++; continue; }
          if (rows.length >= take) { more = true; break; }
          rows.push(row);
          seen++;
        }
      }
      return { rows, total: null, names, more };
    },

    /** One page of the project's files, filtered by the same kind of terms. */
    filesPage(tokens, start, limit) {
      const skip = Math.max(0, Number(start) || 0);
      const take = Math.max(1, Math.min(Number(limit) || 200, 2000));
      const terms = termsOf(tokens);
      const rels = relsOf();
      const rows = [];

      const push = (i) => {
        const b = rec(seg.files, REC_FILE, i);
        rows.push({
          rel: rels[i],
          fileId: i,
          size: b.readUInt32LE(8),
          symbols: b.readUInt32LE(16),
          refs: b.readUInt32LE(24)
        });
      };

      if (!terms.length) {
        for (let i = skip; i < Math.min(skip + take, fileCount); i++) push(i);
        return { rows, total: fileCount, more: skip + rows.length < fileCount };
      }

      /* 命中全部词的文件,按匹配度排序(文件名命中优先于目录命中,短路径在前) ——
         输入 "tcp ipv4" 时 net/ipv4/tcp_ipv4.c 要排在 net/ipv4/tcp.c 前面
         (user request 2026-10-15)。文件表只有几万条,直接全排。 */
      const cand = [];
      for (let i = 0; i < fileCount; i++) {
        const rel = rels[i];
        let ok = true;
        for (const t of terms) if (rel.indexOf(t) < 0) { ok = false; break; }
        if (!ok) continue;
        cand.push({ score: scorePath(rel, terms), rel, i });
      }
      cand.sort((a, b) => (b.score - a.score)
        || (a.rel.length - b.rel.length)
        || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
      for (let k = skip; k < Math.min(skip + take, cand.length); k++) push(cand[k].i);
      return { rows, total: cand.length, more: skip + rows.length < cand.length };
    },

    /** Every reference whose name is `name`, WITHOUT building descriptors - use
     *  this in hot paths and when the answer feeds a loop. */
    eachRef(name, fn, pool) {
      const id = idOf(name);
      if (id === 0xFFFFFFFF) return 0;
      const r = rangeOf(seg.refs, REC_REF, id);
      const mask = poolMask(pool);
      const langs = mask ? langTable() : null;
      let hits = 0;
      for (let i = r.first; i < r.first + r.count; i++) {
        const b = rec(seg.refs, REC_REF, i);
        if (mask && !mask[langs[b.readUInt32LE(4)]]) continue;
        hits++;
        const flags = b.readUInt32LE(16);
        fn({
          fileId: b.readUInt32LE(4),
          line: b.readUInt32LE(8),
          column: b.readUInt32LE(12),
          kind: REF_KIND_NAME[flags & 0xFF] || 'read',
          conf: (flags & 0x200) ? 'unresolved' : ((flags & 0x100) ? 'name-only' : 'exact'),
          fn: strAt(b.readUInt32LE(24)),
          config: strAt(b.readUInt32LE(28)),
          to: strAt(b.readUInt32LE(20))
        });
      }
      return hits;
    }
  };
  return api;
}

/* Kept as an alias: a Buffer is still the natural thing to hand `dump` and the
   tests, and it reads identically. */
const decode = (buf) => open(buf);

/* ------------------------------------------------------------------ dump

   A binary format that cannot be looked at is a format that cannot be debugged.
   This is deliberately NOT a user feature - the user never sees the index - but
   it is what makes the index auditable, and it is the shape the AI layer is fed
   (SPEC F1.12 "边界显形": what could not be resolved is listed, not hidden). */

function dump(source, opts) {
  const o = opts || {};
  const ix = open(source);
  const lines = [];
  const head = o.limit || 60;

  lines.push('CRIX v' + FORMAT + '  ' + ix.bytes + ' bytes');
  lines.push('strings=' + ix.counts.strings + ' files=' + ix.counts.files
    + ' symbols=' + ix.counts.symbols + ' refs=' + ix.counts.refs);

  if (o.name) {
    lines.push('');
    lines.push('symbols(' + o.name + '):');
    for (const s of ix.symbols(o.name)) {
      lines.push('  ' + s.kind + ' ' + s.name + ' @' + ix.file(s.fileId).rel + ':' + s.line
        + (s.type ? '  type=' + s.type : '')
        + (s.parent ? '  in=' + s.parent : '')
        + (s.config ? '  [' + s.config + ']' : ''));
    }
    lines.push('references(' + o.name + '):');
    for (const r of ix.references(o.name)) {
      lines.push('  ' + r.kind.padEnd(8) + r.conf.padEnd(11)
        + ix.file(r.fileId).rel + ':' + r.line + ':' + r.column
        + (r.fn ? '  in ' + r.fn : '')
        + (r.config ? '  [' + r.config + ']' : '')
        + (r.to ? '  -> ' + r.to : ''));
    }
    ix.close();
    return lines.join('\n');
  }

  lines.push('');
  lines.push('files:');
  for (let i = 0; i < Math.min(ix.counts.files, head); i++) {
    const f = ix.file(i);
    lines.push('  ' + f.rel + '  sym=' + f.symbols.count + ' ref=' + f.refs.count);
  }
  ix.close();
  return lines.join('\n');
}

module.exports = {
  createBuilder, encode, open, decode, dump,
  MAGIC, FORMAT,
  HDR, REC_SYMBOL, REC_REF, REC_FILE, REC_STRIDX,
  SYM_COLS, REF_COLS, CHUNK_RECS,
  COLS_SYM, COLS_REF, COLS_FILE,
  KINDS, REF_KIND_NAME
};
