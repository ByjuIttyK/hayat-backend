// ─────────────────────────────────────────────────────────────────────────────
//  gl_suggest_api.js — Smart GL Suggestion via Google Gemini (free tier)
//  Mount in HayatDb.js:
//    const glSuggestApi = require('./gl_suggest_api')(connection);
//    app.use('/api/gl-suggest', authMiddleware, glSuggestApi);
//  Requires in .env:  GEMINI_API_KEY=...
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const MODEL = 'gemini-2.5-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// ── Helper: callback-style DB query → Promise ─────────────────────────────────
function dbQuery(connection, sql, params = []) {
  return new Promise((resolve, reject) => {
    connection.query(sql, params, (err, rows) => {
      if (err) reject(err); else resolve(rows);
    });
  });
}

// ── Helper: pull the likely party-name phrase out of free-text narration ─────
//   "Received from GALADARI ENERGY SOLUTIONS LLC with PDC an amount of..."
//   → "GALADARI ENERGY SOLUTIONS LLC"
function extractNamePhrase(narration) {
  const m = narration.match(
    /(?:from|to)\s+(.+?)(?:\s+with\b|\s+against\b|\s+re\b|\s+towards\b|\s+for\b|\s+chq|\s+an\s+amount|$)/i
  );
  return (m ? m[1] : narration).trim();
}

// ── Helper: stopword-filtered tokens of that phrase, used to build a SQL LIKE
//    search (so we don't search on junk words like "the"/"with") ─────────────
const NAME_STOPWORDS = new Set([
  'from', 'to', 'with', 'chqs', 'chq', 'cheque', 'cheques', 'amount', 'received', 'paid',
  'towards', 'against', 'for', 'the', 'and', 'llc', 'co', 'ltd', 'company', 'dhs', 'aed',
  'date', 'dt', 'inv', 'invoice', 'no',
]);
function extractNameTokens(narration) {
  return extractNamePhrase(narration)
    .split(/[^A-Za-z0-9]+/)
    .map(w => w.trim())
    .filter(w => w.length >= 4 && !NAME_STOPWORDS.has(w.toLowerCase()));
}

