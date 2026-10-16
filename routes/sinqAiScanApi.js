// E:\hayatApi\routes\sinqAiScanApi.js — AI Scan for Sales Inquiry / RFQ Entry (SALESINQ)
//
//   POST /api/ai/sinq_scan     multipart, field "file"
//        PDF / image  → sent to Gemini as-is (Gemini reads PDFs natively)
//        XLS / XLSX / CSV → every sheet turned into CSV text, then sent to Gemini
//        EML / TXT    → read as text (an enquiry e-mail saved to disk)
//   Returns { header, items, notes, customer, source, model }
//
// Register in HayatDb.js AFTER authMiddleware:
//   const sinqAiScanApi = require("./routes/sinqAiScanApi");
//   app.use("/api", sinqAiScanApi(connection));
//
// Needs: npm i @google/genai multer xlsx      (GEMINI_API_KEY in .env)

const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");

// @google/genai is ES-module only — Node 18 can't require() it, so it is
// loaded once with a dynamic import() the first time a scan runs.
let genaiPromise = null;
const loadGenAI = () => {
  if (!genaiPromise) {
    genaiPromise = import("@google/genai").then((m) => m.GoogleGenAI || m.default?.GoogleGenAI);
    genaiPromise.catch(() => { genaiPromise = null; });   // allow a retry after a failed load
  }
  return genaiPromise;
};

const MODELS = [...new Set([
  process.env.GEMINI_MODEL || "gemini-2.5-flash",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash-lite",
])];
const MAX_MB = 15;
const MAX_TEXT_CHARS = 150000;
const MAX_ITEMS = 20;   // the screen's item grid holds 20 rows

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024 } });

// ─── File type ───────────────────────────────────────────────────────────────
const SHEET_EXT = ["xls", "xlsx", "xlsm", "xlsb", "csv", "ods"];
const TEXT_EXT = ["txt", "eml"];
const IMAGE_MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
function kindOf(file) {
  const ext = String(file.originalname || "").split(".").pop().toLowerCase();
  if (ext === "pdf" || file.mimetype === "application/pdf") return { kind: "pdf", mime: "application/pdf" };
  if (SHEET_EXT.includes(ext)) return { kind: "sheet" };
  if (TEXT_EXT.includes(ext)) return { kind: "text" };
  if (IMAGE_MIME[ext]) return { kind: "image", mime: IMAGE_MIME[ext] };
  if (String(file.mimetype).startsWith("image/")) return { kind: "image", mime: file.mimetype };
  return null;
}

const clip = (s) => (s.length > MAX_TEXT_CHARS ? s.slice(0, MAX_TEXT_CHARS) + "\n…(truncated)" : s);

function sheetToText(buf) {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  return clip(wb.SheetNames.map((name) => {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false, dateNF: "dd/mm/yyyy" });
    return `### Sheet: ${name}\n${csv}`;
  }).join("\n\n"));
}

// ─── Prompt ──────────────────────────────────────────────────────────────────
const buildPrompt = (ourName) => `You read customer enquiries / RFQs (request for quotation) received by
${ourName ? `"${ourName}"` : "an electrical switchgear manufacturer"} — e-mails, letters, tender
documents, BOQs and panel schedules — and return ONE JSON object, nothing else:

{
  "header": {
    "INQ_DATE": "", "CLIENT_NAME": "", "CUST_CODE": "", "CUST_REF_NO": "", "OUR_REF": "",
    "CUST_CONTACT_PER": "", "SUBJECT": "", "SCOPE_OF_WORK": "", "CLOSING_DATE": "",
    "FORM_OF_ENQUIRY": "", "ESTIMATED_BY": "", "SALESMAN": "", "ENGINEER": "",
    "SITE_VISITED_BY": "", "INQ_RECEIVED_BY": ""
  },
  "items": [ { "FG_ITEM_DESC": "", "FG_UNIT": "", "QTY": 1 } ],
  "notes": ""
}

Two kinds of document arrive:
 (a) the customer's own enquiry / RFQ / tender / BOQ (e-mail, letter, Excel);
 (b) our own printed "Sales Inquiry / RFQ" form, which has labelled boxes
     (Customer, Contact Details, Cust Ref. No, Our Ref No, Form of Enquiry,
     Quote Req Date, Estimated By, Salesman, Engineer, Site Visited By,
     Received By) and an item table (Sr, FG Code, FG Item Description, Unit, Qty).
     Read each labelled box into the matching field. The Enquiry No, FG Code and
     Sr columns are ours and are NOT returned.

Rules:
- A box shown as "—", "-" or blank is "".
- CLIENT_NAME = the customer. When a "Customer" box is printed, take it from
  there; "1CS0679 - MAK POOLS AND GARDENS LLC" gives CUST_CODE "1CS0679" and
  CLIENT_NAME "MAK POOLS AND GARDENS LLC". Otherwise it is the company SENDING
  the enquiry (letterhead / sender / "From"). ${ourName ? `Never "${ourName}" — that is us, the receiver, even when it is the letterhead.` : "Never the receiving switchgear company."}
  CUST_CODE only if a customer account code is printed.
- ESTIMATED_BY, SALESMAN, ENGINEER, FORM_OF_ENQUIRY: exactly as printed,
  e.g. "01 - STANY D'SOUZA" (code and name) or just a name.
- SITE_VISITED_BY, INQ_RECEIVED_BY, OUR_REF: as printed.
- INQ_DATE = date of the enquiry / RFQ / e-mail. CLOSING_DATE = date the quotation
  is required by (closing / submission / due date). Dates are day-first
  (dd/mm/yyyy); output every date as yyyy-mm-dd. Never a "printed on" date.
- CUST_REF_NO = the customer's own enquiry / RFQ / tender / reference number.
- CUST_CONTACT_PER = the contact person with designation, phone, mobile and e-mail,
  one item per line, as printed.
- SUBJECT = project name / subject line (short, one line).
- SCOPE_OF_WORK = what is asked for, in a few plain sentences (supply, design,
  testing, installation, delivery terms, special requirements). Keep it factual.
- items = every panel / equipment line requested, in document order, across ALL
  pages / sheets. FG_ITEM_DESC is the full description as written, including
  ratings and tags such as "(N-367)"; a description wrapped over two lines is ONE
  item, and a word split by a hyphen at the line end is rejoined. FG_UNIT as
  printed (NOS, SET, LOT, NO …), "" if none. QTY is a number (1 if not shown).
- Skip column headings, totals, signatures, disclaimers and repeated page headers.
- Use "notes" for anything doubtful (unreadable text, more lines than fit, items
  that may be options/alternatives), else "".`;

