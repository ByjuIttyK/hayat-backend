// =====================================================================
// fa_disposal_api.js  -  Fixed Assets > Asset Disposal routes
// Factory pattern, same as fa_transfer / fa_dep_run:
//
//   const faDisposalRoutes = require('./fa_disposal_api');
//   app.use('/api/fa-disposal', faDisposalRoutes(connection));
//
// Routes:
//   GET    /lov/assets        active (not-yet-disposed) assets with cost/dep/nbv
//   GET    /lov/accounts      GL account LOV (ACC_CODE, ACC_HEAD)
//   GET    /next-no           next DSP_NO (preview only; re-allocated on save)
//   GET    /list              rows for InfoGrid (FA_ASSET_DISPOSAL)
//   GET    /:dspNo            load one disposal
//   POST   /save              insert disposal + mark asset + post JV (one txn)
//   DELETE /:dspNo            delete disposal + JV, revert asset status
//
// !! VERIFY before first run (marked "VERIFY" below):
//   - fa_asset_mst cost column name  (ASSET_COST assumed)
//   - fa_asset_mst status column     (STATUS 'ACTIVE'/'DISPOSED' assumed)
//   - fa_category_mst GL columns     (ASSET_GL_ACC confirmed earlier,
//                                     ACCUM_DEP_GL_ACC assumed)
//   - vouchers / tran_acc column lists: copy the exact INSERT column
//     lists from your working fa_dep_run_api.js post-jv route.
//   - TRAN_TYPE '16' assumed free for Asset Disposal ('15' = depreciation)
// =====================================================================

const express = require('express');

const TRAN_TYPE_DISPOSAL = '16';   // VERIFY: unused TRAN_TYPE in your chart

