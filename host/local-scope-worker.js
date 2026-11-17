'use strict';
/*
 * Local-scope AST builder (worker thread).
 *
 * Input : { id, rel, text }            - text is read by the host (path checks stay there)
 * Output: { id, ok: true, scope }      - plain JSON (no tree-sitter objects)
 *         { id, ok: false, error }
 *
 * Scope shape (all positions 1-based, line/column in *bytes* like tree-sitter):
 *   { file, functions: [{ id, name, startLine, endLine, bodyBlockId }],
 *     blocks: [{ id, parentId, functionId, depth, startLine, startColumn, endLine, endColumn }],
 *     declarations: [{ name, kind, type, line, column, startOffset, blockId, functionId, text }] }
 *
 * Only C is handled: the whole point of this module is "which declaration does
 * this identifier mean", and C is the only language whose locals we resolve.
 */

const path = require('path');
const { parentPort } = require('worker_threads');

let Parser = null;
let cLanguage = null;
let readyPromise = null;

function wasmPathOf(name) {
  return path.join(__dirname, '..', 'vendor', 'tree-sitter', name);
}

function ensureReady() {
  if (readyPromise !== null) return readyPromise;
  readyPromise = (async () => {
    /* Same vendored runtime the indexer uses; separate instance per worker is
       fine (it is just wasm + JS glue, ~2 MB). */
    Parser = require('../vendor/tree-sitter/tree-sitter.js');
    await Parser.init();
    cLanguage = await Parser.Language.load(wasmPathOf('tree-sitter-c.wasm'));
  })();
  return readyPromise;
}

/* --------------------------------------------------------------- helpers */

const WRAPPER_TYPES = new Set([
  'pointer_declarator',
  'array_declarator',
  'function_declarator',
  'parenthesized_declarator',
  'init_declarator',
]);

function nodeText(node, src) {
  if (!node) return '';
  if (typeof node.text === 'string') return node.text;
  return src.slice(node.startIndex, node.endIndex);
}

/** Deepest naming identifier inside a declarator chain. */
function declaratorName(node, src) {
  let cur = node;
  for (let guard = 0; cur && guard < 24; guard += 1) {
    const type = String(cur.type);
    if (type === 'identifier' || type === 'field_identifier' || type === 'type_identifier') {
      return nodeText(cur, src);
    }
    const next = cur.childForFieldName ? cur.childForFieldName('declarator') : null;
    if (next) { cur = next; continue; }
    /* function_declarator / parenthesized_declarator: first declarator-ish child */
    let found = null;
    for (let i = 0; i < cur.childCount; i += 1) {
      const child = cur.child(i);
      if (!child) continue;
      const ct = String(child.type);
      if (ct === 'identifier' || WRAPPER_TYPES.has(ct)) { found = child; break; }
    }
    if (!found) return '';
    cur = found;
  }
  return '';
}

/** Every declared name of a `declaration` / `parameter_declaration`. */
function declaratorsOf(node) {
  const out = [];
  const first = node.childForFieldName ? node.childForFieldName('declarator') : null;
  if (first) out.push(first);
  for (let i = 0; i < node.childCount; i += 1) {
    const child = node.child(i);
    if (!child) continue;
    if (child === first) continue;
    const type = String(child.type);
    if (type === 'identifier' || WRAPPER_TYPES.has(type)) out.push(child);
  }
  return out;
}

function typeTextOf(node, src, declarator) {
  const typeNode = node.childForFieldName ? node.childForFieldName('type') : null;
  if (typeNode) return nodeText(typeNode, src).trim();
  if (!declarator) return '';
  const raw = src.slice(node.startIndex, declarator.startIndex);
  return raw.replace(/[*\s]+$/u, '').trim();
}

function lineOf(node) {
  return (node.startPosition ? node.startPosition.row : 0) + 1;
}

function columnOf(node) {
  return (node.startPosition ? node.startPosition.column : 0) + 1;
}

/** End column of a node (1-based). */
function endColumnOf(node) {
  return (node.endPosition ? node.endPosition.column : 0) + 1;
}

/** Pointer / array depth carried by a declarator chain (`char *a[4]` -> ptr 1, arr 1). */
function declaratorMods(node) {
  let ptr = 0;
  let array = 0;
  let cur = node;
  for (let guard = 0; cur && guard < 24; guard += 1) {
    const type = String(cur.type);
    if (type === 'pointer_declarator') ptr += 1;
    else if (type === 'array_declarator') array += 1;
    else if (type === 'identifier' || type === 'field_identifier') break;
    const field = cur.childForFieldName ? cur.childForFieldName('declarator') : null;
    if (field) { cur = field; continue; }
    let found = null;
    for (let i = 0; i < cur.childCount; i += 1) {
      const child = cur.child(i);
      if (!child) continue;
      const ct = String(child.type);
      if (ct === 'identifier' || WRAPPER_TYPES.has(ct)) { found = child; break; }
    }
    if (!found) break;
    cur = found;
  }
  return { ptr, array };
}

