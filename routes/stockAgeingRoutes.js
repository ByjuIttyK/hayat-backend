// routes/stockAgeingRoutes.js
// Stock Ageing (FIFO) as on a date, location 01.
//
//   GET /api/stock-ageing?asOn=YYYY-MM-DD&buckets=30,60,90,180,365
//
// FIFO means the oldest stock is issued first, so the quantity still in store
// is made up of the NEWEST receipts. For each item with a positive balance the
// balance is laid over its receipts (stock_trans Qty > 0) from the latest
// backwards; each slice is aged from its receipt date and valued at the
// receipt's Std_cost.
//
// Opening stock (item_mst.OP_STOCK) is not in stock_trans: it is added to the
// balance and treated as the OLDEST layer (before every receipt), so it is
// used up first and whatever is left of it falls in the last bucket.
//
// Register in HayatDb.js:
//   const stockAgeingRoutes = require('./routes/stockAgeingRoutes');
//   app.use('/api', stockAgeingRoutes(connection));

const express = require('express');

const STOCK_LOC = '01';
const DEFAULT_BUCKETS = [30, 60, 90, 180, 365];

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
const dayOf = (d) => { const x = new Date(d.getTime()); x.setHours(0, 0, 0, 0); return x; };

function bucketLabels(b) {
  const out = [];
  let lo = 0;
  b.forEach((hi) => { out.push(`${lo === 0 ? 0 : lo + 1}–${hi} days`); lo = hi; });
  out.push(`Over ${lo} days`);
  return out;
}

const colCache = new Map();
async function columnsOf(db, table) {
  if (!colCache.has(table)) {
    try {
      const [rows] = await db.query(`SHOW COLUMNS FROM ${table}`);
      colCache.set(table, new Set(rows.map((r) => String(r.Field).toUpperCase())));
    } catch (e) { colCache.set(table, new Set()); }
  }
  return colCache.get(table);
}

