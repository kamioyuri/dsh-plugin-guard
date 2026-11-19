/**
 * 共享契约层（纯函数，无 Node 内置模块，无副作用）。
 * Node 端（guard/tools）、浏览器端（client）、测试三方共用。
 * 职责：定义数据模型 + 钉死"数据怎么算"（风险判定 / 依赖图 / 摘要 / meta 解析）。
 */

export const PLUGIN_ID = 'plugin-guard'

/** dsh 内置核心模块保护名单（同步自 dsh-plugin-manager/lib/index.js 的 protectedModules）。
 *  这些模块承载管理工具、Loader、API 网关等核心能力，删除会直接导致 dsh 崩溃。 */
export const PROTECTED_MODULES: readonly string[] = [
  '@deepseek-ai/dsh-plugin-manager',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/cordis-plugin-include',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
  '@deepseek-ai/dsh-client-ui-plugin-manager',
  '@deepseek-ai/dsh-host-plugin-inventory',
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-api-remote-access',
  '@deepseek-ai/cordis-plugin-timer',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-host-frontend-static',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-hmr',
]

/** 官方 profile 模板栈 —— 即使未被 protectedModules 命中，也属于"核心功能提供者"。 */
export const CORE_STACK: readonly string[] = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-acp-app',
  '@deepseek-ai/dsh-sdk-app',
  '@deepseek-ai/dsh-sdk-minimal',
]

export type RiskLevel = 'ok' | 'warn' | 'block'
export type PluginScope = 'protected' | 'core' | 'optional' | 'third-party' | 'unknown'

export interface DependEdge {
  from: string
  to: string
  kind: 'package' | 'peer' | 'service'
}

export interface PluginNode {
  /** patchId / entryId（可为空） */
  id: string | null
  /** 模块名 / 包名，例如 @scope/pkg */
  name: string
  /** 所属 bundle；非 bundle 级则等于 name 或 null */
  bundle: string | null
  enabled: boolean
  removable: boolean
  fiberPhase: string | null
  started: boolean
  dependencies: string[]
  dependents: string[]
  readOnlyReason: string | null
  official: boolean
  optional: boolean
  hasError: boolean
}

export interface DependentRef {
  name: string
  kind: DependEdge['kind']
  enabled: boolean
  protected: boolean
}

export interface CleanupPlan {
  /** 需要走官方 removeBundle 的 bundle 名 */
  bundles: string[]
  /** 需要清理的模块/包名 */
  modules: string[]
  /** 计划清理的注册/配置条目描述（profile patch override、compatibility、workspace 授权等） */
  configEntries: string[]
  /** 计划清理的缓存相对路径（在 DSH_HOME/cache 下） */
  cachePaths: string[]
  /** 计划清理的残留文件相对路径（在 profile 目录下） */
  residualPaths: string[]
  /** 明确不自动删除、需要用户知情的高优先级条目（如 home 级 patch） */
  skipped: string[]
}

export interface TargetAssessment {
  name: string
  scope: PluginScope
  risk: RiskLevel
  verdict: 'pass' | 'block'
  reasons: string[]
  blockers: string[]
  dependents: DependentRef[]
  running: boolean
  plan: CleanupPlan
  /** 恶意行为扫描结果（联动；可选，仅在带扫描的评估中填充）。 */
  scan?: PluginScanResult
  /** 扫描命中高风险，删除时需额外二次确认。 */
  requiresExtraConfirm?: boolean
}

export interface AssessmentReport {
  /** 供 cleanup 校验的状态摘要（对目标节点关键字段 + 依赖边计算） */
  digest: string
  targets: TargetAssessment[]
  pass: boolean
  createdAt: number
}

/** 浏览器端渲染用的投影 meta。 */
export interface GuardMeta {
  kind: 'plugin-guard-list' | 'plugin-guard-evaluate' | 'plugin-guard-cleanup' | 'plugin-guard-scan' | 'plugin-guard-menu'
  rows: Record<string, unknown>[]
  summary: string
  pass?: boolean
}

// ---------------------------------------------------------------------------
// 纯函数工具
// ---------------------------------------------------------------------------

/** 判断一个模块名是否命中核心保护名单 / 核心栈。 */
export function isProtectedModule(name: string): boolean {
  if (PROTECTED_MODULES.includes(name)) return true
  if (CORE_STACK.includes(name)) return true
  return false
}

