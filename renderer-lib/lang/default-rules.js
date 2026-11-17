(function (root) {
'use strict';
/* 「未知语言」的默认规则（REQUIREMENTS-GAP.md G.4）。
 *
 * 这不是任何语言的表，而是最后一道兜底：文件没有注册条目时，**宁可给出
 * 「可能是符号」的行并标注近似**，也不假装这个文件没有符号。
 *
 * 三条自我约束：
 *   - 只做一行内的粗筛（不折叠签名、不跨行、不解析）——所以产物永远带
 *     confidence:'approx'，不能和 tree-sitter 的结果平起平坐；
 *   - 先到先得：patterns 的顺序就是优先级（宏 → 关键字 → 类型 → 函数 →
 *     变量 → 顶层赋值）；
 *   - stop 里的词是控制结构而不是定义（`if (x) {` 不是函数）。
 *
 * 本文件属于语言数据（lang/），允许出现各语言的词汇；执行器在
 * main/symbol-approx.js，核心不直接持有这些词。 */
root.LangDefaultRules = {
  confidence: 'approx',

  patterns: [
    /* 预处理宏：跨语言最没有歧义的一类（C / 汇编 / 部分构建脚本）。 */
    { kind: 'macro', re: '^\\s*#\\s*define\\s+([A-Za-z_]\\w*)' },

    /* 关键字引导的定义：def / function / func / fn / sub / proc … */
    { kind: 'function',
      re: '^\\s*(?:def|function|func|fn|sub|subroutine|proc|procedure)\\s+([A-Za-z_$][\\w$]*)' },

    /* 类型：class / interface / struct / enum / trait / impl …（归入 type 槽） */
    { kind: 'struct',
      re: '^\\s*(?:class|interface|struct|union|enum|trait|impl|object|module|namespace|record|protocol)\\s+([A-Za-z_$][\\w$]*)' },

    /* C / JS 风格：`类型 名字(参数) {` —— 必须带左花括号，否则普通调用语句
       （`print(x)` 独占一行）会被当成定义。 */
    { kind: 'function',
      re: '^\\s*(?:[A-Za-z_$][\\w$]*[\\s*&]+)+([A-Za-z_$][\\w$]*)\\s*\\([^;{}]*\\)\\s*\\{\\s*(?://.*|/\\*.*)?$' },

    /* 声明式变量：const / let / var / val / auto */
    { kind: 'variable',
      re: '^\\s*(?:const|let|var|val|auto)\\s+([A-Za-z_$][\\w$]*)' },

    /* 顶格赋值（脚本语言的模块级常量；函数体内的缩进赋值不会命中） */
    { kind: 'variable', re: '^([A-Za-z_$][\\w$]*)\\s*=' }
  ],

  /* 控制结构：即使形状像定义，也不是符号。 */
  stop: ['if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'else',
    'do', 'case', 'new', 'delete', 'throw', 'typeof', 'await', 'yield']
};
})(typeof window !== 'undefined' ? window : globalThis);
