    /* Semantic colouring v1: paint the declaration token of each indexed symbol
     * on its own line. This is deliberately the KernelSight first-pass idea
     * (index -> decoration), not a scope resolver: it never recolours arbitrary
     * uses, so a local variable that shares a global's name is not mislabelled.
     * Only macro/type/function declarations get a colour; variables stay plain. */
    const SEMANTIC_STYLE = {
      macro: { color: 'var(--sl-syn-macro, #b04a3c)', fontWeight: '700' },
      struct: { color: 'var(--sl-syn-type, #0f6472)', fontWeight: '600' },
      class: { color: 'var(--sl-syn-type, #0f6472)', fontWeight: '600' },
      union: { color: 'var(--sl-syn-type, #0f6472)', fontWeight: '600' },
      enum: { color: 'var(--sl-syn-type, #0f6472)', fontWeight: '600' },
      typedef: { color: 'var(--sl-syn-type, #0f6472)', fontWeight: '600' },
      type: { color: 'var(--sl-syn-type, #0f6472)', fontWeight: '600' },
      interface: { color: 'var(--sl-syn-type, #0f6472)', fontWeight: '600' },
      function: { color: 'var(--sl-syn-fn-def, #8b2be2)', fontWeight: '700' },
    };

    function semanticSpansFor(model, symbols) {
      if (!model || !Array.isArray(symbols) || symbols.length === 0) return [];
      const byKind = new Map();
      for (const symbol of symbols) {
        if (!symbol || typeof symbol.name !== 'string' || symbol.name === '') continue;
        const line = Number(symbol.line);
        if (!Number.isInteger(line) || line < 1 || line > model.getLineCount()) continue;
        const style = SEMANTIC_STYLE[String(symbol.kind || '').toLowerCase()];
        if (!style) continue;
        let lineText = '';
        try { lineText = model.getLineContent(line); } catch { continue; }
        const index = lineText.indexOf(symbol.name);
        if (index < 0) continue;
        const kind = String(symbol.kind).toLowerCase();
        if (!byKind.has(kind)) byKind.set(kind, []);
        byKind.get(kind).push({
          start: { line, column: index + 1 },
          end: { line, column: index + 1 + symbol.name.length },
        });
      }
      return [...byKind.entries()].map(([kind, ranges]) => ({
        kind,
        ranges,
        style: SEMANTIC_STYLE[kind],
      }));
    }
