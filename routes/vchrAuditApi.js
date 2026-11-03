// =====================================================================
// routes/vchrAuditApi.js — Voucher Audit (VchrAudit screen) — 03-Nov-2026
//
// Register in HayatDb.js:
//   const vchrAuditApi = require('./routes/vchrAuditApi');
//   app.use('/api', vchrAuditApi(connection));
//
// Tables: tran_acc (G/L lines), vchr_audit (audited vouchers), vchr_audit_log (audit / revoke log),
//         ac_list (account heads), tran_type (type names) — see vchr_audit.sql.
// A voucher = TRAN_TYPE + VCHR_NO in tran_acc. Audited = it has a row in vchr_audit; the
// tran_acc triggers then refuse to add, change or delete its lines (settlement stays open).
//
//   GET  /vchr-audit/meta                       { canAudit, user, types:[{code,name}] }
//   GET  /vchr-audit/list?from&to&type&status   vouchers (status U = unaudited, A = audited, ALL)
//   GET  /vchr-audit/lines/:type/:no            Dr / Cr lines of one voucher
//   POST /vchr-audit/audit   { items:[{tranType,vchrNo}] }
//   POST /vchr-audit/revoke  { items:[...], reason }       reason required, logged
//   POST /vchr-audit/status  { items:[...] }                which of these are audited (InfoGrid lists)
//
// Who may audit / revoke: users listed in VCHR_AUDIT_USERS in .env (comma separated,
// default "admin") — taken from the login token only, never from the request body.
// =====================================================================
const express = require('express');

const AUDIT_USERS = String(process.env.VCHR_AUDIT_USERS || 'admin')
  .split(',')
  .map((u) => u.trim().toLowerCase())
  .filter(Boolean);
const MAX_ROWS = 3000; // list cap — narrow the dates for more
const MAX_ITEMS = 500; // vouchers per audit / revoke call

const userOf = (req) => (req.user && (req.user.USER_NAME || req.user.username || req.user.user_name)) || '';
const canAudit = (req) => {
  const u = String(userOf(req)).trim().toLowerCase();
  return !!u && AUDIT_USERS.includes(u);
};
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/** party of a voucher: its first customer / supplier line (letter in the 2nd character), else its first line */
const PARTY_SQL = `COALESCE(
    SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN SUBSTRING(t.ACC_CODE, 2, 1) REGEXP '[A-Za-z]' THEN t.ACC_CODE END
                                 ORDER BY CAST(t.SR_NO AS UNSIGNED), t.srno_row_id SEPARATOR '|'), '|', 1),
    SUBSTRING_INDEX(GROUP_CONCAT(t.ACC_CODE ORDER BY CAST(t.SR_NO AS UNSIGNED), t.srno_row_id SEPARATOR '|'), '|', 1))`;

