(function (root) {
'use strict';
/* C++：以 C 规则为底，加 class / namespace 的通用声明，并使用真正的 C++ grammar。 */
const L = root.Lang;
if (!L) throw new Error('lang/registry.js must load before lang/cpp.js');
const base = ((L.tableFor('c') || {}).syntax) || {};

L.register('cpp', {
  id: 'cpp',
  name: 'C++',
  indexId: 2,
  extensions: ['cpp', 'hpp', 'cc', 'hh', 'cxx', 'hxx', 'inl', 'ipp', 'm', 'mm'],
  borrows: 'c',
  syntax: Object.assign({}, base, {
    grammar: 'tree-sitter-cpp.wasm',
    /* 类/命名空间里的函数归属容器；C++ 的成员与类作用域需要它。 */
    declParent: true,
    nt: Object.assign({}, base.nt, {
      classSpecifier: 'class_specifier',
      namespaceDefinition: 'namespace_definition'
    }),
    declNodes: (base.declNodes || []).concat(['class_specifier', 'namespace_definition']),
    declKinds: Object.assign({}, base.declKinds, {
      class_specifier: 'class',
      namespace_definition: 'module'
    }),
    declContext: (base.declContext || []).concat(['class_specifier', 'namespace_definition'])
  })
});
})(typeof window !== 'undefined' ? window : globalThis);
