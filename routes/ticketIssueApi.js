// routes/ticketIssueApi.js — Air Ticket Issue / Encashment vouchers (emp_ticket_txn)
// Register in HayatDb.js (after ticketLedgerApi):
//   const ticketIssueApi = require("./routes/ticketIssueApi");
//   app.use("/api", ticketIssueApi(connection));
//
// GET    /api/ticket-issue-lookups          leave types, travel agents (sup_mst), provisional next no, last agent used
// GET    /api/ticket-issue                  list (newest first)
// GET    /api/ticket-issue/:no              one voucher
// GET    /api/ticket-issue-balance/:emp?date=YYYY-MM-DD[&exclude=<no>]  balance on a date
// POST   /api/ticket-issue                  add   (TKT_NO = MAX + 1, retried on a clash)
// PUT    /api/ticket-issue/:no              edit
// POST   /api/ticket-issue/:no/lpo          { LPO_NO } — called by Lpoent after it saves an LPO made from this voucher
// DELETE /api/ticket-issue/:no              refused while an LPO is linked
// An entry that would take the balance below zero is refused with 409 { needConfirm }
// unless the body carries force: true (advance ticket).

const express = require("express");
const { buildLedger, promiseDb, EMP_SELECT, TXN_SELECT, empArgs, r2 } = require("./ticketLedgerApi");

const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

// leave_type_mst column names vary — pick the code / name columns by their names
const pickCol = (row, tests) => Object.keys(row || {}).find((k) => tests.some((t) => t.test(k)));

