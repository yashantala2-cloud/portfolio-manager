// Dhan API — requires access token
async function fetchDhan(symbols, accessToken) {
  if (!accessToken) return {};
  try {
    const out = {};
    for (const symbol of symbols) {
      const res = await fetch(`https://api.dhan.co/market/feed/quotes/${symbol}/NSE`, {
        headers: {
          'access-token': accessToken,
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const q = data?.data;
      if (q && q.ltp != null) {
        out[symbol] = {
          ltp: q.ltp,
          change: q.netChange ?? 0,
          pct: q.percentChange ?? 0
        };
      }
    }
    return out;
  } catch { return {}; }
}
import { useState, useEffect, useCallback, useRef } from "react";
import * as XLSX from "xlsx";

// ─── Supabase ─────────────────────────────────────────────────────────────────
const SB_URL = "https://qyrqjxbhttaqjgihmzgx.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF5cnFqeGJodHRhcWpnaWhtemd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2NTg5MzQsImV4cCI6MjA4NzIzNDkzNH0.cQC2Vo722Z_LY8X5an2QJqJhavjIstmzNbp2Cjo_51I";

const jwtUid = t => { try { return JSON.parse(atob(t.split(".")[1])).sub; } catch { return null; } };
const jwtExp = t => { try { return JSON.parse(atob(t.split(".")[1])).exp * 1000; } catch { return 0; } };

const sb = async (path, opts = {}, token = null) => {
  const h = { apikey: SB_KEY, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...opts.headers };
  const r = await fetch(`${SB_URL}${path}`, { ...opts, headers: h });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.message || e.error_description || `Error ${r.status}`); }
  return r.status === 204 ? null : r.json();
};

const authLogin   = (e, p) => sb("/auth/v1/token?grant_type=password", { method: "POST", body: JSON.stringify({ email: e, password: p }) });
const authSignup  = (e, p) => sb("/auth/v1/signup", { method: "POST", body: JSON.stringify({ email: e, password: p }) });
const authRefresh = rt     => sb("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: rt }) });
const authPwdChange = (token, pwd) => sb("/auth/v1/user", { method: "PUT", body: JSON.stringify({ password: pwd }) }, token);
const dbGet    = (p, t)    => sb(p, {}, t);
const dbPost   = (p, b, t) => sb(p, { method: "POST",   headers: { Prefer: "return=representation" }, body: JSON.stringify(b) }, t);
const dbPatch  = (p, b, t) => sb(p, { method: "PATCH",  headers: { Prefer: "return=representation" }, body: JSON.stringify(b) }, t);
const dbDelete = (p, t)    => sb(p, { method: "DELETE" }, t);
const dbUpsert = (p, b, t) => sb(p, { method: "POST", headers: { Prefer: "return=representation,resolution=merge-duplicates" }, body: JSON.stringify(b) }, t);

const stGet = async k => { try { const r = await window.storage.get(k); return r ? JSON.parse(r.value) : null; } catch { return null; } };
const stSet = async (k, v) => { try { await window.storage.set(k, JSON.stringify(v)); } catch {} };
const stDel = async k => { try { await window.storage.delete(k); } catch {} };

// ─── Market Hours ─────────────────────────────────────────────────────────────
const getIST = () => new Date(Date.now() + new Date().getTimezoneOffset() * 60000 + 19800000);
const isMarketOpen = () => { const d = getIST(), day = d.getDay(), m = d.getHours() * 60 + d.getMinutes(); return day > 0 && day < 6 && m >= 555 && m < 930; };
const todayIST = () => getIST().toISOString().slice(0, 10);

// ─── LTP Fetching — Angel One SmartAPI primary, Upstox fallback, Yahoo last ───
// Angel One SmartAPI — requires user API key + JWT from login
async function fetchAngeleOne(symbols, apiKey, jwtToken) {
  if (!apiKey || !jwtToken) return {};
  try {
    const instrumentList = symbols.map(s => ({ exchange: "NSE", tradingsymbol: s, symboltoken: "" }));
    const res = await fetch("https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwtToken}`, "X-Api-Key": apiKey, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "FULL", exchangeTokens: { NSE: symbols } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return {};
    const data = await res.json();
    const out = {};
    (data?.data?.fetched || []).forEach(q => { if (q.tradingSymbol && q.ltp != null) out[q.tradingSymbol] = { ltp: q.ltp, change: q.netChange ?? 0, pct: q.percentChange ?? 0 }; });
    return out;
  } catch { return {}; }
}

// Upstox API v2 — requires access_token from OAuth
async function fetchUpstox(symbols, accessToken) {
  if (!accessToken) return {};
  try {
    const instrumentKeys = symbols.map(s => `NSE_EQ|${s}`).join(",");
    const res = await fetch(`https://api.upstox.com/v2/market-quote/quotes?symbol=${encodeURIComponent(instrumentKeys)}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return {};
    const data = await res.json();
    const out = {};
    Object.values(data?.data || {}).forEach(q => {
      const sym = q.instrument_token?.replace("NSE_EQ|", "") || q.symbol;
      if (sym && q.last_price != null) out[sym] = { ltp: q.last_price, change: q.net_change ?? 0, pct: q.net_change_percentage ?? 0 };
    });
    return out;
  } catch { return {}; }
}

// Yahoo Finance (no-auth, CORS proxy chain)
async function fetchYahoo(syms) {
  const qs = syms.map(s => `${s}.NS`).join(",");
  const base = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${qs}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent`;
  const urls = [base, `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${qs}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent`, `https://api.allorigins.win/raw?url=${encodeURIComponent(base)}`, `https://corsproxy.io/?url=${encodeURIComponent(base)}`];
  for (const url of urls) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { Accept: "application/json" } });
      if (!r.ok) continue;
      const d = await r.json();
      const quotes = d?.quoteResponse?.result || [];
      if (!quotes.length) continue;
      const out = {};
      for (const q of quotes) { const s = q.symbol?.replace(".NS", ""); if (s && q.regularMarketPrice != null) out[s] = { ltp: q.regularMarketPrice, change: q.regularMarketChange ?? 0, pct: q.regularMarketChangePercent ?? 0 }; }
      if (Object.keys(out).length) return out;
    } catch { /* next */ }
  }
  return {};
}

// Claude API with web search — guaranteed to work in artifact environment
async function fetchPricesViaClaude(symbols) {
  if (!symbols.length) return {};
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514", max_tokens: 1000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        system: `Return ONLY valid JSON, no text, no markdown. Format: {\"SYMBOL\": {\"ltp\": number, \"change\": number, \"pct\": number}}`,
        messages: [{ role: "user", content: `Search NSE India current stock prices for: ${symbols.slice(0, 8).join(", ")}. Return JSON only with current LTP in rupees.` }]
      })
    });
    if (!res.ok) return {};
    const data = await res.json();
    const text = data.content?.filter(b => b.type === "text").map(b => b.text).join("") || "";
    const j = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    return j ? JSON.parse(j) : {};
  } catch { return {}; }
}

// Groq API for stock prices
async function fetchPricesViaGroq(symbols) {
  if (!symbols.length) return {};
  const apiKey = import.meta.env.VITE_GROQ_API_KEY;
  if (!apiKey) return {};
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "llama3-70b-8192",
        messages: [
          {
            role: "system",
            content: "Return ONLY valid JSON, no text, no markdown. Format: {\"SYMBOL\": {\"ltp\": number, \"change\": number, \"pct\": number}}"
          },
          {
            role: "user",
            content: `Search NSE India current stock prices for: ${symbols.slice(0, 8).join(", ")}. Return JSON only with current LTP in rupees.`
          }
        ],
        max_tokens: 1000
      })
    });
    if (!res.ok) return {};
    const data = await res.json();
    let text = data.choices?.[0]?.message?.content || "";
    const j = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    return j ? JSON.parse(j) : {};
  } catch { return {}; }
}

// Master fetch — tries Angel One → Upstox → Yahoo → Claude
async function fetchAllPrices(symbols, profile) {
  if (!symbols.length) return {};
  const out = {};
  const remaining = [...symbols];


  // 1. Try Angel One if user has API keys
  if (profile?.angelone_api_key && profile?.angelone_client_code) {
    const ao = await fetchAngeleOne(remaining, profile.angelone_api_key, profile.angelone_client_code);
    Object.assign(out, ao);
    remaining.splice(0, remaining.length, ...remaining.filter(s => !out[s]));
  }

  // 2. Try Upstox if user has access token
  if (remaining.length && profile?.upstox_access_token) {
    const up = await fetchUpstox(remaining, profile.upstox_access_token);
    Object.assign(out, up);
    remaining.splice(0, remaining.length, ...remaining.filter(s => !out[s]));
  }

  // 3. Try Dhan if user has access token
  if (remaining.length && profile?.dhan_access_token) {
    const dh = await fetchDhan(remaining, profile.dhan_access_token);
    Object.assign(out, dh);
    remaining.splice(0, remaining.length, ...remaining.filter(s => !out[s]));
  }

  // 3. Yahoo Finance for remaining
  if (remaining.length) {
    const chunks = [];
    for (let i = 0; i < remaining.length; i += 8) chunks.push(remaining.slice(i, i + 8));
    const yResults = await Promise.allSettled(chunks.map(fetchYahoo));
    yResults.forEach(r => { if (r.status === "fulfilled") Object.assign(out, r.value); });
    remaining.splice(0, remaining.length, ...remaining.filter(s => !out[s]));
  }


  // 4. Claude API fallback for anything still missing
  if (remaining.length) {
    const chunks = [];
    for (let i = 0; i < remaining.length; i += 8) chunks.push(remaining.slice(i, i + 8));
    for (const chunk of chunks) { const cd = await fetchPricesViaClaude(chunk); Object.assign(out, cd); }
    remaining.splice(0, remaining.length, ...remaining.filter(s => !out[s]));
  }

  // 5. Groq API fallback for anything still missing
  if (remaining.length) {
    const chunks = [];
    for (let i = 0; i < remaining.length; i += 8) chunks.push(remaining.slice(i, i + 8));
    for (const chunk of chunks) { const gd = await fetchPricesViaGroq(chunk); Object.assign(out, gd); }
  }

  return out;
}

// ─── Design ───────────────────────────────────────────────────────────────────
const C = { bg:"#0C0E10", card:"#141719", cardL:"#1A1E21", border:"#252C30", navy:"#0A3D62", gold:"#D4AF37", profit:"#22C55E", loss:"#EF4444", neutral:"#64748B", white:"#F1F5F9", dim:"#94A3B8", muted:"#4A5568" };
const clr  = n => n == null ? C.neutral : n > 0 ? C.profit : n < 0 ? C.loss : C.neutral;
const sign = n => n > 0 ? "▲" : n < 0 ? "▼" : "";
const fmt  = (n, d = 2) => n == null ? "—" : n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtC = n => { if (n == null) return "—"; const a = Math.abs(n); return a >= 1e7 ? `₹${(a/1e7).toFixed(2)}Cr` : a >= 1e5 ? `₹${(a/1e5).toFixed(2)}L` : `₹${fmt(a)}`; };
const HIDDEN = "••••";
const ph = (v, p) => p ? HIDDEN : v;

