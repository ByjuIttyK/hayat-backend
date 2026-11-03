// =====================================================================
// routes/salSchemeApi.js — Salary Calculation Scheme master (SalSchemeMst) — 03-Nov-2026
//
// Register in HayatDb.js:
//   const salSchemeApi = require('./routes/salSchemeApi');
//   app.use('/api', salSchemeApi(connection));
//
// Tables: sal_scheme_mst, emp_catg_mst.SAL_SCHEME, emp_mst.EMP_CATG   (see sal_scheme.sql)
//
//   GET    /sal-scheme/list               all schemes
//   POST   /sal-scheme/save               { mode: 'ADD' | 'EDIT', row }
//   DELETE /sal-scheme/:code              refused while a category or a time sheet uses it
//   GET    /sal-scheme/catgs              employee categories with their scheme
//   POST   /sal-scheme/catg               { catgCode, scheme }   (scheme '' = use the default)
//
// Shared with routes/timeSheetApi.js:
//   loadScheme(conn, code)         one scheme as the screen uses it
//   resolveScheme(conn, empCode)   category scheme → default scheme → built-in A
// =====================================================================
const express = require('express');

/** Built-in scheme A — used when sal_scheme_mst is missing or empty, so pay never stops. */
const SCHEME_A = {
  code: 'A',
  name: 'HOURLY RATE (365-DAY YEAR)',
  dayBasis: 'Y',
  prorateAllow: false,
  lateBasis: 'H',
  notFactor: 1.25,
  hotFactor: 1.5,
};

const toScheme = (r) =>
  r
    ? {
        code: r.SCHEME_CODE,
        name: r.SCHEME_NAME,
        dayBasis: ['Y', 'C', 'F'].includes(r.DAY_BASIS) ? r.DAY_BASIS : 'Y',
        prorateAllow: r.PRORATE_ALLOW === 'Y',
        lateBasis: r.LATE_BASIS === 'D' ? 'D' : 'H',
        notFactor: Number(r.NOT_FACTOR) || 1.25,
        hotFactor: Number(r.HOT_FACTOR) || 1.5,
      }
    : null;

async function loadScheme(conn, code) {
  if (!code) return SCHEME_A;
  try {
    const [rows] = await conn.query('SELECT * FROM sal_scheme_mst WHERE SCHEME_CODE = ?', [code]);
    return toScheme(rows[0]) || SCHEME_A;
  } catch (e) {
    console.warn('[sal-scheme] not read:', e.code || e.message);
    return SCHEME_A;
  }
}

/** Scheme of the employee's category, else the default scheme, else built-in A. */
async function resolveScheme(conn, empCode) {
  try {
    const [rows] = await conn.query(
      `SELECT s.*
         FROM emp_mst e
         LEFT JOIN emp_catg_mst c ON c.catg_code = e.EMP_CATG
         JOIN sal_scheme_mst s
           ON s.SCHEME_CODE = COALESCE(NULLIF(c.SAL_SCHEME, ''),
                                       (SELECT d.SCHEME_CODE FROM sal_scheme_mst d WHERE d.IS_DEFAULT = 'Y' AND d.ACTIVE = 'Y' LIMIT 1))
        WHERE e.EMP_CODE = ?`,
      [empCode],
    );
    return toScheme(rows[0]) || SCHEME_A;
  } catch (e) {
    console.warn('[sal-scheme] not resolved, using A:', e.code || e.message);
    return SCHEME_A;
  }
}

const userOf = (req) => (req.user && (req.user.USER_NAME || req.user.username || req.user.user_name)) || 'system';
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const send = (res, e) => {
  if (!e.status) console.error('[sal-scheme]', e);
  res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : e.sqlMessage || e.message });
};

