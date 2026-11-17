'use strict';
/*
 * KernelSight - local filesystem & index service (main process side).
 *
 * Deliberately free of Electron imports so it can be unit-tested with plain node.
 *
 * NOTE (SPEC T3/T4): the symbol extractor below is the legacy regex
 * implementation inherited from the prototype. It will be replaced by
 * tree-sitter + scope-aware name resolution. The exported query surface is
 * shaped after SPEC 9.5 (IndexQuery) so the UI does not need to change later.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const tsIndex = require('./ts-indexer');
/* 局部变量/参数的作用域解析（C，tree-sitter，跑在 worker 里）。
   命中缓存时零解析；未命中/失败一律回退到下面的文本扫描。 */
const localScope = require('./local-scope');
const store = require('./index-store');
const indexPool = require('./index-pool');
const approx = require('./symbol-approx');
const asmIndex = require('./asm-extract');
const compileDb = require('./compile-db');
const btfReader = require('./btf-reader');
const remoteFs = require('./remote-fs');
const enhance = require('./enhance');
const derive = require('./macro-derive');
/* 有限递归展开：宏表预扫 + 站点展开（默认关，CR_MACRO_EXPAND=1）。 */
const macroExpand = require('./macro-expand');
/* 内置宏知识表：推导器要跳过"内置表已经认识"的宏（包会覆盖内置，粗规则盖细规则）。 */
const KM = require('./kernel-macros');

/* 语言数据（正则引擎的词表 / 句式、kind 词汇、文件→语言）来自规则表。
   cpp / text-assets 也要注册：文件级 `lang` 由注册表统一回答。 */
require('../renderer-lib/lang/registry.js');
require('../renderer-lib/lang/c.js');
require('../renderer-lib/lang/cpp.js');
require('../renderer-lib/lang/text-assets.js');
require('../renderer-lib/lang/rust.js');
require('../renderer-lib/lang/go.js');
require('../renderer-lib/lang/python.js');
require('../renderer-lib/lang/javascript.js');
require('../renderer-lib/lang/java.js');
const LANG = globalThis.Lang || {};
const SYMS = (LANG.defaultTable() || {}).symbols || {};

const SKIP_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', '__pycache__', '.idea', '.vscode',
  'dist', 'build', '.cache', 'target', '.venv', 'venv', 'out', '.next',
  '.gradle', '.mypy_cache', '.pytest_cache', 'cmake-build-debug', 'CMakeFiles'
]);

const CODE_EXT = new Set([
  'c', 'h', 'cpp', 'hpp', 'cc', 'hh', 'cxx', 'hxx', 'inl', 'ipp', 'm', 'mm',
  'java', 'py', 'rs', 'go', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'rb', 'pl', 'lua',
  'sh', 'bash', 'zsh', 'mk', 'am', 'ac', 'cmake', 'def', 'lds', 'dts', 'dtsi',
  's', 'S', 'asm', 'md', 'txt', 'yaml', 'yml', 'json', 'toml', 'ini', 'cfg', 'conf', 'rst'
]);

const SPECIAL_NAMES = new Set([
  'Makefile', 'makefile', 'GNUmakefile', 'Kconfig', 'Kbuild', 'CMakeLists.txt', 'Dockerfile'
]);

/* 哪些文件交给 tree-sitter —— 由**语言注册表**回答（条目或其借用链有 grammar
   槽就有；文本资产与未知语言自然落在外面）。核心不再持有任何扩展名名单，
   语言数据全在 lang/*.js。
   这条闸门就是 SPEC F1.7 的理由：拿 C grammar 去解析散文会造出成堆假
   "变量"污染搜索结果，所以只喂「有 grammar 槽」的语言。 */
function isTsIndexable(rel) {
  return typeof LANG.isIndexable === 'function' ? LANG.isIndexable(rel) : false;
}

/* 一个文件的取符号方式（G.4 三档）：
 *   tree   —— 有 grammar 槽（注册语言，或沿借用链借到）→ tree-sitter
 *   approx —— 未注册语言 → 默认规则（通用词法，近似符号，低置信度）
 *   none   —— 登记过的文本资产（Kconfig / JSON / Makefile …）→ 零符号
 * 判断只做一次，并行池把它随批次交给 worker；worker 不碰语言层。 */
function extractMode(rel) {
  /* 汇编单独一档：没有语法树，但标签就是读者要找的入口点（`__switch_to`、
     `ret_from_fork`）。见 asm-extract.js（2026-10-22）。 */
  /* 链接脚本（`.lds` / `.lds.S`）不是汇编：里面的 `ENTRY(x)` 只是**引用**已有
     符号，照着造会多出一个假定义（`vmlinux.lds.S` 就出过一条）。 */
  if (/\.lds(?:\.S)?$/i.test(String(rel || ''))) return 'none';
  if (/\.(?:S|s)$/.test(String(rel || ''))) return 'asm';
  if (isTsIndexable(rel)) return 'tree';
  return LANG.isTextAsset(rel) ? 'none' : 'approx';
}

/* The kernel tree has ~51k C/H files. Two separate problems with the old
 * ceiling, both fixed here:
 *   - it counted DIRECTORIES as well as files, so the real file budget was
 *     thousands lower than the number suggests;
 *   - hitting it was SILENT, producing an index that looks complete while
 *     missing a fifth of the tree. That is the worst kind of wrong.
 * Only files count now, the limit is raised well clear, and truncation is
 * reported so nobody has to infer it from a suspiciously round file count. */
const MAX_FILES = 120000;
const MAX_DEPTH = 20;
/* 索引比打开更严：1MB 以上的文件基本都是自动生成的表（寄存器掩码、协议常量、
   测试向量），没有手写逻辑，索引它们只会塞进几十万条无意义宏符号。
   1~2MB 仍可打开阅读，只是不进索引（outline 为空、不参与符号查询）。 */
const MAX_INDEX_SIZE = 1 * 1024 * 1024;  // F2.6: files above this are not indexed
const MAX_OPEN_SIZE = 2 * 1024 * 1024;   // refuse to open anything larger

/* ------------------------------------------------------------------ state */

let projectRoot = null;
let indexCache = null;
let indexBuilding = null;
/* 每次开始构建 / 换项目都 +1。旧构建的 finally 只有在**自己仍是最新一任**时才允许
   清空全局状态 —— 否则切项目后旧 job 会把新 job 的 indexBuilding/buildCancel 一起清掉，
   导致"building:false + 取消失效 + 两个 builder 同时写同一份 .tmp"。 */
let buildGen = 0;
let fileListCache = null;

/* ------------------------------------------------------- local / remote IO

   一个项目要么在本机、要么在另一台机器上（`ssh://user@host:port/abs/path`）。
   这一层只做两件事：把「列目录 / 读文件 / 写文件」翻译成对应的实现；以及
   所有路径拼接走 POSIX 规则（远程是 Linux，Windows 的 path.join 会给出
   反斜杠，path.posix 又会吃掉 scheme 后面的双斜杠）。

   远程项目的根仍然是**用户输入的那个 URI 字符串**：渲染进程把它当不透明的
   key（`root + '/' + rel`），fileId、最近项目、索引校验都靠它保持稳定。 */

let remote = null;      // { root, io, user, host, port, dir } —— 当前远程连接

function isRemoteRoot(root) {
  return remoteFs.isRemote(root);
}

/** 当前项目的远程连接；root 不匹配时返回 null（切换项目的瞬间可能如此）。
 *  同一个项目的带 / 不带 :22 两种写法要认到同一条连接。 */
function remoteFor(root) {
  if (!remote) return null;
  if (remote.root === root) return remote;
  return remoteFs.sameRoot(remote.root, root) ? remote : null;
}

function ioFor(root) {
  const r = remoteFor(root);
  return r ? r.io : localIo;
}

function isRemoteProject() {
  return !!(projectRoot && remoteFor(projectRoot));
}

/* 本机 IO：与原来的 fsp 调用一一对应，多了统一的 `readdir` 形状
   （{name, isDirectory, isFile}），这样树遍历不必分两套。 */
const localIo = {
  readdir: async (dir) => (await fsp.readdir(dir, { withFileTypes: true })).map((e) => ({
    name: e.name,
    isDirectory: e.isDirectory(),
    isFile: e.isFile()
  })),
  stat: (p) => fsp.stat(p),
  /* readFile 返回字节、readText 返回文本：远端 SFTP 天然给 Buffer，本地若
     也统一给 Buffer，调用方就得记住每处该不该 toString。两个方法各有明确
     契约，按需要挑。 */
  readFile: (p) => fsp.readFile(p),
  readText: (p) => fsp.readFile(p, 'utf8'),
  writeFile: (p, text) => fsp.writeFile(p, text, 'utf8'),
  mkdirp: (p) => fsp.mkdir(p, { recursive: true }),
  unlink: (p) => fsp.unlink(p),
  rename: (a, b) => fsp.rename(a, b),
  exists: async (p) => { try { await fsp.stat(p); return true; } catch { return false; } }
};

function pjoin(base, sub) {
  return isRemoteRoot(base) ? remoteFs.join(base, sub) : path.join(base, sub);
}

/* 局部作用域 worker 的 IO 钩子：读盘与 stat 都走当前项目根（远程项目也能用），
   路径拼装、权限判断仍然只在这一层做。 */
localScope.configure({
  readText: (rel) => {
    if (!projectRoot) throw new Error('no project opened');
    return ioFor(projectRoot).readText(pjoin(projectRoot, rel));
  },
  stat: (rel) => {
    if (!projectRoot) throw new Error('no project opened');
    return ioFor(projectRoot).stat(pjoin(projectRoot, rel));
  },
  maxBytes: 1024 * 1024,
});

/** 相对路径（远程：POSIX，越界时返回 ''；本地：与以前完全一致）。 */
function prel(base, abs) {
  if (!base) return String(abs || '').replace(/\\/g, '/');
  if (isRemoteRoot(base)) {
    /* 调用方给的根可能是另一种写法（带 :22），而 abs 一律由服务端根拼出来 */
    const r = remoteFs.rel(remoteFs.canonical(base), String(abs || '').replace(/\\/g, '/'));
    return r === null ? '' : r;
  }
  return path.relative(base, abs).replace(/\\/g, '/');
}

function pbase(p) {
  return isRemoteRoot(p) ? remoteFs.basename(p) : path.basename(p);
}

function projectName(root) {
  if (!root) return null;
  if (isRemoteRoot(root)) {
    const u = remoteFs.parse(root);
    return remoteFs.basename(u ? u.dir : root) || root;
  }
  return path.basename(root) || root;
}

/** 本地临时缓存：远程索引下载到这里再打开（userData 里不放远程索引）。 */
function remoteIndexCache(root) {
  const h = crypto.createHash('sha1').update(String(root)).digest('hex').slice(0, 16);
  const base = path.join(os.tmpdir(), 'kernelsight-remote-' + h);
  return { db: base + '.crdb', meta: base + '.json' };
}

/* 索引构建的进度与取消（同一时刻只会有一个构建）。
   buildSink 是渲染进程的进度事件通道；buildCancel 由 index:cancel 置位，
   在扫描/解析的每个批次边界检查。写盘阶段不接受取消（见 cancelBuild）。 */
let buildSink = null;
let buildCancel = false;
/* 自动推导出新规则后"立刻再建一次"的防重入标记（只允许重入一轮）。 */
let autoRebuildGuard = false;
let buildState = null;      // { phase, done, total, active, startedAt, updatedAt }

class IndexAbortError extends Error {
  constructor() {
    super('index build canceled');
    this.name = 'IndexAbortError';
    this.code = 'INDEX_ABORTED';
  }
}

function abortError() {
  return new IndexAbortError();
}

/* Query-side state, deliberately separate from the symbol cache above. The
   binary index owns the REFERENCE GRAPH, which is far too large for the JSON
   cache and is read page by page (SPEC F1.17). */
let db = null;            // open index-store handle, or null
let l2 = null;            // compile-db: -D/-I, and condition evaluation
let l3 = null;            // BTF: member offsets, and which functions were built

function getProjectRoot() {
  return projectRoot;
}

/** 关掉当前项目的 SSH 连接（切换项目 / 退出时调用）。 */
function closeRemote() {
  if (!remote) return;
  const r = remote;
  remote = null;
  try { r.io.close(); } catch { /* already gone */ }
}

async function setProjectRoot(root, creds) {
  // 远程：ssh://user@host:port/abs/path（先连上再改状态，失败不留半截项目）
  if (isRemoteRoot(root)) {
    const u = remoteFs.parse(root);
    if (!u) throw new Error('远程地址格式应为 ssh://user@host:port/绝对路径');
    /* 同一台机器上换目录（渲染进程里就地编辑项目目录的常规操作）：复用现有
       SFTP 连接。省一次握手，更要紧的是只用密码认证的机器切目录时不必再输一遍
       密码 —— RemoteFs 把 opts（含密码）留在内存里，连接掉了 _op 会自己重连。 */
    const prev = remote;
    const reuse = prev && prev.user === u.user && prev.host === u.host
      && Number(prev.port) === Number(u.port) ? prev : null;
    const io = reuse ? reuse.io : new remoteFs.RemoteFs({
      host: u.host,
      port: u.port,
      user: u.user,
      password: creds && creds.password,
      privateKey: creds && creds.privateKey,
      passphrase: creds && creds.passphrase
    });
    let st;
    try {
      if (!reuse) await io.connect();
      st = await io.stat(u.dir);
    } catch (err) {
      if (!reuse) { try { await io.close(); } catch { /* already gone */ } }
      const msg = String((err && err.message) || err || '');
      const e = new Error('无法访问 ' + u.user + '@' + u.host + ':' + u.dir + ' —— ' + msg);
      e.code = /auth|permission|All configured authentication/i.test(msg) ? 'EAUTH' : 'EREMOTE';
      throw e;
    }
    if (!st.isDirectory()) {
      if (!reuse) { try { await io.close(); } catch { /* already gone */ } }
      const e = new Error('不是目录: ' + u.dir);
      e.code = 'ENOTDIR';
      throw e;
    }
    /* 新连接确认可用之后才关旧的：换目录失败不该把当前项目弄断（以前是先关，
       路径敲错时旧项目的连接就没了，后续读文件全炸）。 */
    if (!reuse) closeRemote();
    /* 规范化成唯一写法（默认端口、末尾斜杠）：根字符串同时是索引缓存键和
       索引文件里记的 root，两种写法会被当成两个项目。 */
    projectRoot = remoteFs.canonical(root);
    remote = { root: projectRoot, io, user: u.user, host: u.host, port: u.port, dir: u.dir };
  } else {
    const abs = path.resolve(root);
    /* Validate before mutating state: restoring a project that has been moved or
     * deleted must fail cleanly instead of leaving a broken root behind. */
    const stat = fs.statSync(abs);
    if (!stat.isDirectory()) throw new Error('不是目录: ' + abs);
    closeRemote();
    projectRoot = abs;
  }

  indexCache = null;
  /* 换项目：旧的局部作用域描述的是另一棵树，留着会答错。 */
  localScope.clear();
  /* 成员兜底的正文缓存同样是按 rel 存的，换项目必须清。 */
  memberTextCache.clear();
  /* A build for the previous root must not commit into the new project's
     cache directory (the job checks the root before saving as well). */
  buildCancel = true;
  indexBuilding = null;
  /* 让旧构建的 finally 认不出自己（见 buildGen 注释），不会回头清掉新状态。 */
  buildGen += 1;
  fileListCache = null;
  /* The previous project's page cache and compile database describe a different
     tree; keeping them would answer the new project's queries with the old
     project's files. */
  closeAuxiliary();
  return { root: projectRoot, name: projectName(projectRoot) };
}

function projectInfo() {
  if (!projectRoot) return { root: null, name: null };
  return { root: projectRoot, name: projectName(projectRoot) };
}

/* ------------------------------------------------------------- file tree */

function isCodeFile(name) {
  /* Kernel build artefacts sit next to the sources and would otherwise fill
   * the index with generated symbols. */
  if (/\.mod\.c$/i.test(name)) return false;
  if (SPECIAL_NAMES.has(name)) return true;
  const ext = path.extname(name).slice(1).toLowerCase();
  return CODE_EXT.has(ext);
}

async function buildTree(root, onScan, shouldAbort) {
  let files = 0;
  let truncated = false;
  const io = ioFor(root);
  /* 远程：每层子目录并发展开（SFTP 是往返延迟主导，串行 5900 次约 6s，
     12 并发后不到 1s；并发上限由 remote-fs 内部限流器掌握）。
     本地保持原来的串行递归——顺序影响 MAX_FILES 截断时的具体集合。 */
  const parallel = isRemoteRoot(root);

  async function walk(dir, depth) {
    if (shouldAbort && shouldAbort()) throw abortError();
    if (depth > MAX_DEPTH) { truncated = true; return null; }
    let entries;
    try {
      entries = await io.readdir(dir);
    } catch {
      return null;
    }
    /* 按名字排序（**顺序即 fileId**）：NTFS 的 `readdir` 返回顺序不保证稳定，
       不排序的话同一棵树连建两次，符号/引用的行序不同 —— `.crdb` 长度一样、
       字节不一样，回归基线就没法逐字节对拍（2026-10-23 实测：fixtures 三次
       一致，283 文件的 intel 目录三次三个 sha1）。排序后本地/远程同一口径。 */
    entries = entries.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    /* 扫描阶段的实时位置：每进入一个目录报一次（由调用方节流）。 */
    if (onScan) onScan(dir, files);

    const children = [];
    const pending = [];
    for (const e of entries) {
      if (files >= MAX_FILES) { truncated = true; break; }
      const full = pjoin(dir, e.name);
      if (e.isDirectory) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        if (parallel) { pending.push(full); continue; }
        const sub = await walk(full, depth + 1);
        /* A directory does NOT spend the file budget. Counting both made the
           effective file ceiling thousands lower than the constant said. */
        if (sub && sub.children.length) children.push(sub);
      } else if (e.isFile) {
        if (!isCodeFile(e.name)) continue;
        files++;
        children.push({ name: e.name, path: full, type: 'file' });
      }
    }

    if (parallel) {
      const subs = await Promise.all(pending.map((d) => walk(d, depth + 1).catch(() => null)));
      for (const sub of subs) if (sub && sub.children.length) children.push(sub);
    }

    children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return { name: pbase(dir) || dir, path: dir, type: 'dir', children };
  }

  const tree = await walk(root, 0);
  return { tree, count: files, truncated };
}

/* --------------------------------------------------------------- symbols */

/* 正则符号引擎（无 tree-sitter 时的兜底）：词表与句式来自语言表。 */
const RX = SYMS.regexEngine || {};
const KIND = SYMS.kinds || {};
const buildRe = (pat) => (pat ? new RegExp(pat) : /(?!)/);
const KEYWORDS = new Set(RX.keywords || []);
const RE_MACRO = buildRe(RX.macro);
const RE_STRUCT = buildRe(RX.struct);
const RE_TYPEDEF = buildRe(RX.typedef);
const RE_FUNC = buildRe(RX.func);
/* file-scope variable: an unindented line that ends in ';' (locals are indented).
 * The character class includes ',' so "static int a, b;" declares b (the last
 * declarator) rather than matching nothing. */
const RE_GLOBAL = buildRe(RX.global);
/* "struct foo;" / "enum bar;" is a forward declaration, not a variable */
const RE_FORWARD = buildRe(RX.forward);

/** Net '(' depth of a line. */
function parenDepth(s) {
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') d++;
    else if (s[i] === ')') d--;
  }
  return d;
}

/** Lines that start a control statement, never a declaration. */
const CONTROL_START = /^(if|for|while|switch|return|do|else|case|goto|break|continue)$/;

/**
 * Fold a function signature that spans several lines into one string, so that
 * `ip_rcv(...)` in net/ipv4/ip_input.c is found. Only folds while parentheses
 * are unbalanced and only for a few lines - folding every continuation line
 * instead would swallow the declaration below it.
 */
function foldSignature(lines, i) {
  const first = lines[i].trim();
  let depth = parenDepth(first);
  if (depth === 0) return { text: first, line: i + 1, endLine: i + 1 };

  let text = first;
  for (let j = i + 1; j < lines.length && j - i <= 8; j++) {
    const part = lines[j].trim();
    text += ' ' + part;
    depth += parenDepth(part);
    if (depth === 0) return { text, line: i + 1, endLine: j + 1 };
    if (depth < 0) return null;
  }
  return null;   // still unbalanced: not a declaration
}

function extractSymbols(text, relPath) {
  const lines = text.split(/\r?\n/);
  const out = [];
  const seen = new Set();

  const push = (name, kind, line) => {
    const key = kind + ':' + name + ':' + line;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, kind, file: relPath, line });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 400) continue;

    let m = RE_MACRO.exec(line);
    if (m) { push(m[1], KIND.macro, i + 1); continue; }

    m = RE_STRUCT.exec(line);
    if (m) { push(m[2], m[1], i + 1); continue; }

    m = RE_TYPEDEF.exec(line);
    if (m) { push(m[1], KIND.typedef, i + 1); continue; }

    /* function definition, possibly with a folded multi-line signature */
    if (line.indexOf('(') >= 0) {
      const sig = foldSignature(lines, i);
      if (sig) {
        m = RE_FUNC.exec(sig.text);
        if (m) {
          const name = m[2];
          const prefix = m[1].trim();
          if (!KEYWORDS.has(name)
              && !CONTROL_START.test(prefix)
              && !sig.text.includes('=')
              && !sig.text.includes(';')
              && /^[A-Za-z_]/.test(prefix)
              && /[A-Za-z_]\w*[ \t\*]+[A-Za-z_]/.test(m[1] + ' ' + m[2])) {
            const nextText = (lines[sig.endLine] || '').trim();
            const hasBrace = sig.text.trimEnd().endsWith('{') || nextText.startsWith('{');
            if (hasBrace) { push(name, 'function', sig.line); continue; }
          }
        }
      }
    }

    if (RE_FORWARD.test(line)) continue;

    m = RE_GLOBAL.exec(line);
    if (m) {
      if (!KEYWORDS.has(m[1])) push(m[1], 'variable', i + 1);
      continue;
    }
  }

  return out;
}

/* ------------------------------------------------------------- index store

   The index is a user-triggered artefact (F1.2), so it is persisted: building
   it once should be enough (F1.11 / SPEC 9.7). It lives in the user data
   directory, never inside the project - the project is usually somebody else's
   read-only source tree.
*/

/* v2: symbols carry type / parent / params / config / source / binds, and each
 * file carries its includes and conditional labels (SPEC 9.8.3). Bumping the
 * number retires v1 caches instead of mis-reading them.
 * v3: the indexer no longer records macro blocks as functions
 * (for_each_possible_cpu(cpu) { ... } used to index a "function cpu"); old
 * v2 indexes still contain those ghosts, so they must be rebuilt. */
const INDEX_FORMAT = 3;

let cacheDir = path.join(os.homedir(), '.code-reader', 'index');

function setCacheDir(dir) {
  if (dir) cacheDir = dir;
}

/* 远程项目的索引存放在**项目自己的** <root>/.kernelscope/ 里：那台机器上的
   源码是人家的，不能往 userData 里塞（本地索引只在打开时临时下载一份）。
   文件名固定，因为一个项目目录只有一个索引。 */
const REMOTE_INDEX_DIR = '.kernelscope';
const REMOTE_INDEX_JSON = 'index.json';
const REMOTE_INDEX_DB = 'index.crdb';

function indexFileFor(root) {
  if (isRemoteRoot(root)) return remoteFs.join(root, REMOTE_INDEX_DIR + '/' + REMOTE_INDEX_JSON);
  const hash = crypto.createHash('sha1').update(root).digest('hex').slice(0, 16);
  return path.join(cacheDir, hash + '.idx.json');
}

/**
 * Where a `CONFIG_*` is declared: the `config FOO` / `menuconfig FOO` line in the
 * `Kconfig` file that owns it.
 *
 * WHY IT IS SERVER-SIDE AND WHY IT ONLY READS Kconfig FILES. The first version
 * grepped the code for `config IPV6` (12 hits, whole tree) and looked for a
 * Kconfig among the hits. Two things were wrong with that, and both showed up on
 * the very first option a user tried:
 *
 *   1. `menuconfig IPV6` is how `net/ipv6/Kconfig` declares it - the regex only
 *      accepted `config`, so the declaration was "not found" in a tree that has
 *      it (user report 2026-10-14);
 *   2. the hit limit meant the walk had to read most of the tree looking for 12
 *      matches, and the real declaration was not among them: 41 seconds, cold.
 *
 * Kconfig files are 1,584 files / 5.7 MB in a 5.10 kernel - reading all of them is
 * milliseconds, and reading ONLY them cannot miss the declaration behind a hit
 * limit. The current file's directory goes first (an option is usually declared
 * beside the code it gates), but the whole list is always searched: `net/ipv6/
 * Kconfig` declares the switch that `net/ipv4/*.c` tests.
 */
