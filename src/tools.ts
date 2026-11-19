/**
 * 三个工具的 defineTool 定义。
 *  - plugin_guard_list：查看/筛选插件
 *  - plugin_guard_evaluate：删除前评估（只读），返回评估令牌
 *  - plugin_guard_cleanup：执行清理（需评估令牌 + 官方审批 UI 确认）
 *
 * 注意 dsh 的真实约束：output.schema 为 additionalProperties:false 时，
 * execute 返回值字段必须与 schema 完全一致，否则每次调用都被运行时拒绝。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PluginGuard } from './guard.ts'
import { guardMetaFrom, type GuardMeta } from './fragment.ts'

function rowsMeta(kind: GuardMeta['kind'], rows: Record<string, unknown>[], summary: string, pass?: boolean) {
  return { kind, rows, summary, ...(pass === undefined ? {} : { pass }) }
}

/** 把评估报告的 targets 投影成浏览器可读的行数据。 */
function reportRows(targets: Array<Record<string, any>>): Record<string, unknown>[] {
  return targets.map((t) => ({
    name: t.name,
    verdict: t.verdict,
    risk: t.risk,
    scope: t.scope,
    reasons: t.reasons,
    blockers: t.blockers,
    running: t.running,
    dependents: t.dependents?.map((d: any) => d.name) ?? [],
    bundles: t.plan?.bundles ?? [],
    cachePaths: t.plan?.cachePaths ?? [],
    scanRisk: t.scan?.level,
    scanCategories: t.scan?.categories ?? [],
    requiresExtraConfirm: t.requiresExtraConfirm === true,
  }))
}

/** 把扫描结果投影成浏览器可读的行数据。 */
function scanRows(results: Array<Record<string, any>>): Record<string, unknown>[] {
  return results.map((r) => ({
    name: r.name,
    level: r.level,
    categories: r.categories,
    hits: (r.hits ?? []).slice(0, 20).map((h: any) => ({
      ruleId: h.ruleId, category: h.category, severity: h.severity,
      label: h.label, line: h.line, excerpt: h.excerpt,
    })),
    summary: r.summary,
    filesScanned: r.filesScanned,
    error: r.error,
  }))
}

export function listTool(guard: PluginGuard): ToolDefinition {
  return defineTool({
    name: 'plugin_guard_list',
    description:
      '列出当前 dsh 已安装的插件/扩展。当用户想查看、盘点或筛选插件，或在删除前想确认有哪些插件时使用。可按名称关键字过滤，或按状态筛选。返回每个插件的名称、是否启用、是否可删除、是否为受保护核心模块、依赖与被依赖关系、运行状态。此工具只读，不会修改任何东西。',
    parameters: {
      query: { type: 'string', description: '按插件名/bundle 名过滤的关键字（可选，大小写不敏感）' },
      status: {
        type: 'string',
        enum: ['all', 'enabled', 'disabled', 'removable', 'core'],
        description: '状态筛选：all=全部（默认），enabled=已启用，disabled=已停用，removable=可安全删除，core=核心/官方',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          rows: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          count: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value.text) }],
      presentationMeta: (_args, value) =>
        rowsMeta('plugin-guard-list', value.rows as Record<string, unknown>[], String(value.text)),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const query = typeof args.query === 'string' ? args.query : undefined
      const status = typeof args.status === 'string' ? args.status : 'all'
      const { rows, warnings } = await guard.list({ query, status })
      const lines = rows.map((r) => {
        const tags = [r.protected ? '受保护核心' : r.scope, r.enabled ? '启用' : '停用', r.running ? '运行中' : '', r.removable ? '可删除' : '不可删'].filter(Boolean).join('/')
        const dep = r.dependents.length > 0 ? ` ←被依赖[${r.dependents.join(',')}]` : ''
        return `- ${r.name} [${tags}]${dep}`
      })
      const head = `共 ${rows.length} 个插件：`
      const warningText = warnings.length ? `\n注意：${warnings.join('；')}` : ''
      const text = lines.length ? `${head}\n${lines.join('\n')}${warningText}` : `${head}（无匹配项）${warningText}`
      return { text, rows: rows as unknown as Record<string, unknown>[], count: rows.length }
    },
    presentCall: () => ({ card: 'generic', title: '插件清单', kind: 'other' }),
    presentResult(_args, result) {
      if (result.isError) return undefined
      const meta = guardMetaFrom(result.meta)
      if (!meta) return undefined
      return { card: 'generic', title: `插件清单 · ${meta.rows.length} 个`, kind: 'other' }
    },
  })
}

