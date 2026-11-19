import { r as __toESM } from "./chunks/chunk.js";
import z from "@deepseek-ai/schemastery";
import { randomUUID } from "node:crypto";
import { copyFile, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { defineTool } from "@deepseek-ai/dsh-tools";

//#region src/fragment.ts
/**
* 共享契约层（纯函数，无 Node 内置模块，无副作用）。
* Node 端（guard/tools）、浏览器端（client）、测试三方共用。
* 职责：定义数据模型 + 钉死"数据怎么算"（风险判定 / 依赖图 / 摘要 / meta 解析）。
*/
const PLUGIN_ID = "plugin-guard";
/** dsh 内置核心模块保护名单（同步自 dsh-plugin-manager/lib/index.js 的 protectedModules）。
*  这些模块承载管理工具、Loader、API 网关等核心能力，删除会直接导致 dsh 崩溃。 */
const PROTECTED_MODULES = [
	"@deepseek-ai/dsh-plugin-manager",
	"@deepseek-ai/cordis-plugin-loader",
	"@deepseek-ai/cordis-plugin-include",
	"@deepseek-ai/dsh-api-gateway",
	"@deepseek-ai/dsh-host-webserver",
	"@deepseek-ai/dsh-client-modules",
	"@deepseek-ai/dsh-client-ui-settings-plugin-inventory",
	"@deepseek-ai/dsh-client-ui-plugin-manager",
	"@deepseek-ai/dsh-host-plugin-inventory",
	"@deepseek-ai/dsh-typert-registry",
	"@deepseek-ai/dsh-api-remotes",
	"@deepseek-ai/dsh-api-remote-access",
	"@deepseek-ai/cordis-plugin-timer",
	"@deepseek-ai/dsh-client-connection",
	"@deepseek-ai/dsh-host-frontend-static",
	"@deepseek-ai/dsh-tools",
	"@deepseek-ai/dsh-hmr"
];
/** 官方 profile 模板栈 —— 即使未被 protectedModules 命中，也属于"核心功能提供者"。 */
const CORE_STACK = [
	"@deepseek-ai/dsh-base",
	"@deepseek-ai/dsh-web-app",
	"@deepseek-ai/dsh-headless",
	"@deepseek-ai/dsh-acp-app",
	"@deepseek-ai/dsh-sdk-app",
	"@deepseek-ai/dsh-sdk-minimal"
];
/** 判断一个模块名是否命中核心保护名单 / 核心栈。 */
function isProtectedModule(name$1) {
	if (PROTECTED_MODULES.includes(name$1)) return true;
	if (CORE_STACK.includes(name$1)) return true;
	return false;
}
/** 规范化依赖边：去重、排序，保证摘要稳定。 */
function normalizeEdges(edges) {
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const e of edges) {
		const key = `${e.from}\u0000${e.to}\u0000${e.kind}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({
			from: e.from,
			to: e.to,
			kind: e.kind
		});
	}
	return out.sort((a, b) => (a.from + a.to + a.kind).localeCompare(b.from + b.to + b.kind));
}
/** 稳定序列化（键排序），用于摘要与令牌绑定。 */
function stableStringify(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const obj = value;
	return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
/** FNV-1a 32 位哈希（非安全用途，仅用于生成稳定的状态摘要；安全由令牌随机性保证）。 */
function fnv1a(input) {
	let h = 2166136261;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 16777619) >>> 0;
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}
/**
* 计算评估状态摘要。只对"会影响删除安全结论"的字段取摘要：
* 目标节点的关键属性 + 全部依赖边。评估时与 cleanup 时各算一次，
* 若不一致说明环境已变化（TOCTOU），必须中止。
*/
function assessmentDigest(targets, nodes, edges) {
	const keyNodes = nodes.filter((n) => targets.includes(n.name)).map((n) => ({
		name: n.name,
		bundle: n.bundle,
		enabled: n.enabled,
		removable: n.removable,
		readOnlyReason: n.readOnlyReason,
		official: n.official,
		optional: n.optional,
		started: n.started,
		fiberPhase: n.fiberPhase
	})).sort((a, b) => a.name.localeCompare(b.name));
	return fnv1a(stableStringify({
		targets: [...targets].sort(),
		nodes: keyNodes,
		edges: normalizeEdges(edges).filter((e) => targets.includes(e.from) || targets.includes(e.to))
	}));
}
/** 判断目标是否被某个"受保护的启用方"依赖 —— 这是删除会引发核心异常的最强信号。 */
function protectedDependent(target, edges, nodes) {
	const nodeByName = new Map(nodes.map((n) => [n.name, n]));
	for (const e of edges) {
		if (e.to !== target) continue;
		const dep = nodeByName.get(e.from);
		if (!dep) continue;
		if (isProtectedModule(dep.name) || dep.optional || dep.official) {
			if (dep.enabled) return dep.name;
		}
	}
	return null;
}
/** 汇总目标的依赖方（谁依赖它），带保护/启用标记，供评估展示。 */
function dependentsOf(target, edges, nodes) {
	const nodeByName = new Map(nodes.map((n) => [n.name, n]));
	const refs = [];
	for (const e of edges) {
		if (e.to !== target) continue;
		const dep = nodeByName.get(e.from);
		refs.push({
			name: e.from,
			kind: e.kind,
			enabled: dep?.enabled ?? false,
			protected: isProtectedModule(e.from) || dep?.optional === true
		});
	}
	return refs.sort((a, b) => a.name.localeCompare(b.name));
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
function assessTarget(input) {
	const { name: name$1, node, edges, nodes } = input;
	const reasons = [];
	const blockers = [];
	const dependents = node ? dependentsOf(name$1, edges, nodes) : [];
	if (!node) return {
		name: name$1,
		scope: "unknown",
		risk: "block",
		verdict: "block",
		reasons: ["未找到该插件，可能名称不正确或已被卸载。"],
		blockers: ["target-not-found"],
		dependents: [],
		running: false,
		plan: emptyPlan(name$1)
	};
	const protectedHit = isProtectedModule(name$1) || node.readOnlyReason === "management-required";
	let scope;
	if (protectedHit) scope = "protected";
	else if (node.official && node.optional) scope = "optional";
	else if (node.official) scope = "core";
	else if (node.name.startsWith("@deepseek-ai/")) scope = "core";
	else scope = "third-party";
	if (protectedHit) {
		blockers.push("protected-module");
		reasons.push("该插件属于 dsh 核心/管理模块，删除会导致 dsh 崩溃或核心功能失效。");
	}
	if (node.readOnlyReason === "management-required") {
		if (!blockers.includes("protected-module")) blockers.push("management-required");
		if (!reasons.some((r) => r.includes("只读"))) reasons.push("该插件由 dsh 管理器标记为只读，禁止通过清理工具删除。");
	}
	if (!node.removable && !protectedHit) {
		blockers.push("not-removable");
		reasons.push("dsh 判定该插件不可卸载（可能为内置或安装型 bundle）。");
	}
	const hardDep = protectedDependent(name$1, edges, nodes);
	if (hardDep) {
		blockers.push("required-by-core");
		reasons.push(`仍被核心/受保护插件「${hardDep}」依赖，删除会引发核心功能异常。`);
	}
	const activeDependents = dependents.filter((d) => d.enabled && !d.protected);
	if (activeDependents.length > 0 && blockers.length === 0) reasons.push(`被 ${activeDependents.length} 个启用中的插件依赖：${activeDependents.map((d) => d.name).join("、")}。删除后这些插件将失去依赖。`);
	const running = node.started || node.fiberPhase !== null && node.fiberPhase !== "disposed";
	if (running && blockers.length === 0) reasons.push("该插件当前处于运行/已加载状态，清理后通常需要重启 dsh 才会完全生效。");
	if (node.hasError && blockers.length === 0) reasons.push("该插件当前存在加载错误，清理时需一并移除其错误配置残留。");
	let risk;
	if (blockers.length > 0) risk = "block";
	else if (activeDependents.length > 0 || running) risk = "warn";
	else risk = "ok";
	if (blockers.length === 0 && reasons.length === 0) reasons.push("未发现核心依赖冲突；该插件可被安全清理。");
	return {
		name: name$1,
		scope,
		risk,
		verdict: blockers.length > 0 ? "block" : "pass",
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
			skipped: input.skipped
		}
	};
}
function emptyPlan(name$1) {
	return {
		bundles: [],
		modules: [name$1],
		configEntries: [],
		cachePaths: [],
		residualPaths: [],
		skipped: []
	};
}
function guardMetaFrom(meta) {
	if (typeof meta !== "object" || meta === null) return void 0;
	const m = meta;
	if (m.kind !== "plugin-guard-list" && m.kind !== "plugin-guard-evaluate" && m.kind !== "plugin-guard-cleanup" && m.kind !== "plugin-guard-scan" && m.kind !== "plugin-guard-menu") return;
	return {
		kind: m.kind,
		rows: Array.isArray(m.rows) ? m.rows : [],
		summary: typeof m.summary === "string" ? m.summary : "",
		pass: typeof m.pass === "boolean" ? m.pass : void 0
	};
}
/**
* 检测规则表。刻意保持"宽粒度、低误报承诺"：
* 命中只表示"存在该特征"，是否恶意需人工判断。
* 使用字符串形式存储 pattern 以便跨端安全序列化，运行时编译。
*/
const SCAN_RULES = [
	{
		id: "eval",
		category: "dynamic-code",
		severity: "high",
		source: "\\beval\\s*\\(",
		flags: "g",
		label: "使用 eval 动态执行代码"
	},
	{
		id: "new-func",
		category: "dynamic-code",
		severity: "high",
		source: "new\\s+Function\\s*\\(",
		flags: "g",
		label: "使用 new Function 动态构造代码"
	},
	{
		id: "vm-run",
		category: "dynamic-code",
		severity: "medium",
		source: "\\bvm\\.(runIn|compileFunction|Script)",
		flags: "g",
		label: "使用 vm 沙箱执行代码"
	},
	{
		id: "child-exec",
		category: "child-process",
		severity: "high",
		source: "\\b(exec|execSync|spawn|spawnSync|fork)\\s*\\(",
		flags: "g",
		label: "调用子进程执行命令"
	},
	{
		id: "shell-true",
		category: "child-process",
		severity: "high",
		source: "shell\\s*:\\s*true",
		flags: "g",
		label: "以 shell 方式执行命令"
	},
	{
		id: "fetch-egress",
		category: "network-egress",
		severity: "medium",
		source: "\\bfetch\\s*\\(\\s*[\"'`]https?://",
		flags: "g",
		label: "向外部 URL 发起网络请求"
	},
	{
		id: "http-request",
		category: "network-egress",
		severity: "medium",
		source: "\\b(https?|net)\\.(request|get|connect)\\s*\\(",
		flags: "g",
		label: "发起 HTTP/Socket 外联"
	},
	{
		id: "credential-file",
		category: "credential-access",
		severity: "high",
		source: "\\.credentials|credentials\\.ya?ml|id_rsa|\\.ssh[\\\\/]",
		flags: "gi",
		label: "访问凭据或私钥文件"
	},
	{
		id: "secret-env",
		category: "credential-access",
		severity: "medium",
		source: "process\\.env\\.[A-Z_]*(TOKEN|SECRET|KEY|PASSWORD)",
		flags: "g",
		label: "读取密钥类环境变量"
	},
	{
		id: "core-patch",
		category: "core-tamper",
		severity: "high",
		source: "cordis\\.patch\\.ya?ml",
		flags: "gi",
		label: "引用/改写 dsh 核心 patch 配置"
	},
	{
		id: "node-modules-write",
		category: "core-tamper",
		severity: "medium",
		source: "node_modules[\\\\/]",
		flags: "g",
		label: "直接操作 node_modules 目录"
	},
	{
		id: "rm-recursive",
		category: "fs-destructive",
		severity: "high",
		source: "\\brm\\s*\\([^)]*recursive\\s*:\\s*true",
		flags: "g",
		label: "递归删除目录"
	},
	{
		id: "atob",
		category: "obfuscation",
		severity: "medium",
		source: "\\batob\\s*\\(",
		flags: "g",
		label: "使用 atob 解码（常见于混淆载荷）"
	},
	{
		id: "long-b64",
		category: "obfuscation",
		severity: "low",
		source: "[A-Za-z0-9+/]{120,}={0,2}",
		flags: "g",
		label: "出现超长 base64 字符串"
	},
	{
		id: "env-harvest",
		category: "env-harvest",
		severity: "medium",
		source: "Object\\.keys\\s*\\(\\s*process\\.env",
		flags: "g",
		label: "枚举全部环境变量"
	}
];
/** 编译规则表（每次调用现编译，避免模块级 RegExp 的 lastIndex 状态污染）。 */
function compileRules() {
	return SCAN_RULES.map((r) => ({
		id: r.id,
		category: r.category,
		severity: r.severity,
		label: r.label,
		pattern: new RegExp(r.source, r.flags.includes("g") ? r.flags : r.flags + "g")
	}));
}
/** 对单段文本运行所有规则，返回命中项（每规则每文件最多记录 3 处，避免爆炸）。 */
function analyzeText(text, maxPerRule = 3) {
	const hits = [];
	const lines = text.split(/\r?\n/);
	for (const rule of compileRules()) {
		rule.pattern.lastIndex = 0;
		let match;
		let count = 0;
		while ((match = rule.pattern.exec(text)) !== null && count < maxPerRule) {
			const line = text.slice(0, match.index).split("\n").length;
			const raw = lines[line - 1] ?? "";
			hits.push({
				ruleId: rule.id,
				category: rule.category,
				severity: rule.severity,
				label: rule.label,
				line,
				excerpt: raw.trim().slice(0, 160)
			});
			count++;
			if (match[0].length === 0) rule.pattern.lastIndex++;
		}
	}
	return hits;
}
/** 由命中项推导整体风险等级。 */
function scanLevelOf(hits) {
	if (hits.length === 0) return "clean";
	if (hits.some((h) => h.severity === "high")) return "high";
	if (hits.some((h) => h.severity === "medium")) return "medium";
	return "low";
}
/** 去重分类列表。 */
function categoriesOf(hits) {
	return [...new Set(hits.map((h) => h.category))].sort();
}
/** 生成扫描摘要（不含具体行内容，避免泄露敏感串）。 */
function summarizeScan(name$1, hits, filesScanned, error) {
	if (error) return `${name$1}: 扫描异常（${error}），结果不完整。`;
	const level = scanLevelOf(hits);
	if (level === "clean") return `${name$1}: 扫描 ${filesScanned} 个文件，未发现可疑特征。`;
	const cats = categoriesOf(hits);
	return `${name$1}: 扫描 ${filesScanned} 个文件，发现 ${hits.length} 处可疑特征（${{
		clean: "干净",
		low: "低风险",
		medium: "中风险",
		high: "高风险",
		error: "异常"
	}[level]}），类别：${cats.join("、")}。仅为静态启发式提示，非恶意定论。`;
}
/** 扫描命中是否达到"高风险"——用于与删除流程联动（需额外二次确认）。 */
function isHighRisk(result) {
	return result.level === "high";
}

