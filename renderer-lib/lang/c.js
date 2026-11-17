(function (root) {
'use strict';
/* ------------------------------------------------------------- C 语言规则表
 *
 * 本块先落「读者语义」：每种词 → 给读者的一句解释。
 * 数据来源 = 原 actions.js 的 CW_TYPE_NOTES / CW_KEYWORDS / CW_QUALIFIERS /
 * CW_INFO_KINDS 四张表，**逐字搬迁、一字不改**（双轨对照：行为必须一字未变）。
 *
 * 语言关键字（struct / sizeof 这些）**不是符号** —— 点了只说明它是什么，
 * 不给"定义 / 引用 / AI"动作（user request 2026-10-16）。注意与 typedef
 * 名字区分：typedef 名（u32 / pid_t / 自己起的类型名）是符号，有定义也有代码。
 *
 * 预处理指令词（include / define / endif …）不是符号，面板只说一句；
 * #include 的文件名走头文件屏，#define 的宏名走正常符号。
 */

root.Lang.register('c', {
  id: 'c',
  name: 'C',
  /* 写进索引的 lang id（**固定枚举**：加新语言值 = 格式变更 = 重建）。 */
  indexId: 1,
  /* 哪些文件属于本语言（文件名优先，其次扩展名）。`.h` 归 C（定稿）；
     `.inc/.def` 刻意不列 —— 无条目即未知语言，走默认规则。 */
  extensions: ['c', 'h'],

  notes: {
    /* 内建 / 基础类型：点了给一句解释（不是符号）。 */
    types: {
      void: '无类型 / 无返回值',
      char: '最小整数类型(1 字节),也用于字符;有无符号由实现决定',
      short: '短整型,至少 16 位',
      int: '基本整型,通常 32 位,有无符号由实现决定',
      long: '长整型,至少 32 位(64 位平台上通常 64 位)',
      float: '单精度浮点(IEEE 754,约 7 位有效数字)',
      double: '双精度浮点(约 15 位有效数字)',
      signed: '显式声明有符号;与 unsigned 配对影响取值范围与提升规则',
      unsigned: '无符号:回绕定义明确,适合位运算;与运算 / 比较时当心隐式转换',
      bool: '布尔类型(C99 需 <stdbool.h>)',
      size_t: 'sizeof 的结果类型,无符号;表示对象大小 / 数组下标',
      ssize_t: '有符号的 size_t;失败可返回 -1',
      ptrdiff_t: '两个指针相减的结果类型,有符号',
      wchar_t: '宽字符类型',
      int8_t: '正好 8 位有符号整数', uint8_t: '正好 8 位无符号整数',
      int16_t: '正好 16 位有符号整数', uint16_t: '正好 16 位无符号整数',
      int32_t: '正好 32 位有符号整数', uint32_t: '正好 32 位无符号整数',
      int64_t: '正好 64 位有符号整数', uint64_t: '正好 64 位无符号整数'
    },

    /* 语言关键字（含预处理指令词本身）：全部不是符号，只给一句释义。 */
    keywords: {
      struct: '结构体:把若干成员打包成一个类型;`struct tag` 只是标签,不是类型名(所以常配 typedef)',
      union: '联合:所有成员共用同一块存储,大小取最大成员;同一时刻只有一个成员有效',
      enum: '枚举:一组具名整数常量;调试时比裸数字可读',
      typedef: '为已有类型起别名:别名与原类型完全等价,是内核里 u32 / pid_t 这类名字的来源',
      sizeof: '求对象 / 类型的大小(字节),结果是 size_t;**不求值**它的操作数(副作用不执行)',
      typeof: 'GNU 扩展:取表达式的类型,常用于宏里写出"同类型的临时变量"(_Generic / typeof 配合)',
      defined: '预处理运算符:判断某个宏是否被定义,只用在 #if / #elif 里',
      /* 预处理指令词本身：include 曾被解析成一个叫 include 的变量、define 被解析
         成成员、endif 落到"外部符号"屏还挂着 AI 按钮（user report 2026-10-16）。 */
      include: '把另一个文件的内容插到这里:尖括号 <…> 走系统头文件路径,引号 "…" 先找当前目录',
      define: '定义宏(可带参数):编译前做文本替换,没有类型检查;内核里大量使用',
      undef: '取消一个宏定义',
      ifdef: '条件编译:该宏已定义时编译这一段',
      ifndef: '条件编译:该宏未定义时编译这一段(头文件的双保险常用它)',
      endif: '结束一个 #if / #ifdef / #ifndef 块',
      elif: '条件编译的另一个分支', pragma: '编译器指令(如 once / pack / GCC diagnostic)',
      error: '编译到这一行就报错(常放在不该被编译到的分支里)',
      warning: '编译到这一行给个警告', line: '改变编译器眼中的行号 / 文件名',
      if: '条件分支', else: 'else 分支', while: 'while 循环', for: 'for 循环',
      do: 'do-while 循环(至少执行一次)', switch: '多路分支', case: 'switch 的一个分支',
      default: 'switch 的兜底分支;在 struct 里则表示默认值',
      return: '从函数返回(可带值)', break: '跳出最内层循环 / switch',
      continue: '跳过本轮循环,进入下一轮', goto: '无条件跳转到同函数内的标签'
    },

    /* 存储类 / 限定符：说清它对声明做了什么。 */
    qualifiers: {
      static: '静态存储类:限制链接性(仅本文件可见),并把生命周期延长到整个程序;修饰函数表示内部函数',
      extern: '外部链接声明:定义在别处,此处不分配存储',
      const: '只读限定:编译器禁止通过这个名字修改对象',
      volatile: '易变限定:每次访问都必须真实读写,禁止优化掉;用于寄存器 / 共享内存 / 被中断修改的变量',
      register: '建议放入寄存器:现代编译器基本忽略;不能对它取地址',
      inline: '内联建议:提示编译器就地展开;在 C99 下同时影响链接语义',
      restrict: '限定该指针是访问所指对象的唯一途径,便于编译器消除别名检查(C99)',
      auto: '自动存储类:局部变量的默认值,几乎不显式书写',
      _Noreturn: '函数不会返回(如 abort / exit),帮助编译器与静态分析(C11)',
      thread_local: '线程局部存储:每个线程各自一份副本',
      _Thread_local: '线程局部存储(C11)',
      __attribute__: 'GCC / Clang 扩展:为声明附加编译期属性(如 packed / aligned / unused)',
      _Atomic: '原子类型:访问是原子的(C11)',
      _Static_assert: '编译期断言:条件不成立则编译失败(C11)'
    },

    /* "不是符号"的那些种类各自的标签与说明（统一方法：面板只说它是什么，
       不查索引、不给动作）。key 来自分析器的 kind。 */
    kinds: {
      operator: {
        label: '运算符 / 标点',
        note: '运算符或标点符号:它连接的是两边的表达式,本身不是符号,没有定义也没有引用'
      },
      number: {
        label: '数字字面量',
        note: '数字字面量(常量):值就是它自己;要注意后缀与进制(0x 十六进制、U 无符号、L 长整型)'
      },
      block: { label: '代码块', note: '选中的是一整块代码,不是一个符号 —— 要用 AI 分析这段代码,用「AI」按钮' },
      line: { label: '整行代码', note: '选中的是一整行代码,不是一个符号' },
      code: { label: '代码片段', note: '选中的是代码片段,不是一个符号' },
      none: { label: '空白处', note: '光标 / 右键处没有词 —— 把一个标识符放到光标下再看' },
      /* 编译器内建 / C 标准库（2026-11-16）：没有源码定义，但也不是"外部符号"。 */
      builtin: {
        label: '编译器内建 / 标准库',
        note: '由编译器或 C 标准库提供,源码树里没有定义'
      }
    }
  },

  /* 词法块：注释 / 字符串定界符、数字模式、关键字表。
     数据来源 = 原 context-analyzer.js 与 app.js 里的字面量，**逐字搬迁、
     一字不改**（双轨对照：lex-snapshot.js 的 old/new/cmp + regions 对拍）。 */
  lexical: {
    /* 定界符（buildRegions 用；escape 是字符串里的转义符） */
    comment: { line: '//', blockStart: '/*', blockEnd: '*/', nested: false },
    quotes: ['"', "'"],
    escape: '\\',
    /* 指令行引导符（声明扫描跳过 # 行；# 在别的语言里可能是注释） */
    directiveSigil: '#',
    /* 导入指令词（"来自 #include" 文案与 include 行识别共用） */
    includeWord: 'include',
    /* 内容其实是汇编的 `.h`（arch/m68k/fpsp040/*.h、arch/mips/include/asm/
       asmmacro.h）：按 C 解析只会吐出 `$31` / `xorl` / `If` / `need` 这类垃圾
       名字，外加成百上千条垃圾引用（2026-11-16）。命中行数达到 `asmSniffMin`
       就不按 C 解析。判据只认行首的汇编伪指令，宽松到不会误伤正常 C 头。 */
    asmSniff: '(^|[\\r\\n])[ \\t]*\\.(?:macro|endm|set|equ|globl)\\b',
    asmSniffMin: 3,

    /* 数字字面量模式（正则源串，消费方自己 new RegExp）：
       number      —— 分析器：整词判定（锚定 ^...$）
       numberToken —— 代码着色器：行内取一个数字 token（不锚尾，含指数与后缀） */
    number: '^(0[xX][0-9a-fA-F]+|\\d+(\\.\\d+)?)[uUlLfF]*$',
    numberToken: '^(?:0[xX][0-9a-fA-F]+|\\d+(?:\\.\\d*)?(?:[eE][+-]?\\d+)?)[uUlLfF]*',

    /* 语言关键字（词法层识别）；控制流词另列（声明扫描用它排除"语句不是声明"） */
    keywords: [
      'if', 'else', 'while', 'for', 'do', 'switch', 'case', 'default', 'return',
      'break', 'continue', 'goto', 'sizeof', 'typeof', 'defined', 'static', 'const',
      'volatile', 'extern', 'register', 'inline', 'void', 'char', 'short', 'int',
      'long', 'float', 'double', 'signed', 'unsigned', 'struct', 'union', 'enum',
      'typedef', 'auto', 'restrict', '_Bool', '_Atomic'
    ],
    keywordsExtra: [
      'bool', 'true', 'false', 'nullptr', 'thread_local', 'asm',
      '_Static_assert', '_Alignas', '_Alignof', '_Noreturn', '_Generic',
      '_Thread_local', '__attribute__', '__inline__', '__restrict', '__asm__'
    ],
    /* 关键字释义（分析器/上下文面板显示"这是什么"） */
    keywordReason: 'C 语言关键字',
    controlWords: ['if', 'for', 'while', 'switch', 'return', 'sizeof', 'typeof', 'do', 'else', 'case', 'goto', 'break', 'continue'],

    /* # 指令词（analyze 判定"其它预处理指令"用；#include 由导入路径单独接住） */
    directiveWords: ['define', 'undef', 'if', 'ifdef', 'ifndef', 'elif', 'elifdef', 'elifndef', 'else', 'endif', 'pragma', 'error', 'warning', 'line'],

    /* 代码着色器的词表（highlightC 用；与上面两份有交叠，保持各自原样） */
    colorKeywords: [
      'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'return',
      'break', 'continue', 'goto', 'sizeof', 'typeof', 'defined', 'asm', '__asm__',
      'static', 'extern', 'inline', '__inline', '__inline__', 'register', 'auto',
      'const', 'volatile', 'restrict', '__restrict', 'struct', 'union', 'enum',
      'typedef', 'signed', 'unsigned', 'void', 'char', 'short', 'int', 'long',
      'float', 'double', 'bool', '_Bool'
    ],
    colorTypes: [
      'size_t', 'ssize_t', 'ptrdiff_t', 'wchar_t', 'off_t', 'pid_t', 'uid_t', 'gid_t',
      'u8', 'u16', 'u32', 'u64', 's8', 's16', 's32', 's64',
      '__u8', '__u16', '__u32', '__u64', '__s8', '__s16', '__s32', '__s64',
      'uch', 'ulg', 'ulong', 'uint', 'ushort', 'u_char', 'u_int', 'u_long',
      'true', 'false', 'NULL'
    ]
  },

  /* 导入解析块（G.4 第五块能力）：哪些节点算导入 + 行模式 + 名字→文件解析规则。 */
  imports: {
    nodeTypes: ['preproc_include'],
    line: '^[ \\t]*#[ \\t]*include[ \\t]*[<"]([^>"]+)[>"]',
    resolve: 'path',
    label: '#include',
    /* 导入目标是一个**文件名**（`<x.h>` 里的 x.h） */
    target: 'header',
    targetLabel: '头文件'
  },

  /* 判定优先级链：核心 whatIsAt 只按表执行（实现待落地；顺序 = C 现状）。 */
  judgeOrder: ['lexical', 'selection', 'directiveWord', 'includeName', 'keyword', 'symbol', 'config', 'external'],

  /* 条件提取：语言级条件从哪些节点来（CONFIG 条件屏是文本级公共能力）。 */
  conditions: {
    sources: ['preproc_if', 'preproc_ifdef', 'preproc_ifndef', 'preproc_else', 'preproc_elif'],
    configPattern: 'CONFIG_[A-Z0-9_]+'
  },

  /* 符号识别块：kind 词汇与它们的 UI 呈现（徽标 / 文案 / 着色）+ C 的识别启发式。
     数据来源 = 原 context-analyzer.js / app.js 里的字面量，**逐字搬迁、一字不改**
     （双轨对照：sym-snapshot.js cmp + ca-behavior.js 行为对拍）。 */
  symbols: {
    /* 索引 kind → UI kind（类型族在 UI 里统一成 'type'） */
    kindMap: {
      function: 'function',
      macro: 'macro',
      struct: 'type',
      union: 'type',
      enum: 'type',
      class: 'type',
      typedef: 'type',
      variable: 'variable'
    },
    /* UI kind → 标签（分析器用） */
    kindLabel: {
      function: '函数',
      type: '类型',
      macro: '宏',
      variable: '变量'
    },
    /* 索引 kind → 标签（Context 窗口用） */
    indexKindLabel: {
      function: '函数', struct: '结构体', union: '联合', enum: '枚举',
      typedef: '类型别名', macro: '宏', variable: '变量', class: '类',
      member: '成员', enum_member: '枚举值', parameter: '参数',
      /* 标签不是索引里的 kind（tree-sitter 不抽它），但 `goto out` 的目标必须
         有个正确的名字，否则会被当成变量去别的文件里找同名 (2026-10-20)。 */
      label: '标签'
    },
    /* 标签语句与跳转关键字 —— 规则表声明语法，核心只执行：
       `labelDef` 抓 `out:` 这样的行首标签（`(?!:)` 排除 C++ 的 `A::b`），
       `jumpWords` 决定"这个词是跳转目标"。两者一起把 `goto out;` 的 out 认成
       标签，而不是拿它去做符号查找。 */
    labelDef: '^[ \\t]*([A-Za-z_]\\w*)[ \\t]*:(?!:)',
    jumpWords: ['goto'],
    /* kind → 徽标（字符 / css 类 / tooltip 文案） */
    badges: {
      macro: { ch: '#', css: 'k-macro', label: '宏' },
      function: { ch: 'ƒ', css: 'k-func', label: '函数' },
      struct: { ch: 'S', css: 'k-type', label: '结构体' },
      union: { ch: 'U', css: 'k-type', label: '联合' },
      enum: { ch: 'E', css: 'k-type', label: '枚举' },
      typedef: { ch: 'T', css: 'k-type', label: '类型别名' },
      class: { ch: 'C', css: 'k-type', label: '类' },
      enum_member: { ch: 'e', css: 'k-type', label: '枚举值' },
      variable: { ch: 'v', css: 'k-var', label: '变量' },
      /* #ifdef / #ifndef / #if / #elif / #else / #endif 之类的编译开关 */
      preproc: { ch: '⌥', css: 'k-other', label: '编译开关' },
      /* 分析器把结构体/联合/枚举/typedef 统称 `type`（结果窗的类型标识要用它） */
      type: { ch: 'T', css: 'k-type', label: '类型' },
      /* 结果窗用：一行"落在什么上"的标识 */
      call: { ch: 'ƒ', css: 'k-func', label: '调用' },
      member: { ch: 'm', css: 'k-var', label: '成员' },
      comment: { ch: 'c', css: 'k-other', label: '注释' },
      declaration: { ch: 'd', css: 'k-other', label: '声明' },
      /* 索引里的参数/局部定义也得有个标识，否则行首是一个没有含义的点 */
      parameter: { ch: 'p', css: 'k-var', label: '参数' },
      local: { ch: 'l', css: 'k-var', label: '局部变量' },
      /* goto 标签：只在当前函数内跳转，和变量/函数不是一回事 */
      label: { ch: '@', css: 'k-other', label: 'goto 标签' }
    },
    /* kind → 语义着色。颜色一律走 CSS 变量(--syn-*),五套主题各自解析 —— 这样
       语义着色与词法高亮永远是同一套色,切主题也不用重算 (user request 2026-10-19:
       函数定义深蓝紫加粗、调用稍深的蓝、宏柔和红)。函数名出现处都是"调用"这一层,
       定义那一层的强调由适配器的 syn-fn-def 装饰叠加(CSS 优先级更高)。 */
    style: {
      macro: { color: 'var(--syn-macro)', fontWeight: 600 },
      function: { color: 'var(--syn-fn)', fontWeight: 600 },
      struct: { color: 'var(--syn-type)', fontWeight: 600 },
      union: { color: 'var(--syn-type)', fontWeight: 600 },
      enum: { color: 'var(--syn-type)', fontWeight: 600 },
      class: { color: 'var(--syn-type)', fontWeight: 600 },
      typedef: { color: 'var(--syn-type)' }
    },
    /* 全局符号窗收录的 kind（文件级变量另由 parent 判定） */
    globalKinds: ['struct', 'union', 'enum', 'typedef', 'macro', 'function'],
    /* 类型族：问"这是什么类型"时这几个 kind 可互换 */
    typeFamily: ['struct', 'union', 'enum', 'typedef', 'class'],
    /* 声明类型判断的**宽**集合（`u32 x;` 不必再去展开成结构体） */
    basicTypes: [
      'void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned', 'bool',
      '_Bool', 'size_t', 'ssize_t', 'ptrdiff_t', 'wchar_t', 'int8_t', 'int16_t', 'int32_t',
      'int64_t', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t', 'u8', 'u16', 'u32', 'u64',
      's8', 's16', 's32', 's64', '__u8', '__u16', '__u32', '__u64', '__s8', '__s16', '__s32', '__s64'
    ],
    /* "语言内建"的**窄**集合（typedef 别名不在其中，这样 u32/size_t 会去索引找定义） */
    builtinWords: [
      'void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned',
      'bool', '_Bool'
    ],
    /* 编译器内建 / C 标准库（2026-11-16）：它们**没有源码定义**，不能按符号解析，
       但也不该被说成"外部符号 / 未定义"。查询期在索引里查不到时给一句说明
       （`notes.kinds.builtin`）。`__func__` 一个在内核里就有数万处引用，以前
       全被统计成"零定义"。**只在索引查不到时才用**，不遮住真实定义。 */
    builtinIdentifiers: {
      __func__: '当前函数的函数名；编译器在每个函数里生成，不是符号',
      __FUNCTION__: '当前函数名（GNU 扩展）；不是符号',
      __PRETTY_FUNCTION__: '当前函数的完整签名（GNU 扩展）；不是符号',
      __LINE__: '当前行号（整数常量）；编译期替换，不是符号',
      __FILE__: '当前源文件名（字符串常量）；编译期替换，不是符号',
      __DATE__: '编译日期字符串；编译期替换，不是符号',
      __TIME__: '编译时间字符串；编译期替换，不是符号',
      __COUNTER__: '每次展开自增的整数（GCC / Clang 扩展）；不是符号',
      __STDC__: '是否标准 C 的编译期常量；不是符号',
      __STDC_VERSION__: 'C 标准版本号的编译期常量；不是符号'
    },
    /* 项目外定义的已知类型名（命名习惯之外的兜底） */
    builtinTypes: [
      'size_t', 'ssize_t', 'off_t', 'pid_t', 'uid_t', 'gid_t', 'time_t', 'clock_t',
      'va_list', 'FILE', 'wchar_t', 'intptr_t', 'uintptr_t', 'intmax_t', 'uintmax_t',
      'int8_t', 'uint8_t', 'int16_t', 'uint16_t', 'int32_t', 'uint32_t',
      'int64_t', 'uint64_t', 'u8', 'u16', 'u32', 'u64', 's8', 's16', 's32', 's64'
    ],
    /* `struct foo` 这样的写法里，关键字后面跟的是类型名 */
    typeKeywords: ['struct', 'union', 'enum', 'class'],
    typeKeywordReason: 'struct / union / enum 后面的类型名',
    /* 命名习惯 */
    typeNameSuffix: '_t',
    macroNameRe: '^[A-Z][A-Z0-9_]*$',
    /* 声明扫描的句式（无解析器时恢复参数 / 局部变量的启发式） */
    declScan: {
      funcDef: '^[A-Za-z_][\\w\\s\\*]*?[\\s\\*]([A-Za-z_]\\w*)\\s*\\(([^;{]*)\\)\\s*\\{?$',
      declHead: '^(?:[A-Za-z_]\\w*[\\s\\*]+)+(?:\\*+\\s*)?',
      declTail: '[;=\\[,]',
      firstWord: '^[A-Za-z_]\\w*',
      forDecl: '^\\s*for\\s*\\(\\s*([A-Za-z_][\\w\\s\\*]*?)\\s+([A-Za-z_]\\w*)\\s*[=;]'
    },

    /* 索引器产出的 kind 常量（索引与 UI 共享的种类词汇） */
    kinds: {
      function: 'function',
      struct: 'struct',
      union: 'union',
      enum: 'enum',
      typedef: 'typedef',
      macro: 'macro',
      variable: 'variable',
      member: 'member',
      enumMember: 'enum_member',
      parameter: 'parameter'
    },

    /* 索引二进制格式里的 kind 编号顺序（改顺序 = 格式变更 = 重建索引） */
    indexKinds: ['struct', 'union', 'enum', 'typedef', 'macro', 'variable',
      'member', 'enum_member', 'parameter', 'function', 'class', 'interface', 'module'],

    /* kind → Context 窗口的动作组（union / enum 与 struct 共用 type 组） */
    actionGroup: {
      function: 'function', struct: 'type', union: 'type', enum: 'type',
      macro: 'macro', variable: 'variable', member: 'variable', param: 'variable'
    },

    /* 无解析器时的正则符号引擎（fs-service 的兜底路径）：词表 + 句式。
       注意模式串里的 `\\t` 必须写成双反斜杠（单反斜杠会被 JS 解释成真的 TAB） */
    regexEngine: {
      keywords: ['if', 'for', 'while', 'switch', 'return', 'sizeof', 'catch', 'do', 'else',
        'case', 'default', 'typeof', 'defined', 'assert', 'static_assert'],
      macro: '^[ \\t]*#[ \\t]*define[ \\t]+([A-Za-z_]\\w*)',
      struct: '^[ \\t]*(?:[A-Za-z_]\\w*[ \\t]+)*(struct|union|enum|class)[ \\t]+([A-Za-z_]\\w*)[ \\t]*\\{?[ \\t]*$',
      typedef: '^[ \\t]*typedef[^;{]*[ \\t\\*]([A-Za-z_]\\w*)[ \\t]*;',
      func: '^[ \\t]*([A-Za-z_][\\w \\t\\*]*?)[ \\t\\*]([A-Za-z_]\\w*)[ \\t]*\\(([^;{)]*)\\)[ \\t]*\\{?[ \\t]*$',
      global: '^[A-Za-z_][\\w \\t\\*,]*[ \\t\\*]([A-Za-z_]\\w*)[ \\t]*(?:\\[[^\\]]*\\])?[ \\t]*(?:=[^;]*)?;[ \\t]*$',
      forward: '^\\s*(struct|union|enum)\\s+[A-Za-z_]\\w*\\s*;'
    },

    /* 不能当被调用者的词（表达式解析跳过它们） */
    calleeSkip: ['if', 'for', 'while', 'switch', 'return', 'sizeof', 'typeof', 'defined', 'do',
      'else', 'case', 'default', 'goto', 'break', 'continue', 'alignof',
      'static_assert', '_Static_assert', '_Alignof', '_Generic'],

    /* 类型说明符（`(struct sock *)p` 这类形态判定用） */
    typeSpecifiers: ['struct', 'union', 'enum'],

    /* 声明前缀词（剥掉它们才能看到裸类型名） */
    declPrefix: ['const', 'volatile', 'restrict', 'static', 'extern', 'register',
      'struct', 'union', 'enum'],

    /* 表达式里遇到这些词就切分操作数（`return ip_hdr(skb)->saddr`） */
    exprKeywordStops: ['return', 'sizeof', 'case', 'goto', 'else'],

    /* kind → 引用目标 kind（结果窗按类型筛引用） */
    targetKinds: {
      function: ['function'], macro: ['macro'],
      variable: ['variable'], parameter: ['parameter'],
      member: ['member', 'field'], enum_member: ['enum_member', 'field'],
      struct: ['struct'], union: ['union'], enum: ['enum'],
      typedef: ['typedef'], class: ['class']
    }
  },

  /* 语法块：tree-sitter 语法树的标点（节点名 / 字段名 / token）、判定上下文与
     引用角色。索引器是"通用 AST 遍历器"：名字全从表里取，不认识任何具体语言。 */
  syntax: {
    /* 引用里没有意义的标识符（不产引用）。编译器内建由编译器在编译期给出，
       不是符号 —— `__func__` 在内核里数万处，记成引用只会制造"零定义"噪声
       （2026-11-16）。查询侧另有 `symbols.builtinIdentifiers` 给说明屏。 */
    refIgnore: ['__func__', '__FUNCTION__', '__PRETTY_FUNCTION__', '__LINE__', '__FILE__',
      '__DATE__', '__TIME__', '__COUNTER__', '__STDC__', '__STDC_VERSION__'],

    /* E1 推导器的**词表**：工具从 `#define` 原文反推规则时，用它判断
       "宏体里哪一段是类型 / 哪些是存储类"。算法在 main/macro-derive.js，
       这里只放语言数据（核心零语言字面量）。 */
    macroDerive: {
      storage: ['static', 'extern', 'inline', 'const', 'volatile', 'register'],
      scalars: ['int', 'char', 'short', 'long', 'float', 'double', 'unsigned', 'signed',
        'bool', '_Bool', 'void', 'size_t', 'ssize_t',
        'u8', 'u16', 'u32', 'u64', 's8', 's16', 's32', 's64'],
      typeSpecs: ['struct', 'union', 'enum'],
      typeSuffix: '_t'
    },

    /* 节点名与字段名共用一个命名空间（`declarator` 两种角色都用同一个词） */
    nt: {
      argument: 'argument', arguments: 'arguments', argumentList: 'argument_list',
      arrayDeclarator: 'array_declarator', assignmentExpression: 'assignment_expression',
      binaryExpression: 'binary_expression', body: 'body',
      callExpression: 'call_expression', compoundStatement: 'compound_statement',
      condition: 'condition', declaration: 'declaration', declarator: 'declarator',
      enumSpecifier: 'enum_specifier', enumerator: 'enumerator',
      /* 解析失败的片段：`#ifdef` 包住的整条声明有时整段落进这里，
         既没有 declaration 也没有 call 节点（见 ts-indexer 的 ERROR 扫描）。 */
      errorNode: 'ERROR',
      enumeratorList: 'enumerator_list', expressionStatement: 'expression_statement',
      fieldDeclaration: 'field_declaration', fieldDeclarationList: 'field_declaration_list',
      fieldIdentifier: 'field_identifier', function: 'function',
      /* 指定初始化器 `.field = value`：用来记「函数被登记到哪个回调字段」。
         只认这两个字段名，节点类型跟着语言表走（2026-10-21）。 */
      designator: 'designator', value: 'value', initializerPair: 'initializer_pair',
      initializerList: 'initializer_list',
      /* `&fn`：新版 tree-sitter-c 用 pointer_expression（老版是 unary_expression） */
      pointerExpression: 'pointer_expression',
      functionDeclarator: 'function_declarator', functionDefinition: 'function_definition',
      identifier: 'identifier', initDeclarator: 'init_declarator', left: 'left',
      /* `static FOO(a, b);`：多参数声明宏在树里是**一个类型说明符**
         （`FOO(a, b)` 整段），不是 type_identifier —— 单参数才是后者。 */
      macroTypeSpecifier: 'macro_type_specifier',
      /* 结构体/联合体里的字段声明（`struct s { FOO(a,b) m; }` 的宏站点就在这） */
      fieldDecl: 'field_declaration',
      name: 'name', parameterDeclaration: 'parameter_declaration',
      parameters: 'parameters', parenthesizedDeclarator: 'parenthesized_declarator',
      path: 'path', pointerDeclarator: 'pointer_declarator', preprocDef: 'preproc_def',
      preprocElif: 'preproc_elif', preprocElse: 'preproc_else',
      preprocFunctionDef: 'preproc_function_def', preprocIf: 'preproc_if',
      preprocIfdef: 'preproc_ifdef', preprocIfndef: 'preproc_ifndef',
      preprocInclude: 'preproc_include', preprocParams: 'preproc_params',
      primitiveType: 'primitive_type', returnStatement: 'return_statement',
      sizedTypeSpecifier: 'sized_type_specifier',
      storageClassSpecifier: 'storage_class_specifier', stringLiteral: 'string_literal',
      structSpecifier: 'struct_specifier', systemLibString: 'system_lib_string',
      type: 'type', typeDefinition: 'type_definition', typeIdentifier: 'type_identifier',
      unaryExpression: 'unary_expression', unionSpecifier: 'union_specifier',
      value: 'value', variadicParameter: 'variadic_parameter',
      /* 单字符 / 字面 token */
      eq: '=', amp: '&', star: '*', ellipsis: '...',
      /* 预处理指令词与关键字 */
      elseDirective: '#else', ifndefDirective: '#ifndef', elifDirective: '#elif',
      externKeyword: 'extern'
    },
    /* "这是声明" / "这是使用" 的节点上下文（各语言的名单不同） */
    declContext: [
      'declarator', 'function_declarator', 'pointer_declarator', 'array_declarator',
      'parenthesized_declarator', 'parameter_declaration', 'field_declaration',
      'preproc_def', 'preproc_function_def', 'preproc_params', 'enumerator',
      'struct_specifier', 'union_specifier', 'enum_specifier', 'type_definition',
      'declaration'
    ],
    useContext: [
      'call_expression', 'compound_statement', 'expression_statement',
      'return_statement', 'binary_expression', 'argument_list', 'assignment_expression'
    ],
    /* "像 declarator 的节点"后缀模式 */
    patterns: { declaratorish: 'declarator$|identifier$' },
    /* 语法文件（grammar 接入多语言时按语言切换） */
    grammar: 'tree-sitter-c.wasm',
    /* 引用角色（使用位置块）：一次使用"做什么" */
    roles: { read: 'read', write: 'write', call: 'call', address: 'address', type: 'type', field: 'field' },
    /* 成员访问运算符（`x->f` / `x.f` 的形态判定与拆解） */
    memberOps: ['->', '.']
  }
});

})(typeof window !== 'undefined' ? window : globalThis);
