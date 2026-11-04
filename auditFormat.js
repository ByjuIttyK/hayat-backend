// auditFormat.js – turns raw audit_log rows into readable "events"
//
// An event = one save by one user (rows of the same user within a few seconds
// for the same document). For each event it lists only what really changed:
//   - UPDATE rows        -> one line per changed field (before -> after)
//   - DELETE + INSERT    -> lines paired (by SR_NO / line no), unchanged pairs
//                            collapsed into "n lines saved again – no change"
//   - unpaired rows      -> "Added" / "Removed" with a short summary
// Used by routes/auditApi.js for the Excel report.

const GAP_MS = 3000; // rows further apart than this start a new event

// fields ignored when deciding whether something changed
const NOISE = new Set([
  "SRNO_ROW_ID", "ID", "USERNAME", "TRANS_DATE", "TRANS_TIME",
  "CREATED_BY", "CREATED_DT", "MODIFIED_BY", "MODIFIED_DT", "EDITED_BY", "EDITED_DT",
]);
// columns used to pair a removed line with its re-added copy
const LINE_COLS = ["SR_NO", "SRNO", "LINE_NO", "SL_NO", "SEQ_NO", "ITEM_SR_NO"];

const TABLE_NAMES = {
  tran_acc: "Ledger lines",
  vouchers: "Voucher",
  vchr_nar: "Voucher narration",
  adj_dtl: "Invoice settlement",
  current_chq: "Cheque",
  pdc_isu: "PDC issued",
  pdc_rcd: "PDC received",
  crnote_hdr: "Credit note",
  drnote_hdr: "Debit note",
  pcashexp_hdr: "Petty cash",
  pcashexp_dtl: "Petty cash line",
  salary_jv_hdr: "Salary JV",
  eosb_prov_hdr: "Gratuity / leave salary provision",
  tran_type: "Voucher type setup",
  acc_posting_setup: "Posting account setup",
  ac_period: "Accounting period",
  acc_mst: "Account master",
  cus_mst: "Customer master",
  sup_mst: "Supplier master",
  pret_hdr: "Purchase return",
  pret_items: "Purchase return line",
  ngpret_hdr: "Non-goods purchase return",
  purchase_hdr: "Purchase invoice",
  purchase_items: "Purchase invoice line",
  purchase_hdr_ns: "Purchase invoice (non-stock)",
  purchase_items_ns: "Purchase invoice line (non-stock)",
  ngp_net: "Non-goods purchase",
  sret_hdr: "Sales return",
  srv_hdr: "Goods received (SRV)",
  srv_items: "SRV line",
  siv_hdr: "Store issue (SIV)",
  siv_items: "SIV line",
  gtrn_hdr: "Goods transfer",
  stk_adj: "Stock adjustment",
  net_sales: "Sales invoice",
  invoice: "Sales invoice line",
  fab_inv_hdr: "Fabrication invoice",
  fab_inv_dtl: "Fabrication invoice line",
};

const FIELD_NAMES = {
  DATTE: "Date", VCHR_DATE: "Voucher date", VCHR_NO: "Voucher no", TRAN_TYPE: "Voucher type",
  ACC_CODE: "Account", AC_CODE: "Account", CUST_CODE: "Customer", SUP_CODE: "Supplier", PARTY_CODE: "Party",
  DB_CR: "Dr / Cr", AMOUNT: "Amount", AMOUNT_FC: "Amount (foreign currency)", AMT_SETTLED: "Amount settled",
  NARRATION1: "Narration", NARRATION2: "Narration 2", NARRATION: "Narration",
  CHQ_NO: "Cheque no", CHQ_DATE: "Cheque date", BANK_CODE: "Bank", JOB_NO: "Job no", REF_NO: "Reference",
  STLD_AMT: "Settled amount", STLD_DOC: "Settled document", DIV_CODE: "Division",
  INV_NO: "Invoice no", INV_DATE: "Invoice date", PJV_NO: "Purchase no", PJV_DATE: "Purchase date",
  ITEM_CODE: "Item", QTY: "Quantity", RATE: "Rate", VAT_AMT: "VAT amount", NET_AMT: "Net amount",
  ACC_HEAD: "Account name", CUST_NAME: "Customer name", SUP_NAME: "Supplier name",
  CLOSED_PERIOD: "Closed up to", START_DATE: "Start date", END_DATE: "End date",
};

