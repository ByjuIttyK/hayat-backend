// ---------------------------------------------------------------------------
// salesInquiryRoutes.js
//
// Backend for SalesInquiryEnt.tsx (called from InfoGrid.tsx, ADD/EDIT/DELETE).
// sales_inquiry's PK is INQ_NO (varchar(10)).
//
// Endpoints:
//   GET    /api/sales-inquiry               -> list all (for infoGrid's grid)
//   GET    /api/sales-inquiry/next-no        -> generate next INQ_NO
//   GET    /api/sales-inquiry/:inqNo         -> single row, with joined LOV
//                                                descriptions for display
//   POST   /api/sales-inquiry                -> create (ADD)
//   PUT    /api/sales-inquiry/:inqNo         -> update (EDIT)
//   DELETE /api/sales-inquiry/:inqNo         -> delete (DELETE)
//   POST   /api/sales-inquiry/upload         -> attachment upload (multipart)
//
// *** VERIFY BEFORE USE ***
// The LEFT JOINs below use the same LOV_CONFIG table/column guesses as
// lovRoutes.js (cus_mst, emp_mst, loc_mst, job_type_mst, reason_mst,
// compliance_mst, inq_status_mst) — fix both files together if any of
// those don't match your actual schema.
// ---------------------------------------------------------------------------

const path = require("path");
const fs = require("fs");