export function evaluateTool(guard: PluginGuard): ToolDefinition {
  return defineTool({
    name: 'plugin_guard_evaluate',
    description:
      '删除插件前的安全评估（只读，绝不修改任何东西）。对指定的一个或多个插件，评估它与 dsh 核心及其他插件的依赖关系、运行状态，判断是否会引发 dsh 崩溃或核心功能异常，并给出每个插件的风险等级、阻断原因与清理清单预览。只有全部评估通过（pass=true）才可能执行清理。用户要求删除/清理插件时必须先调用此工具，再调用 plugin_guard_cleanup。返回中包含评估令牌，cleanup 必须携带。',
    parameters: {
      targets: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: '待评估删除的插件名列表（来自 plugin_guard_list 的 name 字段）',
      },
      withScan: {
        type: 'boolean',
        description: '是否同时做恶意行为静态扫描并联动（默认 false）。开启后高风险插件会被标记并在删除时要求二次确认。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          pass: { type: 'boolean', required: true },
          token: { type: 'string', required: true },
          rows: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          digest: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value.text) }],
      presentationMeta: (_args, value) =>
        rowsMeta('plugin-guard-evaluate', value.rows as Record<string, unknown>[], String(value.text), Boolean(value.pass)),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const raw = Array.isArray(args.targets) ? args.targets : []
      const targets = raw.filter((t): t is string => typeof t === 'string')
      const withScan = args.withScan === true
      const { report, token, warnings } = await guard.evaluate(targets, withScan)
      const lines = report.targets.map((t) => {
        const verdict = t.verdict === 'pass' ? '✅ 通过' : '⛔ 阻断'
        const detail = t.reasons.map((r) => `    · ${r}`).join('\n')
        return `${verdict} ${t.name} [${t.risk}/${t.scope}]\n${detail}`
      })
      const warningText = warnings.length ? `\n注意：${warnings.join('；')}` : ''
      const text =
        `评估结果：${report.pass ? '全部通过，可进入清理（仍需用户确认）' : '存在阻断项，禁止清理'}。\n` +
        `${lines.join('\n')}\n` +
        `评估令牌：${token}\n` +
        `状态摘要：${report.digest}${warningText}`
      return {
        text,
        pass: report.pass,
        token,
        rows: reportRows(report.targets as unknown as Array<Record<string, any>>),
        digest: report.digest,
      }
    },
    presentCall: () => ({ card: 'generic', title: '删除前安全评估', kind: 'other' }),
    presentResult(_args, result) {
      if (result.isError) return undefined
      const meta = guardMetaFrom(result.meta)
      if (!meta) return undefined
      return { card: 'generic', title: meta.pass ? '评估通过 · 待确认' : '评估未通过 · 已阻断', kind: 'other' }
    },
  })
}

export function cleanupTool(guard: PluginGuard): ToolDefinition {
  return defineTool({
    name: 'plugin_guard_cleanup',
    description:
      '执行插件清理（破坏性操作）。仅当已调用 plugin_guard_evaluate 且评估全部通过（pass=true）、并已获得用户对本次删除的明确同意后才可调用。必须传入评估返回的 token 与相同 targets。工具会再次复核状态与风险，任一不符即中止。执行时会卸载插件本体并清理其配置、缓存、注册信息与残留文件。调用本工具会触发 dsh 的用户确认界面，只有用户批准后才真正删除。',
    parameters: {
      token: { type: 'string', required: true, description: 'plugin_guard_evaluate 返回的评估令牌' },
      targets: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: '待清理的插件名列表，必须与评估时的 targets 完全一致',
      },
      acknowledgeHighRisk: {
        type: 'boolean',
        description: '当目标在扫描中命中高风险可疑特征时，必须显式设为 true 确认已了解风险，否则清理会被拒绝。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          rows: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value.text) }],
      presentationMeta: (_args, value) =>
        rowsMeta('plugin-guard-cleanup', value.rows as Record<string, unknown>[], String(value.text), Boolean(value.ok)),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const token = typeof args.token === 'string' ? args.token : ''
      const raw = Array.isArray(args.targets) ? args.targets : []
      const targets = raw.filter((t): t is string => typeof t === 'string')
      const result = await guard.cleanup(token, targets, args.acknowledgeHighRisk === true)
      const lines = result.steps.map((s) => {
        const head = `${s.ok ? '✅' : '❌'} ${s.target}`
        const phases = s.phases.map((p) => `    ✓ ${p}`)
        const warns = s.warnings.map((w) => `    ! ${w}`)
        const errors = s.errors.map((e) => `    ✗ ${e}`)
        return [head, ...phases, ...warns, ...errors].join('\n')
      })
      const text = `${result.message}\n${lines.join('\n')}`.trim()
      return {
        text,
        ok: result.ok,
        rows: result.steps.map((s) => ({ ...s })) as unknown as Record<string, unknown>[],
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `清理 ${Array.isArray(args.targets) ? args.targets.length : 0} 个插件`,
      kind: 'delete',
    }),
    presentResult(_args, result) {
      if (result.isError) return undefined
      const meta = guardMetaFrom(result.meta)
      if (!meta) return undefined
      return { card: 'generic', title: meta.pass ? '清理完成' : '清理未完全成功', kind: 'other' }
    },
  })
}

