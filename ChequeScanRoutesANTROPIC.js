// ─────────────────────────────────────────────────────────────────────────────
//  ChequeScanRoutes.js — AI cheque OCR proxy (Anthropic API)
//  Mount in HayatDb.js:   app.use("/ai", require("./routes/ChequeScanRoutes"));
//  Requires in .env:      ANTHROPIC_API_KEY=sk-ant-...
//  Note: ensure app.use(express.json({ limit: "10mb" })) is set globally,
//        scanned PDFs as base64 easily exceed the 100kb default.
// ─────────────────────────────────────────────────────────────────────────────
const express = require("express");
const router = express.Router();

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-20250514";

const SYSTEM_FULL = `UAE cheque OCR. Return ONLY JSON with: chqNo, bankName, branchName,
accountNo, payeeName, amount (number), currency, chequeDate (YYYY-MM-DD),
confidence (high/medium/low), notes. No markdown.
chqNo = printed serial (top "NO." or FIRST MICR group), never the account number.
Use null for fields not present on the cheque.`;

const SYSTEM_SERIES = `UAE cheque OCR. Return ONLY JSON: chqNo, bankName, branchName,
accountNo, amount (number), currency, chequeDate (YYYY-MM-DD). No markdown.
chqNo = printed serial (top "NO." or FIRST MICR group), never the account number.
Use null for fields not present (blank cheque leaves have no payee/date/amount).`;

router.post("/cheque_scan", async (req, res) => {
  try {
    if (!ANTHROPIC_KEY) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY not set in .env" });
    }

    const { b64, mime, fields } = req.body || {};
    if (!b64) return res.status(400).json({ error: "b64 (base64 file data) is required" });

    const isPdf = mime === "application/pdf";
    const block = isPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
      : { type: "image", source: { type: "base64", media_type: mime || "image/jpeg", data: b64 } };

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 800,
        system: fields === "series" ? SYSTEM_SERIES : SYSTEM_FULL,
        messages: [{
          role: "user",
          content: [block, { type: "text", text: "Extract cheque details." }],
        }],
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      console.error("cheque_scan: Anthropic API error", data);
      return res.status(r.status).json({ error: data.error?.message || "AI request failed" });
    }

    const text = (data.content || []).map(c => c.text || "").join("");
    let json;
    try {
      json = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch {
      console.error("cheque_scan: unparseable AI response:", text);
      return res.status(502).json({ error: "AI returned unparseable response" });
    }
    res.json(json);
  } catch (err) {
    console.error("cheque_scan:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