async function kconfigDeclOf(name, nearRel) {
  /* 调用方可能给 `CONFIG_SMP`（用户在代码里看到的写法），而 Kconfig 里声明的
     是 `config SMP`。两种都接受：前缀不影响查找，只是同一个符号的两种拼写。 */
  const want = String(name || '').trim().replace(/^CONFIG_/, '');
  if (!want || !projectRoot) return null;

  const esc2 = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const decl = new RegExp('^\\s*(?:menuconfig|config)\\s+' + esc2 + '\\s*$');
  const isKconfig = /(^|\/)Kconfig(\.[A-Za-z0-9_.-]+)?$/;

  let files;
  try { files = (await listFiles()).filter((f) => isKconfig.test(f.rel)); } catch { return null; }
  const dir = String(nearRel || '').replace(/[^/]*$/, '');
  const ordered = dir ? files.filter((f) => f.rel.startsWith(dir))
    .concat(files.filter((f) => !f.rel.startsWith(dir))) : files;

  /* 1,584 个 Kconfig / 5.7 MB：本地顺序读是毫秒级，远程每个文件一个往返，
     批内并发才有意义（命中即返回，所以按批推进、批内取第一个命中）。 */
  const B = isRemoteRoot(projectRoot) ? 12 : 1;
  const io = ioFor(projectRoot);
  for (let i = 0; i < ordered.length; i += B) {
    const batch = ordered.slice(i, i + B);
    const hits = await Promise.all(batch.map(async (f) => {
      let text;
      try { text = await io.readText(f.path); } catch { return null; }
      const lines = text.split(/\r?\n/);
      for (let j = 0; j < lines.length; j++) {
        if (decl.test(lines[j])) return { file: f.rel, line: j + 1, text: lines[j].trim() };
      }
      return null;
    }));
    for (const hit of hits) if (hit) return hit;
  }
  return null;
}

/** The binary index: every symbol AND every reference. Two files, two jobs -
 *  the JSON one is what the UI renders, this one is what queries search. */
function binaryFileFor(root) {
  if (isRemoteRoot(root)) return remoteFs.join(root, REMOTE_INDEX_DIR + '/' + REMOTE_INDEX_DB);
  const hash = crypto.createHash('sha1').update(root).digest('hex').slice(0, 16);
  return path.join(cacheDir, hash + '.crdb');
}

/** 远程索引在本机的临时副本是否仍与远端一致（size + mtime 足以判定）。 */
async function remoteCacheFresh(root, st) {
  const c = remoteIndexCache(root);
  let meta = null;
  try { meta = JSON.parse(await fsp.readFile(c.meta, 'utf8')); } catch { /* no cache */ }
  if (!meta) return null;
  if (meta.size !== st.size || meta.mtimeMs !== Math.floor(st.mtimeMs)) return null;
  if (!fs.existsSync(c.db)) return null;
  return c.db;
}

/** 把远端 index.crdb 拉回本机临时目录并打开（只读查询用；写永远落远端）。 */
async function openRemoteDb(root) {
  const io = ioFor(root);
  const remoteDb = binaryFileFor(root);
  let st;
  try { st = await io.stat(remoteDb); } catch { return null; }
  if (!st.isFile()) return null;

  const c = remoteIndexCache(root);
  await fsp.mkdir(path.dirname(c.db), { recursive: true });
  const cached = await remoteCacheFresh(root, st);
  if (!cached) {
    const part = c.db + '.part';
    try { await fsp.unlink(part); } catch { /* none */ }
    await io.download(remoteDb, part);
    await renameWithRetry(part, c.db);
    await fsp.writeFile(c.meta, JSON.stringify({ size: st.size, mtimeMs: Math.floor(st.mtimeMs) }), 'utf8');
  }
  return store.open(c.db);
}

/* 二进制层的三种结局。'none' 和 'invalid' 必须分开：没建过索引是正常的，
   文件在但打不开是「这份缓存不能信」——调用方要停止把它当成已建好的索引。 */
const AUX_NONE = 'none', AUX_OK = 'ok', AUX_INVALID = 'invalid';

/**
 * Open the query-side artefacts: the binary reference index (L1), the compile
 * database (L2) and the build artefacts (L3).
 *
 * All three are OPTIONAL and fail soft. A project with none of them is indexed
 * and browsable, just less precise - and which layers are live is reported, so
 * the difference is never silent (SPEC F1.15).
 *
 * Returns AUX_OK / AUX_NONE / AUX_INVALID for the binary layer (see above).
 */
async function openAuxiliary(root) {
  closeAuxiliary();
  let invalid = false;

  if (isRemoteRoot(root)) {
    /* L1 从远端下载（临时副本 + size/mtime 校验）；L2 是本地编译数据库，
       远端项目没有意义，保持关闭；L3 只读 vmlinux 的 .BTF 段，走区间读。 */
    try { db = await openRemoteDb(root); } catch (err) {
      console.error('[fs-service] remote binary index unreadable: ' + ((err && err.message) || err));
      db = null;
      invalid = true;
    }
    l2 = null;
    const r = remoteFor(root);
    if (r) {
      try {
        l3 = await btfReader.loadRemote({
          stat: (p) => r.io.stat(p),
          readRange: (p, off, len) => r.io.readRange(p, off, len)
        }, root, r.dir);
      } catch { l3 = null; }
    }
    return invalid ? AUX_INVALID : (db ? AUX_OK : AUX_NONE);
  }

  try {
    const f = binaryFileFor(root);
    if (fs.existsSync(f)) db = store.open(f);
  } catch (err) {
    /* 最常见的是 `index: format N, expected M`：格式号变了，这份文件属于
       旧版本。不迁移、不猜测，直接判为不可用（SPEC 的零旧索引兼容）。 */
    console.error('[fs-service] binary index unreadable: ' + ((err && err.message) || err));
    db = null;
    invalid = true;
  }

  try { l2 = compileDb.load(root); } catch { l2 = null; }
  try { l3 = btfReader.load(root); } catch { l3 = null; }

  if (invalid) return AUX_INVALID;
  return db ? AUX_OK : AUX_NONE;
}

function closeAuxiliary() {
  if (db) { try { db.close(); } catch { /* already closed */ } }
  db = null;
  l2 = null;
  l3 = null;
}

/* 注意：**不能**在 saveIndex 里"推迟关闭"来躲 EBADF。
   Windows 上 rename 覆盖一个仍被打开的文件会 EBUSY/EPERM，推迟关闭直接让重建的
   写入阶段失败（2026-11-15 实测：phase=failed）。所以仍在这里同步关闭，
   飞行中的查询改由 index-store 的"读失败就重开一次"兜底。 */

/**
 * Disk shape: FILE METADATA ONLY.
 *
 * Symbols and references live in the binary index, which is where they can be
 * sorted, searched and read on demand. Writing them here as well cost hundreds
 * of megabytes of JSON at kernel scale and bought nothing - the JSON cache is
 * only consulted to decide what changed (SPEC F1.17).
 */
function toDiskShape(idx) {
  return {
    format: INDEX_FORMAT,
    root: idx.root,
    engine: idx.engine || 'regex',
    builtAt: idx.builtAt,
    /* 用哪个解析器版本建的；加载时比对，不一致就提示重建（旧索引缺位域等字段）。 */
    parserRev: String(idx.parserRev || ''),
    elapsedMs: idx.elapsedMs || 0,
    truncated: !!idx.truncated,
    binaryStats: idx.binaryStats || null,
    /* L4：这份索引是用哪个增强包建的 + 解析降级清单（索引报告的唯一来源）。 */
    enhance: idx.enhance || null,
    enhanceErrors: idx.enhanceErrors || [],
    issues: idx.issues || [],
    /* 这份索引到底**扫没扫过**解析降级。不能靠 issues 是否为空来判断：
       旧索引读出来也是 []，"0 处"和"没扫过"长得一模一样（2026-10-21 实测：
       内核旧索引的解析报告写着"没有发现降级"，其实根本没记）。 */
    issuesScanned: !!idx.issuesScanned,
    symStats: idx.symStats || null,
    /* 接收者形状普查（待解析台账第四节）。旧索引没有 → null，台账如实说"重建后才有"。 */
    recvStats: idx.recvStats || null,
    ruleHits: idx.ruleHits || null,
    files: idx.files.map((f) => ({
      rel: f.rel,
      mtimeMs: f.mtimeMs || 0,
      size: f.size || 0,
      includes: f.includes || [],
      conds: f.conds || []
    }))
  };
}

function fromDiskShape(disk) {
  return {
    root: disk.root,
    engine: disk.engine || 'regex',
    builtAt: disk.builtAt,
    parserRev: String(disk.parserRev || ''),
    elapsedMs: disk.elapsedMs,
    truncated: !!disk.truncated,
    binaryStats: disk.binaryStats || null,
    enhance: disk.enhance || null,
    enhanceErrors: disk.enhanceErrors || [],
    issues: disk.issues || [],
    /* 旧索引没有这个字段 → false，报告据此说"重建后才有内容"而不是"没有降级"。 */
    issuesScanned: !!disk.issuesScanned,
    symStats: disk.symStats || null,
    recvStats: disk.recvStats || null,
    ruleHits: disk.ruleHits || null,
    files: disk.files.map((f) => ({
      path: pjoin(disk.root, f.rel),
      rel: f.rel,
      size: f.size,
      mtimeMs: f.mtimeMs,
      includes: f.includes || [],
      conds: f.conds || []
    })),
    fromCache: true
  };
}

/** Rename over an existing file; Windows occasionally reports EPERM/EBUSY for
 *  a few hundred ms after the previous handle was closed. */
async function renameWithRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      const retryable = err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES');
      if (!retryable || i >= 5) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/**
 * Save the index WITHOUT touching the old one until both new files are complete.
 *
 * 1. the binary is streamed to `*.tmp`, then the JSON to `*.tmp`;
 * 2. only then are they renamed over the real files (same directory, so this is
 *    a metadata operation, not a copy);
 * 3. cancel / disk-full / any failure before step 2 deletes the temporaries and
 *    leaves the previous index exactly as it was.
 *
 * The old binary handle is closed for the rename because Windows keeps open
 * files locked. If the save fails, it is reopened against the intact old file.
 */
/**
 * 远程项目的保存：**索引本体写到远端** `<root>/.kernelscope/index.crdb`。
 *
 * 本地只留一份临时副本（os.tmpdir），用途是给 index-store 打开查询——它是
 * 同步文件 IO，不能边下载边查。副本按 size+mtime 与远端校验，重建后无需
 * 重新下载；userData 里不放远程索引（那是别人的源码树，而本地缓存目录是
 * 按项目路径散列的，两者混在一起会让「索引在哪」变得不可解释）。
 *
 * 远端先写 `.tmp` 再改名：中途失败时旧索引仍然完整可用，和本地语义一致。
 */
async function saveRemoteIndex(idx) {
  const io = ioFor(idx.root);
  const dir = remoteFs.join(idx.root, REMOTE_INDEX_DIR);
  const finalJson = indexFileFor(idx.root);
  const finalDb = binaryFileFor(idx.root);
  const tmpJson = finalJson + '.tmp';
  const tmpDb = finalDb + '.tmp';

  const cache = remoteIndexCache(idx.root);
  await fsp.mkdir(path.dirname(cache.db), { recursive: true });
  const localTmp = cache.db + '.tmp';
  const localJson = localTmp + '.json';

  let committed = false;
  try {
    await io.mkdirp(dir);

    /* Finish the binary first so the JSON records its real size/stats. */
    if (idx.builder) {
      const stats = await idx.builder.finishFile(localTmp);
      idx.binaryStats = stats;
      idx.binaryBytes = stats.bytes;
    }
    const json = JSON.stringify(toDiskShape(idx));
    await fsp.writeFile(localJson, json, 'utf8');

    /* 取消可以落在「解析完之后、替换之前」——写盘一旦开始就不给取消,
       但项目切换等路径也会置位,这里再挡一次。 */
    if (buildCancel) throw abortError();

    closeAuxiliary();
    await io.upload(localTmp, tmpDb);
    await io.writeFile(tmpJson, json);
    await io.rename(tmpDb, finalDb);
    await io.rename(tmpJson, finalJson);

    /* 远端改名后的 stat 才是这份索引的权威身份；本地副本据此免下载。 */
    const st = await io.stat(finalDb);
    await renameWithRetry(localTmp, cache.db);
    await fsp.writeFile(cache.meta,
      JSON.stringify({ size: st.size, mtimeMs: Math.floor(st.mtimeMs) }), 'utf8');
    committed = true;
    idx.saved = true;
  } finally {
    idx.builder = null;
    try { await fsp.unlink(localTmp); } catch { /* already gone */ }
    try { await fsp.unlink(localJson); } catch { /* already gone */ }
    if (!committed) {
      try { await io.unlink(tmpDb); } catch { /* already gone */ }
      try { await io.unlink(tmpJson); } catch { /* already gone */ }
      if (projectRoot === idx.root) await openAuxiliary(idx.root);
    }
  }
}

async function saveIndex(idx) {
  if (isRemoteRoot(idx.root) && remoteFor(idx.root)) return saveRemoteIndex(idx);

  await fsp.mkdir(cacheDir, { recursive: true });
  const finalJson = indexFileFor(idx.root);
  const finalDb = binaryFileFor(idx.root);
  const tmpJson = finalJson + '.tmp';
  const tmpDb = finalDb + '.tmp';

  try { await fsp.unlink(tmpJson); } catch { /* not there */ }
  try { await fsp.unlink(tmpDb); } catch { /* not there */ }

  let committed = false;
  try {
    /* Finish the binary first so the JSON records its real size/stats. */
    if (idx.builder) {
      const stats = await idx.builder.finishFile(tmpDb);
      idx.binaryStats = stats;
      idx.binaryBytes = stats.bytes;
    }
    await fsp.writeFile(tmpJson, JSON.stringify(toDiskShape(idx)), 'utf8');

    /* 取消可以落在「解析完之后、替换之前」——写盘一旦开始就不给取消,
       但项目切换等路径也会置位,这里再挡一次。 */
    if (buildCancel) throw abortError();

    closeAuxiliary();
    await renameWithRetry(tmpDb, finalDb);
    await renameWithRetry(tmpJson, finalJson);
    committed = true;
    idx.saved = true;
  } finally {
    /* The columns are the largest allocation in the process - gigabytes at
       kernel scale. Once the file is on disk they are dead weight. */
    idx.builder = null;
    if (!committed) {
      try { await fsp.unlink(tmpDb); } catch { /* already gone */ }
      try { await fsp.unlink(tmpJson); } catch { /* already gone */ }
      /* We closed the old handle for the commit attempt; keep queries working
         against the old index. */
      if (projectRoot === idx.root) await openAuxiliary(idx.root);
    }
  }
}

async function readDiskIndex(root) {
  const io = ioFor(root);
  /* Leftovers from an interrupted save are never part of the live index. */
  try { await io.unlink(indexFileFor(root) + '.tmp'); } catch { /* none */ }
  try { await io.unlink(binaryFileFor(root) + '.tmp'); } catch { /* none */ }
  try {
    const disk = JSON.parse(await io.readText(indexFileFor(root)));
    if (!disk || disk.format !== INDEX_FORMAT) return null;
    /* 同一个远程项目可能被写成带 / 不带 :22 两种 URI（旧索引就是这样），
       按机器/目录比较，别让写法差异当成"没有索引"。本地仍是严格相等。 */
    if (!remoteFs.sameRoot(disk.root, root)) return null;
    if (!Array.isArray(disk.files)) return null;
    /* 落盘时的写法可能和当前根不同：路径一律按当前根重建。 */
    return fromDiskShape({ ...disk, root });
  } catch {
    return null;   // missing / corrupt / unreadable: treat as "no cache"
  }
}

/** Previous symbols keyed by file, for incremental rebuilds. */
function indexByRel(idx) {
  if (!idx) return null;
  const map = new Map();
  for (const f of idx.files) {
    map.set(f.rel, {
      size: f.size, mtimeMs: f.mtimeMs,
      symbols: [], includes: f.includes || [], conds: f.conds || []
    });
  }
  /* `symbols` is deliberately absent from the JSON cache - writing them there
     cost hundreds of megabytes at kernel scale and bought nothing, because the
     BINARY index is what gets queried (SPEC F1.17). So an index that came from
     disk has none, and iterating it unguarded threw `idx.symbols is not
     iterable` on the second build of a session: the one path where this is
     handed an index that was loaded rather than just built. */
  for (const s of (idx.symbols || [])) {
    const entry = map.get(s.file);
    if (entry) entry.symbols.push(s);
  }
  return map;
}

/** Files changed / added / deleted since the index was built. */
async function changedSince(idx) {
  const changed = [];
  const known = new Set();

  /* 远程项目不做这个检查：6 万个文件就是 6 万次 SFTP stat，每次都是一个
     往返，光「打开项目」就要几分钟。远端索引的新旧由用户显式重建决定。 */
  if (isRemoteRoot(idx.root)) return changed;

  /* 6.7 万次 stat 以前是**串行 await**（每次一个 syscall 往返）。Windows 上单个
     0.1–0.3ms，光这一步就要 10–20s —— 打开项目和"刚建完索引"都要等它。
     改成固定并发（64）：结果按文件序回收，`changed` 的顺序仍然确定。 */
  const files = idx.files;
  const flags = new Array(files.length).fill(null);
  let cursor = 0;
  const CONCURRENCY = 64;
  const worker = async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= files.length) return;
      const f = files[i];
      known.add(f.rel);
      try {
        const st = await fsp.stat(f.path);
        if (st.size !== f.size || Math.abs(st.mtimeMs - f.mtimeMs) > 1) flags[i] = f.rel;
      } catch {
        flags[i] = f.rel;                              // deleted
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
  for (const rel of flags) if (rel !== null) changed.push(rel);

  /* **不再用"磁盘上多出来的文件"判定过期**（2026-10-23）。
     两次扫描的过滤口径不完全一致（`listFiles()` 比建索引时的遍历多认出
     `.clang-format`、`arch/<arch>/Kconfig.debug` 这类边缘文件），于是每次都报
     "有 8 个文件变了"，而实际上 67,834 个已索引文件**一个都没变** —— 用户看到
     `stale` 会以为索引过期，这是误报。
     况且新增文件并不会让已有行失效（打开时文件树本来就是实时读盘的），
     真正需要重建的只有：已索引文件被改了 / 被删了。 */
  return changed;
}

/**
 * Load the persisted index for the current project. No rebuild happens here:
 * loading is "remembering what the user already asked for", not starting over.
 */
async function loadIndexFromDisk() {
  if (!projectRoot) throw new Error('no project opened');
  if (currentIndex()) return { ...indexState(), symbols: indexCache.symbols };

  const t0 = Date.now();
  const idx = await readDiskIndex(projectRoot);
  if (!idx) return indexState();

  /* 二进制索引是这份缓存的另一半：文件在、但版本号与当前代码不符（或已
     损坏）时，整份索引都不可用。按「没有索引」处理，界面回到「建立索引」，
     而不是一个看着建好了、点「谁调用我」却查不到东西的半成品。旧文件不删，
     下一次构建会把两份一起重写。 */
  const aux = await openAuxiliary(projectRoot);
  if (aux === AUX_INVALID) {
    console.error('[fs-service] index is outdated or damaged — treated as "not indexed"');
    return indexState();
  }

  indexCache = idx;
  const changed = await changedSince(idx);
  idx.changedFiles = changed;
  /* 解析器升级后旧索引缺新提取的字段（位域、多声明符…）：标记过期并让界面看得见，
     仍然允许查询（成员兜底会补），但不再"静默按旧索引回答"。 */
  const parserRev = String(tsIndex.PARSER_REV || '');
  idx.parserStale = parserRev !== '' && String(idx.parserRev || '') !== parserRev;
  idx.stale = changed.length > 0 || idx.parserStale;
  if (idx.parserStale) {
    console.info(`[fs-service] index built by parser ${idx.parserRev || '(unknown)'}, current ${parserRev} — marked stale`);
  }
  /* 引用图已经由上面的 openAuxiliary 打开（远程项目也在这里下载）。
     SPEC F1.17：没有它就没有 findReferences。 */
  idx.loadMs = Date.now() - t0;      // read + freshness check
  return indexState();
}

/* ------------------------------------------------------- build progress */

/* 进度事件节流:解析期每批 48 个文件、11 个 worker,不节流会每秒几十条 IPC。
   200ms 一条足够「实时」,阶段切换与最终状态强制发送。 */
const PROGRESS_INTERVAL_MS = 200;
let lastProgressAt = 0;
let lastEmittedPhase = '';

