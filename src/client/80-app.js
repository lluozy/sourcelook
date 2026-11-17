/* --------------------------------------------------------------- the app */

    function escapeRegExp(text) {
      return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /* 折叠路径时保留尾部：`…\vendor\monaco\vs\loader.js`。 */
    function shortenPathTail(value, max = 40) {
      const text = String(value || '');
      if (text.length <= max) return text;
      const sep = text.includes('\\') ? '\\' : '/';
      const parts = text.split(/[\\/]+/u).filter((part) => part !== '');
      let tail = parts.length > 0 ? parts[parts.length - 1] : text;
      for (let index = parts.length - 2; index >= 0; index -= 1) {
        const next = `${parts[index]}${sep}${tail}`;
        if (next.length + 2 > max) break;
        tail = next;
      }
      return `…${sep}${tail}`;
    }
    /* 标题栏只显示项目目录的**最后一段**：完整路径在悬停提示和弹层里都有，
       标题栏要的是"一眼认出是哪个工程"，两段太占宽度（29 字符 ≈ 200px）。
       目录名本身超长时再从前面压掉。 */
    function projectTail(value, maxChars = 24) {
      const text = String(value || '').replace(/[\\/]+$/u, '');
      if (text === '') return '';
      const parts = text.split(/[\\/]+/u).filter((part) => part !== '');
      let label = parts.length > 0 ? parts[parts.length - 1] : text;
      if (label === '') label = text;
      if (label.length > maxChars) label = `…${label.slice(label.length - maxChars)}`;
      return label;
    }

    /* 保留给别的调用点：只压前面，留最后 max 个字符。 */
    function tailChars(value, max = 20) {
      const text = String(value || '');
      if (text.length <= max) return text;
      return `…${text.slice(text.length - max)}`;
    }

    function formatEta(ms) {
      const seconds = Math.max(0, Math.round(Number(ms) / 1000));
      if (seconds <= 4) return '即将完成';
      const minutes = Math.floor(seconds / 60);
      const rest = seconds % 60;
      return minutes > 0 ? `约剩 ${minutes} 分 ${rest} 秒` : `约剩 ${rest} 秒`;
    }

    /* ------------------------------------------------------ local macro expand
     * Ported from the original reader: substitute the call site's arguments into
     * the macro body. No preprocessing, no include expansion, no condition
     * evaluation — the footer says so. */

    /** Arguments of `word(...)` at `col` on one line, or null. */
    function macroCallArgsAt(line, word, col) {
      if (!line || !word) return null;
      const hits = [];
      let at = line.indexOf(word);
      while (at >= 0) {
        const before = at === 0 ? '' : line[at - 1];
        const after = line[at + word.length] || '';
        if (!/[A-Za-z0-9_]/u.test(before) && !/[A-Za-z0-9_]/u.test(after)) hits.push(at);
        at = line.indexOf(word, at + word.length);
      }
      if (hits.length === 0) return null;
      const start = hits.reduce((a, b) => (Math.abs(b - col) < Math.abs(a - col) ? b : a), hits[0]);
      let index = start + word.length;
      while (line[index] === ' ' || line[index] === '\t') index += 1;
      if (line[index] !== '(') return null;
      let depth = 0;
      let end = -1;
      for (let scan = index; scan < line.length; scan += 1) {
        if (line[scan] === '(') depth += 1;
        else if (line[scan] === ')') {
          depth -= 1;
          if (depth === 0) { end = scan; break; }
        }
      }
      if (end < 0) return null;
      const inner = line.slice(index + 1, end);
      const args = [];
      let nesting = 0;
      let from = 0;
      for (let scan = 0; scan < inner.length; scan += 1) {
        const ch = inner[scan];
        if (ch === '(' || ch === '[' || ch === '{') nesting += 1;
        else if (ch === ')' || ch === ']' || ch === '}') nesting -= 1;
        else if (ch === ',' && nesting === 0) {
          args.push(inner.slice(from, scan).trim());
          from = scan + 1;
        }
      }
      args.push(inner.slice(from).trim());
      return args;
    }

    /** `#p` first (stringify), then plain parameter substitution. `##` is only
     *  flagged as partial, never expanded. */
    function expandMacroOnce(body, params, args) {
      let out = String(body || '');
      if (params && params.length > 0) {
        for (let index = 0; index < params.length; index += 1) {
          const param = params[index];
          const value = args && args[index] !== undefined ? args[index] : '';
          const quoted = param.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          out = out.replace(new RegExp(`(^|[^#])#\\s*${quoted}\\b`, 'g'), (match, prefix) => `${prefix}"${value}"`);
          out = out.replace(new RegExp(`\\b${quoted}\\b`, 'g'), value);
        }
      }
      return out;
    }

    /* Same-kind filtering and authority ordering, ported from the original
     * reader's definition resolver. A click on `struct sock` must not list
     * variables called `sock`; duplicate definitions prefer include/linux over
     * a random driver copy and a real definition over a prototype. */
    const TYPE_KINDS = new Set(['struct', 'union', 'enum', 'typedef', 'type', 'class', 'interface']);
    const MEMBER_KINDS = new Set(['member', 'field', 'enum_member']);

    /* AI prompt library (ported from the original actions.js PROMPTS). The nine
       kind buttons cover the common cases; this picker adds the rest. */
    const AI_PROMPT_LIBRARY = [
      { id: 'explainCall', label: '解释这处调用', ask: '下面是一处调用点。请说明：这次调用传入了什么、返回值如何使用、调用者需要满足什么前置条件；信息不足时明确指出缺哪部分。' },
      { id: 'explainUsage', label: '符号用途与坑', ask: '请说明这个符号的用途、作用域与生命周期，以及使用时常见的坑（未初始化、别名、并发访问等）。' },
      { id: 'explainLayout', label: '类型内存布局', ask: '请说明这个类型的内存布局（字段顺序、对齐、填充）、典型用途，以及使用时的注意事项。' },
      { id: 'explainLine', label: '解释这一行', ask: '请解释这一行代码：它做了什么、为什么这样写、需要注意的细节（返回值、副作用、边界条件）。3 到 5 句。' },
      { id: 'explainPreproc', label: '解释这条预处理', ask: '请解释这条 C 预处理指令：作用、生效条件、为什么在这里出现；如果是条件编译，说明各分支的区别。' },
      { id: 'explainOperator', label: '解释运算符', ask: '请解释这里的运算符：含义、优先级、副作用与常见陷阱，并结合上下文说明它在这里起什么作用。' },
      { id: 'addComment', label: '补一段注释', ask: '请为这段代码补一段简洁的中文注释：先说它做什么，再指出关键步骤；直接给出可以粘贴进源码的注释文本。' },
      { id: 'optimizeComment', label: '优化注释', ask: '在保持原意的前提下优化这段注释：去掉冗余、修正语病、补充关键信息。原文是英文就保持英文，是中文就保持中文。只输出注释本身。' },
      { id: 'translateComment', label: '翻译注释为中文', ask: '把这段注释翻译成中文。保留原有格式；专有名词、函数名、宏名不翻译。只输出翻译结果。' },
      { id: 'condenseComment', label: '浓缩成一句话', ask: '把这段注释浓缩成一句话（不超过 40 字），保留最关键的信息。只输出结果。' },
    ];
    /* C 关键字：点击它们只解释“这是什么”，绝不当符号去查定义。 */
    const C_LANGUAGE_KEYWORDS = new Set((
      'auto break case char const continue default do double else enum extern float for goto if '
      + 'inline int long register restrict return short signed sizeof static struct switch typedef '
      + 'union unsigned void volatile while _Bool _Complex _Imaginary _Static_assert _Alignas '
      + '_Alignof _Atomic _Generic _Noreturn _Thread_local asm __asm__ __attribute__ __inline__ '
      + '__restrict__ __extension__ __typeof__ typeof'
    ).split(/\s+/));

    const C_LANGUAGE_NOTES = {
      unsigned: '无符号整数类型说明符：只修饰整数类型，本身不是符号。',
      signed: '有符号整数类型说明符：只修饰整数类型，本身不是符号。',
      int: '整数类型说明符，本身不是符号。',
      char: '字符类型说明符，本身不是符号。',
      short: '短整数类型说明符，本身不是符号。',
      long: '长整数类型说明符，本身不是符号。',
      float: '单精度浮点类型说明符，本身不是符号。',
      double: '双精度浮点类型说明符，本身不是符号。',
      void: '无类型说明符，本身不是符号。',
      struct: '结构体关键字：点它只说明这是关键字；要查定义请点后面的结构体名。',
      union: '联合体关键字：点它只说明这是关键字；要查定义请点后面的联合体名。',
      enum: '枚举关键字：点它只说明这是关键字；要查定义请点后面的枚举名。',
      typedef: '类型定义关键字，本身不是符号。',
      sizeof: '运算符，不是函数，也不是符号。',
      return: '流程控制关键字，不是符号。',
      if: '流程控制关键字，不是符号。',
      else: '流程控制关键字，不是符号。',
      for: '流程控制关键字，不是符号。',
      while: '流程控制关键字，不是符号。',
      do: '流程控制关键字，不是符号。',
      switch: '流程控制关键字，不是符号。',
      case: '流程控制关键字，不是符号。',
      default: '流程控制关键字，不是符号。',
      break: '流程控制关键字，不是符号。',
      continue: '流程控制关键字，不是符号。',
      goto: '流程控制关键字，不是符号。',
    };

    /* 文本偏移处的词法区域：0=代码 1=注释 2=字符串。逐字符扫描，C 规则。 */
    const LANG_BY_EXT = { py: 'python', pyw: 'python', pyi: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'javascript', tsx: 'javascript', java: 'java', go: 'go', rs: 'rust', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', hh: 'cpp', cxx: 'cpp' };
    const LANG_KEYWORDS = {
      python: new Set(['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'in', 'is', 'not', 'and', 'or', 'import', 'from', 'as', 'try', 'except', 'finally', 'with', 'lambda', 'yield', 'async', 'await', 'pass', 'break', 'continue', 'raise', 'global', 'nonlocal', 'del']),
      javascript: new Set(['function', 'class', 'const', 'let', 'var', 'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'new', 'this', 'import', 'export', 'from', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of']),
      java: new Set(['class', 'interface', 'enum', 'record', 'public', 'private', 'protected', 'static', 'final', 'void', 'int', 'long', 'double', 'float', 'boolean', 'char', 'new', 'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'import', 'package', 'extends', 'implements'])
    };
    const LANG_LABEL = { python: 'Python', javascript: 'JavaScript', java: 'Java', go: 'Go', rust: 'Rust' };
    function languageOfPath(rel) {
      const base = String(rel || '').split('/').pop() || '';
      const ext = (/\\.([A-Za-z0-9]+)$/.exec(base) || [])[1];
      return LANG_BY_EXT[String(ext || '').toLowerCase()] || 'c';
    }
    function lexicalStateAtOffset(text, offset, lang = 'c') {
      let mode = 0;
      const limit = Math.min(Number(offset) || 0, text.length);
      for (let i = 0; i < limit; i += 1) {
        const c = text[i];
        const n = text[i + 1];
        if (mode === 0) {
          if (lang === 'python' && c === '#') { mode = 1; }
          else if (c === '/' && n === '/') { mode = 1; i += 1; }
          else if (c === '/' && n === '*') { mode = 2; i += 1; }
          else if (c === '"') mode = 3;
          else if (c === "'") mode = 4;
        } else if (mode === 1) {
          if (c === '\n') mode = 0;
        } else if (mode === 2) {
          if (c === '*' && n === '/') { mode = 0; i += 1; }
        } else if (mode === 3) {
          if (c === '\\') i += 1;
          else if (c === '"' || c === '\n') mode = 0;
        } else if (mode === 4) {
          if (c === '\\') i += 1;
          else if (c === "'" || c === '\n') mode = 0;
        }
      }
      return mode === 1 || mode === 2 ? 'comment' : (mode === 3 || mode === 4 ? 'string' : 'code');
    }

    function lexicalKindAt(text, line, column, lang = 'c') {
      const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
      const target = Math.max(1, Math.min(Number(line) || 1, lines.length));
      let offset = 0;
      for (let i = 0; i < target - 1; i += 1) offset += lines[i].length + 1;
      offset += Math.max(0, (Number(column) || 1) - 1);
      return lexicalStateAtOffset(String(text || ''), offset, lang);
    }

    /* One-line meanings for the qualifiers the reader clicks most often; the
       original shows these instead of an empty definition list. */
    const KEYWORD_NOTES = {
      static: '限制链接性（仅本文件可见），并把生命周期延长到整个程序。',
      const: '只读限定：写入是未定义行为，编译器可据此优化。',
      volatile: '每次都必须真正读写，编译器不得缓存或重排。',
      inline: '建议内联展开，同时允许在头文件里重复定义。',
      extern: '声明而非定义：实体在别的翻译单元里。',
      register: '建议放进寄存器（现代编译器基本忽略）。',
      restrict: '承诺该指针是访问对象的唯一途径，便于优化。',
      _Atomic: '原子类型：读写不可分割，用于并发。',
      typeof: '取表达式的类型（GNU 扩展）。',
      __attribute__: '编译器扩展属性：对齐、段、废弃、格式检查等。',
      __init: '初始化阶段专用，启动完成后内存可释放。',
      __exit: '退出阶段专用。',
      likely: '告诉编译器这个分支大概率成立，用于布局优化。',
      unlikely: '告诉编译器这个分支很少成立。',
    };

    function sameKindSet(kind) {
      const value = String(kind || '').toLowerCase();
      if (TYPE_KINDS.has(value)) return TYPE_KINDS;
      if (MEMBER_KINDS.has(value)) return MEMBER_KINDS;
      return null;
    }

    function definitionAuthority(file) {
      const rel = String(file || '').replace(/\\/gu, '/');
      if (/(^|\/)include\/linux\//u.test(rel)) return 0;
      if (/(^|\/)include\/uapi\//u.test(rel)) return 1;
      if (/(^|\/)include\//u.test(rel)) return 2;
      if (/(^|\/)arch\/[^/]+\/include\//u.test(rel)) return 3;
      if (/\.h$/u.test(rel)) return 4;
      return 5;
    }

    function orderDefinitions(list) {
      return [...list].sort((a, b) => {
        const prototypeA = a?.prototype === true ? 1 : 0;
        const prototypeB = b?.prototype === true ? 1 : 0;
        if (prototypeA !== prototypeB) return prototypeA - prototypeB;
        const authorityA = definitionAuthority(a?.file);
        const authorityB = definitionAuthority(b?.file);
        if (authorityA !== authorityB) return authorityA - authorityB;
        return String(a?.file || '').localeCompare(String(b?.file || ''));
      });
    }

    /* "调用 12，读取 5 · 其中 2 处当前配置不编译" — the original's one-line
       summary that goes in the result window title. */
    function summariseRefs(hits, skipKinds) {
      const label = {
        call: '调用', write: '写入', read: '读取', address: '取址', type: '类型', field: '字段', reg: '登记',
      };
      const by = {};
      let dead = 0;
      let unsure = 0;
      for (const hit of hits || []) {
        if (!hit || !hit.kind) continue;
        by[hit.kind] = (by[hit.kind] || 0) + 1;
        if (hit.live === false) dead += 1;
        if (hit.conf && hit.conf !== 'exact') unsure += 1;
      }
      const parts = ['call', 'write', 'read', 'address', 'type', 'field']
        .filter((kind) => by[kind] && !(skipKinds && skipKinds.indexOf(kind) >= 0))
        .map((kind) => `${label[kind]} ${by[kind]}`);
      let text = parts.join('，');
      if (dead) text += `${text ? ' · ' : ''}其中 ${dead} 处当前配置不编译`;
      if (unsure) text += `${text ? ' · ' : ''}${unsure} 处未能确定目标`;
      return text;
    }

    function useT(ctx) {
      const [tick, setTick] = useState(0);
      useEffect(() => ctx.locale.subscribe(() => setTick((value) => value + 1)), [ctx]);
      /* 语言没变时保持同一个 t 引用，memo 子组件才能跳过无关重渲染。 */
      return useMemo(() => ctx.locale.bind(NS), [ctx, tick]);
    }

    function selectSessionId(state) {
      const items = Object.values(state.byId ?? {});
      let fallback;
      for (const item of items) {
        if (fallback === undefined) fallback = item.id;
        if ((item.retainedBy?.mainView ?? 0) > 0) return item.id;
      }
      return fallback;
    }

    /* The overlay normally receives useSessions. A carrier that does not is not
     * fatal: the Host falls back to the first registered workspace. */
    function useNoSessions() {
      return undefined;
    }

    function makeTab(data, content, dirty) {
      return {
        path: data.path,
        absolutePath: data.absolutePath,
        name: baseName(data.path),
        content,
        baseVersion: data.version,
        size: data.size,
        mtime: data.mtime,
        encoding: data.encoding,
        readOnly: data.readOnly === true,
        bom: data.bom === true,
        eol: data.eol,
        savedAltVersion: undefined,
        forceDirty: dirty === true,
        dirty: dirty === true,
      };
    }

    function SourceLookPlugin({ ctx, useSessions }) {
      const t = useT(ctx);
      const tRef = useRef(t);
      tRef.current = t;

      const sessionId = (typeof useSessions === 'function' ? useSessions : useNoSessions)(selectSessionId);
      const [mode, setMode] = useState(readMode);
      const [theme, setTheme] = useState(readTheme);
      const [colors, setColors] = useState(readColors);
      const [colorPanelOpen, setColorPanelOpen] = useState(false);
      const [enhanceOpen, setEnhanceOpen] = useState(false);
      const [enhanceData, setEnhanceData] = useState(null);
      const [enhanceError, setEnhanceError] = useState(null);
      const [enhanceReport, setEnhanceReport] = useState(null);
      const [enhanceConfig, setEnhanceConfig] = useState('');
      const [enhancePreview, setEnhancePreview] = useState(null);
      const [enhanceBusy, setEnhanceBusy] = useState(false);
      const [aiOpen, setAiOpen] = useState(false);
      const [aiWord, setAiWord] = useState('');
      const [aiText, setAiText] = useState('');
      const [aiConfig, setAiConfig] = useState(readAiConfig);
      const [aiShowConfig, setAiShowConfig] = useState(false);
      const [aiModels, setAiModels] = useState([]);
      const [aiLog, setAiLog] = useState(readAiLog);
      const [aiBusy, setAiBusy] = useState(false);
      const [aiPromptChoice, setAiPromptChoice] = useState('');
      const aiLogRef = useRef(null);
      const [pathOpen, setPathOpen] = useState(false);
      /* 路径弹层的锚点：贴着"路径按钮"下方弹出（像菜单），不再居中飘在标题栏下。 */
      const [pathAnchor, setPathAnchor] = useState({ left: 240, top: 44 });
      const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
      const [dshWidth, setDshWidth] = useState(() => readDshWidth(window.innerWidth));
      const [dshBusy, setDshBusy] = useState({ busy: false, jobs: 0 });
      const [paneRatios, setPaneRatios] = useState(readPaneRatios);
      const [rootInfo, setRootInfo] = useState(null);
      const [infoError, setInfoError] = useState(null);
      const [infoReload, setInfoReload] = useState(0);
      const [tabs, setTabs] = useState([]);
      const [activePath, setActivePath] = useState('');
      const [recent, setRecent] = useState([]);
      const [notice, setNotice] = useState(null);      const [conflict, setConflict] = useState(null);
      const [pickerOpen, setPickerOpen] = useState(false);
      const [projectOpen, setProjectOpen] = useState(false);
      const [projectPath, setProjectPath] = useState('');
      const [projectBusy, setProjectBusy] = useState(false);
      const [projectError, setProjectError] = useState(null);
      const [recentProjects, setRecentProjects] = useState(readRecentProjects);
      const [showAllProjects, setShowAllProjects] = useState(false);
      const [projectMenuOpen, setProjectMenuOpen] = useState(false);
      const [projectMenuPos, setProjectMenuPos] = useState({ left: 240, top: 42 });
      useEffect(() => {
        const root = rootInfo?.root;
        if (!root) return;
        setRecentProjects((previous) => {
          if (previous[0] === root) return previous;
          const next = [root, ...previous.filter((item) => item !== root)].slice(0, 30);
          writeRecentProjects(next);
          return next;
        });
      }, [rootInfo?.root]);
      const projectBtnRef = useRef(null);
      const pathBtnRef = useRef(null);
      const [dirPath, setDirPath] = useState('');
      const [dirParent, setDirParent] = useState('');
      const [dirDirs, setDirDirs] = useState([]);
      const [dirDrives, setDirDrives] = useState([]);
      const [dirLoading, setDirLoading] = useState(false);
      const [dirError, setDirError] = useState(null);
      const [saveState, setSaveState] = useState('idle');
      const [cursor, setCursor] = useState({ line: 1, column: 1 });
      const [monacoStatus, setMonacoStatus] = useState('loading');
      const [monacoError, setMonacoError] = useState('');
      const [monacoReload, setMonacoReload] = useState(0);

      const [indexInfo, setIndexInfo] = useState(null);
      const [indexBusy, setIndexBusy] = useState(false);
      const [indexConfirm, setIndexConfirm] = useState(false);      const [indexPanelOpen, setIndexPanelOpen] = useState(false);
      const [indexPanelFinal, setIndexPanelFinal] = useState(null);
      const [indexPanelPos, setIndexPanelPos] = useState(null);
      const [indexCancelRequested, setIndexCancelRequested] = useState(false);

      useEffect(() => {
        if (!indexInfo) return undefined;
        if (indexInfo.building === true) {
          setIndexPanelOpen(true);
          setIndexPanelFinal(null);
          return undefined;
        }
        if (indexPanelOpen !== true) return undefined;
        setIndexPanelFinal(indexInfo);
        const phase = indexInfo.progress?.phase;
        const delay = indexInfo.built === true
          ? 4000
          : (phase === 'canceled' ? 2600 : 6500);
        const timer = window.setTimeout(() => {
          setIndexPanelOpen(false);
          setIndexPanelFinal(null);
          setIndexCancelRequested(false);
        }, delay);
        return () => window.clearTimeout(timer);
      }, [indexInfo]);

      const startIndexPanelDrag = useCallback((event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const panel = event.currentTarget.closest('.sl-index-panel');
        if (!panel) return;
        const rect = panel.getBoundingClientRect();
        const startX = event.clientX;
        const startY = event.clientY;
        const move = (moveEvent) => {
          setIndexPanelPos({
            left: Math.min(window.innerWidth - 80, Math.max(0, Math.round(rect.left + moveEvent.clientX - startX))),
            top: Math.min(window.innerHeight - 40, Math.max(40, Math.round(rect.top + moveEvent.clientY - startY))),
          });
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }, []);

      const [outlineData, setOutlineData] = useState({ path: '', symbols: [], loading: false, error: null });
      const [outlineTick, setOutlineTick] = useState(0);
      const [bufferText, setBufferText] = useState('');
      const [outlineHeight, setOutlineHeight] = useState(readOutlineHeight);
      const [outlineCollapsed, setOutlineCollapsed] = useState(false);
      const [resultsHeight, setResultsHeight] = useState(() => {
        const stored = Number(readStorage(RESULTS_HEIGHT_KEY));
        const fallback = Math.round(window.innerHeight * 0.356);
        return Number.isFinite(stored) && stored >= 160 ? clampResultsHeight(stored, window.innerHeight) : fallback;
      });



      const initialPanesRef = useRef(null);
      if (initialPanesRef.current === null) initialPanesRef.current = readPanes();
      const [contextOpen, setContextOpen] = useState(initialPanesRef.current.contextOpen);
      const [contextCollapsed, setContextCollapsed] = useState(initialPanesRef.current.contextCollapsed);
      const [symbolSort, setSymbolSort] = useState('line');
      const [symbolFilter, setSymbolFilter] = useState('');
      const [symbolPaneCollapsed, setSymbolPaneCollapsed] = useState(initialPanesRef.current.symbolCollapsed);
      const [globalMode, setGlobalMode] = useState(initialPanesRef.current.globalMode);
      const [globalCollapsed, setGlobalCollapsed] = useState(initialPanesRef.current.globalCollapsed);
      const [topFind, setTopFind] = useState('');
      /* 本文件查找（面包屑行右侧那一条）：搜的是**当前编辑缓冲区**，含未保存修改。 */
      const [fileFind, setFileFind] = useState('');
      const [fileFindCount, setFileFindCount] = useState(0);
      const [fileFindIndex, setFileFindIndex] = useState(0);
      const [fileFindFocusTick, setFileFindFocusTick] = useState(0);
      const fileFindInputRef = useRef(null);
      const fileFindMatchesRef = useRef([]);
      const fileFindDecoRef = useRef([]);
      const fileFindCollRef = useRef(null);
      const fileFindCollOwnerRef = useRef(null);
      const fileFindIndexRef = useRef(0);
      const fileFindApiRef = useRef(null);
      const [findOpts, setFindOpts] = useState({ regex: false, caseSensitive: false, word: true });
      const findOptsRef = useRef(findOpts);
      findOptsRef.current = findOpts;
      const [aboutOpen, setAboutOpen] = useState(false);
      const [symbolOpen, setSymbolOpen] = useState(false);
      const [symbolQuery, setSymbolQuery] = useState('');
      const [symbolResults, setSymbolResults] = useState([]);
      const [symbolLoading, setSymbolLoading] = useState(false);
      const [symbolError, setSymbolError] = useState(null);
      const [symbolNeedsIndex, setSymbolNeedsIndex] = useState(false);
      const [results, setResults] = useState(null);
      const [resultsPreview, setResultsPreview] = useState(null);
      const [editorMenu, setEditorMenu] = useState(null);
      const [fontSize, setFontSizeState] = useState(readFontSize);
      const [highlight, setHighlight] = useState(null);
      const [floatBar, setFloatBar] = useState(null);
      const [macroPop, setMacroPop] = useState(null);
      const [macroReady, setMacroReady] = useState(false);
      const [flash, setFlash] = useState(null);
      const [hint, setHint] = useState(null);

      /* DSH, when open in C mode, owns the right dshWidth pixels; the plugin
       * lays itself out inside the remaining width so no pane is hidden. */
      /* The plugin keeps the full window width in every mode; the DSH child
       * window floats above its right side. dshLeft is only used to place that
       * floating panel, its title-band controls and the resize grip. */
      const dshLeft = Math.max(0, viewportWidth - dshWidth);
      const sidebarWidth = Math.max(180, Math.min(620, Math.round(viewportWidth * paneRatios.sidebar)));
      const globalWidth = Math.max(220, Math.min(680, Math.round(viewportWidth * paneRatios.global)));

      const editorHostRef = useRef(null);
      const adapterRef = useRef(null);
      const modeRef = useRef(mode);
      modeRef.current = mode;
      const lastOpenModeRef = useRef((() => {
        const stored = readStorage(OPEN_MODE_KEY);
        if (stored === 'C' || stored === 'P') return stored;
        return readMode() === 'C' ? 'C' : 'P';
      })());
      const monacoRef = useRef(null);
      const tabsRef = useRef([]);
      const activeRef = useRef('');
      const rootRef = useRef(null);
      const sessionRef = useRef(sessionId);
      const hydratedRef = useRef(false);
      /* 启动闸门：/info 与"恢复上次标签"都落定之前不显示欢迎页，
         否则每次重启都会先闪一下"开始阅读代码"。 */
      const bootReadyRef = useRef(false);
      const [bootReady, setBootReady] = useState(false);
      /* 编辑器首次亮出的时机：模型 + 上次滚动位置都就位之后（见 model effect）。 */
      const editorVisibleRef = useRef(false);
      const [editorVisible, setEditorVisible] = useState(false);
      /* 启动加载页：只盖住"外壳已出、代码还没就位"这几秒（Monaco 编译 ~3.5s）。
         Monaco 一就绪就撤（剩下的几百毫秒让代码页自己收尾），6s 兜底，任何失败都不锁屏。 */
      const [splashVisible, setSplashVisible] = useState(true);
      /* /info 是否已经回来：没项目时不该让人干等这张加载页（反正也没有代码要看）。 */
      const [infoResolved, setInfoResolved] = useState(false);
      const lastActiveRef = useRef('');
      const viewStatesRef = useRef(new Map());
      const draftTimersRef = useRef(new Map());
      const draftQuotaWarnedRef = useRef(false);
      const noticeTimerRef = useRef(0);
      const flashTimerRef = useRef(0);
      const hintTimerRef = useRef(0);
      const fontSizeRef = useRef(fontSize);
      fontSizeRef.current = fontSize;
      const highlightRef = useRef(highlight);
      highlightRef.current = highlight;
      const cursorRef = useRef(cursor);
      cursorRef.current = cursor;
      const cursorRafRef = useRef(0);
      if (typeof window !== 'undefined' && cursorRafRef.current === -1) cursorRafRef.current = 0;
      const outlineRef = useRef(outlineData);
      outlineRef.current = outlineData;
      const caretMapRef = useRef({});
      const caretRootRef = useRef('');
      const caretTimerRef = useRef(0);
      const startupRestoreRef = useRef(null);
      const resultsRef = useRef(null);
      const resultStepRef = useRef(-1);
      resultsRef.current = results;
      const pendingRevealRef = useRef(null);
      const pendingScrollRef = useRef(null);
      const caretSaveRef = useRef(null);
      const gotoDefinitionRef = useRef(null);
      const findReferencesRef = useRef(null);
      const showContextRef = useRef(null);
      const searchCodeRef = useRef(null);
      const openAiRef = useRef(null);
      const macroExpandableRef = useRef(null);
      const showMacroRef = useRef(null);
      const aiZoneRef = useRef(null);
      const contextCacheRef = useRef(new Map());














      const fullPrevWidthRef = useRef(0);





      const openAiEditRef = useRef(null);
      const startIndexRef = useRef(null);
      const openFileAtRef = useRef(null);
      const symbolOpenRef = useRef(false);
      symbolOpenRef.current = symbolOpen;
      const previewCacheRef = useRef(new Map());
      /* 同一文件的"正在读"请求：避免并发重复读（见 previewResult）。 */
      const previewPendingRef = useRef(new Map());
      const previewSeqRef = useRef(0);
      /* 底部上下文窗（定义/代码/引用）与结果窗是两个独立目标，各用一个序号：
         快速连点时只允许“最新一次请求”落地，否则旧应答会覆盖新选中行。 */
      const contextPreviewSeqRef = useRef(0);
      const contextSeqRef = useRef(0);
      const historyRef = useRef([]);
      const historyIndexRef = useRef(-1);
      const autoContextRef = useRef('');
      const restoringHistoryRef = useRef(false);
      const [historyVersion, setHistoryVersion] = useState(0);

      useEffect(() => { tabsRef.current = tabs; }, [tabs]);
      useEffect(() => { activeRef.current = activePath; }, [activePath]);
      useEffect(() => { rootRef.current = rootInfo; }, [rootInfo]);
      useEffect(() => { sessionRef.current = sessionId; }, [sessionId]);

      /* 幂等：第一次调用就把闸门打开（之后的调用是空操作）。 */
      const markBootReady = useCallback(() => {
        if (bootReadyRef.current) return;
        bootReadyRef.current = true;
        setBootReady(true);
      }, []);

      /* 兜底：任何一步卡住（老 Host、远程项目、网络抖动）都不能一直白屏。 */
      useEffect(() => {
        const timer = window.setTimeout(markBootReady, 8000);
        return () => window.clearTimeout(timer);
      }, [markBootReady]);

      /* Monaco 重新加载时重新进入"待亮出"状态；正常切文件不动它。 */
      useEffect(() => {
        if (monacoStatus === 'ready') return;
        editorVisibleRef.current = false;
        setEditorVisible(false);
      }, [monacoStatus]);

      /* 以前这里有个"1.2s 后无论如何亮出编辑区"的兜底。它会造出用户看到的那个
         "左上角小框框"：Monaco 先就绪、文件还没读完时，亮出的是一台**没有模型**的空
         编辑器（只剩行号槽 + 光标），过一会儿才被代码顶掉。
         现在**只有模型真的设上了才亮**（见 model effect），没有文件可显示就走欢迎页。 */

      /* 加载页的撤页时机：
         - 代码真的画出来之后才撤（`editorVisible`）。**不能只等 `ready`**：
           Monaco 就绪时它先画的是"第 1 行空白编辑器"，我们要等它按恢复位置重绘完，
           否则撤页瞬间会露出那张空框（就是那块"左上角小框框"）。
         - Monaco 报错立即撤；
         - 没有项目（/info 回来了但没有 root）直接撤 —— 没有代码可看，不必等；
         - 6s 硬上限。 */
      useEffect(() => {
        if (!splashVisible) return undefined;
        const hide = () => setSplashVisible(false);
        if (monacoStatus === 'error') { hide(); return undefined; }
        if (monacoStatus === 'ready' && editorVisible) {
          /* 代码已就位，再压 150ms 让 Monaco 的首帧绘制彻底落定再撤页：
             DOM 采样看不到差异（描画在合成阶段），但撤页瞬间左上角可能闪一下
             空白编辑器边框。多这一帧多不到用户能感知的程度。 */
          const settle = window.setTimeout(hide, 150);
          return () => window.clearTimeout(settle);
        }
        const hasRoot = rootInfo !== null && typeof rootInfo.root === 'string' && rootInfo.root !== '';
        if (infoResolved && !hasRoot) { hide(); return undefined; }
        /* 没有可显示的代码（文件被删光 / 恢复失败）：直接给欢迎页，别亮空编辑器。 */
        if (bootReady && tabs.length === 0) { hide(); return undefined; }
        const timer = window.setTimeout(hide, 6000);
        return () => window.clearTimeout(timer);
      }, [splashVisible, monacoStatus, editorVisible, infoResolved, rootInfo, bootReady, tabs.length]);

      useEffect(() => {
        const root = rootInfo?.root;
        if (!root) {
          caretMapRef.current = {};
          caretRootRef.current = '';
          return;
        }
        caretRootRef.current = root;
        caretMapRef.current = readCarets(root);
      }, [rootInfo?.root]);

      useEffect(() => {
        const root = rootInfo?.root;
        const path = activePath;
        if (!root || path === '') return undefined;
        if (caretTimerRef.current) window.clearTimeout(caretTimerRef.current);
        const flush = () => {
          /* 直接向 Monaco 取当前位置：`cursor` 是 rAF 合并后的 state，关闭时可能
             还停在文件刚打开的第 1 行，不能拿它当权威。 */
          const raw = adapterRef.current?.raw;
          const position = raw?.getPosition?.();
          const scrollTop = Number(raw?.getScrollTop?.());
          const record = {
            line: Number(position?.lineNumber) > 0 ? Number(position.lineNumber) : cursor.line,
            column: Number(position?.column) > 0 ? Number(position.column) : cursor.column,
            scrollTop: Number.isFinite(scrollTop) && scrollTop >= 0 ? Math.round(scrollTop) : undefined,
          };
          caretMapRef.current = { ...caretMapRef.current, [path]: record };
          writeCarets(root, caretMapRef.current);
          writeLastPos({ root, rel: path, ...record });
        };
        caretSaveRef.current = flush;
        caretTimerRef.current = window.setTimeout(flush, 300);
        /* 关闭窗口时 300ms 防抖可能还没落盘；pagehide 不阻止关闭，只补一次保存。 */
        const onPageHide = () => flush();
        const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
        window.addEventListener('pagehide', onPageHide);
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
          window.clearTimeout(caretTimerRef.current);
          window.removeEventListener('pagehide', onPageHide);
          document.removeEventListener('visibilitychange', onVisibility);
          if (caretSaveRef.current === flush) caretSaveRef.current = null;
        };
      }, [cursor.line, cursor.column, activePath, rootInfo?.root]);

      const updateTabs = useCallback((updater) => {
        setTabs((previous) => (typeof updater === 'function' ? updater(previous) : updater));
      }, []);
      const flashStatus = useCallback((text, kind = 'info') => {
        if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
        setFlash({ text: String(text ?? ''), kind });
        flashTimerRef.current = window.setTimeout(() => setFlash(null), 6000);
      }, []);

      const flashHint = useCallback((text) => {
        if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current);
        setHint({ text: String(text ?? '') });
        hintTimerRef.current = window.setTimeout(() => setHint(null), 1800);
      }, []);

      const editorAction = useCallback((id) => {
        const adapter = adapterRef.current;
        if (!adapter) return;
        try {
          adapter.raw?.getAction?.(id)?.run();
        } catch {
          /* an action can be unavailable while the editor is rebuilding */
        }
      }, []);

      const runTopFind = useCallback(() => {
        const query = topFind.trim();
        if (query === '') {
          setSymbolQuery('');
          setSymbolOpen(true);
          return;
        }
        void searchCodeRef.current?.(query);
      }, [topFind]);

      /* ---------------------- 本文件查找（Ctrl+F / 面包屑行左端） ---------------------- */

      const paintFileMatches = useCallback((activeIndex) => {
        const editor = adapterRef.current?.raw;
        if (!editor) return;
        const matches = fileFindMatchesRef.current;
        const limit = Math.min(matches.length, 2000);
        const decos = [];
        for (let i = 0; i < limit; i += 1) {
          const isActive = activeIndex > 0 && i + 1 === activeIndex;
          decos.push({
            range: matches[i].range,
            options: {
              inlineClassName: isActive ? 'sl-find-hit sl-find-hit-current' : 'sl-find-hit',
              stickiness: 1,
            },
          });
        }
        /* 用 createDecorationsCollection，不用旧的 `deltaDecorations`：
           这份裁剪过的 monaco 里后者是空壳（装饰进了 model 却不渲染，页面里一个
           span 都看不到），集合 API 正常。集合绑定在具体 editor 实例上，editor
           重建（monacoReload）后要重新创建。 */
        try {
          if (fileFindCollOwnerRef.current !== editor) {
            fileFindCollRef.current = typeof editor.createDecorationsCollection === 'function'
              ? editor.createDecorationsCollection([])
              : null;
            fileFindCollOwnerRef.current = editor;
          }
          if (fileFindCollRef.current) {
            /* 空数组用 clear()：这份裁剪过的 monaco 里 `set([])` 有时不回收旧装饰
               （Esc 后高亮还留在屏幕上）。 */
            if (decos.length === 0) fileFindCollRef.current.clear();
            else fileFindCollRef.current.set(decos);
            return;
          }
          fileFindDecoRef.current = editor.deltaDecorations(fileFindDecoRef.current || [], decos);
        } catch { /* editor swapped under us */ }
      }, []);

      const collectFileMatches = useCallback((queryOverride) => {
        const model = adapterRef.current?.raw.getModel();
        /* 支持显式传入查询：输入框的 onChange 会立刻算一次，不等 React 状态与定时器
           （窗口被遮挡时 setTimeout 会被节流到 1s+，那样"边打边跳"就废了）。 */
        const query = typeof queryOverride === 'string' ? queryOverride : fileFind;
        if (!model || query === '') {
          fileFindMatchesRef.current = [];
          fileFindIndexRef.current = 0;
          setFileFindCount(0);
          setFileFindIndex(0);
          paintFileMatches(0);
          return [];
        }
        let matches = [];
        try {
          /* 固定：不区分大小写、不做全词匹配、不按正则。 */
          matches = model.findMatches(query, false, false, false, null, false, 2000) || [];
        } catch {
          matches = [];
        }
        fileFindMatchesRef.current = matches;
        setFileFindCount(matches.length);
        const next = matches.length === 0
          ? 0
          : Math.min(Math.max(1, fileFindIndexRef.current || 1), matches.length);
        fileFindIndexRef.current = next;
        setFileFindIndex(next);
        return matches;
      }, [fileFind, paintFileMatches]);

      const gotoFileMatch = useCallback((target, opts) => {
        const editor = adapterRef.current?.raw;
        const matches = fileFindMatchesRef.current;
        if (!editor) return;
        if (matches.length === 0) { paintFileMatches(0); return; }
        const total = matches.length;
        let next = Math.round(Number(target) || 1);
        if (opts && opts.wrap === true) {
          if (next > total) next = 1;
          if (next < 1) next = total;
        }
        next = Math.min(Math.max(1, next), total);
        fileFindIndexRef.current = next;
        setFileFindIndex(next);
        const range = matches[next - 1].range;
        try {
          editor.setSelection(range);
          if (!opts || opts.reveal !== false) editor.revealRangeInCenterIfOutsideViewport(range, 0);
        } catch { /* model swapped */ }
        paintFileMatches(next);
      }, [paintFileMatches]);

      const stepFileMatch = useCallback((delta) => {
        gotoFileMatch((fileFindIndexRef.current || 1) + delta, { wrap: true });
      }, [gotoFileMatch]);

      const closeFileFind = useCallback(() => {
        fileFindMatchesRef.current = [];
        fileFindIndexRef.current = 0;
        setFileFindCount(0);
        setFileFindIndex(0);
        /* 连查询一起清掉：输入框回到占位提示，不会留下"词还在、计数 0/0"的怪状态。 */
        setFileFind('');
        paintFileMatches(0);
        try { fileFindInputRef.current?.blur(); } catch { /* gone */ }
        try { adapterRef.current?.raw?.focus?.(); } catch { /* gone */ }
      }, [paintFileMatches]);

      /** Ctrl+F / 放大镜：聚焦输入框，并预填"光标下的词"或当前选区。 */
      const revealFileFind = useCallback(() => {
        const editor = adapterRef.current?.raw;
        const model = editor?.getModel();
        if (editor && model) {
          let word = '';
          const sel = editor.getSelection();
          if (sel && !sel.isEmpty()) {
            word = String(model.getValueInRange(sel)).split('\n')[0].trim();
          } else {
            const pos = editor.getPosition();
            if (pos) {
              const lineText = model.getLineContent(pos.lineNumber);
              const head = /[A-Za-z0-9_$]+$/.exec(lineText.slice(0, pos.column - 1));
              const tail = /^[A-Za-z0-9_$]+/.exec(lineText.slice(pos.column - 1));
              word = `${head ? head[0] : ''}${tail ? tail[0] : ''}`;
            }
          }
          if (word !== '' && word.length <= 120) {
            setFileFind(word);
            /* 预填也要当场算一次，否则计数/高亮还停在上一轮的查询上（要等下一次输入）。 */
            const matches = fileFindApiRef.current?.collect?.(word);
            if (matches && matches.length > 0) fileFindApiRef.current?.go?.(1, { reveal: true });
          }
        }
        setFileFindFocusTick((value) => value + 1);
      }, []);

      fileFindApiRef.current = {
        collect: collectFileMatches,
        paint: paintFileMatches,
        go: gotoFileMatch,
        close: closeFileFind,
        reveal: revealFileFind,
      };


      /* 聚焦（含从菜单/Ctrl+F 进来时）：聚焦并全选，方便直接覆盖输入。 */
      useEffect(() => {
        if (fileFindFocusTick === 0) return;
        const el = fileFindInputRef.current;
        if (!el) return;
        el.focus();
        try { el.select(); } catch { /* not selectable */ }
      }, [fileFindFocusTick]);

      /* 缓冲区变化（打字/撤销/外部刷新）：重算并重绘，但**不**动光标。 */
      useEffect(() => {
        if (monacoStatus !== 'ready') return undefined;
        const editor = adapterRef.current?.raw;
        if (!editor || typeof editor.onDidChangeModelContent !== 'function') return undefined;
        let timer = 0;
        const sub = editor.onDidChangeModelContent(() => {
          if (timer !== 0) window.clearTimeout(timer);
          timer = window.setTimeout(() => {
            timer = 0;
            const api = fileFindApiRef.current;
            if (!api) return;
            api.collect();
            api.paint(fileFindIndexRef.current);
          }, 160);
        });
        return () => {
          if (timer !== 0) window.clearTimeout(timer);
          try { sub.dispose(); } catch { /* already gone */ }
        };
      }, [monacoStatus, monacoReload]);

      /* 换文件：保留查询，重算高亮，但不把光标拽到别处。 */
      useEffect(() => {
        fileFindIndexRef.current = 0;
        if (fileFind === '') { paintFileMatches(0); return; }
        const timer = window.setTimeout(() => {
          fileFindApiRef.current?.collect?.();
          fileFindApiRef.current?.paint?.(0);
        }, 120);
        return () => window.clearTimeout(timer);
      }, [activePath]);

      useEffect(() => {
        if (!enhanceOpen) return undefined;
        let alive = true;
        setEnhanceError(null);
        api('/layers', undefined, sessionRef.current)
          .then((data) => { if (alive) setEnhanceData(data); })
          .catch((error) => { if (alive) setEnhanceError(errorText(error, tRef.current)); });
        return () => { alive = false; };
      }, [enhanceOpen]);

      const openProjectPath = useCallback(async (target) => {
        const wanted = String(target || '').trim();
        if (wanted === '') {
          setProjectError('请输入项目目录的绝对路径。');
          return;
        }
        setProjectBusy(true);
        setProjectError(null);
        try {
          const data = await api('/project/open', {
            method: 'POST',
            body: JSON.stringify({ path: wanted }),
          }, sessionRef.current);
          if (data?.ok !== true) throw new Error(data?.error || '打开失败');
          setProjectOpen(false);
          setProjectPath('');
          setInfoReload((value) => value + 1);
          setRecentProjects((previous) => {
            const next = [data.root, ...previous.filter((item) => item !== data.root)].slice(0, 30);
            writeRecentProjects(next);
            return next;
          });
          flashStatus(`已打开项目：${data.root}`, 'success');
        } catch (error) {
          setProjectError(errorText(error, tRef.current));
        } finally {
          setProjectBusy(false);
        }
      }, [flashStatus]);

      const loadDir = useCallback(async (target) => {
        setDirLoading(true);
        setDirError(null);
        try {
          const data = await api(`/project/dirs?path=${encodeURIComponent(target || '')}`, undefined, sessionRef.current);
          if (data?.ok !== true) throw new Error(data?.error || '读取目录失败');
          setDirPath(data.path);
          setDirParent(data.parent || '');
          setDirDirs(Array.isArray(data.dirs) ? data.dirs : []);
          setDirDrives(Array.isArray(data.drives) ? data.drives : []);
          setProjectPath(data.path);
          setProjectError(null);
        } catch (error) {
          setDirError(error?.status === 404
            ? '目录浏览需要重启一次 DSH 才生效；也可以直接输入绝对路径。'
            : errorText(error, tRef.current));
        } finally {
          setDirLoading(false);
        }
      }, []);

      const openDirBrowser = useCallback((start) => {
        setProjectMenuOpen(false);
        setProjectOpen(true);
        setProjectError(null);
        setProjectPath(start || rootInfo?.root || '');
        void loadDir(start || rootInfo?.root || '');
      }, [loadDir, rootInfo?.root]);

      const pickLocalProject = useCallback(async () => {
        setProjectMenuOpen(false);
        /* 统一使用插件自己的目录浏览器：Windows/Linux 样式一致，也不依赖
           Host 能否启动系统对话框。 */
        openDirBrowser(rootInfo?.root);
      }, [openDirBrowser, rootInfo?.root]);

      const openProjectMenu = useCallback(() => {
        setPathOpen(false);
        const rect = projectBtnRef.current?.getBoundingClientRect();
        setProjectMenuPos({
          left: Math.round(rect?.left ?? 240),
          top: Math.round((rect?.bottom ?? 40) + 4),
        });
        setShowAllProjects(false);
        setProjectMenuOpen(true);
      }, []);
      const openProjectDir = useCallback(() => {
        void openProjectPath(projectPath);
      }, [openProjectPath, projectPath]);
      const resetProjectDir = useCallback(async () => {
        setProjectBusy(true);
        try {
          await api('/project/reset', { method: 'POST' }, sessionRef.current);
          setProjectOpen(false);
          setInfoReload((value) => value + 1);
          flashStatus('已回到会话工作区', 'success');
        } catch (error) {
          setProjectError(errorText(error, tRef.current));
        } finally {
          setProjectBusy(false);
        }
      }, [flashStatus]);
      const loadEnhanceReport = useCallback(async () => {
        setEnhanceBusy(true);
        try {
          const data = await api('/enhance/report?lang=zh', undefined, sessionRef.current);
          setEnhanceReport({
            ...data,
            error: data?.ok === false ? (Array.isArray(data.errors) ? data.errors.join('；') : '报告生成失败') : null,
          });
        } catch (error) {
          setEnhanceReport({ ok: false, error: errorText(error, tRef.current) });
        } finally {
          setEnhanceBusy(false);
        }
      }, []);

      const exportEnhanceReport = useCallback(async () => {
        setEnhanceBusy(true);
        try {
          const data = await api('/enhance/export', {
            method: 'POST',
            body: JSON.stringify({ lang: 'zh' }),
          }, sessionRef.current);
          setEnhanceReport((previous) => ({
            ...(previous ?? {}),
            path: data?.path ?? '',
            error: data?.ok === false ? (Array.isArray(data.errors) ? data.errors.join('；') : '导出失败') : null,
          }));
        } catch (error) {
          setEnhanceReport((previous) => ({ ...(previous ?? {}), error: errorText(error, tRef.current) }));
        } finally {
          setEnhanceBusy(false);
        }
      }, []);
      const previewEnhancePack = useCallback(async () => {
        setEnhanceBusy(true);
        try {
          const data = await api('/enhance/preview', {
            method: 'POST',
            body: JSON.stringify({ text: enhanceConfig }),
          }, sessionRef.current);
          setEnhancePreview(data);
        } catch (error) {
          setEnhancePreview({ ok: false, errors: [errorText(error, tRef.current)] });
        } finally {
          setEnhanceBusy(false);
        }
      }, [enhanceConfig]);

      const applyEnhancePack = useCallback(async () => {
        setEnhanceBusy(true);
        try {
          const data = await api('/enhance/apply', {
            method: 'POST',
            body: JSON.stringify({ text: enhanceConfig }),
          }, sessionRef.current);
          setEnhancePreview(data);
          if (data?.ok === true) {
            flashStatus('增强包已写入，正在重建索引…');
            void startIndexRef.current?.(true);
          }
        } catch (error) {
          setEnhancePreview({ ok: false, errors: [errorText(error, tRef.current)] });
        } finally {
          setEnhanceBusy(false);
        }
      }, [enhanceConfig, flashStatus]);
      useEffect(() => {
        if (!pathOpen) return undefined;
        const close = () => setPathOpen(false);
        const escape = (event) => {
          if (event.key === 'Escape') setPathOpen(false);
        };
        document.addEventListener('mousedown', close);
        document.addEventListener('keydown', escape);
        return () => {
          document.removeEventListener('mousedown', close);
          document.removeEventListener('keydown', escape);
        };
      }, [pathOpen]);
      useEffect(() => {
        if (!projectMenuOpen) return undefined;
        const onDown = (event) => {
          const target = event.target;
          if (target instanceof Element
            && (target.closest('.sl-proj-menu') || target.closest('.sl-top-action.project'))) return;
          setProjectMenuOpen(false);
        };
        document.addEventListener('pointerdown', onDown, true);
        return () => document.removeEventListener('pointerdown', onDown, true);
      }, [projectMenuOpen]);

      useEffect(() => {
        const onFold = () => setMode('P');
        window.addEventListener('sourcelook:fold-dsh', onFold);
        return () => window.removeEventListener('sourcelook:fold-dsh', onFold);
      }, []);

      useEffect(() => {
        beacon('mounted');
        /* A hot-reloaded client can leave an older overlay in the DOM. Keep
         * only the layer that owns this editor, so the newest UI is the one
         * that receives mouse events. */
        const mine = editorHostRef.current?.closest('.sl-layer') ?? null;
        const layers = Array.from(document.querySelectorAll('.sl-layer'));
        for (const layer of layers) {
          if (mine !== null && layer !== mine) layer.style.display = 'none';
          else if (mine === null && layer.getAttribute('data-sl-build') !== BUILD_TAG) layer.style.display = 'none';
        }
        if (mine !== null) {
          mine.style.display = 'flex';
          mine.style.zIndex = '50';
        }
      }, []);

      /* The shortcut service dispatches an event rather than calling into the
       * component, so the command stays a pure registration. */
      useEffect(() => {
        const open = () => {
          if (modeRef.current === 'D') return;
          setSymbolQuery('');
          setSymbolOpen(true);
        };
        window.addEventListener('sourcelook:open-symbol-search', open);
        return () => window.removeEventListener('sourcelook:open-symbol-search', open);
      }, []);

      /* Older mounts of this plugin each added a semantic stylesheet before the
       * adapter learned to reuse one. Collapse the strays on mount. */
      useEffect(() => {
        const nodes = document.querySelectorAll('style[data-code-reader="semantic-styles"]');
        for (let index = 1; index < nodes.length; index += 1) nodes[index].remove();
      }, []);

      /* ---------------------------------------------------------- environment */


      useEffect(() => {
        const onResize = () => setViewportWidth(window.innerWidth);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, []);

      useEffect(() => {
        setDshWidth((value) => {
          const next = clampDshWidth(value, viewportWidth);
          return next === value ? value : next;
        });
      }, [viewportWidth]);

      useEffect(() => { writeStorage(DSH_WIDTH_KEY, String(dshWidth)); }, [dshWidth]);

      useEffect(() => {
        writePaneRatios(paneRatios);
      }, [paneRatios]);
      useEffect(() => { writeStorage(OUTLINE_HEIGHT_KEY, String(outlineHeight)); }, [outlineHeight]);
      useEffect(() => { writeStorage(RESULTS_HEIGHT_KEY, String(resultsHeight)); }, [resultsHeight]);

      /* DSH renders its 应用/编辑 menu in a body-level portal with inline styles.
       * In C the portal becomes the DSH child window's title band (top-left of
       * the panel); in P it is hidden; in D it goes back to the window corner.
       * A child-list observer re-applies the position if DSH re-creates it. */
      useEffect(() => {
        /* 只盯 body / #root 的直接子节点：带 subtree 的 observer 会被 Monaco
           每次滚动重绘的行节点触发，导致滚动时不断重排 DSH 菜单、手感发滞。
           另外 **不能**在回调里重新 observe：ResizeObserver 对每次新 observe
           都会立刻补发一次初始通知，那会变成"每帧一次"的自反馈循环，而每次
           同步都要读布局（getBoundingClientRect）与 --dsh-windows-menu-start，
           在滚动时（样式缓存每帧都脏）每次约 55ms。 */
        const CHROME_SELECTORS = ['#root', 'button[class*="newSession"]', '[data-sidebar-toggle]', '[data-windows-menu]'];
        let frame = 0;
        let resizeObserver = null;
        let observed = [];

        const applyMenu = () => {
          if (frame !== 0) return;
          frame = window.requestAnimationFrame(() => {
            frame = 0;
            syncDshMenu(mode, dshLeft, dshWidth);
          });
        };
        const rebindChrome = () => {
          if (mode !== 'C' || typeof ResizeObserver !== 'function') {
            if (resizeObserver !== null) {
              resizeObserver.disconnect();
              resizeObserver = null;
            }
            observed = [];
            return;
          }
          const next = [];
          for (const sel of CHROME_SELECTORS) {
            const node = document.querySelector(sel);
            if (node instanceof HTMLElement) next.push(node);
          }
          if (next.length === observed.length && next.every((node, index) => node === observed[index])) return;
          if (resizeObserver === null) resizeObserver = new ResizeObserver(() => applyMenu());
          resizeObserver.disconnect();
          observed = next;
          for (const node of next) resizeObserver.observe(node);
        };

        rebindChrome();
        applyMenu();
        const observer = new MutationObserver(() => {
          rebindChrome();
          applyMenu();
        });
        observer.observe(document.body, { childList: true });
        const rootNode = document.getElementById('root');
        if (rootNode) observer.observe(rootNode, { childList: true });
        return () => {
          if (frame !== 0) window.cancelAnimationFrame(frame);
          if (resizeObserver !== null) resizeObserver.disconnect();
          observer.disconnect();
          syncDshMenu('D', 0, 0);
        };
      }, [mode, dshLeft, dshWidth]);

      /* DSH child-window chrome. The plugin layer is *below* the floating DSH
       * window (z 40 < 45), so these two controls are body-level nodes with a
       * very high z-index: they must stay clickable on top of the child window.
       * Both are removed whenever the plugin is not in mode 2. */
      useEffect(() => {
        if (mode !== 'C') return undefined;
        const hide = document.createElement('button');
        hide.id = 'sourcelook-dsh-hide';
        hide.type = 'button';
        hide.className = 'sl-dsh-hide sl-dsh-size';
        hide.title = '隐藏 DSH 子窗口';
        hide.setAttribute('aria-label', '隐藏 DSH 子窗口');
        hide.innerHTML = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8h8.5"/><path d="M8.5 4.5 12 8l-3.5 3.5"/></svg>';
        const onHide = () => setMode('P');
        hide.addEventListener('click', onHide);
        document.body.appendChild(hide);

        /* Two width presets beside the hide arrow. */
        const extra = [];
        const addSize = (id, title, svg, onClick) => {
          const button = document.createElement('button');
          button.id = id;
          button.type = 'button';
          button.className = 'sl-dsh-size';
          button.title = title;
          button.setAttribute('aria-label', title);
          button.innerHTML = svg;
          button.addEventListener('click', onClick);
          document.body.appendChild(button);
          extra.push({ button, onClick });
        };
        addSize(
          'sourcelook-dsh-full',
          'DSH 子窗口：占满整窗（再点还原）',
          '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.2 8h11.6"/><path d="M5.2 4.8 2 8l3.2 3.2"/><path d="M10.8 4.8 14 8l-3.2 3.2"/></svg>',
          () => setDshWidth((previous) => {
            if (previous >= viewportWidth - 60) {
              return fullPrevWidthRef.current > 0
                ? fullPrevWidthRef.current
                : Math.max(320, Math.round(viewportWidth / 2));
            }
            fullPrevWidthRef.current = previous;
            return Math.max(320, viewportWidth - 12);
          }),
        );
        addSize(
          'sourcelook-dsh-half',
          'DSH 子窗口：一半宽度',
          '<span class="sl-dsh-size-glyph half"></span>',
          () => setDshWidth(Math.max(320, Math.round(viewportWidth / 2))),
        );
        addSize(
          'sourcelook-dsh-third',
          'DSH 子窗口：三分之一宽度',
          '<span class="sl-dsh-size-glyph third"></span>',
          () => setDshWidth(Math.max(320, Math.round(viewportWidth / 3))),
        );
        return () => {
          hide.removeEventListener('click', onHide);
          hide.remove();
          for (const item of extra) {
            item.button.removeEventListener('click', item.onClick);
            item.button.remove();
          }
        };
      }, [mode, viewportWidth]);


      useEffect(() => {
        if (mode !== 'C') return undefined;
        const grip = document.createElement('div');
        grip.id = 'sourcelook-dsh-grip';
        grip.className = 'sl-dsh-grip';
        grip.style.left = `${Math.max(0, dshLeft - 4)}px`;
        grip.title = '拖动调整 DSH 宽度';
        const onDown = (event) => {
          event.preventDefault();
          const startX = event.clientX;
          const startWidth = dshWidth;
          let moveRaf = 0;
          let nextWidth = dshWidth;
          const onMove = (moveEvent) => {
            nextWidth = Math.max(320, Math.min(viewportWidth - 360, startWidth + (startX - moveEvent.clientX)));
            if (moveRaf !== 0) return;
            moveRaf = window.requestAnimationFrame(() => {
              moveRaf = 0;
              setDshWidth(nextWidth);
            });
          };
          const onUp = () => {
            if (moveRaf !== 0) window.cancelAnimationFrame(moveRaf);
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
          };
          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', onUp);
        };
        grip.addEventListener('pointerdown', onDown);
        document.body.appendChild(grip);
        return () => {
          grip.removeEventListener('pointerdown', onDown);
          grip.remove();
        };
      }, [mode, dshLeft, dshWidth, viewportWidth]);

      /* DSH does not expose its run state to plugins, but its own DOM does:
       * while a turn streams the composer shows a "停止生成" button, and the
       * session header shows "N 个后台任务运行中" while background jobs run.
       * Mirror that onto the DSH button so the hidden panel still shows work.
       *
       * 这个 observer 覆盖 #root 整棵子树（插件层也在其中），所以滚动时 Monaco
       * 重绘行、对话流式输出都会触发它。每次 read() 是一次全树 querySelector，
       * 因此必须：① 结果节点缓存复用（isConnected + matches 校验），② 至少
       * 250ms 才重扫一次 —— 忙闲状态不需要帧级精度。 */
      useEffect(() => {
        const root = document.getElementById('root');
        if (root === null) return undefined;
        const STOP_SELECTOR = '[aria-label="停止生成"], [aria-label="停止"], [title="停止生成"]';
        const JOBS_SELECTOR = '[aria-label*="后台任务运行中"]';
        let stopNode = null;
        let jobsNode = null;
        const stillMatches = (node, selector) => !!(node && node.isConnected && node.matches(selector));
        const read = () => {
          if (!stillMatches(stopNode, STOP_SELECTOR)) stopNode = root.querySelector(STOP_SELECTOR);
          if (!stillMatches(jobsNode, JOBS_SELECTOR)) jobsNode = root.querySelector(JOBS_SELECTOR);
          let jobs = 0;
          if (jobsNode !== null) {
            const match = /(\d+)/.exec(jobsNode.getAttribute('aria-label') || '');
            jobs = match === null ? 1 : Number(match[1]);
          }
          const busy = stopNode !== null || jobs > 0;
          setDshBusy((prev) => (prev.busy === busy && prev.jobs === jobs ? prev : { busy, jobs }));
        };
        let scheduled = 0;
        let lastRead = 0;
        const schedule = () => {
          if (scheduled !== 0) return;
          const wait = Math.max(0, 250 - (Date.now() - lastRead));
          scheduled = window.setTimeout(() => {
            scheduled = 0;
            lastRead = Date.now();
            read();
          }, wait);
        };
        const observer = new MutationObserver(schedule);
        observer.observe(root, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['aria-label', 'title', 'data-status'],
        });
        read();
        return () => {
          observer.disconnect();
          if (scheduled !== 0) window.clearTimeout(scheduled);
        };
      }, []);

      useEffect(() => {
        /* Older 1.1.68 builds injected a style element that zeroed the DSH
         * title band and hid its menus. Remove it when a hot-reloaded build
         * leaves it behind so the child window keeps its 40px band. */
        document.getElementById('sourcelook-dsh-panel')?.remove();
      }, []);
      useEffect(() => {
        writeMode(mode);
        if (mode === 'C' || mode === 'P') {
          lastOpenModeRef.current = mode;
          writeStorage(OPEN_MODE_KEY, mode);
        }
      }, [mode]);
      useEffect(() => { writeTheme(theme); }, [theme]);
      useEffect(() => { writeColors(colors); }, [colors]);      useEffect(() => { writeAiConfig(aiConfig); }, [aiConfig]);
      useEffect(() => { writeAiLog(aiLog); }, [aiLog]);
      useEffect(() => {
        writePanes({
          symbolCollapsed: symbolPaneCollapsed,
          globalCollapsed,
          globalMode,
          contextOpen,
          contextCollapsed,
        });
      }, [symbolPaneCollapsed, globalCollapsed, globalMode, contextOpen, contextCollapsed]);
      useEffect(() => {
        const node = aiLogRef.current;
        if (node) node.scrollTop = node.scrollHeight;
      }, [aiLog, aiBusy]);

      const shellToken = useRef(null);
      if (shellToken.current === null) shellToken.current = Symbol('sourcelook-shell');

      /* Custom themes own the whole window: when the reader is dark, DSH is
       * darkened with it (and restored when it is not). */
      useEffect(() => {
        syncHostDark(shellToken.current, theme, ctx.get('theme'));
      }, [theme]);
      useEffect(() => () => { releaseHostDark(shellToken.current); }, []);
      useEffect(() => {
        const monaco = monacoRef.current;
        if (monaco) {
          try { defineMonacoTheme(monaco); } catch { /* editor is rebuilding */ }
        }
      }, [theme, colors]);

      useLayoutEffect(() => {
        applyShell(mode, dshWidth, viewportWidth, shellToken.current);
        return () => {
          restoreShell(shellToken.current);
        };
      }, [mode, dshWidth, viewportWidth]);

      useEffect(() => {
        if (mode === 'D') return undefined;
        const frame = window.requestAnimationFrame(() => {
          try { adapterRef.current?.raw.layout(); } catch { /* editor may be gone */ }
        });
        return () => window.cancelAnimationFrame(frame);
      }, [mode, dshWidth, viewportWidth]);

      /* --------------------------------------------------------------- info */

      useEffect(() => {
        let alive = true;
        setInfoError(null);
        api('/info', undefined, sessionId)
          .then((info) => {
            beacon('info-ok');
            if (!alive) return;
            setRootInfo(info);
            setInfoResolved(true);
            /* 没有项目就没有可恢复的东西：直接放行，欢迎页是正常内容。 */
            if (!info || typeof info.root !== 'string' || info.root === '') markBootReady();
          })
          .catch((error) => {
            beacon('info-fail', error?.message ?? String(error));
            if (!alive) return;
            setRootInfo(null);
            setInfoResolved(true);
            setInfoError(errorText(error, tRef.current));
            markBootReady();
          });
        return () => { alive = false; };
      }, [sessionId, infoReload, markBootReady]);

      useEffect(() => {
        const root = rootInfo?.root;
        if (!root) { setRecent([]); return; }
        const stored = readJsonStorage(RECENT_PREFIX + root, []);
        setRecent(Array.isArray(stored) ? stored.filter((item) => typeof item === 'string') : []);
      }, [rootInfo?.root]);

      /* ---------------------------------------------------------------- index */

      const refreshIndex = useCallback(async () => {
        try {
          const info = await api('/index/status', undefined, sessionRef.current);
          setIndexInfo(info);
          return info;
        } catch {
          return null;
        }
      }, []);

      useEffect(() => {
        if (!rootInfo?.root) { setIndexInfo(null); return undefined; }
        let alive = true;
        setIndexInfo(null);
        api('/index/status', undefined, sessionRef.current)
          .then((info) => { if (alive) setIndexInfo(info); })
          .catch(() => { /* the status is optional until the first build */ });
        return () => { alive = false; };
      }, [rootInfo?.root]);

      /* 轮询索引状态。构建中 900ms 一次；否则 4s 一次（"有心跳"）——
         只按 building 轮询有个洞：如果构建是别处发起的（或界面刚挂载时 indexInfo
         还没就绪），`building` 永远是 false，轮询根本不会启动，用户就看不到实时进度。
         有索引时保持慢速心跳，任何一次构建都能在 4s 内被发现并弹面板。 */
      useEffect(() => {
        if (!rootInfo?.root) return undefined;
        const building = indexInfo?.building === true;
        let alive = true;
        const tick = () => {
          api('/index/status', undefined, sessionRef.current)
            .then((info) => { if (alive) setIndexInfo(info); })
            .catch(() => { /* next tick retries */ });
        };
        const timer = window.setInterval(tick, building ? 900 : 4000);
        return () => { alive = false; window.clearInterval(timer); };
      }, [rootInfo?.root, indexInfo?.building, indexInfo?.built]);

      useEffect(() => {
        if (indexInfo?.progress?.phase === 'failed') {
          setNotice({ kind: 'error', text: tRef.current('indexFailed') });
        }
      }, [indexInfo?.progress?.phase]);

      useEffect(() => {
        if (!rootInfo?.root || activePath === '') {
          setOutlineData({ path: '', symbols: [], loading: false, error: null });
          return undefined;
        }
        let alive = true;
        setOutlineData((previous) => ({ ...previous, path: activePath, loading: true, error: null }));
        const timer = window.setTimeout(async () => {
          try {
            const data = await api(`/outline?path=${encodeURIComponent(activePath)}`, undefined, sessionRef.current);
            if (!alive) return;
            setOutlineData({
              path: activePath,
              symbols: Array.isArray(data.symbols) ? data.symbols : [],
              approx: data.approx === true,
              loading: false,
              error: null,
            });
          } catch (error) {
            if (!alive) return;
            setOutlineData({ path: activePath, symbols: [], loading: false, error: errorText(error, tRef.current) });
          }
        }, 180);
        return () => { alive = false; window.clearTimeout(timer); };
      }, [activePath, rootInfo?.root, indexInfo?.builtAt, indexInfo?.symbolCount, outlineTick]);

      /* Declaration colouring. The index describes the file on disk, so a dirty
       * buffer must not be painted (its line numbers have moved). Papering over
       * that would put colour on unrelated code, which KernelSight explicitly
       * avoids. */
      useEffect(() => {
        const adapter = adapterRef.current;
        if (!adapter) return;
        try {
          adapter.applyCodeEmphasis({});
        } catch (error) {
          console.warn('[sourcelook] code emphasis failed:', error);
        }
      }, [activePath, monacoStatus, tabs]);

      useEffect(() => {
        const adapter = adapterRef.current;
        if (!adapter) return;
        const tab = tabsRef.current.find((item) => item.path === activeRef.current);
        const clean = tab && !tab.dirty && outlineData.path === activePath && outlineData.path !== '' && !outlineData.loading;
        if (!clean) {
          try { adapter.clearSemanticSpans(); } catch { /* editor gone */ }
          return;
        }
        const model = adapter.raw.getModel();
        if (!model) return;
        try { adapter.applyCodeEmphasis({}); } catch { /* emphasis is optional */ }
        try {
          const symbols = outlineData.path === activePath ? outlineData.symbols : [];
          const spans = semanticSpansFor(model, symbols || []);
          if (spans.length > 0) adapter.applySemanticSpans(spans);
          else adapter.clearSemanticSpans();
        } catch { /* semantic colour is optional */ }
        try {
          if (model.getValueLength() > 1.5 * 1024 * 1024) {
            adapter.clearSemanticSpans();
            return;
          }
          const spans = semanticSpansFor(model, outlineData.symbols);
          if (spans.length === 0) adapter.clearSemanticSpans();
          else adapter.applySemanticSpans(spans);
        } catch {
          try { adapter.clearSemanticSpans(); } catch { /* editor gone */ }
        }
      }, [outlineData, activePath, tabs, monacoStatus]);

      useEffect(() => {
        if (!symbolOpen) { setSymbolLoading(false); return undefined; }
        const query = symbolQuery.trim();
        if (query === '') {
          setSymbolResults([]);
          setSymbolNeedsIndex(false);
          setSymbolError(null);
          setSymbolLoading(false);
          return undefined;
        }
        let alive = true;
        setSymbolLoading(true);
        const timer = window.setTimeout(async () => {
          try {
            const data = await api(`/symbols?q=${encodeURIComponent(query)}&limit=60`, undefined, sessionRef.current);
            if (!alive) return;
            setSymbolResults(Array.isArray(data.symbols) ? data.symbols : []);
            setSymbolNeedsIndex(data.needsIndex === true);
            setSymbolError(null);
          } catch (error) {
            if (!alive) return;
            setSymbolResults([]);
            setSymbolError(errorText(error, tRef.current));
          } finally {
            if (alive) setSymbolLoading(false);
          }
        }, 160);
        return () => { alive = false; window.clearTimeout(timer); };
      }, [symbolOpen, symbolQuery]);

      /* --------------------------------------------------------- tab hydration */

      useEffect(() => {
        const root = rootInfo?.root;
        if (!root) return undefined;
        let alive = true;
        hydratedRef.current = false;
        lastActiveRef.current = '';
        viewStatesRef.current.clear();
        if (adapterRef.current) {
          if (tabsRef.current.length > 0) {
            try { adapterRef.current.raw.setModel(null); } catch { /* ignore */ }
            for (const tab of tabsRef.current) {
              try { adapterRef.current.disposeModel(tab.absolutePath); } catch { /* ignore */ }
            }
          }
        }
        setTabs([]);
        setActivePath('');
        setConflict(null);
        setSaveState('idle');
        setNotice(null);
        setCursor({ line: 1, column: 1 });
        setIndexInfo(null);
        setOutlineData({ path: '', symbols: [], loading: false, error: null });
        setResults(null);
        setResultsPreview(null);
        previewCacheRef.current.clear();
        setSymbolOpen(false);
        pendingRevealRef.current = null;
        pendingScrollRef.current = null;

        (async () => {
          const stored = readJsonStorage(TABS_PREFIX + root, null);
          const paths = Array.isArray(stored?.tabs)
            ? stored.tabs.filter((item) => typeof item === 'string' && item !== '').slice(0, 20)
            : [];
          const activeSaved = typeof stored?.active === 'string' ? stored.active : '';
          const loaded = [];
          /* 先恢复“上次活动的那个文件”，其余标签随后补齐：这样重启后第一个
             画面就是代码，而不是先闪一张欢迎页（以前是按顺序读完 20 个文件
             才 setTabs，慢的时候能停好几秒）。 */
          const loadOne = async (rel) => {
            const data = await api(`/file?path=${encodeURIComponent(rel)}`, undefined, sessionRef.current);
            const draft = readJsonStorage(draftKey(root, rel), null);
            const useDraft = draft !== null
              && typeof draft.content === 'string'
              && draft.content !== data.content
              && draft.content.length <= DRAFT_LIMIT;
            return makeTab(data, useDraft ? draft.content : data.content, useDraft);
          };
          const ordered = () => paths
            .map((rel) => loaded.find((tab) => tab.path === rel))
            .filter(Boolean);
          const firstPath = paths.includes(activeSaved) ? activeSaved : (paths[0] ?? '');
          if (firstPath !== '') {
            try {
              loaded.push(await loadOne(firstPath));
            } catch {
              /* 文件没了就跳过，继续按顺序恢复其余标签 */
            }
            if (!alive) return;
          }
          const nextActive = loaded.some((tab) => tab.path === activeSaved)
            ? activeSaved
            : (loaded[0]?.path ?? '');
          /* 直接读持久化的 caret 表，不依赖 root effect 与 tabs 加载的先后。
             如果该文件还没有 caret，再看 lastPos（上次关闭时的活动文件）。 */
          const carets = readCarets(root);
          const lastPos = readLastPos();
          const fromCarets = Number(carets?.[nextActive]?.line);
          const fromLast = lastPos && lastPos.root === root && lastPos.rel === nextActive
            ? Number(lastPos.line) : 0;
          const remembered = fromCarets > 0 ? fromCarets : fromLast;
          if (nextActive !== '' && Number.isFinite(remembered) && remembered > 0) {
            pendingRevealRef.current = { path: nextActive, line: Math.round(remembered) };
            startupRestoreRef.current = { path: nextActive, line: Math.round(remembered) };
          }
          const savedScroll = Number(carets?.[nextActive]?.scrollTop ?? lastPos?.scrollTop);
          if (nextActive !== '' && Number.isFinite(savedScroll) && savedScroll >= 0) {
            pendingScrollRef.current = { path: nextActive, scrollTop: Math.round(savedScroll) };
          }
          /* 第一批：活动文件先上场（有内容就直接放行闸门，见到代码即止）。 */
          setTabs(ordered());
          if (nextActive !== '') setActivePath(nextActive);
          markBootReady();
          /* 剩余标签逐个补齐，期间不再动 activePath。 */
          for (const rel of paths) {
            if (!alive) return;
            if (loaded.some((tab) => tab.path === rel)) continue;
            try {
              loaded.push(await loadOne(rel));
            } catch {
              /* A tab whose file disappeared is dropped, not fatal. */
            }
            if (!alive) return;
            setTabs(ordered());
          }
          /* 极端情况：活动文件没读出来、其余标签却读出来了 —— 别留在空屏。 */
          if (nextActive === '' && loaded.length > 0) setActivePath(loaded[0].path);
          hydratedRef.current = true;
        })();

        return () => { alive = false; };
      }, [rootInfo?.root, makeTab, markBootReady]);

      useEffect(() => {
        const root = rootInfo?.root;
        if (!root || !hydratedRef.current) return;
        writeJsonStorage(TABS_PREFIX + root, {
          tabs: tabs.map((tab) => tab.path),
          active: activePath,
        });
      }, [tabs, activePath, rootInfo?.root]);

      /* ------------------------------------------------------------- Monaco */

      const handleModelChange = useCallback(() => {
        /* Context panels cache index line numbers: any edit makes them stale. */
        contextCacheRef.current.clear();
        const adapter = adapterRef.current;
        const tab = tabsRef.current.find((item) => item.path === activeRef.current);
        if (!adapter || !tab) return;
        const model = adapter.raw.getModel();
        if (!model) return;
        const dirty = tab.forceDirty || model.getAlternativeVersionId() !== tab.savedAltVersion;
        if (dirty !== tab.dirty) {
          updateTabs((previous) => previous.map((item) => (
            item.path === tab.path ? { ...item, dirty } : item
          )));
        }
        scheduleDraft(tab, model.getValue());
      }, [updateTabs]);

      /* The editor is created once and lives until the plugin unmounts. Keeping
       * it out of the effect cleanup matters: a re-run must not delete the
       * editor's DOM while the React tree stays mounted. */
      const changeHandlerRef = useRef(null);
      changeHandlerRef.current = handleModelChange;

      useEffect(() => {
        let alive = true;
        let unwatch = null;
        /* React only honours a cleanup returned synchronously by the effect —
           a `return () => …` inside the .then() below would be dropped and every
           monacoReload would stack another pair of DOM listeners (holding the
           disposed adapter's closure) on the editor host. */
        let detach = null;
        beacon('monaco-effect');
        setMonacoStatus('loading');
        setMonacoError('');

        const previous = adapterRef.current;
        if (previous) {
          adapterRef.current = null;
          try { previous.raw.dispose(); } catch { /* already gone */ }
        }

        ensureMonaco().then((monaco) => {
          if (!alive) return;
          monacoRef.current = monaco;
          defineMonacoTheme(monaco);
          unwatch = watchTheme(monaco);
          const adapter = window.createMonacoAdapter({
            monaco,
            theme: 'sourcelook',
            fontSize: fontSizeRef.current,
            lineHeight: Math.round(fontSizeRef.current * 1.31),
            fontFamily: '"Cascadia Mono", "SFMono-Regular", "JetBrains Mono", Consolas, "Liberation Mono", monospace',
          });
          adapter.mount(editorHostRef.current);
          window.requestAnimationFrame(() => applyCursorContrast());
          adapter.raw.updateOptions({
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'off',
            tabSize: 4,
            insertSpaces: true,
            /* 流畅优先：关掉逐字符/逐光标的装饰计算，滚动时只做可见行渲染。
               smoothScrolling 只影响**物理滚轮**：开启后每一格都要走 125ms 的
               缓动动画（Monaco 内部 MG=125），滚轮因此永远"慢半拍"；触摸板的
               精确像素增量本来就直写 scrollTop，不受该选项影响。关掉它，滚轮
               才是 1:1 跟手。 */
            renderWhitespace: 'none',
            smoothScrolling: false,
            mouseWheelScrollSensitivity: 2.2,
            fastScrollSensitivity: 9,
            occurrencesHighlight: 'off',
            selectionHighlight: false,
            matchBrackets: 'never',
            bracketPairColorization: { enabled: false },
            renderValidationDecorations: 'off',
            cursorBlinking: 'solid',
            cursorSmoothCaretAnimation: 'off',
            /* 默认 2px 在 200% DPI 下太粗；1.5 更细，光标颜色由主题单独保证对比。 */
            cursorWidth: 1.5,
            cursorStyle: 'line',
            stickyScroll: { enabled: false },
            scrollbar: { useShadows: false, verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
            lineDecorationsWidth: 4,
            stopRenderingLineAfter: 5000,
            maxTokenizationLineLength: 20000,
            overviewRulerLanes: 0,
            overviewRulerBorder: false,
            hideCursorInOverviewRuler: true,
            renderLineHighlight: 'line',
            fontLigatures: false,
            padding: { top: 6 },
            lineNumbersMinChars: 4,
            glyphMargin: false,
            folding: false,
            guides: { indentation: false, highlightActiveIndentation: false },
          });
          adapter.raw.onDidChangeCursorPosition((event) => {
            const next = { line: event.position.lineNumber, column: event.position.column };
            const previous = cursorRef.current;
            if (previous.line === next.line && previous.column === next.column) return;
            cursorRef.current = next;
            /* 光标/列号不需要每帧重绘整个 App；50ms 合并一次，点击换行仍是即时手感。 */
            if (cursorRafRef.current) return;
            cursorRafRef.current = window.setTimeout(() => {
              cursorRafRef.current = 0;
              const nextCursor = cursorRef.current;
              if (typeof React.startTransition === 'function') {
                React.startTransition(() => setCursor(nextCursor));
              } else {
                setCursor(nextCursor);
              }
            }, 50);
          });
          /* 触摸板双指滚动是高频像素事件；Monaco 默认会经过自己的累加/平滑
             逻辑，快速滑动时追不上原生窗口。监听 window 捕获阶段，确保抢在
             Monaco 自己的滚轮处理之前；普通鼠标滚轮仍走 Monaco 原逻辑。 */
          let scrollSaveTimer = 0;
          const scrollDisposable = adapter.raw.onDidScrollChange?.(() => {
            if (scrollSaveTimer !== 0) return;
            scrollSaveTimer = window.setTimeout(() => {
              scrollSaveTimer = 0;
              caretSaveRef.current?.();
            }, 450);
          });
          adapter.onNavigateRequest((position, word) => {
            if (word) void gotoDefinitionRef.current?.(word);
          });
          adapter.registerShortcut('F12', () => {
            const word = adapter.getWordAtCursor();
            if (word) void gotoDefinitionRef.current?.(word);
          });
          adapter.registerShortcut('Shift+F12', () => {
            const word = adapter.getWordAtCursor();
            if (word) void findReferencesRef.current?.(word);
          });
          adapter.onChange(() => changeHandlerRef.current?.());
          adapter.onSingleClick(({ word, position }) => {
            if (word) {
              if (position) setCursor({ line: position.line, column: position.column });
              setTopFind(word);
              try { adapter.transientHighlightWord(word); } catch { /* decorative only */ }
              void showContextRef.current?.(word, position ?? undefined);
            } else {
              try { adapter.transientHighlight([]); } catch { /* decorative only */ }
            }
          });
          adapter.onRightClick(({ x, y, word, position }) => {
            setEditorMenu({ x, y, word: word || '', line: position?.line ?? 1, column: position?.column ?? 1 });
          });
          const editorHost = editorHostRef.current;
          const openContextMenu = (event) => {
            event.preventDefault();
            let word = '';
            let line = 1;
            let column = 1;
            try {
              const raw = adapter.raw;
              const target = raw.getTargetAtClientPoint?.(event.clientX, event.clientY);
              const position = target?.position;
              if (position) {
                line = position.lineNumber;
                column = position.column;
                const model = raw.getModel();
                word = model?.getWordAtPosition(position)?.word ?? '';
              }
            } catch { /* hit testing is best effort */ }
            setEditorMenu({ x: event.clientX, y: event.clientY, word, line, column });
          };
          editorHost?.addEventListener('contextmenu', openContextMenu);
          /* Double-click a word: no jump (that is the original's rule), but the
           * floating action bar appears next to the selection. */
          const openFloatBar = (event) => {
            if (event.detail < 2) return;
            let word = '';
            let position = null;
            try {
              const raw = adapter.raw;
              const target = raw.getTargetAtClientPoint?.(event.clientX, event.clientY);
              position = target?.position ?? null;
              const model = raw.getModel();
              if (position && model) word = model.getWordAtPosition(position)?.word ?? '';
            } catch { /* hit testing is best effort */ }
            if (word === '') {
              setFloatBar(null);
              /* 双击空白打开 AI 编辑带；已有内容时不再另开一个（原版行为）。 */
              const zone = aiZoneRef.current;
              if (zone && zone.request.value.trim() !== '') {
                flashHint('先把当前的 AI 编辑框处理完（Esc 取消）');
                return;
              }
              if (position) openAiEditRef.current?.(position);
              return;
            }
            const symbol = (outlineRef.current.symbols || []).find((item) => item.name === word);
            const bar = {
              word,
              line: position?.lineNumber ?? cursorRef.current.line,
              column: position?.column ?? 1,
              kind: symbol ? definitionLabel(symbol) : '标识符',
              x: event.clientX + 14,
              y: event.clientY - 8,
              highlighted: highlightRef.current?.word === word,
            };
            setFloatBar(bar);
            /* Add 展开 only when the index confirms this is a macro call. */
            void macroExpandableRef.current?.(bar.word, bar.line, bar.column).then((ok) => {
              if (ok === true) {
                setFloatBar((previous) => (previous && previous.word === bar.word ? { ...previous, macro: true } : previous));
              }
            });
          };
          editorHost?.addEventListener('dblclick', openFloatBar);
          adapterRef.current = adapter;
          setMonacoStatus('ready');
          beacon('monaco-ready');

          try { adapter.setFontSize?.(fontSizeRef.current); } catch { /* optional */ }
          /* Ctrl+F 归我们：聚焦本文件查找条（Monaco 自带的浮窗锚在编辑器右上角，
             C 模式下正好被 DSH 面板盖住，等于不可用）。 */
          try {
            const monacoApi = window.monaco;
            if (monacoApi && typeof adapter.raw?.addCommand === 'function') {
              adapter.raw.addCommand(
                monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyF,
                () => { fileFindApiRef.current?.reveal?.(); },
              );
              adapter.raw.addCommand(
                monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyH,
                () => { fileFindApiRef.current?.reveal?.(); },
              );
            }
          } catch { /* older monaco */ }
          detach = () => {
            editorHost?.removeEventListener('contextmenu', openContextMenu);
            editorHost?.removeEventListener('dblclick', openFloatBar);
            if (scrollSaveTimer !== 0) window.clearTimeout(scrollSaveTimer);
            try { scrollDisposable?.dispose?.(); } catch { /* gone */ }
            detach = null;
          };
        }).catch((error) => {
          if (!alive) return;
          beacon('monaco-error', error?.message ?? String(error));
          console.error('[sourcelook] Monaco load failed:', error);
          setMonacoStatus('error');
          setMonacoError(error instanceof Error ? error.message : String(error));
        });

        return () => {
          alive = false;
          if (unwatch) unwatch();
          if (detach) detach();
        };
      }, [monacoReload]);

;
      useEffect(() => () => {
        const adapter = adapterRef.current;
        adapterRef.current = null;
        if (adapter) {
          try { adapter.raw.dispose(); } catch { /* already gone */ }
        }
      }, []);

      /* --------------------------------------------------------- active model */

      useEffect(() => {
        const adapter = adapterRef.current;
        const root = rootInfo?.root;
        if (!adapter || !root || activePath === '') return;
        const tab = tabsRef.current.find((item) => item.path === activePath);
        if (!tab) return;

        const previous = lastActiveRef.current;
        if (previous !== '' && previous !== activePath) {
          try { viewStatesRef.current.set(previous, adapter.raw.saveViewState()); } catch { /* ignore */ }
        }

        const monaco = monacoRef.current;
        const uri = monaco.Uri.file(tab.absolutePath);
        const existing = monaco.editor.getModel(uri);
        const text = existing ? existing.getValue() : tab.content;
        const model = adapter.setContent(tab.absolutePath, text, languageOf(tab.path));
        /* setContent 会清掉旧的函数/宏强调；内容就位后立刻重算，词法器还没
           就绪时 applyCodeEmphasis 会保留旧装饰并自动重试。 */
        try { adapter.applyCodeEmphasis({}); } catch { /* emphasis is optional */ }
        try {
          const symbols = outlineData.path === activePath ? outlineData.symbols : [];
          const spans = semanticSpansFor(model, symbols || []);
          if (spans.length > 0) adapter.applySemanticSpans(spans);
          else adapter.clearSemanticSpans();
        } catch { /* semantic colour is optional */ }
        if (tab.savedAltVersion === undefined && !tab.forceDirty) {
          tab.savedAltVersion = model.getAlternativeVersionId();
        }
        const dirty = tab.forceDirty || model.getAlternativeVersionId() !== tab.savedAltVersion;
        if (dirty !== tab.dirty) {
          updateTabs((previousTabs) => previousTabs.map((item) => (
            item.path === tab.path ? { ...item, dirty } : item
          )));
        }

        const viewState = viewStatesRef.current.get(activePath);
        if (viewState) {
          try { adapter.raw.restoreViewState(viewState); } catch { /* ignore */ }
        }
        const pendingReveal = pendingRevealRef.current;
        if (pendingReveal && pendingReveal.path === activePath) {
          pendingRevealRef.current = null;
          try { adapter.revealLine(pendingReveal.line, true); } catch { /* ignore */ }
        }
        const pendingScroll = pendingScrollRef.current;
        if (pendingScroll && pendingScroll.path === activePath) {
          pendingScrollRef.current = null;
          try { adapter.raw.setScrollTop?.(pendingScroll.scrollTop); } catch { /* ignore */ }
        }
        const startup = startupRestoreRef.current;
        if (startup !== null && startup.path === activePath) {
          /* 不再弹"已回到上次的位置"提示：启动时多一块临时文字反而更乱。 */
          startupRestoreRef.current = null;
        }
        /* 滚动位置已经就位，还要等 Monaco 真的按新位置重绘完再亮出来。
           只等两帧不够：Monaco 的渲染是它自己的 rAF 队列，撤掉 visibility:hidden
           会先把上一帧（第 1 行空白）露出来 —— 那就是"左上角小框框"的来源。
           这里多留约 60ms，确保重绘落地。 */
        if (!editorVisibleRef.current) {
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
            window.setTimeout(() => {
              /* 强制同步重绘一次再亮出：`render(true)` 让 Monaco 立刻按当前滚动位置
                 重画，避免把上一帧（第 1 行空白）的位图露出来。 */
              try { adapter.raw.render?.(true); } catch { /* older monaco */ }
              editorVisibleRef.current = true;
              setEditorVisible(true);
            }, 60);
          }));
        }
        lastActiveRef.current = activePath;
        adapter.raw.focus();
      }, [activePath, rootInfo?.root, monacoStatus, monacoReload, updateTabs]);

      /* -------------------------------------------------------------- drafts */

      function clearDraft(tab) {
        const root = rootRef.current?.root;
        if (!root || !tab) return;
        const timer = draftTimersRef.current.get(tab.path);
        if (timer) { window.clearTimeout(timer); draftTimersRef.current.delete(tab.path); }
        removeStorage(draftKey(root, tab.path));
      }

      function scheduleDraft(tab, content) {
        const root = rootRef.current?.root;
        if (!root) return;
        const pending = draftTimersRef.current.get(tab.path);
        if (pending) window.clearTimeout(pending);
        const timer = window.setTimeout(() => {
          draftTimersRef.current.delete(tab.path);
          if (content.length > DRAFT_LIMIT) {
            removeStorage(draftKey(root, tab.path));
            return;
          }
          const ok = writeJsonStorage(draftKey(root, tab.path), {
            content,
            version: tab.baseVersion,
            savedAt: Date.now(),
          });
          /* 配额满时不要假装存了：清掉这条旧草稿并只提示一次，避免用户以为
             有草稿可恢复。 */
          if (ok === false && draftQuotaWarnedRef.current !== true) {
            draftQuotaWarnedRef.current = true;
            removeStorage(draftKey(root, tab.path));
            flashHint('草稿保存失败：本地存储已满（保存文件即可清除草稿）');
          }
        }, 500);
        draftTimersRef.current.set(tab.path, timer);
      }

      useEffect(() => () => {
        for (const timer of draftTimersRef.current.values()) window.clearTimeout(timer);
        draftTimersRef.current.clear();
        if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
        if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
        if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current);
      }, []);

      useEffect(() => {
        if (!conflict && !notice) return;
        const timer = window.setTimeout(() => setNotice(null), 6000);
        noticeTimerRef.current = timer;
        return () => window.clearTimeout(timer);
      }, [conflict, notice]);

      /* ------------------------------------------------------------ operations */

      const addRecent = useCallback((rel) => {
        const root = rootRef.current?.root;
        if (!root) return;
        setRecent((previous) => {
          const next = [rel, ...previous.filter((item) => item !== rel)].slice(0, 12);
          writeJsonStorage(RECENT_PREFIX + root, next);
          return next;
        });
      }, []);

      const openFile = useCallback(async (rel) => {
        if (!rootRef.current) return;
        rememberCurrentHistory();
        const existing = tabsRef.current.find((tab) => tab.path === rel);
        if (existing) {
          setActivePath(rel);
          setPickerOpen(false);
          return;
        }
        try {
          const data = await api(`/file?path=${encodeURIComponent(rel)}`, undefined, sessionRef.current);
          /* 同一个文件被点两次（快速打开里双击）会并发两个请求：await 之后再
             复查一次，否则会开出两个同路径标签，二者共用草稿/dirty 键。 */
          if (tabsRef.current.some((tab) => tab.path === rel)) {
            setActivePath(rel);
            setPickerOpen(false);
            return;
          }
          const tab = makeTab(data, data.content, false);
          setTabs((previous) => (previous.some((item) => item.path === rel) ? previous : [...previous, tab]));
          setActivePath(rel);
          setPickerOpen(false);
          setConflict(null);
          addRecent(rel);
          if (data.readOnly) setNotice({ kind: 'warn', text: tRef.current('notUtf8') });
        } catch (error) {
          setNotice({ kind: 'error', text: errorText(error, tRef.current) });
        }
      }, [addRecent]);

      const revealLine = useCallback((line) => {
        const adapter = adapterRef.current;
        if (!adapter || !Number.isFinite(Number(line))) return;
        try {
          adapter.revealLine(Math.max(1, Math.round(Number(line))), true);
          adapter.raw.focus();
        } catch { /* the editor may be gone */ }
      }, []);

      const recordHistory = useCallback((path, line) => {
        if (restoringHistoryRef.current || typeof path !== 'string' || path === '') return;
        const history = historyRef.current;
        const last = history[historyIndexRef.current];
        if (last && last.path === path && last.line === line) return;
        const next = history.slice(0, historyIndexRef.current + 1);
        next.push({ path, line });
        if (next.length > 80) next.shift();
        historyRef.current = next;
        historyIndexRef.current = next.length - 1;
        setHistoryVersion((value) => value + 1);
      }, []);

      const liveEditorLine = useCallback(() => {
        const rawLine = Number(adapterRef.current?.raw?.getPosition?.()?.lineNumber);
        const line = rawLine > 0 ? rawLine : Number(cursorRef.current.line);
        return Math.max(1, Math.round(Number.isFinite(line) && line > 0 ? line : 1));
      }, []);
      const rememberCurrentHistory = useCallback(() => {
        const history = historyRef.current;
        const current = history[historyIndexRef.current];
        const active = activeRef.current;
        if (!current || current.path !== active) return;
        const line = liveEditorLine();
        if (current.line !== line) {
          current.line = line;
          setHistoryVersion((value) => value + 1);
        }
      }, [liveEditorLine]);
      /* 离开一个文件时，把它当时的光标行写回历史；回来时才能回到原位置。 */
      const prevActiveRef = useRef('');
      useEffect(() => {
        prevActiveRef.current = activePath;
        if (activePath === '') return;
        const remembered = Number(caretMapRef.current?.[activePath]?.line);
        recordHistory(activePath, Number.isFinite(remembered) && remembered > 0 ? Math.round(remembered) : 1);
      }, [activePath, recordHistory, liveEditorLine]);

      /* 打开/切换文件时预热局部作用域 AST：纯后台，失败或老 Host 没有该路由时
         静默忽略（首次点击仍走文本兜底）。 */
      useEffect(() => {
        if (activePath === '' || !/\.(c|h)$/iu.test(activePath)) return;
        void api('/local-scope/warm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: activePath }),
        }, sessionRef.current).catch(() => { /* old host or remote project */ });
      }, [activePath]);

      const openFileAt = useCallback(async (rel, line) => {
        if (typeof rel !== 'string' || rel === '') return;
        rememberCurrentHistory();
        const remembered = Number(caretMapRef.current?.[rel]?.line);
        const wanted = Number(line) > 0 ? Number(line) : (Number.isFinite(remembered) && remembered > 0 ? remembered : 1);
        const targetLine = Math.round(wanted);
        caretMapRef.current = { ...caretMapRef.current, [rel]: { line: targetLine, column: 1 } };
        recordHistory(rel, targetLine);
        pendingRevealRef.current = { path: rel, line: targetLine };
        setSymbolOpen(false);
        if (activeRef.current === rel) {
          pendingRevealRef.current = null;
          revealLine(targetLine);
          return;
        }
        await openFile(rel);
      }, [openFile, revealLine, recordHistory, rememberCurrentHistory, liveEditorLine]);

      openFileAtRef.current = openFileAt;

      /* 传给左右面板的回调保持稳定，React.memo 才能在光标/无关状态变化时跳过
         整个符号列表的重渲染。 */
      const toggleSymbolPane = useCallback(() => {
        setSymbolPaneCollapsed((value) => !value);
      }, []);
      const selectSymbol = useCallback(async (symbol) => {
        if (symbol.pseudo === true) {
          revealLine(symbol.line);
          return;
        }
        await openFileAt(symbol.file || activePath, symbol.line);
        if (typeof symbol.name === 'string' && symbol.name !== '') {
          setTopFind(symbol.name);
          void showContextRef.current?.(symbol.name);
        }
      }, [activePath, openFileAt, revealLine]);
      const toggleGlobalPane = useCallback(() => {
        setGlobalCollapsed((value) => !value);
      }, []);
      const openGlobalItem = useCallback((file, line) => {
        void openFileAtRef.current?.(file, line);
      }, []);
      const previewGlobalItem = useCallback((item) => {
        if (item?.name) {
          setTopFind(item.name);
          void showContextRef.current?.(item.name);
        }
      }, []);
      const noteGlobalItem = useCallback((text) => flashHint(text), [flashHint]);
      const goBack = useCallback(async () => {
        if (historyIndexRef.current <= 0) return;
        /* 先把当前文件离开时的真实行写回它自己的历史项，再移动索引。 */
        const leaving = historyRef.current[historyIndexRef.current];
        if (leaving) leaving.line = liveEditorLine();
        restoringHistoryRef.current = true;
        historyIndexRef.current -= 1;
        setHistoryVersion((value) => value + 1);
        const target = historyRef.current[historyIndexRef.current];
        try {
          if (target) await openFileAt(target.path, target.line);
        } finally {
          restoringHistoryRef.current = false;
        }
      }, [openFileAt, liveEditorLine]);

      const goForward = useCallback(async () => {
        if (historyIndexRef.current >= historyRef.current.length - 1) return;
        const leaving = historyRef.current[historyIndexRef.current];
        if (leaving) leaving.line = liveEditorLine();
        restoringHistoryRef.current = true;
        historyIndexRef.current += 1;
        setHistoryVersion((value) => value + 1);
        const target = historyRef.current[historyIndexRef.current];
        try {
          if (target) await openFileAt(target.path, target.line);
        } finally {
          restoringHistoryRef.current = false;
        }
      }, [openFileAt, liveEditorLine]);;

      const startIndex = useCallback(async (confirmed = false) => {
        if (!rootInfo) return;
        if (!confirmed && indexInfo?.built === true && indexInfo?.building !== true) {
          setIndexConfirm(true);
          return;
        }
        setIndexBusy(true);
        /* 面板立刻打开（别等第一次轮询）：用户点了"刷新索引"，马上就该看到进度。 */
        setIndexPanelFinal(null);
        setIndexPanelOpen(true);
        try {
          const response = await api('/index/build', { method: 'POST' }, sessionRef.current);
          if (response?.state) setIndexInfo(response.state);
          else void refreshIndex();
        } catch (error) {
          setNotice({ kind: 'error', text: errorText(error, tRef.current) });
        } finally {
          setIndexBusy(false);
        }
      }, [rootInfo, refreshIndex, indexInfo]);

      startIndexRef.current = startIndex;

      const cancelIndex = useCallback(async () => {
        try {
          const data = await api('/index/cancel', { method: 'POST' }, sessionRef.current);
          if (data && data.canceled === false) setIndexCancelRequested(false);
          await refreshIndex();
        } catch {
          setIndexCancelRequested(false);
          flashHint('取消失败，稍后会自动刷新状态', 'error');
        }
      }, [refreshIndex, flashHint]);

      const previewResult = useCallback(async (item) => {
        if (!item?.file) return;
        const seq = ++contextPreviewSeqRef.current;
        const commit = (next) => {
          if (seq === contextPreviewSeqRef.current) setResultsPreview(next);
        };
        const file = item.file;
        const line = Number.isFinite(Number(item.line)) && Number(item.line) > 0 ? Math.round(Number(item.line)) : 1;
        const cached = previewCacheRef.current.get(file);
        if (typeof cached === 'string') {
          commit({ file, line, content: cached, loading: false, error: null });
          return;
        }
        commit({ file, line, content: '', loading: true, error: null });
        try {
          /* 同一次点击会连着要两次预览（结果窗 + 底部上下文窗），两次都在
             await 之前 miss 缓存 → 同一个文件读两遍（实测 30–90 ms ×2）。
             并发只发一次请求，后来者等同一个 Promise。 */
          let pending = previewPendingRef.current.get(file);
          if (pending === undefined) {
            pending = api(`/file?path=${encodeURIComponent(file)}`, undefined, sessionRef.current)
              .then((data) => {
                if (previewCacheRef.current.size >= 8) {
                  const first = previewCacheRef.current.keys().next().value;
                  if (first !== undefined) previewCacheRef.current.delete(first);
                }
                previewCacheRef.current.set(file, data.content);
                return data.content;
              })
              .finally(() => { previewPendingRef.current.delete(file); });
            previewPendingRef.current.set(file, pending);
          }
          const content = await pending;
          commit({ file, line, content, loading: false, error: null });
        } catch (error) {
          commit({ file, line, content: '', loading: false, error: errorText(error, tRef.current) });
        }
      }, []);

      const showResults = useCallback((next) => {
        setResults(next);
        resultStepRef.current = -1;
        const first = next?.preview ?? next?.items?.[0] ?? next?.refs?.[0];
        if (first) void previewResult(first);
        else setResultsPreview(null);
      }, [previewResult]);





      /* ----------------------------------------------------- result window */

      const [resultWin, setResultWin] = useState(null);
      const [resultWinPreview, setResultWinPreview] = useState(null);
      const resultWinRef = useRef(null);
      resultWinRef.current = resultWin;
      const lastResultRef = useRef(null);
      const resultQueryRef = useRef({ kind: 'find', word: '', scope: 'idx' });

      /* Keep the last *filled* result so 查找结果 can reopen it. */
      useEffect(() => {
        if (resultWin !== null) lastResultRef.current = resultWin;
      }, [resultWin]);

      const loadResultPreview = useCallback(async (hit) => {
        const seq = ++previewSeqRef.current;
        const commit = (next) => {
          if (seq === previewSeqRef.current) setResultWinPreview(next);
        };
        if (!hit?.file) {
          commit(null);
          return;
        }
        const line = Math.max(1, Number(hit.line) || 1);
        /* The open file may have unsaved edits: preview the buffer, not disk,
           exactly like the original reader's code viewer. */
        if (hit.file === activeRef.current) {
          const live = adapterRef.current?.raw.getModel()?.getValue?.();
          if (typeof live === 'string') {
            commit({ file: hit.file, line, content: live, loading: false, error: null });
            return;
          }
        }
        const cached = previewCacheRef.current.get(hit.file);
        if (typeof cached === 'string') {
          commit({ file: hit.file, line, content: cached, loading: false, error: null });
          return;
        }
        commit({ file: hit.file, line, content: '', loading: true, error: null });
        try {
          /* 与 previewResult 共用同一份"正在读"：结果窗和底部窗常常同时
             要同一个文件的预览，否则同一文件会被读两遍。 */
          let pending = previewPendingRef.current.get(hit.file);
          if (pending === undefined) {
            pending = api(`/file?path=${encodeURIComponent(hit.file)}`, undefined, sessionRef.current)
              .then((data) => {
                if (previewCacheRef.current.size >= 8) {
                  const first = previewCacheRef.current.keys().next().value;
                  if (first !== undefined) previewCacheRef.current.delete(first);
                }
                previewCacheRef.current.set(hit.file, data.content);
                return data.content;
              })
              .finally(() => { previewPendingRef.current.delete(hit.file); });
            previewPendingRef.current.set(hit.file, pending);
          }
          const content = await pending;
          commit({ file: hit.file, line, content, loading: false, error: null });
        } catch (error) {
          commit({ file: hit.file, line, content: '', loading: false, error: errorText(error, tRef.current) });
        }
      }, []);

      /* Index rows carry only file:line — read those lines back so each row can
         show the matching source text, like the original reader. One read per
         file, at most 120 files; an unreadable file just leaves the text blank. */
      const fillHitText = useCallback(async (hits) => {
        const need = (hits || []).filter((hit) => !hit.text && hit.file);
        if (need.length === 0) return hits;
        const byFile = new Map();
        for (const hit of need) {
          if (!byFile.has(hit.file)) byFile.set(hit.file, []);
          byFile.get(hit.file).push(hit);
        }
        const files = [...byFile.keys()].slice(0, 120);
        await Promise.all(files.map(async (file) => {
          let content = previewCacheRef.current.get(file);
          if (typeof content !== 'string') {
            try {
              const data = await api(`/file?path=${encodeURIComponent(file)}`, undefined, sessionRef.current);
              content = data.content;
              previewCacheRef.current.set(file, content);
            } catch {
              return;
            }
          }
          const lines = String(content).split(/\r?\n/);
          for (const hit of byFile.get(file)) {
            const text = lines[Number(hit.line) - 1];
            if (text !== undefined) hit.text = text.trim().slice(0, 200);
          }
        }));
        return hits;
      }, []);

      /** Show the window right away (with `正在搜索…` when loading). */
      const openResultWindow = useCallback((next) => {
        resultQueryRef.current = { kind: next.kind, word: next.word, scope: next.scope };
        previewSeqRef.current += 1;
        setResultWinPreview(null);
        setResultWin({ selected: -1, hits: [], loading: false, note: '', error: null, ...next });
      }, []);

      /** Fill a window that is already open (keeps its position/size). */
      const fillResultWindow = useCallback((next) => {
        resultQueryRef.current = { kind: next.kind, word: next.word, scope: next.scope };
        previewSeqRef.current += 1;
        setResultWinPreview(null);
        setResultWin((previous) => ({
          ...(previous ?? {}),
          selected: next.hits.length > 0 ? 0 : -1,
          hits: [],
          tree: null,
          loading: false,
          note: '',
          error: null,
          ...next,
        }));
        /* A one-sentence result window also says its line in the status bar,
           like the original (it survives closing the window). */
        if (next.hits.length === 0 && typeof next.note === 'string' && next.note !== '') {
          flashStatus(`${next.title ? `${next.title} — ` : ''}${next.note}`);
        }
      }, [flashStatus]);

      const closeResultWindow = useCallback(() => {
        setResultWin(null);
        setResultWinPreview(null);
      }, []);

      /* Definitions / references → the list shape the window renders
         (symKind / defNote / parent / fn / conf / pool). */
      const toDefinitionHit = useCallback((definition, word) => ({
        file: definition.file,
        line: definition.line,
        column: definition.column ?? 0,
        symKind: definition.kind || '',
        defNote: definition.prototype === true ? '声明' : '',
        parent: definition.parent || '',
        config: definition.config || '',
        pool: definition.pool || '',
        approx: definition.approx === true,
        word,
      }), []);

      const toReferenceHit = useCallback((reference, word) => ({
        file: reference.file,
        line: reference.line,
        column: reference.column ?? 0,
        kind: reference.kind || '',
        fn: reference.fn || '',
        conf: reference.conf || '',
        config: reference.config || '',
        live: reference.live,
        pool: reference.pool || '',
        approx: reference.approx === true,
        word,
      }), []);

      /* 查找: four scopes, exactly like the original. */
      const runFind = useCallback(async (scope, word, options = {}) => {
        const query = String(word || '').trim();
        if (query === '') {
          flashHint('先在查找框里输入要找的内容');
          return;
        }
        const flags = { ...findOptsRef.current, ...options };
        const active = activeRef.current;
        const rel = active.replace(/\\/gu, '/');
        const slash = rel.lastIndexOf('/');
        const dir = slash > 0 ? rel.slice(0, slash) : '';
        const scopeId = scope || 'idx';
        const titles = {
          file: `本文件 · ${rel}`,
          dir: `本目录 · ${dir || '项目根'}`,
          idx: '索引',
          global: '全文匹配',
        };
        const title = titles[scopeId] || '';
        /* The window appears immediately with the spinner: the reader must see
           that the click did something (original behaviour). */
        openResultWindow({ title, kind: 'find', word: query, scope: scopeId, loading: true });
        try {
          if (scopeId === 'file') {
            const model = adapterRef.current?.raw.getModel();
            if (!model) {
              fillResultWindow({ title, kind: 'find', word: query, scope: scopeId, hits: [], note: '还没有打开文件。' });
              return;
            }
            let re;
            try {
              const source = flags.regex ? query : escapeRegExp(query);
              re = new RegExp(flags.word ? `\\b(?:${source})\\b` : source, flags.caseSensitive ? 'u' : 'iu');
            } catch {
              fillResultWindow({ title, kind: 'find', word: query, scope: scopeId, hits: [], note: '正则表达式无效' });
              return;
            }
            const hits = [];
            for (let line = 1; line <= model.getLineCount() && hits.length < 500; line += 1) {
              const text = model.getLineContent(line);
              if (re.test(text)) hits.push({ file: rel, line, text: text.trim().slice(0, 200), word: query });
            }
            fillResultWindow({ title, kind: 'find', word: query, scope: scopeId, hits });
            if (hits.length > 0) void loadResultPreview(hits[0]);
            return;
          }
          if (scopeId === 'dir' || scopeId === 'global') {
            const grepFlags = `&word=${flags.word ? 1 : 0}&regex=${flags.regex ? 1 : 0}&case=${flags.caseSensitive ? 1 : 0}`;
            const scopeQuery = scopeId === 'dir' && dir !== ''
              ? `/grep?q=${encodeURIComponent(query)}&limit=300${grepFlags}&dir=${encodeURIComponent(dir)}`
              : `/grep?q=${encodeURIComponent(query)}&limit=300${grepFlags}`;
            const data = await api(scopeQuery, undefined, sessionRef.current);
            if (data?.error === 'invalid_regex') {
              fillResultWindow({ title, kind: 'find', word: query, scope: scopeId, hits: [], note: '正则表达式无效' });
              return;
            }
            const hits = (Array.isArray(data?.hits) ? data.hits : [])
              .map((hit) => ({ file: hit.file, line: hit.line, text: String(hit.text || '').trim().slice(0, 200), word: query }));
            const finalTitle = scopeId === 'global'
              ? ['全文匹配', summariseRefs(hits)].filter(Boolean).join(' · ')
              : title;
            fillResultWindow({ title: finalTitle, kind: 'find', word: query, scope: scopeId, hits });
            if (hits.length > 0) void loadResultPreview(hits[0]);
            return;
          }
          /* idx: one index query, no file reads except the hit lines. */
          const activeLine = Number(options.line) || cursorRef.current.line;
          const activeColumn = Number(options.column) || cursorRef.current.column;
          const knownKind = String((outlineRef.current.symbols || []).find((item) => item.name === query)?.kind || '').toLowerCase();
          const [data, defData] = await Promise.all([
            api(`/references?name=${encodeURIComponent(query)}&path=${encodeURIComponent(active)}&limit=1000&kind=${encodeURIComponent(knownKind)}`, undefined, sessionRef.current),
            api(`/definition?name=${encodeURIComponent(query)}&path=${encodeURIComponent(active)}&line=${activeLine}&column=${cursorRef.current.column}`, undefined, sessionRef.current).catch(() => null),
          ]);
          if (defData && Array.isArray(defData.definitions) && defData.definitions.length > 0) {
            data.definitions = defData.definitions;
          }
          if (data?.needsIndex === true) {
            fillResultWindow({
              title: '索引', kind: 'find', word: query, scope: scopeId, hits: [],
              note: '没有可用的索引 —— 本项目查找需要索引。点状态栏「建立索引」，或切到「本目录」按文本查找。',
            });
            return;
          }
          const defs = (Array.isArray(data?.definitions) ? data.definitions : []).map((item) => toDefinitionHit(item, query));
          const refs = (Array.isArray(data?.references) ? data.references : []).map((item) => toReferenceHit(item, query));
          const hits = await fillHitText(defs.concat(refs));
          fillResultWindow({
            title: ['索引', summariseRefs(refs)].filter(Boolean).join(' · '),
            kind: 'find',
            word: query,
            scope: scopeId,
            hits,
          });
          if (hits.length > 0) void loadResultPreview(hits[0]);
        } catch (error) {
          setResultWin((previous) => (previous ? {
            ...previous, loading: false, error: errorText(error, tRef.current),
          } : previous));
        }
      }, [fillHitText, loadResultPreview, openResultWindow, toDefinitionHit, toReferenceHit, flashHint]);

      /* 定义 / 调用: fetch first, then either jump (one hit) or open the list. */
      const runSymbolResult = useCallback(async (kind, word, options = {}) => {
        const query = String(word || '').trim();
        if (query === '') {
          flashHint('没有取到符号名');
          return;
        }
        const keep = options.keepWindow === true;
        const active = activeRef.current;
        if (keep) setResultWin((previous) => (previous ? { ...previous, loading: true, error: null } : previous));
        try {
          const activeLine = Number(options.line) || cursorRef.current.line;
          const activeColumn = Number(options.column) || cursorRef.current.column;
          const knownKind = String((outlineRef.current.symbols || []).find((item) => item.name === query)?.kind || '').toLowerCase();
          const [data, defData] = await Promise.all([
            api(`/references?name=${encodeURIComponent(query)}&path=${encodeURIComponent(active)}&limit=${kind === 'defs' ? 400 : 1000}&kind=${encodeURIComponent(knownKind)}`, undefined, sessionRef.current),
            api(`/definition?name=${encodeURIComponent(query)}&path=${encodeURIComponent(active)}&line=${activeLine}&column=${cursorRef.current.column}`, undefined, sessionRef.current).catch(() => null),
          ]);
          if (defData && Array.isArray(defData.definitions) && defData.definitions.length > 0) {
            data.definitions = defData.definitions;
          }
          if (data?.needsIndex === true) {
            fillResultWindow({
              title: '', kind, word: query, scope: '', hits: [],
              note: '没有可用的索引 —— 请先点状态栏的「建立索引」。',
            });
            return;
          }
          const allDefs = Array.isArray(data?.definitions) ? data.definitions : [];
          const allRefs = Array.isArray(data?.references) ? data.references : [];
          const clickedKind = (outlineRef.current.symbols || []).find((symbol) => symbol.name === query)?.kind
            || allDefs[0]?.kind
            || '';

          if (kind === 'defs') {
            const kindSet = sameKindSet(clickedKind);
            const picked = kindSet === null
              ? allDefs
              : allDefs.filter((item) => kindSet.has(String(item.kind || '').toLowerCase()));
            const usable = picked.length > 0 ? picked : allDefs;
            const ordered = orderDefinitions(usable);
            const dropped = allDefs.length - usable.length;
            const hits = await fillHitText(ordered.map((item) => toDefinitionHit(item, query)));
            if (hits.length === 1 && !keep) {
              closeResultWindow();
              await openFileAtRef.current?.(hits[0].file, hits[0].line);
              flashStatus(`${query}：定义在 ${hits[0].file}:${hits[0].line}，已跳过去`);
              return;
            }
            if (hits.length === 0 && !keep) {
              closeResultWindow();
              flashHint(`没有找到 ${query} 的定义`);
              return;
            }
            const label = hits.length > 0 ? definitionLabel({ kind: clickedKind }) : '';
            const title = [
              label || '',
              dropped > 0 ? `另有 ${dropped} 条同名定义类型不同未列出` : '',
            ].filter(Boolean).join(' · ');
            fillResultWindow({ title, kind: 'defs', word: query, scope: '', hits });
            if (hits.length > 0) void loadResultPreview(hits[0]);
            return;
          }

          /* callers: flat reference list, grouped by nothing — the original
             keeps it flat and puts the caller function name at the row head. */
          const refs = allRefs;
          if (kind === 'callers' && refs.length > 0) {
            if (refs.length === 1 && !keep) {
              closeResultWindow();
              await openFileAtRef.current?.(refs[0].file, refs[0].line);
              flashStatus(`${query}：只有一处调用（${refs[0].file}:${refs[0].line}），已跳过去`);
              return;
            }
            const groups = new Map();
            for (const item of refs) {
              const fn = String(item.fn || '').trim() || '(文件作用域)';
              const list = groups.get(fn) || [];
              list.push({ file: item.file, line: item.line, column: item.column, fn });
              groups.set(fn, list);
            }
            const callers = [...groups.entries()]
              .map(([fn, sites]) => ({ fn, count: sites.length, sites: sites.slice(0, 120) }))
              .sort((a, b) => b.count - a.count);
            fillResultWindow({
              title: `${query} 的调用层级 · ${callers.length} 个调用者`,
              kind: 'callers',
              word: query,
              scope: '',
              hits: [],
              tree: { name: query, total: refs.length, callers },
            });
            const firstSite = callers[0]?.sites[0];
            if (firstSite) void loadResultPreview({ ...firstSite, word: query });
            return;
          }
          const hits = await fillHitText(refs.map((item) => toReferenceHit(item, query)));
          if (hits.length === 1 && !keep) {
            closeResultWindow();
            await openFileAtRef.current?.(hits[0].file, hits[0].line);
            flashStatus(`${query}：只有一处引用（${hits[0].file}:${hits[0].line}），已跳过去`);
            return;
          }
          if (hits.length === 0 && !keep) {
            closeResultWindow();
            flashHint(`\`${query}\`：没有找到引用`);
            return;
          }
          const first = allDefs[0];
          const title = [
            first ? definitionLabel(first) : '',
            first ? `定义于 ${first.file}:${first.line}` : '',
            summariseRefs(refs, ['call']),
          ].filter(Boolean).join(' · ');
          fillResultWindow({ title, kind: 'callers', word: query, scope: '', hits });
          if (hits.length > 0) void loadResultPreview(hits[0]);
        } catch (error) {
          setResultWin((previous) => (previous ? {
            ...previous, loading: false, error: errorText(error, tRef.current),
          } : previous));
        }
      }, [fillHitText, loadResultPreview, toDefinitionHit, toReferenceHit, flashHint, flashStatus, closeResultWindow]);

      /* Query rerun from the window: same kind, same scope for 查找. */
      const rerunResult = useCallback((kind, word, scope) => {
        if (kind === 'defs' || kind === 'callers' || kind === 'callees') {
          void runSymbolResult(kind === 'callees' ? 'callers' : kind, word, { keepWindow: true });
          return;
        }
        void runFind(scope || resultQueryRef.current.scope || 'idx', word);
      }, [runFind, runSymbolResult]);

      /* F4 / Shift+F4: step through the open result window (or the context
         window's list when no result window is open). */
      const stepResult = useCallback((delta) => {
        const win = resultWinRef.current;
        if (win !== null) {
          const hits = Array.isArray(win.hits) ? win.hits : [];
          if (hits.length === 0) return;
          let index = win.selected < 0
            ? (delta > 0 ? 0 : hits.length - 1)
            : win.selected + delta;
          index = Math.max(0, Math.min(index, hits.length - 1));
          setResultWin((previous) => (previous ? { ...previous, selected: index } : previous));
          void loadResultPreview(hits[index]);
          window.requestAnimationFrame(() => {
            const row = document.querySelector('.sl-result-window .sl-rw-row.active');
            if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
          });
          flashStatus(`${index + 1}/${hits.length} · ${hits[index].file}:${hits[index].line}`);
          return;
        }
        const current = resultsRef.current;
        if (current === null) {
          flashHint('没有查找结果');
          return;
        }
        const items = [...(current.items || []), ...(current.refs || [])].filter((item) => item?.file);
        if (items.length === 0) return;
        let index = resultStepRef.current;
        if (index < 0) index = delta > 0 ? -1 : items.length;
        index = (index + delta + items.length) % items.length;
        resultStepRef.current = index;
        const item = items[index];
        setContextOpen(true);
        setContextCollapsed(false);
        void previewResult(item);
        void openFileAtRef.current?.(item.file, item.line);
        flashStatus(`${index + 1}/${items.length} · ${item.file}:${item.line}`);
      }, [flashHint, flashStatus, previewResult, loadResultPreview]);

      const searchCode = useCallback(async (query) => {
        const needle = String(query || '').trim();
        if (needle === '') return;
        await runFind('idx', needle);
      }, [runFind]);

      searchCodeRef.current = searchCode;

      const openCounterpart = useCallback(async () => {
        const current = activeRef.current;
        if (current === '') return;
        const match = /^(.*)\.(c|h|cc|cpp|hpp|hh)$/i.exec(current);
        if (!match) {
          setNotice({ kind: 'warn', text: '当前文件没有可对应的 .c/.h 文件。' });
          return;
        }
        const base = match[1];
        const ext = match[2].toLowerCase();
        const want = ext === 'c' || ext === 'cc' || ext === 'cpp'
          ? ['h', 'hpp', 'hh']
          : ['c', 'cc', 'cpp'];
        try {
          const data = await api(`/files?q=${encodeURIComponent(base.split('/').pop())}&limit=100`, undefined, sessionRef.current);
          const rows = Array.isArray(data?.rows) ? data.rows : [];
          const target = rows.find((row) => {
            const rel = String(row.rel || '');
            if (rel === current) return false;
            if (rel.replace(/\.[^.]+$/u, '').toLowerCase() !== base.toLowerCase()) return false;
            return want.includes((/\.[^.]+$/u.exec(rel)?.[0] || '').slice(1).toLowerCase());
          });
          if (!target) {
            setNotice({ kind: 'warn', text: '没有找到对应的 .c/.h 文件。' });
            return;
          }
          await openFileAt(target.rel, 1);
        } catch (error) {
          setNotice({ kind: 'error', text: errorText(error, tRef.current) });
        }
      }, [openFileAt]);

      const gotoDefinition = useCallback(async (name, at) => {
        const word = String(name || '').trim();
        if (word === '' || activeRef.current === '') return;
        await runSymbolResult('defs', word, at || {});
      }, [runSymbolResult]);

      const findReferences = useCallback(async (name, at) => {
        const word = String(name || '').trim();
        if (word === '' || activeRef.current === '') return;
        await runSymbolResult('callers', word, at || {});
      }, [runSymbolResult]);

      const showContext = useCallback(async (name, at) => {
        const word = String(name || '').trim();
        if (word === '' || activeRef.current === '') return;
        /* 普通左键每次都会触发这里；两次点击的词不同时，旧请求后返回会把新词
           的定义/引用写进底部窗（标题是新词、内容却是旧词）。只认最新一次。 */
        const seq = ++contextSeqRef.current;
        const stale = () => seq !== contextSeqRef.current;
        const active = activeRef.current;
        const line = Number(at?.line) || cursorRef.current.line;
        const column = Number(at?.column) || cursorRef.current.column;
        const cacheKey = `${word}\u0000${active}\u0000${line}\u0000${column}`;
        const tab = tabsRef.current.find((item) => item.path === active);
        /* Replay a recent panel instantly (the original keeps 20). Only clean
           buffers qualify: index line numbers describe the file on disk. */
        if (tab && !tab.dirty) {
          const cached = contextCacheRef.current.get(cacheKey);
          if (cached) {
            showResults(cached.results);
            if (cached.preview) void previewResult(cached.preview);
            return;
          }
        }
        const remember = (payload, previewItem) => {
          if (!tab || tab.dirty) return;
          contextCacheRef.current.set(cacheKey, { results: payload, preview: previewItem });
          if (contextCacheRef.current.size > 20) {
            const first = contextCacheRef.current.keys().next().value;
            if (first !== undefined) contextCacheRef.current.delete(first);
          }
        };
        const model = adapterRef.current?.raw.getModel();
        const lineText = model?.getLineContent(line) ?? '';
        const langId = languageOfPath(active);
        const includeMatch = (langId === 'c' || langId === 'cpp')
          ? /#\s*include\s*[<"]([^>"]+)[>"]/u.exec(lineText)
          : null;

        /* `#include <...>` 里的头文件名不是符号：直接给头文件，不查定义。 */
        if (includeMatch !== null && String(includeMatch[1]).includes(word) && word !== '') {
          const header = includeMatch[1];
          let headerRel = '';
          try {
            const files = await api(`/files?q=${encodeURIComponent(header)}&limit=120`, undefined, sessionRef.current);
            if (stale()) return;
            const rows = Array.isArray(files?.rows) ? files.rows : [];
            const hit = rows.find((row) => String(row.rel || '') === header)
              ?? rows.find((row) => String(row.rel || '').endsWith(`/${header}`))
              ?? rows.find((row) => baseName(String(row.rel || '')) === baseName(header));
            if (hit) headerRel = hit.rel;
          } catch { /* 没有文件路由时仍然显示头文件名 */ }
          const payload = {
            title: `#include ${header}`,
            word,
            kind: 'context',
            items: headerRel ? [{ file: headerRel, line: 1, name: word, kind: 'include' }] : [],
            refs: [],
            note: headerRel ? `头文件 ${headerRel}` : `项目里没有找到 ${header}`,
            preview: headerRel ? { file: headerRel, line: 1 } : { file: active, line },
          };
          showResults(payload);
          remember(payload, payload.preview);
          return;
        }

        const showNotice = (title, note) => {
          const payload = {
            title: `${word} · ${title}`,
            word,
            kind: 'context',
            items: [],
            refs: [],
            note,
            preview: { file: active, line },
          };
          showResults(payload);
          remember(payload, { file: active, line });
        };
        const directiveMatch = (langId === 'c' || langId === 'cpp')
          ? /^\s*#\s*([A-Za-z_]\w*)/u.exec(lineText)
          : null;
        const lexical = includeMatch === null
          ? lexicalKindAt(model?.getValue() ?? '', line, column, langId)
          : 'code';
        if (lexical === 'comment' || lexical === 'string') {
          showNotice(lexical === 'comment' ? '注释' : '字符串', lexical === 'comment' ? '注释' : '字符串');
          return;
        }
        /* C 标签（`failure:` / `goto failure;`）不是普通符号；定义区只报“标签 failure”。 */
        const labelAtLine = /^\s*([A-Za-z_]\w*)\s*:/u.exec(lineText);
        const labelAtGoto = /\bgoto\s+([A-Za-z_]\w*)/u.exec(lineText);
        if ((langId === 'c' || langId === 'cpp')
          && ((labelAtLine && labelAtLine[1] === word) || (labelAtGoto && labelAtGoto[1] === word))) {
          showNotice('标签', `标签 ${word}`);
          return;
        }
        /* 以数字开头就按数字字面量处理，简单可靠。 */
        if (/^\d/u.test(word)) {
          showNotice('数字', `数字 ${word}`);
          return;
        }
        if (directiveMatch !== null && directiveMatch[1] === word) {
          showNotice('预处理', '预处理');
          return;
        }
        if (C_LANGUAGE_KEYWORDS.has(word)) {
          showNotice('C 关键字', 'C 关键字');
          return;
        }
        if (langId !== 'c' && langId !== 'cpp' && LANG_KEYWORDS[langId]?.has(word)) {
          showNotice(`${LANG_LABEL[langId] || langId} 关键字`,
            `${LANG_LABEL[langId] || langId} 关键字`);
          return;
        }
        /* `x->field` / `x.field`: say "member not resolved" instead of pretending
           the symbol does not exist. */
        const memberAccess = word !== ''
          && new RegExp(`(->|\\.)\\s*${escapeRegExp(word)}\\b`, 'u').test(lineText);
        try {
          /* 先取“定义”（Host 会先做当前文件的局部声明，几十毫秒），再按定义类型
             取引用：局部变量只扫当前文件的文本，全局函数才走整库索引。 */
          const defData = await api(`/definition?name=${encodeURIComponent(word)}&path=${encodeURIComponent(active)}&line=${line}&column=${column}`, undefined, sessionRef.current);
          if (stale()) return;
          if (defData?.status === 'unresolved') {
            showNotice('未解析', '未解析');
            return;
          }
          /* 编译器内建 / C 标准库（`__func__` / `__LINE__`…）：源码里没有定义，
             但它不是"外部符号"，也不是解析失败 —— 给一句说明就行（2026-11-16）。 */
          if (defData?.status === 'builtin') {
            const payload = {
              title: `${word} · 编译器内建`,
              word,
              kind: 'context',
              items: [],
              refs: [],
              note: defData.note || '由编译器或 C 标准库提供,源码树里没有定义',
              preview: { file: active, line },
            };
            showResults(payload);
            remember(payload, { file: active, line });
            return;
          }
          /* 宏体形参 / `##` 拼接片段：标准 C 预处理语义，源码里本来就不是符号。 */
          if (defData?.status === 'macroParam') {
            const payload = {
              title: `${word} · 宏参数`,
              word,
              kind: 'context',
              items: [],
              refs: [],
              note: defData.note || '宏体里的形参 / 拼接片段,不是符号',
              preview: { file: active, line },
            };
            showResults(payload);
            remember(payload, { file: active, line });
            return;
          }
          /* 函数原型形参：原型不定义形参,实现在函数体里 —— 能给就跳到函数定义。 */
          if (defData?.status === 'protoParam') {
            const items = Array.isArray(defData.items) ? defData.items : [];
            const payload = {
              title: `${word} · 函数原型形参`,
              word,
              kind: 'context',
              items,
              refs: [],
              note: defData.note || '原型里的形参,定义在函数实现里',
              preview: items[0] ? { file: items[0].file, line: items[0].line } : { file: active, line },
            };
            showResults(payload);
            remember(payload, payload.preview);
            return;
          }
          const definitions = Array.isArray(defData?.definitions) ? defData.definitions : [];
          const localKinds = new Set(['variable', 'parameter', 'member', 'field', 'enum_member']);
          const localDef = definitions.find((item) => item && (item.scope === 'local'
            || (!item.scope && item.file === active
              && localKinds.has(String(item.kind || '').toLowerCase()))));
          const fileScoped = !localDef && definitions.some((item) => item && item.scope === 'file');
          const clickedKind = String(localDef?.kind || definitions[0]?.kind || '').toLowerCase();
          const memberDef = definitions.find((item) => item && item.parent
            && (String(item.kind || '').toLowerCase() === 'member'
              || String(item.kind || '').toLowerCase() === 'enum_member'));
          let refQuery = `/references?name=${encodeURIComponent(word)}&path=${encodeURIComponent(active)}&limit=400&kind=${encodeURIComponent(clickedKind)}${memberDef ? `&parent=${encodeURIComponent(memberDef.parent)}` : ''}`;
          if (localDef) {
            refQuery += `&fileOnly=1&localText=1&line=${line}`
              + (localDef.parent ? `&fn=${encodeURIComponent(localDef.parent)}` : '');
          } else if (fileScoped) {
            refQuery += `&fileOnly=1&localText=1&line=${line}`;
          }
          const refData = await api(refQuery, undefined, sessionRef.current).catch(() => null);
          if (stale()) return;
          const references = Array.isArray(refData?.references) ? refData.references : [];
          /* Keyword / qualifier: one sentence, no definition list. */
          if (KEYWORD_NOTES[word] !== undefined && includeMatch === null) {
            const payload = {
              title: `${word} · 关键字`,
              word,
              kind: 'context',
              items: [],
              refs: [],
              note: '关键字',
              preview: { file: active, line },
            };
            showResults(payload);
            remember(payload, { file: active, line });
            return;
          }

          const noIndex = defData?.needsIndex === true;
          /* Compile switch (CONFIG_*): the useful answer is "is it on here,
             and where is it declared". */
          if (/^CONFIG_[A-Za-z0-9_]+$/u.test(word)) {
            try {
              const [valueData, decl] = await Promise.all([
                api(`/config-value?name=${encodeURIComponent(word)}&path=${encodeURIComponent(active)}`, undefined, sessionRef.current),
                api(`/kconfig?name=${encodeURIComponent(word)}&path=${encodeURIComponent(active)}`, undefined, sessionRef.current).catch(() => null),
              ]);
              const parts = [`编译开关 ${word}`];
              if (valueData?.hasL2 !== true) parts.push('没有 .config / compile_commands.json，无法判定');
              else if (valueData?.attached !== true) parts.push('没有可判定的配置');
              else if (valueData?.known !== true) parts.push('配置里没有显式设置（可能是默认值）');
              else parts.push(`当前值 ${valueData?.value === null ? '未设置' : String(valueData.value)}`);
              if (valueData?.enabled === true) parts.push('当前代码会编译');
              else if (valueData?.enabled === false) parts.push('当前代码不编译');
              if (decl?.file) parts.push(`声明 ${decl.file}:${decl.line}`);
              const items = decl?.file
                ? [{ file: decl.file, line: decl.line, kind: 'macro', name: word, text: decl.text ?? '' }]
                : [];
              const payload = {
                title: `${word} · 编译开关`,
                word,
                kind: 'context',
                items,
                refs: references.map((reference) => ({ ...reference, name: word })),
                note: parts.join(' · '),
                preview: items.length === 0 ? { file: active, line } : undefined,
              };
              showResults(payload);
              remember(payload, items[0] ?? { file: active, line });
              return;
            } catch {
              /* fall through to the ordinary context panel */
            }
          }
          /* `#include` target: resolve the header against the project. */
          let note = '';
          let extra = [];
          if (includeMatch !== null && lineText.includes(word)) {
            const header = includeMatch[1];
            note = `#include ${header}`;
            try {
              const files = await api(`/files?q=${encodeURIComponent(header)}&limit=120`, undefined, sessionRef.current);
              const rows = Array.isArray(files?.rows) ? files.rows : [];
              const hit = rows.find((row) => String(row.rel || '') === header)
                ?? rows.find((row) => String(row.rel || '').endsWith(`/${header}`))
                ?? rows.find((row) => baseName(String(row.rel || '')) === baseName(header));
              if (hit) {
                extra = [{ file: hit.rel, line: 1, kind: 'include', name: word }];
                note += ` · 项目里已找到 ${hit.rel}`;
              } else {
                note += ' · 项目里没有找到这个头文件';
              }
            } catch { /* keep the plain include note */ }
          }
          if (definitions.length === 0 && references.length === 0 && extra.length === 0) {
            const payload = {
              title: `${word} 的上下文`,
              word,
              kind: 'context',
              items: [],
              refs: [],
              note: note !== '' ? note : '未找到',
              preview: { file: active, line },
            };
            showResults(payload);
            remember(payload, { file: active, line });
            return;
          }
          const payload = {
            title: `${word} 的上下文`,
            word,
            kind: 'context',
            items: [...extra, ...definitions.map((definition) => ({ ...definition, name: word }))],
            refs: references.map((reference) => ({ ...reference, name: word })),
            note,
            preview: definitions.length === 0 && extra.length === 0 ? { file: active, line } : undefined,
          };
          showResults(payload);
          remember(payload, definitions[0] ?? extra[0] ?? { file: active, line });
        } catch (error) {
          setNotice({ kind: 'error', text: errorText(error, tRef.current) });
        }
      }, [showResults, previewResult]);

      const highlightWord = useCallback((name) => {
        const word = String(name || '').trim();
        const adapter = adapterRef.current;
        if (word === '' || !adapter) return;
        try {
          const model = adapter.raw.getModel();
          if (!model) return;
          const matches = model.findMatches(word, false, false, false, null, false, 500);
          adapter.highlightMatches(matches.map((match) => ({
            start: { line: match.range.startLineNumber, column: match.range.startColumn },
            end: { line: match.range.endLineNumber, column: match.range.endColumn },
          })));
        } catch { /* editor is rebuilding */ }
      }, []);

      /* AI 面板已下线：所有 AI 动作统一改成“把提示词发给当前 DSH 会话”，由 DSH
         小窗（C 模式）回答。插件不再自己弹框、不再存 API Key，也不再调本地模型。 */
      const promptToDsh = useCallback(async (text) => {
        const payload = String(text ?? '').trim();
        if (payload === '') {
          flashHint('没有可发送的内容');
          return false;
        }
        const sessions = ctx.get('sessions');
        if (!sessions || typeof sessions.using !== 'function' || !sessionId) {
          try {
            await navigator.clipboard?.writeText(payload);
            setNotice({ kind: 'warn', text: '没有可用的 DSH 会话：提示词已复制，粘贴到 DSH 里发送。' });
          } catch {
            setNotice({ kind: 'error', text: '没有可用的 DSH 会话，复制也失败了。' });
          }
          return false;
        }
        try {
          await sessions.using(sessionId, { source: 'gateway' }, async (reference) => {
            const binding = await reference.ready;
            const result = await binding.session.prompt([{ type: 'text', text: payload }], 'queue');
            if (result && result.ok === false) {
              throw new Error(result.error?.message ?? 'prompt rejected');
            }
          });
          setMode('C');
          setNotice({ kind: 'success', text: '已发送到 DSH，回答在右侧 DSH 面板里。' });
          return true;
        } catch (error) {
          setNotice({ kind: 'error', text: `发送到 DSH 失败：${errorText(error, tRef.current)}` });
          return false;
        }
      }, [ctx, sessionId, flashHint]);

      const openAi = useCallback((kind, word) => {
        const adapter = adapterRef.current;
        const model = adapter?.raw.getModel();
        const line = cursor.line;
        const selected = adapter?.getSelection?.()?.text ?? '';
        const lineText = model?.getLineContent(line) ?? '';
        const code = selected !== '' ? selected : lineText;
        const where = `${activeRef.current}:${line}`;
        const head = word ? `符号 \`${word}\`。` : '';
        const ask = kind === 'risk'
          ? '请指出这段代码真正的风险点：边界条件、错误处理、并发/竞态、资源释放、整数溢出、越界；按严重程度排序，只讲有问题的地方。'
          : kind === 'bugs'
            ? '请以找 bug 为目标审阅这段代码：空指针、越界、整数溢出/截断、未初始化、资源泄漏、错误路径、并发竞态；每条给位置、原因和改法。'
            : kind === 'flow'
              ? '请按执行顺序讲清这段代码的完整流程：输入、关键步骤、判断、输出；不要逐行翻译。'
              : kind === 'usage'
                ? '说明这个符号的用途：它在系统里的角色、生命周期、典型用法和常见坑；不要复述代码。'
                : kind === 'macro'
                  ? '请解释这个宏的展开语义：它展开成什么、参数如何代入、有哪些隐含依赖和分支。'
                  : kind === 'callers'
                    ? '请梳理调用关系：谁调用它、它又调用了谁；只列代码里能确认的调用点。'
                    : kind === 'file'
                      ? '请给这个文件写一段导读：它负责什么、关键数据结构和入口函数、建议的阅读顺序。'
                      : kind === 'comment'
                        ? '给选中的代码加一段简洁的中文注释，输出可直接粘贴的注释文本。'
                        : '请解释这段代码的逻辑：作用、关键步骤，以及读它时容易忽略的细节。';
        /* 不再打开插件内的 AI 面板：直接把这段上下文交给 DSH。 */
        void promptToDsh(`${head}${ask}\n\n上下文：${where}\n\`\`\`c\n${code}\n\`\`\`\n`);
      }, [cursor.line, promptToDsh]);

      openAiRef.current = openAi;

      const copyAiText = useCallback(async () => {
        try {
          await navigator.clipboard?.writeText(aiText);
          setNotice({ kind: 'success', text: '提示词已复制；到 DSH 对话里粘贴发送。' });
        } catch {
          setNotice({ kind: 'error', text: '复制失败，请手动选择文本框内容。' });
        }
      }, [aiText]);

      const sendAiToDsh = useCallback(async () => {
        const sessions = ctx.get('sessions');
        if (!sessions || !sessionId) {
          await copyAiText();
          return;
        }
        try {
          await sessions.using(sessionId, { source: 'gateway' }, async (reference) => {
            const binding = await reference.ready;
            const result = await binding.session.prompt([{ type: 'text', text: aiText }], 'queue');
            if (result && result.ok === false) {
              throw new Error(result.error?.message ?? 'prompt rejected');
            }
          });
          setNotice({ kind: 'success', text: '提示词已发送到当前 DSH 会话。' });
          setAiOpen(false);
          setMode('C');
        } catch (error) {
          setNotice({ kind: 'error', text: `发送失败：${errorText(error, tRef.current)}` });
        }
      }, [aiText, sessionId, ctx, copyAiText]);
      /* ------------------------------------------------------------- AI panel */



      const aiModelsKeyRef = useRef('');

      /* Original prompt library (actions.js PROMPTS), ported as a picker that
         fills the prompt box with the ask plus the code at the caret. */
      const applyAiPrompt = useCallback((id) => {
        const item = AI_PROMPT_LIBRARY.find((entry) => entry.id === id);
        if (!item) return;
        const adapter = adapterRef.current;
        const model = adapter?.raw.getModel();
        const selection = adapter?.getSelection?.()?.text ?? '';
        let code = selection;
        if (code === '' && model) {
          const line = Math.max(1, cursorRef.current.line);
          const from = Math.max(1, line - 8);
          const to = Math.min(model.getLineCount(), line + 8);
          const lines = [];
          for (let index = from; index <= to; index += 1) lines.push(model.getLineContent(index));
          code = lines.join('\n');
        }
        void promptToDsh(`${item.ask}\n\n位置：${activeRef.current}:${cursorRef.current.line}\n\`\`\`c\n${code}\n\`\`\`\n`);
      }, [promptToDsh]);
      const switchAiProvider = useCallback((provider) => {
        const next = provider === 'remote' ? 'remote' : 'local';
        setAiConfig((previous) => ({
          ...previous,
          provider: next,
          baseUrl: AI_DEFAULTS[next].baseUrl,
          model: AI_DEFAULTS[next].model,
        }));
      }, []);

      const refreshAiModels = useCallback(async (announce = false) => {
        const key = `${aiConfig.baseUrl}|${aiConfig.apiKey}`;
        if (announce !== true && aiModelsKeyRef.current === key) return;
        aiModelsKeyRef.current = key;
        try {
          const data = await api(
            `/ai/models?baseUrl=${encodeURIComponent(aiConfig.baseUrl)}&apiKey=${encodeURIComponent(aiConfig.apiKey)}`,
            undefined,
            sessionRef.current,
          );
          const list = Array.isArray(data?.models) ? data.models : [];
          setAiModels(list);
          if (announce === true) {
            flashStatus(list.length > 0 ? `可用模型 ${list.length} 个 —— 点模型框切换` : '这个端点没有返回模型列表', 'success');
          }
        } catch (error) {
          aiModelsKeyRef.current = '';
          if (announce === true) flashStatus(`读取模型列表失败：${errorText(error, tRef.current)}`, 'error');
        }
      }, [aiConfig.baseUrl, aiConfig.apiKey, flashStatus]);

      useEffect(() => {
        if (!aiOpen) return;
        void refreshAiModels(false);
      }, [aiOpen, refreshAiModels]);

      /** Build the user message: the typed prompt plus the code at the caret
       *  when the prompt does not already carry a fenced block. */
      const aiPromptWithContext = useCallback((prompt) => {
        const text = String(prompt || '').trim();
        if (text === '' || text.includes('```')) return text;
        const adapter = adapterRef.current;
        const model = adapter?.raw.getModel();
        if (!model) return text;
        const selection = adapter?.getSelection?.()?.text ?? '';
        let code = selection;
        if (code === '') {
          const line = Math.max(1, cursorRef.current.line);
          const from = Math.max(1, line - 8);
          const to = Math.min(model.getLineCount(), line + 8);
          const lines = [];
          for (let index = from; index <= to; index += 1) lines.push(model.getLineContent(index));
          code = lines.join('\n');
        }
        return `${text}\n\n上下文：${activeRef.current}:${cursorRef.current.line}\n\`\`\`c\n${code}\n\`\`\`\n`;
      }, []);

      const askAi = useCallback(async (promptOverride) => {
        if (aiBusy) return;
        const prompt = aiPromptWithContext(promptOverride ?? aiText);
        if (prompt === '') {
          flashHint('先写一点要问的内容');
          return;
        }
        const history = aiLog
          .filter((entry) => entry.role === 'user' || entry.role === 'ai')
          .slice(-8)
          .map((entry) => ({ role: entry.role === 'ai' ? 'assistant' : 'user', content: entry.text }));
        setAiLog((previous) => [...previous, { role: 'user', text: prompt, at: Date.now() }].slice(-40));
        setAiBusy(true);
        try {
          const data = await api('/ai/chat', {
            method: 'POST',
            body: JSON.stringify({
              baseUrl: aiConfig.baseUrl,
              apiKey: aiConfig.apiKey,
              model: aiConfig.model,
              messages: [...history, { role: 'user', content: prompt }],
            }),
          }, sessionRef.current);
          if (data?.ok !== true) throw new Error(data?.error || '请求失败');
          setAiLog((previous) => [...previous, {
            role: 'ai',
            text: String(data.content || ''),
            model: String(data.model || aiConfig.model || ''),
            at: Date.now(),
          }].slice(-40));
        } catch (error) {
          const reason = error?.data?.error || errorText(error, tRef.current);
          setAiLog((previous) => [...previous, { role: 'error', text: reason, at: Date.now() }].slice(-40));
        } finally {
          setAiBusy(false);
        }
      }, [aiBusy, aiText, aiLog, aiConfig, aiPromptWithContext, flashHint]);
      const askAiRaw = useCallback(async (prompt) => {
        const sent = await promptToDsh(String(prompt));
        if (!sent) throw new Error('没有发送到 DSH');
        return '';
      }, [promptToDsh]);

      const closeAiEdit = useCallback(() => {
        const zone = aiZoneRef.current;
        aiZoneRef.current = null;
        if (!zone) return;
        try { zone.cleanup?.(); } catch { /* listener already gone */ }
        try { adapterRef.current?.removeViewZone?.(zone.zoneId); } catch { /* editor gone */ }
        try { zone.node.remove(); } catch { /* already detached */ }
      }, []);

      const buildAiEditPrompt = useCallback((requestText, line) => {
        const model = adapterRef.current?.raw.getModel();
        const rel = activeRef.current;
        const symbols = outlineRef.current.symbols || [];
        const fn = symbols
          .filter((symbol) => String(symbol.kind || '').toLowerCase() === 'function' && Number(symbol.line) <= line)
          .sort((a, b) => Number(b.line) - Number(a.line))[0];
        const nearby = symbols
          .filter((symbol) => Math.abs(Number(symbol.line) - line) <= 30)
          .slice(0, 14)
          .map((symbol) => `${symbol.kind || '?'} ${symbol.name}:${symbol.line}`)
          .join('，');
        const anchor = model ? model.getLineContent(line) : '';
        const following = [];
        if (model) {
          for (let index = line + 1; index <= Math.min(model.getLineCount(), line + 8); index += 1) {
            following.push(model.getLineContent(index));
          }
        }
        return `你在帮我写代码。文件：${rel}，插入位置：第 ${line} 行之后${fn ? `（函数 ${fn.name} 内）` : ''}。
只输出要插入的代码：不要 markdown 围栏，不要解释，不要重复我给出的代码；缩进与周围一致，注释风格与文件一致。
附近符号：${nearby || '（无）'}
插入点这一行：${anchor}
之后最多 8 行：
${following.join('\n')}
我的要求：${requestText}`;
      }, []);

      const openAiEditAt = useCallback((position) => {
        const adapter = adapterRef.current;
        const model = adapter?.raw.getModel();
        if (!adapter || !model || !position) return;
        const line = Number(position.lineNumber ?? position.line) || cursorRef.current.line;
        const column = Number(position.column) || 1;
        const lineText = model.getLineContent(line);
        if (lineText.slice(column - 1).trim() !== '') {
          flashHint('请在行尾空白处双击（想插到行中间，先自己回车）');
          return;
        }
        closeAiEdit();
        const make = (tag, className, text) => {
          const element = document.createElement(tag);
          if (className) element.className = className;
          if (text !== undefined) element.textContent = text;
          return element;
        };
        const node = make('div', 'sl-ai-zone');

        const inline = make('div', 'sl-ai-zone-inline');
        inline.append(make('span', 'sl-ai-zone-tag', `第 ${line} 行 · AI`));
        const request = make('input', 'sl-ai-zone-input');
        request.type = 'text';
        request.placeholder = '描述需求，回车发送到 DSH · Esc 取消';
        request.spellcheck = false;
        const generate = make('button', 'sl-btn primary', '生成');
        generate.type = 'button';
        const cancel = make('button', 'sl-btn', '取消');
        cancel.type = 'button';
        inline.append(request, generate, cancel);
        const status = make('div', 'sl-ai-zone-status', '');
        status.style.display = 'none';
        const answer = make('textarea', 'sl-ai-zone-answer');
        answer.spellcheck = false;
        answer.style.display = 'none';
        const insertRow = make('div', 'sl-ai-zone-row');
        insertRow.style.display = 'none';
        const insert = make('button', 'sl-btn primary', '插入');
        insert.type = 'button';
        const regenerate = make('button', 'sl-btn', '重新生成');
        regenerate.type = 'button';
        insertRow.append(insert, regenerate);
        const note = make('div', 'sl-ai-zone-note', 'Esc 撤销 · 插入前不会改动文档');
        note.style.display = 'none';
        node.append(inline, status, answer, insertRow, note);

        const zone = { zoneId: null, node, line, request, answer, status, generate };
        aiZoneRef.current = zone;
        /* 空输入时点外面自动收起；已经有内容则保留（原版行为）。 */
        const onDocDown = (event) => {
          const current = aiZoneRef.current;
          if (!current || current !== zone) return;
          if (zone.node.contains(event.target)) return;
          if (zone.request.value.trim() === '') closeAiEdit();
        };
        document.addEventListener('pointerdown', onDocDown, true);
        zone.cleanup = () => document.removeEventListener('pointerdown', onDocDown, true);
        const resize = (height) => {
          try {
            if (zone.zoneId) adapter.removeViewZone(zone.zoneId);
            zone.zoneId = adapter.addViewZone(line, height, node);
          } catch { /* editor disposed */ }
        };
        resize(38);
        /* The view zone spans Monaco's full layout width, which in mode C runs
           under the DSH child window. Monaco positions the zone on the next
           frame, so measure then and clamp to the visible strip; otherwise
           生成/取消 end up under the child window. */
        const clampZone = () => {
          try {
            const nodeRect = node.getBoundingClientRect();
            if (nodeRect.left <= 0 || nodeRect.width <= 0) return;
            const rootRect = document.getElementById('root')?.getBoundingClientRect();
            const limit = mode === 'C' && rootRect && rootRect.left > nodeRect.left + 40
              ? rootRect.left
              : window.innerWidth;
            const width = Math.max(240, Math.round(limit - nodeRect.left - 26));
            node.style.width = `${width}px`;
          } catch { /* layout not ready */ }
        };
        window.requestAnimationFrame(() => window.requestAnimationFrame(clampZone));


        cancel.addEventListener('click', () => closeAiEdit());
        request.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            closeAiEdit();
          } else if (event.key === 'Enter') {
            event.preventDefault();
            void run();
          }
        });
        answer.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            closeAiEdit();
          }
        });
        generate.addEventListener('click', () => void run());
        regenerate.addEventListener('click', () => void run());
        insert.addEventListener('click', () => {
          const text = answer.value.replace(/\r\n/g, '\n');
          if (text.trim() === '') return;
          const baseIndent = (/^\s*/u.exec(model.getLineContent(line)) || [''])[0];
          const lines = text.split('\n').map((value) => (value.trim() === ''
            ? ''
            : (value.startsWith(baseIndent) ? value : baseIndent + value)));
          try {
            adapter.pushUndoStop?.();
            adapter.insertAt?.({ line: line + 1, column: 1 }, `${lines.join('\n')}\n`);
            adapter.markAiInserted?.(line + 1, lines.length);
          } catch (error) {
            status.textContent = `插入失败：${error?.message ?? error}`;
            status.style.display = '';
            return;
          }
          closeAiEdit();
          flashStatus(`已插入 ${lines.length} 行 —— 保存后底色消失`);
        });

        const run = async () => {
          const requestText = request.value.trim();
          if (requestText === '') {
            request.focus();
            return;
          }
          generate.disabled = true;
          regenerate.disabled = true;
          status.textContent = '正在发送到 DSH…';
          status.style.display = '';
          try {
            await askAiRaw(buildAiEditPrompt(requestText, line));
            /* 发送/生成期间用户可能按 Esc / 点外面 / 换文件：closeAiEdit 已经移除
               view zone 并把它从 aiZoneRef 摘掉，迟到的结果一律丢弃。 */
            if (aiZoneRef.current !== zone) return;
            /* 回答由 DSH 面板负责，插件这边收摊。 */
            closeAiEdit();
            flashStatus('已发送到 DSH，回答在右侧面板');
          } catch (error) {
            if (aiZoneRef.current !== zone) return;
            status.textContent = `发送失败：${error?.message ?? error}`;
            status.style.display = '';
          } finally {
            generate.disabled = false;
            regenerate.disabled = false;
          }
        };
        request.focus();
      }, [askAiRaw, buildAiEditPrompt, closeAiEdit, flashHint, flashStatus, mode, dshLeft]);
      openAiEditRef.current = openAiEditAt;



      useEffect(() => () => closeAiEdit(), [closeAiEdit]);
      useEffect(() => { closeAiEdit(); }, [activePath, monacoReload, closeAiEdit]);



      /* 我调用谁: local scan of the enclosing function body, same heuristic as
       * the original (it never claims to be a real call graph). */
      const findCallees = useCallback(() => {
        const adapter = adapterRef.current;
        const model = adapter?.raw.getModel();
        if (!model) return;
        const line = cursorRef.current.line;
        const symbols = outlineRef.current.symbols || [];
        const functions = symbols
          .filter((symbol) => String(symbol.kind || '').toLowerCase() === 'function' && Number(symbol.line) <= line)
          .sort((a, b) => Number(b.line) - Number(a.line));
        const self = functions[0];
        if (!self) {
          flashStatus('光标不在函数里', 'warn');
          return;
        }
        const next = symbols
          .filter((symbol) => String(symbol.kind || '').toLowerCase() === 'function' && Number(symbol.line) > Number(self.line))
          .sort((a, b) => Number(a.line) - Number(b.line))[0];
        const start = Number(self.line);
        const end = next ? Math.max(start, Number(next.line) - 1) : model.getLineCount();
        const skip = new Set(['if', 'for', 'while', 'switch', 'return', 'sizeof', 'catch', 'do', 'else', 'case', 'goto', 'defined', 'typeof', '__attribute__', 'alignof']);
        const items = [];
        const seen = new Set();
        for (let index = start; index <= end && items.length < 200; index += 1) {
          const text = model.getLineContent(index);
          const re = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/gu;
          let match;
          while ((match = re.exec(text)) !== null) {
            const name = match[1];
            if (skip.has(name) || name === self.name) continue;
            const key = `${name}:${index}`;
            if (seen.has(key)) continue;
            seen.add(key);
            items.push({ file: activeRef.current, line: index, column: match.index + 1, name, kind: 'call', text: text.trim() });
          }
        }
        if (items.length === 0) {
          flashStatus(`${self.name} 里没有扫描到明显的调用`, 'warn');
          return;
        }
        openResultWindow({
          title: `我调用谁 · ${self.name}`,
          kind: 'callees',
          word: self.name,
          scope: 'file',
          hits: items,
          loading: false,
          selected: 0,
        });
        void loadResultPreview(items[0]);
        flashStatus(`${self.name} 里扫描到 ${items.length} 处调用（本文件）`);
      }, [flashStatus, openResultWindow, loadResultPreview]);

      gotoDefinitionRef.current = gotoDefinition;
      findReferencesRef.current = findReferences;
      showContextRef.current = showContext;

      /* ---------------------------------------------------- status messages */


      const bumpFont = useCallback((delta) => {
        const next = clampFontSize(fontSizeRef.current + delta);
        if (next === fontSizeRef.current) return;
        setFontSizeState(next);
        flashHint(`字号 ${next}px`);
      }, [flashHint]);

      /* Ctrl+wheel zoom is handled by Monaco itself: a non-passive DOM wheel
         listener on the editor host makes every normal wheel tick wait for JS
         and is the main reason scrolling felt laggy. */
      useEffect(() => {
        if (monacoStatus !== 'ready') return undefined;
        const editor = adapterRef.current?.raw;
        if (!editor || typeof editor.onMouseWheel !== 'function') return undefined;
        const subscription = editor.onMouseWheel((event) => {
          const browser = event.browserEvent;
          if (!browser || (!browser.ctrlKey && !browser.metaKey)) return;
          event.preventDefault();
          const next = clampFontSize(fontSizeRef.current + (event.deltaY < 0 ? 0.5 : -0.5));
          if (next === fontSizeRef.current) return;
          setFontSizeState(next);
          flashHint(`字号 ${next}px`);
        });
        return () => {
          try { subscription?.dispose?.(); } catch { /* editor disposed */ }
        };
      }, [monacoStatus, flashHint]);
      const resetFont = useCallback(() => {
        setFontSizeState(FONT_DEFAULT);
        flashHint(`字号 ${FONT_DEFAULT}px`);
      }, [flashHint]);

      const toggleHighlight = useCallback((name) => {
        const adapter = adapterRef.current;
        const word = String(name || '').trim();
        if (!adapter) return;
        try {
          if (word === '' || highlightRef.current?.word === word) {
            adapter.highlightMatches([]);
            const previous = highlightRef.current?.word ?? '';
            setHighlight(null);
            if (previous !== '') flashStatus(`已取消高亮 ${previous}`);
            return;
          }
          const model = adapter.raw.getModel();
          if (!model) return;
          const matches = model.findMatches(`\\b${escapeRegExp(word)}\\b`, false, true, false, null, false, 3000);
          adapter.highlightMatches(matches.map((match) => ({
            start: { line: match.range.startLineNumber, column: match.range.startColumn },
            end: { line: match.range.endLineNumber, column: match.range.endColumn },
          })));
          setHighlight({ word, count: matches.length });
          flashStatus(`已标亮 ${word}: ${matches.length} 处（本文件）`);
        } catch {
          /* editor rebuilding */
        }
      }, [flashStatus]);

      const copyText = useCallback(async (text, message) => {
        try {
          await navigator.clipboard?.writeText(String(text ?? ''));
          flashStatus(message ?? `已复制 ${String(text ?? '').length} 字符`);
        } catch {
          flashStatus('复制失败', 'error');
        }
      }, [flashStatus]);

      const copyWithLocation = useCallback(async () => {
        const adapter = adapterRef.current;
        if (!adapter) return;
        const selection = adapter.getSelection?.() ?? null;
        const model = adapter.raw.getModel();
        const path = activeRef.current;
        const text = String(selection?.text ?? '');
        if (text !== '' && selection) {
          const start = selection.start?.line ?? 1;
          const end = selection.end?.line ?? start;
          const where = start === end ? `${path}:${start}` : `${path}:${start}-${end}`;
          await copyText(`${where}\n${text}`, '已复制（带位置）');
          return;
        }
        const line = cursorRef.current.line;
        const lineText = model?.getLineContent(line) ?? '';
        if (lineText === '') return;
        await copyText(`${path}:${line}\n${lineText}`, `已复制 ${path}:${line}`);
      }, [copyText]);

      const copySelectionOrLine = useCallback(async () => {
        const adapter = adapterRef.current;
        if (!adapter) return;
        const selection = adapter.getSelection?.() ?? null;
        const text = String(selection?.text ?? '');
        if (text !== '') {
          await copyText(text, `已复制 ${text.length} 字符`);
          return;
        }
        const model = adapter.raw.getModel();
        const lineText = model?.getLineContent(cursorRef.current.line) ?? '';
        if (lineText === '') {
          flashStatus('没有可复制的内容', 'warn');
          return;
        }
        await copyText(lineText, `已复制 ${lineText.length} 字符`);
      }, [copyText, flashStatus]);

      const convertNumber = useCallback((radix) => {
        const adapter = adapterRef.current;
        if (!adapter) return;
        const selection = adapter.getSelection?.() ?? null;
        const raw = String(selection?.text ?? '').trim();
        if (raw === '') {
          flashStatus('先选中一个数字', 'warn');
          return;
        }
        const value = radix === 16
          ? Number(raw)
          : (/^0x/iu.test(raw) ? Number.parseInt(raw, 16) : Number(raw));
        if (!Number.isFinite(value)) {
          flashStatus('选中的不是数字', 'warn');
          return;
        }
        const next = radix === 16 ? `0x${Math.trunc(value).toString(16).toUpperCase()}` : String(Math.trunc(value));
        try {
          adapter.replaceSelection(next);
          flashStatus(`已转成${radix === 16 ? '十六进制' : '十进制'} ${next}`);
        } catch {
          flashStatus('转换失败', 'error');
        }
      }, [flashStatus]);

      /* lineOverride：右键菜单要按“点中的那一行”算，而不是旧光标位置。 */
      const selectFunction = useCallback((lineOverride) => {
        const adapter = adapterRef.current;
        const model = adapter?.raw.getModel();
        if (!adapter || !model) return;
        const wanted = Number(lineOverride);
        const line = wanted > 0 ? Math.round(wanted) : cursorRef.current.line;
        const functions = (outlineRef.current.symbols || [])
          .filter((symbol) => String(symbol.kind || '').toLowerCase() === 'function' && Number(symbol.line) <= line)
          .sort((a, b) => Number(b.line) - Number(a.line));
        const start = Number(functions[0]?.line) || 0;
        if (start === 0) {
          flashStatus('光标不在函数里', 'warn');
          return;
        }
        /* 结束行靠**花括号配对**算，不再用"符号表里下一个函数 - 1"：
           相邻函数符号的行号不一定连续（符号表有顺序/噪声），曾退化成只选中
           签名 1 行。数括号只看文本，不受索引影响。 */
        const total = model.getLineCount();
        let depth = 0;
        let seen = false;
        let block = false;
        let end = total;
        for (let lineNo = start; lineNo <= total; lineNo += 1) {
          const text = model.getLineContent(lineNo);
          let stop = false;
          for (let i = 0; i < text.length; i += 1) {
            const ch = text[i];
            if (block) {
              if (ch === '*' && text[i + 1] === '/') { block = false; i += 1; }
              continue;
            }
            if (ch === '/' && text[i + 1] === '*') { block = true; i += 1; continue; }
            if (ch === '/' && text[i + 1] === '/') break;
            if (ch === '"' || ch === "'") {
              const quote = ch;
              i += 1;
              while (i < text.length) {
                if (text[i] === '\\') { i += 2; continue; }
                if (text[i] === quote) break;
                i += 1;
              }
              continue;
            }
            if (ch === '{') { depth += 1; seen = true; continue; }
            if (ch === '}') {
              depth -= 1;
              if (seen && depth === 0) { end = lineNo; stop = true; break; }
              if (depth < 0) { end = start; stop = true; break; }
            }
          }
          if (stop) break;
        }
        try {
          /* 顺序要紧：adapter.revealLine() 内部会 `setPosition({line: start})`，
             那会把选区清成单行 —— 以前"只选中签名 1 行"的真凶就是它
             （边界其实算对了）。所以先滚动、后设选区，最后一次写入生效。 */
          adapter.revealLine?.(start, true);
          adapter.setSelection({ start: { line: start, column: 1 }, end: { line: end, column: model.getLineMaxColumn(end) } });
          flashStatus(`已选中整个函数（${start}–${end} 行）`);
        } catch {
          flashStatus('选中失败', 'error');
        }
      }, [flashStatus]);

      /* -------------------------------------------------- macro expansion */
      const macroExpandableAt = useCallback(async (word, line, column) => {
        const name = String(word || '').trim();
        if (name === '') return false;
        const model = adapterRef.current?.raw.getModel();
        if (!model) return false;
        const callLine = Math.max(1, Number(line) || cursorRef.current.line);
        const lineText = model.getLineContent(callLine);
        if (/^\s*#\s*define\b/u.test(lineText)) return false;
        if (macroCallArgsAt(lineText, name, Math.max(0, (Number(column) || 1) - 1)) === null) return false;
        try {
          const data = await api(`/definition?name=${encodeURIComponent(name)}&path=${encodeURIComponent(activeRef.current)}`, undefined, sessionRef.current);
          const defs = Array.isArray(data?.definitions) ? data.definitions : [];
          const def = defs.find((item) => String(item.kind || '').toLowerCase() === 'macro' && item.prototype !== true)
            ?? defs.find((item) => String(item.kind || '').toLowerCase() === 'macro');
          if (!def) return false;
          if (def.file === activeRef.current && Number(def.line) === callLine) return false;
          return true;
        } catch {
          return false;
        }
      }, []);

      const macroExpansionAt = useCallback(async (word, line, column) => {
        const name = String(word || '').trim();
        if (name === '') return null;
        const model = adapterRef.current?.raw.getModel();
        if (!model) return null;
        const callLine = Math.max(1, Number(line) || cursorRef.current.line);
        const lineText = model.getLineContent(callLine);
        if (/^\s*#\s*define\b/u.test(lineText)) return null;
        const args = macroCallArgsAt(lineText, name, Math.max(0, (Number(column) || 1) - 1));
        if (args === null) return null;
        let defs = [];
        try {
          const data = await api(`/definition?name=${encodeURIComponent(name)}&path=${encodeURIComponent(activeRef.current)}`, undefined, sessionRef.current);
          defs = Array.isArray(data?.definitions) ? data.definitions : [];
        } catch {
          return null;
        }
        const def = defs.find((item) => String(item.kind || '').toLowerCase() === 'macro' && item.prototype !== true)
          ?? defs.find((item) => String(item.kind || '').toLowerCase() === 'macro');
        if (!def) return null;
        if (def.file === activeRef.current && Number(def.line) === callLine) return null;
        let content = previewCacheRef.current.get(def.file);
        if (typeof content !== 'string') {
          try {
            const data = await api(`/file?path=${encodeURIComponent(def.file)}`, undefined, sessionRef.current);
            content = data.content;
            previewCacheRef.current.set(def.file, content);
          } catch {
            return null;
          }
        }
        const lines = String(content).split(/\r?\n/);
        const first = lines[Number(def.line) - 1];
        if (!first || !/^\s*#\s*define\b/u.test(first)) return null;
        /* Continuation lines: keep them as newlines so a multi-line macro stays
           readable (original behaviour). */
        let text = first;
        for (let index = Number(def.line); /\\\s*$/u.test(text) && index < lines.length; index += 1) {
          text = text.replace(/\\\s*$/u, '\n') + (lines[index] || '');
        }
        const match = /^\s*#\s*define\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*([\s\S]*)$/u.exec(text);
        if (!match || match[1] !== name) return null;
        const params = match[2] === undefined ? null : match[2].split(',').map((item) => item.trim()).filter(Boolean);
        const body = match[3].trim();
        if (body === '') return null;
        /* Clicking the definition itself looks like a call whose "arguments" are
           the parameter names — that expands to nothing useful. */
        if (params && args.length === params.length && args.every((arg, index) => arg === params[index])) return null;
        const expanded = expandMacroOnce(body, params, args);
        const partial = /##|__VA_ARGS__|(^|[^#])#\s*[A-Za-z_]/u.test(body);
        const prefix = text.slice(0, text.length - match[3].length);
        const bodyLine = Number(def.line) + (prefix.split('\n').length - 1);
        return {
          callText: `${name}(${args.join(', ')})`,
          text: expanded,
          partial,
          file: def.file,
          bodyLine,
        };
      }, []);

      macroExpandableRef.current = macroExpandableAt;

      const showMacroAt = useCallback(async (word, line, column) => {
        const data = await macroExpansionAt(word, line, column);
        if (data === null) {
          flashHint('这一处没有可代入的实参');
          return;
        }
        const host = editorHostRef.current?.getBoundingClientRect();
        const width = Math.min(560, Math.round(window.innerWidth * 0.72));
        const height = 220;
        const x = Math.max(12, Math.min((host?.left ?? 40) + 60, window.innerWidth - width - 12));
        const y = Math.max(12, Math.min((host?.top ?? 40) + 70, window.innerHeight - height - 12));
        setMacroPop({ ...data, x, y, width });
      }, [macroExpansionAt, flashHint]);

      showMacroRef.current = showMacroAt;

      /* The context-menu entry appears only once the index confirms a macro call
         (the original appends it asynchronously for the same reason). */
      useEffect(() => {
        setMacroReady(false);
        if (editorMenu === null || !editorMenu.word) return undefined;
        let alive = true;
        void macroExpandableAt(editorMenu.word, editorMenu.line, editorMenu.column ?? 1)
          .then((ok) => { if (alive) setMacroReady(ok === true); });
        return () => { alive = false; };
      }, [editorMenu, macroExpandableAt]);

      const openInclude = useCallback(async (lineOverride) => {
        const model = adapterRef.current?.raw.getModel();
        if (!model) return;
        const wantedLine = Number(lineOverride);
        const line = wantedLine > 0 ? Math.round(wantedLine) : cursorRef.current.line;
        const text = model.getLineContent(line);
        const match = /#\s*include\s*[<"]([^>"]+)[>"]/u.exec(text);
        if (!match) {
          flashStatus('光标不在 #include 行', 'warn');
          return;
        }
        const header = match[1];
        try {
          const data = await api(`/files?q=${encodeURIComponent(header)}&limit=200`, undefined, sessionRef.current);
          const rows = Array.isArray(data?.rows) ? data.rows : [];
          const hit = rows.find((row) => String(row.rel || '') === header)
            ?? rows.find((row) => String(row.rel || '').endsWith(`/${header}`))
            ?? rows.find((row) => baseName(String(row.rel || '')) === baseName(header));
          if (!hit) {
            flashStatus(`项目里没有 ${header}`, 'warn');
            return;
          }
          await openFileAtRef.current?.(hit.rel, 1);
        } catch (error) {
          flashStatus(errorText(error, tRef.current), 'error');
        }
      }, [flashStatus]);

      const findIncludeUsers = useCallback(async (lineOverride) => {
        const model = adapterRef.current?.raw.getModel();
        if (!model) return;
        const wantedLine = Number(lineOverride);
        const line = wantedLine > 0 ? Math.round(wantedLine) : cursorRef.current.line;
        const text = model.getLineContent(line);
        const match = /#\s*include\s*[<"]([^>"]+)[>"]/u.exec(text);
        if (!match) {
          flashStatus('光标不在 #include 行', 'warn');
          return;
        }
        await searchCodeRef.current?.(baseName(match[1]));
      }, [flashStatus]);

      const runFloatAction = useCallback((id, bar) => {
        if (id === 'find') void searchCodeRef.current?.(bar.word);
        else if (id === 'callers') void findReferencesRef.current?.(bar.word, { line: bar.line, column: bar.column });
        else if (id === 'define') void gotoDefinitionRef.current?.(bar.word, { line: bar.line, column: bar.column });
        else if (id === 'highlight') toggleHighlight(bar.word);
        else if (id === 'ai') openAiRef.current?.('explain', bar.word);
        else if (id === 'copy') void copyText(bar.word, `已复制 ${bar.word}`);
        else if (id === 'macro') void showMacroRef.current?.(bar.word, bar.line, bar.column ?? 1);
      }, [toggleHighlight, copyText]);

      useEffect(() => { writeFontSize(fontSize); }, [fontSize]);
      /* Feed the outline its pseudo symbols (#ifdef…) from the live buffer. */
      useEffect(() => {
        let text = '';
        try {
          const model = adapterRef.current?.raw.getModel();
          if (model) text = model.getValue();
        } catch { /* editor rebuilding */ }
        if (text === '') {
          const tab = tabs.find((item) => item.path === activePath);
          text = tab?.content ?? '';
        }
        setBufferText(text.length > 2 * 1024 * 1024 ? '' : text);
      }, [activePath, tabs, monacoStatus, outlineTick]);
      useEffect(() => {
        const adapter = adapterRef.current;
        if (!adapter) return;
        try { adapter.setFontSize?.(fontSize); } catch { /* editor rebuilding */ }
      }, [fontSize, monacoStatus]);



      const closeTab = useCallback((rel) => {
        const tab = tabsRef.current.find((item) => item.path === rel);
        if (!tab) return;
        if (tab.dirty && !window.confirm(tRef.current('discardConfirm'))) return;
        const adapter = adapterRef.current;
        if (adapter) {
          try { viewStatesRef.current.delete(rel); } catch { /* ignore */ }
          if (activeRef.current === rel) {
            try { adapter.raw.setModel(null); } catch { /* ignore */ }
          }
          try { adapter.disposeModel(tab.absolutePath); } catch { /* ignore */ }
        }
        clearDraft(tab);
        const index = tabsRef.current.findIndex((item) => item.path === rel);
        const nextTabs = tabsRef.current.filter((item) => item.path !== rel);
        setTabs(nextTabs);
        if (activeRef.current === rel) {
          rememberCurrentHistory();
          const next = nextTabs[Math.min(index, nextTabs.length - 1)];
          setActivePath(next?.path ?? '');
          setCursor({ line: 1, column: 1 });
        }
      }, []);

      const saveActive = useCallback(async (force = false) => {
        const adapter = adapterRef.current;
        const tab = tabsRef.current.find((item) => item.path === activeRef.current);
        if (!adapter || !tab || tab.readOnly) return;
        const model = adapter.raw.getModel();
        if (!model) return;
        setSaveState('saving');
        setNotice(null);
        /* 快照必须和要写盘的文本同一时刻取：保存期间继续输入时，若在 await
           之后才读版本号，磁盘上落的是旧文本、tab 却被标记成“已保存”，
           关标签时不会提示，输入就静默丢了。 */
        const content = model.getValue();
        const alt = model.getAlternativeVersionId();
        try {
          const saved = await api('/file', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              path: tab.path,
              content,
              expectedVersion: tab.baseVersion,
              force,
              bom: tab.bom,
            }),
          }, sessionRef.current);
          setTabs((previous) => previous.map((item) => (
            item.path === tab.path
              ? {
                ...item,
                baseVersion: saved.version,
                size: saved.size,
                mtime: saved.mtime,
                savedAltVersion: alt,
                /* 保存过程中又改过：仍是脏的，也别丢掉后来的输入 */
                dirty: model.getAlternativeVersionId() !== alt,
              }
              : item
          )));
          /* 只有“写盘内容即当前内容”时草稿才作废；保存期间又输入过时，
             草稿定时器属于更新的编辑，不能连它一起清掉。 */
          if (model.getAlternativeVersionId() === alt) clearDraft(tab);
          setConflict(null);
          setSaveState('saved');
          previewCacheRef.current.delete(tab.path);
          contextCacheRef.current.clear();
          /* AI-inserted lines lose their tint once the file is saved. */
          try { adapterRef.current?.clearAiInserted?.(); } catch { /* editor gone */ }
          setOutlineTick((value) => value + 1);
          void refreshIndex();
          window.setTimeout(() => setSaveState((value) => (value === 'saved' ? 'idle' : value)), 1600);
        } catch (error) {
          if (error.status === 409) {
            const current = error.data?.error?.current;
            setConflict({
              path: tab.path,
              missing: error.data?.error?.missing === true,
              current: current && typeof current.content === 'string' ? current : null,
            });
          } else {
            setNotice({ kind: 'error', text: errorText(error, tRef.current) });
          }
          setSaveState('idle');
        }
      }, []);

      const reloadTab = useCallback(async (targetPath) => {
        const tab = tabsRef.current.find((item) => item.path === targetPath);
        if (!tab) return;
        try {
          const data = await api(`/file?path=${encodeURIComponent(tab.path)}`, undefined, sessionRef.current);
          const adapter = adapterRef.current;
          if (adapter && activeRef.current === tab.path) {
            const model = adapter.raw.getModel();
            if (model) {
              model.setValue(data.content);
              const alt = model.getAlternativeVersionId();
              setTabs((previous) => previous.map((item) => (
                item.path === tab.path
                  ? {
                    ...item,
                    content: data.content,
                    baseVersion: data.version,
                    size: data.size,
                    mtime: data.mtime,
                    savedAltVersion: alt,
                    forceDirty: false,
                    dirty: false,
                  }
                  : item
              )));
            }
          } else {
            setTabs((previous) => previous.map((item) => (
              item.path === tab.path
                ? {
                  ...item,
                  content: data.content,
                  baseVersion: data.version,
                  size: data.size,
                  mtime: data.mtime,
                  savedAltVersion: undefined,
                  forceDirty: false,
                  dirty: false,
                }
                : item
            )));
          }
          clearDraft(tab);
          setConflict(null);
        } catch (error) {
          setNotice({ kind: 'error', text: errorText(error, tRef.current) });
        }
      }, []);

      /* ------------------------------------------------------ external changes */

      useEffect(() => {
        const root = rootInfo?.root;
        if (!root || activePath === '') return undefined;
        let alive = true;
        let running = false;
        const check = async () => {
          if (running) return;
          running = true;
          try {
            const tab = tabsRef.current.find((item) => item.path === activePath);
            if (!tab) return;
            const info = await api(`/stat?path=${encodeURIComponent(tab.path)}`, undefined, sessionRef.current);
            if (!alive) return;
            if (info.exists === false) {
              if (!tab.dirty) setNotice({ kind: 'warn', text: tRef.current('conflictMissing') });
              return;
            }
            if (info.version !== tab.baseVersion) {
              if (tab.dirty) setConflict({ path: tab.path, missing: false, current: null });
              else await reloadTab(tab.path);
            }
          } catch {
            /* transient: the next poll retries */
          } finally {
            running = false;
          }
        };
        const timer = window.setInterval(check, 3000);
        window.addEventListener('focus', check);
        return () => {
          alive = false;
          window.clearInterval(timer);
          window.removeEventListener('focus', check);
        };
      }, [rootInfo?.root, activePath, reloadTab]);

      /* ------------------------------------------------------------- shortcuts */

      useEffect(() => {
        const onKeyDown = (event) => {
          const mod = event.ctrlKey || event.metaKey;
          if (event.defaultPrevented) return;
          if (mod && event.altKey && (event.key === 's' || event.key === 'S')) {
            event.preventDefault();
            setMode((value) => (value === 'D' ? 'P' : 'D'));
            return;
          }
          if (mode === 'D') return;
          if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              void goBack();
              return;
            }
            if (event.key === 'ArrowRight') {
              event.preventDefault();
              void goForward();
              return;
            }
          }
          if (event.key === 'Escape' && symbolOpenRef.current) {
            event.preventDefault();
            setSymbolOpen(false);
            return;
          }
          if (event.key === 'Escape' && (highlightRef.current !== null || floatBar !== null)) {
            if (highlightRef.current !== null) toggleHighlight(highlightRef.current.word);
            setFloatBar(null);
            return;
          }
          /* Font size: half-point steps, same chords as the original. */
          if (mod && !event.altKey && (event.key === '=' || event.key === '+')) {
            event.preventDefault();
            bumpFont(0.5);
            return;
          }
          if (mod && !event.altKey && event.key === '-') {
            event.preventDefault();
            bumpFont(-0.5);
            return;
          }
          if (mod && !event.altKey && event.key === '0') {
            event.preventDefault();
            resetFont();
            return;
          }
          if (event.shiftKey && !mod && !event.altKey && event.key === 'F8') {
            event.preventDefault();
            const adapter = adapterRef.current;
            const selection = adapter?.getSelection?.();
            const word = selection?.text?.trim() || adapter?.getWordAtCursor?.() || '';
            if (word !== '') toggleHighlight(word);
            return;
          }
          if (!mod && !event.altKey && event.key === 'F4') {
            event.preventDefault();
            stepResult(event.shiftKey ? -1 : 1);
            return;
          }
          if (mod && !event.altKey && !event.shiftKey && (event.key === 'g' || event.key === 'G')) {
            event.preventDefault();
            editorAction('editor.action.gotoLine');
            return;
          }
          if (mod && !event.altKey && !event.shiftKey && (event.key === 'o' || event.key === 'O')) {
            event.preventDefault();
            setPickerOpen(true);
            return;
          }
          if (mod && !event.altKey && !event.shiftKey && (event.key === 'i' || event.key === 'I')) {
            event.preventDefault();
            const adapter = adapterRef.current;
            const word = adapter?.getSelection?.()?.text?.trim() || adapter?.getWordAtCursor?.() || '';
            openAiRef.current?.('explain', word);
            return;
          }          if (mod && !event.altKey && !event.shiftKey && (event.key === 's' || event.key === 'S')) {
            event.preventDefault();
            void saveActive(false);
            return;
          }
          if (mod && !event.altKey && (event.key === 'w' || event.key === 'W')) {
            event.preventDefault();
            if (activeRef.current !== '') closeTab(activeRef.current);
          }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
      }, [mode, saveActive, closeTab, goBack, goForward, bumpFont, resetFont, toggleHighlight, editorAction, stepResult, floatBar]);
      /* Esc closes whichever dialog is open (the original's global rule). */
      useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape' || event.defaultPrevented) return;
          if (aboutOpen) { setAboutOpen(false); return; }
          if (colorPanelOpen) { setColorPanelOpen(false); return; }
          if (enhanceOpen) { setEnhanceOpen(false); return; }
          if (pickerOpen) { setPickerOpen(false); return; }
          if (symbolOpen) { setSymbolOpen(false); return; }
          if (pathOpen) { setPathOpen(false); }
          if (projectMenuOpen) { setProjectMenuOpen(false); }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [aboutOpen, colorPanelOpen, enhanceOpen, pickerOpen, symbolOpen, pathOpen, projectMenuOpen]);
      /* 顶栏菜单展开时暂时藏起 DSH 子窗口的四个悬浮按钮：它们是 body 级、
         z-index 极高，否则会盖住"帮助"等下拉菜单。 */
      useEffect(() => {
        const sync = () => {
          const open = document.querySelector('.sl-layer .sl-menu.open') !== null;
          if (open) document.body.setAttribute('data-sl-menu-open', '1');
          else document.body.removeAttribute('data-sl-menu-open');
        };
        sync();
        const observer = new MutationObserver(sync);
        const menuRoot = document.querySelector('.sl-layer .sl-menubar')
          || document.querySelector('.sl-layer');
        if (menuRoot) {
          observer.observe(menuRoot, {
            subtree: true,
            attributes: true,
            attributeFilter: ['class'],
          });
        }
        return () => {
          observer.disconnect();
          document.body.removeAttribute('data-sl-menu-open');
        };
      }, []);
      /* 点外面收起路径浮层与浮动操作条（原版同样行为）。 */
      useEffect(() => {
        if (!pathOpen) return undefined;
        const onDown = (event) => {
          const target = event.target;
          if (target instanceof Element && (target.closest('.sl-path-pop') || target.closest('.sl-top-path'))) return;
          setPathOpen(false);
        };
        document.addEventListener('pointerdown', onDown, true);
        return () => document.removeEventListener('pointerdown', onDown, true);
      }, [pathOpen]);

      useEffect(() => {
        if (floatBar === null) return undefined;
        const onDown = (event) => {
          const target = event.target;
          if (target instanceof Element && (target.closest('.sl-float-bar') || target.closest('.sl-float-actions'))) return;
          setFloatBar(null);
        };
        document.addEventListener('pointerdown', onDown, true);
        return () => document.removeEventListener('pointerdown', onDown, true);
      }, [floatBar]);



      useEffect(() => () => {
        const root = rootRef.current?.root;
        if (!root) return;
        for (const tab of tabsRef.current) {
          if (!tab.dirty) continue;
          const model = window.monaco?.editor.getModel(window.monaco.Uri.file(tab.absolutePath));
          const content = model ? model.getValue() : tab.content;
          if (typeof content === 'string' && content.length <= DRAFT_LIMIT) {
            writeJsonStorage(draftKey(root, tab.path), {
              content,
              version: tab.baseVersion,
              savedAt: Date.now(),
            });
          }
        }
      }, []);

      /* --------------------------------------------------------------- resize */

      const startSidebarResize = useCallback((event) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = Math.round(viewportWidth * paneRatios.sidebar);
        const move = (moveEvent) => {
          const raw = (startWidth + moveEvent.clientX - startX) / Math.max(1, viewportWidth);
          setPaneRatios((previous) => ({
            ...previous,
            sidebar: Math.min(0.5, Math.max(0.14, raw)),
          }));
        };
        const stop = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', stop);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop);
      }, [viewportWidth, paneRatios.sidebar]);

      const startOutlineResize = useCallback((event) => {
        event.preventDefault();
        const startY = event.clientY;
        const startHeight = outlineHeight;
        const move = (moveEvent) => {
          setOutlineHeight(clampOutlineHeight(startHeight + (startY - moveEvent.clientY), window.innerHeight));
        };
        const stop = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', stop);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop);
      }, [outlineHeight]);

      const startResultsResize = useCallback((event) => {
        event.preventDefault();
        const startY = event.clientY;
        const startHeight = resultsHeight;
        const move = (moveEvent) => {
          setResultsHeight(clampResultsHeight(startHeight + (startY - moveEvent.clientY), window.innerHeight));
        };
        const stop = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', stop);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop);
      }, [resultsHeight]);

      const startGlobalResize = useCallback((event) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = Math.round(viewportWidth * paneRatios.global);
        let moveRaf = 0;
        let nextRatio = paneRatios.global;
        const move = (moveEvent) => {
          const raw = (startWidth + (startX - moveEvent.clientX)) / Math.max(1, viewportWidth);
          nextRatio = Math.min(0.5, Math.max(0.14, raw));
          if (moveRaf !== 0) return;
          moveRaf = window.requestAnimationFrame(() => {
            moveRaf = 0;
            setPaneRatios((previous) => ({ ...previous, global: nextRatio }));
          });
        };
        const stop = () => {
          if (moveRaf !== 0) window.cancelAnimationFrame(moveRaf);
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', stop);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop);
      }, [viewportWidth, paneRatios.global]);


      /* --------------------------------------------------------------- render */

      const activeTab = useMemo(
        () => tabs.find((tab) => tab.path === activePath) ?? null,
        [tabs, activePath],
      );
      /* 启动时先不显示编辑器，等"模型 + 上次滚动位置"都就位后再亮出来：
         否则会先看到文件开头，再跳回上次的位置（一块临时画面）。
         editorVisible 只在 Monaco 重新加载时复位，切文件不受影响。 */
      const dirtyCount = tabs.filter((tab) => tab.dirty).length;
      const layerStyle = {
        display: mode === 'D' ? 'none' : 'flex',
      };
      const saveLabel = saveState === 'saving'
        ? t('statusSaving')
        : saveState === 'saved'
          ? t('statusSaved')
          : activeTab?.readOnly
            ? t('statusReadOnly')
            : activeTab?.dirty
              ? t('statusUnsaved')
              : t('statusSaved');
      const indexPct = indexInfo?.progress?.total > 0
        ? Math.round((indexInfo.progress.done / indexInfo.progress.total) * 100)
        : null;
      const indexLabel = indexInfo?.building === true
        ? (indexPct === null ? '索引中…' : `索引中 ${Math.min(99, indexPct)}%`)
        : indexInfo?.built === true
          ? (indexInfo.parserStale === true ? '解析器已更新' : (indexInfo.stale === true ? '索引过期' : `索引 ${indexInfo.symbolCount}`))
          : '建立索引';

      const fileMenu = [
        { label: '打开文件…', shortcut: 'Ctrl+O', action: () => setPickerOpen(true) },
        { label: '本地目录…', action: () => { void pickLocalProject(); } },
        { label: '回到会话工作区', disabled: projectBusy, action: () => { void resetProjectDir(); } },
        { sep: true },
        {
          label: '保存',
          shortcut: 'Ctrl+S',
          disabled: !activeTab || !activeTab.dirty || activeTab.readOnly || saveState === 'saving',
          action: () => void saveActive(false),
        },
        { sep: true },
        { label: '关闭文件', shortcut: 'Ctrl+W', disabled: !activeTab, action: () => activeTab && closeTab(activeTab.path) },
        { sep: true },
        { label: '关闭 SourceLook', action: () => setMode('D') },
      ];
      const editMenu = [
        { label: '撤销', shortcut: 'Ctrl+Z', action: () => editorAction('undo') },
        { label: '重做', shortcut: 'Ctrl+Y', action: () => editorAction('redo') },
        { sep: true },
        { label: '剪切', shortcut: 'Ctrl+X', action: () => editorAction('editor.action.clipboardCutAction') },
        { label: '复制', shortcut: 'Ctrl+C', action: () => void copySelectionOrLine() },
        { label: '粘贴', shortcut: 'Ctrl+V', action: () => editorAction('editor.action.clipboardPasteAction') },
        { label: '全选', shortcut: 'Ctrl+A', action: () => editorAction('editor.action.selectAll') },
        { label: '复制（带位置）', action: () => void copyWithLocation() },
        { sep: true },
        { label: '查找（本文件）', shortcut: 'Ctrl+F', action: () => revealFileFind() },
        { label: '查找（全项目）', shortcut: 'Ctrl+Shift+F', action: () => { setSymbolQuery(''); setSymbolOpen(true); } },
        { label: '跳转行…', shortcut: 'Ctrl+G', action: () => editorAction('editor.action.gotoLine') },
        { sep: true },
        { label: '高亮光标处的词', shortcut: 'Shift+F8', action: () => toggleHighlight(adapterRef.current?.getWordAtCursor?.() ?? '') },
        { label: '选中整个函数', action: () => selectFunction() },
        { sep: true },
        { label: '转成十六进制', action: () => convertNumber(16) },
        { label: '转成十进制', action: () => convertNumber(10) },
        { sep: true },
        { label: '打开 #include 的头文件', action: () => void openInclude() },
        { label: '谁引用了这个头文件', action: () => void findIncludeUsers() },
        { label: '打开对应文件（.c/.h）', action: () => void openCounterpart() },
      ];
      const viewMenu = [
        { label: symbolPaneCollapsed ? '显示符号窗口' : '隐藏符号窗口', action: () => setSymbolPaneCollapsed((value) => !value) },
        { label: globalCollapsed ? '显示全局符号窗口' : '隐藏全局符号窗口', action: () => setGlobalCollapsed((value) => !value) },
        {
          label: contextOpen ? '关闭底部上下文窗' : '打开底部上下文窗',
          action: () => setContextOpen((value) => !value),
        },
        { label: contextCollapsed ? '展开底部上下文窗' : '折叠底部上下文窗', disabled: !contextOpen, action: () => setContextCollapsed((value) => !value) },
        { sep: true },
        { label: '放大字号', shortcut: 'Ctrl+=', action: () => bumpFont(0.5) },
        { label: '缩小字号', shortcut: 'Ctrl+-', action: () => bumpFont(-0.5) },
        { label: `重置字号（当前 ${fontSize}px）`, shortcut: 'Ctrl+0', action: () => resetFont() },
        { sep: true },
        { label: '高亮光标处的词', shortcut: 'Shift+F8', action: () => toggleHighlight(adapterRef.current?.getWordAtCursor?.() ?? '') },
        { sep: true },
        { label: `主题：跟随 DSH${theme === 'auto' ? ' ✓' : ''}`, action: () => setTheme('auto') },
        { label: `主题：浅色${theme === 'light' ? ' ✓' : ''}`, action: () => setTheme('light') },
        { label: `主题：深色${theme === 'dark' ? ' ✓' : ''}`, action: () => setTheme('dark') },
        { label: `主题：羊皮纸${theme === 'sepia' ? ' ✓' : ''}`, action: () => setTheme('sepia') },
        { label: `主题：薄荷${theme === 'mint' ? ' ✓' : ''}`, action: () => setTheme('mint') },
        { label: `主题：石墨${theme === 'graphite' ? ' ✓' : ''}`, action: () => setTheme('graphite') },
        { label: '自定义代码配色…', action: () => setColorPanelOpen(true) },
        { label: '解析与增强…', action: () => setEnhanceOpen(true) },
        { sep: true },
        { label: '重启 SourceLook', shortcut: 'Ctrl+Alt+R', action: () => { window.location.reload(); } },
        mode === 'C' ? { label: '隐藏 DSH 面板', shortcut: 'Ctrl+Alt+B', action: () => setMode('P') } : null,
        { sep: true },
        {
          label: indexInfo?.building === true ? '取消索引' : indexInfo?.built === true ? '重建索引' : '建立索引',
          action: () => {
            if (indexInfo?.building === true) void cancelIndex();
            else void startIndex();
          },
        },
        { sep: true },
        { label: '关于 SourceLook', action: () => setAboutOpen(true) },
      ];
      const helpMenu = [
        { label: '关于 SourceLook', action: () => setAboutOpen(true) },
        { label: '键盘快捷键', shortcut: 'Ctrl+Alt+P', action: () => {
          setSymbolQuery('');
          setSymbolOpen(true);
        } },
      ];

      const canBack = historyVersion >= 0 && historyIndexRef.current > 0;
      const canForward = historyVersion >= 0 && historyIndexRef.current < historyRef.current.length - 1;
      const activeTheme = theme === 'auto'
        ? (document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light')
        : theme;
      const colorChoices = [
        { key: 'com', css: '--sl-syn-com', label: '注释', fallback: '#4a7c59', italic: true },
        { key: 'pre', css: '--sl-syn-pre', label: '预处理', fallback: '#795e26' },
        { key: 'kw', css: '--sl-syn-kw', label: '关键字', fallback: '#0d63ff' },
        { key: 'type', css: '--sl-syn-type', label: '类型', fallback: '#0f6472' },
        { key: 'num', css: '--sl-syn-num', label: '数字', fallback: '#c05a4d' },
        { key: 'str', css: '--sl-syn-str', label: '字符串', fallback: '#2f7d5a' },
        { key: 'fn', css: '--sl-syn-fn', label: '函数调用', fallback: '#2470c4' },
        { key: 'fnDef', css: '--sl-syn-fn-def', label: '函数定义', fallback: '#8b2be2' },
        { key: 'macro', css: '--sl-syn-macro', label: '宏', fallback: '#b04a3c' },
      ];
      const themeColors = colors[activeTheme] ?? {};
      const colorVars = {};
      for (const choice of colorChoices) {
        if (typeof themeColors[choice.key] === 'string' && themeColors[choice.key] !== '') {
          colorVars[choice.css] = themeColors[choice.key];
        }
      }
      const setThemeColor = (key, value) => {
        setColors((previous) => ({
          ...previous,
          [activeTheme]: { ...(previous[activeTheme] ?? {}), [key]: value },
        }));
      };

            const resultCount = results === null
        ? 0
        : ((Array.isArray(results.items) ? results.items.length : 0)
          + (Array.isArray(results.refs) ? results.refs.length : 0));
      const hasResults = resultCount > 0 || (lastResultRef.current?.hits?.length ?? 0) > 0;
      /* 项目路径：固定最多 34 个字符，超过就从前面折叠（不再按窗口宽度伸缩）。 */
      const projectPathLabel = rootInfo?.root ? projectTail(rootInfo.root, 24) : '';
      /* 路径颜色跟着索引状态走：未建索引=红，已建=蓝，构建中=橙。 */
      const indexState = indexInfo?.building === true
        ? 'building'
        : (indexInfo?.built === true ? 'ready' : 'none');

const topbar = h('header', { className: 'sl-topbar' },
        h('div', { className: 'sl-brand', title: 'SourceLook' },
          h('span', { className: 'sl-brand-name' },
            h('span', { className: 'sl-brand-hot' }, 'S'),
            h('span', {}, 'ource'),
            h('span', { className: 'sl-brand-hot green' }, 'L'),
            h('span', {}, 'ook'),
          ),
        ),
        h('nav', { className: 'sl-menubar', 'aria-label': 'main menu' },
          h(SlMenu, { label: '文件', items: fileMenu }),
          h(SlMenu, { label: '编辑', items: editMenu }),
          h(SlMenu, { label: '视图', items: viewMenu }),
        ),
        h('span', { className: 'sl-top-sep' }),
        h('button', {
          type: 'button',
          ref: projectBtnRef,
          className: 'sl-top-action icon project',
          title: rootInfo?.root ? `项目目录：${rootInfo.root}（单击打开项目菜单）` : '项目目录',
          'aria-label': '项目目录',
          onClick: openProjectMenu,
        }, h(Icon, { name: 'project', size: 14 })),
        h('button', {
          type: 'button',
          ref: pathBtnRef,
          className: `sl-top-path idx-${indexState}`,
          title: rootInfo?.root ?? '未打开项目',
          onMouseDown: (event) => event.stopPropagation(),
          onClick: () => {
            const rect = pathBtnRef.current?.getBoundingClientRect();
            if (rect) {
              const width = 380;
              setPathAnchor({
                left: Math.max(8, Math.min(Math.round(rect.left), Math.round(window.innerWidth - width - 12))),
                top: Math.round(rect.bottom + 6),
              });
            }
            setPathOpen((value) => !value);
          },
        }, rootInfo?.root ? projectPathLabel : '（未打开项目）'),
        h('div', { className: 'sl-top-spacer' }),
        /* 中间区：前进/后退 的**中心线**对齐窗口中心，查找框挂在它右边。
           整组绝对定位居中，不受两侧内容宽度影响。 */
        h('div', { className: 'sl-top-center' },
          h('div', { className: 'sl-top-nav' },
          h('button', {
            type: 'button', className: 'sl-nav-btn', title: canBack ? '后退 · Alt+←' : '后退（还没有可后退的位置）· Alt+←',
            disabled: !canBack, onClick: () => void goBack(),
          }, h(Icon, { name: 'back', size: 13 })),
          h('button', {
            type: 'button', className: 'sl-nav-btn', title: canForward ? '前进 · Alt+→' : '前进（还没有可前进的位置）· Alt+→',
            disabled: !canForward, onClick: () => void goForward(),
          }, h(Icon, { name: 'forward', size: 13 })),
        ),
                h('div', { className: 'sl-top-find' },
          h('button', {
            type: 'button',
            className: 'sl-find-icon',
            title: '查找索引（也可以按回车）',
            'aria-label': '查找',
            onClick: () => { void runTopFind(); },
          }, h(Icon, { name: 'search', size: 13 })),
          h('input', {
            type: 'text',
            value: topFind,
            placeholder: '查找索引',
            'aria-label': '查找代码',
            spellCheck: false,
            onChange: (event) => setTopFind(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                runTopFind();
              } else if (event.key === 'Escape') {
                setTopFind('');
              }
            },
          }),
          h('button', {
            type: 'button',
            className: `sl-top-action icon result${hasResults ? ' has' : ''}`,
            title: hasResults ? `查找结果（${resultCount} 处）` : '还没有查找结果',
            'aria-label': '查找结果',
            disabled: lastResultRef.current === null && results === null,
            onClick: () => {
              if (lastResultRef.current !== null) {
                setResultWin(lastResultRef.current);
                return;
              }
              if (results === null) return;
              setContextOpen(true);
              setContextCollapsed(false);
            },
          }, h(Icon, { name: 'list', size: 14 })),
          ),
        ),
h('button', {
          type: 'button',
          className: `sl-top-action dsh${mode === 'C' ? ' active' : ''}${dshBusy.busy ? ' busy' : ''}`,
          title: (mode === 'C' ? '隐藏 DSH 子窗口（回到只有插件的模式）' : '在右侧打开 DSH 子窗口')
            + (dshBusy.busy
              ? (dshBusy.jobs > 0 ? ` · DSH 正在工作（${dshBusy.jobs} 个后台任务）` : ' · DSH 正在工作')
              : ''),
          onClick: () => setMode((value) => (value === 'C' ? 'P' : 'C')),
        },
        'DSH',
        h('span', { className: `sl-dsh-orb${dshBusy.busy ? ' live' : ''}`, 'aria-hidden': true },
          h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, focusable: false },
            h('rect', { className: 'sl-dsh-win', x: 2, y: 2, width: 5.6, height: 5.6, rx: 0.7, fill: 'currentColor' }),
            h('rect', { className: 'sl-dsh-win', x: 8.4, y: 2, width: 5.6, height: 5.6, rx: 0.7, fill: 'currentColor' }),
            h('rect', { className: 'sl-dsh-win', x: 2, y: 8.4, width: 5.6, height: 5.6, rx: 0.7, fill: 'currentColor' }),
            h('rect', { className: 'sl-dsh-win', x: 8.4, y: 8.4, width: 5.6, height: 5.6, rx: 0.7, fill: 'currentColor' }),
          ))),
        h(SlMenu, {
          label: '帮助',
          className: 'sl-help',
          items: [
            { label: '键盘快捷键', action: () => { setSymbolQuery(''); setSymbolOpen(true); } },
            { label: '关于 SourceLook', action: () => setAboutOpen(true) },
          ],
        }),

      );

      const crumbParts = (activeTab?.path ?? '').split('/').filter(Boolean);
      const body = h('div', { className: 'sl-body' },
        h('div', { className: 'sl-pane-hot left' },
          h('button', {
            type: 'button',
            className: 'sl-pane-restore left',
            title: symbolPaneCollapsed ? '展开符号窗口' : '隐藏符号窗口',
            'aria-label': symbolPaneCollapsed ? '展开符号窗口' : '隐藏符号窗口',
            onClick: () => setSymbolPaneCollapsed((value) => !value),
          }, h(Icon, { name: symbolPaneCollapsed ? 'fold-right' : 'fold-left', size: 13 })),
        ),
        h('div', { className: 'sl-pane-hot right' },
          h('button', {
            type: 'button',
            className: 'sl-pane-restore right',
            title: globalCollapsed ? '展开全局符号窗口' : '隐藏全局符号窗口',
            'aria-label': globalCollapsed ? '展开全局符号窗口' : '隐藏全局符号窗口',
            onClick: () => setGlobalCollapsed((value) => !value),
          }, h(Icon, { name: globalCollapsed ? 'fold-left' : 'fold-right', size: 13 })),
        ),
        h(SymbolPane, {
          symbols: outlineData.symbols,
          loading: outlineData.loading,
          error: outlineData.error,
          path: outlineData.path || activePath,
          collapsed: symbolPaneCollapsed,
          width: sidebarWidth,
          filter: symbolFilter,
          sort: symbolSort,
          currentLine: cursor.line,
          bufferText,
          onFilter: setSymbolFilter,
          onSort: setSymbolSort,
          onToggle: toggleSymbolPane,
          onSelect: selectSymbol,
          t,
        }),
        !symbolPaneCollapsed ? h('div', {
          className: 'sl-pane-resizer left',
          role: 'separator',
          'aria-orientation': 'vertical',
          'aria-label': 'resize symbols',
          title: '拖动调整符号窗口宽度；双击恢复默认',
          onPointerDown: startSidebarResize,
          onDoubleClick: () => setPaneRatios((previous) => ({ ...previous, sidebar: DEFAULT_PANE_RATIOS.sidebar })),
        }) : null,
        h('section', { className: 'sl-main' },
          h('div', { className: 'sl-crumbbar', title: activeTab?.path ?? '' },
            /* 本文件查找：路径行**左端**（右边留给路径）。搜索固定"不区分大小写、
               不做全词匹配"。 */
            h('div', { className: 'sl-filefind' },
              h('button', {
                type: 'button',
                className: 'sl-filefind-btn lead',
                title: '查找本文件（Ctrl+F）',
                'aria-label': '查找本文件',
                onClick: revealFileFind,
              }, h(Icon, { name: 'search', size: 12 })),
              h('input', {
                ref: fileFindInputRef,
                type: 'text',
                className: 'sl-filefind-input',
                value: fileFind,
                placeholder: '查找本文件',
                spellCheck: false,
                'aria-label': '查找本文件',
                onChange: (event) => {
                  const value = event.target.value;
                  setFileFind(value);
                  /* 同步算一次 + 跳到第一个匹配：不依赖 effect/定时器（被遮挡的窗口
                     会把 setTimeout 节流到 1s 以上，打字时会觉得"不跟手"）。 */
                  const api = fileFindApiRef.current;
                  if (!api) return;
                  const matches = api.collect(value);
                  if (matches.length > 0) api.go(1, { reveal: true });
                },
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    stepFileMatch(event.shiftKey ? -1 : 1);
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    closeFileFind();
                  }
                },
              }),
              h('span', {
                className: `sl-filefind-count${fileFind !== '' && fileFindCount === 0 ? ' zero' : ''}`,
                title: fileFind !== '' ? `${fileFindCount} 处匹配` : '',
              }, fileFind === '' ? '' : `${fileFindCount === 0 ? 0 : fileFindIndex}/${fileFindCount}`),
              h('button', {
                type: 'button',
                className: 'sl-filefind-btn up',
                title: '上一个匹配（Shift+Enter）',
                'aria-label': '上一个匹配',
                disabled: fileFindCount === 0,
                onClick: () => stepFileMatch(-1),
              }, h(Icon, { name: 'back', size: 12 })),
              h('button', {
                type: 'button',
                className: 'sl-filefind-btn down',
                title: '下一个匹配（Enter）',
                'aria-label': '下一个匹配',
                disabled: fileFindCount === 0,
                onClick: () => stepFileMatch(1),
              }, h(Icon, { name: 'forward', size: 12 })),
              fileFind === '' ? null : h('button', {
                type: 'button',
                className: 'sl-filefind-btn',
                title: '清空并关闭查找（Esc）',
                'aria-label': '关闭查找',
                onClick: closeFileFind,
              }, h(Icon, { name: 'close', size: 12 })),
            ),
            h('div', { className: 'sl-crumb-path' },
              crumbParts.length === 0
                ? h('span', { className: 'sl-crumb-empty' }, '未打开文件')
                : crumbParts.map((part, index) => h(Fragment, { key: `${index}:${part}` },
                  index > 0 ? h('span', { className: 'sl-crumb-sep' }, '›') : null,
                  h('button', {
                    type: 'button',
                    className: 'sl-crumb',
                    title: crumbParts.slice(0, index + 1).join('/'),
                    onClick: () => {
                      setGlobalMode('tree');
                      setGlobalCollapsed(false);
                      flashHint(`已在文件树中展开：${crumbParts.slice(0, index + 1).join('/')}`);
                    },
                  }, part),
                )),
            ),
          ),
          h('div', { className: 'sl-editor-wrap' },
            h('div', {
              ref: editorHostRef,
              className: `sl-editor-host${editorVisible ? '' : ' is-priming'}`,
            }),
            monacoStatus === 'error' ? h('div', { className: 'sl-editor-error' },
              h('div', { className: 'sl-editor-error-title' }, t('editorFailed')),
              h('div', { className: 'sl-editor-error-text' }, monacoError),
              h('button', {
                type: 'button', className: 'sl-btn', onClick: () => setMonacoReload((value) => value + 1),
              }, t('retry')),
            ) : null,
            /* bootReady：等“恢复上次文件”落定再决定要不要欢迎页，
               否则重启时会先闪一下“开始阅读代码”再跳到代码。 */
            tabs.length === 0 && monacoStatus === 'ready' && bootReady ? h('div', { className: 'sl-empty' },
              h('div', { className: 'sl-empty-mark' }, h(Icon, { name: 'code', size: 32 })),
              h('h2', { className: 'sl-empty-title' }, t('emptyTitle')),
              h('p', { className: 'sl-empty-hint' }, t('emptyHint')),
              h('button', { type: 'button', className: 'sl-btn primary', onClick: () => setPickerOpen(true) },
                h(Icon, { name: 'open', size: 15 }), t('open')),
            ) : null,
          ),
        ),
        !globalCollapsed ? h('div', {
          className: 'sl-pane-resizer right',
          role: 'separator',
          'aria-orientation': 'vertical',
          'aria-label': 'resize global symbols',
          title: '拖动调整全局符号窗口宽度；双击恢复默认',
          onPointerDown: startGlobalResize,
          onDoubleClick: () => setPaneRatios((previous) => ({ ...previous, global: DEFAULT_PANE_RATIOS.global })),
        }) : null,
        h(GlobalPane, {
          sessionId,
          rootInfo,
          activePath,
          width: globalWidth,
          collapsed: globalCollapsed,
          mode: globalMode,
          indexInfo,
          onMode: setGlobalMode,
          onToggle: toggleGlobalPane,
          onOpen: openGlobalItem,
          onPreview: previewGlobalItem,
          onNote: noteGlobalItem,
          t,
        }),
      );

      const contextPanel = contextOpen ? h(ResultsPanel, {
        sessionId,
        results,
        preview: resultsPreview,
        height: resultsHeight,
        collapsed: contextCollapsed,
        onResizeStart: startResultsResize,
        onToggle: () => setContextCollapsed((value) => !value),
        onPreview: previewResult,
        onOpen: (item) => {
          if (item?.file) void openFileAt(item.file, item.line);
        },
        onShowRefs: (word) => { void findReferencesRef.current?.(word); },
        aiConfig,
        t,
      }) : null;

      const pathParts = (activeTab?.path ?? '').split('/').filter(Boolean);
      const statusPath = pathParts.length > 0
        ? `${pathParts.join(' > ')} ( 行 ${cursor.line}， 列 ${cursor.column} )`
        : '';
      const statusIndexText = indexInfo?.building === true
        ? (indexPct === null ? '索引中…' : `索引中 ${Math.min(99, indexPct)}% · ${indexInfo.progress?.done ?? 0}/${indexInfo.progress?.total ?? 0} 文件`)
        : indexInfo?.built === true
          ? `已索引 ${Number(indexInfo.symbolCount || 0).toLocaleString('en-US')} 符号 / ${Number(indexInfo.fileCount || 0).toLocaleString('en-US')} 文件 · ${indexInfo.fromCache === true ? '缓存' : '构建'}${indexInfo.parserStale === true ? ' · 解析器已更新，建议重建' : (indexInfo.stale === true ? ' · 索引过期' : '')}${indexInfo.truncated === true ? ' · 文件数超上限，仅索引了前 12 万' : ''}`
          : '未建立索引 · 点击建立';

      const status = h('footer', { className: 'sl-statusbar' },
        h('button', {
          type: 'button',
          className: `sl-st-index${indexInfo?.built === true && indexInfo?.stale !== true ? ' ok' : ''}${indexInfo?.building === true ? ' building' : ''}`,
          disabled: indexBusy,
          title: indexInfo?.building === true ? '取消索引' : indexInfo?.built === true ? '重建索引' : '建立索引',
          onClick: () => {
            if (indexInfo?.building === true) void cancelIndex();
            else void startIndex();
          },
        }, statusIndexText),
        activeTab?.dirty ? h('span', { className: 'sl-st-dirty', title: '当前文件有未保存的修改（Ctrl+S 保存）' }, '● 已修改') : null,
        highlight !== null ? h('span', {
          className: 'sl-st-highlight',
          title: '当前高亮的词（Shift+F8 取消）',
          onClick: () => toggleHighlight(highlight.word),
        }, `高亮 ${highlight.word} · ${highlight.count}`) : null,
        flash !== null
          ? h('span', { className: `sl-st-file flash ${flash.kind}`, title: flash.text }, flash.text)
          : h('span', { className: 'sl-st-file', title: activeTab?.path ?? rootInfo?.root ?? '' }, statusPath),
        h('span', { className: 'sl-st-spacer' }),
        h('span', { className: 'sl-st-hint' }, hint !== null ? hint.text : 'Alt+← 返回 · Alt+→ 前进'),
      );

      const conflictBanner = conflict !== null ? h('div', { className: 'sl-banner' },
        h('div', { className: 'sl-banner-text' },
          h('div', { className: 'sl-banner-title' },
            conflict.missing ? t('conflictMissing') : t('conflictTitle')),
          h('div', { className: 'sl-banner-hint' }, t('conflictHint')),
        ),
        h('div', { className: 'sl-banner-actions' },
          conflict.missing !== true ? h('button', {
            type: 'button', className: 'sl-btn',
            onClick: () => void reloadTab(conflict.path),
          }, t('reload')) : null,
          h('button', {
            type: 'button', className: 'sl-btn primary',
            onClick: () => void saveActive(true),
          }, t('overwrite')),
          h('button', {
            type: 'button', className: 'sl-icon-btn',
            onClick: () => setConflict(null),
          }, h(Icon, { name: 'close', size: 13 })),
        ),
      ) : null;

      const noticeBanner = notice !== null ? h('div', { className: `sl-banner ${notice.kind === 'error' ? ' error' : ''}` },
        h('div', { className: 'sl-banner-text' }, h('div', { className: 'sl-banner-hint' }, notice.text)),
        h('button', {
          type: 'button', className: 'sl-icon-btn',
          onClick: () => setNotice(null),
        }, h(Icon, { name: 'close', size: 13 })),
      ) : null;

      const infoBanner = infoError !== null ? h('div', { className: 'sl-banner error' },
        h('div', { className: 'sl-banner-text' }, h('div', { className: 'sl-banner-hint' }, infoError)),
        h('div', { className: 'sl-banner-actions' },
          h('button', {
            type: 'button', className: 'sl-btn',
            onClick: () => setInfoReload((value) => value + 1),
          }, t('retry')),
        ),
      ) : null;

      const progress = indexInfo?.progress;
      const indexPctBuild = progress?.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
      const indexEtaText = (() => {
        if (!progress) return '索引期间可以继续阅读';
        if (progress.phase === 'write') return '正在写入索引，请稍候';
        if (progress.phase === 'macros') return '正在收集宏定义…';
        if (progress.phase === 'scan') {
          return progress.found > 0 ? `已发现 ${Number(progress.found).toLocaleString('en-US')} 个文件` : '正在扫描目录…';
        }
        const done = Number(progress.done) || 0;
        const total = Number(progress.total) || 0;
        const elapsed = Number(progress.phaseElapsedMs) || 0;
        if (done > 0 && total > done && elapsed >= 3000 && done / total >= 0.05) {
          return formatEta((elapsed / done) * (total - done));
        }
        return '索引期间可以继续阅读';
      })();
      const phaseText = progress?.phase === 'scan' ? '扫描文件'
        : progress?.phase === 'macros' ? '收集宏定义'
          : progress?.phase === 'parse' ? '解析符号'
          : progress?.phase === 'write' ? '写入索引'
            : progress?.phase === 'done' ? '完成'
              : progress?.phase === 'failed' ? '失败'
                : '建立索引';
      const indexPanelInfo = indexPanelOpen
        ? (indexInfo?.building === true ? indexInfo : (indexPanelFinal ?? indexInfo))
        : null;
      const indexPanelPhase = (() => {
        if (!indexPanelInfo) return '';
        if (indexPanelInfo.building === true) return indexPanelInfo.progress?.phase || 'scan';
        const finalPhase = indexPanelInfo.progress?.phase;
        if (finalPhase === 'canceled') return 'canceled';
        if (finalPhase === 'failed') return 'failed';
        if (indexPanelInfo.built === true) return 'done';
        return 'failed';
      })();
      const indexPanelProgress = indexPanelInfo?.progress ?? {};
      const indexPanelTotal = Number(indexPanelProgress.total) || 0;
      const indexPanelDone = Number(indexPanelProgress.done) || 0;
      const indexPanelPct = (indexPanelPhase === 'parse' || indexPanelPhase === 'macros') && indexPanelTotal > 0
        ? Math.min(100, Math.round((indexPanelDone / indexPanelTotal) * 100))
        : (indexPanelPhase === 'done' ? 100 : 0);
      const indexPanelTitle = {
        scan: '扫描目录',
        macros: '预扫描宏定义',
        parse: '解析文件',
        write: '写入索引',
        done: '索引完成',
        canceled: '已取消',
        failed: '建立索引失败',
      }[indexPanelPhase] ?? '建立索引';
      const indexPanelStats = (() => {
        if (!indexPanelInfo) return '';
        if (indexPanelPhase === 'scan') {
          return `已发现 ${Number(indexPanelProgress.found || 0).toLocaleString('en-US')} 个文件`;
        }
        if (indexPanelPhase === 'macros') {
          return `${indexPanelDone.toLocaleString('en-US')} / ${indexPanelTotal.toLocaleString('en-US')} 个文件`;
        }
        if (indexPanelPhase === 'parse') {
          return `${indexPanelDone.toLocaleString('en-US')} / ${indexPanelTotal.toLocaleString('en-US')} 个文件`;
        }
        if (indexPanelPhase === 'write') return `${indexPanelTotal.toLocaleString('en-US')} 个文件`;
        if (indexPanelPhase === 'done') {
          return `${indexPanelTotal.toLocaleString('en-US')} / ${indexPanelTotal.toLocaleString('en-US')} 个文件`;
        }
        if (indexPanelPhase === 'canceled') return '索引已取消';
        return indexPanelInfo.progress?.message || indexPanelInfo.error || '建立索引失败';
      })();
      const indexPanelRows = indexPanelPhase === 'scan'
        ? (indexPanelProgress.scanDir ? [{ dir: indexPanelProgress.scanDir }] : [])
        : (indexPanelPhase === 'parse' && Array.isArray(indexPanelProgress.active)
          ? indexPanelProgress.active.slice(0, 7)
          : []);
      const indexPanelEta = (() => {
        if (indexPanelPhase === 'parse') {
          const elapsed = Number(indexPanelProgress.phaseElapsedMs) || 0;
          if (indexPanelDone > 0 && indexPanelTotal > indexPanelDone
            && elapsed >= 3000 && indexPanelDone / indexPanelTotal >= 0.05) {
            return formatEta((elapsed / indexPanelDone) * (indexPanelTotal - indexPanelDone));
          }
          return '索引期间可以继续阅读';
        }
        if (indexPanelPhase === 'write') return '正在写入索引，请稍候';
        if (indexPanelPhase === 'done') {
          const ms = Number(indexPanelInfo?.elapsedMs) || 0;
          return ms > 0 ? `用时约 ${Math.max(1, Math.round(ms / 1000))} 秒` : '';
        }
        return '';
      })();
      const indexPanel = indexPanelInfo ? h('div', {
        className: 'sl-index-panel',
        role: 'dialog',
        'aria-label': '索引进度',
        style: indexPanelPos
          ? { left: `${indexPanelPos.left}px`, top: `${indexPanelPos.top}px`, transform: 'none' }
          : undefined,
      },
      h('div', {
        className: 'sl-index-head',
        title: '拖动面板',
        onPointerDown: startIndexPanelDrag,
      },
      h('span', {
        className: `sl-index-spinner${indexPanelInfo.building === true ? '' : ' idle'}`,
        'aria-hidden': true,
      }),
      h('span', { className: `sl-index-title phase-${indexPanelPhase}` }, indexPanelTitle),
      h('span', { className: 'sl-index-pct' },
        indexPanelPhase === 'parse' ? `${indexPanelPct}%` : (indexPanelPhase === 'done' ? '100%' : '')),
      ),
      h('div', { className: 'sl-index-bar' }, h('div', {
        className: `sl-index-fill${indexPanelPhase === 'scan' || indexPanelPhase === 'write' ? ' indeterminate' : ''}`,
        style: { width: `${indexPanelPct}%` },
      })),
      h('div', { className: 'sl-index-stats' }, indexPanelStats),
      indexPanelRows.length > 0 ? h('div', { className: 'sl-index-active' },
        indexPanelRows.map((row, index) => h('div', { key: index, className: 'sl-index-active-row' },
          h('span', { className: 'sl-index-active-dir' },
            typeof row === 'string' ? row : String(row?.dir ?? row?.file ?? row?.rel ?? row?.name ?? '')),
          row && typeof row === 'object' && row.files
            ? h('span', { className: 'sl-index-active-n' }, String(row.files))
            : null,
        )),
      ) : null,
      h('div', { className: 'sl-index-foot' },
        h('span', { className: 'sl-index-eta' }, indexPanelEta),
        h('button', {
          type: 'button',
          className: 'sl-btn',
          disabled: indexPanelPhase === 'write'
            || indexPanelPhase === 'done'
            || indexPanelPhase === 'canceled'
            || indexPanelPhase === 'failed'
            || indexCancelRequested,
          onClick: () => { setIndexCancelRequested(true); void cancelIndex(); },
        }, indexCancelRequested ? '正在取消…' : '取消'),
      ),
      ) : null;

      const indexConfirmDialog = indexConfirm ? h('div', {
        className: 'sl-overlay',
        role: 'presentation',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) setIndexConfirm(false);
        },
      },
      h('div', { className: 'sl-about', role: 'dialog', 'aria-modal': 'true', 'aria-label': '刷新索引' },
        h('div', { className: 'sl-about-head' },
          h('div', { className: 'sl-about-brand', style: { fontSize: '17px' } }, '刷新索引'),
          h('button', {
            type: 'button', className: 'sl-icon-btn', title: '关闭',
            onClick: () => setIndexConfirm(false),
          }, h(Icon, { name: 'close', size: 14 })),
        ),
        h('p', { className: 'sl-about-lead' },
          `将重新解析 ${Number(indexInfo?.fileCount || 0).toLocaleString('en-US')} 个文件`
          + `（上次用时约 ${Math.max(1, Math.round(Number(indexInfo?.elapsedMs || 0) / 1000))} 秒）。`),
        h('p', { className: 'sl-about-note' }, '索引期间软件仍可使用；最后的写入阶段不能取消。'),
        h('div', { className: 'sl-about-actions' },
          h('button', { type: 'button', className: 'sl-btn', onClick: () => setIndexConfirm(false) }, '取消'),
          h('button', {
            type: 'button', className: 'sl-btn primary',
            onClick: () => { setIndexConfirm(false); void startIndex(true); },
          }, '开始刷新'),
        ),
      )) : null;

      const hostVersions = rootInfo?.versions ?? {};
      const chromiumVersion = hostVersions.chrome
        || (/Chromium\/([\d.]+)/u.exec(navigator.userAgent || '') || [])[1]
        || '';
      const hostVersionText = [
        hostVersions.electron ? `Electron ${hostVersions.electron}` : '',
        chromiumVersion ? `Chromium ${chromiumVersion}` : '',
        hostVersions.node ? `Node ${hostVersions.node}` : '',
      ].filter(Boolean).join(' · ');
      const about = aboutOpen ? h('div', {        className: 'sl-overlay',
        role: 'presentation',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) setAboutOpen(false);
        },
      },
      h('div', { className: 'sl-about', role: 'dialog', 'aria-modal': 'true', 'aria-label': '关于 SourceLook' },
        h('div', { className: 'sl-about-head' },
          h('div', { className: 'sl-about-brand' },
            h('span', { className: 'sl-brand-hot' }, 'S'),
            h('span', { className: 'sl-brand-word' }, 'ource '),
            h('span', { className: 'sl-brand-hot green' }, 'L'),
            h('span', { className: 'sl-brand-word' }, 'ook'),
          ),
          h('button', {
            type: 'button', className: 'sl-icon-btn', title: '关闭',
            onClick: () => setAboutOpen(false),
          }, h(Icon, { name: 'close', size: 14 })),
        ),
        h('p', { className: 'sl-about-lead' }, 'KernelSight 风格的离线代码阅读器，跑在 DeepSeek Harness 的浮层里。'),
        h('dl', { className: 'sl-about-facts' },
          h('dt', {}, '插件版本'), h('dd', {}, `${PLUGIN_VERSION} · ${BUILD_TAG}`),
          h('dt', {}, '编辑器'), h('dd', {}, 'Monaco · tree-sitter 索引'),
          h('dt', {}, '快捷键'), h('dd', {}, `符号搜索 ${symbolSearchShortcutLabel()} · 定义 F12 / Ctrl+点击 · 引用 Shift+F12`),
          h('dt', {}, '模式'), h('dd', {}, 'P 全窗 · C 与 DSH 并排 · D 回到 DSH'),
        ),
        h('p', { className: 'sl-about-note' }, '当前窗口的源码、索引和草稿都留在本机；索引缓存写入插件 data/index。'),
        h('div', { className: 'sl-about-actions' },
          h('button', { type: 'button', className: 'sl-btn primary', onClick: () => setAboutOpen(false) }, '知道了'),
        ),
      )) : null;

      const menuWordKind = editorMenu?.word
        ? (outlineData.symbols.find((symbol) => symbol.name === editorMenu.word)?.kind ?? '')
        : '';
      const editorMenuItems = editorMenu === null ? [] : [
        {
          label: '查找',
          disabled: editorMenu.word === '',
          action: () => { void searchCodeRef.current?.(editorMenu.word); },
        },
        {
          label: '调用',
          shortcut: 'Shift+F12',
          disabled: editorMenu.word === '',
          action: () => { void findReferencesRef.current?.(editorMenu.word, { line: editorMenu.line, column: editorMenu.column }); },
        },
        {
          label: '定义',
          shortcut: 'F12',
          disabled: editorMenu.word === '',
          action: () => { void gotoDefinitionRef.current?.(editorMenu.word, { line: editorMenu.line, column: editorMenu.column }); },
        },
        {
          label: highlight?.word === editorMenu.word ? '取消高亮' : '高亮',
          shortcut: 'Shift+F8',
          disabled: editorMenu.word === '',
          action: () => { toggleHighlight(editorMenu.word); },
        },
        {
          label: 'AI',
          action: () => {
            if (editorMenu.word) openAi('explain', editorMenu.word);
            else openAi('explain', '');
          },
        },        macroReady ? {
          label: '展开',
          action: () => { void showMacroAt(editorMenu.word, editorMenu.line, editorMenu.column ?? 1); },
        } : null,
        { sep: true },
        {
          label: '显示上下文',
          disabled: editorMenu.word === '',
          action: () => { void showContextRef.current?.(editorMenu.word); },
        },
        {
          label: '选中整个函数',
          action: () => selectFunction(editorMenu.line),
        },
        { sep: true },
        {
          label: '打开对应文件（.c/.h）',
          action: () => { void openCounterpart(); },
        },
        {
          label: '打开 #include 的头文件',
          action: () => { void openInclude(editorMenu.line); },
        },
        {
          label: '谁引用了这个头文件',
          action: () => { void findIncludeUsers(editorMenu.line); },
        },
        { sep: true },
        {
          label: '复制',
          action: () => { void copySelectionOrLine(); },
        },
        {
          label: '复制（带位置）',
          action: () => { void copyWithLocation(); },
        },
        {
          label: '复制名称',
          disabled: editorMenu.word === '',
          action: () => { void copyText(editorMenu.word, `已复制 ${editorMenu.word}`); },
        },
        { sep: true },
        {
          label: '转成十六进制',
          action: () => convertNumber(16),
        },
        {
          label: '转成十进制',
          action: () => convertNumber(10),
        },
      ];


      const themeName = { light: '浅色', dark: '深色', sepia: '羊皮纸', mint: '薄荷', graphite: '石墨' }[activeTheme] ?? activeTheme;
      const projectPanel = projectOpen ? h('div', {
        className: 'sl-overlay',
        role: 'presentation',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) setProjectOpen(false);
        },
      },
      h('div', {
        className: 'sl-about sl-project-browser',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '选择项目目录',
      },
      h('div', { className: 'sl-about-head' },
        h('div', { className: 'sl-about-brand', style: { fontSize: '17px' } }, '选择项目目录'),
        h('button', {
          type: 'button', className: 'sl-icon-btn', title: '关闭',
          onClick: () => setProjectOpen(false),
        }, h(Icon, { name: 'close', size: 14 })),
      ),
      h('p', { className: 'sl-about-lead' },
        '选一个本地文件夹作为项目根目录；切换后标签页、索引、文件树都按新工程重新加载，DSH 会话工作区不变。'),
      h('div', { className: 'sl-dir-top' },
        h('button', {
          type: 'button', className: 'sl-btn',
          disabled: dirParent === '' || dirLoading,
          onClick: () => { void loadDir(dirParent); },
        }, '上一级'),
        h('button', {
          type: 'button', className: 'sl-btn',
          disabled: dirLoading,
          onClick: () => { void loadDir(''); },
        }, '主目录'),
        h('button', {
          type: 'button', className: 'sl-btn',
          disabled: dirLoading,
          onClick: () => { void loadDir(dirPath); },
        }, '刷新'),
      ),
      h('div', { className: 'sl-dir-path', title: dirPath }, dirPath || projectPath || '（未选择）'),
      dirLoading ? h('div', { className: 'sl-results-state' }, '正在读取…') : null,
      dirError ? h('div', { className: 'sl-results-state sl-error' }, dirError) : null,
      h('div', { className: 'sl-dir-list' },
        dirDrives.length > 0 ? h('div', { className: 'sl-dir-drives' },
          dirDrives.map((drive) => h('button', {
            key: drive,
            type: 'button',
            className: 'sl-dir-drive',
            onClick: () => { void loadDir(drive); },
          }, drive)),
        ) : null,
        dirDirs.map((name) => h('button', {
          key: name,
          type: 'button',
          className: 'sl-dir-row',
          onClick: () => {
            const base = dirPath.replace(/[\\/]+$/u, '');
            void loadDir(`${base}/${name}`);
          },
        },
        h(Icon, { name: 'folder', size: 14 }),
        h('span', {}, name),
        )),
        !dirLoading && dirDirs.length === 0 && dirDrives.length === 0
          ? h('div', { className: 'sl-dir-empty' }, '这个目录下没有子目录')
          : null,
      ),
      h('input', {
        className: 'sl-project-input',
        value: projectPath,
        spellCheck: false,
        placeholder: '也可以直接输入绝对路径，回车打开',
        'aria-label': '项目根目录',
        onChange: (event) => setProjectPath(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void openProjectDir();
          }
        },
      }),
      projectError ? h('p', { className: 'sl-results-state sl-error' }, projectError) : null,
      h('div', { className: 'sl-about-actions' },
        h('button', {
          type: 'button', className: 'sl-btn',
          disabled: projectBusy,
          onClick: () => { void resetProjectDir(); },
        }, '回到会话工作区'),
        h('button', { type: 'button', className: 'sl-btn', onClick: () => setProjectOpen(false) }, '取消'),
        h('button', {
          type: 'button', className: 'sl-btn primary',
          disabled: projectBusy || projectPath.trim() === '',
          onClick: () => { void openProjectDir(); },
        }, projectBusy ? '打开中…' : '打开此项目'),
      ),
      )) : null;

      const colorPanel = colorPanelOpen ? h('div', {
        className: 'sl-overlay',
        role: 'presentation',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) setColorPanelOpen(false);
        },
      },
      h('div', { className: 'sl-about sl-color-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': '自定义代码配色' },
        h('div', { className: 'sl-about-head' },
          h('div', { className: 'sl-about-brand', style: { fontSize: '17px' } }, `代码配色 · ${themeName}`),
          h('button', {
            type: 'button', className: 'sl-icon-btn', title: '关闭',
            onClick: () => setColorPanelOpen(false),
          }, h(Icon, { name: 'close', size: 14 })),
        ),
        h('p', { className: 'sl-about-lead' }, '改色立即生效，按主题分别记住；只影响 SourceLook 里的代码高亮。'),
        h('div', { className: 'sl-color-rows' },
          colorChoices.map((choice) => h('label', { key: choice.key, className: 'sl-color-row' },
            h('span', { className: 'sl-color-label' }, choice.label),
            h('input', {
              type: 'color',
              value: themeColors[choice.key] || choice.fallback,
              onChange: (event) => setThemeColor(choice.key, event.target.value),
            }),
            h('span', { className: 'sl-color-hex' }, themeColors[choice.key] || choice.fallback),
          )),
        ),
        h('div', { className: 'sl-about-actions' },
          h('button', {
            type: 'button', className: 'sl-btn',
            onClick: () => setColors((previous) => {
              const next = { ...previous };
              delete next[activeTheme];
              return next;
            }),
          }, '恢复当前主题默认'),
          h('button', { type: 'button', className: 'sl-btn primary', onClick: () => setColorPanelOpen(false) }, '完成'),
        ),
      )) : null;

      const enhancePanel = enhanceOpen ? h('div', {
        className: 'sl-overlay',
        role: 'presentation',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) setEnhanceOpen(false);
        },
      },
      h('div', { className: 'sl-about sl-enhance-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': '解析与增强' },
        h('div', { className: 'sl-about-head' },
          h('div', { className: 'sl-about-brand', style: { fontSize: '17px' } }, '解析与增强'),
          h('button', {
            type: 'button', className: 'sl-icon-btn', title: '关闭',
            onClick: () => setEnhanceOpen(false),
          }, h(Icon, { name: 'close', size: 14 })),
        ),
        h('p', { className: 'sl-about-lead' }, '工具自动增强在建立索引时顺带完成；AI 增强/配置预演后续接入 DSH。'),
        enhanceError !== null ? h('p', { className: 'sl-results-state sl-error' }, enhanceError) : null,
        enhanceData === null && enhanceError === null ? h('p', { className: 'sl-results-state' }, '读取中…') : null,
        enhanceData !== null ? h('dl', { className: 'sl-about-facts' },
          h('dt', {}, 'L1 符号索引'), h('dd', {}, enhanceData.l1 === true || enhanceData.l1?.ready === true ? '已就绪' : '未启用'),
          h('dt', {}, 'L2 编译配置'), h('dd', {},
            enhanceData.l2?.ready === true
              ? `${enhanceData.l2.source ?? '配置'} · ${enhanceData.l2.files ?? 0} 个单元 · ${enhanceData.l2.defines ?? 0} 个 -D${enhanceData.l2.hasConfig === true ? ' · 有 .config' : ''}`
              : '未启用'),
          h('dt', {}, 'L3 二进制类型'), h('dd', {},
            enhanceData.l3?.ready === true
              ? `${enhanceData.l3.source ?? 'BTF'} · ${enhanceData.l3.types ?? 0} 类型 / ${enhanceData.l3.structs ?? 0} 结构 / ${enhanceData.l3.functions ?? 0} 函数`
              : '未启用'),
          h('dt', {}, 'L4 增强包'), h('dd', {},
            enhanceData.l4?.ready === true
              ? `v${enhanceData.l4.version ?? '?'} · ${enhanceData.l4.id ?? '已应用'}${enhanceData.l4.errors > 0 ? ` · ${enhanceData.l4.errors} 条规则被拒` : ''}`
              : '未应用'),
          h('dt', {}, '索引'), h('dd', {}, indexInfo?.built === true
            ? `${Number(indexInfo.symbolCount || 0).toLocaleString('en-US')} 符号 / ${Number(indexInfo.fileCount || 0).toLocaleString('en-US')} 文件${indexInfo.stale === true ? ' · 已过期' : ''}`
            : '未建立'),
          h('dt', {}, '引擎'), h('dd', {}, indexInfo?.engine ?? 'tree-sitter'),
          h('dt', {}, '宿主'), h('dd', {}, hostVersionText || '未知'),
          h('dt', {}, '构建'), h('dd', {}, BUILD_TAG),
        ) : null,
        h('div', { className: 'sl-about-actions', style: { marginTop: '8px' } },
          h('button', {
            type: 'button', className: 'sl-btn',
            disabled: enhanceBusy,
            onClick: () => { void loadEnhanceReport(); },
          }, enhanceBusy ? '生成中…' : '生成解析报告'),
          h('button', {
            type: 'button', className: 'sl-btn',
            disabled: enhanceBusy,
            title: '写到 <项目>/.kernelscope/report.txt，供 AI / Agent 直接读取',
            onClick: () => { void exportEnhanceReport(); },
          }, '导出到 .kernelscope/'),
        ),
        enhanceReport?.error ? h('p', { className: 'sl-results-state sl-error' }, enhanceReport.error) : null,
        enhanceReport?.text
          ? h(Fragment, null,
            h('p', { className: 'sl-about-note' },
              `共 ${Number(enhanceReport.count || 0).toLocaleString('en-US')} 处未看懂 · ${Number(enhanceReport.kinds || 0)} 类`
              + `${enhanceReport.scanned === false ? '（旧索引，建议重建）' : ''}`
              + `${enhanceReport.path ? ` · 已写入 ${enhanceReport.path}` : ''}`),
            h('textarea', {
              className: 'sl-ai-text',
              readOnly: true,
              spellCheck: false,
              value: enhanceReport.text,
              'aria-label': '解析报告',
              style: { height: '240px', flex: 'none' },
            }),
          )
          : null,
        h('p', { className: 'sl-about-note' },
          '增强包配置（ks-enhance/2 JSON）：粘贴后先「预演」看效果，再「应用并重建索引」。'),
        h('div', { className: 'sl-ai-library' },
          h('span', { className: 'sl-ai-library-label' }, '提示词库'),
          h('select', {
            value: aiPromptChoice,
            onChange: (event) => {
              const id = event.target.value;
              setAiPromptChoice('');
              if (id !== '') applyAiPrompt(id);
            },
          },
          h('option', { value: '' }, '选择一条…'),
          AI_PROMPT_LIBRARY.map((item) => h('option', { key: item.id, value: item.id }, item.label)),
          ),
        ),        h('textarea', {
          className: 'sl-ai-text',
          value: enhanceConfig,
          spellCheck: false,
          placeholder: '{ "schema": "ks-enhance/2", "macros": [ { "name": "…", "declare": 0 } ] }',
          'aria-label': '增强包配置',
          onChange: (event) => setEnhanceConfig(event.target.value),
          style: { height: '140px', flex: 'none', marginTop: '4px' },
        }),
        h('div', { className: 'sl-about-actions', style: { marginTop: '6px' } },
          h('button', {
            type: 'button', className: 'sl-btn',
            disabled: enhanceBusy || enhanceConfig.trim() === '',
            onClick: () => { void previewEnhancePack(); },
          }, enhanceBusy ? '处理中…' : '预演'),
          h('button', {
            type: 'button', className: 'sl-btn primary',
            disabled: enhanceBusy || enhanceConfig.trim() === '',
            title: '写入 <项目>/.kernelscope/enhance.json 并重建索引',
            onClick: () => { void applyEnhancePack(); },
          }, '应用并重建索引'),
        ),
        enhancePreview !== null ? h('div', { className: 'sl-enh-preview' },
          h('div', { className: 'sl-about-note' },
            enhancePreview.ok === false
              ? '预演失败'
              : `预演：取样 ${enhancePreview.sampled ?? 0}/${enhancePreview.totalFiles ?? 0} 个文件 · +${enhancePreview.added ?? 0} / -${enhancePreview.removed ?? 0} 个符号 · 影响 ${enhancePreview.changed ?? 0} 个文件`
              + `${enhancePreview.path ? ` · 目标 ${enhancePreview.path}` : ''}`),
          (Array.isArray(enhancePreview.errors) && enhancePreview.errors.length > 0)
            ? h('div', { className: 'sl-results-state sl-error' }, enhancePreview.errors.join('；'))
            : null,
          (Array.isArray(enhancePreview.audit) && enhancePreview.audit.length > 0)
            ? h('div', { className: 'sl-results-state sl-error' }, `体检：${enhancePreview.audit.join('；')}`)
            : null,
          (Array.isArray(enhancePreview.samples) && enhancePreview.samples.length > 0)
            ? h('div', { className: 'sl-enh-samples' }, enhancePreview.samples.map((sample, index) => h('div', {
              key: index,
              className: 'sl-enh-sample',
              title: sample?.file ?? '',
            }, `${sample?.op ?? ''} ${sample?.text ?? ''}  ${sample?.file ?? ''}`)))
            : null,
        ) : null,
        h('div', { className: 'sl-about-actions' },
          h('button', {
            type: 'button', className: 'sl-btn',
            onClick: () => { setEnhanceOpen(false); void startIndex(); },
          }, '重建索引'),
          h('button', { type: 'button', className: 'sl-btn primary', onClick: () => setEnhanceOpen(false) }, '关闭'),
        ),
      )) : null;

      const aiPanel = aiOpen ? h('aside', { className: 'sl-ai-panel', 'aria-label': 'AI 助手' },
        h('div', { className: 'sl-ai-head' },
          h('span', { className: 'sl-ai-title' }, 'AI 助手'),
          h('span', { className: 'sl-ai-model', title: aiConfig.model || '(未设模型)' }, aiConfig.model || '(未设模型)'),
          h('button', {
            type: 'button',
            className: `sl-icon-btn tiny${aiShowConfig ? ' active' : ''}`,
            title: '模型设置',
            onClick: () => setAiShowConfig((value) => !value),
          }, '⚙'),
          h('button', {
            type: 'button', className: 'sl-icon-btn', title: '关闭',
            onClick: () => setAiOpen(false),
          }, h(Icon, { name: 'close', size: 13 })),
        ),
        aiShowConfig ? h('div', { className: 'sl-ai-config' },
          h('label', { className: 'sl-ai-field' },
            h('span', {}, '来源'),
            h('select', {
              value: aiConfig.provider,
              onChange: (event) => switchAiProvider(event.target.value),
            },
            h('option', { value: 'local' }, '本地 Ollama'),
            h('option', { value: 'remote' }, 'OpenAI 兼容 API'),
            ),
          ),
          h('label', { className: 'sl-ai-field' },
            h('span', {}, 'Base URL'),
            h('input', {
              value: aiConfig.baseUrl,
              spellCheck: false,
              onChange: (event) => setAiConfig((previous) => ({ ...previous, baseUrl: event.target.value })),
            }),
          ),
          h('label', { className: 'sl-ai-field' },
            h('span', {}, '模型'),
            h('div', { className: 'sl-ai-modelrow' },
              h('input', {
                value: aiConfig.model,
                list: 'sl-ai-models',
                spellCheck: false,
                onChange: (event) => setAiConfig((previous) => ({ ...previous, model: event.target.value })),
              }),
              h('button', {
                type: 'button', className: 'sl-icon-btn tiny', title: '从服务读取可用模型',
                onClick: () => { void refreshAiModels(true); },
              }, h(Icon, { name: 'refresh', size: 12 })),
            ),
          ),
          h('label', { className: 'sl-ai-field' },
            h('span', {}, 'API Key'),
            h('input', {
              type: 'password',
              value: aiConfig.apiKey,
              spellCheck: false,
              placeholder: '留空则不发送 Authorization',
              onChange: (event) => setAiConfig((previous) => ({ ...previous, apiKey: event.target.value })),
            }),
          ),
          h('p', { className: 'sl-ai-note' }, 'Key 只留在本机 localStorage，并按请求转发；不会写到工程里。'),
          h('div', { className: 'sl-ai-actions', style: { marginTop: '2px' } },
            h('button', {
              type: 'button', className: 'sl-btn',
              disabled: aiLog.length === 0,
              onClick: () => setAiLog([]),
            }, '清空记录'),
          ),
        ) : null,
        h('div', { className: 'sl-ai-log', ref: aiLogRef },
          aiLog.length === 0
            ? h('div', { className: 'sl-ai-empty' }, '问点什么吧。发送时会自动带上当前光标附近的代码。')
            : aiLog.map((entry, index) => h('div', { key: index, className: `sl-ai-msg ${entry.role}` },
              h('div', { className: 'sl-ai-msg-head' },
                entry.role === 'user' ? '你' : (entry.role === 'ai' ? `AI · ${entry.model || ''}` : '错误')),
              h('div', { className: 'sl-ai-msg-body' }, entry.text),
              )),
          aiBusy ? h('div', { className: 'sl-ai-msg ai pending' }, '思考中…') : null,
        ),
        h('div', { className: 'sl-ai-kinds' },
          h('button', { type: 'button', className: 'sl-btn', onClick: () => openAi('usage', aiWord) }, '解释用途'),
          h('button', { type: 'button', className: 'sl-btn', onClick: () => openAi('explain', aiWord) }, '解释逻辑'),
          h('button', { type: 'button', className: 'sl-btn', onClick: () => openAi('risk', aiWord) }, '风险点'),
          h('button', { type: 'button', className: 'sl-btn', onClick: () => openAi('bugs', aiWord) }, '找 bug'),
          h('button', { type: 'button', className: 'sl-btn', onClick: () => openAi('flow', aiWord) }, '整段流程'),
          h('button', { type: 'button', className: 'sl-btn', onClick: () => openAi('macro', aiWord) }, '展开宏'),
          h('button', { type: 'button', className: 'sl-btn', onClick: () => openAi('callers', aiWord) }, '谁调用了它'),
          h('button', { type: 'button', className: 'sl-btn', onClick: () => openAi('file', aiWord) }, '导读本文件'),
          h('button', { type: 'button', className: 'sl-btn', onClick: () => openAi('comment', aiWord) }, '加注释'),
        ),
        h('textarea', {
          className: 'sl-ai-text',
          value: aiText,
          spellCheck: false,
          placeholder: '提示词（可编辑）… Ctrl+Enter 发送',
          'aria-label': 'AI 提示词',
          onChange: (event) => setAiText(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void askAi();
            }
          },
        }),
        h('p', { className: 'sl-ai-note' },
          `当前提供方：${aiConfig.provider === 'local' ? '本地 Ollama' : 'OpenAI 兼容 API'}`
          + `${aiConfig.model ? ` · ${aiConfig.model}` : ''}。发送只在你点按钮/按 Ctrl+Enter 时发生。`),
        h('div', { className: 'sl-ai-actions' },
          h('button', {
            type: 'button', className: 'sl-btn primary',
            disabled: aiBusy || aiText.trim() === '',
            onClick: () => { void askAi(); },
          }, aiBusy ? '思考中…' : '发送'),
          h('button', { type: 'button', className: 'sl-btn', onClick: () => void copyAiText() }, '复制提示词'),
          h('button', {
            type: 'button', className: 'sl-btn', title: '把提示词作为当前 DSH 会话的一条消息发出去',
            onClick: () => void sendAiToDsh(),
          }, '发送到 DSH'),
        ),
        h('datalist', { id: 'sl-ai-models' }, aiModels.map((id) => h('option', { key: id, value: id }))),
      ) : null;



      const projectMenu = projectMenuOpen ? h('div', {
        className: 'sl-proj-menu',
        role: 'menu',
        'aria-label': '项目',
        style: { left: `${projectMenuPos.left}px`, top: `${projectMenuPos.top}px` },
        onMouseDown: (event) => event.stopPropagation(),
      },
      h('button', {
        type: 'button', className: 'sl-proj-act',
        onClick: () => { void pickLocalProject(); },
      }, '本地目录…'),
      h('button', {
        type: 'button', className: 'sl-proj-act',
        onClick: () => {
          setProjectMenuOpen(false);
          flashHint('远程目录暂未移植（当前只支持本地项目）', 'error');
        },
      }, '远程目录…', h('span', { className: 'sl-proj-accel' }, 'Ctrl+Shift+O')),
      /* 索引入口之二：项目图标的菜单里也能建/刷新索引，文字带状态色。 */
      h('button', {
        type: 'button',
        className: `sl-proj-act idx-${indexState}`,
        disabled: indexBusy === true,
        onClick: () => {
          setProjectMenuOpen(false);
          if (indexInfo?.building === true) void cancelIndex();
          else void startIndex();
        },
      },
      indexState === 'building' ? '取消索引' : (indexState === 'ready' ? '刷新索引' : '创建索引'),
      h('span', { className: `sl-proj-accel idx-${indexState}` },
        indexState === 'building' ? '索引中…' : (indexState === 'ready' ? '已建索引' : '未建索引'))),
      h('div', { className: 'sl-proj-sep' }),
      h('div', { className: 'sl-proj-sect' }, '最近项目'),
      recentProjects.length === 0
        ? h('div', { className: 'sl-proj-empty' }, '还没有打开过项目')
        : null,
      recentProjects.slice(0, showAllProjects ? 30 : 8).map((item) => h('div', {
        key: item,
        className: 'sl-proj-row',
        title: item,
        role: 'button',
        tabIndex: 0,
        onClick: () => {
          setProjectMenuOpen(false);
          void openProjectPath(item);
        },
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setProjectMenuOpen(false);
            void openProjectPath(item);
          }
        },
      },
      h('div', { className: 'sl-proj-body' },
        h('div', { className: 'sl-proj-name' }, item.split(/[\\/]+/u).filter(Boolean).pop() || item),
        h('div', { className: 'sl-proj-path' }, item),
      ),
      h('button', {
        type: 'button',
        className: 'sl-proj-del',
        title: '从最近项目里移除',
        onClick: (event) => {
          event.stopPropagation();
          setRecentProjects((previous) => {
            const next = previous.filter((value) => value !== item);
            writeRecentProjects(next);
            return next;
          });
        },
      }, '×'),
      )),
      recentProjects.length > 8 && !showAllProjects
        ? h('button', {
          type: 'button', className: 'sl-proj-more',
          onClick: () => setShowAllProjects(true),
        }, `显示其余 ${recentProjects.length - 8} 项`)
        : null,
      showAllProjects && recentProjects.length > 8
        ? h('button', {
          type: 'button', className: 'sl-proj-more',
          onClick: () => setShowAllProjects(false),
        }, '收起')
        : null,
      ) : null;
      const pathPopover = pathOpen ? h('div', {
        className: 'sl-path-pop',
        style: { left: `${pathAnchor.left}px`, top: `${pathAnchor.top}px` },
        onMouseDown: (event) => event.stopPropagation(),
      },
      h('div', { className: 'sl-path-pop-head' },
        h('span', { className: 'sl-path-pop-title' }, '项目目录'),
        h('div', { className: 'sl-path-pop-head-actions' },
          h('button', {
            type: 'button',
            className: 'sl-path-copy',
            title: '复制完整路径',
            disabled: (rootInfo?.root ?? '') === '',
            onClick: () => {
              void navigator.clipboard?.writeText(rootInfo?.root ?? '');
              flashHint('已复制路径');
            },
          }, '复制路径'),
          h('button', {
            type: 'button', className: 'sl-icon-btn tiny', title: '关闭',
            onClick: () => setPathOpen(false),
          }, h(Icon, { name: 'close', size: 12 })),
        ),
      ),
      /* 路径 + 索引按钮同一行：按钮贴在路径右边，颜色跟索引状态一致。 */
      h('div', { className: 'sl-path-pop-row' },
        h('div', {
          className: `sl-path-pop-path idx-${indexState}`,
          title: rootInfo?.root ?? '',
        }, rootInfo?.root || '未打开项目'),
        h('button', {
          type: 'button',
          className: `sl-btn idx-btn idx-${indexState}`,
          disabled: indexBusy === true,
          title: indexState === 'ready' ? '重建符号索引' : indexState === 'building' ? '取消当前索引' : '为当前项目建立符号索引',
          onClick: () => {
            setPathOpen(false);
            if (indexInfo?.building === true) void cancelIndex();
            else void startIndex();
          },
        }, indexState === 'building' ? '取消索引' : (indexState === 'ready' ? '刷新索引' : '创建索引')),
      ),
      h('div', { className: 'sl-path-pop-actions' },
        h('button', {
          type: 'button', className: 'sl-btn',
          onClick: () => {
            setPathOpen(false);
            openProjectMenu();
          },
        }, '切换项目目录…'),
        h('button', {
          type: 'button', className: 'sl-btn',
          onClick: () => { setPickerOpen(true); setPathOpen(false); },
        }, '打开文件…'),
      )) : null;


      /* D 模式保留整层挂载（只用 CSS 隐藏），这样编辑器不会被卸载重建。 */
      return h(Fragment, null,
        h('style', { key: 'styles' }, CSS),
        h('div', { key: 'layer', className: `sl-layer mode-${mode}`, 'data-sl-build': BUILD_TAG, 'data-sl-theme': theme === 'auto' ? undefined : theme, style: { ...layerStyle, ...colorVars } },
          topbar,
          h('div', { key: 'content', className: 'sl-content' },
            infoBanner,
            conflictBanner,
            noticeBanner,
            body,
            contextPanel,
            status,
          ),
          indexPanel,
          indexConfirmDialog,
          about,
          projectPanel,
          projectMenu,
          colorPanel,
          enhancePanel,
          pathPopover,
          aiPanel,
          h(SlContextMenu, {
            menu: editorMenu,
            items: editorMenuItems,
            header: editorMenu !== null && editorMenu.word !== ''
              ? `${editorMenu.word} · ${menuWordKind || '符号'}`
              : '',
            onClose: () => setEditorMenu(null),
          }),
          h(SlMacroPop, {
            data: macroPop,
            onClose: () => setMacroPop(null),
            onJump: (file, line) => { setMacroPop(null); void openFileAt(file, line); },
          }),          h(SlFloatActions, {
            bar: floatBar,
            onAction: runFloatAction,
            onClose: () => setFloatBar(null),
          }),
          h(SlResultWindow, {
            win: resultWin,
            preview: resultWinPreview,
            onClose: closeResultWindow,
            onKind: (kind) => { rerunResult(kind, resultWin?.word ?? '', kind === 'find' ? (resultWin?.scope || 'idx') : undefined); },
            onScope: (scope) => { void runFind(scope, resultWin?.word ?? ''); },
            onQuery: (word) => {
              if ((resultWin?.kind ?? 'find') === 'find') { void runFind('idx', word); return; }
              rerunResult(resultWin?.kind ?? 'find', word, resultWin?.scope);
            },
            onOpen: (hit) => { if (hit?.file) void openFileAt(hit.file, hit.line); },
            onSelect: (index, hit) => {
              setResultWin((previous) => (previous ? { ...previous, selected: index } : previous));
              void loadResultPreview(hit);
            },
          }),
          h(FilePicker, {
            open: pickerOpen,
            sessionId,
            rootInfo,
            recent,
            onClose: () => setPickerOpen(false),
            onOpen: (rel) => { void openFileAt(rel, 1); },
            t,
          }),
          h(SymbolSearch, {
            open: symbolOpen,
            query: symbolQuery,
            results: symbolResults,
            loading: symbolLoading,
            error: symbolError,
            needsIndex: symbolNeedsIndex,
            onQuery: setSymbolQuery,
            onSelect: (item) => {
              void openFileAt(item.file, item.line);
              setSymbolOpen(false);
            },
            onClose: () => setSymbolOpen(false),
            t,
          }),
          /* 启动加载页：整窗盖住，就绪瞬间撤掉，整屏一次性到位。 */
          splashVisible ? h('div', {
            key: 'bootSplash',
            className: 'sl-boot-splash',
            role: 'status',
            'aria-live': 'polite',
          },
          h('div', { className: 'sl-boot-spinner', 'aria-hidden': 'true' }),
          h('div', { className: 'sl-boot-splash-text' }, t('bootLoading')),
          typeof rootInfo?.root === 'string' && rootInfo.root !== ''
            ? h('div', { className: 'sl-boot-splash-path', title: rootInfo.root }, rootInfo.root)
            : null,
          ) : null,
        ),
        mode === 'D' ? h('button', {
          key: 'pill',
          type: 'button',
          className: 'sl-pill',
          onClick: () => setMode(lastOpenModeRef.current),
          title: t('openApp'),
          'aria-label': t('openApp'),
        }, h('img', {
          className: 'sl-pill-icon',
          /* 原版 KernelSight 标题栏左侧那张 app 图标（64px 缩放版，随 vendor 静态路由发出）。 */
          src: `${API}/vendor/kernelsight.png`,
          alt: '',
          draggable: false,
        })) : null,
      );
    }
