// routes/sivBoqScanApi.js
// ─────────────────────────────────────────────────────────────────────────────
// AI scan of an EPLAN Bill of Materials (BOQ) PDF for the SIV screen.
//
//   POST /api/siv-boq-scan      multipart, field "file" (PDF or image)
//        → { header, customer, lines, warnings }
//          header   : title-block fields (Dwg No, Rev, Date, Quotation, Job,
//                     Panel Ref, Project, Drawn/Checked/Approved, customer name)
//          customer : { CUST_CODE, CUST_NAME, source } or null
//          lines    : BOM rows, each matched to item_mst by ARTICLE_CODE
//                     (per-panel qty — the screen multiplies by Panel Qty)
//
//          A part no printed as "A / B" (e.g. relay + its base) becomes two
//          lines, same qty, description and manufacturer.
//          A line with no matching item carries SIMILAR: up to 10 items whose
//          ARTICLE_CODE looks like its part no, for the user to pick from.
//
//   GET  /api/siv-cust/:code    → { CUST_CODE, CUST_NAME } (Cust Code blur)
//   GET  /api/siv-boq-similar?part=...  → similar items for a typed part no
//
// Register in HayatDb.js:
//   const sivBoqScanApi = require("./routes/sivBoqScanApi");
//   app.use("/api", sivBoqScanApi(connection));
//
// Needs GEMINI_API_KEY in .env (GEMINI_BOQ_MODEL, GEMINI_TIMEOUT_MS optional).
// Calls Gemini the same way as ChequeScanRoutes.js — no SDK needed.
// ─────────────────────────────────────────────────────────────────────────────
const express = require("express");
const multer = require("multer");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const PROMPT = `
You are reading a Bill of Materials (BOQ) exported from EPLAN for ONE electrical
control panel. Return ONLY this JSON, nothing else:

{
  "header": {
    "dwgNo": "", "revNo": "", "dwgDate": "dd/MM/yyyy", "quotNo": "", "jobNo": "",
    "panelRef": "", "project": "", "drawnBy": "", "checkedBy": "", "approvedBy": "",
    "customerName": "", "client": ""
  },
  "lines": [
    { "deviceTag": "", "qty": 0, "description": "", "partNo": "", "manufacturer": "" }
  ]
}

Rules:
- The title block at the bottom repeats on every sheet: read it once.
- If the revision table has several rows, take the LATEST (last filled) row
  for revNo, dwgDate and drawnBy.
- customerName = the company name under "SYSTEM DESIGNED & ASSEMBLED BY"
  (company name only: no P.O. Box, address, phone or email).
- project = the full Project text on one line (join wrapped lines with a space).
- Use "" for any field printed as "--" or left empty.
- lines = EVERY row of the bill of materials from ALL pages, in printed order.
  Do not merge, split, total or skip rows. Copy partNo exactly as printed.
  qty is the number in the Quantity column for that row.
- Ignore Country of Origin, sheet numbers, scale, and the grid letters/numbers
  along the page border.
`;

const clip = (v, n) => String(v ?? "").trim().slice(0, n);
const keyExact = (s) => String(s ?? "").trim().toUpperCase();
const keyLoose = (s) => keyExact(s).replace(/[\s\-./]/g, "");

// "SRN-14-230V / SRN-14-SOK" → ["SRN-14-230V", "SRN-14-SOK"].
// Split only when every piece is at least 4 characters, so codes that use a
// slash inside them (e.g. "C10/3P", "6A/1") stay whole.
const MIN_SPLIT_PART = 4;
function splitPartNo(raw) {
  const s = String(raw ?? "").trim();
  if (!s.includes("/")) return [s];
  const pieces = s.split("/").map((p) => p.trim()).filter(Boolean);
  if (pieces.length < 2 || pieces.some((p) => keyLoose(p).length < MIN_SPLIT_PART)) return [s];
  return pieces;
}

// Similarity of two loose keys, 0..1: shared starting characters count most,
// plus the share of 2-letter pairs they have in common.
function similarity(a, b) {
  if (!a || !b) return 0;
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  const pairs = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); m.set(k, (m.get(k) || 0) + 1); } return m; };
  const pa = pairs(a), pb = pairs(b);
  let common = 0;
  pa.forEach((n, k) => { common += Math.min(n, pb.get(k) || 0); });
  const dice = (pa.size && pb.size) ? (2 * common) / (a.length - 1 + b.length - 1) : 0;
  const prefix = pre / Math.max(a.length, b.length);
  return Math.round((0.5 * prefix + 0.5 * dice) * 100) / 100;
}

