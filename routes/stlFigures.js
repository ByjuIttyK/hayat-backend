// routes/stlFigures.js
// GET /api/stl-figures/:srcType/:srcDoc
//
// For every invoice a voucher (RV/PV/JV) settled in adj_dtl, the invoice's own
// figures — which adj_dtl does not hold (it only knows what the voucher settled):
//
//   INV_AMT     invoice amount: tran_acc Dr on the party for that invoice
//               (TRAN_TYPE = STLD_TYPE, vchr_no = STLD_DOC, ACC_CODE = party)
//   OWN_STLD    settled by THIS voucher
//   PRIOR_STLD  settled by other vouchers dated on/before this voucher
//               → "Already Stld" as it stood when this voucher was made (VIEW)
//   OTHER_STLD  settled by all other vouchers, any date
//               → what is settled elsewhere right now (EDIT, over-settle check)
//
// Register in HayatDb.js:
//   app.use("/api", require("./routes/stlFigures")(connection));

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  router.get("/stl-figures/:srcType/:srcDoc", (req, res) => {
    const srcType = String(req.params.srcType || "").trim();
    const srcDoc = String(req.params.srcDoc || "").trim();
    if (!srcType || !srcDoc) return res.status(400).json({ message: "Voucher type and no. required" });

    // SOURCE_DOC is stored 10-wide ('0000003986'); accept the number either way.
    const sql = `
      SELECT a.STLD_TYPE, a.STLD_DOC, a.ACC_CODE,
             MIN(a.SOURCE_DATE)              AS SRC_DATE,
             SUM(IFNULL(a.STLD_AMT, 0))      AS OWN_STLD,
             (SELECT IFNULL(SUM(t.AMOUNT), 0)
                FROM tran_acc t
               WHERE t.TRAN_TYPE = a.STLD_TYPE
                 AND t.vchr_no   = a.STLD_DOC
                 AND t.ACC_CODE  = a.ACC_CODE
                 AND t.DB_CR     = 'D')                          AS INV_AMT,
             (SELECT DATE_FORMAT(MIN(t.DATTE), '%d/%m/%Y')
                FROM tran_acc t
               WHERE t.TRAN_TYPE = a.STLD_TYPE
                 AND t.vchr_no   = a.STLD_DOC
                 AND t.ACC_CODE  = a.ACC_CODE)                   AS INV_DATE,
             (SELECT IFNULL(SUM(x.STLD_AMT), 0)
                FROM adj_dtl x
               WHERE x.STLD_TYPE = a.STLD_TYPE
                 AND x.STLD_DOC  = a.STLD_DOC
                 AND x.ACC_CODE  = a.ACC_CODE
                 AND NOT (x.SOURCE_TYPE = a.SOURCE_TYPE AND x.SOURCE_DOC = a.SOURCE_DOC)
                 AND x.SOURCE_DATE <= a.SOURCE_DATE)             AS PRIOR_STLD,
             (SELECT IFNULL(SUM(x.STLD_AMT), 0)
                FROM adj_dtl x
               WHERE x.STLD_TYPE = a.STLD_TYPE
                 AND x.STLD_DOC  = a.STLD_DOC
                 AND x.ACC_CODE  = a.ACC_CODE
                 AND NOT (x.SOURCE_TYPE = a.SOURCE_TYPE AND x.SOURCE_DOC = a.SOURCE_DOC)) AS OTHER_STLD
        FROM adj_dtl a
       WHERE a.SOURCE_TYPE = ?
         AND a.SOURCE_DOC IN (?, LPAD(?, 10, '0'))
       GROUP BY a.STLD_TYPE, a.STLD_DOC, a.ACC_CODE, a.SOURCE_TYPE, a.SOURCE_DOC, a.SOURCE_DATE`;

    connection.query(sql, [srcType, srcDoc, srcDoc], (err, rows) => {
      if (err) {
        console.error("stl-figures:", err);
        return res.status(500).json({ message: err.message });
      }
      res.json((rows || []).map((r) => ({
        STLD_TYPE: r.STLD_TYPE,
        STLD_DOC: r.STLD_DOC,
        ACC_CODE: r.ACC_CODE,
        INV_DATE: r.INV_DATE || "",
        INV_AMT: Number(r.INV_AMT) || 0,
        OWN_STLD: Number(r.OWN_STLD) || 0,
        PRIOR_STLD: Number(r.PRIOR_STLD) || 0,
        OTHER_STLD: Number(r.OTHER_STLD) || 0,
      })));
    });
  });

  return router;
};
