// routes/einv/einvCore.js
// ─────────────────────────────────────────────────────────────────────────────
// e-Invoice core: builds the ASP JSON from a STANDARD invoice object and
// checks it before sending. Knows nothing about MySQL - the caller maps its
// tables to the standard shape (same shape the Python bridge will use).
// Formulas: ASP "Validations and tax calculations V3.0".
//
//   hdr  : DOC_NO, DOC_DATE, INVOICE_TYPE, TRANSACTION_TYPE, CURRENCY, EXCH_RATE,
//          DOC_DISCOUNT, DUE_DATE, PAY_MEANS, PO_REF, PROJECT_REF, DESPATCH_REF,
//          CONTRACT_REF, NOTE, BUYER_NAME, BUYER_TRN, BUYER_TIN, BUYER_PEPPOL_ID,
//          BUYER_SCOPE, BUYER_ADDR1, BUYER_ADDR2, BUYER_CITY, BUYER_EMIRATE,
//          BUYER_COUNTRY, BUYER_EMAIL, BUYER_LIC_TYPE, BUYER_LIC_NO, BUYER_LIC_AUTH
//   lines: LINE_NO, ITEM_NAME, ITEM_DESC, ITEM_TYPE, HS_CODE, QTY, UOM_CODE,
//          UNIT_PRICE, LINE_DISCOUNT (amount), VAT_CATEGORY, VAT_RATE
//   seller: name, trn, tin, licType, licNo, licAuthority, addressLine1, addressLine2,
//          city, emirateCode, email, phone, iban, ibanScheme
// ─────────────────────────────────────────────────────────────────────────────
const TEMPLATE = require("./template.json");

const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const str = v => (v === null || v === undefined ? "" : String(v).trim());
const clone = o => JSON.parse(JSON.stringify(o));

