    /* ------------------------------------------------------------ shell takeover */

    let savedRootStyle = null;
    /* Only the newest overlay instance may own the shell geometry; a stale
     * hot-reloaded instance must not restore #root and shift the DSH window. */
    let shellOwner = null;

    function readMode() {
      /* P = 插件独占，D = DSH 独占，C = 插件 + DSH 子窗口。上次关闭时的模式
         直接决定下次启动；非法值回退到三栏模式。 */
      const value = readStorage(MODE_KEY);
      return value === 'P' || value === 'D' || value === 'C' ? value : 'C';
    }

    function writeMode(mode) {
      writeStorage(MODE_KEY, mode);
    }

    function readTheme() {
      const value = readStorage(THEME_KEY);
      return ['light', 'dark', 'sepia', 'mint', 'graphite'].includes(value) ? value : 'auto';
    }

    function writeTheme(theme) {
      writeStorage(THEME_KEY, theme);
    }

    function readColors() {
      try {
        const raw = readStorage(COLORS_KEY);
        const data = raw === '' ? {} : JSON.parse(raw);
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
      } catch {
        return {};
      }
    }

    function writeColors(value) {
      try { writeStorage(COLORS_KEY, JSON.stringify(value)); } catch { /* quota */ }
    }

    /* 最近打开的工程（原版最多记 30 个，菜单里显示 8 个）。 */
    function readRecentProjects() {
      try {
        const raw = readStorage(RECENT_PROJECTS_KEY);
        const data = raw === null || raw === '' ? null : JSON.parse(raw);
        if (!Array.isArray(data)) return [];
        return data.filter((item) => typeof item === 'string' && item !== '').slice(0, 30);
      } catch {
        return [];
      }
    }

    function writeRecentProjects(list) {
      try {
        const unique = [];
        for (const item of list || []) {
          if (typeof item === 'string' && item !== '' && unique.indexOf(item) < 0) unique.push(item);
        }
        writeStorage(RECENT_PROJECTS_KEY, JSON.stringify(unique.slice(0, 30)));
      } catch { /* quota */ }
    }
    /* AI panel transcript (last 40 entries). Text is capped so localStorage
       cannot grow without bound; the key never leaves the machine. */
    function readAiLog() {
      try {
        const raw = readStorage(AI_LOG_KEY);
        const data = raw === null || raw === '' ? null : JSON.parse(raw);
        if (!Array.isArray(data)) return [];
        return data
          .filter((entry) => entry && typeof entry.text === 'string'
            && (entry.role === 'user' || entry.role === 'ai' || entry.role === 'error'))
          .slice(-40)
          .map((entry) => ({
            role: entry.role,
            text: entry.text.slice(0, 12000),
            model: typeof entry.model === 'string' ? entry.model : '',
            at: Number(entry.at) || Date.now(),
          }));
      } catch {
        return [];
      }
    }

    function writeAiLog(entries) {
      try {
        writeStorage(AI_LOG_KEY, JSON.stringify((entries || []).slice(-40).map((entry) => ({
          ...entry,
          text: String(entry.text || '').slice(0, 12000),
        }))));
      } catch { /* quota */ }
    }
    /* Pane collapse / mode state, persisted like the original's cr.paneFold. */
    function readPanes() {
      let data = null;
      try {
        const raw = readStorage(PANES_KEY);
        data = raw === null || raw === '' ? null : JSON.parse(raw);
      } catch {
        data = null;
      }
      return {
        symbolCollapsed: data?.symbolCollapsed === true,
        globalCollapsed: data?.globalCollapsed === true,
        globalMode: ['symbols', 'tree', 'files'].includes(data?.globalMode) ? data.globalMode : 'symbols',
        contextOpen: data?.contextOpen !== false,
        contextCollapsed: data?.contextCollapsed === true,
      };
    }

    function writePanes(value) {
      try { writeStorage(PANES_KEY, JSON.stringify(value)); } catch { /* quota */ }
    }
    /* AI provider settings (the key lives only in the renderer; the original
       reader does the same and forwards it per request). */
    const AI_DEFAULTS = {
      local: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder:7b' },
      remote: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    };

    function readAiConfig() {
      let stored = null;
      try {
        const raw = readStorage(AI_KEY);
        stored = raw === null || raw === '' ? null : JSON.parse(raw);
      } catch {
        stored = null;
      }
      const provider = stored?.provider === 'remote' ? 'remote' : 'local';
      const defaults = AI_DEFAULTS[provider];
      return {
        provider,
        baseUrl: typeof stored?.baseUrl === 'string' && stored.baseUrl !== '' ? stored.baseUrl : defaults.baseUrl,
        model: typeof stored?.model === 'string' && stored.model !== '' ? stored.model : defaults.model,
        apiKey: typeof stored?.apiKey === 'string' ? stored.apiKey : '',
      };
    }

    function writeAiConfig(value) {
      try { writeStorage(AI_KEY, JSON.stringify(value)); } catch { /* quota */ }
    }
    /* Reader font size: half-point steps like the original, 9–28 px. It drives
     * Monaco and the context-window code so both stay in step. */
    const FONT_MIN = 9;
    const FONT_MAX = 30;
    const FONT_DEFAULT = 11.5;
    /* 旧版本默认 14.5 / 13 / 10；升级时把它们当成“没设置过”，跟随新默认 11.5。 */
    const FONT_OLD_DEFAULTS = [14.5, 13, 10];

    function clampFontSize(value) {
      const size = Number(value);
      if (!Number.isFinite(size)) return FONT_DEFAULT;
      return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(size * 2) / 2));
    }

    function readFontSize() {
      const stored = Number(readStorage(FONT_SIZE_KEY));
      if (!Number.isFinite(stored) || stored <= 0) return FONT_DEFAULT;
      if (FONT_OLD_DEFAULTS.includes(stored)) return FONT_DEFAULT;
      return clampFontSize(stored);
    }

    function writeFontSize(value) {
      writeStorage(FONT_SIZE_KEY, String(clampFontSize(value)));
    }

    function readLastPos() {
      try {
        const raw = readStorage(LAST_POS_KEY);
        const data = raw === null || raw === '' ? null : JSON.parse(raw);
        return data && typeof data === 'object' ? data : null;
      } catch {
        return null;
      }
    }

    function writeLastPos(value) {
      try { writeStorage(LAST_POS_KEY, JSON.stringify(value)); } catch { /* quota */ }
    }

    /* Per-file caret memory, like the original reader: reopening a file puts
     * the caret back where it was left. Stored per project root. */
    function caretKey(root) {
      return `sourcelook.caret:${root}`;
    }

    function readCarets(root) {
      if (typeof root !== 'string' || root === '') return {};
      try {
        const raw = readStorage(caretKey(root));
        const data = raw === null || raw === '' ? null : JSON.parse(raw);
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
      } catch {
        return {};
      }
    }

    function writeCarets(root, value) {
      if (typeof root !== 'string' || root === '') return;
      try { writeStorage(caretKey(root), JSON.stringify(value)); } catch { /* quota */ }
    }

    function clampDshWidth(value, viewportWidth) {
      const max = Math.max(320, Math.round(viewportWidth * 0.7));
      const min = Math.min(360, max);
      return Math.round(Math.min(max, Math.max(min, Number(value) || 0)));
    }

    function readDshWidth(viewportWidth) {
      const stored = Number(readStorage(DSH_WIDTH_KEY));
      const fallback = Math.round(viewportWidth / 3);
      /* A stale 70%-wide DSH panel leaves SourceLook only a sliver. Treat
         anything past half the window as an old drag and restart at 1/3. */
      const base = Number.isFinite(stored) && stored > 0 && stored <= viewportWidth * 0.5
        ? stored
        : fallback;
      return clampDshWidth(base, viewportWidth);
    }

    function readSidebarWidth() {
      const ratio = Number(readStorage(SIDEBAR_RATIO_KEY));
      if (Number.isFinite(ratio) && ratio >= 0.2 && ratio <= 0.7) {
        return Math.max(240, Math.min(900, Math.round(window.innerWidth * ratio)));
      }
      const preferred = Math.max(360, Math.min(900, Math.round(window.innerWidth * 0.5)));
      writeStorage(SIDEBAR_RATIO_KEY, String(preferred / window.innerWidth));
      return preferred;
    }

    /* Pane proportions come from the original reader (380 / 409 at 1600px).
     * Stored as ratios of the *visible* width so the split view keeps its shape
     * when the DSH panel opens. A new key keeps old 50% experiments out. */
    const PANE_RATIOS_KEY = 'sourcelook.paneRatios';
    const DEFAULT_PANE_RATIOS = { sidebar: 380 / 1600, global: 409 / 1600 };

    function readPaneRatios() {
      try {
        const raw = readStorage(PANE_RATIOS_KEY);
        if (raw !== '') {
          const data = JSON.parse(raw);
          const sidebar = Number(data?.sidebar);
          const global = Number(data?.global);
          if (Number.isFinite(sidebar) && Number.isFinite(global)
            && sidebar >= 0.12 && sidebar <= 0.5
            && global >= 0.14 && global <= 0.5
            && sidebar + global <= 0.8) {
            return { sidebar, global };
          }
        }
      } catch {
        /* fall through to defaults */
      }
      return { ...DEFAULT_PANE_RATIOS };
    }

    function writePaneRatios(value) {
      try {
        writeStorage(PANE_RATIOS_KEY, JSON.stringify(value));
      } catch {
        /* quota */
      }
    }

    const SHELL_TOPBAR = 40;
    /* The floating DSH child window starts a few pixels below the plugin title
     * bar so it reads as a separate window, clear of the native caption buttons. */
    const SHELL_GAP = 0;
    const DSH_TOP = SHELL_TOPBAR + SHELL_GAP;

    function clampOutlineHeight(value, viewportHeight) {
      const max = Math.max(120, Math.round((Number(viewportHeight) || 800) * 0.55));
      return Math.min(max, Math.max(60, Math.round(Number(value) || 0)));
    }

    function readOutlineHeight() {
      const stored = Number(readStorage(OUTLINE_HEIGHT_KEY));
      return Number.isFinite(stored) && stored >= 60 ? clampOutlineHeight(stored, window.innerHeight) : 220;
    }

    function clampResultsHeight(value, viewportHeight) {
      const max = Math.max(120, Math.round((Number(viewportHeight) || 800) * 0.6));
      return Math.min(max, Math.max(120, Math.round(Number(value) || 0)));
    }

    function readResultsHeight() {
      const stored = Number(readStorage(RESULTS_HEIGHT_KEY));
      return Number.isFinite(stored) && stored >= 120
        ? clampResultsHeight(stored, window.innerHeight)
        : (window.innerHeight < 700 ? 170 : 200);
    }

    /* applyShell 会写这些内联属性；恢复时必须全部还原，否则从 C 切到 D 后
       top/left/right/max-width/min-width/margin 还停在“右侧子窗口”的几何上，
       DSH 独占模式就会出现重叠。 */
    const ROOT_STYLE_PROPS = [
      'width', 'height', 'position', 'z-index', 'top', 'left', 'right',
      'bottom', 'margin', 'margin-left', 'margin-top', 'max-width', 'min-width',
    ];

    function saveRootStyle(root) {
      savedRootStyle = {};
      for (const name of ROOT_STYLE_PROPS) {
        savedRootStyle[name] = {
          value: root.style.getPropertyValue(name),
          priority: root.style.getPropertyPriority(name),
        };
      }
    }

    function restoreRootStyle(root) {
      if (savedRootStyle === null || root === null) return;
      for (const name of ROOT_STYLE_PROPS) {
        const saved = savedRootStyle[name] || { value: '', priority: '' };
        if (saved.value === '') root.style.removeProperty(name);
        else root.style.setProperty(name, saved.value, saved.priority);
      }
      savedRootStyle = null;
    }

    /**
     * P / C / D geometry.
     *
     * C = plugin + DSH floating child window. The plugin keeps its full window
     * width (no reflow at all); the host DSH window is placed as a right-hand
     * panel that starts *below* the plugin title bar (40px) and is stacked
     * above the plugin content (z 45 > layer 40). It therefore overlays the
     * right side of the plugin instead of shrinking it. Its own 40px title band
     * keeps DSH's sidebar toggle / New Session / 应用·编辑 caption cluster
     * (moved by CSS) plus a plugin-drawn hide button.
     */
    function applyShell(mode, dshWidth, viewportWidth, owner) {
      shellOwner = owner;
      /* Mode / geometry changes are the only moments where the host's menu
         anchor can legitimately differ: refresh the cached CSS variable here. */
      resetDshMenuStartCache();
      const doc = document.documentElement;
      doc.dataset.sourcelookMode = mode;
      const dshLeft = Math.max(0, viewportWidth - dshWidth);
      doc.style.setProperty('--sl-dsh-left', `${mode === 'C' ? dshLeft : 0}px`);
      doc.style.setProperty('--sl-dsh-width', `${mode === 'C' ? dshWidth : 0}px`);
      /* The plugin itself never narrows: the DSH panel floats above it. */
      doc.style.setProperty('--sl-visible-w', `${viewportWidth}px`);
      doc.style.setProperty('--sl-topbar-h', `${SHELL_TOPBAR}px`);
      doc.style.setProperty('--sl-dsh-top', `${mode === 'C' ? DSH_TOP : 0}px`);

      const root = document.getElementById('root');
      if (mode === 'C') {
        if (root !== null) {
          if (savedRootStyle === null) saveRootStyle(root);
          /* Fixed, not relative: a stray document scroll must never drag the
             child window upward (the plugin layer itself is fixed). */
          root.style.setProperty('position', 'fixed', 'important');
          root.style.setProperty('top', `${DSH_TOP}px`, 'important');
          root.style.setProperty('left', `${dshLeft}px`, 'important');
          root.style.setProperty('right', '0', 'important');
          root.style.setProperty('width', `${dshWidth}px`, 'important');
          root.style.setProperty('max-width', 'none', 'important');
          root.style.setProperty('min-width', '0', 'important');
          root.style.setProperty('height', `calc(100vh - ${DSH_TOP}px)`, 'important');
          root.style.setProperty('margin', '0', 'important');
          /* Above the plugin layer (40) so the child window covers its right
           * side; the plugin title bar is at y 0..40 and never overlaps. */
          root.style.setProperty('z-index', '20', 'important');
        }
      } else if (root !== null) {
        restoreRootStyle(root);
      }
    }

    function restoreShell(owner) {
      /* A stale instance without a token (pre-1.1.74 overlay) must never
       * restore the shared window once a newer instance owns it. */
      if (owner !== shellOwner) return;
      shellOwner = null;
      const doc = document.documentElement;
      restoreRootStyle(document.getElementById('root'));
      delete doc.dataset.sourcelookMode;
      doc.style.removeProperty('--sl-dsh-left');
      doc.style.removeProperty('--sl-dsh-width');
      doc.style.removeProperty('--sl-visible-w');
      doc.style.removeProperty('--sl-topbar-h');
      doc.style.removeProperty('--sl-dsh-top');
    }

    /* DSH's menu start offset lives in a CSS variable on <html>. Reading it with
     * getComputedStyle forces a style recalculation of the whole document, so it
     * must never happen per frame — cache it per mode/geometry pass instead
     * (readDshMenuStart is only called when the menu really moves). */
    let dshMenuStartCache = null;
    function readDshMenuStart() {
      if (dshMenuStartCache !== null) return dshMenuStartCache;
      let menuStart = 48;
      try {
        const raw = getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-menu-start');
        const value = Number.parseFloat(raw);
        if (Number.isFinite(value) && value > 0) menuStart = value;
      } catch {
        menuStart = 48;
      }
      dshMenuStartCache = menuStart;
      return menuStart;
    }
    function resetDshMenuStartCache() {
      dshMenuStartCache = null;
    }

    /* DSH renders its 应用/编辑 menu in a body-level portal with inline styles.
     * In C it becomes part of the child window's title band, right after the
     * native caption cluster (sidebar toggle at +12, New Session at +48); the
     * plugin then draws the hide button at the far right. In P it is hidden
     * behind the full-window plugin; in D it returns to the window's corner. */
    function syncDshMenu(mode, dshLeft, dshWidth) {
      const menuStart = readDshMenuStart();
      for (const node of document.querySelectorAll('[data-windows-menu]')) {
        if (!(node instanceof HTMLElement)) continue;
        /* Inline-style reads/writes never force a document style recalculation;
         * only computed-style and layout reads do. */
        const put = (prop, value) => {
          if (node.style.getPropertyValue(prop) === value) return;
          node.style.setProperty(prop, value, 'important');
        };
        const clear = (prop) => {
          if (node.style.getPropertyValue(prop) !== '') node.style.removeProperty(prop);
        };
        const clearGeometry = () => {
          for (const prop of ['position', 'left', 'top', 'width', 'height', 'right', 'bottom', 'transform']) {
            clear(prop);
          }
        };
        if (mode === 'P') {
          clearGeometry();
          clear('z-index');
          put('display', 'none');
        } else if (mode === 'C') {
          clear('display');
          /* DSH 的侧边栏开关 / 新建按钮是原生布局里的按钮；侧边栏展开后
             加号会移动，固定 left 会压住它。以它们的实际右边缘为锚点。
             这是布局读取（getBoundingClientRect），只在真正重排菜单时做。 */
          let menuLeft = Math.max(0, dshLeft) + menuStart;
          for (const sel of ['button[class*="newSession"]', '[data-sidebar-toggle]']) {
            const btn = document.querySelector(sel);
            if (!(btn instanceof HTMLElement)) continue;
            const rect = btn.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              menuLeft = Math.max(menuLeft, Math.round(rect.right) + 6);
            }
          }
          put('position', 'fixed');
          put('left', `${menuLeft}px`);
          put('top', `${DSH_TOP}px`);
          put('width', `${Math.max(120, dshWidth - (menuLeft - Math.max(0, dshLeft)) - 88)}px`);
          put('height', `${SHELL_TOPBAR}px`);
          put('right', 'auto');
          /* Above the child window (45), below the plugin-drawn hide button. */
          put('z-index', '2147482960');
        } else {
          clearGeometry();
          clear('z-index');
          clear('display');
          /* SourceLook 入口（D 模式标题栏上的文字按钮）跟在这个菜单后面，
             间距 14px。位置按菜单的**实际右边缘**算，不写死 px —— DSH 换
             语言/字号后菜单会变宽，固定 left 就会贴上去或叠住。
             这是一次布局读，只在菜单重建/重排时发生（调用点已 rAF 节流），
             不在滚动路径上。 */
          const rect = node.getBoundingClientRect();
          if (rect.width > 0) {
            const want = `${Math.round(rect.right) + 14}px`;
            const rootStyle = document.documentElement.style;
            if (rootStyle.getPropertyValue('--sl-pill-left') !== want) {
              rootStyle.setProperty('--sl-pill-left', want);
            }
          }
        }
      }
    }

    /* ------------------------------------------------------------ host theme */

    /* The plugin owns the whole window, so a dark plugin with a light DSH looks
     * broken: the child window stays white next to the dark shell. When the
     * user picks the explicit dark theme we therefore darken the host too by
     * (a) setting DSH's own dark attribute and (b) re-pointing DSH's inline
     * theme tokens to the values from DSH's `body[data-ds-dark-theme]` rules.
     * DSH's preload watches both and repaints the native caption buttons, so
     * the Windows title-bar controls follow as well. Everything is restored
     * verbatim when the plugin leaves the dark theme. */
    const HOST_DARK_ATTR = 'data-ds-dark-theme';
    const HOST_FORCED_ATTR = 'data-sl-host-dark';
    let hostThemeOwner = null;
    let forcedHost = null;

    function readHostDarkTokens() {
      const tokens = new Map();
      const visit = (list) => {
        for (const rule of list) {
          if (rule.cssRules !== undefined && rule.cssRules !== null) {
            visit(rule.cssRules);
            continue;
          }
          if (rule.type !== 1 || typeof rule.selectorText !== 'string') continue;
          if (rule.selectorText.indexOf(`body[${HOST_DARK_ATTR}]`) === -1) continue;
          const style = rule.style;
          for (let index = 0; index < style.length; index += 1) {
            const name = style[index];
            if (name.slice(0, 6) !== '--dsw-') continue;
            tokens.set(name, style.getPropertyValue(name));
          }
        }
      };
      const sheets = Array.from(document.styleSheets);
      /* Vite/Emotion may install constructed sheets that `styleSheets` omits. */
      try {
        if (document.adoptedStyleSheets !== undefined) {
          for (const sheet of Array.from(document.adoptedStyleSheets)) {
            if (sheets.indexOf(sheet) === -1) sheets.push(sheet);
          }
        }
      } catch { /* not supported */ }
      for (const sheet of sheets) {
        /* Skip the plugin's own sheet: it carries a --dsw- dark alias block
         * tuned for the reader palette, not DSH's host palette. */
        const owner = sheet.ownerNode;
        try {
          if (owner !== null && owner.closest !== undefined && owner.closest('.sl-layer') !== null) continue;
          visit(sheet.cssRules);
        } catch {
          /* cross-origin sheet: ignore */
        }
      }
      return tokens;
    }

    function applyForcedHostDark(owner) {
      const body = document.body;
      const root = document.documentElement;
      if (body === null) return false;
      if (forcedHost === null) {
        const tokens = readHostDarkTokens();
        const saved = new Map();
        for (const name of tokens.keys()) {
          saved.set(name, {
            value: body.style.getPropertyValue(name),
            priority: body.style.getPropertyPriority(name),
          });
        }
        forcedHost = {
          owner,
          tokens,
          saved,
          added: false,
          colorScheme: root.style.getPropertyValue('color-scheme'),
          colorSchemePriority: root.style.getPropertyPriority('color-scheme'),
          observer: null,
          timer: 0,
        };
        forcedHost.observer = new MutationObserver(() => {
          if (forcedHost === null || forcedHost.timer !== 0) return;
          forcedHost.timer = window.setTimeout(() => {
            if (forcedHost === null) return;
            /* A newer instance has taken the window over: stop resurrecting
               the old forced palette. */
            if (forcedHost.owner !== hostThemeOwner) {
              forcedHost.timer = 0;
              releaseForcedHostDark();
              return;
            }
            forcedHost.timer = 0;
            if (!applyForcedHostDark(forcedHost.owner)) releaseForcedHostDark();
          }, 60);
        });
        forcedHost.observer.observe(body, { attributes: true, attributeFilter: [HOST_DARK_ATTR, 'style'] });
      }
      /* DSH ships its light and dark palettes as plain CSS (`body[...]` rules)
         and writes no inline tokens for the built-in themes, so flipping the
         attribute is what repaints the host. The inline-token pass below only
         matters for a future DSH that resolves tokens in JS. */
      if (!body.hasAttribute(HOST_DARK_ATTR)) {
        body.setAttribute(HOST_DARK_ATTR, '');
        forcedHost.added = true;
      }
      for (const [name, value] of forcedHost.tokens) {
        if (body.style.getPropertyValue(name) !== value
          || body.style.getPropertyPriority(name) !== 'important') {
          body.style.setProperty(name, value, 'important');
        }
      }
      root.style.setProperty('color-scheme', 'dark', 'important');
      root.setAttribute(HOST_FORCED_ATTR, '');
      return true;
    }

    function releaseForcedHostDark() {
      const body = document.body;
      const root = document.documentElement;
      if (forcedHost === null) {
        root.removeAttribute(HOST_FORCED_ATTR);
        return;
      }
      const state = forcedHost;
      forcedHost = null;
      if (state.timer !== 0) window.clearTimeout(state.timer);
      if (state.observer !== null) state.observer.disconnect();
      if (body !== null) {
        for (const [name, previous] of state.saved) {
          if (previous.value === '') body.style.removeProperty(name);
          else body.style.setProperty(name, previous.value, previous.priority);
        }
        if (state.added) body.removeAttribute(HOST_DARK_ATTR);
      }
      if (state.colorScheme === '') root.style.removeProperty('color-scheme');
      else root.style.setProperty('color-scheme', state.colorScheme, state.colorSchemePriority);
      root.removeAttribute(HOST_FORCED_ATTR);
    }

    /** Keep DSH's own palette in step with the plugin theme. `theme` is the
     *  stored preference (auto | light | dark | sepia | mint | graphite). */
    function syncHostDark(owner, theme, themeService) {
      /* A hot-reloaded (or leftover) instance must not keep forcing the old
       * palette: whoever syncs last owns the host theme. */
      if (hostThemeOwner !== null && hostThemeOwner !== owner) releaseForcedHostDark();
      hostThemeOwner = owner;
      const body = document.body;
      const resolved = theme === 'auto'
        ? (body !== null && body.hasAttribute(HOST_DARK_ATTR) ? 'dark' : 'light')
        : theme;
      if (resolved === 'dark' && body !== null && !body.hasAttribute(HOST_DARK_ATTR)) {
        applyForcedHostDark(owner);
      } else {
        releaseForcedHostDark();
      }
    }

    /** Release only when the calling instance still owns the host theme, so a
     *  stale hot-reloaded instance cannot un-dark the live window. */
    function releaseHostDark(owner) {
      if (owner !== undefined && owner !== hostThemeOwner) return;
      hostThemeOwner = null;
      releaseForcedHostDark();
    }
