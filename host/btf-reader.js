'use strict';
/*
 * btf-reader - L3: what the kernel ACTUALLY looks like once built (SPEC F1.15).
 *
 * WHERE THE DATA COMES FROM. A kernel built with CONFIG_DEBUG_INFO_BTF carries a
 * `.BTF` section inside `vmlinux`. BTF is the kernel's own type format - it
 * exists so eBPF programs can be type-checked against the running kernel, which
 * is why it is already there and needs no extra build step. Nothing has to be
 * compiled for this layer; the artefact the user has anyway is read directly.
 *
 * WHY IT BEATS EVERYTHING ELSE FOR THESE TWO QUESTIONS.
 *
 *   E5  member offsets. `task_struct.pid` is at byte 1234. Source code cannot
 *       say where a member lands: that depends on the configuration, the
 *       compiler, and every preceding field. BTF is the layout the compiler
 *       committed to. cscope and SI cannot answer this at all.
 *
 *   E6  is this symbol really in the kernel? A definition inside `#ifdef` may or
 *       may not have been compiled. A symbol present in BTF WAS compiled, and one
 *       absent from a fully-built vmlinux was not. That turns L2's evaluation,
 *       which is per-file and therefore approximate, into a fact.
 *
 * SIZE DISCIPLINE. `vmlinux` is hundreds of megabytes, so it is never read
 * whole: the ELF header and section table are read, then only the `.BTF` section
 * is pulled in. A detached `.btf` file is accepted as well (that is what
 * `pahole --btf_encode_detached` produces).
 */

const fs = require('fs');
const path = require('path');

/* btf_header is 24 bytes; btf_type is 12 bytes. */
const BTF_MAGIC = 0xeb9f;

const BTF_KIND = {
  1: 'INT', 2: 'PTR', 3: 'ARRAY', 4: 'STRUCT', 5: 'UNION', 6: 'ENUM',
  7: 'FWD', 8: 'TYPEDEF', 9: 'VOLATILE', 10: 'CONST', 11: 'RESTRICT',
  12: 'FUNC', 13: 'FUNC_PROTO', 14: 'VAR', 15: 'DATASEC', 16: 'FLOAT',
  17: 'DECL_TAG', 18: 'TYPE_TAG', 19: 'ENUM64'
};

/* ---------------------------------------------------------------- ELF

   Just enough to locate one named section. Only 64-bit little-endian is
   handled: that is what a Linux kernel image is, and guessing at 32-bit
   big-endian layouts would add paths that can never be exercised here. */

const SHT_NOBITS = 8;

function findSection(fd, size, want) {
  const head = Buffer.allocUnsafe(64);
  if (fs.readSync(fd, head, 0, 64, 0) < 64) return null;
  if (head.readUInt32LE(0) !== 0x464c457f) return null;      // \x7fELF
  if (head[4] !== 2) return null;                             // 64-bit only

  const shoff = Number(head.readBigUInt64LE(0x28));
  const shentsize = head.readUInt16LE(0x3a);
  const shnum = head.readUInt16LE(0x3c);
  const shstrndx = head.readUInt16LE(0x3e);
  if (!shoff || !shentsize || !shnum || shoff >= size) return null;

  const table = Buffer.allocUnsafe(shentsize * shnum);
  fs.readSync(fd, table, 0, table.length, shoff);

  const section = (i) => {
    const o = i * shentsize;
    if (o + shentsize > table.length) return null;
    return {
      nameOff: table.readUInt32LE(o),
      type: table.readUInt32LE(o + 4),
      offset: Number(table.readBigUInt64LE(o + 0x18)),
      size: Number(table.readBigUInt64LE(o + 0x20))
    };
  };

  const strSec = section(shstrndx);
  if (!strSec || strSec.offset + strSec.size > size) return null;
  const names = Buffer.allocUnsafe(strSec.size);
  fs.readSync(fd, names, 0, strSec.size, strSec.offset);

  const nameAt = (off) => {
    if (off >= names.length) return '';
    let end = off;
    while (end < names.length && names[end] !== 0) end++;
    return names.toString('utf8', off, end);
  };

  for (let i = 0; i < shnum; i++) {
    const s = section(i);
    if (!s || s.type === SHT_NOBITS) continue;
    if (nameAt(s.nameOff) !== want) continue;
    if (s.offset + s.size > size) return null;
    const out = Buffer.allocUnsafe(s.size);
    fs.readSync(fd, out, 0, s.size, s.offset);
    return out;
  }
  return null;
}

