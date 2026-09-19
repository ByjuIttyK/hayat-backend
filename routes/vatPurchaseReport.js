// routes/vatPurchaseReport.js
// UAE VAT - Input Tax (Purchase) Report
// Union of stock purchases (purchase_hdr / purchase_items)
// and non-stock purchases (purchase_hdr_ns / purchase_items_ns)
//
// GET /api/vat-purchase-report?fromDate=2026-01-01&toDate=2026-03-31[&order=pjv|date]

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

  const buildSql = (orderBy) => `
SELECT
  b.SRC,
  b.PJV_NO,
  b.PJV_DATE,
  b.SUP_CODE,
  b.SUP_NAME,
  b.INV_NO,
  b.INV_DATE,
  b.GROSS_AMT,
  b.DISCOUNT,
  b.VAT_PERC,
  b.VAT_AMOUNT,
  b.RND_OFF,
  ROUND(b.GROSS_AMT - b.DISCOUNT + b.VAT_AMOUNT + b.RND_OFF, 2) AS NET_AMT,
  b.HDR_NET_AMT
FROM (

  /* ---------- 1. Stock purchases : purchase_hdr + purchase_items ---------- */
  SELECT
    'LOCAL'                                        AS SRC,
    h.PJV_NO,
    h.PJV_DATE,
    h.SUP_CODE,
    s.SUP_NAME,
    h.INV_NO,
    h.INV_DATE,
    ROUND(COALESCE(i.GROSS_AMT, 0), 2)             AS GROSS_AMT,
    ROUND(COALESCE(h.DISCOUNT, 0), 2)              AS DISCOUNT,
    COALESCE(h.VAT_PERC, 0)                        AS VAT_PERC,
    ROUND(
      COALESCE(
        NULLIF(h.VAT_AMOUNT, 0),
        (COALESCE(i.GROSS_AMT, 0) - COALESCE(h.DISCOUNT, 0))
          * COALESCE(h.VAT_PERC, 0) / 100
      ), 2)                                        AS VAT_AMOUNT,
    ROUND(COALESCE(h.RND_OFF, 0), 2)               AS RND_OFF,
    ROUND(COALESCE(h.INV_AMOUNT, 0), 2)            AS HDR_NET_AMT
  FROM purchase_hdr h
  LEFT JOIN (
        SELECT PJV_NO,
               SUM(COALESCE(QTY, 0) * COALESCE(COST, 0)) AS GROSS_AMT
        FROM purchase_items
        GROUP BY PJV_NO
  ) i ON i.PJV_NO = h.PJV_NO
  LEFT JOIN sup_mst s ON TRIM(s.SUP_CODE) = TRIM(h.SUP_CODE)
  WHERE h.PJV_DATE BETWEEN ? AND ?
    AND COALESCE(h.CAN_CEL, 'N') <> 'Y'

  UNION ALL

  /* ------ 2. Non-stock purchases : purchase_hdr_ns + purchase_items_ns ------ */
  SELECT
    'NON-STOCK'                                    AS SRC,
    h.PJV_NO,
    h.PJV_DATE,
    h.SUP_CODE,
    s.SUP_NAME,
    h.INV_NO,
    h.INV_DATE,
    ROUND(COALESCE(n.GROSS_AMT, 0), 2)             AS GROSS_AMT,
    ROUND(COALESCE(n.DISCOUNT, 0), 2)              AS DISCOUNT,
    CASE
      WHEN n.RATE_CNT = 1 THEN n.MAX_RATE
      WHEN COALESCE(n.GROSS_AMT, 0) - COALESCE(n.DISCOUNT, 0) <> 0
        THEN ROUND(n.VAT_AMOUNT / (n.GROSS_AMT - n.DISCOUNT) * 100, 2)
      ELSE COALESCE(h.VAT_PERC, 0)
    END                                            AS VAT_PERC,
    ROUND(COALESCE(n.VAT_AMOUNT, 0), 2)            AS VAT_AMOUNT,
    ROUND(COALESCE(h.RND_OFF, 0), 2)               AS RND_OFF,
    ROUND(COALESCE(h.INV_NET_AMT, 0), 2)           AS HDR_NET_AMT
  FROM purchase_hdr_ns h
  LEFT JOIN (
        SELECT PJV_NO,
               SUM(COALESCE(QTY, 0) * COALESCE(UNIT_COST, 0))      AS GROSS_AMT,
               SUM(COALESCE(DISCOUNT, 0))                          AS DISCOUNT,
               SUM(
                 (COALESCE(QTY, 0) * COALESCE(UNIT_COST, 0) - COALESCE(DISCOUNT, 0))
                   * COALESCE(VAT_PERC, 0) / 100
               )                                                   AS VAT_AMOUNT,
               COUNT(DISTINCT COALESCE(VAT_PERC, 0))               AS RATE_CNT,
               MAX(COALESCE(VAT_PERC, 0))                          AS MAX_RATE
        FROM purchase_items_ns
        GROUP BY PJV_NO
  ) n ON n.PJV_NO = h.PJV_NO
  LEFT JOIN sup_mst s ON TRIM(s.SUP_CODE) = TRIM(h.SUP_CODE)
  WHERE h.PJV_DATE BETWEEN ? AND ?
    AND COALESCE(h.CAN_CEL, 'N') <> 'Y'

) b
ORDER BY ${orderBy}`;

  router.get("/vat-purchase-report", (req, res) => {
    const { fromDate, toDate, order } = req.query;

    if (!isDate(fromDate) || !isDate(toDate)) {
      return res
        .status(400)
        .json({ error: "fromDate and toDate are required as YYYY-MM-DD" });
    }
    if (fromDate > toDate) {
      return res.status(400).json({ error: "fromDate cannot be after toDate" });
    }

    // whitelist only - never interpolate user text into ORDER BY
    const orderBy =
      order === "date" ? "b.PJV_DATE, b.PJV_NO" : "b.PJV_NO, b.PJV_DATE";

    connection.getConnection((err, conn) => {
      if (err) {
        console.error("vat-purchase-report: pool error", err);
        return res.status(500).json({ error: "Database connection failed" });
      }

      conn.query(
        buildSql(orderBy),
        [fromDate, toDate, fromDate, toDate],
        (qErr, rows) => {
          conn.release();

          if (qErr) {
            console.error("vat-purchase-report: query error", qErr);
            return res.status(500).json({ error: "Failed to build VAT report" });
          }

          const num = (v) => Number(v || 0);
          const r2 = (v) => Math.round(v * 100) / 100;

          const data = rows.map((row) => {
            const netAmt = num(row.NET_AMT);
            const hdrNet = num(row.HDR_NET_AMT);
            return {
              ...row,
              GROSS_AMT: num(row.GROSS_AMT),
              DISCOUNT: num(row.DISCOUNT),
              VAT_PERC: num(row.VAT_PERC),
              VAT_AMOUNT: num(row.VAT_AMOUNT),
              RND_OFF: num(row.RND_OFF),
              NET_AMT: netAmt,
              HDR_NET_AMT: hdrNet,
              // audit flag: computed net vs. net stored on the header
              MISMATCH: hdrNet !== 0 && Math.abs(netAmt - hdrNet) > 0.02,
            };
          });

          const totals = data.reduce(
            (t, r) => {
              t.GROSS_AMT += r.GROSS_AMT;
              t.DISCOUNT += r.DISCOUNT;
              t.VAT_AMOUNT += r.VAT_AMOUNT;
              t.RND_OFF += r.RND_OFF;
              t.NET_AMT += r.NET_AMT;
              return t;
            },
            { GROSS_AMT: 0, DISCOUNT: 0, VAT_AMOUNT: 0, RND_OFF: 0, NET_AMT: 0 }
          );
          Object.keys(totals).forEach((k) => (totals[k] = r2(totals[k])));

          // VAT return support: taxable value and input tax per rate
          const byRateMap = {};
          data.forEach((r) => {
            const key = r.VAT_PERC.toFixed(2);
            if (!byRateMap[key]) {
              byRateMap[key] = { VAT_PERC: r.VAT_PERC, TAXABLE: 0, VAT_AMOUNT: 0 };
            }
            byRateMap[key].TAXABLE += r.GROSS_AMT - r.DISCOUNT;
            byRateMap[key].VAT_AMOUNT += r.VAT_AMOUNT;
          });
          const byRate = Object.values(byRateMap)
            .map((x) => ({
              VAT_PERC: x.VAT_PERC,
              TAXABLE: r2(x.TAXABLE),
              VAT_AMOUNT: r2(x.VAT_AMOUNT),
            }))
            .sort((a, b) => a.VAT_PERC - b.VAT_PERC);

          res.json({
            fromDate,
            toDate,
            rowCount: data.length,
            rows: data,
            summary: {
              totals,
              byRate,
              mismatchCount: data.filter((r) => r.MISMATCH).length,
            },
          });
        }
      );
    });
  });

  return router;
};
