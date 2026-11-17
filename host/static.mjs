/* Small, deliberately narrow static file responder for the Monaco bundle. */
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const MIME = new Map(Object.entries({
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}));

function end(res, status, message) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(message);
}

/**
 * Serve `relative` under `baseDir`. Returns true when it handled the request.
 * Only the extensions Monaco actually ships are reachable.
 */
export async function serveStatic(req, res, baseDir, relative, options = {}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    end(res, 405, 'Method not allowed.');
    return;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    end(res, 400, 'Bad path.');
    return;
  }
  const clean = decoded.replaceAll('\\', '/');
  if (clean === '' || clean.includes('\u0000')) {
    end(res, 400, 'Bad path.');
    return;
  }
  const segments = clean.split('/');
  if (segments.some((part) => part === '' || part === '.' || part === '..')) {
    end(res, 403, 'Forbidden.');
    return;
  }
  const extension = path.extname(clean).toLowerCase();
  const mediaType = MIME.get(extension);
  if (mediaType === undefined) {
    end(res, 404, 'Not found.');
    return;
  }

  const base = path.resolve(baseDir);
  const target = path.resolve(base, clean);
  if (!target.startsWith(base + path.sep)) {
    end(res, 403, 'Forbidden.');
    return;
  }

  let info;
  try {
    info = await fs.stat(target);
  } catch {
    end(res, 404, 'Not found.');
    return;
  }
  if (!info.isFile()) {
    end(res, 404, 'Not found.');
    return;
  }

  res.writeHead(200, {
    'content-type': mediaType,
    'content-length': String(info.size),
    'cache-control': options.cacheControl ?? 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(target);
  stream.on('error', () => {
    if (!res.headersSent) end(res, 500, 'Read failed.');
    else res.destroy();
  });
  stream.pipe(res);
}
