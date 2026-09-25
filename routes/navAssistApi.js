// routes/navAssistApi.js
// "Find a screen" assistant — maps a typed request to an entry in the ERP menu, using Gemini.
// Navigation only: it never saves, posts or reads business data.
//
// Register in HayatDb.js:
//   app.use("/api", require("./routes/navAssistApi")(connection));
//
// .env on the VPS (reuse the key you already use for Gemini):
//   GEMINI_API_KEY=...
//   NAV_ASSIST_MODEL=gemini-3.8-flash      (optional; this is the default)
//   NAV_ASSIST_FALLBACK_MODEL=...           (optional; tried when the main model is busy)
//
// Needs Node 18+ (global fetch).

const express = require("express");

const MODEL = process.env.NAV_ASSIST_MODEL || "gemini-3.8-flash";
// Optional second model with its own quota, tried when the main one is busy
// (e.g. a flash-lite model). Leave unset to skip.
const FALLBACK_MODEL = process.env.NAV_ASSIST_FALLBACK_MODEL || "";
const MAX_ITEMS = 800;
const MAX_MATCHES = 5;
const TIMEOUT_MS = 10000;   // per attempt

const SYSTEM_PROMPT = `You help users of Telltron ERP, a manufacturing and trading ERP used in the UAE, open the right screen or report.

You are given the menu catalogue, one entry per line: id|label|menu path|other names.
Rules:
- Choose only ids from the catalogue. Never invent an id.
- When the request clearly points to one screen, return just that id.
- When several screens could fit (e.g. "invoice" could be sales, proforma, manufacturing or purchase invoice; "D/O entry" exists under Trading and Manufacturing), return up to ${MAX_MATCHES} ids, best first.
- When nothing fits, return an empty list and say so in reply.
- You only open screens. You cannot create, change, post or delete anything. If asked to do something, return the screen where the user can do it.

Common abbreviations: A/c = account; GL or G/L = general ledger; TB = trial balance; P&L = profit and loss; B/S = balance sheet; PDC = post-dated cheque; LPO = local purchase order; FPO = foreign purchase order; SRV = store receipt voucher (goods receipt); SIV = store issue voucher; D/O or DO = delivery order; RV / B.RV = receipt voucher; PV / B.PV = payment voucher; JV = journal voucher; NGP = non-goods purchase; SOA = statement of account; register = list/report of entries.

If the user names a transaction type (e.g. journal, bank payment, BR, PV), put its code from the transaction-type list in params.tran_type; leave it empty if more than one code could fit.
If the user names an account, customer or supplier, put the name in params.account exactly as typed (without words like "customer" or "supplier"). If they give a date or period, or a document number, fill those params too. Write dates as dd/MM/yyyy, resolving words like "last month" or "this year" against today's date given in the message. Leave params empty otherwise.
Keep reply to one short sentence.`;

// Gemini structured output — the model must return exactly this JSON shape.
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    ids: { type: "ARRAY", items: { type: "INTEGER" } },
    params: {
      type: "OBJECT",
      properties: {
        account: { type: "STRING" },
        from_date: { type: "STRING" },
        to_date: { type: "STRING" },
        doc_no: { type: "STRING" },
        tran_type: { type: "STRING" },
      },
    },
    reply: { type: "STRING" },
  },
  required: ["ids", "reply"],
};

const clean = (v) => String(v ?? "").replace(/[|\r\n]+/g, " ").trim().slice(0, 160);

// Account type from the code pattern: GL = digits and hyphens; customer = letters in 2nd and 3rd chars;
// supplier = letter in 2nd char, digit in 3rd.
const accTypeOf = (code) => {
  const c = String(code || "").trim();
  if (/^[0-9-]+$/.test(c)) return "GL";
  if (/^.[A-Za-z][A-Za-z]/.test(c)) return "CUS";
  if (/^.[A-Za-z][0-9]/.test(c)) return "SUP";
  return "GL";
};
const squash = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const likeEsc = (s) => s.replace(/[\\%_]/g, "\\$&");

// tran_type is tiny and rarely changes — cache it for 10 minutes.
let tranTypeCache = { at: 0, rows: [] };
const loadTranTypes = (connection) =>
  new Promise((resolve) => {
    if (Date.now() - tranTypeCache.at < 10 * 60 * 1000 && tranTypeCache.rows.length) return resolve(tranTypeCache.rows);
    connection.query(
      `SELECT TRAN_TYPE, TYPE_DES, TYPE_ABBR FROM tran_type WHERE TYPE_DES IS NOT NULL ORDER BY TRAN_TYPE`,
      (err, rows) => {
        if (err) {
          console.error("nav-assist tran_type:", err.message);
          return resolve(tranTypeCache.rows); // stale is better than nothing
        }
        tranTypeCache = {
          at: Date.now(),
          rows: (rows || []).map((r) => ({
            code: String(r.TRAN_TYPE).trim(),
            des: String(r.TYPE_DES || "").trim(),
            abbr: String(r.TYPE_ABBR || "").trim(),
          })),
        };
        resolve(tranTypeCache.rows);
      }
    );
  });