/** 规范化依赖边：去重、排序，保证摘要稳定。 */
export function normalizeEdges(edges: DependEdge[]): DependEdge[] {
  const seen = new Set<string>()
  const out: DependEdge[] = []
  for (const e of edges) {
    const key = `${e.from}\u0000${e.to}\u0000${e.kind}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ from: e.from, to: e.to, kind: e.kind })
  }
  return out.sort((a, b) => (a.from + a.to + a.kind).localeCompare(b.from + b.to + b.kind))
}

/** 稳定序列化（键排序），用于摘要与令牌绑定。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

/** FNV-1a 32 位哈希（非安全用途，仅用于生成稳定的状态摘要；安全由令牌随机性保证）。 */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5 >>> 0
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * 计算评估状态摘要。只对"会影响删除安全结论"的字段取摘要：
 * 目标节点的关键属性 + 全部依赖边。评估时与 cleanup 时各算一次，
 * 若不一致说明环境已变化（TOCTOU），必须中止。
 */
export function assessmentDigest(
  targets: string[],
  nodes: PluginNode[],
  edges: DependEdge[],
): string {
  const keyNodes = nodes
    .filter((n) => targets.includes(n.name))
    .map((n) => ({
      name: n.name,
      bundle: n.bundle,
      enabled: n.enabled,
      removable: n.removable,
      readOnlyReason: n.readOnlyReason,
      official: n.official,
      optional: n.optional,
      started: n.started,
      fiberPhase: n.fiberPhase,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const payload = stableStringify({
    targets: [...targets].sort(),
    nodes: keyNodes,
    edges: normalizeEdges(edges).filter((e) => targets.includes(e.from) || targets.includes(e.to)),
  })
  return fnv1a(payload)
}

// ---------------------------------------------------------------------------
// 依赖图
// ---------------------------------------------------------------------------

/** 判断目标是否被某个"受保护的启用方"依赖 —— 这是删除会引发核心异常的最强信号。 */
export function protectedDependent(
  target: string,
  edges: DependEdge[],
  nodes: PluginNode[],
): string | null {
  const nodeByName = new Map(nodes.map((n) => [n.name, n]))
  for (const e of edges) {
    if (e.to !== target) continue
    const dep = nodeByName.get(e.from)
    if (!dep) continue
    if (isProtectedModule(dep.name) || dep.optional || dep.official) {
      if (dep.enabled) return dep.name
    }
  }
  return null
}

/** 汇总目标的依赖方（谁依赖它），带保护/启用标记，供评估展示。 */
export function dependentsOf(
  target: string,
  edges: DependEdge[],
  nodes: PluginNode[],
): DependentRef[] {
  const nodeByName = new Map(nodes.map((n) => [n.name, n]))
  const refs: DependentRef[] = []
  for (const e of edges) {
    if (e.to !== target) continue
    const dep = nodeByName.get(e.from)
    refs.push({
      name: e.from,
      kind: e.kind,
      enabled: dep?.enabled ?? false,
      protected: isProtectedModule(e.from) || dep?.optional === true,
    })
  }
  return refs.sort((a, b) => a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------------------
// 风险判定（核心契约）
// ---------------------------------------------------------------------------

export interface AssessInput {
  name: string
  node: PluginNode | undefined
  edges: DependEdge[]
  nodes: PluginNode[]
  /** 与缓存路径前缀匹配的相对路径（由 Node 端扫描后传入） */
  cachePaths: string[]
  /** 与插件相关的残留配置/注册条目描述 */
  configEntries: string[]
  residualPaths: string[]
  skipped: string[]
}

/**
 * 单个目标的评估。判定优先级（从硬到软）：
 *  1. 目标不存在                        -> block
 *  2. 命中核心保护名单 / 只读管理名      -> block
 *  3. 不可卸载（removable=false）        -> block
 *  4. 被受保护的启用方依赖              -> block
 *  5. 被其它启用方依赖 / 正在运行        -> warn（可继续但需知情确认）
 *  6. 其它                              -> ok
 */
export function assessTarget(input: AssessInput): TargetAssessment {
  const { name, node, edges, nodes } = input
  const reasons: string[] = []
  const blockers: string[] = []
  const dependents = node ? dependentsOf(name, edges, nodes) : []

  if (!node) {
    return {
      name,
      scope: 'unknown',
      risk: 'block',
      verdict: 'block',
      reasons: ['未找到该插件，可能名称不正确或已被卸载。'],
      blockers: ['target-not-found'],
      dependents: [],
      running: false,
      plan: emptyPlan(name),
    }
  }

  const protectedHit = isProtectedModule(name) || node.readOnlyReason === 'management-required'
  let scope: PluginScope
  if (protectedHit) scope = 'protected'
  else if (node.official && node.optional) scope = 'optional'
  else if (node.official) scope = 'core'
  else if (node.name.startsWith('@deepseek-ai/')) scope = 'core'
  else scope = 'third-party'

  if (protectedHit) {
    blockers.push('protected-module')
    reasons.push('该插件属于 dsh 核心/管理模块，删除会导致 dsh 崩溃或核心功能失效。')
  }
  if (node.readOnlyReason === 'management-required') {
    if (!blockers.includes('protected-module')) blockers.push('management-required')
    if (!reasons.some((r) => r.includes('只读'))) reasons.push('该插件由 dsh 管理器标记为只读，禁止通过清理工具删除。')
  }
  if (!node.removable && !protectedHit) {
    blockers.push('not-removable')
    reasons.push('dsh 判定该插件不可卸载（可能为内置或安装型 bundle）。')
  }

  const hardDep = protectedDependent(name, edges, nodes)
  if (hardDep) {
    blockers.push('required-by-core')
    reasons.push(`仍被核心/受保护插件「${hardDep}」依赖，删除会引发核心功能异常。`)
  }

  const activeDependents = dependents.filter((d) => d.enabled && !d.protected)
  if (activeDependents.length > 0 && blockers.length === 0) {
    reasons.push(`被 ${activeDependents.length} 个启用中的插件依赖：${activeDependents.map((d) => d.name).join('、')}。删除后这些插件将失去依赖。`)
  }

  const running = node.started || (node.fiberPhase !== null && node.fiberPhase !== 'disposed')
  if (running && blockers.length === 0) {
    reasons.push('该插件当前处于运行/已加载状态，清理后通常需要重启 dsh 才会完全生效。')
  }

  if (node.hasError && blockers.length === 0) {
    reasons.push('该插件当前存在加载错误，清理时需一并移除其错误配置残留。')
  }

  let risk: RiskLevel
  if (blockers.length > 0) risk = 'block'
  else if (activeDependents.length > 0 || running) risk = 'warn'
  else risk = 'ok'

  if (blockers.length === 0 && reasons.length === 0) {
    reasons.push('未发现核心依赖冲突；该插件可被安全清理。')
  }

  return {
    name,
    scope,
    risk,
    verdict: blockers.length > 0 ? 'block' : 'pass',
    reasons,
    blockers,
    dependents,
    running,
    plan: {
      bundles: node.bundle ? [node.bundle] : [],
      modules: [node.name],
      configEntries: input.configEntries,
      cachePaths: input.cachePaths,
      residualPaths: input.residualPaths,
      skipped: input.skipped,
    },
  }
}

function emptyPlan(name: string): CleanupPlan {
  return { bundles: [], modules: [name], configEntries: [], cachePaths: [], residualPaths: [], skipped: [] }
}

/** 汇总报告是否全部通过。 */
export function allPass(report: AssessmentReport): boolean {
  return report.pass && report.targets.length > 0 && report.targets.every((t) => t.verdict === 'pass')
}

// ---------------------------------------------------------------------------
// meta 解析（浏览器端使用）
// ---------------------------------------------------------------------------

export function guardMetaFrom(meta: unknown): GuardMeta | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const m = meta as Record<string, unknown>
  if (m.kind !== 'plugin-guard-list' && m.kind !== 'plugin-guard-evaluate' &&
      m.kind !== 'plugin-guard-cleanup' && m.kind !== 'plugin-guard-scan' && m.kind !== 'plugin-guard-menu') {
    return undefined
  }
  return {
    kind: m.kind,
    rows: Array.isArray(m.rows) ? (m.rows as Record<string, unknown>[]) : [],
    summary: typeof m.summary === 'string' ? m.summary : '',
    pass: typeof m.pass === 'boolean' ? m.pass : undefined,
  }
}

// ---------------------------------------------------------------------------
// 恶意行为静态扫描契约（纯函数；启发式特征匹配，非安全定论）
// ---------------------------------------------------------------------------

/** 可疑行为类别。 */
export type RiskCategory =
  | 'dynamic-code'      // eval / new Function / vm
  | 'child-process'     // exec / spawn / shell
  | 'network-egress'    // fetch / http / https / socket 外联
  | 'credential-access' // 读取凭据/密钥/token
  | 'core-tamper'       // 篡改 cordis.patch / package.json / node_modules
  | 'fs-destructive'    // 递归删除 / 越权写
  | 'obfuscation'       // 长 base64 / 十六进制串 / atob
  | 'env-harvest'       // 批量读取环境变量

export type RiskSeverity = 'high' | 'medium' | 'low'

export interface ScanRule {
  id: string
  category: RiskCategory
  severity: RiskSeverity
  /** 用于匹配的正则（对源码文本）。 */
  pattern: RegExp
  /** 人类可读说明。 */
  label: string
}

export interface ScanHit {
  ruleId: string
  category: RiskCategory
  severity: RiskSeverity
  label: string
  /** 命中的行号（1 起）。 */
  line: number
  /** 命中的源码片段（截断）。 */
  excerpt: string
}

export interface PluginScanResult {
  name: string
  /** 风险等级：由命中项的最高级别决定。 */
  level: 'clean' | 'low' | 'medium' | 'high' | 'error'
  categories: RiskCategory[]
  hits: ScanHit[]
  /** 扫描结果摘要（一句话）。 */
  summary: string
  /** 扫描文件数。 */
  filesScanned: number
  /** 扫描异常信息（如目录不可读）。 */
  error?: string
}

/**
 * 检测规则表。刻意保持"宽粒度、低误报承诺"：
 * 命中只表示"存在该特征"，是否恶意需人工判断。
 * 使用字符串形式存储 pattern 以便跨端安全序列化，运行时编译。
 */
export const SCAN_RULES: ReadonlyArray<{ id: string; category: RiskCategory; severity: RiskSeverity; source: string; flags: string; label: string }> = [
  { id: 'eval', category: 'dynamic-code', severity: 'high', source: '\\beval\\s*\\(', flags: 'g', label: '使用 eval 动态执行代码' },
  { id: 'new-func', category: 'dynamic-code', severity: 'high', source: 'new\\s+Function\\s*\\(', flags: 'g', label: '使用 new Function 动态构造代码' },
  { id: 'vm-run', category: 'dynamic-code', severity: 'medium', source: '\\bvm\\.(runIn|compileFunction|Script)', flags: 'g', label: '使用 vm 沙箱执行代码' },
  { id: 'child-exec', category: 'child-process', severity: 'high', source: '\\b(exec|execSync|spawn|spawnSync|fork)\\s*\\(', flags: 'g', label: '调用子进程执行命令' },
  { id: 'shell-true', category: 'child-process', severity: 'high', source: 'shell\\s*:\\s*true', flags: 'g', label: '以 shell 方式执行命令' },
  { id: 'fetch-egress', category: 'network-egress', severity: 'medium', source: '\\bfetch\\s*\\(\\s*["\'`]https?://', flags: 'g', label: '向外部 URL 发起网络请求' },
  { id: 'http-request', category: 'network-egress', severity: 'medium', source: '\\b(https?|net)\\.(request|get|connect)\\s*\\(', flags: 'g', label: '发起 HTTP/Socket 外联' },
  { id: 'credential-file', category: 'credential-access', severity: 'high', source: '\\.credentials|credentials\\.ya?ml|id_rsa|\\.ssh[\\\\/]', flags: 'gi', label: '访问凭据或私钥文件' },
  { id: 'secret-env', category: 'credential-access', severity: 'medium', source: 'process\\.env\\.[A-Z_]*(TOKEN|SECRET|KEY|PASSWORD)', flags: 'g', label: '读取密钥类环境变量' },
  { id: 'core-patch', category: 'core-tamper', severity: 'high', source: 'cordis\\.patch\\.ya?ml', flags: 'gi', label: '引用/改写 dsh 核心 patch 配置' },
  { id: 'node-modules-write', category: 'core-tamper', severity: 'medium', source: 'node_modules[\\\\/]', flags: 'g', label: '直接操作 node_modules 目录' },
  { id: 'rm-recursive', category: 'fs-destructive', severity: 'high', source: '\\brm\\s*\\([^)]*recursive\\s*:\\s*true', flags: 'g', label: '递归删除目录' },
  { id: 'atob', category: 'obfuscation', severity: 'medium', source: '\\batob\\s*\\(', flags: 'g', label: '使用 atob 解码（常见于混淆载荷）' },
  { id: 'long-b64', category: 'obfuscation', severity: 'low', source: '[A-Za-z0-9+/]{120,}={0,2}', flags: 'g', label: '出现超长 base64 字符串' },
  { id: 'env-harvest', category: 'env-harvest', severity: 'medium', source: 'Object\\.keys\\s*\\(\\s*process\\.env', flags: 'g', label: '枚举全部环境变量' },
]

