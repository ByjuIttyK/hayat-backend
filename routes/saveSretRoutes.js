/**
 * Sales Return save — POST /api/save-sret
 * Screen: Salret.tsx
 *
 * Registration in HayatDb.js (remove the old inline app.post("/api/save-sret")):
 *   const saveSretRoutes = require('./routes/saveSretRoutes');
 *   app.use('/api', saveSretRoutes(connection));
 *
 * G/L posting (TRAN_TYPE '08') and invoice settlement (adj_dtl) use postSret()
 * from routes/sretPosting.js:  Dr Sales A/c (DR_CODE) Gross, Dr VAT on Sales VAT,
 * Cr Customer Net;
 * adj_dtl settles the Inv.No (STLD_TYPE '06') with the Net Amount.
 *
 * Multi-user safety
 *   ADD  — the header is claimed with a plain INSERT. If the Return No is
 *          already taken, the next free number is allocated (last SRET_NO
 *          locked FOR UPDATE) and the claim repeats. The number used is returned.
 *   EDIT — the header row is locked FOR UPDATE before the lines are changed,
 *          so concurrent saves of the same return run one after the other.
 *   Deadlock / lock-wait timeout — the whole save is rolled back and retried.
 *
 * sretNet.Mode: 'ADD' for a new return, 'EDIT' for an existing one.
 * Without Mode, an existing return is updated and a missing one is inserted.
 */

const express = require('express');
const { postSret } = require('./sretPosting');

const MAX_ATTEMPTS = 4;
const MAX_CLAIMS = 10;

const q = (conn, sql, params) =>
  new Promise((resolve, reject) =>
    conn.query(sql, params, (err, result) => (err ? reject(err) : resolve(result))));

const begin    = (conn) => new Promise((ok, ko) => conn.beginTransaction((e) => (e ? ko(e) : ok())));
const commit   = (conn) => new Promise((ok, ko) => conn.commit((e) => (e ? ko(e) : ok())));
const rollback = (conn) => new Promise((ok) => conn.rollback(() => ok()));
const sleep    = (ms) => new Promise((r) => setTimeout(r, ms));
/** Same connection (same transaction), in the [rows] shape sretPosting.js expects. */
const asPromiseConn = (conn) => ({ query: (sql, params) => q(conn, sql, params).then((r) => [r]) });

const isRetryable = (e) =>
  !!e && (e.code === 'ER_LOCK_DEADLOCK' || e.code === 'ER_LOCK_WAIT_TIMEOUT' || e.errno === 1213 || e.errno === 1205);
const cut = (v, n) => { const s = String(v ?? '').trim(); return s ? s.slice(0, n) : null; };
const isDup = (e) => !!e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062);

class ConflictError extends Error {}

const HDR_INSERT = `
  INSERT INTO sret_hdr
    (SRET_NO, SRET_DATE, INV_NO, JOB_NO,CUST_CODE, DR_CODE, NARRATION1, NARRATION2, SMAN_CODE, DISCOUNT, AMOUNT,
     PROJECT_DETAILS)
  VALUES (?, ?, ?, ?,?, ?, ?, ?, ?, ?, ?, ?)`;

const HDR_UPDATE = `
  UPDATE sret_hdr
     SET SRET_DATE=?, INV_NO=?, JOB_NO=?,CUST_CODE=?, DR_CODE=?, NARRATION1=?, NARRATION2=?,
         SMAN_CODE=?, DISCOUNT=?, AMOUNT=?, PROJECT_DETAILS=?
   WHERE SRET_NO=?`;

const ITEMS_UPSERT = `
  INSERT INTO sret_items (SRET_NO, SRET_DATE, SR_NO, ITEM_CODE, QTY, INV_RATE, VAT_PERC)
  VALUES ?
  ON DUPLICATE KEY UPDATE
    SRET_DATE = COALESCE(VALUES(SRET_DATE), SRET_DATE),
    ITEM_CODE = COALESCE(VALUES(ITEM_CODE), ITEM_CODE),
    QTY       = COALESCE(VALUES(QTY), QTY),
    INV_RATE  = COALESCE(VALUES(INV_RATE), INV_RATE),
    VAT_PERC  = COALESCE(VALUES(VAT_PERC), VAT_PERC)`;

/** Next Return No after the highest one on file, same zero-padded width. */
async function nextSretNo(conn, width) {
  const rows = await q(conn, 'SELECT SRET_NO FROM sret_hdr ORDER BY SRET_NO DESC LIMIT 1 FOR UPDATE');
  const last = rows.length ? String(rows[0].SRET_NO).trim() : '0';
  if (!/^\d+$/.test(last)) throw new ConflictError(`Cannot allocate next Return No after "${last}"`);
  return String(Number(last) + 1).padStart(Math.max(width, last.length), '0');
}

