    /* ------------------------------------------------------- host CSS guard

       性能守卫：宿主（DSH 及其页面插件）里存在“主体无约束的 :has()”规则，例如

         :has(> ._4EiRdG_navigator._4EiRdG_fill) > :not(._4EiRdG_navigator)

       这一条的主体可以是文档里的**任意元素**。Blink 无法为它算出收窄的
       invalidation set，于是文档里任何一次 DOM 增删（Monaco 每帧滚动都会重写
       可见行）都会触发**整文档样式重算**。本机实测（200% DPI、4661 行 skbuff.h）：

         单次 DOM 改动 → UpdateLayoutTree 8290 个元素 / 55 ms
         Monaco 连续滚动 → 帧间隔 68 ms（约 14fps）
         停用这条规则后 → 同一改动 2.5 ms，滚动帧间隔 12 ms

       插件只做**运行期**处理，不改宿主任何文件：
         - 只动“以 :has( 开头”的选择器片段（主体无约束的那种反模式）；
         - 命中后把该片段换成永不匹配的类名，保留规则位置与层叠顺序；
         - 卸载时把选择器原样写回；
         - 新注入的 <style>/<link> 会重新扫描（DSH 页面插件是懒加载的）。

       代价：宿主 Files 页 navigator 的 “fill” 模式不再隐藏兄弟面板（那是该规则
       唯一的用途）。滚动从 ~14fps 回到 vsync，这个取舍是值得的。 */

    const HOST_CSS_GUARD_CLASS = '.sl-hostcss-guard-off';

    /* 只在顶层逗号处切分：:is()/:not()/:has() 参数里的逗号属于参数列表。 */
    function splitSelectorList(text) {
      const parts = [];
      let depth = 0;
      let current = '';
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === '(' || ch === '[') depth += 1;
        else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
        if (ch === ',' && depth === 0) {
          parts.push(current);
          current = '';
          continue;
        }
        current += ch;
      }
      parts.push(current);
      return parts;
    }

    /* 主体为空（“任何拥有该子元素的元素”）的 :has()。 */
    function hasUnrestrictedSubject(fragment) {
      return String(fragment || '').trim().slice(0, 5) === ':has(';
    }

    function neutraliseHostRule(rule, restoreList) {
      const selector = typeof rule.selectorText === 'string' ? rule.selectorText : '';
      if (selector === '' || selector.indexOf(HOST_CSS_GUARD_CLASS) >= 0) return 0;
      let hit = 0;
      const next = splitSelectorList(selector).map((part) => {
        if (!hasUnrestrictedSubject(part)) return part;
        hit += 1;
        return `${HOST_CSS_GUARD_CLASS}-${hit}`;
      }).join(',');
      if (hit === 0) return 0;
      try {
        rule.selectorText = next;
      } catch {
        return 0;
      }
      restoreList.push({ rule, selector });
      return hit;
    }

    function scanHostRuleList(rules, restoreList) {
      if (!rules) return 0;
      let hits = 0;
      for (let i = 0; i < rules.length; i += 1) {
        const rule = rules[i];
        /* @media / @supports / @layer / @scope 里还有嵌套样式规则。 */
        if (rule.cssRules && typeof rule.selectorText !== 'string') {
          hits += scanHostRuleList(rule.cssRules, restoreList);
          continue;
        }
        if (typeof rule.selectorText !== 'string') continue;
        hits += neutraliseHostRule(rule, restoreList);
      }
      return hits;
    }

    /** 返回 disposer：把改过的选择器原样写回。 */
    function installHostCssGuard() {
      const restoreList = [];
      let disposed = false;
      let timer = 0;
      let observer = null;
      /* 已经命中过规则之后，如果 <style>/<link> 数量没变就不必再全量遍历：
         样式表遍历是 O(规则数)，不该在每次组件的样式注入时都重跑一遍。
         <link> 的 cssRules 要等 load 之后才可读，那条路径用 force 强制重扫。 */
      let lastSheetNodes = -1;

      const countSheetNodes = () => {
        try {
          return document.querySelectorAll('head style, head link[rel="stylesheet"]').length;
        } catch {
          return -1;
        }
      };

      const scan = (force) => {
        if (disposed) return 0;
        const nodes = countSheetNodes();
        if (force !== true && restoreList.length > 0 && nodes === lastSheetNodes) return 0;
        lastSheetNodes = nodes;
        const sheets = [];
        try {
          for (let i = 0; i < document.styleSheets.length; i += 1) sheets.push(document.styleSheets[i]);
        } catch { /* ignore */ }
        try {
          for (const sheet of Array.from(document.adoptedStyleSheets || [])) {
            if (sheets.indexOf(sheet) < 0) sheets.push(sheet);
          }
        } catch { /* not supported */ }
        let hits = 0;
        for (const sheet of sheets) {
          let rules = null;
          try { rules = sheet.cssRules; } catch { continue; }  /* cross-origin: leave alone */
          hits += scanHostRuleList(rules, restoreList);
        }
        if (hits > 0 && typeof console !== 'undefined' && console.info) {
          console.info(`[sourcelook] host CSS guard: neutralised ${hits} unrestricted :has() rule(s) (whole-document style recalc on every DOM mutation)`);
        }
        return hits;
      };

      const schedule = () => {
        if (disposed || timer !== 0) return;
        timer = window.setTimeout(() => {
          timer = 0;
          scan(false);
        }, 120);
      };
      const scheduleForced = () => {
        if (disposed) return;
        scan(true);
      };

      scan(false);
      /* DSH 的页面插件按需注入 <style>；<link> 加载完才有 cssRules。 */
      try {
        observer = new MutationObserver(schedule);
        observer.observe(document.head, { childList: true });
      } catch { /* head always exists in practice */ }
      document.addEventListener('load', scheduleForced, true);

      return () => {
        disposed = true;
        if (timer !== 0) window.clearTimeout(timer);
        if (observer !== null) observer.disconnect();
        document.removeEventListener('load', scheduleForced, true);
        for (const item of restoreList) {
          try { item.rule.selectorText = item.selector; } catch { /* sheet may be gone */ }
        }
        restoreList.length = 0;
      };
    }
