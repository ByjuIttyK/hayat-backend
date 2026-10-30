// =====================================================================
// salRevApi.js — Salary Revision vouchers (SalRev screen)  30-Oct-2026
//
//   GET  /api/sal-rev/:revNo                 voucher (hdr + lines) and the employee's revision history
//   GET  /api/sal-rev-current/:empCode?eff=  pay in force just before the revision applies (old amounts)
//   GET  /api/sal-rev-emps?q=                employees (F9)
//   GET  /api/sal-rev-list?q=&status=        vouchers — list screen and the Open… popup
//   POST /api/save-sal-rev                   { mode: 'ADD'|'EDIT', revNo, hdr, lines }  (Draft only)
//   POST /api/approve-sal-rev                { revNo }  → STATUS 'A', masters updated when due
//   POST /api/delete-sal-rev                 { revNo }  (Draft only)
//   GET  /api/sal-rev-company                company row for the letter's letterhead
//   GET  /api/pay-for-period/:empCode?month=YYYY-MM-01
//                                            pay for that month (time sheet: basic, allowances, deductions)
//
//   Allowance / deduction codes for F9 come from /api/allow-ded-codes (empAllowDedApi.js).
//   Rule: apply from the 1st (salRevPay.js). Back-dating: approval refused when a time sheet of the
//   employee for the APPLY_FROM month or later is already Time / Job approved.
//
// Register in HayatDb.js:
//   const salRevApi = require('./routes/salRevApi');
//   app.use('/api', salRevApi(connection));
// =====================================================================
const express = require('express');
const { applyFromOf, payAsOf, applyDue } = require('./salRevPay');

