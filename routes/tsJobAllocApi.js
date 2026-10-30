// =====================================================================
// tsJobAllocApi.js — Time Sheet Job Allocation (TsJobAlloc screen)  30-Oct-2026
//
//   GET  /api/ts-job-alloc/:tshtNo        header, daily hours, allocation lines, job list
//   GET  /api/ts-job-alloc-sheets?q=      time-approved sheets (LOV when opened without a key)
//   GET  /api/ts-job-alloc-done/:tshtNo   DAY_NOs whose hours are fully allocated (Day colour on TimeSheetEnt)
//   POST /api/save-ts-job-alloc           { tshtNo, lines: [...], approve }
//
// Daily hours = time_sheet_dtl summed per DAY_NO (a midnight-shift day has 2 SEQ_NO rows).
// Allocation lines = time_sheet_job. Saving replaces all lines of the sheet in one
// transaction. Allowed only while the sheet is Time approved (STATUS 'T').
// approve = true also checks every day tallies and sets STATUS 'A' (Job approved).
//
// Register in HayatDb.js:
//   const tsJobAllocApi = require('./routes/tsJobAllocApi');
//   app.use('/api', tsJobAllocApi(connection));
// =====================================================================
const express = require('express');
const { payAsOf } = require('./salRevPay'); // basic in force for the sheet's month (salary revisions)

