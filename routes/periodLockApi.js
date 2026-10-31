// routes/periodLockApi.js
// Period lock: financial period (ac_period) + per-transaction-type closing date (tran_type.CLOSED_PERIOD)
//
//   GET /api/period-lock   -> { periods: [{start,end}], types: { "06": { name, closed } , ... } }
//
// A document of tran type T dated D is LOCKED when
//   (a) tran_type.CLOSED_PERIOD for T is set and D <= CLOSED_PERIOD, or
//   (b) ac_period has rows and D is not inside any START_DATE..END_DATE row.
//
// Register in HayatDb.js:
//   const periodLockApi = require("./routes/periodLockApi");
//   app.use("/api", periodLockApi(connection));
//
// Use in any save / delete route (before writing):
//   const { checkPeriodOpen } = require("./periodLockApi");
//   const msg = await checkPeriodOpen(connection, "06", vchrDate);   // ISO or dd/MM/yyyy
//   if (msg) return res.status(400).json({ error: msg });
//   (on EDIT / DELETE check the date already saved as well as the new one)

const express = require("express");

const pad = (n) => String(n).padStart(2, "0");
const iso = (v) => {
  if (!v) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(s);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return null;
};
const dmy = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : "");

async function loadLock(conn) {
  const db = conn.promise ? conn.promise() : conn;
  const [p] = await db.query(
    "SELECT DATE_FORMAT(START_DATE,'%Y-%m-%d') AS S, DATE_FORMAT(END_DATE,'%Y-%m-%d') AS E FROM ac_period");
  const [t] = await db.query(
    "SELECT TRAN_TYPE, TYPE_DES, DATE_FORMAT(CLOSED_PERIOD,'%Y-%m-%d') AS C FROM tran_type");
  const periods = p.filter((r) => r.S && r.E).map((r) => ({ start: r.S, end: r.E }));
  const types = {};
  t.forEach((r) => (types[r.TRAN_TYPE] = { name: (r.TYPE_DES || r.TRAN_TYPE).trim(), closed: r.C || null }));
  return { periods, types };
}

// Same rule as components/utils/periodLock.ts → lockReason()
function lockReason(data, tranType, date) {
  const d = iso(date);
  if (!d) return null;
  const t = tranType ? data.types[String(tranType)] : null;
  if (t && t.closed && d <= t.closed)
    return `${t.name} period is closed up to ${dmy(t.closed)}`;
  if (data.periods.length && !data.periods.some((p) => d >= p.start && d <= p.end)) {
    const open = data.periods.map((p) => `${dmy(p.start)} - ${dmy(p.end)}`).join(", ");
    return `${dmy(d)} is outside the open financial period (${open})`;
  }
  return null;
}

/** null when the date is open for that tran type, else the reason it is locked. */
async function checkPeriodOpen(conn, tranType, date) {
  return lockReason(await loadLock(conn), tranType, date);
}

module.exports = function (connection) {
  const router = express.Router();

  router.get("/period-lock", async (_req, res) => {
    try {
      res.json(await loadLock(connection));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
module.exports.checkPeriodOpen = checkPeriodOpen;
module.exports.lockReason = lockReason;
