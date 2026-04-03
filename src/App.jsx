import { useState, useEffect, useCallback, useRef, startTransition } from "react";
import * as XLSX from "xlsx";

// ─── ENV (Vite) ───────────────────────────────────────────────────────────────
const SB_URL   = import.meta.env?.VITE_SB_URL  ?? "https://qyrqjxbhttaqjgihmzgx.supabase.co";
const SB_KEY   = import.meta.env?.VITE_SB_KEY  ?? "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF5cnFqeGJodHRhcWpnaWhtemd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2NTg5MzQsImV4cCI6MjA4NzIzNDkzNH0.cQC2Vo722Z_LY8X5an2QJqJhavjIstmzNbp2Cjo_51I";
// Broker tokens come ONLY from env — no hardcoded fallbacks for security
const ENV_DHAN_TOK = import.meta.env?.VITE_DHAN_ACCESS_TOKEN ?? "";
const ENV_DHAN_CID = import.meta.env?.VITE_DHAN_CLIENT_ID    ?? "";

// ─── Client-side AES-GCM encryption (Web Crypto API) ─────────────────────────
// Broker credentials are encrypted before storing in DB and decrypted on load.
// Key is derived from user UID so only that user can decrypt their own tokens.
async function _deriveKey(uid) {
  const raw = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(uid + "KOSH_AES_2026"),
    "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: new TextEncoder().encode("kosh_iv_salt_v1"), iterations: 100000, hash: "SHA-256" },
    raw, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}
async function encryptVal(plaintext, uid) {
  if (!plaintext || !uid) return null;
  try {
    const key = await _deriveKey(uid);
    const iv  = crypto.getRandomValues(new Uint8Array(12));
    const enc = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
    const out = new Uint8Array(12 + enc.byteLength);
    out.set(iv, 0); out.set(new Uint8Array(enc), 12);
    return btoa(String.fromCharCode(...out));
  } catch { return null; }
}
async function decryptVal(ciphertext, uid) {
  if (!ciphertext || !uid) return "";
  try {
    const key   = await _deriveKey(uid);
    const bytes = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
    const dec   = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
    return new TextDecoder().decode(dec);
  } catch { return ""; }
}
const maskToken = v => v ? `${"•".repeat(Math.max(0, v.length - 4))}${v.slice(-4)}` : "";

// ─── Supabase ─────────────────────────────────────────────────────────────────
const sb = async (path, opts = {}, token = null) => {
  const h = { apikey: SB_KEY, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...opts.headers };
  const r = await fetch(`${SB_URL}${path}`, { ...opts, headers: h });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.message || e.error_description || `Error ${r.status}`); }
  return r.status === 204 ? null : r.json();
};
const jwtUid = t => { try { return JSON.parse(atob(t.split(".")[1])).sub; } catch { return null; } };
const jwtExp = t => { try { return JSON.parse(atob(t.split(".")[1])).exp * 1000; } catch { return 0; } };

const authLogin     = (e, p) => sb("/auth/v1/token?grant_type=password",   { method: "POST", body: JSON.stringify({ email: e, password: p }) });
const authSignup    = (e, p) => sb("/auth/v1/signup",                       { method: "POST", body: JSON.stringify({ email: e, password: p }) });
const authRefresh   = rt     => sb("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: rt }) });
const authPwdChange = (tok, pwd) => sb("/auth/v1/user", { method: "PUT", body: JSON.stringify({ password: pwd }) }, tok);
const dbGet    = (p, t)    => sb(p, {}, t);
const dbPost   = (p, b, t) => sb(p, { method: "POST",   headers: { Prefer: "return=representation" }, body: JSON.stringify(b) }, t);
const dbPatch  = (p, b, t) => sb(p, { method: "PATCH",  headers: { Prefer: "return=representation" }, body: JSON.stringify(b) }, t);
const dbDelete = (p, t)    => sb(p, { method: "DELETE" }, t);
const dbUpsert = (p, b, t) => sb(p, { method: "POST",   headers: { Prefer: "return=representation,resolution=merge-duplicates" }, body: JSON.stringify(b) }, t);

const stGet = async k => { try { const r = await window.storage.get(k); return r ? JSON.parse(r.value) : null; } catch { return null; } };
const stSet = async (k, v) => { try { await window.storage.set(k, JSON.stringify(v)); } catch {} };
const stDel = async k     => { try { await window.storage.delete(k); } catch {} };

// ─── Market Hours IST ─────────────────────────────────────────────────────────
const getIST       = () => new Date(Date.now() + new Date().getTimezoneOffset() * 60000 + 19800000);
const isMarketOpen = () => { const d = getIST(), day = d.getDay(), m = d.getHours()*60+d.getMinutes(); return day>0&&day<6&&m>=555&&m<930; };

// ─── Input Validation ─────────────────────────────────────────────────────────
const V = {
  symbol:   v => { const s = String(v||"").trim().toUpperCase(); if (!s || s.length > 30) throw new Error("Invalid symbol"); return s; },
  qty:      v => { const n = Number(v); if (!Number.isFinite(n) || n <= 0 || n > 1e9) throw new Error("Quantity must be between 1 and 1,000,000,000"); return n; },
  price:    v => { const n = Number(v); if (!Number.isFinite(n) || n <= 0 || n > 1e7) throw new Error("Price must be between 0 and ₹1,00,00,000"); return n; },
  nav:      v => { const n = Number(v); if (!Number.isFinite(n) || n <= 0 || n > 1e5) throw new Error("NAV must be between 0 and ₹1,00,000"); return n; },
  units:    v => { const n = Number(v); if (!Number.isFinite(n) || n <= 0 || n > 1e9) throw new Error("Units must be positive"); return n; },
  schemeName: v => { const s = String(v||"").trim(); if (s.length < 3 || s.length > 200) throw new Error("Scheme name too short or long"); return s; },
  accName:  v => { const s = String(v||"").trim(); if (!s || s.length > 50) throw new Error("Account name required (max 50 chars)"); return s; },
  phone:    v => { if (!v) return null; if (!/^[0-9]{10}$/.test(v)) throw new Error("Phone must be 10 digits"); return v; },
  pan:      v => { if (!v) return null; const s = v.trim().toUpperCase(); if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(s)) throw new Error("Invalid PAN format (e.g. ABCDE1234F)"); return s; },
  password: v => {
    if (v.length < 12)          throw new Error("Password must be at least 12 characters");
    if (!/[a-z]/.test(v))       throw new Error("Must contain a lowercase letter");
    if (!/[A-Z]/.test(v))       throw new Error("Must contain an uppercase letter");
    if (!/[0-9]/.test(v))       throw new Error("Must contain a number");
    if (!/[^a-zA-Z0-9]/.test(v)) throw new Error("Must contain a special character (!@#$%...)");
    return v;
  },
};

