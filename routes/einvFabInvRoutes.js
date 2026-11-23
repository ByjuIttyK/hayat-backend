// routes/einvFabInvRoutes.js
// ─────────────────────────────────────────────────────────────────────────────
// e-Invoice for Fabrication Invoices (EinvFabInvoice.tsx trial screen and the
// reusable EinvPanel). Maps fab_inv_hdr / fab_inv_dtl / cus_mst / einv_config
// to the standard invoice shape and uses einv/einvCore.js to build and check
// the ASP payload. "Send" queues the invoice in einv_queue (status PENDING);
// the e-invoice bridge picks it up once the ASP connection is live.
//
//   GET  /api/einv-fab/list?q=text            → recent invoices with e-invoice status
//   GET  /api/einv-fab/doc/:invNo             → invoice, lines, checks, e-invoice totals
//   GET  /api/einv-fab/doc/:invNo/payload     → the JSON that will go to the ASP
//   POST /api/einv-fab/doc/:invNo/options     { tranType, payMeans, note }
//   POST /api/einv-fab/doc/:invNo/hs          { lines: [{ srNo, hs }] }
//   POST /api/einv-fab/doc/:invNo/send
//
// Register in HayatDb.js:
//   app.use(require("./routes/einvFabInvRoutes")(connection));
// ─────────────────────────────────────────────────────────────────────────────
const express = require("express");
const { buildPayload, precheck, r2 } = require("./einv/einvCore");

const DOC_TYPE = "FABINV";
const LOCKED = ["PENDING", "SENT", "DELIVERED"];
const TRAN_TYPES = { "00000000": "Standard invoice", "00000001": "Export", "10000000": "Free zone" };
const PAY_MEANS = { "30": "Bank transfer", "20": "Cheque", "10": "Cash", "1": "Not defined" };

