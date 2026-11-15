// routes/exceptionCenterRoutes.js
// Exception Centre — one screen listing documents that need attention.
//
//   GET /api/exception-centre?from=YYYY-MM-DD&to=YYYY-MM-DD
//       (no dates → the ac_period range)
//
// Each check runs on its own: if one fails (e.g. a column differs), it comes
// back with `error` and the others still show.
//
// Register in HayatDb.js:
//   const exceptionCenterRoutes = require('./routes/exceptionCenterRoutes');
//   app.use('/api', exceptionCenterRoutes(connection));

const express = require('express');

const STOCK_LOC = '01';
const SIV_TRAN_TYPE = '21';
const PUR_TRAN_TYPE = '07';
const ROW_CAP = 1000;   // rows returned per check (the count is always the full count)

const n2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const n3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
const toDate = (v) => {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  return null;
};
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dmy = (v) => {
  const d = toDate(v);
  return d ? `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}` : '';
};

// column list per table, cached for the life of the process
const colCache = new Map();
async function hasCol(db, table, col) {
  if (!colCache.has(table)) {
    try {
      const [rows] = await db.query(`SHOW COLUMNS FROM ${table}`);
      colCache.set(table, new Set(rows.map((r) => String(r.Field).toUpperCase())));
    } catch (e) { colCache.set(table, new Set()); }
  }
  return colCache.get(table).has(col.toUpperCase());
}

async function itemNames(db, codes) {
  const out = {};
  if (!codes.length) return out;
  try {
    const [rows] = await db.query('SELECT ITEM_CODE, ITEM_NAME1 FROM item_mst WHERE ITEM_CODE IN (?)', [codes]);
    rows.forEach((r) => { out[String(r.ITEM_CODE).trim()] = r.ITEM_NAME1 || ''; });
  } catch (e) { /* names optional */ }
  return out;
}