/* ----------------------------------------------------------------- BTF */

function strAt(strings, off) {
  if (!off || off >= strings.length) return '';
  let end = off;
  while (end < strings.length && strings[end] !== 0) end++;
  return strings.toString('utf8', off, end);
}

/**
 * Walk the type section.
 *
 * Types reference each other by ID (1-based, in order), and a name is only
 * useful once the type it points at is known, so this returns a resolvable
 * table rather than a tree: records are kept flat and dereferenced on demand.
 */
function parseBtf(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf.readUInt16LE(0) !== BTF_MAGIC) return null;

  /* Both offsets are measured from the END OF THE HEADER, not from the start of
     the section - a detail a synthetic round-trip test will not catch if the
     header happens to be zero-length, and real vmlinux files all have a 24-byte
     header, so getting this wrong reads garbage rather than failing loudly. */
  const hdrLen = buf.readUInt32LE(4);
  const typeOff = hdrLen + buf.readUInt32LE(8);
  const typeLen = buf.readUInt32LE(12);
  const strOff = hdrLen + buf.readUInt32LE(16);
  const strLen = buf.readUInt32LE(20);

  const strings = buf.subarray(strOff, strOff + strLen);
  const end = typeOff + typeLen;
  const rec = new Map();          // id -> {kind, name, size, ...}  (lazy fields)

  let p = typeOff;
  let id = 1;
  while (p + 12 <= end) {
    const nameOff = buf.readUInt32LE(p);
    const info = buf.readUInt32LE(p + 4);
    const sizeOrType = buf.readUInt32LE(p + 8);
    const vlen = info & 0xffff;
    const kind = BTF_KIND[(info >>> 24) & 0x1f] || 'UNKNOWN';
    const kflag = (info >>> 31) & 1;
    const body = p + 12;

    const r = {
      id, kind, kflag, name: '', size: 0, vlen, members: null, refType: 0
    };

    switch (kind) {
      case 'INT':
        r.name = strAt(strings, nameOff);
        r.size = sizeOrType;
        p = body + 4;
        break;

      case 'PTR':
      case 'CONST':
      case 'VOLATILE':
      case 'RESTRICT':
      case 'TYPEDEF':
      case 'TYPE_TAG':
        r.name = strAt(strings, nameOff);
        r.refType = sizeOrType;
        p = body;
        break;

      case 'ARRAY':
        p = body + 12;
        break;

      case 'STRUCT':
      case 'UNION': {
        r.name = strAt(strings, nameOff);
        r.size = sizeOrType;
        r.members = [];
        for (let i = 0; i < vlen; i++) {
          const o = body + i * 12;
          if (o + 12 > end) break;
          const mName = strAt(strings, buf.readUInt32LE(o));
          const mType = buf.readUInt32LE(o + 4);
          const raw = buf.readUInt32LE(o + 8);
          /* Without the kind flag `offset` is a plain bit offset. With it the
             top 8 bits are the bitfield's width instead, and only the low 24
             bits are the offset. */
          r.members.push({
            name: mName,
            typeId: mType,
            bitOffset: kflag ? (raw & 0xffffff) : raw,
            bitSize: kflag ? (raw >>> 24) : 0
          });
        }
        p = body + vlen * 12;
        break;
      }

      case 'ENUM':
        r.name = strAt(strings, nameOff);
        r.size = sizeOrType;
        p = body + vlen * 8;
        break;

      case 'ENUM64':
        r.name = strAt(strings, nameOff);
        r.size = sizeOrType;
        p = body + vlen * 12;
        break;

      case 'FUNC': {
        r.name = strAt(strings, nameOff);
        r.refType = sizeOrType;
        p = body;
        break;
      }

      case 'FUNC_PROTO':
        r.refType = sizeOrType;
        p = body + vlen * 8;
        break;

      case 'VAR': {
        r.name = strAt(strings, nameOff);
        r.refType = sizeOrType & 0xffff;
        p = body + 4;
        break;
      }

      case 'DATASEC':
        r.name = strAt(strings, nameOff);
        r.size = sizeOrType;
        p = body + vlen * 12;
        break;

      case 'FLOAT':
        r.name = strAt(strings, nameOff);
        p = body;
        break;

      case 'FWD':
        r.name = strAt(strings, nameOff);
        p = body;
        break;

      case 'DECL_TAG':
        p = body + 4;
        break;

      default:
        return { rec, strings, truncatedAt: id };
    }

    rec.set(id, r);
    id++;
  }

  return { rec, strings };
}

