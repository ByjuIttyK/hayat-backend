// routes/pinvChecksRoutes.js
// Checks for Purchase Entry (Local) — PinvLocal.tsx
//
//   GET  /api/pinv-chk/dup-inv?sup=&inv=&pjv=     same supplier + same invoice no already booked?
//   POST /api/pinv-chk/price-info                 last rate per item + LPO rate per item
//   GET  /api/pinv-chk/price-history/:item        last 10 purchases of an item (any supplier)
//   GET  /api/pinv-chk/sup-terms/:sup             supplier credit days (sup_mst)
//   GET  /api/pinv-chk/due-date/:pjv              saved due date of a voucher
//   PUT  /api/pinv-chk/due-date                   save due date { pjvNo, dueDate: 'yyyy-mm-dd' | null }
//
// Register in HayatDb.js:
//   app.use("/api", require("./routes/pinvChecksRoutes")(connection));
//
// Column names that vary between tables (lpo_items rate/qty, sup_mst credit
// days, ngp_net doc no ...) are looked up once from information_schema, so a
// missing column skips that part instead of failing the request.
//
// Due date needs:  ALTER TABLE purchase_hdr ADD COLUMN DUE_DATE DATE NULL;

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise ? connection.promise() : connection;
  const q = async (sql, params = []) => (await db.query(sql, params))[0];

  // ── column lookup (cached per table) ──────────────────────────────────────
  // Kept for 2 minutes, so a column added with ALTER TABLE (e.g. DUE_DATE)
  // is picked up without restarting the backend.
  const COL_TTL_MS = 2 * 60 * 1000;
  const colCache = new Map();
  const tableCols = async (table) => {
    const key = table.toLowerCase();
    const hit = colCache.get(key);
    if (hit && Date.now() - hit.at < COL_TTL_MS) return hit.map;
    const rows = await q(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = ?`, [key]);
    const map = new Map(rows.map((r) => [String(r.COLUMN_NAME).toUpperCase(), r.COLUMN_NAME]));
    colCache.set(key, { map, at: Date.now() });
    return map;
  };
  // first candidate column that exists in the table, else null
  const pick = async (table, candidates) => {
    const cols = await tableCols(table);
    for (const c of candidates) if (cols.has(c.toUpperCase())) return cols.get(c.toUpperCase());
    return null;
  };

  const normInv = (v) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const s = (v) => String(v ?? "").trim();

  // ── 1. Duplicate supplier invoice ────────────────────────────────────────
  // Searched across every purchase type; invoice numbers are compared with
  // spaces, dashes, slashes etc. removed ("DISD 23-565-01707" = "DISD2356501707").
  const DUP_SOURCES = [
    { table: "purchase_hdr",    label: "Purchase (Local)",     doc: ["PJV_NO"],   date: ["PJV_DATE"] },
    { table: "purchase_hdr_ns", label: "Purchase (Non-Stock)", doc: ["PJV_NO"],   date: ["PJV_DATE"] },
    { table: "ngp_net",         label: "Non-Goods Purchase",   doc: ["PURCH_NO", "PJV_NO"], date: ["PURCH_DATE", "PJV_DATE"] },
    { table: "pur_frgn_hdr",    label: "Purchase (Foreign)",   doc: ["PJV_NO"],   date: ["PJV_DATE"] },
  ];

  router.get("/pinv-chk/dup-inv", async (req, res) => {
    const sup = s(req.query.sup);
    const inv = normInv(req.query.inv);
    const pjv = s(req.query.pjv);
    if (!sup || !inv) return res.json([]);
    try {
      const hits = [];
      for (const src of DUP_SOURCES) {
        const cols = await tableCols(src.table);
        if (!cols.size) continue;                      // table not in this database
        const doc = await pick(src.table, src.doc);
        const dt = await pick(src.table, src.date);
        const supC = await pick(src.table, ["SUP_CODE"]);
        const invC = await pick(src.table, ["INV_NO"]);
        if (!doc || !supC || !invC) continue;
        const rows = await q(
          `SELECT ${doc} AS DOC_NO, ${dt ? `DATE_FORMAT(${dt}, '%d/%m/%Y')` : "NULL"} AS DOC_DATE,
                  ${invC} AS INV_NO
             FROM ${src.table}
            WHERE TRIM(${supC}) = ?
              AND UPPER(REGEXP_REPLACE(${invC}, '[^A-Za-z0-9]', '')) = ?
              AND TRIM(${doc}) <> ?
            LIMIT 5`,
          [sup, inv, pjv]);
        rows.forEach((r) => hits.push({ ...r, SOURCE: src.label }));
      }
      res.json(hits);
    } catch (err) {
      console.error("[pinv-chk/dup-inv]", err);
      res.status(500).json({ error: err.sqlMessage || err.message });
    }
  });

  // ── 2. Last rate + LPO rate per item ─────────────────────────────────────
  // body: { pjvNo, pjvDate: 'yyyy-mm-dd'|null, supCode, lpoNo, items: [codes] }
  // returns { [ITEM_CODE]: { LAST_RATE, LAST_DATE, LAST_PJV, LAST_SUP, LAST_OTHER,
  //                          LPO_RATE, LPO_QTY } }
  router.post("/pinv-chk/price-info", async (req, res) => {
    const { pjvNo, pjvDate, supCode, lpoNo } = req.body || {};
    const items = Array.from(new Set((req.body?.items || []).map(s).filter(Boolean))).slice(0, 300);
    const out = {};
    if (!items.length) return res.json(out);
    items.forEach((c) => { out[c] = {}; });

    try {
      // Last purchase of each item before this voucher. Same supplier first;
      // an item never bought from this supplier falls back to any supplier
      // (LAST_OTHER = true, so the screen can say so).
      const lastSql = (bySup) => `
        SELECT ITEM_CODE, COST, PJV_NO, SUP_CODE, DATE_FORMAT(PJV_DATE, '%d/%m/%Y') AS PJV_DATE
          FROM (SELECT i.ITEM_CODE, i.COST, h.PJV_NO, h.SUP_CODE, h.PJV_DATE,
                       ROW_NUMBER() OVER (PARTITION BY i.ITEM_CODE
                                          ORDER BY h.PJV_DATE DESC, h.PJV_NO DESC) AS rn
                  FROM purchase_items i
                  JOIN purchase_hdr h ON h.PJV_NO = i.PJV_NO
                 WHERE i.ITEM_CODE IN (?)
                   AND i.COST > 0
                   AND h.PJV_NO <> ?
                   ${pjvDate ? "AND h.PJV_DATE <= ?" : ""}
                   ${bySup ? "AND TRIM(h.SUP_CODE) = ?" : ""}) x
         WHERE rn = 1`;
      const params = (bySup) => {
        const p = [items, s(pjvNo)];
        if (pjvDate) p.push(pjvDate);
        if (bySup) p.push(s(supCode));
        return p;
      };

      if (s(supCode)) {
        for (const r of await q(lastSql(true), params(true))) {
          out[r.ITEM_CODE] = { ...out[r.ITEM_CODE],
            LAST_RATE: Number(r.COST), LAST_DATE: r.PJV_DATE, LAST_PJV: r.PJV_NO,
            LAST_SUP: s(r.SUP_CODE), LAST_OTHER: false };
        }
      }
      const missing = items.filter((c) => out[c].LAST_RATE == null);
      if (missing.length) {
        const p = params(false); p[0] = missing;
        for (const r of await q(lastSql(false), p)) {
          out[r.ITEM_CODE] = { ...out[r.ITEM_CODE],
            LAST_RATE: Number(r.COST), LAST_DATE: r.PJV_DATE, LAST_PJV: r.PJV_NO,
            LAST_SUP: s(r.SUP_CODE), LAST_OTHER: true };
        }
      }

      // LPO rate: lines of the header's LPO (srv/purchase lines carry no PO no).
      // LPO numbers may be stored padded ('0000002391', '  2391'), so leading
      // spaces/zeros are ignored; if that matches more than one LPO, the one
      // for this supplier, then the latest, is used.
      const lpo = s(lpoNo).replace(/^0+/, "");
      if (lpo) {
        const rateC = await pick("lpo_items", ["RATE", "UNIT_RATE", "UNIT_PRICE", "PRICE", "COST", "LPO_RATE"]);
        const qtyC = await pick("lpo_items", ["QTY", "LPO_QTY", "ORD_QTY", "ORDER_QTY"]);
        if (rateC) {
          const lpos = await q(
            `SELECT LPO_NO FROM lpo_net
              WHERE TRIM(LEADING '0' FROM TRIM(LPO_NO)) = ?
              ORDER BY (TRIM(SUP_CODE) = ?) DESC, LPO_DATE DESC
              LIMIT 1`, [lpo, s(supCode)]);
          if (lpos.length) {
            const rows = await q(
              `SELECT ITEM_CODE, MAX(${rateC}) AS LPO_RATE, ${qtyC ? `SUM(${qtyC})` : "NULL"} AS LPO_QTY
                 FROM lpo_items
                WHERE LPO_NO = ? AND ITEM_CODE IN (?)
                GROUP BY ITEM_CODE`, [lpos[0].LPO_NO, items]);
            for (const r of rows) {
              const c = s(r.ITEM_CODE);
              if (!out[c]) continue;
              out[c].LPO_RATE = Number(r.LPO_RATE);
              out[c].LPO_QTY = r.LPO_QTY == null ? null : Number(r.LPO_QTY);
            }
          }
        } else {
          console.warn("[pinv-chk/price-info] no rate column found in lpo_items");
        }
      }
      res.json(out);
    } catch (err) {
      console.error("[pinv-chk/price-info]", err);
      res.status(500).json({ error: err.sqlMessage || err.message });
    }
  });

  // ── 3. Price history of one item (click on Last Rate) ────────────────────
  router.get("/pinv-chk/price-history/:item", async (req, res) => {
    try {
      const rows = await q(
        `SELECT h.PJV_NO, DATE_FORMAT(h.PJV_DATE, '%d/%m/%Y') AS PJV_DATE,
                TRIM(h.SUP_CODE) AS SUP_CODE, sm.SUP_NAME, i.QTY, i.COST
           FROM purchase_items i
           JOIN purchase_hdr h ON h.PJV_NO = i.PJV_NO
      LEFT JOIN sup_mst sm ON sm.SUP_CODE = h.SUP_CODE
          WHERE i.ITEM_CODE = ? AND i.COST > 0
          ORDER BY h.PJV_DATE DESC, h.PJV_NO DESC
          LIMIT 10`, [s(req.params.item)]);
      res.json(rows);
    } catch (err) {
      console.error("[pinv-chk/price-history]", err);
      res.status(500).json({ error: err.sqlMessage || err.message });
    }
  });

  // ── 4. Supplier credit days ──────────────────────────────────────────────
  router.get("/pinv-chk/sup-terms/:sup", async (req, res) => {
    try {
      const col = await pick("sup_mst", ["CREDIT_DAYS", "CR_DAYS", "CRDAYS", "CREDIT_PERIOD", "PAY_DAYS", "PAYMENT_DAYS"]);
      if (!col) return res.json({ creditDays: null, column: null });
      const rows = await q(`SELECT ${col} AS D FROM sup_mst WHERE SUP_CODE = ? LIMIT 1`, [s(req.params.sup)]);
      const d = rows.length && rows[0].D != null && rows[0].D !== "" ? Number(rows[0].D) : null;
      res.json({ creditDays: Number.isFinite(d) ? d : null, column: col });
    } catch (err) {
      console.error("[pinv-chk/sup-terms]", err);
      res.status(500).json({ error: err.sqlMessage || err.message });
    }
  });

  // ── 5. Due date (purchase_hdr.DUE_DATE) ──────────────────────────────────
  const dueMissing = "purchase_hdr.DUE_DATE column is missing — run: ALTER TABLE purchase_hdr ADD COLUMN DUE_DATE DATE NULL";

  router.get("/pinv-chk/due-date/:pjv", async (req, res) => {
    try {
      if (!(await pick("purchase_hdr", ["DUE_DATE"]))) return res.json({ dueDate: null, missing: true });
      const rows = await q(
        `SELECT DATE_FORMAT(DUE_DATE, '%d/%m/%Y') AS D FROM purchase_hdr WHERE PJV_NO = ? LIMIT 1`,
        [s(req.params.pjv)]);
      res.json({ dueDate: rows[0]?.D || null });
    } catch (err) {
      console.error("[pinv-chk/due-date GET]", err);
      res.status(500).json({ error: err.sqlMessage || err.message });
    }
  });

  router.put("/pinv-chk/due-date", async (req, res) => {
    const pjvNo = s(req.body?.pjvNo);
    const due = req.body?.dueDate || null;
    if (!pjvNo) return res.status(400).json({ error: "pjvNo required" });
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return res.status(400).json({ error: "dueDate must be yyyy-mm-dd" });
    try {
      if (!(await pick("purchase_hdr", ["DUE_DATE"]))) return res.status(409).json({ error: dueMissing });
      const r = await q(`UPDATE purchase_hdr SET DUE_DATE = ? WHERE PJV_NO = ?`, [due, pjvNo]);
      res.json({ ok: true, updated: r.affectedRows });
    } catch (err) {
      console.error("[pinv-chk/due-date PUT]", err);
      res.status(500).json({ error: err.sqlMessage || err.message });
    }
  });

  return router;
};
