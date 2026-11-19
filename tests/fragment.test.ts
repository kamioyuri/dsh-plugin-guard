/**
 * 纯函数契约测试（钉死"数据怎么算"）。
 * 运行：node --experimental-strip-types --test tests/fragment.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isProtectedModule,
  normalizeEdges,
  stableStringify,
  fnv1a,
  assessmentDigest,
  protectedDependent,
  dependentsOf,
  assessTarget,
  allPass,
  guardMetaFrom,
  PROTECTED_MODULES,
  type PluginNode,
  type DependEdge,
  type AssessmentReport,
} from '../src/fragment.ts'

function node(over: Partial<PluginNode> = {}): PluginNode {
  return {
    id: null,
    name: '@yuri/pkg',
    bundle: '@yuri/pkg',
    enabled: true,
    removable: true,
    fiberPhase: null,
    started: false,
    dependencies: [],
    dependents: [],
    readOnlyReason: null,
    official: false,
    optional: false,
    hasError: false,
    ...over,
  }
}

// ---- 核心保护名单 ----
test('核心保护名单命中（含核心栈）', () => {
  assert.equal(isProtectedModule('@deepseek-ai/dsh-plugin-manager'), true)
  assert.equal(isProtectedModule('@deepseek-ai/dsh-tools'), true)
  assert.equal(isProtectedModule('@deepseek-ai/dsh-base'), true)
  assert.equal(isProtectedModule('@yuri/pkg'), false)
  assert.ok(PROTECTED_MODULES.length >= 17)
})

// ---- 稳定序列化 / 摘要 ----
test('stableStringify 键排序稳定', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }))
})

test('fnv1a 稳定且非恒定', () => {
  assert.equal(fnv1a('abc'), fnv1a('abc'))
  assert.notEqual(fnv1a('abc'), fnv1a('abd'))
})

test('assessmentDigest 对状态变化敏感（TOCTOU 基础）', () => {
  const edges: DependEdge[] = [{ from: '@yuri/pkg', to: '@yuri/dep', kind: 'package' }]
  const nodes = [node({ name: '@yuri/pkg' }), node({ name: '@yuri/dep' })]
  const d1 = assessmentDigest(['@yuri/pkg'], nodes, edges)
  const d2 = assessmentDigest(['@yuri/pkg'], nodes.map(n => n.name === '@yuri/pkg' ? { ...n, enabled: false } : n), edges)
  assert.notEqual(d1, d2, '启用状态变化应改变摘要')
})

// ---- 依赖图 ----
test('normalizeEdges 去重排序', () => {
  const e = normalizeEdges([
    { from: 'b', to: 'a', kind: 'package' },
    { from: 'b', to: 'a', kind: 'package' },
    { from: 'a', to: 'c', kind: 'peer' },
  ])
  assert.equal(e.length, 2)
})

test('protectedDependent 检出核心依赖方', () => {
  const edges: DependEdge[] = [
    { from: '@deepseek-ai/dsh-plugin-manager', to: '@yuri/pkg', kind: 'package' },
  ]
  const nodes = [node({ name: '@deepseek-ai/dsh-plugin-manager', enabled: true, official: true }), node()]
  assert.equal(protectedDependent('@yuri/pkg', edges, nodes), '@deepseek-ai/dsh-plugin-manager')
})

test('dependentsOf 汇总依赖方', () => {
  const edges: DependEdge[] = [
    { from: 'a', to: '@yuri/pkg', kind: 'package' },
    { from: 'b', to: '@yuri/pkg', kind: 'peer' },
  ]
  const nodes = [node({ name: 'a' }), node({ name: 'b' }), node()]
  const refs = dependentsOf('@yuri/pkg', edges, nodes)
  assert.deepEqual(refs.map(r => r.name), ['a', 'b'])
})

// ---- 风险判定 ----
test('普通第三方插件：可安全删除', () => {
  const a = assessTarget({
    name: '@yuri/pkg',
    node: node(),
    edges: [],
    nodes: [node()],
    cachePaths: [],
    configEntries: [],
    residualPaths: [],
    skipped: [],
  })
  assert.equal(a.verdict, 'pass')
  assert.equal(a.risk, 'ok')
})

test('核心保护模块：阻断', () => {
  const target = '@deepseek-ai/dsh-plugin-manager'
  const a = assessTarget({
    name: target,
    node: node({ name: target, official: true }),
    edges: [],
    nodes: [node({ name: target, official: true })],
    cachePaths: [], configEntries: [], residualPaths: [], skipped: [],
  })
  assert.equal(a.verdict, 'block')
  assert.ok(a.blockers.includes('protected-module'))
})

test('management-required 只读：阻断', () => {
  const a = assessTarget({
    name: '@yuri/pkg',
    node: node({ readOnlyReason: 'management-required' }),
    edges: [], nodes: [node({ readOnlyReason: 'management-required' })],
    cachePaths: [], configEntries: [], residualPaths: [], skipped: [],
  })
  assert.equal(a.verdict, 'block')
  assert.ok(a.blockers.includes('protected-module'))
})

test('不可卸载：阻断', () => {
  const a = assessTarget({
    name: '@yuri/pkg',
    node: node({ removable: false }),
    edges: [], nodes: [node({ removable: false })],
    cachePaths: [], configEntries: [], residualPaths: [], skipped: [],
  })
  assert.equal(a.verdict, 'block')
  assert.ok(a.blockers.includes('not-removable'))
})

test('被核心依赖：阻断', () => {
  const core = node({ name: '@deepseek-ai/dsh-hmr', official: true, enabled: true })
  const target = node()
  const edges: DependEdge[] = [{ from: core.name, to: target.name, kind: 'package' }]
  const a = assessTarget({
    name: target.name, node: target, edges, nodes: [core, target],
    cachePaths: [], configEntries: [], residualPaths: [], skipped: [],
  })
  assert.equal(a.verdict, 'block')
  assert.ok(a.blockers.includes('required-by-core'))
})

test('运行中/被启用方依赖：warn 但可继续', () => {
  const other = node({ name: '@yuri/other', enabled: true })
  const target = node({ started: true })
  const edges: DependEdge[] = [{ from: other.name, to: target.name, kind: 'package' }]
  const a = assessTarget({
    name: target.name, node: target, edges, nodes: [other, target],
    cachePaths: [], configEntries: [], residualPaths: [], skipped: [],
  })
  assert.equal(a.verdict, 'pass')
  assert.equal(a.risk, 'warn')
})

test('目标不存在：阻断', () => {
  const a = assessTarget({
    name: 'ghost', node: undefined, edges: [], nodes: [],
    cachePaths: [], configEntries: [], residualPaths: [], skipped: [],
  })
  assert.equal(a.verdict, 'block')
  assert.ok(a.blockers.includes('target-not-found'))
})

// ---- 报告汇总 ----
test('allPass 要求全部通过且非空', () => {
  const mk = (pass: boolean): AssessmentReport => ({
    digest: 'x', pass, createdAt: 0,
    targets: [{ name: 'a', scope: 'third-party', risk: 'ok', verdict: pass ? 'pass' : 'block',
      reasons: [], blockers: [], dependents: [], running: false,
      plan: { bundles: [], modules: [], configEntries: [], cachePaths: [], residualPaths: [], skipped: [] } }],
  })
  assert.equal(allPass(mk(true)), true)
  assert.equal(allPass(mk(false)), false)
})

// ---- meta 解析 ----
test('guardMetaFrom 校验 kind', () => {
  assert.ok(guardMetaFrom({ kind: 'plugin-guard-list', rows: [], summary: '' }))
  assert.equal(guardMetaFrom({ kind: 'other', rows: [], summary: '' }), undefined)
  assert.equal(guardMetaFrom(null), undefined)
})

// ============ 恶意行为扫描契约（新增功能） ============
import {
  analyzeText, scanLevelOf, categoriesOf, summarizeScan, isHighRisk,
  SCAN_RULES, type ScanHit,
} from '../src/fragment.ts'

function hit(ruleId: string, severity: 'low'|'medium'|'high', category: any): ScanHit {
  return { ruleId, category, severity, label: ruleId, line: 1, excerpt: '' }
}

test('扫描规则表覆盖各风险类型且严重度合法', () => {
  assert.ok(SCAN_RULES.length >= 12)
  for (const r of SCAN_RULES) {
    assert.ok(['low', 'medium', 'high'].includes(r.severity))
    assert.ok(new RegExp(r.source, r.flags), `规则 ${r.id} 正则应可编译`)
  }
  const cats = new Set(SCAN_RULES.map((r) => r.category))
  for (const need of ['dynamic-code', 'child-process', 'network-egress', 'credential-access', 'core-tamper', 'fs-destructive', 'obfuscation', 'env-harvest']) {
    assert.ok(cats.has(need as any), `应覆盖类别 ${need}`)
  }
})

test('analyzeText 检出 eval 与子进程并给出行号', () => {
  const hits = analyzeText('const x = 1\neval(userInput)\nspawn("cmd", ["/c", "x"])')
  const ids = hits.map((h) => h.ruleId)
  assert.ok(ids.includes('eval'))
  assert.ok(ids.includes('child-exec'))
  assert.ok(hits.some((h) => h.line === 2))
})

test('analyzeText 对干净文本零命中', () => {
  assert.equal(analyzeText('const sum = a + b\nexport default sum').length, 0)
})

test('analyzeText 每规则最多记录上限条，避免爆炸', () => {
  const text = Array.from({ length: 50 }, (_, i) => `eval(x${i})`).join('\n')
  const hits = analyzeText(text, 3)
  assert.ok(hits.filter((h) => h.ruleId === 'eval').length <= 3)
})

test('scanLevelOf / categoriesOf / isHighRisk', () => {
  assert.equal(scanLevelOf([]), 'clean')
  assert.equal(scanLevelOf([hit('a', 'low', 'obfuscation')]), 'low')
  assert.equal(scanLevelOf([hit('a', 'medium', 'network-egress')]), 'medium')
  assert.equal(scanLevelOf([hit('a', 'high', 'child-process')]), 'high')
  assert.deepEqual(categoriesOf([hit('a', 'high', 'child-process'), hit('b', 'low', 'child-process'), hit('c', 'low', 'obfuscation')]), ['child-process', 'obfuscation'])
  assert.equal(isHighRisk({ name: 'x', level: 'high', categories: [], hits: [], summary: '', filesScanned: 0 }), true)
  assert.equal(isHighRisk({ name: 'x', level: 'medium', categories: [], hits: [], summary: '', filesScanned: 0 }), false)
})

test('summarizeScan 区分干净/高风险/异常', () => {
  assert.ok(summarizeScan('p', [], 5).includes('未发现'))
  assert.ok(summarizeScan('p', [hit('a', 'high', 'child-process')], 5).includes('高风险'))
  assert.ok(summarizeScan('p', [], 0, '权限不足').includes('扫描异常'))
  assert.ok(summarizeScan('p', [hit('a', 'high', 'child-process')], 5).includes('非恶意定论'))
})

test('guardMetaFrom 接受新增的 scan/menu kind', () => {
  assert.ok(guardMetaFrom({ kind: 'plugin-guard-scan', rows: [], summary: '' }))
  assert.ok(guardMetaFrom({ kind: 'plugin-guard-menu', rows: [], summary: '' }))
})

// ============ 设置菜单可删过滤（新增） ============
import { isRemovableBundle } from '../src/fragment.ts'

test('isRemovableBundle：dsh-tui 第三方 bundle 可列出', () => {
  assert.equal(isRemovableBundle({ name: '@deepseek-harness-tui/dsh-tui', enabled: false, removable: true, readOnlyReason: null, official: false }), true)
})

test('isRemovableBundle：核心/只读/不可删被隐藏', () => {
  assert.equal(isRemovableBundle({ name: '@deepseek-ai/dsh-plugin-manager', removable: true }), false) // 核心名单
  assert.equal(isRemovableBundle({ name: '@yuri/x', removable: false }), false)
  assert.equal(isRemovableBundle({ name: '@yuri/x', removable: true, readOnlyReason: 'management-required' }), false)
})

test('isRemovableBundle：畸形输入被拒绝', () => {
  assert.equal(isRemovableBundle(null), false)
  assert.equal(isRemovableBundle({}), false)
  assert.equal(isRemovableBundle({ name: '', removable: true }), false)
})

// ============ 搜索过滤（新增） ============
import { isListableBundle, filterByName } from '../src/fragment.ts'

test('isListableBundle：dsh-tui 即使 removable=false 也列出（可被搜索到）', () => {
  assert.equal(isListableBundle({ name: '@deepseek-harness-tui/dsh-tui', removable: false }), true)
})

test('isListableBundle：核心模块仍隐藏', () => {
  assert.equal(isListableBundle({ name: '@deepseek-ai/dsh-plugin-manager', removable: true }), false)
})

test('filterByName：大小写不敏感子串匹配，空串返回全部', () => {
  const names = ['@deepseek-harness-tui/dsh-tui', '@yuri/guard', 'dsh-market']
  assert.deepEqual(filterByName(names, ''), names)
  assert.deepEqual(filterByName(names, 'TUI'), ['@deepseek-harness-tui/dsh-tui'])
  assert.deepEqual(filterByName(names, 'DSH-'), ['@deepseek-harness-tui/dsh-tui', 'dsh-market'])
  assert.deepEqual(filterByName(names, 'zzz'), [])
})