const BROKERS    = ["Zerodha","Groww","Upstox","Angel One","ICICI Direct","HDFC Sky","5Paisa","Motilal Oswal","Kotak Securities","Dhan","Fyers","Custom"];
const ACC_COLORS = ["#D4AF37","#3B82F6","#22C55E","#A855F7","#F97316","#EF4444","#06B6D4","#84CC16","#F59E0B","#EC4899"];
const MF_TYPES   = ["Equity","Debt","Hybrid","Index","ELSS","Liquid","International"];
const ETF_TYPES  = ["Equity","Gold","Silver","Debt","Sectoral","International","Hybrid"];
const SECTIONS   = [{ key:"stocks", icon:"📈", label:"Stocks" }, { key:"mf", icon:"🏦", label:"Mutual Funds" }, { key:"etf", icon:"🔷", label:"ETFs" }];
const STATES     = ["Andhra Pradesh","Arunachal Pradesh","Assam","Bihar","Chhattisgarh","Goa","Gujarat","Haryana","Himachal Pradesh","Jharkhand","Karnataka","Kerala","Madhya Pradesh","Maharashtra","Manipur","Meghalaya","Mizoram","Nagaland","Odisha","Punjab","Rajasthan","Sikkim","Tamil Nadu","Telangana","Tripura","Uttar Pradesh","Uttarakhand","West Bengal","Delhi","Jammu and Kashmir","Ladakh","Puducherry","Others"];

function useIsMobile() {
  const [m, setM] = useState(window.innerWidth < 768);
  useEffect(() => { const h = () => setM(window.innerWidth < 768); window.addEventListener("resize", h); return () => window.removeEventListener("resize", h); }, []);
  return m;
}

// ─── Base UI ──────────────────────────────────────────────────────────────────
const IS = { width:"100%", background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:"10px 12px", color:C.white, fontSize:13, outline:"none", boxSizing:"border-box", fontFamily:"inherit" };
const Row = ({ label, children }) => <div style={{ marginBottom:14 }}><label style={{ color:C.muted, fontSize:10, letterSpacing:1.5, textTransform:"uppercase", display:"block", marginBottom:6 }}>{label}</label>{children}</div>;
const Inp = p => <input {...p} style={{ ...IS, ...p.style }} />;
const Sel = ({ children, ...p }) => <select {...p} style={{ ...IS, ...p.style }}>{children}</select>;
const Btn = ({ children, variant="gold", style:s, ...p }) => {
  const vs = { gold:{background:C.gold,color:C.bg}, navy:{background:C.navy,color:C.white}, ghost:{background:"transparent",border:`1px solid ${C.border}`,color:C.muted}, red:{background:"#EF444411",border:`1px solid #EF444444`,color:C.loss} };
  return <button {...p} style={{ border:"none",borderRadius:9,padding:"11px 16px",fontWeight:700,fontSize:13,cursor:p.disabled?"not-allowed":"pointer",opacity:p.disabled?.5:1,fontFamily:"inherit",...vs[variant],...s }}>{children}</button>;
};

function SearchInput({ value, onChange, results, onSelect, renderResult, placeholder }) {
  return (
    <div style={{ position:"relative" }}>
      <Inp placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} />
      {results.length > 0 && (
        <div style={{ position:"absolute",top:"calc(100% + 4px)",left:0,right:0,background:C.card,border:`1px solid ${C.gold}55`,borderRadius:10,zIndex:300,boxShadow:"0 16px 48px rgba(0,0,0,.9)",maxHeight:220,overflowY:"auto" }}>
          {results.map((item, i) => <div key={i} onClick={() => onSelect(item)} style={{ padding:"9px 13px",cursor:"pointer",borderBottom:i<results.length-1?`1px solid ${C.border}`:"none" }}>{renderResult(item)}</div>)}
        </div>
      )}
    </div>
  );
}

function Sheet({ title, subtitle, onClose, children }) {
  return (
    <div style={{ position:"fixed",inset:0,zIndex:400,display:"flex",flexDirection:"column",justifyContent:"flex-end" }}>
      <div style={{ position:"absolute",inset:0,background:"rgba(0,0,0,.75)" }} onClick={onClose} />
      <div style={{ position:"relative",background:C.card,borderRadius:"18px 18px 0 0",border:`1px solid ${C.border}`,borderBottom:"none",maxHeight:"92vh",display:"flex",flexDirection:"column" }}>
        <div style={{ flexShrink:0,padding:"14px 18px 0" }}>
          <div style={{ width:36,height:4,background:C.border,borderRadius:2,margin:"0 auto 14px" }} />
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16 }}>
            <div><div style={{ color:C.gold,fontWeight:700,fontSize:14 }}>{title}</div>{subtitle&&<div style={{ color:C.muted,fontSize:11,marginTop:2 }}>{subtitle}</div>}</div>
            <button onClick={onClose} style={{ background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:20,padding:4 }}>✕</button>
          </div>
        </div>
        <div style={{ overflowY:"auto",padding:"0 18px 40px",flex:1,WebkitOverflowScrolling:"touch" }}>{children}</div>
      </div>
    </div>
  );
}

function ModalC({ title, subtitle, onClose, children, maxWidth=460 }) {
  return (
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,.88)",backdropFilter:"blur(4px)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",padding:16 }} onClick={onClose}>
      <div style={{ background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:"22px 24px 26px",width:"100%",maxWidth,maxHeight:"90vh",overflowY:"auto",boxShadow:"0 32px 100px rgba(0,0,0,.95)" }} onClick={e=>e.stopPropagation()}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20 }}>
          <div><div style={{ color:C.gold,fontWeight:700,fontSize:14 }}>{title}</div>{subtitle&&<div style={{ color:C.muted,fontSize:11,marginTop:3 }}>{subtitle}</div>}</div>
          <button onClick={onClose} style={{ background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:20,padding:4,flexShrink:0 }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SETTINGS PANEL
// ══════════════════════════════════════════════════════════════════════════════
function SettingsPanel({ token, onClose, onLogout, isMobile }) {
  const uid = jwtUid(token);
  const [tab, setTab] = useState("profile");
  const [profile, setProfile] = useState({});
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [newPwd, setNewPwd] = useState(""); const [newPwd2, setNewPwd2] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [bioAvail, setBioAvail] = useState(false);

  useEffect(() => {
    dbGet(`/rest/v1/user_profiles?id=eq.${uid}&select=*`, token).then(r => { if (r?.[0]) setProfile(r[0]); }).catch(() => {});
    if (window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable)
      window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then(setBioAvail).catch(() => {});
  }, []);

  const saveProfile = async () => {
    setLoading(true); setMsg("");
    try { await dbUpsert("/rest/v1/user_profiles", { ...profile, id: uid, updated_at: new Date().toISOString() }, token); setMsg("✓ Profile saved!"); }
    catch (e) { setMsg("Error: " + e.message); }
    setLoading(false);
  };

  const changePassword = async () => {
    if (!newPwd || newPwd !== newPwd2) return setMsg("Passwords don't match");
    if (newPwd.length < 6) return setMsg("Min 6 characters");
    setLoading(true); setMsg("");
    try { await authPwdChange(token, newPwd); setMsg("✓ Password updated!"); setNewPwd(""); setNewPwd2(""); }
    catch (e) { setMsg("Error: " + e.message); }
    setLoading(false);
  };

  const enableBiometric = async () => {
    try {
      // Register a credential for biometric
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const cred = await navigator.credentials.create({
        publicKey: {
          challenge, rp: { name: "KOSH Portfolio", id: window.location.hostname },
          user: { id: new TextEncoder().encode(uid), name: "kosh-user", displayName: "KOSH User" },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
          timeout: 60000,
        }
      });
      if (cred) {
        const updated = { ...profile, biometric_enabled: true };
        await dbUpsert("/rest/v1/user_profiles", { ...updated, id: uid }, token);
        setProfile(updated);
        await stSet("bio_enabled", true);
        setMsg("✓ Fingerprint registered!");
      }
    } catch (e) { setMsg("Biometric setup failed: " + e.message); }
  };

  const disableBiometric = async () => {
    const updated = { ...profile, biometric_enabled: false };
    await dbUpsert("/rest/v1/user_profiles", { ...updated, id: uid }, token).catch(() => {});
    setProfile(updated);
    await stDel("bio_enabled");
    setMsg("✓ Fingerprint disabled");
  };

  const TABS = [{ k:"profile", l:"👤 Personal Details" }, { k:"security", l:"🔒 Security" }, { k:"api", l:"⚡ Broker API Keys" }];

  const Wrap = isMobile ? ({ children }) => <Sheet title="⚙ Settings" onClose={onClose}>{children}</Sheet>
                        : ({ children }) => <ModalC title="⚙ Settings" onClose={onClose} maxWidth={520}>{children}</ModalC>;

  return (
    <Wrap>
      {/* Tab bar */}
      <div style={{ display:"flex",gap:4,marginBottom:20,background:C.cardL,borderRadius:9,padding:3 }}>
        {TABS.map(t => <button key={t.k} onClick={()=>setTab(t.k)} style={{ flex:1,padding:"7px 4px",borderRadius:7,border:"none",cursor:"pointer",fontWeight:600,fontSize:11,background:tab===t.k?C.navy:"transparent",color:tab===t.k?C.white:C.muted,fontFamily:"inherit" }}>{t.l}</button>)}
      </div>

      {/* Profile tab */}
      {tab === "profile" && <>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12 }}>
          <Row label="Full Name"><Inp placeholder="Your Name" value={profile.full_name||""} onChange={e=>setProfile(p=>({...p,full_name:e.target.value}))} /></Row>
          <Row label="Phone"><Inp placeholder="9876543210" value={profile.phone||""} onChange={e=>setProfile(p=>({...p,phone:e.target.value}))} /></Row>
          <Row label="Date of Birth"><Inp type="date" value={profile.date_of_birth||""} onChange={e=>setProfile(p=>({...p,date_of_birth:e.target.value}))} /></Row>
          <Row label="PAN Number"><Inp placeholder="ABCDE1234F" value={profile.pan_number||""} onChange={e=>setProfile(p=>({...p,pan_number:e.target.value.toUpperCase()}))} /></Row>
          <Row label="City"><Inp placeholder="Ahmedabad" value={profile.city||""} onChange={e=>setProfile(p=>({...p,city:e.target.value}))} /></Row>
          <Row label="State"><Sel value={profile.state||""} onChange={e=>setProfile(p=>({...p,state:e.target.value}))}><option value="">Select State</option>{STATES.map(s=><option key={s}>{s}</option>)}</Sel></Row>
        </div>
        <Row label="Bio / About"><textarea placeholder="Brief about yourself…" value={profile.bio||""} onChange={e=>setProfile(p=>({...p,bio:e.target.value}))} style={{ ...IS,height:70,resize:"vertical" }} /></Row>
        {msg && <div style={{ color:msg.startsWith("✓")?C.profit:C.loss,fontSize:12,marginBottom:10 }}>{msg}</div>}
        <div style={{ display:"flex",gap:10,marginTop:4 }}>
          <Btn variant="ghost" style={{ flex:1 }} onClick={onClose}>Close</Btn>
          <Btn style={{ flex:2 }} onClick={saveProfile} disabled={loading}>{loading?"Saving…":"Save Profile"}</Btn>
        </div>
        <div style={{ marginTop:16,padding:"12px 14px",background:`${C.navy}22`,border:`1px solid ${C.navy}44`,borderRadius:10 }}>
          <div style={{ color:C.loss,fontSize:11,fontWeight:700,marginBottom:6 }}>Danger Zone</div>
          <button onClick={async()=>{await stDel("ks");onLogout();}} style={{ background:"#EF444411",border:`1px solid #EF444444`,borderRadius:7,padding:"8px 14px",cursor:"pointer",color:C.loss,fontSize:12,fontWeight:600,fontFamily:"inherit" }}>🚪 Logout from KOSH</button>
        </div>
      </>}

      {/* Security tab */}
      {tab === "security" && <>
        {/* Biometric */}
        <div style={{ background:C.cardL,borderRadius:12,padding:"14px 16px",marginBottom:16,border:`1px solid ${C.border}` }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8 }}>
            <div><div style={{ color:C.white,fontWeight:600,fontSize:13 }}>🫰 Fingerprint Login</div><div style={{ color:C.muted,fontSize:11,marginTop:2 }}>{bioAvail?"Device biometric available":"Not available on this device"}</div></div>
            {profile.biometric_enabled
              ? <button onClick={disableBiometric} style={{ background:`${C.loss}22`,border:`1px solid ${C.loss}44`,borderRadius:7,padding:"6px 12px",cursor:"pointer",color:C.loss,fontSize:12,fontFamily:"inherit" }}>Disable</button>
              : <button onClick={enableBiometric} disabled={!bioAvail} style={{ background:bioAvail?`${C.profit}22`:`${C.muted}11`,border:`1px solid ${bioAvail?C.profit:C.border}`,borderRadius:7,padding:"6px 12px",cursor:bioAvail?"pointer":"not-allowed",color:bioAvail?C.profit:C.muted,fontSize:12,fontFamily:"inherit" }}>Enable</button>
            }
          </div>
          {profile.biometric_enabled && <div style={{ color:C.profit,fontSize:11 }}>✓ Fingerprint login is active</div>}
        </div>

        {/* Change Password */}
        <div style={{ background:C.cardL,borderRadius:12,padding:"14px 16px",border:`1px solid ${C.border}` }}>
          <div style={{ color:C.white,fontWeight:600,fontSize:13,marginBottom:12 }}>🔑 Change Password</div>
          <Row label="New Password">
            <div style={{ position:"relative" }}>
              <Inp type={showPwd?"text":"password"} placeholder="New password" value={newPwd} onChange={e=>setNewPwd(e.target.value)} style={{ paddingRight:40 }} />
              <button onClick={()=>setShowPwd(v=>!v)} style={{ position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:14 }}>{showPwd?"🙈":"👁"}</button>
            </div>
          </Row>
          <Row label="Confirm Password"><Inp type="password" placeholder="Repeat password" value={newPwd2} onChange={e=>setNewPwd2(e.target.value)} /></Row>
          {msg && <div style={{ color:msg.startsWith("✓")?C.profit:C.loss,fontSize:12,marginBottom:8 }}>{msg}</div>}
          <Btn onClick={changePassword} disabled={loading} style={{ width:"100%" }}>{loading?"Updating…":"Update Password"}</Btn>
        </div>
      </>}

      {/* API Keys tab */}
      {tab === "api" && <>
        <div style={{ color:C.muted,fontSize:12,marginBottom:16,lineHeight:1.5 }}>Enter your broker API keys to enable live LTP fetching. Angel One SmartAPI is checked first, then Upstox, then Dhan, then Yahoo Finance.</div>
        <div style={{ background:C.cardL,borderRadius:12,padding:"14px 16px",marginBottom:14,border:`1px solid ${C.border}` }}>
          <div style={{ color:C.gold,fontWeight:700,fontSize:13,marginBottom:10 }}>🅰 Angel One SmartAPI</div>
          <Row label="API Key"><Inp placeholder="Your Angel One API Key" value={profile.angelone_api_key||""} onChange={e=>setProfile(p=>({...p,angelone_api_key:e.target.value}))} /></Row>
          <Row label="Client Code / JWT Token"><Inp placeholder="Login JWT or Client Code" value={profile.angelone_client_code||""} onChange={e=>setProfile(p=>({...p,angelone_client_code:e.target.value}))} /></Row>
          <div style={{ color:C.muted,fontSize:10,marginTop:4 }}>Get API key from marketapi.angelbroking.com → Create App</div>
        </div>
        <div style={{ background:C.cardL,borderRadius:12,padding:"14px 16px",marginBottom:14,border:`1px solid ${C.border}` }}>
          <div style={{ color:C.gold,fontWeight:700,fontSize:13,marginBottom:10 }}>⬆ Upstox API v2</div>
          <Row label="Access Token"><Inp placeholder="Upstox OAuth Access Token" value={profile.upstox_access_token||""} onChange={e=>setProfile(p=>({...p,upstox_access_token:e.target.value}))} /></Row>
          <div style={{ color:C.muted,fontSize:10,marginTop:4 }}>Get from upstox.com/developer → Login API → Access Token</div>
        </div>
        <div style={{ background:C.cardL,borderRadius:12,padding:"14px 16px",marginBottom:14,border:`1px solid ${C.border}` }}>
          <div style={{ color:C.gold,fontWeight:700,fontSize:13,marginBottom:10 }}>📊 Dhan API</div>
          <Row label="Access Token"><Inp placeholder="Dhan Access Token" value={profile.dhan_access_token||""} onChange={e=>setProfile(p=>({...p,dhan_access_token:e.target.value}))} /></Row>
          <div style={{ color:C.muted,fontSize:10,marginTop:4 }}>Get from dhan.co/developer → API Access Token</div>
        </div>
        <div style={{ background:`${C.navy}22`,border:`1px solid ${C.navy}44`,borderRadius:9,padding:"10px 14px",marginBottom:14 }}>
          <div style={{ color:C.dim,fontSize:11 }}>Without API keys, KOSH uses Yahoo Finance + Claude AI search as fallback — prices may be 15 min delayed during market hours.</div>
        </div>
        {msg && <div style={{ color:msg.startsWith("✓")?C.profit:C.loss,fontSize:12,marginBottom:8 }}>{msg}</div>}
        <Btn onClick={saveProfile} disabled={loading} style={{ width:"100%" }}>{loading?"Saving…":"Save API Keys"}</Btn>
      </>}
    </Wrap>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTH SCREEN