/** 恶意行为静态扫描工具：识别并标记可疑插件，展示名称/风险类型/摘要。 */
export function scanTool(guard: PluginGuard): ToolDefinition {
  return defineTool({
    name: 'plugin_guard_scan',
    description:
      '对已安装插件做恶意行为静态扫描（只读）。扫描插件源码与配置，检测动态代码执行、子进程、网络外联、凭据访问、篡改核心配置、破坏性删除、混淆代码、环境变量收集等可疑特征，按插件返回风险等级、风险类型与扫描结果摘要。当用户要求"检查插件是否安全/有无恶意行为/扫描插件"时使用。注意：这是基于静态特征的启发式提示，不是恶意行为的确证，需人工判断。',
    parameters: {
      targets: {
        type: 'array',
        items: { type: 'string' },
        description: '指定要扫描的插件名；留空则扫描全部已安装插件',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          rows: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          count: { type: 'number', required: true },
          highRiskCount: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value.text) }],
      presentationMeta: (_args, value) =>
        rowsMeta('plugin-guard-scan', value.rows as Record<string, unknown>[], String(value.text)),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const raw = Array.isArray(args.targets) ? args.targets : []
      const targets = raw.filter((t): t is string => typeof t === 'string')
      let results
      try {
        results = await guard.scanPlugins(targets.length > 0 ? targets : undefined)
      } catch (e) {
        const message = `扫描失败：${e instanceof Error ? e.message : String(e)}`
        return { text: message, rows: [], count: 0, highRiskCount: 0 }
      }
      const rows = scanRows(results as unknown as Array<Record<string, any>>)
      const highRiskCount = results.filter((r) => r.level === 'high').length
      const errCount = results.filter((r) => r.level === 'error').length
      const lines = results.map((r) => {
        const icon = r.level === 'high' ? '⛔' : r.level === 'medium' ? '⚠' : r.level === 'error' ? '❓' : '✅'
        return `${icon} ${r.summary}`
      })
      const text =
        `扫描完成：${results.length} 个插件，高风险 ${highRiskCount} 个，扫描异常 ${errCount} 个。\n` +
        `${lines.join('\n')}\n` +
        `（静态启发式提示，非恶意定论；点击卡片可查看风险类型与命中摘要。）`
      return { text, rows, count: results.length, highRiskCount }
    },
    presentCall: () => ({ card: 'generic', title: '恶意行为扫描', kind: 'other' }),
    presentResult(_args, result) {
      if (result.isError) return undefined
      const meta = guardMetaFrom(result.meta)
      if (!meta) return undefined
      return { card: 'generic', title: `插件扫描 · ${meta.rows.length} 个`, kind: 'other' }
    },
  })
}

