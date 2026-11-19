/**
 * 集成冒烟测试：用 mock ctx 直接驱动 PluginGuard 核心服务，
 * 覆盖 scan/list/evaluate/cleanup/令牌/TOCTOU 全链路，不依赖 dsh 内部依赖树。
 * 运行：node --experimental-strip-types --test tests/integration.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PluginGuard, DEFAULT_CONFIG } from '../src/guard.ts'

// mock 插件集：核心管理器 + 普通第三方 + 不可删 + 被核心依赖
function bundles() {
  return [
    { name: '@deepseek-ai/dsh-plugin-manager', rows: [{ moduleName: '@deepseek-ai/dsh-plugin-manager' }], official: true, optional: false, removable: false, enabled: true, error: null },
    { name: '@yuri/good-plugin', rows: [{ moduleName: '@yuri/good-plugin' }], official: false, optional: false, removable: true, enabled: true, error: null },
    { name: '@yuri/locked-plugin', rows: [{ moduleName: '@yuri/locked-plugin' }], official: false, optional: false, removable: false, enabled: false, error: null },
  ]
}

function makeGuard(overrides: Record<string, any> = {}) {
  const removed: string[] = []
  const ctx: any = {
    pluginManager: {
      listBundles: async () => bundles(),
      listPlugins: async () => bundles().map((b, i) => ({
        moduleName: b.name, patchId: `p${i}`, enabled: b.enabled,
        fiberPhase: b.enabled ? 'started' : null,
      })),
      removeBundle: async (name: string) => { removed.push(name); return { changed: true } },
    },
    profileContext: { dir: 'C:\\fake\\profiles\\web', home: 'C:\\fake', installAnchor: '', startedBundles: ['@yuri/good-plugin'] },
    ...overrides,
  }
  return { guard: new PluginGuard(ctx, DEFAULT_CONFIG), removed, ctx }
}

test('manager 可用 / 不可用判定', () => {
  assert.equal(makeGuard().guard.managerAvailable(), true)
  assert.equal(makeGuard({ pluginManager: undefined }).guard.managerAvailable(), false)
})

test('scan：构建节点与依赖边（无 package.json 时依赖为空但不崩溃）', async () => {
  const { guard } = makeGuard()
  const { nodes, edges } = await guard.scan()
  assert.equal(nodes.length, 3)
  assert.ok(Array.isArray(edges))
  const good = nodes.find((n) => n.name === '@yuri/good-plugin')!
  assert.equal(good.started, true)
  assert.equal(good.removable, true)
})

test('scan：pluginManager 缺失时抛明确错误', async () => {
  const { guard } = makeGuard({ pluginManager: undefined })
  await assert.rejects(() => guard.scan(), /pluginManager/)
})

test('list：返回全部并标注受保护/可删除', async () => {
  const { guard } = makeGuard()
  const { rows } = await guard.list({ status: 'all' })
  assert.equal(rows.length, 3)
  const core = rows.find((r) => r.name === '@deepseek-ai/dsh-plugin-manager')!
  assert.equal(core.protected, true)
  assert.equal(core.removable, false)
  const good = rows.find((r) => r.name === '@yuri/good-plugin')!
  assert.equal(good.removable, true)
})

test('list：removable 筛选只保留可删项', async () => {
  const { guard } = makeGuard()
  const { rows } = await guard.list({ status: 'removable' })
  assert.ok(rows.every((r) => r.removable))
})

test('evaluate：核心模块被阻断（返回 block + 令牌）', async () => {
  const { guard } = makeGuard()
  const { report, token } = await guard.evaluate(['@deepseek-ai/dsh-plugin-manager'])
  assert.equal(report.pass, false)
  assert.equal(report.targets[0].verdict, 'block')
  assert.ok(report.targets[0].blockers.includes('protected-module'))
  assert.ok(token)
})

test('evaluate：普通插件通过（返回 pass + digest + 令牌）', async () => {
  const { guard } = makeGuard()
  const { report, token } = await guard.evaluate(['@yuri/good-plugin'])
  assert.equal(report.pass, true)
  assert.ok(report.digest)
  assert.ok(token)
})

test('cleanup：无令牌 / 无效令牌 / 目标不符 均被拒绝', async () => {
  const { guard } = makeGuard()
  const none = await guard.cleanup('', ['@yuri/good-plugin'])
  assert.equal(none.ok, false)
  assert.ok(none.message.includes('缺少评估令牌'))

  const bad = await guard.cleanup('not-a-real-token', ['@yuri/good-plugin'])
  assert.equal(bad.ok, false)
  assert.ok(bad.message.includes('无效或已过期'))

  const evaluated = await guard.evaluate(['@yuri/good-plugin'])
  const mismatch = await guard.cleanup(evaluated.token, ['@yuri/locked-plugin'])
  assert.equal(mismatch.ok, false)
  assert.ok(mismatch.message.includes('不一致'))
})

test('cleanup：评估阻断的目标即使持令牌也拒绝', async () => {
  const { guard } = makeGuard()
  const evaluated = await guard.evaluate(['@deepseek-ai/dsh-plugin-manager'])
  const res = await guard.cleanup(evaluated.token, ['@deepseek-ai/dsh-plugin-manager'])
  assert.equal(res.ok, false)
  assert.ok(res.message.includes('阻断风险'))
})

test('cleanup：正常流程调用官方 removeBundle', async () => {
  const { guard, removed } = makeGuard()
  const evaluated = await guard.evaluate(['@yuri/good-plugin'])
  const res = await guard.cleanup(evaluated.token, ['@yuri/good-plugin'])
  assert.equal(res.ok, true)
  assert.ok(removed.includes('@yuri/good-plugin'))
  assert.ok(res.message.includes('重启'))
})

test('cleanup：令牌一次性（重放被拒）', async () => {
  const { guard } = makeGuard()
  const evaluated = await guard.evaluate(['@yuri/good-plugin'])
  await guard.cleanup(evaluated.token, ['@yuri/good-plugin'])
  const replay = await guard.cleanup(evaluated.token, ['@yuri/good-plugin'])
  assert.equal(replay.ok, false)
  assert.ok(replay.message.includes('已被使用'))
})

test('cleanup：TOCTOU —— 评估后状态变化导致摘要不符则中止', async () => {
  const ctx: any = {
    pluginManager: {
      listBundles: async () => bundles(),
      listPlugins: async () => bundles().map((b, i) => ({ moduleName: b.name, patchId: `p${i}`, enabled: true, fiberPhase: 'started' })),
      removeBundle: async () => ({ changed: true }),
    },
    profileContext: { dir: 'C:\\fake\\profiles\\web', home: 'C:\\fake', installAnchor: '', startedBundles: [] },
  }
  const guard = new PluginGuard(ctx, DEFAULT_CONFIG)
  const evaluated = await guard.evaluate(['@yuri/good-plugin'])
  // 模拟评估后该插件被停用（状态变化）
  ctx.pluginManager.listPlugins = async () => bundles().map((b, i) => ({
    moduleName: b.name, patchId: `p${i}`, enabled: b.name === '@yuri/good-plugin' ? false : true,
    fiberPhase: b.name === '@yuri/good-plugin' ? null : 'started',
  }))
  const res = await guard.cleanup(evaluated.token, ['@yuri/good-plugin'])
  assert.equal(res.ok, false)
  assert.ok(res.message.includes('状态在评估后发生变化'))
})

test('cleanup：自保护 —— 本插件永不删除', async () => {
  // 构造一个把插件守护者当作普通第三方插件的 ctx
  const self = { name: '@yuri/dsh-plugin-guard', rows: [{ moduleName: '@yuri/dsh-plugin-guard' }], official: false, optional: false, removable: true, enabled: true, error: null }
  const ctx: any = {
    pluginManager: {
      listBundles: async () => [self],
      listPlugins: async () => [{ moduleName: self.name, patchId: 'p0', enabled: true, fiberPhase: 'started' }],
      removeBundle: async () => ({ changed: true }),
    },
    profileContext: { dir: 'C:\\fake\\profiles\\web', home: 'C:\\fake' },
  }
  const guard = new PluginGuard(ctx, DEFAULT_CONFIG)
  const evaluated = await guard.evaluate(['@yuri/dsh-plugin-guard'])
  assert.equal(evaluated.report.pass, false)
  assert.ok(evaluated.report.targets[0].blockers.includes('self-protect'))
})

// ============ 恶意扫描 + 删除联动 + 交互菜单边界（新增功能） ============

test('scanPlugins：可扫描真实目录并识别可疑特征', async () => {
  const { guard } = makeGuard()
  // 用项目 src 目录作为 fake profile 的插件目录
  const ctx: any = {
    pluginManager: { listBundles: async () => [], listPlugins: async () => [] },
    profileContext: { dir: 'D:/WorkBuddy-wenjian/wb wenjian/dsh/删除插件/.t-scan', home: 'C:/fake' },
  }
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const root = 'D:/WorkBuddy-wenjian/wb wenjian/dsh/删除插件/.t-scan'
  try {
    mkdirSync(root + '/node_modules/@yuri/suspicious', { recursive: true })
    writeFileSync(root + '/node_modules/@yuri/suspicious/index.js', 'eval(userInput)\nconst { exec } = require("child_process")\n')
    const g = new PluginGuard(ctx, { ...DEFAULT_CONFIG, scanMaxFiles: 300 })
    const results = await g.scanPlugins(['@yuri/suspicious'])
    assert.equal(results.length, 1)
    assert.ok(results[0].filesScanned > 0)
    assert.ok(['high', 'medium', 'low', 'clean'].includes(results[0].level))
    assert.ok(results[0].summary.length > 0)
  } finally {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* noop */ }
  }
})