module.exports = function (connection) {
  const router = express.Router();
  const db = () => connection.promise();

  // ------------------------------------------------------------ LOVs
  router.get('/lov/assets', async (req, res) => {
    try {
      const [rows] = await db().query(
        `SELECT a.ASSET_CODE,
                a.ASSET_NAME,
                a.CAT_CODE,
                a.LOCATION,
                a.JOB_NO,
                a.ACQ_COST AS ASSET_COST,                    -- VERIFY column name
                a.ACCUM_DEP,
                a.NBV
           FROM hayat_fa.fa_asset_mst a
          WHERE IFNULL(a.STATUS,'ACTIVE') <> 'DISPOSED'   -- VERIFY column
          ORDER BY a.ASSET_CODE`
      );
      res.json(rows);
    } catch (err) {
      console.error('fa-disposal lov/assets:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/lov/accounts', async (req, res) => {
    try {
      const [rows] = await db().query(
        `SELECT ACC_CODE, ACC_HEAD FROM acc_mst ORDER BY ACC_HEAD`   // VERIFY table/cols vs /api/acclist
      );
      res.json(rows);
    } catch (err) {
      console.error('fa-disposal lov/accounts:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ------------------------------------------------------------ next no
  async function nextDspNo(conn) {
    const [[row]] = await conn.query(
      `SELECT IFNULL(MAX(CAST(SUBSTRING(DSP_NO, 4) AS UNSIGNED)), 0) + 1 AS n
         FROM hayat_fa.fa_asset_disposal
        WHERE DSP_NO LIKE 'DSP%'`
    );
    return 'DSP' + String(row.n).padStart(6, '0');
  }

  router.get('/next-no', async (req, res) => {
    try {
      res.json({ DSP_NO: await nextDspNo(db()) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ------------------------------------------------------------ InfoGrid list
  router.get('/list', async (req, res) => {
    try {
      const [rows] = await db().query(
        `SELECT d.DSP_NO, d.DSP_DATE, d.ASSET_CODE, a.ASSET_NAME,
                d.DSP_TYPE, d.NBV, d.SALE_AMOUNT, d.GAIN_LOSS,
                d.BUYER, d.VCHR_NO, d.REMARKS
           FROM hayat_fa.fa_asset_disposal d
           LEFT JOIN hayat_fa.fa_asset_mst a ON a.ASSET_CODE = d.ASSET_CODE
          ORDER BY d.DSP_DATE DESC, d.DSP_NO DESC`
      );
      res.json(rows);
    } catch (err) {
      console.error('fa-disposal list:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ------------------------------------------------------------ load one
  router.get('/:dspNo', async (req, res) => {
    try {
      const [[row]] = await db().query(
        `SELECT d.*, a.ASSET_NAME, a.CAT_CODE, a.LOCATION
           FROM hayat_fa.fa_asset_disposal d
           LEFT JOIN hayat_fa.fa_asset_mst a ON a.ASSET_CODE = d.ASSET_CODE
          WHERE d.DSP_NO = ?`,
        [req.params.dspNo]
      );
      if (!row) return res.status(404).json({ error: 'Disposal not found' });
      // normalise date for <input type="date">
      if (row.DSP_DATE instanceof Date) {
        row.DSP_DATE = row.DSP_DATE.toISOString().slice(0, 10);
      }
      res.json(row);
    } catch (err) {
      console.error('fa-disposal load:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ------------------------------------------------------------ JV builder
  // Journal for disposal (amounts from the asset master snapshot):
  //   Dr  Accum. Depreciation acct      ACCUM_DEP
  //   Dr  Proceeds acct                 SALE_AMOUNT   (if > 0)
  //   Dr  Gain/Loss acct                LOSS          (if NBV > proceeds)
  //   Cr  Asset cost acct               ASSET_COST
  //   Cr  Gain/Loss acct                GAIN          (if proceeds > NBV)
  async function postDisposalJv(conn, d, catGl) {
    // next voucher no for this TRAN_TYPE - VERIFY numbering scheme
    const [[v]] = await conn.query(
      `SELECT IFNULL(MAX(CAST(VCHR_NO AS UNSIGNED)), 0) + 1 AS n
         FROM vouchers WHERE TRAN_TYPE = ?`,
      [TRAN_TYPE_DISPOSAL]
    );
    const vchrNo = String(v.n);
    const narration = `Disposal of asset ${d.ASSET_CODE} (${d.DSP_TYPE}) - ${d.DSP_NO}`;

    // --- vouchers header --------------------------------------------
    // VERIFY: copy the exact column list from fa_dep_run_api.js
    await conn.query(
      `INSERT INTO vouchers (TRAN_TYPE, VCHR_NO,DATTE, NARRATION1)
       VALUES (?, ?, ?, ?)`,
      [TRAN_TYPE_DISPOSAL, vchrNo, d.DSP_DATE, narration]
    );

    // --- tran_acc lines ---------------------------------------------
    const lines = [];
    if (Number(d.ACCUM_DEP) > 0) {
      lines.push({ acc: catGl.ACCUM_DEP_GL_ACC, dr: Number(d.ACCUM_DEP), cr: 0 });
    }
    if (Number(d.SALE_AMOUNT) > 0) {
      lines.push({ acc: d.PROCEEDS_ACC, dr: Number(d.SALE_AMOUNT), cr: 0 });
    }
    const gainLoss = Number(d.SALE_AMOUNT) - Number(d.NBV);
    if (gainLoss < 0) {
      lines.push({ acc: d.GAINLOSS_ACC, dr: -gainLoss, cr: 0 });     // loss -> Dr
    }
    lines.push({ acc: catGl.ASSET_GL_ACC, dr: 0, cr: Number(d.ASSET_COST) });
    if (gainLoss > 0) {
      lines.push({ acc: d.GAINLOSS_ACC, dr: 0, cr: gainLoss });      // gain -> Cr
    }

    // sanity: Dr total must equal Cr total
    const drT = lines.reduce((s, l) => s + l.dr, 0);
    const crT = lines.reduce((s, l) => s + l.cr, 0);
    if (Math.abs(drT - crT) > 0.005) {
      throw new Error(`Disposal JV out of balance (Dr ${drT.toFixed(2)} / Cr ${crT.toFixed(2)})`);
    }

    // VERIFY: copy exact column list / SR_NO convention from fa_dep_run_api.js
    let srNo = 1;
    for (const l of lines) {
      console.log("tran-acc", TRAN_TYPE_DISPOSAL, vchrNo, srNo++, d.DSP_DATE, l.acc, 10, l.dr ? 'D' : 'C', narration);
      await conn.query(

        `INSERT INTO tran_acc
           (TRAN_TYPE, VCHR_NO, SR_NO, DATTE, ACC_CODE, AMOUNT ,DB_CR , NARRATION1)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [TRAN_TYPE_DISPOSAL, vchrNo, srNo++, d.DSP_DATE, l.acc, l.dr || 0 + l.cr || 0, l.dr ? 'D' : 'C', narration]
      );
      // l.dr||0+ l.cr||0
    }
    return vchrNo;
  }

  // ------------------------------------------------------------ save
  router.post('/save', async (req, res) => {
    const b = req.body || {};
    const conn = db();
    try {
      // basic validation ------------------------------------------------
      if (!b.ASSET_CODE) throw new Error('Asset is required');
      if (!b.DSP_DATE) throw new Error('Disposal date is required');
      const dspType = String(b.DSP_TYPE || 'SALE').toUpperCase();
      const saleAmt = dspType === 'SALE' ? Number(b.SALE_AMOUNT || 0) : 0;
      if (dspType === 'SALE' && saleAmt < 0) throw new Error('Sale amount cannot be negative');
      if (saleAmt > 0 && !b.PROCEEDS_ACC) throw new Error('Proceeds GL account is required');
      if (!b.GAINLOSS_ACC) throw new Error('Gain/Loss GL account is required');
      if (b.mode === 'EDIT') {
        // Keep it simple & auditable: a posted disposal is not editable.
        throw new Error('A saved disposal cannot be edited. Delete it and re-enter.');
      }

      await conn.query('START TRANSACTION');

      // lock + re-read the asset from the master (source of truth) ------
      const [[asset]] = await conn.query(
        `SELECT ASSET_CODE, ASSET_NAME, CAT_CODE,
                ACQ_COST AS ASSET_COST, ACCUM_DEP, NBV,               -- VERIFY cost column
                IFNULL(STATUS,'ACTIVE') AS STATUS         -- VERIFY status column
           FROM hayat_fa.fa_asset_mst
          WHERE ASSET_CODE = ?
          FOR UPDATE`,
        [b.ASSET_CODE]
      );
      if (!asset) throw new Error('Asset not found');
      if (asset.STATUS === 'DISPOSED') throw new Error('Asset is already disposed');

      // category GL accounts --------------------------------------------
      const [[catGl]] = await conn.query(
        `SELECT ASSET_GL_ACC, ACCUM_DEP_GL_ACC             -- VERIFY columns
           FROM hayat_fa.fa_category_mst
          WHERE CAT_CODE = ?`,
        [asset.CAT_CODE]
      );
      if (!catGl || !catGl.ASSET_GL_ACC) {
        throw new Error(`GL accounts not set on category ${asset.CAT_CODE}`);
      }

      const dspNo = await nextDspNo(conn);
      const gainLoss = saleAmt - Number(asset.NBV);

      const d = {
        DSP_NO: dspNo,
        DSP_DATE: b.DSP_DATE,
        ASSET_CODE: asset.ASSET_CODE,
        DSP_TYPE: dspType,
        ASSET_COST: Number(asset.ASSET_COST),
        ACCUM_DEP: Number(asset.ACCUM_DEP),
        NBV: Number(asset.NBV),
        SALE_AMOUNT: saleAmt,
        GAIN_LOSS: gainLoss,
        BUYER: dspType === 'SALE' ? (b.BUYER || null) : null,
        PROCEEDS_ACC: saleAmt > 0 ? b.PROCEEDS_ACC : null,
        GAINLOSS_ACC: b.GAINLOSS_ACC,
        REMARKS: b.REMARKS || null,
      };

      // post the JV ------------------------------------------------------
      const vchrNo = await postDisposalJv(conn, d, catGl);

      // insert disposal row ---------------------------------------------
      await conn.query(
        `INSERT INTO hayat_fa.fa_asset_disposal
           (DSP_NO, DSP_DATE, ASSET_CODE, DSP_TYPE, ASSET_COST, ACCUM_DEP, NBV,
            SALE_AMOUNT, GAIN_LOSS, BUYER, PROCEEDS_ACC, GAINLOSS_ACC, VCHR_NO, REMARKS)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [d.DSP_NO, d.DSP_DATE, d.ASSET_CODE, d.DSP_TYPE, d.ASSET_COST, d.ACCUM_DEP,
        d.NBV, d.SALE_AMOUNT, d.GAIN_LOSS, d.BUYER, d.PROCEEDS_ACC, d.GAINLOSS_ACC,
          vchrNo, d.REMARKS]
      );

      // mark the asset disposed ------------------------------------------
      await conn.query(
        `UPDATE hayat_fa.fa_asset_mst
            SET STATUS = 'DISPOSED'                       -- VERIFY column
          WHERE ASSET_CODE = ?`,
        [d.ASSET_CODE]
      );

      await conn.query('COMMIT');
      res.json({ success: true, DSP_NO: dspNo, VCHR_NO: vchrNo, GAIN_LOSS: gainLoss });
    } catch (err) {
      await conn.query('ROLLBACK').catch(() => { });
      console.error('fa-disposal save:', err.sqlMessage || err.message);
      console.error('SQL >>>', err.sql);          // <-- shows the statement with NaN visible in place
      res.status(500).json({ error: err.sqlMessage || err.message });
    }
  });

  // ------------------------------------------------------------ delete
  router.delete('/:dspNo', async (req, res) => {
    const conn = db();
    try {
      await conn.query('START TRANSACTION');

      const [[row]] = await conn.query(
        `SELECT * FROM hayat_fa.fa_asset_disposal WHERE DSP_NO = ? FOR UPDATE`,
        [req.params.dspNo]
      );
      if (!row) throw new Error('Disposal not found');

      // remove the posted JV
      if (row.VCHR_NO) {
        await conn.query(
          `DELETE FROM tran_acc WHERE TRAN_TYPE = ? AND VCHR_NO = ?`,
          [TRAN_TYPE_DISPOSAL, row.VCHR_NO]
        );
        await conn.query(
          `DELETE FROM vouchers WHERE TRAN_TYPE = ? AND VCHR_NO = ?`,
          [TRAN_TYPE_DISPOSAL, row.VCHR_NO]
        );
      }

      await conn.query(
        `DELETE FROM hayat_fa.fa_asset_disposal WHERE DSP_NO = ?`,
        [row.DSP_NO]
      );

      // re-activate the asset
      await conn.query(
        `UPDATE hayat_fa.fa_asset_mst
            SET STATUS = 'ACTIVE'                         -- VERIFY column
          WHERE ASSET_CODE = ?`,
        [row.ASSET_CODE]
      );

      await conn.query('COMMIT');
      res.json({ success: true });
    } catch (err) {
      await conn.query('ROLLBACK').catch(() => { });
      console.error('fa-disposal delete:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
