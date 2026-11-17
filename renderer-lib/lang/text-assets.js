(function (root) {
'use strict';
/* --------------------------------------------------------- 文本资产（一族条目）
 *
 * 「注册条目统一化」（G.4 定稿）：文本资产 = **符号槽为空的注册条目**，
 * 条目粒度 = lang 粒度。它们可浏览、可全文搜索、可点符号（走跨池兜底），
 * 但**零符号产出**、不参与符号池。
 *
 * 扩展名清单按定稿（2026-10-16，含内核实测）：
 *   - `.S`  → asm（1295 个；两段式词法：# 行按 C 预处理指令识别）
 *   - `Kconfig` → kconfig（1501 个）
 *   - `.dts/.dtsi/.lds/.lds.S` → dts（3500+ / 70 个）
 *   - `Makefile/Kbuild/...` → make
 *   - 散文与数据（.md/.txt/.rst/.yaml/.json/...）→ text
 *   - **`.inc/.def` 刻意不列**（内核树实测 0/2 个）：无条目 = 未知语言 →
 *     走默认规则，别的项目用项目级扩展名覆盖表改。
 *
 * 真正的编程语言（.py/.java/.rs/.go/.js/...）也**刻意不列**：它们将来是
 * 完整的注册条目（grammar + 规则表 + 哨兵），在此之前按「未知语言」处理
 * 才是诚实的（近似符号 / 低置信度），而不是假装成文本资产。
 *
 * indexId 是**固定枚举**：新增一个语言值 = 索引格式变更 = 重建（零兼容硬规则）。
 */
const ASSETS = [
  {
    id: 'asm',
    name: '汇编（.S）',
    indexId: 3,
    textAsset: true,
    extensions: ['s']
  },
  {
    id: 'kconfig',
    name: 'Kconfig',
    indexId: 4,
    textAsset: true,
    names: ['Kconfig']
  },
  {
    id: 'dts',
    name: '设备树 / 链接脚本',
    indexId: 5,
    textAsset: true,
    extensions: ['dts', 'dtsi', 'lds']
  },
  {
    id: 'make',
    name: '构建文件',
    indexId: 6,
    textAsset: true,
    names: ['Makefile', 'makefile', 'GNUmakefile', 'Kbuild', 'CMakeLists.txt'],
    extensions: ['mk', 'am', 'ac', 'cmake']
  },
  {
    id: 'text',
    name: '文本',
    indexId: 7,
    textAsset: true,
    extensions: ['md', 'txt', 'rst', 'yaml', 'yml', 'json', 'toml', 'ini', 'cfg', 'conf',
      'sh', 'bash', 'zsh']
  }
];

for (const t of ASSETS) root.Lang.register(t.id, t);

})(typeof window !== 'undefined' ? window : globalThis);