/* --------------------------------------------------------------- facade */

/**
 * Everything L3 can answer, or null when there is nothing to read.
 *
 * The record table is kept intact rather than materialised into structs: at
 * kernel scale BTF holds tens of thousands of types, and most are never asked
 * about.
 */
function build(parsed) {
  const { rec } = parsed;
  const byName = new Map();       // name -> [id]  (structs and unions)

  const funcs = new Set();
  for (const r of rec.values()) {
    if (r.kind === 'STRUCT' || r.kind === 'UNION') {
      if (!r.name) continue;
      const a = byName.get(r.name);
      if (a) a.push(r.id); else byName.set(r.name, [r.id]);
    } else if (r.kind === 'FUNC' && r.name) {
      funcs.add(r.name);
    }
  }

  /** Follow typedef/const/volatile wrappers to the underlying record. */
  const deref = (id) => {
    let cur = id;
    for (let i = 0; i < 16 && cur; i++) {
      const r = rec.get(cur);
      if (!r) return null;
      if (r.kind === 'STRUCT' || r.kind === 'UNION' || r.kind === 'INT'
        || r.kind === 'ENUM' || r.kind === 'FLOAT') return r;
      cur = r.refType;
    }
    return null;
  };

  return {
    types: rec.size,
    functions: funcs.size,
    structs: byName.size,

    /** Was this function compiled into the kernel? */
    hasFunction: (name) => funcs.has(name),

    /** Byte offset of a member, or null. THIS is the L3 answer to E5. */
    memberOffset(structName, memberName) {
      const ids = byName.get(structName);
      if (!ids) return null;
      for (const id of ids) {
        const r = rec.get(id);
        if (!r || !r.members) continue;
        const m = r.members.find((x) => x.name === memberName);
        if (m) {
          const base = deref(r.members.find((x) => x.name === memberName).typeId);
          return {
            offset: Math.floor(m.bitOffset / 8),
            bitOffset: m.bitOffset,
            bitSize: m.bitSize,
            type: base ? base.name || base.kind : '',
            structSize: r.size
          };
        }
      }
      return null;
    },

    /** Size of a struct as the compiler laid it out. */
    sizeOf(structName) {
      const ids = byName.get(structName);
      if (!ids) return null;
      const r = rec.get(ids[0]);
      return r ? r.size : null;
    },

    /** Every member with its offset, for showing a struct's real layout. */
    membersOf(structName) {
      const ids = byName.get(structName);
      if (!ids) return null;
      const r = rec.get(ids[0]);
      if (!r || !r.members) return null;
      return r.members.map((m) => ({
        name: m.name,
        offset: Math.floor(m.bitOffset / 8),
        bitSize: m.bitSize,
        type: (() => { const d = deref(m.typeId); return d ? (d.name || d.kind) : ''; })()
      }));
    }
  };
}

const NAMES = ['vmlinux', 'build/vmlinux', 'vmlinux.btf', 'vmlinux.o'];

