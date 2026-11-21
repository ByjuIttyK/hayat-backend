// routes/ticketLedgerApi.js — Employee Air Ticket Ledger (read-only)
// Accruals are generated on the fly from hr_mst; issues / encashments come from emp_ticket_txn
// (entered on the Ticket Issue screen, routes/ticketIssueApi.js).
// Register in HayatDb.js:
//   const ticketLedgerApi = require("./routes/ticketLedgerApi");
//   app.use("/api", ticketLedgerApi(connection));
//
// Unit = ONE-WAY ticket. Monthly factor = 2 / (12 x frequency years).
// Balance is always worked out at full precision from the opening date:
//   Balance = OP + factor x months elapsed - tickets issued
// and rounded to 2 decimals only for display, so 24 months gives exactly 2.00.
//
// GET /api/ticket-ledger/emps                  all employees, ticket-eligible first
// GET /api/ticket-ledger/:emp?from=&to=        ledger rows (from blank = O/P balance date)
// GET /api/ticket-balances?asOn=               every eligible employee's balance (provision)

const express = require("express");

// Column names in the employee masters
const T = {
  hr: "hr_mst",
  emp: "emp_mst",
  empName: "EMP_NAME",
  empCatg: "EMP_CATG",
  eligible: "TICKET_ELIGIBLE",
  sector: "TICKET_SECTOR",
  tclass: "TICKET_CLASS",
  freq: "TICKET_EVERY_YRS",
  lastTkt: "LAST_TICKET_DT",
  type: "TKT_TYPE",
  opBal: "TKT_OP_BAL",
  opDate: "TKT_OP_DATE",
  fare: "TKT_FARE",
};

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const r3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

