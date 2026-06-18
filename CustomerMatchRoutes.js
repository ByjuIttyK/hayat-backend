// ─────────────────────────────────────────────────────────────────────────────
//  CustomerMatchRoutes.js — fuzzy-match a scanned drawer name to CUS_MST
//  Mount in HayatDb.js:  app.use("/api", authMiddleware, require("./CustomerMatchRoutes"));
//  (or merge the single route into your existing app)
//  Contract:  GET /api/match_customer?name=ARYA%20SPARE%20PARTS
//    → { matches: [ { CUST_CODE, CUST_NAME, score } ... ] }  (best first, top 5)
// ─────────────────────────────────────────────────────────────────────────────
const express = require("express");
const router = express.Router();
const connection = require("./db");   // adjust to however HayatDb shares the pool

// normalize: uppercase, strip punctuation, collapse company suffixes/spaces
function norm(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/\b(L\.?L\.?C|LLC|FZE|FZC|FZ\-?LLC|EST|ESTABLISHMENT|TRADING|GENERAL|CO|COMPANY|LTD|LIMITED|W\.?L\.?L)\b/g, " ")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// token-set similarity (Jaccard) + substring bonus → 0..1
function score(aRaw, bRaw) {
  const a = norm(aRaw), b = norm(bRaw);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = new Set(a.split(" ").filter(Boolean));
  const B = new Set(b.split(" ").filter(Boolean));
  let inter = 0;
  A.forEach(t => { if (B.has(t)) inter++; });
  const union = new Set([...A, ...B]).size || 1;
  let s = inter / union;                          // Jaccard
  if (a.includes(b) || b.includes(a)) s = Math.max(s, 0.85);  // one contains the other
  // first-token match bonus (company names usually lead with the distinctive word)
  const a0 = a.split(" ")[0], b0 = b.split(" ")[0];
  if (a0 && a0 === b0) s = Math.min(1, s + 0.1);
  return s;
}

router.get("/match_customer", (req, res) => {
  const scanned = req.query.name || "";
  if (!scanned.trim()) return res.json({ matches: [] });

  connection.query(
    "SELECT CUST_CODE, CUST_NAME FROM CUS_MST",
    (err, rows) => {
      if (err) {
        console.error("match_customer:", err.message);
        return res.status(500).json({ error: err.message });
      }
      const ranked = (rows || [])
        .map(r => ({ CUST_CODE: r.CUST_CODE, CUST_NAME: r.CUST_NAME, score: score(scanned, r.CUST_NAME) }))
        .filter(m => m.score > 0.25)
        .sort((x, y) => y.score - x.score)
        .slice(0, 5);
      res.json({ matches: ranked, scanned });
    }
  );
});

module.exports = router;
