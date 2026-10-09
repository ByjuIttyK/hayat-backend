/**
 * Receipt Voucher save — POST /api/save-rcp
 * Screen: RvEntBank.tsx (hook useRvEntBankSave.tsx)
 *
 * One transaction writes the whole voucher:
 *   vouchers     — header (CUR_CODE / CONV_RATE / AMOUNT_FRGN / AMOUNT)
 *   pdc_rcd      — post-dated cheques   (ChqDt >  VchrDt)   + AMOUNT_FC
 *   current_chq  — current-dated cheques (ChqDt <= VchrDt)  + AMOUNT_FC
 *   tran_acc     — G/L lines                                 + AMOUNT_FC
 *   adj_dtl      — invoice settlements (always AED)
 *   rcp_on_acc   — On A/c Credit: customer credit not matched to invoices
 *                  (DOC_NO = RV no, DOC_TYPE = tran type, DB_CR 'C')
 *
 * AMOUNT_FC is the foreign-currency figure of the line/cheque. It is NULL
 * for an AED voucher (the screen sends AmountFc: null).
 *
 * Registration in HayatDb.js (remove the old inline app.post("/api/save-rcp")):
 *   const saveRcpRoutes = require('./routes/saveRcpRoutes');
 *   app.use('/api', saveRcpRoutes(connection, { allocateVchrNo }));
 *
 * allocateVchrNo(conn, tranType) is the existing HayatDb.js function that
 * assigns the next voucher number under a lock; it is passed in rather than
 * copied so there is still only one copy of it.
 *
 * Multi-user safety
 *   ADD  — the header is CLAIMED first with a plain INSERT (no ON DUPLICATE
 *          KEY UPDATE, no DELETE before it). If another user already holds
 *          that VCHR_NO the INSERT fails with ER_DUP_ENTRY, nothing of theirs
 *          is touched, and the whole save is retried with a new number.
 *   EDIT — the header row is locked with SELECT ... FOR UPDATE before the
 *          old copy is cleared, so two users saving the same voucher run one
 *          after the other instead of interleaving their DELETE/INSERTs.
 *   Deadlock (1213) / lock-wait timeout (1205) — rolled back and retried.
 *   Requires a PRIMARY/UNIQUE key on vouchers (TRAN_TYPE, VCHR_NO).
 */

const express = require('express');
const { saveRcpOnAcc } = require('./rcpOnAcc');

/** conn.query wrapped in a promise — keeps every statement on the one
 *  transaction connection. */
const q = (conn, sql, params) =>
  new Promise((resolve, reject) =>
    conn.query(sql, params, (err, result) => (err ? reject(err) : resolve(result))));

/** Blank / 0 / non-numeric FC → NULL, otherwise rounded to 2 decimals. */
const fcOrNull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? Math.round(n * 100) / 100 : null;
};

/** Errors worth retrying the whole transaction for. */
const MAX_ATTEMPTS = 4;
const isRetryable = (e) =>
  !!e && (e.code === 'ER_LOCK_DEADLOCK' || e.code === 'ER_LOCK_WAIT_TIMEOUT' || e.errno === 1213 || e.errno === 1205);
const isDupVchr = (e) => !!e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062) && e.vchrClaim === true;

const begin    = (conn) => new Promise((ok, ko) => conn.beginTransaction((e) => (e ? ko(e) : ok())));
const commit   = (conn) => new Promise((ok, ko) => conn.commit((e) => (e ? ko(e) : ok())));
const rollback = (conn) => new Promise((ok) => conn.rollback(() => ok()));
const sleep    = (ms) => new Promise((r) => setTimeout(r, ms));

/** Thrown for an EDIT whose voucher no longer exists (deleted by someone else). */
class NotFoundError extends Error {}

