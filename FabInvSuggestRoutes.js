// FabInvSuggestRoutes.js
// ─────────────────────────────────────────────────────────────────────
// AI Suggest routes (voice/NL entry):
//
//   POST /api/fabinv-suggest  — Project (Fab) Invoice
//        parses Job No + panel lines, validates against job_card /
//        job_panels, returns header defaults + invoice line items.
//
//   POST /api/sinv-suggest    — Sales Invoice
//        parses item lines (code OR description + qty + rate),
//        resolves each against item_mst (exact ITEM_CODE first, then
//        fuzzy ITEM_NAME1), returns ITEM_NAME1 / ITEM_UNIT / CAT_CODE
//        with SALE_PRICE as the rate fallback.
//
// Register once in HayatDb.js:
//   app.use(require('./FabInvSuggestRoutes')(connection));
// ─────────────────────────────────────────────────────────────────────
module.exports = function (connection) {
  const express = require('express');
  const router = express.Router();

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  // Same model as gl_suggest_api.js (proven working on this key).
  // Override with GEMINI_MODEL in .env if you ever switch.
  const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
  const GEMINI_URL =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  // promisified query helper
  const q = (sql, params) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );

  // ── Gemini extraction (shared caller, per-endpoint prompt) ───────
  async function callGemini(prompt, tag) {
    // Same pattern as gl_suggest_api.js / ChequeScanRoutes.js
    const r = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }],
        }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 512,
          responseMimeType: 'application/json',
        },
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error(`[${tag}] Gemini API error`, JSON.stringify(data).slice(0, 400));
      throw new Error(data.error?.message || `Gemini HTTP ${r.status}`);
    }
    const outText = data.candidates?.[0]?.content?.parts
      ?.map(p => p.text || '').join('') || '';
    return JSON.parse(outText.replace(/```json|```/g, '').trim());
  }

  function geminiParse(text) {
    const prompt =
`You are a data-extraction assistant for an ERP Project Invoice screen.
The user dictates a Job Number and one or more panel lines, each with an
optional quantity and unit rate.

Return ONLY valid JSON (no markdown, no back-ticks, no commentary) in
exactly this shape:
{"jobNo":"<string>","items":[{"panelNo":"<string>","qty":<number or null>,"rate":<number or null>}]}

Rules:
- jobNo: the job/project number mentioned (words like "job", "job no",
  "job number" precede it). Keep it exactly as spoken/typed (digits, may
  include letters). If none found, use "".
- items: one entry per panel mentioned. "panel", "panel no", "sr", "item"
  may precede the number.
- qty: number after words like "qty", "quantity", "nos", "x". null if absent.
- rate: number after words like "rate", "at", "@", "price", "unit rate".
  Rates may be spoken as "5,500" or "five thousand five hundred" — output
  plain numbers. null if absent.
- Never invent panels or amounts that were not mentioned.

Text: """${text}"""`;
    return callGemini(prompt, 'fabinv-suggest');
  }

  function geminiParseSinv(text) {
    const prompt =
`You are a data-extraction assistant for an ERP Sales Invoice screen.
The user dictates one or more item lines. Each line may identify the
item by an ITEM CODE (short alphanumeric like "CBL001", "P-204") or by
a DESCRIPTION in words (like "armoured cable 4 core"), followed by an
optional quantity and unit rate.

Return ONLY valid JSON (no markdown, no back-ticks, no commentary) in
exactly this shape:
{"items":[{"itemCode":"<string or null>","itemDesc":"<string or null>","qty":<number or null>,"rate":<number or null>}]}

Rules:
- itemCode: only when the user clearly gives a code (compact token with
  digits and/or hyphens, often after "item", "code", "item code").
  Preserve it exactly, including case and hyphens. Otherwise null.
- itemDesc: the descriptive words identifying the item when no code is
  given (or in addition to it). Otherwise null. At least one of
  itemCode / itemDesc must be filled per line.
- qty: number after words like "qty", "quantity", "nos", "pieces", "x".
  null if absent.
- rate: number after words like "rate", "at", "@", "price", "each".
  Rates may be spoken as "25.50" or "twenty five dirhams fifty" — output
  plain numbers. null if absent.
- One JSON entry per item line mentioned; never invent items, quantities
  or rates that were not mentioned.

Text: """${text}"""`;
    return callGemini(prompt, 'sinv-suggest');
  }

  // ── Route ────────────────────────────────────────────────────────
  router.post('/api/fabinv-suggest', async (req, res) => {
    try {
      const { text } = req.body || {};
      if (!text || !String(text).trim())
        return res.status(400).json({ error: 'text is required' });
      if (!GEMINI_KEY)
        return res.status(500).json({ error: 'GEMINI_API_KEY not set in .env' });

      // 1) AI parse (retry once on transient Gemini failure)
      let parsed;
      try {
        parsed = await geminiParse(String(text));
      } catch (e1) {
        try { parsed = await geminiParse(String(text)); }
        catch (e2) {
          console.error('[fabinv-suggest] Gemini parse failed:', e2.message);
          return res.status(502).json({ error: 'AI parse failed: ' + e2.message });
        }
      }

      const warnings = [];
      const jobNo = String(parsed.jobNo || '').trim();
      if (!jobNo)
        return res.status(422).json({ error: 'Could not identify a Job No in the text' });

      // 2) validate Job No against job_card
      const jobRows = await q(
        `SELECT JOB_NO, CUST_CODE, LPO_NO,
                DATE_FORMAT(LPO_DATE, '%Y-%m-%d') AS LPO_DATE,
                PROJ_NAME, CONTRACT_AMT, REVENUE_AC,
                CURR_CODE, CONVERT_RATE, VAT_PERC, QUOT_REF, SMAN_CODE
           FROM job_card
          WHERE JOB_NO = ?`,
        [jobNo]
      );
      if (!jobRows.length)
        return res.status(422).json({ error: `Job No '${jobNo}' not found in Job Card` });
      const job = jobRows[0];

      // 3) resolve each panel against job_panels
      const items = [];
      let missingPanels = 0;
      let missingRates = 0;

      for (const it of parsed.items || []) {
        const pn = String(it.panelNo ?? '').trim();
        if (!pn) continue;

        const numeric = /^\d+$/.test(pn);
        const rows = numeric
          ? await q(
              `SELECT SR_NO, PANEL_REF, QTY, UNIT_RATE
                 FROM job_panels
                WHERE JOB_NO = ? AND CAST(SR_NO AS UNSIGNED) = ?
                LIMIT 1`,
              [jobNo, Number(pn)]
            )
          : await q(
              `SELECT SR_NO, PANEL_REF, QTY, UNIT_RATE
                 FROM job_panels
                WHERE JOB_NO = ? AND SR_NO = ?
                LIMIT 1`,
              [jobNo, pn]
            );

        if (!rows.length) {
          missingPanels++;
          warnings.push(`Panel '${pn}' not found in job_panels for Job ${jobNo}`);
          items.push({ panelNo: pn, panelRef: '', qty: 0, rate: 0, found: false });
          continue;
        }

        const p = rows[0];
        // spoken values win; DB values are the fallback
        const qtyNum  = Number(it.qty);
        const rateNum = Number(it.rate);
        const qty  = Number.isFinite(qtyNum)  && qtyNum  > 0 ? qtyNum  : Number(p.QTY)       || 1;
        const rate = Number.isFinite(rateNum) && rateNum > 0 ? rateNum : Number(p.UNIT_RATE) || 0;
        if (!(rate > 0)) {
          missingRates++;
          warnings.push(`Panel '${pn}': no rate spoken and no UNIT_RATE on file — please fill in`);
        }
        items.push({
          panelNo: String(p.SR_NO),
          panelRef: p.PANEL_REF || '',
          qty,
          rate,
          found: true,
        });
      }

      if (!items.length)
        warnings.push('No panel lines were identified — only header details will be filled');

      const confidence =
        missingPanels > 0 ? 'low' :
        (missingRates > 0 || !items.length) ? 'medium' : 'high';

      return res.json({
        header: {
          JOB_NO:       job.JOB_NO,
          CUST_CODE:    job.CUST_CODE || '',
          LPO_NO:       job.LPO_NO || '',
          LPO_DATE:     job.LPO_DATE || '',
          PROJ_NAME:    job.PROJ_NAME || '',
          CONTRACT_AMT: Number(job.CONTRACT_AMT) || 0,
          REVENUE_AC:   job.REVENUE_AC || '',
          CURR_CODE:    job.CURR_CODE || '',
          CONVERT_RATE: Number(job.CONVERT_RATE) || 0,
          VAT_PERC:     Number(job.VAT_PERC) || 5,
          QUOT_REF:     job.QUOT_REF || '',
          SMAN_CODE:    job.SMAN_CODE || '',
        },
        items,
        warnings,
        confidence,
      });
    } catch (err) {
      console.error('[fabinv-suggest] error:', err);
      return res.status(500).json({ error: 'fabinv-suggest failed: ' + err.message });
    }
  });

  // ── Route: Sales Invoice ─────────────────────────────────────────
  // Resolves one line against item_mst: exact ITEM_CODE first, then
  // fuzzy ITEM_NAME1 (whole phrase LIKE, then all-words AND LIKE).
  async function resolveItem(line) {
    const code = String(line.itemCode || '').trim();
    const desc = String(line.itemDesc || '').trim();

    // 1) exact code (case-insensitive; item_mst PK is LOC_CODE+ITEM_CODE
    //    so take the first location's row)
    if (code) {
      const rows = await q(
        `SELECT ITEM_CODE, ITEM_NAME1, ITEM_UNIT, CAT_CODE, SALE_PRICE
           FROM item_mst
          WHERE UPPER(ITEM_CODE) = UPPER(?)
          LIMIT 1`,
        [code]
      );
      if (rows.length) return { row: rows[0], matchedBy: 'code' };
    }

    // 2) fuzzy by description
    const phrase = desc || code; // fall back to searching the code text as a name
    if (phrase) {
      // 2a) whole phrase
      let rows = await q(
        `SELECT ITEM_CODE, ITEM_NAME1, ITEM_UNIT, CAT_CODE, SALE_PRICE
           FROM item_mst
          WHERE ITEM_NAME1 LIKE ?
          ORDER BY CHAR_LENGTH(ITEM_NAME1)
          LIMIT 1`,
        [`%${phrase}%`]
      );
      if (rows.length) return { row: rows[0], matchedBy: 'name' };

      // 2b) every word must appear (order-independent)
      const words = phrase.split(/\s+/).filter(w => w.length > 1);
      if (words.length > 1) {
        const conds = words.map(() => 'ITEM_NAME1 LIKE ?').join(' AND ');
        rows = await q(
          `SELECT ITEM_CODE, ITEM_NAME1, ITEM_UNIT, CAT_CODE, SALE_PRICE
             FROM item_mst
            WHERE ${conds}
            ORDER BY CHAR_LENGTH(ITEM_NAME1)
            LIMIT 1`,
          words.map(w => `%${w}%`)
        );
        if (rows.length) return { row: rows[0], matchedBy: 'name' };
      }
    }
    return { row: null, matchedBy: '' };
  }

  router.post('/api/sinv-suggest', async (req, res) => {
    try {
      const { text } = req.body || {};
      if (!text || !String(text).trim())
        return res.status(400).json({ error: 'text is required' });
      if (!GEMINI_KEY)
        return res.status(500).json({ error: 'GEMINI_API_KEY not set in .env' });

      // 1) AI parse (retry once on transient Gemini failure)
      let parsed;
      try {
        parsed = await geminiParseSinv(String(text));
      } catch (e1) {
        try { parsed = await geminiParseSinv(String(text)); }
        catch (e2) {
          console.error('[sinv-suggest] Gemini parse failed:', e2.message);
          return res.status(502).json({ error: 'AI parse failed: ' + e2.message });
        }
      }

      const lines = parsed.items || [];
      if (!lines.length)
        return res.status(422).json({ error: 'Could not identify any item lines in the text' });

      const warnings = [];
      const items = [];
      let missingItems = 0;
      let missingRates = 0;

      for (const line of lines) {
        const spoken = String(line.itemCode || line.itemDesc || '').trim();
        if (!spoken) continue;

        const { row, matchedBy } = await resolveItem(line);
        if (!row) {
          missingItems++;
          warnings.push(`'${spoken}' not found in Item Master`);
          items.push({
            itemCode: String(line.itemCode || ''),
            itemDesc: String(line.itemDesc || ''),
            unit: '', catCode: '', qty: 0, rate: 0,
            found: false, matchedBy: '',
          });
          continue;
        }

        // spoken values win; item_mst is the fallback
        const qtyNum  = Number(line.qty);
        const rateNum = Number(line.rate);
        const qty  = Number.isFinite(qtyNum)  && qtyNum  > 0 ? qtyNum  : 1;
        const rate = Number.isFinite(rateNum) && rateNum > 0 ? rateNum : Number(row.SALE_PRICE) || 0;
        if (!(rate > 0)) {
          missingRates++;
          warnings.push(`'${row.ITEM_NAME1}': no rate spoken and no SALE_PRICE on file — please fill in`);
        }
        items.push({
          itemCode: row.ITEM_CODE,
          itemDesc: row.ITEM_NAME1 || '',
          unit: row.ITEM_UNIT || '',
          catCode: row.CAT_CODE || '',
          qty,
          rate,
          found: true,
          matchedBy,
        });
      }

      const confidence =
        missingItems > 0 ? 'low' :
        missingRates > 0 ? 'medium' : 'high';

      return res.json({ items, warnings, confidence });
    } catch (err) {
      console.error('[sinv-suggest] error:', err);
      return res.status(500).json({ error: 'sinv-suggest failed: ' + err.message });
    }
  });

  return router;
};
