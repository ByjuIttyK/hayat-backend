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
// GEMINI_MODEL (if set) is tried first; the rest are fallbacks, so a pinned
// model that has been retired can't take the feature down on its own.
const GEMINI_MODELS = [...new Set([
  process.env.GEMINI_MODEL,
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-flash-latest",
].filter(Boolean))];

const MASTERS = {
  CUSTOMERS: { table: "cus_mst", code: "cust_code", name: "cust_name" },
  SUPPLIERS: { table: "sup_mst", code: "sup_code", name: "sup_name" },
  ACCOUNTS:  { table: "acc_mst", code: "acc_code", name: "acc_head" },
};

// Words that carry no identity in an account name
const STOP = new Set([
  "LLC", "L", "C", "LTD", "LIMITED", "CO", "COMPANY", "EST", "ESTABLISHMENT",
  "FZE", "FZCO", "FZ", "FZC", "FZLLC", "DMCC", "WLL", "PVT", "INC", "PLC", "SA", "SARL",
  "THE", "AND", "OF", "MS", "MESSRS", "M", "S", "GENERAL", "GEN",
  "ACCOUNT", "ACCOUNTS", "AC", "A", "LEDGER", "STATEMENT", "FOR", "TO", "FROM",
]);

// Spoken forms that speech recognition leaves in the text
const SPOKEN_FIX = [
  [/\bM\s*\/?\s*S\b/g, " "],            // M/s, M s
  [/\bMESSRS\b/g, " "],
  [/\bDOUBLE\s+([A-Z])\b/g, "$1$1"],     // "double L" -> LL
  [/\bTRIPLE\s+([A-Z])\b/g, "$1$1$1"],
  [/\bDASH\b|\bHYPHEN\b/g, " "],
];
const DIGIT_WORD = {
  ZERO: "0", OH: "0", O: "0", ONE: "1", TWO: "2", THREE: "3", FOUR: "4",
  FIVE: "5", SIX: "6", SEVEN: "7", EIGHT: "8", NINE: "9", DOUBLE: "", NOUGHT: "0",
};

// ── Text helpers ────────────────────────────────────────────────────────────
const norm = (s) => {
  let t = String(s || "").toUpperCase().replace(/&/g, " AND ").replace(/[^A-Z0-9]+/g, " ").trim();
  for (const [re, to] of SPOKEN_FIX) t = t.replace(re, to);
  return t.replace(/\s+/g, " ").trim();
};

// Spelled-out letters are joined: "A B B" -> ABB, "L L C" -> LLC (then dropped)
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

