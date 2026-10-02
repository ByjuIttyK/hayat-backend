// routes/pvScanApi.js
// Payment Voucher Scan: reads handwritten payment voucher photos with Gemini,
// saves the checked rows to pv_scan with a continuous running number.
//
// Register in HayatDb.js:
//   app.use("/api", require("./routes/pvScanApi")(connection));
//
// .env:  GEMINI_KEY=...   (optional) GEMINI_MODEL=gemini-3.8-flash  GEMINI_FALLBACK_MODEL=gemini-3.7-flash
//
// Endpoints
//   GET  /api/pv-scan/next-run        -> { next_run }
//   POST /api/pv-scan/read            body = image bytes (Content-Type: image/jpeg)
//                                     -> { vchr_no, vchr_date, paid_to, being, amount, conf, notes, img_file }
//   GET  /api/pv-scan/image/:file     -> the stored photo
//   POST /api/pv-scan/save            { rows: [...], allowDuplicates } -> { saved: [{ key, run_no }] }
//                                     409 { duplicates: [{ vchr_no, run_no }] } when a voucher no. is already saved
//   GET  /api/pv-scan/list?limit=200  -> saved rows, newest first
//   PATCH  /api/pv-scan/:runNo        { cr_acc } -> change who paid on a saved voucher
//   DELETE /api/pv-scan/:runNo        -> delete one saved voucher (and its photo)

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const IMG_DIR = path.join(__dirname, "..", "uploads", "pv_scan");
const IMG_NAME = /^pv_\d+_[0-9a-f]{8}\.jpg$/;

// Partners who pay the expenses (credit account). Codes stored in pv_scan.cr_acc.
const PARTNERS = ["ARUN", "REENI"];

const PROMPT = `You are reading a photo of ONE handwritten payment voucher from a printed voucher book.
Layout: a printed company header at the top (ignore it). Below it on the left, "No." followed by a PRINTED
serial number (usually red): this is the voucher number. On the right, "Date:" followed by a handwritten date.
Then "Paid To:" with a handwritten name, a "Rupees" line (amount in words, often blank), a "Being" line with the
handwritten purpose (may be blank), and at the bottom left a box "Rs." with the handwritten amount in figures.
Ignore "Received", "Approved by" and the signature.

Return ONLY a JSON object, no other text:
{"vchr_no": "", "vchr_date": "dd/MM/yyyy", "paid_to": "", "being": "", "amount": 0, "amount_words": "",
 "confidence": {"vchr_no": "high|medium|low", "vchr_date": "high|medium|low", "paid_to": "high|medium|low",
                "being": "high|medium|low", "amount": "high|medium|low"},
 "notes": ""}

Rules:
- The date is day/month/year (Indian style). Two-digit years mean 20xx. Output 2-digit day and month and a
  4-digit year: 1/11/2025 -> 01/11/2025, 05/11/25 -> 05/11/2025.
- Amount: a plain number. Remove "Rs.", "/-", commas and spaces: "500/-" -> 500, "90,000" -> 90000.
- Copy names and text exactly as written, including abbreviations such as "H/w". Do not expand or correct them.
- A blank field is "" (amount null), with confidence "high" if it is clearly blank.
- Use "low" confidence whenever you are guessing a letter or digit.
- If the amount in words is filled and disagrees with the figures, say so in notes.
- If the photo is not a payment voucher, return empty fields and explain in notes.`;

const pad = (n) => String(n).padStart(2, "0");

