// routes/contraRegRoutes.js
// ─────────────────────────────────────────────────────────────────────────────
// Contra Register — PV / JV vouchers flagged as contra (vouchers.CONTRA_FLG='Y')
// for a period, in date order. One row per voucher: the Dr account(s) money
// went TO and the Cr account(s) it came FROM, with names from ac_list.
//
//   GET /api/contra-register?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Register in HayatDb.js like the other report routes, e.g.
//   app.use("/api", authMiddleware, require("./routes/contraRegRoutes")(connection));
// ─────────────────────────────────────────────────────────────────────────────
const express = require("express");

const ISO = /^\d{4}-\d{2}-\d{2}$/;

module.exports = function (connection) {
  const router = express.Router();

  router.get("/contra-register", (req, res) => {
    const from = String(req.query.from || "");
    const to = String(req.query.to || "");
    if (!ISO.test(from) || !ISO.test(to)) {
      return res.status(400).json({ message: "from and to must be YYYY-MM-DD" });
    }

    // GROUP_CONCAT is capped at 1024 chars by default — plenty for the two or
    // three accounts a contra voucher carries.
    const sql = `
      SELECT v.TRAN_TYPE,
             COALESCE(tt.TYPE_ABBR, v.TRAN_TYPE)            AS TYPE_ABBR,
             v.VCHR_NO,
             DATE_FORMAT(v.DATTE, '%d/%m/%Y')               AS VDATE,
             DATE_FORMAT(v.DATTE, '%Y-%m-%d')               AS VDATE_ISO,
             GROUP_CONCAT(CASE WHEN t.DB_CR = 'D' THEN t.ACC_CODE END
                          ORDER BY t.SR_NO SEPARATOR ', ')   AS DR_CODE,
             GROUP_CONCAT(CASE WHEN t.DB_CR = 'D' THEN a.AC_HEAD END
                          ORDER BY t.SR_NO SEPARATOR ', ')   AS DR_HEAD,
             GROUP_CONCAT(CASE WHEN t.DB_CR = 'C' THEN t.ACC_CODE END
                          ORDER BY t.SR_NO SEPARATOR ', ')   AS CR_CODE,
             GROUP_CONCAT(CASE WHEN t.DB_CR = 'C' THEN a.AC_HEAD END
                          ORDER BY t.SR_NO SEPARATOR ', ')   AS CR_HEAD,
             SUM(CASE WHEN t.DB_CR = 'D' THEN t.AMOUNT ELSE 0 END) AS AMOUNT,
             MAX(v.CHEQUE_NO)                                AS CHEQUE_NO,
             MAX(COALESCE(NULLIF(v.NARRATION1, ''), v.PARTICULARS)) AS NARRATION
        FROM vouchers v
        JOIN tran_acc t
          ON t.TRAN_TYPE = v.TRAN_TYPE AND t.VCHR_NO = v.VCHR_NO
        LEFT JOIN ac_list a   ON a.AC_CODE = t.ACC_CODE
        LEFT JOIN tran_type tt ON tt.TRAN_TYPE = v.TRAN_TYPE
       WHERE v.CONTRA_FLG = 'Y'
         AND v.DATTE >= ? AND v.DATTE < DATE_ADD(?, INTERVAL 1 DAY)
       GROUP BY v.TRAN_TYPE, tt.TYPE_ABBR, v.VCHR_NO, v.DATTE
       ORDER BY v.DATTE, v.TRAN_TYPE, v.VCHR_NO`;

    connection.query(sql, [from, to], (err, rows) => {
      if (err) {
        console.error("contra-register:", err);
        return res.status(500).json({ message: "Could not load the contra register" });
      }
      res.json(rows);
    });
  });

  return router;
};
