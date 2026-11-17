'use strict';
/*
 * 增强包（L4）—— 项目自己的「家规」，纯 JSON 数据，不是插件。
 *
 * WHY. 解析器看得见语法，看不见约定：`static LIST_HEAD(x);` 里的 `x` 是声明还是
 * 使用，`container_of(p, struct s, m)` 里的 `m` 属于谁 —— 这些是**知识**，不是算法。
 * 把它们写成数据，才能让用户（和 AI）在不改代码的前提下把解析修好。
 *
 * 这里只做三件事：**读、验、写**。解析器怎么消费它由 ts-indexer.setEnhance()
 * 负责（那边只认归一化之后的 macros[]）；报告由 reportText() 生成。
 *
 * v2（2026-10-22）：只有一张表 macros[]，一条规则说清「这个宏产生什么」——
 * 造符号 declare / 抹名 mask / 容器 container，可叠加；note 是**纯备注**。
 * 参数下标一律按**源码位置**（0 起），名字可以拼模板（`$0_fops`）。
 * **不兼容 v1**（三数组写法已删除）：两种写法并存只会让人猜该写哪个。
 *
 * E3 定稿（2026-10-22 同日）：**AI 只写确定性的东西**——declare / mask /
 * container + 一句 note。`silent` 与 `relate` **不再接受**：
 *   silent 会把宏从"没看懂"清单里抹掉，待解析台账就再也看不到它；
 *   relate 由内置表推导（EXPORT_SYMBOL 这类登记点内置表本来就有）。
 * 包里出现这两个键 = 旧 AI 产物，逐条拒收并说明原因（见 normalize）。
 *
 * 契约见项目根的 ENHANCE-PACK.md。字段只增不改；改语义必须升 SCHEMA。
 */

const SCHEMA = 'ks-enhance/2';
const PACK_REL = '.kernelscope/enhance.json';
const MAX_BYTES = 1 << 20;

/* 允许声明的符号种类：解析器只认这三种（成员要能挂到结构体上）。 */
const DECL_KINDS = new Set(['function', 'variable', 'member']);

/* 规则在哪种**语法形状**下生效。空 = 两种都试。
     declaration  `static FOO(x);` —— tree-sitter 读成"类型=FOO，声明符=(x)"
     call         `FOO(a, b)` 真的解析成调用（函数体里、表达式里）
     statement    语句形状：把宏名抹掉再解析（属性宏/前缀修饰宏） */
const WHEN = new Set(['', 'declaration', 'call', 'statement']);

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const isName = (s) => typeof s === 'string' && NAME_RE.test(s);
/* 参数下标：**源码位置**，0 起（不是"第几个标识符"）。0..15 够用。 */
const isIdx = (n) => Number.isInteger(n) && n >= 0 && n <= 15;

/**
 * 名字模板：`$0` = 第 0 个参数（声明形状里 = 声明符名字）。
 * 只做**纯拼接**，不做条件、不做字符串化 —— 做不到就拒绝那一条，不猜。
 * @returns {string} 错误说明，空串表示合法
 */
function patternError(p) {
  if (typeof p !== 'string' || !p) return 'pattern 不是字符串';
  if (!/^[A-Za-z0-9_$]+$/.test(p)) return 'pattern 只能由字母/数字/下划线/$N 组成';
  const idx = (p.match(/\$\d+/g) || []).map((s) => Number(s.slice(1)));
  if (!idx.length) return 'pattern 里没有 $N';
  if (idx.some((n) => !isIdx(n))) return 'pattern 里的 $N 越界';
  return '';
}

function packPathOf(root) {
  const r = String(root || '').replace(/[\\/]+$/, '');
  return r + '/' + PACK_REL;
}

/** 报告文本的落盘位置（和增强包同一个目录，agent 直接读就行）。 */
function reportPathOf(root) {
  const r = String(root || '').replace(/[\\/]+$/, '');
  return r + '/.kernelscope/report.txt';
}

/**
 * 把磁盘上的 JSON（已 parse）归一化成解析器能直接吃的形状。
 *
 * 归一化的原则是「宁可少用，也不要误解」：一条规则写错了只丢这一条并在 errors
 * 里说明，绝不让整份包失效 —— 除非 schema 都不对。
 *
 * @returns {{ok: boolean, pack: object|null, errors: string[]}}
 */