// ─── Gemini with retry + model fallback (429 / 503 only) ─────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isBusy = (e) => {
  const code = String(e?.status || e?.code || "");
  return code === "429" || code === "503" || /\b(429|503)\b|overloaded|UNAVAILABLE|RESOURCE_EXHAUSTED/i.test(String(e?.message));
};
async function callGemini(ai, parts) {
  let lastErr;
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await ai.models.generateContent({
          model,
          contents: [{ role: "user", parts }],
          config: { responseMimeType: "application/json", temperature: 0 },
        });
        return { text: resp.text, model };
      } catch (e) {
        if (!isBusy(e)) throw e;
        lastErr = e;
        await sleep(2000 * 2 ** attempt);   // 2s, 4s, then next model
      }
    }
  }
  const err = new Error("The AI service is busy — please try again in a minute.");
  err.busy = true;
  err.cause = lastErr;
  throw err;
}

function parseJson(text) {
  const s = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(s); } catch { /* fall through */ }
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
  throw new Error("AI reply was not valid JSON");
}

// ─── Normalising ─────────────────────────────────────────────────────────────
const MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const pad2 = (n) => String(n).padStart(2, "0");
function toIso(v) {
  const s = String(v || "").trim();
  if (!s || s === "-") return "";
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);           // day-first
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    if (Number(m[2]) <= 12 && Number(m[1]) <= 31) return `${y}-${pad2(m[2])}-${pad2(m[1])}`;
  }
  m = s.match(/^(\d{1,2})[\s\-]([A-Za-z]{3})[A-Za-z]*[\s\-,]+(\d{4})$/); // 15-Oct-2026
  if (m && MON[m[2].toUpperCase()]) return `${m[3]}-${pad2(MON[m[2].toUpperCase()])}-${pad2(m[1])}`;
  return "";
}
const clean = (v) => {
  const s = String(v ?? "").trim();
  return s === "-" || s === "—" ? "" : s;
};

function normalise(raw) {
  const h = raw?.header || {};
  const header = {
    INQ_DATE: toIso(h.INQ_DATE),
    CLIENT_NAME: clean(h.CLIENT_NAME).slice(0, 100),
    CUST_CODE: clean(h.CUST_CODE).toUpperCase(),
    CUST_REF_NO: clean(h.CUST_REF_NO),
    OUR_REF: clean(h.OUR_REF),
    CUST_CONTACT_PER: clean(h.CUST_CONTACT_PER),
    SUBJECT: clean(h.SUBJECT).replace(/\s*\n\s*/g, " "),
    SCOPE_OF_WORK: clean(h.SCOPE_OF_WORK),
    CLOSING_DATE: toIso(h.CLOSING_DATE),
    FORM_OF_ENQUIRY: clean(h.FORM_OF_ENQUIRY),
    ESTIMATED_BY: clean(h.ESTIMATED_BY),
    SALESMAN: clean(h.SALESMAN),
    ENGINEER: clean(h.ENGINEER),
    SITE_VISITED_BY: clean(h.SITE_VISITED_BY),
    INQ_RECEIVED_BY: clean(h.INQ_RECEIVED_BY),
  };
  const all = (Array.isArray(raw?.items) ? raw.items : [])
    .map((p) => ({
      FG_ITEM_DESC: clean(p?.FG_ITEM_DESC).replace(/[ \t]+/g, " "),
      FG_UNIT: clean(p?.FG_UNIT).toUpperCase().slice(0, 10),
      QTY: Number(String(p?.QTY ?? "").replace(/[^\d.]/g, "")) || 1,
    }))
    .filter((p) => p.FG_ITEM_DESC);
  return { header, items: all, totalItems: all.length, notes: clean(raw?.notes) };
}

