// routes/jobFinance.js
// Receipts (R.V.) settled against a job's invoices, traced through adj_dtl.
// R.V.s carry no Job No, so the link is:  adj_dtl.STLD_DOC = invoice no,
// adj_dtl.SOURCE_DOC = R.V. no.  The frontend sends the job's invoice numbers
// (from /api/fabinvjob/:jobNo) plus the customer code to keep invoice numbers
// of other parties/series from matching.
//
// Register in HayatDb.js:
//   const jobFinance = require('./routes/jobFinance');
//   app.use('/api', jobFinance(connection));
const express = require('express');

module.exports = function (connection) {
    const router = express.Router();

    // POST /api/job-rcp-dtl   body: { invNos: string[], custCode?: string }
    router.post('/job-rcp-dtl', (req, res) => {
        const invNos = Array.isArray(req.body?.invNos)
            ? req.body.invNos.map(String).filter(Boolean)
            : [];
        const custCode = (req.body?.custCode || '').trim();
        if (invNos.length === 0) return res.json([]);

        let sql = `
            SELECT SOURCE_DOC, SOURCE_TYPE, SOURCE_DATE,
                   STLD_DOC, STLD_TYPE, STLD_DATE,
                   STLD_DBCR, STLD_AMT, ACC_CODE
              FROM adj_dtl
             WHERE STLD_DOC IN (?)`;
        const params = [invNos];
        if (custCode) {
            sql += ` AND ACC_CODE = ?`;
            params.push(custCode);
        }
        sql += ` ORDER BY SOURCE_DATE, SOURCE_DOC, STLD_DOC`;

        connection.query(sql, params, (err, rows) => {
            if (err) {
                console.error('job-rcp-dtl error:', err);
                return res.status(500).json({ error: 'Failed to load job receipts' });
            }
            res.json(rows);
        });
    });

    return router;
};