function normalize(raw) {
  const errors = [];

  /* 分轮产出的收口（2026-10-22）：AI 一次写不完时会把规则分几段给，用户可能
     粘回其中一段。三种形状都收，最后合并成一份：
        { schema, macros:[...] }        一份完整包（正常）
        [ {...}, {...} ]                裸规则数组（模型最常给这个）
        { packs:[ {...}, {...} ] }      多份包（分轮结果一次性粘贴）
     同名规则**后者覆盖前者**，不报错 —— 分轮产出本来就会重叠。 */
  let macrosIn = null;
  let obj = raw;
  if (Array.isArray(raw)) {
    macrosIn = raw;
    obj = {};
  } else if (raw && typeof raw === 'object' && Array.isArray(raw.packs)) {
    macrosIn = [];
    for (const p of raw.packs) {
      const one = normalize(p);
      if (one.pack) macrosIn.push(...one.pack.macros);
      for (const e of one.errors) errors.push(e);
    }
    obj = { id: raw.id, version: raw.version };
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, pack: null, errors: errors.concat(['不是一个 JSON 对象']) };
  }
  /* schema 是版本标签，目前只有一版。**没写就按当前版本收**（AI 十次有八次
     忘了写，而"忘了写"和"写成别的版本"是两回事）；写成别的版本一律拒载 ——
     字段含义可能已经变了，猜不得（2026-10-21：用户拿 AI 生成的包被这句挡在门外）。 */
  const schema = String(obj.schema || SCHEMA);
  if (schema !== SCHEMA) {
    return { ok: false, pack: null, errors: errors.concat(['schema 是 ' + schema + '，本版本只认 ' + SCHEMA]) };
  }

  const pack = {
    schema: SCHEMA,
    id: String(obj.id || '').slice(0, 64),
    version: String(obj.version || '').slice(0, 32),
    macros: []
  };

  /* v2 只有一张表：macros[]。每条规则说清「这个宏产生什么」——造符号 / 抹名 /
     容器 / 关系，可叠加。不再有 attributeMacros / declarationMacros 三件套：
     它们本来就是同一件事的三种写法，分开只能让人（和 AI）猜该往哪个数组里放。 */
  const seen = new Map();       // name -> 在 pack.macros 里的下标（重复时替换）
  const list = macrosIn || (Array.isArray(obj.macros) ? obj.macros : []);
  for (const m of list) {
    if (!m || typeof m !== 'object') { errors.push('macros: 条目不是对象'); continue; }
    const name = String(m.name || '');
    if (!isName(name)) { errors.push('macros: 名字不合法 ' + JSON.stringify(m.name)); continue; }

    const when = String(m.when || '');
    if (!WHEN.has(when)) {
      errors.push(name + ': when 只能是 declaration / call / statement 或省略');
      continue;
    }
    const mask = m.mask === true;
    /* `note`：AI 写的**说明文字**（E3 定稿后 AI 唯一能写的"软"字段）。
       它什么都不做 —— 不造符号、不进 SPEC（所以也**不会**把宏从"没看懂"
       清单里抹掉），只在面板与待解析台账里给人看，标 ⟨AI⟩。 */
    const note = typeof m.note === 'string'
      ? m.note.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    /* `silent` / `relate` 不交给 AI（2026-10-22 E3）：
       silent 会把宏从"没看懂"清单里抹掉 —— 待解析台账就再也看不到它；
       relate 由内置表推导（EXPORT_SYMBOL 这类登记点内置表已有）。
       整条拒收而不是剥掉这个键：半收会让"我明明写了却不生效"变成常事。 */
    /* 只有**真的有效果**才拒：老包（2026-10-22 生成的那份 189 条）里每个条目都
       带 `"silent": false` / `"relate": []` 这样的默认值 —— 把它们也当"用了废字段"
       会把整份包判死（实测 189 条全被拒，等于用户的包凭空消失）。 */
    if (m.silent === true) {
      errors.push(name + '：silent 不再接受 —— 它会把宏从待解析清单里抹掉；'
        + '语句宏请写一条只有 note 的备注说明原因');
      continue;
    }
    if (Array.isArray(m.relate) && m.relate.length) {
      errors.push(name + '：relate 不再接受 —— 登记关系由内置表推导，不写在配置里');
      continue;
    }

    const declare = [];
    let bad = false;
    for (const d of (Array.isArray(m.declare) ? m.declare : [])) {
      if (!d || typeof d !== 'object') { errors.push(name + ': declare 条目不是对象'); bad = true; break; }
      const kind = String(d.kind || 'variable');
      if (!DECL_KINDS.has(kind)) {
        errors.push(name + ': kind 不认识 ' + JSON.stringify(d.kind));
        bad = true; break;
      }
      const type = typeof d.type === 'string' ? d.type.slice(0, 80) : '';
      if (d.pattern !== undefined) {
        const why = patternError(d.pattern);
        if (why) { errors.push(name + ': ' + why + ' ' + JSON.stringify(d.pattern)); bad = true; break; }
        declare.push({ pattern: String(d.pattern), kind, type });
      } else if (isIdx(d.arg)) {
        declare.push({ arg: d.arg, kind, type });
      } else {
        errors.push(name + ': declare 需要 arg(0..15) 或 pattern');
        bad = true; break;
      }
    }
    if (bad) continue;

    let container = null;
    if (m.container) {
      const c = m.container;
      if (!isIdx(c.typeArg) || !isIdx(c.member)) {
        errors.push(name + ': container.typeArg/member 必须是 0..15 的整数');
        continue;
      }
      if (c.typeArg === c.member) {
        errors.push(name + ': container 的 typeArg 与 member 相同，无意义');
        continue;
      }
      container = { typeArg: c.typeArg, member: c.member };
    }

    if (!mask && !declare.length && !container && !note) {
      errors.push(name + ': 什么也没做（没有 declare / mask / container / note）');
      continue;
    }
    /* mask 会把宏名从源码里抹掉，那时"声明形状"就不存在了，declare 无从谈起。 */
    if (mask && declare.length) {
      errors.push(name + ': mask 与 declare 不能共存（抹掉名字后就没有形状可依据）');
      continue;
    }
    /* 上限提到 3000：分轮产出的合集会越滚越大，而每条只有百来字节。 */
    if (pack.macros.length >= 3000 && !seen.has(name)) {
      errors.push('macros 超过 3000 条，其余已忽略');
      break;
    }
    const rule = { name, when, mask, note, declare, container };
    const at = seen.get(name);
    if (at === undefined) { seen.set(name, pack.macros.length); pack.macros.push(rule); }
    else pack.macros[at] = rule;          // 分轮重叠：后一份覆盖前一份
  }

  /* 一条规则都没有的包没有意义，但也不报错：用户可能先建空壳。 */
  return { ok: errors.length === 0, pack, errors };
}

