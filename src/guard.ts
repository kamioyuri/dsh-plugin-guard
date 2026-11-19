/**
 * 插件安全审计与清理的核心服务层（Node 端）。
 *
 * 设计原则（来自对 dsh 真实源码的调研）：
 *  1. 枚举 / 卸载优先复用官方 ctx.pluginManager 服务，不自行 rm -rf node_modules。
 *  2. 核心保护名单 + 只读标记 + 核心栈，任一命中即拒绝删除。
 *  3. 依赖关系无公开 API，自行读 bundle package.json 的 dependencies/peerDependencies 建图。
 *  4. 评估签发令牌（绑定状态摘要），cleanup 时重算摘要校验，防 TOCTOU 与重放。
 *  5. 卸载走官方 removeBundle；官方遗漏的 patch override / compatibility / workspace 授权 /
 *     缓存 / 旧投影由本层做"后置清扫"，改配置文件前先备份。
 */
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, readdir, rm, copyFile, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import {
  assessmentDigest,
  assessTarget,
  dependentsOf,
  isProtectedModule,
  normalizeEdges,
  analyzeText,
  scanLevelOf,
  categoriesOf,
  summarizeScan,
  isHighRisk,
  type AssessmentReport,
  type CleanupPlan,
  type DependEdge,
  type PluginNode,
  type TargetAssessment,
  type PluginScanResult,
  type ScanHit,
} from './fragment.ts'

/** 本插件自身 —— 永不删除，否则审计能力自我解除。 */
const SELF_PROTECT = new Set<string>(['@yuri/dsh-plugin-guard', 'plugin-guard'])

export interface GuardConfig {
  /** 评估令牌有效期（毫秒），默认 5 分钟。 */
  tokenTtlMs: number
  /** 缓存清扫的保守阈值：目录/文件名包含的目标短名长度至少为该值，默认 5。 */
  cacheMatchMinLength: number
  /** 是否执行缓存清扫（默认 true）。 */
  sweepCache: boolean
  /** 是否在修改 profile 配置文件前生成 .bak（默认 true）。 */
  backupBeforeWrite: boolean
  /** 恶意扫描：每个插件最多扫描的文件数（默认 200）。 */
  scanMaxFiles: number
  /** 恶意扫描：单个文件最大字节数，超过则跳过（默认 512KB）。 */
  scanMaxFileBytes: number
}

export const DEFAULT_CONFIG: GuardConfig = {
  tokenTtlMs: 5 * 60 * 1000,
  cacheMatchMinLength: 5,
  sweepCache: true,
  backupBeforeWrite: true,
  scanMaxFiles: 200,
  scanMaxFileBytes: 512 * 1024,
}

interface AssessmentToken {
  id: string
  digest: string
  targets: string[]
  createdAt: number
  consumed: boolean
  /** 扫描命中高风险、需额外二次确认的目标。 */
  highRiskTargets: string[]
}

export interface CleanupStep {
  target: string
  ok: boolean
  phases: string[]
  errors: string[]
  warnings: string[]
}

export interface ListRow {
  name: string
  bundle: string | null
  enabled: boolean
  removable: boolean
  protected: boolean
  scope: string
  running: boolean
  dependencies: string[]
  dependents: string[]
  readOnlyReason: string | null
  status: string
}

// 宽松的服务形状：不依赖 dsh 内部类型声明，便于在未安装 node_modules 时也能类型检查。
type AnyCtx = {
  pluginManager?: {
    listPlugins(): Promise<Array<Record<string, any>>>
    listBundles(): Promise<Array<Record<string, any>>>
    removeBundle(name: string): Promise<Record<string, any>>
    setPluginEnabled?(id: any, enabled: boolean): Promise<Record<string, any>>
  }
  profileContext?: {
    dir?: string
    home?: string
    installAnchor?: string
    startedBundles?: string[]
  }
  [key: string]: any
}

function toShortName(pkg: string): string {
  return pkg.startsWith('@') ? (pkg.split('/')[1] ?? pkg) : pkg
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 简易串行锁：避免与 dsh 自带 manager 及并发 cleanup 竞争写同一 profile 文件。 */
class Mutex {
  private tail: Promise<void> = Promise.resolve()
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail
    let release!: () => void
    this.tail = new Promise<void>((r) => { release = r })
    await prev
    try { return await fn() } finally { release() }
  }
}