/** 编译规则表（每次调用现编译，避免模块级 RegExp 的 lastIndex 状态污染）。 */
function compileRules(): ScanRule[] {
  return SCAN_RULES.map((r) => ({
    id: r.id, category: r.category, severity: r.severity, label: r.label,
    pattern: new RegExp(r.source, r.flags.includes('g') ? r.flags : r.flags + 'g'),
  }))
}

const SEVERITY_RANK: Record<RiskSeverity, number> = { low: 1, medium: 2, high: 3 }

/** 对单段文本运行所有规则，返回命中项（每规则每文件最多记录 3 处，避免爆炸）。 */
export function analyzeText(text: string, maxPerRule = 3): ScanHit[] {
  const hits: ScanHit[] = []
  const lines = text.split(/\r?\n/)
  for (const rule of compileRules()) {
    rule.pattern.lastIndex = 0
    let match: RegExpExecArray | null
    let count = 0
    while ((match = rule.pattern.exec(text)) !== null && count < maxPerRule) {
      const before = text.slice(0, match.index)
      const line = before.split('\n').length
      const raw = lines[line - 1] ?? ''
      hits.push({
        ruleId: rule.id,
        category: rule.category,
        severity: rule.severity,
        label: rule.label,
        line,
        excerpt: raw.trim().slice(0, 160),
      })
      count++
      if (match[0].length === 0) rule.pattern.lastIndex++
    }
  }
  return hits
}

