import { useState, useEffect, useCallback, useRef } from "react";
import * as XLSX from "xlsx";

// ─── Supabase ─────────────────────────────────────────────────────────────────
const SB_URL = "https://qyrqjxbhttaqjgihmzgx.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF5cnFqeGJodHRhcWpnaWhtemd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2NTg5MzQsImV4cCI6MjA4NzIzNDkzNH0.cQC2Vo722Z_LY8X5an2QJqJhavjIstmzNbp2Cjo_51I";

const jwtUid = t => { try { return JSON.parse(atob(t.split(".")[1])).sub; } catch { return null; } };

const sb = async (path, opts = {}, token = null) => {
  const h = { apikey: SB_KEY, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...opts.headers };
  const r = await fetch(`${SB_URL}${path}`, { ...opts, headers: h });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.message || e.error_description || `Error ${r.status}`); }
  return r.status === 204 ? null : r.json();
};

const authLogin   = (e, p) => sb("/auth/v1/token?grant_type=password",  { method: "POST", body: JSON.stringify({ email: e, password: p }) });
const authSignup  = (e, p) => sb("/auth/v1/signup",                      { method: "POST", body: JSON.stringify({ email: e, password: p }) });
const authRefresh = rt     => sb("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: rt }) });
const dbGet    = (p, t)    => sb(p, {}, t);
const dbPost   = (p, b, t) => sb(p, { method: "POST",   headers: { Prefer: "return=representation" }, body: JSON.stringify(b) }, t);
const dbPatch  = (p, b, t) => sb(p, { method: "PATCH",  headers: { Prefer: "return=representation" }, body: JSON.stringify(b) }, t);
const dbDelete = (p, t)    => sb(p, { method: "DELETE" }, t);

// ─── Colors ───────────────────────────────────────────────────────────────────
const C = {
  bg: "#0F1214", card: "#181C1E", cardL: "#1F2426", border: "#2A3235",
  navy: "#0A3D62", navyL: "#1A5276",
  gold: "#D4AF37",                    // KOSH brand / UI accents only
  profit: "#22C55E",                  // Green — gains
  loss: "#EF4444",                    // Red — losses
  white: "#F9F9F9",                   // Neutral prices / LTP
  ivory: "#F9F9F9", ivoryD: "#B0BEC5", muted: "#607D8B",
};
const clr  = n => n == null ? C.white : n > 0 ? C.profit : n < 0 ? C.loss : C.white;
const sign = n => n > 0 ? "▲ " : n < 0 ? "▼ " : "";
const fmt  = (n, d = 2) => n == null ? "—" : n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtC = n => { if (n == null) return "—"; const a = Math.abs(n); return a >= 1e7 ? `₹${(a/1e7).toFixed(2)}Cr` : a >= 1e5 ? `₹${(a/1e5).toFixed(2)}L` : `₹${fmt(a)}`; };
const HIDDEN = "••••••";
const hide = (val, privacy) => privacy ? HIDDEN : val;

const BROKERS    = ["Zerodha","Groww","Upstox","Angel One","ICICI Direct","HDFC Sky","5Paisa","Motilal Oswal","Kotak Securities","Dhan","Fyers","Custom"];
const ACC_COLORS = ["#D4AF37","#0A3D62","#22C55E","#8E44AD","#E67E22","#EF4444","#1ABC9C","#3B82F6","#F97316","#A855F7"];
const MF_TYPES   = ["Equity","Debt","Hybrid","Index","ELSS","Liquid","International"];

// ─── Storage ──────────────────────────────────────────────────────────────────
const stGet = async k => { try { const r = await window.storage.get(k); return r ? JSON.parse(r.value) : null; } catch { return null; } };
const stSet = async (k, v) => { try { await window.storage.set(k, JSON.stringify(v)); } catch {} };
const stDel = async k => { try { await window.storage.delete(k); } catch {} };

// ─── Live Price Fetcher ───────────────────────────────────────────────────────
async function fetchBatch(syms) {
  const qs = syms.map(s => `${s}.NS`).join(",");
  const fields = "regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketPreviousClose,regularMarketDayHigh,regularMarketDayLow";
  const endpoints = [
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${qs}&fields=${fields}`,
    `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${qs}&fields=${fields}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${qs}&fields=${fields}`)}`,
    `https://corsproxy.io/?url=${encodeURIComponent(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${qs}&fields=${fields}`)}`,
  ];
  for (const ep of endpoints) {
    try {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 9000);
      const res  = await fetch(ep, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" }, signal: ctrl.signal });
      clearTimeout(tid);
      if (!res.ok) continue;
      const d = await res.json();
      const quotes = d?.quoteResponse?.result || [];
      if (!quotes.length) continue;
      const out = {};
      for (const q of quotes) {
        const sym = q.symbol?.replace(".NS", "");
        if (sym && q.regularMarketPrice) out[sym] = { ltp: q.regularMarketPrice, change: q.regularMarketChange ?? 0, pct: q.regularMarketChangePercent ?? 0, high: q.regularMarketDayHigh, low: q.regularMarketDayLow };
      }
      if (Object.keys(out).length) return out;
    } catch { /* try next */ }
  }
  return {};
}

async function fetchAllPrices(symbols) {
  if (!symbols.length) return {};
  const chunks = [];
  for (let i = 0; i < symbols.length; i += 8) chunks.push(symbols.slice(i, i + 8));
  const all = await Promise.allSettled(chunks.map(fetchBatch));
  return Object.assign({}, ...all.map(r => r.status === "fulfilled" ? r.value : {}));
}

// ─── MF NAV Fetcher (MFAPI India - no CORS issues) ───────────────────────────
async function fetchMFNav(schemeCode) {
  try {
    const r = await fetch(`https://api.mfapi.in/mf/${schemeCode}/latest`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const d = await r.json();
    return parseFloat(d?.data?.[0]?.nav) || null;
  } catch { return null; }
}

// ─── Responsive ───────────────────────────────────────────────────────────────
function useIsMobile() {
  const [m, setM] = useState(window.innerWidth < 768);
  useEffect(() => { const h = () => setM(window.innerWidth < 768); window.addEventListener("resize", h); return () => window.removeEventListener("resize", h); }, []);
  return m;
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTH SCREEN
// ══════════════════════════════════════════════════════════════════════════════
function AuthScreen({ onAuth }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState(""); const [pass, setPass] = useState("");
  const [err, setErr] = useState(""); const [loading, setLoading] = useState(false);
  const [showPass, setShowPass] = useState(false);

  const submit = async () => {
    if (!email || !pass) return setErr("Fill all fields"); setErr(""); setLoading(true);
    try {
      const fn = mode === "signup" ? authSignup : authLogin;
      const d  = await fn(email, pass);
      if (mode === "signup" && !d.access_token) { setErr("Check email to confirm, then sign in."); setLoading(false); return; }
      await stSet("pt-sess", { at: d.access_token, rt: d.refresh_token });
      onAuth(d);
    } catch (e) { setErr(e.message); }
    setLoading(false);
  };

  return (
    <div style={{ background: C.bg, minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "system-ui", padding: 16 }}>
      <div style={{ width: "100%", maxWidth: 380, background: C.card, borderRadius: 18, border: `1px solid ${C.border}`, overflow: "hidden", boxShadow: "0 40px 100px rgba(0,0,0,.7)" }}>
        <div style={{ height: 4, background: `linear-gradient(90deg,${C.navy},${C.gold},${C.navy})` }} />
        <div style={{ padding: "30px 28px 26px" }}>
          {/* Logo */}
          <div style={{ textAlign: "center", marginBottom: 28 }}>
            <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 56, height: 56, borderRadius: 14, background: C.navy, border: `1px solid ${C.gold}55`, marginBottom: 12, fontSize: 26, color: C.gold, fontWeight: 900 }}>K</div>
            <div style={{ color: C.white, fontWeight: 800, fontSize: 22, letterSpacing: 1 }}>KOSH</div>
            <div style={{ color: C.gold, fontSize: 10, letterSpacing: 3, textTransform: "uppercase", marginTop: 2 }}>Portfolio Terminal</div>
          </div>

          <div style={{ display: "flex", background: C.cardL, borderRadius: 10, padding: 3, marginBottom: 22 }}>
            {["login","signup"].map(m => (
              <button key={m} onClick={() => { setMode(m); setErr(""); }}
                style={{ flex: 1, padding: "9px", borderRadius: 8, border: "none", cursor: "pointer", fontWeight: 600, fontSize: 13, background: mode === m ? C.navy : "transparent", color: mode === m ? C.white : C.muted, transition: "all .2s" }}>
                {m === "login" ? "Sign In" : "Sign Up"}
              </button>
            ))}
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={S.lbl}>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === "Enter" && submit()}
              style={S.inp} placeholder="you@email.com" />
          </div>
          <div style={{ marginBottom: 14, position: "relative" }}>
            <label style={S.lbl}>Password</label>
            <input type={showPass ? "text" : "password"} value={pass} onChange={e => setPass(e.target.value)} onKeyDown={e => e.key === "Enter" && submit()}
              style={{ ...S.inp, paddingRight: 40 }} placeholder="••••••••" />
            <button onClick={() => setShowPass(!showPass)} style={{ position: "absolute", right: 12, top: 32, background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 16 }}>
              {showPass ? "🙈" : "👁"}
            </button>
          </div>

          {err && <div style={{ background: "#EF444422", border: "1px solid #EF444455", borderRadius: 8, padding: "9px 14px", color: C.loss, fontSize: 13, marginBottom: 14 }}>{err}</div>}

          <button onClick={submit} disabled={loading}
            style={{ width: "100%", background: loading ? C.border : C.gold, border: "none", color: C.bg, borderRadius: 10, padding: "13px", fontWeight: 800, fontSize: 15, cursor: loading ? "not-allowed" : "pointer", marginTop: 4, letterSpacing: 0.5 }}>
            {loading ? "Please wait…" : mode === "login" ? "Sign In →" : "Create Account →"}
          </button>
          <p style={{ color: C.muted, fontSize: 12, textAlign: "center", marginTop: 14, marginBottom: 0 }}>
            {mode === "login" ? "No account? " : "Have one? "}
            <span onClick={() => { setMode(mode === "login" ? "signup" : "login"); setErr(""); }} style={{ color: C.gold, cursor: "pointer", fontWeight: 700 }}>
              {mode === "login" ? "Sign up free" : "Sign in"}
            </span>
          </p>
        </div>
      </div>
      <div style={{ color: C.muted, fontSize: 11, marginTop: 18, letterSpacing: 2 }}>EXCLUSIVELY POWERED BY KOSH</div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// EXCEL IMPORT MODAL