// ══════════════════════════════════════════════════════════════════════════════
function AuthScreen({ onAuth }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState(""); const [pass, setPass] = useState("");
  const [err, setErr] = useState(""); const [loading, setLoading] = useState(false);
  const [showP, setShowP] = useState(false);
  const [bioAvail, setBioAvail] = useState(false);
  const [bioLoading, setBioLoading] = useState(false);

  useEffect(() => {
    if (window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable)
      window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then(setBioAvail).catch(() => {});
  }, []);

  const biometricLogin = async () => {
    setBioLoading(true); setErr("");
    try {
      const result = await navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), timeout: 60000, userVerification: "required", allowCredentials: [] } }).catch(() => null);
      if (result) {
        const saved = await stGet("ks");
        if (saved?.at) { onAuth({ access_token: saved.at, refresh_token: saved.rt }); return; }
        setErr("No saved session. Sign in with email first.");
      } else { setErr("Biometric cancelled."); }
    } catch { setErr("Biometric not available."); }
    setBioLoading(false);
  };

  const submit = async () => {
    if (!email || !pass) return setErr("Fill all fields"); setErr(""); setLoading(true);
    try {
      const d = await (mode === "signup" ? authSignup : authLogin)(email, pass);
      if (mode === "signup" && !d.access_token) { setErr("Confirm your email, then sign in."); setLoading(false); return; }
      await stSet("ks", { at: d.access_token, rt: d.refresh_token });
      onAuth(d);
    } catch (e) { setErr(e.message); }
    setLoading(false);
  };

  return (
    <div style={{ background:C.bg,minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",fontFamily:"system-ui,sans-serif",padding:16 }}>
      <div style={{ width:"100%",maxWidth:360,background:C.card,borderRadius:16,border:`1px solid ${C.border}`,overflow:"hidden",boxShadow:"0 32px 80px rgba(0,0,0,.8)" }}>
        <div style={{ height:3,background:`linear-gradient(90deg,${C.navy},${C.gold},${C.navy})` }} />
        <div style={{ padding:"28px 24px 24px" }}>
          <div style={{ textAlign:"center",marginBottom:24 }}>
            <div style={{ width:52,height:52,borderRadius:14,background:C.navy,border:`1px solid ${C.gold}44`,margin:"0 auto 10px",display:"flex",alignItems:"center",justifyContent:"center",color:C.gold,fontWeight:900,fontSize:22 }}>K</div>
            <div style={{ color:C.white,fontWeight:800,fontSize:20,letterSpacing:1 }}>KOSH</div>
            <div style={{ color:C.gold,fontSize:10,letterSpacing:3,textTransform:"uppercase" }}>Portfolio Terminal</div>
          </div>

          {bioAvail && <button onClick={biometricLogin} disabled={bioLoading} style={{ width:"100%",background:`${C.navy}55`,border:`1px solid ${C.navy}`,color:C.white,borderRadius:10,padding:"12px",fontWeight:600,fontSize:14,cursor:"pointer",marginBottom:16,display:"flex",alignItems:"center",justifyContent:"center",gap:8,fontFamily:"inherit" }}>
            <span style={{ fontSize:20 }}>🫰</span> {bioLoading?"Verifying…":"Sign in with Fingerprint"}
          </button>}

          {bioAvail && <div style={{ display:"flex",gap:8,alignItems:"center",marginBottom:16 }}><div style={{ flex:1,height:1,background:C.border }} /><span style={{ color:C.muted,fontSize:11 }}>or</span><div style={{ flex:1,height:1,background:C.border }} /></div>}

          <div style={{ display:"flex",background:C.cardL,borderRadius:9,padding:3,marginBottom:18 }}>
            {["login","signup"].map(m=><button key={m} onClick={()=>{setMode(m);setErr("");}} style={{ flex:1,padding:"8px",borderRadius:7,border:"none",cursor:"pointer",fontWeight:600,fontSize:13,background:mode===m?C.navy:"transparent",color:mode===m?C.white:C.muted,fontFamily:"inherit" }}>{m==="login"?"Sign In":"Sign Up"}</button>)}
          </div>

          <label style={{ color:C.muted,fontSize:10,letterSpacing:1.5,textTransform:"uppercase",display:"block",marginBottom:6 }}>Email</label>
          <Inp type="email" value={email} onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} style={{ marginBottom:12 }} placeholder="you@email.com" />
          <label style={{ color:C.muted,fontSize:10,letterSpacing:1.5,textTransform:"uppercase",display:"block",marginBottom:6 }}>Password</label>
          <div style={{ position:"relative",marginBottom:12 }}>
            <Inp type={showP?"text":"password"} value={pass} onChange={e=>setPass(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} style={{ paddingRight:42 }} placeholder="••••••••" />
            <button onClick={()=>setShowP(v=>!v)} style={{ position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:15 }}>{showP?"🙈":"👁"}</button>
          </div>
          {err&&<div style={{ background:"#EF444422",border:"1px solid #EF444455",borderRadius:7,padding:"8px 12px",color:C.loss,fontSize:12,marginBottom:12 }}>{err}</div>}
          <button onClick={submit} disabled={loading} style={{ width:"100%",background:loading?C.border:C.gold,border:"none",color:C.bg,borderRadius:10,padding:"12px",fontWeight:800,fontSize:14,cursor:loading?"not-allowed":"pointer",fontFamily:"inherit" }}>
            {loading?"Please wait…":mode==="login"?"Sign In →":"Create Account →"}
          </button>
          <p style={{ color:C.muted,fontSize:12,textAlign:"center",marginTop:14,marginBottom:0 }}>
            {mode==="login"?"No account? ":"Have one? "}
            <span onClick={()=>{setMode(mode==="login"?"signup":"login");setErr("");}} style={{ color:C.gold,cursor:"pointer",fontWeight:700 }}>{mode==="login"?"Sign up":"Sign in"}</span>
          </p>
        </div>
      </div>
      <div style={{ color:C.muted,fontSize:10,marginTop:16,letterSpacing:2 }}>EXCLUSIVELY POWERED BY KOSH</div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// HOLDING FORMS (condensed)
// ══════════════════════════════════════════════════════════════════════════════
function StockForm({ holding, accounts, token, onSave, onClose }) {
  const uid = jwtUid(token);
  const [f, setF] = useState({ account_id:holding?.account_id??accounts[0]?.id??"", symbol:holding?.symbol??"", exchange:holding?.exchange??"NSE", qty:holding?.qty??"", avg_price:holding?.avg_price??"" });
  const [text, setText] = useState(holding?.symbol??""); const [res, setRes] = useState([]);
  const [loading, setLoading] = useState(false); const [err, setErr] = useState("");
  const timer = useRef(null); const set = (k,v) => setF(p=>({...p,[k]:v}));
  const search = q => { clearTimeout(timer.current); if(!q){setRes([]);return;} timer.current=setTimeout(async()=>{ try{setRes(await dbGet(`/rest/v1/nse_stocks?or=(symbol.ilike.*${encodeURIComponent(q)}*,company_name.ilike.*${encodeURIComponent(q)}*)&select=symbol,company_name,sector,market_cap_category&limit=8`,token)||[]);}catch{setRes([]);} },280); };
  const submit = async () => {
    if (!f.symbol||!f.qty||!f.avg_price||!f.account_id) return setErr("Fill all fields");
    setLoading(true); setErr("");
    try { if(holding) await dbPatch(`/rest/v1/holdings?id=eq.${holding.id}`,{account_id:f.account_id,symbol:f.symbol,exchange:f.exchange,qty:+f.qty,avg_price:+f.avg_price},token); else await dbPost("/rest/v1/holdings",{user_id:uid,account_id:f.account_id,symbol:f.symbol,exchange:f.exchange,qty:+f.qty,avg_price:+f.avg_price,asset_type:"stock"},token); onSave(); }
    catch(e){setErr(e.message);} setLoading(false);
  };
  return (<>
    <Row label="Account"><Sel value={f.account_id} onChange={e=>set("account_id",e.target.value)}>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</Sel></Row>
    <Row label="Exchange"><Sel value={f.exchange} onChange={e=>set("exchange",e.target.value)}><option>NSE</option><option>BSE</option></Sel></Row>
    <Row label="Symbol / Company"><SearchInput placeholder="RELIANCE, Infosys, HAL…" value={text} onChange={v=>{setText(v.toUpperCase());set("symbol",v.toUpperCase());search(v);}} results={res} onSelect={s=>{set("symbol",s.symbol);setText(s.symbol);setRes([]);}} renderResult={s=><div><span style={{color:C.gold,fontWeight:700}}>{s.symbol}</span><span style={{color:C.dim,fontSize:11,marginLeft:6}}>{s.company_name}</span><span style={{float:"right",color:C.muted,fontSize:9,background:C.cardL,borderRadius:4,padding:"1px 5px"}}>{s.market_cap_category}</span></div>} /></Row>
    <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12 }}>
      <Row label="Qty"><Inp type="number" placeholder="100" value={f.qty} onChange={e=>set("qty",e.target.value)} /></Row>
      <Row label="Avg Price (₹)"><Inp type="number" placeholder="250.50" value={f.avg_price} onChange={e=>set("avg_price",e.target.value)} /></Row>
    </div>
    {f.qty&&f.avg_price&&<div style={{ background:C.bg,borderRadius:8,padding:"10px 14px",border:`1px solid ${C.gold}33`,display:"flex",justifyContent:"space-between",marginBottom:4 }}><span style={{color:C.muted,fontSize:12}}>Invested</span><span style={{color:C.gold,fontWeight:700}}>₹{fmt(+f.qty*+f.avg_price)}</span></div>}
    {err&&<div style={{color:C.loss,fontSize:12,marginTop:8,padding:"6px 10px",background:"#EF444411",borderRadius:6}}>{err}</div>}
    <div style={{ display:"flex",gap:10,marginTop:18 }}><Btn variant="ghost" style={{flex:1}} onClick={onClose}>Cancel</Btn><Btn style={{flex:2}} onClick={submit} disabled={loading}>{loading?"Saving…":holding?"Update":"Add Stock"}</Btn></div>
  </>);
}

function MFForm({ holding, accounts, token, onSave, onClose }) {
  const uid = jwtUid(token);
  const [f, setF] = useState({ account_id:holding?.account_id??accounts[0]?.id??"", scheme_name:holding?.scheme_name??"", isin:holding?.isin??"", fund_house:holding?.fund_house??"", fund_type:holding?.fund_type??"Equity", units:holding?.units??"", avg_nav:holding?.avg_nav??"" });
  const [text, setText] = useState(holding?.scheme_name??""); const [res, setRes] = useState([]);
  const [loading, setLoading] = useState(false); const [err, setErr] = useState("");
  const timer = useRef(null); const set = (k,v)=>setF(p=>({...p,[k]:v}));
  const search = q => { clearTimeout(timer.current); if(!q||q.length<2){setRes([]);return;} timer.current=setTimeout(async()=>{ try{setRes(await dbGet(`/rest/v1/mf_schemes?or=(scheme_name.ilike.*${encodeURIComponent(q)}*,fund_house.ilike.*${encodeURIComponent(q)}*)&select=*&limit=8`,token)||[]);}catch{setRes([]);} },280); };
  const submit = async () => {
    if(!f.scheme_name||!f.units||!f.avg_nav||!f.account_id) return setErr("Fill all fields");
    setLoading(true); setErr("");
    try { if(holding) await dbPatch(`/rest/v1/mf_holdings?id=eq.${holding.id}`,{account_id:f.account_id,scheme_name:f.scheme_name,isin:f.isin,fund_house:f.fund_house,fund_type:f.fund_type,units:+f.units,avg_nav:+f.avg_nav},token); else await dbPost("/rest/v1/mf_holdings",{user_id:uid,account_id:f.account_id,scheme_name:f.scheme_name,isin:f.isin,fund_house:f.fund_house,fund_type:f.fund_type,units:+f.units,avg_nav:+f.avg_nav},token); onSave(); }
    catch(e){setErr(e.message);} setLoading(false);
  };
  return (<>
    <Row label="Account"><Sel value={f.account_id} onChange={e=>set("account_id",e.target.value)}>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</Sel></Row>
    <Row label="Fund Type"><Sel value={f.fund_type} onChange={e=>set("fund_type",e.target.value)}>{MF_TYPES.map(t=><option key={t}>{t}</option>)}</Sel></Row>
    <Row label="Scheme Name"><SearchInput placeholder="HDFC Flexi Cap, SBI Small Cap…" value={text} onChange={v=>{setText(v);set("scheme_name",v);search(v);}} results={res} onSelect={s=>{set("scheme_name",s.scheme_name);set("isin",s.isin);set("fund_house",s.fund_house);set("fund_type",s.fund_type);setText(s.scheme_name);setRes([]);}} renderResult={s=><div><div style={{color:C.white,fontWeight:600,fontSize:12}}>{s.scheme_name}</div><div style={{color:C.muted,fontSize:10,marginTop:2}}>{s.fund_house} · {s.fund_type}</div></div>} /></Row>
    <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12 }}>
      <Row label="Units"><Inp type="number" step="0.001" placeholder="50.234" value={f.units} onChange={e=>set("units",e.target.value)} /></Row>
      <Row label="Avg NAV (₹)"><Inp type="number" step="0.01" placeholder="450.00" value={f.avg_nav} onChange={e=>set("avg_nav",e.target.value)} /></Row>
    </div>
    {f.units&&f.avg_nav&&<div style={{ background:C.bg,borderRadius:8,padding:"10px 14px",border:`1px solid ${C.gold}33`,display:"flex",justifyContent:"space-between",marginBottom:4 }}><span style={{color:C.muted,fontSize:12}}>Invested</span><span style={{color:C.gold,fontWeight:700}}>₹{fmt(+f.units*+f.avg_nav)}</span></div>}
    {err&&<div style={{color:C.loss,fontSize:12,marginTop:8}}>{err}</div>}
    <div style={{ display:"flex",gap:10,marginTop:18 }}><Btn variant="ghost" style={{flex:1}} onClick={onClose}>Cancel</Btn><Btn style={{flex:2}} onClick={submit} disabled={loading}>{loading?"Saving…":holding?"Update":"Add Fund"}</Btn></div>
  </>);
}

