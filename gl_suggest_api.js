const COMPANY = require("./config/company");
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

// ── Helper: tokens for matching ACCOUNT heads. Unlike extractNameTokens,
//    which looks only at the party phrase after "from"/"to", this scans the
//    whole narration — the bank is usually named at the end ("...into ENBD").
//    Bank names are short, so the minimum length is 3, not 4.
const ACC_STOPWORDS = new Set([
  ...['from', 'to', 'with', 'chq', 'chqs', 'cheque', 'cheques', 'amount', 'received',
      'paid', 'towards', 'against', 'for', 'the', 'and', 'llc', 'ltd', 'dhs', 'aed',
      'date', 'dtd', 'inv', 'invoice', 'no', 'into', 'via', 'through', 'deposit',
      'deposited', 'transfer', 'split', 'dated', 'our', 'their', 'account'],
]);
function extractAccountTokens(narration) {
  return String(narration || '')
    .split(/[^A-Za-z0-9]+/)
    .map(w => w.trim())
    .filter(w => w.length >= 3 && !/^\d+$/.test(w) && !ACC_STOPWORDS.has(w.toLowerCase()));
}

// ── Helper: LIKE search over a master table using a supplied token list ─────
async function findCandidatesByTokens(connection, table, codeCol, nameCol, tokens, limit = 40) {
  if (!tokens.length) return [];
  try {
    const whereClauses = tokens.map(() => `${nameCol} LIKE ?`).join(' OR ');
    const scoreClauses = tokens.map(() => `CASE WHEN ${nameCol} LIKE ? THEN 1 ELSE 0 END`).join(' + ');
    const likeParams = tokens.map(t => `%${t}%`);
    return await dbQuery(
      connection,
      `SELECT ${codeCol} AS CODE, ${nameCol} AS NAME, (${scoreClauses}) AS MATCH_COUNT
       FROM ${table}
       WHERE ${whereClauses}
       ORDER BY MATCH_COUNT DESC
       LIMIT ${limit}`,
      [...likeParams, ...likeParams]
    );
  } catch (e) {
    console.error(`gl-suggest: account lookup failed for ${table}:`, e.message);
    return [];
  }
}

// ── Helper: UAE bank abbreviations people actually write in narrations.
//    Fed to the prompt so "into ENBD" is not matched to whichever bank
//    happens to sit near the top of the chart of accounts. Extend freely —
//    it is only a hint list, never a hard mapping. ──────────────────────────
const BANK_ALIAS_HINTS = [
  'ENBD / EMIRATES NBD = Emirates NBD Bank',
  'RAK / RAKBANK = National Bank of Ras Al Khaimah',
  'ADCB = Abu Dhabi Commercial Bank',
  'FAB / NBAD = First Abu Dhabi Bank',
  'DIB = Dubai Islamic Bank',
  'CBD = Commercial Bank of Dubai',
  'ADIB = Abu Dhabi Islamic Bank',
  'MASHREQ / MASHREQBANK = Mashreq Bank',
  'SCB = Standard Chartered Bank',
  'HSBC = HSBC Bank Middle East',
].join('\n');

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
      //    accountCandidates: G/L accounts whose head matches a word in the
      //    narration (the paying bank, "...from ENBD"), listed first.
      const [accounts, suppliers, supplierCandidates, accountCandidates] = await Promise.all([
        dbQuery(connection, 'SELECT ACC_CODE, ACC_HEAD FROM acc_mst ORDER BY ACC_CODE LIMIT 400'),
        dbQuery(connection, 'SELECT SUP_CODE, SUP_NAME FROM sup_mst ORDER BY SUP_NAME LIMIT 300'),
        findCandidates(connection, 'sup_mst', 'SUP_CODE', 'SUP_NAME', narration),
        findCandidatesByTokens(connection, 'acc_mst', 'ACC_CODE', 'ACC_HEAD', extractAccountTokens(narration), 20),
      ]);

      const mergedAccounts = mergeCandidates(accountCandidates, accounts, 'ACC_CODE', 'ACC_HEAD');
      const accList = candidatesToPromptList(mergedAccounts);
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

CHART OF ACCOUNTS (ACC_CODE - ACC_HEAD) — accounts named in the narration are listed first:
${accList}

