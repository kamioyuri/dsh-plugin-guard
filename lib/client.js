window.__ModuleLoader__.load({ id: "@yuri/dsh-plugin-guard", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") {
		for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
			key = keys[i];
			if (!__hasOwnProp.call(to, key) && key !== except) {
				__defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
		}
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let react = require("react");
react = __toESM(react);
let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
_deepseek_ai_dsh_client_ui_primitives = __toESM(_deepseek_ai_dsh_client_ui_primitives);
let react_jsx_runtime = require("react/jsx-runtime");

//#region src/fragment.ts
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
/** 设置菜单"搜索已安装插件"用：只要是具名、非核心保护的已安装 bundle 就列出，
*  不因 removable=false 而隐藏（这类项显示但删除按钮禁用，并给出原因）。
*  这样 @deepseek-harness-tui/dsh-tui 等一定会出现在搜索结果中。 */
function isListableBundle(b) {
	if (typeof b !== "object" || b === null) return false;
	const x = b;
	if (typeof x.name !== "string" || x.name === "") return false;
	if (isProtectedModule(x.name)) return false;
	return true;
}

//#endregion
//#region src/client/index.tsx
const name = "@yuri/dsh-plugin-guard";
const inject = [
	"slots",
	"locale",
	"remote",
	"remote.pluginManager"
];
/**
* 配色统一：全部引用 dsh 官方 --dsw-* 主题令牌，跟随系统明/暗主题。
* fallback 为官方深色模式的等价 hex，仅在令牌缺失（如宿主未注入主题）时生效。
* 令牌来源：@deepseek-ai/dsh-client-ui-theme/lib/client.js (design-platform.css)。
*/
const cssVar = (token, fallback) => `var(${token}, ${fallback})`;
const COLORS = {
	bg: cssVar("--dsw-alias-bg-layer-2", "#2c2c2e"),
	surface: cssVar("--dsw-alias-bg-layer-3", "#353638"),
	border: cssVar("--dsw-alias-border-l4", "rgba(255,255,255,0.2)"),
	text: cssVar("--dsw-alias-label-primary", "#f9fafb"),
	muted: cssVar("--dsw-alias-label-secondary", "#cfd3d6"),
	green: cssVar("--dsw-alias-state-success-primary", "#4ade80"),
	red: cssVar("--dsw-alias-state-error-primary", "#f25a5a"),
	amber: cssVar("--dsw-alias-state-warn-label", "#fbbf24"),
	blue: cssVar("--dsw-alias-state-business-primary", "#7aaaff"),
	chip: cssVar("--dsw-alias-bg-layer-3", "#353638"),
	dangerHover: cssVar("--dsw-alias-interactive-bg-hover-danger", "rgba(242,90,90,0.15)"),
	focusRing: cssVar("--dsw-focus-ring-color", "#7aaaff")
};
const RADIUS = {
	sm: cssVar("--dsw-radius-sm", "8px"),
	md: cssVar("--dsw-radius-md", "12px"),
	lg: cssVar("--dsw-radius-lg", "16px")
};
const cardStyle = {
	background: COLORS.bg,
	color: COLORS.text,
	border: `0.5px solid ${COLORS.border}`,
	borderRadius: RADIUS.md,
	padding: 14,
	fontFamily: "system-ui, -apple-system, sans-serif",
	fontSize: 13,
	maxWidth: 720
};
const rowStyle = {
	display: "flex",
	alignItems: "flex-start",
	gap: 8,
	padding: "8px 10px",
	background: COLORS.surface,
	borderRadius: RADIUS.sm,
	marginBottom: 6
};
function chip(text, color) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
		style: {
			background: COLORS.chip,
			color,
			borderRadius: RADIUS.sm,
			padding: "1px 7px",
			fontSize: 11,
			whiteSpace: "nowrap",
			border: `0.5px solid ${COLORS.border}`
		},
		children: text
	});
}
function str(v) {
	return v === void 0 || v === null ? "" : String(v);
}
function arr(v) {
	return Array.isArray(v) ? v.map(String) : [];
}
function ListView({ meta }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: cardStyle,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					alignItems: "center",
					gap: 8,
					marginBottom: 10
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
					style: { fontSize: 14 },
					children: "🧩 插件清单"
				}), chip(`${meta.rows.length} 个`, COLORS.blue)]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					color: COLORS.muted,
					marginBottom: 10,
					fontSize: 12
				},
				children: meta.summary
			}),
			meta.rows.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: { color: COLORS.muted },
				children: "无匹配插件。"
			}),
			meta.rows.map((r, i) => {
				const protectedFlag = r.protected === true;
				const enabled = r.enabled === true;
				const running = r.running === true;
				const removable = r.removable === true;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: rowStyle,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							flex: 1,
							minWidth: 0
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontWeight: 600,
									wordBreak: "break-word"
								},
								children: str(r.name)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									marginTop: 4,
									display: "flex",
									gap: 4,
									flexWrap: "wrap"
								},
								children: [
									chip(str(r.scope || "unknown"), protectedFlag ? COLORS.amber : COLORS.muted),
									chip(enabled ? "已启用" : "已停用", enabled ? COLORS.green : COLORS.muted),
									running && chip("运行中", COLORS.blue),
									chip(removable ? "可删除" : "不可删", removable ? COLORS.green : COLORS.red),
									protectedFlag && chip("核心保护", COLORS.amber)
								]
							}),
							arr(r.dependents).length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									marginTop: 5,
									color: COLORS.muted,
									fontSize: 11
								},
								children: ["被依赖：", arr(r.dependents).join("、")]
							})
						]
					})
				}, i);
			})
		]
	});
}
function EvaluateView({ meta }) {
	const pass = meta.pass === true;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: {
			...cardStyle,
			borderColor: pass ? COLORS.green : COLORS.red,
			borderWidth: 2
		},
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					alignItems: "center",
					gap: 8,
					marginBottom: 10
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
					style: { fontSize: 14 },
					children: "🛡️ 删除前安全评估"
				}), chip(pass ? "全部通过 · 待用户确认" : "存在阻断 · 禁止清理", pass ? COLORS.green : COLORS.red)]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					color: COLORS.muted,
					marginBottom: 10,
					fontSize: 12
				},
				children: meta.summary
			}),
			meta.rows.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: { color: COLORS.muted },
				children: "无评估条目。"
			}),
			meta.rows.map((r, i) => {
				const ok = r.verdict === "pass";
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						...rowStyle,
						flexDirection: "column",
						gap: 6,
						borderLeft: `3px solid ${ok ? COLORS.green : COLORS.red}`
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								alignItems: "center",
								gap: 8,
								width: "100%",
								flexWrap: "wrap"
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [
									ok ? "✅" : "⛔",
									" ",
									str(r.name)
								] }),
								chip(`风险:${str(r.risk)}`, r.risk === "block" ? COLORS.red : r.risk === "warn" ? COLORS.amber : COLORS.green),
								chip(str(r.scope), COLORS.muted),
								r.running === true && chip("运行中", COLORS.blue),
								r.scanRisk !== void 0 && chip(`扫描:${str(r.scanRisk)}`, r.scanRisk === "high" ? COLORS.red : r.scanRisk === "medium" ? COLORS.amber : r.scanRisk === "clean" ? COLORS.green : COLORS.muted),
								r.requiresExtraConfirm === true && chip("需额外确认", COLORS.red)
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							style: {
								margin: 0,
								paddingLeft: 18,
								color: COLORS.muted,
								fontSize: 12
							},
							children: arr(r.reasons).map((reason, j) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
								style: { marginBottom: 2 },
								children: reason
							}, j))
						}),
						arr(r.dependents).length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								fontSize: 11,
								color: COLORS.amber
							},
							children: ["依赖方：", arr(r.dependents).join("、")]
						}),
						arr(r.blockers).length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								fontSize: 11,
								color: COLORS.red
							},
							children: ["阻断码：", arr(r.blockers).join("、")]
						})
					]
				}, i);
			})
		]
	});
}
function CleanupView({ meta }) {
	const ok = meta.pass === true;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: {
			...cardStyle,
			borderColor: ok ? COLORS.green : COLORS.red,
			borderWidth: 2
		},
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					alignItems: "center",
					gap: 8,
					marginBottom: 10
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
					style: { fontSize: 14 },
					children: "🧹 插件清理结果"
				}), chip(ok ? "清理完成" : "存在失败项", ok ? COLORS.green : COLORS.red)]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					color: COLORS.muted,
					marginBottom: 10,
					fontSize: 12
				},
				children: meta.summary
			}),
			meta.rows.map((r, i) => {
				const rowOk = r.ok === true;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						...rowStyle,
						flexDirection: "column",
						gap: 5,
						borderLeft: `3px solid ${rowOk ? COLORS.green : COLORS.red}`
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [
							rowOk ? "✅" : "❌",
							" ",
							str(r.target)
						] }),
						arr(r.phases).map((p, j) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								color: COLORS.green,
								fontSize: 12
							},
							children: ["✓ ", p]
						}, `p${j}`)),
						arr(r.warnings).map((w, j) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								color: COLORS.amber,
								fontSize: 12
							},
							children: ["! ", w]
						}, `w${j}`)),
						arr(r.errors).map((e, j) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								color: COLORS.red,
								fontSize: 12
							},
							children: ["✗ ", e]
						}, `e${j}`))
					]
				}, i);
			})
		]
	});
}
function levelColor(level) {
	const l = str(level);
	return l === "high" ? COLORS.red : l === "medium" ? COLORS.amber : l === "low" ? COLORS.blue : l === "clean" ? COLORS.green : COLORS.muted;
}
function levelIcon(level) {
	const l = str(level);
	return l === "high" ? "⛔" : l === "medium" ? "⚠" : l === "error" ? "❓" : l === "clean" ? "✅" : "🔎";
}
/** 恶意行为扫描结果卡片：插件名 + 风险类型 + 摘要 + 命中明细。 */
function ScanView({ meta }) {
	const high = meta.rows.filter((r) => r.level === "high").length;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: {
			...cardStyle,
			borderColor: high > 0 ? COLORS.red : COLORS.border,
			borderWidth: high > 0 ? 2 : 1
		},
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					alignItems: "center",
					gap: 8,
					marginBottom: 10
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
						style: { fontSize: 14 },
						children: "🔎 恶意行为扫描"
					}),
					chip(`${meta.rows.length} 个插件`, COLORS.blue),
					high > 0 && chip(`高风险 ${high}`, COLORS.red)
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					color: COLORS.muted,
					marginBottom: 10,
					fontSize: 12
				},
				children: meta.summary
			}),
			meta.rows.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: { color: COLORS.muted },
				children: "无扫描结果。"
			}),
			meta.rows.map((r, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					...rowStyle,
					flexDirection: "column",
					gap: 6,
					borderLeft: `3px solid ${levelColor(r.level)}`
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 6,
							flexWrap: "wrap",
							width: "100%"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [
								levelIcon(r.level),
								" ",
								str(r.name)
							] }),
							chip(`等级:${str(r.level)}`, levelColor(r.level)),
							chip(`扫描 ${str(r.filesScanned)} 文件`, COLORS.muted)
						]
					}),
					arr(r.categories).length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							fontSize: 11,
							color: COLORS.amber
						},
						children: ["风险类型：", arr(r.categories).join("、")]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: 12,
							color: COLORS.muted
						},
						children: str(r.summary)
					}),
					arr(r.hits).length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
						style: {
							width: "100%",
							fontSize: 11
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("summary", {
							style: {
								cursor: "pointer",
								color: COLORS.blue
							},
							children: [
								"命中明细（",
								arr(r.hits).length,
								"）"
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							style: {
								margin: "6px 0 0",
								paddingLeft: 18,
								color: COLORS.muted
							},
							children: arr(r.hits).slice(0, 8).map((h, j) => {
								let hit = {};
								try {
									hit = JSON.parse(h);
								} catch {}
								const label = typeof hit === "object" && hit !== null ? str(hit.label || hit.ruleId) : h;
								const line = typeof hit === "object" && hit !== null ? str(hit.line) : "";
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
									style: { marginBottom: 2 },
									children: [label, line ? ` @L${line}` : ""]
								}, j);
							})
						})]
					})
				]
			}, i)),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					marginTop: 8,
					fontSize: 11,
					color: COLORS.muted
				},
				children: "静态启发式提示，非恶意定论；请结合实际情况判断。"
			})
		]
	});
}
/** 删除菜单卡片：可删除插件列表 + 风险标记，提示用户用交互菜单选择与确认。 */
function MenuView({ meta }) {
	const high = meta.rows.filter((r) => r.highRisk === true).length;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: {
			...cardStyle,
			borderColor: COLORS.blue,
			borderWidth: 1
		},
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					alignItems: "center",
					gap: 8,
					marginBottom: 10
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
						style: { fontSize: 14 },
						children: "🗑️ 插件删除菜单"
					}),
					chip(`${meta.rows.length} 个可删`, COLORS.blue),
					high > 0 && chip(`高风险 ${high}`, COLORS.red)
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					color: COLORS.muted,
					marginBottom: 10,
					fontSize: 12
				},
				children: meta.summary
			}),
			meta.rows.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: { color: COLORS.muted },
				children: "当前没有可删除的插件。"
			}),
			meta.rows.map((r, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: rowStyle,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						flex: 1,
						minWidth: 0
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontWeight: 600,
								wordBreak: "break-word"
							},
							children: str(r.name)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								marginTop: 4,
								display: "flex",
								gap: 4,
								flexWrap: "wrap"
							},
							children: [
								chip(`扫描:${str(r.scanRisk)}`, levelColor(r.scanRisk)),
								r.highRisk === true && chip("⚠ 高风险·需额外确认", COLORS.red),
								r.running === true && chip("运行中", COLORS.blue)
							]
						}),
						arr(r.scanCategories).length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								marginTop: 4,
								fontSize: 11,
								color: COLORS.amber
							},
							children: ["风险类型：", arr(r.scanCategories).join("、")]
						})
					]
				})
			}, i)),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					marginTop: 8,
					padding: 8,
					background: COLORS.surface,
					borderRadius: RADIUS.sm,
					fontSize: 11,
					color: COLORS.muted
				},
				children: "删除前会弹出两级菜单：先选择插件、再次确认；高风险插件需额外确认。也可对我说\"用菜单删除某个插件\"直接开始。"
			})
		]
	});
}
function GuardCard({ callId, block }) {
	if (!("kind" in block)) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		style: cardStyle,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			style: { color: COLORS.muted },
			children: "⏳ 插件审计处理中…"
		})
	});
	const anyBlock = block;
	if (anyBlock.isError) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		style: {
			...cardStyle,
			borderColor: COLORS.red
		},
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			style: { color: COLORS.red },
			children: "插件工具执行失败。"
		})
	});
	const meta = guardMetaFrom(anyBlock.meta);
	if (!meta) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		style: cardStyle,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			style: { color: COLORS.muted },
			children: str(anyBlock.content?.[0]?.text) || "无渲染数据"
		})
	});
	if (meta.kind === "plugin-guard-list") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ListView, { meta });
	if (meta.kind === "plugin-guard-evaluate") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EvaluateView, { meta });
	if (meta.kind === "plugin-guard-scan") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ScanView, { meta });
	if (meta.kind === "plugin-guard-menu") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MenuView, { meta });
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CleanupView, { meta });
}
const SECTION_NS = "dshPluginGuardSettings";
const SECTION_ID = "dsh-plugin-guard";
const DICT = {
	zh: {
		nav: "插件守卫",
		title: "插件守卫 · 插件清理",
		subtitle: "搜索并选择插件清理。删除前会二次确认。",
		search: "搜索已安装插件…",
		noMatch: "没有匹配的插件。",
		found: "匹配 {n} 个",
		refresh: "刷新",
		empty: "没有已安装的插件。",
		del: "删除",
		deleting: "删除中…",
		protected: "不可卸载",
		readonly: "只读",
		cancel: "取消",
		confirm: "确认删除",
		confirmTitle: "删除插件",
		confirmDesc: "将移除插件本体及其配置、缓存与注册信息，通常需要重启 dsh 才完全生效。此操作不可撤销。",
		ok: "删除成功，请重启 dsh 使其完全生效。",
		fail: "删除失败",
		loading: "正在加载插件列表…",
		note: "插件清理仅针对已安装插件；删除前请确认目标，操作不可撤销。"
	},
	en: {
		nav: "Plugin Guard",
		title: "Plugin Guard · Cleanup",
		subtitle: "Search and select a plugin to clean up. Confirmation is required before deletion.",
		search: "Search installed plugins…",
		noMatch: "No matching plugins.",
		found: "{n} matched",
		refresh: "Refresh",
		empty: "No installed plugins.",
		del: "Delete",
		deleting: "Deleting…",
		protected: "Not removable",
		readonly: "Read-only",
		cancel: "Cancel",
		confirm: "Confirm delete",
		confirmTitle: "Delete plugin",
		confirmDesc: "Removes the plugin and its config, cache and registration. A dsh restart is usually required. This cannot be undone.",
		ok: "Deleted. Restart dsh to fully apply.",
		fail: "Delete failed",
		loading: "Loading plugin list…",
		note: "Cleanup applies to installed plugins only. Confirm the target before deleting; this cannot be undone."
	}
};
/** 二次确认弹窗：优先用 primitives.Modal/Button，缺失时降级为原生实现。 */
function ConfirmModal({ title, desc, cancelLabel, confirmLabel, onCancel, onConfirm, busy }) {
	const P = _deepseek_ai_dsh_client_ui_primitives;
	const Modal = P?.Modal;
	const Button = P?.Button;
	if (Modal && Button) return react.default.createElement(Modal, {
		open: true,
		onClose: onCancel,
		title,
		description: desc,
		footer: react.default.createElement(react.default.Fragment, null, react.default.createElement(Button, {
			variant: "outline",
			onClick: onCancel,
			disabled: busy,
			children: cancelLabel
		}), react.default.createElement(Button, {
			variant: "primary",
			onClick: onConfirm,
			disabled: busy,
			style: {
				"--dsw-alias-button-primary-fill": "var(--dsw-alias-state-error-primary, #f25a5a)",
				"--dsw-alias-button-primary-hover": "var(--dsw-alias-state-error-primary, #f25a5a)"
			},
			children: busy ? deletingFallback : confirmLabel
		}))
	});
	return react.default.createElement("div", { style: {
		position: "fixed",
		inset: 0,
		background: cssVar("--dsw-alias-bg-mask-2", "rgba(0,0,0,0.55)"),
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		zIndex: 9999
	} }, react.default.createElement("div", { style: {
		background: COLORS.bg,
		color: COLORS.text,
		border: `0.5px solid ${COLORS.border}`,
		borderRadius: RADIUS.md,
		padding: 20,
		maxWidth: 440,
		fontFamily: "system-ui, sans-serif"
	} }, react.default.createElement("h3", null, title), react.default.createElement("p", { style: {
		color: COLORS.muted,
		fontSize: 13
	} }, desc), react.default.createElement("div", { style: {
		display: "flex",
		gap: 8,
		justifyContent: "flex-end",
		marginTop: 16
	} }, react.default.createElement("button", {
		type: "button",
		onClick: onCancel,
		disabled: busy,
		style: btnStyle(false)
	}, cancelLabel), react.default.createElement("button", {
		type: "button",
		onClick: onConfirm,
		disabled: busy,
		style: btnStyle(true)
	}, busy ? "…" : confirmLabel))));
}
const deletingFallback = "…";
/** primary=true → 危险操作按钮（官方 .dangerButton 风格：透明底 + 红字 + 半透明红边）；
*  primary=false → 普通幽灵按钮。均带 focus-visible 焦点环。 */
function btnStyle(primary) {
	return {
		background: primary ? "transparent" : cssVar("--dsw-alias-button-contrast-fill", COLORS.surface),
		color: primary ? COLORS.red : COLORS.text,
		border: primary ? `0.5px solid ${cssVar("--dsw-alias-state-error-primary", "#f25a5a")}` : `0.5px solid ${COLORS.border}`,
		borderRadius: RADIUS.sm,
		padding: "6px 14px",
		cursor: "pointer",
		fontSize: 13,
		outlineOffset: 1
	};
}
/** onFocus/onBlur 内联模拟 :focus-visible（内联样式无法写伪类）。 */
function focusHandlers(e) {
	e.currentTarget.style.outline = `2px solid ${COLORS.focusRing}`;
}
function blurHandlers(e) {
	e.currentTarget.style.outline = "none";
}
/** 设置 section 组件：列出可删插件，每行一个删除按钮 + 确认弹窗。 */
function GuardSection(props) {
	const t = props.t;
	const remote = props.remote;
	const [rows, setRows] = react.default.useState([]);
	const [loading, setLoading] = react.default.useState(true);
	const [query, setQuery] = react.default.useState("");
	const [confirmName, setConfirmName] = react.default.useState(null);
	const [busy, setBusy] = react.default.useState(null);
	const [note, setNote] = react.default.useState("");
	const load = react.default.useCallback(async () => {
		setLoading(true);
		try {
			const list = [];
			if (remote?.pluginManager?.listBundles) {
				const r = await remote.pluginManager.listBundles();
				if (r?.ok && Array.isArray(r.value)) for (const b of r.value) {
					if (!isListableBundle(b)) continue;
					const canRemove = b.removable !== false && !(typeof b.readOnlyReason === "string" && b.readOnlyReason !== "");
					list.push({
						name: b.name,
						enabled: Boolean(b.enabled),
						removable: b.removable !== false,
						canRemove,
						readOnlyReason: b.readOnlyReason ?? null,
						official: Boolean(b.official),
						optional: Boolean(b.optional),
						source: "bundle"
					});
				}
			}
			list.sort((a, b) => a.name.localeCompare(b.name));
			setRows(list);
		} catch (e) {
			setNote(`${t("fail")}: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setLoading(false);
		}
	}, [remote, t]);
	react.default.useEffect(() => {
		load();
	}, [load]);
	const doRemove = react.default.useCallback(async () => {
		const name$1 = confirmName;
		setConfirmName(null);
		if (!name$1) return;
		setBusy(name$1);
		setNote("");
		try {
			if (!remote?.pluginManager?.removeBundle) throw new Error("removeBundle 不可用（remote.pluginManager 未注入）");
			const r = await remote.pluginManager.removeBundle(name$1);
			if (r?.ok) {
				setNote(t("ok"));
				await load();
			} else {
				const reason = r?.error?.message || r?.error?.code || JSON.stringify(r?.error ?? r);
				setNote(`${t("fail")}: ${name$1} — ${reason}`);
			}
		} catch (e) {
			setNote(`${t("fail")}: ${name$1} — ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setBusy(null);
		}
	}, [
		confirmName,
		remote,
		load,
		t
	]);
	const q = query.trim().toLowerCase();
	const filtered = q === "" ? rows : rows.filter((r) => r.name.toLowerCase().includes(q));
	return react.default.createElement(react.default.Fragment, null, react.default.createElement("h2", { style: {
		fontSize: 16,
		margin: "0 0 6px"
	} }, t("title")), react.default.createElement("p", { style: {
		color: COLORS.muted,
		fontSize: 12,
		margin: "0 0 12px"
	} }, t("subtitle")), react.default.createElement("div", { style: {
		display: "flex",
		gap: 8,
		marginBottom: 10
	} }, react.default.createElement("input", {
		type: "text",
		value: query,
		onChange: (e) => setQuery(e.target.value ?? ""),
		placeholder: t("search"),
		style: {
			flex: 1,
			minWidth: 0,
			padding: "7px 10px",
			borderRadius: RADIUS.sm,
			border: `0.5px solid ${COLORS.border}`,
			background: COLORS.surface,
			color: COLORS.text,
			fontSize: 13,
			outline: "none",
			onFocus: focusHandlers,
			onBlur: blurHandlers
		}
	}), react.default.createElement("button", {
		type: "button",
		onClick: () => void load(),
		disabled: loading,
		style: btnStyle(false),
		onFocus: focusHandlers,
		onBlur: blurHandlers
	}, t("refresh"))), q !== "" && react.default.createElement("div", { style: {
		color: COLORS.muted,
		fontSize: 11,
		marginBottom: 8
	} }, t("found").replace("{n}", String(filtered.length))), note && react.default.createElement("div", {
		style: {
			padding: 8,
			marginBottom: 12,
			borderRadius: RADIUS.sm,
			background: COLORS.surface,
			color: COLORS.amber,
			fontSize: 12
		},
		role: "status"
	}, note), loading ? react.default.createElement("div", { style: {
		color: COLORS.muted,
		fontSize: 13
	} }, t("loading")) : rows.length === 0 ? react.default.createElement("div", { style: {
		color: COLORS.muted,
		fontSize: 13
	} }, t("empty")) : filtered.length === 0 ? react.default.createElement("div", { style: {
		color: COLORS.muted,
		fontSize: 13
	} }, t("noMatch")) : react.default.createElement("div", null, filtered.map((r) => react.default.createElement("div", {
		key: r.name,
		style: {
			...rowStyle,
			alignItems: "center"
		}
	}, react.default.createElement("div", { style: {
		flex: 1,
		minWidth: 0
	} }, react.default.createElement("div", { style: {
		fontWeight: 600,
		wordBreak: "break-word",
		fontSize: 13
	} }, r.name), react.default.createElement("div", { style: {
		marginTop: 3,
		display: "flex",
		gap: 4,
		flexWrap: "wrap"
	} }, chip(r.enabled ? "启用" : "停用", r.enabled ? COLORS.green : COLORS.muted), r.canRemove ? chip("可卸载", COLORS.green) : chip(r.readOnlyReason ? t("readonly") : t("protected"), COLORS.amber))), react.default.createElement("button", {
		type: "button",
		disabled: !r.canRemove || busy === r.name,
		onClick: () => setConfirmName(r.name),
		style: btnStyle(true),
		onFocus: focusHandlers,
		onBlur: blurHandlers,
		title: r.canRemove ? void 0 : r.readOnlyReason || t("protected")
	}, busy === r.name ? t("deleting") : t("del"))))), react.default.createElement("p", { style: {
		color: COLORS.muted,
		fontSize: 11,
		marginTop: 14
	} }, t("note")), confirmName !== null && react.default.createElement(ConfirmModal, {
		title: t("confirmTitle"),
		desc: `${t("confirmDesc")}\n\n${confirmName}`,
		cancelLabel: t("cancel"),
		confirmLabel: t("confirm"),
		busy: busy !== null,
		onCancel: () => setConfirmName(null),
		onConfirm: () => void doRemove()
	}));
}
function apply(ctx) {
	const anyCtx = ctx;
	try {
		const locale = anyCtx.locale;
		const t = locale?.bind ? locale.bind(SECTION_NS) : (k) => DICT.zh[k] ?? k;
		if (locale?.register) ctx.effect(() => {
			const offs = [];
			try {
				offs.push(locale.register(SECTION_NS, "zh", DICT.zh));
			} catch {}
			try {
				offs.push(locale.register(SECTION_NS, "en", DICT.en));
			} catch {}
			return () => offs.forEach((off) => {
				try {
					off();
				} catch {}
			});
		}, "plugin-guard.settings.locale");
		anyCtx.slots.inject("settings.section", () => anyCtx.slots.register({
			name: "settings.section",
			id: SECTION_ID,
			order: 26,
			label: () => t("nav"),
			locale: SECTION_NS,
			inject: () => ({
				t,
				remote: anyCtx.remote
			})
		}, GuardSection));
	} catch {}
	const register = (key, component) => {
		ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
			name: "tool.call.toolview",
			key
		}, component));
	};
	register("plugin_guard_list", GuardCard);
	register("plugin_guard_evaluate", GuardCard);
	register("plugin_guard_cleanup", GuardCard);
	register("plugin_guard_scan", GuardCard);
	register("plugin_guard_menu", GuardCard);
}

//#endregion
exports.apply = apply;
exports.inject = inject;
exports.name = name;
return module.exports; } });