// ── the checks ────────────────────────────────────────────────────────────
// Each returns { rows } built from (db, from, to). from/to are YYYY-MM-DD.
const CHECKS = [
  {
    key: 'srv_no_pjv', severity: 'high', area: 'Purchases',
    title: 'SRVs without a Purchase JV',
    description: 'Stock received but not booked in Purchase Invoice Local — the supplier liability is missing from the G/L.',
    columns: [
      { field: 'srvNo', header: 'SRV No' }, { field: 'date', header: 'SRV Date' },
      { field: 'party', header: 'Supplier' }, { field: 'lpoNo', header: 'LPO' },
      { field: 'amount', header: 'SRV Value', type: 'amount' }, { field: 'days', header: 'Days pending', type: 'int' },
    ],
    async run(db, from, to) {
      const supOk = await hasCol(db, 'srv_hdr', 'SUP_CODE');
      const poOk = await hasCol(db, 'srv_hdr', 'PO_NO');
      const [rows] = await db.query(
        `SELECT s.SRV_NO, MIN(s.SRV_DATE) AS D,
                ROUND(SUM(IFNULL(s.QTY, 0) * IFNULL(s.COST, 0) - IFNULL(s.DISCOUNT, 0)), 2) AS V
                ${supOk ? ', MAX(m.SUP_NAME) AS SUP' : ''} ${poOk ? ', MAX(h.PO_NO) AS LPO' : ''}
           FROM srv_items s
           ${supOk || poOk ? 'LEFT JOIN srv_hdr h ON h.SRV_NO = s.SRV_NO' : ''}
           ${supOk ? 'LEFT JOIN sup_mst m ON m.SUP_CODE = h.SUP_CODE' : ''}
          WHERE s.SRV_DATE BETWEEN ? AND ?
            AND NOT EXISTS (SELECT 1 FROM purchase_hdr p
                             WHERE p.SRV_NO = s.SRV_NO AND IFNULL(p.CAN_CEL, 'N') <> 'Y')
          GROUP BY s.SRV_NO
          ORDER BY D, s.SRV_NO`,
        [from, `${to} 23:59:59`]
      );
      const today = new Date(); today.setHours(0, 0, 0, 0);
      return rows.map((r) => {
        const d = toDate(r.D);
        return {
          srvNo: r.SRV_NO, date: dmy(d), party: r.SUP || '', lpoNo: r.LPO || '', amount: n2(r.V),
          days: d ? Math.max(0, Math.round((today - d) / 86400000)) : null,
        };
      });
    },
  },
  {
    key: 'pjv_not_in_gl', severity: 'high', area: 'Purchases',
    title: 'Purchase JVs not posted to the G/L',
    description: 'PJVs in purchase_hdr with no tran type 07 entries in tran_acc.',
    columns: [
      { field: 'pjvNo', header: 'PJV No' }, { field: 'date', header: 'PJV Date' }, { field: 'srvNo', header: 'SRV No' },
      { field: 'party', header: 'Supplier' }, { field: 'invNo', header: 'Sup. Inv No' }, { field: 'amount', header: 'Inv Amount', type: 'amount' },
    ],
    async run(db, from, to) {
      const [rows] = await db.query(
        `SELECT p.PJV_NO, p.PJV_DATE, p.SRV_NO, p.INV_NO, IFNULL(p.INV_AMOUNT, 0) AS AMT, m.SUP_NAME
           FROM purchase_hdr p LEFT JOIN sup_mst m ON m.SUP_CODE = p.SUP_CODE
          WHERE IFNULL(p.CAN_CEL, 'N') <> 'Y' AND p.PJV_DATE BETWEEN ? AND ?
            AND NOT EXISTS (SELECT 1 FROM tran_acc t WHERE t.TRAN_TYPE = ? AND t.VCHR_NO = p.PJV_NO)
          ORDER BY p.PJV_DATE, p.PJV_NO`,
        [from, to, PUR_TRAN_TYPE]
      );
      return rows.map((r) => ({
        pjvNo: r.PJV_NO, date: dmy(r.PJV_DATE), srvNo: r.SRV_NO || '', party: r.SUP_NAME || '',
        invNo: r.INV_NO || '', amount: n2(r.AMT),
      }));
    },
  },
  {
    key: 'dup_sup_inv', severity: 'medium', area: 'Purchases',
    title: 'Same supplier invoice no. booked more than once',
    description: 'Two or more live PJVs (Purchase Local) for one supplier carry the same invoice number.',
    columns: [
      { field: 'party', header: 'Supplier' }, { field: 'invNo', header: 'Sup. Inv No' },
      { field: 'count', header: 'Times', type: 'int' }, { field: 'docs', header: 'PJVs' },
      { field: 'date', header: 'Latest PJV Date' }, { field: 'amount', header: 'Total Amount', type: 'amount' },
    ],
    async run(db, from, to) {
      const [rows] = await db.query(
        `SELECT p.SUP_CODE, MAX(m.SUP_NAME) AS SUP_NAME, TRIM(p.INV_NO) AS INV, COUNT(*) AS N,
                GROUP_CONCAT(p.PJV_NO ORDER BY p.PJV_NO SEPARATOR ', ') AS PJVS,
                MAX(p.PJV_DATE) AS D, SUM(IFNULL(p.INV_AMOUNT, 0)) AS AMT
           FROM purchase_hdr p LEFT JOIN sup_mst m ON m.SUP_CODE = p.SUP_CODE
          WHERE IFNULL(p.CAN_CEL, 'N') <> 'Y' AND TRIM(IFNULL(p.INV_NO, '')) <> ''
          GROUP BY p.SUP_CODE, TRIM(p.INV_NO)
         HAVING COUNT(*) > 1 AND MAX(p.PJV_DATE) BETWEEN ? AND ?
          ORDER BY D DESC`,
        [from, to]
      );
      return rows.map((r) => ({
        party: r.SUP_NAME || r.SUP_CODE, invNo: r.INV, count: Number(r.N), docs: r.PJVS,
        date: dmy(r.D), amount: n2(r.AMT),
      }));
    },
  },
  {
    key: 'lpo_over_receipt', severity: 'medium', area: 'Purchases',
    title: 'Received more than the LPO quantity',
    description: 'All SRVs on an LPO line add up to more than was ordered. LPO no. from the SRV line, else srv_hdr.PO_NO. Not limited by period.',
    columns: [
      { field: 'lpoNo', header: 'LPO' }, { field: 'lpoSr', header: 'Line', type: 'int' },
      { field: 'itemCode', header: 'Item Code' }, { field: 'itemName', header: 'Description' },
      { field: 'ordered', header: 'LPO Qty', type: 'qty' }, { field: 'received', header: 'Received', type: 'qty' },
      { field: 'over', header: 'Over by', type: 'qty' },
    ],
    async run(db) {
      const poOk = await hasCol(db, 'srv_hdr', 'PO_NO');
      const eff = `COALESCE(NULLIF(TRIM(s.LPO_NO), ''), NULLIF(TRIM(s.PO_NO), '')${poOk ? ", NULLIF(TRIM(h.PO_NO), '')" : ''})`;
      const [rows] = await db.query(
        `SELECT l.LPO_NO, l.SR_NO, l.ITEM_CODE, l.ITEM_NAME, IFNULL(l.QTY, 0) AS QTY, SUM(r.RQ) AS RQ
           FROM lpo_items l
           JOIN (SELECT ${eff} AS ELPO, CAST(s.SR_NO AS UNSIGNED) AS SRN, s.ITEM_CODE, SUM(IFNULL(s.QTY, 0)) AS RQ
                   FROM srv_items s ${poOk ? 'LEFT JOIN srv_hdr h ON h.SRV_NO = s.SRV_NO' : ''}
                  GROUP BY ELPO, SRN, s.ITEM_CODE) r
             ON r.ELPO = TRIM(l.LPO_NO) AND r.SRN = l.SR_NO
            AND (TRIM(IFNULL(l.ITEM_CODE, '')) = '' OR r.ITEM_CODE = l.ITEM_CODE)
          GROUP BY l.LPO_NO, l.SR_NO, l.ITEM_CODE, l.ITEM_NAME, l.QTY
         HAVING SUM(r.RQ) > IFNULL(l.QTY, 0) + 0.0005
          ORDER BY l.LPO_NO DESC, l.SR_NO`
      );
      return rows.map((r) => ({
        lpoNo: r.LPO_NO, lpoSr: Number(r.SR_NO), itemCode: r.ITEM_CODE || '', itemName: r.ITEM_NAME || '',
        ordered: n3(r.QTY), received: n3(r.RQ), over: n3(Number(r.RQ) - Number(r.QTY)),
      }));
    },
  },
  {
    key: 'siv_zero_cost', severity: 'high', area: 'Stores',
    title: 'SIV lines issued at zero cost',
    description: 'Material issued with STD_COST 0 — the job cost is understated by these lines.',
    columns: [
      { field: 'sivNo', header: 'SIV No' }, { field: 'date', header: 'SIV Date' }, { field: 'jobNo', header: 'Job' },
      { field: 'itemCode', header: 'Item Code' }, { field: 'itemName', header: 'Description' }, { field: 'qty', header: 'Qty', type: 'qty' },
    ],
    async run(db, from, to) {
      const [rows] = await db.query(
        `SELECT h.SIV_NO, h.SIV_DATE, h.JOB_NO, i.ITEM_CODE,
                COALESCE(NULLIF(i.XL_ITEM_DESC, ''), m.ITEM_NAME1) AS NAME, IFNULL(i.QTY, 0) AS QTY
           FROM siv_hdr h JOIN siv_items i ON i.SIV_NO = h.SIV_NO
           LEFT JOIN item_mst m ON m.ITEM_CODE = i.ITEM_CODE
          WHERE h.SIV_DATE BETWEEN ? AND ? AND IFNULL(i.STD_COST, 0) = 0 AND IFNULL(i.QTY, 0) <> 0
          ORDER BY h.SIV_DATE, h.SIV_NO, i.SR_NO`,
        [from, `${to} 23:59:59`]
      );
      return rows.map((r) => ({
        sivNo: r.SIV_NO, date: dmy(r.SIV_DATE), jobNo: r.JOB_NO || '', itemCode: r.ITEM_CODE || '',
        itemName: r.NAME || '', qty: n3(r.QTY),
      }));
    },
  },
  {
    key: 'siv_gl', severity: 'medium', area: 'Stores',
    title: 'SIVs not posted, or G/L ≠ item value',
    description: 'SIVs with no tran type 21 entries, or whose G/L debit differs from the sum of QTY × STD_COST.',
    columns: [
      { field: 'sivNo', header: 'SIV No' }, { field: 'date', header: 'SIV Date' }, { field: 'jobNo', header: 'Job' },
      { field: 'value', header: 'Item Value', type: 'amount' }, { field: 'gl', header: 'G/L Debit', type: 'amount' },
      { field: 'issue', header: 'Issue' },
    ],
    async run(db, from, to) {
      const [rows] = await db.query(
        `SELECT h.SIV_NO, h.SIV_DATE, h.JOB_NO, v.V, g.D
           FROM siv_hdr h
           JOIN (SELECT SIV_NO, SUM(IFNULL(QTY, 0) * IFNULL(STD_COST, 0)) AS V FROM siv_items GROUP BY SIV_NO) v
             ON v.SIV_NO = h.SIV_NO
           LEFT JOIN (SELECT VCHR_NO, SUM(CASE WHEN DB_CR = 'D' THEN AMOUNT ELSE 0 END) AS D
                        FROM tran_acc WHERE TRAN_TYPE = ? GROUP BY VCHR_NO) g
             ON g.VCHR_NO = h.SIV_NO
          WHERE h.SIV_DATE BETWEEN ? AND ?
            AND ((g.D IS NULL AND ABS(v.V) > 0.004) OR (g.D IS NOT NULL AND ABS(g.D - v.V) > 0.01))
          ORDER BY h.SIV_DATE, h.SIV_NO`,
        [SIV_TRAN_TYPE, from, `${to} 23:59:59`]
      );
      return rows.map((r) => ({
        sivNo: r.SIV_NO, date: dmy(r.SIV_DATE), jobNo: r.JOB_NO || '', value: n2(r.V),
        gl: r.D == null ? null : n2(r.D),
        issue: r.D == null ? 'Not in G/L' : 'Amount differs',
      }));
    },
  },
  {
    key: 'negative_stock', severity: 'high', area: 'Stores',
    title: 'Items with negative stock (today)',
    description: 'Stock balance below zero in location 01 — usually an issue entered before its SRV, or a missing receipt. Not limited by period.',
    columns: [
      { field: 'itemCode', header: 'Item Code' }, { field: 'itemName', header: 'Description' },
      { field: 'qty', header: 'Stock', type: 'qty' }, { field: 'date', header: 'Last Movement' },
    ],
    async run(db) {
      const [rows] = await db.query(
        `SELECT Item_code AS C, SUM(Qty) AS Q, MAX(Doc_date) AS D
           FROM stock_trans WHERE Loc_code = ?
          GROUP BY Item_code HAVING SUM(Qty) < -0.0005
          ORDER BY SUM(Qty)`,
        [STOCK_LOC]
      );
      const names = await itemNames(db, rows.map((r) => String(r.C).trim()));
      return rows.map((r) => ({
        itemCode: String(r.C).trim(), itemName: names[String(r.C).trim()] || '', qty: n3(r.Q), date: dmy(r.D),
      }));
    },
  },
  {
    key: 'unbalanced', severity: 'high', area: 'Accounts',
    title: 'Vouchers where Debit ≠ Credit',
    description: 'tran_acc vouchers (any tran type) in the period whose debits and credits do not agree.',
    columns: [
      { field: 'tranType', header: 'Tran Type' }, { field: 'vchrNo', header: 'Vchr No' }, { field: 'date', header: 'Date' },
      { field: 'dr', header: 'Debit', type: 'amount' }, { field: 'cr', header: 'Credit', type: 'amount' },
      { field: 'diff', header: 'Difference', type: 'amount' },
    ],
    async run(db, from, to) {
      const [rows] = await db.query(
        `SELECT TRAN_TYPE, VCHR_NO, MIN(DATTE) AS D,
                SUM(CASE WHEN DB_CR = 'D' THEN AMOUNT ELSE 0 END) AS DR,
                SUM(CASE WHEN DB_CR = 'C' THEN AMOUNT ELSE 0 END) AS CR
           FROM tran_acc WHERE DATTE BETWEEN ? AND ?
          GROUP BY TRAN_TYPE, VCHR_NO
         HAVING ABS(DR - CR) > 0.01
          ORDER BY D, TRAN_TYPE, VCHR_NO`,
        [from, `${to} 23:59:59`]
      );
      return rows.map((r) => ({
        tranType: r.TRAN_TYPE, vchrNo: r.VCHR_NO, date: dmy(r.D),
        dr: n2(r.DR), cr: n2(r.CR), diff: n2(Number(r.DR) - Number(r.CR)),
      }));
    },
  },
];

