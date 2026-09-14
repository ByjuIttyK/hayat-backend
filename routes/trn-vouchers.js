// routes/trn-vouchers.js
// ---------------------------------------------------------------------------
// Voucher dropdown list for the Transaction Print (TrnPrn) screen.
//
// Register in HayatDb.js:
//     const trnVouchersRoute = require("./routes/trn-vouchers");
//     app.use("/api", trnVouchersRoute(connection));
//
// GET /api/trn-vouchers/:tranType?limit=1000&from=YYYY-MM-DD
//   → [ { VCHR_NO: "1234", DATTE: "05/09/2026" }, ... ]  newest first
//
// GROUP BY collapses the voucher's lines to one row. The LIMIT is there
// because a type like 05 can hold tens of thousands of vouchers — the screen
// filters what it is given, so it only needs the recent ones. Raise it, or
// pass ?from=, if an older voucher has to be reachable from the dropdown.
// Table names lowercase for the Linux VPS.
// ---------------------------------------------------------------------------
const express = require("express");

module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise();

  router.get("/trn-vouchers/:tranType", async (req, res) => {
    const { tranType } = req.params;
    const limit = Math.min(parseInt(req.query.limit, 10) || 1000, 5000);
    const { from } = req.query;

    try {
      const where = ["TRAN_TYPE = ?"];
      const args = [tranType];
      if (from) {
        where.push("DATTE >= ?");
        args.push(from);
      }
      args.push(limit);

      const [rows] = await db.query(
        `SELECT VCHR_NO,
                DATE_FORMAT(MAX(DATTE), '%d/%m/%Y') AS DATTE
           FROM tran_acc
          WHERE ${where.join(" AND ")}
          GROUP BY VCHR_NO
          ORDER BY MAX(DATTE) DESC, CAST(VCHR_NO AS UNSIGNED) DESC
          LIMIT ?`,
        args
      );

      res.json(rows);
    } catch (err) {
      console.error("[trn-vouchers]", err);
      res.status(500).json({ message: "Failed to fetch voucher list" });
    }
  });

  return router;
};