/** 删除菜单数据源：返回可删除插件列表，附带扫描风险标记（供卡片下拉菜单渲染与联动）。 */
export function menuTool(guard: PluginGuard): ToolDefinition {
  return defineTool({
    name: 'plugin_guard_menu',
    description:
      '打开"删除插件"交互菜单。默认（interactive=false）返回可删除插件列表数据源（只读），卡片渲染下拉菜单；设 interactive=true 则弹出交互式两级菜单：第一级让用户点选要删除的插件，第二级在删除前再次确认（高风险插件需额外确认），确认后执行评估+清理。当用户要求"打开删除菜单/用菜单删除插件/我要选插件删掉"时使用；只需查看列表时用 interactive=false。',
    parameters: {
      interactive: {
        type: 'boolean',
        description: 'true=弹出两级交互菜单并执行删除；false=仅返回可删除列表（默认）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          rows: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          count: { type: 'number', required: true },
          deleted: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value.text) }],
      presentationMeta: (_args, value) =>
        rowsMeta('plugin-guard-menu', value.rows as Record<string, unknown>[], String(value.text)),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      // 第一步：生成可删除列表 + 扫描风险标记（两种模式共用）。
      let rows: Array<Record<string, unknown>>
      try {
        const { rows: removable } = await guard.list({ status: 'removable' })
        const scanResults = await guard.scanPlugins(removable.map((r) => r.name))
        const scanBy = new Map(scanResults.map((r) => [r.name, r]))
        rows = removable.map((r) => {
          const s = scanBy.get(r.name)
          return {
            name: r.name,
            bundle: r.bundle,
            enabled: r.enabled,
            running: r.running,
            scanRisk: s?.level ?? 'unknown',
            scanCategories: s?.categories ?? [],
            highRisk: s?.level === 'high',
          }
        })
      } catch (e) {
        const msg = `菜单数据生成失败：${e instanceof Error ? e.message : String(e)}`
        return { text: msg, rows: [], count: 0, deleted: false }
      }

      // 非交互模式：仅返回列表（卡片下拉菜单渲染数据源）。
      if (args.interactive !== true) {
        const text = `可删除插件 ${rows.length} 个（卡片下拉菜单中选择，删除前会二次确认；高风险插件需额外确认）。`
        return { text, rows, count: rows.length, deleted: false }
      }

      // 交互模式：无 open turn（exec.agent 缺失）时优雅降级。
      const execCtx = exec as { agent?: unknown; signal?: AbortSignal } | undefined
      if (rows.length === 0) {
        return { text: '当前没有可删除的插件（受保护核心/不可卸插件已排除）。', rows, count: 0, deleted: false }
      }

      const CANCEL = '取消'
      try {
        // 第一级菜单：选择插件。
        const pick = await guard.askUser([{
          id: 'target',
          question: '请选择要删除的插件（删除前会再次确认）：',
          header: '删除插件 · 第 1 步',
          options: [
            ...rows.map((r) => ({
              label: String(r.name),
              description: `${r.highRisk ? '⚠ 扫描高风险；' : ''}${r.running ? '运行中；' : ''}风险:${String(r.scanRisk)}`,
            })),
            { label: CANCEL, description: '不删除任何插件' },
          ],
        }], execCtx)
        const chosen = (pick.target ?? [])[0]
        if (!chosen || chosen === CANCEL) {
          return { text: '已取消删除，未做任何更改。', rows, count: rows.length, deleted: false }
        }

        const targetRow = rows.find((r) => r.name === chosen)
        if (!targetRow) {
          return { text: `所选插件「${chosen}」不在可删除列表中，已中止。`, rows, count: rows.length, deleted: false }
        }

        // 第二级菜单：删除前确认（高风险插件文案更严厉）。
        const isHigh = targetRow.highRisk === true
        const confirm = await guard.askUser([{
          id: 'confirm',
          question: isHigh
            ? `⚠ 高危确认：插件「${chosen}」扫描命中高风险可疑特征，确定删除吗？`
            : `确认删除插件「${chosen}」？此操作会移除插件本体及其配置、缓存与注册信息。`,
          detail: isHigh
            ? `风险类型：${(targetRow.scanCategories as string[]).join('、') || '未知'}。静态扫描仅为启发式提示，非恶意定论；如不确定，请取消。`
            : '删除后通常需要重启 dsh 才会完全生效。',
          header: isHigh ? '高危二次确认' : '删除确认 · 第 2 步',
          options: [{ label: '确认删除', description: '执行评估并清理' }, { label: CANCEL, description: '返回，不删除' }],
        }], execCtx)
        const verified = (confirm.confirm ?? [])[0]
        if (verified !== '确认删除') {
          return { text: '已在最终确认时取消，未做任何更改。', rows, count: rows.length, deleted: false }
        }

        // 评估（带扫描联动）→ 复核 → 清理。
        const { report, token } = await guard.evaluate([chosen], true)
        if (!report.pass) {
          const blocked = report.targets.filter((t) => t.verdict === 'block')
          return {
            text: `删除前评估未通过，已中止：${blocked.map((b) => `${b.name}（${b.blockers.join('/')}）`).join('；')}`,
            rows, count: rows.length, deleted: false,
          }
        }
        const needExtra = report.targets.some((t) => t.requiresExtraConfirm === true)
        const result = await guard.cleanup(token, [chosen], needExtra && isHigh)
        const text = result.ok
          ? `菜单删除成功：${result.message}`
          : `菜单删除未完全成功：${result.message}`
        return { text, rows, count: rows.length, deleted: result.ok }
      } catch (e) {
        // ask-user / 评估 / 清理任一异常都优雅降级，不抛出工具错误。
        const msg = e instanceof Error ? e.message : String(e)
        return {
          text: `交互式删除菜单未能完成（${msg}）。请改用对话式流程：plugin_guard_evaluate → 用户确认 → plugin_guard_cleanup。未做任何更改。`,
          rows, count: rows.length, deleted: false,
        }
      }
    },
    presentCall: () => ({ card: 'generic', title: '插件删除菜单', kind: 'other' }),
    presentResult(_args, result) {
      if (result.isError) return undefined
      const meta = guardMetaFrom(result.meta)
      if (!meta) return undefined
      return { card: 'generic', title: `删除菜单 · ${meta.rows.length} 个可删`, kind: 'other' }
    },
  })
}
