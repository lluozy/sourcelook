    /* The original reader's right pane: one window, three modes (symbols / tree /
     * files) sharing one fuzzy filter. Symbol results are grouped by name the
     * way the original list is, with duplicate definitions folded behind a
     * caret and the occurrence count on the right. */
    function GlobalPane({
      sessionId,
      rootInfo,
      activePath,
      collapsed,
      mode,
      onMode,
      onToggle,
      onOpen,
      onPreview,
      onNote,
      width = 300,
      onResizeStart,
      indexInfo,
      t,
    }) {
      const [filter, setFilter] = useState('');
      const [symbols, setSymbols] = useState([]);
      const [files, setFiles] = useState([]);
      const [loading, setLoading] = useState(false);
      const [loadingMore, setLoadingMore] = useState(false);
      const [more, setMore] = useState(false);
      const [error, setError] = useState(null);
      const [openNames, setOpenNames] = useState(() => new Set());
      const [selectedFile, setSelectedFile] = useState('');

      useEffect(() => {
        if (collapsed || mode === 'tree') return undefined;
        let cancelled = false;
        setLoading(true);
        setError(null);
        setMore(false);
        const timer = window.setTimeout(async () => {
          try {
            if (mode === 'symbols') {
              /* Paged list: 200 rows at a time, the rest loads on scroll.
                 Older hosts (before this build) have no paged route: fall back
                 so a live session keeps working until DSH is restarted. */
              let data;
              try {
                data = await api(`/symbols-page?q=${encodeURIComponent(filter)}&start=0&limit=200&globals=1`, undefined, sessionId);
              } catch (error) {
                if (error?.status !== 404) throw error;
                data = await api(`/symbols?q=${encodeURIComponent(filter)}&limit=200`, undefined, sessionId);
              }
              if (cancelled) return;
              setSymbols(Array.isArray(data?.rows) ? data.rows : Array.isArray(data?.symbols) ? data.symbols : []);
              setMore(data?.more === true);
            } else {
              let data;
              try {
                data = await api(`/files-page?q=${encodeURIComponent(filter)}&start=0&limit=200`, undefined, sessionId);
              } catch (error) {
                if (error?.status !== 404) throw error;
                data = await api(`/files?q=${encodeURIComponent(filter)}&limit=300`, undefined, sessionId);
              }
              if (cancelled) return;
              setFiles(Array.isArray(data?.rows) ? data.rows : []);
              setMore(data?.more === true);
            }
          } catch (err) {
            if (!cancelled) setError(errorText(err, t));
          } finally {
            if (!cancelled) setLoading(false);
          }
        }, 160);
        return () => {
          cancelled = true;
          window.clearTimeout(timer);
        };
        /* t is intentionally not a dependency: it is re-created on each render. */
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [collapsed, mode, filter, sessionId]);

      const loadMore = useCallback(async () => {
        if (collapsed || mode === 'tree' || loading || loadingMore || !more) return;
        const start = mode === 'symbols' ? symbols.length : files.length;
        if (start === 0) return;
        setLoadingMore(true);
        try {
          let data;
          try {
            data = mode === 'symbols'
              ? await api(`/symbols-page?q=${encodeURIComponent(filter)}&start=${start}&limit=200&globals=1`, undefined, sessionId)
              : await api(`/files-page?q=${encodeURIComponent(filter)}&start=${start}&limit=200`, undefined, sessionId);
          } catch (error) {
            if (error?.status === 404) {
              /* Host predates paging: stop asking, the first page is all we have. */
              setMore(false);
              return;
            }
            throw error;
          }
          const rows = Array.isArray(data?.rows) ? data.rows : [];
          if (mode === 'symbols') setSymbols((previous) => previous.concat(rows));
          else setFiles((previous) => previous.concat(rows));
          setMore(data?.more === true && rows.length > 0);
        } catch {
          /* transient: the next scroll retries */
        } finally {
          setLoadingMore(false);
        }
      }, [collapsed, mode, loading, loadingMore, more, symbols.length, files.length, filter, sessionId]);

      const onListScroll = (event) => {
        const element = event.currentTarget;
        if (element.scrollHeight - element.scrollTop - element.clientHeight <= 160) void loadMore();
      };

      const groups = useMemo(() => {
        const map = new Map();
        for (const symbol of symbols) {
          const name = String(symbol.name || '');
          const key = `${name}\u0000${symbol.kind || ''}`;
          let group = map.get(key);
          if (group === undefined) {
            group = { key, name, kind: symbol.kind, items: [] };
            map.set(key, group);
          }
          group.items.push(symbol);
        }
        return Array.from(map.values());
      }, [symbols]);

      const toggleGroup = (key) => {
        setOpenNames((previous) => {
          const next = new Set(previous);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      };

      const total = mode === 'files'
        ? Number(indexInfo?.fileCount) || 0
        : Number(indexInfo?.symbolCount) || 0;
      const loaded = mode === 'symbols' ? symbols.length : mode === 'files' ? files.length : 0;
      const statText = mode === 'tree'
        ? (rootInfo?.name || '')
        : total > 0
          ? `${total.toLocaleString('en-US')} 项，已载入 ${loaded}`
          : loaded > 0 ? `已载入 ${loaded}` : '';

      const moreFooter = loadingMore
        ? h('div', { className: 'sl-glb-state' }, '加载中…')
        : more
          ? h('div', { className: 'sl-glb-state' }, '滚动到底继续加载')
          : null;

      const body = (() => {
        if (mode === 'tree') {
          return h(FileTree, {
            sessionId,
            rootInfo,
            activePath,
            onOpen,
            t,
            filter,
          });
        }
        if (error !== null) return h('div', { className: 'sl-glb-state sl-error' }, error);
        if (loading && (mode === 'symbols' ? symbols.length === 0 : files.length === 0)) {
          return h('div', { className: 'sl-glb-state' }, '加载中…');
        }
        if (mode === 'symbols') {
          if (groups.length === 0) return h('div', { className: 'sl-glb-state' }, '没有匹配的符号。');
          return h('div', { className: 'sl-glb-list', onScroll: onListScroll }, groups.map((group) => {
            const open = group.items.length > 1 && openNames.has(group.key);
            return h('div', { key: group.key, className: 'sl-glb-group' },
              h('div', {
                role: 'button',
                tabIndex: 0,
                className: `sl-glb-row sl-glb-sym k-${symbolFamily(group.kind)}`,
                title: `${group.name}   ${group.kind || ''}   ${group.items[0].file}:${group.items[0].line}\n单击预览，双击打开`,
                onClick: () => {
                  if (group.items.length > 1) toggleGroup(group.key);
                  onPreview?.({ name: group.name, file: group.items[0].file, line: group.items[0].line, kind: group.kind });
                },
                onDoubleClick: () => onOpen(group.items[0].file, group.items[0].line),
              },
              group.items.length > 1
                ? h('span', {
                  className: `sl-glb-caret${open ? ' open' : ''}`,
                  title: '展开 / 收起同名记录',
                  onClick: (event) => { event.stopPropagation(); toggleGroup(group.key); },
                }, '▸')
                : h('span', { className: 'sl-glb-caret placeholder' }),
              h(SymbolBadge, { kind: group.kind }),
              h('span', { className: 'sl-glb-name' }, group.name),
              h('span', { className: 'sl-glb-at' }, String(group.items[0].line)),
              h('span', { className: 'sl-glb-count' }, String(group.items.length)),
              ),
              open ? h('div', { className: 'sl-glb-kids' }, group.items.map((item, index) => h('div', {
                key: `${item.file}:${item.line}:${index}`,
                role: 'button',
                tabIndex: 0,
                className: 'sl-glb-row sl-glb-def',
                title: `${item.file}:${item.line}\n单击预览，双击打开`,
                onClick: () => onPreview?.({ name: group.name, file: item.file, line: item.line, kind: group.kind }),
                onDoubleClick: () => onOpen(item.file, item.line),
              },
              h('span', { className: 'sl-glb-file' }, item.file || ''),
              h('span', { className: 'sl-glb-at' }, String(item.line)),
              ))) : null,
            );
          }), moreFooter);
        }
        return files.length === 0
          ? h('div', { className: 'sl-glb-state' }, '没有匹配的文件。')
          : h('div', { className: 'sl-glb-list', onScroll: onListScroll }, files.map((file) => h('div', {
            key: file.rel,
            role: 'button',
            tabIndex: 0,
            className: `sl-glb-row sl-glb-file-row${file.rel === (selectedFile || activePath) ? ' active' : ''}`,
            title: `${file.rel}（单击选中，双击打开）`,
            onClick: () => { setSelectedFile(file.rel); onNote?.(`${file.rel}（双击打开）`); },
            onDoubleClick: () => onOpen(file.rel, 1),
          },
          h('span', { className: 'sl-glb-fileicon' }, h(Icon, { name: 'file', size: 13 })),
          h('span', { className: 'sl-glb-name' }, String(file.rel).split('/').pop()),
          h('span', { className: 'sl-glb-at' }, String(file.symbols ?? '')),
          )), moreFooter);
      })();

      if (collapsed) return null;

      return h('aside', { className: 'sl-glb-pane', style: { width: `${width}px` }, 'aria-label': 'global symbols' },
        h('div', { className: 'sl-glb-head' },
          h('label', { className: 'sl-glb-field' },
            h('input', {
              type: 'text',
              value: filter,
              placeholder: '模糊过滤:空格分词',
              'aria-label': '过滤全局符号',
              spellCheck: false,
              style: { paddingRight: width >= 350 ? '78px' : '10px' },
              onChange: (event) => setFilter(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Escape') setFilter('');
                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (mode === 'symbols' && groups.length > 0) {
                    const hit = groups[0].items[0];
                    onOpen(hit.file, hit.line);
                  } else if (mode === 'files' && files.length > 0) {
                    onOpen(files[0].rel, 1);
                  }
                }
              },
            }),
            statText !== '' && width >= 350 ? h('span', { className: 'sl-glb-stat', title: statText }, statText) : null,
          ),
          h('div', { className: 'sl-glb-tools', role: 'tablist' },
            h('button', {
              type: 'button',
              role: 'tab',
              'aria-selected': mode === 'symbols' ? 'true' : 'false',
              className: `sl-glb-btn tone-blue${mode === 'symbols' ? ' active' : ''}`,
              title: '符号列表 symbol list',
              onClick: () => onMode('symbols'),
            }, h(Icon, { name: 'mode-symbols', size: 16 })),
            h('button', {
              type: 'button',
              role: 'tab',
              'aria-selected': mode === 'tree' ? 'true' : 'false',
              className: `sl-glb-btn tone-violet${mode === 'tree' ? ' active' : ''}`,
              title: '文件树 file browser',
              onClick: () => onMode('tree'),
            }, h(Icon, { name: 'mode-tree', size: 16 })),
            h('button', {
              type: 'button',
              role: 'tab',
              'aria-selected': mode === 'files' ? 'true' : 'false',
              className: `sl-glb-btn tone-green${mode === 'files' ? ' active' : ''}`,
              title: '文件列表 file list',
              onClick: () => onMode('files'),
            }, h(Icon, { name: 'mode-files', size: 16 })),
            h('button', {
              type: 'button',
              className: 'sl-glb-btn fold tone-slate',
              title: '收起符号窗口（向右）',
              onClick: onToggle,
            }, h(Icon, { name: 'fold-right', size: 13 })),
          ),
        ),
        h('div', { className: 'sl-glb-body' }, body),
      );
    }

    GlobalPane = React.memo(GlobalPane);