module.exports = function (connection, { allocateVchrNo } = {}) {
  if (typeof allocateVchrNo !== 'function') {
    throw new Error('saveRcpRoutes: allocateVchrNo must be passed in from HayatDb.js');
  }
  const router = express.Router();

  router.post('/save-rcp', (req, res) => {
    const {
      vchrData,
      chqData = [],
      currentChqData = [],
      tranaccData = [],
      InvStlData = [],
      rcpOnAcc = null,
    } = req.body || {};

    if (!vchrData || !vchrData.TranType) {
      return res.status(400).json({ message: 'vchrData.TranType is required' });
    }

    // One complete attempt: begin → allocate/lock → write everything → commit.
    // Throws on any failure; the caller rolls back and decides whether to retry.
    const saveOnce = async (conn) => {
      await begin(conn);

      // On ADD the number is assigned here, not trusted from the client.
      // Everything below uses vchrNo rather than vchrData.VchrNo, so a
      // stale number in the payload can neither overwrite another user's
      // voucher nor scatter child rows under the wrong header. On EDIT the
      // client's number is the record being edited and is kept as-is.
      const isAdd = String(vchrData.Mode || '').toUpperCase() === 'ADD';
      const vchrNo = isAdd
        ? await allocateVchrNo(conn, vchrData.TranType)
        : vchrData.VchrNo;
      const tt = vchrData.TranType;

      const hdrParams = [tt, vchrNo, vchrData.VchrDate,
        vchrData.CustCd, vchrData.DrAc, vchrData.CurCd, vchrData.ConvRt,
        vchrData.Particulars, vchrData.PaidTo,
        vchrData.FrgnAmt, vchrData.Amount];

      if (isAdd) {
        // ── ADD: claim the number first ──
        // Plain INSERT: if VCHR_NO is already taken by another user's
        // voucher this throws ER_DUP_ENTRY and their voucher is left
        // untouched — the caller retries with a freshly allocated number.
        try {
          await q(conn, `
            INSERT INTO vouchers (TRAN_TYPE, VCHR_NO, DATTE, CUST_CODE, ACC_CODE,
                                  CUR_CODE, CONV_RATE, NARRATION1, PAID_TO, AMOUNT_FRGN,
                                  AMOUNT)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, hdrParams);
        } catch (e) {
          if (e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062)) e.vchrClaim = true;
          throw e;
        }
      } else {
        // ── EDIT: lock the header so concurrent saves of this voucher queue ──
        const rows = await q(conn,
          'SELECT VCHR_NO FROM vouchers WHERE TRAN_TYPE=? AND VCHR_NO=? FOR UPDATE', [tt, vchrNo]);
        if (!rows.length) throw new NotFoundError(`Receipt voucher ${vchrNo} no longer exists`);

        // NARRATION1 takes Particulars and PAID_TO takes PaidTo.
        await q(conn, `
          UPDATE vouchers
             SET DATTE=?, CUST_CODE=?, ACC_CODE=?, CUR_CODE=?, CONV_RATE=?,
                 NARRATION1=?, PAID_TO=?, AMOUNT_FRGN=?, AMOUNT=?
           WHERE TRAN_TYPE=? AND VCHR_NO=?`,
          [...hdrParams.slice(2), tt, vchrNo]);
      }

      // ── Clear the old child rows (header is now owned/locked by us) ──
      // On ADD these are only stray rows left under a free number, never
      // another user's live voucher (the header claim above guarantees it).
      await q(conn, 'DELETE FROM tran_acc    WHERE TRAN_TYPE=? AND VCHR_NO=?', [tt, vchrNo]);
      await q(conn, 'DELETE FROM pdc_rcd     WHERE TRAN_TYPE=? AND VCHR_NO=?', [tt, vchrNo]);
      await q(conn, 'DELETE FROM current_chq WHERE TRAN_TYPE=? AND VCHR_NO=?', [tt, vchrNo]);
      await q(conn, 'DELETE FROM adj_dtl     WHERE SOURCE_TYPE=? AND SOURCE_DOC=?', [tt, vchrNo]);

      if (tt !== '05') {
        // ── pdc_rcd (post-dated cheques) ──
        for (const chq of chqData.filter(c => c.ChqNo && String(c.ChqNo).trim() !== '')) {
          await q(conn, `
            INSERT INTO pdc_rcd (
              TRAN_TYPE, VCHR_NO, VCHR_DATE, CHQ_NO, CHQ_DATE,
              PDC_CODE, CUST_CODE, CHQ_BANK, AMOUNT, AMOUNT_FC, NARRATION
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              VCHR_DATE = VALUES(VCHR_DATE),
              CHQ_DATE  = VALUES(CHQ_DATE),
              PDC_CODE  = VALUES(PDC_CODE),
              CUST_CODE = VALUES(CUST_CODE),
              CHQ_BANK  = VALUES(CHQ_BANK),
              AMOUNT    = VALUES(AMOUNT),
              AMOUNT_FC = VALUES(AMOUNT_FC),
              NARRATION = VALUES(NARRATION)`,
            [chq.TranType, vchrNo, vchrData.VchrDate, chq.ChqNo, chq.ChqDt,
             chq.PdcCode, chq.CustCd, chq.ChqBank, chq.Amount, fcOrNull(chq.AmountFc),
             chq.Narration]);
        }

        // ── current_chq (current-dated cheques) ──
        // Written here, in the same transaction, instead of by the
        // separate /api/save-current-chq call after the commit — that call
        // could fail after the voucher was already saved, leaving the
        // cheques missing. The DELETE above already cleared this voucher's
        // rows, so an EDIT re-writes them cleanly.
        for (const cc of currentChqData.filter(c => c.ChqNo && String(c.ChqNo).trim() !== '')) {
          await q(conn, `
            INSERT INTO current_chq (
              TRAN_TYPE, VCHR_NO, VCHR_DATE, CHQ_NO, CHQ_DATE, CHQ_BANK,
              PDC_CODE, SUP_CODE, AMOUNT, AMOUNT_FC, NARRATION,
              JV_NO_RLZ, JV_DATE_RLZ, REALISED, MAIN_SR_NO
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [cc.TranType || tt, vchrNo, cc.VchrDate || vchrData.VchrDate,
             cc.ChqNo, cc.ChqDate, cc.ChqBank,
             cc.PdcCode, cc.SupCode, cc.Amount, fcOrNull(cc.AmountFc), cc.Narration,
             cc.JvNoRlz ?? null, cc.JvDateRlz ?? null, cc.Realised || 'N', cc.MainSrNo ?? null]);
        }
      }

      // ── tran_acc ──
      for (const trn of tranaccData) {
        await q(conn, `
          INSERT INTO tran_acc (
            TRAN_TYPE, VCHR_NO, DATTE, SR_NO, ACC_CODE,
            AMOUNT, AMOUNT_FC, DB_CR, NARRATION1, NARRATION2, JOB_NO
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            DATTE      = VALUES(DATTE),
            ACC_CODE   = VALUES(ACC_CODE),
            AMOUNT     = VALUES(AMOUNT),
            AMOUNT_FC  = VALUES(AMOUNT_FC),
            DB_CR      = VALUES(DB_CR),
            NARRATION1 = VALUES(NARRATION1),
            NARRATION2 = VALUES(NARRATION2),
            JOB_NO     = VALUES(JOB_NO)`,
          [trn.TranType, vchrNo, vchrData.VchrDate, trn.SrNo, trn.AccCode,
           trn.Amount, fcOrNull(trn.AmountFc), trn.DbCr,
           trn.Narration1, trn.Narration2, trn.JobNo]);
      }

      // ── adj_dtl (settlements — AED) ──
      for (const stl of InvStlData) {
        await q(conn, `
          INSERT INTO adj_dtl (
            SOURCE_TYPE, SOURCE_DOC, SOURCE_DATE, ACC_CODE,
            STLD_TYPE, STLD_DOC, STLD_DATE, STLD_AMT
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            SOURCE_DATE = VALUES(SOURCE_DATE),
            ACC_CODE    = VALUES(ACC_CODE),
            STLD_TYPE   = VALUES(STLD_TYPE),
            STLD_DOC    = VALUES(STLD_DOC),
            STLD_DATE   = VALUES(STLD_DATE),
            STLD_AMT    = VALUES(STLD_AMT)`,
          [stl.TranType, vchrNo, stl.SourceDate, stl.AccCode,
           stl.StldType, stl.StldDoc, stl.StldDate, stl.Amount]);
      }

      // ── rcp_on_acc (On A/c Credit) ──
      // Credit to the customer beyond what was settled against invoices.
      // Uses vchrNo (allocated on ADD) so the row sits under the real RV.
      // An amount of 0 removes any earlier row for this voucher; a row
      // already partly settled can't be reduced below STLD_AMT (throws →
      // the whole voucher rolls back).
      if (rcpOnAcc) {
        await saveRcpOnAcc((sql, params) => q(conn, sql, params), {
          vchrNo,
          tranType: tt,
          vchrDate: vchrData.VchrDate,
          custCode: rcpOnAcc.CustCd || vchrData.CustCd,
          amount:   Number(rcpOnAcc.Amount) || 0,
          mainSrNo: rcpOnAcc.MainSrNo ?? null,
        });
      }

      await commit(conn);
      return vchrNo;
    };

    connection.getConnection(async (err, conn) => {
      if (err) {
        console.error('[save-rcp] getConnection:', err);
        return res.status(500).json({ message: 'R.V Bank save - Error getting connection' });
      }

      try {
        for (let attempt = 1; ; attempt++) {
          try {
            const vchrNo = await saveOnce(conn);
            // vchrNo goes back so the screen adopts the number actually
            // written — on ADD it may differ from the one the client showed.
            return res.json({ message: 'Data saved successfully!', vchrNo });
          } catch (error) {
            await rollback(conn);
            const retry = attempt < MAX_ATTEMPTS && (isRetryable(error) || isDupVchr(error));
            if (!retry) throw error;
            console.warn(`[save-rcp] attempt ${attempt} hit ${error.code || error.message}, retrying`);
            await sleep(40 * attempt + Math.floor(Math.random() * 60)); // small jittered back-off
          }
        }
      } catch (error) {
        console.error('[save-rcp] failed, rolled back:', error);
        if (error instanceof NotFoundError) {
          return res.status(409).json({ message: error.message });
        }
        const busy = isRetryable(error) || isDupVchr(error);
        res.status(busy ? 409 : 500).json({
          message: busy
            ? 'Another user is saving receipts right now — please try Save again.'
            : 'Receipt voucher save failed, rolled back',
          error: error && error.message ? error.message : error,
        });
      } finally {
        conn.release();
      }
    });
  });

  return router;
};
