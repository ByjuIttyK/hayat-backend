// routes/cusEinvLinkRoutes.js
// ─────────────────────────────────────────────────────────────────────────────
// Customer Update Links (CusEinvLinks.tsx)
// Sends each customer a personal link to the public e-Invoice update form.
// One cus_einv_update row per link (STATUS 'SENT', random TOKEN, expiry).
// Sending a new link to the same customer marks the previous unanswered
// link 'REPLACED', so only the newest link works.
//
//   GET  /api/cus-einv-links/list?scope=ACTIVE|ALL
//   GET  /api/cus-einv-links/preview/:custCode      → e-mail HTML (preview only)
//   POST /api/cus-einv-links/send  { items:[{custCode,email}], days, saveEmails }
//
// Register in HayatDb.js:
//   app.use(require("./routes/cusEinvLinkRoutes")(connection));
//
// .env
//   SMTP_HOST, SMTP_PORT, SMTP_SECURE (true/false), SMTP_USER, SMTP_PASS
//   EINV_MAIL_FROM        e.g. "Al Hayat Accounts <accounts@...>"  (default SMTP_USER)
//   EINV_FORM_URL         default https://hayaterp.cloud/einv-form
//   EINV_CONTACT_NAME     shown in the e-mail (default "Accounts Department")
//   EINV_CONTACT_EMAIL    shown in the e-mail and used as Reply-To
//   EINV_CONTACT_PHONE    shown in the e-mail
// If you already create a nodemailer transporter elsewhere (statement run),
// you can pass that one in instead: require(...)(connection, transporter)
// ─────────────────────────────────────────────────────────────────────────────
const express = require("express");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