/* ------------------------------------------------------ remote (SSH) source

   vmlinux is hundreds of megabytes and lives on the other machine, so the same
   discipline as the local path applies: read the ELF header, then the section
   table, then ONLY the `.BTF` section. `reader` supplies stat() and
   readRange(path, offset, length); nothing is downloaded whole. */

async function findSectionRemote(reader, file, size, want) {
  const head = await reader.readRange(file, 0, 64);
  if (head.length < 64) return null;
  if (head.readUInt32LE(0) !== 0x464c457f) return null;      // \x7fELF
  if (head[4] !== 2) return null;                             // 64-bit only

  const shoff = Number(head.readBigUInt64LE(0x28));
  const shentsize = head.readUInt16LE(0x3a);
  const shnum = head.readUInt16LE(0x3c);
  const shstrndx = head.readUInt16LE(0x3e);
  if (!shoff || !shentsize || !shnum || shoff >= size) return null;

  const table = await reader.readRange(file, shoff, shentsize * shnum);
  const section = (i) => {
    const o = i * shentsize;
    if (o + shentsize > table.length) return null;
    return {
      nameOff: table.readUInt32LE(o),
      type: table.readUInt32LE(o + 4),
      offset: Number(table.readBigUInt64LE(o + 0x18)),
      size: Number(table.readBigUInt64LE(o + 0x20))
    };
  };

  const strSec = section(shstrndx);
  if (!strSec || strSec.offset + strSec.size > size) return null;
  const names = await reader.readRange(file, strSec.offset, strSec.size);

  const nameAt = (off) => {
    if (off >= names.length) return '';
    let end = off;
    while (end < names.length && names[end] !== 0) end++;
    return names.toString('utf8', off, end);
  };

  for (let i = 0; i < shnum; i++) {
    const s = section(i);
    if (!s || s.type === SHT_NOBITS) continue;
    if (nameAt(s.nameOff) !== want) continue;
    if (s.offset + s.size > size) return null;
    return reader.readRange(file, s.offset, s.size);
  }
  return null;
}

/**
 * Remote twin of load(). `root` is the ssh:// URI (only used to label the
 * source); `dir` is the POSIX directory the connection is attached to.
 */
async function loadRemote(reader, root, dir) {
  if (!reader || !dir) return null;
  for (const n of NAMES) {
    const file = dir + '/' + n;
    let st;
    try { st = await reader.stat(file); } catch { continue; }
    if (!st.isFile()) continue;

    let buf = null;
    try {
      if (/\.btf$/i.test(n)) buf = await reader.readRange(file, 0, st.size);
      else buf = await findSectionRemote(reader, file, st.size, '.BTF');
    } catch { buf = null; }
    if (!buf) continue;

    const parsed = parseBtf(buf);
    if (!parsed) continue;

    const api = build(parsed);
    api.source = n.replace(/\\/g, '/');
    api.bytes = buf.length;
    return api;
  }
  return null;
}

/**
 * Find and read whatever L3 information the project has. Returns null when
 * there is none, which the caller MUST treat as "run as L1+L2" rather than an
 * error: a kernel source tree with no build output is the normal case.
 */
function load(root) {
  if (!root) return null;

  for (const n of NAMES) {
    const file = path.join(root, n);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile()) continue;

    let buf = null;
    try {
      if (/\.btf$/i.test(file)) {
        buf = fs.readFileSync(file);
      } else {
        const fd = fs.openSync(file, 'r');
        try { buf = findSection(fd, st.size, '.BTF'); } finally { fs.closeSync(fd); }
      }
    } catch { buf = null; }

    if (!buf) continue;
    const parsed = parseBtf(buf);
    if (!parsed) continue;

    const api = build(parsed);
    api.source = path.relative(root, file).replace(/\\/g, '/');
    api.bytes = buf.length;
    return api;
  }
  return null;
}

module.exports = { load, loadRemote, parseBtf, findSection, findSectionRemote, build, BTF_KIND };