const label = (f) =>
  FIELD_NAMES[f.toUpperCase()] ||
  f.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const isAmountField = (f) => /AMOUNT|AMT|VALUE|BAL|TOTAL|PRICE|COST|VAT|NET|GROSS|RATE/i.test(f);
const CODE_FIELDS = /^(ACC_CODE|AC_CODE|CUST_CODE|SUP_CODE|PARTY_CODE|BANK_CODE|.*_AC)$/i;

function fmtVal(v, field, acHead) {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "string") {
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
    if (m) {
      const d = `${m[3]}/${m[2]}/${m[1]}`;
      return m[4] && !(m[4] === "00" && m[5] === "00") ? `${d} ${m[4]}:${m[5]}` : d;
    }
  }
  if (field && field.toUpperCase() === "DB_CR") return v === "D" ? "Debit" : v === "C" ? "Credit" : String(v);
  if (field && isAmountField(field) && v !== "" && !Number.isNaN(Number(v)))
    return Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (field && CODE_FIELDS.test(field) && acHead && acHead[v]) return `${v} – ${acHead[v]}`;
  return String(v);
}

const sameVal = (a, b) => {
  if ((a === null || a === undefined || a === "") && (b === null || b === undefined || b === "")) return true;
  if (!Number.isNaN(Number(a)) && !Number.isNaN(Number(b)) && a !== "" && b !== "") return Number(a) === Number(b);
  return String(a) === String(b);
};

function changed(oldRow, newRow) {
  const keys = new Set([...Object.keys(oldRow || {}), ...Object.keys(newRow || {})]);
  return [...keys].filter((k) => !NOISE.has(k.toUpperCase()) && !sameVal(oldRow?.[k], newRow?.[k]));
}

function lineCol(row) {
  return row && Object.keys(row).find((k) => LINE_COLS.includes(k.toUpperCase()));
}

/** short description of a whole line (for added / removed lines) */
function summary(tbl, row, acHead) {
  if (!row) return "";
  if (tbl === "tran_acc") {
    return [
      row.DB_CR === "D" ? "Dr" : row.DB_CR === "C" ? "Cr" : "",
      fmtVal(row.ACC_CODE, "ACC_CODE", acHead),
      fmtVal(row.AMOUNT, "AMOUNT"),
      row.NARRATION1 ? `– ${row.NARRATION1}` : "",
    ].filter(Boolean).join(" ");
  }
  return Object.keys(row)
    .filter((k) => !NOISE.has(k.toUpperCase()) && !["TRAN_TYPE", "VCHR_NO"].includes(k.toUpperCase()) && row[k] !== null && row[k] !== "")
    .slice(0, 6)
    .map((k) => `${label(k)}: ${fmtVal(row[k], k, acHead)}`)
    .join("; ");
}

const tableName = (t) => TABLE_NAMES[t] || label(t);

/**
 * rows: audit_log rows in id order, each { id, ts (Date|string), user_name, op, tbl, key_val,
 *        tran_type, vchr_no, datte, old_data, new_data } with old/new already parsed
 * lookups: { acHead: {code: name}, tranTypeName: {code: name} }
 */
function buildEvents(rows, lookups = {}) {
  const acHead = lookups.acHead || {};
  const ttName = lookups.tranTypeName || {};
  const events = [];
  let cur = null;
  const docOf = (r) => (r.vchr_no ? `${r.tran_type || ""}|${r.vchr_no}` : null);

  for (const r of rows) {
    const t = new Date(r.ts).getTime();
    const d = docOf(r);
    const startNew =
      !cur ||
      cur.user !== r.user_name ||
      t - cur.lastTs > GAP_MS ||
      (d && cur.doc && d !== cur.doc);
    if (startNew) {
      cur = { user: r.user_name, firstTs: r.ts, tsText: r.ts_txt, lastTs: t, doc: d, rows: [] };
      events.push(cur);
    }
    if (d && !cur.doc) cur.doc = d;
    cur.lastTs = t;
    cur.rows.push(r);
  }

  return events.map((ev) => describe(ev, acHead, ttName));
}