module.exports = function (connection) {
  const router = express.Router();
  const getConn = () =>
    new Promise((resolve, reject) => connection.getConnection((err, conn) => (err ? reject(err) : resolve(conn))));
  const q = (conn, sql, params = []) =>
    new Promise((resolve, reject) => conn.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
  const userOf = (req) => (req.user && (req.user.username || req.user.USER_NAME || req.user.userId)) || null;
  const amt3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
  const dayBefore = (iso) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };
  const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

  const withConn = (fn) => async (req, res) => {
    let conn;
    try {
      conn = await getConn();
      await fn(conn, req, res);
    } catch (err) {
      if (conn) await q(conn, 'ROLLBACK').catch(() => {});
      console.error('salRevApi:', err);
      res.status(400).json({ ok: false, message: err.message });
    } finally {
      if (conn) conn.release();
    }
  };

  // code → description lookups
  const descMaps = async (conn) => {
    const a = await q(conn, `SELECT ALLOW_CODE c, ALLOW_DESC d, ALLOW_TYPE t FROM allow_mst`);
    const d = await q(conn, `SELECT DED_CODE c, DED_DESC d, DED_TYPE t FROM ded_mst`);
    const toMap = (rows) => new Map(rows.map((r) => [Number(r.c), { d: r.d || '', t: r.t || '' }]));
    return { A: toMap(a), D: toMap(d) };
  };
  const descOf = (maps, type, code) => maps[type].get(Number(code))?.d || '';
  const typeOf = (maps, type, code) => maps[type].get(Number(code))?.t || '';
  const withDesc = (maps, type, list) => list.map((x) => ({ ...x, desc: descOf(maps, type, x.code) }));

  const history = (conn, empCode, exceptNo = '') =>
    q(
      conn,
      `SELECT h.REV_NO, DATE_FORMAT(h.EFF_DATE,'%Y-%m-%d') EFF_DATE, DATE_FORMAT(h.APPLY_FROM,'%Y-%m-%d') APPLY_FROM,
              h.REV_TYPE, h.STATUS, b.OLD_AMT BASIC_OLD, b.NEW_AMT BASIC_NEW,
              (SELECT COUNT(*) FROM sal_rev_dtl x WHERE x.REV_NO = h.REV_NO) LINE_CNT
         FROM sal_rev_hdr h LEFT JOIN sal_rev_dtl b ON b.REV_NO = h.REV_NO AND b.ITEM_TYPE = 'B'
        WHERE h.EMP_CODE = ? AND h.REV_NO <> ?
        ORDER BY h.APPLY_FROM DESC, h.REV_NO DESC LIMIT 20`,
      [empCode, exceptNo],
    );

  // ---------------------------------------------------------------
  router.get('/sal-rev/:revNo', withConn(async (conn, req, res) => {
    const revNo = String(req.params.revNo || '').trim().toUpperCase();
    const hdr = (await q(
      conn,
      `SELECT h.REV_NO, DATE_FORMAT(h.REV_DATE,'%Y-%m-%d') REV_DATE, h.EMP_CODE, e.EMP_NAME,
              DATE_FORMAT(h.EFF_DATE,'%Y-%m-%d') EFF_DATE, DATE_FORMAT(h.APPLY_FROM,'%Y-%m-%d') APPLY_FROM,
              h.REV_TYPE, h.REASON, h.STATUS, h.APPLIED, h.APPROVED_BY, DATE_FORMAT(h.APPROVED_DT,'%Y-%m-%d') APPROVED_DT
         FROM sal_rev_hdr h LEFT JOIN emp_mst e ON e.EMP_CODE = h.EMP_CODE WHERE h.REV_NO = ?`,
      [revNo],
    ))[0];
    if (!hdr) return res.status(404).json({ ok: false, message: `Revision ${revNo} not found` });
    const maps = await descMaps(conn);
    const lines = (await q(conn, `SELECT ITEM_TYPE, ITEM_CODE, OLD_AMT, NEW_AMT FROM sal_rev_dtl WHERE REV_NO = ? ORDER BY LINE_NO`, [revNo])).map(
      (l) => ({ ...l, ITEM_DESC: l.ITEM_TYPE === 'B' ? 'Basic salary' : descOf(maps, l.ITEM_TYPE, l.ITEM_CODE) }),
    );
    // the employee's other items as they stood just before this revision (for the gross)
    const before = await payAsOf(q, conn, hdr.EMP_CODE, dayBefore(hdr.APPLY_FROM));
    res.json({
      ok: true, hdr, lines,
      current: { basic: before.basic, allow: withDesc(maps, 'A', before.allow), ded: withDesc(maps, 'D', before.ded) },
      history: await history(conn, hdr.EMP_CODE, revNo),
    });
  }));

  router.get('/sal-rev-current/:empCode', withConn(async (conn, req, res) => {
    const empCode = String(req.params.empCode || '').trim().toUpperCase();
    const emp = (await q(conn, `SELECT EMP_CODE, EMP_NAME FROM emp_mst WHERE EMP_CODE = ?`, [empCode]))[0];
    if (!emp) return res.status(404).json({ ok: false, message: `Employee ${empCode} not found` });
    const eff = isIso(req.query.eff) ? req.query.eff : new Date().toISOString().slice(0, 10);
    const applyFrom = applyFromOf(eff);
    const maps = await descMaps(conn);
    const before = await payAsOf(q, conn, empCode, dayBefore(applyFrom));
    res.json({
      ok: true, emp, applyFrom,
      current: { basic: before.basic, allow: withDesc(maps, 'A', before.allow), ded: withDesc(maps, 'D', before.ded) },
      history: await history(conn, empCode),
    });
  }));

  router.get('/sal-rev-emps', withConn(async (conn, req, res) => {
    const s = `%${String(req.query.q || '').trim()}%`;
    res.json(await q(conn, `SELECT EMP_CODE, EMP_NAME, CARD_NO FROM emp_mst WHERE EMP_CODE LIKE ? OR EMP_NAME LIKE ? OR CARD_NO LIKE ? ORDER BY EMP_CODE LIMIT 100`, [s, s, s]));
  }));

  // list screen + Open… popup. ?status=D|A to filter
  router.get('/sal-rev-list', withConn(async (conn, req, res) => {
    const s = `%${String(req.query.q || '').trim()}%`;
    const st = ['D', 'A'].includes(String(req.query.status)) ? String(req.query.status) : '';
    res.json(await q(
      conn,
      `SELECT h.REV_NO, DATE_FORMAT(h.REV_DATE,'%d/%m/%Y') REV_DATE, h.EMP_CODE, e.EMP_NAME,
              DATE_FORMAT(h.EFF_DATE,'%d/%m/%Y') EFF_DATE, DATE_FORMAT(h.APPLY_FROM,'%d/%m/%Y') APPLY_FROM,
              h.REV_TYPE, h.REASON, h.STATUS, h.APPLIED, h.APPROVED_BY,
              CASE h.STATUS WHEN 'A' THEN 'Approved' ELSE 'Draft' END STATUS_TEXT,
              b.OLD_AMT BASIC_OLD, b.NEW_AMT BASIC_NEW,
              (SELECT IFNULL(SUM(CASE x.ITEM_TYPE WHEN 'D' THEN -(x.NEW_AMT - x.OLD_AMT) ELSE x.NEW_AMT - x.OLD_AMT END), 0)
                 FROM sal_rev_dtl x WHERE x.REV_NO = h.REV_NO) GROSS_CHANGE,
              (SELECT COUNT(*) FROM sal_rev_dtl x WHERE x.REV_NO = h.REV_NO) LINE_CNT
         FROM sal_rev_hdr h
         LEFT JOIN emp_mst e ON e.EMP_CODE = h.EMP_CODE
         LEFT JOIN sal_rev_dtl b ON b.REV_NO = h.REV_NO AND b.ITEM_TYPE = 'B'
        WHERE (h.REV_NO LIKE ? OR h.EMP_CODE LIKE ? OR e.EMP_NAME LIKE ?) ${st ? 'AND h.STATUS = ?' : ''}
        ORDER BY h.REV_DATE DESC, h.REV_NO DESC LIMIT 1000`,
      st ? [s, s, s, st] : [s, s, s],
    ));
  }));

  // ---------------------------------------------------------------
  /** Validates and normalises the lines; keeps changed lines only. */
  const cleanLines = (lines) => {
    const seen = new Set();
    const out = [];
    for (const l of lines || []) {
      const type = String(l.ITEM_TYPE || '').toUpperCase();
      if (!['B', 'A', 'D'].includes(type)) continue;
      const code = type === 'B' ? 0 : Number(l.ITEM_CODE);
      if (type !== 'B' && !(code > 0)) continue;
      const k = `${type}|${code}`;
      if (seen.has(k)) throw new Error(`${type === 'B' ? 'Basic' : `Code ${code}`} is entered twice`);
      seen.add(k);
      const oldAmt = amt3(l.OLD_AMT), newAmt = amt3(l.NEW_AMT);
      if (newAmt < 0) throw new Error('Revised amount cannot be negative');
      if (type === 'B' && !(newAmt > 0)) throw new Error('Revised basic must be more than 0');
      if (oldAmt !== newAmt) out.push({ type, code, oldAmt, newAmt });
    }
    if (!out.length) throw new Error('Nothing is revised — change at least one amount');
    return out;
  };

  router.post('/save-sal-rev', withConn(async (conn, req, res) => {
    const { mode, revNo: givenNo, hdr = {}, lines } = req.body || {};
    const empCode = String(hdr.EMP_CODE || '').trim().toUpperCase();
    if (!empCode) throw new Error('Employee missing');
    if (!isIso(hdr.REV_DATE)) throw new Error('Revision date missing');
    if (!isIso(hdr.EFF_DATE)) throw new Error('Effective date missing');
    const clean = cleanLines(lines);
    const applyFrom = applyFromOf(hdr.EFF_DATE);
    const who = userOf(req);
    const year = hdr.REV_DATE.slice(0, 4);

    for (let attempt = 0; attempt < 3; attempt++) {
      await q(conn, 'START TRANSACTION');
      let revNo = String(givenNo || '').trim().toUpperCase();
      if (mode === 'EDIT') {
        const cur = (await q(conn, `SELECT STATUS FROM sal_rev_hdr WHERE REV_NO = ? FOR UPDATE`, [revNo]))[0];
        if (!cur) throw new Error(`Revision ${revNo} not found`);
        if (cur.STATUS !== 'D') throw new Error('An approved revision cannot be changed — make a new revision');
        await q(
          conn,
          `UPDATE sal_rev_hdr SET REV_DATE=?, EMP_CODE=?, EFF_DATE=?, APPLY_FROM=?, REV_TYPE=?, REASON=?, MODIFIED_BY=? WHERE REV_NO=?`,
          [hdr.REV_DATE, empCode, hdr.EFF_DATE, applyFrom, hdr.REV_TYPE || 'INCREMENT', hdr.REASON || null, who, revNo],
        );
        await q(conn, `DELETE FROM sal_rev_dtl WHERE REV_NO = ?`, [revNo]);
      } else {
        // new number = MAX + 1 for the year; the PK catches a clash and we retry
        const last = (await q(conn, `SELECT MAX(CAST(SUBSTRING(REV_NO, 11) AS UNSIGNED)) n FROM sal_rev_hdr WHERE REV_NO LIKE ?`, [`SREV-${year}-%`]))[0];
        revNo = `SREV-${year}-${String((Number(last?.n) || 0) + 1).padStart(4, '0')}`;
        try {
          await q(
            conn,
            `INSERT INTO sal_rev_hdr (REV_NO, REV_DATE, EMP_CODE, EFF_DATE, APPLY_FROM, REV_TYPE, REASON, CREATED_BY) VALUES (?,?,?,?,?,?,?,?)`,
            [revNo, hdr.REV_DATE, empCode, hdr.EFF_DATE, applyFrom, hdr.REV_TYPE || 'INCREMENT', hdr.REASON || null, who],
          );
        } catch (e) {
          await q(conn, 'ROLLBACK');
          if (e.code === 'ER_DUP_ENTRY') continue;
          throw e;
        }
      }
      let ln = 0;
      for (const l of clean)
        await q(conn, `INSERT INTO sal_rev_dtl (REV_NO, LINE_NO, ITEM_TYPE, ITEM_CODE, OLD_AMT, NEW_AMT) VALUES (?,?,?,?,?,?)`, [revNo, ++ln, l.type, l.code, l.oldAmt, l.newAmt]);
      await q(conn, 'COMMIT');
      return res.json({ ok: true, revNo, applyFrom, message: `Revision ${revNo} saved` });
    }
    throw new Error('Could not get a revision number — please save again');
  }));

  router.post('/approve-sal-rev', withConn(async (conn, req, res) => {
    const revNo = String(req.body?.revNo || '').trim().toUpperCase();
    await q(conn, 'START TRANSACTION');
    const h = (await q(conn, `SELECT EMP_CODE, STATUS, DATE_FORMAT(APPLY_FROM,'%Y-%m-%d') APPLY_FROM FROM sal_rev_hdr WHERE REV_NO = ? FOR UPDATE`, [revNo]))[0];
    if (!h) throw new Error(`Revision ${revNo} not found`);
    if (h.STATUS !== 'D') throw new Error('Already approved');

    // no back-dating into approved time sheets
    const locked = await q(
      conn,
      `SELECT TSHT_NO, DATE_FORMAT(TSHT_DATE,'%m/%Y') MON FROM time_sheet_hdr
        WHERE EMP_CODE = ? AND STATUS IN ('T','A') AND LAST_DAY(TSHT_DATE) >= ? ORDER BY TSHT_DATE LIMIT 1`,
      [h.EMP_CODE, h.APPLY_FROM],
    );
    if (locked.length)
      throw new Error(`The time sheet for ${locked[0].MON} (${locked[0].TSHT_NO}) is already approved — the revision would apply to it. Revoke that approval first or change the effective date.`);

    // old amounts as they stand now (another revision may have been approved since this was saved)
    const before = await payAsOf(q, conn, h.EMP_CODE, dayBefore(h.APPLY_FROM));
    const oldOf = (type, code) =>
      type === 'B' ? before.basic : (before[type === 'A' ? 'allow' : 'ded'].find((x) => x.code === Number(code))?.amount || 0);
    const lines = await q(conn, `SELECT LINE_NO, ITEM_TYPE, ITEM_CODE, NEW_AMT FROM sal_rev_dtl WHERE REV_NO = ?`, [revNo]);
    let changed = 0;
    for (const l of lines) {
      const old = amt3(oldOf(l.ITEM_TYPE, l.ITEM_CODE));
      if (old !== amt3(l.NEW_AMT)) changed++;
      await q(conn, `UPDATE sal_rev_dtl SET OLD_AMT = ? WHERE REV_NO = ? AND LINE_NO = ?`, [old, revNo, l.LINE_NO]);
    }
    if (!changed) throw new Error('Nothing is revised any more — the amounts already match the current pay');

    await q(conn, `UPDATE sal_rev_hdr SET STATUS = 'A', APPROVED_BY = ?, APPROVED_DT = NOW() WHERE REV_NO = ?`, [userOf(req), revNo]);
    const applied = await applyDue(q, conn, h.EMP_CODE);
    await q(conn, 'COMMIT');
    res.json({
      ok: true, revNo,
      message: applied ? `Revision ${revNo} approved — employee master updated` : `Revision ${revNo} approved — applies from ${h.APPLY_FROM.split('-').reverse().join('/')}`,
    });
  }));

  router.post('/delete-sal-rev', withConn(async (conn, req, res) => {
    const revNo = String(req.body?.revNo || '').trim().toUpperCase();
    await q(conn, 'START TRANSACTION');
    const h = (await q(conn, `SELECT STATUS FROM sal_rev_hdr WHERE REV_NO = ? FOR UPDATE`, [revNo]))[0];
    if (!h) throw new Error(`Revision ${revNo} not found`);
    if (h.STATUS !== 'D') throw new Error('An approved revision cannot be deleted');
    await q(conn, `DELETE FROM sal_rev_hdr WHERE REV_NO = ?`, [revNo]); // lines go by ON DELETE CASCADE
    await q(conn, 'COMMIT');
    res.json({ ok: true, message: `Revision ${revNo} deleted` });
  }));

  // company row for the letterhead (name, address, contacts, LOGO_FILENAME)
  router.get('/sal-rev-company', withConn(async (conn, req, res) => {
    res.json((await q(conn, `SELECT * FROM company LIMIT 1`))[0] || {});
  }));

  // pay for a month — the time sheet uses this for basic, allowances and deductions
  router.get('/pay-for-period/:empCode', withConn(async (conn, req, res) => {
    const empCode = String(req.params.empCode || '').trim().toUpperCase();
    const month = isIso(req.query.month) ? `${req.query.month.slice(0, 8)}01` : `${new Date().toISOString().slice(0, 8)}01`;
    await q(conn, 'START TRANSACTION');
    await applyDue(q, conn, empCode); // keep the masters current
    await q(conn, 'COMMIT');
    const maps = await descMaps(conn);
    const pay = await payAsOf(q, conn, empCode, month);
    res.json({
      ok: true, month,
      basic: pay.basic,
      allow: pay.allow.map((x) => ({ ALLOW_CODE: x.code, ALLOW_DESC: descOf(maps, 'A', x.code), ALLOW_TYPE: typeOf(maps, 'A', x.code), AMOUNT: x.amount })),
      ded: pay.ded.map((x) => ({ DED_CODE: x.code, DED_DESC: descOf(maps, 'D', x.code), DED_TYPE: typeOf(maps, 'D', x.code), AMOUNT: x.amount })),
    });
  }));

  return router;
};
