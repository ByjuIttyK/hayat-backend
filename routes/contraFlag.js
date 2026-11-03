// routes/contraFlag.js
// ─────────────────────────────────────────────────────────────────────────────
// Server-side Contra flag for PV / JV (and any voucher saved through vouchers).
//
// Rule: a voucher is CONTRA when every one of its tran_acc lines is a cash or
// bank account. The server works it out from the lines it has just written —
// the screen only displays it — so the flag can't be forgotten or set wrongly.
//
// Use: in the save route (save-jv, and the PV save route), AFTER the tran_acc
// lines are inserted and BEFORE the commit, on the same connection:
//
//     const { stampContra } = require("./contraFlag");
//     ...
//     const contra = await stampContra(conn, tranType, vchrNo);   // 'Y' | 'N'
//     // optional: include it in the response → res.json({ ..., contraFlg: contra })
//
// Works with a callback-style mysql2 connection (conn.query(sql, params, cb))
// and with a promise connection (mysql2/promise).
// ─────────────────────────────────────────────────────────────────────────────

// Cash and bank accounts. Change here if some cash/bank accounts sit outside
// 111-, or 111- holds accounts that are not cash/bank.
const CASH_BANK_PREFIXES = ["111-"];

const cashBankSql = CASH_BANK_PREFIXES
  .map(() => "COALESCE(t.ACC_CODE, '') LIKE ?")
  .join(" OR ");
const cashBankParams = CASH_BANK_PREFIXES.map((p) => `${p}%`);

function q(conn, sql, params) {
  return new Promise((resolve, reject) => {
    const ret = conn.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    // mysql2/promise ignores the callback and returns a real Promise of
    // [rows, fields]. (Don't test for .then — mysql2's callback Query object
    // has a .then that deliberately throws.)
    if (ret instanceof Promise) {
      ret.then((r) => resolve(Array.isArray(r) ? r[0] : r), reject);
    }
  });
}

/** Sets vouchers.CONTRA_FLG for one voucher from its tran_acc lines. Returns 'Y' or 'N'. */
async function stampContra(conn, tranType, vchrNo) {
  await q(conn,
    `UPDATE vouchers v
        SET v.CONTRA_FLG =
            (SELECT CASE WHEN COUNT(*) >= 2 AND SUM(NOT (${cashBankSql})) = 0
                         THEN 'Y' ELSE 'N' END
               FROM tran_acc t
              WHERE t.TRAN_TYPE = v.TRAN_TYPE AND t.VCHR_NO = v.VCHR_NO)
      WHERE v.TRAN_TYPE = ? AND v.VCHR_NO = ?`,
    [...cashBankParams, tranType, vchrNo]);

  const rows = await q(conn,
    "SELECT CONTRA_FLG FROM vouchers WHERE TRAN_TYPE = ? AND VCHR_NO = ?",
    [tranType, vchrNo]);
  return rows && rows[0] ? rows[0].CONTRA_FLG : "N";
}

module.exports = { stampContra, CASH_BANK_PREFIXES };