function describe(ev, acHead, ttName) {
  const rows = ev.rows;
  const withDoc = rows.find((r) => r.vchr_no) || rows[0];
  const header = rows.find((r) => r.vchr_no && !["tran_acc", "adj_dtl", "vchr_nar"].includes(r.tbl)) || withDoc;
  const tt = withDoc.tran_type;

  let document;
  if (withDoc.vchr_no) {
    const typeLabel = (tt && ttName[tt]) || (header && header.tbl !== "tran_acc" ? tableName(header.tbl) : tt ? `Type ${tt}` : "Document");
    document = `${typeLabel} ${withDoc.vchr_no}`;
  } else {
    document = `${tableName(withDoc.tbl)} ${withDoc.key_val || ""}`.trim();
  }
  // a document date only for vouchers / documents, not for master records
  const docDate = withDoc.vchr_no ? (rows.find((r) => r.datte) || {}).datte || "" : "";

  const lines = [];
  let anyChange = false;
  const ops = new Set(rows.map((r) => r.op));

  // keep tables in the order they were first touched
  const byTbl = new Map();
  rows.forEach((r) => {
    if (!byTbl.has(r.tbl)) byTbl.set(r.tbl, []);
    byTbl.get(r.tbl).push(r);
  });

  for (const [tbl, list] of byTbl) {
    const section = tableName(tbl);
    const ups = list.filter((r) => r.op === "UPDATE");
    const dels = list.filter((r) => r.op === "DELETE");
    const ins = list.filter((r) => r.op === "INSERT");

    ups.forEach((r) => {
      const f = changed(r.old, r.new);
      if (!f.length) return;
      anyChange = true;
      const lc = lineCol(r.new);
      f.forEach((k) =>
        lines.push({
          section,
          line: lc ? `Line ${Number(r.new[lc]) || r.new[lc]}` : "",
          field: label(k),
          before: fmtVal(r.old?.[k], k, acHead),
          after: fmtVal(r.new?.[k], k, acHead),
        })
      );
    });

    // pair removed and re-added lines
    const pairs = [];
    const freeIns = [...ins];
    const freeDel = [];
    dels.forEach((dr) => {
      const lc = lineCol(dr.old);
      let idx = -1;
      if (lc) idx = freeIns.findIndex((ir) => ir.new && sameVal(ir.new[lineCol(ir.new)], dr.old[lc]));
      if (idx < 0) idx = freeIns.findIndex((ir) => changed(dr.old, ir.new).length === 0); // identical content
      if (idx >= 0) pairs.push([dr, freeIns.splice(idx, 1)[0]]);
      else freeDel.push(dr);
    });
    if (!lineCol(dels[0]?.old) && freeDel.length && freeDel.length === freeIns.length) {
      // no line number to pair on and counts match: pair in order
      freeDel.splice(0).forEach((dr) => pairs.push([dr, freeIns.shift()]));
    }

    let unchanged = 0;
    pairs.forEach(([dr, ir]) => {
      const f = changed(dr.old, ir.new);
      if (!f.length) return unchanged++;
      anyChange = true;
      const lc = lineCol(ir.new);
      f.forEach((k) =>
        lines.push({
          section,
          line: lc ? `Line ${Number(ir.new[lc]) || ir.new[lc]}` : "",
          field: label(k),
          before: fmtVal(dr.old?.[k], k, acHead),
          after: fmtVal(ir.new?.[k], k, acHead),
        })
      );
    });
    freeDel.forEach((dr) => {
      anyChange = true;
      const lc = lineCol(dr.old);
      lines.push({ section, line: lc ? `Line ${Number(dr.old[lc]) || dr.old[lc]}` : "", field: "Removed", before: summary(tbl, dr.old, acHead), after: "" });
    });
    freeIns.forEach((ir) => {
      anyChange = true;
      const lc = lineCol(ir.new);
      lines.push({ section, line: lc ? `Line ${Number(ir.new[lc]) || ir.new[lc]}` : "", field: "Added", before: "", after: summary(tbl, ir.new, acHead) });
    });
    if (unchanged)
      lines.push({ section, line: "", field: `${unchanged} line${unchanged > 1 ? "s" : ""} saved again – no change`, before: "", after: "", note: true });
  }

  let action;
  if (ops.size === 1 && ops.has("INSERT")) action = "Created";
  else if (ops.size === 1 && ops.has("DELETE")) action = "Deleted";
  else action = anyChange ? "Edited" : "Saved again – no change";

  return {
    ts: ev.firstTs,
    tsText: ev.tsText || String(ev.firstTs),
    user: ev.user || "",
    action,
    document,
    docDate,
    lines,
    rowCount: rows.length,
  };
}

module.exports = { buildEvents, tableName, label, fmtVal };