module.exports = function (connection) {
  const router = express.Router();

  // promise wrappers over the callback pool
  const getConn = () =>
    new Promise((resolve, reject) => connection.getConnection((err, conn) => (err ? reject(err) : resolve(conn))));
  const q = (conn, sql, params = []) =>
    new Promise((resolve, reject) => conn.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

  const userOf = (req) => (req.user && (req.user.username || req.user.USER_NAME || req.user.userId)) || null;
  const int = (v) => Math.max(0, Math.round(Number(v) || 0));
  const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

  // ---------------------------------------------------------------
  const loadHeaderRaw = (conn, tshtNo) =>
    q(
      conn,
      `SELECT h.TSHT_NO, DATE_FORMAT(h.TSHT_DATE,'%Y-%m-%d') AS TSHT_DATE, h.EMP_CODE, e.EMP_NAME, h.STATUS,
              IFNULL(p.BASIC_SAL,0) AS BASIC_SAL,
              IFNULL(h.NORMAL_WAGES,0) AS NORMAL_WAGES, IFNULL(h.NOT_WAGES,0) AS NOT_WAGES, IFNULL(h.HOT_WAGES,0) AS HOT_WAGES
         FROM time_sheet_hdr h
         LEFT JOIN emp_mst e     ON e.EMP_CODE = h.EMP_CODE
         LEFT JOIN payroll_mst p ON p.EMP_CODE = h.EMP_CODE
        WHERE h.TSHT_NO = ?`,
      [tshtNo],
    ).then((r) => r[0] || null);
  // Basic = pay in force for the sheet's month (employee master + approved salary revisions)
  const loadHeader = async (conn, tshtNo) => {
    const hdr = await loadHeaderRaw(conn, tshtNo);
    if (hdr && hdr.TSHT_DATE) hdr.BASIC_SAL = (await payAsOf(q, conn, hdr.EMP_CODE, `${hdr.TSHT_DATE.slice(0, 8)}01`)).basic;
    return hdr;
  };

  const loadDays = (conn, tshtNo) =>
    q(
      conn,
      `SELECT DAY_NO, DATE_FORMAT(MIN(ATT_DATE),'%Y-%m-%d') AS ATT_DATE,
              SUM(IFNULL(NORMAL_HRS,0)) AS NORMAL_MINS,
              SUM(IFNULL(NORMAL_OT,0))  AS NOT_MINS,
              SUM(IFNULL(HOLIDAY_OT,0)) AS HOT_MINS
         FROM time_sheet_dtl
        WHERE TSHT_NO = ?
        GROUP BY DAY_NO
       HAVING SUM(IFNULL(NORMAL_HRS,0)) + SUM(IFNULL(NORMAL_OT,0)) + SUM(IFNULL(HOLIDAY_OT,0)) > 0
        ORDER BY DAY_NO`,
      [tshtNo],
    );

  // ---------------------------------------------------------------
  router.get('/ts-job-alloc/:tshtNo', async (req, res) => {
    let conn;
    try {
      conn = await getConn();
      const tshtNo = String(req.params.tshtNo || '').trim();
      const hdr = await loadHeader(conn, tshtNo);
      if (!hdr) return res.status(404).json({ error: `Time sheet ${tshtNo} not found` });
      const days = await loadDays(conn, tshtNo);
      const lines = await q(
        conn,
        `SELECT DAY_NO, LINE_NO, JOB_NO, NORMAL_MINS, NOT_MINS, HOT_MINS, REMARKS
           FROM time_sheet_job WHERE TSHT_NO = ? ORDER BY DAY_NO, LINE_NO`,
        [tshtNo],
      );
      const jobs = await q(conn, `SELECT JOB_NO, PROJ_NAME FROM job_card ORDER BY JOB_NO DESC`);
      res.json({ hdr, days, lines, jobs });
    } catch (err) {
      console.error('ts-job-alloc load:', err);
      res.status(500).json({ error: err.message });
    } finally {
      if (conn) conn.release();
    }
  });

  // days where every hours column of time_sheet_job tallies with time_sheet_dtl
  router.get('/ts-job-alloc-done/:tshtNo', async (req, res) => {
    let conn;
    try {
      conn = await getConn();
      const rows = await q(
        conn,
        `SELECT d.DAY_NO
           FROM (SELECT DAY_NO, SUM(IFNULL(NORMAL_HRS,0)) N, SUM(IFNULL(NORMAL_OT,0)) O, SUM(IFNULL(HOLIDAY_OT,0)) H
                   FROM time_sheet_dtl WHERE TSHT_NO = ? GROUP BY DAY_NO) d
           JOIN (SELECT DAY_NO, SUM(NORMAL_MINS) N, SUM(NOT_MINS) O, SUM(HOT_MINS) H
                   FROM time_sheet_job WHERE TSHT_NO = ? GROUP BY DAY_NO) j ON j.DAY_NO = d.DAY_NO
          WHERE d.N + d.O + d.H > 0 AND d.N = j.N AND d.O = j.O AND d.H = j.H
          ORDER BY d.DAY_NO`,
        [req.params.tshtNo, req.params.tshtNo],
      );
      res.json(rows.map((r) => Number(r.DAY_NO)));
    } catch (err) {
      console.error('ts-job-alloc-done:', err);
      res.status(500).json({ error: err.message });
    } finally {
      if (conn) conn.release();
    }
  });

  router.get('/ts-job-alloc-sheets', async (req, res) => {
    let conn;
    try {
      conn = await getConn();
      const s = `%${String(req.query.q || '').trim()}%`;
      const rows = await q(
        conn,
        `SELECT h.TSHT_NO, h.EMP_CODE, e.EMP_NAME,
                CASE h.STATUS WHEN 'T' THEN 'Time Approved' WHEN 'A' THEN 'Job Approved' ELSE h.STATUS END AS STATUS_TEXT
           FROM time_sheet_hdr h LEFT JOIN emp_mst e ON e.EMP_CODE = h.EMP_CODE
          WHERE h.STATUS IN ('T','A') AND (h.TSHT_NO LIKE ? OR h.EMP_CODE LIKE ? OR e.EMP_NAME LIKE ?)
          ORDER BY h.TSHT_DATE DESC, h.EMP_CODE
          LIMIT 200`,
        [s, s, s],
      );
      res.json(rows);
    } catch (err) {
      console.error('ts-job-alloc-sheets:', err);
      res.status(500).json({ error: err.message });
    } finally {
      if (conn) conn.release();
    }
  });

  // ---------------------------------------------------------------
  router.post('/save-ts-job-alloc', async (req, res) => {
    const { tshtNo, lines = [], approve = false } = req.body || {};
    let conn;
    try {
      conn = await getConn();
      await q(conn, 'START TRANSACTION');

      const hdr = (await q(conn, `SELECT STATUS FROM time_sheet_hdr WHERE TSHT_NO = ? FOR UPDATE`, [tshtNo]))[0];
      if (!hdr) throw new Error(`Time sheet ${tshtNo} not found`);
      if (hdr.STATUS === 'D') throw new Error('Approve the time on the time sheet first');
      if (hdr.STATUS === 'A') throw new Error('Jobs are already approved — revoke the job approval on the time sheet to change them');

      const days = await loadDays(conn, tshtNo);
      const dayByNo = new Map(days.map((d) => [Number(d.DAY_NO), d]));

      // validate lines
      const jobSet = new Set((await q(conn, `SELECT JOB_NO FROM job_card`)).map((j) => String(j.JOB_NO)));
      const clean = [];
      for (const l of lines) {
        const dayNo = Number(l.DAY_NO);
        const day = dayByNo.get(dayNo);
        if (!day) throw new Error(`Day ${dayNo} has no hours to allocate`);
        const jobNo = String(l.JOB_NO || '').trim();
        if (!jobNo) throw new Error(`Day ${dayNo}: Job No missing on a line`);
        if (!jobSet.has(jobNo)) throw new Error(`Day ${dayNo}: Job No ${jobNo} not found in job cards`);
        const n = int(l.NORMAL_MINS), o = int(l.NOT_MINS), h = int(l.HOT_MINS);
        if (n + o + h === 0) continue; // empty line — skip
        clean.push({ ...l, DAY_NO: dayNo, JOB_NO: jobNo, n, o, h, ATT_DATE: day.ATT_DATE });
      }

      // never more than the day's hours (less is fine on Save, must tally on Approve)
      const sum = new Map();
      for (const l of clean) {
        const t = sum.get(l.DAY_NO) || { n: 0, o: 0, h: 0 };
        t.n += l.n; t.o += l.o; t.h += l.h;
        sum.set(l.DAY_NO, t);
      }
      const notTallied = [];
      for (const d of days) {
        const t = sum.get(Number(d.DAY_NO)) || { n: 0, o: 0, h: 0 };
        if (t.n > d.NORMAL_MINS || t.o > d.NOT_MINS || t.h > d.HOT_MINS)
          throw new Error(`Day ${d.DAY_NO}: allocated hours are more than the day's hours`);
        if (t.n !== Number(d.NORMAL_MINS) || t.o !== Number(d.NOT_MINS) || t.h !== Number(d.HOT_MINS)) notTallied.push(d.DAY_NO);
      }
      if (approve && notTallied.length) throw new Error(`Hours not fully allocated on day(s): ${notTallied.join(', ')}`);

      // replace the sheet's lines (renumbered per day)
      await q(conn, `DELETE FROM time_sheet_job WHERE TSHT_NO = ?`, [tshtNo]);
      const lineNo = new Map();
      const who = userOf(req);
      for (const l of clean) {
        const ln = (lineNo.get(l.DAY_NO) || 0) + 1;
        lineNo.set(l.DAY_NO, ln);
        await q(
          conn,
          `INSERT INTO time_sheet_job
             (TSHT_NO, DAY_NO, LINE_NO, ATT_DATE, JOB_NO, NORMAL_MINS, NOT_MINS, HOT_MINS, NORMAL_COST, NOT_COST, HOT_COST, REMARKS, CREATED_BY)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [tshtNo, l.DAY_NO, ln, l.ATT_DATE, l.JOB_NO, l.n, l.o, l.h,
           money(l.NORMAL_COST), money(l.NOT_COST), money(l.HOT_COST), String(l.REMARKS || '').slice(0, 100) || null, who],
        );
      }

      if (approve) await q(conn, `UPDATE time_sheet_hdr SET STATUS = 'A', EDITED_BY = ? WHERE TSHT_NO = ?`, [who, tshtNo]);
      else await q(conn, `UPDATE time_sheet_hdr SET EDITED_BY = ? WHERE TSHT_NO = ?`, [who, tshtNo]);

      await q(conn, 'COMMIT');
      res.json({ ok: true, tshtNo, status: approve ? 'A' : 'T', pendingDays: notTallied });
    } catch (err) {
      if (conn) await q(conn, 'ROLLBACK').catch(() => {});
      console.error('save-ts-job-alloc:', err);
      res.status(400).json({ ok: false, error: err.message });
    } finally {
      if (conn) conn.release();
    }
  });

  return router;
};
