// routes/cusRcptAnalysis.js
// Customer Receipt Analysis (MIS) — data for SupPayAnalysis.tsx with party="cus"
// (route /CusRcptAnalysis). Mirror of supPayAnalysis.js with the ledger sides flipped.
//
// Register in HayatDb.js next to the supplier route:
//   app.use("/api", authMiddleware, require("./routes/cusRcptAnalysis")(connection));
//
// Endpoints (all GET, dates as YYYY-MM-DD):
//   /api/cus-rcpt-analysis/customers?q=abc               -> customer list for the picker
//                                                          (q empty = full list, for the drop-down)
//   /api/cus-rcpt-analysis/top?from=...&to=...           -> top 10 customers by amount received
//   /api/cus-rcpt-analysis/:custCode?from=...&to=...     -> full analysis for one customer
//
// Data rules
//   Sales        = Dr lines of the customer in tran_acc (invoices, Dr notes, opening JVs ...)
//   Receipts     = Cr lines whose TRAN_TYPE is in RCP_TYPES (receipt vouchers)
//   Days to collect = adj_dtl.SOURCE_DATE (receipt date) minus the settled document's
//                 tran_acc.DATTE (falls back to adj_dtl.STLD_DATE), weighted by STLD_AMT
//   Opening / outstanding = Dr - Cr (customer side)
//
// The JSON uses the same field names as the supplier route (supplier, purchases, paid,
// payments ...) so one screen serves both; here they mean customer, sales, received, receipts.
//
// NOTE: table names are lowercase for the Linux VPS.

const express = require("express");

