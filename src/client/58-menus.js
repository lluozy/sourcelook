    /* Compact menubar used by the KernelSight-style topbar. A menu owns only
     * its open state; every item is a plain callback so the app remains the
     * single place that knows how to save, find, toggle panes, etc. */
    function SlMenu({ label, items, title, className }) {
      const [open, setOpen] = useState(false);
      const rootRef = useRef(null);

      useEffect(() => {
        if (!open) return undefined;
        /* 菜单打开时隐藏 DSH 右上角四个悬浮尺寸按钮：它们 z-index 极高，
           否则会盖住“帮助”等菜单。 */
        document.body.setAttribute('data-sl-menu-open', '1');
        const close = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
        };
        const escape = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', close);
        document.addEventListener('keydown', escape);
        return () => {
          document.removeEventListener('mousedown', close);
          document.removeEventListener('keydown', escape);
          if (!document.querySelector('.sl-menu.open')) {
            document.body.removeAttribute('data-sl-menu-open');
          }
        };
      }, [open]);

      return h('div', { className: `sl-menu${className ? ` ${className}` : ''}${open ? ' open' : ''}`, ref: rootRef },
        h('button', {
          type: 'button',
          className: 'sl-menu-btn',
          'aria-haspopup': 'menu',
          'aria-expanded': open ? 'true' : 'false',
          title: title || label,
          onPointerDown: (event) => event.stopPropagation(),
          onClick: () => setOpen((value) => !value),
        }, label, h('span', { className: 'sl-menu-caret' }, h(Icon, { name: 'chevron', size: 9 }))),
        open ? h('div', { className: 'sl-menu-pop', role: 'menu' },
          items.filter(Boolean).map((item, index) => {
            if (item?.sep === true) return h('div', { key: `sep-${index}`, className: 'sl-menu-sep' });
            return h('button', {
              key: `${item.label}-${index}`,
              type: 'button',
              role: 'menuitem',
              className: `sl-menu-item${item.danger ? ' danger' : ''}`,
              disabled: item.disabled === true,
              onPointerDown: (event) => event.stopPropagation(),
              onClick: () => {
                setOpen(false);
                item.action?.();
              },
            },
            h('span', { className: 'sl-menu-label' }, item.label),
            item.shortcut ? h('span', { className: 'sl-menu-key' }, item.shortcut) : null,
            );
          }),
        ) : null,
      );
    }
