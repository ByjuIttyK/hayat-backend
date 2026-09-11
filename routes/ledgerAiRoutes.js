// routes/ledgerAiRoutes.js
// ---------------------------------------------------------------------------
// AI ledger enquiry for AcLedger — Telltron ERP
//
//   POST /api/ledger-ai/parse   { text: "supplier ledger gulf ocean lights last quarter" }
//   → {
//       ledgerType:  "CUSTOMERS" | "SUPPLIERS" | "ACCOUNTS" | null,
//       fromDate:    "YYYY-MM-DD" | null,
//       toDate:      "YYYY-MM-DD" | null,
//       accountText: "gulf ocean lights" | null,
//       match:       { type, code, name } | null,       // confident single account
//       candidates:  [{ type, code, name, score }],      // when the name is ambiguous
//       message:     string
//     }
//
// Gemini reads the sentence (ledger type, period, account words); the account
// itself is resolved here against the masters, so the AI never invents a code.
// Table names are lowercase for the Linux VPS (lower_case_table_names=0).
//
// Register in HayatDb.js (after the /api auth middleware):
//   app.use("/api", require("./routes/ledgerAiRoutes")(connection));
// Requires GEMINI_API_KEY in .env (optional GEMINI_MODEL to pin a model).
// ---------------------------------------------------------------------------
const express = require("express");

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODELS = process.env.GEMINI_MODEL
  ? [process.env.GEMINI_MODEL]
  : ["gemini-2.5-flash-lite", "gemini-2.5-flash"];

const MASTERS = {
  CUSTOMERS: { table: "cus_mst", code: "cust_code", name: "cust_name" },
  SUPPLIERS: { table: "sup_mst", code: "sup_code", name: "sup_name" },
  ACCOUNTS:  { table: "acc_mst", code: "acc_code", name: "acc_head" },
};

// Words that carry no identity in an account name
const STOP = new Set([
  "LLC", "L", "C", "LTD", "LIMITED", "CO", "COMPANY", "EST", "ESTABLISHMENT",
  "FZE", "FZCO", "FZ", "FZC", "THE", "AND", "OF", "MS", "M", "S", "PVT", "INC",
  "ACCOUNT", "AC", "A", "LEDGER", "STATEMENT", "FOR", "TO", "FROM",
]);

// ── Text helpers ────────────────────────────────────────────────────────────
const norm = (s) => String(s || "").toUpperCase().replace(/&/g, " AND ").replace(/[^A-Z0-9]+/g, " ").trim();
// Spelled-out letters are joined first: "A B B" -> ABB, "L L C" -> LLC (then dropped)
const tokens = (s) => {
  const parts = norm(s).split(" ").filter(Boolean);
  const merged = [];
  for (let i = 0; i < parts.length; i++) {
    if (/^[A-Z]$/.test(parts[i]) && /^[A-Z]$/.test(parts[i + 1] || "")) {
      let run = parts[i];
      while (/^[A-Z]$/.test(parts[i + 1] || "")) run += parts[++i];
      merged.push(run);
    } else merged.push(parts[i]);
  }
  return merged.filter((t) => !STOP.has(t));
};
const compact = (s) => tokens(s).join("");

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// How well one spoken token matches one name token (0..1)
function tokenScore(q, t) {
  if (q === t) return 1;
  const short = q.length <= t.length ? q : t;
  const long = q.length <= t.length ? t : q;
  if (short.length >= 3 && long.startsWith(short)) return 0.85;   // LIGHT ~ LIGHTS
  if (short.length >= 4) {
    const sim = 1 - levenshtein(q, t) / Math.max(q.length, t.length);
    if (sim >= 0.75) return sim * 0.8;                              // speech misspellings
  }
  return 0;
}

