(function (root) {
'use strict';
/* Java 规则表：类/接口/方法/字段/参数，先覆盖通用声明。 */
const L = root.Lang;
if (!L) throw new Error('lang/registry.js must load before lang/java.js');

L.register('java', {
  id: 'java',
  name: 'Java',
  indexId: 13,
  extensions: ['java'],

  lexical: {
    comment: { line: '//', blockStart: '/*', blockEnd: '*/', nested: false },
    quotes: [{ ch: "'", escape: true }, { ch: '"', escape: true }, { ch: '"""', escape: true }],
    escape: '\\',
    directiveSigil: '',
    includeWord: 'import',
    keywords: ['abstract', 'assert', 'break', 'case', 'catch', 'class', 'const',
      'continue', 'default', 'do', 'else', 'enum', 'extends', 'final', 'finally',
      'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'interface', 'native',
      'new', 'package', 'private', 'protected', 'public', 'return', 'static',
      'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws',
      'transient', 'try', 'volatile', 'while', 'record', 'sealed', 'permits'],
    keywordsExtra: ['true', 'false', 'null'],
    keywordReason: 'Java 关键字',
    colorKeywords: ['abstract', 'assert', 'break', 'case', 'catch', 'class', 'const',
      'continue', 'default', 'do', 'else', 'enum', 'extends', 'final', 'finally',
      'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'interface', 'native',
      'new', 'package', 'private', 'protected', 'public', 'return', 'static',
      'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws',
      'transient', 'try', 'volatile', 'while', 'record', 'sealed', 'permits'],
    colorTypes: ['boolean', 'byte', 'char', 'double', 'float', 'int', 'long', 'short', 'void', 'String']
  },

  imports: {
    nodeTypes: ['import_declaration'],
    line: '^\\s*import\\s+(?:static\\s+)?([\\w.]+)',
    resolve: 'package',
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
    kindLabel: { function: '方法', type: '类型', variable: '变量', member: '字段' },
    indexKindLabel: { function: '方法', class: '类', variable: '变量', parameter: '参数', member: '字段' }
  },

  syntax: {
    nt: {
      name: 'name', type: 'type', parameters: 'parameters', parameterList: 'formal_parameters', body: 'body', value: 'value',
      identifier: 'identifier', typeIdentifier: 'type_identifier', fieldIdentifier: 'identifier',
      functionDefinition: 'method_declaration',
      classDefinition: ['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration'],
      fieldDeclaration: 'field_declaration',
      variableDeclaration: 'variable_declarator',
      callExpression: 'method_invocation',
      function: 'name', arguments: 'arguments', argumentList: 'argument_list',
      selectorExpression: ['field_access', 'method_invocation'], selectorField: 'field', selectorOperand: 'object',
      expressionStatement: 'expression_statement',
      returnStatement: 'return_statement',
      compoundStatement: 'block',
      eq: '=', star: '*'
    },
    declNodes: ['method_declaration', 'class_declaration', 'interface_declaration', 'enum_declaration',
      'record_declaration', 'field_declaration', 'variable_declarator', 'formal_parameter'],
    declKinds: {
      method_declaration: 'function',
      class_declaration: 'class',
      interface_declaration: 'class',
      enum_declaration: 'enum',
      record_declaration: 'class',
      field_declaration: 'member',
      variable_declarator: 'variable',
      formal_parameter: 'parameter'
    },
    declContext: ['method_declaration', 'class_declaration', 'interface_declaration',
      'enum_declaration', 'record_declaration', 'field_declaration', 'variable_declarator', 'formal_parameter'],
    useContext: ['method_invocation', 'block', 'expression_statement', 'return_statement', 'argument_list'],
    patterns: { declaratorish: 'identifier$' },
    declParent: true,
    grammar: 'tree-sitter-java.wasm',
    roles: { read: 'read', write: 'write', call: 'call', address: 'address', type: 'type', field: 'field' },
    memberOps: ['.']
  }
});
})(typeof window !== 'undefined' ? window : globalThis);