const txt = v => (v === null || v === undefined ? "" : String(v).trim());
const num = v => Number(v) || 0;
const pad = n => String(n).padStart(2, "0");
const dmy = d => (d instanceof Date && !isNaN(d) ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` : "");
const dmyhm = d => (d instanceof Date && !isNaN(d) ? `${dmy(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}` : "");
const who = req => {
    const u = req.user || {};
    return String(u.USER_NAME || u.username || u.userName || u.user || u.name || "WEB").slice(0, 30);
};

module.exports = (connection) => {
    const router = express.Router();
    const q = (sql, p = []) => new Promise((ok, ko) => connection.query(sql, p, (e, r) => (e ? ko(e) : ok(r))));
    const fail = (res, tag, err, code = 500) => {
        console.error(`[einv-fab/${tag}]`, err.sqlMessage || err.message || err);
        res.status(err.http || code).json({ error: err.sqlMessage || err.message || String(err) });
    };

    // ── Load everything for one invoice and map it to the standard shape ────
    async function loadInvoice(invNo) {
        const [h] = await q(`
            SELECT h.*, c.CUST_NAME, c.VAT_REG_NO, c.TIN, c.PEPPOL_ID, c.EINV_SCOPE, c.CUST_ADR1, c.CUST_ADR2,
                   c.CITY, c.EMIRATE_CODE, c.COUNTRY_ISO, c.EMAIL AS CUST_EMAIL, c.LIC_TYPE, c.LIC_NO, c.LIC_AUTHORITY,
                   cm.ISO_CODE
              FROM fab_inv_hdr h
              LEFT JOIN cus_mst c ON c.CUST_CODE = h.CUST_CODE
              LEFT JOIN einv_curr_map cm ON cm.CURR_CODE = h.CURR_CODE
             WHERE h.INV_NO = ?`, [invNo]);
        if (!h) throw Object.assign(new Error(`Invoice ${invNo} not found`), { http: 404 });

        const dtl = await q(`
            SELECT d.SR_NO, d.MAIN_SR_NO, d.PANEL_NO, d.INV_ITEM_DESC, d.INV_QTY, d.INV_UNIT, d.INV_RATE,
                   d.VAT_PERC, d.DIS_COUNT, d.HS_CODE, u.UOM_CODE
              FROM fab_inv_dtl d
              LEFT JOIN einv_uom_map u ON u.ERP_UNIT = UPPER(TRIM(d.INV_UNIT))
             WHERE d.INV_NO = ?
             ORDER BY d.SR_NO`, [invNo]);

        const [cfg] = await q(`SELECT * FROM einv_config ORDER BY srno_row_id LIMIT 1`);
        const conf = cfg || {};
        const defHs = txt(conf.default_hs_code);

        // Lines with no quantity and no rate are description rows: their text is
        // added to the line above, so no zero-value line goes to the ASP.
        const std = [];
        const shown = dtl.map(d => {
            const qty = num(d.INV_QTY), rate = num(d.INV_RATE);
            const isText = !qty && !rate;
            const hsEff = txt(d.HS_CODE) || defHs;
            const uom = txt(d.UOM_CODE) || (txt(h.LUMPSUM) === "Y" && !txt(d.INV_UNIT) ? "LS" : "");
            const desc = txt(d.INV_ITEM_DESC);
            if (isText && std.length) {
                const last = std[std.length - 1];
                last.ITEM_DESC = `${last.ITEM_DESC}\n${desc}`.trim();
            } else if (!isText) {
                const vat = d.VAT_PERC !== null && d.VAT_PERC !== undefined ? num(d.VAT_PERC)
                          : h.VAT_PERC !== null && h.VAT_PERC !== undefined ? num(h.VAT_PERC) : 5;
                const name = (txt(d.PANEL_NO) ? `${txt(d.PANEL_NO)} - ` : "") + desc.split("\n")[0];
                std.push({
                    LINE_NO: d.SR_NO, ITEM_NAME: name, ITEM_DESC: desc, ITEM_TYPE: "G", HS_CODE: hsEff,
                    QTY: qty, UOM_CODE: uom, UNIT_PRICE: rate, LINE_DISCOUNT: num(d.DIS_COUNT),
                    VAT_CATEGORY: vat > 0 ? "S" : "Z", VAT_RATE: vat,
                });
            }
            return {
                srNo: d.SR_NO, panelNo: txt(d.PANEL_NO), desc, qty, unit: txt(d.INV_UNIT), uomCode: uom,
                rate, disc: num(d.DIS_COUNT), vatPerc: d.VAT_PERC === null ? null : num(d.VAT_PERC),
                hs: txt(d.HS_CODE), hsEff, isText, amount: r2(qty * rate - num(d.DIS_COUNT)),
            };
        });

        const due = h.INV_DATE instanceof Date ? new Date(h.INV_DATE.getTime() + num(h.CR_DAYS) * 86400000) : null;
        const stdHdr = {
            DOC_NO: h.INV_NO, DOC_DATE: h.INV_DATE, INVOICE_TYPE: "380",
            TRANSACTION_TYPE: txt(h.EINV_TRAN_TYPE) || "00000000",
            CURRENCY: txt(h.ISO_CODE) || (["", "01"].includes(txt(h.CURR_CODE)) ? "AED" : txt(h.CURR_CODE)),
            EXCH_RATE: num(h.CONVERT_RATE) || 1, DOC_DISCOUNT: num(h.DISCOUNT), DUE_DATE: due,
            PAY_MEANS: txt(h.EINV_PAY_MEANS) || txt(conf.default_pay_means) || "30",
            PO_REF: txt(h.LPO_NO), PROJECT_REF: txt(h.JOB_NO), DESPATCH_REF: txt(h.DO_NO), CONTRACT_REF: txt(h.QUOT_NO),
            NOTE: txt(h.EINV_NOTE) || txt(h.PROJECT_DETAIL),
            BUYER_NAME: txt(h.CASH_CUST_NAME) || txt(h.CUST_NAME), BUYER_TRN: txt(h.VAT_REG_NO), BUYER_TIN: txt(h.TIN),
            BUYER_PEPPOL_ID: txt(h.PEPPOL_ID), BUYER_SCOPE: txt(h.EINV_SCOPE) || "Y",
            BUYER_ADDR1: txt(h.CUST_ADR1), BUYER_ADDR2: txt(h.CUST_ADR2), BUYER_CITY: txt(h.CITY),
            BUYER_EMIRATE: txt(h.EMIRATE_CODE), BUYER_COUNTRY: txt(h.COUNTRY_ISO) || "AE", BUYER_EMAIL: txt(h.CUST_EMAIL),
            BUYER_LIC_TYPE: txt(h.LIC_TYPE), BUYER_LIC_NO: txt(h.LIC_NO), BUYER_LIC_AUTH: txt(h.LIC_AUTHORITY),
        };
        const seller = {
            name: txt(conf.seller_name), trn: txt(conf.seller_trn), tin: txt(conf.seller_tin), peppolId: txt(conf.peppol_id),
            licType: txt(conf.lic_type), licNo: txt(conf.lic_no), licAuthority: txt(conf.lic_authority),
            addressLine1: txt(conf.addr_line1), addressLine2: txt(conf.addr_line2), city: txt(conf.city),
            emirateCode: txt(conf.emirate_code), email: txt(conf.email), phone: txt(conf.phone),
            iban: txt(conf.bank_iban), ibanScheme: txt(conf.iban_scheme),
        };

        const payload = buildPayload(stdHdr, std, seller);
        const checks = precheck(payload, { total: h.NET_AMT, vat: h.VAT_AMOUNT });
        if (!cfg) checks.unshift({ ok: false, text: "e-Invoice company settings (einv_config) not entered" });
        if (txt(h.INV_CANCELLED) === "Y") checks.unshift({ ok: false, text: "Invoice is cancelled" });
        return { h, shown, stdHdr, payload, checks };
    }

    // ── Recent invoices ──────────────────────────────────────────────────────
    router.get("/api/einv-fab/list", async (req, res) => {
        const s = `%${txt(req.query.q)}%`;
        try {
            const rows = await q(`
                SELECT h.INV_NO, h.INV_DATE, h.CUST_CODE, IFNULL(NULLIF(TRIM(h.CASH_CUST_NAME), ''), c.CUST_NAME) AS CUST_NAME,
                       h.NET_AMT, h.EINV_STATUS
                  FROM fab_inv_hdr h
                  LEFT JOIN cus_mst c ON c.CUST_CODE = h.CUST_CODE
                 WHERE IFNULL(h.INV_CANCELLED, 'N') <> 'Y'
                   AND (? = '%%' OR h.INV_NO LIKE ? OR c.CUST_NAME LIKE ? OR h.CUST_CODE LIKE ? OR h.JOB_NO LIKE ?)
                 ORDER BY h.INV_DATE DESC, h.INV_NO DESC
                 LIMIT 300`, [s, s, s, s, s]);
            res.json(rows.map(r => ({
                invNo: r.INV_NO, invDate: dmy(r.INV_DATE), custCode: txt(r.CUST_CODE), custName: txt(r.CUST_NAME),
                netAmt: num(r.NET_AMT), status: txt(r.EINV_STATUS) || "NOT SENT",
            })));
        } catch (err) { fail(res, "list", err); }
    });

    // ── One invoice ──────────────────────────────────────────────────────────
    router.get("/api/einv-fab/doc/:invNo", async (req, res) => {
        try {
            const { h, shown, stdHdr, payload, checks } = await loadInvoice(req.params.invNo);
            const d = payload.invoiceDetail;
            res.json({
                hdr: {
                    invNo: h.INV_NO, invDate: dmy(h.INV_DATE), custCode: txt(h.CUST_CODE), custName: stdHdr.BUYER_NAME,
                    jobNo: txt(h.JOB_NO), quotNo: txt(h.QUOT_NO), lpoNo: txt(h.LPO_NO), lpoDate: dmy(h.LPO_DATE),
                    doNo: txt(h.DO_NO), doDate: dmy(h.DO_DATE), currency: stdHdr.CURRENCY, convRate: stdHdr.EXCH_RATE,
                    crDays: num(h.CR_DAYS), contractPct: h.CONTRACT_AMT_PERCENT === null ? null : num(h.CONTRACT_AMT_PERCENT),
                    paymentTerms: txt(h.PAYMENT_TERMS), projectDetail: txt(h.PROJECT_DETAIL),
                    discount: num(h.DISCOUNT), vatAmount: num(h.VAT_AMOUNT), netAmt: num(h.NET_AMT),
                    cancelled: txt(h.INV_CANCELLED) === "Y",
                },
                customer: {
                    trn: stdHdr.BUYER_TRN, tin: stdHdr.BUYER_TIN, city: stdHdr.BUYER_CITY,
                    emirate: stdHdr.BUYER_EMIRATE, scope: stdHdr.BUYER_SCOPE,
                },
                lines: shown,
                einv: {
                    status: txt(h.EINV_STATUS) || "NOT SENT", statusText: txt(h.EINV_STATUS_TEXT), id: txt(h.EINV_ID),
                    sentOn: dmyhm(h.EINV_SENT_ON), sentBy: txt(h.EINV_SENT_BY), locked: LOCKED.includes(txt(h.EINV_STATUS)),
                    tranType: stdHdr.TRANSACTION_TYPE, payMeans: stdHdr.PAY_MEANS, note: txt(h.EINV_NOTE),
                    noteDefault: txt(h.PROJECT_DETAIL),
                },
                totals: {
                    lines: d.sumOfInvoiceLineNetAmount, discount: d.suMofDocumentLevelallowances,
                    withoutVat: d.invoiceTotalAmountWithoutTax, vat: d.invoiceTotalTaxAmount, withVat: d.invoiceTotalAmountWithTax,
                    lineCount: payload.items.length,
                },
                checks, ready: checks.every(c => c.ok),
                tranTypes: TRAN_TYPES, payMeansList: PAY_MEANS,
            });
        } catch (err) { fail(res, "doc", err); }
    });

    router.get("/api/einv-fab/doc/:invNo/payload", async (req, res) => {
        try {
            const { payload, checks } = await loadInvoice(req.params.invNo);
            res.json({ payload, checks });
        } catch (err) { fail(res, "payload", err); }
    });

    const assertEditable = async invNo => {
        const [h] = await q(`SELECT EINV_STATUS FROM fab_inv_hdr WHERE INV_NO = ?`, [invNo]);
        if (!h) throw Object.assign(new Error("Invoice not found"), { http: 404 });
        if (LOCKED.includes(txt(h.EINV_STATUS))) throw Object.assign(new Error(`e-Invoice already ${txt(h.EINV_STATUS).toLowerCase()} - cannot change`), { http: 409 });
    };

    // ── Per-invoice choices ──────────────────────────────────────────────────
    router.post("/api/einv-fab/doc/:invNo/options", async (req, res) => {
        const b = req.body || {};
        const tran = txt(b.tranType), pay = txt(b.payMeans), note = txt(b.note).slice(0, 500);
        if (tran && !TRAN_TYPES[tran]) return res.status(400).json({ error: "Invalid transaction type" });
        if (pay && !PAY_MEANS[pay]) return res.status(400).json({ error: "Invalid payment method" });
        try {
            await assertEditable(req.params.invNo);
            await q(`UPDATE fab_inv_hdr SET EINV_TRAN_TYPE = ?, EINV_PAY_MEANS = ?, EINV_NOTE = ?,
                            LAST_EDITED_BY = ?, LAST_EDITED_ON = NOW() WHERE INV_NO = ?`,
                [tran || "00000000", pay || null, note || null, who(req), req.params.invNo]);
            res.json({ ok: true });
        } catch (err) { fail(res, "options", err); }
    });

    // ── HS codes per line (blank = company default) ──────────────────────────
    router.post("/api/einv-fab/doc/:invNo/hs", async (req, res) => {
        const lines = Array.isArray(req.body && req.body.lines) ? req.body.lines : [];
        const bad = lines.filter(l => txt(l.hs) && !/^\d{4,12}$/.test(txt(l.hs).replace(/\./g, "")));
        if (bad.length) return res.status(400).json({ error: `HS code must be 4-12 digits (line ${bad.map(l => l.srNo).join(", ")})` });
        try {
            await assertEditable(req.params.invNo);
            for (const l of lines) {
                await q(`UPDATE fab_inv_dtl SET HS_CODE = ? WHERE INV_NO = ? AND SR_NO = ?`,
                    [txt(l.hs).replace(/\./g, "") || null, req.params.invNo, l.srNo]);
            }
            res.json({ ok: true, updated: lines.length });
        } catch (err) { fail(res, "hs", err); }
    });

    // ── Send = queue for the bridge ──────────────────────────────────────────
    router.post("/api/einv-fab/doc/:invNo/send", async (req, res) => {
        const user = who(req);
        try {
            await assertEditable(req.params.invNo);
            const { checks } = await loadInvoice(req.params.invNo);
            const failed = checks.filter(c => !c.ok);
            if (failed.length) return res.status(400).json({ error: "Pre-check failed: " + failed.map(c => c.text).join("; ") });
            await q(`INSERT INTO einv_queue (DOC_TYPE, DOC_NO, STATUS, REQUESTED_BY) VALUES (?, ?, 'PENDING', ?)`,
                [DOC_TYPE, req.params.invNo, user]);
            await q(`UPDATE fab_inv_hdr SET EINV_STATUS = 'PENDING', EINV_STATUS_TEXT = 'Queued for sending',
                            EINV_SENT_ON = NOW(), EINV_SENT_BY = ? WHERE INV_NO = ?`, [user, req.params.invNo]);
            res.json({ ok: true });
        } catch (err) { fail(res, "send", err); }
    });

    return router;
};