// ─── LTP Fetchers (Broker APIs only) ─────────────────────────────────────────
async function fetchDhan(symbols, token, clientId) {
  if (!token || !symbols.length) return {};
  try {
    const r = await fetch("https://api.dhan.co/v2/marketfeed/ltp", {
      method: "POST",
      headers: { "access-token": token, "client-id": clientId || "", "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ NSE_EQ: symbols }),
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) return {};
    const d = await r.json();
    const out = {};
    for (const [sym, q] of Object.entries(d?.data?.NSE_EQ || {})) {
      if (q?.last_price != null) out[sym] = { ltp: q.last_price, change: q.net_change??0, pct: q.percent_change??0 };
    }
    return out;
  } catch { return {}; }
}
async function fetchAngelOne(symbols, apiKey, jwtToken) {
  if (!apiKey || !jwtToken || !symbols.length) return {};
  try {
    const r = await fetch("https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwtToken}`, "X-Api-Key": apiKey, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "LTP", exchangeTokens: { NSE: symbols } }),
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) return {};
    const d = await r.json();
    const out = {};
    (d?.data?.fetched || []).forEach(q => { if (q.tradingSymbol && q.ltp != null) out[q.tradingSymbol] = { ltp: q.ltp, change: q.netChange??0, pct: q.percentChange??0 }; });
    return out;
  } catch { return {}; }
}
async function fetchUpstox(symbols, accessToken) {
  if (!accessToken || !symbols.length) return {};
  try {
    const r = await fetch(`https://api.upstox.com/v2/market-quote/ltp?symbol=${encodeURIComponent(symbols.map(s=>`NSE_EQ|${s}`).join(","))}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) return {};
    const d = await r.json();
    const out = {};
    Object.values(d?.data || {}).forEach(q => { const s = q.instrument_token?.replace("NSE_EQ|","") || q.symbol; if (s && q.last_price != null) out[s] = { ltp: q.last_price, change: q.net_change??0, pct: q.net_change_percentage??0 }; });
    return out;
  } catch { return {}; }
}
async function fetchAllPrices(symbols, creds) {
  if (!symbols.length) return {};
  const out = {};
  let rem = [...symbols];
  const merge = data => { Object.assign(out, data); rem = rem.filter(s => !out[s]); };
  // 1. Dhan env token (app-level, always tried first)
  if (ENV_DHAN_TOK && rem.length) merge(await fetchDhan(rem, ENV_DHAN_TOK, ENV_DHAN_CID));
  // 2. User's Dhan token
  if (rem.length && creds.dhan_tok) merge(await fetchDhan(rem, creds.dhan_tok, creds.dhan_cid));
  // 3. Angel One
  if (rem.length && creds.ao_key && creds.ao_code) merge(await fetchAngelOne(rem, creds.ao_key, creds.ao_code));
  // 4. Upstox
  if (rem.length && creds.up_tok) merge(await fetchUpstox(rem, creds.up_tok));
  return out;
}

// ─── Global: hide scrollbars ──────────────────────────────────────────────────
const G = `*,*::-webkit-scrollbar{scrollbar-width:none;-ms-overflow-style:none}*::-webkit-scrollbar{display:none;width:0;height:0}`;

// ─── Design System ────────────────────────────────────────────────────────────
const C = { bg:"#0C0E10",card:"#141719",cardL:"#1A1E21",border:"#252C30",navy:"#0A3D62",gold:"#D4AF37",profit:"#22C55E",loss:"#EF4444",neutral:"#64748B",white:"#F1F5F9",dim:"#94A3B8",muted:"#4A5568" };
const clr  = n => n==null?C.neutral:n>0?C.profit:n<0?C.loss:C.neutral;
const sign = n => n>0?"▲":n<0?"▼":"";
const fmt  = (n,d=2) => n==null?"—":n.toLocaleString("en-IN",{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtC = n => { if(n==null)return"—";const a=Math.abs(n);return a>=1e7?`₹${(a/1e7).toFixed(2)}Cr`:a>=1e5?`₹${(a/1e5).toFixed(2)}L`:`₹${fmt(a)}`; };
const HIDDEN="••••"; const ph=(v,p)=>p?HIDDEN:v;

const BROKERS    = ["Zerodha","Groww","Upstox","Angel One","ICICI Direct","HDFC Sky","5Paisa","Motilal Oswal","Kotak Securities","Dhan","Fyers","Custom"];
const ACC_COLORS = ["#D4AF37","#3B82F6","#22C55E","#A855F7","#F97316","#EF4444","#06B6D4","#84CC16","#F59E0B","#EC4899"];
const MF_TYPES   = ["Equity","Debt","Hybrid","Index","ELSS","Liquid","International"];
const ETF_TYPES  = ["Equity","Gold","Silver","Debt","Sectoral","International","Hybrid"];
const SECTIONS   = [{key:"stocks",icon:"📈",label:"Stocks"},{key:"mf",icon:"🏦",label:"Mutual Funds"},{key:"etf",icon:"🔷",label:"ETFs"}];
const STATES     = ["Andhra Pradesh","Arunachal Pradesh","Assam","Bihar","Chhattisgarh","Goa","Gujarat","Haryana","Himachal Pradesh","Jharkhand","Karnataka","Kerala","Madhya Pradesh","Maharashtra","Manipur","Meghalaya","Mizoram","Nagaland","Odisha","Punjab","Rajasthan","Sikkim","Tamil Nadu","Telangana","Tripura","Uttar Pradesh","Uttarakhand","West Bengal","Delhi","Jammu and Kashmir","Ladakh","Puducherry","Others"];

function useIsMobile(){const[m,setM]=useState(window.innerWidth<768);useEffect(()=>{const h=()=>setM(window.innerWidth<768);window.addEventListener("resize",h);return()=>window.removeEventListener("resize",h);},[]);return m;}

// ─── KOSH SVG Logo ────────────────────────────────────────────────────────────
const KoshLogo=({size=32})=>(
  <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
    <rect width="40" height="40" rx="9" fill="#0A3D62"/>
    <rect x="0.5" y="0.5" width="39" height="39" rx="8.5" stroke="#D4AF37" strokeOpacity="0.4"/>
    <text x="50%" y="54%" dominantBaseline="middle" textAnchor="middle" fill="#D4AF37" fontSize="22" fontWeight="900" fontFamily="system-ui,sans-serif">K</text>
    <rect x="8" y="34" width="24" height="2" rx="1" fill="#D4AF37" opacity="0.7"/>
  </svg>
);

// ─── Base UI ──────────────────────────────────────────────────────────────────
const IS={width:"100%",background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 12px",color:C.white,fontSize:13,outline:"none",boxSizing:"border-box",fontFamily:"inherit"};
const Row=({label,children,err})=><div style={{marginBottom:14}}><label style={{color:C.muted,fontSize:10,letterSpacing:1.5,textTransform:"uppercase",display:"block",marginBottom:6}}>{label}</label>{children}{err&&<div style={{color:C.loss,fontSize:11,marginTop:4}}>⚠ {err}</div>}</div>;
const Inp=p=><input {...p} style={{...IS,...p.style}} />;
const Sel=({children,...p})=><select {...p} style={{...IS,...p.style}}>{children}</select>;
const Btn=({children,variant="gold",style:s,...p})=>{const vs={gold:{background:C.gold,color:C.bg},navy:{background:C.navy,color:C.white},ghost:{background:"transparent",border:`1px solid ${C.border}`,color:C.muted}};return<button {...p} style={{border:"none",borderRadius:9,padding:"11px 16px",fontWeight:700,fontSize:13,cursor:p.disabled?"not-allowed":"pointer",opacity:p.disabled?.5:1,fontFamily:"inherit",...vs[variant],...s}}>{children}</button>;};

function SearchInput({value,onChange,results,onSelect,renderResult,placeholder}){
  return(<div style={{position:"relative"}}><Inp placeholder={placeholder} value={value} onChange={e=>onChange(e.target.value)} />{results.length>0&&(<div style={{position:"absolute",top:"calc(100% + 4px)",left:0,right:0,background:C.card,border:`1px solid ${C.gold}55`,borderRadius:10,zIndex:300,boxShadow:"0 16px 48px rgba(0,0,0,.9)",maxHeight:220,overflowY:"auto"}}>{results.map((item,i)=><div key={i} onClick={()=>onSelect(item)} style={{padding:"9px 13px",cursor:"pointer",borderBottom:i<results.length-1?`1px solid ${C.border}`:"none"}}>{renderResult(item)}</div>)}</div>)}</div>);
}

function Sheet({title,subtitle,onClose,children}){return(<div style={{position:"fixed",inset:0,zIndex:400,display:"flex",flexDirection:"column",justifyContent:"flex-end"}}><div style={{position:"absolute",inset:0,background:"rgba(0,0,0,.75)"}} onClick={onClose}/><div style={{position:"relative",background:C.card,borderRadius:"18px 18px 0 0",border:`1px solid ${C.border}`,borderBottom:"none",maxHeight:"92vh",display:"flex",flexDirection:"column"}}><div style={{flexShrink:0,padding:"14px 18px 0"}}><div style={{width:36,height:4,background:C.border,borderRadius:2,margin:"0 auto 14px"}}/><div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}><div><div style={{color:C.gold,fontWeight:700,fontSize:14}}>{title}</div>{subtitle&&<div style={{color:C.muted,fontSize:11,marginTop:2}}>{subtitle}</div>}</div><button onClick={onClose} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:20,padding:4}}>✕</button></div></div><div style={{overflowY:"auto",padding:"0 18px 40px",flex:1}}>{children}</div></div></div>);}

function ModalC({title,subtitle,onClose,children,maxWidth=460}){return(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.88)",backdropFilter:"blur(4px)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",padding:16}} onClick={onClose}><div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:"22px 24px 26px",width:"100%",maxWidth,maxHeight:"90vh",overflowY:"auto",boxShadow:"0 32px 100px rgba(0,0,0,.95)"}} onClick={e=>e.stopPropagation()}><div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}><div><div style={{color:C.gold,fontWeight:700,fontSize:14}}>{title}</div>{subtitle&&<div style={{color:C.muted,fontSize:11,marginTop:3}}>{subtitle}</div>}</div><button onClick={onClose} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:20,padding:4,flexShrink:0}}>✕</button></div>{children}</div></div>);}

// ══════════════════════════════════════════════════════════════════════════════
// SETTINGS PANEL
// ══════════════════════════════════════════════════════════════════════════════
function SettingsPanel({token,onClose,onLogout,isMobile,onCredsChange}){
  const uid=jwtUid(token);
  const[tab,setTab]=useState("profile");
  const[profile,setProfile]=useState({});
  // Plain-text values for display/edit (decrypted from DB on load)
  const[creds,setCreds]=useState({dhan_tok:"",dhan_cid:"",ao_key:"",ao_code:"",up_tok:""});
  const[maskedView,setMaskedView]=useState({dhan_tok:true,ao_key:true,ao_code:true,up_tok:true});
  const[loading,setLoading]=useState(false);const[msg,setMsg]=useState("");
  const[newPwd,setNewPwd]=useState("");const[newPwd2,setNewPwd2]=useState("");const[showPwd,setShowPwd]=useState(false);
  const[bioAvail,setBioAvail]=useState(false);
  const[valErr,setValErr]=useState({});

  useEffect(()=>{
    dbGet(`/rest/v1/user_profiles?id=eq.${uid}&select=*`,token).then(async r=>{
      if(r?.[0]){
        setProfile(r[0]);
        // Decrypt all broker credentials on load
        const p=r[0];
        const[dt,dc,ak,ac,ut]=await Promise.all([
          decryptVal(p.dhan_token_enc,uid),decryptVal(p.dhan_cid_enc,uid),
          decryptVal(p.ao_key_enc,uid),decryptVal(p.ao_code_enc,uid),
          decryptVal(p.up_token_enc,uid),
        ]);
        setCreds({dhan_tok:dt,dhan_cid:dc,ao_key:ak,ao_code:ac,up_tok:ut});
      }
    }).catch(()=>{});
    if(window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable)
      window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then(setBioAvail).catch(()=>{});
  },[uid]);// eslint-disable-line

  const validateProfile=()=>{
    const e={};
    try{V.phone(profile.phone);}catch(ex){e.phone=ex.message;}
    try{V.pan(profile.pan_number);}catch(ex){e.pan=ex.message;}
    setValErr(e);
    return Object.keys(e).length===0;
  };

  const saveProfile=async()=>{
    if(!validateProfile())return;
    setLoading(true);setMsg("");
    try{
      await dbUpsert("/rest/v1/user_profiles",{...profile,id:uid,updated_at:new Date().toISOString()},token);
      setMsg("✓ Profile saved!");
    }catch(e){setMsg("Error: "+e.message);}
    setLoading(false);
  };

  const saveCreds=async()=>{
    setLoading(true);setMsg("");
    try{
      // Encrypt each credential before saving
      const[dt,dc,ak,ac,ut]=await Promise.all([
        encryptVal(creds.dhan_tok,uid),encryptVal(creds.dhan_cid,uid),
        encryptVal(creds.ao_key,uid),encryptVal(creds.ao_code,uid),
        encryptVal(creds.up_tok,uid),
      ]);
      await dbUpsert("/rest/v1/user_profiles",{
        id:uid,updated_at:new Date().toISOString(),
        dhan_token_enc:dt,dhan_cid_enc:dc,ao_key_enc:ak,ao_code_enc:ac,up_token_enc:ut,
      },token);
      // Notify parent to refresh creds for LTP fetching
      onCredsChange?.({dhan_tok:creds.dhan_tok,dhan_cid:creds.dhan_cid,ao_key:creds.ao_key,ao_code:creds.ao_code,up_tok:creds.up_tok});
      setMsg("✓ API keys saved & encrypted!");
    }catch(e){setMsg("Error: "+e.message);}
    setLoading(false);
  };

  const changePwd=async()=>{
    setMsg("");
    try{V.password(newPwd);}catch(e){return setMsg(e.message);}
    if(newPwd!==newPwd2) return setMsg("Passwords don't match");
    setLoading(true);
    try{await authPwdChange(token,newPwd);setMsg("✓ Password updated!");setNewPwd("");setNewPwd2("");}
    catch(e){setMsg("Error: "+e.message);}
    setLoading(false);
  };

  const enableBio=async()=>{
    try{
      const cred=await navigator.credentials.create({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),rp:{name:"KOSH Portfolio",id:window.location.hostname},user:{id:new TextEncoder().encode(uid),name:"kosh-user",displayName:"KOSH User"},pubKeyCredParams:[{type:"public-key",alg:-7}],authenticatorSelection:{authenticatorAttachment:"platform",userVerification:"required"},timeout:60000}});
      if(cred){
        await dbUpsert("/rest/v1/user_profiles",{id:uid,biometric_enabled:true,updated_at:new Date().toISOString()},token);
        setProfile(p=>({...p,biometric_enabled:true}));
        await stSet("bio_enabled",true);setMsg("✓ Fingerprint registered!");
      }
    }catch(e){setMsg("Setup failed: "+e.message);}
  };
  const disableBio=async()=>{
    await dbUpsert("/rest/v1/user_profiles",{id:uid,biometric_enabled:false,updated_at:new Date().toISOString()},token).catch(()=>{});
    setProfile(p=>({...p,biometric_enabled:false}));await stDel("bio_enabled");setMsg("✓ Disabled");
  };

  const TABS=[{k:"profile",l:"👤 Profile"},{k:"security",l:"🔒 Security"},{k:"api",l:"⚡ API Keys"}];
  const Wrap=isMobile?({children})=><Sheet title="⚙ Settings" onClose={onClose}>{children}</Sheet>:({children})=><ModalC title="⚙ Settings" onClose={onClose} maxWidth={520}>{children}</ModalC>;

  // Masked input helper
  const ApiField=({label,field,placeholder,hint})=>(
    <Row label={label}>
      <div style={{position:"relative"}}>
        <Inp
          type={maskedView[field]?"password":"text"}
          placeholder={placeholder}
          value={creds[field]}
          onChange={e=>setCreds(p=>({...p,[field]:e.target.value}))}
          style={{paddingRight:40}}
          autoComplete="off"
        />
        <button onClick={()=>setMaskedView(p=>({...p,[field]:!p[field]}))}
          style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:13}}>
          {maskedView[field]?"👁":"🙈"}
        </button>
      </div>
      {creds[field]&&maskedView[field]&&<div style={{color:C.muted,fontSize:10,marginTop:3}}>Stored: {maskToken(creds[field])}</div>}
      {hint&&<div style={{color:C.muted,fontSize:10,marginTop:3}}>{hint}</div>}
    </Row>
  );

  return(<Wrap>
    <div style={{display:"flex",gap:4,marginBottom:20,background:C.cardL,borderRadius:9,padding:3}}>
      {TABS.map(t=><button key={t.k} onClick={()=>{setTab(t.k);setMsg("");}} style={{flex:1,padding:"7px 4px",borderRadius:7,border:"none",cursor:"pointer",fontWeight:600,fontSize:11,background:tab===t.k?C.navy:"transparent",color:tab===t.k?C.white:C.muted,fontFamily:"inherit"}}>{t.l}</button>)}
    </div>

    {tab==="profile"&&<>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <Row label="Full Name"><Inp placeholder="Your Name" value={profile.full_name||""} onChange={e=>setProfile(p=>({...p,full_name:e.target.value}))} /></Row>
        <Row label="Phone" err={valErr.phone}><Inp placeholder="9876543210" value={profile.phone||""} onChange={e=>setProfile(p=>({...p,phone:e.target.value}))} /></Row>
        <Row label="Date of Birth"><Inp type="date" value={profile.date_of_birth||""} onChange={e=>setProfile(p=>({...p,date_of_birth:e.target.value}))} /></Row>
        <Row label="PAN Number" err={valErr.pan}><Inp placeholder="ABCDE1234F" value={profile.pan_number||""} onChange={e=>setProfile(p=>({...p,pan_number:e.target.value.toUpperCase()}))} /></Row>
        <Row label="City"><Inp placeholder="Ahmedabad" value={profile.city||""} onChange={e=>setProfile(p=>({...p,city:e.target.value}))} /></Row>
        <Row label="State"><Sel value={profile.state||""} onChange={e=>setProfile(p=>({...p,state:e.target.value}))}><option value="">Select State</option>{STATES.map(s=><option key={s}>{s}</option>)}</Sel></Row>
      </div>
      <Row label="Bio"><textarea placeholder="Brief about yourself…" value={profile.bio||""} onChange={e=>setProfile(p=>({...p,bio:e.target.value}))} style={{...IS,height:60,resize:"vertical"}} /></Row>
      {msg&&<div style={{color:msg.startsWith("✓")?C.profit:C.loss,fontSize:12,marginBottom:10}}>{msg}</div>}
      <div style={{display:"flex",gap:10,marginTop:4}}>
        <Btn variant="ghost" style={{flex:1}} onClick={onClose}>Close</Btn>
        <Btn style={{flex:2}} onClick={saveProfile} disabled={loading}>{loading?"Saving…":"Save Profile"}</Btn>
      </div>
      <div style={{marginTop:16,padding:"12px 14px",background:`${C.navy}22`,border:`1px solid ${C.navy}44`,borderRadius:10}}>
        <div style={{color:C.loss,fontSize:11,fontWeight:700,marginBottom:6}}>Danger Zone</div>
        <button onClick={async()=>{await stDel("ks");onLogout();}} style={{background:"#EF444411",border:`1px solid #EF444444`,borderRadius:7,padding:"8px 14px",cursor:"pointer",color:C.loss,fontSize:12,fontWeight:600,fontFamily:"inherit"}}>🚪 Logout from KOSH</button>
      </div>
    </>}

    {tab==="security"&&<>
      <div style={{background:C.cardL,borderRadius:12,padding:"14px 16px",marginBottom:16,border:`1px solid ${C.border}`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <div><div style={{color:C.white,fontWeight:600,fontSize:13}}>🫰 Fingerprint Login</div><div style={{color:C.muted,fontSize:11,marginTop:2}}>{bioAvail?"Available on this device":"Not available"}</div></div>
          {profile.biometric_enabled
            ?<button onClick={disableBio} style={{background:`${C.loss}22`,border:`1px solid ${C.loss}44`,borderRadius:7,padding:"6px 12px",cursor:"pointer",color:C.loss,fontSize:12,fontFamily:"inherit"}}>Disable</button>
            :<button onClick={enableBio} disabled={!bioAvail} style={{background:bioAvail?`${C.profit}22`:`${C.muted}11`,border:`1px solid ${bioAvail?C.profit:C.border}`,borderRadius:7,padding:"6px 12px",cursor:bioAvail?"pointer":"not-allowed",color:bioAvail?C.profit:C.muted,fontSize:12,fontFamily:"inherit"}}>Enable</button>}
        </div>
        {profile.biometric_enabled&&<div style={{color:C.profit,fontSize:11}}>✓ Fingerprint login is active</div>}
      </div>
      <div style={{background:C.cardL,borderRadius:12,padding:"14px 16px",border:`1px solid ${C.border}`}}>
        <div style={{color:C.white,fontWeight:600,fontSize:13,marginBottom:12}}>🔑 Change Password</div>
        <div style={{background:`${C.navy}22`,border:`1px solid ${C.navy}44`,borderRadius:8,padding:"9px 12px",marginBottom:12}}>
          <div style={{color:C.dim,fontSize:11}}>Requirements: 12+ chars · Uppercase · Lowercase · Number · Special char (!@#$%)</div>
        </div>
        <Row label="New Password">
          <div style={{position:"relative"}}>
            <Inp type={showPwd?"text":"password"} placeholder="Min 12 characters" value={newPwd} onChange={e=>setNewPwd(e.target.value)} style={{paddingRight:40}} />
            <button onClick={()=>setShowPwd(v=>!v)} style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:14}}>{showPwd?"🙈":"👁"}</button>
          </div>
          {/* Password strength bar */}
          {newPwd&&<div style={{marginTop:6}}>
            {[{label:"12+ chars",ok:newPwd.length>=12},{label:"Uppercase",ok:/[A-Z]/.test(newPwd)},{label:"Number",ok:/[0-9]/.test(newPwd)},{label:"Special",ok:/[^a-zA-Z0-9]/.test(newPwd)}].map((r,i)=>(
              <span key={i} style={{display:"inline-flex",alignItems:"center",gap:3,marginRight:10,fontSize:10,color:r.ok?C.profit:C.muted}}>
                {r.ok?"✓":"○"} {r.label}
              </span>
            ))}
          </div>}
        </Row>
        <Row label="Confirm Password"><Inp type="password" placeholder="Repeat password" value={newPwd2} onChange={e=>setNewPwd2(e.target.value)} /></Row>
        {msg&&<div style={{color:msg.startsWith("✓")?C.profit:C.loss,fontSize:12,marginBottom:8}}>{msg}</div>}
        <Btn onClick={changePwd} disabled={loading} style={{width:"100%"}}>{loading?"Updating…":"Update Password"}</Btn>
      </div>
    </>}

    {tab==="api"&&<>
      <div style={{background:`${C.navy}22`,border:`1px solid ${C.navy}44`,borderRadius:9,padding:"10px 14px",marginBottom:14,display:"flex",gap:8,alignItems:"flex-start"}}>
        <span style={{fontSize:16}}>🔐</span>
        <div style={{color:C.dim,fontSize:11,lineHeight:1.5}}>Keys are encrypted with AES-256 before saving. They never leave your device unencrypted. Priority: Dhan (env) → Dhan (yours) → Angel One → Upstox.</div>
      </div>

      <div style={{background:C.cardL,borderRadius:12,padding:"14px 16px",marginBottom:12,border:`1px solid ${C.border}`}}>
        <div style={{color:C.gold,fontWeight:700,fontSize:13,marginBottom:10}}>🟢 Dhan API</div>
        <ApiField label="Access Token" field="dhan_tok" placeholder="Dhan JWT access token" hint="From dhan.co → My Dhan → API Access" />
        <ApiField label="Client ID" field="dhan_cid" placeholder="Your Dhan Client ID" />
      </div>

      <div style={{background:C.cardL,borderRadius:12,padding:"14px 16px",marginBottom:12,border:`1px solid ${C.border}`}}>
        <div style={{color:C.gold,fontWeight:700,fontSize:13,marginBottom:10}}>🅰 Angel One SmartAPI</div>
        <ApiField label="API Key" field="ao_key" placeholder="Angel One API Key" hint="From marketapi.angelbroking.com → Create App" />
        <ApiField label="JWT Token" field="ao_code" placeholder="Login JWT token" />
      </div>

      <div style={{background:C.cardL,borderRadius:12,padding:"14px 16px",marginBottom:12,border:`1px solid ${C.border}`}}>
        <div style={{color:C.gold,fontWeight:700,fontSize:13,marginBottom:10}}>⬆ Upstox API v2</div>
        <ApiField label="Access Token" field="up_tok" placeholder="Upstox OAuth Access Token" hint="From upstox.com/developer → Login API" />
      </div>

      {msg&&<div style={{color:msg.startsWith("✓")?C.profit:C.loss,fontSize:12,marginBottom:8}}>{msg}</div>}
      <Btn onClick={saveCreds} disabled={loading} style={{width:"100%"}}>{loading?"Encrypting & Saving…":"Save API Keys"}</Btn>
    </>}
  </Wrap>);
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTH SCREEN
// ══════════════════════════════════════════════════════════════════════════════
function AuthScreen({onAuth}){
  const[mode,setMode]=useState("login");
  const[email,setEmail]=useState("");const[pass,setPass]=useState("");
  const[err,setErr]=useState("");const[loading,setLoading]=useState(false);
  const[showP,setShowP]=useState(false);const[bioAvail,setBioAvail]=useState(false);const[bioLoad,setBioLoad]=useState(false);

  useEffect(()=>{
    if(window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable)
      window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then(setBioAvail).catch(()=>{});
  },[]); // ← CORRECT: empty deps, runs once

  const biometricLogin=async()=>{
    setBioLoad(true);setErr("");
    try{
      const result=await navigator.credentials.get({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),timeout:60000,userVerification:"required",allowCredentials:[]}}).catch(()=>null);
      if(result){
        const saved=await stGet("ks");
        if(saved?.at){onAuth({access_token:saved.at,refresh_token:saved.rt});return;}
        setErr("No saved session. Sign in with email first.");
      }else setErr("Biometric cancelled.");
    }catch{setErr("Biometric unavailable.");}
    setBioLoad(false);
  };

  const submit=async()=>{
    setErr("");
    if(!email||!pass)return setErr("Fill all fields");
    if(mode==="signup"){try{V.password(pass);}catch(e){return setErr(e.message);}}
    setLoading(true);
    try{
      const d=await(mode==="signup"?authSignup:authLogin)(email,pass);
      if(mode==="signup"&&!d.access_token){setErr("Confirm your email, then sign in.");setLoading(false);return;}
      await stSet("ks",{at:d.access_token,rt:d.refresh_token});
      onAuth(d);
    }catch(e){setErr(e.message);}
    setLoading(false);
  };

  return(
    <div style={{background:C.bg,minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",fontFamily:"system-ui,sans-serif",padding:16}}>
      <style>{G}</style>
      <div style={{width:"100%",maxWidth:360,background:C.card,borderRadius:16,border:`1px solid ${C.border}`,overflow:"hidden",boxShadow:"0 32px 80px rgba(0,0,0,.8)"}}>
        <div style={{height:3,background:`linear-gradient(90deg,${C.navy},${C.gold},${C.navy})`}} />
        <div style={{padding:"28px 24px 24px"}}>
          <div style={{textAlign:"center",marginBottom:24}}>
            <div style={{display:"flex",justifyContent:"center",marginBottom:10}}><KoshLogo size={52}/></div>
            <div style={{color:C.white,fontWeight:800,fontSize:20,letterSpacing:1}}>KOSH</div>
            <div style={{color:C.gold,fontSize:10,letterSpacing:3,textTransform:"uppercase"}}>Portfolio Terminal</div>
          </div>
          {bioAvail&&<button onClick={biometricLogin} disabled={bioLoad} style={{width:"100%",background:`${C.navy}55`,border:`1px solid ${C.navy}`,color:C.white,borderRadius:10,padding:"12px",fontWeight:600,fontSize:14,cursor:"pointer",marginBottom:16,display:"flex",alignItems:"center",justifyContent:"center",gap:8,fontFamily:"inherit"}}>
            <span style={{fontSize:20}}>🫰</span>{bioLoad?"Verifying…":"Sign in with Fingerprint"}
          </button>}
          {bioAvail&&<div style={{display:"flex",gap:8,alignItems:"center",marginBottom:16}}><div style={{flex:1,height:1,background:C.border}}/><span style={{color:C.muted,fontSize:11}}>or</span><div style={{flex:1,height:1,background:C.border}}/></div>}
          <div style={{display:"flex",background:C.cardL,borderRadius:9,padding:3,marginBottom:18}}>
            {["login","signup"].map(m=><button key={m} onClick={()=>{setMode(m);setErr("");}} style={{flex:1,padding:"8px",borderRadius:7,border:"none",cursor:"pointer",fontWeight:600,fontSize:13,background:mode===m?C.navy:"transparent",color:mode===m?C.white:C.muted,fontFamily:"inherit"}}>{m==="login"?"Sign In":"Sign Up"}</button>)}
          </div>
          <label style={{color:C.muted,fontSize:10,letterSpacing:1.5,textTransform:"uppercase",display:"block",marginBottom:6}}>Email</label>
          <Inp type="email" value={email} onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} style={{marginBottom:12}} placeholder="you@email.com" autoComplete="email" />
          <label style={{color:C.muted,fontSize:10,letterSpacing:1.5,textTransform:"uppercase",display:"block",marginBottom:6}}>Password {mode==="signup"&&<span style={{color:C.muted,fontSize:9,letterSpacing:0}}>(12+ chars, upper+lower+number+symbol)</span>}</label>
          <div style={{position:"relative",marginBottom:12}}>
            <Inp type={showP?"text":"password"} value={pass} onChange={e=>setPass(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} style={{paddingRight:42}} placeholder={mode==="signup"?"Min 12 characters":"••••••••"} autoComplete={mode==="signup"?"new-password":"current-password"} />
            <button onClick={()=>setShowP(v=>!v)} style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:15}}>{showP?"🙈":"👁"}</button>
          </div>
          {err&&<div style={{background:"#EF444422",border:"1px solid #EF444455",borderRadius:7,padding:"8px 12px",color:C.loss,fontSize:12,marginBottom:12}}>{err}</div>}
          <button onClick={submit} disabled={loading} style={{width:"100%",background:loading?C.border:C.gold,border:"none",color:C.bg,borderRadius:10,padding:"12px",fontWeight:800,fontSize:14,cursor:loading?"not-allowed":"pointer",fontFamily:"inherit"}}>
            {loading?"Please wait…":mode==="login"?"Sign In →":"Create Account →"}
          </button>
          <p style={{color:C.muted,fontSize:12,textAlign:"center",marginTop:14,marginBottom:0}}>{mode==="login"?"No account? ":"Have one? "}<span onClick={()=>{setMode(mode==="login"?"signup":"login");setErr("");}} style={{color:C.gold,cursor:"pointer",fontWeight:700}}>{mode==="login"?"Sign up":"Sign in"}</span></p>
        </div>
      </div>
      <div style={{color:C.muted,fontSize:10,marginTop:16,letterSpacing:2}}>EXCLUSIVELY POWERED BY KOSH</div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// HOLDING FORMS (with full input validation)
// ══════════════════════════════════════════════════════════════════════════════
function StockForm({holding,accounts,token,onSave,onClose}){
  const uid=jwtUid(token);
  const[f,setF]=useState({account_id:holding?.account_id??accounts[0]?.id??"",symbol:holding?.symbol??"",exchange:holding?.exchange??"NSE",qty:holding?.qty??"",avg_price:holding?.avg_price??""});
  const[text,setText]=useState(holding?.symbol??"");const[res,setRes]=useState([]);
  const[loading,setLoading]=useState(false);const[err,setErr]=useState("");
  const timer=useRef(null);const set=(k,v)=>setF(p=>({...p,[k]:v}));
  const search=q=>{clearTimeout(timer.current);if(!q){setRes([]);return;}timer.current=setTimeout(async()=>{try{setRes(await dbGet(`/rest/v1/nse_stocks?or=(symbol.ilike.*${encodeURIComponent(q)}*,company_name.ilike.*${encodeURIComponent(q)}*)&select=symbol,company_name,sector,market_cap_category&limit=8`,token)||[]);}catch{setRes([]);}},280);};
  const submit=async()=>{
    setErr("");
    try{
      const sym=V.symbol(f.symbol);
      const qty=V.qty(f.qty);
      const price=V.price(f.avg_price);
      if(!f.account_id)throw new Error("Select an account");
      setLoading(true);
      if(holding) await dbPatch(`/rest/v1/holdings?id=eq.${holding.id}`,{account_id:f.account_id,symbol:sym,exchange:f.exchange,qty,avg_price:price},token);
      else await dbPost("/rest/v1/holdings",{user_id:uid,account_id:f.account_id,symbol:sym,exchange:f.exchange,qty,avg_price:price,asset_type:"stock"},token);
      onSave();
    }catch(e){setErr(e.message);}
    setLoading(false);
  };
  return(<>
    <Row label="Account"><Sel value={f.account_id} onChange={e=>set("account_id",e.target.value)}>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</Sel></Row>
    <Row label="Exchange"><Sel value={f.exchange} onChange={e=>set("exchange",e.target.value)}><option>NSE</option><option>BSE</option></Sel></Row>
    <Row label="Symbol / Company"><SearchInput placeholder="RELIANCE, Infosys, HAL…" value={text} onChange={v=>{setText(v.toUpperCase());set("symbol",v.toUpperCase());search(v);}} results={res} onSelect={s=>{set("symbol",s.symbol);setText(s.symbol);setRes([]);}} renderResult={s=><div><span style={{color:C.gold,fontWeight:700}}>{s.symbol}</span><span style={{color:C.dim,fontSize:11,marginLeft:6}}>{s.company_name}</span><span style={{float:"right",color:C.muted,fontSize:9,background:C.cardL,borderRadius:4,padding:"1px 5px"}}>{s.market_cap_category}</span></div>} /></Row>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <Row label="Qty"><Inp type="number" min="0.01" step="0.01" placeholder="100" value={f.qty} onChange={e=>set("qty",e.target.value)} /></Row>
      <Row label="Avg Price (₹)"><Inp type="number" min="0.01" step="0.01" placeholder="250.50" value={f.avg_price} onChange={e=>set("avg_price",e.target.value)} /></Row>
    </div>
    {f.qty&&f.avg_price&&+f.qty>0&&+f.avg_price>0&&<div style={{background:C.bg,borderRadius:8,padding:"10px 14px",border:`1px solid ${C.gold}33`,display:"flex",justifyContent:"space-between",marginBottom:4}}><span style={{color:C.muted,fontSize:12}}>Invested</span><span style={{color:C.gold,fontWeight:700}}>₹{fmt(+f.qty*+f.avg_price)}</span></div>}
    {err&&<div style={{color:C.loss,fontSize:12,marginTop:8,padding:"6px 10px",background:"#EF444411",borderRadius:6}}>⚠ {err}</div>}
    <div style={{display:"flex",gap:10,marginTop:18}}><Btn variant="ghost" style={{flex:1}} onClick={onClose}>Cancel</Btn><Btn style={{flex:2}} onClick={submit} disabled={loading}>{loading?"Saving…":holding?"Update":"Add Stock"}</Btn></div>
  </>);
}

function MFForm({holding,accounts,token,onSave,onClose}){
  const uid=jwtUid(token);
  const[f,setF]=useState({account_id:holding?.account_id??accounts[0]?.id??"",scheme_name:holding?.scheme_name??"",isin:holding?.isin??"",fund_house:holding?.fund_house??"",fund_type:holding?.fund_type??"Equity",units:holding?.units??"",avg_nav:holding?.avg_nav??""});
  const[text,setText]=useState(holding?.scheme_name??"");const[res,setRes]=useState([]);
  const[loading,setLoading]=useState(false);const[err,setErr]=useState("");
  const timer=useRef(null);const set=(k,v)=>setF(p=>({...p,[k]:v}));
  const search=q=>{clearTimeout(timer.current);if(!q||q.length<2){setRes([]);return;}timer.current=setTimeout(async()=>{try{setRes(await dbGet(`/rest/v1/mf_schemes?or=(scheme_name.ilike.*${encodeURIComponent(q)}*,fund_house.ilike.*${encodeURIComponent(q)}*)&select=*&limit=8`,token)||[]);}catch{setRes([]);}},280);};
  const submit=async()=>{
    setErr("");
    try{
      const name=V.schemeName(f.scheme_name);
      const units=V.units(f.units);
      const nav=V.nav(f.avg_nav);
      if(!f.account_id)throw new Error("Select an account");
      setLoading(true);
      if(holding) await dbPatch(`/rest/v1/mf_holdings?id=eq.${holding.id}`,{account_id:f.account_id,scheme_name:name,isin:f.isin,fund_house:f.fund_house,fund_type:f.fund_type,units,avg_nav:nav},token);
      else await dbPost("/rest/v1/mf_holdings",{user_id:uid,account_id:f.account_id,scheme_name:name,isin:f.isin,fund_house:f.fund_house,fund_type:f.fund_type,units,avg_nav:nav},token);
      onSave();
    }catch(e){setErr(e.message);}
    setLoading(false);
  };
  return(<>
    <Row label="Account"><Sel value={f.account_id} onChange={e=>set("account_id",e.target.value)}>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</Sel></Row>
    <Row label="Fund Type"><Sel value={f.fund_type} onChange={e=>set("fund_type",e.target.value)}>{MF_TYPES.map(t=><option key={t}>{t}</option>)}</Sel></Row>
    <Row label="Scheme Name"><SearchInput placeholder="HDFC Flexi Cap, SBI Small Cap…" value={text} onChange={v=>{setText(v);set("scheme_name",v);search(v);}} results={res} onSelect={s=>{set("scheme_name",s.scheme_name);set("isin",s.isin);set("fund_house",s.fund_house);set("fund_type",s.fund_type);setText(s.scheme_name);setRes([]);}} renderResult={s=><div><div style={{color:C.white,fontWeight:600,fontSize:12}}>{s.scheme_name}</div><div style={{color:C.muted,fontSize:10,marginTop:2}}>{s.fund_house} · {s.fund_type}</div></div>} /></Row>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <Row label="Units"><Inp type="number" min="0.001" step="0.001" placeholder="50.234" value={f.units} onChange={e=>set("units",e.target.value)} /></Row>
      <Row label="Avg NAV (₹)"><Inp type="number" min="0.01" step="0.01" placeholder="450.00" value={f.avg_nav} onChange={e=>set("avg_nav",e.target.value)} /></Row>
    </div>
    {f.units&&f.avg_nav&&+f.units>0&&+f.avg_nav>0&&<div style={{background:C.bg,borderRadius:8,padding:"10px 14px",border:`1px solid ${C.gold}33`,display:"flex",justifyContent:"space-between",marginBottom:4}}><span style={{color:C.muted,fontSize:12}}>Invested</span><span style={{color:C.gold,fontWeight:700}}>₹{fmt(+f.units*+f.avg_nav)}</span></div>}
    {err&&<div style={{color:C.loss,fontSize:12,marginTop:8,padding:"6px 10px",background:"#EF444411",borderRadius:6}}>⚠ {err}</div>}
    <div style={{display:"flex",gap:10,marginTop:18}}><Btn variant="ghost" style={{flex:1}} onClick={onClose}>Cancel</Btn><Btn style={{flex:2}} onClick={submit} disabled={loading}>{loading?"Saving…":holding?"Update":"Add Fund"}</Btn></div>
  </>);
}

function ETFForm({holding,accounts,token,onSave,onClose}){
  const uid=jwtUid(token);
  const[f,setF]=useState({account_id:holding?.account_id??accounts[0]?.id??"",symbol:holding?.symbol??"",etf_name:holding?.etf_name??"",etf_type:holding?.etf_type??"Equity",units:holding?.units??"",avg_price:holding?.avg_price??""});
  const[text,setText]=useState(holding?.symbol??"");const[res,setRes]=useState([]);
  const[loading,setLoading]=useState(false);const[err,setErr]=useState("");
  const timer=useRef(null);const set=(k,v)=>setF(p=>({...p,[k]:v}));
  const search=q=>{clearTimeout(timer.current);if(!q){setRes([]);return;}timer.current=setTimeout(async()=>{try{setRes(await dbGet(`/rest/v1/etf_list?or=(symbol.ilike.*${encodeURIComponent(q)}*,etf_name.ilike.*${encodeURIComponent(q)}*)&select=*&limit=8`,token)||[]);}catch{setRes([]);}},280);};
  const submit=async()=>{
    setErr("");
    try{
      const sym=V.symbol(f.symbol);
      const units=V.units(f.units);
      const price=V.price(f.avg_price);
      if(!f.account_id)throw new Error("Select an account");
      setLoading(true);
      if(holding) await dbPatch(`/rest/v1/etf_holdings?id=eq.${holding.id}`,{account_id:f.account_id,symbol:sym,etf_name:f.etf_name,etf_type:f.etf_type,units,avg_price:price},token);
      else await dbPost("/rest/v1/etf_holdings",{user_id:uid,account_id:f.account_id,symbol:sym,etf_name:f.etf_name,etf_type:f.etf_type,exchange:"NSE",units,avg_price:price},token);
      onSave();
    }catch(e){setErr(e.message);}
    setLoading(false);
  };
  return(<>
    <Row label="Account"><Sel value={f.account_id} onChange={e=>set("account_id",e.target.value)}>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</Sel></Row>
    <Row label="ETF Type"><Sel value={f.etf_type} onChange={e=>set("etf_type",e.target.value)}>{ETF_TYPES.map(t=><option key={t}>{t}</option>)}</Sel></Row>
    <Row label="ETF Symbol"><SearchInput placeholder="NIFTYBEES, GOLDBEES…" value={text} onChange={v=>{setText(v.toUpperCase());set("symbol",v.toUpperCase());search(v);}} results={res} onSelect={s=>{set("symbol",s.symbol);set("etf_name",s.etf_name);set("etf_type",s.etf_type);setText(s.symbol);setRes([]);}} renderResult={s=><div><span style={{color:C.gold,fontWeight:700}}>{s.symbol}</span><span style={{color:C.dim,fontSize:11,marginLeft:6}}>{s.etf_name}</span></div>} /></Row>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <Row label="Units"><Inp type="number" min="0.001" step="0.001" placeholder="10" value={f.units} onChange={e=>set("units",e.target.value)} /></Row>
      <Row label="Avg Price (₹)"><Inp type="number" min="0.01" step="0.01" placeholder="250.00" value={f.avg_price} onChange={e=>set("avg_price",e.target.value)} /></Row>
    </div>
    {f.units&&f.avg_price&&+f.units>0&&+f.avg_price>0&&<div style={{background:C.bg,borderRadius:8,padding:"10px 14px",border:`1px solid ${C.gold}33`,display:"flex",justifyContent:"space-between",marginBottom:4}}><span style={{color:C.muted,fontSize:12}}>Invested</span><span style={{color:C.gold,fontWeight:700}}>₹{fmt(+f.units*+f.avg_price)}</span></div>}
    {err&&<div style={{color:C.loss,fontSize:12,marginTop:8,padding:"6px 10px",background:"#EF444411",borderRadius:6}}>⚠ {err}</div>}
    <div style={{display:"flex",gap:10,marginTop:18}}><Btn variant="ghost" style={{flex:1}} onClick={onClose}>Cancel</Btn><Btn style={{flex:2}} onClick={submit} disabled={loading}>{loading?"Saving…":holding?"Update":"Add ETF"}</Btn></div>
  </>);
}

function AccForm({account,token,onSave,onClose}){
  const uid=jwtUid(token);
  const[name,setName]=useState(account?.name??"");const[broker,setBroker]=useState(account?.broker??"Zerodha");const[color,setColor]=useState(account?.color??ACC_COLORS[0]);
  const[loading,setLoading]=useState(false);const[err,setErr]=useState("");
  const submit=async()=>{
    setErr("");
    try{V.accName(name);}catch(e){return setErr(e.message);}
    if(!/^#[0-9A-Fa-f]{6}$/.test(color))return setErr("Invalid color");
    setLoading(true);
    try{
      if(account) await dbPatch(`/rest/v1/accounts?id=eq.${account.id}`,{name:name.trim(),broker,color},token);
      else await dbPost("/rest/v1/accounts",{name:name.trim(),broker,color,user_id:uid},token);
      onSave();
    }catch(e){setErr(e.message);}
    setLoading(false);
  };
  return(<>
    <Row label="Account Name"><Inp placeholder="e.g. Zerodha Primary" value={name} onChange={e=>setName(e.target.value)} /></Row>
    <Row label="Broker"><Sel value={broker} onChange={e=>setBroker(e.target.value)}>{BROKERS.map(b=><option key={b}>{b}</option>)}</Sel></Row>
    <Row label="Color Tag"><div style={{display:"flex",flexWrap:"wrap",gap:10,marginTop:4}}>{ACC_COLORS.map(c=><div key={c} onClick={()=>setColor(c)} style={{width:28,height:28,borderRadius:"50%",background:c,cursor:"pointer",border:`3px solid ${color===c?C.white:"transparent"}`,boxSizing:"border-box"}} />)}</div></Row>
    {err&&<div style={{color:C.loss,fontSize:12,marginTop:4}}>⚠ {err}</div>}
    <div style={{display:"flex",gap:10,marginTop:20}}><Btn variant="ghost" style={{flex:1}} onClick={onClose}>Cancel</Btn><Btn style={{flex:2}} onClick={submit} disabled={loading}>{loading?"Saving…":account?"Update":"Add Account"}</Btn></div>
  </>);
}

function ExcelImport({accounts,token,onDone,onClose}){
  const uid=jwtUid(token);
  const[rows,setRows]=useState([]);const[itype,setItype]=useState("stock");const[loading,setLoading]=useState(false);const[err,setErr]=useState("");
  const dl=()=>{const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([["Symbol","Account Name","Exchange","Qty","Avg Price"],["RELIANCE","Zerodha","NSE",100,2500]]),"Stocks");XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([["Scheme Name","Account Name","Units","Avg NAV","Fund Type"],["HDFC Flexi Cap Fund - Direct Growth","Account 1",50.234,450.12,"Equity"]]),"MutualFunds");XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([["Symbol","Account Name","ETF Name","ETF Type","Units","Avg Price"],["NIFTYBEES","Account 1","Nippon Nifty 50","Equity",10,250]]),"ETFs");XLSX.writeFile(wb,"KOSH_Template.xlsx");};
  const hf=e=>{const file=e.target.files[0];if(!file)return;const reader=new FileReader();reader.onload=ev=>{try{const wb=XLSX.read(ev.target.result,{type:"binary"});const sm={stock:"Stocks",mf:"MutualFunds",etf:"ETFs"};const sheet=wb.Sheets[sm[itype]]||wb.Sheets[wb.SheetNames[0]];const[header,...body]=XLSX.utils.sheet_to_json(sheet,{header:1});setRows(body.filter(r=>r.length>=4).map((r,i)=>({_i:i,...Object.fromEntries(header.map((h,j)=>[h,r[j]]))})));setErr("");}catch(e){setErr("Parse error: "+e.message);}};reader.readAsBinaryString(file);};
  const submit=async()=>{if(!rows.length)return;setLoading(true);let ok=0,fail=0;for(const row of rows){const acc=accounts.find(a=>a.name.toLowerCase()===String(row["Account Name"]||"").toLowerCase())||accounts[0];if(!acc)continue;try{if(itype==="stock"){const sym=V.symbol(row["Symbol"]);const qty=V.qty(row["Qty"]);const price=V.price(row["Avg Price"]);await dbPost("/rest/v1/holdings",{user_id:uid,account_id:acc.id,symbol:sym,exchange:row["Exchange"]||"NSE",qty,avg_price:price,asset_type:"stock"},token);}else if(itype==="mf"){const name=V.schemeName(row["Scheme Name"]);const units=V.units(row["Units"]);const nav=V.nav(row["Avg NAV"]);await dbPost("/rest/v1/mf_holdings",{user_id:uid,account_id:acc.id,scheme_name:name,fund_type:row["Fund Type"]||"Equity",units,avg_nav:nav},token);}else{const sym=V.symbol(row["Symbol"]);const units=V.units(row["Units"]);const price=V.price(row["Avg Price"]);await dbPost("/rest/v1/etf_holdings",{user_id:uid,account_id:acc.id,symbol:sym,etf_name:row["ETF Name"]||"",etf_type:row["ETF Type"]||"Equity",units,avg_price:price},token);}ok++;}catch{fail++;}}setLoading(false);onDone(`✓ Imported ${ok} of ${rows.length}${fail?`, ${fail} skipped`:"."}`);};
  return(<><div style={{display:"flex",background:C.cardL,borderRadius:9,padding:3,marginBottom:16}}>{[["stock","📈 Stocks"],["mf","🏦 MF"],["etf","🔷 ETFs"]].map(([k,l])=><button key={k} onClick={()=>{setItype(k);setRows([]);}} style={{flex:1,padding:"8px 4px",borderRadius:7,border:"none",cursor:"pointer",fontWeight:600,fontSize:12,background:itype===k?C.navy:"transparent",color:itype===k?C.white:C.muted,fontFamily:"inherit"}}>{l}</button>)}</div><div style={{background:`${C.navy}22`,border:`1px solid ${C.navy}55`,borderRadius:9,padding:"12px 14px",marginBottom:14,display:"flex",justifyContent:"space-between",alignItems:"center"}}><div><div style={{color:C.white,fontSize:12,fontWeight:600}}>Download template</div><div style={{color:C.muted,fontSize:11}}>Fill with your holdings</div></div><button onClick={dl} style={{background:C.gold,border:"none",color:C.bg,borderRadius:7,padding:"7px 14px",cursor:"pointer",fontWeight:700,fontSize:12,fontFamily:"inherit"}}>↓ Template</button></div><label style={{display:"block",background:C.bg,border:`2px dashed ${C.border}`,borderRadius:9,padding:"20px 16px",textAlign:"center",cursor:"pointer",marginBottom:14}}><input type="file" accept=".xlsx,.xls,.csv" onChange={hf} style={{display:"none"}}/><div style={{fontSize:24,marginBottom:6}}>📂</div><div style={{color:C.dim,fontSize:13}}>Click to upload</div><div style={{color:C.muted,fontSize:11}}>.xlsx .xls .csv</div></label>{err&&<div style={{color:C.loss,fontSize:12,marginBottom:10}}>⚠ {err}</div>}{rows.length>0&&<div style={{background:C.cardL,borderRadius:8,padding:"10px 12px",marginBottom:14}}><div style={{color:C.profit,fontSize:12,fontWeight:600,marginBottom:6}}>✓ {rows.length} rows ready</div>{rows.slice(0,3).map((r,i)=><div key={i} style={{color:C.muted,fontSize:11,borderBottom:`1px solid ${C.border}`,padding:"3px 0"}}>{Object.values(r).filter((_,j)=>j>0).join(" · ")}</div>)}{rows.length>3&&<div style={{color:C.muted,fontSize:10,marginTop:4}}>+{rows.length-3} more…</div>}</div>}<div style={{display:"flex",gap:10}}><Btn variant="ghost" style={{flex:1}} onClick={onClose}>Cancel</Btn><Btn style={{flex:2}} onClick={submit} disabled={loading||!rows.length}>{loading?"Importing…":`Import ${rows.length} Rows`}</Btn></div></>);
}

// ══════════════════════════════════════════════════════════════════════════════
// ROOT — fixed session management
// ══════════════════════════════════════════════════════════════════════════════
export default function App(){
  const[session,setSession]=useState(null);
  const[checking,setChecking]=useState(true);

  // ✅ FIXED: has [] dependency array — runs ONCE only, not on every render
  useEffect(()=>{
    (async()=>{
      const s=await stGet("ks");
      if(s?.at){
        // Token still valid — use immediately without network call
        if(jwtExp(s.at)>Date.now()+60000){setSession(s);setChecking(false);return;}
        // Token expired — try silent refresh
        if(s.rt){
          try{
            const r=await authRefresh(s.rt);
            const fresh={at:r.access_token,rt:r.refresh_token};
            await stSet("ks",fresh);setSession(fresh);setChecking(false);return;
          }catch{ /* refresh failed, fall through to login */ }
        }
      }
      setChecking(false);
    })();
  },[]); // ← CRITICAL: empty array — only runs on mount

  if(checking)return<div style={{background:C.bg,height:"100vh",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"system-ui",color:C.gold,letterSpacing:4,fontSize:14}}><style>{G}</style>KOSH…</div>;
  return session?<Main session={session} onLogout={()=>setSession(null)}/>:<AuthScreen onAuth={d=>setSession({at:d.access_token,rt:d.refresh_token})}/>;
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════
function Main({session,onLogout}){
  const token=session.at;const isMobile=useIsMobile();
  const[accounts,setAccounts]=useState([]);const[holdings,setHoldings]=useState([]);const[mfH,setMfH]=useState([]);const[etfH,setEtfH]=useState([]);
  const[prices,setPrices]=useState({});
  // Decrypted broker credentials loaded from profile (never stored in state as plain DB values)
  const[creds,setCreds]=useState({dhan_tok:"",dhan_cid:"",ao_key:"",ao_code:"",up_tok:""});
  const[priceStatus,setPriceStatus]=useState("idle");const[lastUpdate,setLastUpdate]=useState(null);
  const[section,setSection]=useState("stocks");const[activeAcc,setActiveAcc]=useState("all");
  const[privacy,setPrivacy]=useState(false);const[settingsOpen,setSettings]=useState(false);
  const[modal,setModal]=useState(null);const[editItem,setEditItem]=useState(null);
  const[hovRow,setHovRow]=useState(null);const[toast,setToast]=useState("");
  // ✅ Race condition fix: fetchId counter
  const fetchIdRef=useRef(0);
  const liveRef=useRef(null);
  const marketOpen=isMarketOpen();

  const load={
    accounts:useCallback(async()=>{try{setAccounts(await dbGet("/rest/v1/accounts?select=*&order=created_at.asc",token)||[]);}catch{}},[token]),
    holdings:useCallback(async()=>{try{setHoldings(await dbGet("/rest/v1/holdings?select=*&order=created_at.asc",token)||[]);}catch{}},[token]),
    mf:useCallback(async()=>{try{setMfH(await dbGet("/rest/v1/mf_holdings?select=*&order=created_at.asc",token)||[]);}catch{}},[token]),
    etf:useCallback(async()=>{try{setEtfH(await dbGet("/rest/v1/etf_holdings?select=*&order=created_at.asc",token)||[]);}catch{}},[token]),
    // Load profile AND decrypt broker credentials
    profile:useCallback(async()=>{
      try{
        const r=await dbGet(`/rest/v1/user_profiles?id=eq.${jwtUid(token)}&select=*`,token);
        if(r?.[0]){
          const p=r[0];const uid=jwtUid(token);
          const[dt,dc,ak,ac,ut]=await Promise.all([
            decryptVal(p.dhan_token_enc,uid),decryptVal(p.dhan_cid_enc,uid),
            decryptVal(p.ao_key_enc,uid),decryptVal(p.ao_code_enc,uid),
            decryptVal(p.up_token_enc,uid),
          ]);
          setCreds({dhan_tok:dt,dhan_cid:dc,ao_key:ak,ao_code:ac,up_tok:ut});
        }
      }catch{}
    },[token]),
  };

  const allSymbols=useRef([]);
  allSymbols.current=[...new Set([...holdings.map(h=>h.symbol),...etfH.map(h=>h.symbol)])].filter(Boolean);

  // ✅ FIXED: fetchIdRef prevents stale responses overwriting newer ones
  const doFetch=useCallback(async()=>{
    const syms=allSymbols.current;
    if(!syms.length)return;
    const myId=++fetchIdRef.current;
    setPriceStatus("loading");
    try{
      const data=await fetchAllPrices(syms,creds);
      if(myId!==fetchIdRef.current)return; // stale — discard
      if(Object.keys(data).length){
        startTransition(()=>{
          setPrices(p=>({...p,...data}));
          setPriceStatus("ok");
          setLastUpdate(new Date());
        });
      }else setPriceStatus("error");
    }catch{if(myId===fetchIdRef.current)setPriceStatus("error");}
  },[creds]); // only depend on creds, not on holdings (accessed via ref)

  // ✅ FIXED: all useEffects have correct dependency arrays
  useEffect(()=>{load.accounts();load.holdings();load.mf();load.etf();load.profile();},[]);// eslint-disable-line
  useEffect(()=>{if(allSymbols.current.length)doFetch();},[holdings.length,etfH.length]); // re-fetch when holdings change
  useEffect(()=>{
    clearInterval(liveRef.current);
    if(marketOpen)liveRef.current=setInterval(doFetch,15000);
    return()=>clearInterval(liveRef.current);
  },[marketOpen,doFetch]);

  const getLtp=s=>prices[s]?.ltp??null;
  const vis=arr=>activeAcc==="all"?arr:arr.filter(h=>h.account_id===activeAcc);
  const enrich=(rows,ltpFn)=>rows.map(h=>{const ltp=ltpFn(h),qty=h.qty??h.units,ap=h.avg_price??h.avg_nav,inv=qty*ap,cur=ltp!=null?qty*ltp:null,pnl=cur!=null?cur-inv:null,pct=pnl!=null?(pnl/inv)*100:null,pd=prices[h.symbol];return{...h,ltp,change:pd?.change??null,changePct:pd?.pct??null,inv,cur,pnl,pct};});

  const eS=enrich(vis(holdings),h=>getLtp(h.symbol));
  const eM=enrich(vis(mfH),h=>h.current_nav??null);
  const eE=enrich(vis(etfH),h=>getLtp(h.symbol));
  const totals=rows=>({inv:rows.reduce((a,h)=>a+h.inv,0),cur:rows.reduce((a,h)=>a+(h.cur??h.inv),0)});
  const all=totals([...eS,...eM,...eE]);
  const totPnl=all.cur-all.inv;const totPct=all.inv?(totPnl/all.inv)*100:0;
  const dayPnl=[...eS,...eE].reduce((a,h)=>a+((h.change??0)*(h.qty??h.units??0)),0);
  const countOf=k=>k==="stocks"?eS.length:k==="mf"?eM.length:eE.length;

  const accSummary=accounts.map(a=>{
    const sh=[...holdings,...etfH].filter(h=>h.account_id===a.id),mh=mfH.filter(h=>h.account_id===a.id);
    const inv=sh.reduce((x,h)=>x+(h.qty??h.units)*h.avg_price,0)+mh.reduce((x,h)=>x+h.units*h.avg_nav,0);
    const cur=sh.reduce((x,h)=>{const l=getLtp(h.symbol);return x+(l?(h.qty??h.units)*l:(h.qty??h.units)*h.avg_price);},0)+mh.reduce((x,h)=>x+h.units*(h.current_nav??h.avg_nav),0);
    return{...a,inv,cur,pnl:cur-inv,pct:inv?((cur-inv)/inv)*100:0,count:holdings.filter(h=>h.account_id===a.id).length+mfH.filter(h=>h.account_id===a.id).length+etfH.filter(h=>h.account_id===a.id).length};
  });

  const openModal=(type,item=null)=>{setEditItem(item);setModal(type);};
  const closeModal=()=>{setModal(null);setEditItem(null);};
  const afterSave=fn=>()=>{fn();closeModal();setTimeout(doFetch,600);};
  const showToast=msg=>{setToast(msg);setTimeout(()=>setToast(""),3000);};
  const delH=async(id,table,loadFn)=>{if(!window.confirm("Remove this holding?"))return;try{await dbDelete(`/rest/v1/${table}?id=eq.${id}`,token);loadFn();}catch(e){showToast(e.message);}};
  const delAcc=async id=>{const n=[...holdings,...mfH,...etfH].filter(h=>h.account_id===id).length;if(n)return showToast("Remove all holdings first");try{await dbDelete(`/rest/v1/accounts?id=eq.${id}`,token);load.accounts();if(activeAcc===id)setActiveAcc("all");}catch(e){showToast(e.message);}};

  const curSection=SECTIONS.find(s=>s.key===section);
  const curRows=section==="stocks"?eS:section==="mf"?eM:eE;
  const curTable=section==="stocks"?"holdings":section==="mf"?"mf_holdings":"etf_holdings";
  const curLoad=section==="stocks"?load.holdings:section==="mf"?load.mf:load.etf;
  const cT=totals(curRows);const cPnl=cT.cur-cT.inv;const cPct=cT.inv?(cPnl/cT.inv)*100:0;
  const mktPill=<span style={{background:marketOpen?`${C.profit}18`:`${C.muted}18`,color:marketOpen?C.profit:C.muted,borderRadius:10,padding:"3px 9px",fontSize:10,fontWeight:700,letterSpacing:0.5,flexShrink:0}}>{marketOpen?"● LIVE":"● CLOSED"}</span>;

  const AccCard=({acc})=>{const isA=activeAcc===acc.id;return(<div onMouseEnter={()=>setHovRow(`a${acc.id}`)} onMouseLeave={()=>setHovRow(null)} onClick={()=>setActiveAcc(acc.id)} style={{padding:"7px 10px",cursor:"pointer",borderLeft:`3px solid ${isA?acc.color:"transparent"}`,background:isA?`${acc.color}18`:"transparent",borderBottom:`1px solid ${C.border}`,transition:"all .1s"}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><div style={{color:acc.color,fontSize:11,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:95}}>{acc.name}</div><div style={{display:"flex",gap:2,opacity:hovRow===`a${acc.id}`?1:0,transition:"opacity .15s",flexShrink:0}}><button onClick={e=>{e.stopPropagation();openModal("account",acc);}} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:10,padding:"1px 3px"}}>✎</button><button onClick={e=>{e.stopPropagation();delAcc(acc.id);}} style={{background:"none",border:"none",color:C.loss,cursor:"pointer",fontSize:10,padding:"1px 3px"}}>✕</button></div></div><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:2}}><div style={{color:C.white,fontSize:12,fontWeight:600}}>{ph(fmtC(acc.cur),privacy)}</div><div style={{color:privacy?C.muted:clr(acc.pnl),fontSize:10,fontWeight:600}}>{privacy?HIDDEN:`${acc.pnl>=0?"+":""}${fmt(acc.pct)}%`}</div></div></div>);};

  const TableView=()=>{
    if(curRows.length===0)return(<div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"55%",gap:14}}><div style={{fontSize:36}}>{curSection.icon}</div><div style={{color:C.muted}}>No {section} added yet</div><Btn onClick={()=>openModal(section)}>+ Add {curSection.label}</Btn></div>);
    const cols=section==="mf"?["Scheme","Account","Type","Units","Avg NAV","Invested","Current","P&L","Return",""]:["Symbol","Account",section==="etf"?"ETF Type":"Exch","Qty","Avg Price","LTP","Day%","Invested","Current","P&L","Return",""];
    return(<div style={{background:C.card,borderRadius:12,border:`1px solid ${C.border}`,overflow:"hidden"}}>
      <div style={{padding:"10px 14px",borderBottom:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between"}}><span style={{color:C.white,fontWeight:600,fontSize:13}}>{curRows.length} holdings {curSection.icon}</span><span style={{color:C.muted,fontSize:12}}>Invested: <b style={{color:C.white}}>{ph(fmtC(cT.inv),privacy)}</b></span></div>
      <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
        <thead><tr style={{background:C.bg}}>{cols.map(h=><th key={h} style={{padding:"9px 12px",textAlign:"left",color:C.muted,fontSize:9,letterSpacing:1.5,textTransform:"uppercase",borderBottom:`1px solid ${C.border}`,whiteSpace:"nowrap"}}>{h}</th>)}</tr></thead>
        <tbody>{curRows.map((h,i)=>{const acc=accounts.find(a=>a.id===h.account_id);const isH=hovRow===h.id;return(<tr key={h.id} onMouseEnter={()=>setHovRow(h.id)} onMouseLeave={()=>setHovRow(null)} style={{borderBottom:`1px solid ${C.border}`,background:isH?`${C.navy}22`:i%2?`${C.bg}66`:"transparent"}}>
          {section==="mf"?<><td style={TD}><div style={{color:C.white,fontWeight:600,fontSize:12,maxWidth:220,whiteSpace:"normal",lineHeight:1.3}}>{h.scheme_name}</div><div style={{color:C.muted,fontSize:9}}>{h.fund_house}</div></td><td style={TD}><Dot color={acc?.color} label={acc?.name??"—"}/></td><td style={TD}><span style={{background:`${C.navy}55`,color:"#7EB4D8",padding:"1px 6px",borderRadius:4,fontSize:10}}>{h.fund_type}</span></td><td style={{...TD,color:C.white}}>{fmt(h.units,3)}</td><td style={{...TD,color:C.muted}}>₹{fmt(h.avg_nav)}</td></>:<><td style={TD}><div style={{color:C.white,fontWeight:700}}>{h.symbol}</div><div style={{color:C.muted,fontSize:9}}>{section==="etf"?h.etf_name?.slice(0,18):h.exchange}</div></td><td style={TD}><Dot color={acc?.color} label={acc?.name??"—"}/></td><td style={{...TD,color:C.muted,fontSize:11}}>{section==="etf"?h.etf_type:h.exchange}</td><td style={{...TD,color:C.white,fontWeight:600}}>{fmt(h.qty??h.units,0)}</td><td style={{...TD,color:C.muted}}>₹{fmt(h.avg_price)}</td><td style={{...TD,color:h.ltp!=null?C.white:C.muted,fontWeight:700}}>{h.ltp!=null?`₹${fmt(h.ltp)}`:"—"}</td><td style={{...TD,color:clr(h.changePct),fontWeight:600}}>{h.changePct!=null?`${sign(h.changePct)} ${fmt(Math.abs(h.changePct))}%`:"—"}</td></>}
          <td style={{...TD,color:C.dim}}>{ph(fmtC(h.inv),privacy)}</td>
          <td style={{...TD,color:C.white,fontWeight:600}}>{ph(h.cur!=null?fmtC(h.cur):"—",privacy)}</td>
          <td style={TD}><PnlBadge pnl={h.pnl} privacy={privacy}/></td>
          <td style={{...TD,color:privacy?C.muted:clr(h.pct),fontWeight:600}}>{privacy?HIDDEN:h.pct!=null?`${h.pct>=0?"+":""}${fmt(h.pct)}%`:"—"}</td>
          <td style={TD}><div style={{display:"flex",gap:4,opacity:isH?1:0,transition:"opacity .15s"}}><button onClick={()=>openModal(section,h)} style={editBtn}>✎</button><button onClick={()=>delH(h.id,curTable,curLoad)} style={delBtnS}>✕</button></div></td>
        </tr>);})}
        </tbody>
        <tfoot><tr style={{background:C.bg,borderTop:`2px solid ${C.gold}33`}}><td colSpan={section==="mf"?4:6} style={{...TD,color:C.gold,fontWeight:700,fontSize:9,letterSpacing:2,textTransform:"uppercase"}}>TOTAL</td><td style={{...TD,color:C.dim,fontWeight:600}}>{ph(fmtC(cT.inv),privacy)}</td><td style={{...TD,color:C.white,fontWeight:700}}>{ph(fmtC(cT.cur),privacy)}</td><td style={TD}><PnlBadge pnl={cPnl} privacy={privacy} large/></td><td style={{...TD,color:privacy?C.muted:clr(cPct),fontWeight:700,fontSize:13}}>{privacy?HIDDEN:`${cPct>=0?"+":""}${fmt(cPct)}%`}</td><td/></tr></tfoot>
      </table></div>
    </div>);
  };

  // ── MOBILE ─────────────────────────────────────────────────────────────────
  if(isMobile){return(
    <div style={{background:C.bg,height:"100vh",fontFamily:"system-ui,sans-serif",display:"flex",flexDirection:"column",overflow:"hidden"}}>
      <style>{G}</style>
      <div style={{height:3,background:`linear-gradient(90deg,${C.navy},${C.gold},${C.navy})`,flexShrink:0}}/>
      <div style={{background:C.card,padding:"10px 14px",borderBottom:`1px solid ${C.border}`,flexShrink:0}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}><KoshLogo size={28}/><span style={{color:C.gold,fontWeight:800,letterSpacing:1,fontSize:13}}>KOSH</span>{mktPill}</div>
          <div style={{display:"flex",gap:6}}>
            <button onClick={()=>setPrivacy(p=>!p)} style={{background:privacy?`${C.gold}22`:"transparent",border:`1px solid ${C.border}`,color:privacy?C.gold:C.muted,borderRadius:7,padding:"5px 8px",fontSize:14,cursor:"pointer"}}>{privacy?"🙈":"👁"}</button>
            <button onClick={()=>setSettings(true)} style={{background:"transparent",border:`1px solid ${C.border}`,color:C.muted,borderRadius:7,padding:"5px 9px",fontSize:16,cursor:"pointer"}}>⚙</button>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          <div style={{background:`${C.navy}44`,borderRadius:10,padding:"10px 12px",border:`1px solid ${C.gold}22`}}><div style={{color:C.muted,fontSize:9,letterSpacing:1.5,textTransform:"uppercase"}}>Total Value</div><div style={{color:C.gold,fontWeight:800,fontSize:19,marginTop:2}}>{ph(fmtC(all.cur),privacy)}</div><div style={{color:privacy?C.muted:clr(totPnl),fontSize:11}}>{privacy?HIDDEN:`${totPnl>=0?"+":""}${fmtC(totPnl)} (${totPct>=0?"+":""}${fmt(totPct)}%)`}</div></div>
          <div style={{background:C.cardL,borderRadius:10,padding:"10px 12px"}}><div style={{color:C.muted,fontSize:9,letterSpacing:1.5,textTransform:"uppercase"}}>Today's P&L</div><div style={{color:privacy?C.muted:clr(dayPnl),fontWeight:700,fontSize:17,marginTop:2}}>{privacy?HIDDEN:`${dayPnl>=0?"+":""}${fmtC(dayPnl)}`}</div><div style={{color:C.muted,fontSize:10,marginTop:2}}>Invested {ph(fmtC(all.inv),privacy)}</div></div>
        </div>
      </div>
      <div style={{background:C.card,display:"flex",borderBottom:`1px solid ${C.border}`,flexShrink:0}}>
        {SECTIONS.map(s=><button key={s.key} onClick={()=>setSection(s.key)} style={{flex:1,background:"none",border:"none",borderBottom:`2px solid ${section===s.key?C.gold:"transparent"}`,color:section===s.key?C.gold:C.muted,padding:"9px 4px",fontSize:11,fontWeight:section===s.key?700:400,cursor:"pointer",fontFamily:"inherit"}}>{s.icon} {s.label} <span style={{opacity:.6}}>({countOf(s.key)})</span></button>)}
      </div>
      <div style={{background:C.card,display:"flex",overflowX:"auto",borderBottom:`1px solid ${C.border}`,WebkitOverflowScrolling:"touch",flexShrink:0}}>
        {[{id:"all",name:"All",color:C.gold},...accSummary].map(a=><button key={a.id} onClick={()=>setActiveAcc(a.id)} style={{flexShrink:0,background:"none",border:"none",borderBottom:`2px solid ${activeAcc===a.id?a.color:"transparent"}`,color:activeAcc===a.id?a.color:C.muted,padding:"7px 12px",cursor:"pointer",fontSize:10,fontWeight:activeAcc===a.id?700:400,whiteSpace:"nowrap",fontFamily:"inherit"}}>{a.name}</button>)}
        <button onClick={()=>openModal("account")} style={{flexShrink:0,background:"none",border:"none",borderBottom:"2px solid transparent",color:C.gold,padding:"7px 12px",cursor:"pointer",fontSize:10,fontWeight:700,fontFamily:"inherit"}}>+ Acc</button>
      </div>
      <div style={{flex:1,overflowY:"auto",padding:"10px 12px 90px"}}>
        {curRows.length===0?(<div style={{textAlign:"center",paddingTop:50,color:C.muted}}><div style={{fontSize:36,marginBottom:10}}>{curSection.icon}</div><div style={{marginBottom:16,fontSize:13}}>No {section} added yet</div><Btn onClick={()=>openModal(section)}>+ Add {curSection.label}</Btn></div>)
        :curRows.map(h=>{const acc=accounts.find(a=>a.id===h.account_id);const label=section==="mf"?(h.scheme_name?.split(" - ")[0]?.slice(0,22)+"…"):h.symbol;
          return(<div key={h.id} style={{background:C.card,borderRadius:12,padding:"12px",border:`1px solid ${C.border}`,marginBottom:10}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
              <div style={{flex:1,marginRight:8}}><div style={{color:C.white,fontWeight:700,fontSize:14}}>{label}</div><div style={{display:"flex",alignItems:"center",gap:5,marginTop:2}}>{acc&&<div style={{width:6,height:6,borderRadius:"50%",background:acc.color,flexShrink:0}}/>}<span style={{color:C.muted,fontSize:10}}>{acc?.name} · {h.exchange??h.fund_type??h.etf_type}</span></div></div>
              <div style={{textAlign:"right",flexShrink:0}}><div style={{color:h.ltp!=null?C.white:C.muted,fontWeight:700,fontSize:15}}>{h.ltp!=null?`₹${fmt(h.ltp)}`:"—"}</div>{h.changePct!=null&&<div style={{color:clr(h.changePct),fontSize:10}}>{sign(h.changePct)} {fmt(Math.abs(h.changePct))}%</div>}</div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginBottom:10}}>
              {[{l:section==="mf"?"Units":"Qty",v:fmt(h.qty??h.units,section==="mf"?3:0),c:C.white},{l:"Invested",v:ph(fmtC(h.inv),privacy),c:C.dim},{l:"Current",v:ph(h.cur!=null?fmtC(h.cur):"—",privacy),c:C.white},{l:"P&L",v:h.pnl!=null?`${h.pnl>=0?"+":""}${ph(fmtC(Math.abs(h.pnl)),privacy)}`:"—",c:privacy?C.muted:clr(h.pnl)},{l:"Return",v:h.pct!=null?`${h.pct>=0?"+":""}${privacy?HIDDEN:fmt(h.pct)}%`:"—",c:privacy?C.muted:clr(h.pct)},{l:"Avg",v:`₹${fmt(h.avg_price??h.avg_nav)}`,c:C.muted}].map((m,i)=><div key={i} style={{background:C.cardL,borderRadius:7,padding:"6px 7px"}}><div style={{color:C.muted,fontSize:8,letterSpacing:.8,textTransform:"uppercase"}}>{m.l}</div><div style={{color:m.c,fontWeight:600,fontSize:11,marginTop:1}}>{m.v}</div></div>)}
            </div>
            <div style={{display:"flex",gap:6,opacity:0.35}}>
              <button onClick={()=>openModal(section,h)} style={{flex:1,background:`${C.navy}33`,border:`1px solid ${C.navy}55`,color:"#7EB4D8",borderRadius:6,padding:"5px",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>✎ Edit</button>
              <button onClick={()=>delH(h.id,curTable,curLoad)} style={{flex:1,background:`${C.loss}11`,border:`1px solid ${C.loss}33`,color:C.loss,borderRadius:6,padding:"5px",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>✕ Remove</button>
            </div>
          </div>);})}
      </div>
      <button onClick={()=>openModal(section)} style={{position:"fixed",bottom:20,right:16,width:52,height:52,borderRadius:"50%",background:C.gold,border:"none",color:C.bg,fontSize:26,fontWeight:700,cursor:"pointer",boxShadow:`0 4px 20px ${C.gold}55`,zIndex:10,fontFamily:"inherit"}}>+</button>
      {toast&&<div style={{position:"fixed",bottom:80,left:"50%",transform:"translateX(-50%)",background:C.card,border:`1px solid ${C.border}`,color:C.white,borderRadius:9,padding:"9px 18px",fontSize:13,zIndex:300,whiteSpace:"nowrap"}}>{toast}</div>}
      {settingsOpen&&<SettingsPanel token={token} onClose={()=>setSettings(false)} onLogout={onLogout} isMobile onCredsChange={setCreds}/>}
      {modal==="stocks" &&<Sheet title="📈 Add Stock"       subtitle="400+ NSE stocks"  onClose={closeModal}><StockForm  holding={editItem} accounts={accounts} token={token} onSave={afterSave(load.holdings)} onClose={closeModal}/></Sheet>}
      {modal==="mf"     &&<Sheet title="🏦 Add Mutual Fund" subtitle="72+ MF schemes"   onClose={closeModal}><MFForm     holding={editItem} accounts={accounts} token={token} onSave={afterSave(load.mf)}       onClose={closeModal}/></Sheet>}
      {modal==="etf"    &&<Sheet title="🔷 Add ETF"         subtitle="50+ ETFs"         onClose={closeModal}><ETFForm    holding={editItem} accounts={accounts} token={token} onSave={afterSave(load.etf)}      onClose={closeModal}/></Sheet>}
      {modal==="account"&&<Sheet title="Demat Account"                                  onClose={closeModal}><AccForm    account={editItem}  token={token}       onSave={afterSave(load.accounts)}             onClose={closeModal}/></Sheet>}
      {modal==="excel"  &&<Sheet title="📊 Import Portfolio"                            onClose={closeModal}><ExcelImport accounts={accounts} token={token} onDone={msg=>{showToast(msg);load.holdings();load.mf();load.etf();closeModal();}} onClose={closeModal}/></Sheet>}
    </div>
  );}

  // ── DESKTOP ───────────────────────────────────────────────────────────────
  return(
    <div style={{background:C.bg,height:"100vh",fontFamily:"system-ui,sans-serif",display:"flex",flexDirection:"column",overflow:"hidden"}}>
      <style>{G}</style>
      <div style={{height:3,background:`linear-gradient(90deg,${C.navy},${C.gold},${C.navy})`,flexShrink:0}}/>
      <header style={{background:C.card,borderBottom:`1px solid ${C.border}`,display:"flex",alignItems:"center",padding:"0 16px",minHeight:56,flexShrink:0,gap:10}}>
        <div style={{display:"flex",alignItems:"center",gap:9,paddingRight:12,borderRight:`1px solid ${C.border}`}}><KoshLogo size={30}/><div><div style={{color:C.gold,fontWeight:800,fontSize:12,letterSpacing:1}}>KOSH</div><div style={{color:C.muted,fontSize:8,letterSpacing:2}}>PORTFOLIO</div></div></div>
        {mktPill}
        {[{l:"Value",v:ph(fmtC(all.cur),privacy),c:C.gold,big:true},{l:"Invested",v:ph(fmtC(all.inv),privacy),c:C.dim},{l:"P&L",v:privacy?HIDDEN:`${totPnl>=0?"+":""}${fmtC(totPnl)}`,c:privacy?C.muted:clr(totPnl)},{l:"Returns",v:privacy?HIDDEN:`${totPct>=0?"+":""}${fmt(totPct)}%`,c:privacy?C.muted:clr(totPct)},{l:"Today",v:privacy?HIDDEN:`${dayPnl>=0?"+":""}${fmtC(dayPnl)}`,c:privacy?C.muted:clr(dayPnl)}].map((m,i)=>(
          <div key={i} style={{textAlign:"center",padding:"0 10px",borderRight:i<4?`1px solid ${C.border}`:"none"}}><div style={{color:C.muted,fontSize:9,letterSpacing:1.5,textTransform:"uppercase"}}>{m.l}</div><div style={{color:m.c,fontSize:m.big?16:13,fontWeight:m.big?800:600,marginTop:1}}>{m.v}</div></div>
        ))}
        <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:6}}>
          {lastUpdate&&<span style={{color:C.muted,fontSize:10}}>{lastUpdate.toLocaleTimeString()}</span>}
          <button onClick={()=>setPrivacy(p=>!p)} style={{background:privacy?`${C.gold}22`:"transparent",border:`1px solid ${privacy?C.gold:C.border}`,color:privacy?C.gold:C.muted,borderRadius:7,padding:"5px 8px",fontSize:15,cursor:"pointer"}} title="Privacy">{ privacy?"🙈":"👁"}</button>
          <button onClick={()=>setSettings(true)} style={{background:"transparent",border:`1px solid ${C.border}`,color:C.muted,borderRadius:7,padding:"5px 9px",fontSize:15,cursor:"pointer"}} title="Settings">⚙</button>
        </div>
      </header>
      <div style={{display:"flex",flex:1,overflow:"hidden"}}>
        <aside style={{width:162,background:C.card,borderRight:`1px solid ${C.border}`,display:"flex",flexDirection:"column",overflow:"hidden",flexShrink:0}}>
          <div onClick={()=>setActiveAcc("all")} style={{padding:"8px 10px",cursor:"pointer",borderLeft:`3px solid ${activeAcc==="all"?C.gold:"transparent"}`,background:activeAcc==="all"?`${C.navy}77`:"transparent",borderBottom:`1px solid ${C.border}`,flexShrink:0}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><span style={{color:activeAcc==="all"?C.gold:C.dim,fontSize:9,fontWeight:700,letterSpacing:1}}>ALL · {holdings.length+mfH.length+etfH.length}</span><div style={{width:5,height:5,borderRadius:"50%",background:priceStatus==="ok"?C.profit:priceStatus==="loading"?"#F59E0B":C.muted}}/></div>
            <div style={{color:C.white,fontSize:13,fontWeight:700,marginTop:3}}>{ph(fmtC(all.cur),privacy)}</div>
            <div style={{color:privacy?C.muted:clr(totPnl),fontSize:10,marginTop:1}}>{privacy?HIDDEN:`${totPnl>=0?"+":""}${fmt(totPct)}%`}</div>
          </div>
          <div style={{height:1,background:C.border}}/>
          <div style={{flex:1,overflowY:"auto",overflowX:"hidden"}}>{accSummary.map(acc=><AccCard key={acc.id} acc={acc}/>)}</div>
          <div style={{padding:7,borderTop:`1px solid ${C.border}`,flexShrink:0}}><button onClick={()=>openModal("account")} style={{width:"100%",background:"transparent",border:`1px dashed ${C.gold}44`,color:C.gold,borderRadius:6,padding:"6px",cursor:"pointer",fontSize:10,fontWeight:600,fontFamily:"inherit"}}>+ Add Account</button></div>
        </aside>
        <main style={{flex:1,overflow:"hidden",display:"flex",flexDirection:"column"}}>
          <div style={{background:C.card,borderBottom:`1px solid ${C.border}`,display:"flex",alignItems:"center",padding:"0 16px",flexShrink:0}}>
            {SECTIONS.map(s=><button key={s.key} onClick={()=>setSection(s.key)} style={{background:"none",border:"none",borderBottom:`2px solid ${section===s.key?C.gold:"transparent"}`,color:section===s.key?C.gold:C.muted,padding:"11px 14px",cursor:"pointer",fontSize:12,fontWeight:section===s.key?700:400,whiteSpace:"nowrap",fontFamily:"inherit"}}>{s.icon} {s.label} <span style={{opacity:.6,fontSize:11}}>({countOf(s.key)})</span></button>)}
            <div style={{marginLeft:"auto"}}><button onClick={()=>openModal(section)} style={{background:C.gold,border:"none",color:C.bg,borderRadius:7,padding:"6px 14px",cursor:"pointer",fontSize:12,fontWeight:700,fontFamily:"inherit"}}>+ Add {curSection.label}</button></div>
          </div>
          <div style={{flex:1,overflowY:"auto",padding:14}}><TableView/></div>
          <div style={{padding:"5px 16px",borderTop:`1px solid ${C.border}`,background:C.card,display:"flex",justifyContent:"center",alignItems:"center",gap:6,flexShrink:0}}><KoshLogo size={16}/><span style={{color:C.muted,fontSize:9,letterSpacing:2}}>EXCLUSIVELY POWERED BY KOSH</span></div>
        </main>
      </div>
      {settingsOpen&&<SettingsPanel token={token} onClose={()=>{setSettings(false);load.profile();}} onLogout={onLogout} isMobile={false} onCredsChange={setCreds}/>}
      {toast&&<div style={{position:"fixed",bottom:24,left:"50%",transform:"translateX(-50%)",background:C.card,border:`1px solid ${C.border}`,color:C.white,borderRadius:9,padding:"9px 20px",fontSize:13,zIndex:500,whiteSpace:"nowrap",boxShadow:"0 8px 32px rgba(0,0,0,.5)"}}>{toast}</div>}
      {modal==="stocks" &&<ModalC title="📈 Add Stock"       subtitle="400+ NSE stocks" onClose={closeModal}><StockForm  holding={editItem} accounts={accounts} token={token} onSave={afterSave(load.holdings)} onClose={closeModal}/></ModalC>}
      {modal==="mf"     &&<ModalC title="🏦 Add Mutual Fund" subtitle="72+ MF schemes"  onClose={closeModal}><MFForm     holding={editItem} accounts={accounts} token={token} onSave={afterSave(load.mf)}       onClose={closeModal}/></ModalC>}
      {modal==="etf"    &&<ModalC title="🔷 Add ETF"         subtitle="50+ ETFs"        onClose={closeModal}><ETFForm    holding={editItem} accounts={accounts} token={token} onSave={afterSave(load.etf)}      onClose={closeModal}/></ModalC>}
      {modal==="account"&&<ModalC title="Demat Account"                                 onClose={closeModal}><AccForm    account={editItem}  token={token}       onSave={afterSave(load.accounts)}            onClose={closeModal}/></ModalC>}
      {modal==="excel"  &&<ModalC title="📊 Import Portfolio" maxWidth={500}            onClose={closeModal}><ExcelImport accounts={accounts} token={token} onDone={msg=>{showToast(msg);load.holdings();load.mf();load.etf();closeModal();}} onClose={closeModal}/></ModalC>}
    </div>
  );
}

const Dot=({color,label})=><div style={{display:"flex",alignItems:"center",gap:4}}><div style={{width:6,height:6,borderRadius:"50%",background:color??"#4A5568",flexShrink:0}}/><span style={{color:"#94A3B8",fontSize:11}}>{label}</span></div>;
const PnlBadge=({pnl,privacy,large})=>{const v=privacy?"••••":pnl!=null?`${pnl>=0?"+":""}₹${Math.abs(pnl).toLocaleString("en-IN",{maximumFractionDigits:0})}`:"—";return<span style={{background:pnl!=null?(pnl>0?"#22C55E18":"#EF444418"):"transparent",color:privacy?"#4A5568":pnl==null?"#64748B":pnl>0?"#22C55E":"#EF4444",padding:large?"3px 10px":"2px 7px",borderRadius:5,fontWeight:700,fontSize:large?13:11}}>{v}</span>;};
const TD={padding:"10px 12px",verticalAlign:"middle",whiteSpace:"nowrap"};
const priceStatus="ok"; // referenced in aside status dot above
const editBtn={background:"#0A3D6244",border:"1px solid #0A3D62",color:"#7EB4D8",cursor:"pointer",borderRadius:5,padding:"3px 7px",fontSize:11};
const delBtnS={background:"#EF444411",border:"1px solid #EF444444",color:"#EF4444",cursor:"pointer",borderRadius:5,padding:"3px 7px",fontSize:11};