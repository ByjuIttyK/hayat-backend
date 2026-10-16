// E:\hayatApi\routes\drawRegAiScanApi.js — AI Scan for Drawing Register (DRAWREG)
//
//   POST /api/ai/drawreg_scan     multipart, field "file"
//        PDF / image  → sent to Gemini as-is (Gemini reads PDFs natively)
//        XLS / XLSX / CSV → every sheet turned into CSV text, then sent to Gemini
//   Returns { header, panels, refDrawingNo, notes, customer, source, model }
//
// Register in HayatDb.js AFTER authMiddleware:
//   const drawRegAiScanApi = require("./routes/drawRegAiScanApi");
//   app.use("/api", drawRegAiScanApi(connection));
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
const MAX_SHEET_CHARS = 150000;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024 } });

// ─── File type ───────────────────────────────────────────────────────────────
const SHEET_EXT = ["xls", "xlsx", "xlsm", "xlsb", "csv", "ods"];
const IMAGE_MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
function kindOf(file) {
  const ext = String(file.originalname || "").split(".").pop().toLowerCase();
  if (ext === "pdf" || file.mimetype === "application/pdf") return { kind: "pdf", mime: "application/pdf" };
  if (SHEET_EXT.includes(ext)) return { kind: "sheet" };
  if (IMAGE_MIME[ext]) return { kind: "image", mime: IMAGE_MIME[ext] };
  if (String(file.mimetype).startsWith("image/")) return { kind: "image", mime: file.mimetype };
  return null;
}

function sheetToText(buf) {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const text = wb.SheetNames.map((name) => {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false, dateNF: "dd/mm/yyyy" });
    return `### Sheet: ${name}\n${csv}`;
  }).join("\n\n");
  return text.length > MAX_SHEET_CHARS ? text.slice(0, MAX_SHEET_CHARS) + "\n…(truncated)" : text;
}

// ─── Prompt ──────────────────────────────────────────────────────────────────
const PROMPT = `You read panel drawing registers, drawing lists, RFQs and quotations of an
electrical switchgear manufacturer and return ONE JSON object, nothing else:

{
  "header": {
    "DRAW_DATE": "", "QUOTE_REF": "", "CUST_CODE": "", "CLIENT_NAME": "",
    "JOB_NO": "", "PROJECT_NAME": "", "DRAWN_NAME": "", "DATE_OF_SUBM": "",
    "APPROVAL_DATE": "", "COMPUTER_LOCATION": "", "EXT_REV": "", "DRAWING_NO": ""
  },
  "panels": [ { "PANEL_DETAILS": "", "QTY": 1, "DRAWING_NO": "", "REV_NO": "" } ],
  "notes": ""
}

Rules:
- DRAW_DATE = drawing / register / document date. Dates are day-first (dd/mm/yyyy);
  output every date as yyyy-mm-dd. Never use a "Printed on" date.
- QUOTE_REF = quotation / quote / offer / RFQ reference number, exactly as printed
  (keep leading zeros). CUST_CODE only if a customer code is printed (e.g. 1CS1419).
- CLIENT_NAME = the customer / client, NOT the issuing company in the letterhead.
- PROJECT_NAME = project / site / plot references, as printed.
- DRAWN_NAME = "Drawn by" person. Leave a field "" when it is blank, "-" or absent.
- DRAWING_NO in header = the set / main drawing number if one is printed.
- panels = every panel / line item, in document order, across ALL pages / sheets.
  PANEL_DETAILS: the full description exactly as written, including tags such as
  "(N-367)". A description wrapped over two lines is ONE panel, joined with a
  space; a word split by a hyphen at the line end is rejoined ("PAN-" + "EL" →
  "PANEL"), but real hyphens such as "MAIN POOL -1" or "N-367" stay. Keep the
  original spelling otherwise. QTY is a number (1 if not shown). DRAWING_NO /
  REV_NO per line only if printed. The serial number column is not part of
  PANEL_DETAILS.
- Skip column headings, totals ("23 panels · Total Qty 75"), signature boxes,
  page headers/footers and repeated headings on later pages.
- Use "notes" for anything doubtful (unreadable text, possible duplicates), else "".`;

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
    DRAW_DATE: toIso(h.DRAW_DATE),
    QUOTE_REF: clean(h.QUOTE_REF),
    CUST_CODE: clean(h.CUST_CODE).toUpperCase(),
    CLIENT_NAME: clean(h.CLIENT_NAME).slice(0, 100),
    JOB_NO: clean(h.JOB_NO),
    PROJECT_NAME: clean(h.PROJECT_NAME).replace(/\s*\n\s*/g, " "),
    DRAWN_NAME: clean(h.DRAWN_NAME).toUpperCase(),
    DATE_OF_SUBM: toIso(h.DATE_OF_SUBM),
    APPROVAL_DATE: toIso(h.APPROVAL_DATE),
    COMPUTER_LOCATION: clean(h.COMPUTER_LOCATION),
    EXT_REV: clean(h.EXT_REV),
  };
  const panels = (Array.isArray(raw?.panels) ? raw.panels : [])
    .map((p) => ({
      PANEL_DETAILS: clean(p?.PANEL_DETAILS).replace(/[ \t]+/g, " "),
      QTY: Number(String(p?.QTY ?? "").replace(/[^\d.]/g, "")) || 1,
      DRAWING_NO: clean(p?.DRAWING_NO),
      REV_NO: clean(p?.REV_NO),
    }))
    .filter((p) => p.PANEL_DETAILS);
  return { header, panels, refDrawingNo: clean(h.DRAWING_NO), notes: clean(raw?.notes) };
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

  router.post("/ai/drawreg_scan", (req, res, next) => {
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
      if (!type) return res.status(400).json({ message: "Use a PDF, Excel (xls/xlsx/csv) or image file." });

      const parts = [{ text: PROMPT }];
      if (type.kind === "sheet") {
        let text;
        try { text = sheetToText(file.buffer); } catch (e) {
          return res.status(400).json({ message: "Could not read the spreadsheet: " + e.message });
        }
        parts.push({ text: `Spreadsheet "${file.originalname}" (sheets as CSV):\n\n${text}` });
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
        console.error("drawreg_scan customer match:", e.message);
      }

      res.json({ ...out, customer, source: type.kind, model });
    } catch (e) {
      console.error("drawreg_scan:", e);
      res.status(e.busy ? 503 : 500).json({ message: e.busy ? e.message : "AI scan failed: " + e.message });
    }
  });

  return router;
};
