// hayatApi/routes/voucherDelete.js
//
// Delete a voucher whole: the header, its account lines, its cheques, its
// settlements and its LPO allocations, in one transaction.
//
//   const voucherDelete = require("./routes/voucherDelete");
//   app.use("/api", voucherDelete(connection));
//
// Only the four voucher types that live in vouchers/tran_acc are handled here.
// Invoices, LPOs, SRVs and the rest carry stock and costing consequences that
// a blanket row delete would not undo, so they are refused rather than half
// handled.

const express = require("express");

// Checked on the server, not in the browser: anything compared in the React
// bundle can be read by anyone who opens the dev tools, so the password would
// be decoration. Override per-site with VOUCHER_DELETE_PASSWORD in .env.
const DELETE_PASSWORD = process.env.VOUCHER_DELETE_PASSWORD || "swiTch@26";

// Tran types this route will delete. Keyed by the list screen's pageType.
// CONFIRM the codes against tran_type_mst before going live — PCV especially.
const DELETABLE = {
  RV: ["03", "01"],  // receipt: bank, cash
  PV: ["04", "02"],  // payment: bank, cash
  JV: ["05"],        // journal
  PCV: ["06"],       // petty cash
};

const ALL_DELETABLE = Object.values(DELETABLE).flat();

module.exports = function (connection) {
  const router = express.Router();
  const dbp = connection.promise();

  const num = (v) => Number(v || 0);

  /* ---- GET /api/voucher-lines/:tranType/:vchrNo ---------------------------
   * What the confirmation window shows: the voucher's own Dr/Cr lines, plus a
   * count of everything else that would go with it.
   * ---------------------------------------------------------------------- */
  router.get("/voucher-lines/:tranType/:vchrNo", async (req, res) => {
    const { tranType, vchrNo } = req.params;
    try {
      const [hdr] = await dbp.query(
        `SELECT v.TRAN_TYPE, v.VCHR_NO,
                DATE_FORMAT(v.DATTE, '%d/%m/%Y') AS DATTE,
                v.NARRATION1, v.PAID_TO, v.AMOUNT, v.CUST_CODE, v.ACC_CODE
           FROM vouchers v
          WHERE v.TRAN_TYPE = ? AND v.VCHR_NO = ?`,
        [tranType, vchrNo]
      );

      const [lines] = await dbp.query(
        `SELECT t.SR_NO, t.ACC_CODE,
                COALESCE(a.ac_head, '')          AS ACC_HEAD,
                t.NARRATION1, t.JOB_NO, t.DB_CR, t.AMOUNT
           FROM tran_acc t
           LEFT JOIN ac_list a ON a.ac_code = t.ACC_CODE
          WHERE t.TRAN_TYPE = ? AND t.VCHR_NO = ?
          ORDER BY t.SR_NO`,
        [tranType, vchrNo]
      );

      // The child rows themselves, not just how many. A count tells the user
      // something will vanish; the rows tell them which cheque and which
      // invoice, which is what they need to judge the delete.
      const p2 = [tranType, vchrNo];

      const [chqIsu] = await dbp.query(
        `SELECT CHQ_NO, DATE_FORMAT(CHQ_DATE,'%d/%m/%Y') AS CHQ_DATE,
                CHQ_BANK, PDC_CODE, SUP_CODE AS PARTY, AMOUNT, REALISED
           FROM pdc_isu WHERE TRAN_TYPE=? AND VCHR_NO=? ORDER BY CHQ_DATE, CHQ_NO`, p2);

      const [chqRcd] = await dbp.query(
        `SELECT CHQ_NO, DATE_FORMAT(CHQ_DATE,'%d/%m/%Y') AS CHQ_DATE,
                CHQ_BANK, PDC_CODE, CUST_CODE AS PARTY, AMOUNT, REALISED
           FROM pdc_rcd WHERE TRAN_TYPE=? AND VCHR_NO=? ORDER BY CHQ_DATE, CHQ_NO`, p2);

      const [chqCur] = await dbp.query(
        `SELECT CHQ_NO, DATE_FORMAT(CHQ_DATE,'%d/%m/%Y') AS CHQ_DATE,
                CHQ_BANK, PDC_CODE, SUP_CODE AS PARTY, AMOUNT, REALISED
           FROM current_chq WHERE TRAN_TYPE=? AND VCHR_NO=? ORDER BY CHQ_DATE, CHQ_NO`, p2);

      const [adj] = await dbp.query(
        `SELECT MAIN_SR_NO, STLD_TYPE, STLD_DOC,
                DATE_FORMAT(STLD_DATE,'%d/%m/%Y') AS STLD_DATE,
                ACC_CODE, STLD_AMT, STLD_DBCR
           FROM adj_dtl WHERE SOURCE_TYPE=? AND SOURCE_DOC=? ORDER BY MAIN_SR_NO`, p2);

      const [lpo] = await dbp.query(
        `SELECT MAIN_SR_NO, LPO_NO, DETAILS, SUP_CODE, AMOUNT_STL
           FROM lpo_pv_settlements WHERE PV_TYPE=? AND PV_NO=? ORDER BY MAIN_SR_NO`, p2);

      const chq = (rows) => rows.map((r) => ({ ...r, AMOUNT: num(r.AMOUNT) }));

      if (!hdr.length && !lines.length) {
        return res.status(404).json({ message: `No voucher ${vchrNo} of type ${tranType}.` });
      }

      const totalDr = lines.filter((l) => l.DB_CR === "D").reduce((t, l) => t + num(l.AMOUNT), 0);
      const totalCr = lines.filter((l) => l.DB_CR === "C").reduce((t, l) => t + num(l.AMOUNT), 0);

      res.json({
        header: hdr.length
          ? { ...hdr[0], AMOUNT: num(hdr[0].AMOUNT) }
          : { TRAN_TYPE: tranType, VCHR_NO: vchrNo },
        lines: lines.map((l) => ({ ...l, AMOUNT: num(l.AMOUNT) })),
        totals: {
          dr: Math.round(totalDr * 100) / 100,
          cr: Math.round(totalCr * 100) / 100,
        },
        related: {
          pdcIsu: chqIsu.length,
          pdcRcd: chqRcd.length,
          currentChq: chqCur.length,
          adjDtl: adj.length,
          lpoStl: lpo.length,
        },
        // Everything that goes with the voucher, spelled out
        children: {
          pdcIsu: chq(chqIsu),
          pdcRcd: chq(chqRcd),
          currentChq: chq(chqCur),
          adjDtl: adj.map((r) => ({ ...r, STLD_AMT: num(r.STLD_AMT) })),
          lpoStl: lpo.map((r) => ({ ...r, AMOUNT_STL: num(r.AMOUNT_STL) })),
        },
        deletable: ALL_DELETABLE.includes(String(tranType)),
      });
    } catch (err) {
      console.error("[voucher-lines] failed:", err);
      res.status(500).json({ message: "Could not read the voucher." });
    }
  });

  /* ---- POST /api/voucher-delete/verify ------------------------------------
   * Lets the dialog enable its Delete button only once the password is right,
   * without the password ever reaching the browser. The real check still
   * happens on the DELETE itself — this one is for the button state, and
   * passing it is not authorisation to do anything.
   * ---------------------------------------------------------------------- */
  router.post("/voucher-delete/verify", (req, res) => {
    const password = (req.body && req.body.password) || "";
    res.json({ ok: password === DELETE_PASSWORD });
  });

  /* ---- DELETE /api/voucher/:tranType/:vchrNo ------------------------------
   * All or nothing. A half-deleted voucher — header gone, tran_acc rows left —
   * is worse than one that is still there, so every table goes in the same
   * transaction.
   * ---------------------------------------------------------------------- */
  router.delete("/voucher/:tranType/:vchrNo", async (req, res) => {
    const { tranType, vchrNo } = req.params;
    const deletedBy = (req.body && req.body.deletedBy) || null;
    const password = (req.body && req.body.password) || "";

    if (password !== DELETE_PASSWORD) {
      console.warn(`[voucher delete] wrong password for ${tranType}/${vchrNo}`);
      return res.status(403).json({ message: "That password is not correct." });
    }

    if (!ALL_DELETABLE.includes(String(tranType))) {
      return res.status(400).json({
        message:
          `Tran type ${tranType} is not deleted this way. ` +
          `Only receipts, payments, journals and petty cash vouchers are.`,
      });
    }

    const conn = await dbp.getConnection();
    try {
      await conn.beginTransaction();

      const deletes = [
        ["tran_acc",            "DELETE FROM tran_acc            WHERE TRAN_TYPE=? AND VCHR_NO=?"],
        ["pdc_isu",             "DELETE FROM pdc_isu             WHERE TRAN_TYPE=? AND VCHR_NO=?"],
        ["pdc_rcd",             "DELETE FROM pdc_rcd             WHERE TRAN_TYPE=? AND VCHR_NO=?"],
        ["current_chq",         "DELETE FROM current_chq         WHERE TRAN_TYPE=? AND VCHR_NO=?"],
        ["adj_dtl",             "DELETE FROM adj_dtl             WHERE SOURCE_TYPE=? AND SOURCE_DOC=?"],
        ["lpo_pv_settlements",  "DELETE FROM lpo_pv_settlements  WHERE PV_TYPE=? AND PV_NO=?"],
        ["vouchers",            "DELETE FROM vouchers            WHERE TRAN_TYPE=? AND VCHR_NO=?"],
      ];

      const removed = {};
      for (const [name, sql] of deletes) {
        const [r] = await conn.query(sql, [tranType, vchrNo]);
        removed[name] = r.affectedRows;
      }

      const total = Object.values(removed).reduce((t, n) => t + n, 0);
      if (total === 0) {
        await conn.rollback();
        return res.status(404).json({ message: `Nothing found for voucher ${vchrNo}.` });
      }

      await conn.commit();
      console.log(`[voucher delete] ${tranType}/${vchrNo} by ${deletedBy || "unknown"}:`, removed);
      res.json({ ok: true, tranType, vchrNo, removed });
    } catch (err) {
      await conn.rollback().catch(() => {});
      console.error("[voucher delete] failed:", err);
      res.status(500).json({ message: "The voucher was not deleted.", detail: err.message });
    } finally {
      conn.release();
    }
  });

  return router;
};

module.exports.DELETABLE = DELETABLE;
