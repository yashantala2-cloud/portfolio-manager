// ─────────────────────────────────────────────────────────────────────────────
// /api/dhan-ltp.js  —  Vercel Serverless Function
//
// WHY THIS EXISTS:
//   Dhan API does NOT set CORS headers, so browsers cannot call it directly.
//   This function runs server-side on Vercel, proxies the request, and also
//   handles the symbol → Security ID conversion that Dhan requires.
//
// HOW IT WORKS:
//   1. Frontend sends: { symbols: ["RELIANCE", "TCS"], token, clientId }
//   2. This function downloads Dhan's scrip master CSV (cached for 1 hour)
//      and builds a  symbol → securityId  lookup map for NSE Equity stocks.
//   3. It calls https://api.dhan.co/v2/marketfeed/ltp  with security IDs.
//   4. Maps the response back from securityId → symbol and returns it.
//
// RESPONSE FORMAT (returned to your fetchDhan() in App.jsx):
//   { data: { RELIANCE: { ltp, change, pct }, TCS: { ltp, change, pct } } }
//
// DEPLOYMENT:
//   Place this file at  /api/dhan-ltp.js  in the root of your Vercel project.
//   No vercel.json changes needed — Vercel auto-detects files under /api/.
// ─────────────────────────────────────────────────────────────────────────────

// ── In-memory scrip master cache (lives for the lifetime of the serverless instance) ──
let _scripCache = null;   // { SYMBOL: "securityId", ... }
let _scripCacheTs = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Fetches Dhan's public scrip master CSV and builds a
 * { TRADING_SYMBOL → security_id } map for NSE Equity instruments.
 * Result is cached in memory so the ~10 MB CSV is only downloaded once per hour.
 */
async function getScripMap() {
  if (_scripCache && Date.now() - _scripCacheTs < CACHE_TTL_MS) {
    return _scripCache;
  }

  const res = await fetch(
    "https://images.dhan.co/api-data/api-scrip-master.csv",
    { signal: AbortSignal.timeout(20_000) }
  );

  if (!res.ok) {
    throw new Error(`Scrip master fetch failed: HTTP ${res.status}`);
  }

  const text = await res.text();
  const lines = text.trim().split("\n");

  // Parse header row — columns vary; we locate by name, not position.
  const rawHeaders = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
  const col = name => rawHeaders.indexOf(name);

  const IDX_SYM  = col("SEM_TRADING_SYMBOL");
  const IDX_ID   = col("SEM_SMST_SECURITY_ID");
  const IDX_EXCH = col("SEM_EXM_EXCH_ID");
  const IDX_INST = col("SEM_INSTRUMENT_NAME");

  if ([IDX_SYM, IDX_ID, IDX_EXCH, IDX_INST].some(i => i === -1)) {
    // Fallback: try alternative column names used in older scrip master versions
    const IDX_SYM2  = col("SM_SYMBOL_NAME");
    const IDX_ID2   = col("SEM_SMST_SECURITY_ID");
    // Log available headers to help debug if this ever breaks
    console.warn("Scrip master header mismatch. Headers found:", rawHeaders.slice(0, 20).join(", "));
    if (IDX_SYM2 === -1 || IDX_ID2 === -1) {
      throw new Error("Cannot parse scrip master CSV — unexpected column names.");
    }
  }

  const map = {};

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    // Simple CSV split — works for scrip master since none of these fields
    // contain commas. For safety we strip surrounding quotes.
    const cols = line.split(",");
    if (cols.length <= Math.max(IDX_SYM, IDX_ID, IDX_EXCH, IDX_INST)) continue;

    const clean = idx => (cols[idx] || "").trim().replace(/^"|"$/g, "");

    const exch = clean(IDX_EXCH);   // "NSE" or "BSE"
    const inst = clean(IDX_INST);   // "EQUITY", "INDEX", etc.
    const sym  = clean(IDX_SYM);    // "RELIANCE", "TCS", etc.
    const id   = clean(IDX_ID);     // "1333", "11536", etc.

    // We only need NSE Equity for stock LTP
    if (exch === "NSE" && inst === "EQUITY" && sym && id) {
      map[sym] = id;
    }
  }

  _scripCache  = map;
  _scripCacheTs = Date.now();
  console.log(`[dhan-ltp] Scrip master loaded: ${Object.keys(map).length} NSE_EQ instruments`);
  return map;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Only accept POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { symbols, token, clientId } = req.body || {};

  if (!token) {
    return res.status(400).json({ error: "Missing Dhan access token" });
  }
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return res.status(400).json({ error: "Missing or empty symbols array" });
  }

  try {
    // ── Step 1: Build / retrieve symbol → security ID map ──────────────────
    const scripMap = await getScripMap();

    // ── Step 2: Convert stock symbols to Dhan security IDs ─────────────────
    const securityIds = [];
    const idToSymbol  = {};   // reverse map: secId → symbol
    const notMapped   = [];

    for (const sym of symbols) {
      const secId = scripMap[sym.toUpperCase()];
      if (secId) {
        securityIds.push(secId);
        idToSymbol[secId] = sym.toUpperCase();
      } else {
        notMapped.push(sym);
      }
    }

    if (!securityIds.length) {
      console.warn("[dhan-ltp] None of the requested symbols found in scrip master:", symbols);
      return res.status(200).json({ data: {}, notFound: notMapped });
    }

    // ── Step 3: Call Dhan Market Quote LTP API ──────────────────────────────
    // API: POST https://api.dhan.co/v2/marketfeed/ltp
    // Body: { "NSE_EQ": ["1333", "11536", ...] }   ← security IDs (strings)
    // Ref: https://dhanhq.co/docs/v2/market-quote/
    const dhanRes = await fetch("https://api.dhan.co/v2/marketfeed/ltp", {
      method: "POST",
      headers: {
        "access-token":  token,
        "client-id":     clientId || "",
        "Content-Type":  "application/json",
        Accept:          "application/json",
      },
      body: JSON.stringify({ NSE_EQ: securityIds }),
      signal: AbortSignal.timeout(9_000),
    });

    if (!dhanRes.ok) {
      const errText = await dhanRes.text().catch(() => "");
      console.error("[dhan-ltp] Dhan API error:", dhanRes.status, errText);
      return res.status(dhanRes.status).json({ error: errText || `Dhan API error ${dhanRes.status}` });
    }

    const dhanData = await dhanRes.json();

    // ── Step 4: Map response from securityId → symbol ──────────────────────
    // Dhan response: { data: { NSE_EQ: { "11536": { last_price, net_change, percent_change } } } }
    const out = {};

    for (const [secId, quote] of Object.entries(dhanData?.data?.NSE_EQ || {})) {
      const sym = idToSymbol[secId];
      if (sym && quote?.last_price != null) {
        out[sym] = {
          ltp:    quote.last_price,
          change: quote.net_change     ?? 0,
          pct:    quote.percent_change ?? 0,
        };
      }
    }

    return res.status(200).json({
      data:     out,       // { SYMBOL: { ltp, change, pct } }
      notFound: [          // symbols with no data (not in scrip master or market closed)
        ...notMapped,
        ...symbols.filter(s => !out[s.toUpperCase()] && !notMapped.includes(s)),
      ],
    });

  } catch (err) {
    console.error("[dhan-ltp] Unexpected error:", err);
    return res.status(500).json({ error: err.message });
  }
}