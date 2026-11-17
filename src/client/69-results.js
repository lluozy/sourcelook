    /* ---------------------------------------------------- bottom context window
     * Three equal cards on the original reader's model: definitions on the left
     * (grouped per file, the definition line shown inline), the code around the
     * selected line in the middle, references on the right (grouped per file).
     * The cards have no title bar; a 10px strip above them resizes the panel and
     * carries the collapse chevron. */

    const CONTEXT_COLS_KEY = 'sourcelook.contextCols.v2';
    const CONTEXT_CHUNK = 16;

    const C_KEYWORDS = new Set([
      'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else',
      'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long', 'register',
      'restrict', 'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch',
      'typedef', 'union', 'unsigned', 'void', 'volatile', 'while', '_Bool', 'bool',
      'asm', '__asm__', '__attribute__', '__inline', '__init', '__exit', 'extern',
      'fn', 'let', 'mut', 'pub', 'impl', 'trait', 'match', 'use', 'mod', 'type', 'where',
      'func', 'defer', 'go', 'chan', 'package', 'import', 'range', 'interface', 'select',
    ]);
    const C_TYPES = new Set([
      'size_t', 'ssize_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint16_t',
      'uint32_t', 'uint64_t', 'u8', 'u16', 'u32', 'u64', 's8', 's16', 's32', 's64',
      'phys_addr_t', 'dma_addr_t', 'resource_size_t', 'irqreturn_t', 'gfp_t', 'uid_t', 'gid_t',
      'off_t', 'pid_t', 'bool', 'FILE',
    ]);

    function cTokenClass(word, rest) {
      if (C_KEYWORDS.has(word)) return 'c-kw';
      if (C_TYPES.has(word) || /^[a-z_]\w*_t$/u.test(word) || /^u(8|16|32|64)$/u.test(word)) return 'c-type';
      if (/^[A-Z][A-Z0-9_]{2,}$/u.test(word)) return 'c-macro';
      if (/^\s*\(/u.test(rest)) return 'c-fn';
      return '';
    }

    function highlightC(text, hitWord = '') {
      const out = [];
      const source = String(text ?? '');
      const trimmed = source.trimStart();
      if (trimmed.startsWith('#')) {
        const match = /^(\s*)(#\s*[a-zA-Z_]+)(.*)$/u.exec(source);
        if (match) {
          out.push(match[1]);
          out.push(h('span', { key: 'pre', className: 'c-pre' }, match[2]));
          out.push(...highlightC(match[3], hitWord));
          return out;
        }
      }
      const re = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(0x[0-9a-fA-F]+|\b\d+(?:\.\d+)?[uUlLfF]*\b)|([A-Za-z_]\w*)|(\s+)|([^\sA-Za-z_0-9]+)/gu;
      let match;
      let index = 0;
      while ((match = re.exec(source)) !== null) {
        const [token, comment, string, number, word] = match;
        let cls = '';
        if (comment) cls = 'c-com';
        else if (string) cls = 'c-str';
        else if (number) cls = 'c-num';
        else if (word) {
          const rest = source.slice(match.index + token.length);
          cls = cTokenClass(word, rest);
          if (hitWord !== '' && word === hitWord) {
            out.push(h('span', { key: `h${index}`, className: 'cw-hit' }, word));
            index += 1;
            continue;
          }
        }
        if (cls === '') out.push(token);
        else out.push(h('span', { key: `t${index}`, className: cls }, token));
        index += 1;
      }
      return out;
    }

    const DEF_KIND_LABEL = {
      function: '函数',
      macro: '宏',
      struct: '结构体',
      union: '联合',
      enum: '枚举',
      enum_member: '枚举值',
      typedef: '类型',
      type: '类型',
      class: '类',
      namespace: '命名空间',
      variable: '变量',
      constant: '常量',
      member: '成员',
      field: '成员',
      parameter: '参数',
      local: '局部变量',
      include: '头文件',
    };

    /* Per-kind AI questions for the bottom Context Window (original behaviour:
       a function asks about arguments/returns, a type about fields/usage…).
       Answers accumulate as blocks under the buttons. */
    const CONTEXT_AI_ACTIONS = {
      function: [
        { id: 'what', label: '它做什么', ask: '用两三句话说明这个函数做什么、什么时候会被调用。' },
        { id: 'args', label: '参数与返回值', ask: '逐个说明参数含义与取值范围，以及返回值的含义和错误约定。' },
        { id: 'risk', label: '风险点', ask: '指出这个函数真正的风险点：边界条件、错误路径、并发、资源释放；按严重程度排序。' },
      ],
      type: [
        { id: 'fields', label: '字段含义', ask: '逐个说明这个类型的字段含义、生命周期与所有权。' },
        { id: 'usage', label: '该怎么用', ask: '说明这个类型应该怎么用：初始化、释放、并发约定。' },
        { id: 'risk', label: '风险点', ask: '指出使用这个类型时真正的风险点。' },
      ],
      macro: [
        { id: 'semantics', label: '展开与语义', ask: '说明这个宏展开成什么、参数如何代入、有哪些隐含依赖。' },
        { id: 'risk', label: '风险点', ask: '指出使用这个宏时容易出错的点。' },
      ],
      variable: [
        { id: 'purpose', label: '作用与取值', ask: '说明这个变量的作用、取值范围、生命周期与并发访问约定。' },
        { id: 'risk', label: '风险点', ask: '指出这个变量相关的风险点。' },
      ],
    };
    function definitionLabel(item) {
      const kind = String(item?.kind || '').toLowerCase();
      return DEF_KIND_LABEL[kind] || (kind === '' ? '符号' : kind);
    }

    function groupByFile(items) {
      const groups = [];
      const map = new Map();
      for (const item of items || []) {
        const file = String(item.file || '');
        let group = map.get(file);
        if (group === undefined) {
          group = { file, items: [] };
          map.set(file, group);
          groups.push(group);
        }
        group.items.push(item);
      }
      return groups;
    }

    const readContextCols = () => {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(CONTEXT_COLS_KEY) || 'null');
        if (Array.isArray(parsed) && parsed.length === 2) {
          const left = Number(parsed[0]);
          const right = Number(parsed[1]);
          if (left >= 0.15 && right <= 0.85 && right - left >= 0.15) {
            return { left, right };
          }
        }
      } catch {
        /* ignore */
      }
      return { left: 1 / 3, right: 2 / 3 };
    };
    const writeContextCols = (left, right) => {
      try {
        window.localStorage.setItem(CONTEXT_COLS_KEY, JSON.stringify([left, right]));
      } catch {
        /* ignore */
      }
    };

    const CW_LINE_H = 16;
    const CW_OVERSCAN = 24;

    /* 代码区单独成组件：滚动只重渲染这几十行，不带着左边定义/右边引用一起重排。 */
    function ContextCodePane({ preview, line, word, loadingText, onOpen }) {
      const paneRef = useRef(null);
      const [view, setView] = useState({ start: 1, height: 600 });
      const viewRef = useRef({ start: 1, height: 600 });
      const rafRef = useRef(0);
      const lines = useMemo(
        () => (preview?.content ? String(preview.content).split('\n') : []),
        [preview?.content],
      );
      const total = lines.length;
      const current = Math.max(1, Number(line) || 1);

      useLayoutEffect(() => {
        const pane = paneRef.current;
        if (!pane || total === 0) return undefined;
        const height = pane.clientHeight || 600;
        const target = Math.max(0, (current - 1) * CW_LINE_H - height / 2);
        const start = Math.max(1, Math.floor(target / CW_LINE_H) - CW_OVERSCAN);
        const next = { start, height };
        viewRef.current = next;
        setView(next);
        pane.scrollTop = target;
        const frame = window.requestAnimationFrame(() => { pane.scrollTop = target; });
        return () => window.cancelAnimationFrame(frame);
      }, [preview?.file, current, preview?.content, total]);

      /* 卸载后仍可能有已排队的滚动帧在路上：不取消就会对已卸载组件 setView。 */
      useEffect(() => () => {
        if (rafRef.current) {
          window.cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
        }
      }, []);

      const onScroll = () => {
        if (rafRef.current) return;
        rafRef.current = window.requestAnimationFrame(() => {
          rafRef.current = 0;
          const pane = paneRef.current;
          if (!pane) return;
          const height = pane.clientHeight || 600;
          const start = Math.max(1, Math.floor(pane.scrollTop / CW_LINE_H) - CW_OVERSCAN);
          const previous = viewRef.current;
          const moved = Math.abs(start - previous.start);
          /* 小范围滚动不触发 React：现有 overscan 已经覆盖；跨过缓冲带才换窗口。 */
          if (moved < 10 && height === previous.height) return;
          const next = { start, height };
          viewRef.current = next;
          setView(next);
        });
      };

      let body = null;
      if (preview?.loading === true) {
        body = h('div', { className: 'cw-state' }, loadingText);
      } else if (preview?.error) {
        body = h('div', { className: 'cw-state sl-error' }, preview.error);
      } else if (total > 0) {
        const end = Math.min(total, view.start + Math.ceil((view.height || 600) / CW_LINE_H) + CW_OVERSCAN * 2);
        const rows = [];
        for (let number = view.start; number <= end; number += 1) {
          const text = lines[number - 1];
          if (text === undefined) break;
          const hit = number === current;
          rows.push(h('div', {
            key: `l${number}`,
            className: `cw-line${hit ? ' hit' : ''}`,
            style: { position: 'absolute', top: `${(number - 1) * CW_LINE_H}px`, left: 0, right: 0 },
          },
            h('span', { className: 'cw-no' }, String(number)),
            h('span', { className: 'cw-src' }, highlightC(text, hit ? word : '')),
          ));
        }
        body = h('div', {
          className: 'cw-virtual',
          style: { position: 'relative', height: `${total * CW_LINE_H}px` },
        }, rows);
      }

      const openAtPointer = (event) => {
        if (!preview?.file || typeof onOpen !== 'function') return;
        const pane = paneRef.current;
        if (!pane) return;
        const rect = pane.getBoundingClientRect();
        const lineAt = Math.max(1, Math.floor((event.clientY - rect.top + pane.scrollTop) / CW_LINE_H) + 1);
        onOpen({ file: preview.file, line: lineAt });
      };
      return h('div', {
        className: 'sl-cw-card sl-cw-right',
      },
      h('div', {
        className: 'sl-cw-path',
        title: preview?.file ? `${preview.file}:${current}` : '',
      }, preview?.file ? `${preview.file}:${current}` : ''),
      h('div', {
        className: 'sl-cw-scroll',
        ref: paneRef,
        onScroll,
        onDoubleClick: openAtPointer,
        contentEditable: false,
        spellCheck: false,
        'aria-readonly': true,
      }, body));
    }
    function ResultsPanel({
      sessionId,
      results,
      preview,
      height,
      collapsed,
      onResizeStart,
      onToggle,
      onPreview,
      onOpen,
      t,
    }) {
      const initialCols = readContextCols();
      const [leftFrac, setLeftFrac] = useState(initialCols.left);
      const [rightFrac, setRightFrac] = useState(initialCols.right);
      const [fileTexts, setFileTexts] = useState({});
      const [openDefs, setOpenDefs] = useState(() => new Set());
      const [openRefs, setOpenRefs] = useState(() => new Set());
      const settingsTimerRef = useRef(0);
      const pendingRef = useRef(new Set());

      useEffect(() => {
        let alive = true;
        fetch(apiUrl('/settings'), { headers: { 'x-sourcelook': '1' } })
          .then((response) => response.json())
          .then((settings) => {
            if (!alive) return;
            const cols = settings?.contextColsV2;
            if (!Array.isArray(cols) || cols.length !== 2) return;
            const left = Number(cols[0]);
            const right = Number(cols[1]);
            if (left >= 0.15 && right <= 0.85 && right - left >= 0.15) {
              setLeftFrac(left);
              setRightFrac(right);
              writeContextCols(left, right);
            }
          })
          .catch(() => {});
        return () => { alive = false; };
      }, []);

      useEffect(() => () => window.clearTimeout(settingsTimerRef.current), []);

      const persistContextCols = (left, right) => {
        window.clearTimeout(settingsTimerRef.current);
        settingsTimerRef.current = window.setTimeout(() => {
          fetch(apiUrl('/settings'), {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-sourcelook': '1' },
            body: JSON.stringify({ contextColsV2: [left, right] }),
          }).catch(() => {});
        }, 250);
      };

      const resetContextCols = () => {
        setLeftFrac(1 / 3);
        setRightFrac(2 / 3);
        writeContextCols(1 / 3, 2 / 3);
        persistContextCols(1 / 3, 2 / 3);
      };

      const ensureFile = useCallback((file) => {
        const rel = String(file || '');
        if (rel === '' || pendingRef.current.has(rel)) return;
        let known = false;
        setFileTexts((previous) => {
          if (previous[rel] !== undefined && previous[rel] !== null) { known = true; return previous; }
          return previous;
        });
        if (known) return;
        pendingRef.current.add(rel);
        api(`/file?path=${encodeURIComponent(rel)}`, undefined, sessionId)
          .then((data) => {
            setFileTexts((previous) => {
              if (previous[rel] !== undefined) return previous;
              const next = { ...previous, [rel]: String(data?.content ?? '') };
              /* 结果窗可能引用上百个文件；最多留 24 个全文，避免内存无限涨。 */
              const keys = Object.keys(next);
              if (keys.length > 24) {
                for (const key of keys) {
                  if (key === rel) continue;
                  delete next[key];
                  if (Object.keys(next).length <= 24) break;
                }
              }
              return next;
            });
          })
          .catch(() => {
            setFileTexts((previous) => (previous[rel] !== undefined ? previous : { ...previous, [rel]: null }));
          })
          .finally(() => { pendingRef.current.delete(rel); });
      }, [sessionId]);

      const items = results?.items || [];
      const refs = results?.refs || [];
      const defGroups = useMemo(() => groupByFile(items), [items]);
      const refGroups = useMemo(() => groupByFile(refs), [refs]);

      useEffect(() => {
        setOpenDefs(new Set(defGroups.length > 0 ? [defGroups[0].file] : []));
        setOpenRefs(new Set());
        if (defGroups.length > 0) ensureFile(defGroups[0].file);
        /* 其余文件在展开分组时按需加载，避免一打开就缓存上百个全文。 */
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [results, ensureFile]);

      const startColumnDrag = (which, event) => {
        event.preventDefault();
        const body = event.currentTarget.parentElement;
        if (!body) return;
        const rect = body.getBoundingClientRect();
        const move = (moveEvent) => {
          const fraction = Math.min(0.85, Math.max(0.15, (moveEvent.clientX - rect.left) / rect.width));
          if (which === 'left') {
            const next = Math.min(fraction, rightFrac - 0.18);
            setLeftFrac(next);
            writeContextCols(next, rightFrac);
            persistContextCols(next, rightFrac);
          } else {
            const next = Math.max(fraction, leftFrac + 0.18);
            setRightFrac(next);
            writeContextCols(leftFrac, next);
            persistContextCols(leftFrac, next);
          }
        };
        const stop = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', stop);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop, { once: true });
      };

      const fileLines = (file) => {
        const text = fileTexts[file];
        return typeof text === 'string' ? text.split('\n') : null;
      };
      const lineText = (file, line) => {
        const lines = fileLines(file);
        if (lines === null) return '';
        return lines[Math.max(0, Number(line) - 1)] ?? '';
      };
      const previewLines = preview?.content ? String(preview.content).split('\n') : [];
      const previewLine = Math.max(1, Number(preview?.line) || 1);
      const hitWord = results?.kind === 'grep'
        ? ''
        : String(results?.word || items[0]?.name || '').trim();

      const previewStart = previewLines.length === 0 ? 1 : Math.max(1, previewLine - 6);
      const previewEnd = previewLines.length === 0 ? 0 : Math.min(previewLines.length, previewLine + 9);

      const codeRows = (lines, from, to, current, word) => {
        if (lines.length === 0) return null;
        const out = [];
        for (let number = from; number <= to; number += 1) {
          const text = lines[number - 1];
          if (text === undefined) break;
          const isCurrent = number === current;
          out.push(h('div', { key: `l${number}`, className: `cw-line${isCurrent ? ' hit' : ''}` },
            h('span', { className: 'cw-no' }, String(number)),
            h('span', { className: 'cw-src' }, highlightC(text, isCurrent ? word : '')),
          ));
        }
        return out;
      };

      const defGroup = (group) => {
        const open = openDefs.has(group.file);
        const first = group.items[0];
        const cond = first?.config ? String(first.config) : '';
        const isDeclaration = first?.prototype === true;
        const buildLive = first?.live === false;
        const headTitle = `${definitionLabel(first)}${isDeclaration ? '（声明）' : ''}：${group.file}:${first?.line ?? 1}`
          + (buildLive ? '　当前配置不编译' : '')
          + (cond ? `　条件 ${cond}` : '')
          + `；点标题跳到 ${group.file}:${first?.line ?? 1}，点行首方括号展开/折叠本文件的定义行`;
        return h('div', { key: group.file, className: `cw-local${open ? ' open' : ''}` },
          h('div', {
            className: `cw-local-head${open ? ' active' : ''}`,
            title: headTitle,
            onClick: () => {
              setOpenDefs((previous) => {
                const next = new Set(previous);
                if (next.has(group.file)) next.delete(group.file);
                else next.add(group.file);
                return next;
              });
              ensureFile(group.file);
              onPreview({ ...first, file: group.file });
            },
          },
          h('span', { className: 'cw-local-caret' }, open ? '[-]' : '[+]'),
          h('span', { className: 'cw-local-title' }, `${definitionLabel(first)}：${group.file}:${first?.line ?? 1}`),
          cond !== '' ? h('span', { className: 'cw-cond', title: `这一处受条件编译控制：${cond}` }, cond) : null,
          ),
          open ? h('div', { className: 'cw-local-body' }, group.items.map((item, index) => h('div', {
            key: `${item.file}:${item.line}:${index}`,
            className: `cw-local-row is-def${item.live === false ? ' dead' : ''}`,
            title: `${item.file}:${item.line}${item.prototype === true ? '  声明' : ''}${item.config ? `  条件 ${item.config}` : ''}${item.live === false ? '  当前配置不编译' : ''}`,
            onClick: () => onPreview(item),
            onDoubleClick: () => onOpen(item),
          },
          h('span', { className: 'cw-local-at' }, `${item.line}:`),
          h('span', { className: 'cw-local-code' }, highlightC(lineText(item.file, item.line) || ' ', hitWord)),
          item.config ? h('span', { className: 'cw-cond', title: `这一行受条件编译控制：${item.config}` }, String(item.config).slice(0, 16)) : null,
          ))) : null,
        );
      };

      const refGroup = (group) => {
        const open = openRefs.has(group.file);
        return h('div', { key: group.file, className: `cw-local is-file${open ? ' open' : ''}` },
          h('div', {
            className: 'cw-local-head',
            title: group.file,
            onClick: () => {
              setOpenRefs((previous) => {
                const next = new Set(previous);
                if (next.has(group.file)) next.delete(group.file);
                else next.add(group.file);
                return next;
              });
              ensureFile(group.file);
            },
          },
          h('span', { className: 'cw-local-caret' }, open ? '[-]' : '[+]'),
          h('span', { className: 'cw-local-title' }, group.file),
          h('span', { className: 'cw-local-count' }, `(${group.items.length})`),
          ),
          open ? h('div', { className: 'cw-local-body' }, group.items.map((item, index) => h('div', {
            key: `${item.line}:${index}`,
            className: `cw-local-row${item.live === false ? ' dead' : ''}`,
            title: `${item.file}:${item.line}${item.fn ? `  ${item.fn}()` : ''}`,
            onClick: () => onPreview(item),
            onDoubleClick: () => onOpen(item),
          },
          h('span', { className: 'cw-local-at' }, `${item.line}:`),
          h('span', { className: 'cw-local-code' }, highlightC(lineText(item.file, item.line) || (item.fn ? `${item.fn}()` : ' '), hitWord)),
          ))) : null,
        );
      };

      const defsBody = defGroups.length === 0
        ? null
        : h('div', { className: 'cw-refs' }, defGroups.map(defGroup));

      const refsBody = refGroups.length === 0
        ? null
        : h('div', { className: 'cw-refs cw-refs-col' }, refGroups.map(refGroup));

      const note = typeof results?.note === 'string' && results.note !== ''
        ? h('div', { className: 'cw-state' }, results.note)
        : null;

      const codeBody = preview === null
        ? h('div', { className: 'sl-cw-card sl-cw-right' })
        : h(ContextCodePane, {
          preview,
          line: previewLine,
          word: hitWord,
          loadingText: t('loading'),
          onOpen,
        });

      const bodyStyle = {
        gridTemplateColumns: `${(leftFrac * 100).toFixed(3)}% 10px minmax(0, 1fr) 10px ${((1 - rightFrac) * 100).toFixed(3)}%`,
      };

      return h('section', {
        className: `sl-cw${collapsed ? ' collapsed' : ''}`,
        style: { height: `${collapsed ? 12 : height}px` },
        'aria-label': results?.title || '上下文',
      },
      h('div', {
        className: 'sl-cw-strip',
        onPointerDown: collapsed ? undefined : onResizeStart,
        onDoubleClick: collapsed ? undefined : onToggle,
        title: results?.title ? `${results.title} · 拖拽调整高度 · 双击折叠` : '拖拽调整高度 · 双击折叠',
      },
      h('div', { className: 'sl-cw-drag' }),
      collapsed && results?.word ? h('span', { className: 'sl-cw-title' }, results.word) : null,
      h('button', {
        type: 'button',
        className: 'sl-cw-toggle',
        title: collapsed ? '展开上下文窗口' : '折叠上下文窗口',
        onClick: (event) => { event.stopPropagation(); onToggle(); },
      }, h(Icon, { name: 'chevron', size: 10 })),
      ),
      collapsed ? null : h('div', { className: 'sl-cw-body', style: bodyStyle },
        h('div', { className: 'sl-cw-card' }, defsBody ?? note ?? h('div', { className: 'cw-state' }, '没有')),
        h('div', {
          className: 'sl-cw-resizer',
          role: 'separator',
          'aria-orientation': 'vertical',
          'aria-label': '调整定义列宽度',
          title: '拖动调整定义列宽度；双击复位',
          onPointerDown: (event) => startColumnDrag('left', event),
          onDoubleClick: resetContextCols,
        }),
        codeBody,
        h('div', {
          className: 'sl-cw-resizer',
          role: 'separator',
          'aria-orientation': 'vertical',
          'aria-label': '调整引用列宽度',
          title: '拖动调整引用列宽度；双击复位',
          onPointerDown: (event) => startColumnDrag('right', event),
          onDoubleClick: resetContextCols,
        }),
        h('div', { className: 'sl-cw-card' }, refsBody),
      ),
      );
    }


    /* ---------------------------------------------------------- result window
     * Faithful port of the original reader's 结果窗:
     *   header: [kind pill ▾] [query input] [title] [共 N 处] [scopes (find only)] [×]
     *   list card: badge? fn()? file [来自 pool] [近似] line text [conf]
     *   code card: file:line + the whole file, hit line marked and scrolled to
     * The window opens at once with a spinner for 查找, never closes on an
     * outside click, is draggable/resizable and remembers its geometry. */

    const RESULT_GEOM_KEY = 'sourcelook.resultGeom.v2';
    const CODEVIEW_MAX = 6000;

    function readResultGeom() {
      try {
        const raw = window.localStorage.getItem(RESULT_GEOM_KEY);
        const data = raw === null || raw === '' ? null : JSON.parse(raw);
        if (data && Number.isFinite(data.width) && Number.isFinite(data.height)) {
          return {
            x: Number(data.x) || 0,
            y: Number(data.y) || 0,
            width: Math.max(320, Math.min(window.innerWidth - 12, data.width)),
            height: Math.max(240, Math.min(window.innerHeight - 12, data.height)),
          };
        }
      } catch {
        /* default geometry */
      }
      const width = Math.min(1180, Math.round(window.innerWidth * 0.94));
      const height = Math.min(640, Math.round(window.innerHeight * 0.82));
      return {
        x: Math.max(2, Math.round((window.innerWidth - width) / 2)),
        y: Math.max(46, Math.round(window.innerHeight * 0.09)),
        width,
        height,
      };
    }

    function writeResultGeom(value) {
      try { window.localStorage.setItem(RESULT_GEOM_KEY, JSON.stringify(value)); } catch { /* quota */ }
    }

    const RESULT_KIND_ORDER = ['callers', 'defs', 'find'];
    const RESULT_KIND_LABEL = { callers: '调用', defs: '定义', find: '查找', callees: '我调用谁' };
    const RESULT_SCOPES = [
      { id: 'idx', label: '索引', title: '按索引查整个项目（默认）' },
      { id: 'file', label: '本文件', title: '只在当前文件里按文本匹配' },
      { id: 'dir', label: '本目录', title: '只在当前文件所在目录里按文本匹配' },
      { id: 'global', label: '本项目', title: '整个项目按文本匹配（不用索引，较慢）' },
    ];

    const TYPEDEF_RE = /^\s*typedef\b/u;
    const TYPE_MENTION_RE = /\b(struct|union|enum)\b/u;

    /* 从一行源码判断"命中落在什么上"（没有索引信息时的兜底），照原版搬。 */
    function lineBadgeKind(text, word) {
      const source = String(text || '');
      if (!source.trim()) return '';
      const at = word ? source.indexOf(word) : -1;
      if (at >= 0) {
        const before = source.slice(0, at);
        const block = before.lastIndexOf('/*');
        const line = before.lastIndexOf('//');
        if (line >= 0 || (block >= 0 && before.indexOf('*/', block) < 0)) return 'comment';
      } else if (/^\s*(\/\*|\*|\/\/)/u.test(source)) {
        return 'comment';
      }
      if (/^\s*#\s*define\b/u.test(source)) return 'macro';
      if (TYPEDEF_RE.test(source)) return 'typedef';
      if (TYPE_MENTION_RE.test(source)) return 'type';
      if (/[A-Za-z_]\w*\s*\(/u.test(source)) return 'call';
      return 'variable';
    }

    /* Badge kind for one hit: symbol kind → reference kind → line heuristic. */
    function resultRowKind(hit) {
      if (hit.symKind) return hit.symKind;
      if (hit.kind === 'call') return 'call';
      if (hit.kind === 'type') return 'type';
      if (hit.kind === 'field') return 'member';
      if (hit.kind === 'read' || hit.kind === 'write' || hit.kind === 'address') return 'variable';
      return lineBadgeKind(hit.text, hit.word || '');
    }

    function SlResultWindow({ win, preview, onClose, onKind, onScope, onQuery, onOpen, onSelect }) {
      const [geom, setGeom] = useState(readResultGeom);
      const [query, setQuery] = useState('');
      const [kindOpen, setKindOpen] = useState(false);
      const [openCallers, setOpenCallers] = useState(() => new Set());
      const codeRef = useRef(null);

      useEffect(() => {
        if (win !== null) setQuery(win.word ?? '');
      }, [win === null ? null : win.word]);

      useEffect(() => {
        const callers = win?.tree?.callers;
        /* 调用层级默认展开第一项，下面的代码区也对应第一处调用。 */
        setOpenCallers(new Set(Array.isArray(callers) && callers.length > 0 ? [0] : []));
      }, [win?.tree]);

      useEffect(() => { writeResultGeom(geom); }, [geom]);

      useEffect(() => {
        if (win === null) return undefined;
        const escape = (event) => {
          if (event.key !== 'Escape') return;
          if (kindOpen) setKindOpen(false);
          else onClose();
        };
        document.addEventListener('keydown', escape);
        return () => document.removeEventListener('keydown', escape);
      }, [win, kindOpen, onClose]);

      useEffect(() => {
        if (!kindOpen) return undefined;
        const close = (event) => {
          const target = event.target;
          if (target && typeof target.closest === 'function' && target.closest('.sl-rw-kindbox')) return;
          setKindOpen(false);
        };
        document.addEventListener('pointerdown', close, true);
        return () => document.removeEventListener('pointerdown', close, true);
      }, [kindOpen]);

      const code = useMemo(() => {
        if (typeof preview?.content !== 'string') return { lines: [], offset: 0, truncated: false, total: 0 };
        const all = preview.content.split(/\r?\n/);
        /* 结果窗只渲染命中行附近，最多 800 行；整个文件由底部上下文窗负责，
           这里全量渲染 6000 行会把搜索/跳转拖卡。 */
        if (all.length <= 800) return { lines: all, offset: 0, truncated: false, total: all.length };
        const center = Math.max(1, Math.min(all.length, Number(preview?.line) || 1));
        const start = Math.max(0, center - 200);
        return {
          lines: all.slice(start, start + 400),
          offset: start,
          truncated: true,
          total: all.length,
        };
      }, [preview?.content, preview?.line]);

      useEffect(() => {
        if (preview === null) return undefined;
        const view = codeRef.current;
        if (!view) return undefined;
        const pin = () => {
          const hit = view.querySelector('.sl-rw-cline.hit');
          if (!hit) return;
          /* Measure from the scroll container: offsetTop is relative to the
             nearest positioned ancestor (the fixed window). */
          const top = hit.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop;
          view.scrollTop = Math.max(0, Math.round(top - view.clientHeight / 3));
        };
        /* Wait one frame so flex layout has settled before measuring. */
        const raf = window.requestAnimationFrame(pin);
        return () => window.cancelAnimationFrame(raf);
      }, [preview, geom.height, geom.width]);

      if (win === null) return null;

      const hits = Array.isArray(win.hits) ? win.hits : [];
      const tree = win.tree || null;
      const word = win.word ?? '';
      const kindLabel = RESULT_KIND_LABEL[win.kind] ?? '查找';
      const loading = win.loading === true;
      const isFind = win.kind === 'find';
      const toggleCaller = (index) => {
        setOpenCallers((previous) => {
          const next = new Set(previous);
          if (next.has(index)) next.delete(index);
          else next.add(index);
          return next;
        });
      };

      const width = Math.max(320, Math.min(geom.width, window.innerWidth - 12));
      const height = Math.max(240, Math.min(geom.height, window.innerHeight - 12));
      const left = Math.max(2, Math.min(geom.x, Math.max(2, window.innerWidth - width - 6)));
      const top = Math.max(2, Math.min(geom.y, Math.max(2, window.innerHeight - height - 6)));

      const startDrag = (event) => {
        if (event.button !== 0) return;
        const target = event.target;
        if (target && typeof target.closest === 'function'
          && target.closest('button, input, .sl-rw-kindbox')) return;
        const sx = event.clientX;
        const sy = event.clientY;
        const base = { x: left, y: top };
        const move = (moveEvent) => {
          setGeom((previous) => ({
            ...previous,
            x: Math.max(-previous.width + 120, Math.min(window.innerWidth - 120, base.x + moveEvent.clientX - sx)),
            y: Math.max(2, Math.min(window.innerHeight - 60, base.y + moveEvent.clientY - sy)),
          }));
        };
        const stop = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', stop);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop);
        event.preventDefault();
      };

      const startResize = (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const sx = event.clientX;
        const sy = event.clientY;
        const base = { width, height };
        const move = (moveEvent) => {
          setGeom((previous) => ({
            ...previous,
            width: Math.max(320, Math.min(window.innerWidth - left - 6, base.width + moveEvent.clientX - sx)),
            height: Math.max(240, Math.min(window.innerHeight - top - 6, base.height + moveEvent.clientY - sy)),
          }));
        };
        const stop = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', stop);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop);
      };

      const enterQuery = () => {
        const next = query.trim();
        if (next !== '') onQuery(next);
      };

      const rowTip = (hit) => [
        hit.fn || '',
        `${hit.file}:${hit.line}`,
        hit.defNote || '',
        hit.parent ? `结构体 ${hit.parent}` : '',
        hit.config || '',
      ].filter(Boolean).join('  ');

      const previewLine = Number(preview?.line) || 1;

      return h('div', {
        className: 'sl-result-window',
        role: 'dialog',
        'aria-label': win.title || '查找结果',
        style: { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` },
        onMouseDown: (event) => event.stopPropagation(),
      },
      h('div', { className: 'sl-rw-head', onPointerDown: startDrag },
        h('span', { className: 'sl-rw-accent', 'aria-hidden': true }),
        h('div', { className: 'sl-rw-kindbox' },
          h('button', {
            type: 'button',
            className: 'sl-rw-kind',
            title: '切换结果类型',
            'aria-haspopup': 'menu',
            'aria-expanded': kindOpen ? 'true' : 'false',
            onClick: () => setKindOpen((value) => !value),
          }, kindLabel),
          kindOpen ? h('div', { className: 'sl-rw-kindmenu', role: 'menu' },
            RESULT_KIND_ORDER.map((kind) => h('button', {
              key: kind,
              type: 'button',
              role: 'menuitem',
              className: `sl-rw-kinditem${win.kind === kind ? ' on' : ''}`,
              onClick: () => {
                setKindOpen(false);
                onKind(kind);
              },
            },
            h('span', { className: 'sl-rw-chk' }, win.kind === kind ? '✓' : ''),
            h('span', null, RESULT_KIND_LABEL[kind]),
            )),
          ) : null,
        ),
        h('input', {
          className: 'sl-rw-query',
          value: query,
          spellCheck: false,
          placeholder: '修改查找词，回车重查',
          title: '修改查找词，回车重查',
          onChange: (event) => setQuery(event.target.value),
          onKeyDown: (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            enterQuery();
          },
        }),
        h('span', { className: 'sl-rw-title', title: win.title || '' }, win.title || ''),
        h('span', { className: 'sl-rw-stat' }, loading ? '' : `共 ${hits.length} 处`),
        h('span', { className: 'sl-rw-spacer' }),
        isFind ? h('span', { className: 'sl-rw-scopes' },
          RESULT_SCOPES.map((scope) => h('button', {
            key: scope.id,
            type: 'button',
            className: `sl-rw-scope${win.scope === scope.id ? ' active' : ''}`,
            title: scope.title,
            onClick: () => onScope(scope.id),
          }, scope.label)),
        ) : null,
        h('button', {
          type: 'button',
          className: 'sl-rw-close',
          title: '关闭（Esc）',
          onClick: onClose,
        }, '×'),
      ),
      h('div', { className: 'sl-rw-list', role: 'listbox' },
        loading
          ? h('div', { className: 'sl-rw-loading' },
            h('span', { className: 'sl-rw-spin', 'aria-hidden': true }),
            '正在搜索…',
            win.note ? h('span', { className: 'sl-rw-loading-note' }, win.note) : null,
          )
          : win.error
            ? h('div', { className: 'sl-rw-empty sl-error' }, `搜索失败：${win.error}`)
            : tree
              ? h('div', { className: 'sl-rw-tree' },
                h('div', { className: 'sl-rw-root' },
                  `${tree.name} · ${tree.total} 处调用 · ${tree.callers.length} 个调用者`),
                tree.callers.map((caller, index) => {
                  const open = openCallers.has(index);
                  return h(Fragment, { key: `${caller.fn}:${index}` },
                    h('div', {
                      className: 'sl-rw-caller',
                      title: `${caller.fn} · ${caller.count} 处调用（单击展开/收起，双击打开第一处）`,
                      onClick: () => toggleCaller(index),
                      onDoubleClick: () => { if (caller.sites[0]) onOpen(caller.sites[0]); },
                    },
                    h('span', { className: 'sl-rw-caret' }, open ? '[-]' : '[+]'),
                    h('span', { className: 'sl-rw-fn' }, `${caller.fn}()`),
                    h('span', { className: 'sl-rw-count' }, `${caller.count} 处`),
                    ),
                    open ? caller.sites.map((site, siteIndex) => h('div', {
                      key: `${site.file}:${site.line}:${siteIndex}`,
                      className: 'sl-rw-site',
                      title: `${site.file}:${site.line}`,
                      onClick: () => onSelect(-1, site),
                      onDoubleClick: () => onOpen(site),
                    },
                    h('span', { className: 'sl-rw-file' }, site.file),
                    h('span', { className: 'sl-rw-line' }, site.line),
                    )) : null,
                  );
                }),
              )
              : hits.length === 0
              ? h('div', { className: 'sl-rw-empty' }, win.note || '没有匹配')
              : hits.map((hit, index) => {
                const kind = resultRowKind(hit);
                return h('div', {
                  key: `${hit.file}:${hit.line}:${index}`,
                  role: 'option',
                  'data-i': index,
                  'aria-selected': win.selected === index ? 'true' : 'false',
                  className: `sl-rw-row${win.selected === index ? ' active' : ''}`,
                  title: rowTip(hit),
                  onClick: () => onSelect(index, hit),
                  onDoubleClick: () => onOpen(hit),
                },
                kind !== '' ? h(SymbolBadge, { kind }) : null,
                hit.fn ? h('span', { className: 'sl-rw-fn' }, `${hit.fn}()`) : null,
                h('span', { className: 'sl-rw-file' }, hit.file),
                hit.pool ? h('span', { className: 'sl-rw-pool' }, `来自 ${hit.pool}`) : null,
                hit.approx ? h('span', { className: 'sl-rw-pool sl-rw-approx', title: '近似符号：未注册语言，通用词法' }, '近似') : null,
                h('span', { className: 'sl-rw-line' }, hit.line),
                h('span', { className: 'sl-rw-text' }, String(hit.text || '').trim()),
                hit.conf && hit.conf !== 'exact' ? h('span', { className: 'sl-rw-conf' }, hit.conf) : null,
                );
              }),
      ),
      h('div', { className: 'sl-rw-code' },
        h('div', { className: 'sl-rw-codehead', title: preview ? `${preview.file}:${previewLine}` : '' },
          preview ? `${preview.file}:${previewLine}` : '点击上面的位置，这里显示对应代码。'),
        h('div', { className: 'sl-rw-codeview', ref: codeRef },
          preview?.loading === true ? h('div', { className: 'sl-rw-empty' }, '读取中…') : null,
          preview?.error ? h('div', { className: 'sl-rw-empty sl-error' }, preview.error) : null,
          !preview || preview.loading === true || preview.error
            ? null
            : h(Fragment, null,
              code.lines.map((line, index) => {
                const lineNo = index + 1 + code.offset;
                return h('div', {
                  key: lineNo,
                  className: `sl-rw-cline${lineNo === previewLine ? ' hit' : ''}`,
                },
                h('span', { className: 'sl-rw-no' }, lineNo),
                h('span', { className: 'sl-rw-src' }, highlightC(line, word)),
                );
              }),
              code.truncated ? h('div', { className: 'sl-rw-trunc' }, `仅显示前 ${CODEVIEW_MAX} 行`) : null,
            ),
        ),
      ),
      h('div', { className: 'sl-rw-resize', title: '拖拽调整大小', onPointerDown: startResize }),
      );
    }