function emitProgress(force) {
  if (!buildSink || !buildState) return;
  const now = Date.now();
  if (!force && now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
  lastProgressAt = now;
  buildState.updatedAt = now;
  buildState.elapsedMs = now - buildState.startedAt;
  /* 阶段的起始时间用于估算剩余时间(渲染进程按阶段内的速率外推)。 */
  if (buildState.phase !== lastEmittedPhase) {
    lastEmittedPhase = buildState.phase;
    buildState.phaseStartedAt = now;
  }
  buildState.phaseElapsedMs = now - (buildState.phaseStartedAt || buildState.startedAt);
  let payload;
  try {
    payload = JSON.parse(JSON.stringify(buildState));
  } catch {
    return;
  }
  try { buildSink(payload); } catch { /* the window may be closing */ }
}

function beginBuildProgress(root) {
  buildState = {
    root,
    phase: 'scan',
    done: 0,
    total: 0,
    active: [],
    scanDir: '',
    found: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    elapsedMs: 0,
    phaseStartedAt: Date.now(),
    phaseElapsedMs: 0
  };
  lastProgressAt = 0;
  lastEmittedPhase = '';
  emitProgress(true);
}

function relDirOf(abs, root) {
  const rel = prel(root, abs);
  const i = rel.lastIndexOf('/');
  return i < 0 ? '.' : (rel.slice(0, i) || '.');
}

function reportScan(root, dir, found) {
  if (!buildState) return;
  let rel = prel(root, dir);
  if (!rel) rel = '.';
  buildState.phase = 'scan';
  buildState.scanDir = rel;
  buildState.found = found;
  emitProgress(false);
}

function reportParsed(done, total, active) {
  if (!buildState) return;
  const first = buildState.phase !== 'parse';
  buildState.phase = 'parse';
  buildState.total = total;
  buildState.done = done;
  if (active) buildState.active = active;
  emitProgress(first);
}

function reportActive(active) {
  if (!buildState) return;
  buildState.active = active;
  emitProgress(false);
}

/* 宏表预扫描（`#define` 收集）在建索引前跑一遍，要把 6 万多个文件读一遍。
   以前这段时间界面上停在 "解析符号 0/N"，看着像卡死 —— 现在单独报一个阶段。 */
function reportMacros(done, total) {
  if (!buildState) return;
  const first = buildState.phase !== 'macros';
  buildState.phase = 'macros';
  buildState.total = total;
  buildState.done = done;
  buildState.active = [];
  buildState.scanDir = '';
  emitProgress(first);
}

function reportWriting() {
  if (!buildState) return;
  buildState.phase = 'write';
  buildState.active = [];
  buildState.scanDir = '';
  buildState.done = buildState.total;
  emitProgress(true);
}

function reportPhase(phase) {
  if (!buildState) return;
  buildState.phase = phase;
  buildState.active = [];
  buildState.scanDir = '';
  emitProgress(true);
}

/**
 * 远程批量预读：一批 48 个文件并发走 SFTP（真实并发由 remote-fs 限流）。
 * `size` 直接由收到的字节数给出 —— 文件内容反正要读，省掉一次 stat 往返；
 * mtime 置 0，远程项目不做「文件是否改过」的检查（changedSince 已跳过）。
 */
/**
 * 本地预读：主进程用异步 IO + 32 并发把这一批文本读进来，随批送进 worker。
 * worker 里原本是同步 `readFile`（48 个文件串行阻塞），换成这里之后读写可以
 * 和解析重叠 —— 实测 400 个内核头文件 914ms → 789ms。
 *
 * 两个字段必须带：`size`（与 worker 自己 stat 的值一致）和 `mtimeMs`
 * （索引里存的就是它，漏了会让 changedSince 把所有文件判成"变过"）。
 */
async function prefetchLocal(files, maxSize) {
  const CONCURRENCY = 32;
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= files.length) return;
      const f = files[i];
      try {
        const st = await fsp.stat(f.abs);
        f.size = st.size;
        f.mtimeMs = st.mtimeMs;
        if (st.size > maxSize) { f.skip = true; continue; }
        f.text = await fsp.readFile(f.abs, 'utf8');
      } catch {
        f.skip = true;                       // 读不了就跳过（与顺序路径一致）
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
}

async function prefetchRemote(root, files, maxSize) {
  const r = remoteFor(root);
  if (!r) {
    for (const f of files) f.skip = true;
    return;
  }
  await Promise.all(files.map(async (f) => {
    try {
      const buf = await r.io.readFile(f.abs);
      f.size = buf.length;
      f.mtimeMs = 0;
      if (buf.length > maxSize) return;          // worker 会按 size 跳过
      if (f.mode !== 'none') f.text = buf.toString('utf8');
    } catch {
      f.skip = true;                             // 读不了：与本地一致，跳过
    }
  }));
}

/**
 * 预扫全树的 `#define`，建"宏名 → 候选定义"表（只留可能拼出新名字的那些）。
 *
 * 纯文本正则、不走语法树（20.5 ms/文件 → ~1 ms/文件），并行走 worker 池；
 * 小树 / 池不可用时退回串行读。有限递归展开（`CR_MACRO_EXPAND=1`）才用得到。
 */
async function scanMacroTable(root, paths) {
  const all = [];
  const take = (rec) => {
    if (rec && Array.isArray(rec.defines)) {
      for (const d of rec.defines) all.push(d);
    }
  };
  let pooled = false;
  try {
    pooled = await indexPool.parseAll(paths, {
      root,
      maxSize: MAX_INDEX_SIZE,
      relOf: (abs) => prel(root, abs),
      langOf: (rel) => LANG.langIdOf(rel),
      modeOf: () => 'defines',
      enhance: null,
      onProgress: (done) => reportMacros(done, paths.length),
      /* 宏预扫也要读一遍全树：同样走预读，省掉 worker 里的同步读盘。 */
      prefetch: isRemoteRoot(root)
        ? (files, maxSize) => prefetchRemote(root, files, maxSize)
        : (files, maxSize) => prefetchLocal(files, maxSize)
    }, take);
  } catch (err) {
    console.error('[fs-service] 宏表预扫（并行）失败，退回串行: ' + ((err && err.message) || err));
    pooled = false;
  }
  if (!pooled) {
    const io = ioFor(root);
    for (const p of paths) {
      try { take({ defines: macroExpand.extractDefines(await io.readText(p)) }); }
      catch { /* 读不了就跳过（与建索引一致） */ }
    }
  }
  return macroExpand.relevantDefines(all);
}

/* ---------------------- 自动推导（工具自己的增强） ---------------------- */

/* 注意 `pjoin` 只收两个参数（base, sub）—— 多传的会被丢掉，path.join 到目录上
   → writeFile EISDIR（2026-10-23 踩过一次，日志就这么静默没写出来）。 */
function deriveLogPath(root) { return pjoin(root, '.kernelscope/derive-log.json'); }

/** 上一次自动推导的结果（面板显示"工具已经做了多少"）。 */
async function readDeriveLog(root) {
  try {
    const txt = await ioFor(root).readText(deriveLogPath(root));
    const j = JSON.parse(txt);
    return j && typeof j === 'object' ? j : null;
  } catch { return null; }
}

async function writeDeriveLog(root, log) {
  try {
    await fsp.mkdir(pjoin(root, '.kernelscope'), { recursive: true });
    await fsp.writeFile(deriveLogPath(root), JSON.stringify(log, null, 2), 'utf8');
  } catch { /* 写不了就算了，不影响索引 */ }
}

/**
 * 建完索引 → 立刻用这次索引推导规则（`enhanceDerive` 的交叉验证要查索引，
 * 所以只能"建完再推"）。推出来的规则**写进包**，然后由 buildIndexNow 重入一次
 * 让它们生效 —— 用户点一次"建立索引"，工具自己跑两轮，不需要点面板。
 *
 * @returns {Promise<null|{at:number, added:number, tried:number, total:number}>}
 */
async function autoDeriveAfterBuild(root) {
  /* SourceLook: never derive or write an enhancement pack into the user tree. */
  return null;
  if (!root || isRemoteRoot(root)) return null;
  const r = await enhanceDerive();
  if (!r || !r.ok) return null;
  const tried = (r.derived || []).length;
  let added = 0;
  if (tried > 0) {
    const s = await enhanceSave(r.text);
    if (s && s.ok) added = tried;
  }
  /* 日志要**累计**：一次建索引没新增，不代表以前没补过 —— 面板要能说清
     "一共自动补了多少条"，所以 `autoTotal` 跨次累加，`at` 只在真的补到时更新。 */
  const prev = await readDeriveLog(root);
  const log = {
    at: added ? Date.now() : ((prev && prev.at) || Date.now()),
    checkedAt: Date.now(),
    added,
    autoTotal: ((prev && prev.autoTotal) || 0) + added,
    tried,
    total: (r.existing || 0) + added,
    candidates: r.candidates || 0
  };
  await writeDeriveLog(root, log);
  return log;
}

async function buildIndex(root) {
  const t0 = Date.now();
  const { tree, truncated } = await buildTree(
    root,
    (dir, found) => reportScan(root, dir, found),
    () => buildCancel
  );
  const paths = [];

  (function collect(node) {
    if (!node) return;
    if (node.type === 'file') { paths.push(node.path); return; }
    for (const c of node.children) collect(c);
  })(tree);

  /* 扫描结束:总数已知,进入解析阶段。 */
  reportParsed(0, paths.length, []);

  /* L4：项目自己的宏知识（`.kernelscope/enhance.json`）。没有就退回内置表，
     行为与没有这一层时逐字节一致 —— 增强包永远是可选的。 */
  const enh = await readEnhancePack(root);
  tsIndex.setEnhance(enh.pack);

  /* L1 engine (SPEC 9.8). tree-sitter gives conditional-compilation labels,
   * scopes and types that the regex prototype cannot express; the regex stays
   * as a fallback so the app still indexes if the WASM cannot be loaded. */
  let engine = 'regex';
  let projectGrammars = [];
  try {
    /* 只加载这个项目实际出现的语言；Linux 项目不会加载 Python/JS/Java 的 wasm。 */
    projectGrammars = Array.from(new Set(paths
      .map((abs) => LANG.grammarForRel(prel(root, abs)))
      .filter(Boolean)));
    await tsIndex.ensureReady(projectGrammars);
    if (tsIndex.isReady()) engine = 'tree-sitter';
  } catch (err) {
    console.error('[fs-service] tree-sitter unavailable, falling back to regex: '
      + ((err && err.message) || err));
  }

  /* THE BUILDER REPLACES THE SYMBOL ARRAY. Records go into columns as they are
   * produced and the parsed objects become garbage immediately, so the peak is
   * the data itself rather than one JS object per symbol and per reference -
   * which at kernel scale was the difference between 2 GB and 4 GB before a
   * single line was written (SPEC F1.17). */
  let builder = store.createBuilder(root);
  let fileList = [];
  const BATCH = 8;

  /* 进度行的"目录 + 文件数"必须成对真实:以前取的是这一批**第一个文件**的目录,
     数字却是整批大小,于是每个目录后面都挂着同一个数(用户 2026-10-19 报告
     "统一为 48")。数字改成该目录在待解析清单里的实际文件总数,批内按目录去重。 */
  const dirTotals = new Map();
  for (const abs of paths) {
    const d = relDirOf(abs, root);
    dirTotals.set(d, (dirTotals.get(d) || 0) + 1);
  }
  const activeOf = (slice) => {
    const seen = new Set();
    const rows = [];
    for (const abs of slice) {
      const d = relDirOf(abs, root);
      if (seen.has(d)) continue;
      seen.add(d);
      rows.push({ dir: d, files: dirTotals.get(d) || 0 });
    }
    return rows;
  };

  /* 解析降级清单：按「种类 + 名字」全局聚合（`WARN_ON ×1204` 比 1204 行有用）。
     上限 600 个名字 —— 报告只需要一个短名单，索引文件不该为它变大。 */
  const issueMap = new Map();
  const addIssues = (list, rel) => {
    for (const it of (list || [])) {
      if (!it || !it.kind || !it.name) continue;
      const key = it.kind + '|' + it.name;
      const e = issueMap.get(key);
      if (e) { e.count += (it.count || 1); continue; }
      /* 索引里最多存多少个不同的名字。这条不是"报告容量"，是**落盘上限**：
         每条约 120 字节 JSON，20000 条 ≈ 2.4 MB，相对内核索引（~1 GB）是零头。
         真正的显示上限在 enhance.reportText 的字节预算里（那里才是给 AI 的
         口径），所以这里放宽到基本不会成为瓶颈（2026-10-22）。 */
      if (issueMap.size >= 100000) continue;
      issueMap.set(key, {
        kind: it.kind, name: it.name, count: it.count || 1,
        file: rel, line: it.line || 0, sample: it.sample || ''
      });
    }
  };

  /* 一个文件的收尾：台账（L2 编译参数 / 分支名的原料，SPEC 9.8.2）+ 进列。
     顺序敏感 —— fileId 就是添加顺序，所以并行路径也必须按输入顺序回流。 */
  /* 符号级自检：全树累加计数 + **明细**（不是样本）。内核实测三类合计约 1,700 个，
     所以全量留得下（上限 4000 只是病态保护）；台账第三节据此全量列出。 */
  const symStats = { total: 0, weakDef: 0, noType: 0, noOwner: 0, samples: [] };
  /* 规则命中计数：`{宏名: 次数}`，全树累加。用途只有一个 —— 让"这条规则到底
     生效没有"看得见（0 命中的那条要自己跳出来）。 */
  const ruleHits = new Map();
  const addRuleHits = (o) => {
    if (!o) return;
    for (const k of Object.keys(o)) ruleHits.set(k, (ruleHits.get(k) || 0) + (o[k] || 0));
  };
  const addSymStats = (st, rel) => {
    if (!st) return;
    symStats.total += st.total || 0;
    symStats.weakDef += st.weakDef || 0;
    symStats.noType += st.noType || 0;
    symStats.noOwner += st.noOwner || 0;
    for (const s of (st.samples || [])) {
      if (symStats.samples.length >= 4000) break;
      /* 文件路径在聚合时补上（worker 只知道自己批里的 rel，样例本身不带它）。 */
      symStats.samples.push(rel ? { ...s, file: rel } : s);
    }
  };

  /* 接收者形状普查（待解析台账第四节）：字段访问的接收者**形状**分布 + 少量
     带源码行的样本。只计数，不进索引主体（同 symStats）。 */
  const recvStats = {
    total: 0, plain: 0, chain: 0, call: 0, index: 0, cast: 0, other: 0, samples: []
  };
  const addRecvStats = (st, rel) => {
    if (!st) return;
    recvStats.total += st.total || 0;
    for (const k of ['plain', 'chain', 'call', 'index', 'cast', 'other']) {
      recvStats[k] += st[k] || 0;
    }
    for (const s of (st.samples || [])) {
      if (recvStats.samples.length >= 200) break;
      recvStats.samples.push(rel ? { ...s, file: rel } : s);
    }
  };

  const keep = (abs, rel, size, mtimeMs, lang, got) => {
    fileList.push({
      path: abs, rel, size, mtimeMs, lang,
      includes: got.includes || [], conds: got.conds || []
    });
    addIssues(got.issues, rel);
    addSymStats(got.symStats, rel);
    addRecvStats(got.recvStats, rel);
    addRuleHits(got.ruleHits);
    builder.addFile({
      rel, size, mtimeMs, lang,
      symbols: got.symbols, refs: got.refs,
      /* 并行路的回流是「字典 + 定长列」，builder 见到 dict 就走列式入口
         （两条路必须产出同一个索引，见 index-columns.js 的对拍）。 */
      dict: got.dict, kinds: got.kinds, rkinds: got.rkinds, sym: got.sym, ref: got.ref
    });
  };

  /* 并行路：解析是纯 CPU（实测 20.5ms/文件 → 内核全树 17.4 分钟单线程），
     交给 worker 池后线性下降；批回流保序，fileId 与顺序构建逐字节可比。
     小树 / 单核 / 正则引擎都返回 false（一个回调都没发生）→ 走下面的顺序路。 */
  const remoteRoot = isRemoteRoot(root);
  let pooled = false;

  /* 有限递归展开（2026-10-23）：**默认就开**，没有开关。
     解析得越准，读代码越省事 —— 这是工具的生命力（用户 2026-10-23 定）。
     先并行预扫一遍 `#define`：纯正则、不走语法树，实测 0.17–0.9 ms/文件。 */
  let macroList = null;
  let macroLang = null;
  if (engine === 'tree-sitter' && paths.length) {
    try {
      reportMacros(0, paths.length);
      macroList = await scanMacroTable(root, paths);
      macroLang = ((LANG.defaultTable() || {}).syntax || {}).macroDerive || null;
      tsIndex.setMacroTable(macroList, macroLang);
    } catch (err) {
      console.error('[fs-service] 宏表预扫失败，退回不展开: ' + ((err && err.message) || err));
      macroList = null;
    }
  }
  if (engine === 'tree-sitter') {
    try {
      pooled = await indexPool.parseAll(paths, {
        root,
        maxSize: MAX_INDEX_SIZE,
        relOf: (abs) => prel(root, abs),
        langOf: (rel) => LANG.langIdOf(rel),
        modeOf: (rel) => extractMode(rel),
        enhance: enh.pack,
        macros: macroList,
        macroLang,
        grammars: projectGrammars,
        shouldAbort: () => buildCancel,
        onProgress: (done) => reportParsed(done, paths.length),
        onActive: (active) => reportActive(active),
        /* 远程：worker 不能自己读 SFTP，由主进程在派发前并发预读，
           文本随批送过去（见 index-pool.js 的 dispatch）。 */
        /* 本地也预读：异步 IO 与解析重叠（远程必须预读，本地也能省掉 worker 里的
           同步阻塞读盘）。 */
        prefetch: remoteRoot
          ? (files, maxSize) => prefetchRemote(root, files, maxSize)
          : (files, maxSize) => prefetchLocal(files, maxSize)
      }, (f) => keep(pjoin(root, f.rel), f.rel, f.size, f.mtimeMs, f.lang, f));
    } catch (err) {
      /* 取消不是「池失败」:不能回退到顺序路径继续跑。 */
      if (err && err.code === 'INDEX_ABORTED') throw err;
      /* 池半路失败：已喂进 builder 的记录必须整体作废，从头顺序重来。 */
      console.error('[fs-service] 并行建索引失败，回退顺序路径: '
        + ((err && err.message) || err));
      pooled = false;
      fileList = [];
      builder = store.createBuilder(root);
    }
  }

  /* 顺序路（小树 / 单核 / 正则引擎 / 池失败回退）。
     块内并发读盘 + 解析，但**按输入顺序 flush**：谁先读完不该影响 fileId。
     以前直接在 Promise.all 里 keep()，文件表顺序取决于读盘快慢 —— 同一棵树
     两次构建的索引字节不同（并行路反而因为保序而稳定），回归基线便失去意义。 */
  if (!pooled) {
    const io = ioFor(root);
    for (let i = 0; i < paths.length; i += BATCH) {
      if (buildCancel) throw abortError();
      const slice = paths.slice(i, i + BATCH);
      reportActive(activeOf(slice));
      const done = await Promise.all(slice.map(async (abs) => {
        try {
          const stat = await io.stat(abs);
          if (stat.size > MAX_INDEX_SIZE) return null;

          const rel = prel(root, abs);
          const text = await io.readText(abs);
          const lang = LANG.langIdOf(rel);

          let got;
          if (engine === 'tree-sitter') {
            const mode = extractMode(rel);
            if (mode === 'tree') {
              got = tsIndex.extract(text, rel);
            } else if (mode === 'asm') {
              got = { symbols: asmIndex.extract(text), refs: [], includes: [], conds: [] };
            } else if (mode === 'approx') {
              /* 未注册语言：默认规则给出近似符号（G.4），可搜可跳但标注近似。 */
              got = { symbols: approx.extract(text), refs: [], includes: [], conds: [] };
            } else {
              /* 登记过的文本资产：可浏览可搜索，零符号。 */
              got = { symbols: [], refs: [], includes: [], conds: [] };
            }
          } else {
            got = { symbols: extractSymbols(text, rel), refs: [], includes: [], conds: [] };
          }
          return { abs, rel, size: stat.size, mtimeMs: stat.mtimeMs, lang, got };
        } catch {
          return null; /* unreadable file: skip */
        }
      }));
      for (const r of done) {
        if (r) keep(r.abs, r.rel, r.size, r.mtimeMs, r.lang, r.got);
      }
      reportParsed(Math.min(i + BATCH, paths.length), paths.length, activeOf(slice));
    }
  }

  /* 取消可能落在最后一批之后、返回之前;不能让一个已取消的构建进保存。 */
  if (buildCancel) throw abortError();
  reportActive([]);

  return {
    root, files: fileList, engine, builder, truncated,
    builtAt: Date.now(), elapsedMs: Date.now() - t0,
    /* 索引内容与解析器版本绑定：提取逻辑一改（例如位域多声明符），旧索引就不可信。 */
    parserRev: String(tsIndex.PARSER_REV || ''),
    /* L4：这份索引是用哪个包建的（用来提示「换了包要重建」），以及解析降级清单。 */
    enhance: enh.pack ? { id: enh.pack.id, version: enh.pack.version } : null,
    enhanceErrors: enh.errors || [],
    issues: Array.from(issueMap.values()).sort((a, b) => b.count - a.count),
    /* 本次构建确实扫过降级（哪怕结果为空）—— 报告靠它区分"真没有"和"旧索引"。 */
    issuesScanned: true,
    /* 符号级自检（定义回读/类型缺失/归属缺失）—— 衡量"讲不清的符号"有多少。 */
    symStats,
    /* 接收者形状普查（台账第四节；只计数 + 样本，不进二进制索引）。 */
    recvStats,
    /* 每条规则命中多少处（0 命中 = 规则没生效或写错）。 */
    ruleHits: Object.fromEntries(ruleHits)
  };
}

/* The symbol index is built ONLY when the user asks for it. The reader stays
 * fully usable without one - it just knows fewer facts (no jump-to-definition,
 * no global symbol search, no semantic colouring). */

function indexState() {
  const idx = currentIndex();
  return {
    built: !!idx,
    root: projectRoot,
    building: !!indexBuilding,
    /* Counts come from the BINARY index. The in-memory symbol array is gone -
       twelve million objects was the single largest allocation in the process
       and every question it answered can be answered from the file
       (SPEC F1.17). */
    symbolCount: db ? db.counts.symbols : 0,
    fileCount: idx ? idx.files.length : 0,
    builtAt: idx ? idx.builtAt : 0,
    elapsedMs: idx ? (idx.elapsedMs || 0) : 0,
    loadMs: idx ? (idx.loadMs || 0) : 0,
    engine: idx ? (idx.engine || 'regex') : '',
    references: db ? db.counts.refs : 0,
    strings: db ? db.counts.strings : 0,
    /* Known from the writer on a fresh build, and from the open file otherwise -
       a cached load left this at zero, which the UI would have shown as "0 MB"
       for a one-gigabyte index. */
    binaryBytes: (idx && idx.binaryBytes) || (db ? db.bytes : 0),
    layers: { l1: !!db, l2: !!l2, l3: !!l3 },
    /* True when the tree was cut off by MAX_FILES. Reported rather than left to
       be inferred from a suspiciously round file count. */
    truncated: !!(idx && idx.truncated),
    fromCache: !!(idx && idx.fromCache),
    stale: !!(idx && idx.stale),
    /* 解析器版本与索引不一致（旧索引缺新提取的字段，例如位域成员）。 */
    parserRev: String(tsIndex.PARSER_REV || ''),
    parserStale: !!(idx && idx.parserStale),
    changedFiles: idx && idx.changedFiles ? idx.changedFiles.length : 0,
    /* 构建中/刚结束时的进度快照。渲染进程重载后靠它恢复「索引中 x%」。 */
    progress: buildState ? {
      ...buildState,
      active: (buildState.active || []).map((a) => ({ ...a }))
    } : null
  };
}

/**
 * Explicit build / rebuild - triggered by the toolbar button.
 *
 * 这是**全量重建**：每个文件都会重新读盘 + 解析（没有"未改动文件复用符号"的捷径，
 * 之前那句注释是假的，形参 prevByRel 也从没被用过）。全量是刻意的 —— 解析器版本一变
 * （PARSER_REV），只有重新提取才能把新字段补进索引。
 */
async function buildIndexNow(sink) {
  if (!projectRoot) throw new Error('no project opened');
  if (indexBuilding) return indexBuilding;

  const root = projectRoot;
  buildSink = typeof sink === 'function' ? sink : null;
  buildCancel = false;
  const gen = ++buildGen;
  beginBuildProgress(root);

  const job = (async () => {
    try {
      /* 全量重新提取：本项目**没有**"未改动文件复用符号"的捷径
         （旧参数 prevByRel 从没被 buildIndex 用过，已删，免得注释继续骗人）。 */
      const idx = await buildIndex(root);
      /* 项目已切换:不要把上一个项目的索引写进新项目的缓存目录。 */
      if (root !== projectRoot || buildCancel) throw abortError();
      reportWriting();
      await saveIndex(idx);
      if (root !== projectRoot) throw abortError();
      /* 保存成功之后才切换内存索引:失败时旧索引继续可用。 */
      indexCache = idx;
      await openAuxiliary(root);    // the fresh binary index is on disk now
      /* 自动推导（工具自己的增强，**不用 AI、不用用户点**）：建完索引立刻推。
         交叉验证要查索引，所以只能"建完立刻推"；推出来的规则写进包之后，
         还要**再建一次**才生效 —— 重入由外层负责（`autoRebuildGuard` 防循环）。 */
      try {
        /* 重入那次（`autoRebuildGuard`）**不再推导**：规则刚刚才写进包，这次建索引
           就是为了让它们生效；再推一遍只会把 derive-log 里的"新增 N 条"覆盖成 0。 */
        if (!autoRebuildGuard) {
          const ad = await autoDeriveAfterBuild(root);
          if (ad && ad.added) idx.autoDerived = ad.added;
        }
      } catch (err) {
        console.error('[fs-service] 自动推导失败（不影响索引）: ' + ((err && err.message) || err));
      }
      reportPhase('done');
      return idx;
    } catch (err) {
      if (err && err.code === 'INDEX_ABORTED') {
        /* 取消:丢弃 builder(随 idx 成为垃圾),旧索引一个字节都没动。 */
        reportPhase('canceled');
        return null;
      }
      reportPhase('failed');
      throw err;
    }
  })();

  indexBuilding = job;
  try {
    const idx = await job;
    /* 这次建索引里自动推导出了规则（已写进包）→ 立刻再建一次让它们生效。
       只重入一轮（`autoRebuildGuard`），避免"规则永远在变"时无限重来。 */
    if (idx && idx.autoDerived && !autoRebuildGuard) {
      autoRebuildGuard = true;
      try {
        indexBuilding = null;
        buildSink = null;
        buildCancel = false;
        return await buildIndexNow(sink);
      } finally {
        autoRebuildGuard = false;
      }
    }
    return idx;
  } finally {
    /* 重入期间不要清（外层那个 return 还要用 indexBuilding 之外的状态）；
       已被后一任构建/换项目接管时也不要清（否则会把新 job 的 building 状态抹掉，
       导致「界面显示没在构建、取消按钮失效、还能再起一个 builder 写同一份 tmp」）。 */
    if (!autoRebuildGuard && gen === buildGen) {
      indexBuilding = null;
      buildSink = null;
      buildCancel = false;
    }
  }
}

/** 取消正在运行的构建。写盘阶段不可取消(两份文件替换只在一瞬)。 */
function cancelBuild() {
  if (!indexBuilding) return { canceled: false, reason: 'idle' };
  if (buildState && buildState.phase === 'write') return { canceled: false, reason: 'writing' };
  buildCancel = true;
  return { canceled: true };
}

/** The index, if one exists and belongs to the current project. */
function currentIndex() {
  if (indexCache && indexCache.root === projectRoot) return indexCache;
  return null;
}

/**
 * Every code file in the project WITHOUT parsing anything. Cheap enough to run
 * as part of opening a directory, and the only thing grep / Ctrl+O need.
 */
async function listFiles() {
  if (!projectRoot) throw new Error('no project opened');
  if (fileListCache && fileListCache.root === projectRoot) return fileListCache.files;

  const { tree } = await buildTree(projectRoot);
  const files = [];
  (function walk(node) {
    if (!node) return;
    if (node.type === 'file') {
      files.push({ path: node.path, rel: prel(projectRoot, node.path) });
      return;
    }
    for (const c of node.children) walk(c);
  })(tree);

  fileListCache = { root: projectRoot, files };
  return files;
}

/* ----------------------------------------------------------------- files */

function safeResolve(root, rel) {
  if (!root) return null;
  if (isRemoteRoot(root)) {
    const abs = remoteFs.resolve(root, rel);
    const norm = remoteFs.rel(root, abs);
    if (norm === null || norm.split('/').indexOf('..') >= 0) return null;
    return abs;
  }
  const abs = path.resolve(root, rel);
  const norm = path.relative(root, abs);
  if (norm.startsWith('..') || path.isAbsolute(norm)) return null;
  return abs;
}

/** 渲染进程传来的绝对路径必须落在项目内（本地/远程同一套判断）。 */
function resolveInside(absPath) {
  if (!projectRoot) throw new Error('no project opened');
  if (isRemoteRoot(projectRoot)) {
    const rel = remoteFs.rel(projectRoot, String(absPath == null ? '' : absPath).replace(/\\/g, '/'));
    if (rel === null) {
      const err = new Error('路径不在项目目录内');
      err.code = 'OUTSIDE_PROJECT';
      throw err;
    }
    return remoteFs.join(projectRoot, rel);
  }
  const abs = path.resolve(String(absPath == null ? '' : absPath));
  const rel = path.relative(projectRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error('路径不在项目目录内');
    err.code = 'OUTSIDE_PROJECT';
    throw err;
  }
  return abs;
}

async function readFile(absPath) {
  const io = ioFor(projectRoot);
  const stat = await io.stat(absPath);
  if (stat.size > MAX_OPEN_SIZE) {
    const err = new Error('文件过大,暂不支持打开(> 2MB)');
    err.code = 'TOO_LARGE';
    throw err;
  }
  const content = await io.readText(absPath);
  const rel = projectRoot ? prel(projectRoot, absPath) : pbase(absPath);
  return { path: absPath, rel, content, size: stat.size };
}

async function writeFile(absPath, content) {
  if (!projectRoot) throw new Error('no project opened');
  const abs = resolveInside(absPath);
  await ioFor(projectRoot).writeFile(abs, content);

  /* 保存后旧的 AST 作用域就过期了（版本号对不上也会自愈，这里直接扔掉更快）。 */
  const savedRel = prel(projectRoot, abs);
  if (savedRel !== '') localScope.invalidate(savedRel);

  /* Keep the index but mark it stale: the user decides when to refresh it
   * (F1.11 - never rebuild behind their back). */
  const idx = currentIndex();
  if (idx) {
    const rel = savedRel;
    const changed = idx.changedFiles || [];
    if (!changed.includes(rel)) changed.push(rel);
    idx.changedFiles = changed;
    idx.stale = true;
  }

  return { ok: true, path: abs, bytes: Buffer.byteLength(content, 'utf8') };
}

/**
 * Full-text search.
 *
 * `opts.word` restricts matches to identifier boundaries: looking up "lookup"
 * must not return "ctx_lookup". Substring matching floods a large codebase with
 * false references, which is exactly what makes a reference lookup feel unlike
 * Source Insight.
 */
async function grep(query, max, opts) {
  const limit = Math.min(Number(max) || 50, 500);
  if (!query) return { hits: [] };

  /* An explicit file list - "read only these" - is what the INDEX-FIRST reference
     lookup passes: these are the files the index says mention the name, so the
     project is never walked and the other ~39,990 files of a kernel tree are
     never opened (user decision 2026-10-14: "索引优先,秒级;无索引时不要触发全文
     扫描,全文扫描由用户自己点击查找来实现"). They come from the index, so they
     are code files by construction - the extension filter listFiles would apply
     has nothing to add. */
  const only = (opts && Array.isArray(opts.files) && opts.files.length) ? opts.files : null;

  /* Otherwise: every code file, without parsing anything. */
  let files = only ? [] : await listFiles();
  if (only) {
    const rootAbs = String(projectRoot).replace(/[\\/]+$/, '');
    const seen = new Set();
    for (const f of only) {
      const rel = String(f).replace(/\\/g, '/');
      if (!rel || seen.has(rel)) continue;
      seen.add(rel);
      files.push({ rel, path: pjoin(rootAbs, rel) });
    }
  }

  /* A directory scope (user request 2026-10-13). "Find in this folder" is what
     a reader reaches for when the project-wide search returns too much, and it
     costs nothing to honour: the walk below stops as soon as the limit is hit,
     so a narrower list is a shorter walk, not a second pass. */
  const dir = (opts && opts.dir)
    ? String(opts.dir).replace(/\\/g, '/').replace(/\/+$/, '') + '/'
    : '';
  if (dir) files = files.filter((f) => f.rel.replace(/\\/g, '/').startsWith(dir));

  const caseSensitive = !!(opts && opts.caseSensitive);
  const useRegex = !!(opts && opts.regex);
  const rawSource = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let matcher;
  try {
    matcher = new RegExp(opts && opts.word ? `\\b(?:${rawSource})\\b` : rawSource, caseSensitive ? 'u' : 'iu');
  } catch {
    return { hits: [], error: 'invalid_regex' };
  }
  const hits = [];

  /* Read a few files at a time, in file order.
   *
   * The walk is LATENCY-bound, not bandwidth-bound: one file at a time pays a
   * full open+read round trip per file, and on a 40,000-file kernel tree that is
   * minutes of "正在搜索…" with the window looking hung - the user reported
   * exactly that (2026-10-14: "一直显示正在搜索"). Measured on that tree:
   * 5.97 ms/file one at a time vs 1.85 ms/file in batches - 3.2x, same answer.
   * The batch stays small on purpose: Node's fs thread pool is 4 threads wide by
   * default, so a much larger batch only queues. Order is preserved by
   * collecting each batch before moving to the next, and the hit limit still cuts
   * the scan where it always did. */
  const remoteScan = isRemoteRoot(projectRoot);
  const GREP_BATCH = remoteScan ? 16 : 8;
  const scanIo = ioFor(projectRoot);

  const scanFile = async (f) => {
    const found = [];
    try {
      const text = await scanIo.readText(f.path);
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const matched = matcher.test(line);
        if (matched) found.push({ file: f.rel, line: i + 1, text: line.trim().slice(0, 200) });
      }
    } catch { /* skip */ }
    return found;
  };

  for (let i = 0; i < files.length && hits.length < limit; i += GREP_BATCH) {
    const batch = await Promise.all(files.slice(i, i + GREP_BATCH).map(scanFile));
    for (const part of batch) {
      for (const h of part) {
        if (hits.length >= limit) break;
        hits.push(h);
      }
      if (hits.length >= limit) break;
    }
  }
  return { hits };
}

