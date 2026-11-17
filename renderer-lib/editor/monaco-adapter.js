(function () {
'use strict';
/*
 * MonacoAdapter - EditorAdapter implemented on Monaco Editor.
 *
 * v1 note (SPEC D14): Monaco derives column coordinates from a single
 * character width, so a per-token font-size breaks cursor placement, click
 * hit-testing and selection ranges. `fontSize` / `fontFamily` from a
 * SemanticStyle are therefore DROPPED here (reported once). Colors, weight,
 * italic and underline are applied as usual. The v1.5 DOM/CodeMirror adapter
 * will honour everything without any change to app code - that is the whole
 * point of the seam.
 */

const { StyleRegistry, assertAdapter } = window.EditorAdapter;

const LANG_MAP = {
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cxx: 'cpp', hxx: 'cpp',
  inl: 'cpp', ipp: 'cpp', py: 'python', js: 'javascript', mjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', jsx: 'javascript', rs: 'rust', go: 'go',
  java: 'java', sh: 'shell', bash: 'shell', zsh: 'shell', json: 'json',
  md: 'markdown', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
  cfg: 'ini', conf: 'ini', lua: 'lua', rb: 'ruby', pl: 'perl',
  txt: 'plaintext', rst: 'plaintext', dts: 'cpp', dtsi: 'cpp'
};

function languageOf(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  return LANG_MAP[ext] || 'plaintext';
}

/* 语法强调 (applyCodeEmphasis):这些词后面跟着左括号也不是函数调用,别涂成
   函数色。C/C++ 里会这么出现的控制词就这些。 */
const FN_SKIP = new Set([
  'if', 'for', 'while', 'switch', 'do', 'else', 'return', 'sizeof', 'defined',
  'case', 'goto', 'typeof', 'alignof', 'decltype', '_Static_assert', 'static_assert',
  /* 编译器扩展的"函数样式"关键字,后面也跟括号,但不是函数名 */
  '__attribute__', '__attribute', '__declspec', '_Pragma'
]);

/* "后面紧跟 ( 的标识符"是函数定义/声明,还是调用? (user request 2026-10-19)
   纯词法判断,依据 C 的声明形式:
     - 名字之前(本行内)不许出现 = ; , ( ) { } -> . 这些"只出现在表达式里"的
       东西,也不许出现 return/if/while/... 这些语句关键字;
     - 名字前面必须有东西(返回类型 / 存储类 / 宏修饰 / *),否则是顶格裸调用
       (list_for_each(pos, head) 这种宏语句),不算定义;
     - 名字前面什么都没有(声明被拆行)时,看上一行:以标识符或 * 结尾且没有
       分号/花括号,才算定义的上半截。
   隐式 int 的老写法(foo(a,b) 顶格)会被当成调用 —— 内核里没有这种代码。 */
const DEF_BREAK = /[=;,(){}]|->|\.|\b(?:return|if|while|for|switch|case|goto|sizeof|do|else)\b/;
function looksLikeDefinition(line, start, prevLine) {
  const prefix = line.slice(0, start);
  if (DEF_BREAK.test(prefix)) return false;
  if (prefix.trim()) return true;
  const prev = String(prevLine || '').trim();
  if (!prev || /[;{}]$/.test(prev)) return false;
  return /[A-Za-z0-9_*]$/.test(prev);
}

/**
 * One spelling per file, whatever the caller passed.
 *
 * `C:\proj\a.c` (file tree, `fs` paths) and `C:/proj/a.c` (Context Window,
 * built by hand from the project root) are the same file - and Monaco's
 * ModelService agrees, because `Uri.file` normalises both to one URI. The
 * adapter's own cache has to agree too, or the second spelling tries to create
 * a model that already exists and the open fails silently (2026-10-13).
 */
function modelKey(absPath) {
  return String(absPath || '').replace(/\\/g, '/');
}

function createMonacoAdapter(options) {
  const monaco = options.monaco;
  const registry = new StyleRegistry();
  const models = new Map();
  const listeners = {
    cursor: [], selection: [], navigate: [], change: [],
    rightClick: [], singleClick: [], doubleClickEmpty: []
  };

  let editor = null;
  let semCollection = null;
  let matchCollection = null;
  let transientCollection = null;
  let aiCollection = null;
  let synCollection = null;
  let emphRetryModel = null;
  let emphRetryTimer = 0;
  let emphAt = 0;
  let fontsDropped = false;

  const toPos = (p) => ({ line: p.lineNumber, column: p.column });
  const toRange = (r) => new monaco.Range(
    r.start.line, r.start.column, r.end.line, r.end.column
  );
  const emit = (name, ...args) => {
    for (const cb of listeners[name]) {
      try { cb(...args); } catch (err) { console.error('[editor] listener error:', err); }
    }
  };

  /* 行高 = 字号 × 1.3。Monaco 的 lineHeight 选项是**像素**,不是倍数 —— 以前
     这里写的是 1.55(当倍数用),Monaco 判定为非法值后回退到 1.5 倍,13.5px 的
     字号行距 21px,读代码偏松(用户 2026-10-19 要求紧凑)。现在按字号算像素,
     字号变化时一并更新,否则放大字号后行与行会叠起来。 */
  const LINE_HEIGHT_RATIO = 1.3;
  const lineHeightFor = (px) => Math.round(Number(px || 13.5) * LINE_HEIGHT_RATIO);

  /* v1: strip the properties Monaco cannot honour without breaking itself. */
  function monacoStyle(style) {
    const s = style || {};
    if ((s.fontSize || s.fontFamily) && !fontsDropped) {
      fontsDropped = true;
      console.info('[MonacoAdapter] fontSize/fontFamily ignored in v1 (SPEC D14: mixed font sizes need a different kernel)');
    }
    const out = {};
    for (const k of Object.keys(s)) {
      if (k === 'fontSize' || k === 'fontFamily') continue;
      out[k] = s[k];
    }
    return out;
  }

  const adapter = {
    /* ------------------------------------------------------------- lifecycle */

    mount(container) {
      editor = monaco.editor.create(container, {
        value: '',
        theme: options.theme || 'vs',
        fontSize: options.fontSize || 13.5,
        fontFamily: options.fontFamily || 'ui-monospace, Consolas, "Cascadia Mono", monospace',
        lineHeight: lineHeightFor(options.fontSize || 13.5),
        minimap: { enabled: false },
        /* Panes are draggable (SPEC F2.13): without this the editor keeps its
         * old width after a drag and the gutter is suddenly half off-screen. */
        automaticLayout: true,
        scrollBeyondLastLine: false,
        renderLineHighlight: 'line',
        /* 物理滚轮的平滑动画会让每一格慢半拍（见 80-app.js 的说明）。 */
        smoothScrolling: false,
        automaticLayout: true,
        readOnly: false,
        padding: { top: 8 },
        links: false,               // we own Ctrl+click
        /* Kept enabled so Monaco still dispatches its contextmenu event (with
         * the hit test result); the menu itself is disposed right below, since
         * an embedded Monaco renders an empty popup. */
        contextmenu: true,
        /* 默认 1px 的竖线在浅色底上太细,2px 更容易跟住 (2026-10-19 用户反馈
           "光标有时候是白色的"——白色的是 Windows 的 I 型鼠标指针,不是输入
           光标;输入光标本身是黑色,只是太细时不显眼)。 */
        cursorWidth: 2
      });

      editor.onDidChangeCursorPosition((e) => emit('cursor', toPos(e.position)));
      editor.onDidChangeCursorSelection(() => {
        emit('selection', adapter.getSelection());
      });
      editor.onDidChangeModelContent(() => emit('change'));

      /* Ctrl+click jumps to the definition (SPEC D7).
       * Double click must NOT jump: selecting a word with it is how the user
       * asks "what can I do with this?", and swallowing it moved the caret to
       * the top of the definition line instead of leaving the word selected. */
      editor.onMouseDown((e) => {
        const be = e.event && e.event.browserEvent;
        if (!be) return;
        const pos = e.target && e.target.position;

        /* Right-click: hand back Monaco's own hit test result immediately.
         * The DOM contextmenu event is not usable (Monaco consumes it), and
         * deriving the word from screen coordinates fails as soon as anything
         * overlays the editor - in which case the caller would fall back to the
         * caret's word, i.e. a different line entirely. Ctrl+click already
         * proves this event carries a trustworthy position. */
        if (be.button === 2) {
          const model = editor.getModel();
          const w = pos && model ? model.getWordAtPosition(pos) : null;
          emit('rightClick', {
            x: be.clientX,
            y: be.clientY,
            position: pos ? toPos(pos) : null,
            word: w ? w.word : ''
          });
          return;
        }

        if (!pos) return;
        const model = editor.getModel();
        const w = model ? model.getWordAtPosition(pos) : null;

        if (be.ctrlKey || be.metaKey) {
          if (w) emit('navigate', toPos(pos), w.word);
          return;
        }

        /* Double click must NOT jump: selecting a word with it is how the user
         * asks "what can I do with this?" (the original reader's D7 decision).
         * Jumping is Ctrl+click or F12. */
        if (be.button === 0 && be.detail === 2 && w) {
          emit('singleClick', { position: toPos(pos), word: w.word });
          return;
        }

        /* Double click on BLANK space = "write code here" (user request
         * 2026-10-12). It only fires where there is no identifier: double
         * clicking a WORD still selects it, which is how the action bar works. */
        if (be.button === 0 && be.detail === 2 && !w) {
          emit('doubleClickEmpty', { position: toPos(pos) });
          return;
        }

        /* Plain left click feeds the Context Window (SPEC F2.12): clicking a
         * name shows its definition below, the way Source Insight does. */
        if (be.button === 0) {
          emit('singleClick', { position: toPos(pos), word: w ? w.word : '' });
        }
      });

      /* The app renders its own action menu (查找/调用/定义/高亮/...). Monaco's
       * built-in menu would sit above it and swallow the click, so the
       * contribution is disposed; `contextmenu: true` stays on so the mouse-down
       * hit test keeps working. */
      try {
        const contextMenuContribution = editor.getContribution('editor.contrib.contextmenu');
        if (contextMenuContribution && typeof contextMenuContribution.dispose === 'function') {
          contextMenuContribution.dispose();
        }
      } catch { /* contribution absent in this Monaco build */ }

      return editor;
    },

    setContent(absPath, text, language) {
      const lang = language || languageOf(absPath);
      /* ONE FILE, ONE MODEL. Paths arrive here in more than one spelling - the
       * file tree hands over `C:\proj\a.c`, the Context Window builds
       * `C:/proj/a.c` from the project root - and this cache is keyed by the
       * spelling while Monaco keys models by URI. So the second spelling missed
       * the cache, called createModel on a URI that already had a model, and
       * threw "Cannot add model because it already exists!": the window ended up
       * titled with the new file, breadcrumbed 打开失败, and still showing the
       * old one (found 2026-10-13 while verifying "open the file a use lives
       * in"). Canonicalising the key AND falling back to Monaco's own registry
       * removes the whole class of failure. */
      const key = modelKey(absPath);
      const uri = monaco.Uri.file(key);
      let model = models.get(key) || monaco.editor.getModel(uri);
      if (!model || model.isDisposed()) {
        model = monaco.editor.createModel(text, lang, uri);
      } else if (model.getValue() !== text) {
        model.setValue(text);
      }
      models.set(key, model);
      editor.setModel(model);
      adapter.clearSemanticSpans();
      adapter.clearCodeEmphasis();
      adapter.highlightMatches([]);
      /* The marks belonged to the model that was open, not to this one. */
      adapter.clearAiInserted();
      return model;
    },

    hasOpenModel(absPath) {
      const m = models.get(modelKey(absPath)) || monaco.editor.getModel(monaco.Uri.file(modelKey(absPath)));
      return !!m && !m.isDisposed();
    },

    disposeModel(absPath) {
      const key = modelKey(absPath);
      const m = models.get(key) || monaco.editor.getModel(monaco.Uri.file(key));
      if (m && !m.isDisposed()) m.dispose();
      models.delete(key);
    },

    getText() {
      const m = editor && editor.getModel();
      return m ? m.getValue() : '';
    },

    isDirty() {
      const m = editor && editor.getModel();
      return !!(m && typeof m.isDirty === 'function' && m.isDirty());
    },

    /* The model's alternative version id: undo/redo back to the saved state
     * returns the SAME value, so "has this file changed?" costs one integer
     * comparison instead of loading and comparing the whole document on every
     * keystroke. */
    getVersionId() {
      const m = editor && editor.getModel();
      return (m && typeof m.getAlternativeVersionId === 'function')
        ? m.getAlternativeVersionId() : 0;
    },

    setReadOnly(flag) {
      if (editor) editor.updateOptions({ readOnly: !!flag });
    },

    /* Whole-editor font size - a different thing from the per-token
     * SemanticStyle.fontSize that v1 cannot honour (SPEC D14). */
    setFontSize(px) {
      const n = Number(px);
      if (editor && Number.isFinite(n)) {
        editor.updateOptions({ fontSize: n, lineHeight: lineHeightFor(n) });
      }
    },

    /* ------------------------------------------------------- position & view */

    getCursor() {
      if (!editor) return { line: 1, column: 1 };
      return toPos(editor.getPosition());
    },

    setCursor(pos) {
      if (!editor) return;
      editor.setPosition({ lineNumber: pos.line, column: pos.column });
    },

    getSelection() {
      if (!editor) return null;
      const sel = editor.getSelection();
      const model = editor.getModel();
      if (!sel || !model) return null;
      const start = toPos(sel.getStartPosition());
      const end = toPos(sel.getEndPosition());
      return {
        start,
        end,
        empty: sel.isEmpty(),
        text: model.getValueInRange(sel)
      };
    },

    getWordAtCursor() {
      if (!editor) return '';
      const pos = editor.getPosition();
      const model = editor.getModel();
      if (!pos || !model) return '';
      const w = model.getWordAtPosition(pos);
      return w ? w.word : '';
    },

    /**
     * Screen point -> the identifier underneath it (SPEC 6.1).
     *
     * The right-click menu must describe the word the user actually clicked.
     * Monaco does not move the caret on every right-click, so asking for the
     * caret's word can return a different line - or nothing at all.
     */
    /** Screen point of a text position (used by the right-click regression).
     *  `left` is relative to the text area, so the gutter width has to be added
     *  back or the point lands on a different token. */
    pointOf(line, column) {
      if (!editor || typeof editor.getScrolledVisiblePosition !== 'function') return null;
      const v = editor.getScrolledVisiblePosition({ lineNumber: line, column: column });
      const dom = editor.getDomNode();
      if (!v || !dom) return null;
      const rect = dom.getBoundingClientRect();
      const layout = editor.getLayoutInfo ? editor.getLayoutInfo() : null;
      const contentLeft = layout ? layout.contentLeft : 0;
      return { x: rect.left + contentLeft + v.left + 3, y: rect.top + v.top + v.height / 2 };
    },

    getWordAtPoint(clientX, clientY) {
      if (!editor || typeof editor.getTargetAtClientPoint !== 'function') return null;
      const target = editor.getTargetAtClientPoint(clientX, clientY);
      const pos = target && target.position;
      const model = editor.getModel();
      if (!pos || !model) return null;

      const w = model.getWordAtPosition(pos);
      return {
        position: toPos(pos),
        word: w ? w.word : '',
        startColumn: w ? w.startColumn : pos.column,
        endColumn: w ? w.endColumn : pos.column
      };
    },

    setSelection(range) {
      if (!editor || !range) return;
      editor.setSelection(new monaco.Range(
        range.start.line, range.start.column, range.end.line, range.end.column
      ));
    },

    /** Viewport rect of a position, in client coordinates. Used to anchor the
     *  floating action bar (DOM renderers must provide the same thing). */
    getScreenRect(pos) {
      if (!editor) return null;
      const p = pos || editor.getPosition();
      if (!p) return null;
      const r = editor.getScrolledVisiblePosition({ lineNumber: p.line, column: p.column });
      const node = editor.getDomNode();
      if (!r || !node) return null;
      const base = node.getBoundingClientRect();
      return { left: base.left + r.left, top: base.top + r.top, height: r.height };
    },

    replaceSelection(text) {
      if (!editor) return false;
      const sel = editor.getSelection();
      if (!sel) return false;
      editor.executeEdits('code-reader', [{ range: sel, text, forceMoveMarkers: true }]);
      editor.focus();
      return true;
    },

    /* Insert at an explicit position. An AI answer arrives seconds later, by
     * which time the caret may well have moved - the insertion point must not
     * (SPEC F2.15). */
    insertAt(pos, text) {
      if (!editor || !pos) return false;
      const range = new monaco.Range(pos.line, pos.column, pos.line, pos.column);
      editor.executeEdits('ai-edit', [{ range, text: String(text), forceMoveMarkers: true }]);
      editor.focus();
      return true;
    },

    revealLine(line, center) {
      if (!editor) return;
      if (center !== false) editor.revealLineInCenter(line);
      else editor.revealLine(line);
      editor.setPosition({ lineNumber: line, column: 1 });
    },

    focus() {
      if (editor) editor.focus();
    },

    /* ------------------------------------------------------ semantic styling */

    applySemanticSpans(spans) {
      if (!editor) return 0;
      const decos = [];
      for (const span of spans || []) {
        const cls = registry.className(monacoStyle(span.style));
        for (const r of span.ranges) {
          decos.push({ range: toRange(r), options: { inlineClassName: cls } });
        }
      }
      if (!semCollection) semCollection = editor.createDecorationsCollection(decos);
      else semCollection.set(decos);
      return decos.length;
    },

    clearSemanticSpans() {
      if (semCollection) semCollection.clear();
    },

    /* ------------------------------------------------------ code emphasis

       函数名加粗 + 偏亮的蓝,宏(全大写标识符)柔和红 (user request 2026-10-19)。
       定义/声明用更深的偏紫亮蓝(syn-fn-def),调用用稍深的蓝(syn-fn) —— 两者的
       区分见 looksLikeDefinition()。

       Monaco 内置的 C/C++ 词法把函数名和宏名都归成普通 `identifier`,主题规则
       是按 token 类型匹配的,够不着它们;所以这里再读一遍 token 流,按"后面紧跟
       左括号"、"全大写"、"是不是定义"几条规则打行内 class。颜色写在 CSS 变量里
       (--syn-fn-def / --syn-fn / --syn-macro),切主题不用重算装饰。

       这是可选的适配器能力:app 用 applyCodeEmphasis?.() 调用,换了内核也不影响。
    */
    applyCodeEmphasis(opts) {
      const model = editor && editor.getModel();
      if (!model) return 0;
      const lang = model.getLanguageId();
      if (lang !== 'c' && lang !== 'cpp') { adapter.clearCodeEmphasis(); return 0; }

      const afterEdit = !!(opts && opts.afterEdit);
      const text = model.getValue();
      /* 整篇 tokenize 的代价随文件线性涨(实测 120KB≈40ms、1.4MB≈270ms)。
         打开时给 512KB 上限(一次性 ~100ms),编辑后的重算收紧到 160KB,
         否则在 300ms 的停顿点整篇重词法会有明显顿感。超限时**保留**已有
         装饰而不是清掉 —— 用户在大文件里打字不该看着颜色消失。 */
      if (text.length > (afterEdit ? 160 * 1024 : 512 * 1024)) return 0;
      /* 连续敲字时每次停顿都重算没有意义,1s 内只做一次。 */
      if (afterEdit && Date.now() - emphAt < 1000) return 0;
      emphAt = Date.now();

      let toks;
      try {
        toks = monaco.editor.tokenize(text, lang);
      } catch (err) {
        console.warn('[editor] tokenize failed, emphasis skipped:', err);
        return 0;
      }

      const lines = text.split('\n');
      const decos = [];
      let sawIdent = false;
      /* token.offset 是**行内**偏移(0 起,列号 = 偏移 + 1),不是整篇文档的偏移。 */
      for (let i = 0; i < toks.length && decos.length < 30000; i++) {
        const lineToks = toks[i];
        const line = lines[i] || '';
        for (let k = 0; k < lineToks.length; k++) {
          const type = lineToks[k].type;
          /* 只看标识符 token:注释、字符串、关键字、数字已经被词法标好了 */
          if (!type || type.indexOf('identifier') !== 0) continue;
          sawIdent = true;
          const start = lineToks[k].offset;
          const end = k + 1 < lineToks.length ? lineToks[k + 1].offset : line.length;
          if (start < 0 || start >= line.length) continue;
          const name = line.slice(start, end).trimEnd();
          if (!name) continue;

          const isMacro = /^[A-Z_][A-Z0-9_]{2,}$/.test(name);
          const isFn = !isMacro && FN_SKIP.has(name) === false
            && /^\s*\(/.test(line.slice(start + name.length));
          if (!isMacro && !isFn) continue;

          /* 预处理行上的小写宏(#define foo(x))不算函数调用,别涂成函数色。 */
          let cls = 'syn-fn';
          if (isMacro) cls = 'syn-macro';
          else if (/^\s*#/.test(line)) continue;
          else if (looksLikeDefinition(line, start, lines[i - 1])) cls = 'syn-fn-def';

          decos.push({
            range: new monaco.Range(i + 1, start + 1, i + 1, start + 1 + name.length),
            options: { inlineClassName: cls }
          });
        }
      }

      /* Monaco 的 C 词法器是懒加载的:第一次打开 C 文件时,setModel 之后立刻
         tokenize 拿到的还是"整行一个空 token",一个标识符都认不出来。等一拍
         再算一次(只等一次),否则第一个文件永远没有函数/宏的强调色。 */
      if (!sawIdent) {
        if (emphRetryModel !== model) {
          emphRetryModel = model;
          clearTimeout(emphRetryTimer);
          emphRetryTimer = setTimeout(() => {
            emphRetryTimer = 0;
            if (editor && editor.getModel() === model) adapter.applyCodeEmphasis();
          }, 300);
        }
        return 0;
      }

      if (!synCollection) synCollection = editor.createDecorationsCollection(decos);
      else synCollection.set(decos);
      return decos.length;
    },

    clearCodeEmphasis() {
      if (synCollection) synCollection.clear();
      emphRetryModel = null;
      emphAt = 0;
      clearTimeout(emphRetryTimer);
      emphRetryTimer = 0;
    },

    /* 单击一个词后，把当前模型里所有同名的词都临时标成嫩绿色；
       持久高亮是黄色，两套装饰集合互不影响。 */
    transientHighlightWord(word) {
      if (!editor) return;
      const model = editor.getModel();
      const text = String(word || '').trim();
      if (!model || text === '') {
        this.transientHighlight([]);
        return;
      }
      const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      let matches = [];
      try { matches = model.findMatches(`\\b${escaped}\\b`, false, true, true, null, false, 400); }
      catch { matches = model.findMatches(text, false, false, true, null, false, 400); }
      this.transientHighlight(matches.map((m) => ({
        start: { line: m.range.startLineNumber, column: m.range.startColumn },
        end: { line: m.range.endLineNumber, column: m.range.endColumn },
      })));
    },
    transientHighlight(ranges) {
      if (!editor) return;
      const cls = registry.className({ backgroundColor: 'rgba(88, 190, 120, .26)' });
      const decos = (ranges || []).map((r) => ({
        range: toRange(r),
        options: { inlineClassName: cls }
      }));
      if (!transientCollection) transientCollection = editor.createDecorationsCollection(decos);
      else transientCollection.set(decos);
    },
    highlightMatches(ranges) {
      if (!editor) return;
      const cls = registry.className({ backgroundColor: 'rgba(255, 196, 0, 0.45)' });
      const decos = (ranges || []).map((r) => ({
        range: toRange(r),
        options: { inlineClassName: cls }
      }));
      if (!matchCollection) matchCollection = editor.createDecorationsCollection(decos);
      else matchCollection.set(decos);
    },

    /* ------------------------------------------------- AI-inserted code

       Code the model wrote is marked until the file is saved, so the user can
       tell at a glance what came from the model and what came from the
       codebase (user request 2026-10-12). Whole-line background plus a colour
       bar in the gutter: a background alone is easy to miss on a light theme.
    */

    markAiInserted(startLine, lineCount) {
      if (!editor || !startLine || lineCount <= 0) return 0;
      const decos = [];
      for (let i = 0; i < lineCount; i++) {
        decos.push({
          range: new monaco.Range(startLine + i, 1, startLine + i, 1),
          options: {
            isWholeLine: true,
            className: 'ai-ins-line',            // tinted background
            inlineClassName: 'ai-ins-text',      // coloured + bold text
            linesDecorationsClassName: 'ai-ins-gutter'
          }
        });
      }
      if (!aiCollection) aiCollection = editor.createDecorationsCollection(decos);
      else aiCollection.set(decos);
      return decos.length;
    },

    clearAiInserted() {
      if (aiCollection) aiCollection.clear();
    },

    /* ------------------------------------------------ inline AI editing

       The AI edit flow lives IN the document: the request is text the user
       types, the answer is text the model writes, and a small bar sits between
       them. That needs two things from the editor - decorations whose ranges
       FOLLOW EDITS, and a view zone for the bar.

       Tracking by decoration id rather than by line number is what makes
       "edit the request and regenerate" work: Monaco moves the range along with
       the text, so no arithmetic of ours can drift.
    */

    addDecorations(decos) {
      if (!editor) return [];
      /* Ranges arrive in the adapter's own shape ({ start: { line, column } })
       * and must be converted: Monaco silently creates nothing for a plain
       * object, which then reads as "the decoration has no range".
       *
       * `noGrow` maps to the stickiness rule. Without it, a decoration whose
       * end sits exactly where the user starts typing SWALLOWS the new text -
       * which quietly turned the AI slot into a range covering the request too,
       * making "has anything been written?" answer no. */
      return editor.deltaDecorations([], (decos || []).map((d) => {
        const opts = Object.assign({}, d.options);
        opts.stickiness = d.noGrow
          ? monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
          : monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges;
        return { range: toRange(d.range), options: opts };
      }));
    },

    updateDecorations(oldIds, decos) {
      if (!editor) return [];
      return editor.deltaDecorations(oldIds || [], (decos || []).map((d) => ({
        range: toRange(d.range),
        options: d.options
      })));
    },

    removeDecorations(ids) {
      if (editor && ids && ids.length) editor.deltaDecorations(ids, []);
    },

    /** Live range of a tracked decoration in the adapter's own shape, or null
     *  once it is gone. Monaco's IRange never leaves this file (SPEC 13.2). */
    decorationRange(id) {
      const model = editor && editor.getModel();
      const r = (model && id) ? model.getDecorationRange(id) : null;
      return r ? { start: toPos(r.getStartPosition()), end: toPos(r.getEndPosition()) } : null;
    },

    /** Text currently covered by a range (used to read the AI request back). */
    textInRange(range) {
      const model = editor && editor.getModel();
      return (model && range) ? model.getValueInRange(toRange(range)) : '';
    },

    /** Seal the current edit into its own undo unit. Everything before it is
     *  one step, everything after starts another. */
    pushUndoStop() {
      if (!editor) return false;
      const m = editor.getModel();
      if (m) m.pushStackElement();
      return true;
    },

    /** Forget the undo history, keeping the content.
     *
     *  Monaco has no "drop the stack" call; re-setting the model's value is the
     *  documented way, and going through the model keeps it off the editor's
     *  own event path. Used so an AI edit session leaves NO trace in Ctrl+Z -
     *  without it, cancelling the session removed the text but left the three
     *  edits that created it on the stack, so the next Ctrl+Z put the request
     *  text right back into the file (user report 2026-10-12). */
    dropUndoHistory() {
      if (!editor) return false;
      const m = editor.getModel();
      if (!m) return false;
      const pos = editor.getPosition();
      const top = editor.getScrollTop();
      m.setValue(m.getValue());
      if (pos) editor.setPosition(pos);
      editor.setScrollTop(top);
      return true;
    },

    lineCount() {
      if (!editor) return 0;
      const m = editor.getModel();
      return m ? m.getLineCount() : 0;
    },

    /** The text of one line, terminator stripped. Reading a line whole is what
     *  keeps the AI edit request from being cut in half by the caret. */
    lineText(lineNumber) {
      if (!editor) return '';
      const m = editor.getModel();
      if (!m || !lineNumber || lineNumber < 1 || lineNumber > m.getLineCount()) return '';
      return m.getLineContent(lineNumber);
    },

    /** Height of one editor line, for sizing a view zone in whole lines. */
    lineHeight() {
      if (!editor) return 0;
      return editor.getOption(monaco.editor.EditorOption.lineHeight) || 0;
    },

    /** Width of one monospace character in the editor's current font. */
    charWidth() {
      if (!editor) return 0;
      const info = editor.getOption(monaco.editor.EditorOption.fontInfo);
      return (info && info.typicalHalfwidthCharacterWidth) || 0;
    },

    /** Column just past the last character of a line - where a trailing button
     *  wants to sit. */
    lineEndColumn(lineNumber) {
      const model = editor && editor.getModel();
      if (!model || !lineNumber) return 1;
      const n = Math.min(Math.max(1, lineNumber), model.getLineCount());
      return model.getLineMaxColumn(n);
    },

    /** Replace a range with text. The answer takes the place of the request it
     *  was written for, so the code lands exactly where it was described. */
    replaceRange(range, text) {
      if (!editor || !range) return false;
      editor.executeEdits('ai-edit', [{
        range: toRange(range),
        text: String(text),
        forceMoveMarkers: true
      }]);
      return true;
    },

    /** Delete a range - used to take back the text an AI edit session owns. */
    deleteRange(range) {
      if (!editor || !range) return false;
      editor.executeEdits('ai-edit', [{
        range: toRange(range),
        text: '',
        forceMoveMarkers: true
      }]);
      return true;
    },

    /** Drop whole lines [startLine, endLineExclusive). Regenerating an answer
     *  means removing the previous one, and decorations only style text - they
     *  never delete it. */
    deleteLines(startLine, endLineExclusive) {
      const model = editor && editor.getModel();
      if (!model || endLineExclusive <= startLine) return false;
      const last = Math.min(endLineExclusive, model.getLineCount() + 1);
      editor.executeEdits('ai-edit', [{
        range: new monaco.Range(startLine, 1, last, 1),
        text: '',
        forceMoveMarkers: true
      }]);
      return true;
    },

    /** A DOM band between two lines - where the AI edit buttons live. */
    addViewZone(afterLineNumber, heightInPx, domNode) {
      if (!editor) return null;
      let zoneId = null;
      editor.changeViewZones((accessor) => {
        zoneId = accessor.addZone({
          afterLineNumber,
          heightInPx,
          domNode,
          suppressMouseDown: false
        });
      });
      return zoneId;
    },

    removeViewZone(zoneId) {
      if (editor && zoneId) editor.changeViewZones((a) => a.removeZone(zoneId));
    },

    /**
     * A floating node pinned to a text position, taking part in NO layout.
     *
     * That is the point: buttons that sit at the end of a line cost no vertical
     * space and do not push the code around (user request 2026-10-12).
     * `getPos` returns { line, column } or null to hide the widget, which is
     * how "no answer yet, so no Insert button" is expressed.
     */
    addContentWidget(id, domNode, getPos) {
      if (!editor) return null;
      const widget = {
        getId: () => 'cr-widget-' + id,
        getDomNode: () => domNode,
        getPosition: () => {
          const p = getPos();
          if (!p || !p.line) return null;
          return {
            position: { lineNumber: p.line, column: p.column || 1 },
            preference: [monaco.editor.ContentWidgetPositionPreference.EXACT]
          };
        }
      };
      editor.addContentWidget(widget);
      return widget;
    },

    removeContentWidget(widget) {
      if (editor && widget) editor.removeContentWidget(widget);
    },

    /** Call after the position the widget follows has moved. */
    layoutContentWidget(widget) {
      if (editor && widget) editor.layoutContentWidget(widget);
    },

    setTheme(name) {
      if (monaco) monaco.editor.setTheme(name);
    },

    registerTheme(name, theme) {
      monaco.editor.defineTheme(name, theme);
    },

    /* ------------------------------------------------------------- commands */

    undo() { if (editor) editor.trigger('api', 'undo', null); },
    redo() { if (editor) editor.trigger('api', 'redo', null); },

    addAction(id, label, keybinding, run) {
      if (!editor) return;
      editor.addAction({
        id,
        label,
        keybindings: keybinding ? [keybinding] : [],
        run: () => run()
      });
    },

    /** keySpec is a portable name such as 'F12' or 'Ctrl+Shift+K'; the adapter
     *  maps it onto the kernel's own key code so app code stays agnostic. */
    registerShortcut(keySpec, handler) {
      if (!editor) return;
      const parts = String(keySpec).split('+').map((p) => p.trim()).filter(Boolean);
      let code = 0;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (i === parts.length - 1) {
          const kc = monaco.KeyCode[p];
          if (kc === undefined) { console.warn('[MonacoAdapter] unknown key: ' + keySpec); return; }
          code |= kc;
        } else {
          const mod = monaco.KeyMod[p];
          if (mod === undefined) { console.warn('[MonacoAdapter] unknown modifier: ' + p); return; }
          code |= mod;
        }
      }
      editor.addCommand(code, () => handler());
    },

    /* -------------------------------------------------------------- events */

    onCursorMove(cb) { listeners.cursor.push(cb); },
    onSelectionChange(cb) { listeners.selection.push(cb); },
    onNavigateRequest(cb) { listeners.navigate.push(cb); },
    onChange(cb) { listeners.change.push(cb); },
    /* Right-click: carries Monaco's hit test result (position + word). */
    onRightClick(cb) { listeners.rightClick.push(cb); },

    /* Plain left click on a name - drives the Context Window (SPEC F2.12). */
    onSingleClick(cb) { listeners.singleClick.push(cb); },

    /* Double click on blank space - opens the AI edit box (SPEC F2.15). */
    onDoubleClickEmpty(cb) { listeners.doubleClickEmpty.push(cb); },

    get raw() { return editor; }
  };

  return assertAdapter(adapter);
}

window.createMonacoAdapter = createMonacoAdapter;

})();
