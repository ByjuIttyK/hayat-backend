// routes/pjvListApi.js
// PJV drop-down list for Purchase Return (components/utils/PjvSelect.tsx).
// Register in HayatDb.js:
//   const pjvListApi = require("./routes/pjvListApi");
//   app.use("/api", pjvListApi(connection));
//
// GET /api/pjv-list?supCode=1T0020&search=123
//   supCode  optional — only that supplier's PJVs; blank = all suppliers
//   search   optional — matches PJV_NO or INV_NO (contains)
// Newest first (PJV_NO descending). Dates come back as dd/mm/yyyy strings, so
// the browser never shifts them by time zone.

const express = require("express");

const LIST_LIMIT = 300;

module.exports = function (connection) {
  const router = express.Router();

  router.get("/pjv-list", (req, res) => {
    const supCode = String(req.query.supCode || "").trim();
    const search = String(req.query.search || "").trim();

    const where = [];
    const params = [];
    if (supCode) {
      where.push("h.SUP_CODE = ?");
      params.push(supCode);
    }
    if (search) {
      where.push("(h.PJV_NO LIKE ? OR h.INV_NO LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }
    params.push(LIST_LIMIT);

    const sql = `
      SELECT h.PJV_NO,
             DATE_FORMAT(h.PJV_DATE, '%d/%m/%Y') AS PJV_DATE,
             h.INV_NO,
             DATE_FORMAT(h.INV_DATE, '%d/%m/%Y') AS INV_DATE,
             h.SUP_CODE,
             s.SUP_NAME,
             h.INV_AMOUNT
        FROM purchase_hdr h
        LEFT JOIN sup_mst s ON s.SUP_CODE = h.SUP_CODE
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY h.PJV_NO DESC
       LIMIT ?`;

    connection.query(sql, params, (err, rows) => {
      if (err) {
        console.error("pjv-list failed:", err);
        return res.status(500).json({ message: err.sqlMessage || "PJV list failed" });
      }
      res.json(rows);
    });
  });

  // GET /api/pjv-fill/:pjvNo — Purchase Return "Fill Data".
  // { hdr: {...} | null, items: [...] } — header from purchase_hdr (+ supplier
  // name), lines from purchase_items in SR_NO order. SR_NO is varchar(4), so
  // it is sorted numerically ('10' after '9'). The item name comes from
  // item_mst, preferring the line's own location.
  router.get("/pjv-fill/:pjvNo", (req, res) => {
    const pjvNo = String(req.params.pjvNo || "").trim();
    if (!pjvNo) return res.status(400).json({ message: "PJV No is required" });

    const hdrSql = `
      SELECT h.PJV_NO,
             DATE_FORMAT(h.PJV_DATE, '%d/%m/%Y') AS PJV_DATE,
             h.INV_NO,
             DATE_FORMAT(h.INV_DATE, '%d/%m/%Y') AS INV_DATE,
             h.SUP_CODE,
             s.SUP_NAME,
             h.INV_AMOUNT, h.DISCOUNT, h.VAT_PERC
        FROM purchase_hdr h
        LEFT JOIN sup_mst s ON s.SUP_CODE = h.SUP_CODE
       WHERE h.PJV_NO = ?`;

    const itemsSql = `
      SELECT pi.SR_NO, pi.LOC_CODE, pi.ITEM_CODE,
             (SELECT m.ITEM_NAME1
                FROM item_mst m
               WHERE m.ITEM_CODE = pi.ITEM_CODE
               ORDER BY (m.LOC_CODE = pi.LOC_CODE) DESC
               LIMIT 1) AS ITEM_NAME,
             pi.QTY, pi.COST, pi.ITEM_UNIT
        FROM purchase_items pi
       WHERE pi.PJV_NO = ?
       ORDER BY CAST(pi.SR_NO AS UNSIGNED), pi.SR_NO`;

    connection.query(hdrSql, [pjvNo], (err, hdrRows) => {
      if (err) {
        console.error("pjv-fill header failed:", err);
        return res.status(500).json({ message: err.sqlMessage || "PJV header could not be read" });
      }
      if (!hdrRows.length) return res.json({ hdr: null, items: [] });

      connection.query(itemsSql, [pjvNo], (err2, itemRows) => {
        if (err2) {
          console.error("pjv-fill items failed:", err2);
          return res.status(500).json({ message: err2.sqlMessage || "PJV items could not be read" });
        }
        res.json({ hdr: hdrRows[0], items: itemRows });
      });
    });
  });

  return router;
};