module.exports = function (connection) {
  const router = express.Router();

  router.get('/stock-ageing', async (req, res) => {
    const db = connection.promise();
    try {
      const asOn = dayOf(toDate(req.query.asOn) || new Date());
      const asOnEnd = `${ymd(asOn)} 23:59:59`;
      let buckets = String(req.query.buckets || '').split(',').map((x) => parseInt(x, 10)).filter((x) => x > 0);
      buckets = buckets.length ? [...new Set(buckets)].sort((a, b) => a - b) : DEFAULT_BUCKETS;
      const nb = buckets.length + 1;
      const bucketOf = (age) => { const i = buckets.findIndex((hi) => age <= hi); return i < 0 ? buckets.length : i; };

      // balances as on the date
      const [bal] = await db.query(
        `SELECT Item_code AS C, SUM(Qty) AS Q,
                MAX(CASE WHEN Qty > 0 THEN Doc_date END) AS LI,
                MAX(CASE WHEN Qty < 0 THEN Doc_date END) AS LO
           FROM stock_trans
          WHERE Loc_code = ? AND Doc_date <= ?
          GROUP BY Item_code`,
        [STOCK_LOC, asOnEnd]
      );
      const all = {};
      bal.forEach((r) => {
        const c = String(r.C || '').trim();
        if (c) all[c] = { qty: Number(r.Q) || 0, op: 0, opCost: 0, lastIn: r.LI, lastOut: r.LO };
      });

      // + opening stock from item_mst.OP_STOCK
      const imCols = await columnsOf(db, 'item_mst');
      if (imCols.has('OP_STOCK')) {
        const costCol = ['OP_RATE', 'OP_COST', 'STD_COST', 'AVG_COST'].find((k) => imCols.has(k));
        const [op] = await db.query(
          `SELECT ITEM_CODE AS C, IFNULL(OP_STOCK, 0) AS Q${costCol ? `, IFNULL(${costCol}, 0) AS COST` : ''}
             FROM item_mst WHERE IFNULL(OP_STOCK, 0) <> 0`
        );
        op.forEach((r) => {
          const c = String(r.C || '').trim();
          if (!c) return;
          const it = all[c] || (all[c] = { qty: 0, op: 0, opCost: 0, lastIn: null, lastOut: null });
          it.op = Number(r.Q) || 0;
          it.opCost = Number(r.COST) || 0;
          it.qty += it.op;
        });
      }

      const items = {};
      Object.entries(all).forEach(([c, it]) => { if (it.qty > 0.0005) items[c] = it; });
      const codes = Object.keys(items);
      if (!codes.length) {
        return res.json({ asOn: dmy(asOn), buckets: bucketLabels(buckets), totals: { qty: 0, value: 0, bv: Array(nb).fill(0) }, items: [] });
      }

      // receipts, newest first per item
      const [ins] = await db.query(
        `SELECT Item_code AS C, Doc_no, Stock_tran_type AS T, Doc_date AS D, Qty AS Q, IFNULL(Std_cost, 0) AS COST
           FROM stock_trans
          WHERE Loc_code = ? AND Qty > 0 AND Doc_date <= ?
          ORDER BY Item_code, Doc_date DESC, sORT_ORD DESC, Doc_no DESC`,
        [STOCK_LOC, asOnEnd]
      );
      const layers = {};
      ins.forEach((r) => {
        const c = String(r.C).trim();
        if (items[c]) (layers[c] = layers[c] || []).push(r);
      });

      // names / part no
      const names = {};
      try {
        const [nm] = await db.query('SELECT ITEM_CODE, ITEM_NAME1, ARTICLE_CODE FROM item_mst WHERE ITEM_CODE IN (?)', [codes]);
        nm.forEach((r) => { names[String(r.ITEM_CODE).trim()] = { name: r.ITEM_NAME1 || '', part: r.ARTICLE_CODE || '' }; });
      } catch (e) { /* optional */ }

      const totals = { qty: 0, value: 0, bv: Array(nb).fill(0), bq: Array(nb).fill(0), noReceiptQty: 0, opQty: 0 };
      const out = codes.map((c) => {
        const it = items[c];
        const ls = [...(layers[c] || [])];
        // opening stock = oldest layer, after all receipts (list is newest first)
        if (it.op > 0) ls.push({ OPENING: true, Q: it.op, COST: it.opCost, D: null });
        const lastCost = (ls.find((l) => Number(l.COST) > 0) || {}).COST || 0;
        const bq = Array(nb).fill(0), bv = Array(nb).fill(0);
        let rem = it.qty, value = 0, oldest = null, opUsed = 0;
        for (const l of ls) {
          if (rem <= 0.0005) break;
          const take = Math.min(rem, Number(l.Q) || 0);
          if (take <= 0) continue;
          const d = l.OPENING ? null : toDate(l.D);
          const age = d ? Math.max(0, Math.round((asOn - dayOf(d)) / 86400000)) : 99999;   // opening → last bucket
          if (l.OPENING) opUsed = take;
          const b = bucketOf(age);
          const cost = Number(l.COST) > 0 ? Number(l.COST) : Number(lastCost);
          bq[b] += take; bv[b] += take * cost; value += take * cost;
          oldest = l.OPENING ? 'OPENING' : (d || oldest);
          rem -= take;
        }
        const noReceipt = rem > 0.0005 ? rem : 0;   // balance with no receipt to explain it
        if (noReceipt) { bq[nb - 1] += noReceipt; bv[nb - 1] += noReceipt * Number(lastCost); value += noReceipt * Number(lastCost); }

        const lastMove = [toDate(it.lastIn), toDate(it.lastOut)].filter(Boolean).sort((a, b) => b - a)[0];
        const lastOut = toDate(it.lastOut);
        const idleDays = lastOut ? Math.max(0, Math.round((asOn - dayOf(lastOut)) / 86400000)) : null;

        totals.qty += it.qty; totals.value += value; totals.noReceiptQty += noReceipt; totals.opQty += opUsed;
        bq.forEach((q, i) => { totals.bq[i] += q; totals.bv[i] += bv[i]; });

        return {
          itemCode: c, itemName: (names[c] || {}).name || '', partNo: (names[c] || {}).part || '',
          qty: n3(it.qty), value: n2(value), avgCost: it.qty ? n3(value / it.qty) : 0,
          bq: bq.map(n3), bv: bv.map(n2),
          oldest: oldest === 'OPENING' ? 'Opening' : dmy(oldest), lastIn: dmy(it.lastIn), lastOut: dmy(it.lastOut), lastMove: dmy(lastMove),
          idleDays,                       // days since last issue (null = never issued)
          noReceipt: n3(noReceipt),
          opQty: n3(opUsed),              // part of the balance that is opening stock
        };
      }).sort((a, b) => b.value - a.value);

      res.json({
        asOn: dmy(asOn),
        bucketDays: buckets,
        buckets: bucketLabels(buckets),
        totals: {
          qty: n3(totals.qty), value: n2(totals.value),
          bq: totals.bq.map(n3), bv: totals.bv.map(n2), noReceiptQty: n3(totals.noReceiptQty), opQty: n3(totals.opQty),
          items: out.length,
        },
        items: out,
      });
    } catch (err) {
      console.error('stock-ageing error:', err);
      res.status(500).json({ error: 'Failed to work out stock ageing', detail: err.message });
    }
  });

  return router;
};