// ══════════════════════════════════════════════════════════════════════════════
function ExcelImportModal({ accounts, token, onSave, onClose }) {
  const uid = jwtUid(token);
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [importType, setImportType] = useState("stock"); // stock | mf

  const downloadTemplate = () => {
    const stockData = [["Symbol","Account Name","Exchange","Qty","Avg Price"],["RELIANCE","My Zerodha","NSE",100,2500],["INFY","Groww Account","NSE",50,1800]];
    const mfData    = [["Scheme Name","Account Name","Units","Avg NAV","Fund Type"],["HDFC Flexi Cap Fund - Direct Growth","Zerodha Account",50.234,450.12,"Equity"]];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(stockData), "Stocks");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(mfData), "MutualFunds");
    XLSX.writeFile(wb, "KOSH_Portfolio_Template.xlsx");
  };

  const handleFile = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const wb = XLSX.read(ev.target.result, { type: "binary" });
        const sheetName = importType === "stock" ? "Stocks" : "MutualFunds";
        const sheet = wb.Sheets[sheetName] || wb.Sheets[wb.SheetNames[0]];
        const data  = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        const [header, ...body] = data;
        setError("");
        setRows(body.filter(r => r.length >= 4).map((r, i) => ({ _idx: i, ...Object.fromEntries(header.map((h, j) => [h, r[j]])) })));
      } catch (e) { setError("Could not parse file: " + e.message); }
    };
    reader.readAsBinaryString(file);
  };

  const submit = async () => {
    if (!rows.length) return;
    setLoading(true);
    let ok = 0, fail = 0;
    for (const row of rows) {
      try {
        if (importType === "stock") {
          const acc = accounts.find(a => a.name.toLowerCase() === String(row["Account Name"] || "").toLowerCase()) || accounts[0];
          if (!acc) continue;
          await dbPost("/rest/v1/holdings", { user_id: uid, account_id: acc.id, symbol: String(row["Symbol"] || "").toUpperCase(), exchange: row["Exchange"] || "NSE", qty: Number(row["Qty"]), avg_price: Number(row["Avg Price"]), asset_type: "stock" }, token);
        } else {
          const acc = accounts.find(a => a.name.toLowerCase() === String(row["Account Name"] || "").toLowerCase()) || accounts[0];
          if (!acc) continue;
          await dbPost("/rest/v1/mf_holdings", { user_id: uid, account_id: acc.id, scheme_name: row["Scheme Name"], fund_type: row["Fund Type"] || "Equity", units: Number(row["Units"]), avg_nav: Number(row["Avg NAV"]) }, token);
        }
        ok++;
      } catch { fail++; }
    }
    setLoading(false);
    onSave(`Imported ${ok} entries${fail ? `, ${fail} failed` : ""}`);
  };

  return (
    <div style={MS.overlay} onClick={onClose}>
      <div style={{ ...MS.modal, maxWidth: 560 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
          <div>
            <div style={{ color: C.gold, fontWeight: 800, letterSpacing: 1, fontSize: 14, textTransform: "uppercase" }}>📊 Import from Excel</div>
            <div style={{ color: C.muted, fontSize: 12, marginTop: 3 }}>Bulk import your portfolio holdings</div>
          </div>
          <button onClick={onClose} style={MS.closeBtn}>✕</button>
        </div>

        {/* Type toggle */}
        <div style={{ display: "flex", background: C.cardL, borderRadius: 10, padding: 3, marginBottom: 18 }}>
          {["stock","mf"].map(t => (
            <button key={t} onClick={() => { setImportType(t); setRows([]); setError(""); }}
              style={{ flex: 1, padding: "8px", borderRadius: 8, border: "none", cursor: "pointer", fontWeight: 600, fontSize: 12, background: importType === t ? C.navy : "transparent", color: importType === t ? C.white : C.muted }}>
              {t === "stock" ? "📈 Stocks" : "🏦 Mutual Funds"}
            </button>
          ))}
        </div>

        {/* Download template */}
        <div style={{ background: `${C.navy}33`, border: `1px solid ${C.navy}`, borderRadius: 10, padding: "14px 16px", marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ color: C.white, fontWeight: 600, fontSize: 13 }}>Step 1: Download Template</div>
            <div style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>Fill the template with your holdings data</div>
          </div>
          <button onClick={downloadTemplate} style={{ background: C.gold, border: "none", color: C.bg, borderRadius: 8, padding: "8px 16px", cursor: "pointer", fontWeight: 700, fontSize: 12, whiteSpace: "nowrap" }}>
            ↓ Template
          </button>
        </div>

        {/* Upload area */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ color: C.ivoryD, fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Step 2: Upload Filled File</div>
          <label style={{ display: "block", background: C.cardL, border: `2px dashed ${C.border}`, borderRadius: 10, padding: "20px", textAlign: "center", cursor: "pointer" }}>
            <input type="file" accept=".xlsx,.xls,.csv" onChange={handleFile} style={{ display: "none" }} />
            <div style={{ fontSize: 28, marginBottom: 6 }}>📂</div>
            <div style={{ color: C.ivoryD, fontSize: 13 }}>Click to choose file</div>
            <div style={{ color: C.muted, fontSize: 11 }}>.xlsx, .xls, .csv accepted</div>
          </label>
        </div>

        {error && <div style={{ color: C.loss, fontSize: 12, marginBottom: 12 }}>{error}</div>}

        {/* Preview */}
        {rows.length > 0 && (
          <div style={{ background: C.cardL, borderRadius: 10, padding: 12, marginBottom: 16, maxHeight: 180, overflowY: "auto" }}>
            <div style={{ color: C.profit, fontSize: 12, fontWeight: 600, marginBottom: 8 }}>✓ {rows.length} rows detected — preview:</div>
            {rows.slice(0, 5).map((r, i) => (
              <div key={i} style={{ color: C.ivoryD, fontSize: 11, padding: "4px 0", borderBottom: `1px solid ${C.border}` }}>
                {Object.values(r).filter((_, j) => j > 0).join(" · ")}
              </div>
            ))}
            {rows.length > 5 && <div style={{ color: C.muted, fontSize: 11, marginTop: 4 }}>+ {rows.length - 5} more…</div>}
          </div>
        )}

        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onClose} style={MS.cancelBtn}>Cancel</button>
          <button onClick={submit} disabled={loading || !rows.length} style={{ ...MS.saveBtn, opacity: (!rows.length || loading) ? 0.5 : 1 }}>
            {loading ? "Importing…" : `Import ${rows.length} Rows`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// STOCK HOLDING MODAL
// ══════════════════════════════════════════════════════════════════════════════
function StockModal({ holding, accounts, token, onSave, onClose }) {
  const uid = jwtUid(token);
  const [form, setForm] = useState({ account_id: holding?.account_id ?? accounts[0]?.id ?? "", symbol: holding?.symbol ?? "", exchange: holding?.exchange ?? "NSE", qty: holding?.qty ?? "", avg_price: holding?.avg_price ?? "" });
  const [symText, setSymText] = useState(holding?.symbol ?? "");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const timer = useRef(null);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const search = (q) => {
    clearTimeout(timer.current);
    if (!q) { setResults([]); return; }
    timer.current = setTimeout(async () => {
      try { const r = await dbGet(`/rest/v1/nse_stocks?or=(symbol.ilike.*${encodeURIComponent(q)}*,company_name.ilike.*${encodeURIComponent(q)}*)&select=symbol,company_name,sector,market_cap_category&limit=8`, token); setResults(r || []); }
      catch { setResults([]); }
    }, 280);
  };

  const submit = async () => {
    if (!form.symbol || !form.qty || !form.avg_price || !form.account_id) return setErr("Fill all fields");
    setLoading(true); setErr("");
    try {
      if (holding) await dbPatch(`/rest/v1/holdings?id=eq.${holding.id}`, { account_id: form.account_id, symbol: form.symbol, exchange: form.exchange, qty: +form.qty, avg_price: +form.avg_price }, token);
      else await dbPost("/rest/v1/holdings", { user_id: uid, account_id: form.account_id, symbol: form.symbol, exchange: form.exchange, qty: +form.qty, avg_price: +form.avg_price, asset_type: "stock" }, token);
      onSave();
    } catch (e) { setErr(e.message); }
    setLoading(false);
  };

  return (
    <div style={MS.overlay} onClick={onClose}>
      <div style={MS.modal} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
          <div><div style={{ color: C.gold, fontWeight: 800, letterSpacing: 1, fontSize: 13, textTransform: "uppercase" }}>{holding ? "✎ Edit Stock" : "📈 Add Stock"}</div><div style={{ color: C.muted, fontSize: 11, marginTop: 3 }}>Search from 369+ NSE stocks</div></div>
          <button onClick={onClose} style={MS.closeBtn}>✕</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div style={MS.fg}><label style={S.lbl}>Account</label>
            <select style={S.inp} value={form.account_id} onChange={e => set("account_id", e.target.value)}>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div style={MS.fg}><label style={S.lbl}>Exchange</label>
            <select style={S.inp} value={form.exchange} onChange={e => set("exchange", e.target.value)}><option>NSE</option><option>BSE</option></select>
          </div>
          <div style={{ ...MS.fg, gridColumn: "1/-1", position: "relative" }}>
            <label style={S.lbl}>Symbol / Company Name</label>
            <input style={S.inp} placeholder="RELIANCE, Infosys, HAL…" value={symText}
              onChange={e => { const v = e.target.value.toUpperCase(); setSymText(v); set("symbol", v); search(v); }} />
            {results.length > 0 && (
              <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, background: C.card, border: `1px solid ${C.gold}55`, borderRadius: 10, zIndex: 50, overflow: "hidden", boxShadow: "0 16px 48px rgba(0,0,0,.7)", maxHeight: 240, overflowY: "auto" }}>
                {results.map(s => (
                  <div key={s.symbol} onClick={() => { set("symbol", s.symbol); setSymText(s.symbol); setResults([]); }}
                    style={{ padding: "10px 14px", cursor: "pointer", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div><div style={{ color: C.gold, fontWeight: 700, fontSize: 13 }}>{s.symbol}</div><div style={{ color: C.ivoryD, fontSize: 11 }}>{s.company_name} · {s.sector}</div></div>
                    <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: s.market_cap_category === "LARGE" ? `${C.navy}99` : "#1A3A2A", color: s.market_cap_category === "LARGE" ? "#7EB4D8" : "#7EC8A0" }}>{s.market_cap_category}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div style={MS.fg}><label style={S.lbl}>Quantity</label><input style={S.inp} type="number" placeholder="100" value={form.qty} onChange={e => set("qty", e.target.value)} /></div>
          <div style={MS.fg}><label style={S.lbl}>Avg Buy Price (₹)</label><input style={S.inp} type="number" placeholder="250.50" value={form.avg_price} onChange={e => set("avg_price", e.target.value)} /></div>
          {form.qty && form.avg_price && (
            <div style={{ gridColumn: "1/-1", background: C.bg, borderRadius: 8, padding: "11px 16px", border: `1px solid ${C.gold}33`, display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: C.muted }}>Total Invested</span>
              <span style={{ color: C.gold, fontWeight: 700, fontSize: 16 }}>₹{fmt(+form.qty * +form.avg_price)}</span>
            </div>
          )}
        </div>
        {err && <div style={{ color: C.loss, fontSize: 12, marginTop: 10, background: "#EF444411", borderRadius: 6, padding: "8px 12px" }}>{err}</div>}
        <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
          <button onClick={onClose} style={MS.cancelBtn}>Cancel</button>
          <button onClick={submit} disabled={loading} style={{ ...MS.saveBtn, opacity: loading ? .6 : 1 }}>{loading ? "Saving…" : holding ? "Update" : "Add Stock"}</button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MF HOLDING MODAL
// ══════════════════════════════════════════════════════════════════════════════
function MFModal({ holding, accounts, token, onSave, onClose }) {
  const uid = jwtUid(token);
  const [form, setForm] = useState({ account_id: holding?.account_id ?? accounts[0]?.id ?? "", scheme_name: holding?.scheme_name ?? "", isin: holding?.isin ?? "", fund_house: holding?.fund_house ?? "", fund_type: holding?.fund_type ?? "Equity", units: holding?.units ?? "", avg_nav: holding?.avg_nav ?? "" });
  const [schemeText, setSchemeText] = useState(holding?.scheme_name ?? "");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const timer = useRef(null);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const searchMF = (q) => {
    clearTimeout(timer.current);
    if (!q || q.length < 2) { setResults([]); return; }
    timer.current = setTimeout(async () => {
      try { const r = await dbGet(`/rest/v1/mf_schemes?or=(scheme_name.ilike.*${encodeURIComponent(q)}*,fund_house.ilike.*${encodeURIComponent(q)}*)&select=*&limit=8`, token); setResults(r || []); }
      catch { setResults([]); }
    }, 280);
  };

  const submit = async () => {
    if (!form.scheme_name || !form.units || !form.avg_nav || !form.account_id) return setErr("Fill all fields");
    setLoading(true); setErr("");
    try {
      if (holding) await dbPatch(`/rest/v1/mf_holdings?id=eq.${holding.id}`, { account_id: form.account_id, scheme_name: form.scheme_name, isin: form.isin, fund_house: form.fund_house, fund_type: form.fund_type, units: +form.units, avg_nav: +form.avg_nav }, token);
      else await dbPost("/rest/v1/mf_holdings", { user_id: uid, account_id: form.account_id, scheme_name: form.scheme_name, isin: form.isin, fund_house: form.fund_house, fund_type: form.fund_type, units: +form.units, avg_nav: +form.avg_nav }, token);
      onSave();
    } catch (e) { setErr(e.message); }
    setLoading(false);
  };

  return (
    <div style={MS.overlay} onClick={onClose}>
      <div style={MS.modal} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
          <div><div style={{ color: C.gold, fontWeight: 800, letterSpacing: 1, fontSize: 13, textTransform: "uppercase" }}>{holding ? "✎ Edit MF" : "🏦 Add Mutual Fund"}</div><div style={{ color: C.muted, fontSize: 11, marginTop: 3 }}>Search from 72+ MF schemes</div></div>
          <button onClick={onClose} style={MS.closeBtn}>✕</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div style={MS.fg}><label style={S.lbl}>Account</label>
            <select style={S.inp} value={form.account_id} onChange={e => set("account_id", e.target.value)}>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div style={MS.fg}><label style={S.lbl}>Fund Type</label>
            <select style={S.inp} value={form.fund_type} onChange={e => set("fund_type", e.target.value)}>
              {MF_TYPES.map(t => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div style={{ ...MS.fg, gridColumn: "1/-1", position: "relative" }}>
            <label style={S.lbl}>Scheme Name / Fund House</label>
            <input style={S.inp} placeholder="HDFC Flexi Cap, SBI Small Cap…" value={schemeText}
              onChange={e => { const v = e.target.value; setSchemeText(v); set("scheme_name", v); searchMF(v); }} />
            {results.length > 0 && (
              <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, background: C.card, border: `1px solid ${C.gold}55`, borderRadius: 10, zIndex: 50, overflow: "hidden", boxShadow: "0 16px 48px rgba(0,0,0,.7)", maxHeight: 240, overflowY: "auto" }}>
                {results.map(s => (
                  <div key={s.isin} onClick={() => { set("scheme_name", s.scheme_name); set("isin", s.isin); set("fund_house", s.fund_house); set("fund_type", s.fund_type); setSchemeText(s.scheme_name); setResults([]); }}
                    style={{ padding: "10px 14px", cursor: "pointer", borderBottom: `1px solid ${C.border}` }}>
                    <div style={{ color: C.white, fontWeight: 600, fontSize: 12 }}>{s.scheme_name}</div>
                    <div style={{ color: C.muted, fontSize: 10, marginTop: 2 }}>{s.fund_house} · {s.fund_type}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div style={MS.fg}><label style={S.lbl}>Units</label><input style={S.inp} type="number" step="0.001" placeholder="50.234" value={form.units} onChange={e => set("units", e.target.value)} /></div>
          <div style={MS.fg}><label style={S.lbl}>Avg NAV (₹)</label><input style={S.inp} type="number" step="0.01" placeholder="450.00" value={form.avg_nav} onChange={e => set("avg_nav", e.target.value)} /></div>
          {form.units && form.avg_nav && (
            <div style={{ gridColumn: "1/-1", background: C.bg, borderRadius: 8, padding: "11px 16px", border: `1px solid ${C.gold}33`, display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: C.muted }}>Invested Value</span>
              <span style={{ color: C.gold, fontWeight: 700, fontSize: 16 }}>₹{fmt(+form.units * +form.avg_nav)}</span>
            </div>
          )}
        </div>
        <div style={{ background: `${C.navy}22`, border: `1px solid ${C.navy}55`, borderRadius: 8, padding: "9px 14px", marginTop: 12 }}>
          <div style={{ color: C.muted, fontSize: 11 }}>💡 Current NAV is fetched automatically from MFAPI for known schemes. You can update it manually later.</div>
        </div>
        {err && <div style={{ color: C.loss, fontSize: 12, marginTop: 10 }}>{err}</div>}
        <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
          <button onClick={onClose} style={MS.cancelBtn}>Cancel</button>
          <button onClick={submit} disabled={loading} style={{ ...MS.saveBtn, opacity: loading ? .6 : 1 }}>{loading ? "Saving…" : holding ? "Update" : "Add Fund"}</button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ACCOUNT MODAL
// ══════════════════════════════════════════════════════════════════════════════
function AccountModal({ account, token, onSave, onClose }) {
  const uid = jwtUid(token);
  const [name, setName] = useState(account?.name ?? "");
  const [broker, setBroker] = useState(account?.broker ?? "Zerodha");
  const [color, setColor] = useState(account?.color ?? ACC_COLORS[0]);
  const [loading, setLoading] = useState(false); const [err, setErr] = useState("");

  const submit = async () => {
    if (!name.trim()) return setErr("Enter account name"); setLoading(true); setErr("");
    try {
      if (account) await dbPatch(`/rest/v1/accounts?id=eq.${account.id}`, { name: name.trim(), broker, color }, token);
      else await dbPost("/rest/v1/accounts", { name: name.trim(), broker, color, user_id: uid }, token);
      onSave();
    } catch (e) { setErr(e.message); }
    setLoading(false);
  };

  return (
    <div style={MS.overlay} onClick={onClose}>
      <div style={{ ...MS.modal, maxWidth: 360 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 20 }}>
          <div style={{ color: C.gold, fontWeight: 800, fontSize: 13, textTransform: "uppercase", letterSpacing: 1 }}>{account ? "Edit Account" : "New Demat Account"}</div>
          <button onClick={onClose} style={MS.closeBtn}>✕</button>
        </div>
        <div style={{ ...MS.fg, marginBottom: 14 }}><label style={S.lbl}>Account Name</label><input style={S.inp} placeholder="e.g. Zerodha Primary" value={name} onChange={e => setName(e.target.value)} /></div>
        <div style={{ ...MS.fg, marginBottom: 14 }}><label style={S.lbl}>Broker</label><select style={S.inp} value={broker} onChange={e => setBroker(e.target.value)}>{BROKERS.map(b => <option key={b}>{b}</option>)}</select></div>
        <div style={{ ...MS.fg, marginBottom: 4 }}>
          <label style={S.lbl}>Color Tag</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 8 }}>
            {ACC_COLORS.map(c => <div key={c} onClick={() => setColor(c)} style={{ width: 30, height: 30, borderRadius: "50%", background: c, cursor: "pointer", border: `3px solid ${color === c ? C.white : "transparent"}`, boxSizing: "border-box" }} />)}
          </div>
        </div>
        {err && <div style={{ color: C.loss, fontSize: 12, marginTop: 10 }}>{err}</div>}
        <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
          <button onClick={onClose} style={MS.cancelBtn}>Cancel</button>
          <button onClick={submit} disabled={loading} style={{ ...MS.saveBtn, opacity: loading ? .6 : 1 }}>{loading ? "Saving…" : account ? "Update" : "Add Account"}</button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    (async () => {
      const saved = await stGet("pt-sess");
      if (saved?.at) {
        try { const r = await authRefresh(saved.rt); await stSet("pt-sess", { at: r.access_token, rt: r.refresh_token }); setSession({ at: r.access_token, rt: r.refresh_token }); }
        catch { setSession(saved); }
      }
      setChecking(false);
    })();
  }, []);

  if (checking) return <div style={{ background: C.bg, height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui" }}><div style={{ color: C.gold, letterSpacing: 3 }}>KOSH…</div></div>;
  return session ? <Main session={session} onLogout={() => setSession(null)} /> : <AuthScreen onAuth={d => setSession({ at: d.access_token, rt: d.refresh_token })} />;
}

function Main({ session, onLogout }) {
  const token = session.at;
  const isMobile = useIsMobile();

  const [accounts,  setAccounts]  = useState([]);
  const [holdings,  setHoldings]  = useState([]);
  const [mfHoldings,setMfHoldings]= useState([]);
  const [prices,    setPrices]    = useState({});
  const [mfNavs,    setMfNavs]    = useState({}); // schemeCode -> nav
  const [priceStatus, setPriceStatus] = useState("idle");
  const [lastRefresh, setLastRefresh] = useState(null);
  const [countdown,   setCountdown]   = useState(90);
  const [activeTab,   setActiveTab]   = useState("all");
  const [mainSection, setMainSection] = useState("stocks"); // stocks | mf
  const [privacy,     setPrivacy]     = useState(false);
  const [hoveredRow,  setHoveredRow]  = useState(null);

  const [modal, setModal] = useState(null); // null | "stock" | "mf" | "account" | "excel" | "editStock" | "editMF" | "editAccount"
  const [editItem, setEditItem] = useState(null);

  const timerRef = useRef(null);
  const cdRef    = useRef(null);

  const loadAccounts = useCallback(async () => { try { const r = await dbGet("/rest/v1/accounts?select=*&order=created_at.asc", token); setAccounts(r || []); } catch {} }, [token]);
  const loadHoldings = useCallback(async () => { try { const r = await dbGet("/rest/v1/holdings?select=*&order=created_at.asc", token); setHoldings(r || []); } catch {} }, [token]);
  const loadMF       = useCallback(async () => { try { const r = await dbGet("/rest/v1/mf_holdings?select=*&order=created_at.asc", token); setMfHoldings(r || []); } catch {} }, [token]);

  const refreshPrices = useCallback(async () => {
    const syms = [...new Set(holdings.map(h => h.symbol))].filter(Boolean);
    if (!syms.length) { setPriceStatus("idle"); return; }
    setPriceStatus("loading");
    const data = await fetchAllPrices(syms);
    if (Object.keys(data).length) { setPrices(prev => ({ ...prev, ...data })); setPriceStatus("ok"); setLastRefresh(new Date()); setCountdown(90); }
    else setPriceStatus("error");
  }, [holdings]);

  useEffect(() => { loadAccounts(); loadHoldings(); loadMF(); }, []);
  useEffect(() => { if (holdings.length) refreshPrices(); }, [holdings.length]);

  useEffect(() => {
    clearInterval(timerRef.current);
    clearInterval(cdRef.current);
    timerRef.current = setInterval(refreshPrices, 90000);
    cdRef.current    = setInterval(() => setCountdown(c => c <= 1 ? 90 : c - 1), 1000);
    return () => { clearInterval(timerRef.current); clearInterval(cdRef.current); };
  }, [refreshPrices]);

  const delHolding = async id => { try { await dbDelete(`/rest/v1/holdings?id=eq.${id}`, token); loadHoldings(); } catch {} };
  const delMF      = async id => { try { await dbDelete(`/rest/v1/mf_holdings?id=eq.${id}`, token); loadMF(); } catch {} };
  const delAccount = async id => {
    if (holdings.some(h => h.account_id === id)) return alert("Remove all holdings in this account first.");
    try { await dbDelete(`/rest/v1/accounts?id=eq.${id}`, token); loadAccounts(); if (activeTab === id) setActiveTab("all"); } catch {}
  };

  // ── Enriched stocks ─────────────────────────────────────────────────────────
  const visible  = (activeTab === "all" ? holdings : holdings.filter(h => h.account_id === activeTab));
  const enriched = visible.map(h => {
    const p = prices[h.symbol];
    const inv = h.qty * h.avg_price;
    const cur = p?.ltp != null ? h.qty * p.ltp : null;
    const pnl = cur != null ? cur - inv : null;
    const pct = pnl != null ? (pnl / inv) * 100 : null;
    return { ...h, ltp: p?.ltp ?? null, change: p?.change ?? null, changePct: p?.pct ?? null, high: p?.high, low: p?.low, inv, cur, pnl, pct };
  });

  // ── Enriched MF ──────────────────────────────────────────────────────────────
  const visMF    = activeTab === "all" ? mfHoldings : mfHoldings.filter(h => h.account_id === activeTab);
  const enrichMF = visMF.map(h => {
    const nav  = h.current_nav ?? null;
    const inv  = h.units * h.avg_nav;
    const cur  = nav != null ? h.units * nav : null;
    const pnl  = cur != null ? cur - inv : null;
    const pct  = pnl != null ? (pnl / inv) * 100 : null;
    return { ...h, nav, inv, cur, pnl, pct };
  });

  // ── Totals ────────────────────────────────────────────────────────────────────
  const stockInv = enriched.reduce((a, h) => a + h.inv, 0);
  const stockCur = enriched.reduce((a, h) => a + (h.cur ?? h.inv), 0);
  const mfInv    = enrichMF.reduce((a, h) => a + h.inv, 0);
  const mfCur    = enrichMF.reduce((a, h) => a + (h.cur ?? h.inv), 0);
  const totInv   = stockInv + mfInv;
  const totCur   = stockCur + mfCur;
  const totPnl   = totCur - totInv;
  const totPct   = totInv ? (totPnl / totInv) * 100 : 0;
  const dayPnl   = enriched.reduce((a, h) => a + ((h.change ?? 0) * h.qty), 0);

  const accSummary = accounts.map(a => {
    const sh = holdings.filter(h => h.account_id === a.id), mh = mfHoldings.filter(h => h.account_id === a.id);
    const inv = sh.reduce((x, h) => x + h.qty * h.avg_price, 0) + mh.reduce((x, h) => x + h.units * h.avg_nav, 0);
    const cur = sh.reduce((x, h) => { const l = prices[h.symbol]?.ltp; return x + (l ? h.qty * l : h.qty * h.avg_price); }, 0) + mh.reduce((x, h) => x + (h.current_nav ? h.units * h.current_nav : h.units * h.avg_nav), 0);
    return { ...a, inv, cur, pnl: cur - inv, count: sh.length + mh.length };
  });

  const openModal = (type, item = null) => { setEditItem(item); setModal(type); };
  const closeModal = () => { setModal(null); setEditItem(null); };
  const afterSave = (loadFn) => () => { loadFn(); closeModal(); setTimeout(refreshPrices, 600); };

  // Privacy helper
  const ph = (val) => privacy ? HIDDEN : val;

  // Stat chips for header
  const stats = [
    { l: "Portfolio Value", v: ph(fmtC(totCur)),  c: C.white, big: true },
    { l: "Invested",        v: ph(fmtC(totInv)),  c: C.ivoryD },
    { l: "Total P&L",       v: totPnl >= 0 ? `+${ph(fmtC(Math.abs(totPnl)))}` : `-${ph(fmtC(Math.abs(totPnl)))}`, c: privacy ? C.muted : clr(totPnl) },
    { l: "Returns",         v: privacy ? HIDDEN : `${totPct >= 0 ? "+" : ""}${fmt(totPct)}%`, c: privacy ? C.muted : clr(totPct) },
    { l: "Today's P&L",    v: dayPnl >= 0 ? `+${ph(fmtC(Math.abs(dayPnl)))}` : `-${ph(fmtC(Math.abs(dayPnl)))}`, c: privacy ? C.muted : clr(dayPnl) },
  ];

  // ── MOBILE ─────────────────────────────────────────────────────────────────
  if (isMobile) {
    const display = mainSection === "stocks" ? enriched : enrichMF;
    return (
      <div style={{ background: C.bg, minHeight: "100vh", fontFamily: "system-ui", display: "flex", flexDirection: "column" }}>
        <div style={{ height: 3, background: `linear-gradient(90deg,${C.navy},${C.gold},${C.navy})` }} />

        {/* Mobile Header */}
        <div style={{ background: C.card, padding: "10px 14px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 30, height: 30, borderRadius: 8, background: C.navy, display: "flex", alignItems: "center", justifyContent: "center", color: C.gold, fontWeight: 900, fontSize: 14 }}>K</div>
              <div>
                <div style={{ color: C.gold, fontWeight: 800, fontSize: 13, letterSpacing: 1 }}>KOSH</div>
                <div style={{ color: C.muted, fontSize: 9, letterSpacing: 1.5 }}>PORTFOLIO</div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button onClick={() => setPrivacy(p => !p)} style={{ background: privacy ? `${C.gold}33` : "transparent", border: `1px solid ${C.border}`, color: privacy ? C.gold : C.muted, borderRadius: 7, padding: "5px 8px", fontSize: 14, cursor: "pointer" }}>{privacy ? "🙈" : "👁"}</button>
              <button onClick={refreshPrices} style={{ background: C.navy, border: "none", color: C.white, borderRadius: 7, padding: "5px 9px", fontSize: 12, cursor: "pointer" }}>↺</button>
              <button onClick={async () => { await stDel("pt-sess"); onLogout(); }} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.muted, borderRadius: 7, padding: "5px 8px", fontSize: 11, cursor: "pointer" }}>Out</button>
            </div>
          </div>
          {/* Summary */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div style={{ background: `${C.navy}44`, borderRadius: 10, padding: "10px 12px", border: `1px solid ${C.gold}22` }}>
              <div style={{ color: C.muted, fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase" }}>Portfolio</div>
              <div style={{ color: C.gold, fontWeight: 800, fontSize: 20, marginTop: 2 }}>{ph(fmtC(totCur))}</div>
              <div style={{ color: privacy ? C.muted : clr(totPnl), fontSize: 11 }}>{privacy ? HIDDEN : `${sign(totPnl)}${fmtC(Math.abs(totPnl))} (${totPct >= 0 ? "+" : ""}${fmt(totPct)}%)`}</div>
            </div>
            <div style={{ background: C.cardL, borderRadius: 10, padding: "10px 12px" }}>
              <div style={{ color: C.muted, fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase" }}>Today's P&L</div>
              <div style={{ color: privacy ? C.muted : clr(dayPnl), fontWeight: 700, fontSize: 18, marginTop: 2 }}>{privacy ? HIDDEN : `${sign(dayPnl)}${fmtC(Math.abs(dayPnl))}`}</div>
              <div style={{ color: C.muted, fontSize: 10, marginTop: 1 }}>Invested: {ph(fmtC(totInv))}</div>
            </div>
          </div>
        </div>

        {/* Section toggle */}
        <div style={{ background: C.card, display: "flex", borderBottom: `1px solid ${C.border}` }}>
          {[["stocks","📈 Stocks"],["mf","🏦 Mutual Funds"]].map(([k, l]) => (
            <button key={k} onClick={() => setMainSection(k)} style={{ flex: 1, background: "none", border: "none", borderBottom: `2px solid ${mainSection === k ? C.gold : "transparent"}`, color: mainSection === k ? C.gold : C.muted, padding: "10px", fontSize: 12, fontWeight: mainSection === k ? 700 : 400, cursor: "pointer" }}>{l}</button>
          ))}
        </div>

        {/* Account tabs */}
        <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, display: "flex", overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
          {[{ id: "all", name: "All", color: C.gold, count: holdings.length + mfHoldings.length }, ...accSummary].map(a => (
            <button key={a.id} onClick={() => setActiveTab(a.id)}
              style={{ flexShrink: 0, background: "none", border: "none", borderBottom: `2px solid ${activeTab === a.id ? a.color : "transparent"}`, color: activeTab === a.id ? a.color : C.muted, padding: "8px 14px", cursor: "pointer", fontSize: 11, fontWeight: activeTab === a.id ? 700 : 400, whiteSpace: "nowrap" }}>
              {a.name} <span style={{ opacity: .6 }}>({a.count})</span>
            </button>
          ))}
          <button onClick={() => openModal("account")} style={{ flexShrink: 0, background: "none", border: "none", borderBottom: "2px solid transparent", color: C.gold, padding: "8px 14px", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>+ Account</button>
        </div>

        {/* Holdings cards */}
        <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px 90px" }}>
          {display.length === 0 ? (
            <div style={{ textAlign: "center", paddingTop: 60, color: C.muted }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>📊</div>
              <div style={{ marginBottom: 16 }}>No {mainSection === "mf" ? "mutual funds" : "stocks"} yet</div>
              <button onClick={() => openModal(mainSection === "mf" ? "mf" : "stock")} style={{ background: C.gold, border: "none", color: C.bg, borderRadius: 9, padding: "11px 24px", fontWeight: 700, cursor: "pointer" }}>+ Add Now</button>
            </div>
          ) : display.map(h => (
            <div key={h.id} style={{ background: C.card, borderRadius: 12, padding: 14, border: `1px solid ${C.border}`, marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                <div>
                  <div style={{ color: C.white, fontWeight: 800, fontSize: 15 }}>{mainSection === "mf" ? h.scheme_name?.split(" - ")[0].slice(0, 22) + "…" : h.symbol}</div>
                  <div style={{ display: "flex", gap: 6, marginTop: 3, alignItems: "center" }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: accounts.find(a => a.id === h.account_id)?.color ?? C.muted }} />
                    <span style={{ color: C.muted, fontSize: 10 }}>{accounts.find(a => a.id === h.account_id)?.name} · {mainSection === "mf" ? h.fund_type : h.exchange}</span>
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ color: C.white, fontWeight: 700, fontSize: 15 }}>{ph(h.ltp != null || h.nav != null ? `₹${fmt(h.ltp ?? h.nav)}` : "—")}</div>
                  {(h.changePct != null) && <div style={{ color: clr(h.changePct), fontSize: 10 }}>{sign(h.changePct)}{fmt(Math.abs(h.changePct))}%</div>}
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 7, marginBottom: 10 }}>
                {[
                  { l: mainSection === "mf" ? "Units" : "Qty", v: fmt(h.qty ?? h.units, mainSection === "mf" ? 3 : 0) },
                  { l: "Invested", v: ph(fmtC(h.inv)), c: C.ivoryD },
                  { l: "Current",  v: ph(h.cur != null ? fmtC(h.cur) : "—"), c: C.white },
                  { l: "P&L",      v: ph(h.pnl != null ? `${h.pnl >= 0 ? "+" : ""}${fmtC(Math.abs(h.pnl))}` : "—"), c: privacy ? C.muted : clr(h.pnl) },
                  { l: "Return",   v: privacy ? HIDDEN : (h.pct != null ? `${h.pct >= 0 ? "+" : ""}${fmt(h.pct)}%` : "—"), c: privacy ? C.muted : clr(h.pct) },
                  { l: "Avg",      v: `₹${fmt(h.avg_price ?? h.avg_nav)}`, c: C.muted },
                ].map((m, i) => (
                  <div key={i} style={{ background: C.cardL, borderRadius: 8, padding: "6px 8px" }}>
                    <div style={{ color: C.muted, fontSize: 8, letterSpacing: 1, textTransform: "uppercase" }}>{m.l}</div>
                    <div style={{ color: m.c ?? C.white, fontWeight: 600, fontSize: 11, marginTop: 1 }}>{m.v}</div>
                  </div>
                ))}
              </div>
              {/* Edit/Delete — subtle, at bottom */}
              <div style={{ display: "flex", gap: 6, opacity: 0.55 }}>
                <button onClick={() => openModal(mainSection === "mf" ? "mf" : "stock", h)} style={{ flex: 1, background: `${C.navy}33`, border: `1px solid ${C.navy}55`, color: "#7EB4D8", borderRadius: 7, padding: "6px", fontSize: 11, cursor: "pointer" }}>✎ Edit</button>
                <button onClick={() => mainSection === "mf" ? delMF(h.id) : delHolding(h.id)} style={{ flex: 1, background: `${C.loss}11`, border: `1px solid ${C.loss}33`, color: C.loss, borderRadius: 7, padding: "6px", fontSize: 11, cursor: "pointer" }}>✕ Remove</button>
              </div>
            </div>
          ))}
        </div>

        {/* FABs */}
        <div style={{ position: "fixed", bottom: 20, right: 16, display: "flex", flexDirection: "column", gap: 10, zIndex: 20 }}>
          <button onClick={() => openModal("excel")} style={{ width: 44, height: 44, borderRadius: "50%", background: C.navy, border: "none", color: C.white, fontSize: 18, cursor: "pointer", boxShadow: "0 4px 16px rgba(0,0,0,.4)" }}>📊</button>
          <button onClick={() => openModal(mainSection === "mf" ? "mf" : "stock")} style={{ width: 54, height: 54, borderRadius: "50%", background: C.gold, border: "none", color: C.bg, fontSize: 26, fontWeight: 700, cursor: "pointer", boxShadow: `0 4px 20px ${C.gold}55` }}>+</button>
        </div>

        {modal === "stock"   && <StockModal   holding={editItem} accounts={accounts} token={token} onSave={afterSave(loadHoldings)} onClose={closeModal} />}
        {modal === "mf"      && <MFModal      holding={editItem} accounts={accounts} token={token} onSave={afterSave(loadMF)}      onClose={closeModal} />}
        {modal === "account" && <AccountModal account={editItem} token={token} onSave={afterSave(loadAccounts)} onClose={closeModal} />}
        {modal === "excel"   && <ExcelImportModal accounts={accounts} token={token} onSave={(msg) => { alert(msg); loadHoldings(); loadMF(); closeModal(); }} onClose={closeModal} />}
      </div>
    );
  }

  // ── DESKTOP ────────────────────────────────────────────────────────────────
  return (
    <div style={{ background: C.bg, minHeight: "100vh", fontFamily: "system-ui", display: "flex", flexDirection: "column" }}>
      <div style={{ height: 3, background: `linear-gradient(90deg,${C.navy},${C.gold},${C.navy})` }} />

      {/* Header */}
      <header style={{ background: C.card, borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", padding: "0 20px", gap: 0, minHeight: 66, flexShrink: 0 }}>
        {/* KOSH Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, paddingRight: 20, borderRight: `1px solid ${C.border}`, marginRight: 20 }}>
          <div style={{ width: 36, height: 36, borderRadius: 9, background: C.navy, display: "flex", alignItems: "center", justifyContent: "center", color: C.gold, fontWeight: 900, fontSize: 18, border: `1px solid ${C.gold}33` }}>K</div>
          <div>
            <div style={{ color: C.gold, fontWeight: 800, fontSize: 15, letterSpacing: 1 }}>KOSH</div>
            <div style={{ color: C.muted, fontSize: 9, letterSpacing: 2, textTransform: "uppercase" }}>Portfolio Terminal</div>
          </div>
        </div>

        {/* Stats */}
        {stats.map((m, i) => (
          <div key={i} style={{ textAlign: "center", padding: "0 16px", borderRight: i < 4 ? `1px solid ${C.border}` : "none" }}>
            <div style={{ color: C.muted, fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase" }}>{m.l}</div>
            <div style={{ color: m.c, fontSize: m.big ? 19 : 13, fontWeight: m.big ? 800 : 600, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>{m.v}</div>
          </div>
        ))}

        {/* Controls */}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, paddingLeft: 20, borderLeft: `1px solid ${C.border}` }}>
          {/* Countdown */}
          <div style={{ textAlign: "right" }}>
            <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: priceStatus === "ok" ? C.profit : priceStatus === "loading" ? "#F59E0B" : C.loss, boxShadow: priceStatus === "ok" ? `0 0 6px ${C.profit}` : "none" }} />
              <span style={{ color: C.muted, fontSize: 10 }}>{priceStatus === "ok" ? `Live · ↺${countdown}s` : priceStatus === "loading" ? "Fetching…" : "Offline"}</span>
            </div>
            {lastRefresh && <div style={{ color: C.muted, fontSize: 9, marginTop: 1 }}>{lastRefresh.toLocaleTimeString()}</div>}
          </div>
          <button onClick={() => setPrivacy(p => !p)} style={{ background: privacy ? `${C.gold}22` : "transparent", border: `1px solid ${privacy ? C.gold : C.border}`, color: privacy ? C.gold : C.muted, borderRadius: 7, padding: "6px 10px", cursor: "pointer", fontSize: 16 }} title="Privacy Mode">{privacy ? "🙈" : "👁"}</button>
          <button onClick={refreshPrices} style={{ background: C.navy, border: "none", color: C.white, borderRadius: 7, padding: "6px 13px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>↺ Refresh</button>
          <button onClick={() => openModal("excel")} style={{ background: `${C.navy}66`, border: `1px solid ${C.navy}`, color: "#7EB4D8", borderRadius: 7, padding: "6px 13px", cursor: "pointer", fontSize: 12 }}>📊 Import</button>
          <button onClick={() => openModal(mainSection === "mf" ? "mf" : "stock")} style={{ background: C.gold, border: "none", color: C.bg, borderRadius: 7, padding: "6px 13px", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>+ Add</button>
          <button onClick={async () => { await stDel("pt-sess"); onLogout(); }} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.muted, borderRadius: 7, padding: "6px 11px", cursor: "pointer", fontSize: 12 }}>Logout</button>
        </div>
      </header>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Sidebar */}
        <aside style={{ width: 210, background: C.card, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", overflow: "hidden", flexShrink: 0 }}>
          <div onClick={() => setActiveTab("all")}
            style={{ padding: "13px 16px", cursor: "pointer", borderLeft: `3px solid ${activeTab === "all" ? C.gold : "transparent"}`, background: activeTab === "all" ? `${C.navy}99` : "transparent", borderBottom: `1px solid ${C.border}` }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: activeTab === "all" ? C.gold : C.ivoryD, fontSize: 11, fontWeight: 700, letterSpacing: 1 }}>ALL ACCOUNTS</span>
              <span style={{ background: C.cardL, color: C.muted, borderRadius: 10, padding: "1px 7px", fontSize: 10 }}>{holdings.length + mfHoldings.length}</span>
            </div>
            <div style={{ color: C.white, fontSize: 17, fontWeight: 700, marginTop: 4 }}>{ph(fmtC(totCur))}</div>
            <div style={{ color: privacy ? C.muted : clr(totPnl), fontSize: 12 }}>{privacy ? HIDDEN : `${sign(totPnl)}${fmtC(totPnl)}`}</div>
          </div>
          <div style={{ height: 1, background: C.border }} />
          <div style={{ flex: 1, overflowY: "auto" }}>
            {accSummary.map(acc => (
              <div key={acc.id}
                onMouseEnter={() => setHoveredRow(`acc-${acc.id}`)} onMouseLeave={() => setHoveredRow(null)}
                onClick={() => setActiveTab(acc.id)}
                style={{ padding: "12px 16px", cursor: "pointer", borderLeft: `3px solid ${activeTab === acc.id ? acc.color : "transparent"}`, background: activeTab === acc.id ? `${C.navy}44` : "transparent", borderBottom: `1px solid ${C.border}`, position: "relative" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <div>
                    <div style={{ color: acc.color, fontSize: 12, fontWeight: 700 }}>{acc.name}</div>
                    <div style={{ color: C.muted, fontSize: 10 }}>{acc.broker}</div>
                  </div>
                  {/* Edit/del hidden until hover */}
                  <div style={{ display: "flex", gap: 4, opacity: hoveredRow === `acc-${acc.id}` ? 1 : 0, transition: "opacity .2s" }}>
                    <button onClick={e => { e.stopPropagation(); openModal("account", acc); }} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 12, padding: "2px 4px" }}>✎</button>
                    <button onClick={e => { e.stopPropagation(); delAccount(acc.id); }} style={{ background: "none", border: "none", color: C.loss, cursor: "pointer", fontSize: 12, padding: "2px 4px" }}>✕</button>
                  </div>
                </div>
                <div style={{ color: C.white, fontSize: 14, fontWeight: 600, marginTop: 6 }}>{ph(fmtC(acc.cur))}</div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
                  <span style={{ color: privacy ? C.muted : clr(acc.pnl), fontSize: 11 }}>{privacy ? HIDDEN : `${sign(acc.pnl)}${fmtC(acc.pnl)}`}</span>
                  <span style={{ color: C.muted, fontSize: 10 }}>{acc.count} items</span>
                </div>
              </div>
            ))}
          </div>
          <div style={{ padding: 10, borderTop: `1px solid ${C.border}` }}>
            <button onClick={() => openModal("account")} style={{ width: "100%", background: "transparent", border: `1px dashed ${C.gold}55`, color: C.gold, borderRadius: 8, padding: "8px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>+ Add Account</button>
          </div>
        </aside>

        {/* Main content */}
        <main style={{ flex: 1, overflowY: "auto", background: C.cardL, display: "flex", flexDirection: "column" }}>
          {/* Section tabs */}
          <div style={{ display: "flex", background: C.card, borderBottom: `1px solid ${C.border}`, padding: "0 20px" }}>
            {[["stocks","📈 Stocks",enriched.length],["mf","🏦 Mutual Funds",enrichMF.length]].map(([k, l, cnt]) => (
              <button key={k} onClick={() => setMainSection(k)}
                style={{ background: "none", border: "none", borderBottom: `2px solid ${mainSection === k ? C.gold : "transparent"}`, color: mainSection === k ? C.gold : C.muted, padding: "12px 18px", cursor: "pointer", fontSize: 13, fontWeight: mainSection === k ? 700 : 400, transition: "all .15s" }}>
                {l} <span style={{ fontSize: 11, opacity: .7 }}>({cnt})</span>
              </button>
            ))}
          </div>

          <div style={{ padding: 16, flex: 1 }}>
            {mainSection === "stocks" && (
              enriched.length === 0 ? (
                <EmptyState label="stocks" onAdd={() => openModal("stock")} />
              ) : (
                <DataTable rows={enriched} accounts={accounts} privacy={privacy} ph={ph} hoveredRow={hoveredRow} setHoveredRow={setHoveredRow}
                  onEdit={h => openModal("stock", h)} onDelete={delHolding}
                  totInv={stockInv} totCur={stockCur}
                  columns={["Symbol","Account","Qty","Avg Price","LTP","Day%","High","Low","Invested","Current","P&L","Return"]}
                  renderRow={(h, acc, i) => [
                    <div><div style={{ color: C.white, fontWeight: 700 }}>{h.symbol}</div><div style={{ color: C.muted, fontSize: 10 }}>{h.exchange}</div></div>,
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}><div style={{ width: 7, height: 7, borderRadius: "50%", background: acc?.color ?? C.muted }} /><span style={{ color: C.ivoryD, fontSize: 11 }}>{acc?.name ?? "—"}</span></div>,
                    <span style={{ color: C.white }}>{h.qty}</span>,
                    <span style={{ color: C.muted }}>₹{fmt(h.avg_price)}</span>,
                    <span style={{ color: h.ltp ? C.white : C.muted, fontWeight: 700 }}>{h.ltp ? `₹${fmt(h.ltp)}` : "—"}</span>,
                    <span style={{ color: clr(h.changePct), fontWeight: 600 }}>{h.changePct != null ? `${sign(h.changePct)}${fmt(Math.abs(h.changePct))}%` : "—"}</span>,
                    <span style={{ color: C.muted }}>{h.high ? `₹${fmt(h.high)}` : "—"}</span>,
                    <span style={{ color: C.muted }}>{h.low ? `₹${fmt(h.low)}` : "—"}</span>,
                    <span style={{ color: C.ivoryD }}>{ph(`₹${fmt(h.inv)}`)}</span>,
                    <span style={{ color: C.white, fontWeight: 600 }}>{ph(h.cur != null ? `₹${fmt(h.cur)}` : "—")}</span>,
                    <span style={{ background: h.pnl != null ? (h.pnl > 0 ? `${C.profit}18` : `${C.loss}18`) : "transparent", color: privacy ? C.muted : clr(h.pnl), padding: "2px 7px", borderRadius: 4, fontWeight: 700, fontSize: 11 }}>{privacy ? HIDDEN : (h.pnl != null ? `${h.pnl >= 0 ? "+" : ""}₹${fmt(Math.abs(h.pnl))}` : "—")}</span>,
                    <span style={{ color: privacy ? C.muted : clr(h.pct), fontWeight: 600 }}>{privacy ? HIDDEN : (h.pct != null ? `${h.pct >= 0 ? "+" : ""}${fmt(h.pct)}%` : "—")}</span>,
                  ]}
                />
              )
            )}
            {mainSection === "mf" && (
              enrichMF.length === 0 ? (
                <EmptyState label="mutual funds" onAdd={() => openModal("mf")} />
              ) : (
                <DataTable rows={enrichMF} accounts={accounts} privacy={privacy} ph={ph} hoveredRow={hoveredRow} setHoveredRow={setHoveredRow}
                  onEdit={h => openModal("mf", h)} onDelete={delMF}
                  totInv={mfInv} totCur={mfCur}
                  columns={["Scheme","Account","Type","Units","Avg NAV","Curr NAV","Invested","Current","P&L","Return"]}
                  renderRow={(h, acc) => [
                    <div style={{ maxWidth: 200 }}><div style={{ color: C.white, fontWeight: 600, fontSize: 12, whiteSpace: "normal", lineHeight: 1.3 }}>{h.scheme_name}</div><div style={{ color: C.muted, fontSize: 10 }}>{h.fund_house}</div></div>,
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}><div style={{ width: 7, height: 7, borderRadius: "50%", background: acc?.color ?? C.muted }} /><span style={{ color: C.ivoryD, fontSize: 11 }}>{acc?.name ?? "—"}</span></div>,
                    <span style={{ background: `${C.navy}55`, color: "#7EB4D8", padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 600 }}>{h.fund_type}</span>,
                    <span style={{ color: C.white }}>{fmt(h.units, 3)}</span>,
                    <span style={{ color: C.muted }}>₹{fmt(h.avg_nav)}</span>,
                    <span style={{ color: h.nav ? C.white : C.muted, fontWeight: 700 }}>{h.nav ? `₹${fmt(h.nav)}` : "—"}</span>,
                    <span style={{ color: C.ivoryD }}>{ph(`₹${fmt(h.inv)}`)}</span>,
                    <span style={{ color: C.white, fontWeight: 600 }}>{ph(h.cur != null ? `₹${fmt(h.cur)}` : "—")}</span>,
                    <span style={{ background: h.pnl != null ? (h.pnl > 0 ? `${C.profit}18` : `${C.loss}18`) : "transparent", color: privacy ? C.muted : clr(h.pnl), padding: "2px 7px", borderRadius: 4, fontWeight: 700, fontSize: 11 }}>{privacy ? HIDDEN : (h.pnl != null ? `${h.pnl >= 0 ? "+" : ""}₹${fmt(Math.abs(h.pnl))}` : "—")}</span>,
                    <span style={{ color: privacy ? C.muted : clr(h.pct), fontWeight: 600 }}>{privacy ? HIDDEN : (h.pct != null ? `${h.pct >= 0 ? "+" : ""}${fmt(h.pct)}%` : "—")}</span>,
                  ]}
                />
              )
            )}
          </div>

          {/* KOSH Footer */}
          <div style={{ padding: "8px 20px", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "center", alignItems: "center", gap: 8, background: C.card }}>
            <div style={{ width: 18, height: 18, borderRadius: 5, background: C.navy, display: "flex", alignItems: "center", justifyContent: "center", color: C.gold, fontWeight: 900, fontSize: 9 }}>K</div>
            <span style={{ color: C.muted, fontSize: 10, letterSpacing: 2, textTransform: "uppercase" }}>Exclusively Powered by KOSH · {new Date().getFullYear()}</span>
          </div>
        </main>
      </div>

      {modal === "stock"   && <StockModal   holding={editItem} accounts={accounts} token={token} onSave={afterSave(loadHoldings)} onClose={closeModal} />}
      {modal === "mf"      && <MFModal      holding={editItem} accounts={accounts} token={token} onSave={afterSave(loadMF)}      onClose={closeModal} />}
      {modal === "account" && <AccountModal account={editItem} token={token} onSave={afterSave(loadAccounts)} onClose={closeModal} />}
      {modal === "excel"   && <ExcelImportModal accounts={accounts} token={token} onSave={(msg) => { alert(msg); loadHoldings(); loadMF(); closeModal(); }} onClose={closeModal} />}
    </div>
  );
}

// ── Reusable table component ───────────────────────────────────────────────────
function DataTable({ rows, accounts, privacy, ph, hoveredRow, setHoveredRow, onEdit, onDelete, totInv, totCur, columns, renderRow }) {
  const totPnl = totCur - totInv;
  const totPct = totInv ? (totPnl / totInv) * 100 : 0;
  return (
    <div style={{ background: C.card, borderRadius: 12, overflow: "hidden", border: `1px solid ${C.border}` }}>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead><tr style={{ background: C.bg }}>
            {[...columns, ""].map(h => <th key={h} style={{ padding: "9px 12px", textAlign: "left", color: C.muted, fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>{h}</th>)}
          </tr></thead>
          <tbody>
            {rows.map((h, i) => {
              const acc = accounts.find(a => a.id === h.account_id);
              const cells = renderRow(h, acc, i);
              const isHovered = hoveredRow === h.id;
              return (
                <tr key={h.id} onMouseEnter={() => setHoveredRow(h.id)} onMouseLeave={() => setHoveredRow(null)}
                  style={{ borderBottom: `1px solid ${C.border}`, background: isHovered ? `${C.navy}22` : i % 2 === 1 ? `${C.bg}66` : "transparent", transition: "background .1s" }}>
                  {cells.map((cell, j) => <td key={j} style={{ padding: "10px 12px", verticalAlign: "middle", whiteSpace: "nowrap" }}>{cell}</td>)}
                  <td style={{ padding: "10px 12px", verticalAlign: "middle" }}>
                    {/* Buttons hidden until row hover */}
                    <div style={{ display: "flex", gap: 4, opacity: isHovered ? 1 : 0, transition: "opacity .2s", pointerEvents: isHovered ? "auto" : "none" }}>
                      <button onClick={() => onEdit(h)} style={{ background: `${C.navy}44`, border: `1px solid ${C.navy}`, color: "#7EB4D8", cursor: "pointer", borderRadius: 5, padding: "3px 7px", fontSize: 11 }}>✎</button>
                      <button onClick={() => onDelete(h.id)} style={{ background: `${C.loss}11`, border: `1px solid ${C.loss}44`, color: C.loss, cursor: "pointer", borderRadius: 5, padding: "3px 7px", fontSize: 11 }}>✕</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot><tr style={{ background: C.bg, borderTop: `2px solid ${C.gold}44` }}>
            <td colSpan={columns.length - 3} style={{ padding: "10px 12px", color: C.gold, fontWeight: 700, fontSize: 10, letterSpacing: 1, textTransform: "uppercase" }}>TOTAL</td>
            <td style={{ padding: "10px 12px", color: C.ivoryD, fontWeight: 600 }}>{ph(`₹${fmt(totInv)}`)}</td>
            <td style={{ padding: "10px 12px", color: C.white, fontWeight: 700 }}>{ph(`₹${fmt(totCur)}`)}</td>
            <td style={{ padding: "10px 12px" }}><span style={{ background: totPnl > 0 ? `${C.profit}22` : `${C.loss}22`, color: privacy ? C.muted : clr(totPnl), padding: "3px 8px", borderRadius: 5, fontWeight: 700 }}>{privacy ? HIDDEN : `${totPnl >= 0 ? "+" : ""}₹${fmt(Math.abs(totPnl))}`}</span></td>
            <td style={{ padding: "10px 12px", color: privacy ? C.muted : clr(totPct), fontWeight: 700 }}>{privacy ? HIDDEN : `${totPct >= 0 ? "+" : ""}${fmt(totPct)}%`}</td>
            <td />
          </tr></tfoot>
        </table>
      </div>
    </div>
  );
}

function EmptyState({ label, onAdd }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "55%", gap: 14 }}>
      <div style={{ width: 64, height: 64, borderRadius: "50%", background: C.card, border: `2px dashed ${C.border}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 }}>📊</div>
      <div style={{ color: C.ivoryD }}>No {label} added yet</div>
      <button onClick={onAdd} style={{ background: C.gold, border: "none", color: C.bg, borderRadius: 9, padding: "10px 24px", fontWeight: 700, cursor: "pointer" }}>+ Add {label.charAt(0).toUpperCase() + label.slice(1)}</button>
    </div>
  );
}

// ─── Shared style tokens ──────────────────────────────────────────────────────
const S = {
  lbl: { color: C.muted, fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", display: "block", marginBottom: 6 },
  inp: { background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 13px", color: C.white, fontSize: 13, outline: "none", width: "100%", boxSizing: "border-box" },
};
const MS = {
  overlay: { position: "fixed", inset: 0, background: "rgba(8,10,12,.9)", backdropFilter: "blur(6px)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 },
  modal: { background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: "24px 26px", width: "100%", maxWidth: 480, maxHeight: "92vh", overflowY: "auto", boxShadow: "0 32px 100px rgba(0,0,0,.8)" },
  closeBtn: { background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 20, padding: 4, flexShrink: 0 },
  fg: { display: "flex", flexDirection: "column", gap: 6 },
  saveBtn: { flex: 1, background: C.gold, border: "none", color: C.bg, borderRadius: 9, padding: "12px", fontWeight: 800, fontSize: 13, cursor: "pointer" },
  cancelBtn: { background: "transparent", border: `1px solid ${C.border}`, color: C.muted, borderRadius: 9, padding: "11px 20px", cursor: "pointer", fontSize: 13 },
};