// routes/partySnapshotRoutes.js
// Customer snapshot for the Receipt Voucher screen (RvPartySnapshot.tsx).
// Register in HayatDb.js:
//   app.use("/api", require("./routes/partySnapshotRoutes")(connection));
//
// GET /api/party-snapshot/:accCode?asOn=YYYY-MM-DD&exType=03&exVchr=0000001234
//   asOn   : RV date (defaults to today)
//   exType / exVchr : in EDIT/VIEW, exclude this RV's own tran_acc lines so the
//                     "before RV" balance is not already reduced by it.

const express = require("express");

// ---- Schema mapping: check these against your tables ----
const RV_TRAN_TYPES = ["02", "03"]; // tran_acc TRAN_TYPE values counted as receipts

// PDCs received from this customer that have not matured yet (cheque date > asOn).
// Adjust table/column names if pdc_rcd differs.
const PDC_SQL = `
  SELECT COUNT(*) AS cnt,
         COALESCE(SUM(AMOUNT), 0) AS total,
         DATE_FORMAT(MIN(CHQ_DATE), '%d/%m/%Y') AS next_dt
    FROM pdc_rcd
   WHERE CUST_CODE = ?
     AND CHQ_DATE > ?`;

// Optional; returns null if the column does not exist.
const CREDIT_LIMIT_SQL = `SELECT CREDIT_LIMIT AS lim FROM cus_mst WHERE CUST_CODE = ?`;

module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise();

  router.get("/party-snapshot/:accCode", async (req, res) => {
    const acc = req.params.accCode;
    const asOn = /^\d{4}-\d{2}-\d{2}$/.test(req.query.asOn || "")
      ? req.query.asOn
      : new Date().toISOString().slice(0, 10);
    const hasEx = req.query.exType && req.query.exVchr;
    const exSql = hasEx ? " AND NOT (TRAN_TYPE = ? AND VCHR_NO = ?)" : "";
    const exPrm = hasEx ? [req.query.exType, req.query.exVchr] : [];

    try {
      // 1. Ledger balance up to asOn (Dr positive)
      const [[bal]] = await db.query(
        `SELECT COALESCE(SUM(CASE WHEN DB_CR = 'D' THEN AMOUNT ELSE -AMOUNT END), 0) AS bal
           FROM tran_acc
          WHERE ACC_CODE = ? AND DATTE <= ?${exSql}`,
        [acc, asOn, ...exPrm]
      );
      const balance = Number(bal.bal) || 0;

      // 2. FIFO ageing of the balance against the most recent debits
      const ageing = { b0: 0, b30: 0, b60: 0, b90: 0 };
      if (balance > 0) {
        const [debits] = await db.query(
          `SELECT AMOUNT, DATEDIFF(?, DATTE) AS days
             FROM tran_acc
            WHERE ACC_CODE = ? AND DB_CR = 'D' AND DATTE <= ?${exSql}
            ORDER BY DATTE DESC, srno_row_id DESC
            LIMIT 1000`,
          [asOn, acc, asOn, ...exPrm]
        );
        let left = balance;
        for (const d of debits) {
          if (left <= 0) break;
          const take = Math.min(left, Number(d.AMOUNT) || 0);
          const k = d.days <= 30 ? "b0" : d.days <= 60 ? "b30" : d.days <= 90 ? "b60" : "b90";
          ageing[k] += take;
          left -= take;
        }
        if (left > 0) ageing.b90 += left; // older than the debits scanned / opening balance
      }

      // 3. Invoiced (Dr) vs received (Cr) per month, last 12 months
      const [mrows] = await db.query(
        `SELECT DATE_FORMAT(DATTE, '%Y-%m') AS ym,
                SUM(CASE WHEN DB_CR = 'D' THEN AMOUNT ELSE 0 END) AS dr,
                SUM(CASE WHEN DB_CR = 'C' THEN AMOUNT ELSE 0 END) AS cr
           FROM tran_acc
          WHERE ACC_CODE = ?
            AND DATTE > DATE_SUB(?, INTERVAL 12 MONTH) AND DATTE <= ?${exSql}
          GROUP BY ym`,
        [acc, asOn, asOn, ...exPrm]
      );
      const byYm = Object.fromEntries(mrows.map((r) => [r.ym, r]));
      const months = [];
      const base = new Date(asOn + "T00:00:00");
      for (let i = 11; i >= 0; i--) {
        const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
        const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        months.push({ ym, dr: Number(byYm[ym]?.dr) || 0, cr: Number(byYm[ym]?.cr) || 0 });
      }

      // 4. Last receipt before this RV
      const [lr] = await db.query(
        `SELECT DATE_FORMAT(DATTE, '%d/%m/%Y') AS dt, AMOUNT, TRAN_TYPE, VCHR_NO
           FROM tran_acc
          WHERE ACC_CODE = ? AND DB_CR = 'C' AND TRAN_TYPE IN (?) AND DATTE <= ?${exSql}
          ORDER BY DATTE DESC, srno_row_id DESC
          LIMIT 1`,
        [acc, RV_TRAN_TYPES, asOn, ...exPrm]
      );
      const lastReceipt = lr.length
        ? { date: lr[0].dt, amount: Number(lr[0].AMOUNT) || 0, tranType: lr[0].TRAN_TYPE, vchrNo: lr[0].VCHR_NO }
        : null;

      // 5. PDCs in hand (optional block)
      let pdc = null;
      try {
        const [[p]] = await db.query(PDC_SQL, [acc, asOn]);
        pdc = { count: Number(p.cnt) || 0, total: Number(p.total) || 0, nextDate: p.next_dt || null };
      } catch (e) {
        console.warn("party-snapshot PDC query:", e.message);
      }

      // 6. Credit limit (optional block)
      let creditLimit = null;
      try {
        const [cl] = await db.query(CREDIT_LIMIT_SQL, [acc]);
        if (cl.length && cl[0].lim != null) creditLimit = Number(cl[0].lim) || null;
      } catch (e) {
        /* column not present - ignore */
      }

      res.json({ balance, ageing, months, lastReceipt, pdc, creditLimit });
    } catch (err) {
      console.error("party-snapshot:", err);
      res.status(500).json({ error: "Failed to load party snapshot", detail: err.sqlMessage || err.message });
    }
  });

  return router;
};