module.exports = function (connection) {
  const router = express.Router();
  const db = promiseDb(connection);
  const userOf = (req) =>
    String(req.user?.username || req.user?.user_name || req.user?.user_id || "").slice(0, 30) || null;

  const loadEmp = async (empCode) => (await db.query(`${EMP_SELECT} WHERE e.EMP_CODE = ?`, [empCode]))[0][0];

  // balance on a date, leaving out one voucher (the one being edited)
  async function balanceOn(empCode, date, excludeNo) {
    const emp = await loadEmp(empCode);
    if (!emp) return { error: "Employee not found", status: 404 };
    const [txns] = await db.query(
      `${TXN_SELECT} WHERE EMP_CODE = ? ${excludeNo ? "AND TKT_NO <> ?" : ""} ORDER BY TXN_DATE, srno_row_id`,
      excludeNo ? [empCode, excludeNo] : [empCode]);
    const led = buildLedger(empArgs(emp), txns, null, date);
    if (led.error) return { error: led.error, status: 400, emp };
    return { emp, balance: led.totals.balance, factor: led.factor, fare: led.fare };
  }

  function readBody(b) {
    const v = {
      EMP_CODE: String(b.EMP_CODE || "").trim().toUpperCase(),
      TXN_DATE: String(b.TXN_DATE || "").slice(0, 10),
      TXN_TYPE: b.TXN_TYPE === "E" ? "E" : "I",
      TICKETS: Number(b.TICKETS),
      SECTOR: String(b.SECTOR || "").trim().toUpperCase().slice(0, 30) || null,
      TKT_REF: String(b.TKT_REF || "").trim().slice(0, 30) || null,
      AMOUNT: Number(b.AMOUNT || 0),
      LEAVE_TYPE: String(b.LEAVE_TYPE || "").trim().slice(0, 5) || null,
      SUP_CODE: String(b.SUP_CODE || "").trim().slice(0, 10) || null,
      REMARKS: String(b.REMARKS || "").trim().slice(0, 200) || null,
    };
    if (!v.EMP_CODE) return { error: "Select the employee" };
    if (!isYmd(v.TXN_DATE)) return { error: "Enter a valid date" };
    if (![1, 2].includes(v.TICKETS)) return { error: "Tickets must be 2 (return) or 1 (one way)" };
    if (!Number.isFinite(v.AMOUNT) || v.AMOUNT < 0) return { error: "Amount is not valid" };
    return { v };
  }

  // checks shared by add / edit; returns null when fine, else { status, body }
  async function check(v, force, excludeNo) {
    if (v.SUP_CODE) {
      const [[s]] = await db.query(`SELECT SUP_CODE FROM sup_mst WHERE SUP_CODE = ?`, [v.SUP_CODE]);
      if (!s) return { status: 400, body: { message: `Travel agent ${v.SUP_CODE} is not in the supplier master` } };
    }
    const b = await balanceOn(v.EMP_CODE, v.TXN_DATE, excludeNo);
    if (b.error) return { status: b.status, body: { message: b.error } };
    if (String(b.emp.ELIGIBLE || "").toUpperCase() !== "Y" && !force)
      return { status: 409, body: { needConfirm: true, message: `${b.emp.EMP_NAME} is not marked ticket eligible in the Employee Master.` } };
    if (b.emp.OP_DATE && v.TXN_DATE <= b.emp.OP_DATE)
      return { status: 400, body: { message: `Date must be after the ticket O/P balance date (${b.emp.OP_DATE.split("-").reverse().join("/")})` } };
    const after = r2(b.balance - v.TICKETS);
    if (after < 0 && !force)
      return { status: 409, body: { needConfirm: true, balance: b.balance, after,
        message: `Ticket balance on this date is ${b.balance.toFixed(2)}. This entry takes it to ${after.toFixed(2)}.` } };
    return null;
  }

  const ROW_SELECT = `
    SELECT t.TKT_NO, t.srno_row_id, DATE_FORMAT(t.TXN_DATE, '%Y-%m-%d') AS TXN_DATE, t.EMP_CODE, e.EMP_NAME, e.EMP_CATG,
           t.TXN_TYPE, t.TICKETS, t.SECTOR, t.TKT_REF, t.AMOUNT, t.LEAVE_TYPE, t.SUP_CODE, s.SUP_NAME, t.LPO_NO,
           t.REMARKS, t.CREATED_BY, DATE_FORMAT(t.CREATED_ON, '%d/%m/%Y %H:%i') AS CREATED_ON
      FROM emp_ticket_txn t
      LEFT JOIN emp_mst e ON e.EMP_CODE = t.EMP_CODE
      LEFT JOIN sup_mst s ON s.SUP_CODE = t.SUP_CODE`;

  // ---------- lookups for the entry screen ----------
  router.get("/ticket-issue-lookups", async (req, res) => {
    try {
      const [[{ nextNo }]] = await db.query(`SELECT COALESCE(MAX(TKT_NO), 0) + 1 AS nextNo FROM emp_ticket_txn`);
      const [agents] = await db.query(`SELECT SUP_CODE AS code, SUP_NAME AS name FROM sup_mst ORDER BY SUP_NAME`);
      const [last] = await db.query(
        `SELECT SUP_CODE FROM emp_ticket_txn WHERE SUP_CODE IS NOT NULL AND SUP_CODE <> '' ORDER BY TKT_NO DESC LIMIT 1`);
      let leaveTypes = [];
      try {
        const [lt] = await db.query(`SELECT * FROM leave_type_mst`);
        if (lt.length) {
          const codeK = pickCol(lt[0], [/^LEAVE_?CODE$/i, /^LEAVE_?TYPE$/i, /^LT_?CODE$/i, /CODE$/i]);
          const nameK = pickCol(lt[0], [/^LEAVE_?(NAME|DESC)/i, /NAME$/i, /DESC/i]);
          leaveTypes = lt
            .map((r) => ({ code: String(r[codeK] ?? "").trim(), name: String(r[nameK] ?? r[codeK] ?? "").trim() }))
            .filter((r) => r.code)
            .sort((a, b) => a.code.localeCompare(b.code));
        }
      } catch (e) { /* no leave_type_mst — dropdown stays empty */ }
      res.json({ nextNo, agents, lastAgent: last[0]?.SUP_CODE || "", leaveTypes });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // ---------- list ----------
  router.get("/ticket-issue", async (req, res) => {
    try {
      const [r] = await db.query(`${ROW_SELECT} ORDER BY t.TXN_DATE DESC, t.TKT_NO DESC`);
      res.json(r);
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // ---------- balance on a date (entry screen shows it live) ----------
  router.get("/ticket-issue-balance/:emp", async (req, res) => {
    try {
      const date = isYmd(req.query.date) ? req.query.date : new Date().toISOString().slice(0, 10);
      const b = await balanceOn(String(req.params.emp).toUpperCase(), date, req.query.exclude ? Number(req.query.exclude) : null);
      if (b.error) return res.status(b.status).json({ message: b.error, emp: b.emp || null });
      res.json({ emp: b.emp, balance: b.balance, factor: b.factor, fare: b.fare, date });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // ---------- one voucher ----------
  router.get("/ticket-issue/:no", async (req, res) => {
    try {
      const [r] = await db.query(`${ROW_SELECT} WHERE t.TKT_NO = ?`, [req.params.no]);
      if (!r.length) return res.status(404).json({ message: `Ticket issue ${req.params.no} not found` });
      res.json(r[0]);
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // ---------- add ----------
  router.post("/ticket-issue", async (req, res) => {
    const { v, error } = readBody(req.body || {});
    if (error) return res.status(400).json({ message: error });
    try {
      const bad = await check(v, !!req.body.force, null);
      if (bad) return res.status(bad.status).json(bad.body);
      const user = userOf(req);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const [ins] = await db.query(
            `INSERT INTO emp_ticket_txn (TKT_NO, EMP_CODE, TXN_DATE, TXN_TYPE, TICKETS, SECTOR, TKT_REF, AMOUNT,
                                         LEAVE_TYPE, SUP_CODE, REMARKS, CREATED_BY, CREATED_ON)
             SELECT COALESCE(MAX(TKT_NO), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW() FROM emp_ticket_txn`,
            [v.EMP_CODE, v.TXN_DATE, v.TXN_TYPE, v.TICKETS, v.SECTOR, v.TKT_REF, v.AMOUNT, v.LEAVE_TYPE, v.SUP_CODE, v.REMARKS, user]);
          const [[row]] = await db.query(`SELECT TKT_NO FROM emp_ticket_txn WHERE srno_row_id = ?`, [ins.insertId]);
          const provisional = Number(req.body.PROV_NO) || null;
          const changed = provisional && provisional !== row.TKT_NO;
          return res.json({
            ok: true, TKT_NO: row.TKT_NO, changed,
            message: changed
              ? `Issue No ${provisional} was taken by another user. Saved as Ticket Issue ${row.TKT_NO}.`
              : `Ticket issue ${row.TKT_NO} saved`,
          });
        } catch (e) {
          if (e.code !== "ER_DUP_ENTRY" || attempt === 2) throw e; // another user took the number - try again
        }
      }
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // ---------- edit ----------
  router.put("/ticket-issue/:no", async (req, res) => {
    const no = Number(req.params.no);
    const { v, error } = readBody(req.body || {});
    if (error) return res.status(400).json({ message: error });
    try {
      const bad = await check(v, !!req.body.force, no);
      if (bad) return res.status(bad.status).json(bad.body);
      const [u] = await db.query(
        `UPDATE emp_ticket_txn SET EMP_CODE = ?, TXN_DATE = ?, TXN_TYPE = ?, TICKETS = ?, SECTOR = ?, TKT_REF = ?,
                AMOUNT = ?, LEAVE_TYPE = ?, SUP_CODE = ?, REMARKS = ?, LAST_EDITED_BY = ?, LAST_EDITED_ON = NOW()
          WHERE TKT_NO = ?`,
        [v.EMP_CODE, v.TXN_DATE, v.TXN_TYPE, v.TICKETS, v.SECTOR, v.TKT_REF, v.AMOUNT, v.LEAVE_TYPE, v.SUP_CODE,
         v.REMARKS, userOf(req), no]);
      if (!u.affectedRows) return res.status(404).json({ message: `Ticket issue ${no} not found` });
      res.json({ ok: true, TKT_NO: no, message: `Ticket issue ${no} saved` });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // ---------- LPO made from this voucher (called by Lpoent after its save) ----------
  router.post("/ticket-issue/:no/lpo", async (req, res) => {
    const lpo = String(req.body?.LPO_NO || "").trim().slice(0, 15);
    if (!lpo) return res.status(400).json({ message: "LPO No missing" });
    try {
      const [u] = await db.query(
        `UPDATE emp_ticket_txn SET LPO_NO = ? WHERE TKT_NO = ? AND (LPO_NO IS NULL OR LPO_NO = '')`, [lpo, req.params.no]);
      if (!u.affectedRows) {
        const [[t]] = await db.query(`SELECT LPO_NO FROM emp_ticket_txn WHERE TKT_NO = ?`, [req.params.no]);
        if (!t) return res.status(404).json({ message: `Ticket issue ${req.params.no} not found` });
        return res.status(409).json({ message: `Ticket issue ${req.params.no} already has LPO ${t.LPO_NO}` });
      }
      res.json({ ok: true, message: `LPO ${lpo} linked to Ticket Issue ${req.params.no}` });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // ---------- delete ----------
  router.delete("/ticket-issue/:no", async (req, res) => {
    try {
      const [[t]] = await db.query(`SELECT LPO_NO FROM emp_ticket_txn WHERE TKT_NO = ?`, [req.params.no]);
      if (!t) return res.status(404).json({ message: `Ticket issue ${req.params.no} not found` });
      if (t.LPO_NO) return res.status(400).json({ message: `Ticket issue ${req.params.no} has LPO ${t.LPO_NO} — cancel or delete the LPO first.` });
      await db.query(`DELETE FROM emp_ticket_txn WHERE TKT_NO = ?`, [req.params.no]);
      res.json({ ok: true, message: `Ticket issue ${req.params.no} deleted` });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  return router;
};