module.exports = function vchrAuditApi(connection) {
  const router = express.Router();
  const db = connection.promise();

  const send = (res, e) => {
    if (!e.status) console.error('[vchr-audit]', e);
    res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : e.sqlMessage || e.message });
  };

  /** account heads for a set of codes (ac_list = acc_mst + cus_mst + sup_mst) */
  async function headsOf(codes) {
    const list = Array.from(new Set(codes.filter(Boolean)));
    const map = {};
    if (!list.length) return map;
    try {
      const [rows] = await db.query('SELECT AC_CODE, AC_HEAD FROM ac_list WHERE AC_CODE IN (?)', [list]);
      rows.forEach((r) => (map[r.AC_CODE] = r.AC_HEAD));
    } catch (e) {
      console.warn('[vchr-audit] ac_list not read:', e.code || e.message);
    }
    return map;
  }

  /** transaction type names from tran_type (the description column is found by name) */
  async function typeNames() {
    const map = {};
    try {
      const [rows] = await db.query('SELECT * FROM tran_type');
      rows.forEach((r) => {
        const keys = Object.keys(r);
        const codeKey = keys.find((k) => k.toUpperCase() === 'TRAN_TYPE');
        if (!codeKey) return;
        const nameKey =
          keys.find((k) => /^(TRAN_DESC|TRAN_NAME|DESCRIPTION|DESCR|TRAN_DESCRIPTION|NAME)$/i.test(k)) ||
          keys.find((k) => k !== codeKey && typeof r[k] === 'string' && r[k].length > 2);
        map[String(r[codeKey])] = nameKey ? String(r[nameKey] || '').trim() : '';
      });
    } catch (e) {
      console.warn('[vchr-audit] tran_type not read:', e.code || e.message);
    }
    return map;
  }

  // ---------- who am I + the type list ----------
  router.get('/vchr-audit/meta', async (req, res) => {
    try {
      const names = await typeNames();
      const [rows] = await db.query('SELECT DISTINCT TRAN_TYPE FROM tran_acc ORDER BY TRAN_TYPE');
      const types = rows.map((r) => ({ code: r.TRAN_TYPE, name: names[r.TRAN_TYPE] || '' }));
      res.json({ ok: true, canAudit: canAudit(req), user: userOf(req), types });
    } catch (e) {
      send(res, e);
    }
  });

  // ---------- voucher list ----------
  router.get('/vchr-audit/list', async (req, res) => {
    try {
      const { from, to } = req.query;
      const type = String(req.query.type || 'ALL');
      const status = String(req.query.status || 'U').toUpperCase();
      if (!isYmd(from) || !isYmd(to)) throw httpErr(400, 'From and To dates are required');
      if (to < from) throw httpErr(400, "'To' date is before 'From' date");

      const where = ['t.DATTE BETWEEN ? AND ?'];
      const params = [from, to];
      if (type !== 'ALL') {
        where.push('t.TRAN_TYPE = ?');
        params.push(type);
      }
      const having = status === 'A' ? 'HAVING AUDITED_BY IS NOT NULL' : status === 'U' ? 'HAVING AUDITED_BY IS NULL' : '';

      const [rows] = await db.query(
        `SELECT t.TRAN_TYPE, t.VCHR_NO,
                DATE_FORMAT(MIN(t.DATTE), '%Y-%m-%d') AS DATTE,
                ROUND(SUM(CASE WHEN t.DB_CR = 'D' THEN t.AMOUNT ELSE 0 END), 2) AS DR_TOTAL,
                ROUND(SUM(CASE WHEN t.DB_CR = 'C' THEN t.AMOUNT ELSE 0 END), 2) AS CR_TOTAL,
                COUNT(*) AS LINE_CNT,
                MIN(t.USERNAME) AS USERNAME,
                SUBSTRING_INDEX(GROUP_CONCAT(NULLIF(TRIM(t.NARRATION1), '') ORDER BY CAST(t.SR_NO AS UNSIGNED), t.srno_row_id SEPARATOR '\\n'), '\\n', 1) AS NARR,
                ${PARTY_SQL} AS PARTY_CODE,
                a.AUDITED_BY,
                DATE_FORMAT(a.AUDITED_DT, '%Y-%m-%d %H:%i') AS AUDITED_DT
           FROM tran_acc t
           LEFT JOIN vchr_audit a ON a.TRAN_TYPE = t.TRAN_TYPE AND a.VCHR_NO = t.VCHR_NO
          WHERE ${where.join(' AND ')}
          GROUP BY t.TRAN_TYPE, t.VCHR_NO, a.AUDITED_BY, a.AUDITED_DT
          ${having}
          ORDER BY MIN(t.DATTE) DESC, t.TRAN_TYPE, t.VCHR_NO DESC
          LIMIT ${MAX_ROWS + 1}`,
        params,
      );
      const more = rows.length > MAX_ROWS;
      const list = more ? rows.slice(0, MAX_ROWS) : rows;
      const heads = await headsOf(list.map((r) => r.PARTY_CODE));
      list.forEach((r) => (r.PARTY_HEAD = heads[r.PARTY_CODE] || ''));
      res.json({ ok: true, rows: list, more, max: MAX_ROWS });
    } catch (e) {
      send(res, e);
    }
  });

  // ---------- lines of one voucher ----------
  router.get('/vchr-audit/lines/:type/:no', async (req, res) => {
    try {
      const { type, no } = req.params;
      const [rows] = await db.query(
        `SELECT SR_NO, ACC_CODE, DB_CR, AMOUNT, AMOUNT_FC, NARRATION1, NARRATION2, JOB_NO, REF_NO,
                DATE_FORMAT(DATTE, '%Y-%m-%d') AS DATTE, USERNAME
           FROM tran_acc
          WHERE TRAN_TYPE = ? AND VCHR_NO = ?
          ORDER BY CAST(SR_NO AS UNSIGNED), srno_row_id`,
        [type, no],
      );
      const heads = await headsOf(rows.map((r) => r.ACC_CODE));
      rows.forEach((r) => (r.AC_HEAD = heads[r.ACC_CODE] || ''));
      const [a] = await db.query(
        "SELECT AUDITED_BY, DATE_FORMAT(AUDITED_DT, '%Y-%m-%d %H:%i') AS AUDITED_DT FROM vchr_audit WHERE TRAN_TYPE = ? AND VCHR_NO = ?",
        [type, no],
      );
      const [log] = await db.query(
        `SELECT ACTION, ACTION_BY, DATE_FORMAT(ACTION_DT, '%Y-%m-%d %H:%i') AS ACTION_DT, REASON
           FROM vchr_audit_log WHERE TRAN_TYPE = ? AND VCHR_NO = ? ORDER BY srno_row_id DESC LIMIT 20`,
        [type, no],
      );
      res.json({ ok: true, lines: rows, audit: a[0] || null, log });
    } catch (e) {
      send(res, e);
    }
  });

  // ---------- audit status of many vouchers (InfoGrid lists: lock Edit / Delete) ----------
  // POST { items: [{ tranType, vchrNo }] }  →  { rows: [{ TRAN_TYPE, VCHR_NO, AUDITED_BY, AUDITED_DT }] }
  // Read-only, any logged-in user. Sent in chunks by the screen (utils/auditLock.ts).
  router.post('/vchr-audit/status', async (req, res) => {
    try {
      const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
      const byType = new Map();
      for (const i of items.slice(0, 20000)) {
        const t = String((i && i.tranType) || '').trim();
        const n = String((i && i.vchrNo) || '').trim();
        if (!t || !n) continue;
        if (!byType.has(t)) byType.set(t, new Set());
        byType.get(t).add(n);
      }
      const out = [];
      for (const [t, set] of byType) {
        const nos = Array.from(set);
        for (let k = 0; k < nos.length; k += 1000) {
          const [rows] = await db.query(
            `SELECT TRAN_TYPE, VCHR_NO, AUDITED_BY, DATE_FORMAT(AUDITED_DT, '%Y-%m-%d %H:%i') AS AUDITED_DT
               FROM vchr_audit WHERE TRAN_TYPE = ? AND VCHR_NO IN (?)`,
            [t, nos.slice(k, k + 1000)],
          );
          out.push(...rows);
        }
      }
      res.json({ ok: true, rows: out });
    } catch (e) {
      send(res, e);
    }
  });

  /** checks the caller and the posted voucher list */
  const readItems = (req) => {
    if (!canAudit(req)) throw httpErr(403, 'Only the Chief Accountant can audit or revoke vouchers');
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    const clean = items
      .map((i) => ({ tranType: String(i.tranType || '').trim(), vchrNo: String(i.vchrNo || '').trim() }))
      .filter((i) => i.tranType && i.vchrNo);
    if (!clean.length) throw httpErr(400, 'No vouchers selected');
    if (clean.length > MAX_ITEMS) throw httpErr(400, `At most ${MAX_ITEMS} vouchers at a time`);
    return clean;
  };

  // ---------- audit ----------
  router.post('/vchr-audit/audit', async (req, res) => {
    let conn;
    try {
      const items = readItems(req);
      const user = String(userOf(req)).slice(0, 30);
      conn = await db.getConnection();
      await conn.beginTransaction();
      let done = 0;
      for (const { tranType, vchrNo } of items) {
        const [r] = await conn.query(
          'INSERT IGNORE INTO vchr_audit (TRAN_TYPE, VCHR_NO, AUDITED_BY, AUDITED_DT) VALUES (?, ?, ?, NOW())',
          [tranType, vchrNo, user],
        );
        if (r.affectedRows) {
          done++;
          await conn.query(
            "INSERT INTO vchr_audit_log (TRAN_TYPE, VCHR_NO, ACTION, ACTION_BY, ACTION_DT) VALUES (?, ?, 'A', ?, NOW())",
            [tranType, vchrNo, user],
          );
        }
      }
      await conn.commit();
      res.json({ ok: true, done, skipped: items.length - done, message: `${done} voucher(s) audited and locked` });
    } catch (e) {
      if (conn) await conn.rollback().catch(() => {});
      send(res, e);
    } finally {
      if (conn) conn.release();
    }
  });

  // ---------- revoke ----------
  router.post('/vchr-audit/revoke', async (req, res) => {
    let conn;
    try {
      const items = readItems(req);
      const reason = String((req.body && req.body.reason) || '').trim().slice(0, 200);
      if (!reason) throw httpErr(400, 'A reason is required to revoke an audit');
      const user = String(userOf(req)).slice(0, 30);
      conn = await db.getConnection();
      await conn.beginTransaction();
      let done = 0;
      for (const { tranType, vchrNo } of items) {
        const [r] = await conn.query('DELETE FROM vchr_audit WHERE TRAN_TYPE = ? AND VCHR_NO = ?', [tranType, vchrNo]);
        if (r.affectedRows) {
          done++;
          await conn.query(
            "INSERT INTO vchr_audit_log (TRAN_TYPE, VCHR_NO, ACTION, ACTION_BY, ACTION_DT, REASON) VALUES (?, ?, 'R', ?, NOW(), ?)",
            [tranType, vchrNo, user, reason],
          );
        }
      }
      await conn.commit();
      console.log(`[vchr-audit] ${user} revoked ${done} voucher(s): ${reason}`);
      res.json({ ok: true, done, message: `Audit revoked on ${done} voucher(s)` });
    } catch (e) {
      if (conn) await conn.rollback().catch(() => {});
      send(res, e);
    } finally {
      if (conn) conn.release();
    }
  });

  return router;
};
