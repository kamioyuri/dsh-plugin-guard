/**
 * 浏览器端：
 *  (A) 设置界面二级菜单 —— 注册 settings.section（"插件守卫"），列出可删插件，
 *      每项删除按钮 + 确认弹窗，直接调用官方 ctx.remote.pluginManager.removeBundle()。
 *  (B) Toolview —— 把五个工具的持久化 meta 渲染成卡片。
 * 沙箱约束：单文件产物、无动态 import、内联样式、平台模块走 require 白名单。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import React from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { guardMetaFrom, isListableBundle, type GuardMeta } from '../fragment.ts'

// 与 tsdown.config.ts 中 __ModuleLoader__.load 的 id 一致：dsh 以完整包名作为模块 id 校验。
export const name = '@yuri/dsh-plugin-guard'
// cordis fiber inject 服务名：
// - slots：注册 settings.section / tool.call.toolview
// - locale：设置界面文案本地化
// - remote + remote.pluginManager：删除插件的官方 Remote 端点（removeBundle/listBundles/listPlugins）
export const inject = ['slots', 'locale', 'remote', 'remote.pluginManager']

/**
 * 配色统一：全部引用 dsh 官方 --dsw-* 主题令牌，跟随系统明/暗主题。
 * fallback 为官方深色模式的等价 hex，仅在令牌缺失（如宿主未注入主题）时生效。
 * 令牌来源：@deepseek-ai/dsh-client-ui-theme/lib/client.js (design-platform.css)。
 */
const cssVar = (token: string, fallback: string) => `var(${token}, ${fallback})`
const COLORS = {
  bg: cssVar('--dsw-alias-bg-layer-2', '#2c2c2e'),       // 卡片/条目前景面
  surface: cssVar('--dsw-alias-bg-layer-3', '#353638'),   // 二级表面/输入框
  border: cssVar('--dsw-alias-border-l4', 'rgba(255,255,255,0.2)'),
  text: cssVar('--dsw-alias-label-primary', '#f9fafb'),
  muted: cssVar('--dsw-alias-label-secondary', '#cfd3d6'),
  green: cssVar('--dsw-alias-state-success-primary', '#4ade80'),
  red: cssVar('--dsw-alias-state-error-primary', '#f25a5a'),
  amber: cssVar('--dsw-alias-state-warn-label', '#fbbf24'),
  blue: cssVar('--dsw-alias-state-business-primary', '#7aaaff'),
  chip: cssVar('--dsw-alias-bg-layer-3', '#353638'),
  dangerHover: cssVar('--dsw-alias-interactive-bg-hover-danger', 'rgba(242,90,90,0.15)'),
  focusRing: cssVar('--dsw-focus-ring-color', '#7aaaff'),
}
const RADIUS = {
  sm: cssVar('--dsw-radius-sm', '8px'),
  md: cssVar('--dsw-radius-md', '12px'),
  lg: cssVar('--dsw-radius-lg', '16px'),
}

const cardStyle: React.CSSProperties = {
  background: COLORS.bg,
  color: COLORS.text,
  border: `0.5px solid ${COLORS.border}`,
  borderRadius: RADIUS.md,
  padding: 14,
  fontFamily: 'system-ui, -apple-system, sans-serif',
  fontSize: 13,
  maxWidth: 720,
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  padding: '8px 10px',
  background: COLORS.surface,
  borderRadius: RADIUS.sm,
  marginBottom: 6,
}

function chip(text: string, color: string): React.ReactElement {
  return (
    <span style={{
      background: COLORS.chip, color, borderRadius: RADIUS.sm,
      padding: '1px 7px', fontSize: 11, whiteSpace: 'nowrap', border: `0.5px solid ${COLORS.border}`,
    }}>{text}</span>
  )
}

function str(v: unknown): string { return v === undefined || v === null ? '' : String(v) }
function arr(v: unknown): string[] { return Array.isArray(v) ? v.map(String) : [] }