/** 解析磁盘文本（字符串），顺带挡住超大文件。 */
function parseText(text) {
  const s = String(text == null ? '' : text);
  if (s.length > MAX_BYTES) return { ok: false, pack: null, errors: ['增强包超过 1 MB'] };
  let raw;
  try { raw = JSON.parse(s); } catch (err) {
    return { ok: false, pack: null, errors: ['JSON 解析失败：' + ((err && err.message) || err)] };
  }
  return normalize(raw);
}

/**
 * 给界面看的一句话状态（按"效果"计数，不是按数组）。
 *
 * `noteOnly` 是**只有备注、不影响解析**的规则名：面板据此把它们从"×0 未命中"
 * 的警告里排除（备注本来就不该命中），并单独列为 ⟨AI⟩ 备注（2026-10-22 E3）。
 */
function statusOf(pack) {
  if (!pack) return null;
  let declare = 0, mask = 0, container = 0, note = 0;
  const noteList = [];
  for (const m of pack.macros) {
    declare += m.declare.length;
    if (m.mask) mask++;
    if (m.container) container++;
    if (m.note) {
      note++;
      const only = !m.mask && !m.declare.length && !m.container;
      noteList.push({ name: m.name, note: m.note, only });
    }
  }
  return {
    id: pack.id || '',
    version: pack.version || '',
    rules: pack.macros.length,
    declare, mask, container, note,
    noteList,
    noteOnly: noteList.filter((r) => r.only).map((r) => r.name)
  };
}

/* ---------------------------------------------------------------- 报告

   报告是「工具没看懂什么」的清单，也是喂给 AI 的输入。它只描述**事实**：
   哪些宏出现在声明位置、哪些宏在文件作用域被调用、哪些调用长得像容器宏。
   不写"建议改成什么" —— 那是 AI 的活，也是用户审的活。 */

const KIND_TITLE = {
  macroDecl: '把宏当成了类型（声明没解析出来）',
  macroCall: '文件作用域调用的宏（可能是声明宏）',
  containerCall: '看起来像容器宏（成员归属不明）'
};
/* 报告是要**贴给 AI** 的，所以英文界面下它也得是英文（2026-10-21）。 */
const KIND_TITLE_EN = {
  macroDecl: 'A macro used as a type (the declaration was lost)',
  macroCall: 'A macro called at file scope (possibly a declaration macro)',
  containerCall: 'Looks like a container macro (member owner unknown)'
};
/* 报告里每条建议对应 v2 的哪个字段（给人看的提示，不参与逻辑）。 */
const KIND_HINT = {
  macroDecl: 'declare 或 mask',
  macroCall: 'declare',
  containerCall: 'container'
};
const KIND_ORDER = ['macroDecl', 'macroCall', 'containerCall'];

/**
 * @param {object} meta 索引元数据（含 issues: [{kind,name,count,file,line,sample}]）
 * @param {object} opts {project, maxPerKind}
 */
