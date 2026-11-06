/**
 * Stores Receipt Voucher save — POST /api/save-srv
 * Screen: SrvEnt.tsx
 *
 * Registration in HayatDb.js (remove the old inline app.post("/api/save-srv")):
 *   const saveSrvRoutes = require('./routes/saveSrvRoutes');
 *   app.use('/api', saveSrvRoutes(connection));
 *
 * Multi-user safety
 *   ADD  — the header is claimed with a plain INSERT. If the SRV No is already
 *          taken, the next free number is allocated (last SRV_NO locked FOR
 *          UPDATE) and the claim repeats. The number actually used is returned.
 *   EDIT — the header row is locked FOR UPDATE before the lines are changed,
 *          so concurrent saves of the same SRV run one after the other.
 *   Deadlock / lock-wait timeout — the whole save is rolled back and retried.
 *
 * netData.Mode: 'ADD' for a new SRV, 'EDIT' for an existing one.
 * Without Mode, an existing SRV is updated and a missing one is inserted.
 *
 * Foreign SRV (SrvEntFP.tsx, 06-Nov-2026) — recognised by expData being sent
 * (the local SRV screen doesn't send it, so its saves are unchanged):
 *   srv_hdr   CURR_CODE, CONVERT_RATE, INV_AMT_FC, FREIGHT_FOB, INV_AMT_LOCAL,
 *             EXP_AMOUNT, EFF_RATE                  ← netData.CurrCd … EffRate
 *   srv_items COST_FC (Rate F.C); COST = Rate Local (Rate F.C × Eff. Rate)
 *   lcst_trn  the SRV's expense lines are replaced: DELETE by VCHR_NO, then
 *             INSERT the lines on screen (lcst_trn has no unique key on
 *             VCHR_NO + GIT_TYPE, so an upsert would only add rows)
 * All inside the same transaction — a failure rolls the expenses back too.
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

const HDR_INSERT = `
  INSERT INTO srv_hdr
    (SRV_NO, SRV_DATE, PO_NO, SUP_CODE, NARRATION, INV_NO, INV_DATE, INV_AMOUNT)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

const HDR_UPDATE = `
  UPDATE srv_hdr
     SET SRV_DATE=?, PO_NO=?, SUP_CODE=?, NARRATION=?, INV_NO=?, INV_DATE=?, INV_AMOUNT=?
   WHERE SRV_NO=?`;

const ITEMS_UPSERT = `
  INSERT INTO srv_items (SRV_NO, SRV_DATE, SR_NO, ITEM_CODE, QTY, COST)
  VALUES ?
  ON DUPLICATE KEY UPDATE
    SRV_DATE  = COALESCE(VALUES(SRV_DATE), SRV_DATE),
    ITEM_CODE = COALESCE(VALUES(ITEM_CODE), ITEM_CODE),
    QTY       = COALESCE(VALUES(QTY), QTY),
    COST      = COALESCE(VALUES(COST), COST)`;

// ── Foreign SRV ──────────────────────────────────────────────────────────
const HDR_FOREIGN_UPDATE = `
  UPDATE srv_hdr
     SET CURR_CODE=?, CONVERT_RATE=?, INV_AMT_FC=?, FREIGHT_FOB=?,
         INV_AMT_LOCAL=?, EXP_AMOUNT=?, EFF_RATE=?
   WHERE SRV_NO=?`;

// Rate F.C is written as sent (not COALESCE'd), so a cleared rate is cleared.
const ITEMS_UPSERT_FP = `
  INSERT INTO srv_items (SRV_NO, SRV_DATE, SR_NO, ITEM_CODE, QTY, COST, COST_FC)
  VALUES ?
  ON DUPLICATE KEY UPDATE
    SRV_DATE  = COALESCE(VALUES(SRV_DATE), SRV_DATE),
    ITEM_CODE = COALESCE(VALUES(ITEM_CODE), ITEM_CODE),
    QTY       = COALESCE(VALUES(QTY), QTY),
    COST      = COALESCE(VALUES(COST), COST),
    COST_FC   = VALUES(COST_FC)`;

const LCST_INSERT = `
  INSERT INTO lcst_trn (VCHR_NO, GIT_TYPE, AMOUNT, ACC_CODE)
  VALUES ?`;

/** Landed-cost expense account: 506-007-0-0NN (pattern of the existing lcst_trn rows). */
const expAccCode = (gitType) => `506-007-0-${String(gitType).trim().padStart(3, '0')}`;

const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** Next SRV No after the highest one on file, same zero-padded width. */
async function nextSrvNo(conn, width) {
  const rows = await q(conn, 'SELECT SRV_NO FROM srv_hdr ORDER BY SRV_NO DESC LIMIT 1 FOR UPDATE');
  const last = rows.length ? String(rows[0].SRV_NO).trim() : '0';
  if (!/^\d+$/.test(last)) throw new ConflictError(`Cannot allocate next SRV No after "${last}"`);
  return String(Number(last) + 1).padStart(Math.max(width, last.length), '0');
}