// Name similarity: mostly "did every spoken word match", a little "how much of the name was said"
function nameScore(query, name) {
  const qt = tokens(query);
  const nt = tokens(name);
  if (!qt.length || !nt.length) return 0;
  const qc = qt.join(""), nc = nt.join("");
  if (qc === nc) return 1;

  let recall = 0;
  const used = new Set();
  for (const q of qt) {
    let best = 0, bestIdx = -1;
    nt.forEach((t, i) => {
      if (used.has(i)) return;
      const s = tokenScore(q, t);
      if (s > best) { best = s; bestIdx = i; }
    });
    if (bestIdx >= 0 && best > 0) used.add(bestIdx);
    recall += best;
  }
  recall /= qt.length;
  const precision = used.size / nt.length;
  let score = 0.75 * recall + 0.25 * precision;
  if (qc.length >= 4 && nc.startsWith(qc)) score = Math.max(score, 0.9);   // "ALHAYAT" vs "AL HAYAT ELECT"
  return Math.round(Math.min(score, 0.99) * 1000) / 1000;
}

// ── Dates ───────────────────────────────────────────────────────────────────
const isoToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const validIso = (s) => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? s : null;
};

// ── Gemini ──────────────────────────────────────────────────────────────────
async function geminiJson(prompt) {
  let lastErr;
  for (const model of GEMINI_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 256, responseMimeType: "application/json" },
      }),
    });
    if (resp.status === 404) { lastErr = new Error(`Gemini model ${model} not found`); continue; }
    if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    const raw = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
    return JSON.parse(raw.replace(/```json|```/g, "").trim());
  }
  throw lastErr || new Error("No Gemini model available");
}

function buildPrompt(text) {
  const today = isoToday();
  const weekday = new Date().toLocaleDateString("en-GB", { weekday: "long" });
  return `You read ledger enquiries for a UAE company's accounting system. The text may come from
speech recognition and can contain recognition errors.
Today is ${today} (${weekday}). The financial year is the calendar year. Dates are day-first (dd/mm/yyyy).

Return ONLY this JSON:
{"ledgerType": "CUSTOMER" | "SUPPLIER" | "GL" | null,
 "accountText": string | null,
 "fromDate": "YYYY-MM-DD" | null,
 "toDate": "YYYY-MM-DD" | null}

ledgerType:
- customer, client, debtor, receivable, customer statement, sales party -> "CUSTOMER"
- supplier, vendor, creditor, payable, purchase party -> "SUPPLIER"
- G/L, GL, general ledger, nominal, bank, cash, expense, income, asset, liability account -> "GL"
- not stated -> null

accountText: the account name or code exactly as said, without words such as ledger, account,
statement, show, display, open, of, for, from, period or the dates. null if no account is named.

Dates:
- "this year" = ${today.slice(0, 4)}-01-01 to today; "last year" = the whole previous calendar year
- "this month" = 1st of this month to today; "last month" = the whole previous month
- "this quarter" / "last quarter" / "Q1 2025" = calendar quarters (Q1 Jan-Mar)
- a month name alone ("March", "March 2025") = that whole month; a year alone ("2025") = that whole year
- "since March" / "from 1st April" = that date to today
- "up to 30 June" / "till 30 June" = fromDate null, toDate that date
- "till date", "to date", "today" as an end = today
- a date without a year takes the current year; if that makes the period start in the future, use the previous year
- nothing about a period -> both null

Text: """${String(text).slice(0, 500)}"""`;
}