module.exports = function (connection) {
  const router = express.Router();

  router.post('/save-sret', (req, res) => {
    const { sretNet, sretItems } = req.body || {};
    if (!sretNet || !Array.isArray(sretItems) || sretItems.length === 0) {
      return res.status(400).json({ message: 'Invalid Sales Return data format' });
    }

    const clientSretNo = String(sretNet.SretNo ?? '').trim();
    if (!clientSretNo) {
      return res.status(400).json({ message: 'Sales Return No is required' });
    }

    const mode = String(sretNet.Mode || '').toUpperCase();

    // Rows without SR_NO can't be told apart from deleted ones, so pruning is skipped.
    const keepSrNos = sretItems.map((r) => (r.SR_NO == null ? '' : String(r.SR_NO).trim()));
    const canPrune = keepSrNos.every((s) => s !== '');
    if (!canPrune) console.warn('[save-sret] line without SR_NO — removed rows not pruned', { clientSretNo });

    const hdrFields = [
      sretNet.SretDt, sretNet.invNo ?? null,sretNet.JobNo ?? null, sretNet.CustCd ?? null, sretNet.AccCd ?? null,
      // NARRATION1 is varchar(40)
      cut(sretNet.Narration1 ?? sretNet.Narration, 40), sretNet.Narration2 ?? null, sretNet.SmanCd ?? null,
      sretNet.Discount ?? null, sretNet.TotAmt ?? null,
      cut(sretNet.ProjectDetails, 200),   // PROJECT_DETAILS — filled from fab_inv_hdr in saveOnce if empty
    ];
    const PROJ_IDX = hdrFields.length - 1;

    const claim = async (conn) => {
      let sretNo = clientSretNo;
      for (let i = 0; i < MAX_CLAIMS; i++) {
        try {
          await q(conn, HDR_INSERT, [sretNo, ...hdrFields]);
          return sretNo;
        } catch (e) {
          if (!isDup(e)) throw e;
          if (mode !== 'ADD') throw new ConflictError(`Sales Return ${sretNo} was just created by another user — please reload it`);
          sretNo = await nextSretNo(conn, clientSretNo.length);
        }
      }
      throw new ConflictError('Could not allocate a free Sales Return No — please try Save again');
    };

    const saveOnce = async (conn) => {
      await begin(conn);

      // Project details come from the invoice when the screen didn't send them
      const invNo = String(sretNet.invNo ?? '').trim();
      if (!hdrFields[PROJ_IDX] && invNo) {
        const inv = await q(conn, 'SELECT PROJECT_DETAIL FROM fab_inv_hdr WHERE INV_NO = ? LIMIT 1', [invNo]);
        hdrFields[PROJ_IDX] = cut(inv[0]?.PROJECT_DETAIL, 200);
      }

      let sretNo;
      if (mode === 'ADD') {
        sretNo = await claim(conn);
      } else {
        const rows = await q(conn, 'SELECT SRET_NO FROM sret_hdr WHERE SRET_NO=? FOR UPDATE', [clientSretNo]);
        if (rows.length) {
          sretNo = clientSretNo;
          await q(conn, HDR_UPDATE, [...hdrFields, sretNo]);
        } else if (mode === 'EDIT') {
          throw new ConflictError(`Sales Return ${clientSretNo} no longer exists`);
        } else {
          sretNo = await claim(conn);
        }
      }

      // Delete before upsert so an SR_NO reused in this save isn't deleted again.
      if (canPrune) {
        await q(conn, 'DELETE FROM sret_items WHERE SRET_NO = ? AND SR_NO NOT IN (?)', [sretNo, keepSrNos]);
      } else if (sretNo !== clientSretNo) {
        await q(conn, 'DELETE FROM sret_items WHERE SRET_NO = ?', [sretNo]);
      }

      const values = sretItems.map((row) => [
        sretNo, sretNet.SretDt, row.SR_NO, row.ITEM_CODE, row.QTY, row.INV_RATE, row.VAT_PERC,
      ]);
      await q(conn, ITEMS_UPSERT, [values]);

      // tran_acc (08): Dr Sales A/c / Cr Customer + adj_dtl settlement of the Inv.No — all Net Amount.
      // A posting error (e.g. no Debit A/c) is shown to the user as-is.
      try {
        await postSret(asPromiseConn(conn), {
          sretNo,
          sretDate: sretNet.SretDt,                       // yyyy-MM-dd from the screen
          custCode: sretNet.CustCd,
          salesAcc: sretNet.AccCd,                        // Debit A/c on the screen
          invNo: sretNet.invNo,
          jobNo: sretNet.JobNo,
          grossAmt: sretNet.grossAmt,                     // after discount
          vatAmt: sretNet.vatAmt,
          roundOff: sretNet.RoundOff,
          netAmt: sretNet.TotAmt,                         // Net Amount
          narration: hdrFields[5],                        // NARRATION1 as saved
          divCode: null,
        });
      } catch (e) {
        if (isRetryable(e) || e.code) throw e;            // DB errors keep their normal handling
        throw new ConflictError(e.message);
      }

      await commit(conn);
      return sretNo;
    };

    connection.getConnection(async (err, conn) => {
      if (err) {
        console.error('[save-sret] getConnection:', err);
        return res.status(500).json({ message: 'Error getting connection' });
      }

      try {
        for (let attempt = 1; ; attempt++) {
          try {
            const sretNo = await saveOnce(conn);
            return res.json({ message: 'Sales Return saved successfully!', sretNo });
          } catch (error) {
            await rollback(conn);
            if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) throw error;
            console.warn(`[save-sret] attempt ${attempt} hit ${error.code}, retrying`);
            await sleep(40 * attempt + Math.floor(Math.random() * 60));
          }
        }
      } catch (error) {
        console.error('[save-sret] failed, rolled back:', error);
        if (error instanceof ConflictError) {
          return res.status(409).json({ message: error.message });
        }
        const busy = isRetryable(error);
        res.status(busy ? 409 : 500).json({
          message: busy
            ? 'Another user is saving a Sales Return right now — please try Save again.'
            : 'Sales Return save failed, rolled back',
          error: error && error.message ? error.message : error,
        });
      } finally {
        conn.release();
      }
    });
  });

  return router;
};
