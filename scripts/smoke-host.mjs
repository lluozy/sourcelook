/* Development smoke test for host/files.js. Run: node scripts/smoke-host.mjs */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFileService } from '../host/files.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
/* fixture 必须跟着仓库走（`tmp/` 被 .gitignore 排除，CI 上没有它）。 */
const root = path.join(here, '..', 'test', 'fixture');
const svc = createFileService(root);

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log('ok  ', message);
}

const listing = await svc.list('');
assert(listing.entries.some((entry) => entry.name === 'main.c' && entry.type === 'file'), 'lists main.c');
assert(listing.entries.some((entry) => entry.name === 'hash.c'), 'lists hash.c');

const file = await svc.read('main.c');
assert(file.content.includes('main'), 'reads main.c');
assert(/^\d+:\d+:\d+$/.test(file.version), 'returns a version');
assert(file.encoding === 'utf-8' && file.readOnly === false, 'detects UTF-8');

const target = 'scratch.txt';
await fs.writeFile(path.join(root, target), 'one', 'utf8');
const first = await svc.stat(target);
assert(first.exists === true, 'stat finds the scratch file');
const saved = await svc.write(target, 'two', { expectedVersion: first.version });
assert((await fs.readFile(path.join(root, target), 'utf8')) === 'two', 'writes the new content');
assert(saved.version !== first.version, 'version changes after write');

let conflict = null;
try {
  await svc.write(target, 'three', { expectedVersion: first.version });
} catch (error) {
  conflict = error;
}
assert(conflict?.code === 'conflict' && conflict.status === 409, 'rejects a stale expectedVersion');

let traversal = null;
try {
  await svc.read('../../package.json');
} catch (error) {
  traversal = error;
}
assert(traversal !== null, 'rejects traversal');

await fs.rm(path.join(root, target), { force: true });
console.log('all host file checks passed');
