// routes/custOutBal.js
// Customer balances for the Fabrication Invoice header:
//   LEDGER_BAL = customer ledger balance in tran_acc (Dr − Cr, all dates)
//   PDC_BAL    = post-dated cheques received and not yet realised (pdc_rcd.REALISED <> 'Y')
//
// Register in HayatDb.js:
//   const custOutBal = require('./routes/custOutBal');
//   app.use('/api', custOutBal(connection));
//
// If pdc_rcd names its customer / amount columns differently, change the two
// constants below (run `desc pdc_rcd;` to check).
const express = require('express');

const PDC_CUST_COL = 'CUST_CODE';
const PDC_AMT_COL  = 'AMOUNT';

module.exports = function (connection) {
    const router = express.Router();

    // GET /api/cust-out-bal/:custCode  →  { LEDGER_BAL, PDC_BAL }
    router.get('/cust-out-bal/:custCode', (req, res) => {
        const code = String(req.params.custCode || '').trim();
        if (!code) return res.json({ LEDGER_BAL: 0, PDC_BAL: 0 });

        const sql = `
            SELECT
              (SELECT IFNULL(SUM(CASE WHEN DB_CR = 'D' THEN AMOUNT ELSE -AMOUNT END), 0)
                 FROM tran_acc
                WHERE ACC_CODE = ?)                                   AS LEDGER_BAL,
              (SELECT IFNULL(SUM(${PDC_AMT_COL}), 0)
                 FROM pdc_rcd
                WHERE ${PDC_CUST_COL} = ?
                  AND IFNULL(REALISED, 'N') <> 'Y')                   AS PDC_BAL`;

        connection.query(sql, [code, code], (err, rows) => {
            if (err) {
                console.error('cust-out-bal error:', err);
                return res.status(500).json({ error: 'Failed to load customer balances' });
            }
            const r = rows?.[0] || {};
            res.json({
                LEDGER_BAL: Number(r.LEDGER_BAL) || 0,
                PDC_BAL: Number(r.PDC_BAL) || 0,
            });
        });
    });

    return router;
};