/** 由命中项推导整体风险等级。 */
export function scanLevelOf(hits: ScanHit[]): PluginScanResult['level'] {
  if (hits.length === 0) return 'clean'
  if (hits.some((h) => h.severity === 'high')) return 'high'
  if (hits.some((h) => h.severity === 'medium')) return 'medium'
  return 'low'
}

/** 去重分类列表。 */
export function categoriesOf(hits: ScanHit[]): RiskCategory[] {
  return [...new Set(hits.map((h) => h.category))].sort()
}

/** 生成扫描摘要（不含具体行内容，避免泄露敏感串）。 */
export function summarizeScan(name: string, hits: ScanHit[], filesScanned: number, error?: string): string {
  if (error) return `${name}: 扫描异常（${error}），结果不完整。`
  const level = scanLevelOf(hits)
  if (level === 'clean') return `${name}: 扫描 ${filesScanned} 个文件，未发现可疑特征。`
  const cats = categoriesOf(hits)
  const label: Record<PluginScanResult['level'], string> = {
    clean: '干净', low: '低风险', medium: '中风险', high: '高风险', error: '异常',
  }
  return `${name}: 扫描 ${filesScanned} 个文件，发现 ${hits.length} 处可疑特征（${label[level]}），类别：${cats.join('、')}。仅为静态启发式提示，非恶意定论。`
}

