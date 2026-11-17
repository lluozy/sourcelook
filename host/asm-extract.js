'use strict';
/**
 * 汇编（`.S` / `.s`）的符号提取 —— 只认**标签**，不建引用。
 *
 * 为什么单独一个模块：树里没有汇编语法（tree-sitter-c 上去就是一团 ERROR），
 * 而内核的汇编里恰好有读者最想找的东西：`__switch_to`、`ret_from_fork`、
 * `secondary_startup_64` 这些入口点。以前整类文件不收，点它们只能落到 C 里的
 * 声明（或者什么都落不到）。
 *
 * 认四种写法（内核里 99% 的入口都用这几种）：
 *
 *     foo:                         裸标签
 *     ENTRY(foo)                   arch/* 的宏（展开成 .globl foo; foo:）
 *     GLOBAL(foo) / SYM_FUNC_START(foo) / SYM_CODE_START(foo)
 *     .globl foo                  只声明、不一定在这行定义
 *
 * `.Lxxx` 这类局部标签**不算**：它们不是给读者点的名字。
 * 数字标签（`1:`）也不算。
 */

const LABEL_RE = /^([A-Za-z_][\w.$]*):/;
/* 内核的入口宏一直在增加：ENTRY / SYM_CODE_START / SYM_CODE_START_NOALIGN /
   SYM_INNER_LABEL / SYM_TYPED_FUNC_START…。这里认「ENTRY / GLOBAL / SYM_*」里
   第一个参数是名字的写法，但**排除 `_END`**（配对宏只是收尾，不产生新名字）。 */
const DECL_MACRO_RE = /^\s*(ENTRY|GLOBAL|SYM_[A-Z_]+)\s*\(\s*([A-Za-z_]\w*)/;
const GLOBL_RE = /^\s*\.(?:globl|global)\s+([A-Za-z_]\w*)/;

/** @returns {Array<{name:string, kind:string, line:number, parent:'', type:string, config:''}>} */
function extract(text) {
  const out = [];
  const seen = new Set();
  const lines = String(text || '').split(/\r?\n/);

  const add = (name, line, kind) => {
    if (!name || seen.has(name)) return;
    if (name.startsWith('.L') || name.startsWith('.')) return;   // 局部/伪标签
    if (/^\d+$/.test(name)) return;
    seen.add(name);
    out.push({ name, kind: kind || 'function', line, parent: '', type: '', config: '' });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;

    const label = LABEL_RE.exec(line);
    if (label) { add(label[1], ln, 'function'); continue; }

    const macro = DECL_MACRO_RE.exec(line);
    if (macro && !/_END$/.test(macro[1])) { add(macro[2], ln, 'function'); continue; }

    const glob = GLOBL_RE.exec(line);
    if (glob) add(glob[1], ln, 'function');
  }
  return out;
}

module.exports = { extract };
