// routes/reorderRoutes.js
// Reorder Planning.
//
//   GET /api/reorder?months=6&lpoMonths=12
//       Per item: stock (loc 01), SIV issues over `months` (usage), on-order qty
//       (open LPO lines from the last `lpoMonths`), Min / Max / lead / pack
//       from item_reorder, last supplier + rate from the latest SRV line.
//       Suggestions and status are worked out on the screen, so changing the
//       safety days / cover months does not need a reload.
//
//   PUT /api/reorder/levels   { levels: [{ itemCode, min, max, lead, pack }] }
//       Upserts item_reorder (see sql/item_reorder.sql).
//
// Register in HayatDb.js:
//   const reorderRoutes = require('./routes/reorderRoutes');
//   app.use('/api', reorderRoutes(connection));

const express = require('express');

const STOCK_LOC = '01';
const DEFAULT_LEAD = 14;

const n3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
const t = (v) => String(v ?? '').trim();
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dmy = (v) => {
  const d = v instanceof Date ? v : (v ? new Date(v) : null);
  return d && !isNaN(d.getTime()) ? `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}` : '';
};
const monthsBack = (m) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setMonth(d.getMonth() - m); return d; };

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

module.exports = function (connection) {
  const router = express.Router();

  router.get('/reorder', async (req, res) => {
    const db = connection.promise();
    try {
      const months = Math.min(36, Math.max(1, parseInt(req.query.months, 10) || 6));
      const lpoMonths = Math.min(60, Math.max(1, parseInt(req.query.lpoMonths, 10) || 12));
      const useFrom = ymd(monthsBack(months));
      const lpoFrom = ymd(monthsBack(lpoMonths));

      // stock now (stock_trans, loc 01)
      const [st] = await db.query(
        `SELECT Item_code AS C, SUM(Qty) AS Q FROM stock_trans WHERE Loc_code = ? GROUP BY Item_code`,
        [STOCK_LOC]
      );
      const map = {};
      const get = (c) => (map[c] = map[c] || { itemCode: c, stock: 0, used: 0, onOrder: 0 });
      st.forEach((r) => { get(t(r.C)).stock = n3(r.Q); });

      // usage = qty issued on SIVs in the period (store issues only — no D/O, returns or adjustments)
      const [use] = await db.query(
        `SELECT i.ITEM_CODE AS C, SUM(IFNULL(i.QTY, 0)) AS U
           FROM siv_items i JOIN siv_hdr h ON h.SIV_NO = i.SIV_NO
          WHERE h.SIV_DATE >= ? AND IFNULL(i.LOC_CODE, ?) = ?
          GROUP BY i.ITEM_CODE`,
        [useFrom, STOCK_LOC, STOCK_LOC]
      );
      use.forEach((r) => { if (t(r.C)) get(t(r.C)).used = n3(r.U); });

      // reorder levels
      let levelsOk = true;
      try {
        const [lv] = await db.query('SELECT ITEM_CODE, MIN_QTY, MAX_QTY, LEAD_DAYS, PACK_QTY FROM item_reorder');
        lv.forEach((r) => {
          const it = get(t(r.ITEM_CODE));
          it.min = n3(r.MIN_QTY); it.max = n3(r.MAX_QTY);
          it.lead = r.LEAD_DAYS == null ? null : Number(r.LEAD_DAYS);
          it.pack = r.PACK_QTY == null ? null : n3(r.PACK_QTY);
        });
      } catch (e) { levelsOk = false; }

      // on order: open LPO lines (LPO qty − received), LPO no. on the SRV line else srv_hdr.PO_NO
      const poOk = await hasCol(db, 'srv_hdr', 'PO_NO');
      const netDate = await hasCol(db, 'lpo_net', 'LPO_DATE');
      const eff = `COALESCE(NULLIF(TRIM(s.LPO_NO), ''), NULLIF(TRIM(s.PO_NO), '')${poOk ? ", NULLIF(TRIM(h.PO_NO), '')" : ''})`;
      const dateExpr = netDate ? 'COALESCE(l.LPO_DATE, n.LPO_DATE)' : 'l.LPO_DATE';
      try {
        const [oo] = await db.query(
          `SELECT l.ITEM_CODE, SUM(GREATEST(IFNULL(l.QTY, 0) - IFNULL(r.RQ, 0), 0)) AS PEND
             FROM lpo_items l
             ${netDate ? 'LEFT JOIN lpo_net n ON TRIM(n.LPO_NO) = TRIM(l.LPO_NO)' : ''}
             LEFT JOIN (SELECT ${eff} AS ELPO, CAST(s.SR_NO AS UNSIGNED) AS SRN, s.ITEM_CODE, SUM(IFNULL(s.QTY, 0)) AS RQ
                          FROM srv_items s ${poOk ? 'LEFT JOIN srv_hdr h ON h.SRV_NO = s.SRV_NO' : ''}
                         GROUP BY ELPO, SRN, s.ITEM_CODE) r
               ON r.ELPO = TRIM(l.LPO_NO) AND r.SRN = l.SR_NO AND r.ITEM_CODE = l.ITEM_CODE
            WHERE TRIM(IFNULL(l.ITEM_CODE, '')) <> ''
              AND (${dateExpr} IS NULL OR ${dateExpr} >= ?)
            GROUP BY l.ITEM_CODE
           HAVING PEND > 0`,
          [lpoFrom]
        );
        oo.forEach((r) => { get(t(r.ITEM_CODE)).onOrder = n3(r.PEND); });
      } catch (e) { console.error('reorder on-order:', e.message); }

      // keep items that matter: stock, usage, on order, or levels set
      const items = Object.values(map).filter((it) => it.stock !== 0 || it.used > 0 || it.onOrder > 0 || it.min || it.max);
      const codes = items.map((it) => it.itemCode);

      // names / part no
      const names = {};
      if (codes.length) {
        try {
          const [nm] = await db.query('SELECT ITEM_CODE, ITEM_NAME1, ARTICLE_CODE FROM item_mst WHERE ITEM_CODE IN (?)', [codes]);
          nm.forEach((r) => { names[t(r.ITEM_CODE)] = { name: r.ITEM_NAME1 || '', part: r.ARTICLE_CODE || '' }; });
        } catch (e) { /* optional */ }
      }

      // last supplier + rate from the latest SRV line of each item
      const last = {};
      if (codes.length) {
        const supOk = await hasCol(db, 'srv_hdr', 'SUP_CODE');
        try {
          const [ls] = await db.query(
            `SELECT s.ITEM_CODE, s.COST, s.SRV_DATE, s.SRV_NO ${supOk ? ', h.SUP_CODE, m.SUP_NAME' : ''}
               FROM srv_items s
               JOIN (SELECT ITEM_CODE, MAX(srno_row_id) AS R FROM srv_items
                      WHERE ITEM_CODE IN (?) AND IFNULL(COST, 0) > 0 GROUP BY ITEM_CODE) x
                 ON x.R = s.srno_row_id
               ${supOk ? 'LEFT JOIN srv_hdr h ON h.SRV_NO = s.SRV_NO LEFT JOIN sup_mst m ON m.SUP_CODE = h.SUP_CODE' : ''}`,
            [codes]
          );
          ls.forEach((r) => {
            last[t(r.ITEM_CODE)] = {
              rate: Number(r.COST) || 0, date: dmy(r.SRV_DATE), srvNo: r.SRV_NO,
              supCode: t(r.SUP_CODE), supName: r.SUP_NAME || '',
            };
          });
        } catch (e) { console.error('reorder last supplier:', e.message); }
      }

      res.json({
        months, lpoMonths, defaultLead: DEFAULT_LEAD, levelsTable: levelsOk,
        items: items.map((it) => ({
          itemCode: it.itemCode, itemName: (names[it.itemCode] || {}).name || '', partNo: (names[it.itemCode] || {}).part || '',
          stock: it.stock, onOrder: it.onOrder, usedInPeriod: it.used, usePerMonth: n3(it.used / months),
          min: it.min ?? 0, max: it.max ?? 0, lead: it.lead ?? null, pack: it.pack ?? null,
          lastRate: (last[it.itemCode] || {}).rate || 0, lastDate: (last[it.itemCode] || {}).date || '',
          lastSrvNo: (last[it.itemCode] || {}).srvNo || '',
          supCode: (last[it.itemCode] || {}).supCode || '', supName: (last[it.itemCode] || {}).supName || '',
        })).sort((a, b) => a.itemCode.localeCompare(b.itemCode)),
      });
    } catch (err) {
      console.error('reorder error:', err);
      res.status(500).json({ error: 'Failed to load reorder data', detail: err.message });
    }
  });

  router.put('/reorder/levels', async (req, res) => {
    const levels = Array.isArray(req.body && req.body.levels) ? req.body.levels : [];
    if (!levels.length) return res.status(400).json({ error: 'Nothing to save' });
    const bad = levels.find((l) => !t(l.itemCode) || Number(l.min) < 0 || Number(l.max) < 0 || (Number(l.max) && Number(l.max) < Number(l.min)));
    if (bad) return res.status(400).json({ error: `Check the levels for ${t(bad.itemCode) || '(blank item)'}: Max must be ≥ Min and neither negative` });
    const user = t((req.user && (req.user.username || req.user.userName || req.user.USER_NAME)) || req.headers['x-user'] || '').slice(0, 30) || null;
    const conn = await connection.promise().getConnection();
    try {
      await conn.query('START TRANSACTION');
      for (const l of levels) {
        await conn.execute(
          `INSERT INTO item_reorder (ITEM_CODE, MIN_QTY, MAX_QTY, LEAD_DAYS, PACK_QTY, CREATED_BY)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE MIN_QTY = VALUES(MIN_QTY), MAX_QTY = VALUES(MAX_QTY),
             LEAD_DAYS = VALUES(LEAD_DAYS), PACK_QTY = VALUES(PACK_QTY),
             LAST_EDITED_BY = ?, LAST_EDITED_ON = NOW()`,
          [t(l.itemCode), n3(l.min), n3(l.max),
            l.lead == null || l.lead === '' ? null : Math.max(0, parseInt(l.lead, 10) || 0),
            l.pack == null || l.pack === '' ? null : Math.max(0, n3(l.pack)), user, user]
        );
      }
      await conn.query('COMMIT');
      res.json({ saved: levels.length });
    } catch (err) {
      await conn.query('ROLLBACK').catch(() => {});
      console.error('reorder save error:', err);
      const missing = /doesn't exist/i.test(err.message);
      res.status(500).json({
        error: missing ? 'Table item_reorder is missing — run sql/item_reorder.sql first' : 'Failed to save levels',
        detail: err.message,
      });
    } finally {
      conn.release();
    }
  });

  return router;
};
