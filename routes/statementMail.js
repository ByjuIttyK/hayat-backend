// E:\hayatApi\routes\statementMail.js
// Sends one statement PDF. Nothing else — the run's status is recorded
// through the existing PATCH /stmt-run/:runId/status endpoint, so this
// route needs no table names and no schema changes.
//
//   npm i nodemailer
//   app.use("/api", require("./routes/statementMail")(connection));

const express = require("express");
const nodemailer = require("nodemailer");

const MAX_PDF_BYTES = 8 * 1024 * 1024;

module.exports = function (connection) {
  const router = express.Router();

  let transporter = null;
  const getTransporter = () => {
    if (transporter) return transporter;
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: String(process.env.SMTP_SECURE || "true") === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      pool: true,
      maxConnections: 1,
      maxMessages: 50,
    });
    return transporter;
  };

  const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());

  const ddmmyyyy = (iso) => {
    if (!iso) return "";
    const [y, m, d] = String(iso).slice(0, 10).split("-");
    return y && m && d ? `${d}/${m}/${y}` : String(iso);
  };

  const money = (n) =>
    n === null || n === undefined || isNaN(Number(n))
      ? ""
      : Number(n).toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });

  const body = ({ custName, asOnDate, outstanding }) => `
<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2733;line-height:1.6">
  <p>Dear Sir / Madam,</p>
  <p>Please find attached your statement of account with
     <strong>Al Hayat Elect. Switchgear Ind. LLC</strong>
     as on <strong>${ddmmyyyy(asOnDate)}</strong>.</p>
  ${
    outstanding !== null && outstanding !== undefined && outstanding !== ""
      ? `<p>Balance as per our books: <strong>AED ${money(outstanding)}</strong>.</p>`
      : ""
  }
  <p>Kindly review the statement and arrange settlement of the overdue items.
     If any entry does not agree with your records, write back to this address
     and we will reconcile it with you.</p>
  <p style="margin-top:18px">Regards,<br/>Accounts Department<br/>
     <span style="color:#1f3f6e;font-weight:bold">Al Hayat Elect. Switchgear Ind. LLC</span></p>
</div>`.trim();

  // ---- POST /api/statement/send ------------------------------------
  router.post("/statement/send", async (req, res) => {
    const { custCode, custName, to, asOnDate, outstanding, fileName, pdfBase64, cc } =
      req.body || {};

    if (!custCode || !pdfBase64) {
      return res.status(400).json({ ok: false, error: "custCode and pdfBase64 are required" });
    }
    if (!isEmail(to)) {
      return res.status(400).json({ ok: false, error: `Invalid email address: ${to}` });
    }

    const clean = String(pdfBase64).replace(/^data:application\/pdf;base64,/, "");
    if (Buffer.byteLength(clean, "base64") > MAX_PDF_BYTES) {
      return res.status(413).json({ ok: false, error: "Statement PDF is too large to email" });
    }

    try {
      const info = await getTransporter().sendMail({
        from: `"${process.env.MAIL_FROM_NAME || "Accounts"}" <${process.env.SMTP_USER}>`,
        to: String(to).trim(),
        cc: cc || undefined,
        bcc: process.env.MAIL_BCC || undefined,
        replyTo: process.env.MAIL_REPLY_TO || process.env.SMTP_USER,
        subject: `Statement of Account as on ${ddmmyyyy(asOnDate)} — ${custName || custCode}`,
        html: body({ custName, asOnDate, outstanding }),
        attachments: [
          {
            filename: fileName || `SOA_${custCode}_${asOnDate}.pdf`,
            content: clean,
            encoding: "base64",
            contentType: "application/pdf",
          },
        ],
      });
      return res.json({ ok: true, messageId: info.messageId, sentAt: new Date().toISOString() });
    } catch (err) {
      console.error("[statementMail]", custCode, err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ---- GET /api/statement/mail-test --------------------------------
  // Check the SMTP login before anyone runs a batch.
  router.get("/statement/mail-test", async (_req, res) => {
    try {
      await getTransporter().verify();
      res.json({ ok: true, host: process.env.SMTP_HOST, user: process.env.SMTP_USER });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
};