const SIMILAR_MAX = 10;
const LOOSE_SQL = "REPLACE(REPLACE(REPLACE(REPLACE(UPPER(TRIM(ARTICLE_CODE)),' ',''),'-',''),'.',''),'/','')";

// Words that don't identify a company — dropped before the LIKE search.
const NAME_NOISE = new Set([
  "LLC", "L.L.C", "LTD", "CO", "COMPANY", "FZE", "FZCO", "FZ", "FZC",
  "EST", "ESTABLISHMENT", "THE", "AND", "&", "TRADING", "GROUP",
]);

module.exports = function (connection) {
  const router = express.Router();

  const q = (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );

  // ── Gemini read ───────────────────────────────────────────────────────────
  // Same call as ChequeScanRoutes.js (which works on this server): Node's
  // fetch, key in the URL, snake_case inline_data, gemini-2.5-flash-lite.
  // Override the model with GEMINI_BOQ_MODEL in .env if needed.
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const MODEL = process.env.GEMINI_BOQ_MODEL || "gemini-2.5-flash-lite";
  const GEMINI_URL =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 150000;

  async function readBoq(buffer, mimeType) {
    if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY not set in .env");

    let r;
    try {
      r = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: mimeType || "application/pdf", data: buffer.toString("base64") } },
              { text: PROMPT },
            ],
          }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 8192,                 // a BOQ has many lines — more than a cheque
            responseMimeType: "application/json",
          },
        }),
      });
    } catch (e) {
      // "fetch failed" hides the real reason in e.cause — log and show it.
      const cause = e.cause ? `${e.cause.code || ""} ${e.cause.message || ""}`.trim() : "";
      console.error("siv-boq-scan: fetch to Gemini failed:", e.message, cause, e.cause || "");
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        throw new Error(`Gemini did not answer within ${GEMINI_TIMEOUT_MS / 1000} s`);
      }
      throw new Error(`Cannot reach Gemini: ${e.message}${cause ? ` (${cause})` : ""}`);
    }

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("siv-boq-scan: Gemini API error", JSON.stringify(data).slice(0, 500));
      throw new Error(data.error?.message || `AI request failed (HTTP ${r.status})`);
    }

    const text =
      data.candidates?.[0]?.content?.parts
        ?.map((p) => p.text || "")
        .join("") || "";
    if (!text) {
      const why = data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason || "empty reply";
      throw new Error(`Gemini returned no data (${why})`);
    }
    try {
      return JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch {
      console.error("siv-boq-scan: unparseable AI response:", text.slice(0, 300));
      const cut = data.candidates?.[0]?.finishReason === "MAX_TOKENS" ? " — reply was cut off (too many lines)" : "";
      throw new Error(`AI returned unparseable response${cut}`);
    }
  }

  // ── Customer: by scanned name, then drawing register, then job ────────────
  async function findCustomer(h, warnings) {
    const found = { byName: null, byDrawing: null, byJob: null };

    // 1. Name from the title block
    const words = String(h.customerName || "")
      .toUpperCase()
      .replace(/[^A-Z0-9& ]/g, " ")
      .split(/\s+/)
      .filter((w) => w && !NAME_NOISE.has(w))
      .slice(0, 3);
    if (words.length) {
      const rows = await q(
        `SELECT CUST_CODE, CUST_NAME FROM cus_mst
          WHERE ${words.map(() => "UPPER(CUST_NAME) LIKE ?").join(" AND ")}
          ORDER BY LENGTH(CUST_NAME) LIMIT 10`,
        words.map((w) => `%${w}%`)
      );
      if (rows.length) {
        found.byName = rows[0];
        if (rows.length > 1) {
          warnings.push(
            `Customer name "${h.customerName}" matches ${rows.length} customers — ` +
            `took ${rows[0].CUST_CODE} ${rows[0].CUST_NAME}. Check Cust Code.`
          );
        }
      }
    }

    // 2. Drawing register (panel drawings are <header no>-1, -2 …)
    if (h.dwgNo) {
      try {
        const base = h.dwgNo.replace(/-\d+$/, "");
        const rows = await q(
          `SELECT d.CUST_CODE, c.CUST_NAME FROM drawing_register d
             LEFT JOIN cus_mst c ON c.CUST_CODE = d.CUST_CODE
            WHERE d.DRAWING_NO IN (?, ?) AND d.CUST_CODE IS NOT NULL LIMIT 1`,
          [h.dwgNo, base]
        );
        if (rows.length) found.byDrawing = rows[0];
      } catch (e) { /* table/column differs — fall through */ }
    }

    // 3. Job card
    if (h.jobNo) {
      try {
        const rows = await q(
          `SELECT j.CUST_CODE, c.CUST_NAME FROM job_card j
             LEFT JOIN cus_mst c ON c.CUST_CODE = j.CUST_CODE
            WHERE j.JOB_NO = ? AND j.CUST_CODE IS NOT NULL LIMIT 1`,
          [h.jobNo]
        );
        if (rows.length) found.byJob = rows[0];
      } catch (e) { /* column differs — fall through */ }
    }

    const pick =
      (found.byName && { ...found.byName, source: "name" }) ||
      (found.byDrawing && { ...found.byDrawing, source: "drawing register" }) ||
      (found.byJob && { ...found.byJob, source: "job" }) ||
      null;

    const other = found.byDrawing || found.byJob;
    if (pick && other && other.CUST_CODE !== pick.CUST_CODE) {
      warnings.push(
        `Scanned name gives ${pick.CUST_CODE}, but Job/Drawing ${h.jobNo || h.dwgNo} ` +
        `belongs to ${other.CUST_CODE} ${other.CUST_NAME || ""}. Check Cust Code.`
      );
    }
    if (!pick && h.customerName) {
      warnings.push(`Customer "${h.customerName}" not found in the customer master.`);
    }
    return pick;
  }

  // ── Similar items for a part no with no match ─────────────────────────────
  // Candidates: article codes that contain the part no, start with its first
  // ~60 % (same family, e.g. SRN-14-…), or are contained in it. Ranked by
  // similarity(), best SIMILAR_MAX returned.
  async function similarItems(partNo) {
    const key = keyLoose(partNo);
    if (key.length < 3) return [];
    const stem = key.slice(0, Math.max(3, Math.ceil(key.length * 0.6)));
    const rows = await q(
      `SELECT * FROM (
         SELECT ITEM_CODE, ITEM_NAME1, ITEM_UNIT, TRIM(ARTICLE_CODE) AS ARTICLE_CODE, ${LOOSE_SQL} AS AK
           FROM item_mst
          WHERE LOC_CODE = '01' AND COALESCE(TRIM(ARTICLE_CODE), '') <> ''
       ) t
       WHERE t.AK LIKE ? OR t.AK LIKE ? OR (LENGTH(t.AK) >= 4 AND ? LIKE CONCAT('%', t.AK, '%'))
       LIMIT 300`,
      [`%${key}%`, `${stem}%`, key]
    );
    return rows
      .map((r) => ({
        ITEM_CODE: r.ITEM_CODE, ITEM_NAME1: r.ITEM_NAME1 || "", UOM: r.ITEM_UNIT || "",
        ARTICLE_CODE: r.ARTICLE_CODE, SCORE: similarity(key, r.AK),
      }))
      .sort((a, b) => b.SCORE - a.SCORE || String(a.ARTICLE_CODE).localeCompare(String(b.ARTICLE_CODE)))
      .slice(0, SIMILAR_MAX);
  }

  // ── Items: item_mst.ARTICLE_CODE = part no (exact, then ignoring - . / space)
  async function matchItems(lines, warnings) {
    const parts = lines.map((l) => l.PART_NO).filter(Boolean);
    if (!parts.length) return;

    const exactRows = await q(
      `SELECT ITEM_CODE, ITEM_NAME1, ITEM_UNIT, UPPER(TRIM(ARTICLE_CODE)) AS AK
         FROM item_mst
        WHERE LOC_CODE = '01' AND UPPER(TRIM(ARTICLE_CODE)) IN (?)
        ORDER BY ITEM_CODE`,
      [Array.from(new Set(parts.map(keyExact)))]
    );
    const exact = {};
    exactRows.forEach((r) => (exact[r.AK] = exact[r.AK] || []).push(r));

    const misses = parts.filter((p) => !exact[keyExact(p)]);
    const loose = {};
    if (misses.length) {
      const looseRows = await q(
        `SELECT ITEM_CODE, ITEM_NAME1, ITEM_UNIT,
                REPLACE(REPLACE(REPLACE(REPLACE(UPPER(TRIM(ARTICLE_CODE)),' ',''),'-',''),'.',''),'/','') AS AK
           FROM item_mst
          WHERE LOC_CODE = '01'
            AND REPLACE(REPLACE(REPLACE(REPLACE(UPPER(TRIM(ARTICLE_CODE)),' ',''),'-',''),'.',''),'/','') IN (?)
          ORDER BY ITEM_CODE`,
        [Array.from(new Set(misses.map(keyLoose)))]
      );
      looseRows.forEach((r) => (loose[r.AK] = loose[r.AK] || []).push(r));
    }

    lines.forEach((l) => {
      if (!l.PART_NO) { l.MATCH = "NONE"; return; }
      let hits = exact[keyExact(l.PART_NO)];
      l.MATCH = "EXACT";
      if (!hits) { hits = loose[keyLoose(l.PART_NO)]; l.MATCH = "LOOSE"; }
      if (!hits) { l.MATCH = "NONE"; return; }
      const it = hits[0];
      l.ITEM_CODE = it.ITEM_CODE;
      l.ITEM_NAME1 = it.ITEM_NAME1;
      l.UOM = it.ITEM_UNIT || "";
      if (hits.length > 1) {
        l.MATCH = "MULTI";
        warnings.push(
          `Part ${l.PART_NO} is on ${hits.length} items (${hits.map((h) => h.ITEM_CODE).join(", ")}) — took ${it.ITEM_CODE}.`
        );
      }
    });

    // Unmatched lines: offer similar items (one lookup per distinct part no).
    const unmatched = Array.from(new Set(lines.filter((l) => l.MATCH === "NONE" && l.PART_NO).map((l) => l.PART_NO)));
    const found = {};
    for (const p of unmatched) {
      try { found[p] = await similarItems(p); } catch (e) { found[p] = []; console.error("siv-boq-scan similar:", e.message); }
    }
    lines.forEach((l) => { l.SIMILAR = l.MATCH === "NONE" && l.PART_NO ? (found[l.PART_NO] || []) : []; });
  }

  // ── POST /siv-boq-scan ────────────────────────────────────────────────────
  router.post("/siv-boq-scan", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const mime = req.file.mimetype || "application/pdf";
      if (!/pdf|image\//.test(mime)) {
        return res.status(400).json({ error: "Upload the BOQ as a PDF or an image" });
      }

      const raw = await readBoq(req.file.buffer, mime);
      const rh = raw?.header || {};
      const header = {
        dwgNo: clip(rh.dwgNo, 30),
        revNo: clip(rh.revNo, 5),
        dwgDate: clip(rh.dwgDate, 10),
        quotNo: clip(rh.quotNo, 10),
        jobNo: clip(rh.jobNo, 10),
        panelRef: clip(rh.panelRef, 100),
        project: clip(rh.project, 150),
        drawnBy: clip(rh.drawnBy, 30),
        checkedBy: clip(rh.checkedBy, 30),
        approvedBy: clip(rh.approvedBy, 30),
        customerName: clip(rh.customerName || rh.client, 100),
      };

      let splitCount = 0;
      const lines = (Array.isArray(raw?.lines) ? raw.lines : [])
        .flatMap((l) => {
          const parts = splitPartNo(l.partNo);
          if (parts.length > 1) splitCount++;
          return parts.map((part) => ({
            DEVICE_TAG: clip(l.deviceTag, 30),
            BOQ_QTY: Number(String(l.qty ?? "").replace(/[^\d.]/g, "")) || 0,
            BOQ_ITEM_DESC: clip(l.description, 300),
            PART_NO: clip(part, 30),
            MANUFACTURER: clip(l.manufacturer, 40),
            ITEM_CODE: "",
            ITEM_NAME1: "",
            UOM: "",
            MATCH: "NONE",
            SPLIT: parts.length > 1,
            SIMILAR: [],
          }));
        })
        .filter((l) => l.PART_NO || l.BOQ_ITEM_DESC);

      const warnings = [];
      if (!lines.length) warnings.push("No BOM lines were found in the document.");
      if (splitCount) warnings.push(`${splitCount} BOQ row(s) had two part nos (A / B) — each was put on its own line.`);

      const customer = await findCustomer(header, warnings);
      await matchItems(lines, warnings);

      res.json({ header, customer, lines, warnings });
    } catch (err) {
      console.error("siv-boq-scan:", err);
      res.status(500).json({ error: err.message || "BOQ scan failed" });
    }
  });

  // ── GET /siv-boq-similar?part=... ─────────────────────────────────────────
  // The picker's search box: similar items for whatever part no is typed.
  router.get("/siv-boq-similar", async (req, res) => {
    try {
      res.json(await similarItems(String(req.query.part || "")));
    } catch (err) {
      console.error("siv-boq-similar:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /siv-cust/:code ───────────────────────────────────────────────────
  router.get("/siv-cust/:code", async (req, res) => {
    try {
      const rows = await q(
        "SELECT CUST_CODE, CUST_NAME FROM cus_mst WHERE CUST_CODE = ?",
        [String(req.params.code || "").trim()]
      );
      res.json(rows[0] || null);
    } catch (err) {
      console.error("siv-cust:", err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
