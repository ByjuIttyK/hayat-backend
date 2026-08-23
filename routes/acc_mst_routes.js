// ─────────────────────────────────────────────────────────────────────────
//  Express routes for the Account Master screen (acc_mst).
//
//  Callback-flavoured version — for a plain `mysql` or non-promise
//  `mysql2` pool where connection.query() takes a (sql, params, cb)
//  triple instead of returning a promise.
//
//  Mount from your server bootstrap the same way you mount the other
//  route modules:
//    const accMstRoutes = require('./routes/acc_mst_routes');
//    app.use('/api', accMstRoutes(connection));
//
//  Endpoints:
//    GET    /accmst-list                             — list, filterable
//    GET    /nextAccCode/:reportLn/:glCode/:subLedger — MAX(SrNo)+1 → RL-GL-SL-SrNo
//    POST   /save-accmst                             — INSERT ... ON DUPLICATE KEY UPDATE
//    DELETE /delete-accmst/:accCode                  — hard delete
//    GET    /rpln-list                               — LOV for Report Line
//    GET    /gl-list/:reportLn                       — LOV for GL Code (scoped)
// ─────────────────────────────────────────────────────────────────────────

const express = require('express');

module.exports = function (connection) {
  const router = express.Router();

  // ── 1) List accounts ──────────────────────────────────────────────────
  router.get('/accmst-list', (req, res) => {
    const { reportLn, search } = req.query;
    const where = [];
    const params = [];

    if (reportLn) {
      where.push('REPORT_LN = ?');
      params.push(reportLn);
    }
    if (search) {
      where.push('(ACC_CODE LIKE ? OR ACC_HEAD LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    const sql = `
      SELECT ACC_CODE, ACC_HEAD, REPORT_LN, GL_CODE, SUB_LEDGER,
             OP_BAL, OP_DBCR, CL_BAL, CL_DBCR,
             MN_OPBAL, YR_BUDGET, USER_NAME, START_DATE,
             SUB_CAT_CODE, ACC_TYPE
        FROM acc_mst
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY REPORT_LN, ACC_CODE
       LIMIT 5000
    `;

    connection.query(sql, params, (err, rows) => {
      if (err) {
        console.error('/accmst-list error:', err);
        return res.status(500).json({ error: 'Failed to load accounts' });
      }
      res.json(rows);
    });
  });

  // ── 2) Next ACC_CODE for a given (REPORT_LN, GL_CODE, SUB_LEDGER) ─────
  //
  // ACC_CODE format is {REPORT_LN}-{GL_CODE}-{SUB_LEDGER}-{SrNo(3)}, e.g.
  //   111-011-0-003
  //
  // Rule from Byju:
  //   Next SrNo = MAX(last segment) + 1
  //   WHERE REPORT_LN = ? AND GL_CODE = ? AND SUB_LEDGER = ?
  //
  // SUBSTRING_INDEX(ACC_CODE, '-', -1) pulls "003" out of "111-011-0-003".
  // CAST to UNSIGNED handles the numeric bump; anything non-numeric (a
  // legacy row like 1206003-000000) gets clamped to 0 by CAST, which is
  // fine because we're only computing MAX+1 for future SrNos.
  //
  // The response is the FULLY-FORMATTED code — the client doesn't have
  // to assemble it. Width stays 3 to match the sample data.
  router.get('/nextAccCode/:reportLn/:glCode/:subLedger', (req, res) => {
    const { reportLn, glCode, subLedger } = req.params;
    if (!reportLn)  return res.status(400).json({ error: 'reportLn is required' });
    if (!glCode)    return res.status(400).json({ error: 'glCode is required' });
    if (!subLedger) return res.status(400).json({ error: 'subLedger is required' });

    connection.query(
      `SELECT COALESCE(
                MAX(CAST(SUBSTRING_INDEX(ACC_CODE, '-', -1) AS UNSIGNED)),
                0
              ) + 1 AS NEXT_NO
         FROM acc_mst
        WHERE REPORT_LN = ?
          AND GL_CODE   = ?
          AND SUB_LEDGER = ?`,
      [reportLn, glCode, subLedger],
      (err, rows) => {
        if (err) {
          console.error('/nextAccCode error:', err);
          return res.status(500).json({ error: 'Failed to compute next account code' });
        }
        const nextNo = (rows && rows[0] && rows[0].NEXT_NO) || 1;
        const srNo = String(nextNo).padStart(3, '0');
        const nextCode = `${reportLn}-${glCode}-${subLedger}-${srNo}`;
        res.json({ NEXT_CODE: nextCode, NEXT_NO: nextNo });
      }
    );
  });

  // ── 3) Save an account ────────────────────────────────────────────────
  router.post('/save-accmst', (req, res) => {
    const body = req.body || {};
    if (!body.ACC_CODE) return res.status(400).json({ error: 'ACC_CODE is required' });
    if (!body.ACC_HEAD) return res.status(400).json({ error: 'ACC_HEAD is required' });

    // Whitelist to actual acc_mst columns — silently drop anything else so
    // stray client-only fields (_rowKey, _isNew) can't blow up the query.
    // SUB_LEDGER included so new rows persist their sub-ledger flag.
    const ALLOWED = [
      'ACC_CODE', 'ACC_HEAD', 'REPORT_LN', 'GL_CODE', 'SUB_LEDGER',
      'OP_BAL', 'OP_DBCR', 'CL_BAL', 'CL_DBCR',
      'MN_OPBAL', 'YR_BUDGET', 'USER_NAME', 'START_DATE',
      'SUB_CAT_CODE', 'ACC_TYPE',
    ];
    const columns = ALLOWED.filter(c => body[c] !== undefined);
    const values  = columns.map(c => body[c]);

    const placeholders = columns.map(() => '?').join(', ');
    const updateFrag = columns
      .filter(c => c !== 'ACC_CODE')
      .map(c => `${c} = VALUES(${c})`)
      .join(', ');

    const sql = `
      INSERT INTO acc_mst (${columns.join(', ')})
      VALUES (${placeholders})
      ${updateFrag ? 'ON DUPLICATE KEY UPDATE ' + updateFrag : ''}
    `;

    connection.query(sql, values, (err) => {
      if (err) {
        console.error('/save-accmst error:', err);
        return res.status(500).json({ error: 'Failed to save account' });
      }
      res.json({ ok: true, ACC_CODE: body.ACC_CODE });
    });
  });

  // ── 4) Delete an account ──────────────────────────────────────────────
  router.delete('/delete-accmst/:accCode', (req, res) => {
    const { accCode } = req.params;
    if (!accCode) return res.status(400).json({ error: 'accCode is required' });

    connection.query(
      'DELETE FROM acc_mst WHERE ACC_CODE = ?',
      [accCode],
      (err, result) => {
        if (err) {
          console.error('/delete-accmst error:', err);
          if (err.code === 'ER_ROW_IS_REFERENCED_2') {
            return res.status(409).json({
              error: 'Cannot delete — this account is used by other transactions',
            });
          }
          return res.status(500).json({ error: 'Failed to delete account' });
        }
        res.json({ ok: true, affectedRows: (result && result.affectedRows) || 0 });
      }
    );
  });

  // ── 5) LOV: Report Line list ──────────────────────────────────────────
  // Returns the full rpln_mst table. Structure per the DESCRIBE:
  //   PRIMARY_GROUP  varchar(2)   PK
  //   REPORT_LN      varchar(6)   PK
  //   RP_HEAD        varchar(30)
  //   USER_NAME      varchar(30)
  router.get('/rpln-list', (req, res) => {
    connection.query(
      `SELECT PRIMARY_GROUP, REPORT_LN, RP_HEAD
         FROM rpln_mst
        ORDER BY PRIMARY_GROUP, REPORT_LN`,
      (err, rows) => {
        if (err) {
          console.error('/rpln-list error:', err);
          return res.status(500).json({ error: 'Failed to load report line list' });
        }
        res.json(rows);
      }
    );
  });

  // ── 6) LOV: GL Code list — scoped to a Report Line ────────────────────
  // gl_mst.GL_CODE is only unique WITHIN a REPORT_LN (composite PK on
  // REPORT_LN + GL_CODE per the DESCRIBE), so this endpoint requires
  // the report line and filters by it.
  //   GL_CODE     varchar(4)   PK (composite)
  //   GL_HEAD     varchar(50)
  //   REPORT_LN   varchar(6)   PK (composite)
  //   HEADER      varchar(1)
  //   USER_NAME   varchar(30)
  router.get('/gl-list/:reportLn', (req, res) => {
    const { reportLn } = req.params;
    if (!reportLn) return res.status(400).json({ error: 'reportLn is required' });

    connection.query(
      `SELECT GL_CODE, GL_HEAD, REPORT_LN, HEADER
         FROM gl_mst
        WHERE REPORT_LN = ?
        ORDER BY GL_CODE`,
      [reportLn],
      (err, rows) => {
        if (err) {
          console.error('/gl-list error:', err);
          return res.status(500).json({ error: 'Failed to load GL code list' });
        }
        res.json(rows);
      }
    );
  });

  return router;
};
