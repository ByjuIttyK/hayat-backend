/**
 * Store Issue Voucher save — POST /api/save-siv
 * Screen: SivEnt.tsx
 *
 * Registration in HayatDb.js (remove the old inline app.post("/api/save-siv")):
 *   const saveSivRoutes = require('./routes/saveSivRoutes');
 *   app.use('/api', saveSivRoutes(connection));
 *
 * Multi-user safety
 *   ADD  — the header is claimed with a plain INSERT. If the SIV No is already
 *          taken, the next free number is allocated (last SIV_NO locked FOR
 *          UPDATE) and the claim repeats. The number actually used is returned.
 *   EDIT — the header row is locked FOR UPDATE before the lines are changed,
 *          so concurrent saves of the same SIV run one after the other.
 *   Deadlock / lock-wait timeout — the whole save is rolled back and retried.
 *
 * netData.Mode: 'ADD' for a new SIV, 'EDIT' for an existing one.
 * Without Mode, an existing SIV is updated and a missing one is inserted.
 *
 * G/L posting (tran_acc, TRAN_TYPE 21) — inside the same transaction:
 *   Dr 126-001-<JOB_NO>-1   W.I.P Material Cost A/c
 *   Cr 121-101-0-002        Inventory A/c
 *   VCHR_NO = SIV_NO, DATTE = SIV_DATE, NARRATION1 = panel description (80),
 *   NARRATION2 = narration, JOB_NO, PANEL_NO, AMOUNT = net amount.
 *   On every save the old type-21 rows for the SIV are deleted and re-posted.
 *
 * BOQ scan fields (Nov 2026) — need the siv_hdr ALTER in SIV_BOQ_SCAN_SETUP.md:
 *   siv_hdr  : CUST_CODE, PANEL_QTY, DWG_NO, REV_NO, DWG_DATE, QUOT_NO,
 *              BOQ_PANEL_REF, PROJECT, DRAWN_BY, CHECKED_BY, APPROVED_BY
 *   siv_items: PART_NO, MANUFACTURER, BOQ_ITEM_DESC
 */

const express = require('express');

const MAX_ATTEMPTS = 4;
const MAX_CLAIMS = 10;

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

// Header columns after SIV_NO, in the order of hdrFields below. The BOQ /
// drawing columns (PANEL_QTY … APPROVED_BY) are filled by the AI Scan BOQ.
const HDR_COLS = [
  'SIV_DATE', 'JOB_NO', 'PANEL_NO', 'CUST_CODE', 'NARRATION', 'SIV_TYPE', 'TOTAL_COST',
  'PANEL_QTY', 'DWG_NO', 'REV_NO', 'DWG_DATE', 'QUOT_NO', 'BOQ_PANEL_REF',
  'PROJECT', 'DRAWN_BY', 'CHECKED_BY', 'APPROVED_BY',
];

const HDR_INSERT = `
  INSERT INTO siv_hdr (SIV_NO, ${HDR_COLS.join(', ')})
  VALUES (?, ${HDR_COLS.map(() => '?').join(', ')})`;

const HDR_UPDATE = `
  UPDATE siv_hdr
     SET ${HDR_COLS.map((c) => `${c}=?`).join(', ')}
   WHERE SIV_NO=?`;

const ITEMS_UPSERT = `
  INSERT INTO siv_items
    (SIV_NO, SIV_DATE, JOB_NO, PANEL_NO, SR_NO, ITEM_CODE, QTY, STD_COST,
     PART_NO, MANUFACTURER, BOQ_ITEM_DESC)
  VALUES ?
  ON DUPLICATE KEY UPDATE
    SIV_DATE      = VALUES(SIV_DATE),
    JOB_NO        = VALUES(JOB_NO),
    PANEL_NO      = VALUES(PANEL_NO),
    ITEM_CODE     = VALUES(ITEM_CODE),
    QTY           = VALUES(QTY),
    STD_COST      = VALUES(STD_COST),
    PART_NO       = VALUES(PART_NO),
    MANUFACTURER  = VALUES(MANUFACTURER),
    BOQ_ITEM_DESC = VALUES(BOQ_ITEM_DESC)`;