// ── Account lookup ──────────────────────────────────────────────────────────
module.exports = function (connection) {
  const router = express.Router();
  const db = typeof connection.promise === "function" ? connection.promise() : connection;

  async function findInMaster(type, accountText) {
    const m = MASTERS[type];
    const raw = String(accountText || "").trim();
    const codeKey = raw.replace(/\s+/g, "").toUpperCase();

    // 1. Spoken/typed code — exact hit wins outright
    if (/\d/.test(codeKey)) {
      const [rows] = await db.query(
        `SELECT ${m.code} AS code, ${m.name} AS name FROM ${m.table}
          WHERE UPPER(REPLACE(${m.code}, ' ', '')) = ? LIMIT 1`,
        [codeKey]
      );
      if (rows.length) return [{ type, code: String(rows[0].code).trim(), name: String(rows[0].name || "").trim(), score: 1 }];
    }

    // 2. Name — narrow with LIKE, then score in JS
    const qt = tokens(raw).filter((t) => t.length >= 2);
    if (!qt.length) return [];
    const likeParts = [];
    const params = [];
    for (const t of qt) {
      likeParts.push(`UPPER(${m.name}) LIKE ?`);
      params.push(`%${t.length >= 5 ? t.slice(0, t.length - 1) : t}%`);   // LIGHTS finds LIGHT
    }
    likeParts.push(`UPPER(REPLACE(${m.name}, ' ', '')) LIKE ?`);
    params.push(`%${qt.join("")}%`);

    const [rows] = await db.query(
      `SELECT ${m.code} AS code, ${m.name} AS name FROM ${m.table}
        WHERE ${likeParts.join(" OR ")}
        LIMIT 400`,
      params
    );
    return rows
      .map((r) => ({
        type,
        code: String(r.code || "").trim(),
        name: String(r.name || "").trim(),
        score: nameScore(raw, r.name),
      }))
      .filter((r) => r.code && r.score >= 0.35);
  }

  router.post("/ledger-ai/parse", async (req, res) => {
    const text = String(req.body?.text || "").trim();
    if (text.length < 3) return res.status(400).json({ error: "Say or type what ledger you want to see." });
    if (!GEMINI_KEY) return res.status(500).json({ error: "GEMINI_API_KEY is not set on the server." });

    let ai;
    try {
      ai = await geminiJson(buildPrompt(text));
    } catch (err) {
      console.error("ledger-ai gemini:", err.message);
      return res.status(502).json({ error: "The AI could not read that request. Try again or rephrase it." });
    }

    const typeMap = { CUSTOMER: "CUSTOMERS", SUPPLIER: "SUPPLIERS", GL: "ACCOUNTS" };
    const statedType = typeMap[String(ai?.ledgerType || "").toUpperCase()] || null;
    let fromDate = validIso(ai?.fromDate);
    let toDate = validIso(ai?.toDate);
    if (fromDate && toDate && fromDate > toDate) [fromDate, toDate] = [toDate, fromDate];
    const accountText = ai?.accountText ? String(ai.accountText).trim() : "";

    const out = { ledgerType: statedType, fromDate, toDate, accountText: accountText || null, match: null, candidates: [], message: "" };

    if (!accountText) {
      out.message = "No account name was found in the request.";
      return res.json(out);
    }

    try {
      const byScore = (a, b) => b.score - a.score || a.name.length - b.name.length;
      let found = [];
      let crossType = false;

      if (statedType) {
        found = (await findInMaster(statedType, accountText)).sort(byScore);
        // Nothing convincing in the stated ledger — offer strong hits from the others
        if (!found.length || found[0].score < 0.6) {
          const others = Object.keys(MASTERS).filter((t) => t !== statedType);
          const extra = (await Promise.all(others.map((t) => findInMaster(t, accountText))))
            .flat()
            .filter((r) => r.score >= 0.6)
            .sort(byScore);
          if (extra.length) {
            found = [...extra, ...found];
            crossType = true;
          }
        }
      } else {
        found = (await Promise.all(Object.keys(MASTERS).map((t) => findInMaster(t, accountText))))
          .flat()
          .sort(byScore);
      }

      const [top, second] = found;
      const confident = top && !crossType && (
        (top.score === 1 && (!second || second.score < 1)) ||
        (top.score >= 0.6 && (!second || top.score - second.score >= 0.12))
      );

      const typeWord = { CUSTOMERS: "customer", SUPPLIERS: "supplier", ACCOUNTS: "G/L account" };
      if (confident) {
        out.match = { type: top.type, code: top.code, name: top.name };
        out.ledgerType = top.type;
      } else if (found.length) {
        out.candidates = found.slice(0, 8);
        out.message = crossType
          ? `No ${typeWord[statedType]} matches "${accountText}" closely. Closest accounts:`
          : `More than one account matches "${accountText}". Pick one:`;
      } else {
        out.message = `No account matches "${accountText}".`;
      }
      res.json(out);
    } catch (err) {
      console.error("ledger-ai lookup:", err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};

// exported for tests
module.exports._nameScore = nameScore;