// ─── Customer: by code, else by name against cus_mst ─────────────────────────
const STOP = new Set(["LLC", "L.L.C", "LTD", "CO", "THE", "AND", "FZE", "FZC", "FZCO", "FZ", "EST", "COMPANY", "W.L.L", "WLL"]);
const normName = (s) => String(s || "").toUpperCase()
  .replace(/L\.?\s?L\.?\s?C\.?/g, " LLC ").replace(/&/g, " AND ")
  .replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const sigWords = (s) => normName(s).split(" ").filter((w) => w.length > 1 && !STOP.has(w));
function score(a, b) {
  const A = sigWords(a), B = sigWords(b);
  if (!A.length || !B.length) return 0;
  if (A.join(" ") === B.join(" ")) return 1;
  const hit = A.filter((w) => B.includes(w)).length;
  return hit / Math.max(A.length, B.length);
}

async function matchCustomer(db, code, name) {
  if (code) {
    const [r] = await db.query("SELECT CUST_CODE, CUST_NAME FROM cus_mst WHERE CUST_CODE = ? LIMIT 1", [code]);
    if (r[0]) return { status: "code", CUST_CODE: r[0].CUST_CODE, CUST_NAME: r[0].CUST_NAME, candidates: [] };
  }
  const words = sigWords(name).filter((w) => w.length > 2);
  if (!words.length) return { status: "none", candidates: [] };

  const like = async (ws) => {
    const [rows] = await db.query(
      `SELECT CUST_CODE, CUST_NAME FROM cus_mst WHERE ${ws.map(() => "UPPER(CUST_NAME) LIKE ?").join(" AND ")} LIMIT 30`,
      ws.map((w) => `%${w}%`)
    );
    return rows;
  };
  let rows = await like(words.slice(0, 3));
  if (!rows.length) rows = await like(words.slice(0, 1));

  const ranked = rows
    .map((r) => ({ CUST_CODE: r.CUST_CODE, CUST_NAME: r.CUST_NAME, score: score(name, r.CUST_NAME) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const best = ranked[0];
  // one clear winner → take it; otherwise let the user pick
  if (best && best.score >= 0.8 && !(ranked[1] && ranked[1].score === best.score)) {
    return { status: "name", CUST_CODE: best.CUST_CODE, CUST_NAME: best.CUST_NAME, candidates: ranked };
  }
  return { status: ranked.length ? "candidates" : "none", candidates: ranked };
}

// ─── Route ───────────────────────────────────────────────────────────────────
module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise();

  // Our own company name, so the AI never takes us for the customer.
  let ourName = null;
  const getOurName = async () => {
    if (ourName !== null) return ourName;
    try {
      const [r] = await db.query("SELECT NAME FROM company LIMIT 1");
      ourName = String(r[0]?.NAME || "").trim();
    } catch {
      ourName = "";
    }
    return ourName;
  };

  router.post("/ai/sinq_scan", (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (err) {
        const msg = err.code === "LIMIT_FILE_SIZE" ? `File is larger than ${MAX_MB} MB.` : err.message;
        return res.status(400).json({ message: msg });
      }
      next();
    });
  }, async (req, res) => {
    try {
      if (!process.env.GEMINI_API_KEY) return res.status(500).json({ message: "GEMINI_API_KEY is not set on the server." });
      const file = req.file;
      if (!file) return res.status(400).json({ message: "No file received." });
      const type = kindOf(file);
      if (!type) return res.status(400).json({ message: "Use a PDF, Excel (xls/xlsx/csv), e-mail (.eml/.txt) or image file." });

      const parts = [{ text: buildPrompt(await getOurName()) }];
      if (type.kind === "sheet") {
        let text;
        try { text = sheetToText(file.buffer); } catch (e) {
          return res.status(400).json({ message: "Could not read the spreadsheet: " + e.message });
        }
        parts.push({ text: `Spreadsheet "${file.originalname}" (sheets as CSV):\n\n${text}` });
      } else if (type.kind === "text") {
        parts.push({ text: `Enquiry "${file.originalname}":\n\n${clip(file.buffer.toString("utf8"))}` });
      } else {
        parts.push({ inlineData: { mimeType: type.mime, data: file.buffer.toString("base64") } });
      }

      const GoogleGenAI = await loadGenAI();
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const { text, model } = await callGemini(ai, parts);
      const out = normalise(parseJson(text));

      let customer = { status: "none", candidates: [] };
      try {
        customer = await matchCustomer(db, out.header.CUST_CODE, out.header.CLIENT_NAME);
      } catch (e) {
        console.error("sinq_scan customer match:", e.message);
      }

      res.json({ ...out, maxItems: MAX_ITEMS, customer, source: type.kind, model });
    } catch (e) {
      console.error("sinq_scan:", e);
      res.status(e.busy ? 503 : 500).json({ message: e.busy ? e.message : "AI scan failed: " + e.message });
    }
  });

  return router;
};
