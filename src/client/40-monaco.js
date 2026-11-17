    /* ------------------------------------------------------------------ Monaco */

    let monacoPromise = null;

    function ensureMonaco() {
      if (window.monaco) return Promise.resolve(window.monaco);
      if (monacoPromise !== null) return monacoPromise;
      beacon('monaco-load');
      monacoPromise = loadScript(`${API}/vendor/monaco/vs/loader.js`)
        .then(() => new Promise((resolve, reject) => {
          const loader = window.require;
          if (!loader || typeof loader.config !== 'function') {
            reject(new Error('Monaco loader 未注册 window.require'));
            return;
          }
          const timer = window.setTimeout(() => reject(new Error('Monaco 加载超时')), 20000);
          try {
            loader.config({ paths: { vs: `${API}/vendor/monaco/vs` } });
            loader(['vs/editor/editor.main'], () => {
              window.clearTimeout(timer);
              if (window.monaco) resolve(window.monaco);
              else reject(new Error('Monaco 未暴露 window.monaco'));
            }, (error) => {
              window.clearTimeout(timer);
              reject(error instanceof Error ? error : new Error(String(error)));
            });
          } catch (error) {
            window.clearTimeout(timer);
            reject(error);
          }
        }))
        .catch((error) => {
          monacoPromise = null;
          beacon('monaco-fail', error?.message ?? String(error));
          throw error;
        });
      return monacoPromise;
    }

    function cssToken(name, fallback) {
      const layer = document.querySelector('.sl-layer');
      const target = layer ?? document.body;
      const value = getComputedStyle(target).getPropertyValue(name).trim()
        || getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return value || fallback;
    }

    function clampByte(value) {
      return Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
    }

    function hex2(value) {
      return clampByte(value).toString(16).padStart(2, '0');
    }

    /** Parse the CSS colors DSH actually emits (#rgb, #rrggbb, #rrggbbaa,
     *  rgb()/rgba()). Monaco only accepts 6/8-digit hex in theme colors. */
    function parseColor(value) {
      const input = String(value || '').trim();
      if (input === '' || input === 'transparent') return null;
      let match = /^#([0-9a-f]{3})$/i.exec(input);
      if (match) {
        const raw = match[1].split('').map((part) => part + part).join('');
        return {
          r: parseInt(raw.slice(0, 2), 16),
          g: parseInt(raw.slice(2, 4), 16),
          b: parseInt(raw.slice(4, 6), 16),
          a: 1,
        };
      }
      match = /^#([0-9a-f]{6})$/i.exec(input);
      if (match) {
        return {
          r: parseInt(match[1].slice(0, 2), 16),
          g: parseInt(match[1].slice(2, 4), 16),
          b: parseInt(match[1].slice(4, 6), 16),
          a: 1,
        };
      }
      match = /^#([0-9a-f]{8})$/i.exec(input);
      if (match) {
        return {
          r: parseInt(match[1].slice(0, 2), 16),
          g: parseInt(match[1].slice(2, 4), 16),
          b: parseInt(match[1].slice(4, 6), 16),
          a: parseInt(match[1].slice(6, 8), 16) / 255,
        };
      }
      match = /^rgba?\(([^)]+)\)$/i.exec(input);
      if (match) {
        const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
          return {
            r: clampByte(parts[0]),
            g: clampByte(parts[1]),
            b: clampByte(parts[2]),
            a: parts[3] === undefined ? 1 : Math.max(0, Math.min(1, parts[3])),
          };
        }
      }
      return null;
    }

    function monacoColor(value, fallback) {
      const color = parseColor(value) || parseColor(fallback) || { r: 0, g: 0, b: 0 };
      return `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}`;
    }

    function withAlpha(value, alpha) {
      const color = parseColor(value) || parseColor('#2f6fed') || { r: 0, g: 0, b: 0 };
      const a = Math.round(Math.max(0, Math.min(1, Number(alpha) || 0)) * 255);
      return `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}${hex2(a)}`;
    }

    /* 光标颜色按实际背景亮度选，避免某个主题的 token 缺失/错判时和底色同色。 */
    function cursorColorFor(bgHex) {
      const match = /^#?([0-9a-f]{6})$/i.exec(String(bgHex || ''));
      if (!match) return '#0b57d0';
      const n = parseInt(match[1], 16);
      const r = (n >> 16) & 255;
      const g = (n >> 8) & 255;
      const b = n & 255;
      const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      /* 恢复正常编辑器的观感：深底近白，浅底深灰；不跟主题 token 走，避免同色。 */
      return luminance < 0.45 ? '#e8eef8' : '#1f2328';
    }
    /** 当前主题下编辑器会被涂成的背景色（与 defineMonacoTheme 用同一份 token）。 */
    function themeBackground() {
      const layer = document.querySelector('.sl-layer');
      const explicitTheme = layer?.getAttribute('data-sl-theme');
      const dark = explicitTheme === 'dark'
        || (explicitTheme !== 'light' && document.body.hasAttribute('data-ds-dark-theme'));
      const bg = monacoColor(cssToken('--dsw-alias-bg-base', dark ? '#202329' : '#ffffff'), dark ? '#202329' : '#ffffff');
      return { dark, bg };
    }

    /**
     * 光标颜色**只由主题背景算**，不读计算样式。
     * 以前 `applyCursorContrast` 会 getComputedStyle 量实际背景：主题切换是异步生效的
     * （setTheme → 下一帧才重绘），测量很容易落在旧主题上（深色→浅色的中间帧），
     * 于是把 --sl-cursor-color 写成白色并一直保留 —— 浅色下就是"白底白光标"。
     * 背景本来就是我们在主题里设的 editor.background，用它算即可，天然不会错位。
     */
    function syncCursorColor(bgHex) {
      try {
        const bg = typeof bgHex === 'string' && bgHex !== '' ? bgHex : themeBackground().bg;
        document.documentElement.style.setProperty('--sl-cursor-color', cursorColorFor(bg));
      } catch { /* 主题 token 还没就绪：保持上一次的值 */ }
    }

    /* 保留旧名字：编辑器挂载完成、模式切换、窗口重新可见时都调它做一次同步。 */
    function applyCursorContrast() {
      syncCursorColor();
    }

    function defineMonacoTheme(monaco) {
      const { dark, bg } = themeBackground();
      const fg = monacoColor(cssToken('--dsw-alias-label-primary', dark ? '#c0c6d0' : '#1f1f1f'), dark ? '#c0c6d0' : '#1f1f1f');
      const fg2 = monacoColor(cssToken('--dsw-alias-label-secondary', dark ? '#a4abb7' : '#767676'), dark ? '#a4abb7' : '#767676');
      const layer1 = monacoColor(cssToken('--dsw-alias-bg-layer-1', dark ? '#272b32' : '#f3f3f3'), dark ? '#272b32' : '#f3f3f3');
      const overlay = monacoColor(cssToken('--dsw-alias-bg-overlay', dark ? '#272b32' : '#ffffff'), dark ? '#272b32' : '#ffffff');
      const border = monacoColor(cssToken('--dsw-alias-border-l1', dark ? '#3c424d' : '#d0d0d0'), dark ? '#3c424d' : '#d0d0d0');
      const brand = monacoColor(cssToken('--dsw-alias-brand-primary', dark ? '#6fa0e0' : '#005fb8'), dark ? '#6fa0e0' : '#005fb8');
      const lineHighlight = monacoColor(
        cssToken('--sl-line-highlight', dark ? '#252930' : '#f6f8fa'),
        dark ? '#252930' : '#f6f8fa',
      );
      /* The original reader's editor palette: light-grey line numbers, a very
       * soft current-line tint and VS-style selection. */
      const lineNo = dark ? '#5b626d' : '#b3bac3';
      const lineNoActive = dark ? '#b3b9c3' : '#4a5159';
      const selection = dark ? '#2b4666' : '#add6ff';
      const selectionInactive = dark ? '#26313f' : '#e6ecf2';
      const tokenColor = (name, fallback) => monacoColor(cssToken(name, fallback), fallback).slice(1);
      const rules = [
        { token: '', foreground: fg.slice(1) },
        { token: 'comment', foreground: tokenColor('--sl-syn-com', dark ? '#7d9177' : '#4a7c59'), fontStyle: 'italic' },
        { token: 'keyword', foreground: tokenColor('--sl-syn-kw', dark ? '#8cbcf5' : '#0d63ff') },
        { token: 'keyword.control', foreground: tokenColor('--sl-syn-kw', dark ? '#8cbcf5' : '#0d63ff') },
        { token: 'type', foreground: tokenColor('--sl-syn-type', dark ? '#79c0b6' : '#0f6472') },
        { token: 'type.identifier', foreground: tokenColor('--sl-syn-type', dark ? '#79c0b6' : '#0f6472') },
        { token: 'identifier', foreground: fg.slice(1) },
        { token: 'number', foreground: tokenColor('--sl-syn-num', dark ? '#e0907f' : '#c05a4d') },
        { token: 'number.hex', foreground: tokenColor('--sl-syn-num', dark ? '#e0907f' : '#c05a4d') },
        { token: 'string', foreground: tokenColor('--sl-syn-str', dark ? '#9dbd8a' : '#2f7d5a') },
        { token: 'string.escape', foreground: tokenColor('--sl-syn-str', dark ? '#9dbd8a' : '#2f7d5a') },
        { token: 'preprocessor', foreground: tokenColor('--sl-syn-pre', dark ? '#b08fbe' : '#795e26') },
        { token: 'delimiter', foreground: fg.slice(1) },
        { token: 'operator', foreground: fg.slice(1) },
      ];

      monaco.editor.defineTheme('sourcelook', {
        base: dark ? 'vs-dark' : 'vs',
        inherit: true,
        rules,
        colors: {
          'editor.background': bg,
          'editor.foreground': fg,
          'editor.lineHighlightBackground': lineHighlight,
          'editor.selectionBackground': selection,
          'editor.inactiveSelectionBackground': selectionInactive,
          /* 光标颜色跟随包体背景的亮度选（深底近白、浅底近黑）：主题 token 缺失
             或明暗判断错时也不会出现“白底白/深底黑”。CSS 侧还有一层
             --sl-cursor-color 覆盖（按编辑器真实渲染背景测量）。 */
          'editorCursor.foreground': cursorColorFor(bg),
          'editorLineNumber.foreground': lineNo,
          'editorLineNumber.activeForeground': lineNoActive,
          'editorIndentGuide.background1': lineNo,
          'editorIndentGuide.activeBackground1': lineNoActive,
          'editorWidget.background': overlay,
          'editorWidget.border': border,
          'editorSuggestWidget.background': overlay,
          'editorSuggestWidget.border': border,
          'editorSuggestWidget.selectedBackground': layer1,
          'editorHoverWidget.background': overlay,
          'editorHoverWidget.border': border,
          'editorBracketMatch.background': withAlpha(brand, 0.16),
          'editorBracketMatch.border': withAlpha(brand, 0.6),
          'scrollbarSlider.background': withAlpha(fg2, 0.18),
          'scrollbarSlider.hoverBackground': withAlpha(fg2, 0.3),
          'scrollbarSlider.activeBackground': withAlpha(fg2, 0.4),
          'minimap.background': bg,
        },
      });
      monaco.editor.setTheme('sourcelook');
      /* 变量和主题 token 同源同步写：两者永远一致，不依赖“下一帧量一次”。 */
      syncCursorColor(bg);
      window.requestAnimationFrame(() => syncCursorColor(bg));
    }

    function watchTheme(monaco) {
      const observer = new MutationObserver(() => {
        window.requestAnimationFrame(() => {
          try { defineMonacoTheme(monaco); } catch { /* the editor may already be disposed */ }
        });
      });
      observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class', 'style'] });
      /* P/C/D 切换时编辑器可能整体重绘；窗口从隐藏回到可见时同理。都补一次同步。 */
      const modeObserver = new MutationObserver(() => syncCursorColor());
      try {
        modeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-sourcelook-mode'] });
      } catch { /* not supported */ }
      const onVisible = () => { if (document.visibilityState !== 'hidden') syncCursorColor(); };
      document.addEventListener('visibilitychange', onVisible);
      return () => {
        observer.disconnect();
        modeObserver.disconnect();
        document.removeEventListener('visibilitychange', onVisible);
      };
    }