HOW THIS VOUCHER IS ENTERED:
The bank / cash / PDC account being credited sits in the voucher HEADER (crAcc). The lines grid holds ONLY the
DEBIT lines — the suppliers (parties) being paid. Never put the bank / cash / PDC account, or any credit, in "lines".

EXTRACTION RULES:
1. crAcc / crHead  → The ONE account the money is paid from, from CHART OF ACCOUNTS (header only):
   - If the narration NAMES a bank, use THAT bank's account; never substitute a similar-looking bank.
   - If narration mentions PDC / post-dated / cheque → find PDC PAYABLE or similar account.
   - If bank transfer / NEFT / wire / online → find the BANK account.
   - If cash → find CASH IN HAND or PETTY CASH account.
   - Leave both empty if the narration gives no clue — the user fills the header.
2. lines           → DEBIT lines only, one per supplier being paid:
   { "acc": "", "head": "", "dr": 0, "narration": "" }
   - acc / head come from SUPPLIER MASTER (SUP_CODE / SUP_NAME) — NEVER an ACC_CODE from the chart of accounts.
   - Usually one supplier = one line. Several suppliers named, each with an amount → one line each.
   - dr is that supplier's amount; narration is a short line note (invoice / cheque reference) or "".
   - No "cr" field and no credit lines.
3. drAcc / drHead  → The main supplier paid (the largest debit line) — SUP_CODE / SUP_NAME. Pick the closest match even if imperfect.
4. amount          → Total payment amount = the sum of the debit lines. 0 if not found.
5. cheques         → Array of cheque objects extracted from narration. Each: { chqNo, chqDt (YYYY-MM-DD), amount (number) }. Empty array [] if none.
6. narration       → Clean one-line voucher narration max 100 chars summarising the payment.
7. confidence      → "high" if supplier + amount clearly found, "medium" if partial, "low" if guessed.