// ── Helper: token-set of a string (uppercased, unfiltered) for Jaccard scoring
function tokenSet(s) {
  return new Set(String(s || '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean));
}
function jaccardScore(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const t of aSet) if (bSet.has(t)) inter++;
  const union = aSet.size + bSet.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ── Helper: find likely master-table matches via SQL LIKE on extracted tokens ─
//   Guarantees the real party is in scope even if the master table is bigger
//   than the broad alphabetical LIMIT below could otherwise cover.
//   IMPORTANT: ranks by how many tokens each row matches (MATCH_COUNT) before
//   applying LIMIT — without this, a generic word like "ENERGY" or "SOLUTIONS"
//   matching 30+ unrelated rows could push the actual best match out of the
//   result set in arbitrary table-scan order before scoring ever sees it.
async function findCandidates(connection, table, codeCol, nameCol, narration, limit = 50) {
  const tokens = extractNameTokens(narration);
  if (!tokens.length) return [];
  try {
    const whereClauses = tokens.map(() => `${nameCol} LIKE ?`).join(' OR ');
    const scoreClauses = tokens.map(() => `CASE WHEN ${nameCol} LIKE ? THEN 1 ELSE 0 END`).join(' + ');
    const likeParams = tokens.map(t => `%${t}%`);
    const rows = await dbQuery(
      connection,
      `SELECT ${codeCol} AS CODE, ${nameCol} AS NAME, (${scoreClauses}) AS MATCH_COUNT
       FROM ${table}
       WHERE ${whereClauses}
       ORDER BY MATCH_COUNT DESC
       LIMIT ${limit}`,
      [...likeParams, ...likeParams]
    );
    return rows;
  } catch (e) {
    console.error(`gl-suggest: candidate lookup failed for ${table}:`, e.message);
    return [];
  }
}

// ── Helper: merge narration-matched candidates with the broad list, dedup'd,
//    candidates first so they're most salient — returns a normalized array
//    of { code, name } usable both for the prompt text and for scoring ──────
function mergeCandidates(candidates, broadRows, codeField, nameField) {
  const seen = new Map();
  candidates.forEach(r => { if (!seen.has(r.CODE)) seen.set(r.CODE, r.NAME); });
  broadRows.forEach(r => { if (!seen.has(r[codeField])) seen.set(r[codeField], r[nameField]); });
  return Array.from(seen.entries()).map(([code, name]) => ({ code, name }));
}
function candidatesToPromptList(merged) {
  return merged.map(r => `${r.code} - ${r.name}`).join('\n');
}

// ── Helper: deterministic best-match resolution via Jaccard token-set scoring
//    — same approach as CustomerMatchRoutes.js's fuzzy cheque-scan matching.
//    Used to override the LLM's pick when names are lexically similar
//    (e.g. "GALADARI ENERGY SOLUTIONS LLC" vs "SAKR ENERGY SOLUTIONS"),
//    which Gemini alone is not reliable at disambiguating. ───────────────────
const MATCH_CONFIDENCE_THRESHOLD = 0.34;
function resolveBestMatch(narration, merged) {
  const phraseSet = tokenSet(extractNamePhrase(narration));
  if (!phraseSet.size || !merged.length) return null;
  let best = null;
  for (const row of merged) {
    const score = jaccardScore(phraseSet, tokenSet(row.name));
    if (!best || score > best.score) best = { code: row.code, name: row.name, score };
  }
  return best && best.score >= MATCH_CONFIDENCE_THRESHOLD ? best : null;
}

module.exports = function (connection) {
  const router = express.Router();

  // ── POST /api/gl-suggest/pv ───────────────────────────────────────────────
  // Body: { narration: string, tranType: '04'|'02' }
  //   tranType '04' = Bank Payment,  '02' = Cash Payment
  router.post('/pv', async (req, res) => {
    try {
      if (!GEMINI_KEY) {
        return res.status(500).json({ error: 'GEMINI_API_KEY not set in .env' });
      }

      const { narration, tranType } = req.body || {};
      if (!narration || narration.trim().length < 5) {
        return res.status(400).json({ error: 'Narration too short' });
      }

      // ── 1. Load account + supplier master for context ─────────────────────
      const [accounts, suppliers, supplierCandidates] = await Promise.all([
        dbQuery(connection, 'SELECT ACC_CODE, ACC_HEAD FROM ACC_MST ORDER BY ACC_CODE LIMIT 400'),
        dbQuery(connection, 'SELECT SUP_CODE, SUP_NAME FROM SUP_MST ORDER BY SUP_NAME LIMIT 300'),
        findCandidates(connection, 'SUP_MST', 'SUP_CODE', 'SUP_NAME', narration),
      ]);

      const accList = accounts.map(r => `${r.ACC_CODE} - ${r.ACC_HEAD}`).join('\n');
      const mergedSuppliers = mergeCandidates(supplierCandidates, suppliers, 'SUP_CODE', 'SUP_NAME');
      const supList = candidatesToPromptList(mergedSuppliers);
      // Deterministic Jaccard token-set match — overrides the LLM's pick below
      // when names are lexically similar (e.g. two suppliers sharing a word).
      const bestSupplierMatch = resolveBestMatch(narration, mergedSuppliers);
      const isBankPay = tranType === '04';

      // ── 2. Build prompt ───────────────────────────────────────────────────
      const prompt = `You are an ERP accounting assistant for a UAE manufacturing company.
Analyse the payment voucher narration below and return ONLY a JSON object — no markdown, no explanation.

NARRATION: "${narration.trim()}"

PAYMENT TYPE: ${isBankPay ? 'Bank Payment (may involve PDC cheques, bank transfer, CDC)' : 'Cash Payment'}

SUPPLIER MASTER (SUP_CODE - SUP_NAME) — candidates extracted from the narration are listed first:
${supList}

CHART OF ACCOUNTS (ACC_CODE - ACC_HEAD):
${accList}

EXTRACTION RULES:
1. drAcc / drHead  → Party being paid. Match supplier name from narration against SUPPLIER MASTER. Pick the closest match. Return SUP_CODE as drAcc, SUP_NAME as drHead. NEVER return an ACC_CODE from the chart of accounts here — drAcc must always come from SUPPLIER MASTER, even if the match is imperfect.
2. crAcc / crHead  → Credit side account from CHART OF ACCOUNTS:
   - If narration mentions PDC / post-dated / cheque → find PDC PAYABLE or similar account.
   - If bank transfer / NEFT / wire / online → find the BANK account.
   - If cash → find CASH IN HAND or PETTY CASH account.
3. amount          → Total payment amount as a number. 0 if not found.
4. cheques         → Array of cheque objects extracted from narration. Each: { chqNo, chqDt (YYYY-MM-DD), amount (number) }. Empty array [] if none.
5. narration       → Clean one-line voucher narration max 100 chars summarising the payment.
6. confidence      → "high" if supplier + amount clearly found, "medium" if partial, "low" if guessed.

Return ONLY this JSON:
{
  "drAcc": "",
  "drHead": "",
  "crAcc": "",
  "crHead": "",
  "amount": 0,
  "cheques": [],
  "narration": "",
  "confidence": "medium"
}`;

      // ── 3. Call Gemini — same pattern as ChequeScanRoutes.js ──────────────
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
        console.error('gl-suggest: Gemini API error', JSON.stringify(data).slice(0, 400));
        return res.status(r.status).json({ error: data.error?.message || 'Gemini request failed' });
      }

      // ── 4. Extract text from response ─────────────────────────────────────
      const text = data.candidates?.[0]?.content?.parts
        ?.map(p => p.text || '').join('') || '';

      // ── 5. Parse JSON ─────────────────────────────────────────────────────
      let suggestion;
      try {
        suggestion = JSON.parse(text.replace(/```json|```/g, '').trim());
      } catch {
        console.error('gl-suggest: unparseable response:', text.slice(0, 300));
        return res.status(502).json({ error: 'AI returned unparseable response', raw: text });
      }

      // ── 6. Sanitise + return ──────────────────────────────────────────────
      // If a deterministic narration→supplier match was found, trust it over
      // the LLM's pick for drAcc/drHead (Gemini is unreliable disambiguating
      // lexically-similar supplier names — see resolveBestMatch above).
      const finalDrAcc = bestSupplierMatch ? bestSupplierMatch.code : String(suggestion.drAcc || '').trim();
      const finalDrHead = bestSupplierMatch ? bestSupplierMatch.name : String(suggestion.drHead || '').trim();

      res.json({
        drAcc: finalDrAcc,
        drHead: finalDrHead,
        crAcc: String(suggestion.crAcc || '').trim(),
        crHead: String(suggestion.crHead || '').trim(),
        amount: Number(suggestion.amount || 0),
        cheques: Array.isArray(suggestion.cheques) ? suggestion.cheques : [],
        narration: String(suggestion.narration || '').substring(0, 100),
        confidence: bestSupplierMatch
          ? 'high'
          : (['high', 'medium', 'low'].includes(suggestion.confidence) ? suggestion.confidence : 'medium'),
      });

    } catch (err) {
      console.error('gl-suggest error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/gl-suggest/rv ───────────────────────────────────────────────
  // Body: { narration: string, tranType: '03'|'01' }
  //   tranType '03' = Bank Receipt,  anything else = Cash Receipt
  router.post('/rv', async (req, res) => {
    try {
      if (!GEMINI_KEY) {
        return res.status(500).json({ error: 'GEMINI_API_KEY not set in .env' });
      }

      const { narration, tranType } = req.body || {};
      if (!narration || narration.trim().length < 5) {
        return res.status(400).json({ error: 'Narration too short' });
      }

      // ── 1. Load account + customer master for context ─────────────────────
      const [accounts, customers, customerCandidates] = await Promise.all([
        dbQuery(connection, 'SELECT ACC_CODE, ACC_HEAD FROM ACC_MST ORDER BY ACC_CODE LIMIT 400'),
        dbQuery(connection, 'SELECT CUST_CODE, CUST_NAME FROM CUS_MST ORDER BY CUST_NAME LIMIT 300'),
        findCandidates(connection, 'CUS_MST', 'CUST_CODE', 'CUST_NAME', narration),
      ]);

      const accList = accounts.map(r => `${r.ACC_CODE} - ${r.ACC_HEAD}`).join('\n');
      const mergedCustomers = mergeCandidates(customerCandidates, customers, 'CUST_CODE', 'CUST_NAME');
      const custList = candidatesToPromptList(mergedCustomers);
      // Deterministic Jaccard token-set match — overrides the LLM's pick below
      // when names are lexically similar (e.g. "GALADARI ENERGY SOLUTIONS LLC"
      // vs "SAKR ENERGY SOLUTIONS", which Gemini alone confused).
      const bestCustomerMatch = resolveBestMatch(narration, mergedCustomers);
      const isBankRcpt = tranType === '03';

      // ── 2. Build prompt ───────────────────────────────────────────────────
      const prompt = `You are an ERP accounting assistant for a UAE manufacturing company.
Analyse the receipt voucher narration below and return ONLY a JSON object — no markdown, no explanation.

NARRATION: "${narration.trim()}"

RECEIPT TYPE: ${isBankRcpt ? 'Bank Receipt (may involve PDC cheques, bank transfer, CDC)' : 'Cash Receipt'}

CUSTOMER MASTER (CUST_CODE - CUST_NAME) — candidates extracted from the narration are listed first:
${custList}

CHART OF ACCOUNTS (ACC_CODE - ACC_HEAD):
${accList}

EXTRACTION RULES:
1. crAcc / crHead  → Party paying us. Match customer name from narration against CUSTOMER MASTER. Pick the closest match. Return CUST_CODE as crAcc, CUST_NAME as crHead. NEVER return an ACC_CODE from the chart of accounts here — crAcc must always come from CUSTOMER MASTER, even if the match is imperfect.
2. drAcc / drHead  → Debit side account from CHART OF ACCOUNTS (where the money lands):
   - If narration mentions PDC / post-dated / cheque / bank transfer / NEFT / wire / online → find the BANK account.
   - If cash → find CASH IN HAND or PETTY CASH account.
3. amount          → Total receipt amount as a number. 0 if not found.
4. cheques         → Array of cheque objects extracted from narration. Each: { chqNo, chqDt (YYYY-MM-DD), amount (number) }. Empty array [] if none.
5. narration       → Clean one-line voucher narration max 100 chars summarising the receipt.
6. confidence      → "high" if customer + amount clearly found, "medium" if partial, "low" if guessed.

Return ONLY this JSON:
{
  "drAcc": "",
  "drHead": "",
  "crAcc": "",
  "crHead": "",
  "amount": 0,
  "cheques": [],
  "narration": "",
  "confidence": "medium"
}`;

      // ── 3. Call Gemini — same pattern as ChequeScanRoutes.js ──────────────
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
        console.error('gl-suggest: Gemini API error', JSON.stringify(data).slice(0, 400));
        return res.status(r.status).json({ error: data.error?.message || 'Gemini request failed' });
      }

      // ── 4. Extract text from response ─────────────────────────────────────
      const text = data.candidates?.[0]?.content?.parts
        ?.map(p => p.text || '').join('') || '';

      // ── 5. Parse JSON ─────────────────────────────────────────────────────
      let suggestion;
      try {
        suggestion = JSON.parse(text.replace(/```json|```/g, '').trim());
      } catch {
        console.error('gl-suggest: unparseable response:', text.slice(0, 300));
        return res.status(502).json({ error: 'AI returned unparseable response', raw: text });
      }

      // ── 6. Sanitise + return ──────────────────────────────────────────────
      // If a deterministic narration→customer match was found, trust it over
      // the LLM's pick for crAcc/crHead (Gemini is unreliable disambiguating
      // lexically-similar customer names — see resolveBestMatch above).
      const finalCrAcc = bestCustomerMatch ? bestCustomerMatch.code : String(suggestion.crAcc || '').trim();
      const finalCrHead = bestCustomerMatch ? bestCustomerMatch.name : String(suggestion.crHead || '').trim();

      res.json({
        drAcc: String(suggestion.drAcc || '').trim(),
        drHead: String(suggestion.drHead || '').trim(),
        crAcc: finalCrAcc,
        crHead: finalCrHead,
        amount: Number(suggestion.amount || 0),
        cheques: Array.isArray(suggestion.cheques) ? suggestion.cheques : [],
        narration: String(suggestion.narration || '').substring(0, 100),
        confidence: bestCustomerMatch
          ? 'high'
          : (['high', 'medium', 'low'].includes(suggestion.confidence) ? suggestion.confidence : 'medium'),
        // TEMP DEBUG — remove once matching is confirmed working. If this key
        // is missing from the Network-tab response entirely, the server is
        // still running an older copy of this file.
        _debug: {
          version: 'gl-suggest-v2-jaccard',
          extractedPhrase: extractNamePhrase(narration),
          candidatesConsidered: mergedCustomers.length,
          topScores: mergedCustomers
            .map(r => ({ code: r.code, name: r.name, score: jaccardScore(tokenSet(extractNamePhrase(narration)), tokenSet(r.name)) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 5),
          overrideApplied: !!bestCustomerMatch,
          geminiCrAcc: suggestion.crAcc,
          geminiCrHead: suggestion.crHead,
        },
      });

    } catch (err) {
      console.error('gl-suggest error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/gl-suggest/jv ───────────────────────────────────────────────
  // Body: { narration: string, tranType: '05' }
  router.post('/jv', async (req, res) => {
    try {
      if (!GEMINI_KEY)
        return res.status(500).json({ error: 'GEMINI_API_KEY not set in .env' });

      const { narration } = req.body || {};
      if (!narration || narration.trim().length < 5)
        return res.status(400).json({ error: 'Narration too short' });

      // ── 1. Load accounts, customers and suppliers for context ─────────────
      const [accounts, customers, suppliers, custCandidates, supCandidates] = await Promise.all([
        dbQuery(connection, 'SELECT ACC_CODE, ACC_HEAD FROM ACC_MST ORDER BY ACC_CODE LIMIT 400'),
        dbQuery(connection, 'SELECT CUST_CODE, CUST_NAME FROM CUS_MST ORDER BY CUST_NAME LIMIT 200'),
        dbQuery(connection, 'SELECT SUP_CODE, SUP_NAME FROM SUP_MST ORDER BY SUP_NAME LIMIT 200'),
        findCandidates(connection, 'CUS_MST', 'CUST_CODE', 'CUST_NAME', narration),
        findCandidates(connection, 'SUP_MST', 'SUP_CODE', 'SUP_NAME', narration),
      ]);

      const accList  = accounts.map(r => `${r.ACC_CODE} - ${r.ACC_HEAD}`).join('\n');
      const mergedCust = mergeCandidates(custCandidates, customers, 'CUST_CODE', 'CUST_NAME');
      const mergedSup  = mergeCandidates(supCandidates,  suppliers, 'SUP_CODE',  'SUP_NAME');
      const custList = candidatesToPromptList(mergedCust);
      const supList  = candidatesToPromptList(mergedSup);

      // Deterministic best matches
      const bestCustMatch = resolveBestMatch(narration, mergedCust);
      const bestSupMatch  = resolveBestMatch(narration, mergedSup);

      // ── 2. Build prompt ───────────────────────────────────────────────────
      const prompt = `You are an ERP accounting assistant for a UAE manufacturing company (Al Hayat Switchgear).
Analyse the Journal Voucher narration below and return ONLY a JSON object — no markdown, no explanation.

NARRATION: "${narration.trim()}"

CHART OF ACCOUNTS (ACC_CODE - ACC_HEAD):
${accList}

CUSTOMER MASTER (CUST_CODE - CUST_NAME) — narration candidates listed first:
${custList}

SUPPLIER MASTER (SUP_CODE - SUP_NAME) — narration candidates listed first:
${supList}

EXTRACTION RULES:
1. drAcc / drHead  → Debit side. If payment to supplier, use SUP_CODE. If expense/depreciation/adjustment, use ACC_CODE.
2. crAcc / crHead  → Credit side. If receipt from customer, use CUST_CODE. If income/accrual/provision, use ACC_CODE.
3. amount          → Extract numeric amount from narration. 0 if not found.
4. narration       → Clean one-line narration max 100 chars.
5. confidence      → "high" if accounts + amount clearly identified, "medium" if partial, "low" if guessed.

Common JV patterns:
- Depreciation: Dr Depreciation Expense (ACC_CODE), Cr Accumulated Depreciation (ACC_CODE)
- Accrual: Dr Expense (ACC_CODE), Cr Accrued Liabilities (ACC_CODE)
- Credit note to customer: Dr Sales/Revenue (ACC_CODE), Cr Customer account (CUST_CODE)
- Debit note from supplier: Dr Supplier account (SUP_CODE), Cr Purchase Returns (ACC_CODE)
- Provision: Dr Provision Expense (ACC_CODE), Cr Provision account (ACC_CODE)
- Salary payable: Dr Salary Expense (ACC_CODE), Cr Salary Payable (ACC_CODE)

Return ONLY this JSON:
{
  "drAcc": "",
  "drHead": "",
  "crAcc": "",
  "crHead": "",
  "amount": 0,
  "narration": "",
  "confidence": "medium"
}`;

      // ── 3. Call Gemini REST API (same pattern as /pv and /rv) ─────────────
      const r = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 512,
            responseMimeType: 'application/json',
          },
        }),
      });

      const data = await r.json();
      if (!r.ok) {
        console.error('gl-suggest/jv: Gemini API error', JSON.stringify(data).slice(0, 400));
        return res.status(r.status).json({ error: data.error?.message || 'Gemini request failed' });
      }

      // ── 4. Extract text ───────────────────────────────────────────────────
      const text = data.candidates?.[0]?.content?.parts
        ?.map(p => p.text || '').join('') || '';

      // ── 5. Parse JSON ─────────────────────────────────────────────────────
      let suggestion;
      try {
        suggestion = JSON.parse(text.replace(/```json|```/g, '').trim());
      } catch {
        console.error('gl-suggest/jv: unparseable response:', text.slice(0, 300));
        return res.status(502).json({ error: 'AI returned unparseable response', raw: text });
      }

      // ── 6. Apply deterministic overrides where available ─────────────────
      const finalDrAcc  = bestSupMatch  ? bestSupMatch.code  : String(suggestion.drAcc  || '').trim();
      const finalDrHead = bestSupMatch  ? bestSupMatch.name  : String(suggestion.drHead || '').trim();
      const finalCrAcc  = bestCustMatch ? bestCustMatch.code : String(suggestion.crAcc  || '').trim();
      const finalCrHead = bestCustMatch ? bestCustMatch.name : String(suggestion.crHead || '').trim();

      res.json({
        drAcc:      finalDrAcc,
        drHead:     finalDrHead,
        crAcc:      finalCrAcc,
        crHead:     finalCrHead,
        amount:     Number(suggestion.amount || 0),
        narration:  String(suggestion.narration || '').substring(0, 100),
        confidence: (bestCustMatch || bestSupMatch)
          ? 'high'
          : (['high', 'medium', 'low'].includes(suggestion.confidence)
              ? suggestion.confidence : 'medium'),
      });

    } catch (err) {
      console.error('gl-suggest/jv error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });


  return router;
};
