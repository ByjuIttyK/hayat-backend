// routes/leaveSalPayApi.js — Leave Salary Payment vouchers (Payroll › Leave › Leave Salary Payment)
// Register in HayatDb.js:
//   const leaveSalPayApi = require("./routes/leaveSalPayApi");
//   app.use("/api", leaveSalPayApi(connection));
// Table: leave_sal_pay (sql/leave_sal_pay.sql). Reads emp_mst, hr_mst, payroll_mst, leave_appl, ac_list, ac_period.
// Uses the leave engine of routes/leaveApi.js, so balances here always agree with the Leave Ledger.
//
// Voucher types (company rules, Nov 2026):
//   L  leave salary for one annual leave — paid before the leave or any time after coming back;
//      days up to the leave days still unpaid (all leave days are paid: days beyond the balance are advance
//      leave and take the annual balance negative); an open advance can be adjusted (ADV_ADJ)
//   E  encashment — days sold from the annual balance, up to the available balance; reduces the balance
//   A  advance against future leave — amount (or days × rate); balance not touched
//   Rate = current basic salary (payroll_mst.BASIC_SAL) × 12 / 365, kept on the voucher as paid.
//
// G/L posting (tran_acc, TRAN_TYPE = LS_TRAN_TYPE, voucher no = LS_NO):
//   Dr DR_ACC_CODE   AMOUNT        (L, E: leave salary provision / expense;  A: employee advance a/c)
//   Cr ADV_ACC_CODE  ADV_ADJ       (L with an advance adjusted)
//   Cr CR_ACC_CODE   NET_PAY       (bank / cash)
//
//   GET    /leave-sal-pay?from=yyyy-mm-dd&to=yyyy-mm-dd&emp=W003&type=L,E,A
//   GET    /leave-sal-pay/accounts?q=bank          account LOV (ac_list)
//   GET    /leave-sal-pay/ctx/:code?dt=yyyy-mm-dd&excl=LS2026-0001
//          rate, annual balance on the date, open advance, payable leaves, last accounts used
//   GET    /leave-sal-pay/:no
//   POST   /leave-sal-pay
//   PUT    /leave-sal-pay/:no
//   DELETE /leave-sal-pay/:no
const express = require("express");
const { engine } = require("./leaveApi");

// ---- G/L posting: tran type and tran_acc column names — match these to the Salary JV insert (tran type 15)
const LS_TRAN_TYPE = 16;
const POST_GL = true;
const GL = {
  table: "tran_acc", tranType: "TRAN_TYPE", vchrNo: "VCHR_NO", date: "DATTE", acc: "ACC_CODE",
  amount: "AMOUNT", dbCr: "DB_CR", narr1: "NARRATION1", narr2: "NARRATION2", srNo: "SR_NO",
};

const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !isNaN(Date.parse(s + "T00:00:00Z"));
const todayYmd = () => {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
};
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const dmy = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : "");
const TYPE_TXT = { L: "Leave salary", E: "Encashment", A: "Advance" };