function ymd(d) {
    if (!d) return null;
    if (typeof d === "string") return d.slice(0, 10);
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const PREDEFINED = { N: "9900000098", X: "9900000099" };   // not subject / export not on Peppol
const EMIRATES = ["AUH", "DXB", "SHJ", "AJM", "UAQ", "RAK", "FUJ"];
const TRN_RE = /^1[0-9A-Za-z]{12}03$/;
const TIN_RE = /^1\d{9}$/;

function buildPayload(hdr, lines, seller) {
    const p = clone(TEMPLATE);
    const itemTpl = p.itemTemplate, allowTpl = p.allowanceTemplate;
    delete p.itemTemplate; delete p.allowanceTemplate;

    const currency = str(hdr.CURRENCY) || "AED";
    const rate = currency === "AED" ? 1 : Number(hdr.EXCH_RATE) || 1;
    const scope = str(hdr.BUYER_SCOPE) || "Y";
    const tranType = scope === "X" ? "00000001" : (str(hdr.TRANSACTION_TYPE) || "00000000");
    const isExport = tranType === "00000001";

    Object.assign(p.invoice, {
        invoiceNumber: str(hdr.DOC_NO), invoiceIssueDate: ymd(hdr.DOC_DATE), invoiceIssueTime: null,
        invoiceTypeCode: str(hdr.INVOICE_TYPE) || "380", invoiceTransactionTypeCode: tranType,
        invoiceCurrencyCode: currency, currencyExchangeRate: rate, taxAccountingCurrency: "AED",
        contractReference: str(hdr.CONTRACT_REF), invoiceNote: str(hdr.NOTE).slice(0, 500),
        invoicingPeriodStartDate: null, invoicingPeriodEndDate: null, vatPointDate: null, precedingInvoices: [],
    });

    Object.assign(p.seller, {
        name: str(seller.name), legalRegistrationIdentifierType: str(seller.licType) || "TL",
        legalRegistrationIdentifier: str(seller.licNo), authorityName: str(seller.licAuthority),
        vatIdentifier: str(seller.trn), tin: str(seller.tin),
        electronicaddressScheme: "0235", electronicAddress: str(seller.peppolId) || str(seller.tin),
        addressLine1: str(seller.addressLine1), addressLine2: str(seller.addressLine2),
        emailId: str(seller.email), contactNumber: str(seller.phone),
        countryCode: "AE", countrySubDivision: str(seller.emirateCode), city: str(seller.city),
        uaeStateCodes: str(seller.emirateCode),
    });

    const country = (str(hdr.BUYER_COUNTRY) || "AE").toUpperCase();
    Object.assign(p.buyer, {
        buyerName: str(hdr.BUYER_NAME), tradingName: str(hdr.BUYER_NAME), type: "BuyerOnly",
        identifier: scope === "Y" ? str(hdr.BUYER_TIN) : "", buyerSchemeIdentifier: scope === "Y" ? "0235" : "",
        vatIdentifier: str(hdr.BUYER_TRN), tin: scope === "Y" ? str(hdr.BUYER_TIN) : "",
        legalRegistrationIdentifierType: str(hdr.BUYER_LIC_NO) ? (str(hdr.BUYER_LIC_TYPE) || "TL") : "",
        legalRegistrationIdentifier: str(hdr.BUYER_LIC_NO), authorityName: str(hdr.BUYER_LIC_NO) ? str(hdr.BUYER_LIC_AUTH) : "",
        electronicAddress: PREDEFINED[scope] || str(hdr.BUYER_PEPPOL_ID) || str(hdr.BUYER_TIN),
        electronicAddressSchemeIdentifier: "0235",
        addressLine1: str(hdr.BUYER_ADDR1), addressLine2: str(hdr.BUYER_ADDR2), city: str(hdr.BUYER_CITY),
        countryCode: country, countrySubdivision: country === "AE" ? str(hdr.BUYER_EMIRATE) : str(hdr.BUYER_CITY),
        uaeStateCodes: country === "AE" ? str(hdr.BUYER_EMIRATE) : "", emailID: str(hdr.BUYER_EMAIL),
    });

    const byCat = {};
    let sumNet = 0, sumVat = 0, docVatRate = 5;
    p.items = lines.map((ln, i) => {
        const it = clone(itemTpl);
        const qty = Number(ln.QTY) || 0, price = Number(ln.UNIT_PRICE) || 0, disc = r2(ln.LINE_DISCOUNT || 0);
        const cat = str(ln.VAT_CATEGORY) || "S";
        const vRate = cat === "S" ? Number(ln.VAT_RATE ?? 5) : 0;
        const net = r2(qty * price - disc), vat = r2(net * vRate / 100);
        if (cat === "S") docVatRate = vRate;
        sumNet += net; sumVat += vat; byCat[cat] = r2((byCat[cat] || 0) + net);
        const itemType = str(ln.ITEM_TYPE) || "G";
        Object.assign(it, {
            invoiceLineIdentifier: String(ln.LINE_NO ?? i + 1), itemType,
            itemClassificationSchemeIdentifier: itemType !== "S" ? "HS" : "",
            itemClassificationIdentifier: itemType !== "S" ? str(ln.HS_CODE) : "",
            serviceAccountingCode: itemType !== "G" ? str(ln.SAC_CODE) : "",
            itemName: str(ln.ITEM_NAME).slice(0, 100), itemDescription: str(ln.ITEM_DESC) || str(ln.ITEM_NAME),
            itemPriceBaseQuantity: 1, itemGrossPrice: price, itemPriceDiscount: 0, itemNetPrice: price,
            invoicedQuantity: qty, invoicedQuantityUnitOfMeasureCode: str(ln.UOM_CODE),
            invoiceLineChargeAmount: null, invoiceLineAllowanceAmount: disc > 0 ? disc : null,
            allowanceReasonCode: disc > 0 ? "95" : "",
            invoiceLineNetAmount: net, invoicedItemTaxCategoryCode: cat, invoicedItemTaxRate: vRate,
            vatLineAmount: vat, vatLineAmountInAED: r2(vat * rate), invoiceLineAmountInAED: r2((net + vat) * rate),
        });
        return it;
    });
    sumNet = r2(sumNet); sumVat = r2(sumVat);

    const docDisc = r2(hdr.DOC_DISCOUNT || 0), docDiscVat = r2(docDisc * docVatRate / 100);
    const docs = [];
    if (docDisc > 0) {
        const al = clone(allowTpl);
        Object.assign(al, {
            docComponentType: "Allowance", allowancesOnDocumentLevel: docDisc.toFixed(2), allowanceReasonCode: "95",
            documentLevelAllowanceVatCategory: "S", documentLevelAllowanceVatRate: docVatRate,
        });
        docs.push(al);
        byCat.S = r2((byCat.S || 0) - docDisc);
    }
    const totalNoTax = r2(sumNet - docDisc), totalTax = r2(sumVat - docDiscVat), totalWithTax = r2(totalNoTax + totalTax);
    Object.assign(p.invoiceDetail, {
        sumOfInvoiceLineNetAmount: sumNet, suMofDocumentLevelallowances: docDisc, suMofDocumentLevelcharges: 0,
        invoiceTotalAmountWithoutTax: totalNoTax, invoiceTotalTaxAmount: totalTax, invoiceTotalAmountWithTax: totalWithTax,
        paidAmount: null, roundingAmount: null, amountDueForPayment: totalWithTax,
        invoiceTotalTaxAmountInTaxAccountingCurrency: r2(totalTax * rate),
        taxableStandardRate: byCat.S || 0, taxableZeroRated: byCat.Z || 0, taxableExempt: byCat.E || 0,
        taxableNotSubject: byCat.O || 0, taxableReverseCharge: byCat.AE || 0,
        taxAmountStandardRate: byCat.S !== undefined ? totalTax : 0, invoiceDetailDocuments: docs,
    });

    if (isExport) {
        Object.assign(p.delivery, {
            deliverToPartyName: str(hdr.BUYER_NAME), deliverToAddressLine1: str(hdr.BUYER_ADDR1),
            deliverToCity: str(hdr.BUYER_CITY), deliverToCountrySubdivision: str(hdr.BUYER_CITY), deliverToCountryCode: country,
        });
    }
    const means = str(hdr.PAY_MEANS) || "30";
    Object.assign(p.payment, {
        paymentMeansTypeCode: means,
        paymentAccountIdentifier: means === "30" ? str(seller.iban) : "",
        schemeIdentifier: means === "30" ? (str(seller.ibanScheme) || "0235") : "",
        paymentDueDate: ymd(hdr.DUE_DATE) || ymd(hdr.DOC_DATE),
    });
    Object.assign(p.additionalDocumentDetails, {
        projectReference: str(hdr.PROJECT_REF), purchaseOrderReference: str(hdr.PO_REF).slice(0, 100),
        despatchAdviceReference: str(hdr.DESPATCH_REF).slice(0, 100), supportingDocuments: [],
    });
    return p;
}

// Returns [{ ok, text }] - every check, passed or not (the panel shows them all)
function precheck(payload, erp) {
    const out = [];
    const add = (ok, text) => out.push({ ok: !!ok, text });
    const s = payload.seller, b = payload.buyer, d = payload.invoiceDetail;

    add(TRN_RE.test(s.vatIdentifier) && TIN_RE.test(s.tin) && EMIRATES.includes(s.uaeStateCodes) && s.addressLine1,
        "Company e-Invoice settings complete (TRN, TIN, address, emirate)");
    add(!!b.buyerName && !!b.addressLine1 && !!b.city, "Customer name, address and city present");
    add(b.countryCode !== "AE" || EMIRATES.includes(b.uaeStateCodes), "Customer emirate valid");
    if (b.identifier) add(TRN_RE.test(b.vatIdentifier) && TIN_RE.test(b.tin), `Customer TRN / TIN valid (${b.vatIdentifier || "none"})`);
    else add(true, "Customer outside UAE e-invoicing network (fixed Peppol ID used)");
    add(payload.items.length > 0, "Invoice has lines");
    const noHs = payload.items.filter(i => i.itemType !== "S" && !i.itemClassificationIdentifier).map(i => i.invoiceLineIdentifier);
    add(!noHs.length, noHs.length ? `HS code missing on line ${noHs.join(", ")}` : "HS code on all lines");
    const noUom = payload.items.filter(i => !i.invoicedQuantityUnitOfMeasureCode).map(i => i.invoiceLineIdentifier);
    add(!noUom.length, noUom.length ? `Unit not mapped on line ${noUom.join(", ")} (add to einv_uom_map)` : "Units mapped");
    const zeroQty = payload.items.filter(i => !(i.invoicedQuantity > 0)).map(i => i.invoiceLineIdentifier);
    add(!zeroQty.length, zeroQty.length ? `Quantity is zero on line ${zeroQty.join(", ")}` : "Quantities valid");
    if (payload.payment.paymentMeansTypeCode === "30") add(!!payload.payment.paymentAccountIdentifier, "Bank IBAN set for bank transfer");
    if (erp && erp.total !== undefined && erp.total !== null) {
        const t = Number(erp.total);
        const ok = Math.abs(t - d.invoiceTotalAmountWithTax) <= 0.01 || Math.abs(t - d.invoiceTotalAmountWithoutTax) <= 0.01;
        add(ok, ok ? "Totals match the invoice"
            : `Invoice net ${t.toFixed(2)} ≠ e-Invoice total ${d.invoiceTotalAmountWithTax.toFixed(2)} (without VAT ${d.invoiceTotalAmountWithoutTax.toFixed(2)})`);
    }
    if (erp && erp.vat !== undefined && erp.vat !== null) {
        const ok = Math.abs(Number(erp.vat) - d.invoiceTotalTaxAmount) <= 0.01;
        add(ok, ok ? "VAT matches the invoice" : `Invoice VAT ${Number(erp.vat).toFixed(2)} ≠ e-Invoice VAT ${d.invoiceTotalTaxAmount.toFixed(2)}`);
    }
    return out;
}

module.exports = { buildPayload, precheck, r2, ymd };
