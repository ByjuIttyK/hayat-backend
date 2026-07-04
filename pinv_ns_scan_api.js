// ─────────────────────────────────────────────────────────────────────────────
//  pinv_ns_scan_api.js — AI Scan route for Purchase Entry (Non-Stock).
//  Reads a supplier invoice (PDF or image), asks Gemini to extract header +
//  line items as structured JSON, then fuzzy-matches the extracted company
//  name against SUP_MST. Follows the same gemini-2.5-flash-lite + retry
//  conventions as ChequeScanRoutes.js / gl_suggest_api.js.
//  Mount in HayatDb.js:
//    const pinvNsScanRoutes = require('./pinv_ns_scan_api')(connection);
//    app.use('/api/ai', pinvNsScanRoutes);   // → POST /api/ai/pinv_ns_scan
//
//  Note: unlike ChequeScanRoutes.js, this route isn't passed through your
//  shared `authMiddleware` in the mount line above — it carries its own
//  Bearer-token check below. Swap in `authMiddleware` instead if you'd
//  rather keep auth handling in one place — just remove the `authenticate`
//  function and the require('jsonwebtoken') line, and change the mount to:
//    app.use('/api/ai', authMiddleware, pinvNsScanRoutes);
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const jwt = require('jsonwebtoken');

function dbQuery(connection, sql, params = []) {
  return new Promise((resolve, reject) => {
    connection.query(sql, params, (err, rows) => {
      if (err) reject(err); else resolve(rows);
    });
  });
}

const MODEL = 'gemini-2.5-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET;

const PROMPT = `You are reading a supplier tax invoice for a UAE electrical contracting / switchgear company.
Return ONLY a single JSON object (no markdown fences, no preamble) with this exact shape:

{
  "companyName": string,      // the SUPPLIER's company name issuing the invoice (not the customer)
  "invNo": string,             // invoice number
  "invDate": string,           // format dd/MM/yyyy
  "lpoNo": string | null,      // purchase order / LPO reference number if shown, else null
  "doNo": string | null,       // Delivery Note / Delivery Order / D.O. number if shown, else null
  "paymentTerms": string | null, // payment terms if shown (e.g. "CASH", "30 DAYS", "CDC"), else null
  "attn": string | null,       // the "Attn:" / attention contact name on the invoice if shown, else null
  "vatAmount": number,         // total VAT amount
  "netAmount": number,         // grand total / net total payable
  "items": [
    {
      "partNo": string | null,       // item reference / part number if shown, else null
      "description": string,         // item description
      "qty": number,
      "unit": string | null,         // unit of measure (e.g. NOS, PCS) if shown, else null
      "unitPrice": number
    }
  ]
}

Extract every line item. Use 0 for any numeric value you cannot find, and null for any missing optional text field. Do not invent data.`;

function authenticate(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Missing auth token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

// ── Lightweight Jaccard token-set scorer (same idea as the cheque/customer matcher) ──
function tokenize(s) {
  return new Set(
    (s || '')
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((t) => t && !['LLC', 'LLP', 'FZE', 'FZ', 'CO', 'THE', 'AND', 'INC'].includes(t))
  );
}
function jaccardScore(a, b) {
  const ta = tokenize(a), tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersect = 0;
  for (const t of ta) if (tb.has(t)) intersect++;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : intersect / union;
}

async function callGeminiWithRetry(fileBase64, mimeType) {
  let lastData;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mimeType || 'application/pdf', data: fileBase64 } },
            { text: PROMPT },
          ],
        }],
        generationConfig: { temperature: 0, maxOutputTokens: 2048, responseMimeType: 'application/json' },
      }),
    });
    lastData = await r.json();
    if (r.status !== 503 && r.status !== 429) {
      if (!r.ok) throw new Error(lastData?.error?.message || `Gemini API error (${r.status})`);
      return lastData;
    }
    await new Promise((s) => setTimeout(s, 1500 * attempt));
  }
  throw new Error(lastData?.error?.message || 'Gemini API unavailable after retries');
}

module.exports = function (connection) {
  const router = express.Router();

  router.post('/pinv_ns_scan', authenticate, async (req, res) => {
    const { fileBase64, mimeType } = req.body;
    if (!fileBase64) return res.status(400).json({ message: 'No file provided' });
    if (!GEMINI_KEY) return res.status(500).json({ message: 'GEMINI_API_KEY is not configured on the server' });

    try {
      const data = await callGeminiWithRetry(fileBase64, mimeType);
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) return res.status(502).json({ message: 'AI did not return readable content' });

      let extracted;
      try {
        extracted = JSON.parse(text);
      } catch {
        return res.status(502).json({ message: 'AI response was not valid JSON' });
      }

      // ── Fuzzy-match the extracted company name against SUP_MST ──
      let supplierMatches = [];
      if (extracted.companyName) {
        const suppliers = await dbQuery(connection, `SELECT SUP_CODE, SUP_NAME FROM sup_mst`);
        supplierMatches = suppliers
          .map((s) => ({ SUP_CODE: s.SUP_CODE, SUP_NAME: s.SUP_NAME, score: jaccardScore(extracted.companyName, s.SUP_NAME) }))
          .filter((m) => m.score > 0.2)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3);
      }

      res.json({
        header: {
          companyName: extracted.companyName || null,
          invNo: extracted.invNo || null,
          invDate: extracted.invDate || null,
          lpoNo: extracted.lpoNo || null,
          doNo: extracted.doNo || null,
          paymentTerms: extracted.paymentTerms || null,
          attn: extracted.attn || null,
          vatAmount: Number(extracted.vatAmount) || 0,
          netAmount: Number(extracted.netAmount) || 0,
        },
        items: Array.isArray(extracted.items) ? extracted.items : [],
        supplierMatches,
      });
    } catch (err) {
      console.error('pinv_ns_scan error:', err);
      res.status(500).json({ message: err.message || 'AI scan failed' });
    }
  });

  return router;
};