/* ------------------------------------------------- SPEC 9.5 query surface */
/* UI and AI share these. Only the ones needed by T1 are implemented now;    */
/* the rest are declared so the adapter layer can be built against them.     */

/**
 * Name search over the SYMBOL TABLE.
 *
 * The old version scanned an in-memory array of every symbol: O(n) over twelve
 * million entries at kernel scale, and the one place this tool would have been
 * measurably SLOWER than SI. The symbol table is stored sorted by name, so this
 * is a binary search followed by a short forward read (SPEC F1.17).
 *
 * When the index is absent it falls back to the old scan - but the old scan
 * needs an array that no longer exists, so the honest answer is "no index".
 */
async function searchSymbols(query, limit, rel) {
  const d = ensureDb();
  if (!d) return { symbols: [], needsIndex: true };
  const q = String(query || '').trim();
  const cap = Math.min(Number(limit) || 80, 500);
  return { symbols: d.symbolsMatching(q, cap, poolOf(d, rel)), needsIndex: false };
}

/* ------------------------------------------------------- paged browsing

   The two panes the layout is built around (SPEC F2.23). Both are PAGED
   because both can be enormous: six million symbols, sixty thousand files. The
   renderer asks for one page at a time and never holds the list.

   `substring` is the mode the UI needs - "rst reg" means every name containing
   both - and prefix search cannot answer it. The index does it by scanning the
   string table's raw bytes, which is why it is fast enough to run on a
   keystroke (see index-store.js). */
async function symbolsPage(tokens, start, limit, globalsOnly, rel) {
  const d = ensureDb();
  if (!d) return { rows: [], needsIndex: true };
  /* 全局符号列表也按当前文件的池收窄（G.4）；文件列表 / 文件树不受限。 */
  const pool = poolOf(d, rel);
  return Object.assign({ needsIndex: false }, d.symbolsPage(tokens, start, limit, globalsOnly, pool));
}

async function filesPage(tokens, start, limit) {
  const d = ensureDb();
  if (!d) return { rows: [], needsIndex: true };
  return Object.assign({ needsIndex: false }, d.filesPage(tokens, start, limit));
}

async function outline(relPath) {
  const d = ensureDb();
  if (!d) return { symbols: [], needsIndex: true };
  const want = String(relPath || '').replace(/\\/g, '/');
  const id = d.fileIdOf(want);
  if (id === null) return { symbols: [] };
  const symbols = d.symbolsOfFile(id);
  /* 未注册语言：这一窗的符号来自默认规则（近似），符号窗也要标明。 */
  const isApprox = d.langOf(want) === 0;
  if (isApprox) for (const s of symbols) s.approx = true;
  return { symbols, approx: isApprox };
}

/* ------------------------------------------------------- symbol queries

   SPEC 9.5 / T3-T4. This is what the binary index was built for.

   The difference from a grep, and the reason for all of the above: a grep can
   only say "here are 9 places this word occurs". This says WHICH definition you
   are looking at, WHICH of the uses are compiled in under the current
   configuration, and HOW CONFIDENT each binding is. Everything that could not
   be determined is reported as unresolved rather than guessed
   (SPEC F1.14 A1-A4, E4, E6). */

/** The binary index, opened on demand. */
function ensureDb() {
  if (db) return db;
  if (!projectRoot) return null;
  /* 远程索引只能异步下载，这里不做同步探测：打开的时机由 openAuxiliary
     掌握（打开项目 / 建完索引之后），查询期间 db 已经是打开的。 */
  if (isRemoteRoot(projectRoot)) return null;
  try {
    const f = binaryFileFor(projectRoot);
    if (fs.existsSync(f)) db = store.open(f);
  } catch { db = null; }
  return db;
}

/**
 * Does this conditional context hold in the current build?
 *
 * Returns null - not false - when there is nothing to decide: no condition, or
 * no L2 data. "I cannot tell" must never decay into a confident "no".
 */
function livenessOf(config, rel) {
  if (!config) return true;                 // unconditional code is live
  if (!l2) return null;                     // no compile database: unknown
  const t = l2.truth(config, rel);
  return t === 'unknown' ? null : t === 'true';
}

/**
 * The definitions of one name, and nothing else.
 *
 * WHY THIS IS SEPARATE FROM findReferences (2026-10-14): the receiver resolver
 * asks "what type is `ip_hdr`?" dozens of times per click, once per distinct
 * receiver. Going through findReferences to answer it also mapped EVERY
 * REFERENCE of that name - for busy receiver names (`hdr`, `props`, `iph`) that
 * is thousands of rows per call, and a member click spent ~10 seconds doing
 * nothing but that. Symbols only: one binary search, a handful of records.
 */
/* ---- 池（REQUIREMENTS-GAP.md G.4「语言分离」）--------------------------

   符号类查询只在当前文件所属语言内回答。这里只把「文件 → 池」翻译成一个
   lang id 数组，索引层不认识语言名——池的判据是语言层的数据（有没有符号槽）。

   `rel` 为空 → 不限制：无上下文的调用方（启动加载、探针、LSP 之外的工具）
   保持旧行为。文本资产 / 未知语言 → null（无池）→ 调用方走跨池兜底。 */