test('scanPlugins：插件目录不存在时返回 error 而非抛出', async () => {
  const ctx: any = {
    pluginManager: { listBundles: async () => [], listPlugins: async () => [] },
    profileContext: { dir: 'C:/definitely/not/exist/profile', home: 'C:/fake' },
  }
  const g = new PluginGuard(ctx, DEFAULT_CONFIG)
  const results = await g.scanPlugins(['@yuri/ghost'])
  assert.equal(results[0].level, 'error')
  assert.equal(results[0].error, 'plugin-directory-not-found')
})

test('scanPlugins：pluginManager 缺失时仍抛明确错误（扫描依赖枚举）', async () => {
  const ctx: any = { profileContext: { dir: 'C:/fake' } }
  const g = new PluginGuard(ctx, DEFAULT_CONFIG)
  await assert.rejects(() => g.scanPlugins(['x']), /pluginManager/)
})

test('askUser：无 userQuestions 服务时优雅返回空', async () => {
  const { guard } = makeGuard()
  const out = await guard.askUser([{ id: 'q', question: '选一个', options: [{ label: 'A' }] }])
  assert.deepEqual(out, {})
})

test('askUser：服务返回答案时正确映射为 label 列表', async () => {
  const ctx: any = {
    pluginManager: { listBundles: async () => [], listPlugins: async () => [] },
    profileContext: { dir: 'C:/fake' },
    userQuestions: { ask: async () => ({ answers: [{ id: 'q', selected: ['A', 'B'] }] }) },
  }
  const g = new PluginGuard(ctx, DEFAULT_CONFIG)
  const out = await g.askUser([{ id: 'q', question: '选', options: [{ label: 'A' }, { label: 'B' }] }])
  assert.deepEqual(out, { q: ['A', 'B'] })
})

