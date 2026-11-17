/* Rust 规则表：契约试金石的第一门「新语言」。
 *
 * 填写依据只有三样：官方语言规范、tree-sitter node-types.json、lang/schema.md
 * 的规则表契约；没有读索引器实现（除引擎公开的键语义）。
 * 节点的真实形状以 tree-sitter-rust 0.21 为准（tree-sitter-wasms 自带的
 * tree-sitter-rust.wasm 与它同代）。
 */
(function (root) {
  const L = root.Lang;
  if (!L) throw new Error('lang/registry.js must load before lang/rust.js');

  L.register('rust', {
    id: 'rust',
    name: 'Rust',
    indexId: 8,
    extensions: ['rs'],

    notes: {
      types: {
        usize: '指针宽度的无符号整数（下标 / 长度的默认类型）',
        isize: '指针宽度的有符号整数',
        str: '字符串切片（长度 + 字节），通常以 &str 出现',
        String: '可增长的 UTF-8 字符串（堆上）',
        Option: '可空值：Some(T) / None',
        Result: '可能失败的值：Ok(T) / Err(E)'
      },
      keywords: {
        fn: '函数定义：`fn name(参数) -> 返回类型 { 体 }`',
        let: '绑定一个名字；`let mut` 允许后续修改',
        mut: '可变绑定：没有它名字是不可变的',
        impl: '为类型实现方法或 trait',
        trait: '一组方法签名（接口）',
        struct: '结构体：命名字段的聚合',
        enum: '枚举：多个变体之一',
        use: '把路径引入当前作用域',
        mod: '模块声明 / 内联模块',
        match: '模式匹配（穷尽检查）',
        '&': '借用（引用）；`&mut` 是可变借用'
      }
    },

    /* 词法块：注释 / 字符串 / 关键字的语言知识（着色与词法判定用） */
    lexical: {
      comment: { line: '//', blockStart: '/*', blockEnd: '*/', nested: true },
      /* 只认双引号：单引号在 Rust 里既可能是字符字面量 `'x'`，也可能是生命
         周期 `'a`；当成字符串定界符会把 `fn f<'a>(x: &'a str)` 后半行染成
         字符串。宁可字符字面量不着色，也不能让生命周期吃掉整行。 */
      quotes: ['"'],
      escape: '\\',
      directiveSigil: '',
      includeWord: 'use',
      number: '^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?)(?:[iu](?:8|16|32|64|128|size)|f(?:32|64))?$',
      numberToken: '^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?)(?:[iu](?:8|16|32|64|128|size)|f(?:32|64))?',
      keywords: [
        'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else',
        'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop',
        'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self',
        'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use',
        'where', 'while', 'union', 'macro_rules'
      ],
      /* 标量类型不是关键字（`u8` 是语言内建**类型名**，判定为 type），
         见下面 symbols.builtinTypes。 */
      keywordsExtra: [],
      keywordReason: 'Rust 关键字',
      controlWords: ['if', 'else', 'for', 'while', 'loop', 'match', 'return',
        'break', 'continue'],
      directiveWords: [],
      colorKeywords: [
        'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn',
        'else', 'enum', 'extern', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop',
        'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self',
        'static', 'struct', 'super', 'trait', 'type', 'unsafe', 'use', 'where',
        'while', 'union'
      ],
      colorTypes: [
        'u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'i8', 'i16', 'i32', 'i64',
        'i128', 'isize', 'f32', 'f64', 'bool', 'char', 'str', 'String', 'Vec',
        'Option', 'Result', 'Box', 'Rc', 'Arc'
      ]
    },

    /* 导入块：`use a::b::{c, d};` 是导入语句（第五块能力的 Rust 形状） */
    imports: {
      nodeTypes: ['use_declaration'],
      line: '^[ \\t]*use\\s+([^;]+);',
      resolve: 'module',
      label: 'use',
      /* `use a::b::C;` 的目标是一条**路径**，路径里的每个名字都是符号：
         点击 C 应按符号解析，而不是把整行当成"头文件名"。 */
      target: 'path',
      wholeLine: false
    },

    /* Rust 没有预处理条件；CONFIG 屏是文本级公共能力，保留同形模式即可 */
    conditions: {
      sources: [],
      configPattern: 'CONFIG_[A-Z0-9_]+'
    },

    judgeOrder: ['lexical', 'selection', 'keyword', 'symbol', 'external'],

    symbols: {
      /* kind 词汇与 C 共用同一套索引常量（格式相关，不能各写各的） */
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
      indexKinds: ['struct', 'union', 'enum', 'typedef', 'macro', 'variable',
        'member', 'enum_member', 'parameter', 'function'],
      kindMap: {
        function: 'function', macro: 'macro', struct: 'type', union: 'type',
        enum: 'type', class: 'type', typedef: 'type', variable: 'variable'
      },
      kindLabel: { function: '函数', type: '类型', macro: '宏', variable: '变量' },
      indexKindLabel: {
        function: '函数', struct: '结构体', union: '联合', enum: '枚举',
        typedef: '类型别名', macro: '宏', variable: '变量', class: '类',
        member: '成员', enum_member: '枚举值', parameter: '参数'
      },
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
        type: { ch: 'T', css: 'k-type', label: '类型' },
        call: { ch: 'ƒ', css: 'k-func', label: '调用' },
        member: { ch: 'm', css: 'k-var', label: '成员' },
        parameter: { ch: 'p', css: 'k-var', label: '参数' },
        local: { ch: 'l', css: 'k-var', label: '局部变量' }
      },
      style: {
        macro: { color: '#a00000', fontWeight: 600 },
        function: { color: '#795e26' },
        struct: { color: '#008080', fontWeight: 600 },
        union: { color: '#008080', fontWeight: 600 },
        enum: { color: '#008080', fontWeight: 600 },
        typedef: { color: '#008080' }
      },
      globalKinds: ['struct', 'union', 'enum', 'typedef', 'macro', 'function'],
      typeFamily: ['struct', 'union', 'enum', 'typedef', 'class'],
      actionGroup: {
        function: 'function', struct: 'type', union: 'type', enum: 'type',
        macro: 'macro', variable: 'variable', member: 'variable', param: 'variable'
      },
      /* Rust 的内建标量（不是用户定义类型，不必去索引里找定义） */
      basicTypes: ['i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'u8', 'u16', 'u32',
        'u64', 'u128', 'usize', 'f32', 'f64', 'bool', 'char', 'str'],
      builtinWords: ['i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'u8', 'u16', 'u32',
        'u64', 'u128', 'usize', 'f32', 'f64', 'bool', 'char', 'str', 'Self'],
      /* 语言内建类型（标量 + 常用 std 类型）：点击时判为 type，不去索引找定义 */
      builtinTypes: ['i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'u8', 'u16', 'u32',
        'u64', 'u128', 'usize', 'f32', 'f64', 'bool', 'char', 'str',
        'String', 'Vec', 'Option', 'Result', 'Box', 'Rc', 'Arc',
        'HashMap', 'HashSet', 'VecDeque', 'BTreeMap', 'BTreeSet', 'Cow', 'Path'],
      typeKeywords: ['struct', 'enum', 'union', 'trait', 'type', 'impl'],
      /* Rust 类型名没有 C 的 `_t` 后缀，别把 it 当类型。 */
      typeNameSuffix: null,
      /* Rust 里全大写是常量，宏是 `name!`（不是标识符本身）—— 不能沿用
         C 的「全大写即宏」；宏符号由 macro_definition 节点产出。 */
      macroNameRe: '(?!)',
      /* 无解析器时的兜底句式（rust 基本用不到，但表要自洽） */
      declScan: {
        funcDef: '^\\s*(?:pub\\s+)?fn\\s+([A-Za-z_]\\w*)\\s*\\(([^)]*)\\)',
        declHead: '^\\s*let\\s+(?:mut\\s+)?([A-Za-z_]\\w*)',
        declTail: '[;=]',
        firstWord: '^[A-Za-z_]\\w*',
        forDecl: '^\\s*for\\s+([A-Za-z_]\\w*)\\s+in\\b',
        /* `n: usize` —— 名字在类型前面（C 是 `int n`，名字在最后） */
        paramName: 'first'
      },
      targetKinds: {
        function: ['function'], macro: ['macro'],
        variable: ['variable'], parameter: ['parameter'],
        member: ['member', 'field'], enum_member: ['enum_member', 'field'],
        struct: ['struct'], union: ['union'], enum: ['enum'],
        typedef: ['typedef'], class: ['class']
      }
    },

    calleeSkip: ['if', 'for', 'while', 'match', 'return', 'loop', 'else', 'use'],
    typeSpecifiers: ['struct', 'enum', 'union', 'trait'],
    declPrefix: ['pub', 'const', 'static', 'mut', 'unsafe', 'extern'],
    exprKeywordStops: ['return', 'match', 'break', 'else'],

    /* 语法块：tree-sitter-rust 的节点名 / 字段名 */
    syntax: {
      nt: {
        /* 名字与字段（同一命名空间） */
        name: 'name', pattern: 'pattern', body: 'body', type: 'type',
        returnType: 'return_type', value: 'value',
        identifier: 'identifier', typeIdentifier: 'type_identifier',
        fieldIdentifier: 'field_identifier',
        parameters: 'parameters', parameterDeclaration: 'parameter',
        fieldDeclarationList: 'field_declaration_list',
        enumeratorList: 'enum_variant_list',
        primitiveType: 'primitive_type',

        /* 声明节点（`let` 之外还有 for / if-let 的绑定位置） */
        declaration: ['let_declaration', 'for_expression', 'let_condition'],
        functionDefinition: ['function_item', 'function_signature_item'],
        structSpecifier: 'struct_item',
        unionSpecifier: 'union_item',
        enumSpecifier: 'enum_item',
        fieldDeclaration: 'field_declaration',
        enumerator: 'enum_variant',
        typeDefinition: 'type_item',

        /* 表达式与引用位置 */
        callExpression: 'call_expression',
        function: 'function',
        arguments: 'arguments',
        argumentList: 'arguments',
        argument: 'value',
        memberRecv: 'value',
        assignmentExpression: ['assignment_expression', 'compound_assignment_expr'],
        binaryExpression: 'binary_expression',
        unaryExpression: 'reference_expression',
        expressionStatement: 'expression_statement',
        returnStatement: 'return_expression',
        compoundStatement: 'block',
        left: 'left', right: 'right',

        /* token */
        eq: '=', amp: '&', star: '*',
        externKeyword: 'extern'
      },

      /* 「声明」判定：名字是节点的 name 字段 / pattern 字段里的 identifier */
      declNodes: [
        'function_item', 'function_signature_item', 'struct_item', 'union_item',
        'enum_item', 'trait_item', 'type_item', 'const_item', 'static_item',
        'macro_definition', 'field_declaration', 'enum_variant'
      ],
      declPatterns: ['parameter', 'let_declaration', 'for_expression', 'let_condition', 'match_arm'],
      /* 这些节点自身不出符号，但给体里的成员提供 parent */
      containerNodes: ['impl_item'],
      /* 数据驱动 item：节点 → kind */
      declKinds: {
        struct_item: 'struct',
        union_item: 'union',
        enum_item: 'enum',
        trait_item: 'struct',
        type_item: 'typedef',
        const_item: 'variable',
        static_item: 'variable',
        macro_definition: 'macro'
      },
      /* Rust 的声明没有 C 的声明符作用域；空表即可 */
      declContext: [],
      /* 这些上下文里的名字只能是使用（走到这里就停） */
      useContext: [
        'call_expression', 'block', 'expression_statement', 'return_expression',
        'binary_expression', 'arguments', 'assignment_expression'
      ],
      patterns: { declaratorish: 'identifier$|type_identifier$' },
      /* 返回类型字段的文本前带箭头（`fn f() -> usize`），索引里只要 usize */
      stripTypePrefix: ['->'],
      grammar: 'tree-sitter-rust.wasm',
      /* 调用的 callee 可以是一条路径：`Packet::new(..)` 的名字 `new` 被
         scoped_identifier 包着；带泛型参数时还多一层 generic_function。 */
      calleeWrappers: ['scoped_identifier', 'generic_function'],
      roles: { read: 'read', write: 'write', call: 'call', address: 'address', type: 'type', field: 'field' },
      memberOps: ['.']
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);
