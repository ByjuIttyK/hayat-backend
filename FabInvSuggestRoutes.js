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

  function geminiParseSupplier(text) {
    const prompt =
`You are a data-extraction assistant for an ERP Supplier Master entry
screen. The user dictates supplier details in free form — possibly only
some of the fields.

Return ONLY valid JSON (no markdown, no back-ticks, no commentary) in
exactly this shape (use null for anything not mentioned):
{"supplierName":null,"address1":null,"address2":null,"pinCode":null,
"countryCode":null,"contactPerson":null,"email":null,"tel1":null,
"tel2":null,"fax1":null,"fax2":null,"lpoLimit":null,"creditLimit":null,
"creditDays":null,"vatRegNo":null,"supplierType":null,
"openingBalance":null,"openingBalanceType":null}

Rules:
- supplierName: the company/firm name (words like "supplier", "company",
  "name" may precede it). Keep legal suffixes (LLC, FZE, Trading, etc).
- address1 / address2: street-building part in address1, area-district
  or city part in address2, when distinguishable; else all in address1.
- pinCode: postal/PIN/PO box number if spoken.
- countryCode: country as a short code or name exactly as spoken
  ("UAE", "India", "KSA").
- contactPerson: a person's name ("contact", "attention", "Mr/Ms" cues).
- email: spoken emails like "info at domain dot com" must be converted
  to info@domain.com, lower-case.
- tel1 / tel2 / fax1 / fax2: phone numbers in the order mentioned;
  "fax" cues go to fax fields. Keep digits, +, and spaces only.
- lpoLimit / creditLimit / openingBalance: plain numbers ("fifty
  thousand" → 50000).
- creditDays: number of days ("credit period 60 days" → 60).
- vatRegNo: TRN / VAT registration number, digits as spoken.
- supplierType: "local" or "overseas" if stated.
- openingBalanceType: "Dr" or "Cr" if debit/credit is stated for the
  opening balance.
- Never invent values that were not mentioned.

Text: """${text}"""`;
    return callGemini(prompt, 'supmst-suggest');
  }

  // ── Route: Supplier Master (pure extraction, no DB validation) ────
  router.post('/api/supmst-suggest', async (req, res) => {
    try {
      const { text } = req.body || {};
      if (!text || !String(text).trim())
        return res.status(400).json({ error: 'text is required' });
      if (!GEMINI_KEY)
        return res.status(500).json({ error: 'GEMINI_API_KEY not set in .env' });

      let parsed;
      try {
        parsed = await geminiParseSupplier(String(text));
      } catch (e1) {
        try { parsed = await geminiParseSupplier(String(text)); }
        catch (e2) {
          console.error('[supmst-suggest] Gemini parse failed:', e2.message);
          return res.status(502).json({ error: 'AI parse failed: ' + e2.message });
        }
      }

      // light normalization; every field stays null unless spoken
      const str = (v) => (v == null ? null : String(v).trim() || null);
      const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
      const fields = {
        supplierName: str(parsed.supplierName),
        address1: str(parsed.address1),
        address2: str(parsed.address2),
        pinCode: str(parsed.pinCode),
        countryCode: str(parsed.countryCode) ? String(parsed.countryCode).toUpperCase() : null,
        contactPerson: str(parsed.contactPerson),
        email: str(parsed.email) ? String(parsed.email).toLowerCase().replace(/\s+/g, '') : null,
        tel1: str(parsed.tel1),
        tel2: str(parsed.tel2),
        fax1: str(parsed.fax1),
        fax2: str(parsed.fax2),
        lpoLimit: num(parsed.lpoLimit),
        creditLimit: num(parsed.creditLimit),
        creditDays: num(parsed.creditDays),
        vatRegNo: str(parsed.vatRegNo),
        supplierType:
          /overseas|foreign|import/i.test(String(parsed.supplierType || '')) ? 'overseas'
          : /local|domestic|uae/i.test(String(parsed.supplierType || '')) ? 'local'
          : null,
        openingBalance: num(parsed.openingBalance),
        openingBalanceType:
          /^d/i.test(String(parsed.openingBalanceType || '')) ? 'Dr'
          : /^c/i.test(String(parsed.openingBalanceType || '')) ? 'Cr'
          : null,
      };

      const filled = Object.values(fields).filter((v) => v !== null).length;
      if (filled === 0)
        return res.status(422).json({ error: 'Could not identify any supplier details in the text' });

      // ── resolve spoken country against nation_mst ─────────────────
      const warnings = [];
      if (fields.countryCode) {
        const spoken = fields.countryCode;                       // e.g. "UAE", "INDIA"
        const norm = spoken.replace(/[^A-Z0-9]/g, '');           // "U.A.E" → "UAE"
        try {
          // 1) exact match on code / name / nationality, dots+spaces ignored
          let rows = await q(
            `SELECT NATION_CODE, NATION_NAME FROM nation_mst
              WHERE UPPER(REPLACE(REPLACE(NATION_CODE,'.',''),' ','')) = ?
                 OR UPPER(REPLACE(REPLACE(NATION_NAME,'.',''),' ','')) = ?
                 OR UPPER(REPLACE(REPLACE(NATIONALITY,'.',''),' ','')) = ?
              LIMIT 1`,
            [norm, norm, norm]
          );
          // 2) fuzzy contains on name / nationality, shortest name wins
          if (!rows.length) {
            rows = await q(
              `SELECT NATION_CODE, NATION_NAME FROM nation_mst
                WHERE UPPER(NATION_NAME) LIKE ? OR UPPER(NATIONALITY) LIKE ?
                ORDER BY CHAR_LENGTH(NATION_NAME)
                LIMIT 1`,
              [`%${spoken}%`, `%${spoken}%`]
            );
          }
          if (rows.length) {
            fields.countryCode = rows[0].NATION_CODE;            // the real code
          } else {
            warnings.push(`Country '${spoken}' not found in Nation Master — please select it manually`);
            fields.countryCode = null;                            // let Yup force a manual pick
          }
        } catch (e) {
          console.warn('[supmst-suggest] nation lookup failed:', e.message);
          warnings.push(`Country '${spoken}' could not be verified — please confirm`);
        }
      }

      const confidence = fields.supplierName ? (filled >= 5 ? 'high' : 'medium') : 'low';
      return res.json({ fields, confidence, warnings });
    } catch (err) {
      console.error('[supmst-suggest] error:', err);
      return res.status(500).json({ error: 'supmst-suggest failed: ' + err.message });
    }
  });

  function geminiParseCustomer(text) {
    const prompt =
`You are a data-extraction assistant for an ERP Customer Master entry
screen. The user dictates customer details in free form — possibly only
some of the fields.

Return ONLY valid JSON (no markdown, no back-ticks, no commentary) in
exactly this shape (use null for anything not mentioned):
{"customerName":null,"address1":null,"address2":null,"address3":null,
"address4":null,"tel":null,"fax":null,"email":null,"country":null,
"paymentTerms":null,"creditLimit":null,"crTerms":null,"vatRegNo":null,
"quotationLimit":null,"blockDeliveryOrder":null}

Rules:
- customerName: the company/firm name; keep legal suffixes (LLC, FZE...).
- address1..address4: street/building → address1, area/district →
  address2, city → address3, country/region → address4, when
  distinguishable; otherwise fill in order.
- tel / fax: numbers; "fax" cues go to fax. Keep digits, +, spaces.
- email: spoken emails ("info at domain dot com") → info@domain.com,
  lower-case.
- country: country name or code exactly as spoken ("UAE", "India").
- paymentTerms: as a short phrase or number of days ("30 days",
  "60 days PDC", "advance").
- creditLimit / quotationLimit: plain numbers ("one lakh" → 100000,
  "fifty thousand" → 50000).
- crTerms: "C" if cash is stated, "D" if credit is stated, else null.
- vatRegNo: TRN / VAT registration number, digits as spoken.
- blockDeliveryOrder: "blocked" or "active" if stated.
- Never invent values that were not mentioned.

Text: """${text}"""`;
    return callGemini(prompt, 'cusmst-suggest');
  }

  // ── Route: Customer Master (extraction + nation validation) ───────
  router.post('/api/cusmst-suggest', async (req, res) => {
    try {
      const { text } = req.body || {};
      if (!text || !String(text).trim())
        return res.status(400).json({ error: 'text is required' });
      if (!GEMINI_KEY)
        return res.status(500).json({ error: 'GEMINI_API_KEY not set in .env' });

      let parsed;
      try {
        parsed = await geminiParseCustomer(String(text));
      } catch (e1) {
        try { parsed = await geminiParseCustomer(String(text)); }
        catch (e2) {
          console.error('[cusmst-suggest] Gemini parse failed:', e2.message);
          return res.status(502).json({ error: 'AI parse failed: ' + e2.message });
        }
      }

      const str = (v) => (v == null ? null : String(v).trim() || null);
      const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
      const fields = {
        customerName: str(parsed.customerName),
        address1: str(parsed.address1),
        address2: str(parsed.address2),
        address3: str(parsed.address3),
        address4: str(parsed.address4),
        tel: str(parsed.tel),
        fax: str(parsed.fax),
        email: str(parsed.email) ? String(parsed.email).toLowerCase().replace(/\s+/g, '') : null,
        country: str(parsed.country) ? String(parsed.country).toUpperCase() : null,
        nationCode: null, // filled from nation_mst below
        paymentTerms: str(parsed.paymentTerms),
        creditLimit: num(parsed.creditLimit),
        crTerms:
          /^c(ash)?$/i.test(String(parsed.crTerms || '')) ? 'C'
          : /^d$|credit/i.test(String(parsed.crTerms || '')) ? 'D'
          : null,
        vatRegNo: str(parsed.vatRegNo),
        quotationLimit: num(parsed.quotationLimit),
        blockDeliveryOrder:
          /block/i.test(String(parsed.blockDeliveryOrder || '')) ? 'blocked'
          : /active|open|allow/i.test(String(parsed.blockDeliveryOrder || '')) ? 'active'
          : null,
      };

      const warnings = [];
      if (fields.country) {
        const spoken = fields.country;
        const norm = spoken.replace(/[^A-Z0-9]/g, '');
        try {
          let rows = await q(
            `SELECT NATION_CODE, NATION_NAME FROM nation_mst
              WHERE UPPER(REPLACE(REPLACE(NATION_CODE,'.',''),' ','')) = ?
                 OR UPPER(REPLACE(REPLACE(NATION_NAME,'.',''),' ','')) = ?
                 OR UPPER(REPLACE(REPLACE(NATIONALITY,'.',''),' ','')) = ?
              LIMIT 1`,
            [norm, norm, norm]
          );
          if (!rows.length) {
            rows = await q(
              `SELECT NATION_CODE, NATION_NAME FROM nation_mst
                WHERE UPPER(NATION_NAME) LIKE ? OR UPPER(NATIONALITY) LIKE ?
                ORDER BY CHAR_LENGTH(NATION_NAME)
                LIMIT 1`,
              [`%${spoken}%`, `%${spoken}%`]
            );
          }
          if (rows.length) {
            fields.nationCode = rows[0].NATION_CODE;
          } else {
            warnings.push(`Country '${spoken}' not found in Nation Master — please select it manually`);
            fields.country = null;
          }
        } catch (e) {
          console.warn('[cusmst-suggest] nation lookup failed:', e.message);
          warnings.push(`Country '${spoken}' could not be verified — please confirm`);
        }
      }

      const filled = Object.values(fields).filter((v) => v !== null).length;
      if (filled === 0)
        return res.status(422).json({ error: 'Could not identify any customer details in the text' });

      const confidence = fields.customerName ? (filled >= 5 ? 'high' : 'medium') : 'low';
      return res.json({ fields, confidence, warnings });
    } catch (err) {
      console.error('[cusmst-suggest] error:', err);
      return res.status(500).json({ error: 'cusmst-suggest failed: ' + err.message });
    }
  });

  function geminiParseAccount(text) {
    const prompt =
`You are a data-extraction assistant for an ERP Account Master (chart of
accounts) entry screen. The user dictates account details in free form —
possibly only some of the fields.

Return ONLY valid JSON (no markdown, no back-ticks, no commentary) in
exactly this shape (use null for anything not mentioned):
{"accCode":null,"accHead":null,"glCode":null,"subCatCode":null,
"reportLine":null,"openingBalance":null,"openingBalanceType":null}

Rules:
- accCode: the account code if spoken ("account code SAL001",
  "code 110234"). Alphanumeric, keep exactly as spoken, no spaces.
- accHead: the account name/title ("account head", "account name",
  "head" cues — e.g. "Salaries and Wages", "AIKA Trading LLC").
- glCode: the GL group/control code, up to 4 characters ("GL code 1001",
  "under GL 2050").
- subCatCode: sub-category code, up to 8 characters ("sub category A01").
- reportLine: report line reference if spoken.
- openingBalance: plain number ("twenty five thousand" → 25000).
- openingBalanceType: "Dr" or "Cr" if debit/credit is stated.
- Never invent values that were not mentioned.

Text: """${text}"""`;
    return callGemini(prompt, 'accmst-suggest');
  }

  // ── Route: Account Master (pure extraction) ───────────────────────
  router.post('/api/accmst-suggest', async (req, res) => {
    try {
      const { text } = req.body || {};
      if (!text || !String(text).trim())
        return res.status(400).json({ error: 'text is required' });
      if (!GEMINI_KEY)
        return res.status(500).json({ error: 'GEMINI_API_KEY not set in .env' });

      let parsed;
      try {
        parsed = await geminiParseAccount(String(text));
      } catch (e1) {
        try { parsed = await geminiParseAccount(String(text)); }
        catch (e2) {
          console.error('[accmst-suggest] Gemini parse failed:', e2.message);
          return res.status(502).json({ error: 'AI parse failed: ' + e2.message });
        }
      }

      const str = (v) => (v == null ? null : String(v).trim() || null);
      const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
      const fields = {
        accCode: str(parsed.accCode) ? String(parsed.accCode).toUpperCase().replace(/\s+/g, '') : null,
        accHead: str(parsed.accHead),
        glCode: str(parsed.glCode) ? String(parsed.glCode).toUpperCase().slice(0, 4) : null,
        subCatCode: str(parsed.subCatCode) ? String(parsed.subCatCode).toUpperCase().slice(0, 8) : null,
        reportLine: str(parsed.reportLine),
        openingBalance: num(parsed.openingBalance),
        openingBalanceType:
          /^d/i.test(String(parsed.openingBalanceType || '')) ? 'Dr'
          : /^c/i.test(String(parsed.openingBalanceType || '')) ? 'Cr'
          : null,
      };

      const filled = Object.values(fields).filter((v) => v !== null).length;
      if (filled === 0)
        return res.status(422).json({ error: 'Could not identify any account details in the text' });

      const confidence = fields.accHead ? (filled >= 3 ? 'high' : 'medium') : 'low';
      return res.json({ fields, confidence, warnings: [] });
    } catch (err) {
      console.error('[accmst-suggest] error:', err);
      return res.status(500).json({ error: 'accmst-suggest failed: ' + err.message });
    }
  });

  function geminiParseLpo(text) {
    const prompt =
`You are a data-extraction assistant for an ERP Local Purchase Order
(LPO) entry screen. The user dictates, in one utterance, header details
(supplier, date, narration, attention) and one or more item lines
(item code OR description, quantity, unit, rate).

Return ONLY valid JSON (no markdown, no back-ticks, no commentary) in
exactly this shape (null for anything not mentioned):
{"supplierCode":null,"supplierName":null,"lpoDate":null,
"narration":null,"attention":null,
"items":[{"itemCode":null,"itemDesc":null,"qty":null,"unit":null,"rate":null}]}

Rules:
- supplierCode: only when a compact code is clearly spoken ("supplier
  code 1S0050"). Preserve exactly.
- supplierName: the supplier firm name when spoken ("LPO for Spectrum
  Middle East Trading"). Keep legal suffixes.
- lpoDate: date if spoken, output as yyyy-MM-dd ("14 April 2026" →
  "2026-04-14"). null if not mentioned.
- narration / attention: free text after those cue words.
- items: one entry per line mentioned. itemCode only for compact codes;
  itemDesc for descriptive phrases ("low smoke panel wire 1.5 sqmm
  brown"). qty after "qty/nos/rolls/pieces/x". unit if spoken (RL, MTR,
  NOS, PCS...). rate after "rate/at/@/each" — plain numbers.
- Never invent values that were not mentioned.

Text: """${text}"""`;
    return callGemini(prompt, 'lpo-suggest');
  }

  // ── Route: Local Purchase Order (header + items in one pass) ──────
  // Supplier resolved against sup_mst (exact code, then fuzzy name);
  // items against item_mst with PURCHASE price fallback (LAST_COST,
  // then COST_PRICE) — not SALE_PRICE, since this is a buying document.
  router.post('/api/lpo-suggest', async (req, res) => {
    try {
      const { text } = req.body || {};
      if (!text || !String(text).trim())
        return res.status(400).json({ error: 'text is required' });
      if (!GEMINI_KEY)
        return res.status(500).json({ error: 'GEMINI_API_KEY not set in .env' });

      let parsed;
      try {
        parsed = await geminiParseLpo(String(text));
      } catch (e1) {
        try { parsed = await geminiParseLpo(String(text)); }
        catch (e2) {
          console.error('[lpo-suggest] Gemini parse failed:', e2.message);
          return res.status(502).json({ error: 'AI parse failed: ' + e2.message });
        }
      }

      const warnings = [];
      const str = (v) => (v == null ? null : String(v).trim() || null);

      // ── supplier: exact code, else fuzzy name (whole phrase → all words)
      let supCode = null, supName = null;
      const spokenCode = str(parsed.supplierCode);
      const spokenName = str(parsed.supplierName);
      if (spokenCode || spokenName) {
        try {
          let rows = [];
          if (spokenCode) {
            rows = await q(
              `SELECT SUP_CODE, SUP_NAME FROM sup_mst
                WHERE UPPER(SUP_CODE) = UPPER(?) LIMIT 1`, [spokenCode]);
          }
          if (!rows.length && spokenName) {
            rows = await q(
              `SELECT SUP_CODE, SUP_NAME FROM sup_mst
                WHERE UPPER(SUP_NAME) LIKE ?
                ORDER BY CHAR_LENGTH(SUP_NAME) LIMIT 1`,
              [`%${spokenName.toUpperCase()}%`]);
            if (!rows.length) {
              const words = spokenName.toUpperCase().split(/\s+/).filter(w => w.length > 2);
              if (words.length > 1) {
                const conds = words.map(() => 'UPPER(SUP_NAME) LIKE ?').join(' AND ');
                rows = await q(
                  `SELECT SUP_CODE, SUP_NAME FROM sup_mst
                    WHERE ${conds}
                    ORDER BY CHAR_LENGTH(SUP_NAME) LIMIT 1`,
                  words.map(w => `%${w}%`));
              }
            }
          }
          if (rows.length) {
            supCode = rows[0].SUP_CODE;
            supName = rows[0].SUP_NAME;
          } else {
            warnings.push(`Supplier '${spokenName || spokenCode}' not found in Supplier Master — please select manually`);
          }
        } catch (e) {
          console.warn('[lpo-suggest] supplier lookup failed:', e.message);
          warnings.push('Supplier could not be verified — please confirm');
        }
      }

      // ── items: exact code, else fuzzy ITEM_NAME1; purchase-cost fallback
      const items = [];
      let missingItems = 0, missingRates = 0;
      for (const line of parsed.items || []) {
        const code = str(line.itemCode);
        const desc = str(line.itemDesc);
        const spoken = code || desc;
        if (!spoken) continue;

        let rows = [];
        if (code) {
          rows = await q(
            `SELECT ITEM_CODE, ITEM_NAME1, ITEM_UNIT, CAT_CODE, LAST_COST, COST_PRICE
               FROM item_mst WHERE UPPER(ITEM_CODE) = UPPER(?) LIMIT 1`, [code]);
        }
        const phrase = desc || code;
        if (!rows.length && phrase) {
          rows = await q(
            `SELECT ITEM_CODE, ITEM_NAME1, ITEM_UNIT, CAT_CODE, LAST_COST, COST_PRICE
               FROM item_mst WHERE ITEM_NAME1 LIKE ?
               ORDER BY CHAR_LENGTH(ITEM_NAME1) LIMIT 1`, [`%${phrase}%`]);
          if (!rows.length) {
            const words = phrase.split(/\s+/).filter(w => w.length > 1);
            if (words.length > 1) {
              const conds = words.map(() => 'ITEM_NAME1 LIKE ?').join(' AND ');
              rows = await q(
                `SELECT ITEM_CODE, ITEM_NAME1, ITEM_UNIT, CAT_CODE, LAST_COST, COST_PRICE
                   FROM item_mst WHERE ${conds}
                   ORDER BY CHAR_LENGTH(ITEM_NAME1) LIMIT 1`,
                words.map(w => `%${w}%`));
            }
          }
        }

        if (!rows.length) {
          missingItems++;
          warnings.push(`'${spoken}' not found in Item Master`);
          items.push({ itemCode: code || '', itemName: desc || '', unit: '', catCode: '', qty: 0, rate: 0, found: false });
          continue;
        }
        const it = rows[0];
        const qtyNum = Number(line.qty);
        const rateNum = Number(line.rate);
        const qty = Number.isFinite(qtyNum) && qtyNum > 0 ? qtyNum : 1;
        const rate = Number.isFinite(rateNum) && rateNum > 0
          ? rateNum
          : (Number(it.LAST_COST) || Number(it.COST_PRICE) || 0);
        if (!(rate > 0)) {
          missingRates++;
          warnings.push(`'${it.ITEM_NAME1}': no rate spoken and no cost on file — please fill in`);
        }
        items.push({
          itemCode: it.ITEM_CODE,
          itemName: it.ITEM_NAME1 || '',
          unit: str(line.unit) || it.ITEM_UNIT || '',
          catCode: it.CAT_CODE || '',
          qty, rate, found: true,
        });
      }

      if (!supCode && !items.length)
        return res.status(422).json({ error: 'Could not identify a supplier or any items in the text' });

      const confidence =
        (!supCode && (spokenCode || spokenName)) || missingItems > 0 ? 'low' :
        missingRates > 0 ? 'medium' : 'high';

      return res.json({
        header: {
          supCode: supCode || '',
          supName: supName || '',
          lpoDate: str(parsed.lpoDate) || '',
          narration: str(parsed.narration) || '',
          attention: str(parsed.attention) || '',
        },
        items, warnings, confidence,
      });
    } catch (err) {
      console.error('[lpo-suggest] error:', err);
      return res.status(500).json({ error: 'lpo-suggest failed: ' + err.message });
    }
  });

  function geminiParsePinv(text) {
    const prompt =
`You are a data-extraction assistant for an ERP Purchase Invoice (Local)
entry screen. The user dictates a voucher date and an SRV (Store Receipt
Voucher) number; the system will pull the rest from the SRV.

Return ONLY valid JSON (no markdown, no back-ticks, no commentary) in
exactly this shape (null for anything not mentioned):
{"srvNo":null,"vchrDate":null,"narration":null}

Rules:
- srvNo: the SRV / GRN / receipt voucher number ("SRV 12345",
  "receipt number 000123"). Keep digits/letters exactly, no spaces.
- vchrDate: the voucher date if spoken, output as yyyy-MM-dd
  ("18 July 2026" → "2026-07-18"). null if not mentioned.
- narration: free text after "narration"/"remarks" cues.
- Never invent values that were not mentioned.

Text: """${text}"""`;
    return callGemini(prompt, 'pinvlocal-suggest');
  }

  // ── Route: Purchase Invoice Local — pull everything from the SRV ──
  router.post('/api/pinvlocal-suggest', async (req, res) => {
    try {
      const { text } = req.body || {};
      if (!text || !String(text).trim())
        return res.status(400).json({ error: 'text is required' });
      if (!GEMINI_KEY)
        return res.status(500).json({ error: 'GEMINI_API_KEY not set in .env' });

      let parsed;
      try {
        parsed = await geminiParsePinv(String(text));
      } catch (e1) {
        try { parsed = await geminiParsePinv(String(text)); }
        catch (e2) {
          console.error('[pinvlocal-suggest] Gemini parse failed:', e2.message);
          return res.status(502).json({ error: 'AI parse failed: ' + e2.message });
        }
      }

      const srvNo = String(parsed.srvNo || '').trim();
      if (!srvNo)
        return res.status(422).json({ error: 'Could not identify an SRV number in the text' });

      // header from srv_hdr (+ supplier name)
      const hdrRows = await q(
        `SELECT h.SRV_NO,
                DATE_FORMAT(h.SRV_DATE, '%d/%m/%Y') AS SRV_DATE,
                h.SUP_CODE, s.SUP_NAME,
                h.INV_NO,
                DATE_FORMAT(h.INV_DATE, '%d/%m/%Y') AS INV_DATE,
                h.LPO_NO, h.PO_NO, h.NARRATION,
                h.DISCOUNT, h.VAT_PERC, h.VAT_AMOUNT,
                h.INV_AMOUNT, h.INV_AMT_VAT
           FROM srv_hdr h
           LEFT JOIN sup_mst s ON s.SUP_CODE = h.SUP_CODE
          WHERE h.SRV_NO = ?
          LIMIT 1`,
        [srvNo]
      );
      if (!hdrRows.length)
        return res.status(422).json({ error: `SRV No '${srvNo}' not found in SRV_HDR` });
      const h = hdrRows[0];

      // items from srv_items; item name joined on ITEM_CODE **and**
      // LOC_CODE so multi-location item_mst can't fan the rows out
      const itemRows = await q(
        `SELECT si.SR_NO, si.LOC_CODE, si.ITEM_CODE,
                i.ITEM_NAME1,
                si.QTY, si.COST,
                COALESCE(NULLIF(si.SRV_UNIT, ''), NULLIF(si.ITEM_UNIT, ''), i.ITEM_UNIT) AS UNIT,
                si.ACC_CODE, si.JOB_NO, si.PO_NO,
                DATE_FORMAT(si.SRV_DATE, '%d/%m/%Y') AS SRV_DATE
           FROM srv_items si
           LEFT JOIN item_mst i
             ON i.ITEM_CODE = si.ITEM_CODE AND i.LOC_CODE = si.LOC_CODE
          WHERE si.SRV_NO = ?
          ORDER BY CAST(si.SR_NO AS UNSIGNED)`,
        [srvNo]
      );

      const warnings = [];
      if (!itemRows.length)
        warnings.push(`SRV '${srvNo}' has no item lines in SRV_ITEMS`);

      const items = itemRows.map((r) => ({
        srvNo: r.SRV_NO || srvNo,
        srvDate: r.SRV_DATE || '',
        srNo: Number(r.SR_NO) || 0,
        locCode: r.LOC_CODE || '',
        itemCode: r.ITEM_CODE || '',
        itemName: r.ITEM_NAME1 || '',
        qty: Number(r.QTY) || 0,
        rate: Number(r.COST) || 0,
        unit: r.UNIT || '',
        accCode: r.ACC_CODE || '',
        jobNo: r.JOB_NO || '',
        poNo: r.PO_NO || '',
      }));

      const grossAmount = items.reduce((s2, it) => s2 + it.qty * it.rate, 0);

      return res.json({
        header: {
          srvNo: h.SRV_NO,
          srvDate: h.SRV_DATE || '',
          vchrDate: String(parsed.vchrDate || '').trim() || '',   // spoken voucher date (yyyy-MM-dd)
          supCode: h.SUP_CODE || '',
          supName: h.SUP_NAME || '',
          invNo: h.INV_NO || '',
          invDate: h.INV_DATE || '',
          lpoNo: h.LPO_NO || h.PO_NO || '',
          narration: String(parsed.narration || '').trim() || h.NARRATION || '',
          discount: Number(h.DISCOUNT) || 0,
          vatAmount: Number(h.VAT_AMOUNT) || 0,
          invAmount: Number(h.INV_AMOUNT) || 0,
          grossAmount,
        },
        items,
        warnings,
        confidence: items.length ? 'high' : 'medium',
      });
    } catch (err) {
      console.error('[pinvlocal-suggest] error:', err);
      return res.status(500).json({ error: 'pinvlocal-suggest failed: ' + err.message });
    }
  });

  function geminiParsePinv(text) {
    const prompt =
`You are a data-extraction assistant for an ERP Purchase Invoice (Local)
entry screen. The user dictates mainly a voucher date and one or more
SRV (Stores Receipt Voucher) numbers; optionally a supplier invoice
number/date and a narration.

Return ONLY valid JSON (no markdown, no back-ticks, no commentary) in
exactly this shape (null / [] for anything not mentioned):
{"vchrDate":null,"srvNos":[],"invNo":null,"invDate":null,"narration":null}

Rules:
- vchrDate: the voucher/document date, output yyyy-MM-dd
  ("18 July 2026" → "2026-07-18"; "today" → null).
- srvNos: every SRV/GRV/receipt number mentioned, as strings, digits
  kept exactly ("SRV 1234 and 1235" → ["1234","1235"]).
- invNo / invDate: the SUPPLIER's invoice number and date if spoken
  (invDate as yyyy-MM-dd).
- narration: free text after "narration"/"remarks".
- Never invent values that were not mentioned.

Text: """${text}"""`;
    return callGemini(prompt, 'pinv-suggest');
  }

  // ── Route: Purchase Invoice Local — pull from SRV_HDR / SRV_ITEMS ─
  router.post('/api/pinv-suggest', async (req, res) => {
    try {
      const { text } = req.body || {};
      if (!text || !String(text).trim())
        return res.status(400).json({ error: 'text is required' });
      if (!GEMINI_KEY)
        return res.status(500).json({ error: 'GEMINI_API_KEY not set in .env' });

      let parsed;
      try {
        parsed = await geminiParsePinv(String(text));
      } catch (e1) {
        try { parsed = await geminiParsePinv(String(text)); }
        catch (e2) {
          console.error('[pinv-suggest] Gemini parse failed:', e2.message);
          return res.status(502).json({ error: 'AI parse failed: ' + e2.message });
        }
      }

      const str = (v) => (v == null ? null : String(v).trim() || null);
      const srvNos = (parsed.srvNos || []).map(n => String(n).trim()).filter(Boolean);
      if (!srvNos.length)
        return res.status(422).json({ error: 'Could not identify any SRV number in the text' });

      const warnings = [];
      const hdrAgg = {
        supCode: '', supName: '', lpoNo: '', invNo: '', invDate: '',
        narration: '', discount: 0, vatAmount: 0, invAmount: 0,
      };
      const items = [];
      const srvFound = [];

      for (const srvNo of srvNos) {
        const hdrs = await q(
          `SELECT SRV_NO, DATE_FORMAT(SRV_DATE,'%Y-%m-%d') AS SRV_DATE,
                  SUP_CODE, LPO_NO, PO_NO, INV_NO,
                  DATE_FORMAT(INV_DATE,'%Y-%m-%d') AS INV_DATE,
                  NARRATION, DISCOUNT, VAT_AMOUNT, INV_AMOUNT, PJV_NO
             FROM SRV_HDR
            WHERE SRV_NO = ?
            LIMIT 1`,
          [srvNo]
        );
        if (!hdrs.length) {
          warnings.push(`SRV '${srvNo}' not found in SRV_HDR`);
          continue;
        }
        const h = hdrs[0];
        if (h.PJV_NO && String(h.PJV_NO).trim())
          warnings.push(`SRV '${srvNo}' already invoiced (PJV ${h.PJV_NO}) — please confirm before saving`);

        if (!hdrAgg.supCode) hdrAgg.supCode = h.SUP_CODE || '';
        else if (h.SUP_CODE && h.SUP_CODE !== hdrAgg.supCode)
          warnings.push(`SRV '${srvNo}' belongs to a different supplier (${h.SUP_CODE}) — using ${hdrAgg.supCode}`);

        if (!hdrAgg.lpoNo) hdrAgg.lpoNo = h.LPO_NO || h.PO_NO || '';
        if (!hdrAgg.invNo) hdrAgg.invNo = h.INV_NO || '';
        if (!hdrAgg.invDate) hdrAgg.invDate = h.INV_DATE || '';
        if (!hdrAgg.narration) hdrAgg.narration = h.NARRATION || '';
        hdrAgg.discount += Number(h.DISCOUNT) || 0;
        hdrAgg.vatAmount += Number(h.VAT_AMOUNT) || 0;
        hdrAgg.invAmount += Number(h.INV_AMOUNT) || 0;
        srvFound.push(srvNo);

        // items — item name via a de-duplicated item_mst join (item_mst
        // PK is LOC_CODE+ITEM_CODE, so a bare ITEM_CODE join fans out)
        const rows = await q(
          `SELECT s.SRV_NO, DATE_FORMAT(s.SRV_DATE,'%Y-%m-%d') AS SRV_DATE,
                  s.SR_NO, s.LOC_CODE, s.ITEM_CODE, s.QTY, s.COST,
                  s.ITEM_UNIT, s.ACC_CODE, s.JOB_NO, s.PO_NO,
                  COALESCE(i.ITEM_NAME1, '') AS ITEM_NAME
             FROM SRV_ITEMS s
             LEFT JOIN (SELECT ITEM_CODE, MIN(ITEM_NAME1) AS ITEM_NAME1
                          FROM item_mst GROUP BY ITEM_CODE) i
               ON i.ITEM_CODE = s.ITEM_CODE
            WHERE s.SRV_NO = ?
            ORDER BY CAST(s.SR_NO AS UNSIGNED)`,
          [srvNo]
        );
        for (const r of rows) {
          items.push({
            srvNo: r.SRV_NO,
            srvDate: r.SRV_DATE || '',
            locCode: r.LOC_CODE || '',
            itemCode: r.ITEM_CODE || '',
            itemName: r.ITEM_NAME || '',
            qty: Number(r.QTY) || 0,
            rate: Number(r.COST) || 0,
            unit: r.ITEM_UNIT || '',
            accCode: r.ACC_CODE || '',
            jobNo: r.JOB_NO || '',
            poNo: r.PO_NO || '',
          });
        }
      }

      if (!srvFound.length)
        return res.status(422).json({ error: `No valid SRV found (tried: ${srvNos.join(', ')})` });

      // supplier name
      if (hdrAgg.supCode) {
        try {
          const sup = await q(`SELECT SUP_NAME FROM sup_mst WHERE SUP_CODE = ? LIMIT 1`, [hdrAgg.supCode]);
          hdrAgg.supName = sup[0]?.SUP_NAME || '';
        } catch (e) { console.warn('[pinv-suggest] supplier name lookup failed:', e.message); }
      }

      // spoken overrides win over SRV values
      const header = {
        vchrDate: str(parsed.vchrDate) || '',
        srvNos: srvFound,
        supCode: hdrAgg.supCode,
        supName: hdrAgg.supName,
        lpoNo: hdrAgg.lpoNo,
        invNo: str(parsed.invNo) || hdrAgg.invNo,
        invDate: str(parsed.invDate) || hdrAgg.invDate,
        narration: str(parsed.narration) || hdrAgg.narration,
        discount: hdrAgg.discount,
        vatAmount: hdrAgg.vatAmount,
        invAmount: hdrAgg.invAmount,
      };
      const confidence =
        warnings.some(w => w.includes('not found')) ? 'low' :
        warnings.length ? 'medium' : 'high';

      return res.json({ header, items, warnings, confidence });
    } catch (err) {
      console.error('[pinv-suggest] error:', err);
      return res.status(500).json({ error: 'pinv-suggest failed: ' + err.message });
    }
  });

  return router;
};
