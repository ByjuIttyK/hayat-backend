/**
 * Store Issue Voucher (BOQ) save — POST /api/save-sivboq
 * Screen: SivEntBoq.tsx   (SivEnt.tsx keeps using /api/save-siv, untouched)
 *
 * Registration in HayatDb.js (next to saveSivRoutes):
 *   const saveSivBoqRoutes = require('./routes/saveSivBoqRoutes');
 *   app.use('/api', saveSivBoqRoutes(connection));
 *
 * Same rules as save-siv:
 *   ADD  — header claimed with a plain INSERT; on a duplicate SIV No the next
 *          free number is taken (last SIV_NO locked FOR UPDATE) and the claim
 *          repeats. The number actually used is returned as sivNo.
 *   EDIT — header locked FOR UPDATE, then updated; lines pruned + upserted.
 *   Deadlock / lock-wait timeout — whole save rolled back and retried.
 *
 * G/L (tran_acc, TRAN_TYPE 21), same transaction:
 *   Dr 126-001-<JOB_NO>-1  W.I.P Material Cost A/c
 *   Cr 121-101-0-002       Inventory A/c
 *
 * Saved in addition to the plain SIV:
 *   siv_hdr  : CUST_CODE, PANEL_QTY, DWG_NO, REV_NO, DWG_DATE, QUOT_NO,
 *              BOQ_PANEL_REF, PROJECT, DRAWN_BY, CHECKED_BY, APPROVED_BY,
 *              SIV_TYPE ('M' / 'C', or 'B' for a BOQ-scanned SIV), LOC_CODE, CREATED_BY / LAST_EDITED_BY / LAST_EDITED_ON
 *   siv_items: PART_NO, MANUFACTURER, BOQ_ITEM_DESC, LOC_CODE, JOB_NO, PANEL_NO
 */

const express = require('express');

const MAX_ATTEMPTS = 4;
const MAX_CLAIMS = 10;
const LOC_CODE = '01';                 // stock is kept in location 01 only

const q = (conn, sql, params) =>
  new Promise((resolve, reject) =>
    conn.query(sql, params, (err, result) => (err ? reject(err) : resolve(result))));

const begin    = (conn) => new Promise((ok, ko) => conn.beginTransaction((e) => (e ? ko(e) : ok())));
const commit   = (conn) => new Promise((ok, ko) => conn.commit((e) => (e ? ko(e) : ok())));
const rollback = (conn) => new Promise((ok) => conn.rollback(() => ok()));
const sleep    = (ms) => new Promise((r) => setTimeout(r, ms));

const isRetryable = (e) =>
  !!e && (e.code === 'ER_LOCK_DEADLOCK' || e.code === 'ER_LOCK_WAIT_TIMEOUT' || e.errno === 1213 || e.errno === 1205);
const isDup = (e) => !!e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062);

class ConflictError extends Error {}

// Trimmed text cut to the column width; blank → NULL.
const str = (v, n) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, n) : null;
};
const num = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
// yyyy-MM-dd only; anything else → NULL rather than a bad datetime.
const isoDate = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? '').trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

// Logged-in user from the JWT middleware. Adjust the property to whatever
// your auth middleware puts on req.user.
const userOf = (req) =>
  str(req.user?.username ?? req.user?.USER_NAME ?? req.user?.user_name ?? req.body?.netData?.UserName, 30);

// ---- header -----------------------------------------------------------------
// Columns written on both ADD and EDIT, in the order of hdrFields below.
const HDR_COLS = [
  'SIV_DATE', 'LOC_CODE', 'JOB_NO', 'PANEL_NO', 'CUST_CODE', 'NARRATION', 'SIV_TYPE', 'TOTAL_COST',
  'PANEL_QTY', 'DWG_NO', 'REV_NO', 'DWG_DATE', 'QUOT_NO', 'BOQ_PANEL_REF',
  'PROJECT', 'DRAWN_BY', 'CHECKED_BY', 'APPROVED_BY',
];

const HDR_INSERT = `
  INSERT INTO siv_hdr (SIV_NO, ${HDR_COLS.join(', ')}, CREATED_BY)
  VALUES (?, ${HDR_COLS.map(() => '?').join(', ')}, ?)`;

const HDR_UPDATE = `
  UPDATE siv_hdr
     SET ${HDR_COLS.map((c) => `${c}=?`).join(', ')},
         LAST_EDITED_BY = ?, LAST_EDITED_ON = NOW()
   WHERE SIV_NO=?`;

