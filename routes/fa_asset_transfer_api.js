// =====================================================================
// fa_asset_transfer_api.js
// Fixed Assets - Asset Transfer routes
// Mount in HayatDb.js:
//    const faTransferRoutes = require('./routes/fa_asset_transfer_api')(connection);
//    app.use('/api/fa-transfer', faTransferRoutes);
//
// Table: hayat_fa.fa_asset_transfer
//   TRF_NO        varchar(15)  PK
//   ASSET_CODE    varchar(15)
//   TRF_DATE      date
//   FROM_LOCATION varchar(100)
//   TO_LOCATION   varchar(100)
//   FROM_JOB_NO   varchar(15)
//   TO_JOB_NO     varchar(15)
//   REMARKS       varchar(255)
//   CREATED_AT    timestamp
//
// NOTE: verify the two asset-master column names used below against
// your fa_asset_mst DDL:  LOCATION  and  JOB_NO
// (same caveat as DEP_EXP_GL_ACC / ACCUM_DEP_GL_ACC in fa_category_mst).
// =====================================================================

const express = require('express');

module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise();

  // -------------------------------------------------------------
  // Next transfer number:  TRF000001, TRF000002 ...
  // -------------------------------------------------------------
  async function getNextTrfNo() {
    const [rows] = await db.query(
      `SELECT IFNULL(MAX(CAST(SUBSTRING(TRF_NO, 4) AS UNSIGNED)), 0) + 1 AS NEXT_NO
         FROM hayat_fa.fa_asset_transfer
        WHERE TRF_NO REGEXP '^TRF[0-9]+$'`
    );
    return 'TRF' + String(rows[0].NEXT_NO).padStart(6, '0');
  }

  router.get('/next-no', async (req, res) => {
    try {
      res.json({ TRF_NO: await getNextTrfNo() });
    } catch (err) {
      console.error('fa-transfer next-no:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------
  // LOV: assets (with current location / job pulled from master)
  // -------------------------------------------------------------
  router.get('/lov/assets', async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT a.ASSET_CODE,
                a.ASSET_NAME,
                a.CAT_CODE,
                a.LOCATION  AS CUR_LOCATION,
                a.JOB_NO    AS CUR_JOB_NO,
                a.STATUS
           FROM hayat_fa.fa_asset_mst a
          WHERE IFNULL(a.STATUS,'A') <> 'D'          -- exclude disposed
          ORDER BY a.ASSET_CODE`
      );
      res.json(rows);
    } catch (err) {
      console.error('fa-transfer lov/assets:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------
  // LOV: locations (union of everything seen so far)
  // -------------------------------------------------------------
  router.get('/lov/locations', async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT DISTINCT LOCATION FROM (
             SELECT LOCATION            FROM hayat_fa.fa_asset_mst      WHERE LOCATION IS NOT NULL
             UNION SELECT FROM_LOCATION FROM hayat_fa.fa_asset_transfer WHERE FROM_LOCATION IS NOT NULL
             UNION SELECT TO_LOCATION   FROM hayat_fa.fa_asset_transfer WHERE TO_LOCATION IS NOT NULL
         ) t
         WHERE LOCATION <> ''
         ORDER BY LOCATION`
      );
      res.json(rows.map(r => r.LOCATION));
    } catch (err) {
      console.error('fa-transfer lov/locations:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------
  // LOV: jobs (from main schema job_card)
  // -------------------------------------------------------------
  router.get('/lov/jobs', async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT JOB_NO, PROJ_NAME AS JOB_DESC
           FROM hayat.job_card
          ORDER BY JOB_NO DESC`
      );
      res.json(rows);
    } catch (err) {
      console.error('fa-transfer lov/jobs:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------
  // List for the find/grid panel  (?search= optional)
  // -------------------------------------------------------------
  router.get('/list', async (req, res) => {
    try {
      const search = (req.query.search || '').trim();
      let where = '';
      let params = [];
      if (search) {
        where = `WHERE t.TRF_NO LIKE ? OR t.ASSET_CODE LIKE ?
                    OR a.ASSET_NAME LIKE ? OR t.TO_LOCATION LIKE ?`;
        const like = `%${search}%`;
        params = [like, like, like, like];
      }
      const [rows] = await db.query(
        `SELECT t.TRF_NO,
                t.ASSET_CODE,
                a.ASSET_NAME,
                DATE_FORMAT(t.TRF_DATE, '%d/%m/%Y') AS TRF_DATE,
                t.FROM_LOCATION, t.TO_LOCATION,
                t.FROM_JOB_NO,   t.TO_JOB_NO,
                t.REMARKS
           FROM hayat_fa.fa_asset_transfer t
           LEFT JOIN hayat_fa.fa_asset_mst a ON a.ASSET_CODE = t.ASSET_CODE
           ${where}
          ORDER BY t.TRF_NO DESC
          LIMIT 500`,
        params
      );
      res.json(rows);
    } catch (err) {
      console.error('fa-transfer list:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------
  // Report: Transfer Register  (?from=YYYY-MM-DD&to=&location=&asset=)
  //   NB: registered BEFORE '/:trfNo' so it isn't swallowed by it.
  // -------------------------------------------------------------
  router.get('/report/register', async (req, res) => {
    try {
      const { from, to, location, asset } = req.query;
      const cond = ['1=1'];
      const params = [];
      if (from)     { cond.push('t.TRF_DATE >= ?'); params.push(from); }
      if (to)       { cond.push('t.TRF_DATE <= ?'); params.push(to); }
      if (location) { cond.push('(t.FROM_LOCATION = ? OR t.TO_LOCATION = ?)'); params.push(location, location); }
      if (asset)    { cond.push('t.ASSET_CODE = ?'); params.push(asset); }

      const [rows] = await db.query(
        `SELECT t.TRF_NO,
                DATE_FORMAT(t.TRF_DATE, '%d/%m/%Y') AS TRF_DATE,
                t.ASSET_CODE,
                a.ASSET_NAME,
                c.CAT_NAME,
                t.FROM_LOCATION, t.TO_LOCATION,
                t.FROM_JOB_NO,   t.TO_JOB_NO,
                t.REMARKS
           FROM hayat_fa.fa_asset_transfer t
           LEFT JOIN hayat_fa.fa_asset_mst   a ON a.ASSET_CODE = t.ASSET_CODE
           LEFT JOIN hayat_fa.fa_category_mst c ON c.CAT_CODE  = a.CAT_CODE
          WHERE ${cond.join(' AND ')}
          ORDER BY t.TRF_DATE, t.TRF_NO`,
        params
      );
      res.json(rows);
    } catch (err) {
      console.error('fa-transfer report/register:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------
  // Report: Movement history of one asset (chronological)
  // -------------------------------------------------------------
  router.get('/report/history/:assetCode', async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT t.TRF_NO,
                DATE_FORMAT(t.TRF_DATE, '%d/%m/%Y') AS TRF_DATE,
                t.FROM_LOCATION, t.TO_LOCATION,
                t.FROM_JOB_NO,   t.TO_JOB_NO,
                t.REMARKS,
                t.CREATED_AT
           FROM hayat_fa.fa_asset_transfer t
          WHERE t.ASSET_CODE = ?
          ORDER BY t.TRF_DATE, t.CREATED_AT`,
        [req.params.assetCode]
      );

      const [[asset]] = await db.query(
        `SELECT ASSET_CODE, ASSET_NAME, LOCATION AS CUR_LOCATION, JOB_NO AS CUR_JOB_NO
           FROM hayat_fa.fa_asset_mst
          WHERE ASSET_CODE = ?`,
        [req.params.assetCode]
      );

      res.json({ asset: asset || null, history: rows });
    } catch (err) {
      console.error('fa-transfer report/history:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------
  // Single record fetch
  // -------------------------------------------------------------
  router.get('/:trfNo', async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT t.TRF_NO, t.ASSET_CODE, a.ASSET_NAME,
                DATE_FORMAT(t.TRF_DATE, '%Y-%m-%d') AS TRF_DATE,   -- HTML date input format
                t.FROM_LOCATION, t.TO_LOCATION,
                t.FROM_JOB_NO,   t.TO_JOB_NO,
                t.REMARKS, t.CREATED_AT
           FROM hayat_fa.fa_asset_transfer t
           LEFT JOIN hayat_fa.fa_asset_mst a ON a.ASSET_CODE = t.ASSET_CODE
          WHERE t.TRF_NO = ?`,
        [req.params.trfNo]
      );
      if (!rows.length) return res.status(404).json({ error: 'Transfer not found' });
      res.json(rows[0]);
    } catch (err) {
      console.error('fa-transfer get:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------
  // Save (ADD / EDIT) - transactional.
  //   ADD : optimistic insert with duplicate-key retry on TRF_NO,
  //         then update fa_asset_mst location/job.
  //   EDIT: update transfer row; if it is the LATEST transfer for
  //         the asset, re-sync the asset master to its TO_ values.
  // -------------------------------------------------------------
  router.post('/save', async (req, res) => {
    const {
      mode,                    // 'ADD' | 'EDIT'
      TRF_NO, ASSET_CODE, TRF_DATE,
      FROM_LOCATION, TO_LOCATION,
      FROM_JOB_NO, TO_JOB_NO, REMARKS
    } = req.body;

    if (!ASSET_CODE || !TRF_DATE || !TO_LOCATION) {
      return res.status(400).json({ error: 'Asset, transfer date and To Location are required' });
    }
    if ((FROM_LOCATION || '') === (TO_LOCATION || '') &&
        (FROM_JOB_NO || '')   === (TO_JOB_NO || '')) {
      return res.status(400).json({ error: 'From and To are identical - nothing to transfer' });
    }

    const conn = connection.promise();
    try {
      await conn.query('START TRANSACTION');

      let trfNo = TRF_NO;

      if (mode === 'ADD') {
        // optimistic insert + duplicate-key retry (same pattern as FaAssetMst)
        let attempts = 0;
        while (attempts < 5) {
          trfNo = await getNextTrfNo();
          try {
            await conn.query(
              `INSERT INTO hayat_fa.fa_asset_transfer
                 (TRF_NO, ASSET_CODE, TRF_DATE, FROM_LOCATION, TO_LOCATION,
                  FROM_JOB_NO, TO_JOB_NO, REMARKS, CREATED_AT)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
              [trfNo, ASSET_CODE, TRF_DATE, FROM_LOCATION || null, TO_LOCATION,
               FROM_JOB_NO || null, TO_JOB_NO || null, REMARKS || null]
            );
            break;
          } catch (e) {
            if (e.code === 'ER_DUP_ENTRY') { attempts++; continue; }
            throw e;
          }
        }
        if (attempts >= 5) throw new Error('Could not allocate TRF_NO after 5 attempts');
      } else {
        const [r] = await conn.query(
          `UPDATE hayat_fa.fa_asset_transfer
              SET ASSET_CODE = ?, TRF_DATE = ?, FROM_LOCATION = ?, TO_LOCATION = ?,
                  FROM_JOB_NO = ?, TO_JOB_NO = ?, REMARKS = ?
            WHERE TRF_NO = ?`,
          [ASSET_CODE, TRF_DATE, FROM_LOCATION || null, TO_LOCATION,
           FROM_JOB_NO || null, TO_JOB_NO || null, REMARKS || null, trfNo]
        );
        if (r.affectedRows === 0) throw new Error(`Transfer ${trfNo} not found`);
      }

      // Sync asset master only if this row is the latest transfer for the asset
      const [[latest]] = await conn.query(
        `SELECT TRF_NO FROM hayat_fa.fa_asset_transfer
          WHERE ASSET_CODE = ?
          ORDER BY TRF_DATE DESC, CREATED_AT DESC, TRF_NO DESC
          LIMIT 1`,
        [ASSET_CODE]
      );
      if (latest && latest.TRF_NO === trfNo) {
        await conn.query(
          `UPDATE hayat_fa.fa_asset_mst
              SET LOCATION = ?, JOB_NO = ?
            WHERE ASSET_CODE = ?`,
          [TO_LOCATION, TO_JOB_NO || null, ASSET_CODE]
        );
      }

      await conn.query('COMMIT');
      res.json({ success: true, TRF_NO: trfNo });
    } catch (err) {
      await conn.query('ROLLBACK').catch(() => {});
      console.error('fa-transfer save:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------
  // Delete - only the LATEST transfer of an asset may be deleted,
  // and the asset master is reverted to the FROM_ values.
  // -------------------------------------------------------------
  router.delete('/:trfNo', async (req, res) => {
    const conn = connection.promise();
    try {
      await conn.query('START TRANSACTION');

      const [[row]] = await conn.query(
        `SELECT * FROM hayat_fa.fa_asset_transfer WHERE TRF_NO = ? FOR UPDATE`,
        [req.params.trfNo]
      );
      if (!row) throw new Error('Transfer not found');

      const [[latest]] = await conn.query(
        `SELECT TRF_NO FROM hayat_fa.fa_asset_transfer
          WHERE ASSET_CODE = ?
          ORDER BY TRF_DATE DESC, CREATED_AT DESC, TRF_NO DESC
          LIMIT 1`,
        [row.ASSET_CODE]
      );
      if (latest.TRF_NO !== row.TRF_NO) {
        throw new Error('Only the latest transfer of an asset can be deleted. Delete newer transfers first.');
      }

      await conn.query(
        `DELETE FROM hayat_fa.fa_asset_transfer WHERE TRF_NO = ?`,
        [row.TRF_NO]
      );

      // revert asset master to the FROM_ side of the deleted transfer
      await conn.query(
        `UPDATE hayat_fa.fa_asset_mst
            SET LOCATION = ?, JOB_NO = ?
          WHERE ASSET_CODE = ?`,
        [row.FROM_LOCATION, row.FROM_JOB_NO, row.ASSET_CODE]
      );

      await conn.query('COMMIT');
      res.json({ success: true });
    } catch (err) {
      await conn.query('ROLLBACK').catch(() => {});
      console.error('fa-transfer delete:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
