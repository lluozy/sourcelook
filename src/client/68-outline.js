    /* Current-file symbol window, modelled on the original reader's left pane:
     * fold + three coloured sort keys in one header row, a pill filter field
     * with the file name on its right, and 22px rows carrying a kind badge, a
     * coloured monospace name and the line number. */
    function SymbolPane({
      symbols,
      loading,
      error,
      path,
      collapsed,
      width,
      filter,
      sort,
      currentLine,
      bufferText,
      onFilter,
      onSort,
      onToggle,
      onSelect,
      t,
    }) {
      const base = String(path || '').split('/').filter(Boolean).pop() || '';
      const [activeKey, setActiveKey] = useState('');
      const paneRef = useRef(null);

      /* 兜底：指针落在头部/按钮/边缘这些"不在列表里"的地方时，滚轮也应该滚列表
         （用户反馈过"左边符号框滚不动"——常见就是指针压在头部或列表外沿）。
         列表内的滚轮不拦，交给浏览器原生滚动，避免多一层 JS。 */
      useEffect(() => {
        const pane = paneRef.current;
        if (!pane) return undefined;
        const onWheel = (event) => {
          if (event.ctrlKey || event.metaKey) return;
          const target = event.target;
          if (target && typeof target.closest === 'function' && target.closest('.sl-sym-list')) return;
          const list = pane.querySelector('.sl-sym-list');
          if (!list || list.scrollHeight <= list.clientHeight + 1) return;
          list.scrollTop += event.deltaY;
        };
        pane.addEventListener('wheel', onWheel, { passive: true });
        return () => pane.removeEventListener('wheel', onWheel);
      }, []);
      const rows = useMemo(() => {
        const needle = String(filter || '').trim().toLowerCase();
        const list = (symbols || []).filter((symbol) => {
          /* File-scope symbols only, like the original ("a 600-symbol outline
             became 3,000 rows" was the reason). */
          const kind = String(symbol.kind || '').toLowerCase();
          if (kind === 'local' || kind === 'parameter' || kind === 'member'
            || kind === 'field' || kind === 'enum_member') return false;
          if (symbol.parent !== undefined && symbol.parent !== null && symbol.parent !== '') return false;
          if (needle === '') return true;
          return String(symbol.name || '').toLowerCase().includes(needle);
        });
        const byLine = (a, b) => (Number(a.line) || 0) - (Number(b.line) || 0);
        /* Preprocessor directives as pseudo symbols (the original appends them
           from the buffer so `#ifdef` nesting is visible in the outline). */
        const pseudo = [];
        const text = String(bufferText || '');
        if (text !== '') {
          const lines = text.split(/\r?\n/);
          for (let index = 0; index < lines.length; index += 1) {
            const match = /^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b\s*(.*)$/u.exec(lines[index]);
            if (!match) continue;
            const name = `#${match[1]}${match[2] ? ` ${match[2].trim().slice(0, 28)}` : ''}`;
            if (needle !== '' && !name.toLowerCase().includes(needle)) continue;
            pseudo.push({ name, kind: 'preproc', line: index + 1, pseudo: true });
          }
        }
        const all = list.concat(pseudo);
        if (sort === 'name') all.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en'));
        else if (sort === 'type') {
          all.sort((a, b) => {
            const key = String(a.kind || '').localeCompare(String(b.kind || ''), 'en');
            return key !== 0 ? key : byLine(a, b);
          });
        } else all.sort(byLine);
        return all;
      }, [symbols, filter, sort, bufferText]);

      useEffect(() => {
        if (currentLine === undefined) return;
        const hit = (symbols || []).find((symbol) => Number(symbol.line) === Number(currentLine));
        if (hit) setActiveKey(`${hit.name}:${hit.line}:${hit.kind}`);
      }, [currentLine, symbols]);

      if (collapsed) return null;

      return h('aside', {
        ref: paneRef,
        className: 'sl-sym-pane',
        style: { width: `${width}px` },
        'aria-label': 'symbols',
      },
      h('div', { className: 'sl-sym-head' },
        h('div', { className: 'sl-sym-tools' },
          h('button', {
            type: 'button',
            className: 'sl-sym-btn fold tone-slate',
            title: '收起符号窗口（向左）',
            onClick: onToggle,
          }, h(Icon, { name: 'fold-left', size: 13 })),
          h('button', {
            type: 'button',
            className: `sl-sym-btn tone-blue${sort === 'line' ? ' active' : ''}`,
            title: '按行号',
            'aria-pressed': sort === 'line' ? 'true' : 'false',
            onClick: () => onSort('line'),
          }, h(Icon, { name: 'sort-line', size: 15 })),
          h('button', {
            type: 'button',
            className: `sl-sym-btn tone-violet${sort === 'type' ? ' active' : ''}`,
            title: '按类型',
            'aria-pressed': sort === 'type' ? 'true' : 'false',
            onClick: () => onSort('type'),
          }, h(Icon, { name: 'sort-type', size: 15 })),
          h('button', {
            type: 'button',
            className: `sl-sym-btn tone-green${sort === 'name' ? ' active' : ''}`,
            title: '按名称 A–Z',
            'aria-pressed': sort === 'name' ? 'true' : 'false',
            onClick: () => onSort('name'),
          }, h(Icon, { name: 'sort-name', size: 15 })),
        ),
        h('label', { className: 'sl-sym-field' },
          h('input', {
            type: 'text',
            value: filter,
            placeholder: '过滤本文件符号…',
            'aria-label': '过滤本文件符号',
            spellCheck: false,
            style: { paddingRight: width >= 330 ? '62px' : '10px' },
            onChange: (event) => onFilter(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Escape') {
                onFilter('');
                return;
              }
              /* Enter jumps to the first match, like the original filter box. */
              if (event.key === 'Enter') {
                event.preventDefault();
                const first = rows[0];
                if (first) {
                  onSelect(first);
                  onFilter('');
                }
              }
            },
          }),
          base !== '' && width >= 330 ? h('span', { className: 'sl-sym-stat', title: path }, base) : null,
        ),
      ),
      h('div', { className: 'sl-sym-list' },
        error !== null ? h('div', { className: 'sl-pane-error sl-sym-empty' }, error) : null,
        loading && rows.length === 0 ? h('div', { className: 'sl-sym-empty' }, '加载中…') : null,
        !loading && error === null && rows.length === 0
          ? h('div', { className: 'sl-sym-empty' }, symbols.length === 0 ? '这个文件还没有符号。' : '没有匹配的符号。')
          : null,
        rows.map((symbol) => {
          const key = `${symbol.name}:${symbol.line}:${symbol.kind}`;
          return h('div', {
            key,
            role: 'button',
            tabIndex: 0,
            className: `sl-sym-row k-${symbolFamily(symbol.kind)}${key === activeKey ? ' active' : ''}`,
            title: `${symbol.name}（${symbol.kind || '符号'}，第 ${symbol.line} 行）`,
            onClick: () => {
              setActiveKey(key);
              onSelect(symbol);
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setActiveKey(key);
                onSelect(symbol);
              }
            },
          },
          h(SymbolBadge, { kind: symbol.kind }),
          h('span', { className: 'sl-sym-name' }, symbol.name),
          h('span', { className: 'sl-sym-line' }, String(symbol.line)),
          );
        }),
      ));
    }

    SymbolPane = React.memo(SymbolPane);