function reportText(meta, opts) {
  const o = opts || {};
  const en = o.lang === 'en';
  const TITLE = en ? KIND_TITLE_EN : KIND_TITLE;
  const issues = (meta && Array.isArray(meta.issues)) ? meta.issues : [];
  /* 每类最多列多少个名字。这个上限只为**防止病态输入**，不是"人看一屏"：
     闭环已经是 agent 直接读文件（grep），瓶颈不是人的注意力。内核实测
     2,409 个名字 ≈ 0.5 MB，所以默认放到 3,000，字节预算放到 1 MB
     （2026-10-23：用户问"装不下能不能加大限制"）。 */
  const max = Math.max(1, Math.min(5000, o.maxPerKind || 3000));
  const byKind = new Map();
  let total = 0;
  for (const it of issues) {
    if (!it || !TITLE[it.kind]) continue;
    total += it.count || 1;
    if (!byKind.has(it.kind)) byKind.set(it.kind, []);
    byKind.get(it.kind).push(it);
  }

  const project = o.project || (meta && meta.root) || '';
  /* 给 agent 用的**绝对路径**：它得知道把文件写到哪儿，别让它猜项目根。 */
  const packPath = o.rootPath
    ? String(o.rootPath).replace(/[\\/]+$/, '') + '/' + PACK_REL
    : '<项目根>/' + PACK_REL;
  const lines = [];
  lines.push((en ? '=== KernelScope parse report · ' : '=== KernelScope 解析报告 · ')
    + (project || (en ? 'untitled project' : '未命名项目')) + ' ===');
  const nFiles = (meta && meta.files && meta.files.length) || 0;
  lines.push(en
    ? 'Index: ' + nFiles + ' files; unread call/declaration sites: ' + total
    : '索引：' + nFiles + ' 个文件；未看懂的调用/声明：' + total + ' 处');
  /* 判"旧索引"只能看**有没有扫过**，不能看 issues 是不是空：
     旧索引读出来同样是 []，"0 处"和"没扫过"长得一模一样（2026-10-21）。 */
  if (!meta || meta.issuesScanned !== true) {
    lines.push('');
    lines.push(en
      ? 'This index was built before the parse report existed — rebuild the index and the report will be filled in.'
      : '这份索引建于旧版本，没有记录解析降级 —— 重建一次索引后这里才有内容（不是"没有降级"，是没扫过）。');
    return lines.join('\n');
  }
  if (!issues.length) {
    lines.push('');
    lines.push(en
      ? 'No parse drop-offs found — no enhancement pack needed.'
      : '没有发现解析降级的地方 —— 不需要增强包。');
    return lines.join('\n');
  }
  lines.push('');

  /* 报告用**字节预算**收口，而不是"每类 N 个"：三类名字的分布极不均匀
     （内核实测 macroCall 150 个、macroDecl 12 个），按类拍一个数要么浪费、
     要么把大头砍掉。现在按名字逐条记账，超预算就停，并明说还剩多少。 */
  const budget = Math.max(4096, Math.min(4 * 1024 * 1024, o.maxBytes || 1024 * 1024));
  let used = lines.join('\n').length;
  let idx = 0;
  for (const kind of KIND_ORDER) {
    const list = (byKind.get(kind) || []).slice().sort((a, b) => (b.count || 0) - (a.count || 0));
    if (!list.length) continue;
    idx++;
    const sum = list.reduce((n, x) => n + (x.count || 1), 0);
    lines.push('[' + idx + '] ' + TITLE[kind] + (en ? ' (' + sum + ')' : '（' + sum + ' 处）'));
    used += 40;
    let shown = 0;
    for (const it of list) {
      if (shown >= max) break;
      const cost = 30 + String(it.name).length + String(it.file || '').length
        + (it.sample ? 10 + String(it.sample).length : 0);
      if (used + cost > budget) break;
      used += cost;
      shown++;
      lines.push('    ' + it.name + '  ×' + (it.count || 1) + '   ' + it.file + ':' + it.line);
      if (it.sample) lines.push('        ' + it.sample);
      /* 宏体：`pattern` 的拼法只能从这里抄（前缀还是后缀、几个 `##`）。
         没有它，AI 只能按示例的形状猜 —— 猜错就是造出一堆不存在的名字。 */
      const def = o.defines && o.defines[it.name];
      if (def) lines.push('        ' + def);
    }
    if (list.length > shown) {
      lines.push(en
        ? '    …and ' + (list.length - shown) + ' more names (budget reached; raise it with maxBytes)'
        : '    …另有 ' + (list.length - shown) + ' 个名字（报告已达字节预算，可用 maxBytes 调大）');
    }
    lines.push('');
  }

  /* 符号级自检：这一段回答的是"有多少符号我们其实讲不清" —— 不是解析报错，
     而是"符号造出来了，但位置/类型/归属不可靠"。它比上面三类更能说明真实水平，
     也是"要不要给 AI 补事实"的规模依据（2026-10-22）。 */
  const st = meta.symStats;
  if (st && st.total) {
    const pct = (n) => Math.round((n / st.total) * 1000) / 10;
    lines.push(en ? '--- Symbol self-check (can a click explain it?) ---'
      : '--- 符号级自检（决定"点进去能不能讲清"）---');
    lines.push(en
      ? `symbols ${st.total} · definition line has no such name ${st.weakDef} (${pct(st.weakDef)}%) · type unknown ${st.noType} (${pct(st.noType)}%) · member without owner ${st.noOwner} (${pct(st.noOwner)}%)`
      : `符号 ${st.total} 个 · 定义行找不到名字 ${st.weakDef}（${pct(st.weakDef)}%）· 类型为空 ${st.noType}（${pct(st.noType)}%）· 成员没有归属 ${st.noOwner}（${pct(st.noOwner)}%）`);
    for (const s of (st.samples || []).slice(0, 8)) {
      lines.push('    [' + s.kind + '] ' + s.name + (s.line ? ':' + s.line : '') + '   ' + (s.sample || '').slice(0, 90));
    }
    lines.push('');
  }

  /* 报告末尾这一段是**给 AI / Agent 的需求书**，不是聊天提示词：
     agent 可以直接把产物写到 PACK_REL，不需要人肉粘贴，也不需要"分轮再粘"。
     所以这里给的是完整 schema + 一份可照抄的示例 + 硬约束，而不是"先写 60 条"。 */
  if (en) {
    lines.push('--- Task: produce an enhancement config ---');
    lines.push('');
    lines.push('Deliverable: one JSON file at ' + packPath
      + ' (rebuilding the index applies it; nothing needs pasting).');
    lines.push('Schema: ' + SCHEMA + '. Full shape — copy it and replace the macros with those from the report:');
    lines.push('');
    lines.push('{');
    lines.push('  "schema": "' + SCHEMA + '",');
    lines.push('  "id": "<project>", "version": "1",');
    lines.push('  "macros": [');
    lines.push('    { "name": "DEFINE_MUTEX",');
    lines.push('      "declare": [{ "arg": 0, "kind": "variable", "type": "struct mutex" }] },');
    lines.push('    { "name": "DEFINE_SHOW_ATTRIBUTE",');
    lines.push('      "declare": [{ "pattern": "$0_fops", "kind": "variable", "type": "struct file_operations" },');
    lines.push('                  { "pattern": "$0_open", "kind": "function" }] },');
    lines.push('    { "name": "__init", "mask": true },');
    lines.push('    { "name": "container_of", "container": { "typeArg": 1, "member": 2 } },');
    lines.push('    { "name": "__UNIQUE_ID", "note": "name is generated by the compiler; not expressible" }');
    lines.push('  ]');
    lines.push('}');
    lines.push('');
    lines.push('Fields:');
    lines.push('  name        macro name, exactly as in the source');
    lines.push('  when        optional: declaration | call | statement (omit = both shapes)');
    lines.push('  mask        true = blank this name out before parsing (attributes / prefix macros);');
    lines.push('              cannot appear in the same rule as declare');
    lines.push('  declare[]   creates symbols (repeatable)');
    lines.push('                arg      argument position, 0-based — count COMMAS in the source call');
    lines.push('                pattern  "$N" name template, pure concatenation ("$0_fops")');
    lines.push('                kind     function | variable | member');
    lines.push('                type     optional implied type');
    lines.push('  container   { "typeArg": n, "member": m }: the nth argument is the type, the mth is its member');
    lines.push('  note        optional: one sentence about this macro (what it does / why no rule fits).');
    lines.push('              Documentation only — it changes nothing in parsing.');
    lines.push('');
    lines.push('Hard constraints (a bad rule is rejected on its own, the rest still applies):');
    lines.push('  1. Indices are SOURCE positions, not "the Nth identifier".');
    lines.push('     e.g. DECLARE_PCI_FIXUP_HEADER(vendor, dev, class, mask, data, fn) → fn is arg 5.');
    lines.push('  2. Skip macros whose names need ## (especially with __VA_ARGS__) or # stringification — not expressible.');
    lines.push('  3. mask and declare cannot be combined in one rule.');
    lines.push('  4. A macro producing several symbols (DEFINE_SHOW_ATTRIBUTE → foo_fops / foo_open) uses several declare entries with pattern.');
    lines.push('  4b. **pattern must be copied from the `#define` body given above the entry, never from the examples.**');
    lines.push('      The `##` position tells you the order: `struct device_attribute dev_attr_##_name` → "dev_attr_$0"');
    lines.push('      (prefix); `__name ## _fops` → "$0_fops" (suffix). Guessing the order produces names that do not exist.');
    lines.push('  4c. Use `mask` ONLY for bare attribute words that always sit in a type position (`__init`, `__user`).');
    lines.push('      A macro WITH arguments must never be masked — blanking is lexical, it also erases identically named');
    lines.push('      fields or parameters. A statement macro that creates no symbol must NOT get a rule: either leave it');
    lines.push('      out or write a note-only entry ({ "name": "TP_ARGS", "note": "no symbol; statement macro" }) —');
    lines.push('      an unsolved macro stays in the pending list, which is where the next round looks.');
    lines.push('  5. Only handle macros that appear in the report above; when unsure, leave it out.');
    lines.push('  5b. An entry with NO `#define` line under it has no macro definition in this project — skip it.');
    lines.push('  6. Output JSON only — no prose, no Markdown fences. Write the file directly if you can.');
  } else {
    lines.push('--- 任务：生成增强配置 ---');
    lines.push('');
    lines.push('产物：一个 JSON 文件，写到 ' + packPath
      + '（重建索引即生效，不需要人工粘贴）。');
    lines.push('Schema：' + SCHEMA + '。完整形状如下，把 macros 换成上面报告里的宏即可：');
    lines.push('');
    lines.push('{');
    lines.push('  "schema": "' + SCHEMA + '",');
    lines.push('  "id": "<项目名>", "version": "1",');
    lines.push('  "macros": [');
    lines.push('    { "name": "DEFINE_MUTEX",');
    lines.push('      "declare": [{ "arg": 0, "kind": "variable", "type": "struct mutex" }] },');
    lines.push('    { "name": "DEFINE_SHOW_ATTRIBUTE",');
    lines.push('      "declare": [{ "pattern": "$0_fops", "kind": "variable", "type": "struct file_operations" },');
    lines.push('                  { "pattern": "$0_open", "kind": "function" }] },');
    lines.push('    { "name": "__init", "mask": true },');
    lines.push('    { "name": "container_of", "container": { "typeArg": 1, "member": 2 } },');
    lines.push('    { "name": "__UNIQUE_ID", "note": "名字由编译器生成，规则表达不了" }');
    lines.push('  ]');
    lines.push('}');
    lines.push('');
    lines.push('字段：');
    lines.push('  name       宏名，必须与源码完全一致');
    lines.push('  when       可选：declaration | call | statement（省略 = 两种形状都试）');
    lines.push('  mask       true = 解析前把这个名字抹掉（属性宏、前缀修饰宏）；不能与 declare 同条出现');
    lines.push('  declare[]  产生符号，可多条');
    lines.push('                arg      参数位置，0 起 —— **按源码调用里的逗号数**，不是"第几个标识符"');
    lines.push('                pattern  "$N" 名字模板，纯拼接（"$0_fops"）');
    lines.push('                kind     function | variable | member');
    lines.push('                type     可选，宏隐含的类型');
    lines.push('  container   { "typeArg": n, "member": m }：第 n 个参数是类型、第 m 个是它的成员');
    lines.push('  note        可选：一句话说明这个宏（它做什么 / 为什么没有规则）。**纯备注**，不影响解析');
    lines.push('');
    lines.push('硬约束（单条写错只丢那一条，其余照常生效）：');
    lines.push('  1. 下标是**源码位置**，不是标识符序号。');
    lines.push('     例：DECLARE_PCI_FIXUP_HEADER(vendor, dev, class, mask, data, fn) → fn 是 arg 5。');
    lines.push('  2. 名字需要 ## 拼接（尤其夹 __VA_ARGS__）或字符串化 #x 的宏**不要写** —— 表达不了。');
    lines.push('  3. mask 与 declare 不能出现在同一条规则里。');
    lines.push('  4. 一个宏产生多个符号（DEFINE_SHOW_ATTRIBUTE → foo_fops / foo_open）时，用多条 declare + pattern。');
    lines.push('  4b. **pattern 必须照着条目上方给出的 `#define` 宏体写，不要照抄示例的形状。**');
    lines.push('      `##` 的位置决定顺序：`struct device_attribute dev_attr_##_name` → "dev_attr_$0"（前缀）；');
    lines.push('      `__name ## _fops` → "$0_fops"（后缀）。顺序猜反 = 造出一堆源码里不存在的名字。');
    lines.push('  4c. `mask` **只**用于"永远出现在类型位置的裸属性词"（`__init`、`__user`）。');
    lines.push('      带参数的宏绝对不能 mask —— 抹名是词法的，会把同名字段/参数一起抹掉。');
    lines.push('      语句宏（不产生符号）**不要**造规则：要么不写，要么写一条只有 note 的备注说明原因');
    lines.push('      （例如 { "name": "TP_ARGS", "note": "语句宏，不产生符号" }）—— 没解决的宏留在待解析清单里，');
    lines.push('      那是下一轮要看的清单，抹掉它只会让问题消失而不是解决。');
    lines.push('  5. 只写上面报告里出现过的宏；不确定的宁可不写。');
    lines.push('  5b. 条目下面**没有 `#define` 行**的，说明项目里没有这个宏的定义 —— 跳过，不要写规则。');
    lines.push('  6. 只输出 JSON —— 不要解释、不要 Markdown 代码块；能直接写文件就直接写。');
  }
  return lines.join('\n');
}

