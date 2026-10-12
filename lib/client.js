window.__ModuleLoader__.load({
	id: "dsh-connect-accio",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const jsx = require("react/jsx-runtime");

		/** Plugin-owned host route serving account + credit data. */
		const CREDITS_PATH = "/plugins/dsh-connect-accio/credits";

		// ------------------------------------------------------------------
		// Formatting
		// ------------------------------------------------------------------

		/** Credits are fractional (a cheap model bills 0.01), so keep 2 places. */
		function fmtNum(value) {
			if (typeof value !== "number" || !Number.isFinite(value)) return "—";
			return Number.isInteger(value) ? String(value) : value.toFixed(2);
		}

		function fmtDate(ms) {
			if (typeof ms !== "number" || ms <= 0) return "—";
			return new Date(ms).toLocaleString();
		}

		function fmtDay(ms) {
			if (typeof ms !== "number" || ms <= 0) return "—";
			return new Date(ms).toLocaleDateString();
		}

		/** Human "7 hours 12 min" from a second count, for the daily reset timer. */
		function fmtCountdown(seconds, t) {
			if (typeof seconds !== "number" || seconds <= 0) return "—";
			const h = Math.floor(seconds / 3600);
			const m = Math.floor((seconds % 3600) / 60);
			if (h >= 24) return t("countdown.days", { days: Math.floor(h / 24), hours: h % 24 });
			if (h > 0) return t("countdown.hours", { hours: h, minutes: m });
			return t("countdown.minutes", { minutes: m });
		}

		// ------------------------------------------------------------------
		// Copy
		// ------------------------------------------------------------------

		const zh = {
			"card.title": "Accio 账号",
			"card.subtitle": "本机已登录的 Accio 账号与积分",
			"action.refresh": "刷新",
			"action.refreshing": "刷新中…",

			"account.title": "账号信息",
			"account.name": "用户名",
			"account.email": "邮箱",
			"account.id": "账号 ID",
			"account.accioId": "Accio ID",
			"account.plan": "套餐",
			"account.region": "区域",
			"account.mobile": "手机",
			"account.mobileBound": "已绑定",
			"account.mobileUnbound": "未绑定",

			"credits.title": "积分详情",
			"credits.daily": "每日积分",
			"credits.monthly": "套餐积分",
			"credits.referral": "额外积分",
			"credits.total": "总计",
			"credits.used": "已用",
			"credits.resetIn": "每日重置倒计时",
			"credits.expiresAt": "有效期至",

			"checkin.title": "每日签到",
			"checkin.unsupported": "Accio 无签到接口",
			"checkin.explain": "每日积分由服务端自动发放（DAILY_REWARD），无需手动领取；本卡片因此不提供签到按钮——不存在可调用的签到接口。",

			"grants.title": "积分来源",
			"grants.source": "来源",
			"grants.amount": "数量",
			"grants.expires": "有效期至",
			"grants.expired": "已过期",

			"usage.title": "最近用量",
			"usage.time": "时间",
			"usage.model": "模型",
			"usage.consumed": "消耗",
			"usage.total": "共 {total} 条",

			"state.loading": "正在读取账号与积分…",
			"state.error": "读取失败",
			"state.signedOut": "未登录或登录已失效，请在 Accio 客户端重新登录",
			"state.retry": "重试",

			"countdown.days": "{days} 天 {hours} 小时",
			"countdown.hours": "{hours} 小时 {minutes} 分",
			"countdown.minutes": "{minutes} 分",
		};

		const en = {
			"card.title": "Accio account",
			"card.subtitle": "The Accio account signed in on this machine, with credits",
			"action.refresh": "Refresh",
			"action.refreshing": "Refreshing…",

			"account.title": "Account",
			"account.name": "Name",
			"account.email": "Email",
			"account.id": "User ID",
			"account.accioId": "Accio ID",
			"account.plan": "Plan",
			"account.region": "Region",
			"account.mobile": "Mobile",
			"account.mobileBound": "bound",
			"account.mobileUnbound": "not bound",

			"credits.title": "Credits",
			"credits.daily": "Daily credits",
			"credits.monthly": "Plan credits",
			"credits.referral": "Add-on credits",
			"credits.total": "Total",
			"credits.used": "used",
			"credits.resetIn": "Daily reset in",
			"credits.expiresAt": "Expires",

			"checkin.title": "Daily check-in",
			"checkin.unsupported": "no API in Accio",
			"checkin.explain": "Daily credits are granted automatically by the server as a DAILY_REWARD, so there is nothing to claim. No check-in button is shown because no check-in endpoint exists.",

			"grants.title": "Credit sources",
			"grants.source": "Source",
			"grants.amount": "Amount",
			"grants.expires": "Expires",
			"grants.expired": "expired",

			"usage.title": "Recent usage",
			"usage.time": "When",
			"usage.model": "Model",
			"usage.consumed": "Cost",
			"usage.total": "{total} records",

			"state.loading": "Reading account and credits…",
			"state.error": "Could not load",
			"state.signedOut": "Not signed in, or the session expired. Sign in again in the Accio app.",
			"state.retry": "Retry",

			"countdown.days": "{days}d {hours}h",
			"countdown.hours": "{hours}h {minutes}m",
			"countdown.minutes": "{minutes}m",
		};

		// ------------------------------------------------------------------
		// Styles
		// ------------------------------------------------------------------

		const STYLE_ID = "dsm-accio-card-style";
		const CSS = [
			".dsm-accio{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.5}",
			".dsm-accio-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}",
			".dsm-accio-title{font-weight:600;font-size:14px}",
			".dsm-accio-sub{opacity:.65;font-size:12px;margin-top:2px}",
			".dsm-accio-btn{border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer}",
			".dsm-accio-btn:hover:not(:disabled){background:rgba(127,127,127,.12)}",
			".dsm-accio-btn:disabled{opacity:.5;cursor:default}",
			".dsm-accio-section{border:1px solid rgba(127,127,127,.22);border-radius:8px;padding:10px 12px}",
			".dsm-accio-section-title{font-weight:600;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:8px}",
			".dsm-accio-grid{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:0}",
			".dsm-accio-grid dt{opacity:.6}",
			".dsm-accio-grid dd{margin:0;word-break:break-all}",
			".dsm-accio-buckets{display:flex;flex-direction:column;gap:10px}",
			".dsm-accio-bucket-head{display:flex;justify-content:space-between;gap:8px;margin-bottom:4px}",
			".dsm-accio-bucket-name{font-weight:500}",
			".dsm-accio-bucket-meta{opacity:.65;font-size:12px}",
			".dsm-accio-bar{height:6px;border-radius:3px;background:rgba(127,127,127,.2);overflow:hidden}",
			".dsm-accio-bar > i{display:block;height:100%;background:currentColor;opacity:.55}",
			".dsm-accio-table{width:100%;border-collapse:collapse;font-size:12px}",
			".dsm-accio-table th{text-align:left;font-weight:500;opacity:.6;padding:3px 6px 3px 0;border-bottom:1px solid rgba(127,127,127,.22);white-space:nowrap}",
			".dsm-accio-table td{padding:3px 6px 3px 0;border-bottom:1px solid rgba(127,127,127,.1);vertical-align:top}",
			".dsm-accio-table tr:last-child td{border-bottom:none}",
			".dsm-accio-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}",
			".dsm-accio-dim{opacity:.6}",
			".dsm-accio-badge{display:inline-block;border-radius:4px;padding:1px 6px;font-size:11px;border:1px solid rgba(127,127,127,.35);opacity:.8}",
			".dsm-accio-note{opacity:.7;font-size:12px}",
			".dsm-accio-error{color:#d9534f;font-size:12px}",
			".dsm-accio-scroll{max-height:220px;overflow:auto}",
		].join("\n");

		function ensureStyles() {
			if (typeof document === "undefined") return;
			if (document.getElementById(STYLE_ID) !== null) return;
			const el = document.createElement("style");
			el.id = STYLE_ID;
			el.textContent = CSS;
			document.head.appendChild(el);
		}

		// ------------------------------------------------------------------
		// Card
		// ------------------------------------------------------------------

		/** One credit bucket: a labelled usage bar with remaining/total and expiry. */
		function Bucket({ name, bucket, t }) {
			if (bucket === undefined || bucket === null) return null;
			const total = bucket.total || 0;
			const used = bucket.used || 0;
			const remaining = bucket.remaining || 0;
			const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
			const expire = bucket.expiringSoon ? bucket.expiringSoon.expireTime : undefined;
			return jsx.jsxs("div", { children: [
				jsx.jsxs("div", { className: "dsm-accio-bucket-head", children: [
					jsx.jsx("span", { className: "dsm-accio-bucket-name", children: name }),
					jsx.jsxs("span", { className: "dsm-accio-bucket-meta", children: [
						fmtNum(remaining), " / ", fmtNum(total), " ",
						jsx.jsxs("span", { className: "dsm-accio-dim", children: ["(", t("credits.used"), " ", fmtNum(used), ")"] }),
					] }),
				] }),
				jsx.jsx("div", { className: "dsm-accio-bar", children: jsx.jsx("i", { style: { width: pct + "%" } }) }),
				expire === undefined ? null : jsx.jsxs("div", {
					className: "dsm-accio-bucket-meta",
					children: [t("credits.expiresAt"), " ", fmtDay(Number(expire))],
				}),
			] });
		}

		function AccioCard({ t }) {
			const [state, setState] = react.useState({ phase: "loading" });

			const load = react.useCallback(async () => {
				setState({ phase: "loading" });
				try {
					const res = await fetch(CREDITS_PATH, { headers: { Accept: "application/json" } });
					const body = await res.json().catch(() => undefined);
					if (res.status === 401) {
						setState({ phase: "signedOut" });
						return;
					}
					if (!res.ok || body === undefined || body.error !== undefined) {
						setState({ phase: "error", message: (body && body.error) || ("HTTP " + res.status) });
						return;
					}
					setState({ phase: "ready", data: body });
				} catch (error) {
					setState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
				}
			}, []);

			react.useEffect(() => {
				ensureStyles();
				void load();
			}, [load]);

			const header = jsx.jsxs("div", { className: "dsm-accio-head", children: [
				jsx.jsxs("div", { children: [
					jsx.jsx("div", { className: "dsm-accio-title", children: t("card.title") }),
					jsx.jsx("div", { className: "dsm-accio-sub", children: t("card.subtitle") }),
				] }),
				jsx.jsx("button", {
					className: "dsm-accio-btn",
					disabled: state.phase === "loading",
					onClick: () => { void load(); },
					children: state.phase === "loading" ? t("action.refreshing") : t("action.refresh"),
				}),
			] });

			if (state.phase === "loading") {
				return jsx.jsxs("div", { className: "dsm-accio", children: [
					header,
					jsx.jsx("div", { className: "dsm-accio-note", children: t("state.loading") }),
				] });
			}
			if (state.phase === "signedOut") {
				return jsx.jsxs("div", { className: "dsm-accio", children: [
					header,
					jsx.jsx("div", { className: "dsm-accio-note", children: t("state.signedOut") }),
				] });
			}
			if (state.phase === "error") {
				return jsx.jsxs("div", { className: "dsm-accio", children: [
					header,
					jsx.jsxs("div", { children: [
						jsx.jsxs("div", { className: "dsm-accio-error", children: [t("state.error"), ": ", state.message] }),
						jsx.jsx("button", {
							className: "dsm-accio-btn",
							onClick: () => { void load(); },
							children: t("state.retry"),
						}),
					] }),
				] });
			}

			const d = state.data;
			const user = d.user;
			const sub = d.subscription || {};
			const quota = d.quota || {};
			const grants = d.grants || [];
			const usageItems = (d.usage && d.usage.items) || [];

			const rows = [];
			if (user !== undefined && user !== null) {
				rows.push(jsx.jsx("dt", { children: t("account.name") }, "n"));
				rows.push(jsx.jsx("dd", { children: user.name || "—" }, "nv"));
				rows.push(jsx.jsx("dt", { children: t("account.email") }, "e"));
				rows.push(jsx.jsx("dd", { children: user.email || "—" }, "ev"));
				rows.push(jsx.jsx("dt", { children: t("account.id") }, "i"));
				rows.push(jsx.jsx("dd", { children: user.userId || "—" }, "iv"));
				rows.push(jsx.jsx("dt", { children: t("account.accioId") }, "a"));
				rows.push(jsx.jsx("dd", { children: user.accioId || "—" }, "av"));
				rows.push(jsx.jsx("dt", { children: t("account.plan") }, "p"));
				rows.push(jsx.jsxs("dd", { children: [
					jsx.jsx("span", { className: "dsm-accio-badge", children: user.userLevel || sub.type || "—" }),
					sub.planName ? " " + sub.planName : null,
				] }, "pv"));
				rows.push(jsx.jsx("dt", { children: t("account.region") }, "r"));
				rows.push(jsx.jsx("dd", { children: user.routeRegion || "—" }, "rv"));
				rows.push(jsx.jsx("dt", { children: t("account.mobile") }, "m"));
				rows.push(jsx.jsx("dd", {
					children: user.mobileBound
						? (user.maskedMobile || "—") + " (" + t("account.mobileBound") + ")"
						: t("account.mobileUnbound"),
				}, "mv"));
			}

			return jsx.jsxs("div", { className: "dsm-accio", children: [
				header,

				rows.length === 0 ? null : jsx.jsxs("div", { className: "dsm-accio-section", children: [
					jsx.jsx("div", { className: "dsm-accio-section-title", children: t("account.title") }),
					jsx.jsx("dl", { className: "dsm-accio-grid", children: rows }),
				] }),

				jsx.jsxs("div", { className: "dsm-accio-section", children: [
					jsx.jsx("div", { className: "dsm-accio-section-title", children: t("credits.title") }),
					jsx.jsxs("div", { className: "dsm-accio-buckets", children: [
						jsx.jsx(Bucket, { name: t("credits.daily"), bucket: sub.daily, t }),
						jsx.jsx(Bucket, { name: t("credits.monthly"), bucket: sub.monthly, t }),
						jsx.jsx(Bucket, { name: t("credits.referral"), bucket: sub.referral, t }),
					] }),
					jsx.jsxs("div", {
						className: "dsm-accio-bucket-meta",
						style: { marginTop: "8px" },
						children: [
							t("credits.total"), ": ", fmtNum(sub.remaining), " / ", fmtNum(sub.total),
							typeof quota.refreshCountdownSeconds === "number"
								? " · " + t("credits.resetIn") + " " + fmtCountdown(quota.refreshCountdownSeconds, t)
								: "",
						],
					}),
				] }),

				jsx.jsxs("div", { className: "dsm-accio-section", children: [
					jsx.jsx("div", { className: "dsm-accio-section-title", children: [
						jsx.jsx("span", { children: t("checkin.title") }),
						jsx.jsx("span", { className: "dsm-accio-badge", children: t("checkin.unsupported") }),
					] }),
					jsx.jsx("div", { className: "dsm-accio-note", children: t("checkin.explain") }),
				] }),

				grants.length === 0 ? null : jsx.jsxs("div", { className: "dsm-accio-section", children: [
					jsx.jsx("div", { className: "dsm-accio-section-title", children: t("grants.title") }),
					jsx.jsx("div", { className: "dsm-accio-scroll", children: jsx.jsxs("table", {
						className: "dsm-accio-table",
						children: [
							jsx.jsx("thead", { children: jsx.jsxs("tr", { children: [
								jsx.jsx("th", { children: t("grants.source") }),
								jsx.jsx("th", { className: "dsm-accio-num", children: t("grants.amount") }),
								jsx.jsx("th", { children: t("grants.expires") }),
							] }) }),
							jsx.jsx("tbody", { children: grants.map((g, i) => {
								const expired = g.expiresAt > 0 && g.expiresAt < Date.now();
								return jsx.jsxs("tr", { children: [
									jsx.jsxs("td", { children: [
										g.sourceName || g.type || g.source || "—",
										expired ? jsx.jsxs("span", { className: "dsm-accio-dim", children: [" (", t("grants.expired"), ")"] }) : null,
									] }),
									jsx.jsx("td", { className: "dsm-accio-num", children: fmtNum(g.amount) }),
									jsx.jsx("td", { className: "dsm-accio-dim", children: fmtDay(g.expiresAt) }),
								] }, String(g.id === undefined ? i : g.id));
							}) }),
						],
					}) }),
				] }),

				usageItems.length === 0 ? null : jsx.jsxs("div", { className: "dsm-accio-section", children: [
					jsx.jsx("div", { className: "dsm-accio-section-title", children: [
						jsx.jsx("span", { children: t("usage.title") }),
						jsx.jsx("span", {
							className: "dsm-accio-bucket-meta",
							children: t("usage.total", { total: d.usage.total }),
						}),
					] }),
					jsx.jsx("div", { className: "dsm-accio-scroll", children: jsx.jsxs("table", {
						className: "dsm-accio-table",
						children: [
							jsx.jsx("thead", { children: jsx.jsxs("tr", { children: [
								jsx.jsx("th", { children: t("usage.time") }),
								jsx.jsx("th", { children: t("usage.model") }),
								jsx.jsx("th", { className: "dsm-accio-num", children: t("usage.consumed") }),
							] }) }),
							jsx.jsx("tbody", { children: usageItems.map((row, i) => jsx.jsxs("tr", { children: [
								jsx.jsx("td", { className: "dsm-accio-dim", children: fmtDate(row.at) }),
								jsx.jsx("td", { children: row.model || "—" }),
								jsx.jsx("td", { className: "dsm-accio-num", children: fmtNum(row.consumed) }),
							] }, String(i))) }),
						],
					}) }),
				] }),
			] });
		}

		// ------------------------------------------------------------------
		// Registration
		// ------------------------------------------------------------------

		/**
		 * Only the two services the settings line serves unconditionally.
		 *
		 * `configForms` is deliberately absent: this card is read-only, so it needs
		 * no write scope, and requiring one would prevent the card from loading on a
		 * host that does not serve it.
		 */
		const inject = ["slots", "locale"];

		function apply(ctx) {
			try {
				const namespace = "settings.accio";
				ctx.effect(() => ctx.locale.register(namespace, { zh, en }), "dsh-connect-accio: settings copy");
				const t = ctx.locale.bind(namespace);

				const registerCard = (slotName, key) => {
					try {
						ctx.slots.inject(slotName, () => ctx.slots.register({
							name: slotName,
							key,
							priority: 30,
							inject: () => ({ t }),
						}, AccioCard));
					} catch (error) {
						// A slot-API change must not take down the host provider, which is
						// what actually serves models.
						console.error('[dsh-connect-accio] card slot "' + slotName + '" failed to register:', error);
					}
				};

				registerCard("plugins.bundle.config", "dsh-connect-accio");
				registerCard("plugins.row.config", "dsh-connect-accio#dsh-connect-accio");
			} catch (error) {
				console.error("[dsh-connect-accio] settings card failed to register:", error);
			}
		}

		module.exports = { apply, inject, AccioCard };
		return module.exports;
	},
});