/* ------------------------------------------------------ expression shapes */

const SHAPE_MAX_DEPTH = 12;
const MAX_MEMBERS = 6000;

function calleeName(node, src) {
  let cur = node;
  for (let guard = 0; cur && guard < 8; guard += 1) {
    const type = String(cur.type);
    if (type === 'identifier') return nodeText(cur, src);
    if (type === 'field_expression') return '';          /* function-pointer member */
    if (type === 'parenthesized_expression') {
      const inner = cur.namedChild(0);
      if (!inner) return '';
      cur = inner;
      continue;
    }
    return '';
  }
  return '';
}

/**
 * Normalise an expression into the JSON shape the host resolves types from.
 * Deliberately lossy: subscript indexes and call arguments are dropped (the host
 * never needs them), which keeps the per-file payload small.
 */
function shapeOf(node, src, depth) {
  if (!node || depth > SHAPE_MAX_DEPTH) return { kind: 'unknown' };
  const type = String(node.type);
  if (type === 'identifier') return { kind: 'identifier', name: nodeText(node, src) };
  if (type === 'field_expression') {
    const argument = node.childForFieldName ? node.childForFieldName('argument') : null;
    const field = node.childForFieldName ? node.childForFieldName('field') : null;
    let operator = '.';
    for (let i = 0; i < node.childCount; i += 1) {
      const child = node.child(i);
      if (child && String(child.type) === '->') { operator = '->'; break; }
    }
    const base = shapeOf(argument, src, depth + 1);
    if (base.kind === 'unknown') return base;
    return { kind: 'member', operator, member: nodeText(field, src), base };
  }
  if (type === 'subscript_expression') {
    const argument = node.childForFieldName ? node.childForFieldName('argument') : null;
    const base = shapeOf(argument, src, depth + 1);
    if (base.kind === 'unknown') return base;
    return { kind: 'subscript', base };
  }
  if (type === 'call_expression') {
    const fn = node.childForFieldName ? node.childForFieldName('function') : null;
    const name = calleeName(fn, src);
    if (name === '') return { kind: 'unknown' };
    return { kind: 'call', function: name };
  }
  if (type === 'cast_expression') {
    const typeNode = node.childForFieldName ? node.childForFieldName('type') : null;
    const value = node.childForFieldName ? node.childForFieldName('value') : null;
    const castType = nodeText(typeNode, src).trim();
    if (castType === '') return { kind: 'unknown' };
    return { kind: 'cast', type: castType, value: shapeOf(value, src, depth + 1) };
  }
  if (type === 'pointer_expression') {
    let operator = '*';
    for (let i = 0; i < node.childCount; i += 1) {
      const child = node.child(i);
      if (child && String(child.type) === '&') { operator = '&'; break; }
    }
    return { kind: 'pointer', operator, value: shapeOf(node.namedChild(0), src, depth + 1) };
  }
  if (type === 'parenthesized_expression') {
    return { kind: 'parenthesized', value: shapeOf(node.namedChild(0), src, depth + 1) };
  }
  return { kind: 'unknown' };
}

/* ---------------------------------------------------------------- builder */