// ---- lines ------------------------------------------------------------------
const ITEMS_UPSERT = `
  INSERT INTO siv_items
    (SIV_NO, SIV_DATE, SR_NO, LOC_CODE, ITEM_CODE, PART_NO, MANUFACTURER,
     QTY, STD_COST, JOB_NO, PANEL_NO, BOQ_ITEM_DESC)
  VALUES ?
  ON DUPLICATE KEY UPDATE
    SIV_DATE      = VALUES(SIV_DATE),
    LOC_CODE      = VALUES(LOC_CODE),
    ITEM_CODE     = VALUES(ITEM_CODE),
    PART_NO       = VALUES(PART_NO),
    MANUFACTURER  = VALUES(MANUFACTURER),
    QTY           = VALUES(QTY),
    STD_COST      = VALUES(STD_COST),
    JOB_NO        = VALUES(JOB_NO),
    PANEL_NO      = VALUES(PANEL_NO),
    BOQ_ITEM_DESC = VALUES(BOQ_ITEM_DESC)`;

// ---- G/L posting ------------------------------------------------------------
const SIV_TRAN_TYPE = '21';
const INVENTORY_AC  = '121-101-0-002';
const wipAc = (jobNo) => `126-001-${jobNo}-1`;

const ACC_DELETE = 'DELETE FROM tran_acc WHERE VCHR_NO = ? AND TRAN_TYPE = ?';
const ACC_INSERT = `
  INSERT INTO tran_acc
    (VCHR_NO, SR_NO, DATTE, TRAN_TYPE, ACC_CODE, DB_CR, AMOUNT, NARRATION1, NARRATION2, JOB_NO, PANEL_NO)
  VALUES ?`;
const PANEL_DESC_SQL =
  'SELECT PANEL_REF AS PANEL_DESC FROM job_panels WHERE JOB_NO = ? AND SR_NO = ? LIMIT 1';

async function postSivAccounts(conn, { sivNo, sivDate, jobNo, panelNo, panelDesc, narration, amount }) {
  await q(conn, ACC_DELETE, [sivNo, SIV_TRAN_TYPE]);

  const amt = round2(amount);
  if (amt === 0) return;
  if (!jobNo) throw new ConflictError('Job No is required to post the SIV to W.I.P');

  let desc = String(panelDesc ?? '').trim();
  if (!desc && panelNo) {
    const r = await q(conn, PANEL_DESC_SQL, [jobNo, panelNo]);
    desc = r.length ? String(r[0].PANEL_DESC ?? '').trim() : '';
  }
  const narr1 = desc.slice(0, 80) || null;
  const narr2 = str(narration, 60);

  const rows = [[wipAc(jobNo), 'D'], [INVENTORY_AC, 'C']].map(([acc, dbCr], i) => [
    sivNo, String(i + 1).padStart(3, '0'), sivDate, SIV_TRAN_TYPE,
    acc, dbCr, amt, narr1, narr2, jobNo, panelNo,
  ]);
  await q(conn, ACC_INSERT, [rows]);
}

async function nextSivNo(conn, width) {
  const rows = await q(conn, 'SELECT SIV_NO FROM siv_hdr ORDER BY SIV_NO DESC LIMIT 1 FOR UPDATE');
  const last = rows.length ? String(rows[0].SIV_NO).trim() : '0';
  if (!/^\d+$/.test(last)) throw new ConflictError(`Cannot allocate next SIV No after "${last}"`);
  return String(Number(last) + 1).padStart(Math.max(width, last.length), '0');
}

