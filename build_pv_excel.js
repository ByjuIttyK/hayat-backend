"use strict";
/**
 * build_pv_excel.js
 * Pure Node.js / ExcelJS replacement for build_pv_template.py
 * Called as Express route — no Python needed.
 *
 * Run:  npm install exceljs   (once, in hayatApi folder)
 * Mount in HayatDb.js:
 *   const rvBuildRoute = require('./build_pv_excel');
 *   app.use('/api', rvBuildRoute);
 */

const ExcelJS = require("exceljs");
const express = require("express");
const router  = express.Router();

// ── Colour palette ────────────────────────────────────────────────────────────
// All values are 6-char hex (RRGGBB). The "FF" alpha prefix is added by solid()/border()/font().
const C = {
  NAV:    "1F3864",  WHT:    "FFFFFF",
  SEC_A:  "2E5D9E",  SEC_D:  "7030A0",
  SEC_B:  "375623",  SEC_C:  "843C0C",
  LBL_BG: "D6E4F0",  LBL_FG: "1F3864",
  AUTO_BG:"EAF0FB",  INP_BG: "FFFFFF",
  YLW_BG: "FFFDE7",  TOT_BG: "BDD7EE",
  GRN_BG: "E2EFDA",  MUTED:  "888888",
  BORDER: "4472C4",  DARK_BLUE: "000080",
};

