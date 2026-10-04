// routes/supPayAnalysis.js
// Supplier Payment Analysis (MIS) — data for SupPayAnalysis.tsx
//
// Register in HayatDb.js the same way as the other report routes, e.g.
//   app.use("/api", authMiddleware, require("./routes/supPayAnalysis")(connection));
//
// Endpoints (all GET, dates as YYYY-MM-DD):
//   /api/sup-pay-analysis/suppliers?q=copper              -> supplier search for the picker
//   /api/sup-pay-analysis/top?from=...&to=...             -> top 10 suppliers by amount paid
//   /api/sup-pay-analysis/:supCode?from=...&to=...        -> full analysis for one supplier
//
// Data rules
//   Purchases  = Cr lines of the supplier in tran_acc (invoices, NGP, opening JVs ...)
//   Payments   = Dr lines whose TRAN_TYPE is in PAY_TYPES (payment vouchers)
//   Days to pay = adj_dtl.SOURCE_DATE (payment date) minus the settled document's
//                 tran_acc.DATTE (falls back to adj_dtl.STLD_DATE), weighted by STLD_AMT
//
// NOTE: table names are lowercase for the Linux VPS.

const express = require("express");

// Payment voucher TRAN_TYPEs (PV cash / PV bank). Adjust if your codes differ.
const PAY_TYPES = ["02", "04"];

const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const num = (v) => Number(v || 0);

