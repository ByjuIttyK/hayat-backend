// routes/invPayments.js
// Purchase invoice detail grids — InfoGrid/PURCHASE_HDR (components/InfoGridDetails/InvRcptPanel.tsx)
// (sales invoices: routes/invReceipts.js)
//
//   GET /api/inv-payments/payments/:tranType/:invNo
//       payment vouchers (PV, tran type 04) that settled the invoice (adj_dtl) + the invoice amount
//   GET /api/inv-payments/cheques/:tranType/:invNo
//       cheques of those vouchers (pdc_isu and current_chq, on the voucher's
//       TRAN_TYPE + VCHR_NO), for the invoice's supplier
//
// The invoice's own A/c entries use the existing
//   GET /api/inv-settle/voucher-entries/:tranType/:vchrNo   (routes/invSettle.js)
//
// Register in HayatDb.js:
//   const invPaymentsRoutes = require("./routes/invPayments");
//   app.use("/api", authMiddleware, invPaymentsRoutes(connection));
//
// adj_dtl direction: the voucher is SOURCE_TYPE / SOURCE_DOC and the invoice
// STLD_TYPE / STLD_DOC. Rows where the invoice itself is the SOURCE are read
// too (the other document is then the STLD side).
//
// Built in small steps (vouchers first, then their cheques / names with plain
// parameters) rather than one big UNION / JOIN across tables, so a collation
// difference between adj_dtl, pdc_isu and current_chq cannot fail the query,
// and the TYPE_ABBR lookup in tran_type is optional.

const express = require("express");

const M = {
  invSide: "C",      // party side of the invoice in tran_acc
  paySide: "D",      // party side of the settling voucher
  master: "sup_mst", code: "SUP_CODE",
  pdc: "pdc_isu", pdcParty: "SUP_CODE", pdcFc: null, pdcSrc: "PDC_ISU",
};

