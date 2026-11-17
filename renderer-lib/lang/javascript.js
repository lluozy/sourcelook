(function (root) {
'use strict';
/* JavaScript / TypeScript 规则表（通用声明先落地；JSX/TS 特殊语义后续补）。 */
const L = root.Lang;
if (!L) throw new Error('lang/registry.js must load before lang/javascript.js');

const kinds = {
  function: 'function', class: 'class', variable: 'variable',
  parameter: 'parameter', member: 'member', macro: 'macro',
  struct: 'struct', enum: 'enum', typedef: 'typedef', module: 'module'
};

L.register('javascript', {
  id: 'javascript',
  name: 'JavaScript',
  indexId: 12,
  /* ts / tsx 在 lang/typescript.js 里（它借用本表的规则、换 TS grammar）；
     留在这里会被 entryFor 先命中，导致类型注解被当成符号名。 */
  extensions: ['js', 'mjs', 'cjs', 'jsx'],

  lexical: {
    comment: { line: '//', blockStart: '/*', blockEnd: '*/', nested: false },
    quotes: [{ ch: "'", escape: true }, { ch: '"', escape: true }, { ch: '`', escape: true }],
    escape: '\\',
    directiveSigil: '',
    includeWord: 'import',
    keywords: ['as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const',
      'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends',
      'finally', 'for', 'from', 'function', 'get', 'if', 'import', 'in', 'instanceof',
      'let', 'new', 'of', 'return', 'set', 'static', 'super', 'switch', 'this',
      'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield'],
    keywordsExtra: ['null', 'true', 'false', 'undefined'],
    keywordReason: 'JavaScript 关键字',
    colorKeywords: ['as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const',
      'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends',
      'finally', 'for', 'from', 'function', 'get', 'if', 'import', 'in', 'instanceof',
      'let', 'new', 'of', 'return', 'set', 'static', 'super', 'switch', 'this',
      'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield'],
    colorTypes: ['string', 'number', 'boolean', 'object', 'symbol', 'bigint', 'any', 'unknown', 'never']
  },

  imports: {
    nodeTypes: ['import_statement', 'import_declaration'],
    line: '^\\s*import\\s+.*?from\\s+[\'"]([^\'"]+)[\'"]',
    resolve: 'module',
    label: 'import',
    target: 'path',
    wholeLine: false
  },

  conditions: { sources: [], configPattern: '' },

  symbols: {
    kinds,
    indexKinds: ['function', 'class', 'variable', 'parameter', 'member', 'macro', 'struct', 'enum', 'typedef', 'module'],
    kindMap: { function: 'function', class: 'type', variable: 'variable', parameter: 'variable', member: 'member' },
    kindLabel: { function: '函数', type: '类型', variable: '变量', member: '成员' },
    indexKindLabel: { function: '函数', class: '类', variable: '变量', parameter: '参数', member: '成员' }
  },

  syntax: {
    nt: {
      name: 'name', type: 'type', parameters: 'parameters', parameterList: 'formal_parameters', body: 'body', value: 'value',
      identifier: 'identifier', typeIdentifier: 'type_identifier', fieldIdentifier: 'property_identifier',
      functionDefinition: ['function_declaration', 'function_expression', 'arrow_function', 'method_definition'],
      classDefinition: 'class_declaration',
      variableDeclaration: 'variable_declarator',
      callExpression: 'call_expression',
      function: 'function', arguments: 'arguments', argumentList: 'arguments',
      selectorExpression: 'member_expression', selectorField: 'property', selectorOperand: 'object',
      expressionStatement: 'expression_statement',
      returnStatement: 'return_statement',
      compoundStatement: 'statement_block',
      eq: '=', star: '*'
    },
    declNodes: ['function_declaration', 'function_expression', 'method_definition', 'class_declaration', 'variable_declarator'],
    declKinds: {
      function_declaration: 'function',
      function_expression: 'function',
      method_definition: 'function',
      class_declaration: 'class',
      variable_declarator: 'variable'
    },
    declContext: ['function_declaration', 'function_expression', 'method_definition', 'class_declaration', 'variable_declarator'],
    useContext: ['call_expression', 'statement_block', 'expression_statement', 'return_statement', 'arguments'],
    patterns: { declaratorish: 'identifier$|property_identifier$' },
    declParent: true,
    grammar: 'tree-sitter-javascript.wasm',
    roles: { read: 'read', write: 'write', call: 'call', address: 'address', type: 'type', field: 'field' },
    memberOps: ['.', '?.']
  }
});
})(typeof window !== 'undefined' ? window : globalThis);