// Receipt voucher TRAN_TYPEs. "03" = bank receipt voucher (RvEntBank).
// Add your cash receipt code here if receipts are also posted under another type.
const RCP_TYPES = ["03"];

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

  // ---------------------------------------------------------------- customer list / search
  router.get("/cus-rcpt-analysis/customers", async (req, res) => {
    try {
      const qs = (req.query.q || "").trim();
      const [rows] = qs
        ? await db.query(
            `SELECT cust_code AS code, COALESCE(cust_name, '') AS name
               FROM cus_mst
              WHERE cust_code LIKE ? OR cust_name LIKE ?
              ORDER BY cust_name
              LIMIT 300`,
            [`%${qs}%`, `%${qs}%`]
          )
        : await db.query(
            `SELECT cust_code AS code, COALESCE(cust_name, '') AS name
               FROM cus_mst
              ORDER BY cust_name`
          );
      res.json(rows);
    } catch (err) {
      console.error("cus-rcpt-analysis/customers:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------- top 10 customers
  // (declared before /:custCode so "top" is not taken as a customer code)
  router.get("/cus-rcpt-analysis/top", async (req, res) => {
    const { from, to } = req.query;
    if (!isIsoDate(from) || !isIsoDate(to)) {
      return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
    }
    try {
      const [top] = await db.query(
        `SELECT t.ACC_CODE AS code, COALESCE(c.cust_name, '') AS name,
                SUM(t.AMOUNT) AS paid,
                COUNT(DISTINCT CONCAT(t.TRAN_TYPE, '|', t.vchr_no)) AS cnt
           FROM tran_acc t
           JOIN cus_mst c ON c.cust_code = t.ACC_CODE
          WHERE t.DB_CR = 'C'
            AND t.TRAN_TYPE IN (?)
            AND t.DATTE BETWEEN ? AND ?
          GROUP BY t.ACC_CODE, c.cust_name
          ORDER BY paid DESC
          LIMIT 10`,
        [RCP_TYPES, from, to]
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
        [codes, codes, RCP_TYPES, from, to]
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
      console.error("cus-rcpt-analysis/top:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------- one customer
  router.get("/cus-rcpt-analysis/:custCode", async (req, res) => {
    const cus = req.params.custCode;
    const { from, to } = req.query;
    if (!isIsoDate(from) || !isIsoDate(to)) {
      return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
    }
    try {
      const [[cusRow]] = await db.query(
        `SELECT cust_code AS code, COALESCE(cust_name, '') AS name FROM cus_mst WHERE cust_code = ?`,
        [cus]
      );
      if (!cusRow) return res.status(404).json({ error: `Customer ${cus} not found` });

      // Opening balance (customer side: Dr - Cr)
      const [[ob]] = await db.query(
        `SELECT COALESCE(SUM(CASE WHEN DB_CR = 'D' THEN AMOUNT ELSE -AMOUNT END), 0) AS bal
           FROM tran_acc
          WHERE ACC_CODE = ? AND DATTE < ?`,
        [cus, from]
      );

      // Period totals
      const [[tot]] = await db.query(
        `SELECT COALESCE(SUM(CASE WHEN DB_CR = 'D' THEN AMOUNT END), 0) AS sales,
                COALESCE(SUM(CASE WHEN DB_CR = 'C' THEN AMOUNT END), 0) AS crAll,
                COALESCE(SUM(CASE WHEN DB_CR = 'C' AND TRAN_TYPE IN (?) THEN AMOUNT END), 0) AS received,
                COUNT(DISTINCT CASE WHEN DB_CR = 'D' THEN CONCAT(TRAN_TYPE, '|', vchr_no) END) AS invCount,
                COUNT(DISTINCT CASE WHEN DB_CR = 'C' AND TRAN_TYPE IN (?) THEN CONCAT(TRAN_TYPE, '|', vchr_no) END) AS rcpCount
           FROM tran_acc
          WHERE ACC_CODE = ? AND DATTE BETWEEN ? AND ?`,
        [RCP_TYPES, RCP_TYPES, cus, from, to]
      );

      // Month-wise
      const [mrows] = await db.query(
        `SELECT DATE_FORMAT(DATTE, '%Y-%m') AS ym,
                COALESCE(SUM(CASE WHEN DB_CR = 'D' THEN AMOUNT END), 0) AS sales,
                COALESCE(SUM(CASE WHEN DB_CR = 'C' AND TRAN_TYPE IN (?) THEN AMOUNT END), 0) AS received,
                COUNT(DISTINCT CASE WHEN DB_CR = 'C' AND TRAN_TYPE IN (?) THEN CONCAT(TRAN_TYPE, '|', vchr_no) END) AS cnt
           FROM tran_acc
          WHERE ACC_CODE = ? AND DATTE BETWEEN ? AND ?
          GROUP BY ym`,
        [RCP_TYPES, RCP_TYPES, cus, from, to]
      );
      const mMap = {};
      mrows.forEach((r) => { mMap[r.ym] = r; });
      const months = monthRange(from, to).map((ym) => ({
        ym,
        pur: num(mMap[ym]?.sales),      // field names shared with the supplier route
        paid: num(mMap[ym]?.received),
        cnt: num(mMap[ym]?.cnt),
      }));

      // Settlements of the period's receipts -> days to collect
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
        [cus, cus, RCP_TYPES, from, to]
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

      // Receipt vouchers of the period
      const [rrow] = await db.query(
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
            AND t.DB_CR = 'C'
            AND t.TRAN_TYPE IN (?)
            AND t.DATTE BETWEEN ? AND ?
          GROUP BY t.TRAN_TYPE, t.vchr_no
          ORDER BY MIN(t.DATTE) DESC, t.vchr_no DESC`,
        [cus, RCP_TYPES, from, to]
      );
      const payments = rrow.map((p) => {
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
        supplier: cusRow,                // = the customer (shared field name)
        from,
        to,
        opening,
        closing: opening + num(tot.sales) - num(tot.crAll),
        totals: {
          purchases: num(tot.sales),     // = sales invoiced
          paid: num(tot.received),       // = amount received
          invCount: num(tot.invCount),
          payCount: num(tot.rcpCount),   // = no. of receipts
        },
        avgDays: totAmt ? Math.round(totW / totAmt) : null,
        months,
        payments,                        // = receipts
      });
    } catch (err) {
      console.error("cus-rcpt-analysis:", err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