// --- date helpers on 'YYYY-MM-DD' strings (no timezone drift) -----------
function ymd(d) {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const parts = (s) => s.split("-").map(Number);
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m = 1..12
const monthEnd = (y, m) => `${y}-${String(m).padStart(2, "0")}-${String(daysIn(y, m)).padStart(2, "0")}`;
const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function freqYears(v) {
  const n = parseFloat(v);
  if (!isNaN(n) && n > 0) return n;
  const s = String(v || "").toLowerCase();
  if (s.includes("2")) return 2;
  if (s.includes("year")) return 1;
  return 2;
}

// --- core: build ledger rows ------------------------------------------
// emp: { opBal, opDate, freq, fare }, txns: [{TXN_DATE 'YYYY-MM-DD', TICKETS, TKT_NO, ...}]
// from/to: 'YYYY-MM-DD' (from may be null = from opening date)
function buildLedger(emp, txns, from, to) {
  const factor = 2 / (12 * freqYears(emp.freq));
  const opBal = Number(emp.opBal || 0);
  const opDate = ymd(emp.opDate);
  const fare = Number(emp.fare || 0);
  if (!opDate) return { error: "Ticket O/P balance date is not set for this employee (Employee Master › Leave & Benefits)" };

  // 1. accrual events at each month end after opDate, up to 'to'
  const events = [];
  let [y, m, d] = parts(opDate);
  let first = true;
  while (true) {
    const me = monthEnd(y, m);
    if (me > to) break;
    const dim = daysIn(y, m);
    const frac = first ? (dim - d) / dim : 1; // first month pro-rata by days
    if (frac > 0) {
      events.push({ kind: "A", date: me, months: frac, part: `Accrual ${mon[m - 1]}-${String(y).slice(2)}${frac < 1 ? " (part month)" : ""}` });
    }
    first = false;
    m++; if (m > 12) { m = 1; y++; }
  }

  // 2. issue / encashment events (only after the opening date)
  for (const t of txns) {
    const dt = ymd(t.TXN_DATE);
    if (!dt || dt <= opDate || dt > to) continue;
    const what = t.TXN_TYPE === "E" ? "Ticket encashed" : (Number(t.TICKETS) >= 2 ? "Return ticket issued" : "One-way ticket issued");
    events.push({
      kind: "I", date: dt, tickets: Number(t.TICKETS), id: t.srno_row_id, tktNo: t.TKT_NO ?? null,
      part: [what, t.SECTOR].filter(Boolean).join(" · "),
      ref: [t.TKT_NO ? `Issue ${t.TKT_NO}` : "", t.TKT_REF || ""].filter(Boolean).join(" · "),
      amount: Number(t.AMOUNT || 0), txnType: t.TXN_TYPE,
    });
  }

  // same date: accrual first, then issue
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind === "A" ? -1 : 1));

  // 3. running balance at full precision
  let cumMonths = 0, cumIssued = 0;
  const bal = () => opBal + factor * cumMonths - cumIssued;

  const rows = [];
  const start = from && from > opDate ? from : null;
  let opened = false;
  let perAccrued = 0, perIssued = 0, openBal = 0;

  const pushOpening = (asOn) => {
    openBal = bal();
    rows.push({ date: asOn, particulars: start ? "Balance brought forward" : "Opening balance", ref: "",
      accrued: null, issued: null, balance: r2(openBal), value: r2(openBal * fare), kind: "O" });
    opened = true;
  };
  if (!start) pushOpening(opDate);

  for (const e of events) {
    if (start && !opened && e.date >= start) pushOpening(start);
    if (e.kind === "A") cumMonths += e.months; else cumIssued += e.tickets;
    if (!opened) continue; // before the selected period - folded into opening
    const accrued = e.kind === "A" ? factor * e.months : null;
    if (accrued) perAccrued += accrued;
    if (e.kind === "I") perIssued += e.tickets;
    rows.push({
      date: e.date, particulars: e.part, ref: e.ref || "",
      accrued: accrued != null ? r3(accrued) : null,
      issued: e.kind === "I" ? r2(e.tickets) : null,
      balance: r2(bal()), value: r2(bal() * fare),
      kind: e.kind, id: e.id || null, tktNo: e.tktNo ?? null, amount: e.amount || null,
      eligible: e.kind === "A" && bal() >= 2 - 1e-9 && bal() - factor * e.months < 2 - 1e-9,
    });
  }
  if (!opened) pushOpening(start);

  return {
    factor: r3(factor), freqYears: freqYears(emp.freq), fare,
    from: start || opDate, to,
    rows,
    totals: { opening: r2(openBal), accrued: r2(perAccrued), issued: r2(perIssued), balance: r2(bal()), value: r2(bal() * fare) },
  };
}

// mysql2 pool: use its promise wrapper; otherwise wrap the callback query
const promiseDb = (connection) => (typeof connection.promise === "function"
  ? connection.promise()
  : { query: (sql, params = []) => new Promise((ok, bad) => connection.query(sql, params, (e, r) => (e ? bad(e) : ok([r])))) });

const EMP_SELECT = `
  SELECT e.EMP_CODE, e.${T.empName} AS EMP_NAME, e.${T.empCatg} AS EMP_CATG, c.catg_name AS CATG_NAME,
         e.EMP_STATUS, DATE_FORMAT(e.APPT_DT, '%Y-%m-%d') AS APPT_DT,
         h.${T.eligible} AS ELIGIBLE, h.${T.sector} AS SECTOR, h.${T.tclass} AS TKT_CLASS, h.${T.freq} AS FREQ,
         DATE_FORMAT(h.${T.lastTkt}, '%Y-%m-%d') AS LAST_TKT_DT,
         h.${T.type} AS TKT_TYPE, h.${T.opBal} AS OP_BAL, DATE_FORMAT(h.${T.opDate}, '%Y-%m-%d') AS OP_DATE, h.${T.fare} AS FARE
    FROM ${T.emp} e
    LEFT JOIN ${T.hr} h ON h.EMP_CODE = e.EMP_CODE
    LEFT JOIN emp_catg_mst c ON c.catg_code = e.${T.empCatg}`;