module.exports = function (connection) {
  const router = express.Router();

  const q = (sql, params = []) =>
    new Promise((resolve, reject) => connection.query(sql, params, (e, r) => (e ? reject(e) : resolve(r))));
  const qc = (conn, sql, params = []) =>
    new Promise((resolve, reject) => conn.query(sql, params, (e, r) => (e ? reject(e) : resolve(r))));
  const run = (db, sql, params) => (db ? qc(db, sql, params) : q(sql, params));
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const send = (res, e) => res.status(e.status || 500).json({ message: e.sqlMessage || e.message });
  const userOf = (req) => String(req.user?.username || req.user?.user_name || req.user?.user_id || "").slice(0, 20) || null;
  const str = (v, n) => { const s = v == null ? "" : String(v).trim(); return s ? s.slice(0, n) : null; };
  const up = (v, n) => str(v, n)?.toUpperCase() || null;

  const tx = (fn) => new Promise((resolve, reject) => {
    connection.getConnection(async (err, conn) => {
      if (err) return reject(err);
      try {
        await qc(conn, "START TRANSACTION");
        const out = await fn(conn);
        await qc(conn, "COMMIT");
        resolve(out);
      } catch (e) {
        try { await qc(conn, "ROLLBACK"); } catch (_) { /* ignore */ }
        reject(e);
      } finally { conn.release(); }
    });
  });

  // ---- reads
  const EMP_SQL = `
    SELECT e.EMP_CODE, e.EMP_NAME, e.EMP_STATUS, DATE_FORMAT(e.APPT_DT, '%Y-%m-%d') AS APPT_DT,
           COALESCE(h.LEAVE_DAYS_PA, 30) AS LEAVE_DAYS_PA, COALESCE(h.LEAVE_OPBAL, 0) AS LEAVE_OPBAL,
           DATE_FORMAT(h.LEAVE_OPBAL_DT, '%Y-%m-%d') AS LEAVE_OPBAL_DT, COALESCE(p.BASIC_SAL, 0) AS BASIC_SAL
      FROM emp_mst e
      LEFT JOIN hr_mst h      ON h.EMP_CODE = e.EMP_CODE
      LEFT JOIN payroll_mst p ON p.EMP_CODE = e.EMP_CODE
     WHERE e.EMP_CODE = ?`;
  const LEAVES_SQL = `
    SELECT a.LEAVE_NO, a.EMP_CODE, a.LEAVE_TYPE, lt.LEAVE_NAME, lt.IS_ANNUAL, a.STATUS, a.DAYS, a.ACT_DAYS,
           DATE_FORMAT(a.FROM_DT, '%Y-%m-%d') AS FROM_DT, DATE_FORMAT(a.TO_DT, '%Y-%m-%d') AS TO_DT,
           DATE_FORMAT(a.RESUME_DT, '%Y-%m-%d') AS RESUME_DT
      FROM leave_appl a JOIN leave_type_mst lt ON lt.LEAVE_TYPE = a.LEAVE_TYPE
     WHERE a.STATUS IN ('A','S') AND a.EMP_CODE = ?
     ORDER BY a.FROM_DT`;
  const PAYS_SQL = `
    SELECT LS_NO, LS_TYPE, DATE_FORMAT(LS_DT, '%Y-%m-%d') AS LS_DT, LEAVE_NO, DAYS, AMOUNT, ADV_ADJ, NET_PAY
      FROM leave_sal_pay WHERE EMP_CODE = ? AND LS_NO <> ? ORDER BY LS_DT, LS_NO`;
  const ROW_SQL = `
    SELECT v.LS_NO, DATE_FORMAT(v.LS_DT, '%Y-%m-%d') AS LS_DT, v.EMP_CODE, e.EMP_NAME, v.LS_TYPE, v.LEAVE_NO,
           lt.LEAVE_NAME, DATE_FORMAT(a.FROM_DT, '%Y-%m-%d') AS FROM_DT, DATE_FORMAT(a.TO_DT, '%Y-%m-%d') AS TO_DT,
           DATE_FORMAT(a.RESUME_DT, '%Y-%m-%d') AS RESUME_DT,
           v.DAYS, v.BASIC_SAL, v.DAILY_RATE, v.AMOUNT, v.ADV_ADJ, v.NET_PAY,
           v.DR_ACC_CODE, d.AC_HEAD AS DR_ACC_HEAD, v.CR_ACC_CODE, c.AC_HEAD AS CR_ACC_HEAD,
           v.ADV_ACC_CODE, ad.AC_HEAD AS ADV_ACC_HEAD, v.PAY_REF, v.NARRATION,
           v.CREATED_BY, DATE_FORMAT(v.CREATED_DT, '%Y-%m-%d %H:%i') AS CREATED_DT, v.MODIFIED_BY
      FROM leave_sal_pay v
      JOIN emp_mst e              ON e.EMP_CODE = v.EMP_CODE
      LEFT JOIN leave_appl a      ON a.LEAVE_NO = v.LEAVE_NO
      LEFT JOIN leave_type_mst lt ON lt.LEAVE_TYPE = a.LEAVE_TYPE
      LEFT JOIN ac_list d         ON d.AC_CODE = v.DR_ACC_CODE
      LEFT JOIN ac_list c         ON c.AC_CODE = v.CR_ACC_CODE
      LEFT JOIN ac_list ad        ON ad.AC_CODE = v.ADV_ACC_CODE`;

  const rowOf = async (no, db = null) => {
    const r = await run(db, `${ROW_SQL} WHERE v.LS_NO = ?${db ? " FOR UPDATE" : ""}`, [no]);
    if (!r.length) throw fail(404, `Leave salary voucher ${no} not found`);
    return r[0];
  };

  // everything a voucher for this employee on this date depends on (voucher `excl` left out)
  const ctxOf = async (code, dt, excl = "", db = null) => {
    const e = await run(db, EMP_SQL, [code]);
    if (!e.length) throw fail(404, `Employee ${code} not found`);
    const emp = e[0];
    const [leaves, pays] = await Promise.all([run(db, LEAVES_SQL, [code]), run(db, PAYS_SQL, [code, excl || ""])]);
    const basic = r2(emp.BASIC_SAL);
    const rate = r2(basic * 12 / 365);
    const bal = engine.leaveBalance(emp, leaves, dt, pays.filter((p) => p.LS_TYPE === "E"));
    const advPaid = r2(pays.filter((p) => p.LS_TYPE === "A").reduce((t, p) => t + Number(p.AMOUNT), 0));
    const advAdj = r2(pays.filter((p) => p.LS_TYPE === "L").reduce((t, p) => t + Number(p.ADV_ADJ), 0));
    const payable = leaves.filter((l) => l.IS_ANNUAL === "Y").map((l) => {
      const days = Number(l.STATUS === "S" ? l.ACT_DAYS : l.DAYS) || 0;
      const lp = pays.filter((p) => p.LS_TYPE === "L" && p.LEAVE_NO === l.LEAVE_NO);
      const paidDays = r2(lp.reduce((t, p) => t + Number(p.DAYS), 0));
      const paidAmt = r2(lp.reduce((t, p) => t + Number(p.AMOUNT), 0));
      return {
        LEAVE_NO: l.LEAVE_NO, LEAVE_NAME: l.LEAVE_NAME, STATUS: l.STATUS, FROM_DT: l.FROM_DT, TO_DT: l.TO_DT,
        RESUME_DT: l.RESUME_DT, days: r2(days), paidDays, paidAmt, dueDays: r2(days - paidDays),
      };
    }).reverse();                                                       // latest leave first
    return { emp, basic, rate, bal, openAdvance: r2(advPaid - advAdj), payable, pays };
  };

  const lastAccounts = async () => {
    try {
      const r = await q(`SELECT v.LS_TYPE, v.DR_ACC_CODE, d.AC_HEAD AS DR_ACC_HEAD, v.CR_ACC_CODE, c.AC_HEAD AS CR_ACC_HEAD,
                                v.ADV_ACC_CODE, ad.AC_HEAD AS ADV_ACC_HEAD
                           FROM leave_sal_pay v
                           LEFT JOIN ac_list d  ON d.AC_CODE = v.DR_ACC_CODE
                           LEFT JOIN ac_list c  ON c.AC_CODE = v.CR_ACC_CODE
                           LEFT JOIN ac_list ad ON ad.AC_CODE = v.ADV_ACC_CODE
                          ORDER BY v.srno_row_id DESC LIMIT 60`);
      const out = {};
      r.forEach((x) => { if (!out[x.LS_TYPE]) out[x.LS_TYPE] = x; });
      // advance a/c: the Dr of the last advance voucher, else the last one adjusted
      const advCode = out.A?.DR_ACC_CODE || r.find((x) => x.ADV_ACC_CODE)?.ADV_ACC_CODE || null;
      const advHead = out.A?.DR_ACC_HEAD || r.find((x) => x.ADV_ACC_CODE)?.ADV_ACC_HEAD || null;
      return { ...out, adv: advCode ? { code: advCode, head: advHead } : null };
    } catch (_) { return {}; }
  };

  // ---------------------------------------------------------------- list
  router.get("/leave-sal-pay", async (req, res) => {
    try {
      const where = ["1=1"]; const p = [];
      if (isYmd(req.query.from)) { where.push("v.LS_DT >= ?"); p.push(req.query.from); }
      if (isYmd(req.query.to)) { where.push("v.LS_DT <= ?"); p.push(req.query.to); }
      if (req.query.emp) { where.push("v.EMP_CODE = ?"); p.push(String(req.query.emp).trim().toUpperCase()); }
      const types = String(req.query.type || "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => ["L", "E", "A"].includes(s));
      if (types.length) { where.push("v.LS_TYPE IN (?)"); p.push(types); }
      if (req.query.leave) { where.push("v.LEAVE_NO = ?"); p.push(String(req.query.leave).trim().toUpperCase()); }
      const rows = await q(`${ROW_SQL} WHERE ${where.join(" AND ")} ORDER BY v.LS_DT DESC, v.LS_NO DESC LIMIT 3000`, p);
      res.json({ rows });
    } catch (e) { send(res, e); }
  });

  // ---------------------------------------------------------------- account LOV
  router.get("/leave-sal-pay/accounts", async (req, res) => {
    try {
      const s = `%${String(req.query.q || "").trim()}%`;
      const rows = await q(`SELECT AC_CODE AS code, AC_HEAD AS head FROM ac_list
                             WHERE AC_CODE LIKE ? OR AC_HEAD LIKE ? ORDER BY AC_HEAD LIMIT 60`, [s, s]);
      res.json({ rows });
    } catch (e) { send(res, e); }
  });

  // ---------------------------------------------------------------- context for the entry form
  router.get("/leave-sal-pay/ctx/:code", async (req, res) => {
    try {
      const code = String(req.params.code).trim().toUpperCase();
      const dt = isYmd(req.query.dt) ? req.query.dt : todayYmd();
      const c = await ctxOf(code, dt, String(req.query.excl || "").trim().toUpperCase());
      res.json({
        emp: { EMP_CODE: c.emp.EMP_CODE, EMP_NAME: c.emp.EMP_NAME, APPT_DT: c.emp.APPT_DT },
        basic: c.basic, rate: c.rate, bal: c.bal, openAdvance: c.openAdvance, payable: c.payable,
        last: await lastAccounts(),
      });
    } catch (e) { send(res, e); }
  });

  router.get("/leave-sal-pay/:no", async (req, res) => {
    try { res.json({ row: await rowOf(String(req.params.no).trim().toUpperCase()) }); } catch (e) { send(res, e); }
  });

  // ---------------------------------------------------------------- validation (inside the save transaction)
  const readBody = (b) => ({
    LS_DT: b.LS_DT, EMP_CODE: up(b.EMP_CODE, 4), LS_TYPE: up(b.LS_TYPE, 1), LEAVE_NO: up(b.LEAVE_NO, 12),
    DAYS: r2(b.DAYS), AMOUNT: r2(b.AMOUNT), ADV_ADJ: r2(b.ADV_ADJ),
    DR_ACC_CODE: str(b.DR_ACC_CODE, 20), CR_ACC_CODE: str(b.CR_ACC_CODE, 20), ADV_ACC_CODE: str(b.ADV_ACC_CODE, 20),
    PAY_REF: str(b.PAY_REF, 30), NARRATION: str(b.NARRATION, 200),
  });

  const validate = async (db, v, cur) => {
    if (!["L", "E", "A"].includes(v.LS_TYPE)) throw fail(400, "Select the voucher type (leave salary, encashment or advance)");
    if (!isYmd(v.LS_DT)) throw fail(400, "Voucher date is not valid");
    if (!v.EMP_CODE) throw fail(400, "Select the employee");
    if (cur && cur.EMP_CODE !== v.EMP_CODE) throw fail(400, "The employee of a saved voucher cannot be changed — delete it and enter a new one");
    const per = await qc(db, "SELECT DATE_FORMAT(START_DATE,'%Y-%m-%d') s, DATE_FORMAT(END_DATE,'%Y-%m-%d') e FROM ac_period LIMIT 1");
    if (per.length && (v.LS_DT < per[0].s || v.LS_DT > per[0].e)) {
      throw fail(400, `Voucher date is outside the accounting period ${dmy(per[0].s)} – ${dmy(per[0].e)}`);
    }

    const c = await ctxOf(v.EMP_CODE, v.LS_DT, cur ? cur.LS_NO : "", db);
    // rate: a new voucher takes the current basic; a saved one keeps the rate it was paid at
    v.BASIC_SAL = cur ? r2(cur.BASIC_SAL) : c.basic;
    v.DAILY_RATE = cur ? r2(cur.DAILY_RATE) : c.rate;
    if (!(v.DAILY_RATE > 0) && v.LS_TYPE !== "A") throw fail(400, `${c.emp.EMP_NAME} has no basic salary on the payroll master`);

    if (v.LS_TYPE === "L") {
      if (!v.LEAVE_NO) throw fail(400, "Select the leave this salary is for");
      const lv = c.payable.find((l) => l.LEAVE_NO === v.LEAVE_NO);
      if (!lv) throw fail(400, `${v.LEAVE_NO} is not an approved / resumed annual leave of ${c.emp.EMP_NAME}`);
      if (!(v.DAYS > 0)) throw fail(400, "Enter the days paid");
      if (v.DAYS > lv.dueDays + 0.001) {
        throw fail(400, `Only ${lv.dueDays} day${lv.dueDays === 1 ? "" : "s"} of ${v.LEAVE_NO} are unpaid (${lv.days} days, ${lv.paidDays} already paid)`);
      }
      v.AMOUNT = r2(v.DAYS * v.DAILY_RATE);
      if (v.ADV_ADJ < 0) throw fail(400, "Advance adjusted cannot be negative");
      if (v.ADV_ADJ > c.openAdvance + 0.001) throw fail(400, `Advance adjusted is more than the open advance (${c.openAdvance.toFixed(2)})`);
      if (v.ADV_ADJ > v.AMOUNT + 0.001) throw fail(400, "Advance adjusted is more than the leave salary");
      if (v.ADV_ADJ > 0 && !v.ADV_ACC_CODE) throw fail(400, "Select the employee advance account (credited with the advance adjusted)");
    } else if (v.LS_TYPE === "E") {
      v.LEAVE_NO = null; v.ADV_ADJ = 0; v.ADV_ACC_CODE = null;
      if (!(v.DAYS > 0)) throw fail(400, "Enter the days encashed");
      if (v.DAYS > c.bal.available + 0.001) {
        throw fail(400, `Only ${Math.max(c.bal.available, 0)} days are available on ${dmy(v.LS_DT)} — encashment cannot exceed the balance`);
      }
      v.AMOUNT = r2(v.DAYS * v.DAILY_RATE);
    } else {
      v.LEAVE_NO = null; v.ADV_ADJ = 0; v.ADV_ACC_CODE = null;
      if (v.DAYS < 0) throw fail(400, "Days cannot be negative");
      if (v.DAYS > 0) v.AMOUNT = r2(v.DAYS * v.DAILY_RATE);
      if (!(v.AMOUNT > 0)) throw fail(400, "Enter the advance amount (or days)");
      // an advance already adjusted on leave salary vouchers cannot be reduced below what was adjusted
      if (cur && cur.LS_TYPE === "A") {
        const left = r2(c.openAdvance + v.AMOUNT);
        if (left < -0.001) throw fail(400, `Advance is already adjusted on leave salary vouchers — it cannot be less than ${r2(v.AMOUNT - left).toFixed(2)}`);
      }
    }
    // changing an advance voucher into another type
    if (cur && cur.LS_TYPE === "A" && v.LS_TYPE !== "A" && c.openAdvance < -0.001) {
      throw fail(400, "This advance is already adjusted on leave salary vouchers — its type cannot be changed");
    }
    v.NET_PAY = r2(v.AMOUNT - v.ADV_ADJ);

    if (!v.DR_ACC_CODE) throw fail(400, v.LS_TYPE === "A" ? "Select the employee advance account (debit)" : "Select the leave salary account (debit)");
    if (!v.CR_ACC_CODE) throw fail(400, "Select the bank / cash account (credit)");
    const codes = [v.DR_ACC_CODE, v.CR_ACC_CODE, v.ADV_ADJ > 0 ? v.ADV_ACC_CODE : null].filter(Boolean);
    const found = await qc(db, "SELECT AC_CODE FROM ac_list WHERE AC_CODE IN (?)", [codes]);
    const miss = codes.filter((x) => !found.some((f) => f.AC_CODE === x));
    if (miss.length) throw fail(400, `Account ${miss.join(", ")} is not in the chart of accounts`);
    return c;
  };

  // ---------------------------------------------------------------- G/L
  const unpost = async (db, no) => {
    if (!POST_GL) return;
    await qc(db, `DELETE FROM ${GL.table} WHERE ${GL.tranType} = ? AND ${GL.vchrNo} = ?`, [LS_TRAN_TYPE, no]);
  };
  const post = async (db, no, v, empName) => {
    if (!POST_GL) return;
    const n1 = `${empName} — ${TYPE_TXT[v.LS_TYPE]}${v.LEAVE_NO ? " " + v.LEAVE_NO : ""}${v.DAYS ? ` (${v.DAYS} days)` : ""}`.slice(0, 100);
    const n2 = (v.NARRATION || v.PAY_REF || no).slice(0, 100);
    const lines = [[v.DR_ACC_CODE, v.AMOUNT, "D"]];
    if (v.ADV_ADJ > 0) lines.push([v.ADV_ACC_CODE, v.ADV_ADJ, "C"]);
    if (v.NET_PAY > 0) lines.push([v.CR_ACC_CODE, v.NET_PAY, "C"]);
    let sr = 0;
    for (const [acc, amt, dc] of lines) {
      sr += 1;
      await qc(db,
        `INSERT INTO ${GL.table} (${GL.tranType}, ${GL.vchrNo}, ${GL.date}, ${GL.acc}, ${GL.amount}, ${GL.dbCr}, ${GL.narr1}, ${GL.narr2}, ${GL.srNo})
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [LS_TRAN_TYPE, no, v.LS_DT, acc, amt, dc, n1, n2, sr]);
    }
  };

  const COLS = ["LS_DT", "EMP_CODE", "LS_TYPE", "LEAVE_NO", "DAYS", "BASIC_SAL", "DAILY_RATE", "AMOUNT", "ADV_ADJ", "NET_PAY",
    "DR_ACC_CODE", "CR_ACC_CODE", "ADV_ACC_CODE", "PAY_REF", "NARRATION"];

  // ---------------------------------------------------------------- add
  router.post("/leave-sal-pay", async (req, res) => {
    const user = userOf(req);
    try {
      let no = null;
      for (let attempt = 0; attempt < 3 && !no; attempt++) {
        const v = readBody(req.body || {});
        try {
          no = await tx(async (db) => {
            const c = await validate(db, v, null);
            const pre = `LS${v.LS_DT.slice(0, 4)}-`;
            const m = await qc(db, "SELECT MAX(CAST(SUBSTRING(LS_NO, 8) AS UNSIGNED)) n FROM leave_sal_pay WHERE LS_NO LIKE ?", [pre + "%"]);
            const newNo = pre + String((Number(m[0].n) || 0) + 1).padStart(4, "0");
            await qc(db,
              `INSERT INTO leave_sal_pay (LS_NO, ${COLS.join(", ")}, TRAN_TYPE, CREATED_BY) VALUES (?, ${COLS.map(() => "?").join(", ")}, ?, ?)`,
              [newNo, ...COLS.map((k) => v[k]), POST_GL ? LS_TRAN_TYPE : null, user]);
            await post(db, newNo, v, c.emp.EMP_NAME);
            return newNo;
          });
        } catch (e) { if (e.code !== "ER_DUP_ENTRY") throw e; }      // number taken by another user — retry
      }
      if (!no) throw fail(409, "Could not allocate a voucher number, please save again");
      res.json({ ok: true, LS_NO: no, message: `Leave salary voucher ${no} saved`, row: await rowOf(no) });
    } catch (e) { send(res, e); }
  });

  // ---------------------------------------------------------------- edit
  router.put("/leave-sal-pay/:no", async (req, res) => {
    const no = String(req.params.no).trim().toUpperCase();
    try {
      await tx(async (db) => {
        const cur = (await qc(db, "SELECT * FROM leave_sal_pay WHERE LS_NO = ? FOR UPDATE", [no]))[0];
        if (!cur) throw fail(404, `Leave salary voucher ${no} not found`);
        const v = readBody(req.body || {});
        const c = await validate(db, v, cur);
        await qc(db, `UPDATE leave_sal_pay SET ${COLS.map((k) => `${k} = ?`).join(", ")}, MODIFIED_BY = ? WHERE LS_NO = ?`,
          [...COLS.map((k) => v[k]), userOf(req), no]);
        await unpost(db, no);
        await post(db, no, v, c.emp.EMP_NAME);
      });
      res.json({ ok: true, LS_NO: no, message: `Leave salary voucher ${no} saved`, row: await rowOf(no) });
    } catch (e) { send(res, e); }
  });

  // ---------------------------------------------------------------- delete
  router.delete("/leave-sal-pay/:no", async (req, res) => {
    const no = String(req.params.no).trim().toUpperCase();
    try {
      await tx(async (db) => {
        const cur = (await qc(db, "SELECT * FROM leave_sal_pay WHERE LS_NO = ? FOR UPDATE", [no]))[0];
        if (!cur) throw fail(404, `Leave salary voucher ${no} not found`);
        if (cur.LS_TYPE === "A") {
          const c = await ctxOf(cur.EMP_CODE, todayYmd(), no, db);
          if (c.openAdvance < -0.001) throw fail(400, "This advance is already adjusted on leave salary vouchers — delete or change those first");
        }
        await qc(db, "DELETE FROM leave_sal_pay WHERE LS_NO = ?", [no]);
        await unpost(db, no);
      });
      res.json({ ok: true, message: `Leave salary voucher ${no} deleted` });
    } catch (e) { send(res, e); }
  });

  return router;
};
