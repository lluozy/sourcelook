(function (root) {
'use strict';
/* Python 规则表：先覆盖通用声明（函数、类、赋值变量），特殊语义后续补。 */
const L = root.Lang;
if (!L) throw new Error('lang/registry.js must load before lang/python.js');

L.register('python', {
  id: 'python',
  name: 'Python',
  indexId: 11,
  extensions: ['py', 'pyw', 'pyi'],

  lexical: {
    comment: { line: '#', blockStart: '', blockEnd: '', nested: false },
    quotes: [{ ch: "'", escape: true }, { ch: '"', escape: true }, { ch: '"""', escape: true }, { ch: "'''", escape: true }],
    escape: '\\',
    directiveSigil: '',
    includeWord: 'import',
    keywords: ['and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
      'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global',
      'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass',
      'raise', 'return', 'try', 'while', 'with', 'yield'],
    keywordsExtra: ['None', 'True', 'False', 'self', 'cls'],
    keywordReason: 'Python 关键字',
    colorKeywords: ['and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
      'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global',
      'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass',
      'raise', 'return', 'try', 'while', 'with', 'yield'],
    colorTypes: ['int', 'float', 'str', 'bool', 'bytes', 'list', 'dict', 'set', 'tuple', 'object']
  },

  imports: {
    nodeTypes: ['import_statement', 'import_from_statement'],
    line: '^\\s*(?:from\\s+([\\w.]+)\\s+import|import\\s+([\\w.]+))',
    resolve: 'module',
    label: 'import',
    target: 'path',
    wholeLine: false
  },

  conditions: { sources: [], configPattern: '' },

  symbols: {
    kinds: {
      function: 'function', class: 'class', variable: 'variable',
      parameter: 'parameter', member: 'member', macro: 'macro',
      struct: 'struct', enum: 'enum', typedef: 'typedef', module: 'module'
    },
    indexKinds: ['function', 'class', 'variable', 'parameter', 'member', 'macro', 'struct', 'enum', 'typedef', 'module'],
    kindMap: { function: 'function', class: 'type', variable: 'variable', parameter: 'variable', member: 'member' },
    kindLabel: { function: '函数', type: '类型', variable: '变量', member: '成员' },
    indexKindLabel: { function: '函数', class: '类', variable: '变量', parameter: '参数', member: '成员' }
  },

  syntax: {
    nt: {
      name: 'name', type: 'type', parameters: 'parameters', body: 'body', value: 'value',
      identifier: 'identifier', typeIdentifier: 'identifier', fieldIdentifier: 'identifier',
      functionDefinition: 'function_definition',
      classDefinition: 'class_definition',
      assignment: 'assignment',
      callExpression: 'call_expression',
      function: 'function', arguments: 'arguments', argumentList: 'argument_list',
      selectorExpression: 'attribute', selectorField: 'attribute', selectorOperand: 'object',
      expressionStatement: 'expression_statement',
      returnStatement: 'return_statement',
      compoundStatement: 'block',
      eq: '=', star: '*'
    },
    declNodes: ['function_definition', 'class_definition', 'assignment'],
    declKinds: {
      function_definition: 'function',
      class_definition: 'class',
      assignment: 'variable'
    },
    declNamesFrom: {
      assignment: { field: 'left', types: ['identifier'] }
    },
    declContext: ['assignment', 'function_definition', 'class_definition'],
    useContext: ['call_expression', 'block', 'expression_statement', 'return_statement', 'argument_list'],
    patterns: { declaratorish: 'identifier$' },
    declParent: true,
    grammar: 'tree-sitter-python.wasm',
    roles: { read: 'read', write: 'write', call: 'call', address: 'address', type: 'type', field: 'field' },
    memberOps: ['.']
  }
});
})(typeof window !== 'undefined' ? window : globalThis);
