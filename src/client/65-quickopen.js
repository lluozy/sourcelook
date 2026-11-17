    function FilePicker({ open, sessionId, rootInfo, recent, onClose, onOpen, t }) {
      const [path, setPath] = useState('');
      const [entries, setEntries] = useState([]);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState(null);
      const [filter, setFilter] = useState('');
      const inputRef = useRef(null);
      const tRef = useRef(t);
      tRef.current = t;

      useEffect(() => {
        if (!open) return;
        setPath('');
        setFilter('');
        setError(null);
        window.requestAnimationFrame(() => inputRef.current?.focus());
      }, [open, rootInfo?.root]);

      useEffect(() => {
        if (!open) return undefined;
        let alive = true;
        setLoading(true);
        setError(null);
        api(`/tree?path=${encodeURIComponent(path)}`, undefined, sessionId)
          .then((data) => {
            if (!alive) return;
            setEntries(data.entries);
          })
          .catch((failure) => {
            if (!alive) return;
            setEntries([]);
            setError(errorText(failure, tRef.current));
          })
          .finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
      }, [open, path, sessionId, rootInfo?.root]);

      useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
      }, [open, onClose]);

      if (!open) return null;

      const query = filter.trim().toLowerCase();
      const visible = query === ''
        ? entries
        : entries.filter((entry) => entry.name.toLowerCase().includes(query));
      const segments = path === '' ? [] : path.split('/');
      const recentFiles = path === '' && query === '' ? recent : [];

      const goUp = () => {
        if (path === '') return;
        setPath(parentRel(path));
      };

      return h('div', {
        className: 'sl-modal-backdrop',
        onMouseDown: (event) => { if (event.target === event.currentTarget) onClose(); },
      },
      h('div', { className: 'sl-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('quickOpen') },
        h('div', { className: 'sl-modal-head' },
          h('div', { className: 'sl-modal-title' }, t('quickOpen')),
          h('button', {
            type: 'button', className: 'sl-icon-btn', title: t('close'), 'aria-label': t('close'),
            onClick: onClose,
          }, h(Icon, { name: 'close', size: 14 })),
        ),
        h('div', { className: 'sl-modal-crumbs' },
          h('button', {
            type: 'button', className: 'sl-crumb', onClick: () => setPath(''),
            disabled: path === '',
          }, h(Icon, { name: 'folder', size: 13 }), rootInfo?.name || t('root')),
          segments.map((segment, index) => h(Fragment, { key: `${index}:${segment}` },
            h('span', { className: 'sl-crumb-sep' }, '/'),
            h('button', {
              type: 'button',
              className: 'sl-crumb',
              onClick: () => setPath(segments.slice(0, index + 1).join('/')),
            }, segment),
          )),
          h('span', { className: 'sl-crumb-spacer' }),
          h('button', {
            type: 'button', className: 'sl-icon-btn tiny', title: '←', 'aria-label': '←',
            disabled: path === '', onClick: goUp,
          }, h(Icon, { name: 'chevron', size: 13 })),
        ),
        h('div', { className: 'sl-modal-search' },
          h(Icon, { name: 'search', size: 14 }),
          h('input', {
            ref: inputRef,
            className: 'sl-filter-input',
            value: filter,
            placeholder: t('quickOpenHint'),
            spellCheck: false,
            onChange: (event) => setFilter(event.target.value),
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return;
              const firstFile = visible.find((entry) => entry.type === 'file');
              if (firstFile) void onOpen(firstFile.path);
            },
          }),
        ),
        h('div', { className: 'sl-modal-list' },
          loading ? h('div', { className: 'sl-list-state' }, t('loading')) : null,
          !loading && error ? h('div', { className: 'sl-list-state sl-error' }, error) : null,
          !loading && !error && recentFiles.length > 0 ? h('div', { className: 'sl-list-section' }, t('recent')) : null,
          !loading && !error ? recentFiles.map((rel) => h('button', {
            key: `recent:${rel}`,
            type: 'button',
            className: 'sl-list-row',
            title: rel,
            onClick: () => void onOpen(rel),
          },
          h('span', { className: 'sl-row-icon' }, h(Icon, { name: 'file', size: 15 })),
          h('span', { className: 'sl-list-name' }, baseName(rel)),
          h('span', { className: 'sl-list-meta' }, parentRel(rel) || '/'),
          )) : null,
          !loading && !error && recentFiles.length > 0 && visible.length > 0 ? h('div', { className: 'sl-list-divider' }) : null,
          !loading && !error ? visible.map((entry) => h('button', {
            key: entry.path,
            type: 'button',
            className: 'sl-list-row',
            title: entry.path,
            disabled: entry.type === 'symlink',
            onClick: () => {
              if (entry.type === 'dir') setPath(entry.path);
              else void onOpen(entry.path);
            },
          },
          h('span', { className: 'sl-row-icon' }, h(Icon, { name: entry.type === 'dir' ? 'folder' : 'file', size: 15 })),
          h('span', { className: 'sl-list-name' }, entry.name),
          entry.type === 'dir' ? h('span', { className: 'sl-list-meta' }, '›') : null,
          )) : null,
          !loading && !error && visible.length === 0 && recentFiles.length === 0
            ? h('div', { className: 'sl-list-state' }, query === '' ? t('emptyTree') : t('noMatches'))
            : null,
        ),
      ));
    }