const FORM_URL = (process.env.EINV_FORM_URL || "https://hayaterp.cloud/einv-form").replace(/\/+$/, "");
const TRN_RE = /^1[0-9A-Za-z]{12}03$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const pad = n => String(n).padStart(2, "0");
const dmy = d => (d instanceof Date && !isNaN(d) ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` : "");
const txt = v => (v === null || v === undefined ? "" : String(v).trim());
const esc = s => txt(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const who = req => {
    const u = req.user || {};
    return String(u.USER_NAME || u.username || u.userName || u.user || u.name || "WEB").slice(0, 30);
};

// What the customer master still lacks for an e-invoice
function missingOf(c) {
    const m = [];
    const scope = txt(c.EINV_SCOPE) || "Y";
    if (scope === "Y" && !TRN_RE.test(txt(c.VAT_REG_NO))) m.push("TRN");
    if (!txt(c.CUST_ADR1)) m.push("Address");
    if (!txt(c.CITY)) m.push("City");
    if ((txt(c.COUNTRY_ISO) || "AE").toUpperCase() === "AE" && !txt(c.EMIRATE_CODE)) m.push("Emirate");
    return m;
}

// ── E-mail ───────────────────────────────────────────────────────────────────
const SUBJECT = company => `Action Required: Update of Customer Details for UAE e-Invoicing – ${company}`;

function emailHtml({ company, custName, custCode, link, deadline, contactName, contactEmail, contactPhone }) {
    const contactLine = [esc(contactName || "Accounts Department"),
        contactEmail && `<a href="mailto:${esc(contactEmail)}" style="color:#1f5fa8">${esc(contactEmail)}</a>`,
        contactPhone && esc(contactPhone)].filter(Boolean).join(" &nbsp;|&nbsp; ");
    const li = t => `<tr><td style="padding:3px 0;font-size:14px;color:#1b2433">&#9642;&nbsp; ${t}</td></tr>`;
    return `<!doctype html><html><body style="margin:0;padding:0;background:#e9edf3;font-family:Arial,Helvetica,sans-serif;color:#1b2433">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#e9edf3;padding:20px 0"><tr><td align="center">
<table role="presentation" width="620" cellspacing="0" cellpadding="0" style="max-width:620px;width:100%;background:#ffffff;border:1px solid #d5dce8;border-radius:8px;overflow:hidden">
  <tr><td style="background:#163a66;padding:20px 28px;border-bottom:4px solid #e8892c">
    <div style="color:#ffffff;font-weight:bold;font-size:17px;letter-spacing:.3px">${esc(company).toUpperCase()}</div>
    <div style="color:#f0b429;font-size:12px;margin-top:3px">Finance Department &nbsp;·&nbsp; UAE e-Invoicing</div>
  </td></tr>
  <tr><td style="padding:26px 28px 8px;font-size:14px;line-height:1.65">
    <p style="margin:0 0 4px">Dear Valued Customer,</p>
    <p style="margin:0 0 16px"><strong>${esc(custName)}</strong> <span style="color:#5a6475">(Customer Code: ${esc(custCode)})</span></p>
    <p style="margin:0 0 14px">Greetings from ${esc(company)}.</p>
    <p style="margin:0 0 14px">As part of our commitment to regulatory compliance and in preparation for the UAE e-Invoicing
      framework, we are reviewing and updating our customer master records. Under the new framework, tax invoices will be
      exchanged electronically between our systems through accredited service providers and reported to the Federal Tax
      Authority. Accurate company details are therefore essential to ensure that your invoices continue to be issued and
      delivered without interruption.</p>
    <p style="margin:0 0 6px">We kindly request you to verify and update your company details using the secure link below,
      which has been created specifically for your company:</p>
    <p style="text-align:center;margin:20px 0 6px">
      <a href="${esc(link)}" style="display:inline-block;background:#1f5fa8;color:#ffffff;text-decoration:none;font-weight:bold;padding:13px 34px;border-radius:6px;font-size:15px">Update Company Details</a>
    </p>
    <p style="text-align:center;font-size:11.5px;color:#5a6475;word-break:break-all;margin:0 0 20px">${esc(link)}</p>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 16px"><tr>
      <td style="background:#eaf1fb;border-left:4px solid #1f5fa8;padding:12px 16px">
        <div style="font-weight:bold;font-size:14px;margin-bottom:4px">Please keep the following ready (approx. 3 minutes):</div>
        <table role="presentation" cellspacing="0" cellpadding="0">
          ${li("VAT Registration (TRN) Certificate")}
          ${li("Valid Trade Licence")}
          ${li("Name, e-mail and phone number of your accounts contact")}
        </table>
      </td></tr></table>

    <p style="margin:0 0 14px">Please complete all mandatory fields, upload the supporting documents and submit the form
      by <strong>${esc(deadline)}</strong>.</p>
    <p style="margin:0 0 14px"><strong>On submission, the confirmation page will display the information you provided,
      together with the e-invoicing details of ${esc(company)} (TRN and Peppol ID). Please save or print that page for your
      records, so that our company can be set up correctly in your system.</strong></p>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 16px"><tr>
      <td style="background:#fff4e6;border-left:4px solid #e8892c;padding:10px 16px;font-size:12.5px;color:#5a3204;line-height:1.55">
        <strong>Please note:</strong> this link is unique to your company and is valid until <strong>${esc(deadline)}</strong>.
        Kindly do not forward it outside your organisation. If the link has expired, simply reply to this e-mail and we will
        send you a new one.
      </td></tr></table>

    <p style="margin:0 0 4px">For any clarification or assistance in completing the form, please contact:</p>
    <p style="margin:0 0 16px">${contactLine}</p>
    <p style="margin:0 0 18px">Thank you in advance for your cooperation.</p>
    <p style="margin:0 0 22px;font-size:14px">Best regards,<br><strong>Finance Department</strong><br>${esc(company)}</p>
  </td></tr>
  <tr><td style="background:#f3f6fb;padding:12px 28px;font-size:11px;color:#5a6475;line-height:1.5">
    You are receiving this e-mail because you are a registered customer of ${esc(company)}.
    The information you provide is used only for issuing tax invoices in line with UAE e-invoicing regulations.
  </td></tr>
</table></td></tr></table></body></html>`;
}

