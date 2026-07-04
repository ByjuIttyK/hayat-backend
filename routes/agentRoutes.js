// ============================================================
// agentRoutes.js
// Al Hayat ERP  |  AI Agent — Intent Parser + Task Router
//
// Mount in HayatDb.js:
//   const agentRoutes = require('./routes/agentRoutes')(connection);
//   app.use('/api/agent', authMiddleware, agentRoutes);
// ============================================================
'use strict';

const express = require('express');
const { previewPdcRealise,  confirmPdcRealise  } = require('../agents/agentPdcRealise');
const { previewPdcPayable, confirmPdcPayable } = require('../agents/agentPdcPayable');

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const MODEL      = 'gemini-2.5-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

module.exports = function (connection) {
  const router = express.Router();
  const db     = connection.promise();

  const user = (req) =>
    req.user?.username || req.body?.user || req.query?.user || 'UNKNOWN';

  // ── Helper: call Gemini REST ──────────────────────────────
  async function callGemini(prompt) {
    const r = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 256,
          responseMimeType: 'application/json',
        },
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || 'Gemini error');
    const text = data.candidates?.[0]?.content?.parts
      ?.map(p => p.text || '').join('') || '';
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  }

  // ──────────────────────────────────────────────────────────
  // POST /api/agent/parse
  // Step 1: Parse user goal → structured intent
  // Body: { goalText }
  // ──────────────────────────────────────────────────────────
  router.post('/parse', async (req, res) => {
    try {
      const { goalText } = req.body;
      if (!goalText?.trim())
        return res.status(400).json({ error: 'goalText is required' });

      const today = new Date().toISOString().slice(0, 10);

      const prompt = `You are an ERP assistant for a UAE manufacturing company.
Parse the user's instruction and return a structured JSON intent.

Today's date: ${today}

User instruction: "${goalText.trim()}"

Supported tasks:
- pdc_rcv_realise : Realise/clear matured received (incoming) PDC cheques → generates RV vouchers
- pdc_pay_realise : Realise/clear matured issued (outgoing) PDC cheques → generates PV vouchers  
- bank_recon      : Bank reconciliation for a specific bank account
- depreciation_jv : Monthly depreciation journal entry
- salary_jv       : Monthly salary payable journal entry

Extract:
- taskCode    : one of the task codes above, or "unknown" if not recognised
- asOnDate    : date mentioned (YYYY-MM-DD). Use today if not specified: ${today}
- bankCode    : bank account code or name if mentioned, else null
- description : one sentence describing what will be done
- confidence  : "high" / "medium" / "low"

Return ONLY this JSON:
{
  "taskCode": "",
  "asOnDate": "${today}",
  "bankCode": null,
  "description": "",
  "confidence": "high"
}`;

      const intent = await callGemini(prompt);
      res.json({ success: true, intent });

    } catch (err) {
      console.error('agent/parse error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────
  // POST /api/agent/preview
  // Step 2: Run the preview (no DB writes)
  // Body: { goalText, intent: { taskCode, asOnDate, bankCode, ... } }
  // ──────────────────────────────────────────────────────────
  router.post('/preview', async (req, res) => {
    try {
      const { goalText, intent } = req.body;
      if (!intent?.taskCode)
        return res.status(400).json({ error: 'intent.taskCode is required' });

      const u = user(req);
      let preview;

      switch (intent.taskCode) {
        case 'pdc_rcv_realise':
          preview = await previewPdcRealise(db, intent);
          break;
        case 'pdc_pay_realise':
          preview = await previewPdcPayable(db, intent);
          break;
        case 'bank_recon':
          return res.json({
            success: true,
            preview: { message: 'Bank reconciliation agent coming soon. Use the Bank Reconciliation screen for now.' },
            runId: null,
          });
        case 'depreciation_jv':
          return res.json({
            success: true,
            preview: { message: 'Depreciation JV agent coming soon.' },
            runId: null,
          });
        default:
          return res.status(400).json({
            error: `Task '${intent.taskCode}' is not supported yet.`,
            supportedTasks: ['pdc_rcv_realise', 'pdc_pay_realise'],
          });
      }

      // Save run log with status P (preview)
      const [result] = await db.query(
        `INSERT INTO agent_run_log
           (TASK_CODE, GOAL_TEXT, PARAMS_JSON, STATUS, PREVIEW_JSON, CREATED_BY)
         VALUES (?, ?, ?, 'P', ?, ?)`,
        [
          intent.taskCode,
          goalText || '',
          JSON.stringify(intent),
          JSON.stringify(preview),
          u,
        ]
      );

      res.json({ success: true, runId: result.insertId, preview });

    } catch (err) {
      console.error('agent/preview error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────
  // POST /api/agent/confirm
  // Step 3: User confirms — execute and post
  // Body: { runId, editedCheques?, selectedChqNos? }
  //   editedCheques:  [{ chqNo, bankAcc }]  — optional per-row bank overrides
  //   selectedChqNos: [chqNo, ...]          — only these rows get posted;
  //                                           if omitted, all rows are posted
  // ──────────────────────────────────────────────────────────
  router.post('/confirm', async (req, res) => {
    try {
      const { runId, editedCheques, selectedChqNos } = req.body;
      if (!runId) return res.status(400).json({ error: 'runId is required' });

      const u = user(req);

      // Load the run log
      const [[run]] = await db.query(
        `SELECT * FROM agent_run_log WHERE ID = ? AND STATUS = 'P'`,
        [runId]
      );
      if (!run)
        return res.status(404).json({ error: 'Run not found or already processed' });

      const intent  = JSON.parse(run.PARAMS_JSON  || '{}');
      const preview = JSON.parse(run.PREVIEW_JSON || '{}');

      // Filter down to only the ticked cheques, if a selection was sent
      if (Array.isArray(selectedChqNos) && Array.isArray(preview.cheques)) {
        const selSet = new Set(selectedChqNos);
        preview.cheques = preview.cheques.filter((c) => selSet.has(c.chqNo));
      }

      if (!preview.cheques || preview.cheques.length === 0)
        return res.status(400).json({ error: 'No cheques selected to post' });

      // Apply any user edits (e.g. changed bank account) to the preview rows
      if (Array.isArray(editedCheques) && editedCheques.length && Array.isArray(preview.cheques)) {
        const editMap = new Map(editedCheques.map((e) => [e.chqNo, e]));
        preview.cheques = preview.cheques.map((c) => {
          const edit = editMap.get(c.chqNo);
          return edit ? { ...c, ...edit } : c;
        });
      }

      let result;

      switch (run.TASK_CODE) {
        case 'pdc_rcv_realise':
          result = await confirmPdcRealise(db, intent, preview, runId, u);
          break;
        case 'pdc_pay_realise':
          result = await confirmPdcPayable(db, intent, preview, runId, u);
          break;
        default:
          return res.status(400).json({ error: `No confirm handler for ${run.TASK_CODE}` });
      }

      res.json({ success: true, result });

    } catch (err) {
      console.error('agent/confirm error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────
  // POST /api/agent/cancel
  // Body: { runId }
  // ──────────────────────────────────────────────────────────
  router.post('/cancel', async (req, res) => {
    try {
      const { runId } = req.body;
      await db.query(
        `UPDATE agent_run_log SET STATUS='X' WHERE ID=? AND STATUS='P'`,
        [runId]
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────
  // GET /api/agent/banks
  // List of bank accounts for the editable Dr Bank dropdown
  // ──────────────────────────────────────────────────────────
  router.get('/banks', async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT ACC_CODE, ACC_HEAD FROM ACC_MST
         WHERE ACC_TYPE = 'B'
         ORDER BY ACC_HEAD`
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ──────────────────────────────────────────────────────────
  // GET /api/agent/history
  // Recent agent runs for this user
  // ──────────────────────────────────────────────────────────
  router.get('/history', async (req, res) => {
    try {
      const u = user(req);
      const [rows] = await db.query(
        `SELECT ID, RUN_DT, TASK_CODE, GOAL_TEXT, STATUS,
                CONFIRMED_BY, CONFIRMED_DT, ERROR_MSG,
                LEFT(RESULT_JSON, 200) AS RESULT_SNIPPET
         FROM   agent_run_log
         WHERE  CREATED_BY = ?
         ORDER  BY RUN_DT DESC
         LIMIT  100`,
        [u]
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