function ETFForm({ holding, accounts, token, onSave, onClose }) {
  const uid = jwtUid(token);
  const [f, setF] = useState({ account_id:holding?.account_id??accounts[0]?.id??"", symbol:holding?.symbol??"", etf_name:holding?.etf_name??"", etf_type:holding?.etf_type??"Equity", units:holding?.units??"", avg_price:holding?.avg_price??"" });
  const [text, setText] = useState(holding?.symbol??""); const [res, setRes] = useState([]);
  const [loading, setLoading] = useState(false); const [err, setErr] = useState("");
  const timer = useRef(null); const set=(k,v)=>setF(p=>({...p,[k]:v}));
  const search = q => { clearTimeout(timer.current); if(!q){setRes([]);return;} timer.current=setTimeout(async()=>{ try{setRes(await dbGet(`/rest/v1/etf_list?or=(symbol.ilike.*${encodeURIComponent(q)}*,etf_name.ilike.*${encodeURIComponent(q)}*)&select=*&limit=8`,token)||[]);}catch{setRes([]);} },280); };
  const submit = async () => {
    if(!f.symbol||!f.units||!f.avg_price||!f.account_id) return setErr("Fill all fields");
    setLoading(true); setErr("");
    try { if(holding) await dbPatch(`/rest/v1/etf_holdings?id=eq.${holding.id}`,{account_id:f.account_id,symbol:f.symbol,etf_name:f.etf_name,etf_type:f.etf_type,units:+f.units,avg_price:+f.avg_price},token); else await dbPost("/rest/v1/etf_holdings",{user_id:uid,account_id:f.account_id,symbol:f.symbol,etf_name:f.etf_name,etf_type:f.etf_type,exchange:"NSE",units:+f.units,avg_price:+f.avg_price},token); onSave(); }
    catch(e){setErr(e.message);} setLoading(false);
  };
  return (<>
    <Row label="Account"><Sel value={f.account_id} onChange={e=>set("account_id",e.target.value)}>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</Sel></Row>
    <Row label="ETF Type"><Sel value={f.etf_type} onChange={e=>set("etf_type",e.target.value)}>{ETF_TYPES.map(t=><option key={t}>{t}</option>)}</Sel></Row>
    <Row label="ETF Symbol"><SearchInput placeholder="NIFTYBEES, GOLDBEES…" value={text} onChange={v=>{setText(v.toUpperCase());set("symbol",v.toUpperCase());search(v);}} results={res} onSelect={s=>{set("symbol",s.symbol);set("etf_name",s.etf_name);set("etf_type",s.etf_type);setText(s.symbol);setRes([]);}} renderResult={s=><div><span style={{color:C.gold,fontWeight:700}}>{s.symbol}</span><span style={{color:C.dim,fontSize:11,marginLeft:6}}>{s.etf_name}</span></div>} /></Row>
    <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12 }}>
      <Row label="Units"><Inp type="number" step="0.001" placeholder="10" value={f.units} onChange={e=>set("units",e.target.value)} /></Row>
      <Row label="Avg Price (₹)"><Inp type="number" step="0.01" placeholder="250.00" value={f.avg_price} onChange={e=>set("avg_price",e.target.value)} /></Row>
    </div>
    {f.units&&f.avg_price&&<div style={{ background:C.bg,borderRadius:8,padding:"10px 14px",border:`1px solid ${C.gold}33`,display:"flex",justifyContent:"space-between",marginBottom:4 }}><span style={{color:C.muted,fontSize:12}}>Invested</span><span style={{color:C.gold,fontWeight:700}}>₹{fmt(+f.units*+f.avg_price)}</span></div>}
    {err&&<div style={{color:C.loss,fontSize:12,marginTop:8}}>{err}</div>}
    <div style={{ display:"flex",gap:10,marginTop:18 }}><Btn variant="ghost" style={{flex:1}} onClick={onClose}>Cancel</Btn><Btn style={{flex:2}} onClick={submit} disabled={loading}>{loading?"Saving…":holding?"Update":"Add ETF"}</Btn></div>
  </>);
}