// Soundex — catches speech spellings the edit distance misses (GULPH/GULF, CO-OP/COOP)
function soundex(word) {
  const w = String(word || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (!w) return "";
  const code = (c) => ("BFPV".includes(c) ? "1" : "CGJKQSXZ".includes(c) ? "2"
    : "DT".includes(c) ? "3" : c === "L" ? "4" : "MN".includes(c) ? "5" : c === "R" ? "6" : "");
  let out = w[0];
  let prev = code(w[0]);
  for (let i = 1; i < w.length && out.length < 4; i++) {
    const c = code(w[i]);
    if (c && c !== prev) out += c;
    if (!"HW".includes(w[i])) prev = c;
  }
  return (out + "000").slice(0, 4);
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return m || n;
  if (Math.abs(m - n) > 3) return Math.abs(m - n);   // far apart — skip the matrix
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
  let best = 0;
  if (short.length >= 3 && long.startsWith(short)) best = 0.88;           // LIGHT ~ LIGHTS
  if (short.length >= 3) {
    const sim = 1 - levenshtein(q, t) / Math.max(q.length, t.length);
    if (sim >= 0.7) best = Math.max(best, sim * 0.85);                     // SCHNIEDER ~ SCHNEIDER, RACK ~ RAK
  }
  if (short.length >= 3 && soundex(q) === soundex(t)) best = Math.max(best, 0.72);  // GULPH ~ GULF
  return best;
}

// Rare words identify an account; common ones (TRADING, GENERAL, AL) barely narrow it.
// idf is a Map of token -> weight built from the master; absent tokens get the max weight.
const idfWeight = (idf, token) => (idf ? (idf.get(token) ?? idf.maxWeight ?? 1) : 1);

/**
 * Similarity of a spoken query to one account name (0..1).
 * qt / nt are pre-tokenised; idf is the master's token weights.
 */
function scoreTokens(qt, nt, idf) {
  if (!qt.length || !nt.length) return 0;
  const qc = qt.join(""), nc = nt.join("");
  if (qc === nc) return 1;

  let gotWeight = 0, totWeight = 0;
  const used = new Set();
  for (const q of qt) {
    const w = idfWeight(idf, q);
    totWeight += w;
    let best = 0, bestIdx = -1;
    nt.forEach((t, i) => {
      if (used.has(i)) return;
      const sc = tokenScore(q, t);
      if (sc > best) { best = sc; bestIdx = i; }
    });
    if (bestIdx >= 0 && best > 0) { used.add(bestIdx); gotWeight += best * w; }
  }
  const recall = totWeight ? gotWeight / totWeight : 0;         // did every spoken word land?
  // Long digit runs inside a name (an embedded bank account number) are never
  // spoken, so they don't count against how much of the name was covered.
  const spoken = nt.filter((t) => !(/^\d{5,}$/.test(t)));
  const coverage = used.size / Math.max(spoken.length, 1);
  let score = 0.78 * recall + 0.22 * coverage;

  if (qc.length >= 4 && nc.startsWith(qc)) score = Math.max(score, 0.9);  // "ALHAYAT" vs "AL HAYAT ELECT"
  if (qt.length >= 2 && recall >= 0.995) score = Math.max(score, 0.88);   // every spoken word matched
  return Math.round(Math.min(score, 0.99) * 1000) / 1000;
}

// Kept for direct use / tests
const nameScore = (query, name, idf) => scoreTokens(tokens(query), tokens(name), idf);

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
// Turns Google's 429 body into one readable line: which quota, and when to retry.
function quotaDetail(body) {
  try {
    const err = JSON.parse(body)?.error || {};
    const details = err.details || [];
    const failure = details.find((d) => /QuotaFailure/.test(d["@type"] || ""));
    const retry = details.find((d) => /RetryInfo/.test(d["@type"] || ""));
    const id = failure?.violations?.[0]?.quotaId || "";
    const perDay = /PerDay/i.test(id);
    const secs = retry?.retryDelay ? parseInt(String(retry.retryDelay), 10) : null;
    const scope = perDay ? "daily quota used up" : id ? "per-minute quota hit" : "quota exceeded";
    const when = perDay
      ? " — it resets at midnight US Pacific (about 12:30 PM UAE time)"
      : secs
        ? ` — try again in about ${secs} second${secs === 1 ? "" : "s"}`
        : " — try again shortly";
    return scope + when;
  } catch (_) {
    return "quota exceeded";
  }
}

async function geminiJson(prompt) {
  if (typeof fetch !== "function") {
    throw new Error("This Node build has no global fetch (needs Node 18 or newer).");
  }
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
    if (resp.status === 404) { lastErr = new Error(`model ${model} not found`); continue; }
    if (resp.status === 429) {
      // Quotas are counted per model, so the next one may still have room
      lastErr = new Error(`${model}: ${quotaDetail(await resp.text())}`);
      continue;
    }
    if (!resp.ok) {
      const body = (await resp.text()).replace(/\s+/g, " ").slice(0, 160);
      throw new Error(`Gemini HTTP ${resp.status} (${model}): ${body}`);
    }
    const data = await resp.json();
    const raw = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
    if (!raw.trim()) throw new Error(`${model} returned nothing (blocked or empty response)`);
    try {
      return JSON.parse(raw.replace(/```json|```/g, "").trim());
    } catch (_) {
      throw new Error(`${model} did not return JSON: ${raw.replace(/\s+/g, " ").slice(0, 120)}`);
    }
  }
  throw new Error(`No Gemini model answered (tried ${GEMINI_MODELS.join(", ")})${lastErr ? ` — last: ${lastErr.message}` : ""}`);
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

// ── Local fallback parser ───────────────────────────────────────────────────
// Reads the common request shapes without Gemini, so a spent quota or an API
// outage doesn't take the feature down. Same output shape as the AI.
const MONTHS = {
  JAN: 0, JANUARY: 0, FEB: 1, FEBRUARY: 1, MAR: 2, MARCH: 2, APR: 3, APRIL: 3,
  MAY: 4, JUN: 5, JUNE: 5, JUL: 6, JULY: 6, AUG: 7, AUGUST: 7,
  SEP: 8, SEPT: 8, SEPTEMBER: 8, OCT: 9, OCTOBER: 9, NOV: 10, NOVEMBER: 10, DEC: 11, DECEMBER: 11,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");

const isoOf = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const monthStart = (y, m) => new Date(y, m, 1);
const monthEnd = (y, m) => new Date(y, m + 1, 0);

// "01/07/2026", "1-7-26", "1st July 2026", "July 2026", "July"
function parseOneDate(str, today, endOfPeriod) {
  const t = String(str || "").toUpperCase().trim();
  // Separators may be spaces: norm() has already turned 01/07/2026 into "01 07 2026"
  let m = /^(\d{1,2})[\s\/\-.]+(\d{1,2})[\s\/\-.]+(\d{2,4})$/.exec(t);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    const d = new Date(y, Number(m[2]) - 1, Number(m[1]));
    return isNaN(d.getTime()) ? null : d;
  }
  m = new RegExp(`^(\\d{1,2})(?:ST|ND|RD|TH)?\\s+(${MONTH_RE})\\s*(\\d{4})?$`).exec(t)
    || new RegExp(`^(${MONTH_RE})\\s+(\\d{1,2})(?:ST|ND|RD|TH)?\\s*(\\d{4})?$`).exec(t);
  if (m) {
    const dayFirst = /^\d/.test(m[1]);
    const day = Number(dayFirst ? m[1] : m[2]);
    const mon = MONTHS[dayFirst ? m[2] : m[1]];
    const year = Number(m[3]) || today.getFullYear();
    return new Date(year, mon, day);
  }
  m = new RegExp(`^(${MONTH_RE})\\s*(\\d{4})?$`).exec(t);
  if (m) {
    const mon = MONTHS[m[1]];
    const year = Number(m[2]) || today.getFullYear();
    return endOfPeriod ? monthEnd(year, mon) : monthStart(year, mon);
  }
  m = /^(20\d{2})$/.exec(t);
  if (m) return endOfPeriod ? new Date(Number(m[1]), 11, 31) : new Date(Number(m[1]), 0, 1);
  return null;
}

function parseLocally(text, today = new Date()) {
  let t = ` ${norm(text)} `;
  const eat = (re) => { t = t.replace(re, " "); };

  // Ledger type
  let ledgerType = null;
  if (/\b(CUSTOMER|CUSTOMERS|CLIENT|DEBTOR|RECEIVABLE|RECEIVABLES)\b/.test(t)) ledgerType = "CUSTOMER";
  else if (/\b(SUPPLIER|SUPPLIERS|VENDOR|CREDITOR|PAYABLE|PAYABLES)\b/.test(t)) ledgerType = "SUPPLIER";
  else if (/\b(GL|G L|GENERAL LEDGER|NOMINAL)\b/.test(t)) ledgerType = "GL";
  eat(/\b(CUSTOMERS?|CLIENT|DEBTOR|RECEIVABLES?|SUPPLIERS?|VENDOR|CREDITOR|PAYABLES?|GL|G L|GENERAL LEDGER|NOMINAL)\b/g);

  // Period
  const y = today.getFullYear(), mo = today.getMonth(), q = Math.floor(mo / 3);
  let from = null, to = null;

  const range = new RegExp(
    `\\b(?:FROM|BETWEEN)\\s+(.+?)\\s+(?:TO|TILL|UNTIL|UPTO|UP TO|AND)\\s+(.+?)(?=\\s+(?:FOR|OF|LEDGER|ACCOUNT|STATEMENT)\\b|\\s*$)`
  ).exec(t);
  if (range) {
    const a = parseOneDate(range[1], today, false);
    const b = /^(TODAY|DATE|TILL DATE)$/i.test(range[2].trim()) ? today : parseOneDate(range[2], today, true);
    if (a || b) { from = a; to = b; eat(new RegExp(range[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")); }
  }

  if (!from && !to) {
    const rel = [
      [/\bLAST MONTH\b/, () => [monthStart(y, mo - 1), monthEnd(y, mo - 1)]],
      [/\b(THIS|CURRENT) MONTH\b/, () => [monthStart(y, mo), today]],
      [/\bLAST YEAR\b/, () => [new Date(y - 1, 0, 1), new Date(y - 1, 11, 31)]],
      [/\b(THIS|CURRENT) YEAR\b/, () => [new Date(y, 0, 1), today]],
      [/\bLAST QUARTER\b/, () => [monthStart(y, (q - 1) * 3), monthEnd(y, (q - 1) * 3 + 2)]],
      [/\b(THIS|CURRENT) QUARTER\b/, () => [monthStart(y, q * 3), today]],
      [/\bLAST (\d{1,2}) MONTHS?\b/, (m) => [monthStart(y, mo - Number(m[1])), today]],
      [/\bLAST (\d{1,3}) DAYS?\b/, (m) => [new Date(y, mo, today.getDate() - Number(m[1])), today]],
      [/\bYEAR TO DATE\b|\bYTD\b/, () => [new Date(y, 0, 1), today]],
      [new RegExp(`\\bQ([1-4])\\s*(\\d{4})?\\b`), (m) => {
        const yy = Number(m[2]) || y, qq = Number(m[1]) - 1;
        return [monthStart(yy, qq * 3), monthEnd(yy, qq * 3 + 2)];
      }],
    ];
    for (const [re, fn] of rel) {
      const m = re.exec(t);
      if (m) { [from, to] = fn(m); eat(new RegExp(m[0], "g")); break; }
    }
  }

  if (!from && !to) {
    const since = new RegExp(`\\bSINCE\\s+(.+?)(?=\\s+(?:FOR|OF|LEDGER|ACCOUNT|STATEMENT)\\b|\\s*$)`).exec(t);
    if (since) {
      const a = parseOneDate(since[1], today, false);
      if (a) { from = a; to = today; eat(new RegExp(since[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")); }
    }
  }

  if (!from && !to) {
    const upto = new RegExp(`\\b(?:TILL|UNTIL|UPTO|UP TO|AS ON|AS OF)\\s+(.+?)(?=\\s+(?:FOR|OF|LEDGER|ACCOUNT|STATEMENT)\\b|\\s*$)`).exec(t);
    if (upto) {
      const b = /^(TODAY|DATE)$/i.test(upto[1].trim()) ? today : parseOneDate(upto[1], today, true);
      if (b) { to = b; eat(new RegExp(upto[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")); }
    }
  }

  if (!from && !to) {
    // A bare month name or year: "March", "March 2025", "2025"
    const bare = new RegExp(`\\b(${MONTH_RE})\\s*(\\d{4})?\\b|\\b(20\\d{2})\\b`).exec(t);
    if (bare) {
      from = parseOneDate(bare[0], today, false);
      to = parseOneDate(bare[0], today, true);
      if (from) eat(new RegExp(bare[0], "g"));
    }
  }

  // Whatever is left, minus filler, is the account
  eat(/\b(LEDGER|ACCOUNT|ACCOUNTS|STATEMENT|SHOW|DISPLAY|OPEN|GET|FETCH|PLEASE|GIVE|ME|THE|A|OF|FOR|FROM|TO|PERIOD|DATED|BETWEEN|AND|ALL|TRANSACTIONS|ENTRIES|IN|ON|DURING|WITH)\b/g);
  const accountText = t.replace(/\s+/g, " ").trim();

  return {
    ledgerType,
    accountText: accountText || null,
    fromDate: from ? isoOf(from) : null,
    toDate: to ? isoOf(to) : null,
  };
}

// ── Account lookup ──────────────────────────────────────────────────────────
// The three masters are held in memory (about 11,000 names in total) and every
// row is scored, so a misheard word can't push the right account out of the
// result the way a SQL LIKE would. Rebuilt on a timer; see MASTER_TTL_MS.
const MASTER_TTL_MS = 5 * 60 * 1000;

module.exports = function (connection) {
  const router = express.Router();
  const db = typeof connection.promise === "function" ? connection.promise() : connection;

  const masterCache = {};   // type -> { at, rows, byCode, idf }
  const loading = {};       // type -> in-flight promise

  function buildIndex(rows) {
    const prepared = rows
      .map((r) => {
        const code = String(r.code ?? "").trim();
        const name = String(r.name ?? "").trim();
        return { code, name, tokens: tokens(name), compact: compact(name) };
      })
      .filter((r) => r.code);

    // Document frequency per token -> idf weight
    const df = new Map();
    for (const r of prepared) {
      for (const t of new Set(r.tokens)) df.set(t, (df.get(t) || 0) + 1);
    }
    const n = Math.max(prepared.length, 1);
    const idf = new Map();
    let maxWeight = 1;
    for (const [t, c] of df) {
      const w = Math.log(1 + n / c);
      idf.set(t, w);
      if (w > maxWeight) maxWeight = w;
    }
    idf.maxWeight = maxWeight;

    const byCode = new Map();
    for (const r of prepared) byCode.set(r.code.replace(/\s+/g, "").toUpperCase(), r);

    // Inverted index: exact token, 3-letter stem and soundex all point at the
    // rows worth scoring, so a query never walks the whole master.
    const postings = new Map();
    const add = (key, i) => {
      if (!key) return;
      const list = postings.get(key);
      if (list) list.push(i); else postings.set(key, [i]);
    };
    prepared.forEach((r, i) => {
      for (const t of new Set(r.tokens)) {
        add(`=${t}`, i);
        add(`~${t.slice(0, 3)}`, i);
        add(`#${soundex(t)}`, i);
      }
    });
    return { rows: prepared, byCode, idf, postings };
  }

  function getMaster(type) {
    const cached = masterCache[type];
    if (cached && Date.now() - cached.at < MASTER_TTL_MS) return Promise.resolve(cached);
    if (loading[type]) return loading[type];

    const m = MASTERS[type];
    loading[type] = db
      .query(`SELECT ${m.code} AS code, ${m.name} AS name FROM ${m.table}`)
      .then(([rows]) => {
        const built = { at: Date.now(), ...buildIndex(rows) };
        masterCache[type] = built;
        return built;
      })
      .catch((err) => {
        if (cached) return cached;   // a stale list beats no list
        throw err;
      })
      .finally(() => { delete loading[type]; });
    return loading[type];
  }

  // Spoken digits -> figures, for a dictated account code ("one G zero zero one zero")
  const spokenCode = (raw) => {
    const parts = norm(raw).split(" ").filter(Boolean);
    if (!parts.length) return "";
    const mapped = parts.map((p) => (DIGIT_WORD[p] !== undefined ? DIGIT_WORD[p] : p));
    return mapped.join("");
  };

  async function findInMaster(type, accountText) {
    const raw = String(accountText || "").trim();
    if (!raw) return [];
    const { rows, byCode, idf, postings } = await getMaster(type);

    // 1. A code, typed or dictated — an exact hit wins outright
    for (const key of new Set([raw.replace(/\s+/g, "").toUpperCase(), spokenCode(raw)])) {
      const hit = key && byCode.get(key);
      if (hit) return [{ type, code: hit.code, name: hit.name, score: 1 }];
    }

    // 2. Name — score the rows that share a token, stem or sound with the query
    const qt = tokens(raw);
    if (!qt.length) return [];

    const seen = new Set();
    for (const q of qt) {
      for (const key of [`=${q}`, `~${q.slice(0, 3)}`, `#${soundex(q)}`]) {
        const list = postings.get(key);
        if (list) for (const i of list) seen.add(i);
      }
    }

    const out = [];
    for (const i of seen) {
      const r = rows[i];
      const score = scoreTokens(qt, r.tokens, idf);
      if (score >= 0.4) out.push({ type, code: r.code, name: r.name, score });
    }
    return out;
  }

  // Warm the caches so the first enquiry of the day isn't the slow one
  Promise.all(Object.keys(MASTERS).map((t) => getMaster(t).catch(() => null)))
    .then(() => console.log("[ledger-ai] account masters loaded"))
    .catch(() => undefined);

  // GET /api/ledger-ai/health — says whether the key, the model and the
  // account masters are all in working order. Safe to curl from the VPS.
  router.get("/ledger-ai/health", async (_req, res) => {
    const out = {
      geminiKey: GEMINI_KEY ? `set (${GEMINI_KEY.length} chars)` : "MISSING",
      modelsTried: GEMINI_MODELS,
      nodeFetch: typeof fetch === "function",
      masters: {},
      gemini: "not tested",
    };
    for (const t of Object.keys(MASTERS)) {
      try {
        const { rows } = await getMaster(t);
        out.masters[t] = `${rows.length} rows`;
      } catch (err) {
        out.masters[t] = `ERROR: ${err.message}`;
      }
    }
    if (GEMINI_KEY) {
      try {
        const probe = await geminiJson('Return ONLY this JSON: {"ok": true}');
        out.gemini = probe && probe.ok ? "ok" : `unexpected reply: ${JSON.stringify(probe).slice(0, 80)}`;
      } catch (err) {
        out.gemini = `ERROR: ${err.message}`;
      }
    }
    res.json(out);
  });

  router.post("/ledger-ai/parse", async (req, res) => {
    const text = String(req.body?.text || "").trim();
    if (text.length < 3) return res.status(400).json({ error: "Say or type what ledger you want to see." });
    if (!GEMINI_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY is not set on the server (check the backend .env, then pm2 restart)." });
    }

    let ai;
    let aiNote = "";
    if (GEMINI_KEY) {
      try {
        ai = await geminiJson(buildPrompt(text));
      } catch (err) {
        console.error("ledger-ai gemini:", err.message);
        aiNote = String(err.message || "").slice(0, 180);
      }
    } else {
      aiNote = "GEMINI_API_KEY is not set on the server";
    }

    // Gemini unavailable (quota, outage, no key) — read it here instead
    if (!ai) {
      const local = parseLocally(text);
      const gotSomething = local.ledgerType || local.accountText || local.fromDate || local.toDate;
      if (!gotSomething) {
        return res.status(502).json({ error: `The AI could not read that request. ${aiNote}` });
      }
      ai = local;
    }

    const typeMap = { CUSTOMER: "CUSTOMERS", SUPPLIER: "SUPPLIERS", GL: "ACCOUNTS" };
    const statedType = typeMap[String(ai?.ledgerType || "").toUpperCase()] || null;
    let fromDate = validIso(ai?.fromDate);
    let toDate = validIso(ai?.toDate);
    if (fromDate && toDate && fromDate > toDate) [fromDate, toDate] = [toDate, fromDate];
    const accountText = ai?.accountText ? String(ai.accountText).trim() : "";

    const out = {
      ledgerType: statedType, fromDate, toDate,
      accountText: accountText || null,
      match: null, candidates: [], message: "",
      source: aiNote ? "local" : "ai",
      aiNote,
    };

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
module.exports._parseLocally = parseLocally;
module.exports._tokens = tokens;
module.exports._soundex = soundex;