/** 扫描命中是否达到"高风险"——用于与删除流程联动（需额外二次确认）。 */
export function isHighRisk(result: PluginScanResult): boolean {
  return result.level === 'high'
}

/** 设置菜单：判断一个 BundleInfo 是否应出现在"可删除插件"列表。
 *  隐藏核心/只读/不可删项；dsh-tui 这类第三方 bundle（含未启用的）会保留。 */
export function isRemovableBundle(b: unknown): boolean {
  if (!isListableBundle(b)) return false
  const x = b as Record<string, unknown>
  if (x.removable === false) return false
  if (typeof x.readOnlyReason === 'string' && x.readOnlyReason !== '') return false
  return true
}

/** 设置菜单"搜索已安装插件"用：只要是具名、非核心保护的已安装 bundle 就列出，
 *  不因 removable=false 而隐藏（这类项显示但删除按钮禁用，并给出原因）。
 *  这样 @deepseek-harness-tui/dsh-tui 等一定会出现在搜索结果中。 */
export function isListableBundle(b: unknown): boolean {
  if (typeof b !== 'object' || b === null) return false
  const x = b as Record<string, unknown>
  if (typeof x.name !== 'string' || x.name === '') return false
  if (isProtectedModule(x.name)) return false
  return true
}

/** 按关键字过滤插件名（大小写不敏感）。 */
export function filterByName(names: string[], query: string): string[] {
  const q = query.trim().toLowerCase()
  if (q === '') return names
  return names.filter((n) => n.toLowerCase().includes(q))
}