/* ---------------------------------------------------------------- 待解析台账

   报告回答"工具没看懂什么"（给 AI 的需求书）；台账回答"这些为什么修不了、
   谁来解决"（给人、给下一个会话的备忘录）。四节对应四种**确定性修不了**：

     一 宏规则推不出      推导器的机械判据不满足（没有 #define / ## 不唯一 / 宏体空）
     二 规则表达不了      ks-enhance/2 能力之外（__VA_ARGS__ / 字符串化 #x）
     三 符号级讲不清      符号在，但位置/类型/归属不可靠（weakDef/noType/noOwner）
     四 接收者类型推不出  成员归属要靠接收者类型收窄，这些形状推断不出

   **没有面板也要先有文件**（2026-10-22 E2）：导出报告时一并落盘，agent 直接读。
   面板上的可点/可筛以后再做。 */

const PENDING_REL = '.kernelscope/pending.md';

/** 台账的落盘位置（和报告、增强包同一个目录，便于一起提交）。 */
function pendingPathOf(root) {
  const r = String(root || '').replace(/[\\/]+$/, '');
  return r + '/' + PENDING_REL;
}

/**
 * 从宏体推导「名字模板」，例如
 *
 *     struct device_attribute dev_attr_##_name = __ATTR_RO(_name)
 *        → ["dev_attr_$0"]
 *     static const struct file_operations __name ## _fops = {…}
 *        → ["$0_fops"]
 *
 * 只处理「`##` 两侧一边是形参、一边是字面量」这一种 —— 那也是内核里 95% 的拼法。
 * 拼法不唯一（一个宏体里好几处 `##`，比如 DEFINE_PER_CPU_SECTION）时返回多个，
 * 由调用方判定"说不清"。体检（auditPack）与台账（classifyMacro）共用这一份。
 */