function salSchemeApi(connection) {
  const router = express.Router();
  const db = connection.promise();

  router.get('/sal-scheme/list', async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT s.*, DATE_FORMAT(s.CREATED_DT, '%d/%m/%Y %H:%i') AS CREATED_ON, DATE_FORMAT(s.EDITED_DT, '%d/%m/%Y %H:%i') AS EDITED_ON,
                (SELECT COUNT(*) FROM emp_catg_mst c WHERE c.SAL_SCHEME = s.SCHEME_CODE) AS CATG_COUNT
           FROM sal_scheme_mst s ORDER BY s.SCHEME_CODE`,
      );
      res.json({ ok: true, rows });
    } catch (e) {
      send(res, e);
    }
  });

  router.post('/sal-scheme/save', async (req, res) => {
    const { mode, row = {} } = req.body || {};
    const user = String(userOf(req)).slice(0, 20);
    let conn;
    try {
      const code = String(row.SCHEME_CODE || '').trim().toUpperCase();
      const name = String(row.SCHEME_NAME || '').trim().toUpperCase().slice(0, 50);
      if (!/^[A-Z0-9]{1,2}$/.test(code)) throw httpErr(400, 'Scheme code: 1 or 2 letters / digits');
      if (!name) throw httpErr(400, 'Scheme name is required');
      if (!['Y', 'C', 'F'].includes(row.DAY_BASIS)) throw httpErr(400, 'Day basis must be Y, C or F');
      if (!['Y', 'N'].includes(row.PRORATE_ALLOW)) throw httpErr(400, 'Prorate allowances must be Y or N');
      if (!['H', 'D'].includes(row.LATE_BASIS)) throw httpErr(400, 'Late / short rate must be H or D');
      const notF = Number(row.NOT_FACTOR);
      const hotF = Number(row.HOT_FACTOR);
      if (!(notF > 0 && notF < 10) || !(hotF > 0 && hotF < 10)) throw httpErr(400, 'OT factors must be between 0 and 10');
      const isDefault = row.IS_DEFAULT === 'Y' ? 'Y' : 'N';
      const active = row.ACTIVE === 'N' ? 'N' : 'Y';
      if (isDefault === 'Y' && active === 'N') throw httpErr(400, 'The default scheme must be active');
      const remarks = row.REMARKS ? String(row.REMARKS).slice(0, 200) : null;

      conn = await db.getConnection();
      await conn.beginTransaction();
      const [ex] = await conn.query('SELECT IS_DEFAULT FROM sal_scheme_mst WHERE SCHEME_CODE = ? FOR UPDATE', [code]);
      if (mode === 'ADD' && ex.length) throw httpErr(409, `Scheme ${code} already exists`);
      if (mode !== 'ADD' && !ex.length) throw httpErr(404, `Scheme ${code} not found`);
      if (mode !== 'ADD' && ex[0].IS_DEFAULT === 'Y' && isDefault === 'N') {
        throw httpErr(400, 'Make another scheme the default instead (one scheme must stay the default)');
      }
      if (isDefault === 'Y') await conn.execute("UPDATE sal_scheme_mst SET IS_DEFAULT = 'N' WHERE SCHEME_CODE <> ?", [code]);

      const vals = [name, row.DAY_BASIS, row.PRORATE_ALLOW, row.LATE_BASIS, notF, hotF, isDefault, active, remarks];
      if (mode === 'ADD') {
        await conn.execute(
          `INSERT INTO sal_scheme_mst
             (SCHEME_CODE, SCHEME_NAME, DAY_BASIS, PRORATE_ALLOW, LATE_BASIS, NOT_FACTOR, HOT_FACTOR, IS_DEFAULT, ACTIVE, REMARKS, CREATED_BY, CREATED_DT)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
          [code, ...vals, user],
        );
      } else {
        await conn.execute(
          `UPDATE sal_scheme_mst
              SET SCHEME_NAME = ?, DAY_BASIS = ?, PRORATE_ALLOW = ?, LATE_BASIS = ?, NOT_FACTOR = ?, HOT_FACTOR = ?,
                  IS_DEFAULT = ?, ACTIVE = ?, REMARKS = ?, EDITED_BY = ?, EDITED_DT = NOW()
            WHERE SCHEME_CODE = ?`,
          [...vals, user, code],
        );
      }
      await conn.commit();
      res.json({ ok: true, code, message: `Scheme ${code} ${mode === 'ADD' ? 'added' : 'updated'}` });
    } catch (e) {
      if (conn) await conn.rollback().catch(() => {});
      send(res, e);
    } finally {
      if (conn) conn.release();
    }
  });

  router.delete('/sal-scheme/:code', async (req, res) => {
    try {
      const code = String(req.params.code || '').toUpperCase();
      const [s] = await db.query('SELECT IS_DEFAULT FROM sal_scheme_mst WHERE SCHEME_CODE = ?', [code]);
      if (!s.length) throw httpErr(404, `Scheme ${code} not found`);
      if (s[0].IS_DEFAULT === 'Y') throw httpErr(409, 'The default scheme cannot be deleted');
      const [c] = await db.query('SELECT COUNT(*) AS N FROM emp_catg_mst WHERE SAL_SCHEME = ?', [code]);
      if (c[0].N) throw httpErr(409, `Scheme ${code} is set on ${c[0].N} employee categor${c[0].N === 1 ? 'y' : 'ies'}`);
      const [t] = await db.query('SELECT COUNT(*) AS N FROM time_sheet_hdr WHERE SAL_SCHEME = ?', [code]);
      if (t[0].N) throw httpErr(409, `Scheme ${code} is used by ${t[0].N} time sheet(s) — set it inactive instead`);
      await db.query('DELETE FROM sal_scheme_mst WHERE SCHEME_CODE = ?', [code]);
      res.json({ ok: true, message: `Scheme ${code} deleted` });
    } catch (e) {
      send(res, e);
    }
  });

  router.get('/sal-scheme/catgs', async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT c.catg_code AS CATG_CODE, c.catg_name AS CATG_NAME, c.SAL_SCHEME,
                (SELECT COUNT(*) FROM emp_mst e WHERE e.EMP_CATG = c.catg_code) AS EMP_COUNT
           FROM emp_catg_mst c ORDER BY c.catg_code`,
      );
      res.json({ ok: true, rows });
    } catch (e) {
      send(res, e);
    }
  });

  router.post('/sal-scheme/catg', async (req, res) => {
    try {
      const catg = String((req.body && req.body.catgCode) || '').trim();
      const scheme = String((req.body && req.body.scheme) || '').trim().toUpperCase() || null;
      if (!catg) throw httpErr(400, 'Category is required');
      if (scheme) {
        const [s] = await db.query("SELECT ACTIVE FROM sal_scheme_mst WHERE SCHEME_CODE = ?", [scheme]);
        if (!s.length) throw httpErr(404, `Scheme ${scheme} not found`);
        if (s[0].ACTIVE !== 'Y') throw httpErr(400, `Scheme ${scheme} is inactive`);
      }
      const [r] = await db.query('UPDATE emp_catg_mst SET SAL_SCHEME = ? WHERE catg_code = ?', [scheme, catg]);
      if (!r.affectedRows) throw httpErr(404, `Category ${catg} not found`);
      console.log(`[sal-scheme] ${userOf(req)} set category ${catg} to scheme ${scheme || '(default)'}`);
      res.json({ ok: true, message: `Category ${catg}: ${scheme ? `scheme ${scheme}` : 'default scheme'}` });
    } catch (e) {
      send(res, e);
    }
  });

  return router;
}

module.exports = salSchemeApi;
module.exports.loadScheme = loadScheme;
module.exports.resolveScheme = resolveScheme;
module.exports.SCHEME_A = SCHEME_A;