function buildScope(rel, text, root) {
  const src = text;
  const lines = src.split(/\r?\n/);
  const functions = [];
  const blocks = [];
  const declarations = [];
  const members = [];
  let blockSeq = 0;
  let fnSeq = 0;

  const newBlock = (parentId, functionId, node, depth) => {
    blockSeq += 1;
    const block = {
      id: blockSeq,
      parentId,
      functionId,
      depth,
      startLine: lineOf(node),
      startColumn: columnOf(node),
      endLine: (node.endPosition ? node.endPosition.row : 0) + 1,
      endColumn: (node.endPosition ? node.endPosition.column : 0) + 1,
    };
    blocks.push(block);
    return block;
  };

  const pushDeclaration = (node, declarator, kind, block, functionId) => {
    const name = declaratorName(declarator, src);
    if (name === '' || name === 'void') return;
    const line = lineOf(declarator);
    const mods = declaratorMods(declarator);
    declarations.push({
      name,
      kind,
      type: typeTextOf(node, src, declarator),
      ptrDepth: mods.ptr,
      arrayDepth: mods.array,
      line,
      column: columnOf(declarator),
      startOffset: declarator.startIndex || 0,
      blockId: block ? block.id : 0,
      functionId,
      text: String(lines[line - 1] || '').trim().slice(0, 200),
    });
  };

  /** parameters of a function_definition */
  const pushParameters = (fnNode, bodyBlock, functionId) => {
    const decl = fnNode.childForFieldName ? fnNode.childForFieldName('declarator') : null;
    if (!decl) return;
    let params = null;
    const stack = [decl];
    for (let guard = 0; stack.length > 0 && guard < 64 && !params; guard += 1) {
      const cur = stack.pop();
      if (!cur) continue;
      if (String(cur.type) === 'parameter_list') { params = cur; break; }
      for (let i = 0; i < cur.childCount; i += 1) {
        const child = cur.child(i);
        if (child) stack.push(child);
      }
    }
    if (!params) return;
    for (let i = 0; i < params.childCount; i += 1) {
      const child = params.child(i);
      if (!child || String(child.type) !== 'parameter_declaration') continue;
      for (const declarator of declaratorsOf(child)) {
        pushDeclaration(child, declarator, 'parameter', bodyBlock, functionId);
      }
    }
  };

  const visit = (node, block, functionId, depth) => {
    if (!node) return;
    const type = String(node.type);

    if (type === 'function_definition') {
      fnSeq += 1;
      const functionId = fnSeq;
      const body = node.childForFieldName ? node.childForFieldName('body') : null;
      const declarator = node.childForFieldName ? node.childForFieldName('declarator') : null;
      const entry = {
        id: functionId,
        name: declaratorName(declarator, src),
        startLine: lineOf(node),
        endLine: (node.endPosition ? node.endPosition.row : 0) + 1,
        bodyBlockId: 0,
      };
      if (body && String(body.type) === 'compound_statement') {
        const bodyBlock = newBlock(null, functionId, body, 0);
        entry.bodyBlockId = bodyBlock.id;
        pushParameters(node, bodyBlock, functionId);
        functions.push(entry);
        for (let i = 0; i < body.namedChildCount; i += 1) {
          visit(body.namedChild(i), bodyBlock, functionId, 1);
        }
        return;
      }
      functions.push(entry);
      return;
    }

    if (type === 'compound_statement') {
      const inner = newBlock(block ? block.id : null, functionId, node, depth);
      for (let i = 0; i < node.namedChildCount; i += 1) {
        visit(node.namedChild(i), inner, functionId, depth + 1);
      }
      return;
    }

    if (type === 'for_statement') {
      const init = node.childForFieldName ? node.childForFieldName('initializer') : null;
      const body = node.childForFieldName ? node.childForFieldName('body') : null;
      let scopeBlock = block;
      if (init && String(init.type) === 'declaration') {
        /* for (int i = 0; ...) — the variable lives in a synthetic block that
           covers the whole loop, so it never leaks to the enclosing block. */
        scopeBlock = newBlock(block ? block.id : null, functionId, node, depth);
        for (const declarator of declaratorsOf(init)) {
          pushDeclaration(init, declarator, 'for_variable', scopeBlock, functionId);
        }
      }
      if (body) visit(body, scopeBlock, functionId, depth + 1);
      return;
    }

    if (type === 'declaration') {
      for (const declarator of declaratorsOf(node)) {
        pushDeclaration(node, declarator, 'variable', block, functionId);
      }
      return;
    }

    if (type === 'field_expression') {
      /* `a.b` / `a->b` / `arr[i].b` — record where the field name sits plus the
         normalised receiver shape, so the host can resolve the type from AST
         instead of re-parsing the line with regexes. */
      const field = node.childForFieldName ? node.childForFieldName('field') : null;
      const name = nodeText(field, src);
      const shape = shapeOf(node, src, 0);
      if (name !== '' && shape.kind === 'member' && members.length < MAX_MEMBERS) {
        members.push({
          name,
          line: lineOf(field),
          column: columnOf(field),
          endColumn: endColumnOf(field),
          operator: shape.operator,
          shape,
        });
      }
      const argument = node.childForFieldName ? node.childForFieldName('argument') : null;
      if (argument) visit(argument, block, functionId, depth);
      return;
    }

    /* Everything else: keep walking so nested blocks are still found. */
    for (let i = 0; i < node.namedChildCount; i += 1) {
      visit(node.namedChild(i), block, functionId, depth);
    }
  };

  visit(root, null, 0, 0);

  return { file: rel, functions, blocks, declarations, members };
}

/* ------------------------------------------------------------ message loop */

async function handle(msg) {
  await ensureReady();
  const parser = new Parser();
  parser.setLanguage(cLanguage);
  const tree = parser.parse(msg.text);
  try {
    const scope = buildScope(msg.rel || '', msg.text, tree.rootNode);
    return { id: msg.id, ok: true, scope };
  } finally {
    try { tree.delete(); } catch { /* older runtime */ }
    try { parser.delete(); } catch { /* older runtime */ }
  }
}

parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'quit') { process.exit(0); return; }
  if (msg.type !== 'build') return;
  handle(msg).then(
    (reply) => { parentPort.postMessage(reply); },
    (error) => {
      parentPort.postMessage({
        id: msg.id,
        ok: false,
        error: String((error && error.message) || error || 'parse failed'),
      });
    },
  );
});