//#endregion
//#region src/guard.ts
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
/** 本插件自身 —— 永不删除，否则审计能力自我解除。 */
const SELF_PROTECT = new Set(["@yuri/dsh-plugin-guard", "plugin-guard"]);
const DEFAULT_CONFIG = {
	tokenTtlMs: 300 * 1e3,
	cacheMatchMinLength: 5,
	sweepCache: true,
	backupBeforeWrite: true,
	scanMaxFiles: 200,
	scanMaxFileBytes: 512 * 1024
};
function toShortName(pkg) {
	return pkg.startsWith("@") ? pkg.split("/")[1] ?? pkg : pkg;
}
function errMsg(e) {
	return e instanceof Error ? e.message : String(e);
}
/** 简易串行锁：避免与 dsh 自带 manager 及并发 cleanup 竞争写同一 profile 文件。 */
var Mutex = class {
	tail = Promise.resolve();
	async run(fn) {
		const prev = this.tail;
		let release;
		this.tail = new Promise((r) => {
			release = r;
		});
		await prev;
		try {
			return await fn();
		} finally {
			release();
		}
	}
};
var PluginGuard = class {
	ctx;
	config;
	tokens = /* @__PURE__ */ new Map();
	mutex = new Mutex();
	constructor(ctx, config = {}) {
		this.ctx = ctx;
		this.config = {
			...DEFAULT_CONFIG,
			...config
		};
	}
	/** 插件管理器服务是否可用。 */
	managerAvailable() {
		return typeof this.ctx.pluginManager?.listBundles === "function";
	}
	dshHome() {
		const explicit = process.env.DSH_HOME;
		if (explicit && explicit.trim() !== "") return resolve(explicit);
		return join(homedir(), ".dsh");
	}
	profileDir() {
		return this.ctx.profileContext?.dir || join(this.dshHome(), "profiles", "web");
	}
	/**
	* 枚举插件与 bundle，构建节点与依赖边。
	* 任何一步失败都降级为可用的子集，绝不因单个插件读取失败而整体崩溃。
	*/
	async scan() {
		const warnings = [];
		if (!this.managerAvailable()) throw new Error("插件管理不可用：未检测到 ctx.pluginManager 服务。请在包含 dsh-plugin-manager 的 profile（如 web/headless）中运行本插件。");
		let bundles = [];
		let plugins = [];
		try {
			bundles = await this.ctx.pluginManager.listBundles();
		} catch (e) {
			warnings.push(`listBundles 失败：${errMsg(e)}`);
		}
		try {
			plugins = await this.ctx.pluginManager.listPlugins();
		} catch (e) {
			warnings.push(`listPlugins 失败：${errMsg(e)}`);
		}
		const started = new Set(this.ctx.profileContext?.startedBundles ?? []);
		const pluginByName = /* @__PURE__ */ new Map();
		for (const p of plugins) {
			const n = String(p.moduleName ?? p.name ?? "");
			if (n) pluginByName.set(n, p);
		}
		const nodes = [];
		for (const b of bundles) {
			const name$1 = String(b.name ?? "");
			if (!name$1) continue;
			const firstModule = (Array.isArray(b.rows) ? b.rows : []).find((r) => r && r.moduleName)?.moduleName ?? name$1;
			const nodeInfo = pluginByName.get(name$1) ?? pluginByName.get(String(firstModule));
			const fiberPhase = nodeInfo?.fiberPhase ?? null;
			nodes.push({
				id: nodeInfo?.patchId ?? nodeInfo?.entryId ?? null,
				name: name$1,
				bundle: name$1,
				enabled: Boolean(nodeInfo?.enabled ?? b.enabled),
				removable: b.removable !== false,
				fiberPhase,
				started: started.has(name$1) || fiberPhase !== null && fiberPhase !== "disposed" && fiberPhase !== "stopped",
				dependencies: [],
				dependents: [],
				readOnlyReason: nodeInfo?.readOnlyReason ?? b.readOnlyReason ?? null,
				official: Boolean(b.official),
				optional: Boolean(b.optional),
				hasError: b.error !== void 0 && b.error !== null
			});
		}
		const nameSet = new Set(nodes.map((n) => n.name));
		const edges = [];
		const profile = this.profileDir();
		for (const node of nodes) {
			const deps = await this.readDependencyNames(node.name, profile);
			node.dependencies = deps;
			for (const dep of deps) {
				if (!nameSet.has(dep)) continue;
				edges.push({
					from: node.name,
					to: dep,
					kind: "package"
				});
			}
		}
		for (const node of nodes) node.dependents = dependentsOf(node.name, edges, nodes).map((d) => d.name);
		return {
			nodes,
			edges: normalizeEdges(edges),
			warnings
		};
	}
	/** 读取某个 bundle 包的 package.json 依赖名。 */
	async readDependencyNames(bundleName, profileDir) {
		const candidates = [join(profileDir, "node_modules", ...bundleName.split("/")), this.ctx.profileContext?.installAnchor ? join(this.ctx.profileContext.installAnchor, "node_modules", ...bundleName.split("/")) : ""].filter(Boolean);
		for (const dir of candidates) try {
			const raw = await readFile(join(dir, "package.json"), "utf8");
			const pkg = JSON.parse(raw);
			const deps = {
				...pkg.dependencies ?? {},
				...pkg.peerDependencies ?? {}
			};
			return Object.keys(deps);
		} catch {}
		return [];
	}
	/** 解析插件包目录（与 readDependencyNames 同一套锚点）。 */
	async pluginDir(name$1) {
		const candidates = [join(this.profileDir(), "node_modules", ...name$1.split("/")), this.ctx.profileContext?.installAnchor ? join(this.ctx.profileContext.installAnchor, "node_modules", ...name$1.split("/")) : ""].filter(Boolean);
		for (const dir of candidates) try {
			await stat(dir);
			return dir;
		} catch {}
		return null;
	}
	/**
	* 恶意行为静态扫描（只读）。扫描目标插件包内的源码/配置文件，
	* 用纯函数契约 analyzeText 匹配可疑特征，按风险类型分级输出摘要。
	* 边界：目录不可读/文件过大均降级处理，单个插件异常不影响其它插件与整体扫描。
	*/
	async scanPlugins(targets) {
		const { nodes } = await this.scan();
		let names;
		if (targets && targets.length > 0) names = targets.filter((t) => typeof t === "string" && t.trim() !== "");
		else names = nodes.map((n) => n.name);
		const results = [];
		for (const name$1 of [...new Set(names)]) results.push(await this.scanOnePlugin(name$1));
		return results;
	}
	/** 扫描单个插件。 */
	async scanOnePlugin(name$1) {
		const dir = await this.pluginDir(name$1);
		if (!dir) return {
			name: name$1,
			level: "error",
			categories: [],
			hits: [],
			filesScanned: 0,
			summary: summarizeScan(name$1, [], 0, "未找到插件目录（可能是内置模块或名称不匹配）"),
			error: "plugin-directory-not-found"
		};
		const EXT_OK = /\.(js|cjs|mjs|ts|tsx|jsx|json|ya?ml|md|sh|ps1)$/i;
		const SKIP_DIRS = new Set([
			"node_modules",
			".git",
			"dist",
			"coverage",
			"cache"
		]);
		const hits = [];
		let filesScanned = 0;
		let scanError;
		try {
			const queue = [dir];
			while (queue.length > 0 && filesScanned < this.config.scanMaxFiles) {
				const cur = queue.shift();
				let entries = [];
				try {
					entries = await readdir(cur, { withFileTypes: true });
				} catch (e) {
					scanError = `无法读取目录 ${basename(cur)}：${e.message}`;
					continue;
				}
				for (const ent of entries) {
					if (filesScanned >= this.config.scanMaxFiles) break;
					const full = join(cur, ent.name);
					if (ent.isDirectory()) {
						if (!SKIP_DIRS.has(ent.name)) queue.push(full);
						continue;
					}
					if (!ent.isFile() || !EXT_OK.test(ent.name)) continue;
					try {
						if ((await stat(full)).size > this.config.scanMaxFileBytes) continue;
						const text = await readFile(full, "utf8");
						filesScanned++;
						const rel = full.slice(dir.length + 1);
						for (const h of analyzeText(text)) hits.push({
							...h,
							excerpt: `[${rel}:${h.line}] ${h.excerpt}`
						});
					} catch {}
				}
			}
		} catch (e) {
			scanError = `扫描中断：${e.message}`;
		}
		return {
			name: name$1,
			level: scanError && hits.length === 0 ? "error" : scanLevelOf(hits),
			categories: categoriesOf(hits),
			hits,
			filesScanned,
			summary: summarizeScan(name$1, hits, filesScanned, scanError),
			...scanError ? { error: scanError } : {}
		};
	}
	/** 查询某插件是否被扫描判为高风险（供删除联动；未扫描过返回 false）。 */
	isHighRiskScanned(result) {
		return result !== void 0 && isHighRisk(result);
	}
	/**
	* 通过 dsh 原生 userQuestions 通道向用户发起选择菜单（浏览器端渲染可点击选项）。
	* 返回用户选择的 label 列表；任何异常（无 answerer / 无 agent / 超时 / 取消）都返回空数组，
	* 由调用方优雅降级，不抛出。
	*/
	async askUser(questions, exec) {
		const uq = this.ctx.userQuestions;
		if (!uq || typeof uq.ask !== "function") return {};
		try {
			const answer = await uq.ask({
				questions: questions.map((q) => ({
					id: q.id,
					question: q.question,
					...q.detail !== void 0 ? { detail: q.detail } : {},
					...q.header !== void 0 ? { header: q.header } : {},
					...q.options !== void 0 ? { options: q.options } : {},
					...q.multiSelect !== void 0 ? { multiSelect: q.multiSelect } : {}
				})),
				...exec?.agent !== void 0 ? { agent: exec.agent } : {},
				...exec?.signal !== void 0 ? { signal: exec.signal } : {}
			});
			const out = {};
			for (const a of answer?.answers ?? []) out[a.id] = [...a.selected ?? []];
			return out;
		} catch {
			return {};
		}
	}
	/** 列出插件（供 plugin_guard_list）。 */
	async list(filter = {}) {
		const { nodes, edges, warnings } = await this.scan();
		const q = (filter.query ?? "").trim().toLowerCase();
		const status = filter.status ?? "all";
		const rows = [];
		for (const n of nodes) {
			if (q && !n.name.toLowerCase().includes(q) && !(n.bundle ?? "").toLowerCase().includes(q)) continue;
			const protectedHit = isProtectedModule(n.name) || SELF_PROTECT.has(n.name) || n.readOnlyReason === "management-required";
			let scope;
			if (protectedHit) scope = "protected";
			else if (n.official && n.optional) scope = "optional";
			else if (n.official || n.name.startsWith("@deepseek-ai/")) scope = "core";
			else scope = "third-party";
			const statusKey = protectedHit ? "protected" : n.enabled ? "enabled" : "disabled";
			if (status === "removable" && (protectedHit || !n.removable)) continue;
			if (status === "core" && scope !== "core" && scope !== "protected") continue;
			if (status === "enabled" && !n.enabled) continue;
			if (status === "disabled" && n.enabled) continue;
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
				status: statusKey
			});
		}
		rows.sort((a, b) => a.name.localeCompare(b.name));
		return {
			rows,
			warnings
		};
	}
	/** 评估待删插件（只读，不改任何状态），并签发令牌。
	*  withScan=true 时对目标做恶意行为静态扫描，高风险目标会被要求额外二次确认。 */
	async evaluate(targetNames, withScan = false) {
		const targets = [...new Set(targetNames.map((t) => t.trim()).filter(Boolean))];
		if (targets.length === 0) throw new Error("evaluate：targets 不能为空，请指定至少一个待评估插件。");
		const { nodes, edges, warnings } = await this.scan();
		const profile = this.profileDir();
		const assessments = [];
		const highRiskTargets = [];
		const scanResults = withScan ? await this.scanPlugins(targets) : [];
		const scanByName = new Map(scanResults.map((r) => [r.name, r]));
		for (const name$1 of targets) {
			let node = nodes.find((n) => n.name === name$1);
			if (!node) {
				const alias = nodes.find((n) => (n.id ?? "") === name$1 || toShortName(n.name) === name$1);
				if (alias) node = alias;
			}
			const scan = await this.scanPluginArtifacts(name$1, node, profile);
			const assessment = assessTarget({
				name: name$1,
				node,
				edges,
				nodes,
				cachePaths: scan.cachePaths,
				configEntries: scan.configEntries,
				residualPaths: scan.residualPaths,
				skipped: scan.skipped
			});
			if (SELF_PROTECT.has(name$1) && assessment.verdict !== "block") {
				assessment.verdict = "block";
				assessment.risk = "block";
				assessment.blockers.push("self-protect");
				assessment.reasons.push("该插件是\"插件守护者\"自身，禁止删除以保护审计能力。");
			}
			const scanResult = scanByName.get(name$1);
			if (scanResult) {
				assessment.scan = scanResult;
				if (isHighRisk(scanResult) && assessment.verdict !== "block") {
					assessment.requiresExtraConfirm = true;
					if (assessment.risk !== "block") assessment.risk = "warn";
					assessment.reasons.push(`⚠ 恶意行为扫描命中 ${scanResult.hits.length} 处高风险特征（${scanResult.categories.join("、")}），删除时必须额外二次确认。扫描仅为静态启发式提示，非恶意定论。`);
					highRiskTargets.push(name$1);
				}
			}
			assessments.push(assessment);
		}
		const digest = assessmentDigest(targets, nodes, edges);
		const report = {
			digest,
			targets: assessments,
			pass: assessments.every((a) => a.verdict === "pass"),
			createdAt: Date.now()
		};
		const token = randomUUID();
		this.tokens.set(token, {
			id: token,
			digest,
			targets,
			createdAt: Date.now(),
			consumed: false,
			highRiskTargets
		});
		this.pruneTokens();
		return {
			report,
			token,
			warnings
		};
	}
	pruneTokens() {
		const now = Date.now();
		for (const [id, t] of this.tokens) if (now - t.createdAt > this.config.tokenTtlMs) this.tokens.delete(id);
	}
	/**
	* 清理执行。三重校验：令牌存在未消费未过期 + targets 一致 + 重新扫描摘要一致（TOCTOU）。
	* 任一评估结论为 block 直接中止；不通过官方审批时本函数根本不会被工具层调用。
	*/
	async cleanup(token, targets, acknowledgeHighRisk = false) {
		if (!token || token.trim() === "") return {
			ok: false,
			steps: [],
			message: "缺少评估令牌：请先调用 plugin_guard_evaluate 获取令牌，再执行清理。"
		};
		this.pruneTokens();
		const record = this.tokens.get(token);
		if (!record) return {
			ok: false,
			steps: [],
			message: "评估令牌无效或已过期：请重新执行评估。"
		};
		if (record.consumed) return {
			ok: false,
			steps: [],
			message: "该评估令牌已被使用（防重放）：请重新执行评估。"
		};
		const want = [...new Set(targets.map((t) => t.trim()).filter(Boolean))].sort();
		const got = [...record.targets].sort();
		if (JSON.stringify(want) !== JSON.stringify(got)) return {
			ok: false,
			steps: [],
			message: "清理目标与评估令牌绑定的目标不一致：请重新评估本次目标。"
		};
		const risky = record.highRiskTargets.filter((t) => want.includes(t));
		if (risky.length > 0 && acknowledgeHighRisk !== true) return {
			ok: false,
			steps: [],
			message: `目标 ${risky.join("、")} 在扫描中命中高风险可疑特征，需再次确认：请在清理参数中显式设置 acknowledgeHighRisk=true（确认你已了解静态扫描仅为启发式提示）。未确认前已中止。`
		};
		return this.mutex.run(async () => {
			const { nodes, edges } = await this.scan();
			if (assessmentDigest(want, nodes, edges) !== record.digest) return {
				ok: false,
				steps: [],
				message: "目标插件状态在评估后发生变化（启用状态/依赖已改变），为防止误删已中止。请重新评估后再清理。"
			};
			const reReport = await this.buildReport(want, nodes, edges);
			const blocked = reReport.targets.filter((t) => t.verdict === "block");
			if (blocked.length > 0) return {
				ok: false,
				steps: [],
				message: `清理前复核发现 ${blocked.length} 个目标存在阻断风险：${blocked.map((b) => `${b.name}（${b.blockers.join("/")}）`).join("；")}。已中止。`
			};
			record.consumed = true;
			const steps = [];
			for (const assessment of reReport.targets) steps.push(await this.cleanupOne(assessment));
			const ok = steps.every((s) => s.ok);
			return {
				ok,
				steps,
				message: ok ? `已彻底清理 ${steps.length} 个插件。部分运行态插件需重启 dsh 后才会完全生效。` : `清理完成但存在失败项，请查看各目标详情。`
			};
		});
	}
	/** 基于已扫描的节点/边重建报告（cleanup 复核用，不重复签发令牌）。 */
	async buildReport(targets, nodes, edges) {
		const profile = this.profileDir();
		const assessments = [];
		for (const name$1 of targets) {
			let node = nodes.find((n) => n.name === name$1) ?? nodes.find((n) => (n.id ?? "") === name$1 || toShortName(n.name) === name$1);
			const a = assessTarget({
				name: name$1,
				node,
				edges,
				nodes,
				...await this.scanPluginArtifacts(name$1, node, profile)
			});
			if (SELF_PROTECT.has(name$1) && a.verdict !== "block") {
				a.verdict = "block";
				a.risk = "block";
				a.blockers.push("self-protect");
				a.reasons.push("该插件是插件守护者自身，禁止删除。");
			}
			assessments.push(a);
		}
		return {
			digest: assessmentDigest(targets, nodes, edges),
			targets: assessments,
			pass: assessments.every((a) => a.verdict === "pass"),
			createdAt: Date.now()
		};
	}
	/** 扫描某插件在磁盘上的配置/缓存/残留痕迹（只读）。 */
	async scanPluginArtifacts(name$1, node, profile) {
		const short = toShortName(name$1);
		const cachePaths = [];
		const configEntries = [];
		const residualPaths = [];
		const skipped = [];
		const patchPath = join(profile, "cordis.patch.yml");
		if (await exists(patchPath)) {
			const txt = await safeRead(patchPath);
			if (txt && (txt.includes(name$1) || txt.includes(short))) configEntries.push(`cordis.patch.yml 中引用「${name$1}」的条目`);
		}
		const compatPath = join(profile, "compatibility.json");
		if (await exists(compatPath)) {
			const txt = await safeRead(compatPath);
			if (txt && (txt.includes(name$1) || txt.includes(short))) configEntries.push(`compatibility.json 中「${name$1}」的版本豁免`);
		}
		const wsPath = join(profile, "pnpm-workspace.yaml");
		if (await exists(wsPath)) {
			const txt = await safeRead(wsPath);
			if (txt && txt.includes(name$1)) configEntries.push(`pnpm-workspace.yaml 中「${name$1}」的构建授权`);
		}
		if (await exists(join(profile, ".dsh-module-fallback"))) residualPaths.push(".dsh-module-fallback（旧模块投影，可能关联多个插件）");
		if (this.config.sweepCache && short.length >= this.config.cacheMatchMinLength) {
			const cacheRoot = join(this.dshHome(), "cache");
			try {
				const found = await findMatchingPaths(cacheRoot, short, 30);
				cachePaths.push(...found.map((p) => p.replace(cacheRoot + sep, "")));
			} catch {}
		}
		const homePatch = join(this.dshHome(), "cordis.patch.yml");
		if (await exists(homePatch)) {
			const txt = await safeRead(homePatch);
			if (txt && (txt.includes(name$1) || txt.includes(short))) skipped.push(`~/.dsh/cordis.patch.yml 中「${name$1}」的引用（home 级配置，优先级高，未自动删除，请手动确认）`);
		}
		return {
			cachePaths,
			configEntries,
			residualPaths,
			skipped
		};
	}
	/** 执行单个插件的清理：官方卸载 + 后置清扫。 */
	async cleanupOne(a) {
		const step = {
			target: a.name,
			ok: true,
			phases: [],
			errors: [],
			warnings: [...a.reasons.filter((r) => a.risk === "warn")]
		};
		const profile = this.profileDir();
		const plan = a.plan;
		for (const bundle of plan.bundles) try {
			const result = await this.ctx.pluginManager.removeBundle(bundle);
			if (result && result.error) step.errors.push(`官方卸载 ${bundle} 返回错误：${formatUnknown(result.error)}`);
			else step.phases.push(`官方卸载 bundle「${bundle}」完成`);
			if (result && result.restartReason) step.warnings.push(`需要重启：${String(result.restartReason)}`);
		} catch (e) {
			step.errors.push(`官方卸载 ${bundle} 失败：${errMsg(e)}`);
		}
		if (plan.bundles.length === 0) step.warnings.push("该插件未关联可卸载的 bundle，已跳过本体卸载，仅执行痕迹清扫。");
		if (a.scope !== "protected") {
			await this.sweepConfigFiles(a.name, profile, step);
			if (this.config.sweepCache) await this.sweepCache(a.name, plan.cachePaths, step);
		} else step.warnings.push("受保护目标未执行任何文件清扫。");
		for (const s of plan.skipped) step.warnings.push(s);
		step.ok = step.errors.length === 0;
		return step;
	}
	/** 清扫 profile 内针对目标的配置/注册残留。使用 yaml 库做注释保留的精确删除。 */
	async sweepConfigFiles(name$1, profile, step) {
		const short = toShortName(name$1);
		const patchPath = join(profile, "cordis.patch.yml");
		if (await exists(patchPath)) try {
			const raw = await readFile(patchPath, "utf8");
			const doc = (await import("./chunks/dist.js").then((m) => /* @__PURE__ */ __toESM(m.default, 1))).parseDocument(raw);
			const seq = doc.contents;
			if (seq && Array.isArray(seq.items)) {
				const before = seq.items.length;
				seq.items = seq.items.filter((item) => {
					const text = JSON.stringify(item?.toJSON ? item.toJSON() : item);
					return !(text.includes(`"${name$1}"`) || text.includes(`"${short}"`));
				});
				if (seq.items.length !== before) {
					await this.writeWithBackup(patchPath, doc.toString());
					step.phases.push(`cordis.patch.yml 移除 ${before - seq.items.length} 条目标条目`);
				}
			}
		} catch (e) {
			step.errors.push(`清理 cordis.patch.yml 失败：${errMsg(e)}`);
		}
		const compatPath = join(profile, "compatibility.json");
		if (await exists(compatPath)) try {
			const raw = await readFile(compatPath, "utf8");
			const json = JSON.parse(raw);
			let changed = false;
			for (const key of Object.keys(json)) if (key === name$1 || key.startsWith(`${name$1}@`) || key === short) {
				delete json[key];
				changed = true;
			}
			if (changed) {
				await this.writeWithBackup(compatPath, JSON.stringify(json, null, 2) + "\n");
				step.phases.push("compatibility.json 移除目标版本豁免");
			}
		} catch (e) {
			step.errors.push(`清理 compatibility.json 失败：${errMsg(e)}`);
		}
		const wsPath = join(profile, "pnpm-workspace.yaml");
		if (await exists(wsPath)) try {
			const raw = await readFile(wsPath, "utf8");
			const doc = (await import("./chunks/dist.js").then((m) => /* @__PURE__ */ __toESM(m.default, 1))).parseDocument(raw);
			const allow = doc.getIn(["allowBuilds"]);
			let changed = false;
			if (allow && typeof allow === "object" && "items" in allow) {
				const before = allow.items.length;
				allow.items = allow.items.filter((it) => {
					const k = String(it?.key ?? "");
					return k !== name$1 && k !== short;
				});
				changed = allow.items.length !== before;
			}
			if (changed) {
				await this.writeWithBackup(wsPath, doc.toString());
				step.phases.push("pnpm-workspace.yaml 移除目标构建授权");
			}
		} catch (e) {
			step.errors.push(`清理 pnpm-workspace.yaml 失败：${errMsg(e)}`);
		}
	}
	async sweepCache(name$1, cachePaths, step) {
		const cacheRoot = join(this.dshHome(), "cache");
		let removed = 0;
		for (const rel of cachePaths) {
			const abs = resolve(cacheRoot, rel);
			if (!abs.startsWith(cacheRoot + sep)) continue;
			try {
				await rm(abs, {
					recursive: true,
					force: true
				});
				removed++;
			} catch (e) {
				step.warnings.push(`缓存清理跳过 ${rel}：${errMsg(e)}`);
			}
		}
		if (removed > 0) step.phases.push(`清理 ${removed} 处关联缓存（DSH_HOME/cache）`);
	}
	async writeWithBackup(path, content) {
		if (this.config.backupBeforeWrite && await exists(path)) try {
			await copyFile(path, `${path}.bak-${Date.now()}`);
		} catch {}
		await writeFile(path, content, "utf8");
	}
};
async function exists(p) {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}
async function safeRead(p) {
	try {
		return await readFile(p, "utf8");
	} catch {
		return null;
	}
}
/** 递归查找名称包含 needle 的路径（限制数量，保守匹配）。 */
async function findMatchingPaths(root, needle, limit) {
	const out = [];
	async function walk(dir, depth) {
		if (out.length >= limit || depth > 4) return;
		let entries = [];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (out.length >= limit) break;
			const full = join(dir, e.name);
			if (e.name.toLowerCase().includes(needle.toLowerCase())) {
				out.push(full);
				continue;
			}
			if (e.isDirectory()) await walk(full, depth + 1);
		}
	}
	await walk(root, 0);
	return out;
}
function formatUnknown(v) {
	if (v instanceof Error) return v.message;
	if (typeof v === "string") return v;
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}

