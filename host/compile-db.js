'use strict';
/*
 * compile-db - L2: what the compiler was ACTUALLY told (SPEC F1.15).
 *
 * THE OBVIOUS IDEA, AND WHY IT IS WRONG. `compile_commands.json` exists so a
 * tool can re-run the compiler with exactly the right flags, so the obvious use
 * is to feed every kernel translation unit through clang's AST dump. That is a
 * dead end here: it is hours of CPU for a full kernel, it needs a complete
 * toolchain, and a large share of files do not compile under an arbitrary
 * configuration at all (that is the whole point of `.config`). Spending hours to
 * get an answer that is *sometimes* available beats nothing, but only just.
 *
 * WHAT IS ACTUALLY USEFUL. The file also tells us, in plain text, the `-D` set
 * and the `-I` set for every translation unit. Those two facts are enough to
 * answer the question that L1 cannot: which side of `#ifdef CONFIG_SMP` is the
 * real one. no compiler run, no toolchain, milliseconds per project.
 *
 *     L1  records the CONDITION STACK around every symbol and reference
 *     L2  supplies the -D set, so the stack can be EVALUATED
 *     =>  "this definition is live; that one is compiled out"
 *
 * That is E4 in the comparison table, and cscope/SI have no mechanism for it at
 * all: neither of them has ever seen a compiler command line.
 *
 * HONEST LIMITS. The evaluation is per translation unit, and the index is not -
 * a header is shared by hundreds of units that may disagree about a symbol's
 * visibility. So this reports what it can and says `unknown` otherwise, which is
 * the same rule the rest of the tool follows: never guess.
 */

const fs = require('fs');
const path = require('path');

/* ---------------------------------------------------------- .config

   `CONFIG_FOO=y`, `CONFIG_FOO=m`, `# CONFIG_FOO is not set`. Only the NAME is
   kept: nothing here cares whether a feature is built in or modular, only
   whether the code is compiled at all. */

function parseKconfig(text) {
  const defined = new Set();
  const values = new Map();

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    let m = /^(CONFIG_[A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) {
      defined.add(m[1]);
      values.set(m[1], m[2]);
      continue;
    }
    /* `# CONFIG_FOO is not set` - explicitly absent, which is information too:
       it means the guard is FALSE rather than merely unknown. */
    m = /^#\s*(CONFIG_[A-Za-z0-9_]+)\s+is not set\s*$/.exec(line);
    if (m) values.set(m[1], null);
  }
  return { defined, values };
}

/* ---------------------------------------------------- compile_commands.json

   Two shapes exist: `command` (one shell string, needs splitting) and
   `arguments` (already split). Both are common; support both. */

function splitCommand(cmd) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; continue; }
      if (c === quote) { quote = null; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; started = true; continue; }
    if (c === ' ' || c === '\t') {
      if (started) { out.push(cur); cur = ''; started = false; }
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

/** `-DFOO`, `-DFOO=1`, `-D FOO` -> FOO */
function defineName(arg) {
  const m = /^-D\s*([A-Za-z_]\w*)/.exec(arg);
  return m ? m[1] : null;
}

function includePath(arg, next) {
  const m = /^-I\s*(.*)$/.exec(arg);
  if (m) return m[1] || next || '';
  return null;
}

/**
 * A per-file view of the compiler command lines.
 *
 * Keys are paths relative to the project root, forward-slashed, because that is
 * what the rest of the index uses - `compile_commands.json` records absolute
 * paths (and on Windows, mixed separators), and matching those against the
 * index by string would silently find nothing.
 */
function parseCompileCommands(json, root) {
  const list = Array.isArray(json) ? json : (json && json.commands) || [];
  const byFile = new Map();
  const globalDefines = new Set();

  for (const entry of list) {
    if (!entry) continue;
    const abs = entry.file || entry.directory || '';
    if (!abs) continue;

    const args = Array.isArray(entry.arguments) ? entry.arguments : splitCommand(entry.command || '');

    const defines = new Set();
    const includes = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-D' || a === '-U' || a === '-I' || a === '-isystem' || a === '-include') {
        if (a === '-D' && args[i + 1]) defines.add(String(args[i + 1]).split('=')[0]);
        if (a === '-U' && args[i + 1]) defines.delete(String(args[i + 1]));
        if (a === '-I' && args[i + 1]) includes.push(args[i + 1]);
        i++;
        continue;
      }
      const d = defineName(a);
      if (d) { defines.add(d); continue; }
      const inc = includePath(a, args[i + 1]);
      if (inc) includes.push(inc);
    }

    for (const d of defines) globalDefines.add(d);

    let rel = abs;
    if (root) {
      const r = path.relative(root, abs);
      /* Outside the tree (system headers, a separate build dir): keep the
         absolute path rather than a pile of ../../ that will never match. */
      rel = (r && !r.startsWith('..')) ? r : abs;
    }
    byFile.set(String(rel).replace(/\\/g, '/'), { defines, includes });
  }

  return { byFile, globalDefines };
}