// ── Style helpers ─────────────────────────────────────────────────────────────
// Auto-prefix FF alpha if color is 6 hex chars; pass through if already 8 chars
const asARGB = (hex) => {
  if (!hex) return "FF000000";
  const s = String(hex).replace(/^#/, "");
  return s.length === 6 ? "FF" + s : s;
};

const solid = (hex) => ({ type:"pattern", pattern:"solid", fgColor:{argb: asARGB(hex)} });
const border = (hex=C.BORDER) => {
  const s = { style:"thin", color:{argb: asARGB(hex)} };
  return { top:s, bottom:s, left:s, right:s };
};
const font = (opts={}) => ({
  name:"Arial", size:opts.sz||9,
  bold:!!opts.bold, italic:!!opts.italic,
  color:{ argb: asARGB(opts.color) },
});
const align = (h="left", v="middle", wrap=false) =>
  ({ horizontal:h, vertical:v, wrapText:wrap });

// Apply a full style to a cell
function style(cell, opts={}) {
  if (opts.fgColor)  cell.fill    = solid(opts.fgColor);
  if (opts.font)     cell.font    = opts.font;
  if (opts.align)    cell.alignment = opts.align;
  if (opts.border)   cell.border  = border();
  if (opts.nf)       cell.numFmt  = opts.nf;
}

// Section header spanning all 12 cols
function secHdr(ws, row, text, bgHex) {
  ws.mergeCells(row, 1, row, 12);
  const c = ws.getCell(row, 1);
  c.value     = text;
  c.fill      = solid(bgHex);
  c.font      = font({sz:9, bold:true, color:"FFFFFFFF"});
  c.alignment = align("left");
  ws.getRow(row).height = 18;
}

// Label cell (blue-tinted bg)
function lbl(cell, text) {
  cell.value     = text;
  cell.fill      = solid(C.LBL_BG);
  cell.font      = font({sz:8, bold:true, color:C.LBL_FG});
  cell.alignment = align("right");
  cell.border    = border();
}

// Locked/auto-filled cell (light-blue bg)
function locked(cell, value, opts={}) {
  cell.value     = value ?? "";
  cell.fill      = solid(C.AUTO_BG);
  cell.font      = font({sz:8, bold:!!opts.bold, italic:!!opts.italic,
                          color: opts.color || "FF1F3864"});
  cell.alignment = align(opts.align||"left");
  cell.border    = border();
  if (opts.nf) cell.numFmt = opts.nf;
}

// User-editable cell (yellow bg for amounts, white for text)
// IMPORTANT: protection.locked = false so sheet protection allows editing
function editable(cell, value, opts={}) {
  cell.value     = value ?? "";
  cell.fill      = solid(opts.yellow ? C.YLW_BG : C.INP_BG);
  cell.font      = font({sz:9, bold:!!opts.bold});
  cell.alignment = align(opts.align||"left");
  cell.border    = border();
  cell.protection = { locked: false };   // ← unlocked when sheet is protected
  if (opts.nf) cell.numFmt = opts.nf;
}

// Column header cell
function colHdr(cell, text, bgHex) {
  cell.value     = text;
  cell.fill      = solid(bgHex);
  cell.font      = font({sz:8, bold:true, color:"FFFFFFFF"});
  cell.alignment = align("center","middle",true);
  cell.border    = border();
}

// Empty filler cell
function empty(cell, bgHex=C.INP_BG) {
  cell.fill   = solid(bgHex);
  cell.border = border();
}

// ── Main builder ─────────────────────────────────────────────────────────────
async function buildWorkbook(header, invoices) {
  const h  = header  || {};
  const iv = invoices || [];

  const wb = new ExcelJS.Workbook();
  wb.creator = "HayatERP";
  wb.created = new Date();

  const ws = wb.addWorksheet("PV Entry", {
    views: [{ state:"frozen", xSplit:0, ySplit:4, topLeftCell:"A5",
              showGridLines:false }],
  });

  // Column widths (12 cols):
  // 1=#, 2=DocType/Tran, 3=DocNo/RefNo, 4=DocDate/VchrNo, 5=InvAmt/DepBank,
  // 6=Alr.Stld/BankName, 7=AccCode/ChqNo, 8=SrcType/ChqDate, 9=SettleAmt/DrawnBnk,
  // 10=filler/Amount, 11=filler, 12=filler
  [5, 9, 16, 18, 16, 22, 14, 14, 14, 14, 8, 8].forEach((w,i)=>{
    ws.getColumn(i+1).width = w;
  });

  // ── Row 1: Title ────────────────────────────────────────────────────────
  ws.getRow(1).height = 24;
  ws.mergeCells(1,1,1,12);
  const r1 = ws.getCell(1,1);
  r1.value     = "PAYMENT VOUCHER (PV) — EXCEL ENTRY";
  r1.fill      = solid(C.NAV);
  r1.font      = font({sz:13, bold:true, color:"FFFFFFFF"});
  r1.alignment = align("center");

  // ── Row 2: Subtitle ─────────────────────────────────────────────────────
  ws.getRow(2).height = 13;
  ws.mergeCells(2,1,2,12);
  const r2 = ws.getCell(2,1);
  r2.value     = `Ref: ${h.refNo||""}  |  Generated: ${new Date().toLocaleString("en-GB")}  |  Sheet is protected — fill ONLY yellow cells`;
  r2.fill      = solid(C.NAV);
  r2.font      = font({sz:7, italic:true, color:"FFCCCCCC"});
  r2.alignment = align("center");

  // Row 3: spacer
  ws.getRow(3).height = 5;

  // ── Row 4: Section A header ──────────────────────────────────────────────
  secHdr(ws, 4, "  SECTION A  —  VOUCHER HEADER  (System-Generated — Do Not Edit)", C.SEC_A);

  // ── Rows 5-7: Header fields ──────────────────────────────────────────────
  for (const r of [5,6,7]) ws.getRow(r).height = 18;

  // Row 5: Date | RefNo | VchrNo | TranType
  lbl(ws.getCell(5,1), "PV Date");
  locked(ws.getCell(5,2), h.pvDate||"");
  lbl(ws.getCell(5,3), "Ref No");
  ws.mergeCells(5,4,5,5);
  locked(ws.getCell(5,4), h.refNo||"", {bold:true, color:C.DARK_BLUE});
  lbl(ws.getCell(5,6), "Vchr No");
  ws.mergeCells(5,7,5,8);
  locked(ws.getCell(5,7), h.vchrNo||"");
  lbl(ws.getCell(5,9), "Tran Type");
  ws.mergeCells(5,10,5,12);
  const tt = ws.getCell(5,10);
  tt.value     = "04";
  tt.fill      = solid(C.AUTO_BG);
  tt.font      = font({sz:9, bold:true, color:C.DARK_BLUE});
  tt.alignment = align("center");
  tt.border    = border();

  // Row 6: Customer | Bank
  lbl(ws.getCell(6,1), "Sup (Dr.)");
  locked(ws.getCell(6,2), h.supCode||"", {bold:true});
  ws.mergeCells(6,3,6,5);
  locked(ws.getCell(6,3), h.supName||"", {italic:true});
  lbl(ws.getCell(6,6), "Bank (Cr.)");
  locked(ws.getCell(6,7), h.bankCode||"", {bold:true});
  ws.mergeCells(6,8,6,10);
  locked(ws.getCell(6,8), h.bankName||"", {italic:true});
  ws.mergeCells(6,11,6,12);
  empty(ws.getCell(6,11), C.LBL_BG);

  // Row 7: Particulars | Currency | Rate | FC | Local
  lbl(ws.getCell(7,1), "Particulars");
  ws.mergeCells(7,2,7,4);
  locked(ws.getCell(7,2), h.particulars||"");
  lbl(ws.getCell(7,5), "Curr");
  locked(ws.getCell(7,6), h.currCode||"AED", {align:"center"});
  lbl(ws.getCell(7,7), "Rate");
  locked(ws.getCell(7,8), Number(h.convRate)||1, {nf:"#,##0.00", align:"right"});
  lbl(ws.getCell(7,9), "Amt FC");
  locked(ws.getCell(7,10), Number(h.amountFc)||0, {nf:"#,##0.00", align:"right"});
  lbl(ws.getCell(7,11), "Amt Local");
  const amtCell = ws.getCell(7,12);
  amtCell.value     = Number(h.amountLcl)||0;
  amtCell.fill      = solid(C.AUTO_BG);
  amtCell.font      = font({sz:10, bold:true, color:C.DARK_BLUE});
  amtCell.alignment = align("right");
  amtCell.border    = border();
  amtCell.numFmt    = "#,##0.00";

  // Row 8: spacer
  ws.getRow(8).height = 5;

  // ── SECTION D ────────────────────────────────────────────────────────────
  // New column order: # | DocType | DocNo | DocDate | InvoiceAmt | Alr.Settled
  //                   | Acc Code | Src Type | Settle Amt *  (yellow at END)
  secHdr(ws, 9,
    "  SECTION D — INVOICE SETTLEMENTS  →  adj_dtl  (Src_Type='04')  |  Fill col I (Settle Amt) only — last column",
    C.SEC_D);

  ws.getRow(10).height = 28;
  const dHdrs = ["#","Doc Type","Doc No","Doc Date","Invoice Amt","Alr.Settled","Acc Code","Src Type","Settle Amt *"];
  dHdrs.forEach((h2,i)=> colHdr(ws.getCell(10,i+1), h2, "9DC3E6"));
  for (let c=10;c<=12;c++) empty(ws.getCell(10,c),"9DC3E6");

  const DS = 11;
  for (let idx=0; idx<20; idx++) {
    const row = DS + idx;
    const bg  = idx%2===0 ? "F4F9FF" : "FFFFFF";
    ws.getRow(row).height = 16;

    // Col 1: row number
    const rn = ws.getCell(row,1);
    rn.value     = idx+1;
    rn.fill      = solid("F0F0F0");
    rn.font      = font({sz:7, color:"FF888888"});
    rn.alignment = align("center");
    rn.border    = border();

    if (idx < iv.length) {
      const inv = iv[idx];
      locked(ws.getCell(row,2), inv.DOC_TYPE||inv.TRAN_TYPE||"");
      locked(ws.getCell(row,3), inv.DOC_NO  ||inv.VCHR_NO  ||"");
      locked(ws.getCell(row,4), inv.DOC_DATE||inv.DATTE    ||"");
      // Col 5: Invoice amt
      const ia = ws.getCell(row,5);
      ia.value = Number(inv.INV_AMT||inv.DR_AMT||0);
      ia.fill  = solid(bg); ia.font=font({sz:8});
      ia.alignment=align("right"); ia.border=border(); ia.numFmt="#,##0.00";
      // Col 6: Already settled
      const as = ws.getCell(row,6);
      as.value=0; as.fill=solid(bg); as.font=font({sz:8});
      as.alignment=align("right"); as.border=border(); as.numFmt="#,##0.00";
    } else {
      for (let c=2;c<=6;c++) { const cl=ws.getCell(row,c); cl.fill=solid(idx<iv.length?bg:C.AUTO_BG); cl.border=border(); }
    }

    // Col 7: Acc Code (pre-filled, locked)
    locked(ws.getCell(row,7), h.supCode||"");
    // Col 8: Src Type (always '03', locked)
    const st = ws.getCell(row,8);
    st.value="04"; st.fill=solid(C.AUTO_BG);
    st.font=font({sz:8,bold:true,color:C.DARK_BLUE});
    st.alignment=align("center"); st.border=border();
    // Col 9: Settle Amt — YELLOW, user fills (UNLOCKED for editing)
    editable(ws.getCell(row,9), 0, {yellow:true, align:"right", nf:"#,##0.00", bold:true});
    // Cols 10-12: filler
    for (let c=10;c<=12;c++) empty(ws.getCell(row,c), bg);
  }

  const DE=DS+19, DT=DE+1, DN=DT+1;
  ws.getRow(DT).height = 18;
  ws.mergeCells(DT,1,DT,4);
  const dtl = ws.getCell(DT,1);
  dtl.value="TOTAL SETTLEMENTS"; dtl.fill=solid(C.TOT_BG);
  dtl.font=font({sz:8,bold:true}); dtl.alignment=align("right"); dtl.border=border();

  // Col 5: SUM of Invoice Amt
  const dt5=ws.getCell(DT,5);
  dt5.value={formula:`SUM(E${DS}:E${DE})`}; dt5.fill=solid(C.TOT_BG);
  dt5.font=font({sz:8,bold:true}); dt5.alignment=align("right"); dt5.border=border(); dt5.numFmt="#,##0.00";

  // Col 6: SUM of Already Settled
  const dt6=ws.getCell(DT,6);
  dt6.value={formula:`SUM(F${DS}:F${DE})`}; dt6.fill=solid(C.TOT_BG);
  dt6.font=font({sz:8,bold:true}); dt6.alignment=align("right"); dt6.border=border(); dt6.numFmt="#,##0.00";

  // Cols 7-8: empty (Acc Code, Src Type — no total needed)
  empty(ws.getCell(DT,7),C.TOT_BG);
  empty(ws.getCell(DT,8),C.TOT_BG);

  // Col 9: SUM of Settle Amt (the user-entered yellow column)
  const dt9=ws.getCell(DT,9);
  dt9.value={formula:`SUM(I${DS}:I${DE})`}; dt9.fill=solid(C.TOT_BG);
  dt9.font=font({sz:10,bold:true,color:"FF"+C.SEC_D}); dt9.alignment=align("right"); dt9.border=border(); dt9.numFmt="#,##0.00";

  for (let c=10;c<=12;c++) empty(ws.getCell(DT,c),C.TOT_BG);

  ws.getRow(DN).height = 14;
  ws.mergeCells(DN,1,DN,12);
  const dn = ws.getCell(DN,1);
  dn.value = `ℹ  ${iv.length} outstanding bill(s) pre-loaded. Fill ONLY column I (Settle Amt) — last column. Leave 0 for invoices not being settled.`;
  dn.fill  = solid(C.YLW_BG);
  dn.font  = font({sz:7, italic:true, color:"FF555555"});
  dn.alignment = align("left");

  // ── SECTION B ────────────────────────────────────────────────────────────
  // New column order: # | Tran | Ref No | Vchr No | Paying Bank | Bank Name
  //                   | Chq No * | Chq Date * | Drawn Bank | Amount *  (yellow at END)
  const BS=DN+3, BSTART=BS+2, BEND=BSTART+5, BT=BEND+1;
  secHdr(ws, BS,
    "  SECTION B — CHEQUES ISSUED  →  pdc_isu  (Tran_Type='04')  |  Fill Chq No, Chq Date, Drawn Bank, Amount (last 4 columns)",
    C.SEC_B);

  ws.getRow(BS+1).height = 28;
  const bHdrs = ["#","Tran","Ref No","Vchr No","Paying Bank\n(pre-filled)","Bank Name","Chq No *","Chq Date *","Drawn Bank","Amount *"];
  bHdrs.forEach((h2,i)=> colHdr(ws.getCell(BS+1,i+1), h2, "A9D18E"));
  ws.mergeCells(BS+1,11,BS+1,12); empty(ws.getCell(BS+1,11),"A9D18E");

  for (let idx=0;idx<6;idx++) {
    const row = BSTART+idx;
    const bg  = idx%2===0?"F4FFF4":"FFFFFF";
    ws.getRow(row).height = 18;

    // Col 1: row number
    const rn=ws.getCell(row,1);
    rn.value=idx+1; rn.fill=solid("F0F0F0");
    rn.font=font({sz:7,color:"FF888888"}); rn.alignment=align("center"); rn.border=border();

    // Col 2: Tran Type (locked, '03')
    const t2=ws.getCell(row,2);
    t2.value="04"; t2.fill=solid(C.AUTO_BG);
    t2.font=font({sz:8,bold:true,color:C.DARK_BLUE});
    t2.alignment=align("center"); t2.border=border();

    // Col 3: Ref No (locked)
    locked(ws.getCell(row,3), h.refNo ||"");
    // Col 4: Vchr No (locked)
    locked(ws.getCell(row,4), h.vchrNo||"");
    // Col 5: Paying Bank Code (pre-filled, locked)
    locked(ws.getCell(row,5), h.bankCode||"", {bold:true});
    // Col 6: Bank Name (pre-filled, locked)
    locked(ws.getCell(row,6), h.bankName||"", {italic:true});

    // ── EDITABLE YELLOW COLUMNS (unlocked when sheet is protected) ─────────
    // Col 7: Chq No * — user fills
    editable(ws.getCell(row,7), "",  {yellow:true, align:"left"});
    // Col 8: Chq Date * — user fills
    editable(ws.getCell(row,8), "",  {yellow:true, align:"left"});
    // Col 9: Drawn Bank — optional, user fills (white not yellow since optional)
    editable(ws.getCell(row,9), "",  {align:"left"});
    // Col 10: Amount * — user fills
    editable(ws.getCell(row,10), 0,  {yellow:true, align:"right", nf:"#,##0.00", bold:true});

    // Cols 11-12: filler
    ws.mergeCells(row,11,row,12); empty(ws.getCell(row,11),bg);
  }

  ws.getRow(BT).height = 18;
  ws.mergeCells(BT,1,BT,9);
  const btl=ws.getCell(BT,1);
  btl.value="TOTAL CHEQUES"; btl.fill=solid(C.GRN_BG);
  btl.font=font({sz:8,bold:true}); btl.alignment=align("right"); btl.border=border();

  // Col 10: SUM of Amount (the user-entered yellow column)
  const bt10=ws.getCell(BT,10);
  bt10.value={formula:`SUM(J${BSTART}:J${BEND})`}; bt10.fill=solid(C.GRN_BG);
  bt10.font=font({sz:10,bold:true,color:"FF"+C.SEC_B});
  bt10.alignment=align("right"); bt10.border=border(); bt10.numFmt="#,##0.00";
  for (let c=11;c<=12;c++) empty(ws.getCell(BT,c),C.GRN_BG);

  // Validation row
  const VR=BT+1;
  ws.getRow(VR).height=14;
  ws.mergeCells(VR,1,VR,12);
  const amtLcl = Number(h.amountLcl)||0;
  const vr=ws.getCell(VR,1);
  vr.value = {
    formula: `IF(J${BT}=${amtLcl},"✔ Cheque total matches Amount Local ${amtLcl.toFixed(2)}","⚠ Cheque total "&TEXT(J${BT},"#,##0.00")&" ≠ Amt Local ${amtLcl.toFixed(2)}")`
  };
  vr.fill      = solid("DEEAF1");
  vr.font      = font({sz:8, bold:true, color:"FF1F3864"});
  vr.alignment = align("center");

  // ── SECTION C note ────────────────────────────────────────────────────────
  const CSEC=VR+2;
  secHdr(ws, CSEC,
    "  SECTION C — LEDGER LINES auto-generated by system on Upload / Post. Do not fill.",
    C.SEC_C);

  // ── Instructions sheet ────────────────────────────────────────────────────
  const ws2 = wb.addWorksheet("Instructions");
  ws2.getColumn(1).width = 90;
  const instrRows = [
    { text:`PV EXCEL — REF: ${h.refNo||""}`, bold:true, sz:12, bg:C.NAV,   fg:"FFFFFFFF" },
    { text:"",                                bold:false,sz:9,  bg:"FFFFFF", fg:"FF000000" },
    { text:"INSTRUCTIONS",                   bold:true, sz:11, bg:C.SEC_A, fg:"FFFFFFFF" },
    { text:"1. Sheet is PROTECTED — only YELLOW cells are editable.", bold:false,sz:9,bg:"F0F5FF",fg:"FF"+C.LBL_FG },
    { text:"2. Section A (Header): LOCKED — do not attempt to modify.", bold:false,sz:9,bg:"FFFFFF",fg:"FF000000" },
    { text:"3. Section D (Settlements): Fill ONLY the LAST column (Settle Amt) in yellow. Leave 0 if not settling that invoice.", bold:false,sz:9,bg:"F0F5FF",fg:"FF"+C.LBL_FG },
    { text:"4. Section B (Cheques): Fill the LAST 4 columns — Chq No, Chq Date, Drawn Bank (optional), Amount.", bold:false,sz:9,bg:"FFFFFF",fg:"FF000000" },
    { text:"5. Total Cheques (Section B) MUST equal Amount Local from header.", bold:false,sz:9,bg:"F0F5FF",fg:"FF"+C.LBL_FG },
    { text:`6. Save and upload back using the same filename: ${h.refNo||""}.xlsx`, bold:false,sz:9,bg:"FFFFFF",fg:"FF000000" },
    { text:"7. Sheet password (if needed by accountant): hayat", bold:false,sz:9,bg:"F0F5FF",fg:"FF"+C.LBL_FG },
  ];
  instrRows.forEach((r,i)=>{
    const cell = ws2.getCell(i+1,1);
    cell.value     = r.text;
    cell.font      = { name:"Arial", size:r.sz, bold:r.bold, color:{argb:r.fg} };
    cell.fill      = { type:"pattern", pattern:"solid", fgColor:{argb:"FF"+r.bg} };
    cell.alignment = { horizontal:"left", vertical:"middle", wrapText:true };
    ws2.getRow(i+1).height = r.bold ? 22 : 16;
  });

  // ── SHEET PROTECTION ──────────────────────────────────────────────────────
  // Locks all cells EXCEPT those explicitly marked as { protection: { locked: false } }
  // (set by the editable() helper). User can only modify yellow cells.
  // Password = "hayat" — required to remove protection.
  await ws.protect("hayat", {
    selectLockedCells:     true,    // can click locked cells (just can't edit)
    selectUnlockedCells:   true,    // can click/edit yellow cells
    formatCells:           false,
    formatColumns:         false,
    formatRows:            false,
    insertColumns:         false,
    insertRows:            false,
    insertHyperlinks:      false,
    deleteColumns:         false,
    deleteRows:            false,
    sort:                  false,
    autoFilter:            false,
    pivotTables:           false,
  });

  return wb;
}

// ── Express route ─────────────────────────────────────────────────────────────
router.post("/build-pv-excel", async (req, res) => {
  const { header={}, invoices=[] } = req.body;
  if (!header.refNo)
    return res.status(400).json({ error:"header.refNo is required" });

  try {
    const wb       = await buildWorkbook(header, invoices);
    const filename = `${header.refNo}.xlsx`;

    res.setHeader("Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    await wb.xlsx.write(res);
    res.end();
    console.log(`[build-rv-excel] Sent ${filename}`);
  } catch(err) {
    console.error("[build-rv-excel] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
