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
 */

const express = require('express');

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
    } = req.body || {};

    if (!vchrData || !vchrData.TranType) {
      return res.status(400).json({ message: 'vchrData.TranType is required' });
    }

    connection.getConnection((err, conn) => {
      if (err) {
        console.error('[save-rcp] getConnection:', err);
        return res.status(500).json({ message: 'R.V Bank save - Error getting connection' });
      }

      conn.beginTransaction(async (err) => {
        if (err) {
          console.error('[save-rcp] beginTransaction:', err);
          conn.release();
          return res.status(500).json({ message: 'Transaction error', error: err });
        }

        try {
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

          // ── Clear the old copy (inside the transaction) ──
          await q(conn, 'DELETE FROM vouchers    WHERE TRAN_TYPE=? AND VCHR_NO=?', [tt, vchrNo]);
          await q(conn, 'DELETE FROM tran_acc    WHERE TRAN_TYPE=? AND VCHR_NO=?', [tt, vchrNo]);
          await q(conn, 'DELETE FROM pdc_rcd     WHERE TRAN_TYPE=? AND VCHR_NO=?', [tt, vchrNo]);
          await q(conn, 'DELETE FROM current_chq WHERE TRAN_TYPE=? AND VCHR_NO=?', [tt, vchrNo]);
          await q(conn, 'DELETE FROM adj_dtl     WHERE SOURCE_TYPE=? AND SOURCE_DOC=?', [tt, vchrNo]);

          // ── vouchers ──
          // NARRATION1 takes Particulars and PAID_TO takes PaidTo (column
          // order NARRATION1 then PAID_TO).
          await q(conn, `
            INSERT INTO vouchers (TRAN_TYPE, VCHR_NO, DATTE, CUST_CODE, ACC_CODE,
                                  CUR_CODE, CONV_RATE, NARRATION1, PAID_TO, AMOUNT_FRGN,
                                  AMOUNT)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              DATTE       = VALUES(DATTE),
              CUST_CODE   = VALUES(CUST_CODE),
              ACC_CODE    = VALUES(ACC_CODE),
              CUR_CODE    = VALUES(CUR_CODE),
              CONV_RATE   = VALUES(CONV_RATE),
              NARRATION1  = VALUES(NARRATION1),
              PAID_TO     = VALUES(PAID_TO),
              AMOUNT_FRGN = VALUES(AMOUNT_FRGN),
              AMOUNT      = VALUES(AMOUNT)`,
            [tt, vchrNo, vchrData.VchrDate,
             vchrData.CustCd, vchrData.DrAc, vchrData.CurCd, vchrData.ConvRt,
             vchrData.Particulars, vchrData.PaidTo,
             vchrData.FrgnAmt, vchrData.Amount]);

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

          conn.commit((err) => {
            if (err) {
              console.error('[save-rcp] commit:', err);
              return conn.rollback(() => {
                conn.release();
                res.status(500).json({ message: 'Commit error', error: err });
              });
            }
            conn.release();
            // vchrNo goes back so the screen adopts the number actually
            // written — on ADD it is not the one the client sent.
            res.json({ message: 'Data saved successfully!', vchrNo });
          });

        } catch (error) {
          console.error('[save-rcp] failed, rolling back:', error);
          conn.rollback(() => {
            conn.release();
            res.status(500).json({
              message: 'Receipt voucher save failed, rolled back',
              error: error && error.message ? error.message : error,
            });
          });
        }
      });
    });
  });

  return router;
};