/* ------------------------------------------------------------ evaluation */

/**
 * Is `key` true, given the defines we know about?
 *
 * Handles the three spellings that actually occur in kernel guards: `FOO`,
 * `!FOO`, `defined(FOO)`. Anything else - a numeric comparison, a function-like
 * test, an && of two names - is reported `unknown` rather than guessed at.
 */
function truthOfKey(key, defines) {
  let k = String(key).trim();
  if (!k) return 'unknown';

  let neg = false;
  for (;;) {
    if (k.startsWith('!')) { neg = !neg; k = k.slice(1).trim(); continue; }
    const d = /^defined\s*\(?\s*([A-Za-z_]\w*)\s*\)?$/.exec(k);
    if (d) { k = d[1]; break; }
    const s = /^([A-Za-z_]\w*)$/.exec(k);
    if (s) { k = s[1]; break; }
    return 'unknown';
  }

  if (!defines || !defines.has(k)) return neg ? 'true' : 'false';
  return neg ? 'false' : 'true';
}

/**
 * Evaluate a condition stack produced by L1.
 *
 * L1 renders the stack as `[CONFIG_SMP] [!CONFIG_X86_32]`: one bracket group per
 * enclosing conditional, deepest last, and EVERY GROUP IS A CONDITION THAT HAS
 * TO HOLD for the code to be compiled. That is what makes this a plain fold.
 *
 * The `#else` case used to need branch-chain bookkeeping here, because L1
 * literally recorded the text `[#else]` - which is indistinguishable from "we
 * are inside the #if" and evaluated backwards for every else-branch in the
 * kernel. L1 now records the negation, so the ambiguity is gone at the source
 * and this stays a fold (SPEC F1.16 坑 1).
 */
function truthOfStack(stack, defines) {
  const labels = (String(stack || '').match(/\[[^\]]*\]/g) || [])
    .map((p) => p.slice(1, -1).trim());
  if (!labels.length) return 'true';

  for (const label of labels) {
    const v = truthOfKey(label, defines);
    if (v === 'unknown') return 'unknown';
    if (v === 'false') return 'false';
  }
  return 'true';
}

/* ---------------------------------------------------------------- loading */

const DB_NAMES = [
  'compile_commands.json',
  path.join('build', 'compile_commands.json'),
  path.join('..', 'compile_commands.json')
];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Everything L2 can learn about a project, or null when there is nothing to
 * learn. The caller must treat null as "run as pure L1" - the layers are
 * strictly optional, and a missing one is not an error.
 */
function load(root) {
  if (!root) return null;

  let dbFile = null;
  for (const n of DB_NAMES) {
    const p = path.join(root, n);
    if (fs.existsSync(p)) { dbFile = p; break; }
  }

  const cfgFile = path.join(root, '.config');
  const hasConfig = fs.existsSync(cfgFile);

  if (!dbFile && !hasConfig) return null;

  const db = dbFile ? parseCompileCommands(readJson(dbFile) || [], root) : { byFile: new Map(), globalDefines: new Set() };
  const kcfg = hasConfig ? parseKconfig(fs.readFileSync(cfgFile, 'utf8')) : { defined: new Set(), values: new Map() };

  /* The union: a translation unit sees the kernel config plus whatever its own
     command line adds. Either source alone is incomplete. */
  const allDefines = new Set(db.globalDefines);
  for (const d of kcfg.defined) allDefines.add(d);

  return {
    source: dbFile ? path.relative(root, dbFile) : null,
    hasConfig,
    files: db.byFile.size,
    defines: allDefines,
    config: kcfg.values,

    /** Defines in effect for one file: its own if known, else the project set. */
    definesFor(rel) {
      const e = db.byFile.get(String(rel || '').replace(/\\/g, '/'));
      return e ? e.defines : allDefines;
    },

    includesFor(rel) {
      const e = db.byFile.get(String(rel || '').replace(/\\/g, '/'));
      return e ? e.includes : [];
    },

    /** The whole point of this module. */
    truth(stack, rel) {
      return truthOfStack(stack, this.definesFor(rel));
    }
  };
}

module.exports = {
  load, parseKconfig, parseCompileCommands, truthOfStack, truthOfKey, splitCommand
};