function derivePatterns(body, params) {
  const out = new Set();
  const at = new Map((params || []).map((p, i) => [p, i]));
  const re = /([A-Za-z0-9_]+)\s*##\s*([A-Za-z0-9_]+)/g;
  let m;
  while ((m = re.exec(String(body || ''))) !== null) {
    const L = m[1];
    const R = m[2];
    const li = at.has(L) ? at.get(L) : -1;
    const ri = at.has(R) ? at.get(R) : -1;
    if (li >= 0 && ri < 0) out.add('$' + li + R);
    else if (li < 0 && ri >= 0) out.add(L + '$' + ri);
  }
  return Array.from(out);
}

/**
 * 一条"没看懂"的宏为什么推不出规则 / 表达不了。
 *
 * 只做**机械判据**，不猜：判据不阻塞的（返回 null）交给规则推导器（E1），
 * 这里不列 —— 台账只记"确定修不了"的。
 *
 * @param def {params, body} 或 null（项目里查不到 #define）
 * @returns {null|{sec: 1|2, why: string}} sec 1 = 推不出，2 = 表达不了
 */
function classifyMacro(def) {
  if (!def) {
    return { sec: 1, why: '项目里找不到这个宏的 #define（编译器内置 / 构建生成 / 条件编译才可见）' };
  }
  const body = String(def.body || '').replace(/\s+/g, ' ').trim();
  if (!body) return { sec: 1, why: '宏体是空的，没有可依据的形状' };
  /* 字符串化 `#x`：产出的是字符串字面量，不是符号。
     先抹掉 `##`（拼接）再判 —— `##name` 里的 `#n` 不是字符串化。 */
  if (/#[A-Za-z_(]/.test(body.split('##').join(' '))) {
    return { sec: 2, why: '宏体里有字符串化 #x，产出是字符串不是符号' };
  }
  /* `__VA_ARGS__`：名字按位置展开，规则只能纯拼接。 */
  if (/__VA_ARGS__/.test(body)) {
    return { sec: 2, why: '宏体里有 __VA_ARGS__，名字要靠变参展开，规则表达不了' };
  }
  if (body.indexOf('##') >= 0) {
    const pats = derivePatterns(body, (def.params || []));
    if (pats.length !== 1) {
      return {
        sec: 1,
        why: pats.length
          ? '宏体里有多处 ##（' + pats.join(' / ') + '），判断不出哪个是符号名'
          : '宏体里的 ## 两侧都不是形参，推不出名字拼法'
      };
    }
  }
  return null;
}