//#endregion
//#region src/tools.ts
/**
* 三个工具的 defineTool 定义。
*  - plugin_guard_list：查看/筛选插件
*  - plugin_guard_evaluate：删除前评估（只读），返回评估令牌
*  - plugin_guard_cleanup：执行清理（需评估令牌 + 官方审批 UI 确认）
*
* 注意 dsh 的真实约束：output.schema 为 additionalProperties:false 时，
* execute 返回值字段必须与 schema 完全一致，否则每次调用都被运行时拒绝。
*/
function rowsMeta(kind, rows, summary, pass) {
	return {
		kind,
		rows,
		summary,
		...pass === void 0 ? {} : { pass }
	};
}
/** 把评估报告的 targets 投影成浏览器可读的行数据。 */
function reportRows(targets) {
	return targets.map((t) => ({
		name: t.name,
		verdict: t.verdict,
		risk: t.risk,
		scope: t.scope,
		reasons: t.reasons,
		blockers: t.blockers,
		running: t.running,
		dependents: t.dependents?.map((d) => d.name) ?? [],
		bundles: t.plan?.bundles ?? [],
		cachePaths: t.plan?.cachePaths ?? [],
		scanRisk: t.scan?.level,
		scanCategories: t.scan?.categories ?? [],
		requiresExtraConfirm: t.requiresExtraConfirm === true
	}));
}
/** 把扫描结果投影成浏览器可读的行数据。 */
function scanRows(results) {
	return results.map((r) => ({
		name: r.name,
		level: r.level,
		categories: r.categories,
		hits: (r.hits ?? []).slice(0, 20).map((h) => ({
			ruleId: h.ruleId,
			category: h.category,
			severity: h.severity,
			label: h.label,
			line: h.line,
			excerpt: h.excerpt
		})),
		summary: r.summary,
		filesScanned: r.filesScanned,
		error: r.error
	}));
}
function listTool(guard) {
	return defineTool({
		name: "plugin_guard_list",
		description: "列出当前 dsh 已安装的插件/扩展。当用户想查看、盘点或筛选插件，或在删除前想确认有哪些插件时使用。可按名称关键字过滤，或按状态筛选。返回每个插件的名称、是否启用、是否可删除、是否为受保护核心模块、依赖与被依赖关系、运行状态。此工具只读，不会修改任何东西。",
		parameters: {
			query: {
				type: "string",
				description: "按插件名/bundle 名过滤的关键字（可选，大小写不敏感）"
			},
			status: {
				type: "string",
				enum: [
					"all",
					"enabled",
					"disabled",
					"removable",
					"core"
				],
				description: "状态筛选：all=全部（默认），enabled=已启用，disabled=已停用，removable=可安全删除，core=核心/官方"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					text: {
						type: "string",
						required: true
					},
					rows: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: true
						},
						required: true
					},
					count: {
						type: "number",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: String(value.text)
			}],
			presentationMeta: (_args, value) => rowsMeta("plugin-guard-list", value.rows, String(value.text))
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			const query = typeof args.query === "string" ? args.query : void 0;
			const status = typeof args.status === "string" ? args.status : "all";
			const { rows, warnings } = await guard.list({
				query,
				status
			});
			const lines = rows.map((r) => {
				const tags = [
					r.protected ? "受保护核心" : r.scope,
					r.enabled ? "启用" : "停用",
					r.running ? "运行中" : "",
					r.removable ? "可删除" : "不可删"
				].filter(Boolean).join("/");
				const dep = r.dependents.length > 0 ? ` ←被依赖[${r.dependents.join(",")}]` : "";
				return `- ${r.name} [${tags}]${dep}`;
			});
			const head = `共 ${rows.length} 个插件：`;
			const warningText = warnings.length ? `\n注意：${warnings.join("；")}` : "";
			return {
				text: lines.length ? `${head}\n${lines.join("\n")}${warningText}` : `${head}（无匹配项）${warningText}`,
				rows,
				count: rows.length
			};
		},
		presentCall: () => ({
			card: "generic",
			title: "插件清单",
			kind: "other"
		}),
		presentResult(_args, result) {
			if (result.isError) return void 0;
			const meta = guardMetaFrom(result.meta);
			if (!meta) return void 0;
			return {
				card: "generic",
				title: `插件清单 · ${meta.rows.length} 个`,
				kind: "other"
			};
		}
	});
}
function evaluateTool(guard) {
	return defineTool({
		name: "plugin_guard_evaluate",
		description: "删除插件前的安全评估（只读，绝不修改任何东西）。对指定的一个或多个插件，评估它与 dsh 核心及其他插件的依赖关系、运行状态，判断是否会引发 dsh 崩溃或核心功能异常，并给出每个插件的风险等级、阻断原因与清理清单预览。只有全部评估通过（pass=true）才可能执行清理。用户要求删除/清理插件时必须先调用此工具，再调用 plugin_guard_cleanup。返回中包含评估令牌，cleanup 必须携带。",
		parameters: {
			targets: {
				type: "array",
				items: { type: "string" },
				required: true,
				description: "待评估删除的插件名列表（来自 plugin_guard_list 的 name 字段）"
			},
			withScan: {
				type: "boolean",
				description: "是否同时做恶意行为静态扫描并联动（默认 false）。开启后高风险插件会被标记并在删除时要求二次确认。"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					text: {
						type: "string",
						required: true
					},
					pass: {
						type: "boolean",
						required: true
					},
					token: {
						type: "string",
						required: true
					},
					rows: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: true
						},
						required: true
					},
					digest: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: String(value.text)
			}],
			presentationMeta: (_args, value) => rowsMeta("plugin-guard-evaluate", value.rows, String(value.text), Boolean(value.pass))
		},
		isConcurrencySafe: () => false,
		async execute(args) {
			const targets = (Array.isArray(args.targets) ? args.targets : []).filter((t) => typeof t === "string");
			const withScan = args.withScan === true;
			const { report, token, warnings } = await guard.evaluate(targets, withScan);
			const lines = report.targets.map((t) => {
				const verdict = t.verdict === "pass" ? "✅ 通过" : "⛔ 阻断";
				const detail = t.reasons.map((r) => `    · ${r}`).join("\n");
				return `${verdict} ${t.name} [${t.risk}/${t.scope}]\n${detail}`;
			});
			const warningText = warnings.length ? `\n注意：${warnings.join("；")}` : "";
			return {
				text: `评估结果：${report.pass ? "全部通过，可进入清理（仍需用户确认）" : "存在阻断项，禁止清理"}。\n${lines.join("\n")}\n评估令牌：${token}\n状态摘要：${report.digest}${warningText}`,
				pass: report.pass,
				token,
				rows: reportRows(report.targets),
				digest: report.digest
			};
		},
		presentCall: () => ({
			card: "generic",
			title: "删除前安全评估",
			kind: "other"
		}),
		presentResult(_args, result) {
			if (result.isError) return void 0;
			const meta = guardMetaFrom(result.meta);
			if (!meta) return void 0;
			return {
				card: "generic",
				title: meta.pass ? "评估通过 · 待确认" : "评估未通过 · 已阻断",
				kind: "other"
			};
		}
	});
}
function cleanupTool(guard) {
	return defineTool({
		name: "plugin_guard_cleanup",
		description: "执行插件清理（破坏性操作）。仅当已调用 plugin_guard_evaluate 且评估全部通过（pass=true）、并已获得用户对本次删除的明确同意后才可调用。必须传入评估返回的 token 与相同 targets。工具会再次复核状态与风险，任一不符即中止。执行时会卸载插件本体并清理其配置、缓存、注册信息与残留文件。调用本工具会触发 dsh 的用户确认界面，只有用户批准后才真正删除。",
		parameters: {
			token: {
				type: "string",
				required: true,
				description: "plugin_guard_evaluate 返回的评估令牌"
			},
			targets: {
				type: "array",
				items: { type: "string" },
				required: true,
				description: "待清理的插件名列表，必须与评估时的 targets 完全一致"
			},
			acknowledgeHighRisk: {
				type: "boolean",
				description: "当目标在扫描中命中高风险可疑特征时，必须显式设为 true 确认已了解风险，否则清理会被拒绝。"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					text: {
						type: "string",
						required: true
					},
					ok: {
						type: "boolean",
						required: true
					},
					rows: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: true
						},
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: String(value.text)
			}],
			presentationMeta: (_args, value) => rowsMeta("plugin-guard-cleanup", value.rows, String(value.text), Boolean(value.ok))
		},
		isConcurrencySafe: () => false,
		async execute(args) {
			const token = typeof args.token === "string" ? args.token : "";
			const targets = (Array.isArray(args.targets) ? args.targets : []).filter((t) => typeof t === "string");
			const result = await guard.cleanup(token, targets, args.acknowledgeHighRisk === true);
			const lines = result.steps.map((s) => {
				const head = `${s.ok ? "✅" : "❌"} ${s.target}`;
				const phases = s.phases.map((p) => `    ✓ ${p}`);
				const warns = s.warnings.map((w) => `    ! ${w}`);
				const errors = s.errors.map((e) => `    ✗ ${e}`);
				return [
					head,
					...phases,
					...warns,
					...errors
				].join("\n");
			});
			return {
				text: `${result.message}\n${lines.join("\n")}`.trim(),
				ok: result.ok,
				rows: result.steps.map((s) => ({ ...s }))
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: `清理 ${Array.isArray(args.targets) ? args.targets.length : 0} 个插件`,
			kind: "delete"
		}),
		presentResult(_args, result) {
			if (result.isError) return void 0;
			const meta = guardMetaFrom(result.meta);
			if (!meta) return void 0;
			return {
				card: "generic",
				title: meta.pass ? "清理完成" : "清理未完全成功",
				kind: "other"
			};
		}
	});
}
/** 恶意行为静态扫描工具：识别并标记可疑插件，展示名称/风险类型/摘要。 */
function scanTool(guard) {
	return defineTool({
		name: "plugin_guard_scan",
		description: "对已安装插件做恶意行为静态扫描（只读）。扫描插件源码与配置，检测动态代码执行、子进程、网络外联、凭据访问、篡改核心配置、破坏性删除、混淆代码、环境变量收集等可疑特征，按插件返回风险等级、风险类型与扫描结果摘要。当用户要求\"检查插件是否安全/有无恶意行为/扫描插件\"时使用。注意：这是基于静态特征的启发式提示，不是恶意行为的确证，需人工判断。",
		parameters: { targets: {
			type: "array",
			items: { type: "string" },
			description: "指定要扫描的插件名；留空则扫描全部已安装插件"
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					text: {
						type: "string",
						required: true
					},
					rows: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: true
						},
						required: true
					},
					count: {
						type: "number",
						required: true
					},
					highRiskCount: {
						type: "number",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: String(value.text)
			}],
			presentationMeta: (_args, value) => rowsMeta("plugin-guard-scan", value.rows, String(value.text))
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			const targets = (Array.isArray(args.targets) ? args.targets : []).filter((t) => typeof t === "string");
			let results;
			try {
				results = await guard.scanPlugins(targets.length > 0 ? targets : void 0);
			} catch (e) {
				return {
					text: `扫描失败：${e instanceof Error ? e.message : String(e)}`,
					rows: [],
					count: 0,
					highRiskCount: 0
				};
			}
			const rows = scanRows(results);
			const highRiskCount = results.filter((r) => r.level === "high").length;
			const errCount = results.filter((r) => r.level === "error").length;
			const lines = results.map((r) => {
				return `${r.level === "high" ? "⛔" : r.level === "medium" ? "⚠" : r.level === "error" ? "❓" : "✅"} ${r.summary}`;
			});
			return {
				text: `扫描完成：${results.length} 个插件，高风险 ${highRiskCount} 个，扫描异常 ${errCount} 个。\n${lines.join("\n")}\n（静态启发式提示，非恶意定论；点击卡片可查看风险类型与命中摘要。）`,
				rows,
				count: results.length,
				highRiskCount
			};
		},
		presentCall: () => ({
			card: "generic",
			title: "恶意行为扫描",
			kind: "other"
		}),
		presentResult(_args, result) {
			if (result.isError) return void 0;
			const meta = guardMetaFrom(result.meta);
			if (!meta) return void 0;
			return {
				card: "generic",
				title: `插件扫描 · ${meta.rows.length} 个`,
				kind: "other"
			};
		}
	});
}
/** 删除菜单数据源：返回可删除插件列表，附带扫描风险标记（供卡片下拉菜单渲染与联动）。 */
function menuTool(guard) {
	return defineTool({
		name: "plugin_guard_menu",
		description: "打开\"删除插件\"交互菜单。默认（interactive=false）返回可删除插件列表数据源（只读），卡片渲染下拉菜单；设 interactive=true 则弹出交互式两级菜单：第一级让用户点选要删除的插件，第二级在删除前再次确认（高风险插件需额外确认），确认后执行评估+清理。当用户要求\"打开删除菜单/用菜单删除插件/我要选插件删掉\"时使用；只需查看列表时用 interactive=false。",
		parameters: { interactive: {
			type: "boolean",
			description: "true=弹出两级交互菜单并执行删除；false=仅返回可删除列表（默认）"
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					text: {
						type: "string",
						required: true
					},
					rows: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: true
						},
						required: true
					},
					count: {
						type: "number",
						required: true
					},
					deleted: {
						type: "boolean",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: String(value.text)
			}],
			presentationMeta: (_args, value) => rowsMeta("plugin-guard-menu", value.rows, String(value.text))
		},
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			let rows;
			try {
				const { rows: removable } = await guard.list({ status: "removable" });
				const scanResults = await guard.scanPlugins(removable.map((r) => r.name));
				const scanBy = new Map(scanResults.map((r) => [r.name, r]));
				rows = removable.map((r) => {
					const s = scanBy.get(r.name);
					return {
						name: r.name,
						bundle: r.bundle,
						enabled: r.enabled,
						running: r.running,
						scanRisk: s?.level ?? "unknown",
						scanCategories: s?.categories ?? [],
						highRisk: s?.level === "high"
					};
				});
			} catch (e) {
				return {
					text: `菜单数据生成失败：${e instanceof Error ? e.message : String(e)}`,
					rows: [],
					count: 0,
					deleted: false
				};
			}
			if (args.interactive !== true) return {
				text: `可删除插件 ${rows.length} 个（卡片下拉菜单中选择，删除前会二次确认；高风险插件需额外确认）。`,
				rows,
				count: rows.length,
				deleted: false
			};
			const execCtx = exec;
			if (rows.length === 0) return {
				text: "当前没有可删除的插件（受保护核心/不可卸插件已排除）。",
				rows,
				count: 0,
				deleted: false
			};
			const CANCEL = "取消";
			try {
				const chosen = ((await guard.askUser([{
					id: "target",
					question: "请选择要删除的插件（删除前会再次确认）：",
					header: "删除插件 · 第 1 步",
					options: [...rows.map((r) => ({
						label: String(r.name),
						description: `${r.highRisk ? "⚠ 扫描高风险；" : ""}${r.running ? "运行中；" : ""}风险:${String(r.scanRisk)}`
					})), {
						label: CANCEL,
						description: "不删除任何插件"
					}]
				}], execCtx)).target ?? [])[0];
				if (!chosen || chosen === CANCEL) return {
					text: "已取消删除，未做任何更改。",
					rows,
					count: rows.length,
					deleted: false
				};
				const targetRow = rows.find((r) => r.name === chosen);
				if (!targetRow) return {
					text: `所选插件「${chosen}」不在可删除列表中，已中止。`,
					rows,
					count: rows.length,
					deleted: false
				};
				const isHigh = targetRow.highRisk === true;
				if (((await guard.askUser([{
					id: "confirm",
					question: isHigh ? `⚠ 高危确认：插件「${chosen}」扫描命中高风险可疑特征，确定删除吗？` : `确认删除插件「${chosen}」？此操作会移除插件本体及其配置、缓存与注册信息。`,
					detail: isHigh ? `风险类型：${targetRow.scanCategories.join("、") || "未知"}。静态扫描仅为启发式提示，非恶意定论；如不确定，请取消。` : "删除后通常需要重启 dsh 才会完全生效。",
					header: isHigh ? "高危二次确认" : "删除确认 · 第 2 步",
					options: [{
						label: "确认删除",
						description: "执行评估并清理"
					}, {
						label: CANCEL,
						description: "返回，不删除"
					}]
				}], execCtx)).confirm ?? [])[0] !== "确认删除") return {
					text: "已在最终确认时取消，未做任何更改。",
					rows,
					count: rows.length,
					deleted: false
				};
				const { report, token } = await guard.evaluate([chosen], true);
				if (!report.pass) return {
					text: `删除前评估未通过，已中止：${report.targets.filter((t) => t.verdict === "block").map((b) => `${b.name}（${b.blockers.join("/")}）`).join("；")}`,
					rows,
					count: rows.length,
					deleted: false
				};
				const needExtra = report.targets.some((t) => t.requiresExtraConfirm === true);
				const result = await guard.cleanup(token, [chosen], needExtra && isHigh);
				return {
					text: result.ok ? `菜单删除成功：${result.message}` : `菜单删除未完全成功：${result.message}`,
					rows,
					count: rows.length,
					deleted: result.ok
				};
			} catch (e) {
				return {
					text: `交互式删除菜单未能完成（${e instanceof Error ? e.message : String(e)}）。请改用对话式流程：plugin_guard_evaluate → 用户确认 → plugin_guard_cleanup。未做任何更改。`,
					rows,
					count: rows.length,
					deleted: false
				};
			}
		},
		presentCall: () => ({
			card: "generic",
			title: "插件删除菜单",
			kind: "other"
		}),
		presentResult(_args, result) {
			if (result.isError) return void 0;
			const meta = guardMetaFrom(result.meta);
			if (!meta) return void 0;
			return {
				card: "generic",
				title: `删除菜单 · ${meta.rows.length} 个可删`,
				kind: "other"
			};
		}
	});
}

