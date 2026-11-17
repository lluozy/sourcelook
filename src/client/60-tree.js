    /* Lazy file tree used by the global pane's tree mode. The pane owns the
     * filter field, so this component renders rows only. */
    function FileTree({ sessionId, rootInfo, activePath, onOpen, t, filter = '' }) {
      const root = rootInfo?.root ?? '';
      const [levels, setLevels] = useState({});
      const [expanded, setExpanded] = useState(() => new Set());
      const loadingRef = useRef(new Set());
      const tRef = useRef(t);
      tRef.current = t;

      const loadLevel = useCallback(async (rel) => {
        if (root === '' || loadingRef.current.has(rel)) return;
        loadingRef.current.add(rel);
        setLevels((prev) => ({ ...prev, [rel]: { ...(prev[rel] || {}), loading: true, error: null } }));
        try {
          const data = await api(`/tree?path=${encodeURIComponent(rel)}`, undefined, sessionId);
          setLevels((prev) => ({
            ...prev,
            [rel]: { entries: data.entries, truncated: data.truncated, loading: false, error: null },
          }));
        } catch (error) {
          setLevels((prev) => ({
            ...prev,
            [rel]: { entries: [], loading: false, error: errorText(error, tRef.current) },
          }));
        } finally {
          loadingRef.current.delete(rel);
        }
      }, [root, sessionId]);

      useEffect(() => {
        setLevels({});
        setExpanded(new Set());
        if (root !== '') void loadLevel('');
      }, [root, loadLevel]);

      const toggleDir = useCallback((rel) => {
        setExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(rel)) next.delete(rel);
          else next.add(rel);
          return next;
        });
        const level = levels[rel];
        if (level === undefined || level.error) void loadLevel(rel);
      }, [levels, loadLevel]);

      const query = String(filter || '').trim().toLowerCase();

      const rowsOf = (rel, depth) => {
        const level = levels[rel];
        if (level === undefined) return null;
        if (level.loading === true && level.entries === undefined) {
          return [h('div', { key: `loading:${rel}`, className: 'sl-glb-state' }, t('loading'))];
        }
        if (level.error) {
          return [h('div', { key: `error:${rel}`, className: 'sl-glb-state sl-error' }, level.error)];
        }
        const all = level.entries || [];
        const entries = query === ''
          ? all
          : all.filter((entry) => entry.name.toLowerCase().includes(query) || entry.type === 'dir');
        if (entries.length === 0) {
          if (query !== '') return null;
          return [h('div', { key: `empty:${rel}`, className: 'sl-glb-state' }, t('emptyTree'))];
        }
        const out = [];
        for (const entry of entries) {
          const isDir = entry.type === 'dir';
          const isOpen = isDir && expanded.has(entry.path);
          out.push(h('div', {
            key: entry.path,
            role: 'button',
            tabIndex: entry.type === 'symlink' ? -1 : 0,
            className: `sl-tree-row${entry.path === activePath ? ' active' : ''}${entry.type === 'symlink' ? ' disabled' : ''}`,
            style: { paddingLeft: `${6 + depth * 14}px` },
            title: entry.path,
            onClick: () => {
              if (entry.type === 'symlink') return;
              if (isDir) toggleDir(entry.path);
              else void onOpen(entry.path);
            },
          },
          isDir
            ? h('span', { className: `sl-tree-caret${isOpen ? ' open' : ''}` }, h(Icon, { name: 'chevron', size: 11 }))
            : h('span', { className: 'sl-tree-caret placeholder' }),
          h('span', { className: 'sl-tree-icon' }, h(Icon, { name: isDir ? (isOpen ? 'folderOpen' : 'folder') : 'file', size: 14 })),
          h('span', { className: 'sl-tree-name' }, entry.name),
          ));
          if (isOpen) {
            const children = rowsOf(entry.path, depth + 1);
            if (children) out.push(...children);
          }
        }
        if (level.truncated === true && query === '') {
          out.push(h('div', { key: `truncated:${rel}`, className: 'sl-glb-state' }, '…'));
        }
        return out;
      };

      return h(Fragment, null, rowsOf('', 0));
    }

    function errorText(error, t) {
      switch (error?.code) {
        case 'too_large': return t('tooLarge');
        case 'binary': return t('binary');
        case 'outside_root': return t('outsideRoot');
        case 'no_parent': return t('noParent');
        case 'symlink': return t('symlink');
        case 'not_utf8': return t('notUtf8');
        default:
          return typeof error?.message === 'string' && error.message !== ''
            ? error.message
            : t('openFailed');
      }
    }
