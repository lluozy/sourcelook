/* Go 规则表：契约试金石的第二个「新语言」。
 *
 * 填写依据：Go 语言规范 + tree-sitter-go 的 node-types.json，以及
 * lang/schema.md 的规则表契约；没有读索引器实现（除引擎公开的键语义）。
 * 节点的真实形状已用 tree-sitter-wasms 自带的 tree-sitter-go.wasm 逐条对过
 * （package/import/const/var/type/struct/interface/func/method/泛型,
 * 见 .tmp/cr/contract/go-probe.js）。
 */
(function (root) {
  const L = root.Lang;
  if (!L) throw new Error('lang/registry.js must load before lang/go.js');

  L.register('go', {
    id: 'go',
    name: 'Go',
    indexId: 9,
    extensions: ['go'],

    notes: {
      types: {
        int: '平台相关有符号整数（32/64 位）',
        uint: '平台相关无符号整数',
        uintptr: '可容纳指针的无符号整数',
        byte: 'uint8 的别名',
        rune: 'int32 的别名（Unicode 码点）',
        string: '不可变字节序列（约定 UTF-8）',
        bool: '布尔',
        error: '内建接口：一个 Error() string 方法',
        any: 'interface{} 的别名（Go 1.18+）'
      },
      keywords: {
        func: '定义函数或方法（方法带接收者：func (r T) Name()）',
        type: '定义类型（struct / interface / 别名）',
        struct: '结构体：命名字段的聚合',
        interface: '接口：方法集合（也用于泛型约束）',
        var: '声明变量（可分组：var ( ... )）',
        const: '声明常量（常配 iota）',
        package: '声明本文件所属包',
        import: '导入包（对象是包路径，不是单个文件）',
        go: '启动 goroutine',
        defer: '注册函数返回时执行（LIFO）',
        range: '遍历 slice / map / channel'
      }
    },

    /* 词法块：注释 / 字符串 / 关键字的语言知识（着色与词法判定用） */
    lexical: {
      comment: { line: '//', blockStart: '/*', blockEnd: '*/', nested: false },
      /* 反引号是原始字符串（无转义、可跨行）；单引号是 rune 字面量，
         在 Go 里没有其它含义，可以当定界符。 */
      quotes: [{ ch: '`', escape: false }, '"', "'"],
      escape: '\\',
      directiveSigil: '',
      includeWord: 'import',
      number: '^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\\d[\\d_]*(?:\\.[\\d_]*)?(?:[eE][+-]?\\d+)?)i?$',
      numberToken: '^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\\d[\\d_]*(?:\\.[\\d_]*)?(?:[eE][+-]?\\d+)?i?)',
      keywords: [
        'break', 'case', 'chan', 'const', 'continue', 'default', 'defer',
        'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import',
        'interface', 'map', 'package', 'range', 'return', 'select', 'struct',
        'switch', 'type', 'var'
      ],
      /* 预声明标识符（nil/iota/内建函数）不是关键字，但也不是用户符号：
         点击时按关键字释义，不去索引里找定义。 */
      keywordsExtra: ['nil', 'iota', 'true', 'false', 'append', 'cap', 'clear',
        'close', 'complex', 'copy', 'delete', 'imag', 'len', 'make', 'max',
        'min', 'new', 'panic', 'print', 'println', 'real', 'recover'],
      keywordReason: 'Go 关键字',
      controlWords: ['if', 'else', 'for', 'range', 'switch', 'select', 'case',
        'default', 'return', 'break', 'continue', 'goto', 'fallthrough',
        'go', 'defer'],
      directiveWords: [],
      colorKeywords: [
        'break', 'case', 'chan', 'const', 'continue', 'default', 'defer',
        'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import',
        'interface', 'map', 'package', 'range', 'return', 'select', 'struct',
        'switch', 'type', 'var'
      ],
      colorTypes: ['bool', 'byte', 'complex64', 'complex128', 'error', 'float32',
        'float64', 'int', 'int8', 'int16', 'int32', 'int64', 'rune', 'string',
        'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr', 'any']
    },

    /* 导入块：`import "fmt"` / `import ( s "strings" )` 的对象是**包路径**
       （字符串），不是单个文件；路径里的每个名字在别处按包名使用。 */
    imports: {
      nodeTypes: ['import_spec'],
      line: '^[ \\t]*(?:[A-Za-z_][\\w.]*[ \\t]+)?"([^"]+)"',
      resolve: 'packageDir',
      label: 'import',
      target: 'path',
      wholeLine: false
    },

    /* Go 没有预处理条件；CONFIG 屏是文本级公共能力，保留同形模式即可 */
    conditions: {
      sources: [],
      configPattern: 'CONFIG_[A-Z0-9_]+'
    },

    judgeOrder: ['lexical', 'selection', 'keyword', 'symbol', 'external'],

    symbols: {
      /* kind 词汇与 C/Rust 共用同一套索引常量（格式相关，不能各写各的） */
      kinds: {
        function: 'function',
        struct: 'struct',
        union: 'union',
        enum: 'enum',
        /* Go 的 `type I interface{…}` 不是结构体；包名也是一种符号
           （`pkg.Fn` 里的 `pkg`）。两者以前挤在 struct / 无 里（2026-10-23）。 */
        interface: 'interface',
        module: 'module',
        typedef: 'typedef',
        macro: 'macro',
        variable: 'variable',
        member: 'member',
        enumMember: 'enum_member',
        parameter: 'parameter'
      },
      indexKinds: ['struct', 'union', 'enum', 'typedef', 'macro', 'variable',
        'member', 'enum_member', 'parameter', 'function', 'interface', 'module'],
      kindMap: {
        function: 'function', macro: 'macro', struct: 'type', union: 'type',
        enum: 'type', interface: 'type', class: 'type', typedef: 'type',
        module: 'variable', variable: 'variable'
      },
      kindLabel: { function: '函数', type: '类型', macro: '宏', variable: '变量' },
      indexKindLabel: {
        function: '函数', struct: '结构体', union: '联合', enum: '枚举',
        interface: '接口', module: '包',
        typedef: '类型别名', macro: '宏', variable: '变量', class: '类',
        member: '成员', enum_member: '枚举值', parameter: '参数'
      },
      badges: {
        macro: { ch: '#', css: 'k-macro', label: '宏' },
        function: { ch: 'ƒ', css: 'k-func', label: '函数' },
        struct: { ch: 'S', css: 'k-type', label: '结构体' },
        union: { ch: 'U', css: 'k-type', label: '联合' },
        enum: { ch: 'E', css: 'k-type', label: '枚举' },
        interface: { ch: 'I', css: 'k-type', label: '接口' },
        module: { ch: 'P', css: 'k-type', label: '包' },
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
        interface: { color: '#008080', fontWeight: 600 },
        module: { color: '#795e26' },
        typedef: { color: '#008080' }
      },
      globalKinds: ['struct', 'interface', 'typedef', 'function', 'variable'],
      typeFamily: ['struct', 'union', 'enum', 'interface', 'typedef', 'class'],
      actionGroup: {
        function: 'function', struct: 'type', union: 'type', enum: 'type',
        interface: 'type', module: 'variable',
        macro: 'macro', variable: 'variable', member: 'variable', param: 'variable'
      },
      /* 预声明类型：不是用户定义类型，不必去索引里找定义。 */
      basicTypes: ['bool', 'byte', 'complex64', 'complex128', 'error', 'float32',
        'float64', 'int', 'int8', 'int16', 'int32', 'int64', 'rune', 'string',
        'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr', 'any'],
      builtinWords: ['bool', 'byte', 'complex64', 'complex128', 'error',
        'float32', 'float64', 'int', 'int8', 'int16', 'int32', 'int64', 'rune',
        'string', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr', 'any'],
      builtinTypes: ['bool', 'byte', 'complex64', 'complex128', 'error',
        'float32', 'float64', 'int', 'int8', 'int16', 'int32', 'int64', 'rune',
        'string', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr', 'any',
        'Stringer', 'Reader', 'Writer', 'Closer'],
      typeKeywords: ['type', 'struct', 'interface', 'func'],
      /* Go 类型名没有 `_t` 后缀；全大写是导出名，不是宏。 */
      typeNameSuffix: null,
      macroNameRe: '(?!)',
      /* 无解析器时的兜底句式 */
      declScan: {
        funcDef: '^\\s*func\\s+(?:\\([^)]*\\)\\s*)?([A-Za-z_]\\w*)\\s*\\(',
        declHead: '^\\s*(?:var|const)\\s+([A-Za-z_]\\w*)',
        declTail: '[=;]',
        firstWord: '^[A-Za-z_]\\w*',
        forDecl: '^\\s*for\\s+([A-Za-z_]\\w*)\\s*:?=',
        /* `n int` —— 名字在类型前面（C 是 `int n`，名字在最后） */
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

    calleeSkip: ['if', 'for', 'switch', 'select', 'return', 'go', 'defer',
      'range', 'func', 'type', 'var', 'const'],
    typeSpecifiers: ['struct', 'interface'],
    declPrefix: ['var', 'const', 'type', 'func'],
    exprKeywordStops: ['return', 'if', 'for', 'go', 'defer', 'range'],

    /* 语法块：tree-sitter-go 的节点名 / 字段名（已对 wasm 实测） */
    syntax: {
      nt: {
        /* 名字与字段（同一命名空间） */
        name: 'name', type: 'type', returnType: 'result', value: 'value',
        identifier: 'identifier', typeIdentifier: 'type_identifier',
        fieldIdentifier: 'field_identifier',
        parameters: 'parameters', parameterList: 'parameter_list',
        parameterDeclaration: 'parameter_declaration',
        variadicParameter: 'variadic_parameter_declaration',
        fieldDeclarationList: 'field_declaration_list',

        /* 声明节点 */
        functionDefinition: ['function_declaration', 'method_declaration'],
        fieldDeclaration: 'field_declaration',

        /* 表达式与引用位置 */
        callExpression: 'call_expression',
        function: 'function',
        arguments: 'arguments',
        argumentList: 'argument_list',
        argument: 'value',
        memberRecv: 'operand',
        /* `pkg.Fn` / `x.F`：选择表达式的两个字段（2026-10-23） */
        selectorExpression: 'selector_expression',
        selectorField: 'field',
        selectorOperand: 'operand',
        /* `T{Field: v}`：复合字面量的键也是一个成员引用（2026-10-23） */
        compositeLiteral: 'composite_literal',
        keyedElement: 'keyed_element',
        /* 键/值都包在 literal_element 里（tree-sitter-go 没有 key 字段，
           第一个子节点就是键）。 */
        literalElement: 'literal_element',
        keyedKey: 'key',
        qualifiedType: 'qualified_type',
        assignmentExpression: 'assignment_statement',
        binaryExpression: 'binary_expression',
        unaryExpression: 'unary_expression',
        expressionStatement: 'expression_statement',
        returnStatement: 'return_statement',
        compoundStatement: 'block',
        left: 'left', right: 'right',

        /* token */
        eq: '=', amp: '&', star: '*', ellipsis: '...'
      },

      /* 「声明」判定：名字直接是声明节点的 `name` 字段 */
      declNodes: [
        'function_declaration', 'method_declaration',
        'type_spec', 'type_alias', 'var_spec', 'const_spec', 'method_spec',
        'field_declaration', 'parameter_declaration',
        'variadic_parameter_declaration', 'type_parameter_declaration',
        'short_var_declaration'
      ],
      declPatterns: [],
      /* 方法归属由 receiver 推导，没有 impl 那样的容器节点 */
      containerNodes: [],
      /* 数据驱动 item：节点 → kind（kind 也可由内部类型节点决定） */
      declKinds: {
        var_spec: 'variable',
        const_spec: 'variable',
        short_var_declaration: 'variable',
        method_spec: 'function',
        type_alias: 'typedef',
        /* 结构体字段（含嵌入字段）—— 以前 Go 的 field_declaration 一个符号
           都不产，比"嵌入字段没归属"更严重（2026-10-23 实测）。 */
        field_declaration: 'member'
      },
      /* `x, y := f()`：名字在左侧表达式表的直接子节点里（`p.x, ok :=` 只取 ok）。 */
      declNamesFrom: {
        short_var_declaration: { field: 'left', types: ['identifier'] }
      },
      /* 嵌入字段没有 `name`，名字就是类型的最后一段：`Foo` / `io.Reader` → Reader。
         （只对这几个节点生效，其它语言不填这个键。） */
      declNamesFromType: ['field_declaration'],
      /* `type Foo struct` 的 kind 写在 `type` 字段里；`type Foo int` 是别名。 */
      kindFromChild: {
        type_spec: {
          field: 'type',
          map: { struct_type: 'struct', interface_type: 'interface' },
          default: 'typedef'
        }
      },
      /* 一条声明多个名字：`var x, y int` / `func f(a, b int)` */
      multiNames: [
        'var_spec', 'const_spec', 'parameter_declaration',
        'variadic_parameter_declaration'
      ],
      /* 接口方法把参数表挂在自己身上（没有函数体也没有 declarator） */
      declParamsNodes: ['method_spec'],
      /* 接收者参数是方法作用域里的变量（`func (p *Packet) Encode()`） */
      extraParamFields: ['receiver'],
      /* 空白标识符只是占位，不是引用（`_ = f()`）。 */
      refIgnore: ['_'],
      /* 接口方法属于接口类型（parent 取当前类型名） */
      declParent: true,
      /* 方法归属：`func (p *Packet) Encode()` → Packet */
      receiver: { field: 'receiver', nameNodes: ['type_identifier'] },

      declContext: [
        'field_declaration', 'parameter_declaration',
        'variadic_parameter_declaration', 'type_spec', 'type_alias',
        'var_spec', 'const_spec', 'method_spec', 'type_parameter_declaration'
      ],
      /* 这些上下文里的名字只能是使用（走到这里就停） */
      useContext: [
        'call_expression', 'block', 'expression_statement', 'return_statement',
        'binary_expression', 'argument_list', 'assignment_statement'
      ],
      patterns: { declaratorish: 'identifier$|field_identifier$|type_identifier$' },
      grammar: 'tree-sitter-go.wasm',
      /* 调用的 callee 可以是 `pkg.Fn(...)`：名字被 selector_expression 包着。 */
      calleeWrappers: ['selector_expression'],
      roles: { read: 'read', write: 'write', call: 'call', address: 'address', type: 'type', field: 'field' },
      memberOps: ['.']
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);
