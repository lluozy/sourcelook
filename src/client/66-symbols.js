    /* Shared symbol vocabulary for the outline, search and results lists.
     * Shapes and colours follow the original reader: a 12-view stroke glyph in a
     * 15px rounded square; macros red, functions violet, types teal, variables
     * blue, everything else grey. */
    const SYMBOL_KIND_LABEL = {
      function: 'fn',
      macro: 'M',
      struct: 'T',
      class: 'T',
      union: 'T',
      enum: 'E',
      typedef: 'T',
      type: 'T',
      interface: 'T',
      variable: 'v',
      constant: 'C',
      member: '.',
      field: '.',
      parameter: 'p',
      namespace: 'N',
      label: 'L',
      include: '#',
    };

    const SYMBOL_FAMILY = {
      function: 'func',
      method: 'func',
      call: 'func',
      macro: 'macro',
      define: 'macro',
      struct: 'type',
      class: 'type',
      union: 'type',
      enum: 'type',
      enum_member: 'type',
      typedef: 'type',
      type: 'type',
      interface: 'type',
      namespace: 'other',
      variable: 'var',
      constant: 'var',
      member: 'var',
      field: 'var',
      parameter: 'var',
      local: 'var',
      include: 'other',
      label: 'other',
    };

    /* tag + props, so the badge stays a real SVG instead of a text glyph. */
    const SYMBOL_SHAPES = {
      function: [['path', { d: 'M4.6 2.4C3.3 3.4 3.3 8.6 4.6 9.6' }], ['path', { d: 'M7.4 2.4C8.7 3.4 8.7 8.6 7.4 9.6' }]],
      call: [['path', { d: 'M2.5 6h6.2' }], ['path', { d: 'M6.5 3.7 8.8 6l-2.3 2.3' }]],
      macro: [['path', { d: 'M4.4 2.4 3.5 9.6M8.3 2.4 7.4 9.6M2.6 4.8h7M2.1 7.4h7' }]],
      struct: [['rect', { x: 2.2, y: 3, width: 7.6, height: 6, rx: 1.2 }], ['path', { d: 'M5.3 3v6' }]],
      union: [
        ['rect', { x: 2, y: 2.4, width: 5, height: 5, rx: 1 }],
        ['rect', { x: 5, y: 4.6, width: 5, height: 5, rx: 1 }],
      ],
      enum: [
        ['circle', { cx: 2.9, cy: 3.1, r: 0.85, fill: 'currentColor', stroke: 'none' }],
        ['circle', { cx: 2.9, cy: 6, r: 0.85, fill: 'currentColor', stroke: 'none' }],
        ['circle', { cx: 2.9, cy: 8.9, r: 0.85, fill: 'currentColor', stroke: 'none' }],
        ['path', { d: 'M5.4 3.1h4M5.4 6h4M5.4 8.9h4' }],
      ],
      enum_member: [['path', { d: 'M6 2.5 9.5 6 6 9.5 2.5 6z' }]],
      typedef: [
        ['path', { d: 'M2.6 6.1V3.2h2.9l3.9 3.9-2.9 2.9z' }],
        ['circle', { cx: 4.2, cy: 4.7, r: 0.65, fill: 'currentColor', stroke: 'none' }],
      ],
      class: [['rect', { x: 2.3, y: 2.5, width: 7.4, height: 7, rx: 1.2 }], ['path', { d: 'M2.3 5.1h7.4' }]],
      variable: [['path', { d: 'M2.9 4.3 6 8.1l3.1-3.8' }]],
      local: [['path', { d: 'M3.3 3.7 8.7 8.3M8.7 3.7 3.3 8.3' }]],
      member: [
        ['circle', { cx: 3, cy: 6, r: 1.15, fill: 'currentColor', stroke: 'none' }],
        ['path', { d: 'M5.3 6h4' }],
      ],
      parameter: [
        ['path', { d: 'M2.3 6h4.1' }],
        ['path', { d: 'M4.6 3.9 6.7 6l-2.1 2.1' }],
        ['path', { d: 'M8.4 2.9v6.2' }],
      ],
      preproc: [['path', { d: 'M2.9 2.4v7.2' }], ['path', { d: 'M2.9 3.1h6l-1.7 2.1 1.7 2.1h-6' }]],
      comment: [['path', { d: 'M2.6 3h6.8v4.2H5.9L3.5 9.3V7.2H2.6z' }]],
      declaration: [['path', { d: 'M3 2.5h4.4L9.2 4.3v5.2H3z' }], ['path', { d: 'M7.2 2.5v2h2' }]],
      other: [['circle', { cx: 6, cy: 6, r: 1.3, fill: 'currentColor', stroke: 'none' }]],
    };

    const SYMBOL_FAMILY_SHAPE = {
      func: 'function',
      macro: 'macro',
      type: 'struct',
      var: 'variable',
      other: 'other',
    };

    function symbolKindLabel(kind) {
      const key = String(kind || '').toLowerCase();
      if (SYMBOL_KIND_LABEL[key] !== undefined) return SYMBOL_KIND_LABEL[key];
      return key === '' ? '?' : key.slice(0, 1).toUpperCase();
    }

    function symbolFamily(kind) {
      const key = String(kind || '').toLowerCase();
      return SYMBOL_FAMILY[key] || 'other';
    }

    function SymbolBadge({ kind }) {
      const key = String(kind || 'unknown').toLowerCase();
      const family = symbolFamily(key);
      const shapes = SYMBOL_SHAPES[key] || SYMBOL_SHAPES[SYMBOL_FAMILY_SHAPE[family]] || SYMBOL_SHAPES.other;
      return h('span', {
        className: `sl-kbadge k-${family}`,
        title: kind || '',
        'aria-hidden': true,
      }, h('svg', {
        viewBox: '0 0 12 12',
        width: 10,
        height: 10,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
      }, shapes.map(([tag, props], index) => h(tag, { key: index, ...props }))));
    }