module.exports = function (connection) {
  const router = express.Router();

  // ---- Load: header (EDIT / VIEW) -------------------------------------------
  // Dates as yyyy-MM-dd so the screen's parseApiDate reads them without
  // guessing the year. AMOUNT is TOTAL_COST under the name the screen uses.
  router.get('/sivboqhdr/:siv', (req, res) => {
    connection.query(
      `SELECT a.SIV_NO,
              DATE_FORMAT(a.SIV_DATE, '%Y-%m-%d') AS SIV_DATE,
              a.SIV_TYPE, a.JOB_NO, a.PANEL_NO, a.NARRATION,
              a.TOTAL_COST AS AMOUNT,
              a.CUST_CODE, b.CUST_NAME,
              a.PANEL_QTY, a.DWG_NO, a.REV_NO,
              DATE_FORMAT(a.DWG_DATE, '%Y-%m-%d') AS DWG_DATE,
              a.QUOT_NO, a.BOQ_PANEL_REF, a.PROJECT,
              a.DRAWN_BY, a.CHECKED_BY, a.APPROVED_BY,
              a.CREATED_BY,
              DATE_FORMAT(a.CREATED_ON,     '%Y-%m-%d %H:%i:%s') AS CREATED_ON,
              a.LAST_EDITED_BY,
              DATE_FORMAT(a.LAST_EDITED_ON, '%Y-%m-%d %H:%i:%s') AS LAST_EDITED_ON
         FROM siv_hdr a
    LEFT JOIN cus_mst b ON b.CUST_CODE = a.CUST_CODE
        WHERE a.SIV_NO = ?`,
      [req.params.siv],
      (err, rows) => {
        if (err) {
          console.error('[sivboqhdr]', err);
          return res.status(500).json({ error: err.sqlMessage || err.message });
        }
        res.json(rows);
      }
    );
  });

  // ---- Load: lines (EDIT / VIEW) --------------------------------------------
  // STD_COST is the rate saved with the SIV (what was posted to the G/L);
  // average cost on the SIV date only where none was saved. Part No is the
  // one saved from the BOQ, else the item master's ARTICLE_CODE.
  router.get('/sivboqitems/:siv', (req, res) => {
    connection.query(
      `SELECT a.SIV_NO,
              a.SR_NO,
              a.LOC_CODE,
              a.ITEM_CODE,
              i.ITEM_NAME1,
              COALESCE(NULLIF(TRIM(a.PART_NO), ''), i.ARTICLE_CODE) AS PART_NO,
              a.MANUFACTURER,
              a.BOQ_ITEM_DESC,
              a.QTY,
              COALESCE(a.STD_COST, AVGCOST('01', a.ITEM_CODE, h.SIV_DATE), 0) AS STD_COST,
              ROUND(a.QTY * COALESCE(a.STD_COST, AVGCOST('01', a.ITEM_CODE, h.SIV_DATE), 0), 2) AS AMOUNT
         FROM siv_items a
         JOIN siv_hdr   h ON h.SIV_NO    = a.SIV_NO
    LEFT JOIN item_mst  i ON i.ITEM_CODE = a.ITEM_CODE
        WHERE a.SIV_NO = ?
     ORDER BY CAST(a.SR_NO AS UNSIGNED)`,
      [req.params.siv],
      (err, rows) => {
        if (err) {
          console.error('[sivboqitems]', err);
          return res.status(500).json({ error: err.sqlMessage || err.message });
        }
        res.json(rows);
      }
    );
  });

  router.post('/save-sivboq', (req, res) => {
    const { netData, itemsData } = req.body || {};
    if (!netData || !Array.isArray(itemsData)) {
      return res.status(400).json({ message: 'Invalid SIV data format' });
    }

    const clientSivNo = String(netData.SivNo ?? '').trim();
    if (!clientSivNo) return res.status(400).json({ message: 'SIV No is required' });

    const sivDate = isoDate(netData.SivDt);
    if (!sivDate) return res.status(400).json({ message: 'SIV Date is missing or invalid' });

    const mode = String(netData.Mode || '').toUpperCase();
    if (mode !== 'ADD' && mode !== 'EDIT') {
      return res.status(400).json({ message: 'Mode must be ADD or EDIT' });
    }

    // Only lines with an item and a qty are saved.
    const lines = itemsData.filter((r) => String(r.ITEM_CODE ?? '').trim() && num(r.QTY) > 0);
    if (lines.length === 0) return res.status(400).json({ message: 'No item lines to save' });

    const keepSrNos = lines.map((r) => String(r.SR_NO ?? '').trim());
    if (keepSrNos.some((s) => !s)) return res.status(400).json({ message: 'Every line needs a Sr No' });
    if (new Set(keepSrNos).size !== keepSrNos.length) {
      return res.status(400).json({ message: 'Duplicate Sr No in the lines' });
    }

    // SIV_TYPE: 'C' consumables, 'B' materials filled by the AI BOQ scan,
    // 'M' other materials. 'B' follows the materials rules (panel required).
    const typeIn   = String(netData.SivType || 'M').trim().toUpperCase().charAt(0);
    const sivType  = typeIn === 'C' ? 'C' : typeIn === 'B' ? 'B' : 'M';
    const jobNo    = str(netData.JobNo, 10);
    const panelNo  = sivType === 'C' ? null : str(netData.PanelNo, 4);
    const panelQty = Math.min(9999, Math.max(1, parseInt(netData.PanelQty, 10) || 1));
    const user     = userOf(req);

    if (!jobNo) return res.status(400).json({ message: 'Job No is required' });
    if (sivType !== 'C' && !panelNo) return res.status(400).json({ message: 'Panel No is required for a Materials issue' });

    // Net amount always from the lines, so header, lines and G/L agree.
    const netAmt = round2(lines.reduce((s, r) => s + num(r.QTY) * num(r.STD_COST), 0));

    const hdrFields = [
      sivDate, LOC_CODE, jobNo, panelNo, str(netData.CustCode, 9),
      str(netData.Narration, 60), sivType, netAmt,
      panelQty,
      str(netData.DwgNo, 30),
      str(netData.RevNo, 5),
      isoDate(netData.DwgDate),
      str(netData.QuotNo, 10),
      str(netData.BoqPanelRef, 100),
      str(netData.Project, 150),
      str(netData.DrawnBy, 30),
      str(netData.CheckedBy, 30),
      str(netData.ApprovedBy, 30),
    ];

    const claim = async (conn) => {
      let sivNo = clientSivNo;
      for (let i = 0; i < MAX_CLAIMS; i++) {
        try {
          await q(conn, HDR_INSERT, [sivNo, ...hdrFields, user]);
          return sivNo;
        } catch (e) {
          if (!isDup(e)) throw e;
          sivNo = await nextSivNo(conn, clientSivNo.length);
        }
      }
      throw new ConflictError('Could not allocate a free SIV No — please try Save again');
    };

    const saveOnce = async (conn) => {
      await begin(conn);

      let sivNo;
      if (mode === 'ADD') {
        sivNo = await claim(conn);
      } else {
        const rows = await q(conn, 'SELECT SIV_NO FROM siv_hdr WHERE SIV_NO=? FOR UPDATE', [clientSivNo]);
        if (!rows.length) throw new ConflictError(`SIV ${clientSivNo} no longer exists`);
        sivNo = clientSivNo;
        await q(conn, HDR_UPDATE, [...hdrFields, user, sivNo]);
      }

      // Lines removed on screen go; the rest are upserted on (SIV_NO, SR_NO).
      await q(conn, 'DELETE FROM siv_items WHERE SIV_NO = ? AND SR_NO NOT IN (?)', [sivNo, keepSrNos]);

      const values = lines.map((r) => [
        sivNo, sivDate, String(r.SR_NO).trim().slice(0, 4), LOC_CODE,
        str(r.ITEM_CODE, 20), str(r.PART_NO, 30), str(r.MANUFACTURER, 40),
        num(r.QTY), num(r.STD_COST), jobNo, panelNo, str(r.BOQ_ITEM_DESC, 300),
      ]);
      await q(conn, ITEMS_UPSERT, [values]);

      await postSivAccounts(conn, {
        sivNo, sivDate, jobNo, panelNo,
        panelDesc: netData.PanelDesc,
        narration: netData.Narration,
        amount:    netAmt,
      });

      await commit(conn);
      return sivNo;
    };

    connection.getConnection(async (err, conn) => {
      if (err) {
        console.error('[save-sivboq] getConnection:', err);
        return res.status(500).json({ message: 'Error getting connection' });
      }
      try {
        for (let attempt = 1; ; attempt++) {
          try {
            const sivNo = await saveOnce(conn);
            return res.json({
              message: 'S.I.V saved successfully!',
              sivNo,
              renumbered: sivNo !== clientSivNo,
              totalCost: netAmt,
            });
          } catch (error) {
            await rollback(conn);
            if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) throw error;
            console.warn(`[save-sivboq] attempt ${attempt} hit ${error.code}, retrying`);
            await sleep(40 * attempt + Math.floor(Math.random() * 60));
          }
        }
      } catch (error) {
        console.error('[save-sivboq] failed, rolled back:', error);
        if (error instanceof ConflictError) return res.status(409).json({ message: error.message });
        const busy = isRetryable(error);
        res.status(busy ? 409 : 500).json({
          message: busy
            ? 'Another user is saving an SIV right now — please try Save again.'
            : 'SIV save failed, rolled back',
          error: error && error.message ? error.message : error,
        });
      } finally {
        conn.release();
      }
    });
  });

  return router;
};