function ListView({ meta }: { meta: GuardMeta }) {
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <strong style={{ fontSize: 14 }}>🧩 插件清单</strong>
        {chip(`${meta.rows.length} 个`, COLORS.blue)}
      </div>
      <div style={{ color: COLORS.muted, marginBottom: 10, fontSize: 12 }}>{meta.summary}</div>
      {meta.rows.length === 0 && <div style={{ color: COLORS.muted }}>无匹配插件。</div>}
      {meta.rows.map((r, i) => {
        const protectedFlag = r.protected === true
        const enabled = r.enabled === true
        const running = r.running === true
        const removable = r.removable === true
        return (
          <div key={i} style={rowStyle}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, wordBreak: 'break-word' }}>{str(r.name)}</div>
              <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {chip(str(r.scope || 'unknown'), protectedFlag ? COLORS.amber : COLORS.muted)}
                {chip(enabled ? '已启用' : '已停用', enabled ? COLORS.green : COLORS.muted)}
                {running && chip('运行中', COLORS.blue)}
                {chip(removable ? '可删除' : '不可删', removable ? COLORS.green : COLORS.red)}
                {protectedFlag && chip('核心保护', COLORS.amber)}
              </div>
              {arr(r.dependents).length > 0 && (
                <div style={{ marginTop: 5, color: COLORS.muted, fontSize: 11 }}>
                  被依赖：{arr(r.dependents).join('、')}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function EvaluateView({ meta }: { meta: GuardMeta }) {
  const pass = meta.pass === true
  return (
    <div style={{
      ...cardStyle,
      borderColor: pass ? COLORS.green : COLORS.red,
      borderWidth: 2,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <strong style={{ fontSize: 14 }}>🛡️ 删除前安全评估</strong>
        {chip(pass ? '全部通过 · 待用户确认' : '存在阻断 · 禁止清理', pass ? COLORS.green : COLORS.red)}
      </div>
      <div style={{ color: COLORS.muted, marginBottom: 10, fontSize: 12 }}>{meta.summary}</div>
      {meta.rows.length === 0 && <div style={{ color: COLORS.muted }}>无评估条目。</div>}
      {meta.rows.map((r, i) => {
        const ok = r.verdict === 'pass'
        return (
          <div key={i} style={{
            ...rowStyle,
            flexDirection: 'column',
            gap: 6,
            borderLeft: `3px solid ${ok ? COLORS.green : COLORS.red}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', flexWrap: 'wrap' }}>
              <strong>{ok ? '✅' : '⛔'} {str(r.name)}</strong>
              {chip(`风险:${str(r.risk)}`, r.risk === 'block' ? COLORS.red : r.risk === 'warn' ? COLORS.amber : COLORS.green)}
              {chip(str(r.scope), COLORS.muted)}
              {r.running === true && chip('运行中', COLORS.blue)}
              {r.scanRisk !== undefined && chip(
                `扫描:${str(r.scanRisk)}`,
                r.scanRisk === 'high' ? COLORS.red : r.scanRisk === 'medium' ? COLORS.amber : r.scanRisk === 'clean' ? COLORS.green : COLORS.muted,
              )}
              {r.requiresExtraConfirm === true && chip('需额外确认', COLORS.red)}
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, color: COLORS.muted, fontSize: 12 }}>
              {arr(r.reasons).map((reason, j) => <li key={j} style={{ marginBottom: 2 }}>{reason}</li>)}
            </ul>
            {arr(r.dependents).length > 0 && (
              <div style={{ fontSize: 11, color: COLORS.amber }}>依赖方：{arr(r.dependents).join('、')}</div>
            )}
            {arr(r.blockers).length > 0 && (
              <div style={{ fontSize: 11, color: COLORS.red }}>阻断码：{arr(r.blockers).join('、')}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function CleanupView({ meta }: { meta: GuardMeta }) {
  const ok = meta.pass === true
  return (
    <div style={{ ...cardStyle, borderColor: ok ? COLORS.green : COLORS.red, borderWidth: 2 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <strong style={{ fontSize: 14 }}>🧹 插件清理结果</strong>
        {chip(ok ? '清理完成' : '存在失败项', ok ? COLORS.green : COLORS.red)}
      </div>
      <div style={{ color: COLORS.muted, marginBottom: 10, fontSize: 12 }}>{meta.summary}</div>
      {meta.rows.map((r, i) => {
        const rowOk = r.ok === true
        return (
          <div key={i} style={{ ...rowStyle, flexDirection: 'column', gap: 5, borderLeft: `3px solid ${rowOk ? COLORS.green : COLORS.red}` }}>
            <strong>{rowOk ? '✅' : '❌'} {str(r.target)}</strong>
            {arr(r.phases).map((p, j) => <div key={`p${j}`} style={{ color: COLORS.green, fontSize: 12 }}>✓ {p}</div>)}
            {arr(r.warnings).map((w, j) => <div key={`w${j}`} style={{ color: COLORS.amber, fontSize: 12 }}>! {w}</div>)}
            {arr(r.errors).map((e, j) => <div key={`e${j}`} style={{ color: COLORS.red, fontSize: 12 }}>✗ {e}</div>)}
          </div>
        )
      })}
    </div>
  )
}

function levelColor(level: unknown): string {
  const l = str(level)
  return l === 'high' ? COLORS.red : l === 'medium' ? COLORS.amber : l === 'low' ? COLORS.blue : l === 'clean' ? COLORS.green : COLORS.muted
}

function levelIcon(level: unknown): string {
  const l = str(level)
  return l === 'high' ? '⛔' : l === 'medium' ? '⚠' : l === 'error' ? '❓' : l === 'clean' ? '✅' : '🔎'
}

/** 恶意行为扫描结果卡片：插件名 + 风险类型 + 摘要 + 命中明细。 */
function ScanView({ meta }: { meta: GuardMeta }) {
  const high = meta.rows.filter((r) => r.level === 'high').length
  return (
    <div style={{ ...cardStyle, borderColor: high > 0 ? COLORS.red : COLORS.border, borderWidth: high > 0 ? 2 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <strong style={{ fontSize: 14 }}>🔎 恶意行为扫描</strong>
        {chip(`${meta.rows.length} 个插件`, COLORS.blue)}
        {high > 0 && chip(`高风险 ${high}`, COLORS.red)}
      </div>
      <div style={{ color: COLORS.muted, marginBottom: 10, fontSize: 12 }}>{meta.summary}</div>
      {meta.rows.length === 0 && <div style={{ color: COLORS.muted }}>无扫描结果。</div>}
      {meta.rows.map((r, i) => (
        <div key={i} style={{ ...rowStyle, flexDirection: 'column', gap: 6, borderLeft: `3px solid ${levelColor(r.level)}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', width: '100%' }}>
            <strong>{levelIcon(r.level)} {str(r.name)}</strong>
            {chip(`等级:${str(r.level)}`, levelColor(r.level))}
            {chip(`扫描 ${str(r.filesScanned)} 文件`, COLORS.muted)}
          </div>
          {arr(r.categories).length > 0 && (
            <div style={{ fontSize: 11, color: COLORS.amber }}>风险类型：{arr(r.categories).join('、')}</div>
          )}
          <div style={{ fontSize: 12, color: COLORS.muted }}>{str(r.summary)}</div>
          {arr(r.hits).length > 0 && (
            <details style={{ width: '100%', fontSize: 11 }}>
              <summary style={{ cursor: 'pointer', color: COLORS.blue }}>命中明细（{arr(r.hits).length}）</summary>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: COLORS.muted }}>
                {arr(r.hits).slice(0, 8).map((h, j) => {
                  let hit: Record<string, unknown> = {}
                  try { hit = JSON.parse(h) as Record<string, unknown> } catch { /* 已格式化字符串 */ }
                  const label = typeof hit === 'object' && hit !== null ? str(hit.label || hit.ruleId) : h
                  const line = typeof hit === 'object' && hit !== null ? str(hit.line) : ''
                  return <li key={j} style={{ marginBottom: 2 }}>{label}{line ? ` @L${line}` : ''}</li>
                })}
              </ul>
            </details>
          )}
        </div>
      ))}
      <div style={{ marginTop: 8, fontSize: 11, color: COLORS.muted }}>静态启发式提示，非恶意定论；请结合实际情况判断。</div>
    </div>
  )
}

/** 删除菜单卡片：可删除插件列表 + 风险标记，提示用户用交互菜单选择与确认。 */
function MenuView({ meta }: { meta: GuardMeta }) {
  const high = meta.rows.filter((r) => r.highRisk === true).length
  return (
    <div style={{ ...cardStyle, borderColor: COLORS.blue, borderWidth: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <strong style={{ fontSize: 14 }}>🗑️ 插件删除菜单</strong>
        {chip(`${meta.rows.length} 个可删`, COLORS.blue)}
        {high > 0 && chip(`高风险 ${high}`, COLORS.red)}
      </div>
      <div style={{ color: COLORS.muted, marginBottom: 10, fontSize: 12 }}>{meta.summary}</div>
      {meta.rows.length === 0 && <div style={{ color: COLORS.muted }}>当前没有可删除的插件。</div>}
      {meta.rows.map((r, i) => (
        <div key={i} style={rowStyle}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, wordBreak: 'break-word' }}>{str(r.name)}</div>
            <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {chip(`扫描:${str(r.scanRisk)}`, levelColor(r.scanRisk))}
              {r.highRisk === true && chip('⚠ 高风险·需额外确认', COLORS.red)}
              {r.running === true && chip('运行中', COLORS.blue)}
            </div>
            {arr(r.scanCategories).length > 0 && (
              <div style={{ marginTop: 4, fontSize: 11, color: COLORS.amber }}>风险类型：{arr(r.scanCategories).join('、')}</div>
            )}
          </div>
        </div>
      ))}
      <div style={{ marginTop: 8, padding: 8, background: COLORS.surface, borderRadius: RADIUS.sm, fontSize: 11, color: COLORS.muted }}>
        删除前会弹出两级菜单：先选择插件、再次确认；高风险插件需额外确认。也可对我说"用菜单删除某个插件"直接开始。
      </div>
    </div>
  )
}

function GuardCard({ callId, block }: ToolCallViewProps) {
  // 运行中/未定态：block 没有 kind 字段（或 content 尚未产出 meta）。
  if (!('kind' in (block as object))) {
    return <div style={cardStyle}><span style={{ color: COLORS.muted }}>⏳ 插件审计处理中…</span></div>
  }
  const anyBlock = block as any
  if (anyBlock.isError) {
    return <div style={{ ...cardStyle, borderColor: COLORS.red }}><span style={{ color: COLORS.red }}>插件工具执行失败。</span></div>
  }
  const meta = guardMetaFrom(anyBlock.meta)
  if (!meta) {
    return <div style={cardStyle}><span style={{ color: COLORS.muted }}>{str(anyBlock.content?.[0]?.text) || '无渲染数据'}</span></div>
  }
  if (meta.kind === 'plugin-guard-list') return <ListView meta={meta} />
  if (meta.kind === 'plugin-guard-evaluate') return <EvaluateView meta={meta} />
  if (meta.kind === 'plugin-guard-scan') return <ScanView meta={meta} />
  if (meta.kind === 'plugin-guard-menu') return <MenuView meta={meta} />
  return <CleanupView meta={meta} />
}

// ---- 设置界面"插件守卫" section：可删插件列表 + 二次确认删除 ----

interface GuardRow {
  name: string
  enabled: boolean
  removable: boolean
  canRemove: boolean
  readOnlyReason?: string | null
  official?: boolean
  optional?: boolean
  source: 'bundle' | 'plugin'
}

const SECTION_NS = 'dshPluginGuardSettings'
const SECTION_ID = 'dsh-plugin-guard'

const DICT: Record<string, Record<string, string>> = {
  zh: {
    nav: '插件守卫', title: '插件守卫 · 插件清理',
    subtitle: '搜索并选择插件清理。删除前会二次确认。',
    search: '搜索已安装插件…', noMatch: '没有匹配的插件。', found: '匹配 {n} 个',
    refresh: '刷新', empty: '没有已安装的插件。', del: '删除', deleting: '删除中…',
    protected: '不可卸载', readonly: '只读',
    cancel: '取消', confirm: '确认删除', confirmTitle: '删除插件',
    confirmDesc: '将移除插件本体及其配置、缓存与注册信息，通常需要重启 dsh 才完全生效。此操作不可撤销。',
    ok: '删除成功，请重启 dsh 使其完全生效。', fail: '删除失败', loading: '正在加载插件列表…',
    note: '插件清理仅针对已安装插件；删除前请确认目标，操作不可撤销。',
  },
  en: {
    nav: 'Plugin Guard', title: 'Plugin Guard · Cleanup',
    subtitle: 'Search and select a plugin to clean up. Confirmation is required before deletion.',
    search: 'Search installed plugins…', noMatch: 'No matching plugins.', found: '{n} matched',
    refresh: 'Refresh', empty: 'No installed plugins.', del: 'Delete', deleting: 'Deleting…',
    protected: 'Not removable', readonly: 'Read-only',
    cancel: 'Cancel', confirm: 'Confirm delete', confirmTitle: 'Delete plugin',
    confirmDesc: 'Removes the plugin and its config, cache and registration. A dsh restart is usually required. This cannot be undone.',
    ok: 'Deleted. Restart dsh to fully apply.', fail: 'Delete failed', loading: 'Loading plugin list…',
    note: 'Cleanup applies to installed plugins only. Confirm the target before deleting; this cannot be undone.',
  },
}

/** 二次确认弹窗：优先用 primitives.Modal/Button，缺失时降级为原生实现。 */
function ConfirmModal({ title, desc, cancelLabel, confirmLabel, onCancel, onConfirm, busy }: {
  title: string; desc: string; cancelLabel: string; confirmLabel: string
  onCancel: () => void; onConfirm: () => void; busy: boolean
}) {
  const P: any = primitives as any
  const Modal = P?.Modal
  const Button = P?.Button
  if (Modal && Button) {
    return React.createElement(Modal, {
      open: true, onClose: onCancel, title, description: desc,
      footer: React.createElement(React.Fragment, null,
        React.createElement(Button, { variant: 'outline', onClick: onCancel, disabled: busy, children: cancelLabel }),
        // 官方 .dangerButton 等价做法：覆盖 primary 按钮的两个 fill token 为危险色。
        React.createElement(Button, {
          variant: 'primary', onClick: onConfirm, disabled: busy,
          style: {
            '--dsw-alias-button-primary-fill': 'var(--dsw-alias-state-error-primary, #f25a5a)',
            '--dsw-alias-button-primary-hover': 'var(--dsw-alias-state-error-primary, #f25a5a)',
          } as React.CSSProperties,
          children: busy ? deletingFallback : confirmLabel,
        }),
      ),
    })
  }
  // 降级：原生遮罩层
  return React.createElement('div', { style: {
    position: 'fixed', inset: 0, background: cssVar('--dsw-alias-bg-mask-2', 'rgba(0,0,0,0.55)'), display: 'flex',
    alignItems: 'center', justifyContent: 'center', zIndex: 9999,
  } }, React.createElement('div', { style: {
    background: COLORS.bg, color: COLORS.text, border: `0.5px solid ${COLORS.border}`,
    borderRadius: RADIUS.md, padding: 20, maxWidth: 440, fontFamily: 'system-ui, sans-serif',
  } },
    React.createElement('h3', null, title),
    React.createElement('p', { style: { color: COLORS.muted, fontSize: 13 } }, desc),
    React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 } },
      React.createElement('button', { type: 'button', onClick: onCancel, disabled: busy, style: btnStyle(false) }, cancelLabel),
      React.createElement('button', { type: 'button', onClick: onConfirm, disabled: busy, style: btnStyle(true) }, busy ? '…' : confirmLabel),
    ),
  ))
}
const deletingFallback = '…'
void deletingFallback
/** primary=true → 危险操作按钮（官方 .dangerButton 风格：透明底 + 红字 + 半透明红边）；
 *  primary=false → 普通幽灵按钮。均带 focus-visible 焦点环。 */
function btnStyle(primary: boolean): React.CSSProperties {
  return {
    background: primary ? 'transparent' : cssVar('--dsw-alias-button-contrast-fill', COLORS.surface),
    color: primary ? COLORS.red : COLORS.text,
    border: primary
      ? `0.5px solid ${cssVar('--dsw-alias-state-error-primary', '#f25a5a')}`
      : `0.5px solid ${COLORS.border}`,
    borderRadius: RADIUS.sm,
    padding: '6px 14px', cursor: 'pointer', fontSize: 13,
    outlineOffset: 1,
  }
}
/** onFocus/onBlur 内联模拟 :focus-visible（内联样式无法写伪类）。 */
function focusHandlers(e: React.FocusEvent<HTMLElement>) {
  e.currentTarget.style.outline = `2px solid ${COLORS.focusRing}`
}
function blurHandlers(e: React.FocusEvent<HTMLElement>) {
  e.currentTarget.style.outline = 'none'
}

/** 设置 section 组件：列出可删插件，每行一个删除按钮 + 确认弹窗。 */
function GuardSection(props: any) {
  const t: (key: string, vars?: Record<string, string>) => string = props.t
  const remote = props.remote as any
  const [rows, setRows] = React.useState<GuardRow[]>([])
  const [loading, setLoading] = React.useState(true)
  const [query, setQuery] = React.useState('')
  const [confirmName, setConfirmName] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [note, setNote] = React.useState('')

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const list: GuardRow[] = []
      if (remote?.pluginManager?.listBundles) {
        const r = await remote.pluginManager.listBundles()
        if (r?.ok && Array.isArray(r.value)) {
          for (const b of r.value) {
            // 列出所有非核心的已安装 bundle（含 removable=false 的，dsh-tui 一定在内）。
            if (!isListableBundle(b)) continue
            const canRemove = b.removable !== false && !(typeof b.readOnlyReason === 'string' && b.readOnlyReason !== '')
            list.push({
              name: b.name, enabled: Boolean(b.enabled),
              removable: b.removable !== false, canRemove,
              readOnlyReason: b.readOnlyReason ?? null, official: Boolean(b.official),
              optional: Boolean(b.optional), source: 'bundle',
            })
          }
        }
      }
      list.sort((a, b) => a.name.localeCompare(b.name))
      setRows(list)
    } catch (e) {
      setNote(`${t('fail')}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [remote, t])

  React.useEffect(() => { void load() }, [load])

  const doRemove = React.useCallback(async () => {
    const name = confirmName
    setConfirmName(null)
    if (!name) return
    setBusy(name)
    setNote('')
    try {
      if (!remote?.pluginManager?.removeBundle) throw new Error('removeBundle 不可用（remote.pluginManager 未注入）')
      const r = await remote.pluginManager.removeBundle(name)
      if (r?.ok) {
        setNote(t('ok'))
        await load()
      } else {
        const reason = r?.error?.message || r?.error?.code || JSON.stringify(r?.error ?? r)
        setNote(`${t('fail')}: ${name} — ${reason}`)
      }
    } catch (e) {
      setNote(`${t('fail')}: ${name} — ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }, [confirmName, remote, load, t])

  const q = query.trim().toLowerCase()
  const filtered = q === '' ? rows : rows.filter((r) => r.name.toLowerCase().includes(q))

  return React.createElement(React.Fragment, null,
    React.createElement('h2', { style: { fontSize: 16, margin: '0 0 6px' } }, t('title')),
    React.createElement('p', { style: { color: COLORS.muted, fontSize: 12, margin: '0 0 12px' } }, t('subtitle')),
    // 搜索框（列表上方）
    React.createElement('div', { style: { display: 'flex', gap: 8, marginBottom: 10 } },
      React.createElement('input', {
        type: 'text', value: query,
        onChange: (e: any) => setQuery(e.target.value ?? ''),
        placeholder: t('search'),
        style: {
          flex: 1, minWidth: 0, padding: '7px 10px', borderRadius: RADIUS.sm,
          border: `0.5px solid ${COLORS.border}`, background: COLORS.surface,
          color: COLORS.text, fontSize: 13, outline: 'none',
          onFocus: focusHandlers, onBlur: blurHandlers,
        },
      }),
      React.createElement('button', { type: 'button', onClick: () => void load(), disabled: loading, style: btnStyle(false), onFocus: focusHandlers, onBlur: blurHandlers }, t('refresh')),
    ),
    q !== '' && React.createElement('div', { style: { color: COLORS.muted, fontSize: 11, marginBottom: 8 } },
      t('found').replace('{n}', String(filtered.length)),
    ),
    note && React.createElement('div', {
      style: { padding: 8, marginBottom: 12, borderRadius: RADIUS.sm, background: COLORS.surface, color: COLORS.amber, fontSize: 12 },
      role: 'status',
    }, note),
    loading
      ? React.createElement('div', { style: { color: COLORS.muted, fontSize: 13 } }, t('loading'))
      : rows.length === 0
        ? React.createElement('div', { style: { color: COLORS.muted, fontSize: 13 } }, t('empty'))
        : filtered.length === 0
          ? React.createElement('div', { style: { color: COLORS.muted, fontSize: 13 } }, t('noMatch'))
          : React.createElement('div', null, filtered.map((r) =>
              React.createElement('div', { key: r.name, style: { ...rowStyle, alignItems: 'center' } },
                React.createElement('div', { style: { flex: 1, minWidth: 0 } },
                  React.createElement('div', { style: { fontWeight: 600, wordBreak: 'break-word', fontSize: 13 } }, r.name),
                  React.createElement('div', { style: { marginTop: 3, display: 'flex', gap: 4, flexWrap: 'wrap' } },
                    chip(r.enabled ? '启用' : '停用', r.enabled ? COLORS.green : COLORS.muted),
                    r.canRemove
                      ? chip('可卸载', COLORS.green)
                      : chip(r.readOnlyReason ? t('readonly') : t('protected'), COLORS.amber),
                  ),
                ),
                React.createElement('button', {
                  type: 'button', disabled: !r.canRemove || busy === r.name,
                  onClick: () => setConfirmName(r.name), style: btnStyle(true),
                  onFocus: focusHandlers, onBlur: blurHandlers,
                  title: r.canRemove ? undefined : (r.readOnlyReason || t('protected')),
                }, busy === r.name ? t('deleting') : t('del')),
              ),
            )),
    React.createElement('p', { style: { color: COLORS.muted, fontSize: 11, marginTop: 14 } }, t('note')),
    confirmName !== null && React.createElement(ConfirmModal, {
      title: t('confirmTitle'), desc: `${t('confirmDesc')}\n\n${confirmName}`,
      cancelLabel: t('cancel'), confirmLabel: t('confirm'), busy: busy !== null,
      onCancel: () => setConfirmName(null), onConfirm: () => void doRemove(),
    }),
  )
}

export function apply(ctx: ClientContext): void {
  const anyCtx = ctx as any

  // (A) 设置界面二级菜单：注册独立 section（不占用官方 "plugins" id）。
  try {
    const locale = anyCtx.locale
    const t: (key: string, vars?: Record<string, string>) => string = locale?.bind
      ? locale.bind(SECTION_NS)
      : (k) => (DICT.zh[k] ?? k)
    // 用真实三参签名注册字典（ns, locale, dict）。
    if (locale?.register) {
      ctx.effect(() => {
        const offs: Array<() => void> = []
        try { offs.push(locale.register(SECTION_NS, 'zh', DICT.zh)) } catch { /* noop */ }
        try { offs.push(locale.register(SECTION_NS, 'en', DICT.en)) } catch { /* noop */ }
        return () => offs.forEach((off) => { try { off() } catch { /* noop */ } })
      }, 'plugin-guard.settings.locale')
    }
    anyCtx.slots.inject('settings.section', () => anyCtx.slots.register({
      name: 'settings.section',
      id: SECTION_ID,
      order: 26,
      label: () => t('nav'),
      locale: SECTION_NS,
      inject: () => ({ t, remote: anyCtx.remote }),
    }, GuardSection))
  } catch {
    // 设置 section 注册失败不得影响 Toolview 与插件主体。
  }

  // (B) Toolview：五个工具的卡片渲染。
  const register = (key: string, component: React.ComponentType<ToolCallViewProps>) => {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
      { name: 'tool.call.toolview', key },
      component,
    ))
  }
  register('plugin_guard_list', GuardCard as any)
  register('plugin_guard_evaluate', GuardCard as any)
  register('plugin_guard_cleanup', GuardCard as any)
  register('plugin_guard_scan', GuardCard as any)
  register('plugin_guard_menu', GuardCard as any)
}
