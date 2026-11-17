/*
 * SourceLook file service.
 *
 * Every path crossing this module is workspace-relative with `/` separators.
 * The service never trusts a caller: it normalises the relative path, resolves
 * it inside the real workspace root, and refuses anything that escapes through
 * `..` or a symbolic link.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const MAX_OPEN_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const BINARY_PROBE = 8192;

/** Directories that make a source tree unreadable if they are listed eagerly. */
const SKIP_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', '__pycache__', '.idea', '.vscode',
  'dist', 'build', '.cache', 'target', '.venv', 'venv', 'out', '.next',
  '.gradle', '.mypy_cache', '.pytest_cache', 'CMakeFiles',
]);

function fail(status, code, message, details) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

const writeSeq = new Map();

function versionOf(stat, key) {
  const bump = key === undefined ? 0 : (writeSeq.get(key) ?? 0);
  return `${Math.round(stat.mtimeMs * 1000)}:${stat.size}:${bump}`;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** '' is the workspace root; anything else must be a clean relative path. */
export function normalizeRelative(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw fail(400, 'invalid_path', 'Path must be a string.');
  const trimmed = value.trim().replaceAll('\\', '/');
  if (trimmed === '' || trimmed === '/') return '';
  if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) {
    throw fail(400, 'invalid_path', 'Only workspace-relative paths are allowed.');
  }
  const parts = trimmed.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw fail(400, 'invalid_path', 'Path must not contain empty, "." or ".." segments.');
  }
  return parts.join('/');
}