module.exports = function (connection) {
  const express = require("express");
  const router = express.Router();
  const db = connection.promise();

  // ---- multer setup for the attachment upload endpoint ---------------------
  // TODO: point UPLOAD_DIR at wherever your other upload screens
  // (AttachmentPanel etc.) already store files, for consistency.
  const UPLOAD_DIR = path.join(__dirname, "..", "uploads", "sales_inquiry");
  let multer;
  try {
    multer = require("multer");
  } catch {
    console.warn("[salesInquiryRoutes] 'multer' is not installed — run `npm install multer` for the upload endpoint to work.");
  }
  const upload = multer
    ? multer({
        storage: multer.diskStorage({
          destination: (req, file, cb) => {
            fs.mkdirSync(UPLOAD_DIR, { recursive: true });
            cb(null, UPLOAD_DIR);
          },
          filename: (req, file, cb) => {
            const inqNo = (req.body.inqNo || "unknown").replace(/[^a-zA-Z0-9_-]/g, "");
            const ext = path.extname(file.originalname);
            cb(null, `${inqNo}_${Date.now()}${ext}`);
          },
        }),
      })
    : null;

  const SELECT_WITH_LOVS = `
    SELECT
      si.*,
      cus.CUST_NAME,
      est.SMAN_NAME  AS ESTIMATE_BY_NAME,
      sman.SMAN_NAME AS SMAN_NAME,
      engg.SMAN_NAME AS ENGG_NAME,
      loc.LOC_NAME  AS SINQ_LOC_DESC,
      jt.INQ_TYPE_DESC AS JOB_TYPE_DESC,
      rsn.REGRET_REASON AS REASON_DESC,
      cmp.CMPL_NAME AS INQ_COMPLIANCE_DESC,
      stat.STAT_DESC AS SINQ_STAT_DESC
    FROM sales_inquiry si
    LEFT JOIN cus_mst cus       ON cus.CUST_CODE = si.CUST_CODE
    LEFT JOIN sman_mst est      ON est.SMAN_CODE = si.ESTIMATE_BY
    LEFT JOIN sman_mst sman     ON sman.SMAN_CODE = si.SMAN_CODE
    LEFT JOIN sman_mst engg     ON engg.SMAN_CODE = si.ENGG_CODE
    LEFT JOIN loc_mst loc       ON loc.LOC_CODE = si.SINQ_LOC
    LEFT JOIN inq_type_mst jt   ON jt.INQ_TYPE_CODE = si.JOB_TYPE_CODE
    LEFT JOIN salinq_regret_mst rsn ON rsn.REGRET_CODE = si.REASON_CODE
    LEFT JOIN sinq_compliance_mst cmp ON cmp.CMPL_CODE = si.INQ_COMPLIANCE
    LEFT JOIN sales_inquiry_status stat ON stat.STAT_CODE = si.SINQ_STAT
  `;

  // -------------------------------------------------------------------------
  // GET /api/sales-inquiry
  // -------------------------------------------------------------------------
  router.get("/sales-inquiry", async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT INQ_NO, INQ_DATE, INQ_TYPE, CUST_CODE, SUBJECT, SINQ_STAT, REGRET, QUOTE_NO, QUOTE_DATE
         FROM sales_inquiry ORDER BY INQ_DATE DESC, INQ_NO DESC`
      );
      res.json(rows);
    } catch (err) {
      console.error("[sales-inquiry] list failed:", err);
      res.status(500).json({ message: "Failed to fetch sales inquiries" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/sales-inquiry/next-no
  // Zero-padded 10-char sequential number, same pattern as nextQuotNo.
  // -------------------------------------------------------------------------
  router.get("/sales-inquiry/next-no", async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT (MAX(CAST(LEFT(INQ_NO, 10) AS UNSIGNED)) + 1) AS nextNo FROM sales_inquiry`
      );
      const nextNo = rows[0].nextNo || 1;
      res.json({ strNo: String(nextNo).padStart(10, "0"), maxValue: nextNo });
    } catch (err) {
      console.error("[sales-inquiry/next-no] failed:", err);
      res.status(500).json({ message: "Failed to generate next enquiry number" });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/sales-inquiry/upload
  // -------------------------------------------------------------------------
  router.post("/sales-inquiry/upload", (req, res, next) => {
    if (!upload) return res.status(500).json({ message: "multer not installed on server" });
    next();
  }, (req, res) => {
    upload.single("file")(req, res, (err) => {
      if (err) {
        console.error("[sales-inquiry/upload] failed:", err);
        return res.status(500).json({ message: "Upload failed" });
      }
      if (!req.file) return res.status(400).json({ message: "No file provided" });
      res.json({ fileName: req.file.filename });
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/sales-inquiry/:inqNo
  // -------------------------------------------------------------------------
  router.get("/sales-inquiry/:inqNo", async (req, res) => {
    try {
      const [rows] = await db.query(`${SELECT_WITH_LOVS} WHERE si.INQ_NO = ?`, [req.params.inqNo]);
      if (rows.length === 0) {
        return res.status(404).json({ message: "Sales inquiry not found" });
      }
      res.json(rows[0]);
    } catch (err) {
      console.error("[sales-inquiry/:inqNo] fetch failed:", err);
      res.status(500).json({ message: "Failed to fetch sales inquiry" });
    }
  });

  const FIELDS = [
    "INQ_NO", "INQ_DATE", "INQ_TYPE", "CUST_CODE", "SUBJECT", "ESTIMATE_BY",
    "QUOTE_NO", "QUOTE_DATE", "CLOSING_DATE", "REGRET", "REGRET_REASON",
    "CUST_REF_NO", "ENGG_CODE", "REASON_CODE", "SCOPE_OF_WORK", "OUR_REF",
    "SINQ_STAT", "SMAN_CODE", "INQ_COMPLIANCE", "INQ_RECEIVED_BY",
    "CLOSE_REASON", "SINQ_LOC", "SITE_VISITED_BY", "UPLOAD_FILE_NAME",
    "CUST_CONTACT_PER", "JOB_TYPE_CODE",
  ];
  const nullify = (v) => (v === "" || v === undefined ? null : v);

  // -------------------------------------------------------------------------
  // POST /api/sales-inquiry  (ADD)
  // -------------------------------------------------------------------------
  router.post("/sales-inquiry", async (req, res) => {
    const body = req.body || {};
    if (!body.INQ_NO) {
      return res.status(400).json({ message: "INQ_NO is required" });
    }
    if (!body.CUST_CODE) {
      return res.status(400).json({ message: "CUST_CODE is required" });
    }
    try {
      const [existing] = await db.query(`SELECT INQ_NO FROM sales_inquiry WHERE INQ_NO = ?`, [body.INQ_NO]);
      if (existing.length > 0) {
        return res.status(409).json({ message: `Enquiry No "${body.INQ_NO}" already exists` });
      }

      const cols = FIELDS.join(", ");
      const placeholders = FIELDS.map(() => "?").join(", ");
      const values = FIELDS.map((f) => nullify(body[f]));

      await db.query(
        `INSERT INTO sales_inquiry (${cols}) VALUES (${placeholders})`,
        values
      );
      res.status(201).json({ message: "Sales inquiry created", INQ_NO: body.INQ_NO });
    } catch (err) {
      console.error("[sales-inquiry] create failed:", err);
      res.status(500).json({ message: "Failed to create sales inquiry" });
    }
  });

  // -------------------------------------------------------------------------
  // PUT /api/sales-inquiry/:inqNo  (EDIT)
  // INQ_NO (the PK) is not changed by this route — URL param is authoritative.
  // -------------------------------------------------------------------------
  router.put("/sales-inquiry/:inqNo", async (req, res) => {
    const { inqNo } = req.params;
    const body = req.body || {};
    const updatableFields = FIELDS.filter((f) => f !== "INQ_NO");
    try {
      const setClause = updatableFields.map((f) => `${f} = ?`).join(", ");
      const values = updatableFields.map((f) => nullify(body[f]));
      values.push(inqNo);

      const [result] = await db.query(
        `UPDATE sales_inquiry SET ${setClause} WHERE INQ_NO = ?`,
        values
      );
      if (result.affectedRows === 0) {
        return res.status(404).json({ message: "Sales inquiry not found" });
      }
      res.json({ message: "Sales inquiry updated", INQ_NO: inqNo });
    } catch (err) {
      console.error("[sales-inquiry/:inqNo] update failed:", err);
      res.status(500).json({ message: "Failed to update sales inquiry" });
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /api/sales-inquiry/:inqNo  (DELETE)
  // -------------------------------------------------------------------------
  router.delete("/sales-inquiry/:inqNo", async (req, res) => {
    try {
      const [result] = await db.query(`DELETE FROM sales_inquiry WHERE INQ_NO = ?`, [req.params.inqNo]);
      if (result.affectedRows === 0) {
        return res.status(404).json({ message: "Sales inquiry not found" });
      }
      res.json({ message: "Sales inquiry deleted" });
    } catch (err) {
      console.error("[sales-inquiry/:inqNo] delete failed:", err);
      res.status(500).json({ message: "Failed to delete sales inquiry" });
    }
  });

  return router;
};
