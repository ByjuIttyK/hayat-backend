// ─────────────────────────────────────────────────────────────────────────────
//  Proforma Invoice number generator — series is driven by the INVOICE DATE,
//  not by the wall clock. Back-dating an invoice into last year now correctly
//  continues last year's series instead of jumping into the current one.
// ─────────────────────────────────────────────────────────────────────────────

// Month the series rolls over. 4 = April (financial year), 1 = calendar year.
// This is the ONLY place the rule lives — change it here and both the suffix
// and the "which series does this date belong to" test follow.
const FY_START_MONTH = 4;

// Pull year + month out of whatever the caller hands us WITHOUT going through
// new Date(). `new Date('2026-01-01')` is parsed as UTC midnight, so on a server
// running behind UTC it reads back as 31-Dec — which would file a January
// invoice under the previous year's series. Parsing the string directly sidesteps
// the whole timezone question.
function ymOf(v) {
  if (v instanceof Date) {
    return { y: v.getFullYear(), m: v.getMonth() + 1 };   // driver-supplied Date is already local
  }
  const s = String(v || '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]) };
}

/**
 * Two-digit series suffix for a given invoice date.
 *   FY_START_MONTH = 4 : 15-Aug-2026 -> FY 2026-27 -> "27"
 *                        15-Feb-2026 -> FY 2025-26 -> "26"
 *   FY_START_MONTH = 1 : 15-Aug-2026 -> "26"
 */
function invYearSuffix(invDate) {
  const ym = ymOf(invDate);
  if (!ym) {
    const err = new Error('INV_DATE is missing or not a valid YYYY-MM-DD date');
    err.status = 400;
    throw err;
  }
  const startYear = ym.m >= FY_START_MONTH ? ym.y : ym.y - 1;
  const tail = FY_START_MONTH === 1 ? startYear : startYear + 1;
  return String(tail % 100).padStart(2, '0');
}

/**
 * Next invoice number for the series that `invDate` belongs to.
 * Returns e.g. "137/27".
 *
 * NOTE: MAX()+1 is not safe against concurrent saves — see nextInvNoAtomic below.
 */
async function nextInvNo(conn, invDate) {
  const yy = invYearSuffix(invDate);

  // Two predicates on purpose:
  //   LIKE '%/27'                        — cheap filter
  //   SUBSTRING_INDEX(INV_NO,'/',-1)='27' — exact tail, so a stray "12/1/27"
  //                                         style value can't slip into the max
  const [rows] = await conn.query(
    `SELECT MAX(CAST(SUBSTRING_INDEX(INV_NO,'/',1) AS UNSIGNED)) AS mx
       FROM pfinv_net
      WHERE INV_NO LIKE ?
        AND SUBSTRING_INDEX(INV_NO,'/',-1) = ?`,
    [`%/${yy}`, yy]
  );

  const next = (Number(rows[0] && rows[0].mx) || 0) + 1;
  return `${next}/${yy}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Race-safe variant — same shape as the jv_sequence pattern already in use.
//
//  DDL (run once):
//    CREATE TABLE pfinv_sequence (
//      YY       CHAR(2)     NOT NULL,
//      LAST_NO  INT         NOT NULL DEFAULT 0,
//      PRIMARY KEY (YY)
//    ) ENGINE=InnoDB;
//
//    -- seed from whatever is already in pfinv_net
//    INSERT INTO pfinv_sequence (YY, LAST_NO)
//    SELECT SUBSTRING_INDEX(INV_NO,'/',-1) AS YY,
//           MAX(CAST(SUBSTRING_INDEX(INV_NO,'/',1) AS UNSIGNED))
//      FROM pfinv_net
//     WHERE INV_NO LIKE '%/%'
//     GROUP BY 1;
//
//  MUST be called inside the same transaction as the INSERT, otherwise the row
//  lock is released before the invoice row exists and the gap reopens.
// ─────────────────────────────────────────────────────────────────────────────
async function nextInvNoAtomic(conn, invDate) {
  const yy = invYearSuffix(invDate);

  // Creates the year's row on first use; the UPDATE below then locks it.
  await conn.query(
    `INSERT IGNORE INTO pfinv_sequence (YY, LAST_NO) VALUES (?, 0)`,
    [yy]
  );

  // The UPDATE takes an exclusive row lock held until COMMIT, so a second
  // session blocks here instead of reading the same LAST_NO.
  await conn.query(
    `UPDATE pfinv_sequence SET LAST_NO = LAST_NO + 1 WHERE YY = ?`,
    [yy]
  );

  const [rows] = await conn.query(
    `SELECT LAST_NO FROM pfinv_sequence WHERE YY = ?`,
    [yy]
  );

  return `${rows[0].LAST_NO}/${yy}`;
}

module.exports = { nextInvNo, nextInvNoAtomic, invYearSuffix, FY_START_MONTH };
