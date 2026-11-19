/**
 * dsh 插件守护者（plugin-guard）— apply 入口。
 *
 * 能力：查看/筛选插件 → 删除前强制评估依赖与运行状态 → 用户确认 → 彻底清理。
 * 安全机制：
 *   - 系统提示强制"先评估、后确认、再清理"三步流程；
 *   - tools/pre-execute 关卡对 cleanup 返回 kind:'ask'，接入 dsh 官方审批 UI；
 *   - 评估令牌 + 状态摘要防重放与 TOCTOU；核心保护名单防误删内核。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { PluginGuard, DEFAULT_CONFIG } from './guard.ts'
import { listTool, evaluateTool, cleanupTool, scanTool, menuTool } from './tools.ts'
import { PLUGIN_ID } from './fragment.ts'

export const name = PLUGIN_ID

/** 声明依赖的服务：工具注册、系统提示、官方插件管理器、profile 上下文。 */
// 注意：userQuestions 不放入 inject（避免硬依赖导致加载失败）；
// 交互菜单里通过 ctx.userQuestions 可选访问，缺失时优雅降级为对话式流程。
export const inject = ['tools', 'systemPrompt', 'pluginManager', 'profileContext']

/** 用户可覆盖配置（profile/patch 层）。 */
export const Config = z.object({
  tokenTtlMs: z.number().min(1000).default(DEFAULT_CONFIG.tokenTtlMs),
  sweepCache: z.boolean().default(DEFAULT_CONFIG.sweepCache),
  backupBeforeWrite: z.boolean().default(DEFAULT_CONFIG.backupBeforeWrite),
  cacheMatchMinLength: z.number().min(3).default(DEFAULT_CONFIG.cacheMatchMinLength),
})

export function apply(ctx: Context, config: z.infer<typeof Config> = {} as any) {
  const cfg = {
    tokenTtlMs: (config as any).tokenTtlMs ?? DEFAULT_CONFIG.tokenTtlMs,
    sweepCache: (config as any).sweepCache ?? DEFAULT_CONFIG.sweepCache,
    backupBeforeWrite: (config as any).backupBeforeWrite ?? DEFAULT_CONFIG.backupBeforeWrite,
    cacheMatchMinLength: (config as any).cacheMatchMinLength ?? DEFAULT_CONFIG.cacheMatchMinLength,
  }
  const guard = new PluginGuard(ctx as any, cfg)

  ctx.effect(() => ctx.tools.register(listTool(guard)), `${PLUGIN_ID}.list`)
  ctx.effect(() => ctx.tools.register(evaluateTool(guard)), `${PLUGIN_ID}.evaluate`)
  ctx.effect(() => ctx.tools.register(cleanupTool(guard)), `${PLUGIN_ID}.cleanup`)
  ctx.effect(() => ctx.tools.register(scanTool(guard)), `${PLUGIN_ID}.scan`)
  ctx.effect(() => ctx.tools.register(menuTool(guard)), `${PLUGIN_ID}.menu`)

  // 系统提示：教模型在"删除/卸载/清理插件"意图下走安全流程。order 取较大值避免干扰通用指令。
  ctx.effect(() => ctx.systemPrompt.section({
    name: `${PLUGIN_ID}:policy`,
    order: 2400,
    text: () =>
      '## 插件管理与安全清理 (plugin-guard)\n' +
      '当用户要求查看、盘点、筛选、卸载、删除或清理 dsh 插件时：\n' +
      '1. 先用 `plugin_guard_list` 查看插件（可按 query/status 筛选），让用户确认要处理的插件名称。\n' +
      '2. 删除前**必须**用 `plugin_guard_evaluate` 对目标做依赖与运行状态评估；返回 pass=false 时严禁清理，并如实告知阻断原因。\n' +
      '3. 评估通过后，向用户展示评估报告与清理后果，取得用户对本次删除的明确同意。\n' +
      '4. 仅在用户同意后调用 `plugin_guard_cleanup`，原样传入评估返回的 token 与 targets；不要自行编造 token。\n' +
      '5. 评估令牌有时效（默认 5 分钟）且一次性，过期或目标状态变化需重新评估。\n' +
      '6. 用户要求"扫描插件/检查恶意行为/哪些插件不安全"时用 `plugin_guard_scan`；返回高风险插件时如实展示风险类型与摘要，并说明这是静态启发式提示、非恶意定论。\n' +
      '7. 用户要求"用菜单删除/打开删除菜单/我要选插件删掉"时用 `plugin_guard_menu` 并传 `interactive:true`：会弹出两级选择菜单（先选插件、再确认），高风险插件额外确认后才删除。只需查看可删列表时传 `interactive:false`。\n' +
      '8. 评估可加 `withScan:true` 联动扫描；若某目标被标为 requiresExtraConfirm，清理时必须显式传 `acknowledgeHighRisk:true`，否则会被拒绝。\n' +
      '绝不可跳过评估直接清理，也不要试图删除受保护的核心模块或本插件自身。',
  }), `${PLUGIN_ID}.prompt`)

  // 审批关卡：cleanup 工具在 body 执行前请求用户批准（dsh 官方 approval UI）。
  // 返回 kind:'ask' 后由 registry 自动调用 ApprovalService，只有 allowed-once 才放行。
  ctx.on('tools/pre-execute', async (exec: any, next: () => Promise<any>) => {
    if (exec?.name !== 'plugin_guard_cleanup') return next()
    const targets = Array.isArray(exec?.args?.targets) ? exec.args.targets.join('、') : ''
    return {
      kind: 'ask' as const,
      reason: `即将清理插件：${targets || '（未指定）'}。此操作会移除插件本体及其配置、缓存与注册信息，且需要重启 dsh 才会完全生效。`,
      displayReason: {
        en: `Delete plugin(s): ${targets || '(unspecified)'}? This removes the plugin and its config, cache and registration; a restart is required to fully apply.`,
        zh: `确认清理插件：${targets || '（未指定）'}？将移除插件本体及其配置、缓存与注册信息，重启后完全生效。`,
      },
    }
  }, { prepend: true })

  // 管理器服务不可用时给出明确告警（不崩溃）。
  ctx.effect(() => {
    if (!guard.managerAvailable()) {
      console.warn(`[${PLUGIN_ID}] 未检测到 ctx.pluginManager 服务，插件管理/清理能力不可用。请确认当前 profile 包含 dsh-plugin-manager。`)
    }
  })
}
