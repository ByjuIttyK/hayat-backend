// routes/cusEinvReviewRoutes.js
// ─────────────────────────────────────────────────────────────────────────────
// Customer Update Review & Approval (CusEinvReview.tsx)
// Customers fill in their e-Invoice details through the public update form;
// each submission is a row in cus_einv_update. Accounts reviews it here and
// approves (selected fields copied into cus_mst) or rejects it.
//
//   GET  /api/cus-einv/summary          → counters for the top cards
//   GET  /api/cus-einv/list?status=X    → latest row per customer with status X
//   GET  /api/cus-einv/item/:id         → submission + current cus_mst values
//   GET  /api/cus-einv/item/:id/file/:kind   (kind = TRN | LIC) → uploaded file
//   POST /api/cus-einv/item/:id/approve { apply: { COL: value, ... }, note }
//   POST /api/cus-einv/item/:id/reject  { note }
//
// Register in HayatDb.js:
//   app.use(require("./routes/cusEinvReviewRoutes")(connection));
// Uploaded files folder: EINV_UPLOAD_DIR in .env (default ./uploads/einv)
// ─────────────────────────────────────────────────────────────────────────────
const express = require("express");
const path = require("path");
const fs = require("fs");

const UPLOAD_DIR = process.env.EINV_UPLOAD_DIR || path.join(__dirname, "..", "uploads", "einv");

// Submitted field → cus_mst column. `max` = cus_mst column width.
const FIELD_MAP = [
    { key: "LEGAL_NAME",     col: "CUST_NAME",          label: "Legal name",         max: 100 },
    { key: "VAT_REG_NO",     col: "VAT_REG_NO",         label: "TRN",                max: 20 },
    { key: "TIN",            col: "TIN",                label: "TIN",                max: 10 },
    { key: "LIC_NO",         col: "LIC_NO",             label: "Trade licence no.",  max: 50 },
    { key: "LIC_AUTHORITY",  col: "LIC_AUTHORITY",      label: "Licence issued by",  max: 150 },
    { key: "LIC_EXPIRY",     col: "CUS_LICENSE_EXPIRY", label: "Licence expiry",     max: 10, date: true },
    { key: "ADDR1",          col: "CUST_ADR1",          label: "Address line 1",     max: 40 },
    { key: "ADDR2",          col: "CUST_ADR2",          label: "Address line 2",     max: 80 },
    { key: "CITY",           col: "CITY",               label: "City",               max: 60 },
    { key: "EMIRATE_CODE",   col: "EMIRATE_CODE",       label: "Emirate",            max: 3 },
    { key: "COUNTRY_ISO",    col: "COUNTRY_ISO",        label: "Country code",       max: 2 },
    { key: "CONTACT_PERSON", col: "CONTACT_PR",         label: "Contact person",     max: 30 },
    { key: "CONTACT_EMAIL",  col: "EMAIL",              label: "Accounts e-mail",    max: 60 },
    { key: "CONTACT_PHONE",  col: "CUS_TEL1",           label: "Phone",              max: 20 },
];
const COLS = new Map(FIELD_MAP.map(f => [f.col, f]));
const EMIRATES = ["AUH", "DXB", "SHJ", "AJM", "UAQ", "RAK", "FUJ"];
const TRN_RE = /^1[0-9A-Za-z]{12}03$/;

