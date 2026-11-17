/*
 * SourceLook - Host half.
 *
 * A standard DSH bundle: it registers one HTTP surface on the existing
 * webServer and reads the current Session's workspace. It never touches DSH's
 * installation, and it keeps its own index cache under the plugin directory.
 */
import path from 'node:path';
import os from 'node:os';
import { promises as fs, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { createFileService, MAX_OPEN_BYTES } from './host/files.mjs';
import { serveStatic } from './host/static.mjs';

const require = createRequire(import.meta.url);
const svc = require('./host/fs-service.js');
const ai = require('./host/ai-service.js');

let electronApi = null;
const getElectron = () => {
  if (electronApi !== null) return electronApi;
  try {
    electronApi = require('electron');
  } catch {
    electronApi = false;
  }
  return electronApi;
};

const ROUTE = '/api/sourcelook';
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = path.join(PLUGIN_DIR, 'vendor');
const DATA_DIR = path.join(PLUGIN_DIR, 'data');
const INDEX_CACHE = path.join(DATA_DIR, 'index');
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Small in-memory diagnostic surface. It is deliberately content-free: request
 * counters plus the last client-side render error, which makes "the UI is blank"
 * debuggable without a browser console.
 */
const DIAG = {
  startedAt: Date.now(),
  info: 0,
  tree: 0,
  file: 0,
  write: 0,
  vendor: 0,
  indexStatus: 0,
  indexBuild: 0,
  outline: 0,
  symbols: 0,
  definition: 0,
  references: 0,
  clientErrors: 0,
  vendorHits: Object.create(null),
  lastClientError: null,
  beacons: [],
};

export const inject = ['webServer'];

const execFileAsync = promisify(execFile);

/* 插件 Host 没有 Electron dialog；Windows 下用 Vista+ 的 IFileOpenDialog
   （FOS_PICKFOLDERS），弹的是现代资源管理器风格的“选择文件夹”窗口。
   通过独立 powershell -STA 进程执行，不碰 DSH。 */
const WINDOWS_PICK_SCRIPT = String.raw`
Add-Type @"
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IFileDialog {
 [PreserveSig] int Show(IntPtr parent);
 void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
 void SetFileTypeIndex(uint iFileType);
 void GetFileTypeIndex(out uint piFileType);
 void Advise(IntPtr pfde, out uint pdwCookie);
 void Unadvise(uint dwCookie);
 void SetOptions(uint fos);
 void GetOptions(out uint pfos);
 void SetDefaultFolder(IShellItem psi);
 void SetFolder(IShellItem psi);
 void GetFolder(out IShellItem ppsi);
 void GetCurrentSelection(out IShellItem ppsi);
 void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
 void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
 void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
 void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
 void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
 void GetResult(out IShellItem ppsi);
 void AddPlace(IShellItem psi, int fdap);
 void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
 void Close(int hr);
 void SetClientGuid(ref Guid guid);
 void ClearClientData();
 void SetFilter(IntPtr pFilter);
}
[ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellItem {
 void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
 void GetParent(out IShellItem ppsi);
 void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
 void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
 void Compare(IShellItem psi, uint hint, out int piOrder);
}
[ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
public class FileOpenDialogRCW { }
public static class NativeFolderPicker {
  public static string Pick() {
    var d = (IFileDialog)new FileOpenDialogRCW();
    d.SetOptions(0x20u | 0x40u | 0x800u);
    int hr = d.Show(IntPtr.Zero);
    if (hr != 0) return null;
    IShellItem item;
    d.GetResult(out item);
    string path;
    item.GetDisplayName(0x80058000u, out path);
    return path;
  }
}
"@
$p = [NativeFolderPicker]::Pick()
if ($p) { [Console]::Out.Write($p) }
`;

async function pickWindowsFolder() {
  if (process.platform !== 'win32') return null;
  const encoded = Buffer.from(WINDOWS_PICK_SCRIPT, 'utf16le').toString('base64');
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-STA', '-EncodedCommand', encoded
    ], { windowsHide: true, timeout: 180000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const picked = String(stdout || '').replace(/^\uFEFF/u, '').trim();
    return picked === '' ? { canceled: true } : { path: picked };
  } catch {
    return null;
  }
}
export function apply(ctx, config = {}) {
  const configuredRoot = typeof config.root === 'string' && config.root.trim() !== ''
    ? path.resolve(config.root.trim())
    : '';

  mkdirSync(INDEX_CACHE, { recursive: true });

  /* Project switching: the original reader can open a directory other than the\n   * session workspace; the choice is persisted in data/settings.json. */
  const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
  const readSettingsSync = () => {
    try {
      const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };
  let projectOverride = '';
  {
    const saved = readSettingsSync().projectRoot;
    if (typeof saved === 'string' && saved !== '' && existsSync(saved)) projectOverride = path.resolve(saved);
  }
  svc.setCacheDir(INDEX_CACHE);
  /* 插件 Host 拿不到 Electron；退出/窗口由 DSH 自己处理。这里只做插件生命周期
     的清理：取消正在跑的索引。worker 已 unref，不需要在 dispose 里 terminate。 */
  ctx.effect(() => () => {
    try { svc.cancelBuild(); } catch { /* already idle */ }
    /* 局部作用域 worker 已 unref（不会阻止退出），这里显式收掉线程与队列。 */
    try { svc.shutdownLocalScope(); } catch { /* already gone */ }
  });
  /* fs-service is a single-project service. SourceLook follows the active
   * Session's workspace, so a root change resets it and re-opens the cached
   * index for that root. */
  let currentRoot = '';
  let projectJob = null;
  const ensureProject = async (root) => {
    if (currentRoot === root) return;
    if (projectJob !== null) {
      await projectJob.catch(() => {});
      if (currentRoot === root) return;
    }
    projectJob = (async () => {
      await svc.setProjectRoot(root);
      currentRoot = root;
      try {
        await svc.loadIndexFromDisk();
      } catch (error) {
        console.error('[sourcelook] could not load index:', error);
      }
    })();
    try {
      await projectJob;
    } finally {
      projectJob = null;
    }
  };

  const resolveRoot = (sessionId) => {
    if (projectOverride !== '') return projectOverride;
    if (configuredRoot !== '') return configuredRoot;
    let base = '';
    if (typeof sessionId === 'string' && sessionId !== '') {
      const session = ctx.get('sessions')?.get(sessionId);
      if (session !== undefined) {
        try {
          base = ctx.get('workingDirectory')?.get(session) ?? '';
        } catch {
          base = '';
        }
        if (base === '') base = session.header?.cwd ?? '';
      }
    }
    if (base === '') {
      const workspaces = ctx.get('workspaceRegistry')?.list() ?? [];
      const first = workspaces.find((workspace) => typeof workspace?.path === 'string' && workspace.path !== '');
      if (first !== undefined) base = first.path;
    }
    if (base === '') base = ctx.get('workingDirectory')?.defaultDirectory || process.cwd();
    return path.resolve(base);
  };

  const handle = async (req, res) => {
    try {
      await route(req, res);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      if (status >= 500) console.error('[sourcelook]', error);
      sendJson(res, status, {
        error: {
          code: typeof error?.code === 'string' ? error.code : 'internal',
          message: error instanceof Error ? error.message : String(error),
          ...(error?.details ?? {}),
        },
      });
    }
  };

  async function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const subpath = url.pathname.slice(ROUTE.length) || '/';

    if (subpath.startsWith('/vendor/')) {
      const rest = subpath.slice('/vendor/'.length);
      DIAG.vendor += 1;
      const key = rest.split('/').pop() || rest;
      DIAG.vendorHits[key] = (DIAG.vendorHits[key] || 0) + 1;
      await serveStatic(req, res, VENDOR_DIR, rest);
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { allow: 'GET, HEAD, PUT' });
      res.end();
      return;
    }
    if (req.headers['x-sourcelook'] !== '1') {
      throw httpError(403, 'forbidden', 'Missing SourceLook request header.');
    }
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (typeof origin === 'string' && typeof host === 'string') {
      let originHost = '';
      try { originHost = new URL(origin).host; } catch { originHost = ''; }
      if (originHost !== host) throw httpError(403, 'forbidden', 'Cross-origin request refused.');
    }

    if (req.method === 'GET' && subpath === '/autocontinue') {
      const flag = path.join(PLUGIN_DIR, 'tmp', 'autocontinue.flag');
      let pending = false;
      try {
        await fs.access(flag);
        pending = true;
      } catch {
        pending = false;
      }
      sendJson(res, 200, { pending });
      return;
    }

    if (req.method === 'POST' && subpath === '/autocontinue/clear') {
      try {
        await fs.unlink(path.join(PLUGIN_DIR, 'tmp', 'autocontinue.flag'));
      } catch {
        /* already consumed */
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && subpath === '/settings') {
      let settings = {};
      try {
        settings = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'settings.json'), 'utf8'));
      } catch {
        settings = {};
      }
      sendJson(res, 200, settings && typeof settings === 'object' ? settings : {});
      return;
    }

    if (req.method === 'POST' && subpath === '/settings') {
      const body = await readJson(req);
      let settings = {};
      try {
        settings = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'settings.json'), 'utf8'));
      } catch {
        settings = {};
      }
      if (body && typeof body === 'object') {
        settings = { ...settings, ...body };
      }
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(path.join(DATA_DIR, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
      sendJson(res, 200, settings);
      return;
    }

    /* 本地目录浏览（不依赖 Electron dialog，纯 Node fs）。 */
    if (req.method === 'GET' && subpath === '/project/dirs') {
      const raw = (url.searchParams.get('path') ?? '').trim();
      const target = raw === '' ? os.homedir() : path.resolve(raw);
      let stat = null;
      try { stat = await fs.stat(target); } catch { stat = null; }
      if (stat === null || !stat.isDirectory()) {
        throw httpError(400, 'invalid_path', `不是目录：${target}`);
      }
      let entries = [];
      try { entries = await fs.readdir(target, { withFileTypes: true }); } catch { entries = []; }
      const dirs = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b, 'zh'));
      const parent = path.dirname(target);
      let drives = [];
      if (process.platform === 'win32') {
        for (let code = 65; code <= 90; code += 1) {
          const drive = `${String.fromCharCode(code)}:\\`;
          try { await fs.access(drive); drives.push(drive); } catch { /* 没有这个盘 */ }
        }
      }
      sendJson(res, 200, {
        ok: true,
        path: target,
        parent: parent === target ? '' : parent,
        dirs,
        drives,
        home: os.homedir(),
      });
      return;
    }
    if (req.method === 'GET' && subpath === '/project/pick-support') {
      const electron = getElectron();
      sendJson(res, 200, {
        ok: true,
        dialog: Boolean(electron && electron.dialog
          && typeof electron.dialog.showOpenDialog === 'function'),
      });
      return;
    }
    if (req.method === 'POST' && subpath === '/project/pick') {
      const electron = getElectron();
      if (!electron || !electron.dialog || typeof electron.dialog.showOpenDialog !== 'function') {
        const native = await pickWindowsFolder();
        if (native && native.path) {
          sendJson(res, 200, { ok: true, path: path.resolve(native.path) });
          return;
        }
        if (native && native.canceled) {
          sendJson(res, 200, { ok: false, canceled: true });
          return;
        }
        throw httpError(501, 'no_dialog', '当前宿主不支持系统目录选择器。');
      }
      const result = await electron.dialog.showOpenDialog({
        title: '打开项目目录',
        properties: ['openDirectory'],
      });
      const picked = Array.isArray(result?.filePaths) ? result.filePaths[0] : '';
      if (result?.canceled === true || typeof picked !== 'string' || picked === '') {
        sendJson(res, 200, { ok: false, canceled: true });
        return;
      }
      sendJson(res, 200, { ok: true, path: path.resolve(picked) });
      return;
    }
    /* 打开工程目录 / 回到会话工作区（原版的工程切换）。 */
    if (req.method === 'POST' && subpath === '/project/open') {
      const body = await readJson(req);
      const target = typeof body?.path === 'string' ? body.path.trim() : '';
      if (target === '') throw httpError(400, 'invalid_path', '需要项目目录的绝对路径。');
      const resolved = path.resolve(target);
      let info = null;
      try { info = await fs.stat(resolved); } catch { info = null; }
      if (info === null || !info.isDirectory()) throw httpError(400, 'invalid_path', `不是目录：${resolved}`);
      projectOverride = resolved;
      await ensureProject(resolved);
      const settings = { ...readSettingsSync(), projectRoot: resolved };
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
      sendJson(res, 200, { ok: true, root: resolved, name: path.basename(resolved) || resolved });
      return;
    }
    if (req.method === 'POST' && subpath === '/project/reset') {
      projectOverride = '';
      const settings = { ...readSettingsSync(), projectRoot: '' };
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
      const sessionId = url.searchParams.get('session') ?? undefined;
      const root = resolveRoot(sessionId);
      sendJson(res, 200, { ok: true, root });
      return;
    }    if (req.method === 'GET' && subpath === '/styles.css') {
      try {
        const css = await fs.readFile(path.join(PLUGIN_DIR, 'src/client/styles.css'), 'utf8');
        res.writeHead(200, {
          'content-type': 'text/css; charset=utf-8',
          'cache-control': 'no-store, max-age=0',
        });
        res.end(css);
      } catch (error) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`styles.css: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    if (req.method === 'GET' && subpath === '/diag/state') {
      sendJson(res, 200, {
        ...DIAG,
        vendorHits: { ...DIAG.vendorHits },
        uptimeMs: Date.now() - DIAG.startedAt,
      });
      return;
    }
    if (req.method === 'POST' && subpath === '/diag/reset') {
      DIAG.info = 0;
      DIAG.tree = 0;
      DIAG.file = 0;
      DIAG.write = 0;
      DIAG.vendor = 0;
      DIAG.clientErrors = 0;
      DIAG.vendorHits = Object.create(null);
      DIAG.lastClientError = null;
      DIAG.beacons = [];
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && subpath === '/diag/beacon') {
      const body = await readJson(req);
      DIAG.beacons.push({
        at: new Date().toISOString(),
        stage: String(body?.stage ?? '').slice(0, 120),
        detail: String(body?.detail ?? '').slice(0, 1000),
      });
      if (DIAG.beacons.length > 100) DIAG.beacons.splice(0, DIAG.beacons.length - 100);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && subpath === '/diag/client-error') {
      const body = await readJson(req);
      DIAG.clientErrors += 1;
      DIAG.lastClientError = {
        at: new Date().toISOString(),
        message: String(body?.message ?? '').slice(0, 2000),
        stack: String(body?.stack ?? '').slice(0, 4000),
        componentStack: String(body?.componentStack ?? '').slice(0, 4000),
      };
      await appendClientError(DIAG.lastClientError);
      sendJson(res, 200, { ok: true });
      return;
    }

    const sessionId = url.searchParams.get('session') ?? undefined;
    const root = resolveRoot(sessionId);
    const files = createFileService(root);
    const relative = url.searchParams.get('path') ?? '';

    if (req.method === 'GET' && (subpath === '/' || subpath === '/info')) {
      DIAG.info += 1;
      sendJson(res, 200, {
        root,
        name: path.basename(root) || root,
        platform: process.platform,
        origin: ctx.webServer.getOrigin?.() ?? '',
        version: '0.1.0',
        maxOpenBytes: MAX_OPEN_BYTES,
        versions: {
          electron: process.versions.electron ?? '',
          chrome: process.versions.chrome ?? '',
          node: process.versions.node ?? '',
        },
      });
      return;
    }
    if (req.method === 'GET' && subpath === '/tree') {
      DIAG.tree += 1;
      sendJson(res, 200, await files.list(relative));
      return;
    }
    if (req.method === 'GET' && subpath === '/file') {
      DIAG.file += 1;
      sendJson(res, 200, await files.read(relative));
      return;
    }
    if (req.method === 'GET' && subpath === '/stat') {
      sendJson(res, 200, await files.stat(relative));
      return;
    }
    if (req.method === 'PUT' && subpath === '/file') {
      DIAG.write += 1;
      const body = await readJson(req);
      const saved = await files.write(body?.path, body?.content, {
        expectedVersion: typeof body?.expectedVersion === 'string' ? body.expectedVersion : undefined,
        force: body?.force === true,
        bom: body?.bom === true,
      });
      sendJson(res, 200, saved);
      return;
    }
    if (req.method === 'GET' && subpath === '/index/status') {
      DIAG.indexStatus += 1;
      await ensureProject(root);
      sendJson(res, 200, svc.indexState());
      return;
    }
    if (req.method === 'POST' && subpath === '/index/build') {
      DIAG.indexBuild += 1;
      await ensureProject(root);
      const state = svc.indexState();
      if (state.building === true) {
        sendJson(res, 200, { started: false, state });
        return;
      }
      const job = svc.buildIndexNow(() => {});
      job.catch((error) => console.error('[sourcelook] index build failed:', error));
      sendJson(res, 202, { started: true, state: svc.indexState() });
      return;
    }
    if (req.method === 'POST' && subpath === '/index/cancel') {
      await ensureProject(root);
      sendJson(res, 200, svc.cancelBuild());
      return;
    }
    /* 局部变量作用域预热：只排队，后台在 worker 里解析，绝不等它。 */
    if (req.method === 'POST' && subpath === '/local-scope/warm') {
      await ensureProject(root);
      let body = {};
      try {
        body = await readJson(req);
      } catch {
        body = {};
      }
      const rel = body && typeof body.path === 'string' ? body.path : '';
      if (rel === '') {
        sendJson(res, 400, { ok: false, error: 'path_required' });
        return;
      }
      sendJson(res, 200, await svc.warmLocalScope(rel));
      return;
    }
    /* 解析与增强：报告（给 AI / Agent 的需求书）与落盘导出。 */
    if (req.method === 'GET' && subpath === '/enhance/report') {
      await ensureProject(root);
      sendJson(res, 200, await svc.enhanceReport(url.searchParams.get('lang') === 'en' ? 'en' : 'zh'));
      return;
    }
    if (req.method === 'POST' && subpath === '/enhance/preview') {
      await ensureProject(root);
      const body = await readJson(req);
      sendJson(res, 200, await svc.enhancePreview(String(body?.text ?? '')));
      return;
    }
    if (req.method === 'POST' && subpath === '/enhance/apply') {
      await ensureProject(root);
      const body = await readJson(req);
      sendJson(res, 200, await svc.enhanceSave(String(body?.text ?? '')));
      return;
    }    if (req.method === 'POST' && subpath === '/enhance/export') {
      await ensureProject(root);
      const body = await readJson(req).catch(() => ({}));
      sendJson(res, 200, await svc.enhanceExportReport(body?.lang === 'en' ? 'en' : 'zh'));
      return;
    }    /* AI transport (OpenAI-compatible). The key travels per request from the
       renderer; nothing is persisted here. */
    if (req.method === 'POST' && subpath === '/ai/chat') {
      const body = await readJson(req);
      try {
        sendJson(res, 200, await ai.chat({
          baseUrl: body?.baseUrl,
          apiKey: body?.apiKey,
          model: body?.model,
          messages: body?.messages,
          system: body?.system,
        }));
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }
    if (req.method === 'GET' && subpath === '/ai/models') {
      try {
        sendJson(res, 200, await ai.listModels({
          baseUrl: url.searchParams.get('baseUrl') ?? '',
          apiKey: url.searchParams.get('apiKey') ?? '',
        }));
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }    if (req.method === 'GET' && subpath === '/layers') {
      await ensureProject(root);
      sendJson(res, 200, svc.analysisLayers());
      return;
    }
    if (req.method === 'GET' && subpath === '/outline') {
      DIAG.outline += 1;
      await ensureProject(root);
      sendJson(res, 200, await svc.outline(relative));
      return;
    }
    if (req.method === 'GET' && subpath === '/grep') {
      DIAG.symbols += 1;
      await ensureProject(root);
      const query = (url.searchParams.get('q') ?? '').trim();
      if (query === '') throw httpError(400, 'invalid_query', 'A search query is required.');
      const limit = Math.max(1, Math.min(300, Number(url.searchParams.get('limit')) || 200));
      sendJson(res, 200, await svc.grep(query, limit, {
        word: url.searchParams.get('word') === '1',
        regex: url.searchParams.get('regex') === '1',
        caseSensitive: url.searchParams.get('case') === '1',
        dir: url.searchParams.get('dir') ?? '',
      }));
      return;
    }
    if (req.method === 'GET' && subpath === '/files') {
      DIAG.symbols += 1;
      await ensureProject(root);
      const query = (url.searchParams.get('q') ?? '').trim();
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 300));
      const tokens = query === '' ? [] : query.split(/\s+/u);
      sendJson(res, 200, await svc.filesPage(tokens, 0, limit));
      return;
    }
    if (req.method === 'GET' && subpath === '/symbols') {
      DIAG.symbols += 1;
      await ensureProject(root);
      const query = url.searchParams.get('q') ?? '';
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
      sendJson(res, 200, await svc.searchSymbols(query, limit, relative));
      return;
    }
    /* Paged symbol / file lists: the global pane uses them for large projects
       so it never has to load tens of thousands of rows at once. */
    if (req.method === 'GET' && subpath === '/symbols-page') {
      await ensureProject(root);
      const query = (url.searchParams.get('q') ?? '').trim();
      const tokens = query === '' ? [] : query.split(/\s+/u);
      const start = Math.max(0, Number(url.searchParams.get('start')) || 0);
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 200));
      const globalsOnly = url.searchParams.get('globals') === '1';
      sendJson(res, 200, await svc.symbolsPage(tokens, start, limit, globalsOnly, relative));
      return;
    }
    if (req.method === 'GET' && subpath === '/files-page') {
      await ensureProject(root);
      const query = (url.searchParams.get('q') ?? '').trim();
      const tokens = query === '' ? [] : query.split(/\s+/u);
      const start = Math.max(0, Number(url.searchParams.get('start')) || 0);
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 200));
      sendJson(res, 200, await svc.filesPage(tokens, start, limit));
      return;
    }
    /* Compile-switch support: the value from `.config`/`-D` and the Kconfig
       declaration, used by the context window's CONFIG_* panel. */
    if (req.method === 'GET' && subpath === '/config-value') {
      await ensureProject(root);
      const name = url.searchParams.get('name') ?? '';
      if (name === '') throw httpError(400, 'invalid_name', 'A config name is required.');
      sendJson(res, 200, await svc.configValueOf(name, relative));
      return;
    }
    if (req.method === 'GET' && subpath === '/kconfig') {
      await ensureProject(root);
      const name = url.searchParams.get('name') ?? '';
      if (name === '') throw httpError(400, 'invalid_name', 'A config name is required.');
      sendJson(res, 200, await svc.kconfigDeclOf(name, relative));
      return;
    }
    if (req.method === 'GET' && (subpath === '/definition' || subpath === '/references')) {
      if (subpath === '/definition') DIAG.definition += 1;
      else DIAG.references += 1;
      await ensureProject(root);
      const name = url.searchParams.get('name') ?? '';
      if (name === '') throw httpError(400, 'invalid_name', 'A symbol name is required.');
      const line = Number(url.searchParams.get('line') || 0) || 0;
      const column = Number(url.searchParams.get('column') || 0) || 0;
      const limit = Number(url.searchParams.get('limit') || 0) || 0;
      const fileOnly = url.searchParams.get('fileOnly') === '1';
      const fnName = url.searchParams.get('fn') ?? '';
      const localText = url.searchParams.get('localText') === '1';
      const kindParam = url.searchParams.get('kind') ?? '';
      const parentParam = url.searchParams.get('parent') ?? '';
      const result = subpath === '/definition'
        ? await svc.findDefinition(name, relative, { line, column })
        : await svc.findReferences(name, relative, { limit, fileOnly, fn: fnName, localText, line, kind: kindParam, parent: parentParam });
      sendJson(res, 200, result);
      return;
    }
    throw httpError(404, 'not_found', `Unknown SourceLook endpoint: ${req.method} ${subpath}`);
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: handle }),
    'sourcelook: workspace file api',
  );

  /* One-shot auto-continue after a deliberate restart: the restart helper
     drops tmp/autocontinue.flag before relaunching DSH. Wait for services,
     prompt the current conversation, then consume the flag. */
  const autoFlag = path.join(PLUGIN_DIR, 'tmp', 'autocontinue.flag');
  void (async () => {
    try {
      await fs.access(autoFlag);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 6000));
    try {
      const sessions = ctx.get('sessions');
      if (!sessions || typeof sessions.using !== 'function') {
        throw new Error('sessions.using is unavailable in the host');
      }
      await sessions.using(
        'session-80442f1c-3181-46ed-89e8-9f0e83405264',
        { source: 'gateway' },
        async (reference) => {
          const binding = await reference.ready;
          await binding.session.prompt(
            [{ type: 'text', text: '继续当前 SourceLook 界面校准和调试任务。' }],
            'queue',
          );
        },
      );
      await fs.unlink(autoFlag);
      console.log('[sourcelook] auto-continue prompt queued');
    } catch (error) {
      console.error('[sourcelook] auto-continue failed:', error);
    }
  })();
}

async function appendClientError(entry) {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.appendFile(path.join(DATA_DIR, 'client-errors.log'), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    console.error('[sourcelook] could not write client error log:', error);
  }
}

function sendJson(res, status, value) {  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

async function readJson(req) {
  const length = Number(req.headers['content-length'] ?? 0);
  if (length > MAX_BODY_BYTES) throw httpError(413, 'too_large', 'Request body is too large.');
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw httpError(413, 'too_large', 'Request body is too large.');
    chunks.push(chunk);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'invalid_json', 'Request body must be JSON.');
  }
}

function httpError(status, code, message, details) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