test('askUser：服务抛错时优雅降级为空', async () => {
  const ctx: any = {
    pluginManager: { listBundles: async () => [], listPlugins: async () => [] },
    profileContext: { dir: 'C:/fake' },
    userQuestions: { ask: async () => { throw new Error('no answerer') } },
  }
  const g = new PluginGuard(ctx, DEFAULT_CONFIG)
  assert.deepEqual(await g.askUser([{ id: 'q', question: '选' }]), {})
})

test('evaluate withScan：高风险目标被标记 requiresExtraConfirm，普通目标不受影响', async () => {
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const root = 'D:/WorkBuddy-wenjian/wb wenjian/dsh/删除插件/.t-evalscan'
  try {
    mkdirSync(root + '/node_modules/@yuri/risky', { recursive: true })
    writeFileSync(root + '/node_modules/@yuri/risky/index.js', 'eval(userInput)\n')
    const ctx: any = {
      pluginManager: {
        listBundles: async () => [
          { name: '@yuri/risky', rows: [{ moduleName: '@yuri/risky' }], removable: true, enabled: true, official: false, optional: false, error: null },
          { name: '@yuri/clean', rows: [{ moduleName: '@yuri/clean' }], removable: true, enabled: true, official: false, optional: false, error: null },
        ],
        listPlugins: async () => [
          { moduleName: '@yuri/risky', patchId: 'p0', enabled: true, fiberPhase: null },
          { moduleName: '@yuri/clean', patchId: 'p1', enabled: true, fiberPhase: null },
        ],
      },
      profileContext: { dir: root, home: 'C:/fake' },
    }
    const g = new PluginGuard(ctx, DEFAULT_CONFIG)
    const { report } = await g.evaluate(['@yuri/risky', '@yuri/clean'], true)
    const risky = report.targets.find((t) => t.name === '@yuri/risky')!
    const clean = report.targets.find((t) => t.name === '@yuri/clean')!
    assert.equal(risky.requiresExtraConfirm, true)
    assert.equal(risky.scan?.level, 'high')
    assert.equal(clean.scan?.level, 'error') // 目录不存在 -> error，不算高风险
  } finally {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* noop */ }
  }
})

test('cleanup 联动：高风险目标未确认时拒绝，确认后放行', async () => {
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const root = 'D:/WorkBuddy-wenjian/wb wenjian/dsh/删除插件/.t-cleanlink'
  try {
    mkdirSync(root + '/node_modules/@yuri/risky', { recursive: true })
    writeFileSync(root + '/node_modules/@yuri/risky/index.js', 'eval(x)\n')
    const ctx: any = {
      pluginManager: {
        listBundles: async () => [{ name: '@yuri/risky', rows: [{ moduleName: '@yuri/risky' }], removable: true, enabled: true, official: false, optional: false, error: null }],
        listPlugins: async () => [{ moduleName: '@yuri/risky', patchId: 'p0', enabled: true, fiberPhase: null }],
        removeBundle: async () => ({ changed: true }),
      },
      profileContext: { dir: root, home: 'C:/fake' },
    }
    const g = new PluginGuard(ctx, DEFAULT_CONFIG)
    const { token } = await g.evaluate(['@yuri/risky'], true)
    const denied = await g.cleanup(token, ['@yuri/risky'], false)
    assert.equal(denied.ok, false)
    assert.ok(denied.message.includes('acknowledgeHighRisk'))
    // 令牌未被消费（闸门在消费前），可再次用确认参数
    const allowed = await g.cleanup(token, ['@yuri/risky'], true)
    assert.equal(allowed.ok, true)
  } finally {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* noop */ }
  }
})
