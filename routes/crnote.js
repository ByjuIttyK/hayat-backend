// routes/crnote.js
// Credit Note routes for Telltron ERP
// Register in HayatDb.js:   app.use("/api", require("./routes/crnote")(connection));
//
// Endpoints created here (all under /api):
//   GET  /api/crnote/next-no          -> { nextNo: "CR00000012" }
//   GET  /api/crnote/acc/:acCode      -> [{ AC_CODE, AC_HEAD }]
//   GET  /api/crnote/:vchrNo          -> { hdr: {...}, settled: [...] }
//   POST /api/save-crnote             -> { message, VCHR_NO }
//
// NOTE: table names are written in lower case on purpose — the VPS runs
// lower_case_table_names=0, so CRNOTE_HDR fails there while crnote_hdr works.
// (That is why /api/getMaxDoc/CRNOTE_HDR/VCHR_NO returned nothing on the server.)

const express = require("express");

// ---------------------------------------------------------------------------
// CONFIG — please confirm these three values against the Oracle system
// ---------------------------------------------------------------------------
const TRAN_TYPE = "09";                 // tran_acc.TRAN_TYPE used for credit notes
const VAT_AC = "142-004-0-001";         // GL account the VAT part is posted to
const DIV_CODE = "01";                  // division code written to tran_acc / adj_dtl
const DOC_PREFIX = "CR";                // voucher number prefix
const DOC_WIDTH = 8;                    // digits after the prefix -> CR00000011
// ---------------------------------------------------------------------------

