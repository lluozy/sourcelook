    /* ------------------------------------------------------------------ dev probe
     * Development-only layout measurement. Enable with
     *   localStorage['sourcelook.probe'] = '1'
     * then reload. The report is split across /diag/beacon calls (the Host caps
     * each detail at 1000 chars) and can be read back from /diag/state.
     * No user content is included; only geometry, classes and text labels. */
    (function sourcelookDevProbe() {
      /* Development only: enable with
       *   localStorage['sourcelook.probe'] = '1'
       * then restart/reload. Off by default so a normal install posts nothing. */
      let probeEnabled = false;
      try {
        probeEnabled = window.localStorage.getItem('sourcelook.probe') === '1';
      } catch {
        probeEnabled = false;
      }
      if (!probeEnabled) return;
      const errors = [];
      window.addEventListener('error', (event) => {
        errors.push(String(event.message || event.error || ''));
      });
      const boxOf = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
      };
      const pick = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
          font: [cs.fontSize, cs.lineHeight, cs.fontWeight],
          color: cs.color,
          bg: cs.backgroundColor,
          border: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`,
          radius: cs.borderRadius,
          pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft],
          display: cs.display,
          text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60),
          cls: typeof el.className === 'string' ? el.className : '',
        };
      };
      const q = (sel) => document.querySelector(sel);
      const qa = (sel) => Array.from(document.querySelectorAll(sel));
      const collect = () => {
        const html = document.documentElement;
        const topbar = q('.sl-topbar, .sl-titlebar');
        const status = q('.sl-status, .sl-statusbar');
        return {
          at: new Date().toISOString(),
          viewport: [window.innerWidth, window.innerHeight, window.devicePixelRatio],
          mode: html.dataset.sourcelookMode || '',
          build: document.querySelector('.sl-layer')?.getAttribute('data-sl-build') || '',
          errors,
          layer: pick(q('.sl-layer')),
          topbar: pick(topbar),
          topbarChildren: topbar ? Array.from(topbar.children).slice(0, 26).map((el) => ({ tag: el.tagName, cls: typeof el.className === 'string' ? el.className : '', box: boxOf(el), text: (el.textContent || '').trim().slice(0, 24) })) : [],
          body: pick(q('.sl-body')),
          panes: {
            symbol: pick(q('.sl-symbol-pane')),
            main: pick(q('.sl-main')),
            global: pick(q('.sl-global')),
            results: pick(q('.sl-results')),
            status: pick(status),
            tabs: pick(q('.sl-tabs')),
          },
          counts: {
            symRows: qa('.sl-sym-row').length,
            globalRows: qa('.sl-global-row, .sl-g-row').length,
            cards: qa('.sl-cw-card').length,
            cardsFallback: qa('.sl-results > *').length,
          },
          cards: qa('.sl-cw-card, .sl-cw-right, .sl-results-preview').map(pick),
          dsh: (() => { const root = document.getElementById('root'); return root ? { box: boxOf(root), style: root.getAttribute('style') || '' } : null; })(),
          dshMenu: (() => {
            const menu = document.querySelector('[data-windows-menu]');
            if (menu === null) return null;
            return {
              display: getComputedStyle(menu).display,
              parent: `${menu.parentElement?.tagName}.${typeof menu.parentElement?.className === 'string' ? menu.parentElement.className : ''}`,
              html: menu.outerHTML.slice(0, 160),
            };
          })(),
          panelCss: (document.getElementById('sourcelook-dsh-panel')?.textContent || '').slice(0, 400),
          layerParent: (() => {
            const layer = q('.sl-layer');
            return layer ? `${layer.parentElement?.tagName}#${layer.parentElement?.id}.${typeof layer.parentElement?.className === 'string' ? layer.parentElement.className : ''}` : '';
          })(),
          sampleRow: pick(q('.sl-sym-row')),
          sampleGlobal: pick(q('.sl-glb-row')),
          foldBtn: pick(q('.sl-glb-btn.fold')),
          sampleCard: pick(q('.sl-cw-card')),
          topPath: pick(q('.sl-top-path')),
          globalHead: qa('.sl-glb-head > *').map((el) => ({ cls: typeof el.className === 'string' ? el.className : '', box: boxOf(el) })),
          symHead: qa('.sl-sym-head > *').map((el) => ({ cls: typeof el.className === 'string' ? el.className : '', box: boxOf(el) })),
          cwToggle: pick(q('.sl-cw-toggle')),
          statusText: status ? (status.innerText || '').replace(/\s+/g, ' ').slice(0, 300) : '',
        };
      };
      const post = (stage, detail) => fetch(`${API}/diag/beacon`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [HEADER]: '1' },
        body: JSON.stringify({ stage, detail }),
      }).catch(() => {});
      let tries = 0;
      const tick = () => {
        tries += 1;
        if (!q('.sl-layer') && tries < 60) {
          setTimeout(tick, 250);
          return;
        }
        setTimeout(() => {
          let text = '';
          try {
            text = JSON.stringify(collect());
          } catch (error) {
            text = JSON.stringify({ at: new Date().toISOString(), fatal: String(error), errors });
          }
          const size = 900;
          const total = Math.max(1, Math.ceil(text.length / size));
          for (let index = 0; index < total; index += 1) {
            post(`probe:${index}:${total}`, text.slice(index * size, (index + 1) * size));
          }
        }, 1200);
      };
      tick();
    })();
