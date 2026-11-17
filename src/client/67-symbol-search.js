    function SymbolSearch({ open, query, results, loading, error, needsIndex, onQuery, onSelect, onClose, t }) {
      const inputRef = useRef(null);

      useEffect(() => {
        if (!open) return;
        const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
        return () => window.cancelAnimationFrame(frame);
      }, [open]);

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
      const trimmed = query.trim();

      return h('div', {
        className: 'sl-modal-backdrop',
        onMouseDown: (event) => { if (event.target === event.currentTarget) onClose(); },
      },
      h('div', { className: 'sl-modal sl-symbol-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'symbol search' },
        h('div', { className: 'sl-modal-head' },
          h('div', { className: 'sl-modal-title' }, '符号搜索'),
          h('span', { className: 'sl-modal-kbd' }, symbolSearchShortcutLabel()),
          h('button', {
            type: 'button', className: 'sl-icon-btn', title: t('close'), 'aria-label': t('close'),
            onClick: onClose,
          }, h(Icon, { name: 'close', size: 14 })),
        ),
        h('div', { className: 'sl-modal-search' },
          h(Icon, { name: 'search', size: 14 }),
          h('input', {
            ref: inputRef,
            className: 'sl-filter-input',
            value: query,
            placeholder: '输入符号名…',
            spellCheck: false,
            onChange: (event) => onQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return;
              if (results.length === 0) return;
              event.preventDefault();
              onSelect(results[0]);
            },
          }),
        ),
        h('div', { className: 'sl-modal-list sl-symbol-list' },
          loading ? h('div', { className: 'sl-list-state' }, t('loading')) : null,
          !loading && error ? h('div', { className: 'sl-list-state sl-error' }, error) : null,
          !loading && !error && needsIndex ? h('div', { className: 'sl-list-state' }, '还没有索引：先在底部状态栏点“建立索引”。') : null,
          !loading && !error && !needsIndex && trimmed === '' ? h('div', { className: 'sl-list-state' }, '输入符号名开始搜索。') : null,
          !loading && !error && !needsIndex && trimmed !== '' && results.length === 0 ? h('div', { className: 'sl-list-state' }, t('noMatches')) : null,
          !loading && !error && !needsIndex ? results.map((item) => h('button', {
            key: `${item.file}:${item.line}:${item.name}`,
            type: 'button',
            className: 'sl-symbol-row',
            title: `${item.name}  ${item.file}:${item.line}`,
            onClick: () => onSelect(item),
          },
          h(SymbolBadge, { kind: item.kind }),
          h('span', { className: 'sl-symbol-name' }, item.name),
          h('span', { className: 'sl-symbol-where' }, `${item.file}:${item.line}`),
          )) : null,
        ),
      ));
    }
