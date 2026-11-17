    function Icon({ name, size = 16 }) {
      const common = {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
      };
      const small = (paths, extra = {}) => h('svg', {
        ...common,
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        strokeWidth: 1.5,
        ...extra,
      }, paths);
      switch (name) {
        /* Topbar / pane controls, paths taken from the original reader. */
        case 'maximize':
          return small([
            h('path', { key: 0, d: 'M9.5 3.5h3v3' }),
            h('path', { key: 1, d: 'M6.5 12.5h-3v-3' }),
            h('path', { key: 2, d: 'M12.5 3.5 9 7' }),
            h('path', { key: 3, d: 'M3.5 12.5 7 9' }),
          ]);
          return small([h('path', { key: 0, d: 'M10 3.5L5.5 8l4.5 4.5' })]);
        case 'fold-right':
          return small([h('path', { key: 0, d: 'M6 3.5L10.5 8 6 12.5' })]);
        case 'fold-left':
          return small([h('path', { key: 0, d: 'M10 3.5L5.5 8 10 12.5' })]);
        case 'plus':
        case 'create':
          return small([h('path', { key: 0, d: 'M8 3.5v9M3.5 8h9' })]);
        case 'back':
          return small([h('path', { key: 0, d: 'M10 3.5L5.5 8l4.5 4.5' })]);
        case 'forward':
          return small([h('path', { key: 0, d: 'M6 3.5L10.5 8 6 12.5' })]);
        case 'sort-line':
          return small([
            h('path', { key: 0, d: 'M6 3h8M6 8h8M6 13h8' }),
            h('path', { key: 1, d: 'M2 3v9m0 0l-1.4-1.6M2 12l1.4-1.6' }),
          ]);
        case 'sort-type':
          return small([
            h('rect', { key: 0, x: 1.5, y: 1.5, width: 5, height: 5, rx: 1 }),
            h('circle', { key: 1, cx: 11.5, cy: 4, r: 2.5 }),
            h('path', { key: 2, d: 'M9 10.5l2.5 4h-5z' }),
          ]);
        case 'sort-name':
          return small([
            h('path', { key: 0, d: 'M1.2 12.5L4 3.5l2.8 9M2.2 9.5h3.6' }),
            h('path', { key: 1, d: 'M9.5 3.5h5l-5 9h5' }),
          ]);
        case 'mode-symbols':
          return h('svg', { ...common, viewBox: '0 0 24 24', strokeWidth: 1.8 },
            h('path', { d: 'M10 6h11M10 12h11M10 18h11' }),
            h('path', { d: 'M4 6h1v4M4 10h2' }),
            h('path', { d: 'M6 18H4c0-1 2-2 2-3s-1-1.5-2-1' }));
        case 'mode-tree':
          return h('svg', { ...common, viewBox: '0 0 24 24', strokeWidth: 1.8 },
            h('path', { d: 'M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z' }),
            h('path', { d: 'M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 14h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z' }),
            h('path', { d: 'M3 5a2 2 0 0 0 2 2h3' }),
            h('path', { d: 'M3 3v13a2 2 0 0 0 2 2h3' }));
        case 'mode-files':
          return h('svg', { ...common, viewBox: '0 0 24 24', strokeWidth: 1.8 },
            h('path', { d: 'M20 7h-3a2 2 0 0 1-2-2V2' }),
            h('path', { d: 'M9 18a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7l5 5v9a2 2 0 0 1-2 2Z' }),
            h('path', { d: 'M3 7.6v12.8A1.6 1.6 0 0 0 4.6 22h9.8' }));
        case 'chat':
          return h('svg', common,
            h('path', { d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4H6.5A2.5 2.5 0 0 1 4 13.5z' }));
        case 'panel-right':
          return h('svg', common, h('rect', { x: 3.5, y: 5, width: 17, height: 14, rx: 2 }), h('path', { d: 'M14 5v14' }));
        case 'project':
          /* 立体的项目包：立方体比文件夹更像“工程/项目”。 */
          return h('svg', common,
            h('path', { d: 'M12 2.9 20 7.4v9.2L12 21.1 4 16.6V7.4z' }),
            h('path', { d: 'M4 7.4l8 4.5 8-4.5' }),
            h('path', { d: 'M12 11.9v9.2' }),
          );
        case 'thirds':
          return h('svg', common,
            h('rect', { x: 3, y: 5, width: 18, height: 14, rx: 2 }),
            h('path', { d: 'M9 5v14' }),
            h('path', { d: 'M15 5v14' }),
          );        case 'folder':
          return h('svg', common, h('path', { d: 'M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z' }));
        case 'folderOpen':
          return h('svg', common,
            h('path', { d: 'M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1' }),
            h('path', { d: 'M4.5 19h12.8a2 2 0 0 0 1.9-1.4l2.1-6.1H6.4a2 2 0 0 0-1.9 1.4z' }));
        case 'tree':
          return h('svg', common,
            h('path', { d: 'M5 4v16M5 8h5M5 14h5M5 20h5' }),
            h('path', { d: 'M13 6h6M13 12h6M13 18h6' }));
        case 'file':
          return h('svg', common,
            h('path', { d: 'M7 3.5h6l4.5 4.5V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z' }),
            h('path', { d: 'M13 3.5V8h4.5' }));
        case 'chevron':
          return h('svg', common, h('path', { d: 'M9 6l6 6-6 6' }));
        case 'refresh':
          return h('svg', common, h('path', { d: 'M20 11a8 8 0 1 0-2.34 5.66' }), h('path', { d: 'M20 5v6h-6' }));
        case 'close':
          return h('svg', common, h('path', { d: 'M6 6l12 12M18 6L6 18' }));
        case 'save':
          return h('svg', common, h('path', { d: 'M5 4h11l3 3v13H5z' }), h('path', { d: 'M8 4v5h7V4' }), h('path', { d: 'M8 20v-6h8v6' }));
        case 'open':
          return h('svg', common, h('path', { d: 'M3.5 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z' }), h('path', { d: 'M12 10v6M9.5 13.5 12 16l2.5-2.5' }));
        case 'split':
          return h('svg', common, h('rect', { x: 4, y: 5, width: 16, height: 14, rx: 2 }), h('path', { d: 'M13 5v14' }));
        case 'braces':
          return h('svg', common,
            h('path', { d: 'M9 4H7.5A2.5 2.5 0 0 0 5 6.5v3A2.5 2.5 0 0 1 2.5 12 2.5 2.5 0 0 1 5 14.5v3A2.5 2.5 0 0 0 7.5 20H9', stroke: '#d92d20' }),
            h('path', { d: 'M15 4h1.5A2.5 2.5 0 0 1 19 6.5v3a2.5 2.5 0 0 0 2.5 2.5 2.5 2.5 0 0 0-2.5 2.5 2.5 2.5 0 0 1-2.5 2.5H15', stroke: '#22b35b' }));
        case 'code':
          return h('svg', common, h('path', { d: 'M9 8l-4 4 4 4M15 8l4 4-4 4' }));
        case 'search':
          return h('svg', common, h('circle', { cx: 11, cy: 11, r: 6.5 }), h('path', { d: 'M16 16l4.5 4.5' }));
        case 'check':
          return h('svg', common, h('path', { d: 'M5 12.5l4.5 4.5L19 7.5' }));
        case 'list':
          return h('svg', common,
            h('path', { d: 'M4 6h2M9 6h11' }),
            h('path', { d: 'M4 12h2M9 12h11' }),
            h('path', { d: 'M4 18h2M9 18h11' }));
        case 'filter':
          return h('svg', common, h('path', { d: 'M4 5h16l-6 7v5l-4 2v-7z' }));
        default:
          return h('svg', common);
      }
    }
