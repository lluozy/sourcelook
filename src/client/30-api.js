    /* --------------------------------------------------------------- transport */

    /* Fire-and-forget diagnostics. Disabled by default: enable while debugging
     * a blank overlay, then read GET /api/sourcelook/diag/state. */
    const DIAG_ENABLED = false;

    function beacon(stage, detail) {
      if (!DIAG_ENABLED) return;
      try {
        void fetch(`${API}/diag/beacon`, {
          method: 'POST',
          headers: { [HEADER]: '1', 'content-type': 'application/json' },
          body: JSON.stringify({ stage: String(stage ?? ''), detail: String(detail ?? '') }),
          cache: 'no-store',
          credentials: 'same-origin',
        });
      } catch {
        /* diagnostics must never break the UI */
      }
    }

    function apiUrl(pathname, sessionId) {      const query = typeof sessionId === 'string' && sessionId !== ''
        ? `${pathname.includes('?') ? '&' : '?'}session=${encodeURIComponent(sessionId)}`
        : '';
      return `${API}${pathname}${query}`;
    }

    async function api(pathname, init, sessionId) {
      const headers = Object.assign({}, init?.headers);
      headers[HEADER] = '1';
      if (init?.body !== undefined && headers['content-type'] === undefined) {
        headers['content-type'] = 'application/json';
      }
      const response = await fetch(apiUrl(pathname, sessionId), {
        ...init,
        headers,
        cache: 'no-store',
        credentials: 'same-origin',
      });
      let data;
      try {
        data = await response.json();
      } catch {
        data = undefined;
      }
      if (!response.ok) {
        const error = new Error(data?.error?.message ?? `HTTP ${response.status}`);
        error.status = response.status;
        error.code = data?.error?.code;
        error.data = data;
        throw error;
      }
      return data;
    }

    function loadScript(src) {
      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = () => { beacon('script-ok', src); resolve(); };
        script.onerror = () => {
          beacon('script-error', src);
          reject(new Error(`无法加载 ${src}`));
        };
        document.head.appendChild(script);
      });
    }

    /* ------------------------------------------------------------------ paths */

    function baseName(value) {
      if (typeof value !== 'string' || value === '') return '';
      const parts = value.split('/');
      return parts[parts.length - 1] ?? value;
    }

    function parentRel(value) {
      if (typeof value !== 'string' || value === '') return '';
      const index = value.lastIndexOf('/');
      return index === -1 ? '' : value.slice(0, index);
    }

    function joinRel(parent, name) {
      return parent === '' ? name : `${parent}/${name}`;
    }

    function formatSize(bytes) {
      if (!Number.isFinite(bytes)) return '';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
      return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
    }

    const LANGUAGE_BY_EXT = {
      c: 'c', h: 'c',
      cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
      inl: 'cpp', ipp: 'cpp', dts: 'cpp', dtsi: 'cpp',
      rs: 'rust', go: 'go',
      py: 'python',
      js: 'javascript', mjs: 'javascript', cjs: 'javascript',
      ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
      java: 'java', kt: 'kotlin', scala: 'scala',
      sh: 'shell', bash: 'shell', zsh: 'shell',
      json: 'json', jsonc: 'json',
      md: 'markdown', markdown: 'markdown',
      yaml: 'yaml', yml: 'yaml',
      toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
      lua: 'lua', rb: 'ruby', pl: 'perl', php: 'php', sql: 'sql',
      html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
      xml: 'xml', svg: 'xml',
      s: 'asm', S: 'asm', asm: 'asm',
      txt: 'plaintext', rst: 'plaintext',
    };

    const LANGUAGE_LABEL = {
      c: 'C', cpp: 'C++', rust: 'Rust', go: 'Go', python: 'Python',
      javascript: 'JavaScript', typescript: 'TypeScript', java: 'Java',
      kotlin: 'Kotlin', scala: 'Scala', shell: 'Shell', json: 'JSON',
      markdown: 'Markdown', yaml: 'YAML', ini: 'INI', lua: 'Lua',
      ruby: 'Ruby', perl: 'Perl', php: 'PHP', sql: 'SQL', html: 'HTML',
      css: 'CSS', scss: 'SCSS', less: 'Less', xml: 'XML', asm: 'Assembly',
      plaintext: 'Plain Text',
    };

    function languageOf(rel) {
      const name = baseName(rel);
      const lower = name.toLowerCase();
      if (lower === 'makefile' || lower === 'gnumakefile' || lower === 'kbuild') return 'plaintext';
      if (lower === 'cmakelists.txt') return 'plaintext';
      if (lower === 'kconfig') return 'plaintext';
      const dot = name.lastIndexOf('.');
      if (dot < 0) return 'plaintext';
      const extension = name.slice(dot + 1);
      return LANGUAGE_BY_EXT[extension] || LANGUAGE_BY_EXT[extension.toLowerCase()] || 'plaintext';
    }

    function languageLabelOf(rel) {
      return LANGUAGE_LABEL[languageOf(rel)] || 'Plain Text';
    }

    /** The effective symbol-search chord for the receiving shell. Desktop uses
     *  Mod+Alt+P; Web adds Shift because Mod+P and Mod+Alt+P are taken there. */
    function symbolSearchShortcutLabel() {
      const platform = document.documentElement.dataset.platform;
      const web = platform === undefined;
      const mac = /darwin|mac/i.test(platform || navigator.platform || '');
      const mod = mac ? 'Cmd' : 'Ctrl';
      const alt = mac ? 'Option' : 'Alt';
      return `${mod}+${alt}${web ? '+Shift' : ''}+P`;
    }

    /* ----------------------------------------------------------------- storage */

    function readStorage(key) {
      try { return window.localStorage.getItem(key); } catch { return null; }
    }

    function writeStorage(key, value) {
      try {
        window.localStorage.setItem(key, value);
        return true;
      } catch {
        /* quota exceeded / storage disabled */
        return false;
      }
    }

    function removeStorage(key) {
      try { window.localStorage.removeItem(key); } catch { /* disabled */ }
    }

    function readJsonStorage(key, fallback) {
      const raw = readStorage(key);
      if (typeof raw !== 'string' || raw === '') return fallback;
      try { return JSON.parse(raw); } catch { return fallback; }
    }

    /** 返回是否真的写进去了：配额满时草稿会静默丢失，调用方需要知道。 */
    function writeJsonStorage(key, value) {
      try {
        return writeStorage(key, JSON.stringify(value));
      } catch {
        return false;
      }
    }

    function draftKey(root, rel) {
      return `${DRAFT_PREFIX}${root}:${rel}`;
    }
