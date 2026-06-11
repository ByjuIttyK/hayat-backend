// ═══════════════════════════════════════════════════════════════════════════
//  JvExcelEntryRoutes.js
//  JV Staging Routes — Excel/Spreadsheet drag & drop input
//  Mount in HayatDb.js: app.use('/api/jv', require('./middleware/JvExcelEntryRoutes'))
// ═══════════════════════════════════════════════════════════════════════════

const express    = require('express');
const router     = express.Router();                 // ← Express Router (not app)
const multer     = require('multer');
const ExcelJS    = require('exceljs');
const fs         = require('fs');
const path       = require('path');
const { v4: uuidv4 } = require('uuid');

// ── Shared dependencies from parent app ────────────────────────────────────
// connection and authMiddleware are passed in via require, NOT globals
const connection      = require('./db/connection');          // adjust path if needed
const authMiddleware  = require('./middleware/authMiddleware');

const uploadMiddleware = multer({ dest: 'uploads/' });

// ══════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════

// Extract GL code from "1001 - Cash" → "1001"
function extractGLCode(val) {
  if (!val) return null;
  const s = String(val).trim();
  const m = s.match(/^(\S+)\s*-/);
  return m ? m[1] : s;
}

// Safe MySQL date
function safeDate(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return toMySQLDate(String(val));
}

// Generate next real VCHR_NO (used only at POST time)
async function getNextRealVchrNo() {
  const db = connection.promise();
  const [[row]] = await db.query(
    `SELECT MAX(VCHR_NO) AS maxNo FROM tran_acc WHERE TRAN_TYPE = '05'`
  );
  const last = row?.maxNo;
  if (!last) return 1;
  const num = parseInt(last.replace(/\D/g, ''), 10);
  return isNaN(num) ? 1 : num + 1;
}