module.exports = function (connection) {
  const router = express.Router();

  router.get('/exception-centre', async (req, res) => {
    const db = connection.promise();
    try {
      let from = toDate(req.query.from);
      let to = toDate(req.query.to);
      if (!from || !to) {
        const [[p]] = await db.query('SELECT START_DATE, END_DATE FROM ac_period LIMIT 1');
        from = from || toDate(p && p.START_DATE) || new Date(new Date().getFullYear(), 0, 1);
        to = to || toDate(p && p.END_DATE) || new Date();
      }
      const f = ymd(from), t = ymd(to);
      const only = String(req.query.only || '').trim();   // ?only=<key> reruns one check

      const list = only ? CHECKS.filter((c) => c.key === only) : CHECKS;
      const results = await Promise.all(list.map(async (c) => {
        const base = {
          key: c.key, title: c.title, area: c.area, severity: c.severity,
          description: c.description, columns: c.columns,
        };
        try {
          const rows = await c.run(db, f, t);
          return { ...base, count: rows.length, rows: rows.slice(0, ROW_CAP), capped: rows.length > ROW_CAP };
        } catch (err) {
          console.error(`exception-centre ${c.key}:`, err.message);
          return { ...base, count: 0, rows: [], error: err.message };
        }
      }));
      res.json({ from: dmy(from), to: dmy(to), checks: results });
    } catch (err) {
      console.error('exception-centre error:', err);
      res.status(500).json({ error: 'Failed to run the checks', detail: err.message });
    }
  });

  return router;
};
