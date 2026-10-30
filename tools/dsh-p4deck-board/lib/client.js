window.__ModuleLoader__.load({
	id: "dsh-p4deck-board",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const h = react.createElement;

		const BOARD_ID = "dsh-p4deck-board";
		const BOARD_KIND = "p4deckBoard";
		const API = "/p4deck-board/api/snapshot";
		const TOGGLE = "/p4deck-board/api/human-todos/toggle";
		const ACCEPT = "/p4deck-board/api/packages/accept";
		const CANCEL = "/p4deck-board/api/packages/cancel";
		const EVENTS = "/p4deck-board/api/events";
		const LINE = "1px solid rgba(128,128,128,0.32)";
		const MUTED = "rgba(128,128,128,0.95)";

		const STAGE_LABELS = {
			"in-progress": "进行中",
			blocked: "阻塞",
			implemented: "实现待验收",
			"awaiting_accept": "待人工验收",
			"awaiting_apply": "待应用",
			unverified: "未登记验收",
			partial: "部分实现",
			todo: "待实现",
			proposed: "待确认",
			done: "已完成"
		};
		const STAGE_ORDER = ["in-progress", "blocked", "awaiting_accept", "awaiting_apply", "unverified", "partial", "todo", "proposed", "done"];
		const STAGE_COLOR = {
			"in-progress": "#1f5f8b",
			blocked: "#9b2c2c",
			implemented: "#2f6f4f",
			"awaiting_accept": "#2f6f4f",
			"awaiting_apply": "#8a5a00",
			unverified: "rgba(128,128,128,0.8)",
			partial: "#8a5a00",
			todo: "rgba(128,128,128,0.8)",
			proposed: "rgba(128,128,128,0.8)",
			done: "rgba(128,128,128,0.55)"
		};
		const MS_LABEL = {
			done: "完成",
			frozen: "已冻结",
			qa_with_gap: "QA 有缺口",
			awaiting_apply: "待应用",
			blocked: "阻塞",
			in_progress: "进行中",
			paused: "暂停"
		};
		const AGENT_LABEL = { working: "工作中", waiting: "等待依赖", blocked: "阻塞", idle: "空闲" };
		const AGENT_COLOR = {
			working: "#1f5f8b",
			waiting: "#8a5a00",
			blocked: "#9b2c2c",
			idle: "rgba(128,128,128,0.7)"
		};

		function fmtTime(iso) {
			if (!iso) return "—";
			const date = new Date(iso);
			if (Number.isNaN(date.getTime())) return String(iso);
			return date.toLocaleString("zh-CN", { hour12: false });
		}

		/** 纯视图：只吃 snapshot，便于单测与复用。 */
		function BoardView({ snapshot, status, error, onToggle, onAccept, onCancel, hostOutdated }) {
			if (!snapshot) {
				return h(
					"div",
					{ style: { padding: 12, fontSize: 12, color: MUTED, fontFamily: "inherit" } },
					status === "error" ? "看板数据读取失败：" + (error || "未知错误") + "（确认已启用 dsh-p4deck-board 宿主插件）" : "正在读取看板数据…",
				);
			}
			const counts = snapshot.counts || { byStage: {}, total: 0 };
			const agents = snapshot.agents || [];
			const milestones = snapshot.milestones || [];
			const packages = snapshot.packages || [];
			const todos = snapshot.humanTodos || [];
			const archived = snapshot.archived || [];

			const style = {
				padding: "10px 12px 24px",
				fontFamily: "inherit",
				fontSize: 12,
				lineHeight: 1.45,
				color: "inherit",
				overflowY: "auto",
				height: "100%",
				boxSizing: "border-box",
			};
			const sectionTitle = { fontSize: 11, letterSpacing: "0.06em", color: MUTED, margin: "14px 0 6px" };
			const card = { border: LINE, borderRadius: 6, padding: "6px 8px", marginBottom: 6, background: "rgba(128,128,128,0.05)" };
			const actionButton = (color) => ({
				fontFamily: "inherit",
				fontSize: 10.5,
				padding: "2px 7px",
				borderRadius: 4,
				border: LINE,
				background: "transparent",
				color,
				cursor: "pointer",
			});

			return h(
				"div",
				{ style },
				h(
					"div",
					{ style: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" } },
					h("strong", { style: { fontSize: 13 } }, "工作流看板"),
					h("span", { style: { color: MUTED } }, snapshot.batch ? snapshot.batch.id : ""),
					h("span", { style: { marginLeft: "auto", color: MUTED, fontSize: 11 } }, fmtTime(snapshot.generatedAt)),
				),
				h(
					"div",
					{ style: { color: MUTED, fontSize: 11, marginTop: 2 } },
					(status === "stale" ? "数据可能过期 · " : "") + "共 " + counts.total + " 个主工作包",
				),
				hostOutdated
					? h(
							"div",
							{
								style: {
									marginTop: 6,
									padding: "6px 8px",
									border: "1px solid #9b2c2c",
									borderRadius: 6,
									color: "#9b2c2c",
									fontSize: 11,
									lineHeight: 1.4,
								},
							},
							"⚠ 页面已是新版，但 DSH 宿主插件还是旧代码（点按钮会 HTTP 405）。请完全退出 DSH 再重新启动，不是只关窗口或刷新页面。",
						)
					: null,

				h("div", { style: sectionTitle }, "AGENT 在忙什么"),
				...agents.map((agent) =>
					h(
						"div",
						{ key: "agent-" + agent.role, style: card, title: agent.detail || "" },
						h(
							"div",
							{ style: { display: "flex", alignItems: "center", gap: 6 } },
							h("span", {
								style: {
									width: 7,
									height: 7,
									borderRadius: "50%",
									background: AGENT_COLOR[agent.status] || AGENT_COLOR.idle,
									flex: "0 0 auto",
								},
							}),
							h("strong", null, agent.role),
							h("span", { style: { color: MUTED, fontSize: 11 } }, AGENT_LABEL[agent.status] || agent.status || ""),
						),
						h("div", { style: { marginTop: 2, fontWeight: 600 } }, agent.task || "—"),
						agent.detail ? h("div", { style: { color: MUTED, fontSize: 11, marginTop: 1 } }, agent.detail) : null,
					),
				),

				h("div", { style: sectionTitle }, "批次里程碑"),
				h(
					"div",
					{ style: { display: "flex", flexWrap: "wrap", gap: 6 } },
					...milestones.map((ms) =>
						h(
							"span",
							{
								key: "ms-" + ms.id,
								title: ms.note || "",
								style: { ...card, marginBottom: 0, display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11 },
							},
							h("span", {
								style: { width: 6, height: 6, borderRadius: "50%", background: STAGE_COLOR[ms.status] || "rgba(128,128,128,0.7)" },
							}),
							ms.label,
							h("span", { style: { color: MUTED } }, "· " + (MS_LABEL[ms.status] || ms.status)),
						),
					),
				),

				h("div", { style: sectionTitle }, "人类待办（只有你能勾）"),
				...todos.map((todo) =>
					h(
						"label",
						{
							key: "todo-" + todo.id,
							title: todo.note || "",
							style: { ...card, padding: "5px 7px", display: "flex", gap: 8, alignItems: "baseline", cursor: "pointer" },
						},
						h("input", {
							type: "checkbox",
							checked: Boolean(todo.done),
							onChange: () => onToggle && onToggle(todo.id),
							style: { margin: 0 },
						}),
						h(
							"span",
							{
								style: {
									flex: "1 1 auto",
									textDecoration: todo.done ? "line-through" : "none",
									color: todo.done ? MUTED : "inherit",
								},
							},
							todo.text,
						),
						h("span", { style: { color: MUTED, fontSize: 10, whiteSpace: "nowrap" } }, todo.id),
					),
				),
				todos.length ? null : h("div", { style: { color: MUTED, fontSize: 11 } }, "（暂无）"),

				...STAGE_ORDER.map((stage) => {
					const items = packages.filter((pkg) => pkg.stage === stage);
					if (!items.length) return null;
					return h(
						"div",
						{ key: "stage-" + stage },
						h(
							"div",
							{ style: sectionTitle },
							h("span", {
								style: {
									display: "inline-block",
									width: 6,
									height: 6,
									borderRadius: 2,
									marginRight: 6,
									background: STAGE_COLOR[stage],
								},
							}),
							(STAGE_LABELS[stage] || stage) + " " + items.length,
						),
						...items.map((pkg) => {
							const actionable = pkg.stage === "awaiting_accept" || pkg.stage === "unverified";
							const showAccept = actionable && typeof onAccept === "function" && !hostOutdated;
							const showCancel = pkg.stage !== "done" && typeof onCancel === "function" && !hostOutdated;
							return h(
								"div",
								{ key: pkg.id, style: { ...card, padding: "6px 7px" }, title: pkg.note || "" },
								h(
									"div",
									{ style: { display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" } },
									h("strong", { style: { fontSize: 12 } }, pkg.id),
									pkg.priority ? h("span", { style: { color: MUTED, fontSize: 10 } }, pkg.priority) : null,
									h("span", { style: { marginLeft: "auto", color: MUTED, fontSize: 10 } }, pkg.owner || ""),
								),
								pkg.scope
									? h("div", { style: { marginTop: 2, fontSize: 11.5, fontWeight: 600, lineHeight: 1.35 } }, pkg.scope)
									: null,
								pkg.note
									? h(
											"div",
											{
												style: {
													marginTop: 2,
													color: MUTED,
													fontSize: 10.5,
													display: "-webkit-box",
													WebkitLineClamp: 2,
													WebkitBoxOrient: "vertical",
													overflow: "hidden",
												},
											},
											pkg.note,
										)
									: null,
								showAccept || showCancel || pkg.stage === "done"
									? h(
											"div",
											{ style: { display: "flex", gap: 6, marginTop: 5, flexWrap: "wrap", alignItems: "center" } },
											showAccept
												? h(
														"button",
														{
															type: "button",
															style: actionButton("#2f6f4f"),
															onClick: (event) => {
																event.stopPropagation();
																onAccept(pkg);
															},
														},
														"验收完成",
													)
												: null,
											showCancel
												? h(
														"button",
														{
															type: "button",
															style: actionButton("#9b2c2c"),
															onClick: (event) => {
																event.stopPropagation();
																onCancel(pkg);
															},
														},
														"取消",
													)
												: null,
											pkg.stage === "done" ? h("span", { style: { color: MUTED, fontSize: 10 } }, "已验收") : null,
										)
									: null,
							);
						}),
					);
				}),

				h("div", { style: { ...sectionTitle, marginTop: 16 } }, "已完成归档（独立区域）"),
				...archived.map((pkg) =>
					h(
						"div",
						{ key: "arch-" + pkg.id, style: { ...card, padding: "5px 7px" }, title: pkg.note || "" },
						h(
							"div",
							{ style: { display: "flex", gap: 6, alignItems: "baseline" } },
							h("strong", { style: { fontSize: 12 } }, pkg.id),
							h("span", { style: { marginLeft: "auto", color: MUTED, fontSize: 10 } }, fmtTime(pkg.archivedAt)),
						),
						pkg.scope ? h("div", { style: { marginTop: 2, fontSize: 11, fontWeight: 600 } }, pkg.scope) : null,
						h("div", { style: { color: MUTED, fontSize: 10, marginTop: 1 } }, pkg.archiveReason || "历史迁移项"),
						pkg.canceled ? h("div", { style: { color: "#9b2c2c", fontSize: 10, marginTop: 1 } }, "已取消（未验收）") : null,
					),
				),
				archived.length ? null : h("div", { style: { color: MUTED, fontSize: 11 } }, "（暂无）"),

				h(
					"div",
					{ style: { ...sectionTitle, marginTop: 18 } },
					"来源：state.json · 运行状态.json · 人类待办.json · 每 5 秒自动刷新",
				),
			);
		}

		function useSnapshot() {
			const [state, setState] = react.useState({ status: "loading", snapshot: null, error: null, hostOutdated: false });
			const [nonce, setNonce] = react.useState(0);
			react.useEffect(() => {
				let alive = true;
				const load = async () => {
					try {
						const response = await fetch(API, { cache: "no-store", credentials: "same-origin" });
						if (!response.ok) throw new Error("HTTP " + response.status);
						const snapshot = await response.json();
						// 新宿主对 GET 验收接口返回 405（只接受 POST）；旧宿主直接 404。
						// 这样页面重启前就能正确提示“需要重启”，而不是等用户点了才弹 405。
						let hostOutdated = false;
						try {
							const probe = await fetch(ACCEPT, { method: "GET", cache: "no-store", credentials: "same-origin" });
							hostOutdated = probe.status === 404;
						} catch {}
						if (alive) setState({ status: "ready", snapshot, error: null, hostOutdated });
					} catch (error) {
						if (!alive) return;
						setState((previous) => ({
							status: previous.snapshot ? "stale" : "error",
							snapshot: previous.snapshot,
							error: String(error && error.message ? error.message : error),
							hostOutdated: previous.hostOutdated === true,
						}));
					}
				};
				load();
				// 事件驱动：宿主 watch 数据文件，变了才推送；EventSource 不可用才退回 30s 轮询。
				let source;
				let timer;
				const startPolling = () => {
					if (timer) return;
					timer = setInterval(() => {
						if (typeof document === "undefined" || !document.hidden) load();
					}, 30000);
				};
				if (typeof window !== "undefined" && window.EventSource) {
					source = new window.EventSource(EVENTS);
					source.onmessage = () => {
						if (typeof document === "undefined" || !document.hidden) load();
					};
					source.onerror = startPolling;
					if (typeof document !== "undefined") {
						document.addEventListener("visibilitychange", () => {
							if (!document.hidden) load();
						});
					}
				} else {
					startPolling();
				}
				return () => {
					alive = false;
					if (source) source.close();
					if (timer) clearInterval(timer);
				};
			}, [nonce]);
			return { ...state, reload: () => setNonce((value) => value + 1) };
		}

		function BoardBody() {
			const { status, snapshot, error, hostOutdated, reload } = useSnapshot();
			const onToggle = react.useCallback(
				async (id) => {
					try {
						await fetch(TOGGLE, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ id }),
							credentials: "same-origin",
						});
					} finally {
						reload();
					}
				},
				[reload],
			);
			const runAction = react.useCallback(
				async (url, pkg, confirmText) => {
					if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(confirmText)) {
						return;
					}
					try {
						const response = await fetch(url, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ id: pkg.id }),
							credentials: "same-origin",
						});
						const result = await response.json().catch(() => ({}));
						if (response.status === 405) {
							throw new Error("宿主插件还是旧代码（HTTP 405）；请完全退出 DSH 后重新启动，不是只关窗口或刷新页面。");
						}
						if (response.status === 404) {
							throw new Error("宿主缺少验收接口（HTTP 404）；请确认 dsh-p4deck-board 已更新并重启 DSH。");
						}
						if (!response.ok || result.ok === false) {
							throw new Error(result.reason || "HTTP " + response.status);
						}
					} catch (actionError) {
						if (typeof window !== "undefined" && typeof window.alert === "function") {
							window.alert("操作失败：" + (actionError && actionError.message ? actionError.message : actionError));
						}
					} finally {
						reload();
					}
				},
				[reload],
			);
			const onAccept = react.useCallback(
				(pkg) => {
					const forced = !(pkg.qaPassed && pkg.applied);
					const text =
						"确认把 " +
						pkg.id +
						" 标为人工验收通过？" +
						(forced ? "\n\n注意：这项没有 QA/Apply 回执，会按一键补登记录。" : "");
					return runAction(ACCEPT, pkg, text);
				},
				[runAction],
			);
			const onCancel = react.useCallback(
				(pkg) =>
					runAction(
						CANCEL,
						pkg,
						"确认取消 " + pkg.id + " 并归档？\n\n取消后不再出现在活跃看板（记“取消范围”，不算验收通过）。",
					),
				[runAction],
			);
			return h(BoardView, { snapshot, status, error, onToggle, onAccept, onCancel, hostOutdated });
		}

		function BoardTitle() {
			return h("span", { style: { fontSize: 12 } }, "看板");
		}

		function BoardIcon() {
			return h(
				"svg",
				{ width: 14, height: 14, viewBox: "0 0 16 16", "aria-hidden": "true", fill: "currentColor" },
				h("rect", { x: 1, y: 1, width: 4, height: 6, rx: 1 }),
				h("rect", { x: 6, y: 1, width: 4, height: 9, rx: 1, opacity: 0.75 }),
				h("rect", { x: 11, y: 1, width: 4, height: 4, rx: 1, opacity: 0.55 }),
			);
		}

		/** 必需服务：插槽注册表 + 右侧栏标签类型 + 右侧栏导航。 */
		const inject = ["slots", "sidebarRightTabs", "sidebarRight"];

		function openBoard(ctx, target) {
			if (target !== undefined && typeof ctx.sidebarRight.openTabFromTarget === "function") {
				ctx.sidebarRight.openTabFromTarget(BOARD_KIND, target);
				return;
			}
			ctx.sidebarRight.openTab(BOARD_KIND);
		}

		function apply(ctx) {
			// guide 条目必须挂命令才会显示，因此先登记命令。
			ctx.inject(["shortcuts"], (ctx) => {
				ctx.effect(
					() =>
						ctx.shortcuts.register({
							id: "p4deck.board",
							label: () => "工作流看板",
							aliases: ["p4deck board", "workflow board", "看板"],
							regions: ["page", "editable", "terminal"],
							modals: [],
							resolve: ({ target: element }) => {
								const target =
									typeof ctx.sidebarRight.commandTarget === "function"
										? ctx.sidebarRight.commandTarget(element)
										: undefined;
								return {
									status: "handled",
									run: () => {
										try {
											openBoard(ctx, target);
										} catch {
											ctx.sidebarRight.openTab(BOARD_KIND);
										}
									},
								};
							},
						}),
					"p4deck-board: shortcut",
				);
			});
			ctx.effect(
				() =>
					ctx.sidebarRightTabs.register({
						id: BOARD_ID,
						kind: BOARD_KIND,
						priority: "builtin",
						title: () => "看板",
						guide: [
							{
								id: "p4deck-board",
								commandId: "p4deck.board",
								order: 5,
								title: () => "工作流看板",
								description: () => "任务状态与 Agent 忙闲",
								icon: BoardIcon,
							},
						],
					}),
				"p4deck-board: tab type",
			);
			ctx.effect(
				() =>
					ctx.slots.inject("sidebar.right.pane.tab", () =>
						ctx.slots.register({ name: "sidebar.right.pane.tab", key: BOARD_ID }, BoardBody),
					),
				"p4deck-board: tab body",
			);
			ctx.effect(
				() =>
					ctx.slots.inject("sidebar.right.pane.tab.title", () =>
						ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: BOARD_ID }, BoardTitle),
					),
				"p4deck-board: tab title",
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.BoardView = BoardView;
		return module.exports;
	},
});