export class PluginGuard {
  private ctx: AnyCtx
  private config: GuardConfig
  private tokens = new Map<string, AssessmentToken>()
  private mutex = new Mutex()

  constructor(ctx: AnyCtx, config: Partial<GuardConfig> = {}) {
    this.ctx = ctx
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /** 插件管理器服务是否可用。 */
  managerAvailable(): boolean {
    return typeof this.ctx.pluginManager?.listBundles === 'function'
  }

  private dshHome(): string {
    const explicit = process.env.DSH_HOME
    if (explicit && explicit.trim() !== '') return resolve(explicit)
    return join(homedir(), '.dsh')
  }

  private profileDir(): string {
    return this.ctx.profileContext?.dir || join(this.dshHome(), 'profiles', 'web')
  }

  /**
   * 枚举插件与 bundle，构建节点与依赖边。
   * 任何一步失败都降级为可用的子集，绝不因单个插件读取失败而整体崩溃。
   */
  async scan(): Promise<{ nodes: PluginNode[]; edges: DependEdge[]; warnings: string[] }> {
    const warnings: string[] = []
    if (!this.managerAvailable()) {
      throw new Error(
        '插件管理不可用：未检测到 ctx.pluginManager 服务。请在包含 dsh-plugin-manager 的 profile（如 web/headless）中运行本插件。',
      )
    }

    let bundles: Array<Record<string, any>> = []
    let plugins: Array<Record<string, any>> = []
    try { bundles = await this.ctx.pluginManager!.listBundles() } catch (e) { warnings.push(`listBundles 失败：${errMsg(e)}`) }
    try { plugins = await this.ctx.pluginManager!.listPlugins() } catch (e) { warnings.push(`listPlugins 失败：${errMsg(e)}`) }

    const started = new Set<string>(this.ctx.profileContext?.startedBundles ?? [])
    const pluginByName = new Map<string, Record<string, any>>()
    for (const p of plugins) {
      const n = String(p.moduleName ?? p.name ?? '')
      if (n) pluginByName.set(n, p)
    }

    const nodes: PluginNode[] = []
    for (const b of bundles) {
      const name = String(b.name ?? '')
      if (!name) continue
      const rows: Array<Record<string, any>> = Array.isArray(b.rows) ? b.rows : []
      const firstModule = rows.find((r) => r && r.moduleName)?.moduleName ?? name
      const nodeInfo = pluginByName.get(name) ?? pluginByName.get(String(firstModule))
      const fiberPhase = nodeInfo?.fiberPhase ?? null
      nodes.push({
        id: nodeInfo?.patchId ?? nodeInfo?.entryId ?? null,
        name,
        bundle: name,
        enabled: Boolean(nodeInfo?.enabled ?? b.enabled),
        removable: b.removable !== false,
        fiberPhase: fiberPhase as string | null,
        started: started.has(name) || (fiberPhase !== null && fiberPhase !== 'disposed' && fiberPhase !== 'stopped'),
        dependencies: [],
        dependents: [],
        readOnlyReason: nodeInfo?.readOnlyReason ?? b.readOnlyReason ?? null,
        official: Boolean(b.official),
        optional: Boolean(b.optional),
        hasError: b.error !== undefined && b.error !== null,
      })
    }

    // 依赖边：读每个 bundle 的 package.json 的 dependencies / peerDependencies。
    const nameSet = new Set(nodes.map((n) => n.name))
    const edges: DependEdge[] = []
    const profile = this.profileDir()
    for (const node of nodes) {
      const deps = await this.readDependencyNames(node.name, profile)
      node.dependencies = deps
      for (const dep of deps) {
        if (!nameSet.has(dep)) continue // 外部 npm 依赖不是插件间依赖
        edges.push({ from: node.name, to: dep, kind: 'package' })
      }
    }
    for (const node of nodes) {
      node.dependents = dependentsOf(node.name, edges, nodes).map((d) => d.name)
    }

    return { nodes, edges: normalizeEdges(edges), warnings }
  }

  /** 读取某个 bundle 包的 package.json 依赖名。 */
  private async readDependencyNames(bundleName: string, profileDir: string): Promise<string[]> {
    const candidates = [
      join(profileDir, 'node_modules', ...bundleName.split('/')),
      this.ctx.profileContext?.installAnchor
        ? join(this.ctx.profileContext.installAnchor, 'node_modules', ...bundleName.split('/'))
        : '',
    ].filter(Boolean)
    for (const dir of candidates) {
      try {
        const raw = await readFile(join(dir, 'package.json'), 'utf8')
        const pkg = JSON.parse(raw)
        const deps = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) }
        return Object.keys(deps)
      } catch { /* 尝试下一个候选路径 */ }
    }
    return []
  }

  /** 解析插件包目录（与 readDependencyNames 同一套锚点）。 */
  private async pluginDir(name: string): Promise<string | null> {
    const profile = this.profileDir()
    const candidates = [
      join(profile, 'node_modules', ...name.split('/')),
      this.ctx.profileContext?.installAnchor
        ? join(this.ctx.profileContext.installAnchor, 'node_modules', ...name.split('/'))
        : '',
    ].filter(Boolean)
    for (const dir of candidates) {
      try { await stat(dir); return dir } catch { /* 下一个 */ }
    }
    return null
  }

  /**
   * 恶意行为静态扫描（只读）。扫描目标插件包内的源码/配置文件，
   * 用纯函数契约 analyzeText 匹配可疑特征，按风险类型分级输出摘要。
   * 边界：目录不可读/文件过大均降级处理，单个插件异常不影响其它插件与整体扫描。
   */
  async scanPlugins(targets?: string[]): Promise<PluginScanResult[]> {
    const { nodes } = await this.scan()
    let names: string[]
    if (targets && targets.length > 0) {
      names = targets.filter((t) => typeof t === 'string' && t.trim() !== '')
    } else {
      names = nodes.map((n) => n.name)
    }

    const results: PluginScanResult[] = []
    for (const name of [...new Set(names)]) {
      results.push(await this.scanOnePlugin(name))
    }
    return results
  }

  /** 扫描单个插件。 */
  private async scanOnePlugin(name: string): Promise<PluginScanResult> {
    const dir = await this.pluginDir(name)
    if (!dir) {
      return {
        name, level: 'error', categories: [], hits: [], filesScanned: 0,
        summary: summarizeScan(name, [], 0, '未找到插件目录（可能是内置模块或名称不匹配）'),
        error: 'plugin-directory-not-found',
      }
    }

    const EXT_OK = /\.(js|cjs|mjs|ts|tsx|jsx|json|ya?ml|md|sh|ps1)$/i
    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'cache'])
    const hits: ScanHit[] = []
    let filesScanned = 0
    let scanError: string | undefined

    try {
      const queue: string[] = [dir]
      while (queue.length > 0 && filesScanned < this.config.scanMaxFiles) {
        const cur = queue.shift()!
        let entries: Dirent[] = []
        try {
          entries = await readdir(cur, { withFileTypes: true })
        } catch (e) {
          scanError = `无法读取目录 ${basename(cur)}：${(e as Error).message}`
          continue
        }
        for (const ent of entries) {
          if (filesScanned >= this.config.scanMaxFiles) break
          const full = join(cur, ent.name)
          if (ent.isDirectory()) {
            if (!SKIP_DIRS.has(ent.name)) queue.push(full)
            continue
          }
          if (!ent.isFile() || !EXT_OK.test(ent.name)) continue
          try {
            const st = await stat(full)
            if (st.size > this.config.scanMaxFileBytes) continue
            const text = await readFile(full, 'utf8')
            filesScanned++
            const rel = full.slice(dir.length + 1)
            for (const h of analyzeText(text)) hits.push({ ...h, excerpt: `[${rel}:${h.line}] ${h.excerpt}` })
          } catch {
            // 单文件读取失败跳过，不影响整体。
          }
        }
      }
    } catch (e) {
      scanError = `扫描中断：${(e as Error).message}`
    }

    return {
      name,
      level: scanError && hits.length === 0 ? 'error' : scanLevelOf(hits),
      categories: categoriesOf(hits),
      hits,
      filesScanned,
      summary: summarizeScan(name, hits, filesScanned, scanError),
      ...(scanError ? { error: scanError } : {}),
    }
  }

  /** 查询某插件是否被扫描判为高风险（供删除联动；未扫描过返回 false）。 */
  isHighRiskScanned(result: PluginScanResult | undefined): boolean {
    return result !== undefined && isHighRisk(result)
  }

  /**
   * 通过 dsh 原生 userQuestions 通道向用户发起选择菜单（浏览器端渲染可点击选项）。
   * 返回用户选择的 label 列表；任何异常（无 answerer / 无 agent / 超时 / 取消）都返回空数组，
   * 由调用方优雅降级，不抛出。
   */
  async askUser(questions: Array<{
    id: string
    question: string
    detail?: string
    header?: string
    options?: Array<{ label: string; description?: string }>
    multiSelect?: boolean
  }>, exec?: { agent?: unknown; signal?: AbortSignal }): Promise<Record<string, string[]>> {
    const uq = this.ctx.userQuestions
    if (!uq || typeof uq.ask !== 'function') return {}
    try {
      const answer = await uq.ask({
        questions: questions.map((q) => ({
          id: q.id,
          question: q.question,
          ...(q.detail !== undefined ? { detail: q.detail } : {}),
          ...(q.header !== undefined ? { header: q.header } : {}),
          ...(q.options !== undefined ? { options: q.options } : {}),
          ...(q.multiSelect !== undefined ? { multiSelect: q.multiSelect } : {}),
        })),
        ...(exec?.agent !== undefined ? { agent: exec.agent as any } : {}),
        ...(exec?.signal !== undefined ? { signal: exec.signal } : {}),
      })
      const out: Record<string, string[]> = {}
      for (const a of answer?.answers ?? []) out[a.id] = [...(a.selected ?? [])]
      return out
    } catch {
      return {}
    }
  }

  /** 列出插件（供 plugin_guard_list）。 */
  async list(filter: { query?: string; status?: string } = {}): Promise<{ rows: ListRow[]; warnings: string[] }> {
    const { nodes, edges, warnings } = await this.scan()
    const q = (filter.query ?? '').trim().toLowerCase()
    const status = filter.status ?? 'all'

    const rows: ListRow[] = []
    for (const n of nodes) {
      if (q && !n.name.toLowerCase().includes(q) && !(n.bundle ?? '').toLowerCase().includes(q)) continue
      const protectedHit = isProtectedModule(n.name) || SELF_PROTECT.has(n.name) || n.readOnlyReason === 'management-required'
      let scope: string
      if (protectedHit) scope = 'protected'
      else if (n.official && n.optional) scope = 'optional'
      else if (n.official || n.name.startsWith('@deepseek-ai/')) scope = 'core'
      else scope = 'third-party'

      const statusKey = protectedHit ? 'protected' : n.enabled ? 'enabled' : 'disabled'
      if (status === 'removable' && (protectedHit || !n.removable)) continue
      if (status === 'core' && scope !== 'core' && scope !== 'protected') continue
      if (status === 'enabled' && !n.enabled) continue
      if (status === 'disabled' && n.enabled) continue

      rows.push({
        name: n.name,
        bundle: n.bundle,
        enabled: n.enabled,
        removable: n.removable && !protectedHit,
        protected: protectedHit,
        scope,
        running: n.started,
        dependencies: n.dependencies,
        dependents: dependentsOf(n.name, edges, nodes).map((d) => d.name),
        readOnlyReason: n.readOnlyReason,
        status: statusKey,
      })
    }
    rows.sort((a, b) => a.name.localeCompare(b.name))
    return { rows, warnings }
  }

  /** 评估待删插件（只读，不改任何状态），并签发令牌。
   *  withScan=true 时对目标做恶意行为静态扫描，高风险目标会被要求额外二次确认。 */
  async evaluate(targetNames: string[], withScan = false): Promise<{ report: AssessmentReport; token: string; warnings: string[] }> {
    const targets = [...new Set(targetNames.map((t) => t.trim()).filter(Boolean))]
    if (targets.length === 0) throw new Error('evaluate：targets 不能为空，请指定至少一个待评估插件。')

    const { nodes, edges, warnings } = await this.scan()
    const profile = this.profileDir()
    const assessments: TargetAssessment[] = []
    const highRiskTargets: string[] = []
    // 带扫描时先批量扫描一次（每插件独立容错），供联动使用。
    const scanResults = withScan ? await this.scanPlugins(targets) : []
    const scanByName = new Map(scanResults.map((r) => [r.name, r]))

    for (const name of targets) {
      // 支持按 bundle 名 / 模块名解析；这里 name 即 bundle 名，别名匹配到节点。
      let node = nodes.find((n) => n.name === name)
      if (!node) {
        const alias = nodes.find((n) => (n.id ?? '') === name || toShortName(n.name) === name)
        if (alias) node = alias
      }

      const scan = await this.scanPluginArtifacts(name, node, profile)
      const input = {
        name,
        node,
        edges,
        nodes,
        cachePaths: scan.cachePaths,
        configEntries: scan.configEntries,
        residualPaths: scan.residualPaths,
        skipped: scan.skipped,
      }
      const assessment = assessTarget(input)
      // 本插件自保护：即使从外部传入也强制阻断。
      if (SELF_PROTECT.has(name) && assessment.verdict !== 'block') {
        assessment.verdict = 'block'
        assessment.risk = 'block'
        assessment.blockers.push('self-protect')
        assessment.reasons.push('该插件是"插件守护者"自身，禁止删除以保护审计能力。')
      }

      // 扫描联动：命中高风险特征的插件不阻断删除，但要求额外二次确认。
      const scanResult = scanByName.get(name)
      if (scanResult) {
        assessment.scan = scanResult
        if (isHighRisk(scanResult) && assessment.verdict !== 'block') {
          assessment.requiresExtraConfirm = true
          if (assessment.risk !== 'block') assessment.risk = 'warn'
          assessment.reasons.push(
            `⚠ 恶意行为扫描命中 ${scanResult.hits.length} 处高风险特征（${scanResult.categories.join('、')}），删除时必须额外二次确认。扫描仅为静态启发式提示，非恶意定论。`,
          )
          highRiskTargets.push(name)
        }
      }
      assessments.push(assessment)
    }

    const digest = assessmentDigest(targets, nodes, edges)
    const pass = assessments.every((a) => a.verdict === 'pass')
    const report: AssessmentReport = {
      digest,
      targets: assessments,
      pass,
      createdAt: Date.now(),
    }

    const token = randomUUID()
    this.tokens.set(token, { id: token, digest, targets, createdAt: Date.now(), consumed: false, highRiskTargets })
    // 顺手清理过期令牌。
    this.pruneTokens()
    return { report, token, warnings }
  }

  private pruneTokens(): void {
    const now = Date.now()
    for (const [id, t] of this.tokens) {
      if (now - t.createdAt > this.config.tokenTtlMs) this.tokens.delete(id)
    }
  }

  /**
   * 清理执行。三重校验：令牌存在未消费未过期 + targets 一致 + 重新扫描摘要一致（TOCTOU）。
   * 任一评估结论为 block 直接中止；不通过官方审批时本函数根本不会被工具层调用。
   */
  async cleanup(token: string, targets: string[], acknowledgeHighRisk = false): Promise<{ ok: boolean; steps: CleanupStep[]; message: string }> {
    if (!token || token.trim() === '') {
      return { ok: false, steps: [], message: '缺少评估令牌：请先调用 plugin_guard_evaluate 获取令牌，再执行清理。' }
    }
    this.pruneTokens()
    const record = this.tokens.get(token)
    if (!record) {
      return { ok: false, steps: [], message: '评估令牌无效或已过期：请重新执行评估。' }
    }
    if (record.consumed) {
      return { ok: false, steps: [], message: '该评估令牌已被使用（防重放）：请重新执行评估。' }
    }
    const want = [...new Set(targets.map((t) => t.trim()).filter(Boolean))].sort()
    const got = [...record.targets].sort()
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      return { ok: false, steps: [], message: '清理目标与评估令牌绑定的目标不一致：请重新评估本次目标。' }
    }
    // 扫描联动闸门：命中高风险特征的目标必须显式二次确认。
    const risky = record.highRiskTargets.filter((t) => want.includes(t))
    if (risky.length > 0 && acknowledgeHighRisk !== true) {
      return {
        ok: false,
        steps: [],
        message: `目标 ${risky.join('、')} 在扫描中命中高风险可疑特征，需再次确认：请在清理参数中显式设置 acknowledgeHighRisk=true（确认你已了解静态扫描仅为启发式提示）。未确认前已中止。`,
      }
    }

    return this.mutex.run(async () => {
      // 重新扫描并重算摘要 —— TOCTOU 防护。
      const { nodes, edges } = await this.scan()
      const freshDigest = assessmentDigest(want, nodes, edges)
      if (freshDigest !== record.digest) {
        return {
          ok: false,
          steps: [],
          message: '目标插件状态在评估后发生变化（启用状态/依赖已改变），为防止误删已中止。请重新评估后再清理。',
        }
      }

      const reReport = await this.buildReport(want, nodes, edges)
      const blocked = reReport.targets.filter((t) => t.verdict === 'block')
      if (blocked.length > 0) {
        return {
          ok: false,
          steps: [],
          message: `清理前复核发现 ${blocked.length} 个目标存在阻断风险：${blocked.map((b) => `${b.name}（${b.blockers.join('/')}）`).join('；')}。已中止。`,
        }
      }

      // 校验通过，消费令牌。
      record.consumed = true
      const steps: CleanupStep[] = []
      for (const assessment of reReport.targets) {
        steps.push(await this.cleanupOne(assessment))
      }
      const ok = steps.every((s) => s.ok)
      return {
        ok,
        steps,
        message: ok
          ? `已彻底清理 ${steps.length} 个插件。部分运行态插件需重启 dsh 后才会完全生效。`
          : `清理完成但存在失败项，请查看各目标详情。`,
      }
    })
  }

  /** 基于已扫描的节点/边重建报告（cleanup 复核用，不重复签发令牌）。 */
  private async buildReport(targets: string[], nodes: PluginNode[], edges: DependEdge[]): Promise<AssessmentReport> {
    const profile = this.profileDir()
    const assessments: TargetAssessment[] = []
    for (const name of targets) {
      let node = nodes.find((n) => n.name === name) ?? nodes.find((n) => (n.id ?? '') === name || toShortName(n.name) === name)
      const scan = await this.scanPluginArtifacts(name, node, profile)
      const a = assessTarget({ name, node, edges, nodes, ...scan })
      if (SELF_PROTECT.has(name) && a.verdict !== 'block') {
        a.verdict = 'block'; a.risk = 'block'; a.blockers.push('self-protect')
        a.reasons.push('该插件是插件守护者自身，禁止删除。')
      }
      assessments.push(a)
    }
    return {
      digest: assessmentDigest(targets, nodes, edges),
      targets: assessments,
      pass: assessments.every((a) => a.verdict === 'pass'),
      createdAt: Date.now(),
    }
  }

  /** 扫描某插件在磁盘上的配置/缓存/残留痕迹（只读）。 */
  private async scanPluginArtifacts(
    name: string,
    node: PluginNode | undefined,
    profile: string,
  ): Promise<{ cachePaths: string[]; configEntries: string[]; residualPaths: string[]; skipped: string[] }> {
    const short = toShortName(name)
    const cachePaths: string[] = []
    const configEntries: string[] = []
    const residualPaths: string[] = []
    const skipped: string[] = []

    // 注册/配置条目（描述性，存在才列出）。
    const patchPath = join(profile, 'cordis.patch.yml')
    if (await exists(patchPath)) {
      const txt = await safeRead(patchPath)
      if (txt && (txt.includes(name) || txt.includes(short))) {
        configEntries.push(`cordis.patch.yml 中引用「${name}」的条目`)
      }
    }
    const compatPath = join(profile, 'compatibility.json')
    if (await exists(compatPath)) {
      const txt = await safeRead(compatPath)
      if (txt && (txt.includes(name) || txt.includes(short))) {
        configEntries.push(`compatibility.json 中「${name}」的版本豁免`)
      }
    }
    const wsPath = join(profile, 'pnpm-workspace.yaml')
    if (await exists(wsPath)) {
      const txt = await safeRead(wsPath)
      if (txt && txt.includes(name)) {
        configEntries.push(`pnpm-workspace.yaml 中「${name}」的构建授权`)
      }
    }
    // 旧投影残留。
    const fallback = join(profile, '.dsh-module-fallback')
    if (await exists(fallback)) residualPaths.push('.dsh-module-fallback（旧模块投影，可能关联多个插件）')

    // 缓存：只在 DSH_HOME/cache 下保守匹配。
    if (this.config.sweepCache && short.length >= this.config.cacheMatchMinLength) {
      const cacheRoot = join(this.dshHome(), 'cache')
      try {
        const found = await findMatchingPaths(cacheRoot, short, 30)
        cachePaths.push(...found.map((p) => p.replace(cacheRoot + sep, '')))
      } catch { /* 缓存不存在则跳过 */ }
    }

    // home 级 patch：高优先级，保守跳过并提示。
    const homePatch = join(this.dshHome(), 'cordis.patch.yml')
    if (await exists(homePatch)) {
      const txt = await safeRead(homePatch)
      if (txt && (txt.includes(name) || txt.includes(short))) {
        skipped.push(`~/.dsh/cordis.patch.yml 中「${name}」的引用（home 级配置，优先级高，未自动删除，请手动确认）`)
      }
    }

    return { cachePaths, configEntries, residualPaths, skipped }
  }

  /** 执行单个插件的清理：官方卸载 + 后置清扫。 */
  private async cleanupOne(a: TargetAssessment): Promise<CleanupStep> {
    const step: CleanupStep = { target: a.name, ok: true, phases: [], errors: [], warnings: [...a.reasons.filter((r) => a.risk === 'warn')] }
    const profile = this.profileDir()
    const plan: CleanupPlan = a.plan

    // 阶段 1：官方 removeBundle（持有文件锁、注册表追踪、HMR 串行化）。
    for (const bundle of plan.bundles) {
      try {
        const result = await this.ctx.pluginManager!.removeBundle(bundle)
        if (result && result.error) {
          step.errors.push(`官方卸载 ${bundle} 返回错误：${formatUnknown(result.error)}`)
        } else {
          step.phases.push(`官方卸载 bundle「${bundle}」完成`)
        }
        if (result && result.restartReason) step.warnings.push(`需要重启：${String(result.restartReason)}`)
      } catch (e) {
        step.errors.push(`官方卸载 ${bundle} 失败：${errMsg(e)}`)
      }
    }
    if (plan.bundles.length === 0) {
      step.warnings.push('该插件未关联可卸载的 bundle，已跳过本体卸载，仅执行痕迹清扫。')
    }

    // 阶段 2：后置清扫 —— 逐个配置文件修改前先备份。
    if (a.scope !== 'protected') {
      await this.sweepConfigFiles(a.name, profile, step)
      if (this.config.sweepCache) await this.sweepCache(a.name, plan.cachePaths, step)
    } else {
      step.warnings.push('受保护目标未执行任何文件清扫。')
    }
    for (const s of plan.skipped) step.warnings.push(s)

    step.ok = step.errors.length === 0
    return step
  }

  /** 清扫 profile 内针对目标的配置/注册残留。使用 yaml 库做注释保留的精确删除。 */
  private async sweepConfigFiles(name: string, profile: string, step: CleanupStep): Promise<void> {
    const short = toShortName(name)

    // cordis.patch.yml：删除仅包含目标 id/name 的顶层条目（保留其它 patch）。
    const patchPath = join(profile, 'cordis.patch.yml')
    if (await exists(patchPath)) {
      try {
        const raw = await readFile(patchPath, 'utf8')
        const YAML = await import('yaml')
        const doc = YAML.parseDocument(raw)
        const seq = doc.contents as unknown as { items: any[] }
        if (seq && Array.isArray(seq.items)) {
          const before = seq.items.length
          seq.items = seq.items.filter((item: any) => {
            const text = JSON.stringify(item?.toJSON ? item.toJSON() : item)
            return !(text.includes(`"${name}"`) || text.includes(`"${short}"`))
          })
          if (seq.items.length !== before) {
            await this.writeWithBackup(patchPath, doc.toString())
            step.phases.push(`cordis.patch.yml 移除 ${before - seq.items.length} 条目标条目`)
          }
        }
      } catch (e) { step.errors.push(`清理 cordis.patch.yml 失败：${errMsg(e)}`) }
    }

    // compatibility.json：删除目标包名键。
    const compatPath = join(profile, 'compatibility.json')
    if (await exists(compatPath)) {
      try {
        const raw = await readFile(compatPath, 'utf8')
        const json = JSON.parse(raw)
        let changed = false
        for (const key of Object.keys(json)) {
          if (key === name || key.startsWith(`${name}@`) || key === short) { delete json[key]; changed = true }
        }
        if (changed) {
          await this.writeWithBackup(compatPath, JSON.stringify(json, null, 2) + '\n')
          step.phases.push('compatibility.json 移除目标版本豁免')
        }
      } catch (e) { step.errors.push(`清理 compatibility.json 失败：${errMsg(e)}`) }
    }

    // pnpm-workspace.yaml：删除 allowBuilds 下的目标键。
    const wsPath = join(profile, 'pnpm-workspace.yaml')
    if (await exists(wsPath)) {
      try {
        const raw = await readFile(wsPath, 'utf8')
        const YAML = await import('yaml')
        const doc = YAML.parseDocument(raw)
        const allow = doc.getIn(['allowBuilds']) as any
        let changed = false
        if (allow && typeof allow === 'object' && 'items' in allow) {
          const before = allow.items.length
          allow.items = allow.items.filter((it: any) => {
            const k = String(it?.key ?? '')
            return k !== name && k !== short
          })
          changed = allow.items.length !== before
        }
        if (changed) {
          await this.writeWithBackup(wsPath, doc.toString())
          step.phases.push('pnpm-workspace.yaml 移除目标构建授权')
        }
      } catch (e) { step.errors.push(`清理 pnpm-workspace.yaml 失败：${errMsg(e)}`) }
    }
  }

  private async sweepCache(name: string, cachePaths: string[], step: CleanupStep): Promise<void> {
    const cacheRoot = join(this.dshHome(), 'cache')
    let removed = 0
    for (const rel of cachePaths) {
      // 防目录穿越：只接受 cacheRoot 下的相对路径。
      const abs = resolve(cacheRoot, rel)
      if (!abs.startsWith(cacheRoot + sep)) continue
      try {
        await rm(abs, { recursive: true, force: true })
        removed++
      } catch (e) { step.warnings.push(`缓存清理跳过 ${rel}：${errMsg(e)}`) }
    }
    if (removed > 0) step.phases.push(`清理 ${removed} 处关联缓存（DSH_HOME/cache）`)
  }

  private async writeWithBackup(path: string, content: string): Promise<void> {
    if (this.config.backupBeforeWrite && await exists(path)) {
      try { await copyFile(path, `${path}.bak-${Date.now()}`) } catch { /* 备份失败不阻断，但继续写 */ }
    }
    await writeFile(path, content, 'utf8')
  }
}

// ---------------------------------------------------------------------------
// 文件工具
// ---------------------------------------------------------------------------

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true } catch { return false }
}

async function safeRead(p: string): Promise<string | null> {
  try { return await readFile(p, 'utf8') } catch { return null }
}

/** 递归查找名称包含 needle 的路径（限制数量，保守匹配）。 */
async function findMatchingPaths(root: string, needle: string, limit: number): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (out.length >= limit || depth > 4) return
    let entries: Array<{ name: string; isDirectory(): boolean }> = []
    try { entries = await readdir(dir, { withFileTypes: true }) as any } catch { return }
    for (const e of entries) {
      if (out.length >= limit) break
      const full = join(dir, e.name)
      if (e.name.toLowerCase().includes(needle.toLowerCase())) { out.push(full); continue }
      if (e.isDirectory()) await walk(full, depth + 1)
    }
  }
  await walk(root, 0)
  return out
}

function formatUnknown(v: unknown): string {
  if (v instanceof Error) return v.message
  if (typeof v === 'string') return v
  try { return JSON.stringify(v) } catch { return String(v) }
}