module.exports = function (connection) {
  const router = express.Router();

  // ── Transaction types, for the bot's local matching ────────────────────────
  router.get("/nav-assist/trantypes", async (req, res) => {
    res.json({ rows: await loadTranTypes(connection) });
  });

  // ── Which transaction types hold a voucher no. ─────────────────────────────
  // GET /api/nav-assist/voucher?no=2374&types=01,03
  // Matches the number as typed and zero-padded to 10 ("0000002374").
  router.get("/nav-assist/voucher", (req, res) => {
    const no = String(req.query.no || "").trim().slice(0, 20);
    const types = String(req.query.types || "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => /^[0-9A-Za-z]{1,4}$/.test(t));
    if (!/^[0-9A-Za-z/-]+$/.test(no)) return res.json({ rows: [] });

    const sql = `
      SELECT a.TRAN_TYPE, a.VCHR_NO, DATE_FORMAT(MIN(a.DATTE), '%d/%m/%Y') AS DATTE, t.TYPE_DES, t.TYPE_ABBR
        FROM tran_acc a
        LEFT JOIN tran_type t ON t.TRAN_TYPE = a.TRAN_TYPE
       WHERE a.VCHR_NO IN (?, LPAD(?, 10, '0'))
         ${types.length ? `AND a.TRAN_TYPE IN (${types.map(() => "?").join(",")})` : ""}
       GROUP BY a.TRAN_TYPE, a.VCHR_NO, t.TYPE_DES, t.TYPE_ABBR
       ORDER BY a.TRAN_TYPE
       LIMIT 10`;
    connection.query(sql, [no, no, ...types], (err, rows) => {
      if (err) {
        console.error("nav-assist voucher:", err.message);
        return res.status(500).json({ error: "Voucher lookup failed." });
      }
      res.json({
        rows: (rows || []).map((r) => ({
          code: String(r.TRAN_TYPE).trim(),
          des: String(r.TYPE_DES || "").trim(),
          abbr: String(r.TYPE_ABBR || "").trim(),
          vchr: String(r.VCHR_NO).trim(),
          date: r.DATTE || "",
        })),
      });
    });
  });

  // ── Default period for account screens opened without dates ────────────────
  // The ac_period row that contains today (else the latest one): from its start date
  // up to today, or its end date if that period is already over.
  router.get("/nav-assist/period", (req, res) => {
    const sql = `
      SELECT DATE_FORMAT(START_DATE, '%d/%m/%Y') AS from_date,
             DATE_FORMAT(LEAST(END_DATE, CURDATE()), '%d/%m/%Y') AS to_date
        FROM ac_period
       WHERE START_DATE IS NOT NULL AND END_DATE IS NOT NULL
       ORDER BY (CURDATE() BETWEEN START_DATE AND END_DATE) DESC, START_DATE DESC
       LIMIT 1`;
    connection.query(sql, (err, rows) => {
      if (err) {
        console.error("nav-assist period:", err.message);
        return res.status(500).json({ error: "Period lookup failed." });
      }
      return res.json(rows?.[0] || {});
    });
  });

  // ── Account lookup for "screen + account" requests (no AI) ─────────────────
  // GET /api/nav-assist/accounts?q=newtech pools&types=CUS,SUP
  router.get("/nav-assist/accounts", (req, res) => {
    const q = String(req.query.q || "").trim().slice(0, 80);
    const types = String(req.query.types || "").split(",").filter((t) => ["GL", "CUS", "SUP"].includes(t));
    const words = q.split(/\s+/).filter(Boolean).slice(0, 5);
    const qs = squash(q);
    if (qs.length < 2) return res.json({ rows: [] });

    // Match on every word, OR on the name with spaces/dots/hyphens removed
    // ("newtech pools" finds "NEW TECH POOLS L.L.C"), OR on the exact code.
    const sql = `
      SELECT AC_CODE, AC_HEAD FROM ac_list
       WHERE AC_CODE = ?
          OR (${words.map(() => "AC_HEAD LIKE ?").join(" AND ")})
          OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(UPPER(AC_HEAD), ' ', ''), '.', ''), '-', ''), '&', ''), ',', ''), '/', '') LIKE ?
       ORDER BY (AC_CODE = ?) DESC, LENGTH(AC_HEAD)
       LIMIT 60`;
    const params = [q, ...words.map((w) => `%${likeEsc(w)}%`), `%${likeEsc(qs)}%`, q];

    connection.query(sql, params, (err, rows) => {
      if (err) {
        console.error("nav-assist accounts:", err.message);
        return res.status(500).json({ error: "Account lookup failed." });
      }
      const out = (rows || [])
        .map((r) => {
          const code = String(r.AC_CODE).trim();
          const name = String(r.AC_HEAD || "").trim();
          const sq = squash(name);
          return {
            code,
            name,
            type: accTypeOf(code),
            exact: code.toUpperCase() === q.toUpperCase() || sq === qs,
            starts: sq.startsWith(qs),
          };
        })
        .filter((r) => !types.length || types.includes(r.type))
        .sort((a, b) => b.exact - a.exact || b.starts - a.starts || a.name.length - b.name.length)
        .slice(0, 8)
        .map(({ starts, ...r }) => r);
      return res.json({ rows: out });
    });
  });

  router.post("/nav-assist", async (req, res) => {
    const query = String(req.body?.query || "").trim().slice(0, 300);
    const today = clean(req.body?.today) || new Date().toLocaleDateString("en-GB");
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, MAX_ITEMS) : [];

    if (!query) return res.status(400).json({ error: "Type the screen or report you want." });
    if (!items.length) return res.status(400).json({ error: "No menu entries were sent." });
    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({ error: "The assistant is not set up on the server (GEMINI_API_KEY missing)." });
    }

    const catalogue = items
      .map((it, i) => `${i}|${clean(it.label)}|${clean(it.breadcrumb)}|${clean(it.keywords)}`)
      .join("\n");
    const tranTypes = (await loadTranTypes(connection))
      .map((t) => `${t.code}|${t.des}|${t.abbr}`)
      .join("\n");

    const body = (model) => {
      const generationConfig = {
        maxOutputTokens: 400,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      };
      // 2.5 Flash / Flash-Lite think by default; a menu lookup doesn't need it and answers faster without.
      if (/^gemini-2\.5-flash/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
      // Gemini 3.x is tuned for its default temperature; forcing 0 there can degrade answers. Only pin it on 2.x.
      if (/^gemini-2\./.test(model)) generationConfig.temperature = 0;
      return JSON.stringify({
        systemInstruction: {
          parts: [{ text: `${SYSTEM_PROMPT}\n\nCatalogue:\n${catalogue}\n\nTransaction types (code|description|abbreviation):\n${tranTypes}` }],
        },
        contents: [{ role: "user", parts: [{ text: `Today is ${today}.\nRequest: ${query}` }] }],
        generationConfig,
      });
    };

    // Busy (503), rate-limited (429) or a passing 500: wait briefly and retry once,
    // then try the fallback model (separate quota), if one is set.
    const attempts = [
      { model: MODEL, wait: 0 },
      { model: MODEL, wait: 900 },
      ...(FALLBACK_MODEL && FALLBACK_MODEL !== MODEL ? [{ model: FALLBACK_MODEL, wait: 0 }] : []),
    ];
    const RETRYABLE = new Set([429, 500, 503]);

    try {
      let resp = null;
      let usedModel = MODEL;
      let lastStatus = 0;
      let lastReason = "";

      for (const a of attempts) {
        if (a.wait) await new Promise((r) => setTimeout(r, a.wait));
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        try {
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${a.model}:generateContent`, {
            method: "POST",
            signal: ctrl.signal,
            headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
            body: body(a.model),
          });
          if (r.ok) { resp = r; usedModel = a.model; break; }

          const detail = await r.text();
          console.error("nav-assist: Gemini error", r.status, a.model, detail.slice(0, 800));
          lastStatus = r.status;
          try { lastReason = JSON.parse(detail)?.error?.message || ""; } catch { lastReason = detail; }
          lastReason = `${a.model}: ${lastReason}`;
          if (!RETRYABLE.has(r.status)) break;   // a real error (bad model, key) — retrying won't help
        } catch (err) {
          console.error("nav-assist:", a.model, err.message);
          lastStatus = 504;
          lastReason = `${a.model}: ${err.name === "AbortError" ? "took too long to answer" : "could not be reached"}`;
        } finally {
          clearTimeout(timer);
        }
      }

      if (!resp) {
        // Show Google's own reason (model not found, key restricted, busy...) — never includes the key.
        // busy: true lets the bot fall back to the closest menu matches instead of just an error.
        return res.status(502).json({
          error: `Gemini ${lastStatus} (${clean(lastReason).slice(0, 160) || "no details"})`,
          busy: RETRYABLE.has(lastStatus) || lastStatus === 504,
        });
      }
      if (usedModel !== MODEL) console.log("nav-assist: answered by fallback model", usedModel);

      const data = await resp.json();
      const text = (data?.candidates?.[0]?.content?.parts || [])
        .map((p) => p.text || "")
        .join("");

      let out = {};
      try {
        out = JSON.parse(text.replace(/```json|```/g, "").trim());
      } catch {
        console.error("nav-assist: unparseable reply", text.slice(0, 300), data?.promptFeedback || "");
        return res.status(502).json({ error: "The assistant gave an unreadable answer. Try rephrasing." });
      }

      // Keep only valid, unique ids that exist in what the client sent.
      const seen = new Set();
      const ids = (Array.isArray(out.ids) ? out.ids : [])
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 0 && n < items.length && !seen.has(n) && seen.add(n))
        .slice(0, MAX_MATCHES);

      const p = out.params || {};
      const params = {};
      for (const k of ["account", "from_date", "to_date", "doc_no", "tran_type"]) {
        if (p[k]) params[k] = clean(p[k]);
      }

      return res.json({ ids, params, reply: clean(out.reply) || "" });
    } catch (err) {
      console.error("nav-assist:", err.message);
      return res.status(504).json({ error: "The assistant could not be reached.", busy: true });
    }
  });

  return router;
};