/**
 * 待解析台账正文（E2, 2026-10-22）。
 *
 * @param meta 索引元数据（issues / symStats / recvStats / issuesScanned / files）
 * @param opts {project, rootPath, lang, defs:{name:{params,body}}, notes:{name:string}, maxBytes}
 */
function pendingText(meta, opts) {
  const o = opts || {};
  const en = o.lang === 'en';
  const defs = o.defs || {};
  const notes = o.notes || {};
  const lines = [];
  const project = o.project || (meta && meta.root) || '';
  lines.push((en ? '# KernelScope pending list · ' : '# KernelScope 待解析清单 · ')
    + (project || (en ? 'untitled project' : '未命名项目')));
  lines.push('');
  if (en) {
    lines.push('> What the tool can neither read nor explain, with a reason and a sample per entry.');
    lines.push('> Not a bug list — a ledger of "do not spend time here again".');
    lines.push('> Written together with the parse report ("Export to file"); rebuild the index to refresh.');
  } else {
    lines.push('> 工具读不了 / 讲不清的东西，每条带原因与样本。**不是缺陷清单**，是"别再在这儿花时间"的台账。');
    lines.push('> 由「解析与增强 → 导出到文件」连同报告一并生成；重建索引后刷新。');
  }
  lines.push('');

  /* 和报告同一条判定：旧索引没扫过降级，"空"和"没扫"长得一样。 */
  if (!meta || meta.issuesScanned !== true) {
    lines.push(en
      ? 'This index was built before the ledger existed — rebuild the index and it will be filled in.'
      : '这份索引建于旧版本，没有记录解析降级 —— 重建一次索引后这里才有内容（不是"没有"，是没扫过）。');
    return lines.join('\n');
  }

  const issues = (Array.isArray(meta.issues) ? meta.issues : [])
    .filter((it) => it && it.name && KIND_ORDER.indexOf(it.kind) >= 0);
  const totalSpots = issues.reduce((n, it) => n + (it.count || 1), 0);
  const nFiles = (meta.files && meta.files.length) || 0;

  /* 分类：每个名字只进一节。判据不阻塞的**不列** —— 那是推导器的活（E1）。
     预算放到 1 MB（内核实测 2,409 个名字 ≈ 0.5 MB，能全量装下）；"装不下"
     才会出现"另有 N 个"，那时应当先看是不是索引里冒出了病态名字。 */
  const budget = Math.max(4096, Math.min(4 * 1024 * 1024, o.maxBytes || 1024 * 1024));
  let used = lines.join('\n').length;
  const sec1 = [];
  const sec2 = [];
  let derivable = 0;
  let omitted = 0;
  for (const it of issues.slice().sort((a, b) => (b.count || 0) - (a.count || 0))) {
    const cls = classifyMacro(defs[it.name] || null);
    if (!cls) { derivable++; continue; }
    const cost = 60 + String(it.name).length + String(it.file || '').length
      + String(it.sample || '').length;
    if (used + cost > budget) { omitted++; continue; }
    used += cost;
    (cls.sec === 1 ? sec1 : sec2).push({ it, why: cls.why });
  }

  lines.push(en
    ? 'Index: ' + nFiles + ' files; unread spots: ' + totalSpots + ' in ' + issues.length + ' names'
      + ' (' + derivable + ' not blocked — the rule deriver handles those; the rest are below)'
    : '索引：' + nFiles + ' 个文件；未看懂 ' + totalSpots + ' 处 / ' + issues.length + ' 个名字'
      + '（其中 ' + derivable + ' 个判据不阻塞，交给规则推导器；其余在下面）');
  if (omitted) {
    lines.push(en
      ? '…' + omitted + ' more names omitted (byte budget).'
      : '…另有 ' + omitted + ' 个名字因字节预算未列出。');
  }
  lines.push('');

  const section = (no, title, sub) => {
    lines.push('## ' + (en ? no + '. ' + title : no + '、' + title));
    lines.push('');
    lines.push(sub);
    lines.push('');
  };

  section(1, en ? 'Rule cannot be derived' : '宏规则推不出',
    en ? 'The mechanical criteria do not hold — no guessing, they stay here.'
      : '推导器的机械判据不满足 —— 不猜，留在这儿。');
  const emit = (list) => {
    if (!list.length) { lines.push(en ? '(none)' : '（无）'); lines.push(''); return; }
    for (const { it, why } of list) {
      lines.push(it.name + '   ×' + (it.count || 1) + '   ' + (it.file || '?') + ':' + (it.line || 0));
      lines.push('    ' + (en ? 'reason: ' : '原因：') + why);
      if (notes[it.name]) lines.push('    ⟨AI⟩ ' + notes[it.name]);
      if (it.sample) lines.push('    ' + (en ? 'sample: ' : '样本：') + String(it.sample).slice(0, 120));
      const def = defs[it.name];
      if (def && def.body) {
        const params = (def.params && def.params.length) ? '(' + def.params.join(', ') + ')' : '';
        lines.push('    ' + (en ? 'body:   ' : '宏体：')
          + ('#define ' + it.name + params + ' ' + String(def.body))
            .replace(/\s+/g, ' ').trim().slice(0, 140));
      }
      lines.push('');
    }
  };
  emit(sec1);

  section(2, en ? 'Schema cannot express it' : '规则表达不了',
    en ? 'Outside ks-enhance/2 — a rule would not help even with perfect information.'
      : 'ks-enhance/2 表达能力之外，写规则也解决不了（信息齐全也没用）。');
  emit(sec2);

  const st = meta.symStats;
  section(3, en ? 'Symbols that do not explain themselves' : '符号级讲不清',
    en ? 'The symbol exists, but its position / type / owner is not reliable.'
      : '符号造出来了，但位置 / 类型 / 归属不可靠（点进去可能讲不清）。');
  if (st && st.total) {
    lines.push((en
      ? 'of ' + st.total + ' symbols: definition line has no such name ' + (st.weakDef || 0)
        + ' · type unknown ' + (st.noType || 0) + ' · member without owner ' + (st.noOwner || 0)
      : '共 ' + st.total + ' 个符号：定义行找不到名字 ' + (st.weakDef || 0)
        + ' · 类型为空 ' + (st.noType || 0) + ' · 成员没有归属 ' + (st.noOwner || 0)));
    lines.push('');
    /* 三类"讲不清"的符号在内核里只有约 1,700 个（weakDef 619 + noOwner 1,042 +
       noType 0），所以**全量列出**，不再只给 40 条样本（2026-10-23）。 */
    for (const s of (st.samples || []).slice(0, 4000)) {
      lines.push('    [' + s.kind + '] ' + s.name + '   ' + (s.file || '?') + ':' + (s.line || 0));
      if (s.sample) lines.push('        ' + String(s.sample).slice(0, 110));
    }
    lines.push('');
  } else {
    lines.push(en ? '(no data in this index)' : '（这份索引没有符号级自检数据）');
    lines.push('');
  }

  const rs = meta.recvStats;
  section(4, en ? 'Receiver type cannot be inferred' : '接收者类型推不出',
    en ? 'Member references are narrowed by the receiver type; these receiver shapes need chained inference.'
      : '成员引用要靠接收者类型收窄；下面这些接收者形状要**链式推断**（下标剥层 / 强制转换 / 调用返回类型 / 多级成员），'
      + '任一环的名字或类型不在索引里就推断不出，只能整体退回"同名成员"。');
  if (!rs) {
    lines.push(en ? '(no data in this index — rebuild to collect it)' : '（旧索引没有这项统计，重建后才有内容）');
    lines.push('');
  } else {
    const rows = [
      ['plain', en ? 'plain identifier            p->m' : '普通标识符 p->m'],
      ['chain', en ? 'member chain                a.b->m' : '多级成员 a.b->m'],
      ['call', en ? 'call result                 f()->m' : '调用结果 f()->m'],
      ['index', en ? 'subscript                   a[i]->m' : '下标 a[i]->m'],
      ['cast', en ? 'cast                        ((T *)p)->m' : '强制转换 ((T *)p)->m'],
      ['other', en ? 'other' : '其他']
    ];
    for (const [k, label] of rows) {
      lines.push('    ' + label + '   ×' + (rs[k] || 0));
    }
    lines.push('    ' + (en ? 'total field accesses: ' : '字段访问合计：') + (rs.total || 0));
    const samples = (rs.samples || []).slice(0, 200);
    if (samples.length) {
      lines.push('');
      lines.push(en ? '  samples:' : '  样本：');
      for (const s of samples) {
        lines.push('    ' + s.recv + ' -> ' + s.name + '   ' + (s.file || '?') + ':' + (s.line || 0));
        if (s.sample) lines.push('        ' + String(s.sample).slice(0, 110));
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
  SCHEMA, PACK_REL, PENDING_REL, packPathOf, reportPathOf, pendingPathOf,
  normalize, parseText, statusOf, reportText, pendingText,
  derivePatterns, classifyMacro, KIND_TITLE
};