const TXN_SELECT = `
  SELECT srno_row_id, TKT_NO, EMP_CODE, DATE_FORMAT(TXN_DATE, '%Y-%m-%d') AS TXN_DATE, TXN_TYPE, TICKETS,
         SECTOR, TKT_REF, AMOUNT, REMARKS
    FROM emp_ticket_txn`;

const empArgs = (e) => ({ opBal: e.OP_BAL, opDate: e.OP_DATE, freq: e.FREQ, fare: e.FARE });

module.exports = function (connection) {
  const router = express.Router();
  const db = promiseDb(connection);

  const loadEmp = async (empCode) => (await db.query(`${EMP_SELECT} WHERE e.EMP_CODE = ?`, [empCode]))[0][0];
  const loadTxns = async (empCode) =>
    (await db.query(`${TXN_SELECT} WHERE EMP_CODE = ? ORDER BY TXN_DATE, srno_row_id`, [empCode]))[0];

  // Employees for the dropdown - all employees, ticket-eligible ones first
  router.get("/ticket-ledger/emps", async (req, res) => {
    try {
      const [r] = await db.query(
        `SELECT e.EMP_CODE, e.${T.empName} AS EMP_NAME, e.${T.empCatg} AS EMP_CATG,
                CASE WHEN UPPER(COALESCE(h.${T.eligible}, 'N')) IN ('Y','YES') THEN 'Y' ELSE 'N' END AS ELIGIBLE,
                DATE_FORMAT(h.${T.opDate}, '%Y-%m-%d') AS OP_DATE, h.${T.sector} AS SECTOR
           FROM ${T.emp} e LEFT JOIN ${T.hr} h ON h.EMP_CODE = e.EMP_CODE
          ORDER BY ELIGIBLE DESC, e.EMP_CODE`);
      res.json(r);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Ledger for one employee: /ticket-ledger/W002?from=2026-04-01&to=2026-11-30
  router.get("/ticket-ledger/:empCode", async (req, res) => {
    try {
      const emp = await loadEmp(req.params.empCode);
      if (!emp) return res.status(404).json({ error: "Employee not found" });
      const to = req.query.to || ymd(new Date());
      const from = req.query.from || null;
      const led = buildLedger(empArgs(emp), await loadTxns(emp.EMP_CODE), from, to);
      if (led.error) return res.status(400).json({ error: led.error, emp });
      res.json({ emp, ...led });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Balances of all eligible employees as on a date - for year-end ticket provision
  router.get("/ticket-balances", async (req, res) => {
    try {
      const asOn = req.query.asOn || ymd(new Date());
      const [emps] = await db.query(
        `${EMP_SELECT} WHERE UPPER(COALESCE(h.${T.eligible}, 'N')) IN ('Y','YES') AND h.${T.opDate} IS NOT NULL ORDER BY e.EMP_CODE`);
      const [txns] = await db.query(`${TXN_SELECT} WHERE TXN_DATE <= ?`, [asOn]);
      const byEmp = {};
      txns.forEach((t) => (byEmp[t.EMP_CODE] ||= []).push(t));
      const out = emps.map((e) => {
        const l = buildLedger(empArgs(e), byEmp[e.EMP_CODE] || [], asOn, asOn);
        return { EMP_CODE: e.EMP_CODE, EMP_NAME: e.EMP_NAME, EMP_CATG: e.EMP_CATG,
                 balance: l.totals.balance, fare: Number(e.FARE || 0), value: l.totals.value };
      });
      res.json({ asOn, rows: out, totalValue: r2(out.reduce((s, x) => s + x.value, 0)) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
};

// shared with routes/ticketIssueApi.js
module.exports.buildLedger = buildLedger;
module.exports.promiseDb = promiseDb;
module.exports.EMP_SELECT = EMP_SELECT;
module.exports.TXN_SELECT = TXN_SELECT;
module.exports.empArgs = empArgs;
module.exports.ymd = ymd;
module.exports.r2 = r2;
