# 插件守护者（@yuri/dsh-plugin-guard）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

GitHub：https://github.com/kamioyuri/dsh-plugin-guard

一个用于 DeepSeek Harness（dsh）的**插件管理与安全清理插件**。支持查看、筛选插件；删除前强制评估依赖关系与运行状态；只有评估通过且用户在 dsh 审批界面确认后才执行清理；清理会彻底移除插件本体及关联的配置、缓存、注册信息与残留文件。

## 能力

提供五个工具：

| 工具 | 作用 | 风险 |
| --- | --- | --- |
| `plugin_guard_list` | 列出/筛选插件（按 `query` 关键字、`status` 状态）。展示启用态、是否可删、是否核心保护、依赖/被依赖、运行状态。 | 只读 |
| `plugin_guard_evaluate` | 对目标插件做删除前评估：核心保护、依赖方、运行状态、磁盘痕迹扫描，返回风险等级/阻断原因/清理清单预览 + 一次性评估令牌。`withScan:true` 可联动恶意扫描。 | 只读 |
| `plugin_guard_cleanup` | 执行清理。需评估令牌 + 用户在 dsh 审批界面点"允许"；执行前再次复核状态与风险。高风险目标需 `acknowledgeHighRisk:true`。 | 破坏性（有审批关卡） |
| `plugin_guard_scan` | **恶意行为静态扫描**：检测动态代码/子进程/网络外联/凭据访问/篡改核心配置/破坏性删除/混淆/环境变量收集等可疑特征，按插件返回名称、风险类型、等级与摘要。 | 只读 |
| `plugin_guard_menu` | **删除交互菜单**：`interactive:false` 返回可删列表数据源（卡片下拉菜单）；`interactive:true` 弹出两级菜单——先选插件、再确认（高风险额外确认），确认后自动走评估+清理。 | 交互（含破坏性，需两级确认） |

## 安全设计（五道闸门）

1. **核心保护名单**：内置 dsh 官方 17 项 `protectedModules` + 核心 profile 栈（dsh-base / web-app / headless 等）。命中即 `block`，无法删除。
2. **依赖图评估**：从各 bundle 的 `package.json`（dependencies / peerDependencies）自建依赖图。被核心/受保护插件依赖 → `block`；被启用方依赖或正在运行 → `warn`（需知情确认）。
3. **只读标记与不可删标记**：dsh 标记为 `management-required` 或 `removable=false` 的插件直接阻断。本插件自身永久自保护。
4. **评估令牌 + TOCTOU 防护**：评估签发一次性令牌（默认 5 分钟有效），绑定目标状态摘要；清理时重新扫描并重算摘要，状态变化/目标不符/重放一律中止。
5. **用户确认关卡**：`plugin_guard_cleanup` 注册 `tools/pre-execute` 审批关卡，返回 `kind:'ask'`，由 dsh 官方审批 UI（允许一次/拒绝）接管，只有 `allowed-once` 才真正执行。
6. **两级删除菜单**：`plugin_guard_menu {interactive:true}` 通过 dsh 原生 `userQuestions` 通道弹出两级菜单（选插件 → 确认删除），全部决策在 Node 端复用同一套评估/清理逻辑；无 answerer/超时/取消均优雅降级，不误删。
7. **扫描联动**：恶意扫描命中的高风险插件，删除菜单加警示并需额外二次确认；`evaluate {withScan:true}` 会标记 `requiresExtraConfirm`，此时 `cleanup` 必须显式传 `acknowledgeHighRisk:true`。

## 清理范围

- **本体**：调用官方 `ctx.pluginManager.removeBundle()`（复用 dsh 的文件锁、注册表追踪、HMR 串行化），不直接 `rm -rf node_modules`。
- **配置/注册残留**：`<profile>/cordis.patch.yml` 的目标条目、`<profile>/compatibility.json` 的版本豁免、`<profile>/pnpm-workspace.yaml` 的构建授权（修改前自动 `.bak-<ts>` 备份）。
- **缓存**：`$DSH_HOME/cache` 下按插件短名保守匹配并清理（可在 Config 关闭）。
- **旧投影**：`<profile>/.dsh-module-fallback`。
- **不自动删除**：`~/.dsh/cordis.patch.yml`（home 级，优先级高）中的引用仅提示，需用户手动确认。

> 运行态插件清理后通常需要重启 dsh 才完全生效。

## 使用流程（给模型/用户）