// Trimmed text cut to the column width; blank → NULL.
const str = (v, n) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, n) : null;
};

// ---- G/L posting ----------------------------------------------------------
const SIV_TRAN_TYPE = '21';
const INVENTORY_AC  = '121-101-0-002';
const wipAc = (jobNo) => `126-001-${jobNo}-1`;

const ACC_DELETE = 'DELETE FROM tran_acc WHERE VCHR_NO = ? AND TRAN_TYPE = ?';

const ACC_INSERT = `
  INSERT INTO tran_acc
    (VCHR_NO, SR_NO, DATTE, TRAN_TYPE, ACC_CODE, DB_CR, AMOUNT, NARRATION1, NARRATION2, JOB_NO, PANEL_NO)
  VALUES ?`;

// Panel description when the screen doesn't send it. Adjust the column name if
// job_panels keeps the description under a different column.
const PANEL_DESC_SQL =
  'SELECT PANEL_REF  AS PANEL_DESC FROM job_panels WHERE JOB_NO = ? AND SR_NO = ? LIMIT 1';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Re-posts the SIV's Dr WIP / Cr Inventory pair. Call inside the transaction. */
async function postSivAccounts(conn, { sivNo, sivDate, jobNo, panelNo, panelDesc, narration, amount }) {
  await q(conn, ACC_DELETE, [sivNo, SIV_TRAN_TYPE]);

  const amt = round2(amount);
  if (amt === 0) return;                       // nothing to post
  if (!jobNo) throw new ConflictError('Job No is required to post the SIV to W.I.P');

  let desc = String(panelDesc ?? '').trim();
  if (!desc && panelNo) {
    const r = await q(conn, PANEL_DESC_SQL, [jobNo, panelNo]);
    desc = r.length ? String(r[0].PANEL_DESC ?? '').trim() : '';
  }
  const narr1 = desc.slice(0, 80) || null;
  const narr2 = narration ? String(narration).trim() || null : null;

  // SR_NO is varchar(4) NOT NULL: '001', '002', ...
  const lines = [
    [wipAc(jobNo), 'D'],
    [INVENTORY_AC, 'C'],
  ];
  const rows = lines.map(([acc, dbCr], i) => [
    sivNo, String(i + 1).padStart(3, '0'), sivDate, SIV_TRAN_TYPE,
    acc, dbCr, amt, narr1, narr2, jobNo, panelNo,
  ]);

  await q(conn, ACC_INSERT, [rows]);
}

/** Next SIV No after the highest one on file, same zero-padded width. */
async function nextSivNo(conn, width) {
  const rows = await q(conn, 'SELECT SIV_NO FROM siv_hdr ORDER BY SIV_NO DESC LIMIT 1 FOR UPDATE');
  const last = rows.length ? String(rows[0].SIV_NO).trim() : '0';
  if (!/^\d+$/.test(last)) throw new ConflictError(`Cannot allocate next SIV No after "${last}"`);
  return String(Number(last) + 1).padStart(Math.max(width, last.length), '0');
}

