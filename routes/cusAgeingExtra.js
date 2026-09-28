// routes/cusAgeingExtra.js
// Extra endpoints for the Customer Ageing screen (CusAgeingInv.tsx):
//   GET /api/cus-ageing/lov-customers                      -> customer LOV
//   GET /api/cus-ageing/ledger-bal?as_at_date=&p_sman=&p_cus= -> G/L balance per customer as on date
//
// Register in HayatDb.js:
//   app.use("/api", authMiddleware, require("./routes/cusAgeingExtra")(connection));

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  const q = (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

  /* ── Customer LOV ─────────────────────────────────────────────── */
  router.get("/cus-ageing/lov-customers", async (req, res) => {
    try {
      const rows = await q(
        `SELECT CUST_CODE, CUST_NAME
           FROM cus_mst
          ORDER BY CUST_CODE`);
      res.json(rows);
    } catch (e) {
      console.error("lov-customers:", e);
      res.status(500).json({ error: e.message });
    }
  });

  /* ── Ledger balance per customer as on date ──────────────────────
     Balance = Debits - Credits from tran_acc up to and including the date.
     Only non-zero balances are returned; the screen treats a missing
     customer as a ledger balance of zero. */
  router.get("/cus-ageing/ledger-bal", async (req, res) => {
    const { as_at_date, p_sman, p_cus } = req.query;
    if (!as_at_date) return res.status(400).json({ error: "as_at_date is required" });

    const where  = ["t.DATTE <= ?"];          // <- tran_acc voucher date column
    const params = [as_at_date];
    if (p_sman) { where.push("c.SMAN_CODE = ?"); params.push(p_sman); }
    if (p_cus)  { where.push("t.ACC_CODE = ?");  params.push(p_cus); }

    try {
      const rows = await q(
        `SELECT t.ACC_CODE,
                c.CUST_NAME,
                c.SMAN_CODE,
                ROUND(SUM(CASE WHEN t.DB_CR = 'D' THEN t.AMOUNT ELSE -t.AMOUNT END), 2) AS LEDGER_BAL
           FROM tran_acc t
           JOIN cus_mst  c ON c.CUST_CODE = t.ACC_CODE
          WHERE ${where.join(" AND ")}
          GROUP BY t.ACC_CODE, c.CUST_NAME, c.SMAN_CODE
         HAVING ABS(LEDGER_BAL) >= 0.005
          ORDER BY t.ACC_CODE`,
        params);
      res.json(rows);
    } catch (e) {
      console.error("ledger-bal:", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
