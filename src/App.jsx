import { useState, useEffect, useCallback, useRef } from "react";

// ─── Supabase Config ──────────────────────────────────────────────────────────
const SB_URL = "https://qyrqjxbhttaqjgihmzgx.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF5cnFqeGJodHRhcWpnaWhtemd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2NTg5MzQsImV4cCI6MjA4NzIzNDkzNH0.cQC2Vo722Z_LY8X5an2QJqJhavjIstmzNbp2Cjo_51I";

// Decode JWT to get user_id (fixes 403 — no more stale storage read)
function jwtUserId(token) {
  try { return JSON.parse(atob(token.split(".")[1])).sub; } catch { return null; }
}

const sb = async (path, opts = {}, token = null) => {
  const headers = {
    apikey: SB_KEY,
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...opts.headers,
  };
  const res = await fetch(`${SB_URL}${path}`, { ...opts, headers });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    // Fixed: was e.msg (undefined), now checks all Supabase error fields
    throw new Error(e.message || e.error_description || e.msg || `Error ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
};

const authSignup  = (email, pass) => sb("/auth/v1/signup", { method: "POST", body: JSON.stringify({ email, password: pass }) });
const authLogin   = (email, pass) => sb("/auth/v1/token?grant_type=password", { method: "POST", body: JSON.stringify({ email, password: pass }) });
const authRefresh = (rt) => sb("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: rt }) });

const dbGet    = (path, tok)       => sb(path, {}, tok);
const dbPost   = (path, body, tok) => sb(path, { method: "POST",  headers: { Prefer: "return=representation" }, body: JSON.stringify(body) }, tok);
const dbPatch  = (path, body, tok) => sb(path, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(body) }, tok);
const dbDelete = (path, tok)       => sb(path, { method: "DELETE" }, tok);

// ─── Price Fetcher ────────────────────────────────────────────────────────────
async function fetchBatch(syms) {
  const qs = syms.map(s => `${s}.NS`).join(",");
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${qs}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketPreviousClose`;
  for (const src of [url, `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, `https://corsproxy.io/?url=${encodeURIComponent(url)}`]) {
    try {
      const r = await fetch(src, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const d = await r.json();
      const out = {};
      for (const q of (d?.quoteResponse?.result || [])) {
        const sym = q.symbol?.replace(".NS", "");
        if (sym) out[sym] = { ltp: q.regularMarketPrice, change: q.regularMarketChange, pct: q.regularMarketChangePercent };
      }
      if (Object.keys(out).length) return out;
    } catch { /* try next */ }
  }
  return {};
}
async function fetchAllPrices(symbols) {
  if (!symbols.length) return {};
  const chunks = [];
  for (let i = 0; i < symbols.length; i += 10) chunks.push(symbols.slice(i, i + 10));
  const results = await Promise.all(chunks.map(fetchBatch));
  return Object.assign({}, ...results);
}

// ─── Palette ──────────────────────────────────────────────────────────────────
const C = {
  bg: "#181B1C", card: "#222829", cardL: "#2D3436", border: "#3A4244",
  navy: "#0A3D62", navyL: "#1A5276",
  gold: "#D4AF37", goldL: "#E8C84A",
  ivory: "#F9F9F9", ivoryD: "#C0C8C5", muted: "#7A8C8E",
  loss: "#E74C3C",
};
const clr  = n => n == null ? C.muted : n > 0 ? C.gold : n < 0 ? C.loss : C.muted;
const sign = n => n > 0 ? "▲ " : n < 0 ? "▼ " : "";
const fmt  = (n, d = 2) => n == null ? "—" : n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtC = n => { if (n == null) return "—"; const a = Math.abs(n); return a >= 1e7 ? `₹${(a/1e7).toFixed(2)}Cr` : a >= 1e5 ? `₹${(a/1e5).toFixed(2)}L` : `₹${fmt(a)}`; };

const BROKERS     = ["Zerodha","Groww","Upstox","Angel One","ICICI Direct","HDFC Sky","5Paisa","Motilal Oswal","Kotak Securities","Dhan","Fyers","Custom"];
const ACC_COLORS  = ["#D4AF37","#0A3D62","#27AE60","#8E44AD","#E67E22","#E74C3C","#1ABC9C","#3498DB","#F39C12","#9B59B6"];

// ─── Session storage ──────────────────────────────────────────────────────────
const stGet = async k => { try { const r = await window.storage.get(k); return r ? JSON.parse(r.value) : null; } catch { return null; } };
const stSet = async (k, v) => { try { await window.storage.set(k, JSON.stringify(v)); } catch {} };
const stDel = async k => { try { await window.storage.delete(k); } catch {} };

// ─── Responsive hook ──────────────────────────────────────────────────────────
function useIsMobile() {
  const [mobile, setMobile] = useState(window.innerWidth < 768);
  useEffect(() => {
    const h = () => setMobile(window.innerWidth < 768);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return mobile;
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTH SCREEN
// ══════════════════════════════════════════════════════════════════════════════
function AuthScreen({ onAuth }) {
  const [mode, setMode]     = useState("login");
  const [email, setEmail]   = useState("");
  const [pass, setPass]     = useState("");
  const [err, setErr]       = useState("");
  const [loading, setLoading] = useState(false);
  const isMobile = useIsMobile();

  const submit = async () => {
    if (!email || !pass) return setErr("Fill all fields");
    setErr(""); setLoading(true);
    try {
      let data;
      if (mode === "signup") {
        data = await authSignup(email, pass);
        if (!data.access_token) {
          setErr("Check your email to confirm signup, then sign in.");
          setLoading(false); return;
        }
      } else {
        data = await authLogin(email, pass);
      }
      await stSet("pt-session", { access_token: data.access_token, refresh_token: data.refresh_token });
      onAuth(data);
    } catch (e) { setErr(e.message); }
    setLoading(false);
  };

  return (
    <div style={{ background: C.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui,sans-serif", padding: 16 }}>
      <div style={{ width: "100%", maxWidth: 380, background: C.card, borderRadius: 16, border: `1px solid ${C.border}`, overflow: "hidden", boxShadow: "0 32px 80px rgba(0,0,0,.5)" }}>
        <div style={{ height: 4, background: `linear-gradient(90deg,${C.navy},${C.gold},${C.navy})` }} />
        <div style={{ padding: isMobile ? "24px 20px" : "32px 32px 28px" }}>
          {/* Logo */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 28 }}>
            <div style={{ width: 48, height: 48, borderRadius: 12, background: C.navy, display: "flex", alignItems: "center", justifyContent: "center", color: C.gold, fontSize: 24, fontWeight: 700, border: `1px solid ${C.gold}44`, flexShrink: 0 }}>₹</div>
            <div>
              <div style={{ color: C.ivory, fontWeight: 700, fontSize: 18 }}>Portfolio Terminal</div>
              <div style={{ color: C.gold, fontSize: 10, letterSpacing: 2, textTransform: "uppercase" }}>Multi-Demat Tracker</div>
            </div>
          </div>

          {/* Tabs */}
          <div style={{ display: "flex", background: C.cardL, borderRadius: 10, padding: 4, marginBottom: 22 }}>
            {["login", "signup"].map(m => (
              <button key={m} onClick={() => { setMode(m); setErr(""); }}
                style={{ flex: 1, padding: "9px", borderRadius: 8, border: "none", cursor: "pointer", fontWeight: 600, fontSize: 13, background: mode === m ? C.navy : "transparent", color: mode === m ? C.ivory : C.muted, transition: "all .2s" }}>
                {m === "login" ? "Sign In" : "Sign Up"}
              </button>
            ))}
          </div>

          {[["Email", email, setEmail, "email"], ["Password", pass, setPass, "password"]].map(([lbl, val, set, type]) => (
            <div key={lbl} style={{ marginBottom: 14 }}>
              <label style={{ color: C.muted, fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", display: "block", marginBottom: 6 }}>{lbl}</label>
              <input type={type} value={val} onChange={e => set(e.target.value)} onKeyDown={e => e.key === "Enter" && submit()}
                style={{ width: "100%", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: "11px 14px", color: C.ivory, fontSize: 14, outline: "none", boxSizing: "border-box" }} />
            </div>
          ))}

          {err && <div style={{ background: "#E74C3C22", border: "1px solid #E74C3C55", borderRadius: 8, padding: "9px 14px", color: C.loss, fontSize: 13, marginBottom: 14 }}>{err}</div>}

          <button onClick={submit} disabled={loading}
            style={{ width: "100%", background: loading ? C.border : C.gold, border: "none", color: C.bg, borderRadius: 9, padding: "13px", fontWeight: 700, fontSize: 15, cursor: loading ? "not-allowed" : "pointer", marginTop: 4 }}>
            {loading ? "Please wait…" : mode === "login" ? "Sign In →" : "Create Account →"}
          </button>

          <p style={{ color: C.muted, fontSize: 12, textAlign: "center", marginTop: 16, marginBottom: 0 }}>
            {mode === "login" ? "No account? " : "Already have one? "}
            <span onClick={() => { setMode(mode === "login" ? "signup" : "login"); setErr(""); }}
              style={{ color: C.gold, cursor: "pointer", fontWeight: 600 }}>
              {mode === "login" ? "Sign up free" : "Sign in"}
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// HOLDING MODAL
// ══════════════════════════════════════════════════════════════════════════════
function HoldingModal({ holding, accounts, token, onSave, onClose }) {
  const uid = jwtUserId(token);
  const [form, setForm] = useState({
    account_id: holding?.account_id ?? accounts[0]?.id ?? "",
    symbol: holding?.symbol ?? "",
    exchange: holding?.exchange ?? "NSE",
    qty: holding?.qty ?? "",
    avg_price: holding?.avg_price ?? "",
  });
  const [symText, setSymText] = useState(holding?.symbol ?? "");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const timerRef = useRef(null);
  const isMobile = useIsMobile();

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const searchStock = (q) => {
    clearTimeout(timerRef.current);
    if (!q) { setResults([]); return; }
    timerRef.current = setTimeout(async () => {
      try {
        const r = await dbGet(`/rest/v1/nse_stocks?or=(symbol.ilike.*${encodeURIComponent(q)}*,company_name.ilike.*${encodeURIComponent(q)}*)&select=symbol,company_name,sector,market_cap_category&limit=8`, token);
        setResults(r || []);
      } catch { setResults([]); }
    }, 300);
  };

  const submit = async () => {
    if (!form.symbol || !form.qty || !form.avg_price || !form.account_id) return setErr("Please fill all fields");
    if (!uid) return setErr("Session expired, please logout and login again");
    setLoading(true); setErr("");
    try {
      const body = { account_id: form.account_id, symbol: form.symbol, exchange: form.exchange, qty: Number(form.qty), avg_price: Number(form.avg_price), user_id: uid };
      if (holding) await dbPatch(`/rest/v1/holdings?id=eq.${holding.id}`, { account_id: form.account_id, symbol: form.symbol, exchange: form.exchange, qty: Number(form.qty), avg_price: Number(form.avg_price) }, token);
      else await dbPost("/rest/v1/holdings", body, token);
      onSave();
    } catch (e) { setErr(e.message); }
    setLoading(false);
  };

  return (
    <div style={MS.overlay} onClick={onClose}>
      <div style={{ ...MS.modal, maxWidth: isMobile ? "100%" : 480, margin: isMobile ? "0" : "auto", borderRadius: isMobile ? "16px 16px 0 0" : 14, position: isMobile ? "fixed" : "relative", bottom: isMobile ? 0 : "auto", left: isMobile ? 0 : "auto", right: isMobile ? 0 : "auto" }}
        onClick={e => e.stopPropagation()}>
        {/* Handle bar on mobile */}
        {isMobile && <div style={{ width: 40, height: 4, background: C.border, borderRadius: 2, margin: "0 auto 16px" }} />}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
          <div>
            <div style={{ color: C.gold, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", fontSize: 13 }}>{holding ? "Edit Holding" : "Add Holding"}</div>
            <div style={{ color: C.muted, fontSize: 11, marginTop: 3 }}>Search 200+ NSE stocks</div>
          </div>
          <button onClick={onClose} style={MS.closeBtn}>✕</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div style={MS.fg}>
            <label style={MS.lbl}>Account</label>
            <select style={MS.inp} value={form.account_id} onChange={e => set("account_id", e.target.value)}>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name} — {a.broker}</option>)}
            </select>
          </div>
          <div style={MS.fg}>
            <label style={MS.lbl}>Exchange</label>
            <select style={MS.inp} value={form.exchange} onChange={e => set("exchange", e.target.value)}>
              <option>NSE</option><option>BSE</option>
            </select>
          </div>

          {/* Stock search */}
          <div style={{ ...MS.fg, gridColumn: "1/-1", position: "relative" }}>
            <label style={MS.lbl}>Stock Symbol / Company Name</label>
            <input style={MS.inp} placeholder="Search: RELIANCE, Infosys, HAL…" value={symText}
              onChange={e => { const v = e.target.value.toUpperCase(); setSymText(v); set("symbol", v); searchStock(v); }} />
            {results.length > 0 && (
              <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, background: C.card, border: `1px solid ${C.gold}55`, borderRadius: 10, zIndex: 50, overflow: "hidden", boxShadow: "0 12px 40px rgba(0,0,0,.6)", maxHeight: 260, overflowY: "auto" }}>
                {results.map(s => (
                  <div key={s.symbol} onClick={() => { set("symbol", s.symbol); setSymText(s.symbol); setResults([]); }}
                    style={{ padding: "10px 14px", cursor: "pointer", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ color: C.gold, fontWeight: 700, fontSize: 13 }}>{s.symbol}</div>
                      <div style={{ color: C.ivoryD, fontSize: 11 }}>{s.company_name} · {s.sector}</div>
                    </div>
                    <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: s.market_cap_category === "LARGE" ? `${C.navy}88` : "#1A3A2A", color: s.market_cap_category === "LARGE" ? "#7EB4D8" : "#7EC8A0", letterSpacing: 0.5 }}>
                      {s.market_cap_category}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={MS.fg}>
            <label style={MS.lbl}>Quantity</label>
            <input style={MS.inp} type="number" placeholder="100" value={form.qty} onChange={e => set("qty", e.target.value)} />
          </div>
          <div style={MS.fg}>
            <label style={MS.lbl}>Avg Buy Price (₹)</label>
            <input style={MS.inp} type="number" placeholder="250.50" value={form.avg_price} onChange={e => set("avg_price", e.target.value)} />
          </div>

          {form.qty && form.avg_price && (
            <div style={{ gridColumn: "1/-1", background: C.bg, borderRadius: 8, padding: "12px 16px", border: `1px solid ${C.gold}33`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ color: C.muted, fontSize: 13 }}>Total Invested</span>
              <span style={{ color: C.gold, fontWeight: 700, fontSize: 17 }}>₹{fmt(Number(form.qty) * Number(form.avg_price))}</span>
            </div>
          )}
        </div>

        {err && <div style={{ color: C.loss, fontSize: 12, marginTop: 10, background: "#E74C3C11", borderRadius: 6, padding: "8px 12px" }}>{err}</div>}
        <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
          <button onClick={onClose} style={MS.cancelBtn}>Cancel</button>
          <button onClick={submit} disabled={loading} style={{ ...MS.saveBtn, opacity: loading ? .6 : 1 }}>{loading ? "Saving…" : holding ? "Update" : "Add to Portfolio"}</button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ACCOUNT MODAL
// ══════════════════════════════════════════════════════════════════════════════
function AccountModal({ account, token, onSave, onClose }) {
  const uid = jwtUserId(token);
  const [name,   setName]   = useState(account?.name   ?? "");
  const [broker, setBroker] = useState(account?.broker ?? "Zerodha");
  const [color,  setColor]  = useState(account?.color  ?? ACC_COLORS[0]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const isMobile = useIsMobile();

  const submit = async () => {
    if (!name.trim()) return setErr("Enter account name");
    if (!uid) return setErr("Session expired, please re-login");
    setLoading(true); setErr("");
    try {
      if (account) {
        await dbPatch(`/rest/v1/accounts?id=eq.${account.id}`, { name: name.trim(), broker, color }, token);
      } else {
        // user_id decoded from JWT — this is what RLS checks against auth.uid()
        await dbPost("/rest/v1/accounts", { name: name.trim(), broker, color, user_id: uid }, token);
      }
      onSave();
    } catch (e) { setErr(e.message); }
    setLoading(false);
  };

  return (
    <div style={MS.overlay} onClick={onClose}>
      <div style={{ ...MS.modal, maxWidth: isMobile ? "100%" : 360, margin: isMobile ? "0" : "auto", borderRadius: isMobile ? "16px 16px 0 0" : 14, position: isMobile ? "fixed" : "relative", bottom: isMobile ? 0 : "auto", left: isMobile ? 0 : "auto", right: isMobile ? 0 : "auto" }}
        onClick={e => e.stopPropagation()}>
        {isMobile && <div style={{ width: 40, height: 4, background: C.border, borderRadius: 2, margin: "0 auto 16px" }} />}

        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 20 }}>
          <div style={{ color: C.gold, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, fontSize: 13 }}>{account ? "Edit Account" : "New Account"}</div>
          <button onClick={onClose} style={MS.closeBtn}>✕</button>
        </div>

        <div style={{ ...MS.fg, marginBottom: 14 }}>
          <label style={MS.lbl}>Account Name</label>
          <input style={MS.inp} placeholder="e.g. Zerodha Primary" value={name} onChange={e => setName(e.target.value)} />
        </div>
        <div style={{ ...MS.fg, marginBottom: 14 }}>
          <label style={MS.lbl}>Broker</label>
          <select style={MS.inp} value={broker} onChange={e => setBroker(e.target.value)}>
            {BROKERS.map(b => <option key={b}>{b}</option>)}
          </select>
        </div>
        <div style={{ ...MS.fg, marginBottom: 4 }}>
          <label style={MS.lbl}>Account Color</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 8 }}>
            {ACC_COLORS.map(c => (
              <div key={c} onClick={() => setColor(c)}
                style={{ width: 32, height: 32, borderRadius: "50%", background: c, cursor: "pointer", border: `3px solid ${color === c ? C.ivory : "transparent"}`, boxSizing: "border-box", transition: "all .15s" }} />
            ))}
          </div>
        </div>

        {err && <div style={{ color: C.loss, fontSize: 12, marginTop: 10, background: "#E74C3C11", borderRadius: 6, padding: "8px 12px" }}>{err}</div>}
        <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
          <button onClick={onClose} style={MS.cancelBtn}>Cancel</button>
          <button onClick={submit} disabled={loading} style={{ ...MS.saveBtn, opacity: loading ? .6 : 1 }}>{loading ? "Saving…" : account ? "Update" : "Add Account"}</button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MOBILE HOLDING CARD
// ══════════════════════════════════════════════════════════════════════════════
function HoldingCard({ h, acc, onEdit, onDelete }) {
  return (
    <div style={{ background: C.card, borderRadius: 12, padding: 14, border: `1px solid ${C.border}`, marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div>
          <div style={{ color: C.ivory, fontWeight: 700, fontSize: 16 }}>{h.symbol}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
            {acc && <div style={{ width: 7, height: 7, borderRadius: "50%", background: acc.color }} />}
            <span style={{ color: C.muted, fontSize: 11 }}>{acc?.name ?? "—"} · {h.exchange}</span>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ color: h.ltp ? C.ivory : C.muted, fontWeight: 700, fontSize: 16 }}>{h.ltp ? `₹${fmt(h.ltp)}` : "—"}</div>
          {h.changePct != null && (
            <div style={{ color: clr(h.changePct), fontSize: 11, marginTop: 2 }}>{sign(h.changePct)}{fmt(Math.abs(h.changePct))}%</div>
          )}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
        {[
          { l: "Qty", v: h.qty, c: C.ivory },
          { l: "Avg Price", v: h.inv != null ? `₹${fmt(h.avg_price)}` : "—", c: C.muted },
          { l: "Invested", v: `₹${fmt(h.inv)}`, c: C.ivoryD },
          { l: "Current", v: h.cur != null ? `₹${fmt(h.cur)}` : "—", c: C.ivory },
          { l: "P&L", v: h.pnl != null ? `${h.pnl >= 0 ? "+" : ""}₹${fmt(Math.abs(h.pnl))}` : "—", c: clr(h.pnl) },
          { l: "Return", v: h.pct != null ? `${h.pct >= 0 ? "+" : ""}${fmt(h.pct)}%` : "—", c: clr(h.pct) },
        ].map((m, i) => (
          <div key={i} style={{ background: C.cardL, borderRadius: 8, padding: "7px 9px" }}>
            <div style={{ color: C.muted, fontSize: 9, letterSpacing: 1, textTransform: "uppercase", marginBottom: 2 }}>{m.l}</div>
            <div style={{ color: m.c, fontWeight: 600, fontSize: 12 }}>{m.v}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onEdit} style={{ flex: 1, background: `${C.navy}44`, border: `1px solid ${C.navy}`, color: "#7EB4D8", borderRadius: 8, padding: "8px", fontSize: 12, cursor: "pointer" }}>✎ Edit</button>
        <button onClick={onDelete} style={{ flex: 1, background: `${C.loss}22`, border: `1px solid ${C.loss}55`, color: C.loss, borderRadius: 8, padding: "8px", fontSize: 12, cursor: "pointer" }}>✕ Remove</button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════
function Dashboard({ session, onLogout }) {
  const token = session.access_token;
  const isMobile = useIsMobile();

  const [accounts,  setAccounts]  = useState([]);
  const [holdings,  setHoldings]  = useState([]);
  const [prices,    setPrices]    = useState({});
  const [activeTab, setActiveTab] = useState("all");
  const [priceStatus, setPriceStatus] = useState("idle");
  const [lastRefresh, setLastRefresh] = useState(null);

  const [showAddHolding, setShowAddHolding] = useState(false);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [editHolding,    setEditHolding]    = useState(null);
  const [editAccount,    setEditAccount]    = useState(null);
  const [showMobileMenu, setShowMobileMenu] = useState(false);

  const timerRef = useRef(null);

  const loadAccounts = useCallback(async () => {
    try { const r = await dbGet("/rest/v1/accounts?select=*&order=created_at.asc", token); setAccounts(r || []); }
    catch (e) { console.error("loadAccounts:", e.message); }
  }, [token]);

  const loadHoldings = useCallback(async () => {
    try { const r = await dbGet("/rest/v1/holdings?select=*&order=created_at.asc", token); setHoldings(r || []); }
    catch (e) { console.error("loadHoldings:", e.message); }
  }, [token]);

  const refreshPrices = useCallback(async () => {
    const syms = [...new Set(holdings.map(h => h.symbol))].filter(Boolean);
    if (!syms.length) return;
    setPriceStatus("loading");
    const data = await fetchAllPrices(syms);
    if (Object.keys(data).length) { setPrices(data); setPriceStatus("ok"); setLastRefresh(new Date()); }
    else setPriceStatus("error");
  }, [holdings]);

  useEffect(() => { loadAccounts(); loadHoldings(); }, []);
  useEffect(() => { if (holdings.length) refreshPrices(); }, [holdings.length]);
  useEffect(() => {
    clearInterval(timerRef.current);
    timerRef.current = setInterval(refreshPrices, 90000);
    return () => clearInterval(timerRef.current);
  }, [refreshPrices]);

  const delHolding = async id => {
    try { await dbDelete(`/rest/v1/holdings?id=eq.${id}`, token); loadHoldings(); } catch {}
  };
  const delAccount = async id => {
    if (holdings.some(h => h.account_id === id)) return alert("Remove all holdings in this account first.");
    try { await dbDelete(`/rest/v1/accounts?id=eq.${id}`, token); loadAccounts(); if (activeTab === id) setActiveTab("all"); }
    catch {}
  };

  // ── Computed ────────────────────────────────────────────────────────────────
  const visible  = activeTab === "all" ? holdings : holdings.filter(h => h.account_id === activeTab);
  const enriched = visible.map(h => {
    const p = prices[h.symbol];
    const inv = h.qty * h.avg_price;
    const cur = p?.ltp != null ? h.qty * p.ltp : null;
    const pnl = cur != null ? cur - inv : null;
    const pct = pnl != null ? (pnl / inv) * 100 : null;
    return { ...h, ltp: p?.ltp ?? null, change: p?.change ?? null, changePct: p?.pct ?? null, inv, cur, pnl, pct };
  });
  const totInv = enriched.reduce((a, h) => a + h.inv, 0);
  const totCur = enriched.reduce((a, h) => a + (h.cur ?? h.inv), 0);
  const totPnl = totCur - totInv;
  const totPct = totInv ? (totPnl / totInv) * 100 : 0;
  const dayPnl = enriched.reduce((a, h) => a + ((h.change ?? 0) * h.qty), 0);

  const accSummary = accounts.map(a => {
    const hs = holdings.filter(h => h.account_id === a.id);
    const inv = hs.reduce((x, h) => x + h.qty * h.avg_price, 0);
    const cur = hs.reduce((x, h) => { const ltp = prices[h.symbol]?.ltp; return x + (ltp ? h.qty * ltp : h.qty * h.avg_price); }, 0);
    return { ...a, inv, cur, pnl: cur - inv, count: hs.length };
  });

  const afterSave = (loadFn) => { loadFn(); setShowAddHolding(false); setShowAddAccount(false); setEditHolding(null); setEditAccount(null); setTimeout(refreshPrices, 600); };

  // ── MOBILE LAYOUT ──────────────────────────────────────────────────────────
  if (isMobile) {
    const activeAccData = activeTab === "all" ? null : accSummary.find(a => a.id === activeTab);
    return (
      <div style={{ background: C.bg, minHeight: "100vh", fontFamily: "system-ui,sans-serif", display: "flex", flexDirection: "column" }}>
        <div style={{ height: 3, background: `linear-gradient(90deg,${C.navy},${C.gold},${C.navy})` }} />

        {/* Mobile Header */}
        <div style={{ background: C.card, padding: "12px 16px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: C.navy, display: "flex", alignItems: "center", justifyContent: "center", color: C.gold, fontSize: 16, fontWeight: 700 }}>₹</div>
              <div style={{ color: C.gold, fontSize: 11, letterSpacing: 2, textTransform: "uppercase", fontWeight: 700 }}>Portfolio</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: priceStatus === "ok" ? C.gold : priceStatus === "loading" ? "#F39C12" : C.loss }} />
                <span style={{ color: C.muted, fontSize: 10 }}>{priceStatus === "ok" ? "Live" : priceStatus === "loading" ? "…" : "Off"}</span>
              </div>
              <button onClick={refreshPrices} style={{ background: C.navy, border: "none", color: C.ivory, borderRadius: 7, padding: "5px 10px", fontSize: 12, cursor: "pointer" }}>↺</button>
              <button onClick={async () => { await stDel("pt-session"); onLogout(); }}
                style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.muted, borderRadius: 7, padding: "5px 10px", fontSize: 12, cursor: "pointer" }}>Out</button>
            </div>
          </div>

          {/* Summary strip */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div style={{ background: `${C.navy}55`, borderRadius: 10, padding: "10px 12px", border: `1px solid ${C.gold}33` }}>
              <div style={{ color: C.muted, fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase" }}>Portfolio Value</div>
              <div style={{ color: C.gold, fontWeight: 700, fontSize: 20, marginTop: 2 }}>{fmtC(totCur)}</div>
              <div style={{ color: clr(totPnl), fontSize: 11, marginTop: 1 }}>{sign(totPnl)}{fmtC(Math.abs(totPnl))} ({totPct >= 0 ? "+" : ""}{fmt(totPct)}%)</div>
            </div>
            <div style={{ background: C.cardL, borderRadius: 10, padding: "10px 12px" }}>
              <div style={{ color: C.muted, fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase" }}>Today's P&L</div>
              <div style={{ color: clr(dayPnl), fontWeight: 700, fontSize: 18, marginTop: 2 }}>{sign(dayPnl)}{fmtC(Math.abs(dayPnl))}</div>
              <div style={{ color: C.muted, fontSize: 11, marginTop: 1 }}>Invested: {fmtC(totInv)}</div>
            </div>
          </div>
        </div>

        {/* Account tabs - horizontal scroll */}
        <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: "0 12px", overflowX: "auto", display: "flex", gap: 0, WebkitOverflowScrolling: "touch" }}>
          {[{ id: "all", name: "All", color: C.gold, count: holdings.length }, ...accSummary].map(a => (
            <button key={a.id} onClick={() => setActiveTab(a.id)}
              style={{ flexShrink: 0, background: "none", border: "none", borderBottom: `2px solid ${activeTab === a.id ? a.color : "transparent"}`, color: activeTab === a.id ? a.color : C.muted, padding: "10px 14px", cursor: "pointer", fontSize: 12, fontWeight: activeTab === a.id ? 700 : 400, whiteSpace: "nowrap", transition: "all .15s" }}>
              {a.name} {a.count != null ? <span style={{ fontSize: 10, opacity: .7 }}>({a.count})</span> : ""}
            </button>
          ))}
          <button onClick={() => { setEditAccount(null); setShowAddAccount(true); }}
            style={{ flexShrink: 0, background: "none", border: "none", borderBottom: "2px solid transparent", color: C.gold, padding: "10px 14px", cursor: "pointer", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
            + Account
          </button>
        </div>

        {/* Active account summary bar */}
        {activeAccData && (
          <div style={{ background: `${activeAccData.color}11`, borderBottom: `1px solid ${activeAccData.color}33`, padding: "8px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: activeAccData.color }} />
              <span style={{ color: activeAccData.color, fontWeight: 600, fontSize: 12 }}>{activeAccData.name}</span>
              <span style={{ color: C.muted, fontSize: 11 }}>{activeAccData.broker}</span>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { setEditAccount(activeAccData); setShowAddAccount(true); }} style={{ background: "none", border: `1px solid ${C.border}`, color: C.muted, borderRadius: 6, padding: "4px 10px", fontSize: 11, cursor: "pointer" }}>✎ Edit</button>
              <button onClick={() => delAccount(activeAccData.id)} style={{ background: "none", border: `1px solid ${C.loss}55`, color: C.loss, borderRadius: 6, padding: "4px 10px", fontSize: 11, cursor: "pointer" }}>✕</button>
            </div>
          </div>
        )}

        {/* Holdings list */}
        <div style={{ flex: 1, overflowY: "auto", padding: "12px 12px 80px" }}>
          {enriched.length === 0 ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 300, gap: 12 }}>
              <div style={{ width: 64, height: 64, borderRadius: "50%", background: C.card, border: `2px dashed ${C.border}`, display: "flex", alignItems: "center", justifyContent: "center", color: C.gold, fontSize: 24 }}>₹</div>
              <div style={{ color: C.ivoryD, fontSize: 14 }}>No holdings yet</div>
              <button onClick={() => setShowAddHolding(true)} style={{ background: C.gold, border: "none", color: C.bg, borderRadius: 9, padding: "11px 24px", fontWeight: 700, cursor: "pointer" }}>+ Add Stock</button>
            </div>
          ) : enriched.map(h => (
            <HoldingCard key={h.id} h={h} acc={accounts.find(a => a.id === h.account_id)}
              onEdit={() => { setEditHolding(h); setShowAddHolding(true); }}
              onDelete={() => delHolding(h.id)} />
          ))}
        </div>

        {/* Bottom FAB */}
        <div style={{ position: "fixed", bottom: 20, right: 20, zIndex: 10 }}>
          <button onClick={() => setShowAddHolding(true)}
            style={{ width: 54, height: 54, borderRadius: "50%", background: C.gold, border: "none", color: C.bg, fontSize: 26, fontWeight: 700, cursor: "pointer", boxShadow: `0 4px 20px ${C.gold}66`, display: "flex", alignItems: "center", justifyContent: "center" }}>
            +
          </button>
        </div>

        {/* Modals */}
        {showAddHolding && <HoldingModal holding={editHolding} accounts={accounts} token={token} onSave={() => afterSave(loadHoldings)} onClose={() => { setShowAddHolding(false); setEditHolding(null); }} />}
        {showAddAccount && <AccountModal account={editAccount} token={token} onSave={() => afterSave(loadAccounts)} onClose={() => { setShowAddAccount(false); setEditAccount(null); }} />}
      </div>
    );
  }

  // ── DESKTOP LAYOUT ─────────────────────────────────────────────────────────
  return (
    <div style={{ background: C.bg, minHeight: "100vh", fontFamily: "system-ui,sans-serif", display: "flex", flexDirection: "column" }}>
      <div style={{ height: 3, background: `linear-gradient(90deg,${C.navy},${C.gold},${C.navy})` }} />

      <header style={{ background: C.card, borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", padding: "0 20px", gap: 16, minHeight: 70, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, paddingRight: 20, borderRight: `1px solid ${C.border}` }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, background: C.navy, display: "flex", alignItems: "center", justifyContent: "center", color: C.gold, fontSize: 20, fontWeight: 700, border: `1px solid ${C.gold}33` }}>₹</div>
          <div style={{ color: C.muted, fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase" }}>Portfolio<br />Terminal</div>
        </div>
        {[
          { l: "Portfolio Value", v: fmtC(totCur),  c: C.gold, big: true },
          { l: "Invested",        v: fmtC(totInv),  c: C.ivoryD },
          { l: "Total P&L",       v: `${totPnl >= 0 ? "+" : ""}${fmtC(totPnl)}`, c: clr(totPnl) },
          { l: "Returns",         v: `${totPct >= 0 ? "+" : ""}${fmt(totPct)}%`, c: clr(totPct) },
          { l: "Today's P&L",     v: `${dayPnl >= 0 ? "+" : ""}${fmtC(dayPnl)}`, c: clr(dayPnl) },
        ].map((m, i) => (
          <div key={i} style={{ textAlign: "center", padding: "0 14px", borderRight: i < 4 ? `1px solid ${C.border}` : "none" }}>
            <div style={{ color: C.muted, fontSize: 10, letterSpacing: 1, textTransform: "uppercase" }}>{m.l}</div>
            <div style={{ color: m.c, fontSize: m.big ? 20 : 14, fontWeight: m.big ? 700 : 600, marginTop: 2 }}>{m.v}</div>
          </div>
        ))}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: priceStatus === "ok" ? C.gold : priceStatus === "loading" ? "#F39C12" : C.loss }} />
            <span style={{ color: C.muted, fontSize: 11 }}>{priceStatus === "ok" ? `Live · ${lastRefresh?.toLocaleTimeString()}` : priceStatus === "loading" ? "Fetching…" : "Offline"}</span>
          </div>
          <button onClick={refreshPrices} style={{ background: C.navy, border: "none", color: C.ivory, borderRadius: 7, padding: "7px 14px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>↺ Refresh</button>
          <button onClick={() => setShowAddHolding(true)} style={{ background: C.gold, border: "none", color: C.bg, borderRadius: 7, padding: "7px 14px", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>+ Add Stock</button>
          <button onClick={async () => { await stDel("pt-session"); onLogout(); }} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.muted, borderRadius: 7, padding: "7px 12px", cursor: "pointer", fontSize: 12 }}>Logout</button>
        </div>
      </header>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Sidebar */}
        <aside style={{ width: 220, background: C.card, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", overflow: "hidden", flexShrink: 0 }}>
          <div onClick={() => setActiveTab("all")}
            style={{ padding: "14px 16px", cursor: "pointer", borderLeft: `3px solid ${activeTab === "all" ? C.gold : "transparent"}`, background: activeTab === "all" ? `${C.navy}AA` : "transparent", borderBottom: `1px solid ${C.border}` }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: activeTab === "all" ? C.gold : C.ivoryD, fontSize: 11, fontWeight: 700, letterSpacing: 1 }}>ALL ACCOUNTS</span>
              <span style={{ background: C.cardL, color: C.muted, borderRadius: 10, padding: "1px 7px", fontSize: 10 }}>{holdings.length}</span>
            </div>
            <div style={{ color: C.ivory, fontSize: 18, fontWeight: 700, marginTop: 4 }}>{fmtC(totCur)}</div>
            <div style={{ color: clr(totPnl), fontSize: 12, marginTop: 1 }}>{sign(totPnl)}{fmtC(totPnl)}</div>
          </div>
          <div style={{ height: 1, background: C.border }} />

          <div style={{ flex: 1, overflowY: "auto" }}>
            {accSummary.map(acc => (
              <div key={acc.id} onClick={() => setActiveTab(acc.id)}
                style={{ padding: "14px 16px", cursor: "pointer", borderLeft: `3px solid ${activeTab === acc.id ? acc.color : "transparent"}`, background: activeTab === acc.id ? `${C.navy}55` : "transparent", borderBottom: `1px solid ${C.border}` }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <div>
                    <div style={{ color: acc.color, fontSize: 12, fontWeight: 700 }}>{acc.name}</div>
                    <div style={{ color: C.muted, fontSize: 10 }}>{acc.broker}</div>
                  </div>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button onClick={e => { e.stopPropagation(); setEditAccount(acc); setShowAddAccount(true); }} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 12, padding: "2px 5px" }}>✎</button>
                    <button onClick={e => { e.stopPropagation(); delAccount(acc.id); }} style={{ background: "none", border: "none", color: C.loss, cursor: "pointer", fontSize: 12, padding: "2px 5px" }}>✕</button>
                  </div>
                </div>
                <div style={{ color: C.ivory, fontSize: 15, fontWeight: 600, marginTop: 6 }}>{fmtC(acc.cur)}</div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
                  <span style={{ color: clr(acc.pnl), fontSize: 11 }}>{sign(acc.pnl)}{fmtC(acc.pnl)}</span>
                  <span style={{ color: C.muted, fontSize: 10 }}>{acc.count} stocks</span>
                </div>
              </div>
            ))}
          </div>
          <div style={{ padding: 12, borderTop: `1px solid ${C.border}` }}>
            <button onClick={() => { setEditAccount(null); setShowAddAccount(true); }}
              style={{ width: "100%", background: "transparent", border: `1px dashed ${C.gold}66`, color: C.gold, borderRadius: 8, padding: "9px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
              + Add Account
            </button>
          </div>
        </aside>

        {/* Main */}
        <main style={{ flex: 1, overflowY: "auto", padding: 20, background: C.cardL }}>
          {enriched.length === 0 ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "60%", gap: 16 }}>
              <div style={{ width: 72, height: 72, borderRadius: "50%", background: C.card, border: `2px dashed ${C.border}`, display: "flex", alignItems: "center", justifyContent: "center", color: C.gold, fontSize: 28 }}>₹</div>
              <div style={{ color: C.ivoryD }}>No holdings {activeTab !== "all" ? "in this account" : "yet"}</div>
              <button onClick={() => setShowAddHolding(true)} style={{ background: C.gold, border: "none", color: C.bg, borderRadius: 9, padding: "10px 24px", fontWeight: 700, cursor: "pointer" }}>+ Add First Stock</button>
            </div>
          ) : (
            <div style={{ background: C.card, borderRadius: 12, overflow: "hidden", border: `1px solid ${C.border}` }}>
              <div style={{ padding: "12px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ color: C.ivory, fontWeight: 600 }}>Holdings — <span style={{ color: C.gold }}>{enriched.length} stocks</span></span>
                <span style={{ color: C.muted, fontSize: 12 }}>Invested: <b style={{ color: C.ivory }}>₹{fmt(totInv)}</b></span>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: C.bg }}>
                      {["Symbol","Account","Qty","Avg Price","LTP","Day Chg%","Invested","Current","P&L","Return",""].map(h => (
                        <th key={h} style={{ padding: "10px 14px", textAlign: "left", color: C.muted, fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {enriched.map((h, i) => {
                      const acc = accounts.find(a => a.id === h.account_id);
                      return (
                        <tr key={h.id} style={{ borderBottom: `1px solid ${C.border}`, background: i % 2 === 1 ? `${C.bg}55` : "transparent" }}>
                          <td style={TBL.td}><div style={{ color: C.ivory, fontWeight: 700 }}>{h.symbol}</div><div style={{ color: C.muted, fontSize: 10 }}>{h.exchange}</div></td>
                          <td style={TBL.td}><div style={{ display: "flex", alignItems: "center", gap: 6 }}><div style={{ width: 8, height: 8, borderRadius: "50%", background: acc?.color ?? C.muted }} /><span style={{ color: C.ivoryD, fontSize: 12 }}>{acc?.name ?? "—"}</span></div></td>
                          <td style={{ ...TBL.td, color: C.ivory, fontWeight: 600 }}>{h.qty}</td>
                          <td style={{ ...TBL.td, color: C.muted }}>₹{fmt(h.avg_price)}</td>
                          <td style={{ ...TBL.td, color: h.ltp ? C.ivory : C.muted, fontWeight: 700 }}>{h.ltp ? `₹${fmt(h.ltp)}` : "—"}</td>
                          <td style={{ ...TBL.td, color: clr(h.changePct), fontWeight: 600 }}>{h.changePct != null ? `${sign(h.changePct)}${fmt(Math.abs(h.changePct))}%` : "—"}</td>
                          <td style={{ ...TBL.td, color: C.muted }}>₹{fmt(h.inv)}</td>
                          <td style={{ ...TBL.td, color: C.ivory, fontWeight: 600 }}>{h.cur != null ? `₹${fmt(h.cur)}` : "—"}</td>
                          <td style={TBL.td}><span style={{ background: h.pnl != null ? (h.pnl > 0 ? `${C.gold}1A` : `${C.loss}1A`) : "transparent", color: clr(h.pnl), padding: "3px 8px", borderRadius: 5, fontWeight: 700, fontSize: 12 }}>{h.pnl != null ? `${h.pnl >= 0 ? "+" : ""}₹${fmt(Math.abs(h.pnl))}` : "—"}</span></td>
                          <td style={{ ...TBL.td, color: clr(h.pct), fontWeight: 600 }}>{h.pct != null ? `${h.pct >= 0 ? "+" : ""}${fmt(h.pct)}%` : "—"}</td>
                          <td style={TBL.td}>
                            <div style={{ display: "flex", gap: 4 }}>
                              <button onClick={() => { setEditHolding(h); setShowAddHolding(true); }} style={{ background: `${C.navy}44`, border: `1px solid ${C.navy}`, color: "#7EB4D8", cursor: "pointer", borderRadius: 5, padding: "3px 7px", fontSize: 12 }}>✎</button>
                              <button onClick={() => delHolding(h.id)} style={{ background: `${C.loss}22`, border: `1px solid ${C.loss}55`, color: C.loss, cursor: "pointer", borderRadius: 5, padding: "3px 7px", fontSize: 12 }}>✕</button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: C.bg, borderTop: `2px solid ${C.gold}44` }}>
                      <td colSpan={6} style={{ ...TBL.td, color: C.gold, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", fontSize: 11 }}>TOTAL</td>
                      <td style={{ ...TBL.td, color: C.ivoryD, fontWeight: 600 }}>₹{fmt(totInv)}</td>
                      <td style={{ ...TBL.td, color: C.ivory, fontWeight: 700 }}>₹{fmt(totCur)}</td>
                      <td style={TBL.td}><span style={{ background: totPnl > 0 ? `${C.gold}22` : `${C.loss}22`, color: clr(totPnl), padding: "3px 10px", borderRadius: 5, fontWeight: 700, fontSize: 13 }}>{totPnl >= 0 ? "+" : ""}₹{fmt(Math.abs(totPnl))}</span></td>
                      <td style={{ ...TBL.td, color: clr(totPct), fontWeight: 700, fontSize: 14 }}>{totPct >= 0 ? "+" : ""}{fmt(totPct)}%</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </main>
      </div>

      {showAddHolding && <HoldingModal holding={editHolding} accounts={accounts} token={token} onSave={() => afterSave(loadHoldings)} onClose={() => { setShowAddHolding(false); setEditHolding(null); }} />}
      {showAddAccount && <AccountModal account={editAccount} token={token} onSave={() => afterSave(loadAccounts)} onClose={() => { setShowAddAccount(false); setEditAccount(null); }} />}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ROOT
// ══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    (async () => {
      const saved = await stGet("pt-session");
      if (saved?.access_token) {
        try {
          const r = await authRefresh(saved.refresh_token);
          const fresh = { access_token: r.access_token, refresh_token: r.refresh_token };
          await stSet("pt-session", fresh);
          setSession(fresh);
        } catch { setSession(saved); }
      }
      setChecking(false);
    })();
  }, []);

  if (checking) return (
    <div style={{ background: C.bg, height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui" }}>
      <div style={{ color: C.gold, fontSize: 16, letterSpacing: 2 }}>Loading…</div>
    </div>
  );

  return session
    ? <Dashboard session={session} onLogout={() => setSession(null)} />
    : <AuthScreen onAuth={d => setSession({ access_token: d.access_token, refresh_token: d.refresh_token })} />;
}

// ─── Shared style tokens ──────────────────────────────────────────────────────
const MS = {
  overlay: { position: "fixed", inset: 0, background: "rgba(10,12,14,.88)", backdropFilter: "blur(5px)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center" },
  modal: { background: C.card, border: `1px solid ${C.border}`, padding: "20px 22px 28px", width: "100%", maxHeight: "92vh", overflowY: "auto", boxShadow: "0 -8px 40px rgba(0,0,0,.6)" },
  closeBtn: { background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 20, padding: 4 },
  fg: { display: "flex", flexDirection: "column", gap: 6 },
  lbl: { color: C.muted, fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase" },
  inp: { background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 13px", color: C.ivory, fontSize: 14, outline: "none", width: "100%", boxSizing: "border-box" },
  saveBtn: { flex: 1, background: C.gold, border: "none", color: C.bg, borderRadius: 9, padding: "13px", fontWeight: 700, fontSize: 14, cursor: "pointer" },
  cancelBtn: { background: "transparent", border: `1px solid ${C.border}`, color: C.muted, borderRadius: 9, padding: "12px 20px", cursor: "pointer", fontSize: 14 },
};
const TBL = { td: { padding: "11px 14px", verticalAlign: "middle", whiteSpace: "nowrap" } };