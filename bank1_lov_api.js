// ─────────────────────────────────────────────────────────────────────────────
//  bank1_lov_api.js — Serves the "primary bank" list (bank_mst rows where
//  ACC_INDICATOR = 'BANK1') for the lovmetadata-driven LOV picker.
//  Mount in HayatDb.js:
//    const bank1LovApi = require('./bank1_lov_api')(connection);
//    app.use('/api', bank1LovApi);
//  → exposes GET /api/banklst-bank1
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');

function dbQuery(connection, sql, params = []) {
  return new Promise((resolve, reject) => {
    connection.query(sql, params, (err, rows) => {
      if (err) reject(err); else resolve(rows);
    });
  });
}

module.exports = function (connection) {
  const router = express.Router();

  // GET /api/banklst-bank1
  // Returns bank_mst rows restricted to ACC_INDICATOR = 'BANK1' (the
  // company's primary current/operating bank account used for depositing
  // cleared / current-dated cheques), for use by the lovmetadata LOV system.
  router.get('/banklst-bank1', async (req, res) => {
    try {
      const rows = await dbQuery(
        connection,
        "SELECT BANK_CODE, BANK_NAME FROM bank_mst WHERE ACC_INDICATOR = 'BANK1' ORDER BY BANK_NAME"
      );
      res.json(rows);
    } catch (err) {
      console.error('banklst-bank1 error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
