// routes/chqDupRoutes.js
// ─────────────────────────────────────────────────────────────────────────────
// Duplicate cheque check for the Bank PV cheque grid.
//
//   GET /api/chq-dup-check?chqNo=001194&bank=111-011-0-001&tranType=04&vchrNo=0000004283
//
// Looks for the cheque number among the cheques already issued — pdc_isu
// (post-dated) and current_chq (current-dated, TRAN_TYPE 04) — leaving out the
// voucher being edited. Leading zeros are ignored, so 001194 = 1194.
//
//   → { sameBank:  [ { SRC, TRAN_TYPE, VCHR_NO, CHQ_DATE, CHQ_BANK, AMOUNT } ],
//       otherBank: [ ... ] }
//
// sameBank  → the screen shows an error and clears the cheque number
// otherBank → the screen shows a warning only (different cheque books)
//
// Each table is queried on its own; if one of them is missing or differs, the
// check still runs on the other and the problem is logged.
//
// Register in HayatDb.js like the other routes, e.g.
//   app.use("/api", authMiddleware, require("./routes/chqDupRoutes")(connection));
// ─────────────────────────────────────────────────────────────────────────────
const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  const q = (sql, params) =>
    new Promise((resolve) =>
      connection.query(sql, params, (err, rows) => {
        if (err) { console.error("chq-dup-check:", err.sqlMessage || err.message); resolve([]); }
        else resolve(rows);
      }));

  // chq no without spaces and leading zeros
  const norm = "TRIM(LEADING '0' FROM TRIM(CHQ_NO))";

  router.get("/chq-dup-check", async (req, res) => {
    const chqNo = String(req.query.chqNo || "").trim().replace(/^0+/, "");
    const bank = String(req.query.bank || "").trim();
    const tranType = String(req.query.tranType || "").trim();
    const vchrNo = String(req.query.vchrNo || "").trim();
    if (!chqNo) return res.json({ sameBank: [], otherBank: [] });

    const cols = `TRAN_TYPE, VCHR_NO, DATE_FORMAT(CHQ_DATE, '%d/%m/%Y') AS CHQ_DATE,
                  TRIM(CHQ_BANK) AS CHQ_BANK, AMOUNT`;
    const notThis = "NOT (TRAN_TYPE = ? AND VCHR_NO = ?)";

    const [pdc, cur] = await Promise.all([
      q(`SELECT 'PDC' AS SRC, ${cols} FROM pdc_isu
          WHERE ${norm} = ? AND ${notThis}`,
        [chqNo, tranType, vchrNo]),
      q(`SELECT 'CURRENT' AS SRC, ${cols} FROM current_chq
          WHERE TRAN_TYPE = '04' AND ${norm} = ? AND ${notThis}`,
        [chqNo, tranType, vchrNo]),
    ]);

    // The same cheque can sit in both tables (a PDC that became current) —
    // report each voucher once.
    const seen = new Set();
    const all = [...pdc, ...cur].filter((r) => {
      const k = `${r.TRAN_TYPE}|${r.VCHR_NO}|${r.CHQ_BANK}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    res.json({
      sameBank: bank ? all.filter((r) => r.CHQ_BANK === bank) : [],
      otherBank: all.filter((r) => !bank || r.CHQ_BANK !== bank),
    });
  });

  return router;
};
