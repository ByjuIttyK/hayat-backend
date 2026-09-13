// routes/drnote.js
// Debit Note routes for Telltron ERP
// Register in HayatDb.js:   app.use("/api", require("./routes/drnote")(connection));
//
//   GET  /api/drnote/next-no                 -> { nextNo: "DR00000001" }
//   GET  /api/drnote/acc/:acCode             -> [{ AC_CODE, AC_HEAD }]
//   GET  /api/drnote/invoices/:custCode      -> [{ DOC_TYPE, DOC_NO, DOC_DATE, NAR, DR_AMT, CR_AMT }]
//   GET  /api/drnote/:vchrNo                 -> { hdr: {...} }
//   POST /api/save-drnote                    -> { message, VCHR_NO }
//
// Table names are lower case throughout — the VPS runs
// lower_case_table_names=0, so DRNOTE_HDR fails there.

const express = require("express");

// ---------------------------------------------------------------------------
// CONFIG — confirm against the Oracle system before going live
// ---------------------------------------------------------------------------
const TRAN_TYPE = "10";                 // tran_acc.TRAN_TYPE for debit notes
const VAT_AC = "142-004-0-001";         // GL account the VAT part is posted to
const DIV_CODE = "01";
const DOC_PREFIX = "DR";
const DOC_WIDTH = 8;                    // DR + 8 digits = 10 chars (VCHR_NO is varchar(10))
const INVOICE_TRAN_TYPES = ["06"];      // sales invoice tran types, for the Inv.No LOV
// ---------------------------------------------------------------------------