module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise();

  const pad = (n) => DOC_PREFIX + String(n).padStart(DOC_WIDTH, "0");

  // Next voucher number (MAX of the numeric part + 1)
  async function nextVchrNo(conn) {
    const [rows] = await conn.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(VCHR_NO, ?) AS UNSIGNED)), 0) AS maxNo
         FROM crnote_hdr
        WHERE VCHR_NO LIKE ?`,
      [DOC_PREFIX.length + 1, DOC_PREFIX + "%"]
    );
    return pad(Number(rows[0].maxNo) + 1);
  }

  // =========================================================================
  // GET /api/crnote/next-no
  // =========================================================================
  router.get("/crnote/next-no", async (req, res) => {
    try {
      const nextNo = await nextVchrNo(db);
      res.json({ nextNo });
    } catch (err) {
      console.error("crnote/next-no:", err);
      res.status(500).json({ message: "Could not generate the next credit note number" });
    }
  });

  // =========================================================================
  // GET /api/crnote/acc/:acCode      (validates the Debit A/c typed by hand)
  // =========================================================================
  router.get("/crnote/acc/:acCode", async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT ac_code AS AC_CODE, ac_head AS AC_HEAD
           FROM ac_list
          WHERE ac_code = ?`,
        [req.params.acCode]
      );
      res.json(rows);
    } catch (err) {
      console.error("crnote/acc:", err);
      res.status(500).json({ message: "Could not read the account" });
    }
  });

  // =========================================================================
  // GET /api/crnote/:vchrNo          (header + settlement lines for EDIT/VIEW)
  // Dates come back already formatted dd/MM/yyyy so no time-zone shift happens.
  // =========================================================================
  router.get("/crnote/:vchrNo", async (req, res) => {
    try {
      const { vchrNo } = req.params;

      const [hdrRows] = await db.query(
        `SELECT h.VCHR_NO,
                DATE_FORMAT(h.VCHR_DATE, '%d/%m/%Y') AS VCHR_DATE,
                h.CUST_CODE,
                c.cust_name  AS CUST_NAME,
                h.DEBIT_AC,
                a.ac_head    AS ACC_HEAD,
                h.NARRATION,
                h.AMOUNT,
                h.VAT_AMT,
                h.MAIN_SR_NO,
                h.SMAN_CODE,
                s.SMAN_NAME
           FROM crnote_hdr h
           LEFT JOIN cus_mst  c ON c.cust_code = h.CUST_CODE
           LEFT JOIN ac_list  a ON a.ac_code   = h.DEBIT_AC
           LEFT JOIN sman_mst s ON s.sman_code = h.SMAN_CODE
          WHERE h.VCHR_NO = ?`,
        [vchrNo]
      );

      if (!hdrRows.length) {
        return res.status(404).json({ message: `Credit note ${vchrNo} not found` });
      }

      // Invoices this credit note has already been set against
      const [settled] = await db.query(
        `SELECT SOURCE_TYPE AS DOC_TYPE,
                SOURCE_DOC  AS DOC_NO,
                DATE_FORMAT(SOURCE_DATE, '%d/%m/%Y') AS DOC_DATE,
                ACC_CODE    AS CUST_CODE,
                STLD_AMT    AS AMOUNT
           FROM adj_dtl
          WHERE STLD_DOC = ? AND STLD_TYPE = ?`,
        [vchrNo, TRAN_TYPE]
      );

      res.json({ hdr: hdrRows[0], settled });
    } catch (err) {
      console.error("crnote/:vchrNo:", err);
      res.status(500).json({ message: "Could not load the credit note" });
    }
  });

  // =========================================================================
  // POST /api/save-crnote
  // body: { pageMode, hdr: {...}, settlements: [{ DOC_NO, DOC_TYPE, DOC_DATE, AMOUNT }] }
  // Header + GL (tran_acc) + settlements (adj_dtl) in one transaction.
  // =========================================================================
  router.post("/save-crnote", async (req, res) => {
    const conn = await connection.promise().getConnection();
    try {
      const { pageMode = "ADD", hdr = {}, settlements = [] } = req.body || {};

      if (!hdr.CUST_CODE) return res.status(400).json({ message: "Customer code is required" });
      if (!hdr.VCHR_DATE) return res.status(400).json({ message: "Credit note date is required" });

      const amount = Number(hdr.AMOUNT) || 0;
      const vatAmt = Number(hdr.VAT_AMT) || 0;
      const total = amount + vatAmt;

      await conn.beginTransaction();

      let vchrNo = hdr.VCHR_NO;
      let mainSrNo = hdr.MAIN_SR_NO;

      if (pageMode === "ADD") {
        vchrNo = await nextVchrNo(conn);
        const [sr] = await conn.query(
          `SELECT COALESCE(MAX(MAIN_SR_NO), 0) + 1 AS nextSr
             FROM tran_acc WHERE TRAN_TYPE = ?`,
          [TRAN_TYPE]
        );
        mainSrNo = Number(sr[0].nextSr);
      }

      // ----- header ---------------------------------------------------------
      await conn.query(
        `INSERT INTO crnote_hdr
           (VCHR_NO, VCHR_DATE, CUST_CODE, DEBIT_AC, NARRATION,
            AMOUNT, VAT_AMT, MAIN_SR_NO, SMAN_CODE)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            VCHR_DATE  = VALUES(VCHR_DATE),
            CUST_CODE  = VALUES(CUST_CODE),
            DEBIT_AC   = VALUES(DEBIT_AC),
            NARRATION  = VALUES(NARRATION),
            AMOUNT     = VALUES(AMOUNT),
            VAT_AMT    = VALUES(VAT_AMT),
            SMAN_CODE  = VALUES(SMAN_CODE)`,
        [
          vchrNo,
          hdr.VCHR_DATE,          // yyyy-MM-dd from the screen
          hdr.CUST_CODE,
          hdr.DEBIT_AC || null,
          hdr.NARRATION || null,
          amount,
          vatAmt,
          mainSrNo || null,
          hdr.SMAN_CODE || null,
        ]
      );

      // ----- G/L postings ---------------------------------------------------
      await conn.query(`DELETE FROM tran_acc WHERE TRAN_TYPE = ? AND vchr_no = ?`, [
        TRAN_TYPE,
        vchrNo,
      ]);

      const narration = hdr.NARRATION || `Credit Note ${vchrNo}`;
      const glLines = [
        // Cr the customer with the full value of the note
        [TRAN_TYPE, vchrNo, hdr.VCHR_DATE, hdr.CUST_CODE, total, "C", narration, 1, mainSrNo, DIV_CODE],
        // Dr the expense / income account
        [TRAN_TYPE, vchrNo, hdr.VCHR_DATE, hdr.DEBIT_AC, amount, "D", narration, 2, mainSrNo, DIV_CODE],
      ];
      if (vatAmt > 0) {
        glLines.push([TRAN_TYPE, vchrNo, hdr.VCHR_DATE, VAT_AC, vatAmt, "D", narration, 3, mainSrNo, DIV_CODE]);
      }

      await conn.query(
        `INSERT INTO tran_acc
           (TRAN_TYPE, vchr_no, DATTE, ACC_CODE, AMOUNT, DB_CR,
            NARRATION1, SR_NO, MAIN_SR_NO, DIV_CODE)
         VALUES ?`,
        [glLines]
      );

      // ----- settlements ----------------------------------------------------
      await conn.query(`DELETE FROM adj_dtl WHERE STLD_DOC = ? AND STLD_TYPE = ?`, [
        vchrNo,
        TRAN_TYPE,
      ]);

      const stlRows = (settlements || [])
        .filter((r) => r.DOC_NO && Number(r.AMOUNT) > 0)
        .map((r) => [
          r.DOC_NO,
          r.DOC_TYPE || null,
          r.DOC_DATE || null,          // yyyy-MM-dd
          hdr.CUST_CODE,
          vchrNo,
          TRAN_TYPE,
          Number(r.AMOUNT),
          "C",
          hdr.VCHR_DATE,
          DIV_CODE,
          mainSrNo || null,
        ]);

      if (stlRows.length) {
        await conn.query(
          `INSERT INTO adj_dtl
             (SOURCE_DOC, SOURCE_TYPE, SOURCE_DATE, ACC_CODE,
              STLD_DOC, STLD_TYPE, STLD_AMT, STLD_DBCR, STLD_DATE,
              DIV_CODE, MAIN_SR_NO)
           VALUES ?`,
          [stlRows]
        );
      }

      await conn.commit();
      res.json({ message: `Credit note ${vchrNo} saved`, VCHR_NO: vchrNo });
    } catch (err) {
      await conn.rollback();
      console.error("save-crnote:", err);
      res.status(500).json({ message: `Could not save the credit note: ${err.message}` });
    } finally {
      conn.release();
    }
  });

  return router;
};
