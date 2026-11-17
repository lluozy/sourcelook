    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        beacon('apply');
        /* 预热 Monaco：插件脚本一跑起来就开拉，和 React 挂载、/info、读文件并行。
           以前是等编辑器 effect（挂载后）才开始，白等约 1s。失败无所谓，
           编辑器 effect 里还会再拉一次（memo 过，不会重复下载）。 */
        void ensureMonaco().catch(() => { /* effect 里会再试 */ });
        for (const [locale, dict] of Object.entries({ zh: ZH, 'zh-CN': ZH, en: EN, 'en-US': EN })) {
          ctx.effect(
            () => ctx.locale.register(NS, locale, dict),
            `sourcelook locale ${locale}`,
          );
        }
        const t = ctx.locale.bind(NS);

        /* Register through the Harness shortcut service instead of listening to
         * raw keydown: Desktop intercepts accepted combinations before local
         * handlers, and Ctrl+P is already DSH's Files command. Ctrl+Alt+P (and
         * its Cmd+Option+P form) is free and appears in Settings → Shortcuts. */
        const shortcuts = ctx.get('shortcuts');
        if (shortcuts && typeof shortcuts.register === 'function') {
          ctx.effect(() => {
            try {
              return shortcuts.register({
                id: 'sourcelook.symbol-search',
                label: () => t('symbolSearch'),
                aliases: ['SourceLook symbol search'],
                group: 'application',
                regions: ['page', 'editable'],
                modals: [],
                defaults: {
                  'desktop:windows': { code: 'KeyP', modifiers: ['primary', 'alt'] },
                  'desktop:macos': { code: 'KeyP', modifiers: ['primary', 'alt'] },
                  /* Web browsers reserve Mod+P and the Files page owns Mod+Alt+P;
                   * a three-modifier chord is the free Web binding. */
                  'web:windows': { code: 'KeyP', modifiers: ['primary', 'alt', 'shift'] },
                  'web:macos': { code: 'KeyP', modifiers: ['primary', 'alt', 'shift'] },
                },
                resolve: () => ({
                  status: 'handled',
                  run: () => window.dispatchEvent(new CustomEvent('sourcelook:open-symbol-search')),
                }),
              });
            } catch (error) {
              console.error('[sourcelook] shortcut registration failed:', error);
              return () => {};
            }
          }, 'sourcelook: symbol search shortcut');

          ctx.effect(() => {
            try {
              return shortcuts.register({
                id: 'sourcelook.reload-ui',
                label: () => '重新加载 SourceLook 界面',
                aliases: ['SourceLook reload interface'],
                group: 'application',
                regions: ['page', 'editable'],
                modals: [],
                defaults: {
                  'desktop:windows': { code: 'KeyR', modifiers: ['primary', 'alt'] },
                  'desktop:macos': { code: 'KeyR', modifiers: ['primary', 'alt'] },
                  'web:windows': { code: 'KeyR', modifiers: ['primary', 'alt', 'shift'] },
                  'web:macos': { code: 'KeyR', modifiers: ['primary', 'alt', 'shift'] },
                },
                resolve: () => ({
                  status: 'handled',
                  run: () => window.location.reload(),
                }),
              });
            } catch (error) {
              console.error('[sourcelook] reload shortcut registration failed:', error);
              return () => {};
            }
          }, 'sourcelook: reload UI shortcut');
        }

        /* 运行期的宿主样式守卫：停用宿主里“主体无约束的 :has()”规则。
           这类规则会让文档里任何一次 DOM 改动触发整文档样式重算 —— 实测
           Monaco 滚动从 68ms/帧 降到 12ms/帧。只改内存里的选择器，不动文件，
           卸载时原样写回。详见 45-host-css.js。 */
        ctx.effect(() => installHostCssGuard(), 'sourcelook: host css guard');

        const BoundSourceLook = (props) => h(SourceLookBoundary, null,
          h(SourceLookPlugin, Object.assign({}, props, { ctx })));
        BoundSourceLook.displayName = 'SourceLook';
        ctx.effect(
          () => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: 'sourcelook',
            order: 100,
            label: t('appName'),
          }, BoundSourceLook)),
          'sourcelook: full-window overlay',
        );
      },
    };
  },
});
