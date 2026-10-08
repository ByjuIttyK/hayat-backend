// routes/fabDoInvLov.js
// ─────────────────────────────────────────────────────────────────────────────
// Invoice LOV for the Delivery Order screen (FabDo.tsx → FabInvLov.tsx).
//
//   GET /api/fabdo-inv-lov?cust=<CUST_CODE>&job=<JOB_NO>
//     cust  required — invoices of that customer
//     job   optional — narrows to that job when given
//   → [{ INV_NO, INV_DATE (dd/mm/yyyy), JOB_NO, LPO_NO, DO_NO, NET_AMT }]
//   Cancelled invoices (INV_CANCELLED = 'Y') are excluded. Newest first.
//
// Register in HayatDb.js:
//   app.use(require("./routes/fabDoInvLov")(connection));
// ─────────────────────────────────────────────────────────────────────────────
const express = require("express");

module.exports = (connection) => {
    const router = express.Router();

    router.get("/api/fabdo-inv-lov", (req, res) => {
        const cust = String(req.query.cust || "").trim();
        const job = String(req.query.job || "").trim();
        if (!cust) return res.status(400).json({ error: "Customer Code is required" });

        let sql =
            `SELECT INV_NO,
                    DATE_FORMAT(INV_DATE, '%d/%m/%Y') AS INV_DATE,
                    IFNULL(JOB_NO, '')  AS JOB_NO,
                    IFNULL(LPO_NO, '')  AS LPO_NO,
                    IFNULL(DO_NO, '')   AS DO_NO,
                    IFNULL(NET_AMT, 0)  AS NET_AMT
               FROM fab_inv_hdr
              WHERE CUST_CODE = ?
                AND IFNULL(INV_CANCELLED, 'N') <> 'Y'`;
        const params = [cust];
        if (job) { sql += ` AND JOB_NO = ?`; params.push(job); }
        sql += ` ORDER BY INV_DATE DESC, INV_NO DESC LIMIT 500`;

        connection.query(sql, params, (err, rows) => {
            if (err) {
                console.error("[fabdo-inv-lov]", err.message);
                return res.status(500).json({ error: err.message });
            }
            res.json(rows);
        });
    });

    return router;
};
