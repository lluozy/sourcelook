    /* In-editor right-click menu. The adapter emits the word under the pointer,
     * so the menu describes what the user actually clicked instead of the caret. */
    function SlContextMenu({ menu, items, onClose, header }) {
      useEffect(() => {
        if (menu === null) return undefined;
        const close = () => onClose();
        const escape = (event) => {
          if (event.key === 'Escape') onClose();
        };
        document.addEventListener('mousedown', close);
        document.addEventListener('keydown', escape);
        document.addEventListener('scroll', close, true);
        return () => {
          document.removeEventListener('mousedown', close);
          document.removeEventListener('keydown', escape);
          document.removeEventListener('scroll', close, true);
        };
      }, [menu, onClose]);

      if (menu === null) return null;
      const width = 248;
      const height = Math.max(48, items.length * 28 + (header ? 40 : 16));
      const left = Math.max(8, Math.min(menu.x, window.innerWidth - width - 8));
      const top = Math.max(8, Math.min(menu.y, window.innerHeight - height - 8));

      return h('div', {
        className: 'sl-ctx-menu',
        role: 'menu',
        style: { left: `${left}px`, top: `${top}px`, width: `${width}px` },
        onMouseDown: (event) => event.stopPropagation(),
      },
      header ? h('div', { className: 'sl-ctx-head' }, header) : null,
      items.filter(Boolean).map((item, index) => {
        if (item?.sep === true) return h('div', { key: `sep-${index}`, className: 'sl-ctx-sep' });
        return h('button', {
          key: `${item.label}-${index}`,
          type: 'button',
          role: 'menuitem',
          className: `sl-ctx-item${item.danger ? ' danger' : ''}`,
          disabled: item.disabled === true,
          onClick: () => {
            onClose();
            item.action?.();
          },
        },
        h('span', { className: 'sl-ctx-label' }, item.label),
        item.shortcut ? h('span', { className: 'sl-ctx-key' }, item.shortcut) : null,
        );
      }),
      );
    }

    /* Floating action bar: appears next to a double-clicked word, exactly like
     * the original reader. A single click anywhere dismisses it, and its
     * buttons act on the word that was selected, not on the caret. */
    const FLOAT_ACTIONS = [
      { id: 'find', label: '查找', title: '在结果窗口里查找这个词' },
      { id: 'callers', label: '调用', title: '列出所有引用（谁调用了它）' },
      { id: 'define', label: '定义', title: '跳到定义' },
      { id: 'highlight', label: '高亮', title: '在本文件里标亮这个词（Shift+F8）' },
      { id: 'ai', label: 'AI', title: '把这段代码发给 DSH 助手' },
      { id: 'copy', label: '复制', title: '复制这个词' },
    ];

    /* Macro expansion popover: the call with its arguments, the substituted body
       (one clickable line per source line of the #define), and the caveat. */
    function SlMacroPop({ data, onClose, onJump }) {
      const boxRef = useRef(null);
      useEffect(() => {
        if (data === null) return undefined;
        const escape = (event) => {
          if (event.key === 'Escape') onClose();
        };
        const outside = (event) => {
          if (boxRef.current && !boxRef.current.contains(event.target)) onClose();
        };
        document.addEventListener('keydown', escape);
        document.addEventListener('pointerdown', outside);
        return () => {
          document.removeEventListener('keydown', escape);
          document.removeEventListener('pointerdown', outside);
        };
      }, [data, onClose]);

      if (data === null) return null;
      const lines = String(data.text || '').split('\n');
      return h('div', {
        ref: boxRef,
        className: 'sl-macro-pop',
        role: 'dialog',
        'aria-label': '宏展开',
        style: { left: `${data.x}px`, top: `${data.y}px`, width: `${data.width}px` },
        onMouseDown: (event) => event.stopPropagation(),
      },
      h('div', { className: 'mp-head' },
        h('span', { className: 'mp-title' }, '展开'),
        h('span', { className: 'mp-call', title: data.callText }, data.callText),
        h('button', {
          type: 'button',
          className: 'mp-close',
          title: '关闭（Esc）',
          onClick: onClose,
        }, '×'),
      ),
      h('div', { className: 'mp-body' }, lines.map((text, index) => {
        const lineNo = data.bodyLine ? data.bodyLine + index : 0;
        return h('span', {
          key: index,
          className: 'mp-ln',
          title: lineNo ? `宏体第 ${lineNo} 行（点击跳过去）` : '',
          onClick: lineNo && data.file ? () => onJump(data.file, lineNo) : undefined,
        }, text === '' ? ' ' : text, index < lines.length - 1 ? '\n' : '');
      })),
      data.partial
        ? h('div', { className: 'mp-foot' }, '只做参数替换 · 不展开 include、不求值条件编译')
        : null,
      );
    }
    function SlFloatActions({ bar, onAction, onClose }) {
      useEffect(() => {
        if (bar === null) return undefined;
        const close = () => onClose();
        const escape = (event) => {
          if (event.key === 'Escape') onClose();
        };
        document.addEventListener('mousedown', close);
        document.addEventListener('keydown', escape);
        document.addEventListener('scroll', close, true);
        return () => {
          document.removeEventListener('mousedown', close);
          document.removeEventListener('keydown', escape);
          document.removeEventListener('scroll', close, true);
        };
      }, [bar, onClose]);

      if (bar === null) return null;
      const actions = bar.macro === true
        ? FLOAT_ACTIONS.concat([{ id: 'macro', label: '展开', title: '把实参代进宏体（本地计算，不调模型）' }])
        : FLOAT_ACTIONS;
      const width = bar.macro === true ? 352 : 300;
      const left = Math.max(8, Math.min(bar.x, window.innerWidth - width - 12));
      const top = Math.max(4, Math.min(bar.y, window.innerHeight - 48));
      return h('div', {
        className: 'sl-float-bar',
        style: { left: `${left}px`, top: `${top}px` },
        onMouseDown: (event) => event.stopPropagation(),
      },
      h('span', { className: 'sl-float-kind' }, bar.kind || '符号'),
      actions.map((action) => h('button', {
        key: action.id,
        type: 'button',
        className: `sl-float-btn${action.id === 'highlight' && bar.highlighted ? ' on' : ''}`,
        title: action.title,
        disabled: bar.word === '' && action.id !== 'ai',
        onClick: () => {
          onClose();
          onAction(action.id, bar);
        },
      }, action.label)),
      );
    }
