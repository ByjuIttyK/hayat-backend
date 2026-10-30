// =====================================================================
// empLookupsApi.js — dropdown lists for the Employee Master screen   30-Oct-2026
//   GET /api/emp-lookups  →  { nations: [{ code, name }], accrualAcs: [{ code, head }] }
//     nations    : nation_mst
//     accrualAcs : acc_mst accounts with acc_code LIKE '213%'  (Accrued Sal A/c (Cr))
//
// Register in HayatDb.js:
//   const empLookupsApi = require('./routes/empLookupsApi');
//   app.use('/api', empLookupsApi(connection));
// =====================================================================
const express = require('express');

module.exports = function (connection) {
  const router = express.Router();
  const q = (sql, params = []) =>
    new Promise((resolve, reject) => connection.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

  router.get('/emp-lookups', async (req, res) => {
    try {
      const nations = await q(`SELECT NATION_CODE code, NATION_NAME name FROM nation_mst ORDER BY NATION_NAME`);
      const accrualAcs = await q(`SELECT ACC_CODE code, ACC_HEAD head FROM acc_mst WHERE ACC_CODE LIKE '231%' ORDER BY ACC_CODE`);
      res.json({ nations, accrualAcs });
    } catch (err) {
      console.error('emp-lookups:', err);
      res.status(500).json({ message: err.message });
    }
  });

  return router;
};