function AccForm({ account, token, onSave, onClose }) {
  const uid=jwtUid(token);
  const [name,setName]=useState(account?.name??""); const [broker,setBroker]=useState(account?.broker??"Zerodha"); const [color,setColor]=useState(account?.color??ACC_COLORS[0]);
  const [loading,setLoading]=useState(false); const [err,setErr]=useState("");
  const submit=async()=>{ if(!name.trim()) return setErr("Enter name"); setLoading(true); setErr(""); try{ if(account) await dbPatch(`/rest/v1/accounts?id=eq.${account.id}`,{name:name.trim(),broker,color},token); else await dbPost("/rest/v1/accounts",{name:name.trim(),broker,color,user_id:uid},token); onSave(); }catch(e){setErr(e.message);} setLoading(false); };
  return (<>
    <Row label="Account Name"><Inp placeholder="e.g. Zerodha Primary" value={name} onChange={e=>setName(e.target.value)} /></Row>
    <Row label="Broker"><Sel value={broker} onChange={e=>setBroker(e.target.value)}>{BROKERS.map(b=><option key={b}>{b}</option>)}</Sel></Row>
    <Row label="Color Tag"><div style={{ display:"flex",flexWrap:"wrap",gap:10,marginTop:4 }}>{ACC_COLORS.map(c=><div key={c} onClick={()=>setColor(c)} style={{ width:28,height:28,borderRadius:"50%",background:c,cursor:"pointer",border:`3px solid ${color===c?C.white:"transparent"}`,boxSizing:"border-box" }} />)}</div></Row>
    {err&&<div style={{color:C.loss,fontSize:12}}>{err}</div>}
    <div style={{ display:"flex",gap:10,marginTop:20 }}><Btn variant="ghost" style={{flex:1}} onClick={onClose}>Cancel</Btn><Btn style={{flex:2}} onClick={submit} disabled={loading}>{loading?"Saving…":account?"Update":"Add Account"}</Btn></div>
  </>);
}

function ExcelImport({ accounts, token, onDone, onClose }) {
  const uid=jwtUid(token);
  const [rows,setRows]=useState([]); const [itype,setItype]=useState("stock"); const [loading,setLoading]=useState(false); const [err,setErr]=useState("");
  const downloadTemplate=()=>{ const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([["Symbol","Account Name","Exchange","Qty","Avg Price"],["RELIANCE","Zerodha","NSE",100,2500]]),"Stocks"); XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([["Scheme Name","Account Name","Units","Avg NAV","Fund Type"],["HDFC Flexi Cap Fund - Direct Growth","Account 1",50.234,450.12,"Equity"]]),"MutualFunds"); XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([["Symbol","Account Name","ETF Name","ETF Type","Units","Avg Price"],["NIFTYBEES","Account 1","Nippon Nifty 50","Equity",10,250]]),"ETFs"); XLSX.writeFile(wb,"KOSH_Template.xlsx"); };
  const handleFile=e=>{ const file=e.target.files[0]; if(!file) return; const reader=new FileReader(); reader.onload=ev=>{ try{ const wb=XLSX.read(ev.target.result,{type:"binary"}); const sm={stock:"Stocks",mf:"MutualFunds",etf:"ETFs"}; const sheet=wb.Sheets[sm[itype]]||wb.Sheets[wb.SheetNames[0]]; const [header,...body]=XLSX.utils.sheet_to_json(sheet,{header:1}); setRows(body.filter(r=>r.length>=4).map((r,i)=>({_i:i,...Object.fromEntries(header.map((h,j)=>[h,r[j]]))}))); setErr(""); }catch(e){setErr("Parse error: "+e.message);} }; reader.readAsBinaryString(file); };
  const submit=async()=>{ if(!rows.length) return; setLoading(true); let ok=0; for(const row of rows){ const acc=accounts.find(a=>a.name.toLowerCase()===String(row["Account Name"]||"").toLowerCase())||accounts[0]; if(!acc) continue; try{ if(itype==="stock") await dbPost("/rest/v1/holdings",{user_id:uid,account_id:acc.id,symbol:String(row["Symbol"]||"").toUpperCase(),exchange:row["Exchange"]||"NSE",qty:+row["Qty"],avg_price:+row["Avg Price"],asset_type:"stock"},token); else if(itype==="mf") await dbPost("/rest/v1/mf_holdings",{user_id:uid,account_id:acc.id,scheme_name:row["Scheme Name"],fund_type:row["Fund Type"]||"Equity",units:+row["Units"],avg_nav:+row["Avg NAV"]},token); else await dbPost("/rest/v1/etf_holdings",{user_id:uid,account_id:acc.id,symbol:String(row["Symbol"]||"").toUpperCase(),etf_name:row["ETF Name"]||"",etf_type:row["ETF Type"]||"Equity",units:+row["Units"],avg_price:+row["Avg Price"]},token); ok++; }catch{} } setLoading(false); onDone(`✓ Imported ${ok} of ${rows.length}`); };
  return (<>
    <div style={{ display:"flex",background:C.cardL,borderRadius:9,padding:3,marginBottom:16 }}>
      {[["stock","📈 Stocks"],["mf","🏦 MF"],["etf","🔷 ETFs"]].map(([k,l])=><button key={k} onClick={()=>{setItype(k);setRows([]);}} style={{ flex:1,padding:"8px 4px",borderRadius:7,border:"none",cursor:"pointer",fontWeight:600,fontSize:12,background:itype===k?C.navy:"transparent",color:itype===k?C.white:C.muted,fontFamily:"inherit" }}>{l}</button>)}
    </div>
    <div style={{ background:`${C.navy}22`,border:`1px solid ${C.navy}55`,borderRadius:9,padding:"12px 14px",marginBottom:14,display:"flex",justifyContent:"space-between",alignItems:"center" }}><div><div style={{color:C.white,fontSize:12,fontWeight:600}}>Step 1: Download template</div><div style={{color:C.muted,fontSize:11}}>Fill with your holdings</div></div><button onClick={downloadTemplate} style={{ background:C.gold,border:"none",color:C.bg,borderRadius:7,padding:"7px 14px",cursor:"pointer",fontWeight:700,fontSize:12,fontFamily:"inherit" }}>↓ Template</button></div>
    <label style={{ display:"block",background:C.bg,border:`2px dashed ${C.border}`,borderRadius:9,padding:"20px 16px",textAlign:"center",cursor:"pointer",marginBottom:14 }}><input type="file" accept=".xlsx,.xls,.csv" onChange={handleFile} style={{ display:"none" }} /><div style={{fontSize:24,marginBottom:6}}>📂</div><div style={{color:C.dim,fontSize:13}}>Click to upload</div><div style={{color:C.muted,fontSize:11}}>.xlsx .xls .csv</div></label>
    {err&&<div style={{color:C.loss,fontSize:12,marginBottom:10}}>{err}</div>}
    {rows.length>0&&<div style={{ background:C.cardL,borderRadius:8,padding:"10px 12px",marginBottom:14 }}><div style={{color:C.profit,fontSize:12,fontWeight:600,marginBottom:6}}>✓ {rows.length} rows ready</div>{rows.slice(0,3).map((r,i)=><div key={i} style={{color:C.muted,fontSize:11,borderBottom:`1px solid ${C.border}`,padding:"3px 0"}}>{Object.values(r).filter((_,j)=>j>0).join(" · ")}</div>)}{rows.length>3&&<div style={{color:C.muted,fontSize:10,marginTop:4}}>+{rows.length-3} more…</div>}</div>}
    <div style={{ display:"flex",gap:10 }}><Btn variant="ghost" style={{flex:1}} onClick={onClose}>Cancel</Btn><Btn style={{flex:2}} onClick={submit} disabled={loading||!rows.length}>{loading?"Importing…":`Import ${rows.length} Rows`}</Btn></div>
  </>);
}

