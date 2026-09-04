// E:\hayatApi\routes\CurrentChqRoutes.js
//
// PDC Register — listing API over CURRENT_CHQ
//   TRAN_TYPE = '03'  -> PDC Received
//   TRAN_TYPE = '04'  -> PDC Issued
//
// Register in HayatDb.js:
//   const currentChqRoutes = require("./routes/CurrentChqRoutes");
//   app.use("/api", currentChqRoutes(connection));
//
// NOTE: table name is kept lowercase (current_chq) for the Linux VPS.

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  const TRAN_TYPES = { "03": "PDC Received", "04": "PDC Issued" };
  const DATE_BASIS = { CHQ_DATE: "CHQ_DATE", VCHR_DATE: "VCHR_DATE" };
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

  // Only the first 10 columns are exposed — JV_NO_RLZ, JV_DATE_RLZ,
  // REALISED and MAIN_SR_NO are deliberately left out of this screen.
  const COLUMNS = `
        TRAN_TYPE,
        VCHR_NO,
        DATE_FORMAT(VCHR_DATE, '%Y-%m-%d') AS VCHR_DATE,
        CHQ_NO,
        DATE_FORMAT(CHQ_DATE,  '%Y-%m-%d') AS CHQ_DATE,
        CHQ_BANK,
        PDC_CODE,
        SUP_CODE,
        AMOUNT,
        NARRATION`;

  /**
   * GET /api/current-chq
   *   ?tranType=03|04
   *   &fromDate=YYYY-MM-DD
   *   &toDate=YYYY-MM-DD
   *   &dateBasis=CHQ_DATE|VCHR_DATE      (default CHQ_DATE)
   *
   * Returns { title, tranType, dateBasis, fromDate, toDate, count, totalAmount, rows }
   */
  router.get("/current-chq", (req, res) => {
    const tranType = String(req.query.tranType || "").trim();
    const fromDate = String(req.query.fromDate || "").trim();
    const toDate = String(req.query.toDate || "").trim();
    const dateBasis =
      DATE_BASIS[String(req.query.dateBasis || "CHQ_DATE").toUpperCase()];

    if (!TRAN_TYPES[tranType]) {
      return res
        .status(400)
        .json({ error: "tranType must be 03 (received) or 04 (issued)." });
    }
    if (!ISO_DATE.test(fromDate) || !ISO_DATE.test(toDate)) {
      return res
        .status(400)
        .json({ error: "fromDate and toDate must be sent as yyyy-mm-dd." });
    }
    if (fromDate > toDate) {
      return res
        .status(400)
        .json({ error: "From date cannot be later than To date." });
    }
    if (!dateBasis) {
      return res
        .status(400)
        .json({ error: "dateBasis must be CHQ_DATE or VCHR_DATE." });
    }

    // dateBasis is whitelisted above, so it is safe to interpolate.
    const sql = `
      SELECT ${COLUMNS}
        FROM current_chq
       WHERE TRAN_TYPE = ?
         AND ${dateBasis} BETWEEN ? AND ?
       ORDER BY ${dateBasis} DESC, VCHR_NO`;

    connection.getConnection((err, conn) => {
      if (err) {
        console.error("current-chq: pool error", err);
        return res.status(500).json({ error: "Database connection failed." });
      }

      conn.query(sql, [tranType, fromDate, toDate], (qErr, result) => {
        conn.release();

        if (qErr) {
          console.error("current-chq: query error", qErr);
          return res.status(500).json({ error: "Could not read the cheque register." });
        }

        // DECIMAL comes back as a string from mysql2 — normalise it once here
        // so the grid, the totals and the exports all agree.
        const rows = result.map((r) => ({
          ...r,
          AMOUNT: Number(r.AMOUNT || 0),
        }));

        const totalAmount = rows.reduce((sum, r) => sum + r.AMOUNT, 0);

        res.json({
          title: TRAN_TYPES[tranType],
          tranType,
          dateBasis,
          fromDate,
          toDate,
          count: rows.length,
          totalAmount: Number(totalAmount.toFixed(2)),
          rows,
        });
      });
    });
  });

  /**
   * GET /api/current-chq/summary
   * Bank-wise totals for the same filters — handy for a drill-down or a chart later.
   */
  router.get("/current-chq/summary", (req, res) => {
    const tranType = String(req.query.tranType || "").trim();
    const fromDate = String(req.query.fromDate || "").trim();
    const toDate = String(req.query.toDate || "").trim();
    const dateBasis =
      DATE_BASIS[String(req.query.dateBasis || "CHQ_DATE").toUpperCase()];

    if (!TRAN_TYPES[tranType] || !ISO_DATE.test(fromDate) || !ISO_DATE.test(toDate) || !dateBasis) {
      return res.status(400).json({ error: "Invalid filter values." });
    }

    const sql = `
      SELECT CHQ_BANK,
             COUNT(*)     AS CHQ_COUNT,
             SUM(AMOUNT)  AS TOTAL_AMOUNT
        FROM current_chq
       WHERE TRAN_TYPE = ?
         AND ${dateBasis} BETWEEN ? AND ?
    GROUP BY CHQ_BANK
    ORDER BY TOTAL_AMOUNT DESC`;

    connection.getConnection((err, conn) => {
      if (err) {
        console.error("current-chq/summary: pool error", err);
        return res.status(500).json({ error: "Database connection failed." });
      }

      conn.query(sql, [tranType, fromDate, toDate], (qErr, result) => {
        conn.release();
        if (qErr) {
          console.error("current-chq/summary: query error", qErr);
          return res.status(500).json({ error: "Could not build the bank summary." });
        }
        res.json(
          result.map((r) => ({
            CHQ_BANK: r.CHQ_BANK,
            CHQ_COUNT: Number(r.CHQ_COUNT || 0),
            TOTAL_AMOUNT: Number(r.TOTAL_AMOUNT || 0),
          }))
        );
      });
    });
  });

  return router;
};