function relKey(rel) {
  const s = String(rel || '').replace(/\\/g, '/');
  if (!s) return '';
  const root = String(projectRoot || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return root && s.indexOf(root + '/') === 0 ? s.slice(root.length + 1) : s;
}

function poolOf(d, rel) {
  const key = relKey(rel);
  if (!d || !key) return null;
  const lang = d.langOf(key);
  return LANG.isPoolLang(lang) ? [lang] : null;
}

/** 跨池兜底结果标注来源（"来自 X 池"），并且不进当前文件的符号/定义列表。 */
function withPoolTag(d, rows) {
  for (const r of rows) {
    r.pool = LANG.nameOf(d.langOf(r.file));
    r.crossPool = true;
  }
  return rows;
}

function mapSymbols(d, want, filter, pool, markPool) {
  const f = filter || {};
  const kinds = f.kinds && f.kinds.length ? new Set(f.kinds) : null;
  const notKinds = f.excludeKinds && f.excludeKinds.length ? new Set(f.excludeKinds) : null;
  const limit = f.limit ? Math.max(1, Math.min(Number(f.limit) || 200, 2000)) : 0;
  const wantParent = f.parent !== undefined && f.parent !== '' ? f.parent : null;
  const foundFileId = f.fileRel ? d.fileIdOf(f.fileRel) : null;
  const wantFileId = typeof foundFileId === 'number' && foundFileId >= 0 ? foundFileId : -1;

  /* THE FILTER RUNS INSIDE THE INDEX READ (see `symbolsWhere`). This is not a
     micro-optimisation: the receiver resolver asks for a type and wants eight
     rows, while a name like `p` or `hdr` has four thousand to forty thousand
     records, each with five string-table lookups. Reading them all and filtering
     afterwards cost 3.4 seconds for one `dest` click (measured 2026-10-14). */
  const accept = (kinds || notKinds || wantParent || wantFileId >= 0)
    ? (s) => {
      if (wantFileId >= 0 && s.fileId !== wantFileId) return false;
      if (kinds && !kinds.has(s.kind)) return false;
      if (notKinds && notKinds.has(s.kind)) return false;
      if (wantParent && (s.parent || '') !== wantParent) return false;
      return true;
    }
    : null;

  return d.symbolsWhere(want, accept, limit, pool).map((s) => {
    const rel = d.file(s.fileId).rel;
    const lang = d.langOf(rel);
    const row = {
      kind: s.kind,
      file: rel,
      line: s.line,
      type: s.type || '',
      parent: s.parent || '',
      config: s.config || '',
      prototype: !!s.prototype,
      /* A macro's body: the receiver resolver reads it to find the type a
         field-like macro points at (`((struct iphdr *)skb_network_header(skb))`),
         and the panel can quote it. It was already in the index. */
      value: s.value || '',
      /* 形参表：报告要把 `#define NAME(a, b) …` 原样给 AI 看 —— 没有宏体，
         AI 只能**猜**名字怎么拼（2026-10-22：它把 `dev_attr_##_name` 猜成了
         `$0_attr`，因为提示词里唯一的例子是后缀风格）。 */
      params: s.params || [],
      live: livenessOf(s.config, rel),
      /* L3: was this actually compiled into the kernel? */
      inKernel: (l3 && (s.kind === KIND.function || s.kind === KIND.macro)) ? l3.hasFunction(want) : null,
      size: (l3 && (s.kind === KIND.struct || s.kind === KIND.union)) ? l3.sizeOf(want) : null
    };
    /* 未注册语言（lang=0）的符号来自默认规则：行上必须说清楚"这是近似的"，
       否则一个 .py 里的伪符号会和 tree-sitter 的结果长得一模一样。 */
    if (lang === 0) row.approx = true;
    if (markPool) {
      row.pool = LANG.nameOf(lang);
      row.crossPool = true;
    }
    return row;
  });
}

/**
 * 只要符号,不要引用 —— 见 mapSymbols 上面那段为什么。
 *
 * `filter` 让调用方按需取:`{ kinds, excludeKinds, parent, limit }`。这不是锦上添花,
 * 而是把一次成员点击从 8 秒拉回来的东西:解析器每次只要一个类型,却把那个名字的全部
 * 记录搬过 IPC(`iph` 559 条、`hdr` 4568 条、`len` 18890 条),206 个接收者就是几百
 * KB × 206 —— 实测主进程侧查询只要 2 ms,5.8 秒全花在搬运上(2026-10-14)。
 */
async function findSymbols(name, filter, rel) {
  const want = String(name || '').trim();
  if (!want) return { name: '', definitions: [], needsIndex: !currentIndex() };

  const d = ensureDb();
  if (!d) {
    const idx = currentIndex();
    if (!idx) return { name: want, definitions: [], needsIndex: true };
    return {
      name: want,
      definitions: (idx.symbols || []).filter((s) => s.name === want),
      needsIndex: false
    };
  }
  /* 池内查询，**不做跨池兜底**：这条路径喂的是接收者类型解析，拿另一个
     语言的同名类型去解析成员访问只会更错。兜底属于"点了一个符号"。 */
  return {
    name: want,
    definitions: mapSymbols(d, want, filter, poolOf(d, rel)),
    layers: { l1: true, l2: !!l2, l3: !!l3 },
    needsIndex: false
  };
}

/**
 * Many `findSymbols` calls in one IPC message.
 *
 * The receiver resolver knows every name it is going to ask about before it
 * starts asking (they are the receivers of the symbol's references), and a
 * member click on a kernel-sized name means dozens to hundreds of them. Each
 * call is cheap now that the filter runs inside the index read, but the round
 * trip is not free: batching turned the last second of a `dest` click into
 * milliseconds (2026-10-14).
 *
 * The queries are independent, and a failure on one must not fail the batch -
 * the renderer falls back to asking for that name on its own.
 */
async function findSymbolsMany(queries, rel) {
  const list = Array.isArray(queries) ? queries.slice(0, 600) : [];
  const d = ensureDb();
  const pool = poolOf(d, rel);
  const results = [];
  for (const q of list) {
    const name = String((q && q.name) || '').trim();
    if (!name) { results.push([]); continue; }
    try {
      if (!d) {
        const idx = currentIndex();
        results.push(idx && idx.symbols ? idx.symbols.filter((s) => s.name === name) : []);
        continue;
      }
      results.push(mapSymbols(d, name, q.filter, pool));
    } catch { results.push([]); }
  }
  return { results, needsIndex: !d && !currentIndex() };
}

/**
 * Where is this name defined, and where is it used?
 *
 * Every site carries its configuration and its confidence, because that is what
 * a reader needs in order to trust the answer: a `name-only` hit is a weaker
 * claim than an `exact` one, and a definition that is compiled out is not the
 * definition on screen.
 */
/** 成员引用的接收者类型：`skb`（局部/参数/全局）或 `ip_hdr(skb)`（函数返回类型）。 */
async function receiverTypeOf(d, recv, rel, line, pool) {
  if (!/^[A-Za-z_]\w*$/.test(recv) && !/^[A-Za-z_]\w*\s*\(.*\)$/.test(recv)) return '';
  const call = /([A-Za-z_]\w*)\s*\(/.exec(recv);
  if (call) {
    const hits = mapSymbols(d, call[1], { kinds: ['function', 'macro'], limit: 20 }, pool);
    const fn = hits.find((s) => !s.prototype) || hits[0];
    return baseTypeName(fn ? fn.type : '');
  }
  const ident = (/[A-Za-z_]\w*$/.exec(recv) || [])[0] || '';
  if (ident === '') return '';
  const fileHits = rel !== '' ? mapSymbols(d, ident, { fileRel: rel, limit: 20 }, pool) : [];
  /* 顺序是"就近的局部声明 → 本文件全局 → 全项目全局"；后两级用统一的可见性判断
     （枚举常量也算全局可见，它的 type 就是枚举名）。 */
  const hit = fileHits.find((s) => s.parent && Number(s.line) <= line)
    || fileHits.find((s) => isGloballyVisibleSymbol(s))
    || mapSymbols(d, ident, { limit: 20 }, pool).find((s) => isGloballyVisibleSymbol(s));
  return baseTypeName(hit ? hit.type : '');
}

/** 只保留接收者类型等于成员 owner 的字段访问；判不出类型的保持原样，不丢。 */
async function narrowMemberRaw(d, raw, owner, rel, line, pool) {
  const groups = new Map();
  for (const r of raw) {
    const to = String(r.to || '');
    if (!to.startsWith('field ')) continue;
    const recv = to.slice(6).trim();
    if (recv === '') continue;
    const file = d.file(r.fileId).rel;
    const key = `${file}\u0000${recv}`;
    const info = groups.get(key);
    if (info) { info.count += 1; continue; }
    groups.set(key, { recv, file, line: r.line, count: 1 });
  }
  if (groups.size === 0) return raw;
  /* 先解析出现次数最多的接收者（`skb` 这种通常占绝大多数），预算内收益最大。 */
  const ordered = [...groups.entries()].sort((a, b) => b[1].count - a[1].count);
  const resolved = new Map();
  const started = Date.now();
  for (const [key, info] of ordered) {
    if (resolved.size >= 30 || Date.now() - started > 250) break;
    resolved.set(key, await receiverTypeOf(d, info.recv, info.file, info.line, pool));
  }
  const kept = [];
  for (const r of raw) {
    const to = String(r.to || '');
    if (!to.startsWith('field ')) { kept.push(r); continue; }
    const recv = to.slice(6).trim();
    const key = `${d.file(r.fileId).rel}\u0000${recv}`;
    if (!resolved.has(key)) continue;
    if (resolved.get(key) === owner) kept.push(r);
  }
  return kept.length > 0 ? kept : raw;
}
async function findReferences(name, rel, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const limit = Math.max(1, Math.min(Number(opts.limit) || 400, 2000));
  const fileOnly = opts.fileOnly === true;
  const want = String(name || '').trim();
  if (!want) return { name: '', definitions: [], references: [], needsIndex: !currentIndex() };

  const d = ensureDb();
  if (!d) {
    /* No binary index: fall back to the symbol cache, which knows definitions
       but has never held references. Better than nothing, and it says so. */
    const idx = currentIndex();
    if (!idx) return { name: want, definitions: [], references: [], needsIndex: true };
    return {
      name: want,
      definitions: (idx.symbols || []).filter((s) => s.name === want),
      references: [],
      referencesUnavailable: true,
      needsIndex: false
    };
  }

  /* 局部变量的引用：直接扫当前文件文本，不碰整库（`len` 在核里有 8 万条）。
     位置、行号都是真实的；只在本文件范围内。 */
  if (opts.localText === true && rel !== '') {
    try {
      const text = await ioFor(projectRoot).readText(pjoin(projectRoot, rel));
      const lines = text.split(/\r?\n/);
      const esc = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b${esc}\\b`, 'g');
      let range = null;
      if (opts.fn) {
        const fnEsc = String(opts.fn).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const fnRe = new RegExp(`\\b${fnEsc}\\s*\\(`);
        const fromLine = Math.min(Number(opts.line) || lines.length, lines.length);
        let start = -1;
        for (let i = fromLine - 1; i >= 0; i -= 1) {
          if (fnRe.test(lines[i]) && !/;\s*$/.test(lines[i])) { start = i; break; }
        }
        if (start >= 0) {
          let depth = 0;
          let opened = false;
          for (let i = start; i < lines.length; i += 1) {
            for (const ch of lines[i]) {
              if (ch === '{') { depth += 1; opened = true; }
              else if (ch === '}') depth -= 1;
            }
            if (opened && depth <= 0) { range = { from: start, to: i }; break; }
          }
          if (range === null) range = { from: start, to: lines.length - 1 };
        }
      }
      const rows = [];
      for (let i = 0; i < lines.length && rows.length < limit; i += 1) {
        if (range !== null && (i < range.from || i > range.to)) continue;
        re.lastIndex = 0;
        let match = re.exec(lines[i]);
        while (match !== null && rows.length < limit) {
          rows.push({
            kind: 'ident',
            file: rel,
            line: i + 1,
            column: match.index + 1,
            fn: '',
            config: '',
            to: '',
            conf: 'exact',
            live: true
          });
          match = re.exec(lines[i]);
        }
      }
      return {
        name: want,
        definitions: [],
        references: rows,
        fileOnly: true,
        truncated: false,
        crossPool: false,
        counts: {
          definitions: 0,
          references: rows.length,
          liveReferences: rows.length,
          nameOnly: 0,
          unresolved: 0
        },
        layers: { l1: true, l2: !!l2, l3: !!l3 },
        needsIndex: false
      };
    } catch { /* 读不到文件就退回索引路径 */ }
  }
  const mapRef = (r) => {
    const file = d.file(r.fileId).rel;
    return {
      kind: r.kind,
      file,
      line: r.line,
      column: r.column,
      fn: r.fn || '',
      config: r.config || '',
      to: r.to || '',
      conf: r.conf,
      live: livenessOf(r.config, file)
    };
  };

  const pool = poolOf(d, rel);
  /* 先判符号类型再筛引用：函数只看 call/address，变量只看 read/write/address，
     类型只看 type；滤空就退回全部（与阅读器同一条规则）。 */
  const REF_KIND_TABLE = {
    function: ['call', 'address'],
    variable: ['read', 'write', 'address'],
    parameter: ['read', 'write', 'address'],
    member: ['read', 'write', 'address', 'field'],
    enum_member: ['read', 'write', 'address', 'field'],
    struct: ['type'],
    union: ['type'],
    enum: ['type'],
    typedef: ['type'],
    class: ['type'],
    macro: ['call', 'address']
  };
  const symKind = String(opts.kind || '').toLowerCase();
  const allowedRefKinds = REF_KIND_TABLE[symKind] || null;
  let definitions = mapSymbols(d, want, { limit: 60 }, pool);
  /* 过滤下沉到索引层：`dev` 这类名字有一万多条引用，先按 kind/fileId 筛掉，
     再为通过的少量记录构造对象（每条 3 次字符串表查找）。 */
  const ownerType = String(opts.parent || '').trim();
  const memberMode = (symKind === 'member' || symKind === 'enum_member') && ownerType !== '';
  const fid = fileOnly && rel ? d.fileIdOf(rel) : -1;
  const wantFileId = (typeof fid === 'number' && fid >= 0) ? fid : -1;
  const kindSet = allowedRefKinds !== null ? new Set(allowedRefKinds.map(String)) : null;
  const refAccept = (kindSet || wantFileId >= 0)
    ? (r) => (kindSet === null || kindSet.has(String(r.kind || '')))
      && (wantFileId < 0 || r.fileId === wantFileId)
    : null;
  /* 成员收窄要看到全部候选；fileOnly 要完整集合。这两种不设上限。 */
  const refCap = (!memberMode && wantFileId < 0) ? limit * 4 : 0;
  let refEarlyStop = false;
  let raw = d.references(want, pool, {
    accept: refAccept,
    limit: refCap,
    onStop: () => { refEarlyStop = true; },
  });
  /* 按 kind 过滤后为空 → 退回全部（与原来"滤空退回"的语义一致）。 */
  if (raw.length === 0 && refAccept !== null && !memberMode) raw = d.references(want, pool);
  if (fileOnly && rel) raw = raw.filter((r) => d.file(r.fileId).rel === rel);
  /* 成员引用先只留字段访问（`to="field skb"`），再按接收者类型收窄。 */
  if (memberMode) {
    const fields = raw.filter((r) => String(r.to || '').startsWith('field '));
    if (fields.length > 0) raw = fields;
  }
  if (memberMode) {
    raw = await narrowMemberRaw(d, raw, ownerType, rel, Number(opts.line) || 0, pool);
  }
  if (opts.fn) raw = raw.filter((r) => (r.fn || '') === String(opts.fn));
  const total = raw.length;
  const truncated = total > limit || refEarlyStop;
  let references = raw.slice(0, limit).map(mapRef);

  /* 跨池兜底（G.4「两扇门」）：可跳转、可看代码、标注来源池。 */
  let crossPool = false;
  if (rel && !pool) {
    crossPool = definitions.length > 0 || references.length > 0;
    if (crossPool) { withPoolTag(d, definitions); withPoolTag(d, references); }
  } else if (rel && pool && !definitions.length && !references.length) {
    definitions = withPoolTag(d, mapSymbols(d, want, { limit: 60 }, null));
    const all = d.references(want, null);
    const picked = fileOnly && rel ? all.filter((r) => d.file(r.fileId).rel === rel) : all;
    references = withPoolTag(d, picked.slice(0, limit).map(mapRef));
    crossPool = definitions.length > 0 || references.length > 0;
  }

  return {
    name: want,
    definitions,
    references,
    fileOnly,
    truncated,
    crossPool,
    counts: {
      definitions: definitions.length,
      references: total,
      liveReferences: references.filter((r) => r.live !== false).length,
      nameOnly: references.filter((r) => r.conf === 'name-only').length,
      unresolved: references.filter((r) => r.conf === 'unresolved').length
    },
    layers: { l1: true, l2: !!l2, l3: !!l3 },
    needsIndex: false
  };
}

/** Just the definitions - i.e. the jump target.
 *
 * 点击一个局部变量（`len` 这种）时，不能把全项目一万八千个同名符号都读出来：
 * 先只在该文件里找，取点击行上方最近的一条；没有才退回全局的小批量。
 */
/** 局部变量不在符号索引里：在点击行上方按文本找一次声明（`int len;` / 参数）。
 *  只用于当前文件，范围限定在最近的函数符号内，找不到就返回 null。 */
/** 局部变量不在符号索引里：在点击行上方按文本找一次声明（`int len;` / 参数）。
 *  只在当前文件、最近 400 行内扫描，且遇到函数结束的 `}` 就停；找不到返回 null。
 *  不查符号索引，避免为常见名字（len）扫描几万条记录。 */
/* 把 C 注释/字符串/字符常量替换成空格，保持长度和换行不变，
   这样括号匹配不会被注释里的 `{`/`}` 或字符串骗到。 */
function stripCNoise(text) {
  const chars = String(text || '').split('');
  let state = 'code';
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    const next = chars[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') { chars[i] = ' '; chars[i + 1] = ' '; i += 1; state = 'line'; continue; }
      if (ch === '/' && next === '*') { chars[i] = ' '; chars[i + 1] = ' '; i += 1; state = 'block'; continue; }
      if (ch === '"' || ch === "'") { const quote = ch; chars[i] = ' '; state = quote === '"' ? 'string' : 'char'; continue; }
      continue;
    }
    if (state === 'line') {
      if (ch === '\n') { state = 'code'; continue; }
      chars[i] = ' ';
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') { chars[i] = ' '; chars[i + 1] = ' '; i += 1; state = 'code'; continue; }
      if (ch !== '\n') chars[i] = ' ';
      continue;
    }
    /* string / char：保留换行，内容抹掉；处理反斜杠转义。 */
    if (ch === '\\') { chars[i] = ' '; if (i + 1 < chars.length && chars[i + 1] !== '\n') chars[i + 1] = ' '; i += 1; continue; }
    if ((state === 'string' && ch === '"') || (state === 'char' && ch === "'")) { chars[i] = ' '; state = 'code'; continue; }
    if (ch !== '\n') chars[i] = ' ';
  }
  return chars.join('');
}

/* 找点击行所在的函数体：返回函数名、函数体 `{` 的行、签名起始行。
   只认顶层（花括号深度 0）的 `{`，并排除 if/for/while/switch。 */
function functionBodyAt(codeLines, clickLine) {
  const code = codeLines.join('\n');
  const starts = [0];
  for (let i = 0; i < code.length; i += 1) if (code[i] === '\n') starts.push(i + 1);
  const clickOffset = (starts[Math.max(0, Math.min(clickLine - 1, starts.length - 1))] || 0)
    + (codeLines[Math.max(0, Math.min(clickLine - 1, codeLines.length - 1))] || '').length;
  let depth = 0;
  let found = null;
  for (let i = 0; i < Math.min(clickOffset, code.length); i += 1) {
    if (code[i] === '{') {
      if (depth === 0) {
        let j = i - 1;
        while (j >= 0 && /\s/u.test(code[j])) j -= 1;
        if (j >= 0 && code[j] === ')') {
          let k = j - 1;
          let paren = 0;
          for (; k >= 0; k -= 1) {
            if (code[k] === ')') paren += 1;
            else if (code[k] === '(') {
              if (paren === 0) break;
              paren -= 1;
            }
          }
          if (k >= 0) {
            let n = k - 1;
            while (n >= 0 && /\s/u.test(code[n])) n -= 1;
            let end = n + 1;
            while (n >= 0 && /[A-Za-z0-9_]/u.test(code[n])) n -= 1;
            const fnName = code.slice(n + 1, end);
            if (fnName !== '' && !/^(?:if|for|while|switch)$/u.test(fnName) && !code.slice(0, k).endsWith('.')) {
              const openLine = code.slice(0, i).split('\n').length;
              let sigLine = openLine;
              for (let s = Math.max(1, openLine - 30); s <= openLine; s += 1) {
                if (new RegExp(`\\b${fnName}\\s*\\(`, 'u').test(codeLines[s - 1] || '')) { sigLine = s; break; }
              }
              found = { name: fnName, openLine, sigLine, closeLine: Infinity };
            }
          }
        }
      }
      depth += 1;
    } else if (code[i] === '}') {
      if (depth > 0) depth -= 1;
      if (depth === 0 && found && found.closeLine === Infinity) {
        found.closeLine = code.slice(0, i).split('\n').length;
      }
    }
  }
  if (found && found.closeLine < clickLine) return null;
  return found;
}
/** 把 AST 命中项转成与文本扫描同形的定义行（kind 只用界面认识的词）。 */
function astDefinition(ast, rel, hit) {
  const fn = (ast.functions || []).find((item) => item.id === hit.functionId);
  return {
    kind: hit.kind === 'parameter' ? 'parameter' : 'variable',
    file: rel,
    line: hit.line,
    column: hit.column,
    type: hit.type || '',
    parent: fn ? fn.name : '',
    config: '',
    text: hit.text || '',
  };
}

/** 插件卸载时收掉 worker（unref 过，这里只是干净退出）。 */
function shutdownLocalScope() {
  try { localScope.shutdown(); } catch { /* already gone */ }
}

/** 预热某个文件的局部作用域（打开/切换文件时调用，纯后台，不阻塞）。 */
async function warmLocalScope(rel) {
  if (!projectRoot || typeof rel !== 'string' || rel.trim() === '') return { ok: false };
  const clean = rel.replace(/\\/g, '/').replace(/^\/+/u, '');
  try {
    resolveInside(pjoin(projectRoot, clean));
  } catch {
    return { ok: false };
  }
  const queued = await localScope.warm(clean);
  return { ok: true, queued: queued === true };
}

async function localDeclarationInFile(d, rel, name, line, pool) {
  try {
    const text = await ioFor(projectRoot).readText(pjoin(projectRoot, rel));
    const lines = text.split(/\r?\n/);
    const codeLines = stripCNoise(text).split(/\r?\n/);
    let fn = functionBodyAt(codeLines, line);
    if (!fn) {
      /* 点击可能落在函数签名/参数行，函数体 `{` 还在下面。 */
      for (let probe = line + 1; probe <= Math.min(lines.length, line + 40); probe += 1) {
        const candidate = functionBodyAt(codeLines, probe);
        if (candidate && candidate.sigLine <= line) { fn = candidate; break; }
        if (/;\s*$/u.test(codeLines[probe - 1] || '')) break;
      }
    }
    if (!fn) return null;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nameRe = new RegExp(`\\b${esc}\\b`, 'g');
    const typeRe = /[A-Za-z0-9_\]\*]$/;
    const assignRe = new RegExp(`^\\s*${esc}\\s*(?:=|\\[)`);
    const start = Math.min(line, lines.length) - 1;
    const from = Math.max(0, Math.min(fn.sigLine, lines.length) - 1);
    let skipDepth = 0;
    for (let i = start; i >= from; i -= 1) {
      const textLine = lines[i] || '';
      const codeLine = codeLines[i] || '';
      const trimmed = textLine.trim();
      if (trimmed === '' || trimmed.startsWith('/*') || trimmed.startsWith('//') || trimmed.startsWith('#')) {
        /* still walk braces below */
      } else if (skipDepth === 0 && !(trimmed.startsWith('*') && !/^\*+\s*[A-Za-z_]\w*\s*[;,]/.test(trimmed))) {
        /* 一行里可能出现多次：`const struct net *net`。 */
        nameRe.lastIndex = 0;
        let match = nameRe.exec(codeLine);
        while (match !== null) {
          const index = match.index;
          const before = codeLine.slice(0, index);
          const after = codeLine.slice(index + name.length);
          /* 行内可能先有 `if (...) { int x;`：取最后一个块/语句边界后的片段作为声明前缀。 */
          const prefix = before.trim().split(/[{};]/u).pop().trim();
          const badPrefix = /(?:[=+\-/%!&|^<>?:;,.()]|\b(?:return|case|sizeof|if|while|for|switch|goto|else|do))$/.test(prefix)
            || /[=]/.test(prefix)
            || /\b(?:return|case|sizeof|if|while|for|switch|goto|else|do)\b/.test(prefix);
          const typeLike = typeRe.test(prefix) && !badPrefix;
          const skip = (/(?:->|\.)\s*$/.test(before)
            || /(?:struct|union|enum)\s*$/.test(before)
            || assignRe.test(codeLine)
            || !/^[\s=;,)\[]/.test(after.charAt(0))
            || !typeLike);
          if (!skip) {
            /* 声明和关闭花括号在同一行：例如 `if (...) { int x; }`，如果点击
               在下一行，x 的块已经结束，不能算可见。 */
            const opensBefore = (before.match(/\{/gu) || []).length
              > (before.match(/\}/gu) || []).length;
            if (i < start && opensBefore && /\}/u.test(after)) {
              match = nameRe.exec(codeLine);
              continue;
            }
            const inSignature = i + 1 >= fn.sigLine && i + 1 <= fn.openLine;
            return {
              kind: inSignature ? 'parameter' : 'variable',
              file: rel,
              line: i + 1,
              column: index + 1,
              type: '',
              parent: fn.name,
              config: '',
              text: trimmed
            };
          }
          match = nameRe.exec(codeLine);
        }
      }
      /* 向上扫描时遇到 `}`，说明进入一个在当前点击位置之前已经关闭的
         兄弟块；跳过它内部，直到匹配的 `{`。这样不会把已经出作用域的
         局部变量当成当前变量。 */
      for (let j = codeLine.length - 1; j >= 0; j -= 1) {
        if (codeLine[j] === '}') skipDepth += 1;
        else if (codeLine[j] === '{' && skipDepth > 0) skipDepth -= 1;
      }
    }
  } catch { /* unreadable file: fall back to the global list */ }
  return null;
}

function isCalleeAt(lineText, column) {
  const after = String(lineText || '').slice(Math.max(0, (Number(column) || 1) - 1));
  return /^\w*\s*\(/.test(after);
}

function isTypeKeywordBefore(lineText, column) {
  const before = String(lineText || '')
    .slice(0, Math.max(0, (Number(column) || 1) - 1))
    .replace(/[A-Za-z_]\w*$/, '')
    .replace(/\s+$/, '');
  return /(?:^|[^A-Za-z0-9_])(?:struct|union|enum|class)$/.test(before);
}

function receiverExprAt(lineText, column) {
  let s = String(lineText || '').slice(0, Math.max(0, (Number(column) || 1) - 1));
  s = s.replace(/[A-Za-z_]\w*$/, '').replace(/\s+$/, '');
  if (!/(?:->|\.)\s*$/.test(s)) return '';
  s = s.replace(/(?:->|\.)\s*$/, '').replace(/\s+$/, '');
  let depth = 0;
  let cut = -1;
  for (let i = s.length - 1; i >= 0; i -= 1) {
    const ch = s[i];
    if (ch === ')' || ch === ']') { depth += 1; continue; }
    if (ch === '(' || ch === '[') {
      if (depth === 0) { cut = i; break; }
      depth -= 1;
      continue;
    }
    if (depth > 0) continue;
    if (/\s/.test(ch)) { cut = i; break; }
    if (/[;,=+\-*/%!~&|^<>?:]/.test(ch)) {
      if (ch === '>' && s[i - 1] === '-') continue;
      if (ch === '-' && s[i + 1] === '>') continue;
      cut = i;
      break;
    }
  }
  return s.slice(cut + 1).trim();
}

function lastOperand(expr) {
  const s = String(expr || '');
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '(' || c === '[') { depth += 1; continue; }
    if (c === ')' || c === ']') { depth -= 1; continue; }
    if (depth > 0) continue;
    if (c === ',' || c === '?' || c === '=') cut = i;
    if (c === ':' && s[i - 1] !== ':') cut = i;
    const kw = /^\b(?:return|case|sizeof|if|while|for|switch)\b/.exec(s.slice(i));
    if (kw) { cut = i + kw[0].length - 1; i += kw[0].length - 1; }
  }
  return (cut >= 0 ? s.slice(cut + 1) : s).trim();
}

/** 从 from 向左配对 `{` / `(` / `[`，返回匹配的开符号偏移；找不到返回 -1。 */
function matchBackward(text, from, open, close) {
  let depth = 0;
  for (let i = from - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === close) { depth += 1; continue; }
    if (ch === open) {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

/** 声明起点：从 `=` 向左，遇到内联结构体的 `}` 就跳回匹配的 `{`，
 *  继续取到 `struct X`；普通语句停在 `;` / 换行。 */
function declarationStart(text, eqPos) {
  let start = eqPos;
  while (start > 0) {
    const ch = text[start - 1];
    if (ch === ';' || ch === '\n') break;
    if (ch === '}') {
      const open = matchBackward(text, start - 1, '{', '}');
      if (open < 0) break;
      start = open;
      continue;
    }
    start -= 1;
  }
  return start;
}

/** 声明片段 → 类型名：`static const struct T arr[]` → `T`，`T x` → `T`。 */
function declarationTypeName(fragment) {
  let s = String(fragment || '').trim();
  if (s === '') return '';
  /* 先整段找 tagged 类型：`static const struct X { … } tbl[] = {` 的类型名
     在 `struct X` 上，不能因为后面有 `}` 就把前半截丢掉。 */
  const tagged = /\b(?:struct|union|enum)\s+([A-Za-z_]\w*)/.exec(s);
  if (tagged !== null) return tagged[1];
  let cut = -1;
  for (let i = s.length - 1; i >= 0; i -= 1) {
    if (s[i] === ';' || s[i] === '{' || s[i] === '}' || s[i] === '\n') { cut = i; break; }
  }
  s = s.slice(cut + 1).trim();
  const eq = s.indexOf('=');
  if (eq >= 0) s = s.slice(0, eq).trim();
  s = s.replace(/^\[[^\]]*\]\s*=\s*/, '').trim();
  const plain = /^([A-Za-z_]\w*)\s+(?:\*|[A-Za-z_]\w*)/.exec(s);
  if (plain !== null) return plain[1];
  return '';
}

/** `.field = value` 的容器类型：向上找初始化器 `{`，按 `= {`（声明/数组）或
 *  `(struct T){`（复合字面量）取类型；`[IDX] = {` 的嵌套继续向外找。
 *  只做语法推导，不认具体类型名。 */
function designatorOwnerAt(rawText, offset) {
  const text = blankNoise(rawText);
  let i = offset - 1;
  while (i >= 0 && /\s/.test(text[i])) i -= 1;
  if (i < 0 || text[i] !== '.') return '';
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) j -= 1;
  /* 左边是标识符 / `]` / `)` → 普通成员访问 `x.field`，不归这条规则。 */
  if (j >= 0 && /[A-Za-z0-9_\]\)]/.test(text[j])) return '';
  let brace = matchBackward(text, i, '{', '}');
  let guard = 0;
  while (brace >= 0 && guard < 8) {
    guard += 1;
    let k = brace - 1;
    while (k >= 0 && /\s/.test(text[k])) k -= 1;
    if (k >= 0 && text[k] === '=') {
      let n = k - 1;
      while (n >= 0 && /\s/.test(text[n])) n -= 1;
      if (n >= 0 && text[n] === ']') {
        const lb = matchBackward(text, n, '[', ']');
        if (lb >= 0) {
          let before = lb - 1;
          while (before >= 0 && /\s/.test(text[before])) before -= 1;
          /* `arr[] = {` / `arr[10] = {`：`[` 左边是标识符 → 数组声明，
             元素类型就是声明里的类型，直接取。 */
          if (before >= 0 && /[A-Za-z0-9_]/.test(text[before])) {
            return declarationTypeName(text.slice(declarationStart(text, k), k));
          }
          /* `{ … [IDX] = { … } }`：数组设计符，继续向外找外层初始化器。 */
          brace = matchBackward(text, lb, '{', '}');
          continue;
        }
      }
      return declarationTypeName(text.slice(declarationStart(text, k), k));
    }
    if (k >= 0 && text[k] === ')') {
      const open = matchBackward(text, k, '(', ')');
      if (open < 0) return '';
      return baseTypeName(text.slice(open + 1, k));
    }
    brace = matchBackward(text, brace, '{', '}');
  }
  return '';
}

/** 调用实参里的类型：`f(..., struct T, field)` 返回 T。只看**前一个顶层实参**
 *  是否写成类型表达式；不认宏名，`offsetof` / `container_of` / 自定义宏都适用。 */
function typeArgumentOwnerAt(rawText, offset) {
  const text = blankNoise(rawText);
  const open = matchBackward(text, offset, '(', ')');
  if (open < 0) return '';
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < offset; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) { args.push(text.slice(start, i)); start = i + 1; }
  }
  args.push(text.slice(start, offset));
  if (args.length < 2) return '';
  const prev = args[args.length - 2].trim();
  if (prev === '') return '';
  const tagged = /^(?:const\s+|volatile\s+)*(?:struct|union|enum)\s+([A-Za-z_]\w*)\s*\**$/u.exec(prev);
  if (tagged !== null) return tagged[1];
  const plain = /^([A-Za-z_]\w*)\s*\**$/u.exec(prev);
  if (plain !== null) return plain[1];
  return '';
}

/** 行/列 → 文件绝对偏移（换行按 `\n` 计）。 */
function offsetOfLineColumn(lines, line, column) {
  let offset = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i += 1) offset += lines[i].length + 1;
  return offset + Math.max(0, column - 1);
}

/** 索引里是否存在这个类型名（struct/union/enum/typedef/class…）。 */
function isTypeNameIn(d, name, pool) {
  if (name === '') return false;
  const hits = mapSymbols(d, name, {
    kinds: ['struct', 'union', 'enum', 'typedef', 'type', 'class', 'interface'],
    limit: 1
  }, pool);
  return hits.length > 0;
}

/** typedef 别名指向的类型名：`skb_frag_t`（type=`struct bio_vec`）→ `bio_vec`。
 *  内核 include/ 里就有 638 个 `typedef struct/union`，成员挂在被指向的结构体下，
 *  不跟随就永远查不到（`frag->bv_len` 就是这么"未解析"的）。 */
function typedefTargetOf(d, typeName, pool) {
  const want = String(typeName || '');
  if (want === '') return '';
  const hits = mapSymbols(d, want, { kinds: ['typedef', 'type'], limit: 24 }, pool);
  for (const h of hits) {
    if (String(h.kind).toLowerCase() !== 'typedef') continue;
    const target = baseTypeName(String(h.type || ''));
    if (target !== '' && target !== want) return target;
  }
  return '';
}

function baseTypeName(typeExpr) {
  let s = String(typeExpr || '');
  /* 变量的 type 可能是**内联结构体全文**（`struct T { int x; }`）：
     不先截掉正文，最后一个词会是 `}`，成员查询就会去 `}` 里找。 */
  const brace = s.indexOf('{');
  if (brace >= 0) s = s.slice(0, brace);
  return s
    .replace(/\b(?:const|volatile|register|struct|union|enum)\b/g, ' ')
    .replace(/[*&]/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .pop() || '';
}


/** 定义来源的权威顺序：内核/项目自己的 include 优先，driver 里的私有副本靠后。 */
function definitionRank(file, currentRel) {
  const f = String(file || '').replace(/\\/g, '/');
  if (currentRel && f === currentRel) return 0;
  if (/(^|\/)include\/linux\//.test(f)) return 1;
  if (/(^|\/)include\/uapi\//.test(f)) return 2;
  if (/(^|\/)include\//.test(f)) return 3;
  if (/\.h$/i.test(f)) return 4;
  return 5;
}

/* 全局可见性的唯一判断入口。
 *
 * **不能用 `!sym.parent` 代表"全局"**：`enum_member` 的 parent 是枚举名
 * （`TCP_TW_SYN` → `tcp_tw_status`），但 C 的枚举常量是**非限定标识符**，
 * 直接写名字就能用；只有 struct/union 成员、参数、局部变量才必须带接收者。
 * 之前这条规则散在三处 `!s.parent`，于是 `case TCP_TW_SYN:` 点出来是"没有"。
 *
 * langId 先留着：C++ 的 `enum class` 是限定作用域，需要索引里带 scoped 元数据，
 * 本轮只保证 C（非限定枚举）。
 */
const NON_GLOBAL_KINDS = new Set(['member', 'field', 'parameter', 'local', 'label']);

function isGloballyVisibleSymbol(sym, langId) {          // eslint-disable-line no-unused-vars
  if (!sym) return false;
  const kind = String(sym.kind || '').toLowerCase();
  if (NON_GLOBAL_KINDS.has(kind)) return false;
  /* 有 parent 的 `variable` 是局部变量/循环变量；无 parent 才是全局变量。 */
  if (kind === 'variable') return !sym.parent;
  /* C 的非限定枚举常量：全局可见（匿名枚举的 parent 为空也一样）。 */
  if (kind === 'enum_member') return true;
  /* 其余（function/macro/struct/union/enum/typedef/class/interface/module）：
     文件级或更外层声明，无 parent 即可见。 */
  return !sym.parent;
}

/** 索引里的成员可能缺（多声明符老索引）；按结构体定义文本补一条。
 *  `unsigned char *head, *data;` 这种跨行、逗号续写的声明也要认。 */
/* 成员文本兜底：结构体正文的小型解析器（不是正则逐行猜）。
 * 为什么不用"类型关键字白名单 + 上一行逗号续行"那套（2026-11-15 之前）：
 *   `__u8 txstamp_ack:1,` / `     eor:1,` / `     has_rxtstamp:1,` 这种位域声明里，
 *   第二、第三个名字所在行既没有类型关键字，续行判断也只在"上一行以逗号结尾"时成立，
 *   一旦中间夹了注释或 `#if`，整条链就断了 —— 位域成员直接查不到（`has_rxtstamp`）。
 * 现在按 C 声明本身的结构扫：定位结构体块的 `{}`，在**该块自己的一层**收集以 `;` 结束的
 * 声明，再按逗号拆分每个声明符，位域 `name:N` / 数组 `name[N]` / 函数指针 `(*name)` 都认。 */

/* 文件正文的小 LRU（成员兜底只在索引缺字段时触发，但仍然不该每次重读大文件）。 */
const memberTextCache = new Map();
const MEMBER_TEXT_CACHE_MAX = 8;

async function readTextForMember(rel) {
  const io = ioFor(projectRoot);
  const abs = pjoin(projectRoot, rel);
  let stamp = '';
  try {
    const st = await io.stat(abs);
    stamp = `${Math.floor(st.mtimeMs || 0)}:${st.size || 0}`;
  } catch {
    stamp = '';
  }
  const hit = memberTextCache.get(rel);
  if (hit !== undefined && stamp !== '' && hit.stamp === stamp) return hit.text;
  const text = await io.readText(abs);
  if (memberTextCache.size >= MEMBER_TEXT_CACHE_MAX) {
    const first = memberTextCache.keys().next().value;
    if (first !== undefined) memberTextCache.delete(first);
  }
  memberTextCache.set(rel, { stamp, text });
  return text;
}

/** 把注释与预处理行替换成等长空格（保持字符偏移不变）。 */
function blankNoise(text) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/[^\n]*/g, blank)
    .replace(/^[ \t]*#[^\n]*/gm, blank);
}

/** 从声明符片段里取名字：`(*fp)` / `name[N]` / `name:3` / `*name` / `name = x`。 */
function declaratorNameOf(segment) {
  const fp = /\(\s*\*\s*([A-Za-z_]\w*)\s*\)/.exec(segment);
  if (fp !== null) return fp[1];
  const re = /([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*(?::\s*[^,;]*)?\s*(?:=[^,;]*)?$/;
  const m = re.exec(segment.trim());
  return m === null ? '' : m[1];
}

/** 一段声明（到 `;` 为止）→ [{name, offset, type}]。offset 相对片段起点。 */
function declarationNames(chunk) {
  const clean = blankNoise(chunk);
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      /* 用**去掉注释后**的文本切段：类型前缀里混进块注释会把类型带脏。 */
      parts.push({ text: clean.slice(from, i), offset: from });
      from = i + 1;
    }
  }
  parts.push({ text: clean.slice(from), offset: from });
  const out = [];
  let type = '';
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const name = declaratorNameOf(part.text);
    if (name === '') continue;
    if (index === 0) {
      const at = part.text.lastIndexOf(name);
      type = at > 0 ? part.text.slice(0, at).trim().replace(/[*,]+$/u, '').trim() : '';
      /* 首段前面的类型里如果还留着属性，去掉它（不影响名字）。 */
      type = type.replace(/__attribute__\s*\(\([\s\S]*\)\)/gu, '').trim();
      out.push({ name, offset: part.offset + at, type });
    } else {
      const at = part.text.indexOf(name);
      out.push({ name, offset: part.offset + Math.max(0, at), type });
    }
  }
  return out;
}

/** 在结构体正文里找成员（只认该结构体自己那一层，嵌套结构体的成员不算）。 */
function findMemberInTypeBody(text, fromOffset, memberName) {
  const open = text.indexOf('{', fromOffset);
  if (open < 0 || open - fromOffset > 4000) return null;
  const clean = blankNoise(text);
  let depth = 0;
  let bodyEnd = -1;
  for (let i = open; i < clean.length; i += 1) {
    const ch = clean[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { bodyEnd = i; break; }
    }
  }
  if (bodyEnd < 0) return null;
  const body = text.slice(open + 1, bodyEnd);
  const bodyClean = blankNoise(body);
  /* 按深度 1 的 `;` 切声明。 */
  let depth2 = 0;
  let chunkStart = 0;
  for (let i = 0; i < bodyClean.length; i += 1) {
    const ch = bodyClean[i];
    if (ch === '(' || ch === '[' || ch === '{') depth2 += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth2 = Math.max(0, depth2 - 1);
    else if (ch === ';' && depth2 === 0) {
      const chunk = body.slice(chunkStart, i);
      const names = declarationNames(chunk);
      const hit = names.find((item) => item.name === memberName);
      if (hit !== undefined) {
        return { offset: open + 1 + chunkStart + hit.offset, type: hit.type };
      }
      chunkStart = i + 1;
    }
  }
  /* 结构化切分没命中时的最后兜底：在结构体正文里按"声明符位置"直接找名字。
     典型场景是宏把声明包住了 —— `__struct_group(/* no tag *​/, addrs, /* no attrs *​/,
     __be32 saddr;)` —— 括号让 `;` 不再落在深度 0，整段变成一个 chunk，
     按逗号切也切不出 saddr。这里只要求"这个名字后面紧跟 : / , / ; / ["，
     并且前面是空白、逗号、分号或括号，避免命中注释里的词。 */
  const escaped = String(memberName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[\\s,;(])${escaped}(?=\\s*(?::|,|;|\\[))`, 'm');
  const m = re.exec(bodyClean);
  if (m !== null) {
    const at = m.index + m[1].length;
    const lineStart = body.lastIndexOf('\n', at - 1) + 1;
    const lineText = bodyClean.slice(lineStart, at);
    const t = /([A-Za-z_]\w*(?:\s+[A-Za-z_]\w*)*)\s*$/u.exec(lineText.trim());
    return { offset: open + 1 + at, type: t ? t[1] : '' };
  }
  return null;
}

async function memberFromTypeText(d, typeName, memberName, currentRel, pool) {
  const typeHits = mapSymbols(d, typeName, {
    kinds: ['struct', 'union', 'enum', 'typedef', 'type', 'class', 'interface'],
    limit: 40
  }, pool)
    .slice()
    .sort((a, b) => definitionRank(a.file, currentRel) - definitionRank(b.file, currentRel));
  const wanted = String(memberName);
  /* 同一类型可能有多处定义（前置声明 / 不同文件）；逐个试，直到某处正文里真有这个成员。 */
  for (const hit of typeHits) {
    if (!hit || !hit.file) continue;
    let text = '';
    try {
      text = await readTextForMember(hit.file);
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    const startLine = Math.max(0, Number(hit.line) - 1);
    const head = lines[startLine] || '';
    /* typedef 有两种：`typedef struct bio_vec skb_frag_t;`（别名，正文在别处 —— 由
       typedefTargetOf 跟随）和 `typedef struct { … } foo_t;`（正文就在本行，可以直接扫）。 */
    if (String(hit.kind).toLowerCase() === 'typedef' && head.indexOf('{') < 0) continue;
    if (!/\b(?:struct|union|enum)\b/.test(head)) continue;
    let fromOffset = 0;
    for (let i = 0; i < startLine; i += 1) fromOffset += (lines[i] || '').length + 1;
    const found = findMemberInTypeBody(text, fromOffset + Math.max(0, head.indexOf('{')), wanted)
      || findMemberInTypeBody(text, fromOffset, wanted);
    if (found === null) continue;
    const before = text.slice(0, found.offset);
    const line = before.split('\n').length;
    const column = found.offset - before.lastIndexOf('\n');
    return {
      kind: 'member',
      file: hit.file,
      line,
      column: Math.max(1, column),
      type: found.type || '',
      parent: typeName,
      config: '',
      scope: 'global',
      synthetic: true
    };
  }
  return null;
}


/** 字段式宏（`#define tw_daddr __tw_common.skc_daddr`）→ 真实成员。
 *  从接收者类型出发，按宏体里的 `a.b.c` 逐段查成员；任何一段查不到就返回 null。
 *  这是原版对 `x->tw_*` 这类宏的统一处理，不针对某个名字。 */
async function memberFromMacroBody(d, macroRow, baseType, rel, pool) {
  const body = String((macroRow && macroRow.value) || '').trim();
  if (body === '' || baseType === '') return null;
  const path = body
    .replace(/^\((?:struct|union|enum)\s+[A-Za-z_]\w*\s*\*?\)\s*/, '')
    .replace(/[&*]/g, ' ')
    .trim();
  if (!/^[A-Za-z_]\w*(\s*\.\s*[A-Za-z_]\w*)+$/.test(path)) return null;
  let current = baseType;
  let row = null;
  for (const part of path.split('.').map((item) => item.trim()).filter(Boolean)) {
    const hits = mapSymbols(d, part, {
      parent: current,
      kinds: ['member', 'enum_member', 'field', 'variable'],
      limit: 20
    }, pool);
    if (hits.length === 0) return null;
    row = hits[0];
    current = baseTypeName(row.type || '');
    if (current === '') return null;
  }
  return row;
}


/** 表达式 → 基类型：`skb`、`icsk->icsk_ack`、`skb_shinfo(skb)`、`tcp_sk(sk)->advmss`。 */
function memberPathBase(d, baseType, pathText, pool) {
  let current = String(baseType || '');
  const path = String(pathText || '').trim().replace(/^(?:->|\.)/, '').trim();
  if (current === '' || path === '') return current;
  for (const raw of path.split(/\s*(?:->|\.)\s*/)) {
    const part = raw.replace(/\[.*$/, '').trim();
    if (!/^[A-Za-z_]\w*$/.test(part)) return '';
    const hits = mapSymbols(d, part, {
      parent: current,
      kinds: ['member', 'enum_member', 'field', 'variable'],
      limit: 20
    }, pool);
    if (hits.length === 0) return '';
    current = baseTypeName(hits[0].type || '');
    if (current === '') return '';
  }
  return current;
}

/* ------------------------------------------- 表达式 shape → 类型（AST 路径） */

/** `struct foo **` → `struct foo *`；没有指针时原样返回。 */
function stripOnePointer(typeText) {
  const s = String(typeText || '').trim();
  if (s === '') return '';
  if (s.endsWith('*')) return s.slice(0, -1).replace(/[*\s]+$/u, '').trim();
  return s;
}

/** AST 声明 + 指针/数组层数 → 类型文本（`struct foo *`、`int []`）。 */
function declTypeText(decl) {
  const base = String((decl && decl.type) || '').trim();
  if (base === '') return '';
  const ptr = Math.max(0, Math.min(4, Number(decl.ptrDepth) || 0));
  const arr = Math.max(0, Math.min(4, Number(decl.arrayDepth) || 0));
  return `${base}${' *'.repeat(ptr)}${'[]'.repeat(arr)}`;
}

/** 数组元素 / 指针解一层：`struct foo *` → `struct foo`，`struct foo[]` → `struct foo`。 */
function elementTypeOf(typeText) {
  const s = String(typeText || '').trim();
  if (s === '') return '';
  const arr = s.replace(/\s*\[\s*\]\s*$/u, '').trim();
  if (arr !== s) return arr;
  return stripOnePointer(s);
}

/** 标识符类型：先查当前函数 AST 作用域（局部变量/参数带着 ptr/array 层数），
 *  再退回已有的索引 + 文本推导（全局变量、函数名、宏）。 */
async function resolveIdentifierType(d, name, ctx) {
  const ident = String(name || '').trim();
  if (ident === '') return '';
  if (ctx.scope) {
    const decl = localScope.query(ctx.scope, ident, ctx.line, ctx.column);
    if (decl !== null) {
      const type = declTypeText(decl);
      if (type !== '') return type;
    }
  }
  /* 索引里可能混进“把使用行当声明”的噪音行（type 为空）：先只信带类型的符号，
     同文件里点击行之前优先，其次文件级/全局定义。 */
  const rows = mapSymbols(d, ident, { limit: 40 }, ctx.pool)
    .filter((row) => String(row.type || '').trim() !== '');
  const sameFile = rows.find((row) => row.file === ctx.rel && !row.parent
    && Number(row.line) <= ctx.line);
  const globalDef = rows.find((row) => !row.parent);
  const typed = sameFile || globalDef || rows[0];
  if (typed) return String(typed.type);
  return baseTypeOfExpr(d, ident, ctx.rel, ctx.line, ctx.pool, (Number(ctx.depth) || 0) + 1);
}

/** 成员类型：按 owner 查索引成员，取不出来就退回结构体文本扫描（该路径无类型，链条到此为止）。 */
async function resolveMemberType(d, ownerType, memberName, ctx) {
  const owner = baseTypeName(ownerType);
  const name = String(memberName || '').trim();
  if (owner === '' || name === '') return '';
  const rows = mapSymbols(d, name, {
    parent: owner,
    kinds: ['member', 'enum_member', 'field', 'variable'],
    limit: 20
  }, ctx.pool);
  const typed = rows.find((row) => String(row.type || '').trim() !== '');
  if (typed) return String(typed.type);
  const synthetic = await memberFromTypeText(d, owner, name, ctx.rel, ctx.pool);
  if (synthetic !== null) return String(synthetic.type || '');
  return '';
}

/** 调用表达式类型：函数返回类型；宏走「宏体 cast」这条既有规则。 */
async function resolveCallType(d, fnName, ctx) {
  const name = String(fnName || '').trim();
  if (name === '') return '';
  const hits = mapSymbols(d, name, { kinds: ['function', 'macro'], limit: 20 }, ctx.pool);
  const fn = hits.find((row) => !row.prototype) || hits[0];
  if (!fn) return '';
  const typeExpr = String(fn.type || '').trim();
  if (typeExpr !== '') return typeExpr;
  if (String(fn.kind).toLowerCase() === 'macro') {
    const body = String(fn.value || '');
    const cast = /\(\s*(?:struct|union|enum)\s+([A-Za-z_]\w*)\s*(\*+)?\s*\)/u.exec(body);
    if (cast) return `${cast[1]} ${cast[2] || ''}`.trim();
    const ptr = /\(\s*([A-Za-z_]\w*)\s*(\*+)\s*\)/u.exec(body);
    if (ptr) return `${ptr[1]} ${ptr[2]}`;
  }
  return '';
}

/**
 * 成员表达式的**接收者**类型：`a.b.c` 点 `c` → 解析 `a.b`；`p->x` → 解析 `p` 再解一层指针。
 * 注意不能直接解析整个 shape —— 那得到的是成员本身（点击的那个符号）的类型。
 */
async function resolveReceiverType(d, shape, ctx) {
  if (!shape || typeof shape !== 'object' || shape.kind !== 'member') return '';
  const base = await resolveShapeType(d, shape.base, ctx);
  if (base === '') return '';
  return shape.operator === '->' ? stripOnePointer(base) : base;
}

/**
 * 归一化表达式（worker 产出的 shape）→ 类型文本。返回 '' 表示这一层推不出来，
 * 调用方会退回文本 `baseTypeOfExpr`。
 */
async function resolveShapeType(d, shape, ctx) {
  if (!shape || typeof shape !== 'object') return '';
  switch (shape.kind) {
    case 'identifier':
      return resolveIdentifierType(d, shape.name, ctx);
    case 'subscript': {
      const base = await resolveShapeType(d, shape.base, ctx);
      return base === '' ? '' : elementTypeOf(base);
    }
    case 'member': {
      const base = await resolveShapeType(d, shape.base, ctx);
      if (base === '') return '';
      const owner = shape.operator === '->' ? stripOnePointer(base) : base;
      return resolveMemberType(d, owner, shape.member, ctx);
    }
    case 'call':
      return resolveCallType(d, shape.function, ctx);
    case 'cast':
      return String(shape.type || '').trim();
    case 'pointer': {
      const inner = await resolveShapeType(d, shape.value, ctx);
      if (inner === '') return '';
      return shape.operator === '&' ? `${inner} *` : stripOnePointer(inner);
    }
    case 'parenthesized':
      return resolveShapeType(d, shape.value, ctx);
    default:
      return '';
  }
}

async function baseTypeOfExpr(d, expr, rel, line, pool, depth) {
  const level = Number(depth) || 0;
  const s0 = String(expr || '').trim();
  if (s0 === '' || level > 6) return '';
  let s = s0
    .replace(/^\((?:struct|union|enum)\s+[A-Za-z_]\w*\s*\*?\)\s*/, '')
    .replace(/^[&*]+/, '')
    .trim();
  /* 数组元素：`arr[i].member` 的接收者类型是 arr 的元素类型，不是 i 的类型。 */
  for (let guard = 0; guard < 4; guard += 1) {
    const next = s.replace(/\s*\[[^\]]*\]\s*$/u, '').trim();
    if (next === s) break;
    s = next;
  }
  if (s.startsWith('(') && s.endsWith(')')) {
    let depthP = 0;
    let balanced = true;
    for (let i = 0; i < s.length; i += 1) {
      if (s[i] === '(') depthP += 1;
      else if (s[i] === ')') { depthP -= 1; if (depthP === 0 && i < s.length - 1) { balanced = false; break; } }
    }
    if (balanced) s = s.slice(1, -1).trim();
  }
  const call = /^([A-Za-z_]\w*)\s*\(/.exec(s);
  if (call) {
    const hits = mapSymbols(d, call[1], { kinds: ['function', 'macro'], limit: 20 }, pool);
    const fn = hits.find((x) => !x.prototype) || hits[0];
    let typeExpr = fn ? String(fn.type || '') : '';
    if (typeExpr === '' && fn && String(fn.kind).toLowerCase() === 'macro') {
      const body = String(fn.value || '');
      const cast = /\(\s*(?:struct|union|enum)\s+([A-Za-z_]\w*)\s*\*?\s*\)/.exec(body);
      if (cast) typeExpr = cast[1];
      else {
        const ptr = /\(\s*([A-Za-z_]\w*)\s*\*+\s*\)/.exec(body);
        if (ptr) typeExpr = ptr[1];
      }
    }
    const open = s.indexOf('(', call[0].length - 1);
    let close = -1;
    let depthCall = 0;
    for (let i = open; i >= 0 && i < s.length; i += 1) {
      if (s[i] === '(') depthCall += 1;
      else if (s[i] === ')') {
        depthCall -= 1;
        if (depthCall === 0) { close = i; break; }
      }
    }
    const rest = close >= 0 ? s.slice(close + 1).trim() : '';
    const fnBase = baseTypeName(typeExpr);
    if (rest !== '') return memberPathBase(d, fnBase, rest, pool);
    return fnBase;
  }
  let cut = -1;
  let opLen = 0;
  let depthP = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '(' || ch === '[') depthP += 1;
    else if (ch === ')' || ch === ']') depthP -= 1;
    else if (depthP === 0 && ch === '.') { cut = i; opLen = 1; }
    else if (depthP === 0 && ch === '-' && s[i + 1] === '>') { cut = i; opLen = 2; }
  }
  if (cut > 0) {
    const left = s.slice(0, cut).trim();
    const right = s.slice(cut + opLen).trim().replace(/\[.*$/, '').trim();
    if (left === '' || right === '') return '';
    const base = await baseTypeOfExpr(d, left, rel, line, pool, level + 1);
    if (base === '') return '';
    const members = mapSymbols(d, right, {
      parent: base,
      kinds: ['member', 'enum_member', 'field', 'variable'],
      limit: 20
    }, pool);
    if (members.length === 0) return '';
    /* 同一个名字可能有多条成员记录：匿名 union/struct 里的那条 `type` 是一整段内联
       类型文本（`union { struct net_device *dev; ... }`），拿它当类型会退化成外层
       （`skb->dev->name` 就是这么错成 sk_buff 的）。优先取"类型能被 baseTypeName
       化成一个名字"的那条。 */
    const usable = members.find((m) => {
      const t = String(m.type || '');
      return t.indexOf('{') < 0 && baseTypeName(t) !== '';
    });
    if (usable === undefined) return base;
    return baseTypeName(usable.type || '');
  }
  const ident = (/[A-Za-z_]\w*$/.exec(s) || [])[0] || '';
  if (ident === '') return '';
  const fileHits = rel !== '' ? mapSymbols(d, ident, { fileRel: rel, limit: 20 }, pool) : [];
  const hit = fileHits.find((x) => x.parent && Number(x.line) <= line)
    || fileHits.find((x) => !x.parent)
    || mapSymbols(d, ident, { limit: 20 }, pool).find((x) => !x.parent);
  return baseTypeName(hit ? hit.type : '');
}

/* 非 C 语言的通用定义解析：只依赖索引里的符号/父级/行号，不做文本正则。
 * 语言特有的成员/类型规则以后再按语言加，这一层先保证“函数、类、变量、字段、
 * 参数”能定位；C/C++ 继续走原来的专用解析。 */
async function findDefinitionGeneric(d, want, rel, line, pool) {
  const hits = mapSymbols(d, want, { limit: 80 }, pool);
  if (hits.length === 0) return { name: want, definitions: [] };

  const sameFile = hits.filter((s) => s.file === rel);
  const scopedKinds = new Set(['variable', 'parameter', 'member', 'field', 'enum_member']);
  let picked = [];

  /* 当前文件里、点击位置之前最近的局部声明；参数/变量/字段优先。 */
  const local = sameFile
    .filter((s) => scopedKinds.has(String(s.kind).toLowerCase()) && Number(s.line) <= line)
    .sort((a, b) => Number(b.line) - Number(a.line))[0];
  if (local && line - Number(local.line) < 500) picked = [local];

  /* 当前文件里的文件级定义（函数/类/全局变量/枚举常量）。 */
  if (picked.length === 0) {
    const fileLevel = sameFile.filter((s) => isGloballyVisibleSymbol(s));
    if (fileLevel.length > 0) picked = fileLevel;
    else if (sameFile.length > 0) picked = sameFile;
  }

  /* 文件里没有再按全局同名；优先全局可见的符号。 */
  if (picked.length === 0) {
    const global = hits.filter((s) => isGloballyVisibleSymbol(s));
    picked = global.length > 0 ? global : hits;
  }

  return {
    name: want,
    definitions: picked.slice(0, 40).map((s) => ({ ...s, scope: 'global' }))
  };
}


/* ------------------------------------------------------------ 解释型未定义
 *
 * 有些名字在源码里**确实没有定义**，但把它说成"未解析"是错的。下面几类只在
 * 查询期判断（不改索引、不需要重建），判据全是语法形状，**不认项目**：
 *
 *   macroParam  `#define M(X, ORDER)` 的形参 / `__X_##name` 的拼接片段
 *   protoParam  函数原型 `void f(int timeo);` 的形参 —— 实现在别的 .c 里
 *
 * 说明文案在这一层生成；界面只按 status 分支显示（见 src/client/80-app.js）。
 */

/** 当前文件所属语言的规则表（核心不认识具体语言）。 */
function tableFor(rel) {
  return (typeof LANG.tableForRel === 'function' ? LANG.tableForRel(rel) : null)
    || LANG.defaultTable() || {};
}

/**
 * 点击行所在的 `#define` 指令块（含反斜杠续行）；不在块内返回 null。
 * 只做行级判断，不认识任何具体宏。
 */
function macroDefineBlockAt(lines, line) {
  const at = Number(line) - 1;
  if (!(at >= 0 && at < lines.length)) return null;
  let i = at;
  let guard = 0;
  while (i >= 0 && !/^\s*#\s*define\b/.test(String(lines[i] || ''))) {
    /* 上一行不以反斜杠续行 → 当前行不属于上面那条宏。 */
    if (i === 0 || !/\\\s*$/.test(String(lines[i - 1] || ''))) return null;
    i -= 1;
    if (++guard > 400) return null;
  }
  if (i < 0) return null;
  const m = /^\s*#\s*define\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?/.exec(String(lines[i] || ''));
  if (!m) return null;
  /* 块尾 = 连续续行的最后一行。 */
  let end = i;
  while (end < lines.length - 1 && /\\\s*$/.test(String(lines[end] || ''))) end += 1;
  if (at > end) return null;
  const params = m[2] === undefined ? [] : m[2].split(',').map((s) => s.trim()).filter(Boolean);
  return { name: m[1], params, start: i, end };
}

/** 宏体形参 / `##` 拼接片段的一句说明；不是返回 ''。 */
function macroParamNoteOf(lines, line, column, want) {
  const blk = macroDefineBlockAt(lines, line);
  if (!blk) return '';
  if (blk.params.indexOf(want) >= 0) {
    return `\`${want}\` 是宏 \`${blk.name}\` 的形参，不是符号`;
  }
  const text = String(lines[Number(line) - 1] || '');
  const col = Number(column) || 0;
  if (col > 0) {
    const before = text.slice(0, col - 1).replace(/\s+$/, '');
    const after = text.slice(col - 1 + want.length).replace(/^\s+/, '');
    if (/##$/.test(before) || /^##/.test(after)) {
      return `\`${want}\` 是宏 \`${blk.name}\` 里 \`##\` 拼接出来的名字片段，不是符号`;
    }
  }
  return '';
}

/** 当前行之前的花括号深度是否为 0（= 文件作用域，排除函数体内的语句）。 */
function atFileScope(lines, line) {
  let depth = 0;
  let inBlock = false;
  const stop = Math.min(Number(line) - 1, lines.length);
  for (let i = 0; i < stop; i += 1) {
    let s = String(lines[i] || '');
    if (inBlock) {
      const close = s.indexOf('*/');
      if (close < 0) continue;
      s = s.slice(close + 2);
      inBlock = false;
    }
    s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const open = s.lastIndexOf('/*');
    if (open >= 0) { inBlock = true; s = s.slice(0, open); }
    s = s.replace(/\/\/.*$/, '')
      .replace(/"(?:\\.|[^"\\])*"/g, '""')
      .replace(/'(?:\\.|[^'\\])*'/g, "''");
    for (const ch of s) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
  }
  return depth === 0;
}

/**
 * 点击处是函数原型参数表里的形参 → `{ fn }`；否则 null。
 * 原型形参在头文件里没有"定义"（函数体在 .c 里），索引只给函数体形参建符号。
 */
function protoParamAt(lines, line, column, want, rel) {
  const at = Number(line) - 1;
  if (!(at >= 0 && at < lines.length)) return null;
  if (!atFileScope(lines, line)) return null;
  const col = Number(column) || 0;
  if (col <= 0) return null;
  const text = String(lines[at] || '').replace(/\/\/.*$/, '');
  const body = text.trim();
  /* 必须是**单行**、以 `;` 结尾、不含函数体花括号的声明。 */
  if (!/;$/.test(body) || body.indexOf('{') >= 0 || body.indexOf('}') >= 0) return null;
  const head = text.slice(0, col - 1);
  let depth = 0;
  let open = -1;
  for (let i = head.length - 1; i >= 0; i -= 1) {
    const ch = head[i];
    if (ch === ')') depth += 1;
    else if (ch === '(') {
      if (depth === 0) { open = i; break; }
      depth -= 1;
    }
  }
  if (open < 0) return null;
  const pre = head.slice(0, open).replace(/\s+$/, '');
  const m = /([A-Za-z_]\w*)$/.exec(pre);
  if (!m) return null;
  const fn = m[1];
  if (fn === want) return null;
  const ctrl = new Set(((tableFor(rel).lexical || {}).controlWords) || []);
  if (ctrl.has(fn)) return null;
  /* 函数名之前必须是声明前缀（返回类型 / 存储类），不能是表达式。 */
  const beforeFn = pre.slice(0, pre.length - fn.length);
  if (/[=(){},;]/.test(beforeFn)) return null;
  return { fn };
}

/**
 * 点击行位于"函数签名的延续区"（典型是 `__acquires(rq->lock)` 这类标注宏写
 * 在签名之后、函数体之前）时，返回函数体的结束行；否则 0。
 *
 * 这一区里的标识符属于**函数体作用域**，可点击行在函数体之前，
 * "声明必须在点击行之前"这条必然落空。判据只看结构，不看具体宏名。
 */
function signatureBodyEnd(lines, line) {
  const at = Number(line) - 1;
  if (!(at >= 0 && at < lines.length)) return 0;
  /* ① 上方最近的非空行里要出现过 `)`，且中间没有 `; { }`。 */
  let sawParen = false;
  for (let i = at - 1; i >= 0 && at - i <= 30; i -= 1) {
    const s = String(lines[i] || '').replace(/\/\/.*$/, '');
    if (s.trim() === '') continue;
    if (/;\s*$/.test(s) || s.indexOf('{') >= 0 || s.indexOf('}') >= 0) {
      if (!sawParen) return 0;
      break;
    }
    if (s.indexOf(')') >= 0) sawParen = true;
  }
  if (!sawParen) return 0;
  /* ② 下方到函数体 `{` 之间不能有 `;`（有就是一条独立语句）；然后配平花括号。 */
  let depth = 0;
  let started = false;
  let end = -1;
  for (let i = at; i < lines.length && i - at <= 4000; i += 1) {
    const s = String(lines[i] || '').replace(/\/\/.*$/, '');
    for (const ch of s) {
      if (ch === ';' && !started) return 0;
      if (ch === '}' && !started) return 0;
      if (ch === '{') { depth += 1; started = true; continue; }
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end >= 0) break;
  }
  return end >= 0 ? end + 1 : 0;
}

/**
 * 编译器内建 / C 标准库标识符的一句说明（没有就说空串）。
 *
 * `__func__` / `__LINE__` 这类名字由编译器在编译期给出，源码树里**没有定义**，
 * 按符号去索引里找永远是 0 条 —— 以前界面把它们说成"外部符号 / 未解析"，
 * 既不准确也没法解释（2026-11-16）。表在语言数据里
 * （lang/c.js 的 symbols.builtinIdentifiers），核心只查表。
 */
function builtinNoteOf(name, rel) {
  if (!name) return '';
  const t = (typeof LANG.tableForRel === 'function' ? LANG.tableForRel(rel) : null)
    || LANG.defaultTable() || {};
  const map = (t.symbols && t.symbols.builtinIdentifiers) || null;
  return (map && map[name]) || '';
}

async function findDefinition(name, rel, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const want = String(name || '').trim();
  if (!want) return { name: '', definitions: [], needsIndex: !currentIndex() };
  const d = ensureDb();
  if (!d) {
    const idx = currentIndex();
    if (!idx) return { name: want, definitions: [], needsIndex: true };
    return {
      name: want,
      definitions: (idx.symbols || []).filter((s) => s.name === want).slice(0, 40),
      needsIndex: false
    };
  }
  const pool = poolOf(d, rel);
  const line = Number(opts.line) || 0;
  const column = Number(opts.column) || 0;
  /* 非 C/C++ 语言先走通用解析；C 的专用规则仍留在原路径。 */
  const langId = LANG.entryFor ? String((LANG.entryFor(rel) || {}).id || '') : '';
  if (langId !== '' && langId !== 'c') {
    return findDefinitionGeneric(d, want, rel, line, pool);
  }
  let lines = null;
  const fileLines = async () => {
    if (lines !== null) return lines;
    try {
      const text = await ioFor(projectRoot).readText(pjoin(projectRoot, rel));
      lines = text.split(/\r?\n/);
    } catch {
      lines = [];
    }
    return lines;
  };
  const result = (definitions) => ({
    name: want,
    definitions,
    crossPool: false,
    needsIndex: false,
    layers: { l1: true, l2: !!l2, l3: !!l3 }
  });
  const withScope = (row, scope) => ({ ...row, scope });

  const lineText = line > 0 && rel !== '' ? String((await fileLines())[line - 1] || '') : '';
  const callee = lineText !== '' && isCalleeAt(lineText, column);
  const typeCtx = lineText !== '' && isTypeKeywordBefore(lineText, column);
  const recv = lineText !== '' && !typeCtx ? receiverExprAt(lineText, column) : '';

  /* 成员查询：给定 owner 类型名，找目标名字的成员。成员访问、指定初始化器、
     类型实参绑定三处共用。 */
  const membersOf = async (ownerName) => {
    let hits = mapSymbols(d, want, {
      parent: ownerName,
      kinds: ['member', 'enum_member', 'variable', 'field'],
      limit: 40
    }, pool)
      .slice()
      .sort((a, b) => definitionRank(a.file, rel) - definitionRank(b.file, rel));
    if (hits.length === 0 || definitionRank(hits[0].file, rel) > 1) {
      const synthetic = await memberFromTypeText(d, ownerName, want, rel, pool);
      if (synthetic !== null && !hits.some((m) => m.file === synthetic.file
        && m.line === synthetic.line && (m.parent || '') === (synthetic.parent || ''))) {
        hits.unshift(synthetic);
      }
    }
    return hits;
  };
  const pickBest = (members) => {
    const best = Math.min(...members.map((s) => definitionRank(s.file, rel)));
    return best <= 2 ? members.filter((s) => definitionRank(s.file, rel) === best) : members;
  };

  /* 0a) 指定初始化器 `.field = value`：`.field` 没有接收者，容器类型来自
        外层初始化器（`= {` 的声明/数组元素、`(struct T){` 的复合字面量）。
        纯语法推导，不认具体类型名。
        必须放在成员访问之前：`receiverExprAt` 会把 `{ .field` 里的 `{`
        当成接收者表达式。`designatorOwnerAt` 对 `x.field` 返回空，不会误吞。 */
  if (rel !== '' && line > 0 && lineText !== '') {
    const beforeClick = lineText.slice(0, Math.max(0, column - 1)).replace(/[A-Za-z_]\w*$/, '');
    if (/\.\s*$/.test(beforeClick)) {
      const allLines = await fileLines();
      const owner = designatorOwnerAt(allLines.join('\n'), offsetOfLineColumn(allLines, line, column));
      if (owner !== '') {
        const members = await membersOf(owner);
        if (members.length > 0) return result(pickBest(members).map((s) => withScope(s, 'global')));
      }
    }
  }

  /* 0) 成员访问 `x->field` / `x.field` / `a->b.c`：解析接收者表达式类型，再按 owner 查成员。 */
  if (recv !== '') {
    const expr = lastOperand(recv).trim();
    /* 接收者类型：AST 有这项成员访问时按 shape 推导（数组下标/指针/调用/cast 都是
       AST 结构，不靠正则猜），否则退回原来的文本推导。 */
    let astScope = null;
    try { astScope = await localScope.lookup(rel); } catch { astScope = null; }
    const memberInfo = astScope === null ? null : localScope.findMemberAt(astScope, line, column);
    /* 两条推导路都留着：AST 的 shape 对数组下标 / 调用 / cast 最准，但对**链式**
       接收者（`skb->dev->name`）可能只给出最外层类型（sk_buff）；文本推导反而能
       沿 `->` 走到底。所以不是"先到先得"，而是**哪个能查到成员就用哪个**。 */
    let astBaseType = '';
    if (memberInfo !== null) {
      astBaseType = await resolveReceiverType(d, memberInfo.shape, {
        rel, line, column, pool, scope: astScope, depth: 0
      });
    }
    const textBaseType = expr === '' ? '' : await baseTypeOfExpr(d, expr, rel, line, pool, 0);
    const owners = [];
    for (const candidate of [astBaseType, textBaseType]) {
      const one = baseTypeName(candidate) || candidate;
      if (one !== '' && owners.indexOf(one) < 0) owners.push(one);
    }
    if (owners.length === 0) {
      /* 标注宏（`__acquires(rq->lock)`）写在函数签名之后、函数体之前：里面的
         `rq` 是函数体内的局部变量，按"声明必须在点击行之前"去找必然落空。
         把作用域基准推到函数体末尾再试一次 —— 纯结构判定，不认具体宏名。 */
      const scopeLine = signatureBodyEnd(await fileLines(), line);
      if (scopeLine > line) {
        const retry = await baseTypeOfExpr(d, expr, rel, scopeLine, pool, 0);
        const one = baseTypeName(retry) || retry;
        if (one !== '' && owners.indexOf(one) < 0) owners.push(one);
      }
    }
    if (owners.length === 0) {
      return { ...result([]), status: 'unresolved', reason: `无法解析接收者 \`${expr}\` 的类型` };
    }
    let base = owners[0];
    let owner = base;
    let members = [];
    for (const candidate of owners) {
      members = await membersOf(candidate);
      if (members.length > 0) { base = candidate; owner = candidate; break; }
      /* typedef 别名（`skb_frag_t` → `struct bio_vec`）：成员挂在被指向的结构体下面，
         跟随一次再查（内核 include/ 里就有 638 个 typedef struct）。 */
      const alias = typedefTargetOf(d, candidate, pool);
      if (alias !== '') {
        members = await membersOf(alias);
        if (members.length > 0) { base = candidate; owner = alias; break; }
      }
    }
    if (members.length > 0) {
      const best = Math.min(...members.map((s) => definitionRank(s.file, rel)));
      if (best <= 2) members = members.filter((s) => definitionRank(s.file, rel) === best);
      return result(members.map((s) => withScope(s, 'global')));
    }
    /* `x->tw_daddr` 这类**字段式宏**：接收者结构体里没有这个成员，
       但索引里有同名宏；宏体是 `__tw_common.skc_daddr`，按路径解析到真实成员。 */
    const mac = mapSymbols(d, want, { kinds: ['macro'], limit: 20 }, pool)
      .slice()
      .sort((a, b) => definitionRank(a.file, rel) - definitionRank(b.file, rel));
    if (mac.length > 0) {
      const defs = mac.map((s) => withScope(s, 'global'));
      const target = await memberFromMacroBody(d, mac[0], base, rel, pool);
      if (target !== null) defs.push(withScope(target, 'global'));
      return result(defs);
    }
    return {
      ...result([]),
      status: 'unresolved',
      reason: owner !== base
        ? `\`${base}\`（→ \`${owner}\`）里没有成员 \`${want}\``
        : `\`${base}\` 里没有成员 \`${want}\``
    };
  }
  /* 0b) 类型实参绑定：`f(..., struct T, field)` —— 前一个顶层实参是类型时，
        当前实参按该类型的成员解析。`offsetof` / `container_of` 以及任何
        自定义的“类型+成员”宏都走这一条，规则里没有宏名。 */
  if (recv === '' && rel !== '' && line > 0 && lineText !== '') {
    const beforeClick = lineText.slice(0, Math.max(0, column - 1)).replace(/[A-Za-z_]\w*$/, '');
    if (beforeClick.indexOf('(') >= 0) {
      const allLines = await fileLines();
      const owner = typeArgumentOwnerAt(allLines.join('\n'), offsetOfLineColumn(allLines, line, column));
      if (owner !== '' && await isTypeNameIn(d, owner, pool)) {
        const members = await membersOf(owner);
        if (members.length > 0) return result(pickBest(members).map((s) => withScope(s, 'global')));
      }
    }
  }

  /* 0c) goto 标签：C 的标签是独立命名空间，不是符号。
         `goto X;` 的目标和 `X:` 的定义都给说明屏，不落到"未解析"。 */
  if (lineText !== '') {
    const gotoHit = /\bgoto\s+([A-Za-z_]\w*)\s*;/.exec(lineText);
    const labelDef = /^\s*([A-Za-z_]\w*)\s*:(?!:)/.exec(lineText);
    if ((gotoHit !== null && gotoHit[1] === want) || (labelDef !== null && labelDef[1] === want)) {
      return { ...result([]), status: 'label', reason: `\`${want}\` 是 goto 标签，不是符号` };
    }
  }

  /* 1) 类型位置：`struct sock *sk` 里点 sock → 类型定义。 */
  if (typeCtx) {
    const typeHits = mapSymbols(d, want, {
      kinds: ['struct', 'union', 'enum', 'typedef', 'type', 'class', 'interface'],
      limit: 60
    }, pool);
    if (typeHits.length > 0) return result(typeHits.map((s) => withScope(s, 'global')));
  }

  /* 2) 调用点：`foo(` → 只可能是函数或宏。 */
  if (callee) {
    const callables = mapSymbols(d, want, { kinds: ['function', 'macro'], limit: 80 }, pool)
      .sort((a, b) => (a.prototype ? 1 : 0) - (b.prototype ? 1 : 0));
    if (callables.length > 0) {
      const text = await fileLines();
      const statics = callables.filter((s) => s.file === rel && /\bstatic\b/.test(String(text[s.line - 1] || '')));
      if (statics.length > 0) return result(statics.map((s) => withScope(s, 'file')));
      return result(callables.map((s) => withScope(s, 'global')));
    }
  }

  /* 3) 局部变量 / 参数：优先 AST 作用域（缓存命中时零解析），
        未命中先用文本扫描兜底，同时在后台补一份 AST，后续点击走 AST。 */
  if (rel !== '' && line > 0) {
    let ast = null;
    try {
      ast = await localScope.lookup(rel);          /* 只读缓存，绝不等 worker */
    } catch { ast = null; }
    if (ast !== null) {
      const hit = localScope.query(ast, want, line, column);
      if (hit !== null) return result([{ ...astDefinition(ast, rel, hit), scope: 'local' }]);
    }
    const local = await localDeclarationInFile(d, rel, want, line, pool);
    if (local !== null) {
      if (ast === null) localScope.enqueue(rel);
      return result([{ ...local, scope: 'local' }]);
    }
    if (ast === null) localScope.enqueue(rel);
  }

  /* 4) 本文件 static / 本文件定义。 */
  const fileHits = rel !== ''
    ? mapSymbols(d, want, { fileRel: rel, limit: 50 }, pool)
    : [];
  const fileDefs = fileHits.filter((s) => !s.prototype && isGloballyVisibleSymbol(s));
  if (fileDefs.length > 0) {
    const text = await fileLines();
    const statics = fileDefs.filter((s) => /\bstatic\b/.test(String(text[s.line - 1] || '')));
    if (statics.length > 0) return result(statics.map((s) => withScope(s, 'file')));
  }

  /* 5) 全局：所有同名定义（类型/函数/宏优先），去重后列出。 */
  const typeHits = mapSymbols(d, want, {
    kinds: ['struct', 'union', 'enum', 'typedef', 'type', 'class', 'interface'],
    limit: 60
  }, pool);
  const callableHits = mapSymbols(d, want, { kinds: ['function', 'macro'], limit: 80 }, pool);
  const plainHits = mapSymbols(d, want, { limit: 200 }, pool).filter((s) => isGloballyVisibleSymbol(s));
  const ordered = [];
  const seen = new Set();
  const push = (s, scope) => {
    const key = `${s.file}:${s.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push(withScope(s, scope));
  };
  for (const s of fileDefs) push(s, 'global');
  for (const list of [typeHits, callableHits, plainHits]) {
    for (const s of list) {
      if (!isGloballyVisibleSymbol(s)) continue;
      push(s, 'global');
    }
  }
  if (ordered.length > 0) return result(ordered.slice(0, 200));
  if (fileHits.length > 0) return result(fileHits.map((s) => withScope(s, 'file')));
  const rest = mapSymbols(d, want, { limit: 40 }, pool)
    .filter((s) => isGloballyVisibleSymbol(s))
    .map((s) => withScope(s, 'global'));
  if (rest.length > 0) return result(rest);
  /* 编译器内建 / 标准库：索引里确实没有，但它不是"外部符号"，也不是解析失败
     （见 builtinNoteOf）。**只在所有索引回退之后**才用它 —— 索引里真有同名
     定义时永远优先。 */
  /* 宏体形参 / `##` 拼接片段 / 函数原型形参：源码里确实没有定义，但这是
     "它不是符号"，不是"解析失败"（与 builtin 同一类处理，2026-11-17）。 */
  if (line > 0) {
    const textLines = await fileLines();
    const macroParam = macroParamNoteOf(textLines, line, column, want);
    if (macroParam !== '') {
      return { ...result([]), status: 'macroParam', note: macroParam };
    }
    const proto = protoParamAt(textLines, line, column, want, rel);
    if (proto !== null) {
      const defs = mapSymbols(d, proto.fn, { kinds: ['function'], limit: 40 }, pool)
        .filter((s) => !s.prototype);
      const items = defs.slice(0, 6).map((s) => ({
        file: s.file, line: s.line, name: proto.fn, kind: 'function'
      }));
      return {
        ...result([]),
        status: 'protoParam',
        note: `\`${want}\` 是函数 \`${proto.fn}\` 原型里的形参；形参的"定义"在函数实现里`,
        items,
        target: items[0] || null
      };
    }
  }
  const builtinNote = builtinNoteOf(want, rel);
  if (builtinNote !== '') return { ...result([]), status: 'builtin', note: builtinNote };
  return result([]);
}

/** Which layers are live for this project, so the UI can say so out loud. */
function analysisLayers() {
  const idx = currentIndex();
  return {
    l1: !!idx,
    l2: l2
      ? { ready: true, source: l2.source, files: l2.files, defines: l2.defines.size, hasConfig: l2.hasConfig }
      : { ready: false },
    l3: l3
      ? { ready: true, source: l3.source, types: l3.types, structs: l3.structs, functions: l3.functions }
      : { ready: false },
    /* L4：这次索引用的增强包。装的是 v2、索引建于 v1 时，这两个版本号不一样 ——
       界面据此提示「重建索引后生效」，而不是让用户以为规则没写对。 */
    l4: idx && idx.enhance
      ? { ready: true, id: idx.enhance.id || '', version: idx.enhance.version || '', errors: (idx.enhanceErrors || []).length }
      : { ready: false }
  };
}

/* ------------------------------------------------------------- L4 增强包

   读 / 写 / 预演 / 报告。解析器的消费在 ts-indexer.setEnhance()，这里只管
   项目级别的四件事：这个包在哪、装的是什么、换成新的会怎样、索引没看懂什么。 */

/** 读项目里的增强包。文件不存在是正常状态，不是错误。 */
async function readEnhancePack(root) {
  const file = pjoin(root, enhance.PACK_REL);
  let text = '';
  try {
    text = await ioFor(root).readText(file);
  } catch {
    return { pack: null, errors: [], file: enhance.packPathOf(root), present: false };
  }
  const r = enhance.parseText(text);
  return { pack: r.pack, errors: r.errors, file: enhance.packPathOf(root), present: true, ok: r.ok };
}

/** 当前项目装的包 + 索引里记录的包。 */
async function enhanceStatus() {
  const root = projectRoot;
  if (!root) return { ok: false, errors: ['尚未打开项目'] };
  const cur = await readEnhancePack(root);
  const idx = currentIndex();
  return {
    ok: cur.pack !== null,
    present: cur.present,
    path: cur.file,
    errors: cur.errors || [],
    pack: enhance.statusOf(cur.pack),
    builtWith: (idx && idx.enhance) || null,
    /* 按效果计数（v2）：一条规则可能既造符号又当容器，数组计数没有意义。 */
    rules: enhance.statusOf(cur.pack),
    /* 规则名清单 + 本次索引的命中数：面板据此标出"×0 没命中"的规则。 */
    names: cur.pack ? cur.pack.macros.map((m) => m.name) : [],
    hits: (idx && idx.ruleHits) || null,
    /* 自动推导的记录：面板顶部显示"工具已经做了多少"（2026-10-23）。 */
    deriveLog: await readDeriveLog(root)
  };
}

/**
 * 报告给 AI 的宏体（**只带 `##` 的那些**）。
 *
 * 没有 `#define` 的原文，AI 只能猜名字怎么拼 —— 而拼法只能从宏体里抄
 * （`dev_attr_##_name` 是前缀，`##_fops` 是后缀）。普通宏按参数下标就能写，
 * 带了只是把报告撑大一倍（2026-10-22）。
 */
async function reportDefines(idx, root) {
  const defines = {};
  try {
    const d = ensureDb();
    if (!d) return defines;
    const names = (idx.issues || []).slice(0, 3000).map((it) => it.name);
    /* 形参表不在索引里（列式格式没这一列），从**定义那一行原文**取；
       同一个头文件会被反复用到，所以按文件缓存一次。 */
    const fileLines = new Map();
    const io = ioFor(root);
    for (const n of names) {
      const hit = mapSymbols(d, n, { kinds: ['macro'], limit: 1 }, null)[0];
      if (!hit || hit.value === undefined) continue;
      if (String(hit.value || '').indexOf('##') < 0) continue;
      let lines = fileLines.get(hit.file);
      if (!lines) {
        try { lines = (await io.readText(pjoin(root, hit.file))).split(/\r?\n/); }
        catch { lines = []; }
        fileLines.set(hit.file, lines);
      }
      const raw = lines[hit.line - 1] || '';
      const m = /^\s*#\s*define\s+[A-Za-z_]\w*\s*(\([^)]*\))?/.exec(raw);
      const params = (m && m[1]) ? m[1] : '';
      defines[n] = ('#define ' + n + params + ' ' + String(hit.value || ''))
        .replace(/\\\s*$/, '').replace(/\s+/g, ' ').trim().slice(0, 120);
    }
  } catch { /* 没有二进制索引时就不带宏体，报告照常 */ }
  return defines;
}

/** 索引报告：工具没看懂什么 + 给 AI 的格式说明。 */
async function enhanceReport(lang) {
  const root = projectRoot;
  if (!root) return { ok: false, errors: ['尚未打开项目'] };
  const idx = currentIndex();
  if (!idx) return { ok: false, errors: ['还没有索引：请先建立索引'] };
  const defines = await reportDefines(idx, root);

  const text = enhance.reportText(idx, {
    project: path.basename(String(root).replace(/[\\/]+$/, '')) || root,
    /* 绝对路径给 agent 用（它要把文件写到那儿），不用猜项目根。 */
    rootPath: root,
    defines,
    lang: lang === 'en' ? 'en' : 'zh'
  });
  return {
    ok: true,
    text,
    count: (idx.issues || []).reduce((n, it) => n + (it.count || 1), 0),
    kinds: (idx.issues || []).length,
    /* 旧索引没有这个标记 —— 界面上要说"需重建"，不能说"未看懂 0 处"。 */
    scanned: idx.issuesScanned === true
  };
}

/**
 * 把报告写到 `<项目>/.kernelscope/report.txt`。
 *
 * WHY 要落盘：报告是给 AI / Agent 的需求书，agent 能直接读文件，就不用人工
 * 复制粘贴（2026-10-22）。写在同一目录下，和增强包放一起，便于一起提交。
 */
async function enhanceExportReport(lang) {
  const root = projectRoot;
  if (!root) return { ok: false, errors: ['尚未打开项目'] };
  const idx = currentIndex();
  if (!idx) return { ok: false, errors: ['还没有索引：请先建立索引'] };
  const project = path.basename(String(root).replace(/[\\/]+$/, '')) || root;
  const zh = lang === 'en' ? 'en' : 'zh';
  const text = enhance.reportText(idx, {
    project, rootPath: root, defines: await reportDefines(idx, root), lang: zh
  });

  /* 待解析台账（E2，2026-10-22）：和报告同一份数据、同一个按钮，**没有面板
     也要先有文件**。它比报告多要两样东西 —— 所有名字的宏体（分类用，不只
     `##` 的）与包里 AI 写的备注（⟨AI⟩）。 */
  const names = (idx.issues || []).slice()
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .slice(0, 3000).map((it) => it.name);
  let defs = {};
  try { defs = Object.fromEntries(await macroDefsFor(names)); }
  catch { /* 没有二进制索引就不带宏体，台账照常 */ }
  const pack = (await readEnhancePack(root)).pack;
  const notes = {};
  if (pack) for (const m of pack.macros) if (m.note) notes[m.name] = m.note;
  const pend = enhance.pendingText(idx, { project, defs, notes, lang: zh });

  const file = enhance.reportPathOf(root);
  const pfile = enhance.pendingPathOf(root);
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, text, 'utf8');
    await fs.promises.writeFile(pfile, pend, 'utf8');
  } catch (err) {
    return { ok: false, errors: ['写文件失败：' + ((err && err.message) || err)] };
  }
  return {
    ok: true, path: file, bytes: Buffer.byteLength(text, 'utf8'),
    pending: pfile, pendingBytes: Buffer.byteLength(pend, 'utf8')
  };
}

/**
 * 预演：拿这份配置，对 40 个样本文件重新解析一遍，报「会多/少什么」。
 *
 * WHY 用样本而不是全量：全量要重建索引（分钟级），而用户要判断的是"这份配置
 * 有没有把我的代码读歪"。40 个来自报告点名的文件，足以让写错的下标当场露馅
 * （比如把 `decl: 0` 写成 `decl: 1`，抽样的第一行就会变成"新增符号叫 struct mutex"）。
 */
/** 取若干宏的定义（形参 + 宏体），按文件缓存读取。
 *
 *  `preferRel`：同名宏在不同文件里有不同定义（`container_of` 有 nouveau 版本、
 *  `WARN_ON` 有各 arch 版本）。给出调用点所在文件时按"通用程度"挑：
 *  同文件 > include/linux/ > include/ > 其他 > arch/。 */
async function macroDefsFor(names, preferRel) {
  const out = new Map();
  const root = projectRoot;
  const d = ensureDb();
  if (!d || !root) return out;
  const cache = new Map();
  const io = ioFor(root);
  const rank = (h) => {
    const f = String(h.file || '');
    if (preferRel && f === preferRel) return 0;
    if (f.startsWith('include/linux/')) return 1;
    if (f.startsWith('include/')) return 2;
    if (f.startsWith('arch/')) return 4;
    return 3;
  };
  for (const n of names) {
    const hits = mapSymbols(d, n, { kinds: ['macro'], limit: 8 }, null);
    if (!hits.length) continue;
    hits.sort((a, b) => rank(a) - rank(b));
    const hit = hits[0];
    let lines = cache.get(hit.file);
    if (!lines) {
      try { lines = (await io.readText(pjoin(root, hit.file))).split(/\r?\n/); }
      catch { lines = []; }
      cache.set(hit.file, lines);
    }
    const raw = lines[hit.line - 1] || '';
    const m = /^\s*#\s*define\s+[A-Za-z_]\w*\s*(\([^)]*\))?/.exec(raw);
    const params = (m && m[1])
      ? m[1].slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean) : [];
    out.set(n, { params, body: String(hit.value || ''), file: hit.file, line: hit.line });
  }
  return out;
}

/* ------------------------------------------------------------------ 宏展开
 *
 * 给阅读器"这一次调用展开成什么"的弹窗用。**单层**，不递归 —— 多层
 * （ATOMIC_OPS → ATOMIC_OP → atomic_##op）需要隐藏集，等真有需求再说。
 * 只做三件事：`##` 拼接、`#` 字符串化、形参替换；其余原样保留。
 */

/** 按顶层逗号切实参（括号/方括号/花括号里的逗号不算）。 */
function splitTopArgs(text) {
  const s = String(text || '');
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out.map((t) => t.trim()).filter((t) => t.length > 0);
}

/** 宏体 + 形参 + 实参 → 展开文本（单层）。 */
function renderExpansion(body, params, args) {
  const map = new Map();
  (params || []).forEach((p, i) => map.set(p, args[i] === undefined ? '' : String(args[i]).trim()));
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let text = String(body || '').replace(/\\\s*\n\s*/g, ' ');
  /* `#param` 字符串化：只对形参生效。 */
  text = text.replace(/#\s*([A-Za-z_]\w*)/g, (m, n) => (map.has(n) ? JSON.stringify(map.get(n)) : m));
  /* `a ## b`：两侧先换成实参再粘。 */
  text = text.replace(/([A-Za-z_]\w*)\s*##\s*([A-Za-z_]\w*)/g, (m, a, b) => {
    const va = map.has(a) ? map.get(a) : a;
    const vb = map.has(b) ? map.get(b) : b;
    return va + vb;
  });
  /* 剩余形参一次替换，避免"实参里含形参名"被二次替换。 */
  const names = (params || []).filter(Boolean);
  if (names.length) {
    const re = new RegExp('\\b(?:' + names.map(escRe).join('|') + ')\\b', 'g');
    text = text.replace(re, (m) => (map.has(m) ? map.get(m) : m));
  }
  /* 续行拼接留下成片的制表符/空格，压成单个空格 —— 展开结果本来就是一行。 */
  return text.replace(/[ \t]+/g, ' ').trim();
}

/** 一次宏调用的展开结果（读调用处的实参原文）。 */
async function expandMacro(want, rel, opts) {
  const line = Number(opts && opts.line) || 0;
  const column = Number(opts && opts.column) || 0;
  if (!want || !rel || line <= 0) return { ok: false, reason: '需要一个具体位置' };
  const def = (await macroDefsFor([want], rel)).get(want);
  if (!def) return { ok: false, reason: `索引里没有 \`${want}\` 的对象宏定义` };

  let args = [];
  try {
    const text = await ioFor(projectRoot).readText(pjoin(projectRoot, rel));
    const lines = text.split(/\r?\n/);
    const from = (lines[line - 1] || '').slice(Math.max(0, column - 1));
    const open = from.indexOf('(');
    if (open >= 0) {
      const joined = [from.slice(open + 1)].concat(lines.slice(line, line + 20)).join('\n');
      let depth = 1;
      let end = -1;
      for (let i = 0; i < joined.length; i += 1) {
        const ch = joined[i];
        if (ch === '(') depth += 1;
        else if (ch === ')') { depth -= 1; if (depth === 0) { end = i; break; } }
      }
      if (end >= 0) args = splitTopArgs(joined.slice(0, end));
    }
  } catch { /* 读不到调用处就按空实参展开 */ }

  return {
    ok: true,
    macro: want,
    params: def.params,
    args,
    body: def.body,
    text: renderExpansion(def.body, def.params, args),
    def: { file: def.file, line: def.line },
  };
}

/**
 * 规则体检 —— **机械检查，不靠人眼**。
 *
 * 用户的工作流是「复制报告 → AI 生成 → 粘回来 → 应用」，中间没有人审。所以
 * "AI 把 `dev_attr_##_name` 写成 `$0_attr`" 这种错必须由工具在落盘前挡住：
 *
 *   1. 项目里没有这个宏的 `#define`  → 这条规则只会 0 命中，拒收；
 *   2. 带参数的宏用了 `mask`         → 抹名会把同名字段/参数一起抹掉，拒收；
 *   3. `pattern` 与宏体的 `##` 不符   → 造出来的名字源码里根本不存在，拒收，
 *                                      并把按宏体算出来的正确写法告诉用户。
 *
 * 第 3 条只在「拼法唯一」时才判（宏体里只有一处 `##` 且有一侧是形参），
 * `DEFINE_PER_CPU_SECTION` 那种一个宏体好几处 `##` 的不判 —— 说不清哪个是符号名。
 */
async function auditPack(pack) {
  const errors = [];
  if (!pack || !pack.macros.length) return errors;
  /* 只有 note 的规则不参与解析，没什么可体检的 —— 它也**不该**被"宏不存在"
     挡住：备注正是用来解释"为什么没有规则"的（E3，2026-10-22）。 */
  const active = pack.macros.filter((m) => m.mask || m.declare.length || m.container);
  if (!active.length) return errors;
  const defs = await macroDefsFor(active.map((m) => m.name));
  for (const r of active) {
    const def = defs.get(r.name);
    if (!def) {
      errors.push(r.name + '：项目里找不到这个宏的 #define（这条规则会 0 命中）');
      continue;
    }
    if (r.mask) {
      if (def.params.length) {
        errors.push(r.name + '：这是**带参数**的宏，不能用 mask —— 抹名是词法的，'
          + '会把同名字段/参数一起抹掉；要造符号用 declare；语句宏请写一条只有 note 的备注');
      }
      continue;
    }
    for (const spec of r.declare) {
      if (!spec.pattern) continue;
      const cands = enhance.derivePatterns(def.body, def.params);
      if (cands.length !== 1) continue;
      const want = spec.pattern.replace(/\s+/g, '');
      if (cands[0] !== want) {
        errors.push(r.name + '：pattern "' + spec.pattern + '" 与宏体不符 —— 宏体是 `'
          + def.body.replace(/\s+/g, ' ').slice(0, 64) + '…`，按它应为 "' + cands[0] + '"');
      }
    }
  }
  return errors;
}

async function enhancePreview(text) {
  const root = projectRoot;
  if (!root) return { ok: false, errors: ['尚未打开项目'] };
  const parsed = enhance.parseText(text);
  if (!parsed.pack) return { ok: false, errors: parsed.errors.length ? parsed.errors : ['配置无效'] };

  const idx = currentIndex();
  if (!idx) return { ok: false, errors: ['还没有索引：请先建立索引（预演要用它做对照）'] };

  /* 先做机械体检，再跑样本 —— 两者互不依赖，但体检结论必须最先看到。 */
  const audit = await auditPack(parsed.pack);

  /* 取样：报告点名的文件优先（规则最可能在那儿生效），其余用**等距抽样**补齐。
     等距而不是"取前 N 个"：索引里的文件是按遍历顺序排的，取前 N 个等于只测
     第一个子系统，抽样结论会系统性偏乐观（2026-10-21 改）。 */
  const limit = isRemoteRoot(root) ? 40 : 80;
  const files = [];
  const seen = new Set();
  for (const it of (idx.issues || [])) {
    if (!it.file || seen.has(it.file)) continue;
    seen.add(it.file);
    files.push(it.file);
    if (files.length >= limit) break;
  }
  const pool = idx.files.filter((f) => /\.(c|h)$/.test(f.rel) && !seen.has(f.rel));
  const want = limit - files.length;
  if (want > 0 && pool.length) {
    const step = Math.max(1, Math.floor(pool.length / want));
    for (let i = 0; i < pool.length && files.length < limit; i += step) {
      if (!seen.has(pool[i].rel)) { seen.add(pool[i].rel); files.push(pool[i].rel); }
    }
  }

  /* 从磁盘加载的索引不会初始化解析器：预演要真的解析，先确保 wasm 就绪。 */
  try { await tsIndex.ensureReady(); } catch (err) {
    return { ok: false, errors: ['tree-sitter 不可用：' + ((err && err.message) || err)] };
  }

  const io = ioFor(root);
  /* 对照的是**当前装着的**那份（磁盘上的），不是内存里某次构建的残留：
     用户看到的"现在的效果"就是他上次粘贴进来的那份。 */
  const prevPack = (await readEnhancePack(root)).pack;
  let added = 0, removed = 0, changed = 0;
  const samples = [];
  try {
    for (const rel of files) {
      let src;
      try { src = await io.readText(pjoin(root, rel)); } catch { continue; }

      tsIndex.setEnhance(prevPack);
      let before;
      try { before = tsIndex.extract(src, rel); } catch { continue; }
      tsIndex.setEnhance(parsed.pack);
      let after;
      try { after = tsIndex.extract(src, rel); } catch { continue; }

      const key = (s) => s.kind + '|' + s.name + '|' + s.line;
      const B = new Set(before.symbols.map(key));
      const A = new Set(after.symbols.map(key));
      let touched = 0;
      for (const k of A) if (!B.has(k)) { added++; touched++; if (samples.length < 8) samples.push({ file: rel, op: '+', text: k.replace(/\|/g, '  ') }); }
      for (const k of B) if (!A.has(k)) { removed++; touched++; if (samples.length < 8) samples.push({ file: rel, op: '-', text: k.replace(/\|/g, '  ') }); }
      if (touched) changed++;
    }
  } finally {
    /* 预演绝不能改变"现在生效的包"——它只是一次试算。 */
    tsIndex.setEnhance(prevPack);
  }

  return {
    ok: true,
    errors: parsed.errors,
    /* 机械体检的结论：拼错 / 带参宏用 mask / 宏不存在。落盘时同样会挡。 */
    audit,
    rules: enhance.statusOf(parsed.pack),
    sampled: files.length,
    totalFiles: idx.files.length,
    changed,
    added,
    removed,
    samples,
    path: enhance.packPathOf(root)
  };
}

/**
 * E1（工具推导，2026-10-23）：对报告里点名的宏，从 `#define` 反推规则。
 *
 * 三道关，缺一不可：
 *   ① 机械判据（`macro-derive.deriveFromDef`）：宏体唯一 `##` 或"类型 + 形参"；
 *   ② **交叉验证**：拿报告里的调用样本当参数，拼出名字，这个名字必须真的在
 *      索引里查得到 —— 没有它，任何 pattern 都能自圆其说；
 *   ③ 不覆盖已有规则：包里已有的宏直接跳过（人工/AI 写的优先）。
 *
 * 产物是「现有包 + 新推导规则」的合并 JSON，**不自动写盘**：仍然要用户预演、
 * 应用（人是最后一道闸）。
 */
async function enhanceDerive() {
  const root = projectRoot;
  if (!root) return { ok: false, errors: ['尚未打开项目'] };
  const idx = currentIndex();
  if (!idx) return { ok: false, errors: ['还没有索引：请先建立索引'] };
  const d = ensureDb();
  if (!d) return { ok: false, errors: ['二进制索引不可用（请重建索引）'] };

  const cur = (await readEnhancePack(root)).pack;
  const have = new Set(cur ? cur.macros.map((m) => m.name) : []);

  /* 候选 = 报告里出现过的宏（按次数降序），已有的规则不再重复推导。 */
  const names = [];
  const sampleOf = new Map();
  for (const it of (idx.issues || [])) {
    if (!it || !it.name) continue;
    if (it.sample && !sampleOf.has(it.name)) sampleOf.set(it.name, it.sample);
  }
  for (const it of (idx.issues || []).slice().sort((a, b) => (b.count || 0) - (a.count || 0))) {
    if (!it || !it.name || have.has(it.name) || names.indexOf(it.name) >= 0) continue;
    names.push(it.name);
    if (names.length >= 3000) break;
  }

  const defs = await macroDefsFor(names);
  const table = ((LANG.defaultTable() || {}).syntax || {}).macroDerive || {};
  const derived = [];
  const skipped = [];
  for (const n of names) {
    /* 内置表已经认识的宏不推导：包会**覆盖**内置规则，推一条粗的盖掉细的，
       只会更差（内置表还带 typeArg/member 这些关系）。 */
    if (KM.MACROS.has(n)) { skipped.push({ name: n, why: '内置表已经认识这个宏' }); continue; }
    const def = defs.get(n);
    if (!def) { skipped.push({ name: n, why: '项目里没有 #define' }); continue; }
    const r = derive.deriveFromDef({ name: n, params: def.params, body: def.body }, table);
    if (!r.rule) { skipped.push({ name: n, why: r.why }); continue; }
    /* 同名宏在这个项目里有多份 `#define`（不同 arch/子系统各定义一次）→ 语义可能
       不同，一条规则套全项目只会把别的文件读歪。宁可不推导（2026-10-23 实测：
       `MAKE_REG` 就有一份是 `SIGN_##s`、另一份是初始化列表）。 */
    const allDefs = mapSymbols(d, n, { kinds: ['macro'], limit: 8 }, null) || [];
    if (allDefs.length > 1) {
      skipped.push({ name: n, why: '同名宏有 ' + allDefs.length + ' 份 #define，含义可能不同，不自动推导' });
      continue;
    }
    /* 交叉验证：样本参数 → 生成的名字 → 索引里必须存在。
       一条规则可能声明多个名字（`x##_show` + `x##_store`）→ **每个**都要验过。 */
    const args = argsFromSample(sampleOf.get(n) || '', n);
    const made = [];
    let why = '';
    for (const spec of r.rule.declare) {
      const cand = spec.pattern ? derive.fillPattern(spec.pattern, args) : (args[spec.arg] || '');
      if (!cand || !/^[A-Za-z_]\w*$/.test(cand)) { why = '没有可用的调用样本，无法交叉验证'; break; }
      let hits = mapSymbols(d, cand, { limit: 4 }, null) || [];
      if (!hits.length) {
        /* 定义查不到时，**引用**也算证据：`DEVICE_ATTR_RO(status)` 生成的
           `dev_attr_status` 在源码里没有定义（定义就是宏本身），但到处是
           `&dev_attr_status.attr` 这类引用 —— 实测 27 处（2026-10-23）。
           没有这条，ATTR 这一大族永远过不了交叉验证。 */
        const rr = await findReferences(cand, '');
        if ((rr.references || []).length) hits = [{ kind: 'reference' }];
      }
      if (!hits.length) {
        why = '生成名 ' + cand + ' 在索引里查不到（交叉验证失败）';
        break;
      }
      /* 生成的名字**本身是另一个宏**（`ASPM_STATE_##state` → `ASPM_STATE_L0S`）
         → 这是在引用，不是在声明。照抄成 declare 会在每个调用点造一个重复符号。 */
      if (hits.every((h) => h.kind === 'macro')) {
        why = '生成名 ' + cand + ' 是另一个宏（引用而非声明）';
        break;
      }
      made.push(cand);
    }
    if (why) { skipped.push({ name: n, why }); continue; }
    derived.push({ name: n, rule: r.rule, evidence: r.evidence, sample: made.join(' / ') });
  }

  /* 老规则里 `type` 为空的，用**宏体**补一次（noType 5,449 → 931 之后剩下的那批）。
     只补 `type`，不动 pattern/arg 结构；读不出明确类型就不补 —— 补错的代价是
     Context 行显示一个错类型，比空着更难发现（2026-10-23）。 */
  let typesFilled = 0;
  if (cur) {
    const need = cur.macros.filter((m) => (m.declare || []).some((d) => !d.type));
    if (need.length) {
      const d2 = await macroDefsFor(need.map((m) => m.name));
      for (const m of need) {
        const def = d2.get(m.name);
        if (!def) continue;
        const body = String(def.body || '').replace(/\s+/g, ' ').trim();
        const groups = derive.gluedGroups(body, def.params);
        const pd = derive.paramDeclOf(body, def.params, table);
        for (const d of m.declare) {
          if (d.type) continue;
          let t = '';
          if (d.pattern) {
            const g = groups.find((x) => x.pattern === d.pattern);
            if (g) t = derive.typeBeforeAt(body, g.start, table);
          } else if (pd && pd.arg === d.arg) {
            t = pd.type;
          }
          if (t) { d.type = t; typesFilled++; }
        }
      }
    }
  }

  const pack = {
    schema: 'ks-enhance/2',
    id: cur ? (cur.id || '') : (path.basename(String(root).replace(/[\\/]+$/, '')) || 'project'),
    version: cur ? (cur.version || '1') : '1',
    macros: (cur ? cur.macros.slice() : [])
      .concat(derived.map((x) => Object.assign({ name: x.name }, x.rule)))
  };
  return {
    ok: true,
    text: JSON.stringify(pack, null, 2),
    derived,
    skipped,
    existing: cur ? cur.macros.length : 0,
    typesFilled,
    candidates: names.length
  };
}

/** 从报告里的样本行 `MACRO(a, b);` 取参数（顶层逗号切，只保留原文）。 */
function argsFromSample(line, name) {
  const s = String(line || '');
  const at = s.indexOf(name);
  if (at < 0) return [];
  const open = s.indexOf('(', at + name.length);
  if (open < 0) return [];
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) {
        const body = s.slice(open + 1, i).trim();
        if (!body) return [];
        const out = [];
        let d2 = 0;
        let start = 0;
        for (let j = 0; j < body.length; j++) {
          const ch = body[j];
          if (ch === '(' || ch === '[' || ch === '{') d2++;
          else if (ch === ')' || ch === ']' || ch === '}') d2--;
          else if (ch === ',' && d2 === 0) { out.push(body.slice(start, j).trim()); start = j + 1; }
        }
        out.push(body.slice(start).trim());
        return out;
      }
    }
  }
  return [];
}

/** 写入项目里的增强包。远程项目不写回远端（读得到、改不了）。 */
async function enhanceSave(text) {
  const root = projectRoot;
  if (!root) return { ok: false, errors: ['尚未打开项目'] };
  if (isRemoteRoot(root)) return { ok: false, errors: ['远程项目不支持写入增强包'] };
  const parsed = enhance.parseText(text);
  if (!parsed.pack) return { ok: false, errors: parsed.errors.length ? parsed.errors : ['配置无效'] };
  /* 落盘前的**机械体检**：没有人工审核，所以"名字拼反 / 带参宏用 mask / 宏
     不存在"这三类必须在这里挡住（见 auditPack）。坏条目仍然只丢那一条 —— 但
     拼错的 pattern 不能悄悄写进去，否则下一次重建就会用错名字覆盖真实符号。 */
  const audit = await auditPack(parsed.pack);
  if (audit.length) {
    return { ok: false, errors: parsed.errors.concat(audit), path: enhance.packPathOf(root) };
  }
  /* 其余坏条目**不阻塞**整份落盘：归一化只丢坏的那几条（不会误解），而预演/面板
     已经逐条列出它们。整份拒绝会让"AI 给 10 条错 1 条"直接卡死流程（2026-10-21：
     用户拿 AI 生成的包，只因两条 ## 拼名字的规则就一条都用不上）。 */
  const file = enhance.packPathOf(root);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(parsed.pack, null, 2) + '\n', 'utf8');
  return { ok: true, errors: parsed.errors, path: file, pack: enhance.statusOf(parsed.pack) };
}

/**
 * What is known about one `CONFIG_*` option (SPEC F2.25).
 *
 * `CONFIG_TCP_MD5SIG` has no definition to jump to - it exists only in `#ifdef`s
 * - so the question a reader actually has is "is it on here". Four answers, kept
 * apart on purpose, because collapsing them into one "unknown" is what makes a
 * tool feel unreliable:
 *
 *   attached=false, enabled=null   nothing to decide with: no `.config` and no
 *                                  compile database (L2 missing entirely)
 *   attached=true,  known=false    the `.config` exists but never mentions it
 *                                  (a Kconfig default, or not a project option)
 *   known=true, value              `'y'` / `'m'` / `'42'` / null (`# ... is not
 *                                  set`)
 *   enabled                        what L2 actually evaluates conditions with:
 *                                  the `-D` set from a compile database AND the
 *                                  `.config` names. A project with only
 *                                  `compile_commands.json` still answers here -
 *                                  "no .config" must not mean "no answer".
 */
function configValueOf(name, rel) {
  const want = String(name || '').trim();
  const out = { attached: false, known: false, value: null, enabled: null, hasL2: !!l2 };
  if (!l2) return out;

  out.attached = !!l2.hasConfig;
  if (l2.hasConfig) {
    const v = l2.config.get(want);
    if (v !== undefined) { out.known = true; out.value = v; }
  }
  /* The same fold every other condition label goes through, so "is this switch
     on" cannot disagree with "is this code compiled". */
  const t = l2.truth('[' + want + ']', rel || '');
  out.enabled = t === 'unknown' ? null : t === 'true';
  return out;
}

module.exports = {
  getProjectRoot,
  setProjectRoot,
  closeRemote,
  projectInfo,
  buildTree,
  buildIndex,
  buildIndexNow,
  cancelBuild,
  indexState,
  loadIndexFromDisk,
  indexFileFor,
  binaryFileFor,
  setCacheDir,
  listFiles,
  safeResolve,
  resolveInside,
  readFile,
  writeFile,
  grep,
  searchSymbols,
  symbolsPage,
  filesPage,
  outline,
  findReferences,
  findDefinition,
  warmLocalScope,
  shutdownLocalScope,
  findSymbols,
  findSymbolsMany,
  analysisLayers,
  configValueOf,
  kconfigDeclOf,
  /* L4 增强包：读状态 / 出报告 / 预演 / 落盘 */
  scanMacroTable,
  autoDeriveAfterBuild,
  enhanceStatus,
  enhanceReport,
  enhanceExportReport,
  enhanceDerive,
  enhancePreview,
  enhanceSave,
  isCodeFile
};