module.exports = function (connection) {
  const router = express.Router();

  router.post('/save-siv', (req, res) => {
    const { netData, itemsData } = req.body || {};
    if (!netData || !Array.isArray(itemsData) || itemsData.length === 0) {
      return res.status(400).json({ message: 'Invalid SIV data format' });
    }

    const clientSivNo = String(netData.SivNo ?? '').trim();
    if (!clientSivNo) {
      return res.status(400).json({ message: 'SIV No is required' });
    }

    const mode = String(netData.Mode || '').toUpperCase();

    // Rows without SR_NO can't be told apart from deleted ones, so pruning is skipped.
    const keepSrNos = itemsData.map((r) => (r.SR_NO == null ? '' : String(r.SR_NO).trim()));
    const canPrune = keepSrNos.every((s) => s !== '');
    if (!canPrune) console.warn('[save-siv] line without SR_NO — removed rows not pruned', { clientSivNo });

    // siv_hdr.SIV_TYPE is varchar(1): 'M' materials, 'C' consumables (no panel).
    const sivType = String(netData.SivType || 'M').toUpperCase().charAt(0);
    const panelNo = sivType === 'C' ? null : (String(netData.PanelNo ?? '').trim() || null);
    // Job No and Panel No are kept on siv_items too — the Job Card's Store Issues tab reads them there.
    const jobNo = String(netData.JobNo ?? '').trim() || null;
    // Same order as HDR_COLS. The screen sends CustCode (CustCd kept for any
    // older caller).
    const panelQty = Math.max(1, parseInt(netData.PanelQty, 10) || 1);
    const hdrFields = [
      netData.SivDt, jobNo, panelNo, str(netData.CustCode ?? netData.CustCd, 9),
      netData.Narration ?? null, sivType, netData.Amount ?? null,
      panelQty,
      str(netData.DwgNo, 30),
      str(netData.RevNo, 5),
      netData.DwgDate || null,                 // yyyy-MM-dd from the screen
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
          await q(conn, HDR_INSERT, [sivNo, ...hdrFields]);
          return sivNo;
        } catch (e) {
          if (!isDup(e)) throw e;
          if (mode !== 'ADD') throw new ConflictError(`SIV No ${sivNo} was just created by another user — please reload it`);
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
        if (rows.length) {
          sivNo = clientSivNo;
          await q(conn, HDR_UPDATE, [...hdrFields, sivNo]);
        } else if (mode === 'EDIT') {
          throw new ConflictError(`SIV ${clientSivNo} no longer exists`);
        } else {
          sivNo = await claim(conn);
        }
      }

      // Delete before upsert so an SR_NO reused in this save isn't deleted again.
      if (canPrune) {
        await q(conn, 'DELETE FROM siv_items WHERE SIV_NO = ? AND SR_NO NOT IN (?)', [sivNo, keepSrNos]);
      } else if (sivNo !== clientSivNo) {
        await q(conn, 'DELETE FROM siv_items WHERE SIV_NO = ?', [sivNo]);
      }

      const values = itemsData.map((row) => [
        sivNo, netData.SivDt, jobNo, panelNo, row.SR_NO, row.ITEM_CODE, row.QTY, row.STD_COST,
        str(row.PART_NO, 30), str(row.MANUFACTURER, 40), str(row.BOQ_ITEM_DESC, 300),
      ]);
      await q(conn, ITEMS_UPSERT, [values]);

      // Net amount: header total, else the sum of the lines.
      const netAmt = netData.Amount != null && netData.Amount !== ''
        ? netData.Amount
        : itemsData.reduce((s, r) => s + (Number(r.QTY) || 0) * (Number(r.STD_COST) || 0), 0);

      await postSivAccounts(conn, {
        sivNo,
        sivDate:   netData.SivDt,
        jobNo,
        panelNo,
        panelDesc: netData.PanelDesc,
        narration: netData.Narration,
        amount:    netAmt,
      });

      await commit(conn);
      return sivNo;
    };

    connection.getConnection(async (err, conn) => {
      if (err) {
        console.error('[save-siv] getConnection:', err);
        return res.status(500).json({ message: 'Error getting connection' });
      }

      try {
        for (let attempt = 1; ; attempt++) {
          try {
            const sivNo = await saveOnce(conn);
            return res.json({ message: 'S.I.V saved successfully!', sivNo });
          } catch (error) {
            await rollback(conn);
            if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) throw error;
            console.warn(`[save-siv] attempt ${attempt} hit ${error.code}, retrying`);
            await sleep(40 * attempt + Math.floor(Math.random() * 60));
          }
        }
      } catch (error) {
        console.error('[save-siv] failed, rolled back:', error);
        if (error instanceof ConflictError) {
          return res.status(409).json({ message: error.message });
        }
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
