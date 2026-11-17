/* Development index smoke test: node scripts/smoke-index.cjs */
const path = require('path');
const fs = require('fs');

const plugin = path.join(__dirname, '..');
const svc = require(path.join(plugin, 'host', 'fs-service.js'));
/* fixture 必须跟着仓库走（`tmp/` 被 .gitignore 排除，CI 上没有它）。 */
const fixture = path.join(plugin, 'test', 'fixture');
const cache = path.join(plugin, 'data', 'index-test');

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log('ok  ', message);
}

(async () => {
  fs.rmSync(cache, { recursive: true, force: true });
  fs.mkdirSync(cache, { recursive: true });
  svc.setCacheDir(cache);
  await svc.setProjectRoot(fixture);
  await svc.buildIndexNow(() => {});
  const state = svc.indexState();
  assert(state.built === true, 'builds an index');
  assert(state.symbolCount > 0 && state.fileCount === 5, `indexes the fixture (${state.symbolCount} symbols / ${state.fileCount} files)`);

  const outline = await svc.outline('main.c');
  assert((outline.symbols || []).some((symbol) => symbol.name === 'main'), 'outline contains main');

  const definition = await svc.findDefinition('kv_put', 'main.c');
  assert((definition.definitions || []).length === 2, 'finds the declaration and definition of kv_put');

  const references = await svc.findReferences('kv_put', 'main.c');
  assert(references.counts.references >= 3, 'finds kv_put call sites');

  const search = await svc.searchSymbols('kv_put', 10);
  assert((search.symbols || []).length === 2, 'symbol search returns both kv_put entries');

  await svc.loadIndexFromDisk();
  assert(svc.indexState().built === true, 'reloads the persisted index');
})().catch((error) => {
  console.error('FAILED', error);
  process.exit(1);
});