module.exports = function (connection) {
  const router = express.Router();

  router.post('/save-srv', (req, res) => {
    const { netData, itemsData, expData } = req.body || {};
    if (!netData || !Array.isArray(itemsData) || itemsData.length === 0) {
      return res.status(400).json({ message: 'Invalid SRV data format' });
    }

    // Foreign SRV screen sends expData ([] when all expenses are cleared)
    const isForeign = Array.isArray(expData);
    const foreignHdr = isForeign
      ? [
          (netData.CurrCd ?? '').toString().trim() || null,
          numOrNull(netData.ConvRt),
          numOrNull(netData.InvAmtFc),
          numOrNull(netData.FreightFc),
          numOrNull(netData.InvAmtLcl),
          numOrNull(netData.ExpAmt),
          numOrNull(netData.EffRate),
        ]
      : null;
    // expense lines with a type and a non-zero amount
    const expLines = isForeign
      ? expData
          .filter((r) => r && String(r.expCode ?? '').trim() && numOrNull(r.amount))
          .map((r) => ({ type: String(r.expCode).trim(), amount: numOrNull(r.amount) }))
      : [];

    const clientSrvNo = String(netData.SrvNo ?? '').trim();
    if (!clientSrvNo) {
      return res.status(400).json({ message: 'SRV No is required' });
    }

    const mode = String(netData.Mode || '').toUpperCase();

    // Rows without SR_NO can't be told apart from deleted ones, so pruning is skipped.
    const keepSrNos = itemsData.map((r) => (r.SR_NO == null ? '' : String(r.SR_NO).trim()));
    const canPrune = keepSrNos.every((s) => s !== '');
    if (!canPrune) console.warn('[save-srv] line without SR_NO — removed rows not pruned', { clientSrvNo });

    const hdrFields = [
      netData.SrvDt, netData.LpoNo ?? null, netData.SupCd ?? null, netData.Narration ?? null,
      netData.SupInvNo ?? null, netData.InvDt ?? null, netData.Amount ?? null,
    ];

    const claim = async (conn) => {
      let srvNo = clientSrvNo;
      for (let i = 0; i < MAX_CLAIMS; i++) {
        try {
          await q(conn, HDR_INSERT, [srvNo, ...hdrFields]);
          return srvNo;
        } catch (e) {
          if (!isDup(e)) throw e;
          if (mode !== 'ADD') throw new ConflictError(`SRV No ${srvNo} was just created by another user — please reload it`);
          srvNo = await nextSrvNo(conn, clientSrvNo.length);
        }
      }
      throw new ConflictError('Could not allocate a free SRV No — please try Save again');
    };

    const saveOnce = async (conn) => {
      await begin(conn);

      let srvNo;
      if (mode === 'ADD') {
        srvNo = await claim(conn);
      } else {
        const rows = await q(conn, 'SELECT SRV_NO FROM srv_hdr WHERE SRV_NO=? FOR UPDATE', [clientSrvNo]);
        if (rows.length) {
          srvNo = clientSrvNo;
          await q(conn, HDR_UPDATE, [...hdrFields, srvNo]);
        } else if (mode === 'EDIT') {
          throw new ConflictError(`SRV ${clientSrvNo} no longer exists`);
        } else {
          srvNo = await claim(conn);
        }
      }

      // Delete before upsert so an SR_NO reused in this save isn't deleted again.
      if (canPrune) {
        await q(conn, 'DELETE FROM srv_items WHERE SRV_NO = ? AND SR_NO NOT IN (?)', [srvNo, keepSrNos]);
      } else if (srvNo !== clientSrvNo) {
        await q(conn, 'DELETE FROM srv_items WHERE SRV_NO = ?', [srvNo]);
      }

      if (isForeign) {
        // header: currency, rates, amounts (after the insert/update above)
        await q(conn, HDR_FOREIGN_UPDATE, [...foreignHdr, srvNo]);

        // lines: Rate F.C + Rate Local
        const values = itemsData.map((row) => [
          srvNo, row.SRV_DATE || netData.SrvDt, row.SR_NO, row.ITEM_CODE, row.QTY, row.COST,
          numOrNull(row.COST_FC),
        ]);
        await q(conn, ITEMS_UPSERT_FP, [values]);

        // landed cost expenses: replace this SRV's lines (uses the SRV No actually
        // saved — on ADD it may have moved on to the next free number)
        await q(conn, 'DELETE FROM lcst_trn WHERE VCHR_NO = ?', [srvNo]);
        if (expLines.length) {
          await q(conn, LCST_INSERT, [
            expLines.map((e) => [srvNo, e.type, e.amount, expAccCode(e.type)]),
          ]);
        }
      } else {
        const values = itemsData.map((row) => [
          srvNo, row.SRV_DATE || netData.SrvDt, row.SR_NO, row.ITEM_CODE, row.QTY, row.COST,
        ]);
        await q(conn, ITEMS_UPSERT, [values]);
      }

      await commit(conn);
      return srvNo;
    };

    connection.getConnection(async (err, conn) => {
      if (err) {
        console.error('[save-srv] getConnection:', err);
        return res.status(500).json({ message: 'Error getting connection' });
      }

      try {
        for (let attempt = 1; ; attempt++) {
          try {
            const srvNo = await saveOnce(conn);
            return res.json({ message: 'S.R.V saved successfully!', srvNo });
          } catch (error) {
            await rollback(conn);
            if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) throw error;
            console.warn(`[save-srv] attempt ${attempt} hit ${error.code}, retrying`);
            await sleep(40 * attempt + Math.floor(Math.random() * 60));
          }
        }
      } catch (error) {
        console.error('[save-srv] failed, rolled back:', error);
        if (error instanceof ConflictError) {
          return res.status(409).json({ message: error.message });
        }
        const busy = isRetryable(error);
        res.status(busy ? 409 : 500).json({
          message: busy
            ? 'Another user is saving an SRV right now — please try Save again.'
            : 'SRV save failed, rolled back',
          error: error && error.message ? error.message : error,
        });
      } finally {
        conn.release();
      }
    });
  });

  return router;
};