// "1/11/25", "01-11-2025" -> "01/11/2025"; null if not a real date
function normDmy(s) {
  const m = /^\s*(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})\s*$/.exec(String(s || ""));
  if (!m) return null;
  const d = +m[1], mo = +m[2];
  let y = +m[3];
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${pad(d)}/${pad(mo)}/${y}`;
}

// "01/11/2025" -> "2025-11-01"
function toDbDate(s) {
  const dmy = normDmy(s);
  if (!dmy) return null;
  const [d, m, y] = dmy.split("/");
  return `${y}-${m}-${d}`;
}

function toAmount(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One Gemini call. Busy/overloaded replies (429, 500, 503) are retried, then the fallback model is tried.
async function callGemini(body) {
  const key = process.env.GEMINI_KEY || process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_KEY is not set in the backend .env");
  const models = [process.env.GEMINI_MODEL || "gemini-3.8-flash", process.env.GEMINI_FALLBACK_MODEL || "gemini-3.7-flash"];
  let last = "";
  for (const model of [...new Set(models)]) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(attempt * 2000);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (r.ok) return r.json();
      last = `AI service error ${r.status}: ${(await r.text()).slice(0, 200)}`;
      if (![429, 500, 503].includes(r.status)) break; // not a busy error: try the next model
    }
  }
  throw new Error(last.includes(" 503") || last.includes(" 429") ? "The AI service is busy right now. Click Read again in a minute" : last);
}

async function readWithGemini(buf, mime) {
  const body = {
    contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: buf.toString("base64") } }] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json" },
  };
  const j = await callGemini(body);
  const txt = (j?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
  let o;
  try {
    o = JSON.parse(txt.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());
  } catch {
    throw new Error("Could not understand the AI reply");
  }
  return {
    vchr_no: String(o.vchr_no ?? "").replace(/\s+/g, ""),
    vchr_date: normDmy(o.vchr_date) || String(o.vchr_date ?? "").trim(),
    paid_to: String(o.paid_to ?? "").trim(),
    being: String(o.being ?? "").trim(),
    amount: toAmount(o.amount),
    conf: o.confidence && typeof o.confidence === "object" ? o.confidence : {},
    notes: [o.notes, o.amount_words ? `In words: ${o.amount_words}` : ""].filter(Boolean).join(" | "),
  };
}

module.exports = function (connection) {
  const router = express.Router();
  const db = typeof connection.promise === "function" ? connection.promise() : connection;
  fs.mkdirSync(IMG_DIR, { recursive: true });

  router.get("/pv-scan/next-run", async (req, res) => {
    try {
      const [r] = await db.query("SELECT COALESCE(MAX(run_no), 0) + 1 AS next_run FROM pv_scan");
      res.json({ next_run: Number(r[0].next_run) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Raw image body, so the global express.json() size limit does not apply.
  router.post("/pv-scan/read", express.raw({ type: ["image/*"], limit: "15mb" }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "No image received" });
    const img_file = `pv_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.jpg`;
    try {
      fs.writeFileSync(path.join(IMG_DIR, img_file), req.body);
    } catch (e) {
      return res.status(500).json({ error: `Could not store the photo: ${e.message}` });
    }
    try {
      const data = await readWithGemini(req.body, req.headers["content-type"] || "image/jpeg");
      res.json({ ...data, img_file });
    } catch (e) {
      // Photo is kept so the row can still be typed in by hand.
      res.json({ error: e.message, img_file });
    }
  });

  router.get("/pv-scan/image/:file", (req, res) => {
    const f = req.params.file;
    if (!IMG_NAME.test(f)) return res.status(400).json({ error: "Bad file name" });
    const p = path.join(IMG_DIR, f);
    if (!fs.existsSync(p)) return res.status(404).json({ error: "Photo not found" });
    res.sendFile(p);
  });

  router.post("/pv-scan/save", async (req, res) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: "Nothing to save" });

    const bad = [];
    const clean = rows.map((r, i) => {
      const row = {
        key: r.key,
        vchr_no: String(r.vchr_no || "").trim(),
        vchr_date: toDbDate(r.vchr_date),
        paid_to: String(r.paid_to || "").trim().slice(0, 200),
        being: String(r.being || "").trim().slice(0, 500),
        amount: toAmount(r.amount),
        cr_acc: String(r.cr_acc || "").toUpperCase(),
        img_file: IMG_NAME.test(r.img_file || "") ? r.img_file : null,
        ai_conf: Object.entries(r.conf || {})
          .filter(([, v]) => v !== "high")
          .map(([k, v]) => `${k}:${v}`)
          .join(",")
          .slice(0, 200) || null,
      };
      if (!row.vchr_no || !row.vchr_date || !row.paid_to || !row.amount || !PARTNERS.includes(row.cr_acc)) bad.push(i + 1);
      return row;
    });
    if (bad.length) return res.status(400).json({ error: `Row(s) ${bad.join(", ")} are incomplete` });

    const user = req.user?.username || req.user?.user || null;
    let conn;
    try {
      conn = await db.getConnection();
      await conn.beginTransaction();

      if (!req.body.allowDuplicates) {
        const [dups] = await conn.query(
          "SELECT vchr_no, run_no FROM pv_scan WHERE vchr_no IN (?) ORDER BY run_no",
          [clean.map((r) => r.vchr_no)]
        );
        if (dups.length) {
          await conn.rollback();
          return res.status(409).json({ duplicates: dups });
        }
      }

      const [[{ mx }]] = await conn.query("SELECT COALESCE(MAX(run_no), 0) AS mx FROM pv_scan FOR UPDATE");
      let run = Number(mx);
      const saved = [];
      for (const r of clean) {
        run += 1;
        await conn.query(
          `INSERT INTO pv_scan (run_no, vchr_no, vchr_date, paid_to, being, amount, cr_acc, img_file, ai_conf, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [run, r.vchr_no, r.vchr_date, r.paid_to, r.being, r.amount, r.cr_acc, r.img_file, r.ai_conf, user]
        );
        saved.push({ key: r.key, run_no: run });
      }
      await conn.commit();
      res.json({ saved });
    } catch (e) {
      if (conn) await conn.rollback().catch(() => {});
      res.status(500).json({ error: e.message });
    } finally {
      if (conn) conn.release();
    }
  });

  // Change who paid (Cr A/c) on a saved voucher
  router.patch("/pv-scan/:runNo", async (req, res) => {
    const runNo = parseInt(req.params.runNo, 10);
    const cr = String(req.body?.cr_acc || "").toUpperCase();
    if (!runNo || !PARTNERS.includes(cr)) return res.status(400).json({ error: "Bad running number or partner" });
    try {
      const [r] = await db.query("UPDATE pv_scan SET cr_acc = ? WHERE run_no = ?", [cr, runNo]);
      if (!r.affectedRows) return res.status(404).json({ error: "Voucher not found" });
      res.json({ run_no: runNo, cr_acc: cr });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete("/pv-scan/:runNo", async (req, res) => {
    const runNo = parseInt(req.params.runNo, 10);
    if (!runNo) return res.status(400).json({ error: "Bad running number" });
    try {
      const [rows] = await db.query("SELECT img_file FROM pv_scan WHERE run_no = ?", [runNo]);
      if (!rows.length) return res.status(404).json({ error: "Voucher not found" });
      await db.query("DELETE FROM pv_scan WHERE run_no = ?", [runNo]);
      const f = rows[0].img_file;
      if (f && IMG_NAME.test(f)) fs.unlink(path.join(IMG_DIR, f), () => {});
      res.json({ deleted: runNo });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/pv-scan/list", async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
      const [rows] = await db.query(
        `SELECT run_no, vchr_no, DATE_FORMAT(vchr_date, '%d/%m/%Y') AS vchr_date, paid_to, being,
                amount, cr_acc, img_file, ai_conf, created_by
           FROM pv_scan ORDER BY run_no DESC LIMIT ?`,
        [limit]
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