// ══════════════════════════════════════════════════════════════════════
// ROUTE 1: Download template with live GL/Job/Panel data
// GET /api/jv/template
// ══════════════════════════════════════════════════════════════════════
router.get('/template', authMiddleware, async (req, res) => {
  try {
    const db = connection.promise();
    const userId = req.user?.id;

    const [uRows] = await db.query(
      'SELECT user_abbr, username FROM users WHERE id = ?', [userId]
    );
    const userAbbr = uRows[0]?.user_abbr?.trim() ||
      req.user?.username?.slice(0, 5).toUpperCase() || 'USR';

    const [lastDoc] = await db.query(
      `SELECT doc_no FROM jv_template_log
       WHERE user_abbr = ? ORDER BY id DESC LIMIT 1`,
      [userAbbr]
    );
    let nextSeq = 1;
    if (lastDoc.length) {
      const lastSeq = parseInt(lastDoc[0].doc_no.split('-').pop());
      if (!isNaN(lastSeq)) nextSeq = lastSeq + 1;
    }
    const docNo = `${userAbbr}-${String(nextSeq).padStart(3, '0')}`;

    const now = new Date();
    const mo = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const dateStr = `${now.getFullYear()}-${mo}-${dd}`;
    const fileName = `JV_${docNo}_${dateStr}.xlsx`;
    const prefix = docNo;

    await db.query(
      `INSERT INTO jv_template_log (doc_no, user_abbr, user_id, filename)
       VALUES (?, ?, ?, ?)`,
      [docNo, userAbbr, userId, fileName]
    );

    const [glRows]    = await db.query('SELECT AC_CODE, AC_HEAD FROM ac_list ORDER BY AC_CODE');
    const [jobRows]   = await db.query(
      `SELECT DISTINCT JOB_NO FROM job_card
       WHERE JOB_NO IS NOT NULL AND JOB_NO <> '' AND JOB_NO <> '0' ORDER BY JOB_NO`
    );
    const [panelRows] = await db.query(
      `SELECT JOB_NO, SR_NO, PANEL_REF FROM job_panels
       WHERE JOB_NO IS NOT NULL AND JOB_NO <> '0' ORDER BY JOB_NO, SR_NO+0`
    );

    const templatePath = path.join(__dirname, '..', 'JV_Template_v4.xlsx');  // adjust if needed
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(templatePath);
    const ws = wb.getWorksheet('JV_Entries');

    // Inject Ref_No formula into Column A (rows 2-1000)
    ws.getRow(2).getCell(1).value = { formula: `IF(AND(B2="",C2=""),"","${prefix}-001")` };
    for (let r = 3; r <= 1000; r++) {
      ws.getRow(r).getCell(1).value = {
        formula:
          `IF(AND(B${r}="",C${r}=""),"",` +
          `IF(B${r}<>"","${prefix}-"&TEXT(COUNTIF(B$2:B${r},"<>"),"000"),` +
          `IF(A${r - 1}<>"",A${r - 1},"")))`
      };
    }

    // Fix Panel_No column E
    for (let r = 2; r <= 1000; r++) {
      ws.getRow(r).getCell(5).value = {
        formula:
          `IFERROR(OFFSET(PanelNos,MATCH(D${r},PanelJobs,0)-1,0,` +
          `COUNTIF(PanelJobs,D${r}),1),"")`
      };
    }

    // Clear sample data
    for (let r = 2; r <= 100; r++) {
      [2, 3, 4, 8, 9, 10, 11].forEach(col => {
        ws.getRow(r).getCell(col).value = null;
      });
    }

    // Update GL_Master sheet
    const glSheet = wb.getWorksheet('GL_Master');
    const glOldMax = glSheet.rowCount;
    for (let r = 3; r <= glOldMax; r++) {
      [1, 2, 3, 4].forEach(col => { glSheet.getRow(r).getCell(col).value = null; });
    }
    glRows.forEach((g, i) => {
      const r = i + 3;
      glSheet.getRow(r).getCell(1).value = g.AC_CODE;
      glSheet.getRow(r).getCell(2).value = g.AC_HEAD;
      glSheet.getRow(r).getCell(3).value = 'ACCT';
      glSheet.getRow(r).getCell(4).value = `${g.AC_CODE} - ${g.AC_HEAD}`;
    });

    // Update Job_Master sheet
    const jobSheet = wb.getWorksheet('Job_Master');
    const jobOldMax = jobSheet.rowCount;
    for (let r = 3; r <= jobOldMax; r++) {
      [1, 2].forEach(col => { jobSheet.getRow(r).getCell(col).value = null; });
    }
    jobRows.forEach((j, i) => {
      const r = i + 3;
      jobSheet.getRow(r).getCell(1).value = j.JOB_NO;
      jobSheet.getRow(r).getCell(2).value = j.JOB_NAME || j.JOB_NO;
    });

    // Update Job_Panels sheet
    const panelSheet = wb.getWorksheet('Job_Panels');
    const panelOldMax = panelSheet.rowCount;
    for (let r = 3; r <= panelOldMax; r++) {
      [1, 2, 3].forEach(col => { panelSheet.getRow(r).getCell(col).value = null; });
    }
    panelRows.forEach((p, i) => {
      const r = i + 3;
      panelSheet.getRow(r).getCell(1).value = p.JOB_NO;
      panelSheet.getRow(r).getCell(2).value = p.SR_NO;
      panelSheet.getRow(r).getCell(3).value = p.PANEL_REF || '';
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('X-Doc-No', docNo);
    await wb.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error('Template error:', err);
    res.status(500).json({ message: 'Failed to generate template', error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
// ROUTE 2: Upload Excel → parse → save to staging tables
// POST /api/jv/stage/upload
// ══════════════════════════════════════════════════════════════════════
router.post('/stage/upload', authMiddleware, uploadMiddleware.single('file'), async (req, res) => {
  const filePath = req.file?.path;
  const username = req.user?.username || 'SYSTEM';

  try {
    if (!filePath) return res.status(400).json({ message: 'No file uploaded' });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const ws = wb.getWorksheet('JV_Entries');
    if (!ws) return res.status(400).json({ message: "Sheet 'JV_Entries' not found" });

    const voucherMap = {};
    let currentVchrNo = null;
    let currentDate   = null;

    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;

      const getCellValue = (cell) => {
        const v = cell.value;
        if (v === null || v === undefined) return null;
        if (typeof v === 'object' && v.result !== undefined) return v.result;
        if (v instanceof Date) return v;
        if (typeof v === 'object') return null;
        return v;
      };

      const refNo  = getCellValue(row.getCell(1));
      const jvDate = getCellValue(row.getCell(2));
      const glAcct = getCellValue(row.getCell(3));
      const jobNo  = getCellValue(row.getCell(4));
      const panelNo = getCellValue(row.getCell(5));
      const desc   = getCellValue(row.getCell(8));
      const debit  = parseFloat(getCellValue(row.getCell(9)))  || 0;
      const credit = parseFloat(getCellValue(row.getCell(10))) || 0;
      const costCtr = getCellValue(row.getCell(11));

      if (!refNo && !glAcct && !desc && debit === 0 && credit === 0) return;

      if (refNo)  currentVchrNo = String(refNo).trim();
      if (jvDate) currentDate   = safeDate(jvDate);

      if (!currentVchrNo || !glAcct) return;

      if (!voucherMap[currentVchrNo]) {
        voucherMap[currentVchrNo] = { date: currentDate, lines: [] };
      }

      const acCode = extractGLCode(String(glAcct));

      if (debit > 0) {
        voucherMap[currentVchrNo].lines.push({
          acc_code: acCode, amount: debit, db_cr: 'D',
          narration: desc ? String(desc) : '',
          job_no:   jobNo   ? String(jobNo)   : null,
          panel_no: panelNo ? String(panelNo) : null,
          div_code: costCtr ? String(costCtr) : null,
        });
      }
      if (credit > 0) {
        voucherMap[currentVchrNo].lines.push({
          acc_code: acCode, amount: credit, db_cr: 'C',
          narration: desc ? String(desc) : '',
          job_no:   jobNo   ? String(jobNo)   : null,
          panel_no: panelNo ? String(panelNo) : null,
          div_code: costCtr ? String(costCtr) : null,
        });
      }
    });

    if (!Object.keys(voucherMap).length) {
      return res.status(400).json({ message: 'No valid JV lines found in file' });
    }

    const batchId  = uuidv4();
    const filename = req.file.originalname || 'upload.xlsx';
    let totalLines = 0, totalAmount = 0;

    const db   = connection.promise();
    const conn = await db.getConnection();

    try {
      await conn.beginTransaction();

      await conn.query(
        `INSERT INTO jv_stage_batch
          (BATCH_ID, FILENAME, UPLOADED_BY, TOTAL_VOUCHERS, STATUS)
         VALUES (?, ?, ?, ?, 'PENDING')`,
        [batchId, filename, username, Object.keys(voucherMap).length]
      );

      for (const [vchrNo, v] of Object.entries(voucherMap)) {
        const debitTotal  = v.lines.filter(l => l.db_cr === 'D').reduce((s, l) => s + l.amount, 0);
        const creditTotal = v.lines.filter(l => l.db_cr === 'C').reduce((s, l) => s + l.amount, 0);
        const firstDebit  = v.lines.find(l => l.db_cr === 'D');
        const firstCredit = v.lines.find(l => l.db_cr === 'C');

        await conn.query(
          `INSERT INTO jv_stage_vouchers
            (BATCH_ID, TRAN_TYPE, REF_NO, DATTE,
             ACC_CODE, ACC_CODE2, AMOUNT, AMOUNT2,
             NARRATION1, JOB_NO, VCHR_TYPE, UPLOADED_BY, STATUS)
           VALUES (?, '05', ?, ?, ?, ?, ?, ?, ?, ?, 'J', ?, 'PENDING')`,
          [
            batchId, vchrNo, v.date,
            firstDebit?.acc_code  || null,
            firstCredit?.acc_code || null,
            debitTotal, creditTotal,
            firstDebit?.narration || '',
            firstDebit?.job_no    || null,
            username,
          ]
        );

        for (const line of v.lines) {
          await conn.query(
            `INSERT INTO jv_stage_tran_acc
              (BATCH_ID, REF_NO, TRAN_TYPE, DATTE,
               ACC_CODE, AMOUNT, DB_CR, NARRATION1,
               USERNAME, JOB_NO, PANEL_NO, DIV_CODE, TRANS_DATE, STATUS)
             VALUES (?, ?, '05', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
            [
              batchId, vchrNo, v.date,
              line.acc_code, line.amount, line.db_cr,
              line.narration, username,
              line.job_no, line.panel_no, line.div_code, v.date,
            ]
          );
          totalLines++;
          totalAmount += line.db_cr === 'D' ? line.amount : 0;
        }
      }

      await conn.query(
        `UPDATE jv_stage_batch SET TOTAL_LINES=?, TOTAL_AMOUNT=? WHERE BATCH_ID=?`,
        [totalLines, totalAmount, batchId]
      );

      await conn.commit();

      res.json({
        success: true,
        batch_id: batchId,
        total_vouchers: Object.keys(voucherMap).length,
        total_lines: totalLines,
        total_amount: totalAmount,
        message: `Uploaded to staging — ${Object.keys(voucherMap).length} JV(s), ${totalLines} lines. Please validate before posting.`,
      });

    } catch (dbErr) {
      await conn.rollback();
      throw dbErr;
    } finally {
      conn.release();
    }

  } catch (err) {
    console.error('Stage upload error:', err);
    res.status(500).json({ message: 'Upload failed', error: err.message });
  } finally {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
});

// ══════════════════════════════════════════════════════════════════════
// ROUTE 3: Validate batch
// POST /api/jv/stage/validate/:batchId
// ══════════════════════════════════════════════════════════════════════
router.post('/stage/validate/:batchId', authMiddleware, async (req, res) => {
  const { batchId } = req.params;
  const db = connection.promise();

  try {
    const [vouchers] = await db.query(
      `SELECT * FROM jv_stage_vouchers WHERE BATCH_ID=?`, [batchId]
    );
    if (!vouchers.length) return res.status(404).json({ message: 'Batch not found' });

    const [lines]     = await db.query(`SELECT * FROM jv_stage_tran_acc WHERE BATCH_ID=?`, [batchId]);
    const [glCodes]   = await db.query('SELECT AC_CODE FROM ac_list');
    const [jobCodes]  = await db.query('SELECT DISTINCT JOB_NO FROM job_card WHERE JOB_NO IS NOT NULL');
    const [panelRows] = await db.query('SELECT JOB_NO, SR_NO FROM job_panels');

    const validGL   = new Set(glCodes.map(r => r.AC_CODE));
    const validJobs = new Set(jobCodes.map(r => r.JOB_NO));

    const validPanels = {};
    panelRows.forEach(p => {
      if (!validPanels[p.JOB_NO]) validPanels[p.JOB_NO] = new Set();
      validPanels[p.JOB_NO].add(String(p.SR_NO));
    });

    const vchrNos  = [...new Set(vouchers.map(v => v.VCHR_NO))];
    const [existing] = await db.query(
      `SELECT VCHR_NO FROM vouchers WHERE VCHR_NO IN (?)`, [vchrNos]
    );
    const existingSet = new Set(existing.map(r => r.VCHR_NO));

    const errors = [];
    let errorCount = 0;

    for (const v of vouchers) {
      const vLines      = lines.filter(l => l.REF_NO === v.REF_NO);
      const debitTotal  = vLines.filter(l => l.DB_CR === 'D').reduce((s, l) => s + parseFloat(l.AMOUNT), 0);
      const creditTotal = vLines.filter(l => l.DB_CR === 'C').reduce((s, l) => s + parseFloat(l.AMOUNT), 0);
      const vErrors     = [];

      if (Math.abs(debitTotal - creditTotal) > 0.01)
        vErrors.push(`Unbalanced — Dr:${debitTotal.toFixed(2)} Cr:${creditTotal.toFixed(2)}`);
      if (!v.DATTE) vErrors.push('JV Date is missing');
      if (vLines.length < 2) vErrors.push('JV must have at least 2 lines');
      if (existingSet.has(v.VCHR_NO))
        vErrors.push(`Ref "${v.VCHR_NO}" already exists in vouchers — possible duplicate upload`);

      for (const line of vLines) {
        if (!line.ACC_CODE) {
          vErrors.push('Line has no GL Account');
        } else if (!validGL.has(line.ACC_CODE)) {
          vErrors.push(`GL "${line.ACC_CODE}" not found in ac_list`);
        }
        if (line.JOB_NO && !validJobs.has(line.JOB_NO))
          vErrors.push(`Job "${line.JOB_NO}" not found in job_card`);
        if (line.JOB_NO && line.PANEL_NO) {
          if (!validPanels[line.JOB_NO]?.has(String(line.PANEL_NO)))
            vErrors.push(`Panel "${line.PANEL_NO}" not valid for Job "${line.JOB_NO}"`);
        }
      }

      const status   = vErrors.length ? 'ERROR' : 'VALID';
      const errorMsg = vErrors.join(' | ');
      if (vErrors.length) errorCount++;

      await db.query(
        `UPDATE jv_stage_vouchers SET STATUS=?, ERROR_MSG=? WHERE BATCH_ID=? AND REF_NO=?`,
        [status, errorMsg || null, batchId, v.REF_NO]
      );
      await db.query(
        `UPDATE jv_stage_tran_acc SET STATUS=? WHERE BATCH_ID=? AND REF_NO=?`,
        [status, batchId, v.REF_NO]
      );

      if (vErrors.length) errors.push({ ref_no: v.REF_NO, errors: vErrors });
    }

    const batchStatus = errorCount === 0 ? 'VALID'
      : errorCount === vouchers.length  ? 'ERROR' : 'PARTIAL';

    await db.query(
      `UPDATE jv_stage_batch
       SET STATUS=?, ERROR_COUNT=?, VALIDATED_AT=NOW() WHERE BATCH_ID=?`,
      [batchStatus, errorCount, batchId]
    );

    res.json({
      success: true,
      batch_id: batchId,
      batch_status: batchStatus,
      total:  vouchers.length,
      valid:  vouchers.length - errorCount,
      errors: errorCount,
      error_details: errors,
      can_post: batchStatus === 'VALID',
      message: errorCount === 0
        ? `All ${vouchers.length} JV(s) validated — ready to post`
        : `${errorCount} error(s) found — fix before posting`,
    });

  } catch (err) {
    console.error('Validate error:', err);
    res.status(500).json({ message: 'Validation failed', error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
// ROUTE 4: Get staging batch detail
// GET /api/jv/stage/:batchId
// ══════════════════════════════════════════════════════════════════════
router.get('/stage/:batchId', authMiddleware, async (req, res) => {
  const { batchId } = req.params;
  const db = connection.promise();
  try {
    const [batch] = await db.query('SELECT * FROM jv_stage_batch WHERE BATCH_ID=?', [batchId]);
    const [vouchers] = await db.query(
      `SELECT v.*, COUNT(t.STAGE_LINE_ID) AS LINE_COUNT
       FROM jv_stage_vouchers v
       LEFT JOIN jv_stage_tran_acc t ON t.BATCH_ID=v.BATCH_ID AND t.REF_NO=v.REF_NO
       WHERE v.BATCH_ID=? GROUP BY v.STAGE_ID ORDER BY v.VCHR_NO`,
      [batchId]
    );
    const [lines] = await db.query(
      `SELECT t.*, a.AC_HEAD
       FROM jv_stage_tran_acc t
       LEFT JOIN ac_list a ON a.AC_CODE=t.ACC_CODE
       WHERE t.BATCH_ID=? ORDER BY t.VCHR_NO, t.DB_CR DESC`,
      [batchId]
    );
    res.json({ batch: batch[0], vouchers, lines });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch batch', error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
// ROUTE 5: Get all pending batches
// GET /api/jv/stage/batches/list
// ══════════════════════════════════════════════════════════════════════
router.get('/stage/batches/list', authMiddleware, async (req, res) => {
  const db = connection.promise();
  try {
    const [rows] = await db.query(
      `SELECT * FROM jv_stage_batch
       WHERE STATUS IN ('PENDING','VALID','PARTIAL','ERROR')
       ORDER BY UPLOADED_AT DESC LIMIT 50`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch batches', error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
// ROUTE 6: Post to actual tables — assigns REAL VCHR_NO here
// POST /api/jv/stage/post/:batchId
// ══════════════════════════════════════════════════════════════════════
router.post('/stage/post/:batchId', authMiddleware, async (req, res) => {
  const { batchId } = req.params;
  const username = req.user?.username || 'SYSTEM';
  const db = connection.promise();

  try {
    const [batches] = await db.query('SELECT * FROM jv_stage_batch WHERE BATCH_ID=?', [batchId]);
    if (!batches.length) return res.status(404).json({ message: 'Batch not found' });

    if (batches[0].STATUS !== 'VALID') {
      return res.status(422).json({
        message: `Batch is "${batches[0].STATUS}" — must be VALID before posting`
      });
    }

    const [stageVouchers] = await db.query(
      `SELECT * FROM jv_stage_vouchers WHERE BATCH_ID=? AND STATUS='VALID' ORDER BY REF_NO`,
      [batchId]
    );
    const [stageLines] = await db.query(
      `SELECT * FROM jv_stage_tran_acc WHERE BATCH_ID=? AND STATUS='VALID'`,
      [batchId]
    );

    if (!stageVouchers.length) {
      return res.status(400).json({ message: 'No valid vouchers to post' });
    }

    const conn    = await db.getConnection();
    const posted  = [];
    let counter   = await getNextRealVchrNo();

    try {
      await conn.beginTransaction();

      for (const sv of stageVouchers) {
        const realVchrNo = 'JV' + String(counter).padStart(6, '0');
        counter++;

        await conn.query(
          `INSERT INTO vouchers
            (TRAN_TYPE, VCHR_NO, DATTE, CUST_CODE, ACC_CODE, CHEQUE_NO,
             AMOUNT, NARRATION1, NARRATION2, BANK_NAME, PAID_TO, CAN_CEL,
             ACC_CODE2, AMOUNT2, JOB_NO, VCHR_TYPE, CUR_CODE, CONV_RATE, AMOUNT_FRGN)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            '05', realVchrNo, sv.DATTE, sv.CUST_CODE,
            sv.ACC_CODE, sv.CHEQUE_NO, sv.AMOUNT,
            sv.NARRATION1, sv.NARRATION2, sv.BANK_NAME,
            sv.PAID_TO, sv.CAN_CEL, sv.ACC_CODE2, sv.AMOUNT2,
            sv.JOB_NO, 'J', sv.CUR_CODE, sv.CONV_RATE, sv.AMOUNT_FRGN,
          ]
        );

        const vLines = stageLines.filter(l => l.REF_NO === sv.REF_NO);
        for (const sl of vLines) {
          await conn.query(
            `INSERT INTO tran_acc
              (TRAN_TYPE, vchr_no, DATTE, ACC_CODE, AMOUNT, DB_CR,
               NARRATION1, NARRATION2, AMT_SETTLED, USERNAME,
               TRANS_DATE, BANK_RCNL, DIV_CODE, JOB_NO, PANEL_NO)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              '05', realVchrNo, sl.DATTE, sl.ACC_CODE,
              sl.AMOUNT, sl.DB_CR, sl.NARRATION1, sl.NARRATION2,
              0, username, sl.TRANS_DATE || sl.DATTE, 'N',
              sl.DIV_CODE, sl.JOB_NO, sl.PANEL_NO,
            ]
          );
        }

        await conn.query(
          `UPDATE jv_stage_vouchers
           SET STATUS='POSTED', REAL_VCHR_NO=?, POSTED_AT=NOW(), POSTED_BY=?
           WHERE BATCH_ID=? AND REF_NO=?`,
          [realVchrNo, username, batchId, sv.VCHR_NO]
        );
        await conn.query(
          `UPDATE jv_stage_tran_acc SET STATUS='POSTED' WHERE BATCH_ID=? AND REF_NO=?`,
          [batchId, sv.VCHR_NO]
        );

        posted.push({ temp_ref: sv.VCHR_NO, real_vchr_no: realVchrNo });
      }

      await conn.query(
        `UPDATE jv_stage_batch
         SET STATUS='POSTED', POSTED_AT=NOW(), POSTED_BY=? WHERE BATCH_ID=?`,
        [username, batchId]
      );

      await conn.commit();

      res.json({
        success: true,
        posted_count: posted.length,
        posted,
        message: `${posted.length} JV(s) posted successfully`,
        batch_id: batchId,
      });

    } catch (dbErr) {
      await conn.rollback();
      throw dbErr;
    } finally {
      conn.release();
    }

  } catch (err) {
    console.error('Post error:', err);
    res.status(500).json({ message: 'Posting failed', error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
// ROUTE 7: Reject/delete a batch
// DELETE /api/jv/stage/:batchId
// ══════════════════════════════════════════════════════════════════════
router.delete('/stage/:batchId', authMiddleware, async (req, res) => {
  const { batchId } = req.params;
  const db = connection.promise();
  try {
    await db.query(`UPDATE jv_stage_batch    SET STATUS='REJECTED' WHERE BATCH_ID=?`, [batchId]);
    await db.query(`UPDATE jv_stage_vouchers SET STATUS='REJECTED' WHERE BATCH_ID=?`, [batchId]);
    await db.query(`UPDATE jv_stage_tran_acc SET STATUS='REJECTED' WHERE BATCH_ID=?`, [batchId]);
    res.json({ success: true, message: 'Batch rejected' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to reject batch', error: err.message });
  }
});

module.exports = router;
