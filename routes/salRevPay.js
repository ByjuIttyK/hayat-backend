// =====================================================================
// salRevPay.js — effective pay for a date, from the masters + salary revisions  30-Oct-2026
//
//   PAY_REV_RULE 'FIRST'   : a revision applies from the 1st (EFF_DATE if the 1st, else next month's 1st)
//                'PRORATA' : (later) applies from EFF_DATE — change applyFromOf() and split the month
//
//   payAsOf(q, conn, empCode, isoDate) → { basic, allow: [{code, amount}], ded: [{code, amount}] }
//     Starts from today's masters (payroll_mst.BASIC_SAL, emp_allow_mst, emp_ded_mst), undoes applied
//     revisions that start after the date, and adds approved ones not yet applied that start on/before it.
//     So the time sheet of any month gets that month's pay, past or future.
//   applyDue(q, conn, empCode?) → writes approved revisions whose APPLY_FROM has arrived into the masters.
//
//   q(conn, sql, params) is the promise query wrapper of the calling route.
// =====================================================================
const PAY_REV_RULE = 'FIRST';

const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** Date payroll uses for a revision with this effective date (YYYY-MM-DD in, YYYY-MM-DD out). */
function applyFromOf(effIso) {
  const d = new Date(`${String(effIso).slice(0, 10)}T00:00:00Z`);
  if (PAY_REV_RULE === 'PRORATA' || d.getUTCDate() === 1) return isoOf(d);
  return isoOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)));
}

const key = (type, code) => `${type}|${Number(code) || 0}`;

/** Approved revision lines of an employee, oldest first. */
const revLines = (q, conn, empCode) =>
  q(
    conn,
    `SELECT h.REV_NO, DATE_FORMAT(h.APPLY_FROM,'%Y-%m-%d') APPLY_FROM, h.APPLIED, d.ITEM_TYPE, d.ITEM_CODE, d.OLD_AMT, d.NEW_AMT
       FROM sal_rev_hdr h JOIN sal_rev_dtl d ON d.REV_NO = h.REV_NO
      WHERE h.EMP_CODE = ? AND h.STATUS = 'A'
      ORDER BY h.APPLY_FROM, h.REV_NO, d.LINE_NO`,
    [empCode],
  );

async function currentMasters(q, conn, empCode) {
  const map = new Map();
  const b = await q(conn, `SELECT IFNULL(BASIC_SAL,0) BASIC_SAL FROM payroll_mst WHERE EMP_CODE = ?`, [empCode]);
  map.set(key('B', 0), Number(b[0]?.BASIC_SAL || 0));
  for (const r of await q(conn, `SELECT ALLOW_CODE, AMOUNT FROM emp_allow_mst WHERE EMP_CODE = ?`, [empCode]))
    map.set(key('A', r.ALLOW_CODE), Number(r.AMOUNT) || 0);
  for (const r of await q(conn, `SELECT DED_CODE, AMOUNT FROM emp_ded_mst WHERE EMP_CODE = ?`, [empCode]))
    map.set(key('D', r.DED_CODE), Number(r.AMOUNT) || 0);
  return map;
}

/** Pay in force on isoDate. */
async function payAsOf(q, conn, empCode, isoDate) {
  const date = String(isoDate).slice(0, 10);
  const map = await currentMasters(q, conn, empCode);
  const lines = await revLines(q, conn, empCode);
  // undo applied revisions that start after the date (newest first)
  for (const l of [...lines].reverse())
    if (l.APPLIED === 'Y' && l.APPLY_FROM > date) map.set(key(l.ITEM_TYPE, l.ITEM_CODE), Number(l.OLD_AMT) || 0);
  // add approved, not yet applied revisions that start on/before the date (oldest first)
  for (const l of lines)
    if (l.APPLIED !== 'Y' && l.APPLY_FROM <= date) map.set(key(l.ITEM_TYPE, l.ITEM_CODE), Number(l.NEW_AMT) || 0);

  const out = { basic: 0, allow: [], ded: [] };
  for (const [k, amount] of map) {
    const [type, code] = k.split('|');
    if (type === 'B') out.basic = amount;
    else if (amount > 0) out[type === 'A' ? 'allow' : 'ded'].push({ code: Number(code), amount });
  }
  out.allow.sort((a, b) => a.code - b.code);
  out.ded.sort((a, b) => a.code - b.code);
  return out;
}

/** Write approved revisions that have fallen due into the masters (call inside a transaction). */
async function applyDue(q, conn, empCode) {
  const due = await q(
    conn,
    `SELECT REV_NO, EMP_CODE FROM sal_rev_hdr
      WHERE STATUS = 'A' AND APPLIED = 'N' AND APPLY_FROM <= CURDATE() ${empCode ? 'AND EMP_CODE = ?' : ''}
      ORDER BY APPLY_FROM, REV_NO`,
    empCode ? [empCode] : [],
  );
  for (const h of due) {
    const lines = await q(conn, `SELECT ITEM_TYPE, ITEM_CODE, NEW_AMT FROM sal_rev_dtl WHERE REV_NO = ?`, [h.REV_NO]);
    for (const l of lines) {
      const amt = Number(l.NEW_AMT) || 0;
      if (l.ITEM_TYPE === 'B') {
        await q(conn, `UPDATE payroll_mst SET BASIC_SAL = ? WHERE EMP_CODE = ?`, [amt, h.EMP_CODE]);
      } else {
        const t = l.ITEM_TYPE === 'A' ? { tbl: 'emp_allow_mst', col: 'ALLOW_CODE' } : { tbl: 'emp_ded_mst', col: 'DED_CODE' };
        if (amt > 0)
          await q(
            conn,
            `INSERT INTO ${t.tbl} (EMP_CODE, ${t.col}, AMOUNT, CREATED_BY) VALUES (?,?,?, 'SAL-REV')
             ON DUPLICATE KEY UPDATE AMOUNT = VALUES(AMOUNT), MODIFIED_BY = 'SAL-REV'`,
            [h.EMP_CODE, l.ITEM_CODE, amt],
          );
        else await q(conn, `DELETE FROM ${t.tbl} WHERE EMP_CODE = ? AND ${t.col} = ?`, [h.EMP_CODE, l.ITEM_CODE]);
      }
    }
    await q(conn, `UPDATE sal_rev_hdr SET APPLIED = 'Y' WHERE REV_NO = ?`, [h.REV_NO]);
  }
  return due.length;
}

module.exports = { PAY_REV_RULE, applyFromOf, payAsOf, applyDue };