export function createFileService(root) {
  const absoluteRoot = path.resolve(root);

  async function realRoot() {
    return fs.realpath(absoluteRoot);
  }

  /** The resolved absolute target, guaranteed to live under the real root. */
  async function resolveInside(relative) {
    const clean = normalizeRelative(relative);
    const target = path.resolve(absoluteRoot, clean);
    if (!isInside(absoluteRoot, target)) {
      throw fail(403, 'outside_root', 'Path escapes the workspace root.');
    }
    /* Resolve the deepest existing ancestor: the target itself may be a new
     * file, but the directory it will live in must still be inside the root. */
    let probe = target;
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        if (!isInside(await realRoot(), real)) {
          throw fail(403, 'outside_root', 'Path escapes the workspace root through a link.');
        }
        break;
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          const parent = path.dirname(probe);
          if (parent === probe) throw error;
          probe = parent;
          continue;
        }
        throw error;
      }
    }
    return { absolute: target, relative: clean };
  }

  async function list(relative) {
    const { absolute, relative: clean } = await resolveInside(relative);
    const info = await fs.stat(absolute).catch((error) => {
      if (error && error.code === 'ENOENT') throw fail(404, 'not_found', 'Directory not found.');
      throw error;
    });
    if (!info.isDirectory()) throw fail(400, 'not_directory', 'Not a directory.');

    const dirents = await fs.readdir(absolute, { withFileTypes: true });
    const entries = [];
    let truncated = false;
    for (const dirent of dirents) {
      if (entries.length >= MAX_ENTRIES) { truncated = true; break; }
      const name = dirent.name;
      if (name === '.' || name === '..') continue;
      let type;
      if (dirent.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        type = 'dir';
      } else if (dirent.isFile()) {
        type = 'file';
      } else if (dirent.isSymbolicLink()) {
        type = 'symlink';
      } else {
        type = 'other';
      }
      entries.push({
        name,
        path: clean === '' ? name : `${clean}/${name}`,
        type,
      });
    }
    entries.sort((a, b) => {
      if (a.type !== b.type) {
        if (a.type === 'dir') return -1;
        if (b.type === 'dir') return 1;
      }
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    return { path: clean, entries, truncated };
  }

  async function read(relative) {
    const { absolute, relative: clean } = await resolveInside(relative);
    if (clean === '') throw fail(400, 'invalid_path', 'A file path is required.');
    const linkInfo = await fs.lstat(absolute).catch((error) => {
      if (error && error.code === 'ENOENT') throw fail(404, 'not_found', 'File not found.');
      throw error;
    });
    if (linkInfo.isSymbolicLink()) throw fail(400, 'symlink', 'Refusing to open a symbolic link.');
    if (!linkInfo.isFile()) throw fail(400, 'not_file', 'Not a regular file.');
    if (linkInfo.size > MAX_OPEN_BYTES) {
      throw fail(413, 'too_large', `File is larger than ${Math.round(MAX_OPEN_BYTES / 1024 / 1024)} MB.`);
    }

    const buffer = await fs.readFile(absolute);
    if (buffer.subarray(0, BINARY_PROBE).includes(0)) {
      throw fail(415, 'binary', 'This file does not look like text.');
    }

    let bom = false;
    let body = buffer;
    if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
      bom = true;
      body = body.subarray(3);
    }

    let encoding = 'utf-8';
    let content;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      /* Legacy Windows source trees are often GBK. Viewing is useful; saving
       * is refused because Node cannot encode GB18030 without a dependency. */
      encoding = 'gb18030';
      content = new TextDecoder('gb18030').decode(body);
    }

    const stat = await fs.stat(absolute);
    return {
      path: clean,
      absolutePath: absolute,
      content,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      version: versionOf(stat, clean),
      encoding,
      readOnly: encoding !== 'utf-8',
      bom,
      eol: content.includes('\r\n') ? 'CRLF' : 'LF',
    };
  }

  async function statOf(relative) {
    const { absolute, relative: clean } = await resolveInside(relative);
    if (clean === '') throw fail(400, 'invalid_path', 'A file path is required.');
    try {
      const info = await fs.lstat(absolute);
      if (info.isSymbolicLink()) return { path: clean, exists: false, symlink: true };
      if (!info.isFile()) return { path: clean, exists: false };
      return {
        path: clean,
        exists: true,
        size: info.size,
        mtime: info.mtime.toISOString(),
        version: versionOf(info, clean),
      };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { path: clean, exists: false };
      throw error;
    }
  }

  async function write(relative, content, options = {}) {
    const { absolute, relative: clean } = await resolveInside(relative);
    if (clean === '') throw fail(400, 'invalid_path', 'A file path is required.');
    if (typeof content !== 'string') throw fail(400, 'invalid_body', 'File content must be a string.');
    if (Buffer.byteLength(content, 'utf8') > MAX_OPEN_BYTES) {
      throw fail(413, 'too_large', `File is larger than ${Math.round(MAX_OPEN_BYTES / 1024 / 1024)} MB.`);
    }

    const existing = await fs.lstat(absolute).catch((error) => {
      if (error && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing?.isSymbolicLink()) throw fail(400, 'symlink', 'Refusing to save through a symbolic link.');
    if (existing && !existing.isFile()) throw fail(400, 'not_file', 'Not a regular file.');

    if (options.force !== true) {
      if (existing === undefined) {
        if (typeof options.expectedVersion === 'string') {
          throw fail(409, 'conflict', 'The file no longer exists on disk.', { missing: true });
        }
      } else if (typeof options.expectedVersion === 'string'
        && versionOf(existing, clean) !== options.expectedVersion) {
        const current = await fs.readFile(absolute, 'utf8').catch(() => '');
        throw fail(409, 'conflict', 'The file changed on disk since it was opened.', {
          current: {
            content: current.includes('\u0000') ? '' : current,
            version: versionOf(existing, clean),
            size: existing.size,
            mtime: existing.mtime.toISOString(),
          },
        });
      }
    }

    const parent = path.dirname(absolute);
    const parentInfo = await fs.stat(parent).catch(() => undefined);
    if (!parentInfo?.isDirectory()) throw fail(400, 'no_parent', 'The containing folder does not exist.');

    const payload = options.bom === true ? '\uFEFF' + content : content;
    await fs.writeFile(absolute, payload, 'utf8');
    writeSeq.set(clean, (writeSeq.get(clean) ?? 0) + 1);
    const next = await fs.stat(absolute);
    return {
      path: clean,
      absolutePath: absolute,
      version: versionOf(next, clean),
      size: next.size,
      mtime: next.mtime.toISOString(),
    };
  }

  return {
    root: absoluteRoot,
    list,
    read,
    write,
    stat: statOf,
    normalizeRelative,
    resolveInside,
  };
}