module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise();

  const fail = (res, err, where) => {
    console.error(`[invPayments] ${where}:`, err);
    res.status(500).json({ error: `${where} failed`, detail: err.message });
  };

  // vouchers linked to one invoice through adj_dtl
  const linkedVouchers = async (tranType, invNo) => {
    const [rows] = await db.execute(
      `SELECT a.SOURCE_TYPE AS tt, a.SOURCE_DOC AS vn, a.ACC_CODE AS acc,
              DATE_FORMAT(a.SOURCE_DATE, '%Y-%m-%d') AS vdate, a.STLD_AMT AS amt, a.MAIN_SR_NO AS sr
         FROM adj_dtl a
        WHERE a.STLD_TYPE = ? AND a.STLD_DOC = ?
       UNION ALL
       SELECT a.STLD_TYPE, a.STLD_DOC, a.ACC_CODE,
              DATE_FORMAT(a.STLD_DATE, '%Y-%m-%d'), a.STLD_AMT, a.MAIN_SR_NO
         FROM adj_dtl a
        WHERE a.SOURCE_TYPE = ? AND a.SOURCE_DOC = ?`,
      [tranType, invNo, tranType, invNo]
    );
    return rows;
  };

  // TYPE_ABBR per tran type (BR, CP …) — optional, never fails the request
  let abbrCache = null;
  const typeAbbrs = async () => {
    if (abbrCache) return abbrCache;
    const map = {};
    try {
      const [rows] = await db.query("SELECT * FROM tran_type");
      const r0 = rows[0] || {};
      const keyCol = ["TRAN_TYPE", "tran_type", "TRANTYPE", "TYPE_CODE", "CODE"].find((k) => k in r0);
      const abbrCol = ["TYPE_ABBR", "type_abbr", "ABBR", "TYPE_ABBREVIATION"].find((k) => k in r0);
      if (keyCol && abbrCol) rows.forEach((r) => { map[String(r[keyCol]).trim()] = r[abbrCol]; });
    } catch (e) {
      console.warn(`[invPayments] tran_type lookup skipped:`, e.message);
    }
    abbrCache = map;
    return map;
  };

  const ymdToDmy = (s) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : s || null);

  // --- 1. vouchers against the invoice ---------------------------------------
  router.get("/inv-payments/payments/:tranType/:invNo", async (req, res) => {
    const { tranType, invNo } = req.params;
    try {
      const links = await linkedVouchers(tranType, invNo);
      const abbr = await typeAbbrs();

      const lines = [];
      for (const u of links) {
        const [[v]] = await db.execute(
          `SELECT DATE_FORMAT(MIN(t.DATTE), '%Y-%m-%d')                              AS vdate,
                  SUM(CASE WHEN t.ACC_CODE = ? AND t.DB_CR = '${M.paySide}' THEN t.AMOUNT END) AS rvAmount,
                  MAX(CASE WHEN t.ACC_CODE = ?
                           THEN TRIM(CONCAT_WS(' ', t.NARRATION1, t.NARRATION2)) END)          AS narration
             FROM tran_acc t
            WHERE t.TRAN_TYPE = ? AND t.vchr_no = ?`,
          [u.acc, u.acc, u.tt, u.vn]
        );
        lines.push({
          rvType: u.tt,
          rvNo: u.vn,
          rvAbbr: abbr[String(u.tt).trim()] ?? null,
          rvDate: ymdToDmy(u.vdate || v?.vdate),
          acCode: u.acc,
          stldAmt: u.amt,
          rvAmount: v?.rvAmount ?? null,
          narration: v?.narration ?? null,
          _sort: u.vdate || v?.vdate || "9999-12-31",
          _sr: Number(u.sr) || 0,
        });
      }
      lines.sort((a, b) => a._sort.localeCompare(b._sort) || String(a.rvNo).localeCompare(String(b.rvNo)) || a._sr - b._sr);

      // party names
      const codes = [...new Set(lines.map((l) => l.acCode).filter(Boolean))];
      if (codes.length) {
        const ph = codes.map(() => "?").join(",");
        const [names] = await db.execute(
          `SELECT ${M.code} AS code, ${M.code === "CUST_CODE" ? "CUST_NAME" : "SUP_NAME"} AS name
             FROM ${M.master} WHERE ${M.code} IN (${ph})`, codes);
        const nm = Object.fromEntries(names.map((n) => [n.code, n.name]));
        lines.forEach((l) => { l.acName = nm[l.acCode] ?? null; });
      }
      lines.forEach((l) => { delete l._sort; delete l._sr; });

      // invoice amount = the party line(s) of the invoice
      const [inv] = await db.execute(
        `SELECT SUM(t.AMOUNT) AS amt
           FROM tran_acc t
          WHERE t.TRAN_TYPE = ? AND t.vchr_no = ? AND t.DB_CR = '${M.invSide}'
            AND EXISTS (SELECT 1 FROM ${M.master} p WHERE p.${M.code} = t.ACC_CODE)`,
        [tranType, invNo]
      );

      res.json({ lines, invAmount: inv[0]?.amt == null ? null : Number(inv[0].amt) });
    } catch (err) {
      fail(res, err, "invoice payments");
    }
  });

  // --- 2. cheques of those vouchers -------------------------------------------
  router.get("/inv-payments/cheques/:tranType/:invNo", async (req, res) => {
    const { tranType, invNo } = req.params;
    const cols = (partyCol, fcCol) => `
          MAIN_SR_NO                            AS mainSrNo,
          TRAN_TYPE                             AS rvType,
          VCHR_NO                               AS rvNo,
          CHQ_NO                                AS chqNo,
          DATE_FORMAT(CHQ_DATE, '%d/%m/%Y')     AS chqDate,
          DATE_FORMAT(CHQ_DATE, '%Y-%m-%d')     AS chqDateIso,
          CHQ_BANK                              AS chqBank,
          PDC_CODE                              AS pdcCode,
          ${partyCol}                           AS partyCode,
          AMOUNT                                AS amount,
          ${fcCol || "NULL"}                    AS amountFc,
          NARRATION                             AS narration,
          JV_NO_RLZ                             AS jvNoRlz,
          DATE_FORMAT(JV_DATE_RLZ, '%d/%m/%Y')  AS jvDateRlz,
          REALISED                              AS realised`;
    try {
      const links = await linkedVouchers(tranType, invNo);
      // one entry per voucher; the party(ies) it settled for this invoice
      const vouchers = new Map();
      links.forEach((u) => {
        const k = `${u.tt}|${u.vn}`;
        if (!vouchers.has(k)) vouchers.set(k, { tt: u.tt, vn: u.vn, accs: new Set() });
        if (u.acc) vouchers.get(k).accs.add(String(u.acc).trim());
      });
      if (!vouchers.size) return res.json([]);

      const abbr = await typeAbbrs();
      const out = [];
      for (const v of vouchers.values()) {
        const [pdc] = await db.execute(
          `SELECT '${M.pdcSrc}' AS src, ${cols(M.pdcParty, M.pdcFc)}
             FROM ${M.pdc} WHERE TRAN_TYPE = ? AND VCHR_NO = ?`, [v.tt, v.vn]);
        const [cur] = await db.execute(
          `SELECT 'CURRENT' AS src, ${cols("SUP_CODE", "AMOUNT_FC")}
             FROM current_chq WHERE TRAN_TYPE = ? AND VCHR_NO = ?`, [v.tt, v.vn]);
        [...pdc, ...cur].forEach((c) => {
          // a voucher can carry cheques of several parties — keep this invoice's party
          const pc = String(c.partyCode ?? "").trim();
          if (pc && v.accs.size && !v.accs.has(pc)) return;
          out.push({ ...c, rvAbbr: abbr[String(c.rvType).trim()] ?? null });
        });
      }

      // party / PDC account heads
      const codes = [...new Set(out.flatMap((c) => [c.partyCode, c.pdcCode]).filter(Boolean))];
      if (codes.length) {
        const ph = codes.map(() => "?").join(",");
        const [heads] = await db.execute(
          `SELECT AC_CODE AS code, MAX(AC_HEAD) AS head FROM ac_list WHERE AC_CODE IN (${ph}) GROUP BY AC_CODE`, codes);
        const hd = Object.fromEntries(heads.map((h) => [h.code, h.head]));
        out.forEach((c) => { c.partyName = hd[c.partyCode] ?? null; c.pdcHead = hd[c.pdcCode] ?? null; });
      }
      out.sort((a, b) => String(a.rvNo).localeCompare(String(b.rvNo))
        || String(a.chqDateIso ?? "").localeCompare(String(b.chqDateIso ?? ""))
        || String(a.chqNo ?? "").localeCompare(String(b.chqNo ?? "")));
      res.json(out);
    } catch (err) {
      fail(res, err, "invoice cheques");
    }
  });

  return router;
};