```
1. plugin_guard_list  → 确认目标插件名
2. plugin_guard_evaluate { targets:[...] }  → 查看 pass/阻断原因
   · pass=false：停止，向用户说明阻断原因，不得清理
   · pass=true：展示评估报告，征求用户明确同意
3. 用户同意后 plugin_guard_cleanup { token, targets:[...] }
   · 触发 dsh 审批界面，用户再次点"允许"后执行
   · 若评估带 withScan 且目标 requiresExtraConfirm：另传 acknowledgeHighRisk:true
```

**设置界面二级菜单（ plugin_guard_menu 工具卡片）**：
```
1. plugin_guard_menu  → 结果卡片展示"可删除插件列表"（含风险标记），即设置/卡片内的二级菜单数据源
2. 用户在卡片的下拉列表中选择插件 → 查看风险标记 → 二次确认
3. 确认后由工具链路执行评估 + 清理；高风险插件需额外确认
```

**设置界面原生菜单（推荐，不依赖对话）**：
```
打开 dsh 设置 → 左侧导航「插件守卫」(Plugin Guard)
   → 列表上方「搜索已安装插件」输入框：输入关键字（如 tui）实时过滤
   → 列出所有已安装插件（核心模块隐藏；不可卸载项显示但删除按钮禁用并注明原因）
   → 目标插件行点「删除」→ 二次确认弹窗 → 确认
   → 直接调用官方 ctx.remote.pluginManager.removeBundle()
   → 删除成功提示重启 dsh 生效；失败显示具体原因
```
> 该入口注册在 `settings.section`（id=`dsh-plugin-guard`），是 dsh 设置面板的一级 section，点开即为二级插件列表 + 顶部搜索框。删除走官方 Remote 端点，与 dsh 自带插件管理页的"卸载"完全同源。实测样本：`@deepseek-harness-tui/dsh-tui`——已通过搜索定位并成功删除（dependency、本体目录、lock 记录均已清除）。

**恶意行为扫描**：
```
plugin_guard_scan { targets?:[...] }
   · 留空扫描全部；返回每个插件的名称、风险类型、等级、摘要与命中明细
   · 静态启发式提示，非恶意定论，需人工判断
```

系统提示已注入该流程约束（`plugin-guard:policy`，order=2400）。

## 构建

环境：Node 22+、Python 3、npm 可达。

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build.ps1
```

build.ps1 依次执行：`npm install --legacy-peer-deps` → `python scripts/link_deps.py`（junction 链接宿主依赖，须在 npm install 之后）→ `npx tsdown`（Node ESM + 浏览器 CJS 单文件双端打包）→ 写 `lib/index.d.ts` → 自检（入口存在 / 无动态 import / ModuleLoader 包装）。

> 若 `link_deps.py` 提示缓存路径不符，设置环境变量 `DSH_CACHE` 指向含 `@deepseek-ai/*` 的 `node_modules`（默认本机 npx 缓存路径）。

## 安装到 profile

仓库已包含构建产物 `lib/`，clone 后可直接安装，无需 Node 构建环境：

```bash
git clone https://github.com/kamioyuri/dsh-plugin-guard.git
dsh plugin --profile <profile名> add file:<clone目录绝对路径>
# 重启 dsh 生效
```

从源码改代码重建后同步产物（file: 安装是复制，不感知更新）：

```bash
powershell -ExecutionPolicy Bypass -File scripts/build.ps1
python scripts/sync_profile.py <profile名>
```

在 cordis.patch.yml 中，本插件以 `plugin-guard` / `@yuri/dsh-plugin-guard` 声明 insert。

## 测试

```bash
npm test
# 或分别运行：
node --experimental-strip-types --test tests/fragment.test.ts     # 纯函数契约
node --experimental-strip-types --test tests/integration.test.ts  # 核心服务集成冒烟
```

## 贡献

欢迎 issue 与 PR。提交前请运行 `npm test` 并用 `scripts/build.ps1` 重建 `lib/`（仓库包含产物）。

## 许可证

[MIT](LICENSE) © yuri (kamioyuri)

## 项目结构

```
src/
  fragment.ts        三端共享纯函数契约（数据模型/风险判定/依赖图/摘要/meta 解析/扫描规则）
  guard.ts           Node 端核心服务（枚举/评估/令牌/清理/残留清扫/恶意扫描/askUser 菜单通道）
  tools.ts           五个 defineTool 定义（list/evaluate/cleanup/scan/menu）
  index.ts           apply 入口：注册工具/系统提示/审批关卡
  client/index.tsx   浏览器端 Toolview（清单/评估/清理三类卡片）
scripts/
  build.ps1          构建 + 自检
  link_deps.py       junction 链接 dsh 宿主依赖
  sync_profile.py    同步产物到已安装 profile
tests/
  fragment.test.ts   纯函数契约测试
  integration.test.ts 核心服务集成测试
```
