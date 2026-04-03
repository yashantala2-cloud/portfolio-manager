// api/prices.js — Vercel Serverless Function
// This runs SERVER-SIDE, so Dhan API CORS restrictions don't apply.
// Frontend calls POST /api/prices with { symbols: ["RELIANCE", "INFY", ...] }

export default async function handler(req, res) {
  // CORS headers so any origin (your deployed app) can call this
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { symbols } = req.body || {};
  if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
    return res.status(400).json({ error: "symbols array required" });
  }

  const DHAN_TOK = process.env.VITE_DHAN_ACCESS_TOKEN;
  const DHAN_CID = process.env.VITE_DHAN_CLIENT_ID;

  if (!DHAN_TOK) {
    return res.status(503).json({ error: "Dhan token not configured" });
  }

  try {
    // Dhan v2 MarketFeed LTP — batch request (up to 100 symbols)
    const dhanRes = await fetch("https://api.dhan.co/v2/marketfeed/ltp", {
      method: "POST",
      headers: {
        "access-token": DHAN_TOK,
        "client-id":    DHAN_CID || "",
        "Content-Type": "application/json",
        "Accept":       "application/json",
      },
      body: JSON.stringify({ NSE_EQ: symbols }),
    });

    if (!dhanRes.ok) {
      const errBody = await dhanRes.text();
      return res.status(dhanRes.status).json({ error: `Dhan API: ${errBody}` });
    }

    const data = await dhanRes.json();
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}