// ── helpers ──────────────────────────────────────────────────────────────────
const pad = n => String(n).padStart(2, "0");
const ymd = d => (d instanceof Date && !isNaN(d) ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : "");
const dmy = d => (d instanceof Date && !isNaN(d) ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` : "");
const dmyhm = d => (d instanceof Date && !isNaN(d) ? `${dmy(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}` : "");
const txt = v => (v === null || v === undefined ? "" : v instanceof Date ? dmy(v) : String(v).trim());
const same = (a, b) => txt(a).toUpperCase() === txt(b).toUpperCase();

// dd/MM/yyyy or yyyy-MM-dd → yyyy-MM-dd ('' → null)
function toDbDate(v) {
    const s = txt(v);
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    return m ? `${m[3]}-${pad(m[2])}-${pad(m[1])}` : undefined;   // undefined = invalid
}

// Logged-in user from the JWT middleware, whatever the property is called
const who = req => {
    const u = req.user || {};
    return String(u.USER_NAME || u.username || u.userName || u.user || u.name || "WEB").slice(0, 30);
};

// Latest cus_einv_update row per customer
const LATEST = `
    SELECT u.* FROM cus_einv_update u
     WHERE u.srno_row_id = (SELECT MAX(u2.srno_row_id) FROM cus_einv_update u2 WHERE u2.CUST_CODE = u.CUST_CODE)`;

module.exports = (connection) => {
    const router = express.Router();
    const q = (sql, params = []) => new Promise((resolve, reject) =>
        connection.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
    const fail = (res, tag, err, code = 500) => {
        console.error(`[cus-einv/${tag}]`, err.sqlMessage || err.message || err);
        res.status(code).json({ error: err.sqlMessage || err.message || String(err) });
    };

    // ── Counters ─────────────────────────────────────────────────────────────
    router.get("/api/cus-einv/summary", async (req, res) => {
        try {
            const [c] = await q(`
                SELECT COUNT(*) AS sent,
                       SUM(STATUS = 'SUBMITTED') AS toReview,
                       SUM(STATUS = 'APPROVED')  AS approved,
                       SUM(STATUS = 'REJECTED')  AS rejected,
                       SUM(STATUS = 'SENT' AND (LINK_EXPIRES IS NULL OR LINK_EXPIRES >= NOW())) AS notReplied,
                       SUM(STATUS = 'SENT' AND LINK_EXPIRES < NOW()) AS expired
                  FROM (${LATEST}) x`);
            // Customers invoiced in the last 2 years whose master data is e-Invoice ready
            const [r] = await q(`
                SELECT COUNT(*) AS active,
                       SUM(TRIM(c.VAT_REG_NO) REGEXP '^1[0-9A-Za-z]{12}03$'
                           AND IFNULL(TRIM(c.CUST_ADR1), '') <> ''
                           AND IFNULL(TRIM(c.CITY), '') <> ''
                           AND IFNULL(c.EMIRATE_CODE, '') <> '') AS ready
                  FROM cus_mst c
                 WHERE c.CUST_CODE IN (SELECT DISTINCT CUST_CODE FROM fab_inv_hdr
                                        WHERE INV_DATE >= DATE_SUB(CURDATE(), INTERVAL 2 YEAR))`);
            const num = v => Number(v) || 0;
            res.json({
                sent: num(c.sent), toReview: num(c.toReview), approved: num(c.approved),
                rejected: num(c.rejected), notReplied: num(c.notReplied), expired: num(c.expired),
                activeCustomers: num(r.active), readyCustomers: num(r.ready),
            });
        } catch (err) { fail(res, "summary", err); }
    });

    // ── List (latest row per customer, by status) ────────────────────────────
    router.get("/api/cus-einv/list", async (req, res) => {
        const status = String(req.query.status || "SUBMITTED").toUpperCase();
        if (!["SENT", "SUBMITTED", "APPROVED", "REJECTED", "EXPIRED"].includes(status)) {
            return res.status(400).json({ error: "Invalid status" });
        }
        const where = status === "EXPIRED" ? "x.STATUS = 'SENT' AND x.LINK_EXPIRES < NOW()"
                    : status === "SENT" ? "x.STATUS = 'SENT' AND (x.LINK_EXPIRES IS NULL OR x.LINK_EXPIRES >= NOW())"
                    : "x.STATUS = ?";
        try {
            const rows = await q(`
                SELECT x.*, ${FIELD_MAP.map(f => `c.${f.col} AS CUR_${f.col}`).join(", ")}
                  FROM (${LATEST}) x
                  LEFT JOIN cus_mst c ON c.CUST_CODE = x.CUST_CODE
                 WHERE ${where}
                 ORDER BY IFNULL(x.SUBMITTED_ON, x.LINK_SENT_ON) DESC`,
                status === "EXPIRED" || status === "SENT" ? [] : [status]);
            res.json(rows.map(r => {
                const changed = r.STATUS === "SENT" ? 0
                    : FIELD_MAP.filter(f => txt(r[f.key]) && !same(r[f.key], r[`CUR_${f.col}`])).length;
                const trnDiffers = !!txt(r.VAT_REG_NO) && !!txt(r.CUR_VAT_REG_NO) && !same(r.VAT_REG_NO, r.CUR_VAT_REG_NO);
                return {
                    id: r.srno_row_id, custCode: r.CUST_CODE,
                    custName: txt(r.CUR_CUST_NAME) || txt(r.LEGAL_NAME),
                    status: r.STATUS, submittedOn: dmyhm(r.SUBMITTED_ON), linkSentOn: dmyhm(r.LINK_SENT_ON),
                    emailSentTo: txt(r.EMAIL_SENT_TO), changed, trnDiffers,
                };
            }));
        } catch (err) { fail(res, "list", err); }
    });

    // ── One submission with current master values ────────────────────────────
    router.get("/api/cus-einv/item/:id", async (req, res) => {
        try {
            const [u] = await q(`SELECT * FROM cus_einv_update WHERE srno_row_id = ?`, [req.params.id]);
            if (!u) return res.status(404).json({ error: "Submission not found" });
            const [c] = await q(`SELECT ${FIELD_MAP.map(f => f.col).join(", ")} FROM cus_mst WHERE CUST_CODE = ?`, [u.CUST_CODE]);
            const cur = c || {};
            res.json({
                id: u.srno_row_id, custCode: u.CUST_CODE, status: u.STATUS,
                custName: txt(cur.CUST_NAME), submittedOn: dmyhm(u.SUBMITTED_ON),
                contactPerson: txt(u.CONTACT_PERSON), linkSentOn: dmyhm(u.LINK_SENT_ON),
                reviewedBy: txt(u.REVIEWED_BY), reviewedOn: dmyhm(u.REVIEWED_ON), reviewNote: txt(u.REVIEW_NOTE),
                hasTrnFile: !!txt(u.TRN_FILE), hasLicFile: !!txt(u.LIC_FILE),
                fields: FIELD_MAP.map(f => ({
                    col: f.col, label: f.label, max: f.max, date: !!f.date,
                    current: f.date ? dmy(cur[f.col]) : txt(cur[f.col]),
                    submitted: f.date ? dmy(u[f.key]) : txt(u[f.key]),
                    changed: !!txt(u[f.key]) && !same(f.date ? dmy(u[f.key]) : u[f.key], f.date ? dmy(cur[f.col]) : cur[f.col]),
                })),
            });
        } catch (err) { fail(res, "item", err); }
    });

    // ── Uploaded document ────────────────────────────────────────────────────
    router.get("/api/cus-einv/item/:id/file/:kind", async (req, res) => {
        const col = { TRN: "TRN_FILE", LIC: "LIC_FILE" }[String(req.params.kind).toUpperCase()];
        if (!col) return res.status(400).json({ error: "kind must be TRN or LIC" });
        try {
            const [u] = await q(`SELECT ${col} AS F FROM cus_einv_update WHERE srno_row_id = ?`, [req.params.id]);
            const name = u && txt(u.F) ? path.basename(u.F) : "";        // never trust a path from the table
            const full = path.join(UPLOAD_DIR, name);
            if (!name || !fs.existsSync(full)) return res.status(404).json({ error: "File not found" });
            res.sendFile(full);
        } catch (err) { fail(res, "file", err); }
    });

    // ── Approve: copy the ticked fields into cus_mst ─────────────────────────
    router.post("/api/cus-einv/item/:id/approve", async (req, res) => {
        const apply = (req.body && req.body.apply) || {};
        const note = txt(req.body && req.body.note).slice(0, 500);
        const user = who(req);

        // validate
        const sets = {}, problems = [];
        for (const [col, raw] of Object.entries(apply)) {
            const f = COLS.get(col);
            if (!f) { problems.push(`Unknown field ${col}`); continue; }
            let v = txt(raw);
            if (f.date) {
                const d = toDbDate(v);
                if (d === undefined) { problems.push(`${f.label}: use dd/MM/yyyy`); continue; }
                sets[col] = d; continue;
            }
            if (col === "EMIRATE_CODE" || col === "COUNTRY_ISO") v = v.toUpperCase();
            if (v.length > f.max) problems.push(`${f.label} is ${v.length} characters (max ${f.max}) - shorten it`);
            if (col === "VAT_REG_NO" && v && !TRN_RE.test(v)) problems.push("TRN must be 15 characters, start with 1, end with 03");
            if (col === "EMIRATE_CODE" && v && !EMIRATES.includes(v)) problems.push("Emirate code is not valid");
            sets[col] = v;
        }
        if (problems.length) return res.status(400).json({ error: problems.join("; ") });

        connection.getConnection(async (err, conn) => {
            if (err) return fail(res, "approve", err);
            const cq = (sql, p = []) => new Promise((ok, ko) => conn.query(sql, p, (e, r) => (e ? ko(e) : ok(r))));
            try {
                await cq("START TRANSACTION");
                const [u] = await cq(`SELECT CUST_CODE, STATUS FROM cus_einv_update WHERE srno_row_id = ? FOR UPDATE`, [req.params.id]);
                if (!u) throw Object.assign(new Error("Submission not found"), { http: 404 });
                if (u.STATUS !== "SUBMITTED") throw Object.assign(new Error(`Already ${u.STATUS.toLowerCase()}`), { http: 409 });

                if (Object.keys(sets).length) {
                    const [c] = await cq(`SELECT TIN, PEPPOL_ID, LIC_TYPE FROM cus_mst WHERE CUST_CODE = ? FOR UPDATE`, [u.CUST_CODE]);
                    if (!c) throw Object.assign(new Error(`Customer ${u.CUST_CODE} not in cus_mst`), { http: 404 });
                    // Peppol ID follows a new TIN unless someone set it differently
                    if (sets.TIN && (!txt(c.PEPPOL_ID) || same(c.PEPPOL_ID, c.TIN))) sets.PEPPOL_ID = sets.TIN;
                    // Licence number given → licence type defaults to Trade licence
                    if (sets.LIC_NO && !txt(c.LIC_TYPE)) sets.LIC_TYPE = "TL";
                    const cols = Object.keys(sets);
                    await cq(`UPDATE cus_mst SET ${cols.map(k => `${k} = ?`).join(", ")},
                                     LAST_EDITED_BY = ?, LAST_EDITED_ON = NOW()
                               WHERE CUST_CODE = ?`,
                        [...cols.map(k => sets[k]), user, u.CUST_CODE]);
                }
                await cq(`UPDATE cus_einv_update
                             SET STATUS = 'APPROVED', REVIEWED_BY = ?, REVIEWED_ON = NOW(),
                                 REVIEW_NOTE = ?, APPLIED_FIELDS = ?,
                                 LAST_EDITED_BY = ?, LAST_EDITED_ON = NOW()
                           WHERE srno_row_id = ?`,
                    [user, note || null, Object.keys(apply).join(",").slice(0, 500) || null, user, req.params.id]);
                await cq("COMMIT");
                res.json({ ok: true, custCode: u.CUST_CODE, updated: Object.keys(sets) });
            } catch (e) {
                await cq("ROLLBACK").catch(() => {});
                fail(res, "approve", e, e.http || 500);
            } finally {
                conn.release();
            }
        });
    });

    // ── Reject ───────────────────────────────────────────────────────────────
    router.post("/api/cus-einv/item/:id/reject", async (req, res) => {
        const note = txt(req.body && req.body.note).slice(0, 500);
        if (!note) return res.status(400).json({ error: "Please enter the reason for rejecting" });
        const user = who(req);
        try {
            const r = await q(`
                UPDATE cus_einv_update
                   SET STATUS = 'REJECTED', REVIEWED_BY = ?, REVIEWED_ON = NOW(), REVIEW_NOTE = ?,
                       LAST_EDITED_BY = ?, LAST_EDITED_ON = NOW()
                 WHERE srno_row_id = ? AND STATUS = 'SUBMITTED'`,
                [user, note, user, req.params.id]);
            if (!r.affectedRows) return res.status(409).json({ error: "Only a submitted entry can be rejected" });
            res.json({ ok: true });
        } catch (err) { fail(res, "reject", err); }
    });

    return router;
};
