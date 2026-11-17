(function () {
'use strict';
/*
 * EditorAdapter - the only seam between the app and the editor kernel.
 *
 * SPEC 13.2 hard requirement: the app never calls kernel APIs directly.
 *
 * The contract below is defined against the FINAL capability set, not against
 * Monaco's current limits. `fontSize` / `fontFamily` are already part of
 * SemanticStyle even though the Monaco adapter ignores them today (v1 does not
 * support mixed font sizes - SPEC D14). When v1.5 swaps in CodeMirror 6 or a
 * hand-written DOM renderer, app code must not change at all.
 *
 * Implementations must provide:
 *   mount(container)                        - build the editor inside a DOM node
 *   setContent(path, text, language)        - load a file (path = absolute)
 *   getText()                               - current buffer
 *   setReadOnly(flag)
 *   getCursor()                -> Pos
 *   setCursor(pos)
 *   getSelection()             -> { start, end, text } | null
 *   revealLine(line, center?)
 *   focus()
 *   applySemanticSpans(spans)               - spans: SemanticSpan[]
 *   clearSemanticSpans()
 *   highlightMatches(ranges)                - search hits etc.
 *   setTheme(themeName)
 *   undo() / redo()
 *   onCursorMove(cb) / onSelectionChange(cb)
 *   onNavigateRequest(cb)                   - double click / Ctrl+click
 *   onChange(cb)                            - dirty flag
 *
 * Optional capabilities (app calls them through `state.editor.method?.()`):
 *   applyCodeEmphasis()                     - 词法级强调:函数名加粗蓝、宏柔和红
 *   clearCodeEmphasis()
 */

/**
 * @typedef {{ line: number, column: number }} Pos
 * @typedef {{ start: Pos, end: Pos }} Range
 *
 * @typedef {Object} SemanticStyle
 * @property {string} [color]           CSS color
 * @property {string|number} [fontWeight]
 * @property {string} [fontStyle]       'normal' | 'italic'
 * @property {string} [fontFamily]
 * @property {string} [fontSize]        e.g. '1.15em' (Monaco adapter: ignored)
 * @property {string} [textDecoration]
 *
 * @typedef {Object} SemanticSpan
 * @property {string} kind              'macro' | 'type' | 'func' | 'member' | ...
 * @property {Range[]} ranges
 * @property {SemanticStyle} style
 */

const EDITOR_ADAPTER_METHODS = [
  'mount', 'setContent', 'getText', 'setReadOnly',
  'getCursor', 'setCursor', 'getSelection', 'revealLine', 'focus',
  'replaceSelection', 'setSelection', 'getWordAtCursor', 'getScreenRect',
  'applySemanticSpans', 'clearSemanticSpans', 'highlightMatches',
  'setTheme', 'undo', 'redo', 'registerShortcut',
  'onCursorMove', 'onSelectionChange', 'onNavigateRequest', 'onChange'
];

/**
 * Turns SemanticStyle objects into CSS class names, so that the style layer is
 * data-driven and adapter-agnostic. Any adapter that can attach a class to a
 * text range gets mixed colors / weights / sizes for free.
 */
class StyleRegistry {
  constructor(doc) {
    this.doc = doc || document;
    this.styleEl = null;
    this.byKey = new Map();
    this.rules = [];
  }

  className(style) {
    const key = JSON.stringify(style || {});
    if (this.byKey.has(key)) return this.byKey.get(key);

    const name = 'sem-' + hash32(key);
    this.byKey.set(key, name);
    this.rules.push(styleToRule(name, style || {}));
    this.flush();
    return name;
  }

  flush() {
    if (!this.styleEl) {
      /* The page can outlive several editor mounts (plugin reload, session
       * switch). Reuse the one registry stylesheet instead of adding a new
       * <style data-code-reader="semantic-styles"> on every mount. */
      const existing = this.doc.querySelector('style[data-code-reader="semantic-styles"]');
      if (existing) {
        this.styleEl = existing;
      } else {
        this.styleEl = this.doc.createElement('style');
        this.styleEl.setAttribute('data-code-reader', 'semantic-styles');
        this.doc.head.appendChild(this.styleEl);
      }
    }
    this.styleEl.textContent = this.rules.join('\n');
  }

  reset() {
    this.byKey.clear();
    this.rules = [];
    this.flush();
  }
}

const CSS_PROPS = {
  color: 'color',
  backgroundColor: 'background-color',
  fontWeight: 'font-weight',
  fontStyle: 'font-style',
  fontFamily: 'font-family',
  fontSize: 'font-size',
  textDecoration: 'text-decoration'
};

function styleToRule(name, style) {
  const decls = [];
  for (const key of Object.keys(style)) {
    const cssProp = CSS_PROPS[key];
    const value = style[key];
    if (!cssProp || value === undefined || value === null || value === '') continue;
    /* `!important` must sit before the semicolon: appending it after would make
     * the parser drop the following declaration as an invalid token. */
    decls.push(cssProp + ': ' + value + ' !important;');
  }
  // Color, weight and size must win over Monaco's own token classes.
  return '.' + name + ' { ' + decls.join(' ') + ' }';
}

function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Throws early if an adapter does not honour the contract. */
function assertAdapter(adapter) {
  const missing = EDITOR_ADAPTER_METHODS.filter((m) => typeof adapter[m] !== 'function');
  if (missing.length) {
    throw new Error('EditorAdapter 缺少方法: ' + missing.join(', '));
  }
  return adapter;
}

window.EditorAdapter = {
  METHODS: EDITOR_ADAPTER_METHODS,
  StyleRegistry,
  assertAdapter,
  hash32
};

})();
