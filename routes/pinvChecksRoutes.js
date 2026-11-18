// routes/pinvChecksRoutes.js
// Checks for Purchase Entry (Local) — PinvLocal.tsx
//
//   GET  /api/pinv-chk/dup-inv?sup=&inv=&pjv=     same supplier + same invoice no already booked?
//   POST /api/pinv-chk/price-info                 last rate per item + LPO rate per item
//   GET  /api/pinv-chk/price-history/:item        last 10 purchases of an item (any supplier)
//   GET  /api/pinv-chk/sup-terms/:sup             supplier credit days + TRN (sup_mst)
//   GET  /api/pinv-chk/lock/:pjv                  payments/settlements (adj_dtl) → locked?
//   GET  /api/pinv-chk/job/:job                   job exists? (job_card)
//   GET  /api/pinv-chk/jobs?q=                    job search (last 18 months) for the Job No dropdown
//   GET  /api/pinv-chk/item-jobs/:pjv             saved Job No per line
//   PUT  /api/pinv-chk/item-jobs                  save Job No per line
//   GET  /api/pinv-chk/hdr-extra/:pjv[?t=NS]      saved due date, supplier invoice amount, advance paid
//   PUT  /api/pinv-chk/hdr-extra                  save them { pjvNo, dueDate, supInvAmt, advPaid, t }
//                                                 (t 'NS' = purchase_hdr_ns, else purchase_hdr)
//   GET  /api/pinv-chk/sup-position/:sup          supplier balance, overdue, open PDCs, credit limit
//
// Register in HayatDb.js:
//   app.use("/api", require("./routes/pinvChecksRoutes")(connection));
//
// Column names that vary between tables (lpo_items rate/qty, sup_mst credit
// days, ngp_net doc no ...) are looked up once from information_schema, so a
// missing column skips that part instead of failing the request.
//
// Needs:  ALTER TABLE purchase_hdr ADD COLUMN DUE_DATE DATE NULL AFTER INV_DATE;
//         ALTER TABLE purchase_hdr ADD COLUMN SUP_INV_AMT DECIMAL(12,2) NULL AFTER INV_AMOUNT;
//         ALTER TABLE purchase_hdr ADD COLUMN ADV_PAID DECIMAL(12,2) NULL AFTER SUP_INV_AMT;
//         ALTER TABLE purchase_hdr_ns ADD COLUMN SUP_INV_AMT DECIMAL(12,2) NULL AFTER VAT_AMOUNT;
//         ALTER TABLE purchase_items ADD COLUMN JOB_NO VARCHAR(10) NULL;   (if not there)

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

  // ── 4. Supplier info: credit days + TRN ──────────────────────────────────
  // returns { creditDays, creditCol, trn, trnCol } — a column that isn't in
  // sup_mst comes back as null (trnCol null = TRN can't be checked).
  router.get("/pinv-chk/sup-terms/:sup", async (req, res) => {
    try {
      const daysCol = await pick("sup_mst", ["CR_PERIOD", "CREDIT_DAYS", "CR_DAYS", "CRDAYS", "CREDIT_PERIOD", "PAY_DAYS", "PAYMENT_DAYS"]);
      const trnCol = await pick("sup_mst", ["VAT_REG_NO", "TRN", "TRN_NO", "VAT_TRN", "VAT_NO", "TAX_REG_NO", "TRNNO"]);
      if (!daysCol && !trnCol) return res.json({ creditDays: null, creditCol: null, trn: null, trnCol: null });
      const rows = await q(
        `SELECT ${daysCol || "NULL"} AS D, ${trnCol || "NULL"} AS T FROM sup_mst WHERE SUP_CODE = ? LIMIT 1`,
        [s(req.params.sup)]);
      const r = rows[0] || {};
      const d = r.D != null && r.D !== "" ? Number(r.D) : null;
      res.json({
        creditDays: Number.isFinite(d) ? d : null, creditCol: daysCol,
        trn: r.T == null ? null : s(r.T), trnCol,
      });
    } catch (err) {
      console.error("[pinv-chk/sup-terms]", err);
      res.status(500).json({ error: err.sqlMessage || err.message });
    }
  });

  // ── 6. Lock: payments / settlements against this purchase ─────────────────
  // adj_dtl rows with STLD_TYPE '07' and STLD_DOC = PJV No (source_type 02 cash
  // payment, 04 cheque payment, ...). Any row = the invoice is (part) paid.
  router.get("/pinv-chk/lock/:pjv", async (req, res) => {
    const pjv = s(req.params.pjv);
    if (!pjv) return res.json({ locked: false, docs: [] });
    try {
      const amtC = await pick("adj_dtl", ["ADJ_AMT", "ADJ_AMOUNT", "STLD_AMT", "STLD_AMOUNT", "AMOUNT"]);
      const rows = await q(
        `SELECT TRIM(SOURCE_TYPE) AS SOURCE_TYPE, TRIM(SOURCE_DOC) AS SOURCE_DOC,
                ${amtC ? `SUM(${amtC})` : "NULL"} AS AMOUNT
           FROM adj_dtl
          WHERE TRIM(STLD_TYPE) = '07' AND TRIM(STLD_DOC) = ?
          GROUP BY TRIM(SOURCE_TYPE), TRIM(SOURCE_DOC)`, [pjv]);
      const docs = rows
        .filter((r) => amtC == null || Math.abs(Number(r.AMOUNT) || 0) >= 0.005)
        .map((r) => ({ type: r.SOURCE_TYPE, doc: r.SOURCE_DOC, amount: r.AMOUNT == null ? null : Number(r.AMOUNT) }));
      res.json({ locked: docs.length > 0, docs });
    } catch (err) {
      console.error("[pinv-chk/lock]", err);
      res.status(500).json({ error: err.sqlMessage || err.message });
    }
  });

  // ── 7. Job No per line ───────────────────────────────────────────────────
  // Jobs are in job_card. The project/description column is looked up from
  // the table (first of these that exists), so the name shows if it is there.
  const JOB_TABLE = "job_card";
  const jobNameCol = () => pick(JOB_TABLE,
    ["PROJ_NAME", "PROJECT_NAME", "PROJ_DESC", "JOB_DESC", "JOB_NAME", "DESCRIPTION", "PROJECT", "REMARKS"]);
  // GET /pinv-chk/job/:job          → { JOB_NO, PROJ_NAME } or 404
  // GET /pinv-chk/item-jobs/:pjv    → [{ SR_NO, JOB_NO }]
  // PUT /pinv-chk/item-jobs         { pjvNo, lines: [{ SR_NO, JOB_NO }] }
  // Needs: ALTER TABLE purchase_items ADD COLUMN JOB_NO VARCHAR(10) NULL;
  router.get("/pinv-chk/job/:job", async (req, res) => {
    try {
      const nc = await jobNameCol();
      const rows = await q(
        `SELECT TRIM(JOB_NO) AS JOB_NO, ${nc || "NULL"} AS PROJ_NAME
           FROM ${JOB_TABLE} WHERE TRIM(JOB_NO) = ? LIMIT 1`,
        [s(req.params.job)]);
      if (!rows.length) return res.status(404).json({ error: "Job not found" });
      res.json(rows[0]);
    } catch (err) {
      console.error("[pinv-chk/job]", err);
      res.status(500).json({ error: err.sqlMessage || err.message });
    }
  });

  // GET /pinv-chk/jobs?q=   → up to 50 jobs of the last 18 months, matching
  // Job No / project / customer / quotation ref, newest first — for the Job No
  // dropdown. job_card column names are looked up (first that exists).
  const JOB_MONTHS = 18;
  router.get("/pinv-chk/jobs", async (req, res) => {
    const term = s(req.query.q);
    try {
      const nc   = await jobNameCol();
      const dtC  = await pick(JOB_TABLE, ["JOB_DATE", "JOB_DT", "JOB_CARD_DATE", "ORDER_DATE", "LPO_DATE", "START_DATE", "CREATED_ON"]);
      const cusC = await pick(JOB_TABLE, ["CUST_CODE", "CUS_CODE", "CUSTOMER_CODE"]);
      const qtC  = await pick(JOB_TABLE, ["QUOT_REF", "QUOT_NO", "QUOTE_REF", "QUOT_REF_NO", "QUOTATION_NO", "QT_NO"]);
      const amtC = await pick(JOB_TABLE, ["CONTRACT_AMT", "CONTRACT_AMOUNT", "CONTRACT_VAL", "CONTRACT_VALUE", "JOB_VALUE", "JOB_AMOUNT"]);

      const where = [];
      const params = [];
      if (dtC) where.push(`j.${dtC} >= CURDATE() - INTERVAL ${JOB_MONTHS} MONTH`);
      if (term) {
        const like = `%${term}%`;
        const ors = ["j.JOB_NO LIKE ?"]; params.push(like);
        if (nc)   { ors.push(`j.${nc} LIKE ?`);    params.push(like); }
        if (cusC) { ors.push("c.CUST_NAME LIKE ?"); params.push(like); }
        if (qtC)  { ors.push(`j.${qtC} LIKE ?`);   params.push(like); }
        where.push(`(${ors.join(" OR ")})`);
      }
      const rows = await q(
        `SELECT TRIM(j.JOB_NO) AS JOB_NO,
                ${nc ? `j.${nc}` : "NULL"}     AS PROJ_NAME,
                ${cusC ? "c.CUST_NAME" : "NULL"} AS CUST_NAME,
                ${qtC ? `j.${qtC}` : "NULL"}   AS QUOT_REF,
                ${amtC ? `j.${amtC}` : "NULL"} AS CONTRACT_AMT
           FROM ${JOB_TABLE} j
           ${cusC ? `LEFT JOIN cus_mst c ON c.CUST_CODE = j.${cusC}` : ""}
          ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY LENGTH(TRIM(j.JOB_NO)) DESC, TRIM(j.JOB_NO) DESC
          LIMIT 50`,
        params);
      res.json(rows.map((r) => ({ ...r, CONTRACT_AMT: r.CONTRACT_AMT == null ? null : Number(r.CONTRACT_AMT) })));
    } catch (err) {
      console.error("[pinv-chk/jobs]", err);
      res.status(500).json({ error: err.sqlMessage || err.message });
    }
  });

  router.get("/pinv-chk/item-jobs/:pjv", async (req, res) => {
    try {
      if (!(await pick("purchase_items", ["JOB_NO"]))) return res.json([]);
      const rows = await q(
        `SELECT SR_NO, TRIM(JOB_NO) AS JOB_NO FROM purchase_items
          WHERE PJV_NO = ? AND JOB_NO IS NOT NULL AND TRIM(JOB_NO) <> ''`, [s(req.params.pjv)]);
      res.json(rows);
    } catch (err) {
      console.error("[pinv-chk/item-jobs GET]", err);
      res.status(500).json({ error: err.sqlMessage || err.message });
    }
  });

  router.put("/pinv-chk/item-jobs", async (req, res) => {
    const pjvNo = s(req.body?.pjvNo);
    const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (!pjvNo) return res.status(400).json({ error: "pjvNo required" });
    try {
      if (!(await pick("purchase_items", ["JOB_NO"]))) {
        if (lines.some((l) => s(l.JOB_NO))) {
          return res.status(409).json({ error: "purchase_items.JOB_NO column is missing — run: ALTER TABLE purchase_items ADD COLUMN JOB_NO VARCHAR(10) NULL" });
        }
        return res.json({ ok: true, updated: 0 });
      }
      let updated = 0;
      for (const l of lines) {
        const r = await q(`UPDATE purchase_items SET JOB_NO = ? WHERE PJV_NO = ? AND SR_NO = ?`,
          [s(l.JOB_NO) || null, pjvNo, l.SR_NO]);
        updated += r.affectedRows;
      }
      res.json({ ok: true, updated });
    } catch (err) {
      console.error("[pinv-chk/item-jobs PUT]", err);
      res.status(500).json({ error: err.sqlMessage || err.message });
    }
  });

  // ── 5. Header extras: due date, supplier invoice amount, advance paid ────
  // purchase_hdr.DUE_DATE / SUP_INV_AMT / ADV_PAID, written after the main
  // save (save-localpurch is not touched). Each column is used only if present.
  const EXTRA_COLS = {
    DUE_DATE:    { body: "dueDate",   sql: "ALTER TABLE purchase_hdr ADD COLUMN DUE_DATE DATE NULL AFTER INV_DATE" },
    SUP_INV_AMT: { body: "supInvAmt", sql: "ALTER TABLE purchase_hdr ADD COLUMN SUP_INV_AMT DECIMAL(12,2) NULL AFTER INV_AMOUNT" },
    ADV_PAID:    { body: "advPaid",   sql: "ALTER TABLE purchase_hdr ADD COLUMN ADV_PAID DECIMAL(12,2) NULL AFTER SUP_INV_AMT" },
  };
  const numOrNull = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
  // ?t=NS (or body.t) → Purchase Non-Stock (purchase_hdr_ns); default local (purchase_hdr)
  const HDR_TABLES = { L: "purchase_hdr", NS: "purchase_hdr_ns" };
  const hdrTable = (t) => HDR_TABLES[String(t || "L").toUpperCase()] || HDR_TABLES.L;
  const alterFor = (table, c) => EXTRA_COLS[c].sql.replace("purchase_hdr ", `${table} `)
    .replace(" AFTER INV_AMOUNT", table === "purchase_hdr_ns" ? " AFTER VAT_AMOUNT" : " AFTER INV_AMOUNT");

  router.get("/pinv-chk/hdr-extra/:pjv", async (req, res) => {
    const table = hdrTable(req.query.t);
    try {
      const has = {};
      for (const c of Object.keys(EXTRA_COLS)) has[c] = !!(await pick(table, [c]));
      if (!Object.values(has).some(Boolean)) return res.json({ dueDate: null, supInvAmt: null, advPaid: null });
      const rows = await q(
        `SELECT ${has.DUE_DATE ? "DATE_FORMAT(DUE_DATE, '%d/%m/%Y')" : "NULL"} AS DUE_DATE,
                ${has.SUP_INV_AMT ? "SUP_INV_AMT" : "NULL"} AS SUP_INV_AMT,
                ${has.ADV_PAID ? "ADV_PAID" : "NULL"} AS ADV_PAID
           FROM ${table} WHERE PJV_NO = ? LIMIT 1`, [s(req.params.pjv)]);
      const r = rows[0] || {};
      res.json({
        dueDate: r.DUE_DATE || null,
        supInvAmt: r.SUP_INV_AMT == null ? null : Number(r.SUP_INV_AMT),
        advPaid: r.ADV_PAID == null ? null : Number(r.ADV_PAID),
      });
    } catch (err) {
      console.error("[pinv-chk/hdr-extra GET]", err);
      res.status(500).json({ error: err.sqlMessage || err.message });
    }
  });

  // body: { pjvNo, dueDate: 'yyyy-mm-dd'|null, supInvAmt: number|null, advPaid: number|null }
  router.put("/pinv-chk/hdr-extra", async (req, res) => {
    const pjvNo = s(req.body?.pjvNo);
    const table = hdrTable(req.body?.t);
    const vals = {
      DUE_DATE: req.body?.dueDate || null,
      SUP_INV_AMT: numOrNull(req.body?.supInvAmt),
      ADV_PAID: numOrNull(req.body?.advPaid),
    };
    if (!pjvNo) return res.status(400).json({ error: "pjvNo required" });
    if (vals.DUE_DATE && !/^\d{4}-\d{2}-\d{2}$/.test(vals.DUE_DATE)) return res.status(400).json({ error: "dueDate must be yyyy-mm-dd" });
    for (const c of ["SUP_INV_AMT", "ADV_PAID"]) {
      if (vals[c] !== null && !Number.isFinite(vals[c])) return res.status(400).json({ error: `${EXTRA_COLS[c].body} must be a number` });
    }
    try {
      const sets = [], params = [], missing = [];
      for (const c of Object.keys(EXTRA_COLS)) {
        if (await pick(table, [c])) { sets.push(`${c} = ?`); params.push(vals[c]); }
        else if (vals[c] !== null && vals[c] !== 0) missing.push(alterFor(table, c));
      }
      let updated = 0;
      if (sets.length) {
        const r = await q(`UPDATE ${table} SET ${sets.join(", ")} WHERE PJV_NO = ?`, [...params, pjvNo]);
        updated = r.affectedRows;
      }
      if (missing.length) {
        return res.status(409).json({ error: `Column missing in ${table} — run: ${missing.join("; ")}`, updated });
      }
      res.json({ ok: true, updated });
    } catch (err) {
      console.error("[pinv-chk/hdr-extra PUT]", err);
      res.status(500).json({ error: err.sqlMessage || err.message });
    }
  });

  // ── 8. Supplier position (strip under the header) ────────────────────────
  // GET /pinv-chk/sup-position/:sup
  //  balance  = sup_mst opening (OP_BAL, OP_DBCR) + tran_acc movements from the
  //             ac_period start — positive = payable (Cr)
  //  overdue  = local + non-stock purchases not fully settled in adj_dtl whose
  //             due date (DUE_DATE, else Inv/PJV date + CR_PERIOD) is past
  //  pdc      = cheques issued to the supplier not yet realised (pdc_isu), if
  //             its columns can be found
  //  crLimit  = sup_mst.CR_LIMIT
  router.get("/pinv-chk/sup-position/:sup", async (req, res) => {
    const sup = s(req.params.sup);
    if (!sup) return res.json(null);
    try {
      const out = { balance: null, overdueAmt: null, overdueCount: 0, oldestDue: null,
                    pdcAmt: null, pdcCount: 0, crLimit: null, crPeriod: null };

      const sm = await q(
        `SELECT OP_BAL, OP_DBCR, CR_LIMIT, CR_PERIOD FROM sup_mst WHERE SUP_CODE = ? LIMIT 1`, [sup]);
      if (!sm.length) return res.json(null);
      const op = Number(sm[0].OP_BAL) || 0;
      const opSigned = s(sm[0].OP_DBCR).toUpperCase() === "D" ? -op : op;
      out.crLimit = sm[0].CR_LIMIT == null ? null : Number(sm[0].CR_LIMIT);
      out.crPeriod = sm[0].CR_PERIOD == null ? null : Number(sm[0].CR_PERIOD);

      const mv = await q(
        `SELECT COALESCE(SUM(CASE WHEN DB_CR = 'C' THEN AMOUNT ELSE -AMOUNT END), 0) AS M
           FROM tran_acc
          WHERE ACC_CODE = ?
            AND DATTE >= (SELECT START_DATE FROM ac_period LIMIT 1)`, [sup]);
      out.balance = Math.round((opSigned + (Number(mv[0]?.M) || 0)) * 100) / 100;

      // overdue purchases — local (purchase_hdr, INV_AMOUNT) and non-stock
      // (purchase_hdr_ns, INV_NET_AMT), less what adj_dtl has settled
      const adjAmt = await pick("adj_dtl", ["ADJ_AMT", "ADJ_AMOUNT", "STLD_AMT", "STLD_AMOUNT", "AMOUNT"]);
      if (adjAmt) {
        const days = Number.isFinite(out.crPeriod) ? out.crPeriod : 0;
        const srcs = [{ t: "purchase_hdr", amt: "INV_AMOUNT" }, { t: "purchase_hdr_ns", amt: "INV_NET_AMT" }];
        const parts = [], params = [];
        for (const src of srcs) {
          if (!(await tableCols(src.t)).size || !(await pick(src.t, [src.amt]))) continue;
          const hasDue = !!(await pick(src.t, ["DUE_DATE"]));
          parts.push(
            `SELECT h.PJV_NO, h.${src.amt} AS AMT,
                    ${hasDue ? "COALESCE(h.DUE_DATE, " : "("}
                      DATE_ADD(COALESCE(h.INV_DATE, h.PJV_DATE), INTERVAL ? DAY)) AS DUE
               FROM ${src.t} h WHERE TRIM(h.SUP_CODE) = ?`);
          params.push(days, sup);
        }
        if (parts.length) {
          const rows = await q(
            `SELECT x.AMT - COALESCE(a.SETTLED, 0) AS OPEN_AMT, DATE_FORMAT(x.DUE, '%d/%m/%Y') AS DUE_TXT
               FROM (${parts.join(" UNION ALL ")}) x
          LEFT JOIN (SELECT TRIM(STLD_DOC) AS DOC, SUM(${adjAmt}) AS SETTLED
                       FROM adj_dtl WHERE TRIM(STLD_TYPE) = '07'
                      GROUP BY TRIM(STLD_DOC)) a ON a.DOC = x.PJV_NO
              WHERE x.AMT - COALESCE(a.SETTLED, 0) > 0.005 AND x.DUE < CURDATE()
              ORDER BY x.DUE`, params);
          out.overdueAmt = Math.round(rows.reduce((t, r) => t + Number(r.OPEN_AMT || 0), 0) * 100) / 100;
          out.overdueCount = rows.length;
          out.oldestDue = rows[0]?.DUE_TXT || null;
        }
      }

      // open PDCs issued (best effort — skipped if pdc_isu's columns aren't found)
      try {
        const pSup = await pick("pdc_isu", ["SUP_CODE", "ACC_CODE", "PARTY_CODE", "PAY_TO_CODE"]);
        const pAmt = await pick("pdc_isu", ["CHQ_AMT", "CHQ_AMOUNT", "AMOUNT"]);
        const pDt  = await pick("pdc_isu", ["CHQ_DATE", "CHQ_DT", "CHEQUE_DATE"]);
        const pRl  = await pick("pdc_isu", ["REALISED", "REALIZED"]);
        if (pSup && pAmt && (pRl || pDt)) {
          const r = await q(
            `SELECT COUNT(*) AS N, COALESCE(SUM(${pAmt}), 0) AS A FROM pdc_isu
              WHERE TRIM(${pSup}) = ?
                AND ${pRl ? `COALESCE(${pRl}, 'N') <> 'Y'` : `${pDt} >= CURDATE()`}`, [sup]);
          out.pdcCount = Number(r[0]?.N) || 0;
          out.pdcAmt = Math.round((Number(r[0]?.A) || 0) * 100) / 100;
        }
      } catch (pdcErr) {
        console.warn("[pinv-chk/sup-position] PDC part skipped:", pdcErr.sqlMessage || pdcErr.message);
      }

      res.json(out);
    } catch (err) {
      console.error("[pinv-chk/sup-position]", err);
      res.status(500).json({ error: err.sqlMessage || err.message });
    }
  });

  return router;
};