module.exports = (connection, existingTransporter) => {
    const router = express.Router();
    const q = (sql, params = []) => new Promise((resolve, reject) =>
        connection.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
    const fail = (res, tag, err, code = 500) => {
        console.error(`[cus-einv-links/${tag}]`, err.sqlMessage || err.message || err);
        res.status(code).json({ error: err.sqlMessage || err.message || String(err) });
    };

    let transporter = existingTransporter || null;
    const getTransporter = () => {
        if (!transporter) {
            if (!process.env.SMTP_HOST) throw new Error("SMTP is not configured (SMTP_HOST missing in .env)");
            transporter = nodemailer.createTransport({
                host: process.env.SMTP_HOST,
                port: Number(process.env.SMTP_PORT || 587),
                secure: String(process.env.SMTP_SECURE || "false") === "true",
                auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
            });
        }
        return transporter;
    };

    const companyName = async () => {
        try {
            const [c] = await q("SELECT NAME FROM company LIMIT 1");
            return txt(c && c.NAME) || "Our company";
        } catch { return "Our company"; }
    };

    // ── Customer list with link status ───────────────────────────────────────
    router.get("/api/cus-einv-links/list", async (req, res) => {
        const scope = String(req.query.scope || "ACTIVE").toUpperCase();
        try {
            const rows = await q(`
                SELECT c.CUST_CODE, c.CUST_NAME, c.EMAIL, c.VAT_REG_NO, c.CUST_ADR1, c.CITY,
                       c.EMIRATE_CODE, c.COUNTRY_ISO, c.EINV_SCOPE,
                       inv.LAST_INV, u.STATUS AS LINK_STATUS, u.LINK_SENT_ON, u.LINK_EXPIRES,
                       u.EMAIL_SENT_TO, u.SUBMITTED_ON, u.REVIEW_NOTE, cnt.SENT_COUNT
                  FROM cus_mst c
                  ${scope === "ALL" ? "LEFT" : ""} JOIN (
                        SELECT CUST_CODE, MAX(INV_DATE) AS LAST_INV FROM fab_inv_hdr
                         WHERE INV_DATE >= DATE_SUB(CURDATE(), INTERVAL 2 YEAR)
                           AND IFNULL(INV_CANCELLED, 'N') <> 'Y'
                         GROUP BY CUST_CODE) inv ON inv.CUST_CODE = c.CUST_CODE
                  LEFT JOIN cus_einv_update u
                         ON u.srno_row_id = (SELECT MAX(u2.srno_row_id) FROM cus_einv_update u2
                                              WHERE u2.CUST_CODE = c.CUST_CODE AND u2.STATUS <> 'REPLACED')
                  LEFT JOIN (SELECT CUST_CODE, COUNT(*) AS SENT_COUNT FROM cus_einv_update GROUP BY CUST_CODE) cnt
                         ON cnt.CUST_CODE = c.CUST_CODE
                 ORDER BY c.CUST_NAME`);
            const now = new Date();
            res.json(rows.map(r => {
                let link = "NOT_SENT";
                if (r.LINK_STATUS === "SENT") link = r.LINK_EXPIRES && r.LINK_EXPIRES < now ? "EXPIRED" : "SENT";
                else if (r.LINK_STATUS) link = r.LINK_STATUS;   // SUBMITTED / APPROVED / REJECTED / FAILED
                return {
                    custCode: r.CUST_CODE, custName: txt(r.CUST_NAME), email: txt(r.EMAIL),
                    trn: txt(r.VAT_REG_NO), missing: missingOf(r), lastInv: dmy(r.LAST_INV),
                    link, linkSentOn: dmy(r.LINK_SENT_ON), linkExpires: dmy(r.LINK_EXPIRES),
                    emailSentTo: txt(r.EMAIL_SENT_TO), submittedOn: dmy(r.SUBMITTED_ON),
                    note: txt(r.REVIEW_NOTE), sentCount: Number(r.SENT_COUNT) || 0,
                };
            }));
        } catch (err) { fail(res, "list", err); }
    });

    // ── E-mail preview for one customer (no token is created) ────────────────
    router.get("/api/cus-einv-links/preview/:custCode", async (req, res) => {
        try {
            const [c] = await q("SELECT CUST_NAME FROM cus_mst WHERE CUST_CODE = ?", [req.params.custCode]);
            if (!c) return res.status(404).json({ error: "Customer not found" });
            const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
            const company = await companyName();
            res.json({
                subject: SUBJECT(company),
                html: emailHtml({
                    company, custName: txt(c.CUST_NAME), custCode: req.params.custCode,
                    link: `${FORM_URL}/your-personal-link-is-created-when-sent`, deadline: dmy(new Date(Date.now() + days * 86400000)),
                    contactName: process.env.EINV_CONTACT_NAME, contactEmail: process.env.EINV_CONTACT_EMAIL,
                    contactPhone: process.env.EINV_CONTACT_PHONE,
                }),
            });
        } catch (err) { fail(res, "preview", err); }
    });

    // ── Send links ───────────────────────────────────────────────────────────
    router.post("/api/cus-einv-links/send", async (req, res) => {
        const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
        const days = Math.min(Math.max(Number(req.body && req.body.days) || 30, 1), 90);
        const saveEmails = !(req.body && req.body.saveEmails === false);
        const user = who(req);
        if (!items.length) return res.status(400).json({ error: "No customers selected" });
        if (items.length > 300) return res.status(400).json({ error: "Send at most 300 at a time" });

        let mailer;
        try { mailer = getTransporter(); } catch (e) { return fail(res, "send", e, 500); }

        const company = await companyName();
        const from = process.env.EINV_MAIL_FROM || process.env.SMTP_USER;
        const results = [];

        for (const it of items) {
            const code = txt(it.custCode);
            const email = txt(it.email);
            const r = { custCode: code, ok: false, message: "" };
            results.push(r);
            try {
                if (!EMAIL_RE.test(email)) { r.message = "Invalid e-mail address"; continue; }
                const [c] = await q("SELECT CUST_NAME, EMAIL FROM cus_mst WHERE CUST_CODE = ?", [code]);
                if (!c) { r.message = "Customer not found"; continue; }
                const [pending] = await q(
                    `SELECT srno_row_id FROM cus_einv_update WHERE CUST_CODE = ? AND STATUS = 'SUBMITTED' LIMIT 1`, [code]);
                if (pending) { r.message = "Submission awaiting review - not resent"; continue; }

                // old unanswered links stop working
                await q(`UPDATE cus_einv_update SET STATUS = 'REPLACED', LAST_EDITED_BY = ?, LAST_EDITED_ON = NOW()
                          WHERE CUST_CODE = ? AND STATUS IN ('SENT','REJECTED','FAILED')`, [user, code]);

                const token = crypto.randomBytes(24).toString("hex");      // 48 characters
                const expires = new Date(Date.now() + days * 86400000);
                const ins = await q(`
                    INSERT INTO cus_einv_update
                           (CUST_CODE, TOKEN, STATUS, EMAIL_SENT_TO, LINK_SENT_ON, LINK_SENT_BY, LINK_EXPIRES, CREATED_BY)
                    VALUES (?, ?, 'SENT', ?, NOW(), ?, ?, ?)`,
                    [code, token, email, user, expires, user]);

                try {
                    await mailer.sendMail({
                        from, to: email,
                        replyTo: process.env.EINV_CONTACT_EMAIL || undefined,
                        subject: SUBJECT(company),
                        html: emailHtml({
                            company, custName: txt(c.CUST_NAME), custCode: code, link: `${FORM_URL}/${token}`,
                            deadline: dmy(expires), contactName: process.env.EINV_CONTACT_NAME,
                            contactEmail: process.env.EINV_CONTACT_EMAIL, contactPhone: process.env.EINV_CONTACT_PHONE,
                        }),
                    });
                } catch (mailErr) {
                    await q(`UPDATE cus_einv_update SET STATUS = 'FAILED', REVIEW_NOTE = ? WHERE srno_row_id = ?`,
                        [("Mail failed: " + (mailErr.message || mailErr)).slice(0, 500), ins.insertId]);
                    r.message = "Mail failed: " + (mailErr.message || mailErr);
                    continue;
                }

                if (saveEmails && email.toLowerCase() !== txt(c.EMAIL).toLowerCase() && email.length <= 60) {
                    await q(`UPDATE cus_mst SET EMAIL = ?, LAST_EDITED_BY = ?, LAST_EDITED_ON = NOW() WHERE CUST_CODE = ?`,
                        [email, user, code]);
                }
                r.ok = true;
                r.message = "Sent";
                await sleep(300);          // be gentle with the mail server
            } catch (err) {
                console.error("[cus-einv-links/send]", code, err.sqlMessage || err.message);
                r.message = err.sqlMessage || err.message || String(err);
            }
        }

        res.json({
            sent: results.filter(r => r.ok).length,
            failed: results.filter(r => !r.ok).length,
            results,
        });
    });

    return router;
};
