// adapters/canvas/channel.ts
function e(e = {}) {
	let t = e.failure ?? ((e, t) => Object.assign(Error(t.code), {
		status: e,
		detail: t
	})), n = e.location ?? location, r = e.history ?? history, i = new URLSearchParams(n.hash.slice(1)), a = i.get("sf_pair"), o = i.get("sf_instance");
	r.replaceState(r.state, "", n.pathname + n.search);
	let s = n.pathname.match(/^\/open\/([a-f0-9-]{36})$/)?.[1];
	if (!s || !a || !/^[A-Za-z0-9_-]{43}$/.test(a) || !o) throw t(401, {
		code: "UNPAIRED",
		message: "Fresh Canvas admission required",
		recovery: "Close and reopen Software Factory through the native Canvas host.",
		retryable: !1
	});
	let c = new URL("/channel", n.origin);
	c.protocol = n.protocol === "https:" ? "wss:" : "ws:";
	let l = (e.socket ?? ((e) => new WebSocket(e)))(c.href), u = !1, d = 0, f, p = /* @__PURE__ */ new Map(), m = () => {}, h = (e) => {}, g = new Promise((e, t) => {
		m = e, h = t;
	});
	g.catch(() => {});
	let _ = setTimeout(() => v(), 5e3);
	function v() {
		if (u) return;
		u = !0, clearTimeout(_), a = null;
		let e = t(401, {
			code: "UNPAIRED",
			message: "Canvas channel unavailable",
			recovery: "Reopen Software Factory in the native host. Reconcile pending actions before retrying.",
			retryable: !1
		});
		h(e);
		for (let t of p.values()) clearTimeout(t.timer), t.reject(e);
		p.clear(), f?.error(e), f = void 0, l.close();
	}
	return l.addEventListener("open", () => {
		u || (l.send(JSON.stringify({
			type: "admit",
			proof: a,
			instanceId: o,
			documentId: s
		})), a = null);
	}), l.addEventListener("message", (e) => {
		if (!u) try {
			let n = JSON.parse(String(e.data));
			if (n.type === "ready") clearTimeout(_), m();
			else if (n.type === "open") f?.open();
			else if (n.type === "event") f?.event(n.event);
			else if (n.type === "stream-error") f?.error(Error("Event stream requires refresh"));
			else if (n.type === "result" || n.type === "failure") {
				let e = p.get(n.id);
				if (!e) return;
				p.delete(n.id), clearTimeout(e.timer), n.type === "result" ? e.resolve(n.value) : e.reject(n.status && n.detail ? t(n.status, n.detail) : Error("Request outcome unknown; reconcile the original action key"));
			} else v();
		} catch {
			v();
		}
	}), l.addEventListener("close", v), l.addEventListener("error", v), {
		async request(e, t) {
			if (await g, u) throw Error("Canvas disposed");
			let n = ++d;
			return new Promise((r, i) => {
				let a = setTimeout(() => {
					p.delete(n), i(Error("Request outcome unknown; reconcile the original action key"));
				}, 3e4);
				p.set(n, {
					resolve: r,
					reject: i,
					timer: a
				}), l.send(JSON.stringify({
					type: "request",
					id: n,
					operation: e,
					request: t
				}));
			});
		},
		subscribe(e, t) {
			let n = !0;
			return f = t, g.then(() => {
				n && !u && l.send(JSON.stringify({
					type: "subscribe",
					cursor: e
				}));
			}).catch((e) => {
				n && t.error(e);
			}), () => {
				n && (n = !1, f === t && (f = void 0, !u && l.readyState === WebSocket.OPEN && l.send(JSON.stringify({ type: "unsubscribe" }))));
			};
		},
		dispose() {
			f = void 0, v();
		}
	};
}
export { e as createWebSocketTransport };
