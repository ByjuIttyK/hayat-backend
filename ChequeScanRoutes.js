// ─────────────────────────────────────────────────────────────────────────────
//  ChequeScanRoutes.js — AI cheque OCR proxy (Google Gemini API, free tier)
//  Mount in HayatDb.js:  app.use("/ai", authMiddleware, require("./ChequeScanRoutes"));
//  Requires in .env:     GEMINI_API_KEY=...   (free key from aistudio.google.com)
//  Frontend contract unchanged: POST /ai/cheque_scan { b64, mime, fields }
//  → JSON { chqNo, bankName, branchName, accountNo, payeeName, amount,
//           currency, chequeDate, confidence, notes }
// ─────────────────────────────────────────────────────────────────────────────
const express = require("express");
const router = express.Router();

const GEMINI_KEY = process.env.GEMINI_API_KEY;
//const MODEL = "gemini-2.5-flash";   // free-tier model; change if Google renames
const MODEL = "gemini-2.5-flash-lite";
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const PROMPT_FULL = `You are a UAE cheque OCR system. Read the attached cheque and return ONLY a JSON object with these keys:
chqNo, bankName, branchName, accountNo, payeeName, amount (number), currency, chequeDate (YYYY-MM-DD), confidence ("high"|"medium"|"low"), notes.
Rules:
- chqNo is the printed serial number (top "NO." field or the FIRST group of the MICR line at the bottom). It is NEVER the account number.
- Use null for any field not present on the cheque (blank/unissued cheques have no payee, date, or amount).
- No markdown, no explanations — JSON only.`;

const PROMPT_SERIES = `You are a UAE cheque OCR system. Read the attached cheque and return ONLY a JSON object with these keys:
chqNo, bankName, branchName, accountNo, amount (number), currency, chequeDate (YYYY-MM-DD).
Rules:
- chqNo is the printed serial number (top "NO." field or the FIRST group of the MICR line). NEVER the account number.
- Use null for fields not present (blank cheque leaves have no payee/date/amount).
- No markdown, no explanations — JSON only.`;

router.post("/cheque_scan", async (req, res) => {
  try {
    if (!GEMINI_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY not set in .env" });
    }

    const { b64, mime, fields } = req.body || {};
    if (!b64) return res.status(400).json({ error: "b64 (base64 file data) is required" });

    const r = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mime || "image/jpeg", data: b64 } },
            { text: fields === "series" ? PROMPT_SERIES : PROMPT_FULL },
          ],
        }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 800,
          responseMimeType: "application/json",   // forces clean JSON output
        },
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      console.error("cheque_scan: Gemini API error", JSON.stringify(data).slice(0, 500));
      return res.status(r.status).json({
        error: data.error?.message || "AI request failed",
      });
    }

    const text =
      data.candidates?.[0]?.content?.parts
        ?.map(p => p.text || "")
        .join("") || "";

    let json;
    try {
      json = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch {
      console.error("cheque_scan: unparseable AI response:", text.slice(0, 300));
      return res.status(502).json({ error: "AI returned unparseable response" });
    }
    res.json(json);
  } catch (err) {
    console.error("cheque_scan:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