// ══════════════════════════════════════════════════════════════════════════════
// ROOT
// ══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [session, setSession] = useState(null); const [checking, setChecking] = useState(true);
  useEffect(() => {
    (async () => {
      const s = await stGet("ks");
      if (s?.at) {
        if (jwtExp(s.at) > Date.now() + 60000) { setSession(s); setChecking(false); return; }
        if (s.rt) { try { const r=await authRefresh(s.rt); const fresh={at:r.access_token,rt:r.refresh_token}; await stSet("ks",fresh); setSession(fresh); setChecking(false); return; } catch {} }
        setSession(s); // use expired session, API will fail gracefully
      }
      setChecking(false);
    })();
  }, []);
  if (checking) return <div style={{ background:C.bg,height:"100vh",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"system-ui",color:C.gold,letterSpacing:4,fontSize:14 }}>KOSH…</div>;
  return session ? <Main session={session} onLogout={()=>setSession(null)} /> : <AuthScreen onAuth={d=>setSession({at:d.access_token,rt:d.refresh_token})} />;
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════
function Main({ session, onLogout }) {
  const token=session.at; const isMobile=useIsMobile();
  const [accounts,setAccounts]=useState([]); const [holdings,setHoldings]=useState([]); const [mfH,setMfH]=useState([]); const [etfH,setEtfH]=useState([]);
  const [prices,setPrices]=useState({}); const [profile,setProfile]=useState({});
  const [priceStatus,setPriceStatus]=useState("idle"); const [lastUpdate,setLastUpdate]=useState(null);
  const [section,setSection]=useState("stocks"); const [activeAcc,setActiveAcc]=useState("all");
  const [privacy,setPrivacy]=useState(false); const [settingsOpen,setSettings]=useState(false);
  const [modal,setModal]=useState(null); const [editItem,setEditItem]=useState(null);
  const [hovRow,setHovRow]=useState(null); const [toast,setToast]=useState("");
  const liveRef=useRef(null);
  const marketOpen=isMarketOpen();

  const load={
    accounts:useCallback(async()=>{ try{setAccounts(await dbGet("/rest/v1/accounts?select=*&order=created_at.asc",token)||[]);}catch{} },[token]),
    holdings:useCallback(async()=>{ try{setHoldings(await dbGet("/rest/v1/holdings?select=*&order=created_at.asc",token)||[]);}catch{} },[token]),
    mf:useCallback(async()=>{ try{setMfH(await dbGet("/rest/v1/mf_holdings?select=*&order=created_at.asc",token)||[]);}catch{} },[token]),
    etf:useCallback(async()=>{ try{setEtfH(await dbGet("/rest/v1/etf_holdings?select=*&order=created_at.asc",token)||[]);}catch{} },[token]),
    profile:useCallback(async()=>{ try{const r=await dbGet(`/rest/v1/user_profiles?id=eq.${jwtUid(token)}&select=*`,token); if(r?.[0]) setProfile(r[0]);}catch{} },[token]),
  };

  const allSymbols=[...new Set([...holdings.map(h=>h.symbol),...etfH.map(h=>h.symbol)])].filter(Boolean);

  const doFetch=useCallback(async()=>{ if(!allSymbols.length) return; setPriceStatus("loading"); const data=await fetchAllPrices(allSymbols,profile); if(Object.keys(data).length){setPrices(p=>({...p,...data}));setPriceStatus("ok");setLastUpdate(new Date());}else setPriceStatus("error"); },[allSymbols.join(","),profile]);

  useEffect(()=>{ load.accounts();load.holdings();load.mf();load.etf();load.profile(); },[]);
  useEffect(()=>{ if(allSymbols.length) doFetch(); },[allSymbols.join(",")]);
  useEffect(()=>{ clearInterval(liveRef.current); if(marketOpen) liveRef.current=setInterval(doFetch,15000); return()=>clearInterval(liveRef.current); },[marketOpen,doFetch]);

  const getLtp=s=>prices[s]?.ltp??null;
  const vis=arr=>activeAcc==="all"?arr:arr.filter(h=>h.account_id===activeAcc);
  const enrich=(rows,ltpFn)=>rows.map(h=>{ const ltp=ltpFn(h),qty=h.qty??h.units,ap=h.avg_price??h.avg_nav,inv=qty*ap,cur=ltp!=null?qty*ltp:null,pnl=cur!=null?cur-inv:null,pct=pnl!=null?(pnl/inv)*100:null,pd=prices[h.symbol]; return{...h,ltp,change:pd?.change??null,changePct:pd?.pct??null,inv,cur,pnl,pct}; });

  const eS=enrich(vis(holdings),h=>getLtp(h.symbol)); const eM=enrich(vis(mfH),h=>h.current_nav??null); const eE=enrich(vis(etfH),h=>getLtp(h.symbol));
  const totals=rows=>({inv:rows.reduce((a,h)=>a+h.inv,0),cur:rows.reduce((a,h)=>a+(h.cur??h.inv),0)});
  const all=totals([...eS,...eM,...eE]); const totPnl=all.cur-all.inv; const totPct=all.inv?(totPnl/all.inv)*100:0;
  const dayPnl=[...eS,...eE].reduce((a,h)=>a+((h.change??0)*(h.qty??h.units??0)),0);
  const countOf=k=>k==="stocks"?eS.length:k==="mf"?eM.length:eE.length;

  const accSummary=accounts.map(a=>{ const sh=[...holdings,...etfH].filter(h=>h.account_id===a.id),mh=mfH.filter(h=>h.account_id===a.id); const inv=sh.reduce((x,h)=>x+(h.qty??h.units)*h.avg_price,0)+mh.reduce((x,h)=>x+h.units*h.avg_nav,0); const cur=sh.reduce((x,h)=>{const l=getLtp(h.symbol);return x+(l?(h.qty??h.units)*l:(h.qty??h.units)*h.avg_price);},0)+mh.reduce((x,h)=>x+h.units*(h.current_nav??h.avg_nav),0); return{...a,inv,cur,pnl:cur-inv,pct:inv?((cur-inv)/inv)*100:0,count:holdings.filter(h=>h.account_id===a.id).length+mfH.filter(h=>h.account_id===a.id).length+etfH.filter(h=>h.account_id===a.id).length}; });

  const openModal=(type,item=null)=>{ setEditItem(item);setModal(type); };
  const closeModal=()=>{ setModal(null);setEditItem(null); };
  const afterSave=fn=>()=>{ fn();closeModal();setTimeout(doFetch,500); };
  const showToast=msg=>{ setToast(msg);setTimeout(()=>setToast(""),3000); };
  const delH=async(id,table,loadFn)=>{ if(!window.confirm("Remove?")) return; try{await dbDelete(`/rest/v1/${table}?id=eq.${id}`,token);loadFn();}catch(e){showToast(e.message);} };
  const delAcc=async id=>{ const n=[...holdings,...mfH,...etfH].filter(h=>h.account_id===id).length; if(n) return showToast("Remove all holdings first"); try{await dbDelete(`/rest/v1/accounts?id=eq.${id}`,token);load.accounts();if(activeAcc===id)setActiveAcc("all");}catch(e){showToast(e.message);} };

  const curSection=SECTIONS.find(s=>s.key===section);
  const curRows=section==="stocks"?eS:section==="mf"?eM:eE;
  const curTable=section==="stocks"?"holdings":section==="mf"?"mf_holdings":"etf_holdings";
  const curLoad=section==="stocks"?load.holdings:section==="mf"?load.mf:load.etf;
  const cT=totals(curRows); const cPnl=cT.cur-cT.inv; const cPct=cT.inv?(cPnl/cT.inv)*100:0;
  const mktPill=<span style={{ background:marketOpen?`${C.profit}18`:`${C.muted}18`,color:marketOpen?C.profit:C.muted,borderRadius:10,padding:"3px 9px",fontSize:10,fontWeight:700,letterSpacing:0.5,flexShrink:0 }}>{marketOpen?"● LIVE":"● CLOSED"}</span>;

  // ── SIDEBAR ACCOUNT CARD — ultra compact ──────────────────────────────────
  const AccCard = ({ acc }) => {
    const isActive = activeAcc === acc.id;
    return (
      <div onMouseEnter={()=>setHovRow(`a${acc.id}`)} onMouseLeave={()=>setHovRow(null)} onClick={()=>setActiveAcc(acc.id)}
        style={{ padding:"7px 10px",cursor:"pointer",borderLeft:`3px solid ${isActive?acc.color:"transparent"}`,background:isActive?`${acc.color}18`:"transparent",borderBottom:`1px solid ${C.border}`,transition:"all .1s",position:"relative" }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
          <div style={{ color:acc.color,fontSize:11,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:95 }}>{acc.name}</div>
          <div style={{ display:"flex",gap:2,opacity:hovRow===`a${acc.id}`?1:0,transition:"opacity .15s",flexShrink:0 }}>
            <button onClick={e=>{e.stopPropagation();openModal("account",acc);}} style={{ background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:10,padding:"1px 3px" }}>✎</button>
            <button onClick={e=>{e.stopPropagation();delAcc(acc.id);}} style={{ background:"none",border:"none",color:C.loss,cursor:"pointer",fontSize:10,padding:"1px 3px" }}>✕</button>
          </div>
        </div>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:2 }}>
          <div style={{ color:C.white,fontSize:12,fontWeight:600 }}>{ph(fmtC(acc.cur),privacy)}</div>
          <div style={{ color:privacy?C.muted:clr(acc.pnl),fontSize:10,fontWeight:600 }}>{privacy?HIDDEN:`${acc.pnl>=0?"+":""}${fmt(acc.pct)}%`}</div>
        </div>
      </div>
    );
  };

  // ── DESKTOP TABLE ─────────────────────────────────────────────────────────
  const TableView = () => {
    if(curRows.length===0) return(<div style={{ display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"55%",gap:14 }}><div style={{fontSize:36}}>{curSection.icon}</div><div style={{color:C.muted}}>No {section} added yet</div><Btn onClick={()=>openModal(section)}>+ Add {curSection.label}</Btn></div>);
    const cols=section==="mf"?["Scheme","Account","Type","Units","Avg NAV","Invested","Current","P&L","Return",""]:["Symbol","Account",section==="etf"?"ETF Type":"Exch","Qty","Avg Price","LTP","Day%","Invested","Current","P&L","Return",""];
    return(
      <div style={{ background:C.card,borderRadius:12,border:`1px solid ${C.border}`,overflow:"hidden" }}>
        <div style={{ padding:"10px 14px",borderBottom:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between" }}>
          <span style={{ color:C.white,fontWeight:600,fontSize:13 }}>{curRows.length} holdings {curSection.icon}</span>
          <span style={{ color:C.muted,fontSize:12 }}>Invested: <b style={{color:C.white}}>{ph(fmtC(cT.inv),privacy)}</b></span>
        </div>
        <div style={{ overflowX:"auto" }}>
          <table style={{ width:"100%",borderCollapse:"collapse",fontSize:12 }}>
            <thead><tr style={{background:C.bg}}>{cols.map(h=><th key={h} style={{ padding:"9px 12px",textAlign:"left",color:C.muted,fontSize:9,letterSpacing:1.5,textTransform:"uppercase",borderBottom:`1px solid ${C.border}`,whiteSpace:"nowrap" }}>{h}</th>)}</tr></thead>
            <tbody>{curRows.map((h,i)=>{
              const acc=accounts.find(a=>a.id===h.account_id); const isH=hovRow===h.id;
              return(<tr key={h.id} onMouseEnter={()=>setHovRow(h.id)} onMouseLeave={()=>setHovRow(null)} style={{ borderBottom:`1px solid ${C.border}`,background:isH?`${C.navy}22`:i%2?`${C.bg}66`:"transparent" }}>
                {section==="mf"?<>
                  <td style={TD}><div style={{color:C.white,fontWeight:600,fontSize:12,maxWidth:220,whiteSpace:"normal",lineHeight:1.3}}>{h.scheme_name}</div><div style={{color:C.muted,fontSize:9}}>{h.fund_house}</div></td>
                  <td style={TD}><Dot color={acc?.color} label={acc?.name??"—"} /></td>
                  <td style={TD}><span style={{background:`${C.navy}55`,color:"#7EB4D8",padding:"1px 6px",borderRadius:4,fontSize:10}}>{h.fund_type}</span></td>
                  <td style={{...TD,color:C.white}}>{fmt(h.units,3)}</td>
                  <td style={{...TD,color:C.muted}}>₹{fmt(h.avg_nav)}</td>
                </>:<>
                  <td style={TD}><div style={{color:C.white,fontWeight:700}}>{h.symbol}</div><div style={{color:C.muted,fontSize:9}}>{section==="etf"?h.etf_name?.slice(0,18):h.exchange}</div></td>
                  <td style={TD}><Dot color={acc?.color} label={acc?.name??"—"} /></td>
                  <td style={{...TD,color:C.muted,fontSize:11}}>{section==="etf"?h.etf_type:h.exchange}</td>
                  <td style={{...TD,color:C.white,fontWeight:600}}>{fmt(h.qty??h.units,0)}</td>
                  <td style={{...TD,color:C.muted}}>₹{fmt(h.avg_price)}</td>
                  <td style={{...TD,color:h.ltp!=null?C.white:C.muted,fontWeight:700}}>{h.ltp!=null?`₹${fmt(h.ltp)}`:"—"}</td>
                  <td style={{...TD,color:clr(h.changePct),fontWeight:600}}>{h.changePct!=null?`${sign(h.changePct)} ${fmt(Math.abs(h.changePct))}%`:"—"}</td>
                </>}
                <td style={{...TD,color:C.dim}}>{ph(fmtC(h.inv),privacy)}</td>
                <td style={{...TD,color:C.white,fontWeight:600}}>{ph(h.cur!=null?fmtC(h.cur):"—",privacy)}</td>
                <td style={TD}><PnlBadge pnl={h.pnl} privacy={privacy} /></td>
                <td style={{...TD,color:privacy?C.muted:clr(h.pct),fontWeight:600}}>{privacy?HIDDEN:h.pct!=null?`${h.pct>=0?"+":""}${fmt(h.pct)}%`:"—"}</td>
                <td style={TD}><div style={{display:"flex",gap:4,opacity:isH?1:0,transition:"opacity .15s"}}><button onClick={()=>openModal(section,h)} style={editBtn}>✎</button><button onClick={()=>delH(h.id,curTable,curLoad)} style={delBtnS}>✕</button></div></td>
              </tr>);
            })}</tbody>
            <tfoot><tr style={{background:C.bg,borderTop:`2px solid ${C.gold}33`}}>
              <td colSpan={section==="mf"?4:6} style={{...TD,color:C.gold,fontWeight:700,fontSize:9,letterSpacing:2,textTransform:"uppercase"}}>TOTAL</td>
              <td style={{...TD,color:C.dim,fontWeight:600}}>{ph(fmtC(cT.inv),privacy)}</td>
              <td style={{...TD,color:C.white,fontWeight:700}}>{ph(fmtC(cT.cur),privacy)}</td>
              <td style={TD}><PnlBadge pnl={cPnl} privacy={privacy} large /></td>
              <td style={{...TD,color:privacy?C.muted:clr(cPct),fontWeight:700,fontSize:13}}>{privacy?HIDDEN:`${cPct>=0?"+":""}${fmt(cPct)}%`}</td>
              <td/>
            </tr></tfoot>
          </table>
        </div>
      </div>
    );
  };

  // ── MOBILE ─────────────────────────────────────────────────────────────────
  if(isMobile){
    return(
      <div style={{ background:C.bg,height:"100vh",fontFamily:"system-ui,sans-serif",display:"flex",flexDirection:"column",overflow:"hidden" }}>
        <div style={{ height:3,background:`linear-gradient(90deg,${C.navy},${C.gold},${C.navy})`,flexShrink:0 }} />
        <div style={{ background:C.card,padding:"10px 14px",borderBottom:`1px solid ${C.border}`,flexShrink:0 }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}>
            <div style={{ display:"flex",alignItems:"center",gap:8 }}>
              <div style={{ width:28,height:28,borderRadius:7,background:C.navy,display:"flex",alignItems:"center",justifyContent:"center",color:C.gold,fontWeight:900,fontSize:13 }}>K</div>
              <span style={{ color:C.gold,fontWeight:800,letterSpacing:1,fontSize:13 }}>KOSH</span>{mktPill}
            </div>
            <div style={{ display:"flex",gap:6 }}>
              <button onClick={()=>setPrivacy(p=>!p)} style={{ background:privacy?`${C.gold}22`:"transparent",border:`1px solid ${C.border}`,color:privacy?C.gold:C.muted,borderRadius:7,padding:"5px 8px",fontSize:14,cursor:"pointer" }}>{privacy?"🙈":"👁"}</button>
              <button onClick={()=>setSettings(true)} style={{ background:"transparent",border:`1px solid ${C.border}`,color:C.muted,borderRadius:7,padding:"5px 9px",fontSize:16,cursor:"pointer" }}>⚙</button>
            </div>
          </div>
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:8 }}>
            <div style={{ background:`${C.navy}44`,borderRadius:10,padding:"10px 12px",border:`1px solid ${C.gold}22` }}>
              <div style={{ color:C.muted,fontSize:9,letterSpacing:1.5,textTransform:"uppercase" }}>Total Value</div>
              <div style={{ color:C.gold,fontWeight:800,fontSize:19,marginTop:2 }}>{ph(fmtC(all.cur),privacy)}</div>
              <div style={{ color:privacy?C.muted:clr(totPnl),fontSize:11 }}>{privacy?HIDDEN:`${totPnl>=0?"+":""}${fmtC(totPnl)} (${totPct>=0?"+":""}${fmt(totPct)}%)`}</div>
            </div>
            <div style={{ background:C.cardL,borderRadius:10,padding:"10px 12px" }}>
              <div style={{ color:C.muted,fontSize:9,letterSpacing:1.5,textTransform:"uppercase" }}>Today's P&L</div>
              <div style={{ color:privacy?C.muted:clr(dayPnl),fontWeight:700,fontSize:17,marginTop:2 }}>{privacy?HIDDEN:`${dayPnl>=0?"+":""}${fmtC(dayPnl)}`}</div>
              <div style={{ color:C.muted,fontSize:10,marginTop:2 }}>Invested {ph(fmtC(all.inv),privacy)}</div>
            </div>
          </div>
        </div>
        <div style={{ background:C.card,display:"flex",borderBottom:`1px solid ${C.border}`,flexShrink:0 }}>
          {SECTIONS.map(s=><button key={s.key} onClick={()=>setSection(s.key)} style={{ flex:1,background:"none",border:"none",borderBottom:`2px solid ${section===s.key?C.gold:"transparent"}`,color:section===s.key?C.gold:C.muted,padding:"9px 4px",fontSize:11,fontWeight:section===s.key?700:400,cursor:"pointer",fontFamily:"inherit" }}>{s.icon} {s.label} <span style={{opacity:.6}}>({countOf(s.key)})</span></button>)}
        </div>
        <div style={{ background:C.card,display:"flex",overflowX:"auto",borderBottom:`1px solid ${C.border}`,WebkitOverflowScrolling:"touch",flexShrink:0 }}>
          {[{id:"all",name:"All",color:C.gold},...accSummary].map(a=><button key={a.id} onClick={()=>setActiveAcc(a.id)} style={{ flexShrink:0,background:"none",border:"none",borderBottom:`2px solid ${activeAcc===a.id?a.color:"transparent"}`,color:activeAcc===a.id?a.color:C.muted,padding:"7px 12px",cursor:"pointer",fontSize:10,fontWeight:activeAcc===a.id?700:400,whiteSpace:"nowrap",fontFamily:"inherit" }}>{a.name}</button>)}
          <button onClick={()=>openModal("account")} style={{ flexShrink:0,background:"none",border:"none",borderBottom:"2px solid transparent",color:C.gold,padding:"7px 12px",cursor:"pointer",fontSize:10,fontWeight:700,fontFamily:"inherit" }}>+ Acc</button>
        </div>
        <div style={{ flex:1,overflowY:"auto",padding:"10px 12px 90px",WebkitOverflowScrolling:"touch" }}>
          {curRows.length===0?(<div style={{ textAlign:"center",paddingTop:50,color:C.muted }}><div style={{fontSize:36,marginBottom:10}}>{curSection.icon}</div><div style={{marginBottom:16,fontSize:13}}>No {section} added yet</div><Btn onClick={()=>openModal(section)}>+ Add {curSection.label}</Btn></div>)
          :curRows.map(h=>{
            const acc=accounts.find(a=>a.id===h.account_id); const label=section==="mf"?(h.scheme_name?.split(" - ")[0]?.slice(0,22)+"…"):h.symbol;
            return(<div key={h.id} style={{ background:C.card,borderRadius:12,padding:"12px",border:`1px solid ${C.border}`,marginBottom:10 }}>
              <div style={{ display:"flex",justifyContent:"space-between",marginBottom:10 }}>
                <div style={{ flex:1,marginRight:8 }}><div style={{color:C.white,fontWeight:700,fontSize:14}}>{label}</div><div style={{ display:"flex",alignItems:"center",gap:5,marginTop:2 }}>{acc&&<div style={{width:6,height:6,borderRadius:"50%",background:acc.color,flexShrink:0}}/>}<span style={{color:C.muted,fontSize:10}}>{acc?.name} · {h.exchange??h.fund_type??h.etf_type}</span></div></div>
                <div style={{ textAlign:"right",flexShrink:0 }}><div style={{color:h.ltp!=null?C.white:C.muted,fontWeight:700,fontSize:15}}>{h.ltp!=null?`₹${fmt(h.ltp)}`:"—"}</div>{h.changePct!=null&&<div style={{color:clr(h.changePct),fontSize:10}}>{sign(h.changePct)} {fmt(Math.abs(h.changePct))}%</div>}</div>
              </div>
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginBottom:10 }}>
                {[{l:section==="mf"?"Units":"Qty",v:fmt(h.qty??h.units,section==="mf"?3:0),c:C.white},{l:"Invested",v:ph(fmtC(h.inv),privacy),c:C.dim},{l:"Current",v:ph(h.cur!=null?fmtC(h.cur):"—",privacy),c:C.white},{l:"P&L",v:h.pnl!=null?`${h.pnl>=0?"+":""}${ph(fmtC(Math.abs(h.pnl)),privacy)}`:"—",c:privacy?C.muted:clr(h.pnl)},{l:"Return",v:h.pct!=null?`${h.pct>=0?"+":""}${privacy?HIDDEN:fmt(h.pct)}%`:"—",c:privacy?C.muted:clr(h.pct)},{l:"Avg",v:`₹${fmt(h.avg_price??h.avg_nav)}`,c:C.muted}].map((m,i)=><div key={i} style={{background:C.cardL,borderRadius:7,padding:"6px 7px"}}><div style={{color:C.muted,fontSize:8,letterSpacing:.8,textTransform:"uppercase"}}>{m.l}</div><div style={{color:m.c,fontWeight:600,fontSize:11,marginTop:1}}>{m.v}</div></div>)}
              </div>
              <div style={{ display:"flex",gap:6,opacity:0.35 }}>
                <button onClick={()=>openModal(section,h)} style={{flex:1,background:`${C.navy}33`,border:`1px solid ${C.navy}55`,color:"#7EB4D8",borderRadius:6,padding:"5px",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>✎ Edit</button>
                <button onClick={()=>delH(h.id,curTable,curLoad)} style={{flex:1,background:`${C.loss}11`,border:`1px solid ${C.loss}33`,color:C.loss,borderRadius:6,padding:"5px",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>✕ Remove</button>
              </div>
            </div>);
          })}
        </div>
        <button onClick={()=>openModal(section)} style={{ position:"fixed",bottom:20,right:16,width:52,height:52,borderRadius:"50%",background:C.gold,border:"none",color:C.bg,fontSize:26,fontWeight:700,cursor:"pointer",boxShadow:`0 4px 20px ${C.gold}55`,zIndex:10,fontFamily:"inherit" }}>+</button>
        {toast&&<div style={{ position:"fixed",bottom:80,left:"50%",transform:"translateX(-50%)",background:C.card,border:`1px solid ${C.border}`,color:C.white,borderRadius:9,padding:"9px 18px",fontSize:13,zIndex:300,whiteSpace:"nowrap" }}>{toast}</div>}
        {settingsOpen&&<SettingsPanel token={token} onClose={()=>setSettings(false)} onLogout={onLogout} isMobile />}
        {modal==="stocks" &&<Sheet title="📈 Add Stock"       subtitle="400+ NSE stocks"  onClose={closeModal}><StockForm holding={editItem} accounts={accounts} token={token} onSave={afterSave(load.holdings)} onClose={closeModal} /></Sheet>}
        {modal==="mf"     &&<Sheet title="🏦 Add Mutual Fund" subtitle="72+ MF schemes"   onClose={closeModal}><MFForm    holding={editItem} accounts={accounts} token={token} onSave={afterSave(load.mf)}       onClose={closeModal} /></Sheet>}
        {modal==="etf"    &&<Sheet title="🔷 Add ETF"         subtitle="50+ ETFs"         onClose={closeModal}><ETFForm   holding={editItem} accounts={accounts} token={token} onSave={afterSave(load.etf)}      onClose={closeModal} /></Sheet>}
        {modal==="account"&&<Sheet title="Demat Account"                                  onClose={closeModal}><AccForm   account={editItem}  token={token}       onSave={afterSave(load.accounts)}             onClose={closeModal} /></Sheet>}
        {modal==="excel"  &&<Sheet title="📊 Import Portfolio"                            onClose={closeModal}><ExcelImport accounts={accounts} token={token} onDone={msg=>{showToast(msg);load.holdings();load.mf();load.etf();closeModal();}} onClose={closeModal} /></Sheet>}
      </div>
    );
  }

  // ── DESKTOP ───────────────────────────────────────────────────────────────
  return(
    <div style={{ background:C.bg,height:"100vh",fontFamily:"system-ui,sans-serif",display:"flex",flexDirection:"column",overflow:"hidden" }}>
      <div style={{ height:3,background:`linear-gradient(90deg,${C.navy},${C.gold},${C.navy})`,flexShrink:0 }} />
      <header style={{ background:C.card,borderBottom:`1px solid ${C.border}`,display:"flex",alignItems:"center",padding:"0 16px",minHeight:56,flexShrink:0,gap:10 }}>
        <div style={{ display:"flex",alignItems:"center",gap:8,paddingRight:12,borderRight:`1px solid ${C.border}` }}>
          <div style={{ width:28,height:28,borderRadius:8,background:C.navy,display:"flex",alignItems:"center",justifyContent:"center",color:C.gold,fontWeight:900,fontSize:13,border:`1px solid ${C.gold}33` }}>K</div>
          <div><div style={{color:C.gold,fontWeight:800,fontSize:12,letterSpacing:1}}>KOSH</div><div style={{color:C.muted,fontSize:8,letterSpacing:2}}>PORTFOLIO</div></div>
        </div>
        {mktPill}
        {[{l:"Value",v:ph(fmtC(all.cur),privacy),c:C.gold,big:true},{l:"Invested",v:ph(fmtC(all.inv),privacy),c:C.dim},{l:"P&L",v:privacy?HIDDEN:`${totPnl>=0?"+":""}${fmtC(totPnl)}`,c:privacy?C.muted:clr(totPnl)},{l:"Returns",v:privacy?HIDDEN:`${totPct>=0?"+":""}${fmt(totPct)}%`,c:privacy?C.muted:clr(totPct)},{l:"Today",v:privacy?HIDDEN:`${dayPnl>=0?"+":""}${fmtC(dayPnl)}`,c:privacy?C.muted:clr(dayPnl)}].map((m,i)=>(
          <div key={i} style={{ textAlign:"center",padding:"0 10px",borderRight:i<4?`1px solid ${C.border}`:"none" }}>
            <div style={{color:C.muted,fontSize:9,letterSpacing:1.5,textTransform:"uppercase"}}>{m.l}</div>
            <div style={{color:m.c,fontSize:m.big?16:13,fontWeight:m.big?800:600,marginTop:1}}>{m.v}</div>
          </div>
        ))}
        <div style={{ marginLeft:"auto",display:"flex",alignItems:"center",gap:6 }}>
          {lastUpdate&&<span style={{color:C.muted,fontSize:10}}>{lastUpdate.toLocaleTimeString()}</span>}
          <button onClick={()=>setPrivacy(p=>!p)} style={{ background:privacy?`${C.gold}22`:"transparent",border:`1px solid ${privacy?C.gold:C.border}`,color:privacy?C.gold:C.muted,borderRadius:7,padding:"5px 8px",fontSize:15,cursor:"pointer" }} title="Privacy Mode">{privacy?"🙈":"👁"}</button>
          <button onClick={()=>setSettings(true)} style={{ background:"transparent",border:`1px solid ${C.border}`,color:C.muted,borderRadius:7,padding:"5px 9px",fontSize:15,cursor:"pointer" }} title="Settings">⚙</button>
        </div>
      </header>
      <div style={{ display:"flex",flex:1,overflow:"hidden" }}>
        {/* ── COMPACT SIDEBAR ─────────────────────────────────── */}
        <aside style={{ width:162,background:C.card,borderRight:`1px solid ${C.border}`,display:"flex",flexDirection:"column",overflow:"hidden",flexShrink:0 }}>
          {/* All accounts */}
          <div onClick={()=>setActiveAcc("all")} style={{ padding:"8px 10px",cursor:"pointer",borderLeft:`3px solid ${activeAcc==="all"?C.gold:"transparent"}`,background:activeAcc==="all"?`${C.navy}77`:"transparent",borderBottom:`1px solid ${C.border}` }}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
              <span style={{ color:activeAcc==="all"?C.gold:C.dim,fontSize:9,fontWeight:700,letterSpacing:1 }}>ALL · {holdings.length+mfH.length+etfH.length}</span>
              <div style={{ width:5,height:5,borderRadius:"50%",background:priceStatus==="ok"?C.profit:priceStatus==="loading"?"#F59E0B":C.muted }} />
            </div>
            <div style={{ color:C.white,fontSize:13,fontWeight:700,marginTop:3 }}>{ph(fmtC(all.cur),privacy)}</div>
            <div style={{ color:privacy?C.muted:clr(totPnl),fontSize:10,marginTop:1 }}>{privacy?HIDDEN:`${totPnl>=0?"+":""}${fmt(totPct)}%`}</div>
          </div>
          <div style={{ height:1,background:C.border }} />
          <div style={{ flex:1,overflowY:"auto" }}>
            {accSummary.map(acc=><AccCard key={acc.id} acc={acc} />)}
          </div>
          <div style={{ padding:7,borderTop:`1px solid ${C.border}` }}>
            <button onClick={()=>openModal("account")} style={{ width:"100%",background:"transparent",border:`1px dashed ${C.gold}44`,color:C.gold,borderRadius:6,padding:"6px",cursor:"pointer",fontSize:10,fontWeight:600,fontFamily:"inherit" }}>+ Add Account</button>
          </div>
        </aside>
        {/* ── MAIN ─────────────────────────────────────────────── */}
        <main style={{ flex:1,overflow:"hidden",display:"flex",flexDirection:"column" }}>
          <div style={{ background:C.card,borderBottom:`1px solid ${C.border}`,display:"flex",alignItems:"center",padding:"0 16px",flexShrink:0 }}>
            {SECTIONS.map(s=><button key={s.key} onClick={()=>setSection(s.key)} style={{ background:"none",border:"none",borderBottom:`2px solid ${section===s.key?C.gold:"transparent"}`,color:section===s.key?C.gold:C.muted,padding:"11px 14px",cursor:"pointer",fontSize:12,fontWeight:section===s.key?700:400,whiteSpace:"nowrap",fontFamily:"inherit" }}>{s.icon} {s.label} <span style={{opacity:.6,fontSize:11}}>({countOf(s.key)})</span></button>)}
            <div style={{ marginLeft:"auto" }}><button onClick={()=>openModal(section)} style={{ background:C.gold,border:"none",color:C.bg,borderRadius:7,padding:"6px 14px",cursor:"pointer",fontSize:12,fontWeight:700,fontFamily:"inherit" }}>+ Add {curSection.label}</button></div>
          </div>
          <div style={{ flex:1,overflowY:"auto",padding:14 }}><TableView /></div>
          <div style={{ padding:"5px 16px",borderTop:`1px solid ${C.border}`,background:C.card,display:"flex",justifyContent:"center",alignItems:"center",gap:6,flexShrink:0 }}>
            <div style={{ width:12,height:12,borderRadius:3,background:C.navy,display:"flex",alignItems:"center",justifyContent:"center",color:C.gold,fontWeight:900,fontSize:7 }}>K</div>
            <span style={{ color:C.muted,fontSize:9,letterSpacing:2 }}>EXCLUSIVELY POWERED BY KOSH</span>
          </div>
        </main>
      </div>
      {settingsOpen&&<SettingsPanel token={token} onClose={()=>{setSettings(false);load.profile();}} onLogout={onLogout} isMobile={false} />}
      {toast&&<div style={{ position:"fixed",bottom:24,left:"50%",transform:"translateX(-50%)",background:C.card,border:`1px solid ${C.border}`,color:C.white,borderRadius:9,padding:"9px 20px",fontSize:13,zIndex:500,whiteSpace:"nowrap",boxShadow:"0 8px 32px rgba(0,0,0,.5)" }}>{toast}</div>}
      {modal==="stocks" &&<ModalC title="📈 Add Stock"       subtitle="400+ NSE stocks" onClose={closeModal}><StockForm holding={editItem} accounts={accounts} token={token} onSave={afterSave(load.holdings)} onClose={closeModal} /></ModalC>}
      {modal==="mf"     &&<ModalC title="🏦 Add Mutual Fund" subtitle="72+ MF schemes"  onClose={closeModal}><MFForm    holding={editItem} accounts={accounts} token={token} onSave={afterSave(load.mf)}       onClose={closeModal} /></ModalC>}
      {modal==="etf"    &&<ModalC title="🔷 Add ETF"         subtitle="50+ ETFs"        onClose={closeModal}><ETFForm   holding={editItem} accounts={accounts} token={token} onSave={afterSave(load.etf)}      onClose={closeModal} /></ModalC>}
      {modal==="account"&&<ModalC title="Demat Account"                                 onClose={closeModal}><AccForm   account={editItem}  token={token}       onSave={afterSave(load.accounts)}            onClose={closeModal} /></ModalC>}
      {modal==="excel"  &&<ModalC title="📊 Import Portfolio" maxWidth={500}            onClose={closeModal}><ExcelImport accounts={accounts} token={token} onDone={msg=>{showToast(msg);load.holdings();load.mf();load.etf();closeModal();}} onClose={closeModal} /></ModalC>}
    </div>
  );
}

const Dot=({color,label})=><div style={{display:"flex",alignItems:"center",gap:4}}><div style={{width:6,height:6,borderRadius:"50%",background:color??"#4A5568",flexShrink:0}}/><span style={{color:"#94A3B8",fontSize:11}}>{label}</span></div>;
const PnlBadge=({pnl,privacy,large})=>{const v=privacy?"••••":pnl!=null?`${pnl>=0?"+":""}₹${Math.abs(pnl).toLocaleString("en-IN",{maximumFractionDigits:0})}`:"—"; return <span style={{background:pnl!=null?(pnl>0?"#22C55E18":"#EF444418"):"transparent",color:privacy?"#4A5568":pnl==null?"#64748B":pnl>0?"#22C55E":"#EF4444",padding:large?"3px 10px":"2px 7px",borderRadius:5,fontWeight:700,fontSize:large?13:11}}>{v}</span>;};
const TD={padding:"10px 12px",verticalAlign:"middle",whiteSpace:"nowrap"};
const editBtn={background:"#0A3D6244",border:"1px solid #0A3D62",color:"#7EB4D8",cursor:"pointer",borderRadius:5,padding:"3px 7px",fontSize:11};
const delBtnS={background:"#EF444411",border:"1px solid #EF444444",color:"#EF4444",cursor:"pointer",borderRadius:5,padding:"3px 7px",fontSize:11};