// Every month from `from` to `to` as 'YYYY-MM', so months with no activity still show
function monthRange(from, to) {
  const out = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const ey = Number(to.slice(0, 4));
  const em = Number(to.slice(5, 7));
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise();

  // ---------------------------------------------------------------- supplier search
  router.get("/sup-pay-analysis/suppliers", async (req, res) => {
    try {
      const q = `%${(req.query.q || "").trim()}%`;
      const [rows] = await db.query(
        `SELECT sup_code AS code, sup_name AS name
           FROM sup_mst
          WHERE sup_code LIKE ? OR sup_name LIKE ?
          ORDER BY sup_name
          LIMIT 100`,
        [q, q]
      );
      res.json(rows);
    } catch (err) {
      console.error("sup-pay-analysis/suppliers:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------- top 10 suppliers
  // (declared before /:supCode so "top" is not taken as a supplier code)
  router.get("/sup-pay-analysis/top", async (req, res) => {
    const { from, to } = req.query;
    if (!isIsoDate(from) || !isIsoDate(to)) {
      return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
    }
    try {
      const [top] = await db.query(
        `SELECT t.ACC_CODE AS code, s.sup_name AS name,
                SUM(t.AMOUNT) AS paid,
                COUNT(DISTINCT CONCAT(t.TRAN_TYPE, '|', t.vchr_no)) AS cnt
           FROM tran_acc t
           JOIN sup_mst s ON s.sup_code = t.ACC_CODE
          WHERE t.DB_CR = 'D'
            AND t.TRAN_TYPE IN (?)
            AND t.DATTE BETWEEN ? AND ?
          GROUP BY t.ACC_CODE, s.sup_name
          ORDER BY paid DESC
          LIMIT 10`,
        [PAY_TYPES, from, to]
      );

      if (!top.length) return res.json([]);

      const codes = top.map((r) => r.code);
      const [days] = await db.query(
        `SELECT a.ACC_CODE AS code,
                SUM(a.STLD_AMT * DATEDIFF(a.SOURCE_DATE, COALESCE(inv.dt, a.STLD_DATE)))
                  / NULLIF(SUM(a.STLD_AMT), 0) AS avgDays
           FROM adj_dtl a
           LEFT JOIN (SELECT TRAN_TYPE, vchr_no, ACC_CODE, MIN(DATTE) AS dt
                        FROM tran_acc
                       WHERE ACC_CODE IN (?)
                       GROUP BY TRAN_TYPE, vchr_no, ACC_CODE) inv
                  ON inv.TRAN_TYPE = a.STLD_TYPE
                 AND inv.vchr_no   = a.STLD_DOC
                 AND inv.ACC_CODE  = a.ACC_CODE
          WHERE a.ACC_CODE IN (?)
            AND a.SOURCE_TYPE IN (?)
            AND a.SOURCE_DATE BETWEEN ? AND ?
          GROUP BY a.ACC_CODE`,
        [codes, codes, PAY_TYPES, from, to]
      );
      const dayMap = {};
      days.forEach((d) => { dayMap[d.code] = d.avgDays == null ? null : Math.round(num(d.avgDays)); });

      res.json(
        top.map((r) => ({
          code: r.code,
          name: r.name,
          paid: num(r.paid),
          cnt: num(r.cnt),
          avgDays: dayMap[r.code] ?? null,
        }))
      );
    } catch (err) {
      console.error("sup-pay-analysis/top:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------- one supplier
  router.get("/sup-pay-analysis/:supCode", async (req, res) => {
    const sup = req.params.supCode;
    const { from, to } = req.query;
    if (!isIsoDate(from) || !isIsoDate(to)) {
      return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
    }
    try {
      const [[supRow]] = await db.query(
        `SELECT sup_code AS code, sup_name AS name FROM sup_mst WHERE sup_code = ?`,
        [sup]
      );
      if (!supRow) return res.status(404).json({ error: `Supplier ${sup} not found` });

      // Opening balance (supplier side: Cr - Dr)
      const [[ob]] = await db.query(
        `SELECT COALESCE(SUM(CASE WHEN DB_CR = 'C' THEN AMOUNT ELSE -AMOUNT END), 0) AS bal
           FROM tran_acc
          WHERE ACC_CODE = ? AND DATTE < ?`,
        [sup, from]
      );

      // Period totals
      const [[tot]] = await db.query(
        `SELECT COALESCE(SUM(CASE WHEN DB_CR = 'C' THEN AMOUNT END), 0) AS purchases,
                COALESCE(SUM(CASE WHEN DB_CR = 'D' THEN AMOUNT END), 0) AS drAll,
                COALESCE(SUM(CASE WHEN DB_CR = 'D' AND TRAN_TYPE IN (?) THEN AMOUNT END), 0) AS paid,
                COUNT(DISTINCT CASE WHEN DB_CR = 'C' THEN CONCAT(TRAN_TYPE, '|', vchr_no) END) AS invCount,
                COUNT(DISTINCT CASE WHEN DB_CR = 'D' AND TRAN_TYPE IN (?) THEN CONCAT(TRAN_TYPE, '|', vchr_no) END) AS payCount
           FROM tran_acc
          WHERE ACC_CODE = ? AND DATTE BETWEEN ? AND ?`,
        [PAY_TYPES, PAY_TYPES, sup, from, to]
      );

      // Month-wise
      const [mrows] = await db.query(
        `SELECT DATE_FORMAT(DATTE, '%Y-%m') AS ym,
                COALESCE(SUM(CASE WHEN DB_CR = 'C' THEN AMOUNT END), 0) AS pur,
                COALESCE(SUM(CASE WHEN DB_CR = 'D' AND TRAN_TYPE IN (?) THEN AMOUNT END), 0) AS paid,
                COUNT(DISTINCT CASE WHEN DB_CR = 'D' AND TRAN_TYPE IN (?) THEN CONCAT(TRAN_TYPE, '|', vchr_no) END) AS cnt
           FROM tran_acc
          WHERE ACC_CODE = ? AND DATTE BETWEEN ? AND ?
          GROUP BY ym`,
        [PAY_TYPES, PAY_TYPES, sup, from, to]
      );
      const mMap = {};
      mrows.forEach((r) => { mMap[r.ym] = r; });
      const months = monthRange(from, to).map((ym) => ({
        ym,
        pur: num(mMap[ym]?.pur),
        paid: num(mMap[ym]?.paid),
        cnt: num(mMap[ym]?.cnt),
      }));

      // Settlements of the period's payments -> days to pay
      const [setl] = await db.query(
        `SELECT a.SOURCE_TYPE AS type, a.SOURCE_DOC AS doc, a.STLD_AMT AS amt,
                DATEDIFF(a.SOURCE_DATE, COALESCE(inv.dt, a.STLD_DATE)) AS days
           FROM adj_dtl a
           LEFT JOIN (SELECT TRAN_TYPE, vchr_no, MIN(DATTE) AS dt
                        FROM tran_acc
                       WHERE ACC_CODE = ?
                       GROUP BY TRAN_TYPE, vchr_no) inv
                  ON inv.TRAN_TYPE = a.STLD_TYPE
                 AND inv.vchr_no   = a.STLD_DOC
          WHERE a.ACC_CODE = ?
            AND a.SOURCE_TYPE IN (?)
            AND a.SOURCE_DATE BETWEEN ? AND ?`,
        [sup, sup, PAY_TYPES, from, to]
      );
      const perVchr = {}; // "TYPE|DOC" -> { amt, wsum }
      let totAmt = 0;
      let totW = 0;
      setl.forEach((s) => {
        if (s.days == null) return;
        const k = `${s.type}|${s.doc}`;
        const a = num(s.amt);
        if (!perVchr[k]) perVchr[k] = { amt: 0, wsum: 0 };
        perVchr[k].amt += a;
        perVchr[k].wsum += a * num(s.days);
        totAmt += a;
        totW += a * num(s.days);
      });

      // Payment vouchers of the period
      const [prow] = await db.query(
        `SELECT t.TRAN_TYPE AS type,
                MAX(tt.TYPE_ABBR) AS abbr,
                t.vchr_no AS vchrNo,
                DATE_FORMAT(MIN(t.DATTE), '%d/%m/%Y') AS dt,
                SUM(t.AMOUNT) AS amount,
                MAX(t.NARRATION1) AS narration,
                (SELECT MAX(c.CHQ_NO) FROM current_chq c
                  WHERE c.TRAN_TYPE = t.TRAN_TYPE AND c.VCHR_NO = t.vchr_no) AS chqNo
           FROM tran_acc t
           LEFT JOIN tran_type tt ON tt.TRAN_TYPE = t.TRAN_TYPE
          WHERE t.ACC_CODE = ?
            AND t.DB_CR = 'D'
            AND t.TRAN_TYPE IN (?)
            AND t.DATTE BETWEEN ? AND ?
          GROUP BY t.TRAN_TYPE, t.vchr_no
          ORDER BY MIN(t.DATTE) DESC, t.vchr_no DESC`,
        [sup, PAY_TYPES, from, to]
      );
      const payments = prow.map((p) => {
        const v = perVchr[`${p.type}|${p.vchrNo}`];
        return {
          type: p.type,
          abbr: p.abbr || p.type,
          vchrNo: p.vchrNo,
          date: p.dt,
          amount: num(p.amount),
          chqNo: p.chqNo || "",
          narration: p.narration || "",
          days: v && v.amt ? Math.round(v.wsum / v.amt) : null, // null = not settled against invoices
        };
      });

      const opening = num(ob.bal);
      res.json({
        supplier: supRow,
        from,
        to,
        opening,
        closing: opening + num(tot.purchases) - num(tot.drAll),
        totals: {
          purchases: num(tot.purchases),
          paid: num(tot.paid),
          invCount: num(tot.invCount),
          payCount: num(tot.payCount),
        },
        avgDays: totAmt ? Math.round(totW / totAmt) : null,
        months,
        payments,
      });
    } catch (err) {
      console.error("sup-pay-analysis:", err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