module.exports = function (connection) {
  const router = express.Router();
  const db = connection.promise();

  const pad = (n) => DOC_PREFIX + String(n).padStart(DOC_WIDTH, "0");

  async function nextVchrNo(conn) {
    const [rows] = await conn.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(VCHR_NO, ?) AS UNSIGNED)), 0) AS maxNo
         FROM drnote_hdr
        WHERE VCHR_NO LIKE ?`,
      [DOC_PREFIX.length + 1, DOC_PREFIX + "%"]
    );
    return pad(Number(rows[0].maxNo) + 1);
  }

  // drnote_hdr has no INV_NO column yet. Rather than fail, the column is
  // looked up once and used only if it is there, so:
  //    ALTER TABLE drnote_hdr ADD COLUMN INV_NO varchar(20) AFTER VCHR_DATE;
  // starts storing the invoice number with no code change.
  let invNoColumn = null;
  async function hasInvNoColumn(conn) {
    if (invNoColumn !== null) return invNoColumn;
    const [rows] = await conn.query(
      `SELECT COUNT(*) AS c
         FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'drnote_hdr'
          AND column_name = 'INV_NO'`
    );
    invNoColumn = Number(rows[0].c) > 0;
    return invNoColumn;
  }

  // =========================================================================
  // GET /api/drnote/next-no
  // =========================================================================
  router.get("/drnote/next-no", async (req, res) => {
    try {
      res.json({ nextNo: await nextVchrNo(db) });
    } catch (err) {
      console.error("drnote/next-no:", err);
      res.status(500).json({ message: "Could not generate the next debit note number" });
    }
  });

  // =========================================================================
  // GET /api/drnote/acc/:acCode
  // =========================================================================
  router.get("/drnote/acc/:acCode", async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT ac_code AS AC_CODE, ac_head AS AC_HEAD FROM ac_list WHERE ac_code = ?`,
        [req.params.acCode]
      );
      res.json(rows);
    } catch (err) {
      console.error("drnote/acc:", err);
      res.status(500).json({ message: "Could not read the account" });
    }
  });

  // =========================================================================
  // GET /api/drnote/invoices/:custCode   (feeds the Inv.No LOV)
  // Invoices are the debit entries of that customer in tran_acc. If the
  // tran type filter finds nothing, every debit document of the customer is
  // returned instead, so the LOV is never silently empty.
  // =========================================================================
  router.get("/drnote/invoices/:custCode", async (req, res) => {
    const select = `
      SELECT t.TRAN_TYPE AS DOC_TYPE,
             t.vchr_no    AS DOC_NO,
             DATE_FORMAT(t.DATTE, '%d/%m/%Y') AS DOC_DATE,
             t.NARRATION1 AS NAR,
             t.AMOUNT     AS DR_AMT,                 -- invoice value  (Inv.Amount in the LOV)
             COALESCE(t.AMT_SETTLED, 0) AS CR_AMT    -- already settled (Settled in the LOV)
        FROM tran_acc t
       WHERE t.ACC_CODE = ? AND t.DB_CR = 'D'`;

    try {
      const { custCode } = req.params;
      const [rows] = await db.query(
        `${select} AND t.TRAN_TYPE IN (?) ORDER BY t.DATTE DESC, t.vchr_no DESC LIMIT 500`,
        [custCode, INVOICE_TRAN_TYPES]
      );
      if (rows.length) return res.json(rows);

      const [all] = await db.query(
        `${select} ORDER BY t.DATTE DESC, t.vchr_no DESC LIMIT 500`,
        [custCode]
      );
      res.json(all);
    } catch (err) {
      console.error("drnote/invoices:", err);
      res.status(500).json({ message: "Could not list the invoices of this customer" });
    }
  });

  // =========================================================================
  // GET /api/drnote/:vchrNo
  // =========================================================================
  router.get("/drnote/:vchrNo", async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT h.*,
                DATE_FORMAT(h.VCHR_DATE, '%d/%m/%Y') AS VCHR_DATE_FMT,
                c.cust_name AS CUST_NAME,
                a.ac_head   AS ACC_HEAD,
                s.SMAN_NAME
           FROM drnote_hdr h
           LEFT JOIN cus_mst  c ON c.cust_code = h.CUST_CODE
           LEFT JOIN ac_list  a ON a.ac_code   = h.CREDIT_AC
           LEFT JOIN sman_mst s ON s.sman_code = h.SMAN_CODE
          WHERE h.VCHR_NO = ?`,
        [req.params.vchrNo]
      );

      if (!rows.length) {
        return res.status(404).json({ message: `Debit note ${req.params.vchrNo} not found` });
      }

      const row = rows[0];
      const hdr = { ...row, VCHR_DATE: row.VCHR_DATE_FMT };
      delete hdr.VCHR_DATE_FMT;
      res.json({ hdr });
    } catch (err) {
      console.error("drnote/:vchrNo:", err);
      res.status(500).json({ message: "Could not load the debit note" });
    }
  });

  // =========================================================================
  // POST /api/save-drnote
  // body: { pageMode, hdr: { VCHR_NO, VCHR_DATE (yyyy-MM-dd), CUST_CODE,
  //         CREDIT_AC, NARRATION, AMOUNT, VAT_AMT, SMAN_CODE, INV_NO } }
  // Header + GL postings in one transaction.
  // =========================================================================
  router.post("/save-drnote", async (req, res) => {
    const conn = await connection.promise().getConnection();
    try {
      const { pageMode = "ADD", hdr = {} } = req.body || {};

      if (!hdr.CUST_CODE) return res.status(400).json({ message: "Customer code is required" });
      if (!hdr.VCHR_DATE) return res.status(400).json({ message: "Debit note date is required" });

      const amount = Number(hdr.AMOUNT) || 0;
      const vatAmt = Number(hdr.VAT_AMT) || 0;
      const total = amount + vatAmt;

      await conn.beginTransaction();

      const vchrNo = pageMode === "ADD" ? await nextVchrNo(conn) : hdr.VCHR_NO;
      if (!vchrNo) throw new Error("Debit note number missing");

      // ----- header ---------------------------------------------------------
      const cols = ["VCHR_NO", "VCHR_DATE", "CUST_CODE", "CREDIT_AC", "NARRATION",
        "AMOUNT", "VAT_AMT", "SMAN_CODE"];
      const vals = [vchrNo, hdr.VCHR_DATE, hdr.CUST_CODE, hdr.CREDIT_AC || null,
        hdr.NARRATION || null, amount, vatAmt, hdr.SMAN_CODE || null];

      if (await hasInvNoColumn(conn)) {
        cols.push("INV_NO");
        vals.push(hdr.INV_NO || null);
      }

      const updates = cols
        .filter((c) => c !== "VCHR_NO")
        .map((c) => `${c} = VALUES(${c})`)
        .join(", ");

      await conn.query(
        `INSERT INTO drnote_hdr (${cols.join(", ")})
         VALUES (${cols.map(() => "?").join(", ")})
         ON DUPLICATE KEY UPDATE ${updates}`,
        vals
      );

      // ----- G/L postings ---------------------------------------------------
      const [sr] = await conn.query(
        `SELECT COALESCE(MAX(MAIN_SR_NO), 0) + 1 AS nextSr FROM tran_acc WHERE TRAN_TYPE = ?`,
        [TRAN_TYPE]
      );
      const mainSrNo = Number(sr[0].nextSr);

      await conn.query(`DELETE FROM tran_acc WHERE TRAN_TYPE = ? AND vchr_no = ?`, [
        TRAN_TYPE,
        vchrNo,
      ]);

      const narration = hdr.NARRATION || `Debit Note ${vchrNo}`;
      const glLines = [
        // Dr the customer with the full value of the note
        [TRAN_TYPE, vchrNo, hdr.VCHR_DATE, hdr.CUST_CODE, total, "D", narration, 1, mainSrNo, DIV_CODE],
        // Cr the income / recovery account
        [TRAN_TYPE, vchrNo, hdr.VCHR_DATE, hdr.CREDIT_AC, amount, "C", narration, 2, mainSrNo, DIV_CODE],
      ];
      if (vatAmt > 0) {
        glLines.push([TRAN_TYPE, vchrNo, hdr.VCHR_DATE, VAT_AC, vatAmt, "C", narration, 3, mainSrNo, DIV_CODE]);
      }

      await conn.query(
        `INSERT INTO tran_acc
           (TRAN_TYPE, vchr_no, DATTE, ACC_CODE, AMOUNT, DB_CR,
            NARRATION1, SR_NO, MAIN_SR_NO, DIV_CODE)
         VALUES ?`,
        [glLines]
      );

      await conn.commit();
      res.json({ message: `Debit note ${vchrNo} saved`, VCHR_NO: vchrNo });
    } catch (err) {
      await conn.rollback();
      console.error("save-drnote:", err);
      res.status(500).json({ message: `Could not save the debit note: ${err.message}` });
    } finally {
      conn.release();
    }
  });

  return router;
};
