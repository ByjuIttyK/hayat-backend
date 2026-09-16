// routes/TrialBalanceRoutes.js
// Trial Balance — Periodic (O/P balance + range Dr/Cr + closing) and As On (closing Dr/Cr).
// Each row carries its Report Line (ac_list.REPORT_LN) with the description and
// primary group from rpln_mst.
// Register in HayatDb.js:
//   app.use("/api", authMiddleware, require("./routes/TrialBalanceRoutes")(connection));

const express = require("express");

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Both joins are collapsed to one row per key so they can never duplicate an
// account (and double its amounts):
//  - ac_list is a UNION ALL of acc_mst / sup_mst / cus_mst, so a code present
//    in two masters would otherwise come back twice;
//  - rpln_mst's key is (PRIMARY_GROUP, REPORT_LN).
const RPLN_JOIN = `
        LEFT JOIN (SELECT AC_CODE,
                          MAX(AC_HEAD)   AS AC_HEAD,
                          MAX(REPORT_LN) AS REPORT_LN
                     FROM ac_list
                    GROUP BY AC_CODE) l ON l.AC_CODE = x.ACC_CODE
        LEFT JOIN (SELECT REPORT_LN,
                          MAX(RP_HEAD)       AS RP_HEAD,
                          MAX(PRIMARY_GROUP) AS PRIMARY_GROUP
                     FROM rpln_mst
                    GROUP BY REPORT_LN) r ON r.REPORT_LN = l.REPORT_LN`;

const COMMON_COLS = `
             COALESCE(l.REPORT_LN, '')                       AS REPORT_LN,
             COALESCE(r.RP_HEAD, '')                         AS RP_HEAD,
             COALESCE(r.PRIMARY_GROUP, '')                   AS PRIMARY_GROUP,
             x.ACC_CODE                                      AS AC_CODE,
             COALESCE(l.AC_HEAD, '** Not in A/c master **')  AS AC_HEAD,`;

module.exports = function (connection) {
  const router = express.Router();

  // GET /api/trialbal/periodic/:stdt/:enddt   (dates as yyyy-mm-dd)
  // O/P balance = everything strictly before stdt.
  // DATTE < enddt + 1 day keeps it correct even if DATTE carries a time part.
  router.get("/trialbal/periodic/:stdt/:enddt", (req, res) => {
    const { stdt, enddt } = req.params;
    if (!ISO_DATE.test(stdt) || !ISO_DATE.test(enddt) || stdt > enddt) {
      return res.status(400).send("Invalid date range");
    }

    const sql = `
      SELECT ${COMMON_COLS}
             x.OP_BAL, x.DR_AMT, x.CR_AMT,
             ROUND(x.OP_BAL + x.DR_AMT - x.CR_AMT, 2)        AS CL_BAL
        FROM (
              SELECT ACC_CODE,
                     ROUND(SUM(CASE WHEN DATTE < ?
                                    THEN CASE WHEN DB_CR = 'D' THEN AMOUNT ELSE -AMOUNT END
                                    ELSE 0 END), 2)                                   AS OP_BAL,
                     ROUND(SUM(CASE WHEN DATTE >= ? AND DB_CR = 'D' THEN AMOUNT ELSE 0 END), 2) AS DR_AMT,
                     ROUND(SUM(CASE WHEN DATTE >= ? AND DB_CR = 'C' THEN AMOUNT ELSE 0 END), 2) AS CR_AMT
                FROM tran_acc
               WHERE DATTE < DATE_ADD(?, INTERVAL 1 DAY)
               GROUP BY ACC_CODE
             ) x
        ${RPLN_JOIN}
       WHERE x.OP_BAL <> 0 OR x.DR_AMT <> 0 OR x.CR_AMT <> 0
       ORDER BY x.ACC_CODE`;

    connection.query(sql, [stdt, stdt, stdt, enddt], (error, result) => {
      if (error) {
        console.log("Trial balance (periodic) select error", error);
        return res.status(500).send("Server error - trial balance periodic");
      }
      res.send(result);
    });
  });

  // GET /api/trialbal/ason/:asdt   (date as yyyy-mm-dd)
  // Same row shape as periodic: OP_BAL = 0, DR_AMT / CR_AMT = closing balance
  // on its side, CL_BAL = signed closing.
  router.get("/trialbal/ason/:asdt", (req, res) => {
    const { asdt } = req.params;
    if (!ISO_DATE.test(asdt)) {
      return res.status(400).send("Invalid date");
    }

    const sql = `
      SELECT ${COMMON_COLS}
             0                                               AS OP_BAL,
             CASE WHEN x.BAL > 0 THEN x.BAL  ELSE 0 END      AS DR_AMT,
             CASE WHEN x.BAL < 0 THEN -x.BAL ELSE 0 END      AS CR_AMT,
             x.BAL                                           AS CL_BAL
        FROM (
              SELECT ACC_CODE,
                     ROUND(SUM(CASE WHEN DB_CR = 'D' THEN AMOUNT ELSE -AMOUNT END), 2) AS BAL
                FROM tran_acc
               WHERE DATTE < DATE_ADD(?, INTERVAL 1 DAY)
               GROUP BY ACC_CODE
             ) x
        ${RPLN_JOIN}
       WHERE x.BAL <> 0
       ORDER BY x.ACC_CODE`;

    connection.query(sql, [asdt], (error, result) => {
      if (error) {
        console.log("Trial balance (as on) select error", error);
        return res.status(500).send("Server error - trial balance as on");
      }
      res.send(result);
    });
  });

  return router;
};
