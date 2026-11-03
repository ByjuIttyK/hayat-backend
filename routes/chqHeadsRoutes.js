// routes/chqHeadsRoutes.js
// ─────────────────────────────────────────────────────────────────────────────
// Account names for the AcLedger "Cheque details" panel.
//
//   POST /api/chq-heads
//   body: { codes: ["111-011-0-001", "1CS1372", ...], tranType: "01", vchrNo: "0000002226" }
//
//   → {
//       heads: { "111-011-0-001": "RAK BANK (AED A/C) - ...", "1CS1372": "SIRAJ POWER ..." },
//       legs:  [ { ACC_CODE, AC_HEAD, DB_CR }, ... ]   // the voucher's tran_acc lines
//     }
//
// `heads` gives the bank / party names from ac_list for the codes on the cheques.
// `legs` lets the panel name the party when the cheque row carries no
// PARTY_CODE (e.g. a current-dated cheque on a BR): the leg that is not the bank.
//
// Register in HayatDb.js next to the ledger-drill routes, the same way, e.g.
//   app.use("/api", authMiddleware, require("./routes/chqHeadsRoutes")(connection));
// ─────────────────────────────────────────────────────────────────────────────
const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  const q = (sql, params) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

  router.post("/chq-heads", async (req, res) => {
    try {
      const codes = [...new Set(
        (Array.isArray(req.body?.codes) ? req.body.codes : [])
          .map(c => String(c ?? "").trim())
          .filter(Boolean)
      )].slice(0, 200);
      const tranType = String(req.body?.tranType ?? "").trim();
      const vchrNo = String(req.body?.vchrNo ?? "").trim();

      const heads = {};
      if (codes.length) {
        const rows = await q(
          "SELECT AC_CODE, AC_HEAD FROM ac_list WHERE AC_CODE IN (?)",
          [codes]
        );
        for (const r of rows) heads[String(r.AC_CODE).trim()] = r.AC_HEAD;
      }

      let legs = [];
      if (tranType && vchrNo) {
        legs = await q(
          `SELECT t.ACC_CODE, a.AC_HEAD, t.DB_CR
             FROM tran_acc t
             LEFT JOIN ac_list a ON a.AC_CODE = t.ACC_CODE
            WHERE t.TRAN_TYPE = ? AND t.VCHR_NO = ?
            ORDER BY t.srno_row_id`,
          [tranType, vchrNo]
        );
      }

      res.json({ heads, legs });
    } catch (err) {
      console.error("chq-heads:", err);
      res.status(500).json({ error: "Could not load account names" });
    }
  });

  return router;
};
