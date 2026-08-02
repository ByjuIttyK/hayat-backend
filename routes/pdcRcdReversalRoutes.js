const express = require("express");

// Factory-pattern router — matches your existing convention:
// module.exports = function(connection) { ... }
module.exports = function (connection) {
  const router = express.Router();
  const TRAN_TYPE = "24"; // PDC Received Reversal, per spec

  // ---------------------------------------------------------------------
  // GET /api/pdc-rcd-reversal/pending?asOnDate=YYYY-MM-DD
  // All pdc_rcd rows with REALISED='N' and chq date on/before asOnDate
  // ---------------------------------------------------------------------
  router.get("/pending", async (req, res) => {
    const { asOnDate } = req.query;
    if (!asOnDate) {
      return res.status(400).json({ message: "asOnDate is required" });
    }
    try {
      // Column names confirmed against `desc pdc_rcd` / `desc tran_acc`:
      //   pdc_rcd:  CHQ_BANK (not BANK_CODE), CUST_CODE (not PARTY_CODE),
      //             JV_NO_RLZ / JV_DATE_RLZ (reversal JV, set on save)
      //   NOTE: pdc_rcd has NO primary key defined in the schema. The
      //   composite (TRAN_TYPE, VCHR_NO, CHQ_NO) — the original PDC receipt
      //   voucher plus the cheque number — uniquely identifies a row and is
      //   carried through end-to-end to target the exact row on save.
      // TODO: confirm acc_mst's description column name (assumed ACC_NAME).
      const [rows] = await connection.promise().query(
        `SELECT
           p.TRAN_TYPE,
           p.VCHR_NO,
           p.CHQ_NO,
           p.CHQ_DATE,
           p.PDC_CODE,
           a.ACC_HEAD AS PDC_HEAD,
           p.CHQ_BANK,
           b.BANK_NAME,
           p.AMOUNT,
           p.CUST_CODE,
           c.CUST_NAME AS PARTY
         FROM pdc_rcd p
         LEFT JOIN bank_mst b ON b.BANK_CODE = p.CHQ_BANK
         LEFT JOIN cus_mst c ON c.CUST_CODE = p.CUST_CODE
         LEFT JOIN acc_mst a ON a.ACC_CODE = p.PDC_CODE
         WHERE p.REALISED = 'N'
           AND p.CHQ_DATE <= ?
         ORDER BY p.CHQ_DATE ASC`,
        [asOnDate]
      );
      res.json(rows);
    } catch (err) {
      console.error("pdc-rcd-reversal/pending error:", err);
      res.status(500).json({ message: "Failed to fetch pending PDC receipts" });
    }
  });

  // ---------------------------------------------------------------------
  // GET /api/pdc-rcd-reversal/next-jv
  // Provisional next vchr_no for TRAN_TYPE='24' — display only.
  // Re-validated inside the transaction at /save time.
  // ---------------------------------------------------------------------
  router.get("/next-jv", async (req, res) => {
    try {
      // vchr_no is stored as varchar(10) but holds a purely numeric value
      // (e.g. "2026080001"), so MAX() needs a numeric cast or string
      // comparison would sort "9" above "10".
      const [rows] = await connection
        .promise()
        .query(
          `SELECT COALESCE(MAX(CAST(vchr_no AS UNSIGNED)), 0) + 1 AS nextVchrNo
           FROM tran_acc
           WHERE TRAN_TYPE = ?`,
          [TRAN_TYPE]
        );
      res.json({ nextVchrNo: rows[0].nextVchrNo });
    } catch (err) {
      console.error("pdc-rcd-reversal/next-jv error:", err);
      res.status(500).json({ message: "Failed to fetch next JV number" });
    }
  });

  // ---------------------------------------------------------------------
  // POST /api/pdc-rcd-reversal/save
  // body: { asOnDate, username, rows: [{ tranType, vchrNo, chqNo, pdcCode, pdcHead, custCode, amount }] }
  //
  // pdc_rcd has no defined primary key, so the composite
  // (TRAN_TYPE, VCHR_NO, CHQ_NO) — the original PDC receipt voucher plus
  // cheque number — is used to target the exact row on update.
  //
  // For each row, inside ONE transaction:
  //   1. Lock-safe compute of the real next vchr_no for the REVERSAL JV
  //      (re-checked here, not trusted from the client's provisional
  //      number) — vchr_no is varchar but numeric, so cast for MAX() to
  //      sort correctly.
  //   2. Insert reversal lines into tran_acc (no separate header table —
  //      each Dr/Cr leg is its own row sharing the same vchr_no):
  //        Dr  CUST_CODE (customer)   — reinstate the receivable
  //        Cr  PDC_CODE (PDC head)    — write off the PDC asset account
  //      TODO: confirm this Dr/Cr direction against your chart of accounts.
  //   3. Update pdc_rcd: REALISED='Y', JV_NO_RLZ=?, JV_DATE_RLZ=?
  // ---------------------------------------------------------------------
  router.post("/save", async (req, res) => {
    const { asOnDate, username, rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ message: "No rows to reverse" });
    }

    const conn = connection.promise();
    const printRows = []; // returned to the client for the JV printout

    try {
      await conn.query("START TRANSACTION");

      for (const row of rows) {
        // 1. Get a safe next vchr_no INSIDE the transaction for each row,
        //    so concurrent saves can't collide.
        const [vchrRows] = await conn.query(
          `SELECT COALESCE(MAX(CAST(vchr_no AS UNSIGNED)), 0) + 1 AS nextVchrNo
           FROM tran_acc
           WHERE TRAN_TYPE = ?
           FOR UPDATE`,
          [TRAN_TYPE]
        );
        const newVchrNo = String(vchrRows[0].nextVchrNo);

        // 2. Dr Customer (reinstate the receivable)
        await conn.query(
          `INSERT INTO tran_acc
             (TRAN_TYPE, vchr_no, DATTE, ACC_CODE, AMOUNT, DB_CR,
              NARRATION1, NARRATION2, USERNAME, SR_NO, TRANS_DATE, REF_NO)
           VALUES (?, ?, ?, ?, ?, 'D', ?, ?, ?, ?, ?, ?)`,
          [
            TRAN_TYPE,
            newVchrNo,
            asOnDate,
            row.custCode,
            row.amount,
            `PDC Reversal - Chq No ${row.chqNo}`,
            row.pdcHead || "",
            username || null,
            "1",
            asOnDate,
            row.chqNo,
          ]
        );

        // 3. Cr PDC Head (write off the PDC asset account)
        await conn.query(
          `INSERT INTO tran_acc
             (TRAN_TYPE, vchr_no, DATTE, ACC_CODE, AMOUNT, DB_CR,
              NARRATION1, NARRATION2, USERNAME, SR_NO, TRANS_DATE, REF_NO)
           VALUES (?, ?, ?, ?, ?, 'C', ?, ?, ?, ?, ?, ?)`,
          [
            TRAN_TYPE,
            newVchrNo,
            asOnDate,
            row.pdcCode,
            row.amount,
            `PDC Reversal - Chq No ${row.chqNo}`,
            row.custCode || "",
            username || null,
            "2",
            asOnDate,
            row.chqNo,
          ]
        );

        // 4. Mark pdc_rcd as reversed with the final JV no/date.
        //    (TRAN_TYPE, VCHR_NO, CHQ_NO) of the ORIGINAL PDC receipt
        //    entry targets the exact row, since pdc_rcd has no PK.
        await conn.query(
          `UPDATE pdc_rcd
           SET REALISED = 'Y', JV_NO_RLZ = ?, JV_DATE_RLZ = ?
           WHERE TRAN_TYPE = ? AND VCHR_NO = ? AND CHQ_NO = ? AND REALISED = 'N'`,
          [newVchrNo, asOnDate, row.tranType, row.vchrNo, row.chqNo]
        );

        // 5. Grab the party name for the printout (read-only, kept out of
        //    the insert path above)
        const [partyRows] = await conn.query(
          `SELECT CUST_NAME FROM cus_mst WHERE CUST_CODE = ?`,
          [row.custCode]
        );

        printRows.push({
          vchrNo: newVchrNo,
          jvDate: asOnDate,
          chqNo: row.chqNo,
          partyCode: row.custCode,
          partyName: partyRows[0]?.CUST_NAME || row.custCode,
          pdcHead: row.pdcCode,
          amount: row.amount,
        });
      }

      await conn.query("COMMIT");
      res.json({ message: "Reversal saved successfully", vouchers: printRows });
    } catch (err) {
      await conn.query("ROLLBACK");
      console.error("pdc-rcd-reversal/save error:", err);
      res.status(500).json({ message: "Failed to save reversal" });
    }
  });

  return router;
};