Return ONLY this JSON:
{
  "lines": [{ "acc": "", "head": "", "dr": 0, "narration": "" }],
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
            maxOutputTokens: 1024,
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

      // ── 6a. Debit (supplier) lines only — the grid. The paying bank / cash
      //    account is the header crAcc; credit lines and G/L codes are dropped.
      const accByCode = new Map(mergedAccounts.map(r => [String(r.code).trim(), r.name]));
      const supByCode = new Map(mergedSuppliers.map(r => [String(r.code).trim(), r.name]));
      let lines = (Array.isArray(suggestion.lines) ? suggestion.lines : [])
        .map(l => ({
          acc: String(l?.acc || '').trim(),
          head: String(l?.head || '').trim(),
          dr: Number(l?.dr || 0) || 0,
          cr: 0,
          narration: String(l?.narration || '').trim().substring(0, 100),
        }))
        .filter(l => l.acc && l.dr > 0 && !accByCode.has(l.acc))
        .map(l => ({ ...l, head: supByCode.get(l.acc) || l.head }));
      if (bestSupplierMatch && lines.length <= 1) {
        lines = lines.map(l => ({ ...l, acc: bestSupplierMatch.code, head: bestSupplierMatch.name }));
      }
      const sumDr = lines.reduce((t, l) => t + l.dr, 0);
      const headerAmount = Number(suggestion.amount || 0) || sumDr;
      if (!lines.length && finalDrAcc) {
        lines.push({ acc: finalDrAcc, head: finalDrHead, dr: headerAmount, cr: 0, narration: '' });
      }
      if (lines.length === 1 && headerAmount) lines[0].dr = Number(headerAmount.toFixed(2));
      const drTotal = Number(lines.reduce((t, l) => t + l.dr, 0).toFixed(2));
      const amount = Number((lines.length === 1 ? lines[0].dr : (headerAmount || drTotal)).toFixed(2));
      const mainDr = lines.reduce((big, l) => (!big || l.dr > big.dr ? l : big), null);

      // Header paying account — must be a real G/L account
      const crAccRaw = String(suggestion.crAcc || '').trim();
      const crAcc = accByCode.has(crAccRaw) ? crAccRaw : '';

      res.json({
        lines,                       // debit (supplier) lines only — the grid
        drAcc: mainDr ? mainDr.acc : finalDrAcc,
        drHead: mainDr ? mainDr.head : finalDrHead,
        crAcc,                       // header bank / cash / PDC account
        crHead: crAcc ? accByCode.get(crAcc) : '',
        amount,
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
      //    accountCandidates: G/L accounts whose head matches a word in the
      //    narration (a bank named at the end — "...into ENBD"), so they are in
      //    the prompt even when they sit beyond the first 400 accounts.
      const [accounts, customers, customerCandidates, accountCandidates] = await Promise.all([
        dbQuery(connection, 'SELECT ACC_CODE, ACC_HEAD FROM acc_mst ORDER BY ACC_CODE LIMIT 400'),
        dbQuery(connection, 'SELECT CUST_CODE, CUST_NAME FROM cus_mst ORDER BY CUST_NAME LIMIT 300'),
        findCandidates(connection, 'cus_mst', 'CUST_CODE', 'CUST_NAME', narration),
        findCandidatesByTokens(connection, 'acc_mst', 'ACC_CODE', 'ACC_HEAD', extractAccountTokens(narration), 20),
      ]);

      // named accounts first, then the broad list — one entry per code
      const mergedAccounts = mergeCandidates(accountCandidates, accounts, 'ACC_CODE', 'ACC_HEAD');
      const accList = candidatesToPromptList(mergedAccounts);
      const namedAccList = accountCandidates.length
        ? accountCandidates.map(r => `${r.CODE} - ${r.NAME}`).join('\n')
        : '(none — no account head matches a word in the narration)';
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

ACCOUNTS WHOSE NAME APPEARS IN THE NARRATION — prefer these for the bank / cash account (drAcc):
${namedAccList}

CHART OF ACCOUNTS (ACC_CODE - ACC_HEAD):
${accList}

COMMON UAE BANK ABBREVIATIONS (a hint only — always confirm against the account heads above):
${BANK_ALIAS_HINTS}

HOW THIS VOUCHER IS ENTERED:
The bank / cash account being debited sits in the voucher HEADER (drAcc). The lines grid holds ONLY the
CREDIT lines — the customers paying us. Never put the bank / cash account, or any debit, in "lines".

EXTRACTION RULES:
1. drAcc / drHead  → The ONE bank / cash account receiving the money, from CHART OF ACCOUNTS (header only):
   - If the narration NAMES a bank, use THAT bank's account. Check the abbreviation list above, then match it against the account heads. Never substitute a different bank because its name looks similar.
   - If a cheque / PDC / transfer / NEFT / wire is mentioned and no bank is named → find the BANK account.
   - If cash → find CASH IN HAND or PETTY CASH account.
   - Leave both empty if the narration gives no clue — the user fills the header.
2. lines           → CREDIT lines only, one per customer paying:
   { "acc": "", "head": "", "cr": 0, "narration": "" }
   - acc / head come from CUSTOMER MASTER (CUST_CODE / CUST_NAME) — NEVER an ACC_CODE from the chart of accounts.
   - Usually one customer = one line. Several customers named, each with an amount → one line each.
   - cr is that customer's amount; narration is a short line note (invoice / cheque reference) or "".
   - No "dr" field and no debit lines.
3. crAcc / crHead  → The main paying customer (the largest credit line) — CUST_CODE / CUST_NAME.
4. amount          → Total receipt amount = the sum of the credit lines. 0 if not found.
5. cheques         → Array of cheque objects extracted from narration. Each: { chqNo, chqDt (YYYY-MM-DD), amount (number) }. Empty array [] if none.
6. narration       → Clean one-line voucher narration max 100 chars summarising the receipt.
7. confidence      → "high" if customer + amount clearly found, "medium" if partial, "low" if guessed.

Return ONLY this JSON:
{
  "lines": [{ "acc": "", "head": "", "cr": 0, "narration": "" }],
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
            maxOutputTokens: 1024,
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

      // ── 6a. Normalise the credit lines ────────────────────────────────────
      // The grid takes ONLY the customer (credit) lines; the bank / cash debit
      // is the header account (drAcc). Any debit line the model still sends is
      // dropped, and so is any "customer" code that is really a G/L account.
      const accByCode = new Map(mergedAccounts.map(r => [String(r.code).trim(), r.name]));
      const custByCode = new Map(mergedCustomers.map(r => [String(r.code).trim(), r.name]));

      let lines = (Array.isArray(suggestion.lines) ? suggestion.lines : [])
        .map(l => ({
          acc: String(l?.acc || '').trim(),
          head: String(l?.head || '').trim(),
          dr: 0,
          cr: Number(l?.cr || 0) || 0,
          narration: String(l?.narration || '').trim().substring(0, 100),
        }))
        .filter(l => l.acc && l.cr > 0 && !accByCode.has(l.acc))
        // trust the customer master over the model for the head text
        .map(l => ({ ...l, head: custByCode.get(l.acc) || l.head }));

      // The deterministic customer match wins when there is one paying party.
      if (bestCustomerMatch && lines.length <= 1) {
        lines = lines.map(l => ({ ...l, acc: bestCustomerMatch.code, head: bestCustomerMatch.name }));
      }

      const sumCr = lines.reduce((t, l) => t + l.cr, 0);
      const headerAmount = Number(suggestion.amount || 0) || sumCr;

      // No usable credit line came back — one line for the matched customer.
      if (!lines.length && finalCrAcc) {
        lines.push({ acc: finalCrAcc, head: finalCrHead, dr: 0, cr: headerAmount, narration: '' });
      }

      // One customer: its line is the receipt amount. Several: left as given and
      // flagged if they do not add up to the amount.
      const crTotal = Number(lines.reduce((t, l) => t + l.cr, 0).toFixed(2));
      let adjusted = false;
      if (lines.length === 1 && headerAmount && Math.abs(lines[0].cr - headerAmount) > 0.005) {
        lines[0].cr = Number(headerAmount.toFixed(2));
        adjusted = true;
      }
      const amount = Number((lines.length === 1 ? lines[0].cr : (headerAmount || crTotal)).toFixed(2));

      // Header bank / cash account — must be a real G/L account
      const drAccRaw = String(suggestion.drAcc || '').trim();
      const drAcc = accByCode.has(drAccRaw) ? drAccRaw : '';
      const drHead = drAcc ? accByCode.get(drAcc) : '';

      // Header customer = the largest credit line
      const mainCr = lines.reduce((big, l) => (!big || l.cr > big.cr ? l : big), null);

      res.json({
        lines,                       // credit (customer) lines only — the grid
        drAcc,                       // header bank / cash account
        drHead,
        crAcc: mainCr ? mainCr.acc : finalCrAcc,
        crHead: mainCr ? mainCr.head : finalCrHead,
        amount,
        cheques: Array.isArray(suggestion.cheques) ? suggestion.cheques : [],
        narration: String(suggestion.narration || '').substring(0, 100),
        confidence: bestCustomerMatch
          ? 'high'
          : (['high', 'medium', 'low'].includes(suggestion.confidence) ? suggestion.confidence : 'medium'),
        // TEMP DEBUG — remove once matching is confirmed working. If this key
        // is missing from the Network-tab response entirely, the server is
        // still running an older copy of this file.
        _debug: {
          version: 'gl-suggest-v4-credit-lines',
          lineCount: lines.length,
          crTotal, adjusted,
          geminiDrAccRejected: drAccRaw && !drAcc ? drAccRaw : undefined,
          accountCandidates: accountCandidates.map(r => `${r.CODE} - ${r.NAME}`),
          geminiLines: suggestion.lines,
          geminiDrAcc: suggestion.drAcc,
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
        dbQuery(connection, 'SELECT ACC_CODE, ACC_HEAD FROM acc_mst ORDER BY ACC_CODE LIMIT 400'),
        dbQuery(connection, 'SELECT CUST_CODE, CUST_NAME FROM cus_mst ORDER BY CUST_NAME LIMIT 200'),
        dbQuery(connection, 'SELECT SUP_CODE, SUP_NAME FROM sup_mst ORDER BY SUP_NAME LIMIT 200'),
        findCandidates(connection, 'cus_mst', 'CUST_CODE', 'CUST_NAME', narration),
        findCandidates(connection, 'sup_mst', 'SUP_CODE', 'SUP_NAME', narration),
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
      const prompt = `You are an ERP accounting assistant for a UAE manufacturing company (${COMPANY.SHORT}).
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