//#endregion
//#region src/index.ts
const name = PLUGIN_ID;
/** 声明依赖的服务：工具注册、系统提示、官方插件管理器、profile 上下文。 */
const inject = [
	"tools",
	"systemPrompt",
	"pluginManager",
	"profileContext"
];
/** 用户可覆盖配置（profile/patch 层）。 */
const Config = z.object({
	tokenTtlMs: z.number().min(1e3).default(DEFAULT_CONFIG.tokenTtlMs),
	sweepCache: z.boolean().default(DEFAULT_CONFIG.sweepCache),
	backupBeforeWrite: z.boolean().default(DEFAULT_CONFIG.backupBeforeWrite),
	cacheMatchMinLength: z.number().min(3).default(DEFAULT_CONFIG.cacheMatchMinLength)
});
function apply(ctx, config = {}) {
	const guard = new PluginGuard(ctx, {
		tokenTtlMs: config.tokenTtlMs ?? DEFAULT_CONFIG.tokenTtlMs,
		sweepCache: config.sweepCache ?? DEFAULT_CONFIG.sweepCache,
		backupBeforeWrite: config.backupBeforeWrite ?? DEFAULT_CONFIG.backupBeforeWrite,
		cacheMatchMinLength: config.cacheMatchMinLength ?? DEFAULT_CONFIG.cacheMatchMinLength
	});
	ctx.effect(() => ctx.tools.register(listTool(guard)), `${PLUGIN_ID}.list`);
	ctx.effect(() => ctx.tools.register(evaluateTool(guard)), `${PLUGIN_ID}.evaluate`);
	ctx.effect(() => ctx.tools.register(cleanupTool(guard)), `${PLUGIN_ID}.cleanup`);
	ctx.effect(() => ctx.tools.register(scanTool(guard)), `${PLUGIN_ID}.scan`);
	ctx.effect(() => ctx.tools.register(menuTool(guard)), `${PLUGIN_ID}.menu`);
	ctx.effect(() => ctx.systemPrompt.section({
		name: `${PLUGIN_ID}:policy`,
		order: 2400,
		text: () => "## 插件管理与安全清理 (plugin-guard)\n当用户要求查看、盘点、筛选、卸载、删除或清理 dsh 插件时：\n1. 先用 `plugin_guard_list` 查看插件（可按 query/status 筛选），让用户确认要处理的插件名称。\n2. 删除前**必须**用 `plugin_guard_evaluate` 对目标做依赖与运行状态评估；返回 pass=false 时严禁清理，并如实告知阻断原因。\n3. 评估通过后，向用户展示评估报告与清理后果，取得用户对本次删除的明确同意。\n4. 仅在用户同意后调用 `plugin_guard_cleanup`，原样传入评估返回的 token 与 targets；不要自行编造 token。\n5. 评估令牌有时效（默认 5 分钟）且一次性，过期或目标状态变化需重新评估。\n6. 用户要求\"扫描插件/检查恶意行为/哪些插件不安全\"时用 `plugin_guard_scan`；返回高风险插件时如实展示风险类型与摘要，并说明这是静态启发式提示、非恶意定论。\n7. 用户要求\"用菜单删除/打开删除菜单/我要选插件删掉\"时用 `plugin_guard_menu` 并传 `interactive:true`：会弹出两级选择菜单（先选插件、再确认），高风险插件额外确认后才删除。只需查看可删列表时传 `interactive:false`。\n8. 评估可加 `withScan:true` 联动扫描；若某目标被标为 requiresExtraConfirm，清理时必须显式传 `acknowledgeHighRisk:true`，否则会被拒绝。\n绝不可跳过评估直接清理，也不要试图删除受保护的核心模块或本插件自身。"
	}), `${PLUGIN_ID}.prompt`);
	ctx.on("tools/pre-execute", async (exec, next) => {
		if (exec?.name !== "plugin_guard_cleanup") return next();
		const targets = Array.isArray(exec?.args?.targets) ? exec.args.targets.join("、") : "";
		return {
			kind: "ask",
			reason: `即将清理插件：${targets || "（未指定）"}。此操作会移除插件本体及其配置、缓存与注册信息，且需要重启 dsh 才会完全生效。`,
			displayReason: {
				en: `Delete plugin(s): ${targets || "(unspecified)"}? This removes the plugin and its config, cache and registration; a restart is required to fully apply.`,
				zh: `确认清理插件：${targets || "（未指定）"}？将移除插件本体及其配置、缓存与注册信息，重启后完全生效。`
			}
		};
	}, { prepend: true });
	ctx.effect(() => {
		if (!guard.managerAvailable()) console.warn(`[${PLUGIN_ID}] 未检测到 ctx.pluginManager 服务，插件管理/清理能力不可用。请确认当前 profile 包含 dsh-plugin-manager。`);
	});
}

//#endregion
export { Config, apply, inject, name };