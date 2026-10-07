const COMPANY = require("../config/company");
/**
 * Despatch Note PDF Route
 * File: E:\hayatApi\routes\despatchNoteRoutes.js
 *
 * Endpoint:
 *   GET /api/despatch-note/:jobNumber
 *
 * Generates an A4 LANDSCAPE PDF — one despatch note per page, filling the
 * full printable area (one page per panel).
 * Each section matches the Oracle report layout:
 *   - Company header
 *   - FROM field
 *   - JOB NO / PROJECT / PANEL REF
 *   - "This side up" arrows + HANDLE WITH CARE
 *
 * Data pulled from existing API endpoints:
 *   GET /api/jobcard/:jobNumber   → job header (project, customer etc.)
 *   GET /api/jobpanels/:jobNumber → array of panels
 *
 * Registration in HayatDb.js:
 *   const despatchNote = require('./routes/despatchNoteRoutes');
 *   app.use('/api', despatchNote(connection));
 */

const express  = require('express');
const PDFDocument = require('pdfkit');
// Uses native fetch (Node.js 18+) — no extra dependency needed

// ── Self-call base URL (backend calls its own API to reuse existing routes) ──
// Uses same port the Express server is running on.
const SELF = process.env.SELF_URL || 'http://127.0.0.1:3001';

module.exports = function (connection) {
  const router = express.Router();

  // ── GET /api/despatch-note/:jobNumber ──────────────────────────────────────
  router.get('/despatch-note/:jobNumber', async (req, res) => {
    const { jobNumber } = req.params;
    const token = req.headers.authorization || '';

    try {
      // Fetch job card + panels in parallel from existing routes
      const fetchJson = async (url) => {
        const r = await fetch(url, { headers: { Authorization: token } });
        if (!r.ok) {
          const err = new Error(`Upstream ${url} returned ${r.status}`);
          err.status = r.status;
          throw err;
        }
        return r.json();
      };

      const [jobRaw, panels] = await Promise.all([
        fetchJson(`${SELF}/api/jobcard/${jobNumber}`),
        fetchJson(`${SELF}/api/jobpanels/${jobNumber}`),
      ]);
      // jobcard route returns array — take first element
      const job = Array.isArray(jobRaw) ? jobRaw[0] : jobRaw;

      if (!panels || panels.length === 0) {
        return res.status(404).json({ error: 'No panels found for this job.' });
      }

      // Stream PDF directly to the response
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition',
        `attachment; filename="DespatchNote_${jobNumber}.pdf"`);

      const theme = req.query.theme || 'white';
      const pdf = buildDespatchPdf(job, panels, theme);
      pdf.pipe(res);

    } catch (err) {
      console.error('[despatch-note]', err.message);
      // If the error is an axios 404 from upstream, surface it cleanly
      if (err.status === 404) {
        return res.status(404).json({ error: `Job ${jobNumber} not found.` });
      }
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};

// ─────────────────────────────────────────────────────────────────────────────
// PDF BUILDER
// A4 landscape: 841.89 × 595.28 pt
// One despatch note per page, stretched edge-to-edge inside equal margins.
// ─────────────────────────────────────────────────────────────────────────────

function buildDespatchPdf(job, panels, theme = 'white') {
  const PAGE_W = 841.89;
  const PAGE_H = 595.28;
  const MARGIN = 24;
  const SECT_W = PAGE_W - MARGIN * 2;
  const SECT_H = PAGE_H - MARGIN * 2;

  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margins: { top: 0, bottom: 0, left: 0, right: 0 },   // we position everything ourselves
    autoFirstPage: false,
    info: { Title: `Despatch Note — Job ${job.job_no || job.JOB_NO || ''}` },
  });

  panels.forEach((panel) => {
    doc.addPage({ size: 'A4', layout: 'landscape', margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    drawDespatchNote(doc, job, panel, MARGIN, MARGIN, SECT_W, SECT_H, theme);
  });

  doc.end();
  return doc;
}

// ─── Theme palettes ───────────────────────────────────────────────────────────
const THEMES = {
  white: {
    ACCENT : '#000000', RULE   : '#000000', TITLE  : '#000000',
    HDR_BG : '#FFFFFF', LABEL_BG: '#FFFFFF', PANEL_TINT: '#FFFFFF',
  },
  plain: {
    ACCENT : '#555555', RULE   : '#777777', TITLE  : '#000000',
    HDR_BG : '#F5F5F5', LABEL_BG: '#EEEEEE', PANEL_TINT: '#F0F0F0',
  },
  'navy-gold': {
    ACCENT : '#C9A84C', RULE   : '#C9A84C', TITLE  : '#C9A84C',
    HDR_BG : '#E8EFF5', LABEL_BG: '#EEF2F6', PANEL_TINT: '#EBF0F7',
  },
  'steel-blue': {
    ACCENT : '#1D4ED8', RULE   : '#1D4ED8', TITLE  : '#0F6E84',
    HDR_BG : '#EBF0F7', LABEL_BG: '#EEF2F6', PANEL_TINT: '#EBF4FF',
  },
  'amber-red': {
    ACCENT : '#D97706', RULE   : '#EA580C', TITLE  : '#C41E3A',
    HDR_BG : '#E8EFF5', LABEL_BG: '#EEF2F6', PANEL_TINT: '#EBF0F7',
  },
  'teal-green': {
    ACCENT : '#0F766E', RULE   : '#0D9488', TITLE  : '#15803D',
    HDR_BG : '#F0FAFA', LABEL_BG: '#ECFAF8', PANEL_TINT: '#F0FFF4',
  },
};



// ─────────────────────────────────────────────────────────────────────────────
// Draw one despatch note filling the box (x, y, w, h).
// Everything is sized from w/h so the note is fully justified on the page.
// ─────────────────────────────────────────────────────────────────────────────
function drawDespatchNote(doc, job, panel, x, y, w, h, theme = 'white') {
  const g = (obj, ...keys) => {
    if (!obj) return '---';
    for (const k of keys) {
      if (obj[k] != null && obj[k] !== '') return String(obj[k]).trim();
      const u = k.toUpperCase(); if (obj[u] != null && obj[u] !== '') return String(obj[u]).trim();
      const l = k.toLowerCase(); if (obj[l] != null && obj[l] !== '') return String(obj[l]).trim();
    }
    return '---';
  };

  const jobNo    = g(job,   'JOB_NO','job_no','JobNo');
  const project  = g(job,   'PROJ_NAME','proj_name','PROJECT','project','PROJ_NO','proj_no');
  const panelRef = g(panel, 'PANEL_REF','panel_ref','PANEL_DESCRIPTION','panel_description','PANEL_TAG','panel_tag');

  // ── Design tokens ─────────────────────────────────────────────────────────
  // All text, frame and arrows in pure black — printed on a B&W printer
  const NAVY     = '#000000';
  const LABEL_FG = '#000000';
  const TEXT     = '#000000';
  const LINE     = '#BBBBBB';
  const BORDER   = 2;
  const THIN     = 0.6;
  const PAD      = 16;
  const pal        = THEMES[theme] || THEMES.white;
  const ACCENT     = pal.ACCENT;
  const LABEL_BG   = pal.LABEL_BG;
  const HDR_BG     = pal.HDR_BG;
  const RULE_COL   = pal.RULE;
  const TITLE_COL  = TEXT;          // was pal.TITLE — forced black for B&W printing
  const PANEL_TINT = pal.PANEL_TINT;

  // Shrink a font until the single-line text fits the width
  const fitSize = (text, font, size, maxW, min = 8) => {
    doc.font(font);
    let s = size;
    while (s > min && doc.fontSize(s).widthOfString(text) > maxW) s -= 0.5;
    return s;
  };
  // Text vertically centred in a row. Shrinks to fit one line; if it would
  // drop below `minOne`, wraps onto two lines instead (long panel refs).
  const cellText = (text, font, size, color, tx, rowY, rowH, tw, align = 'left', minOne = 8) => {
    const s = fitSize(text, font, size, tw, minOne);
    doc.font(font).fontSize(s).fillColor(color);
    if (doc.widthOfString(text) <= tw) {
      doc.text(text, tx, rowY + (rowH - s * 0.72) / 2, { width: tw, align, lineBreak: false });
    } else {
      const s2 = Math.min(s, (rowH - 8) / 2.3);
      doc.fontSize(s2);
      const th = doc.heightOfString(text, { width: tw, lineGap: 1 });
      doc.text(text, tx, rowY + (rowH - th) / 2 + 1, { width: tw, align, lineGap: 1, height: rowH - 4, ellipsis: true });
    }
  };

  // ── Section heights (integers keep lines crisp) ───────────────────────────
  const hdrH  = Math.round(h * 0.22);
  const rowH  = Math.round(h * 0.095);          // FROM, JOB NO, PROJECT, PANEL REF
  const rowsH = rowH * 4;
  const careH = h - hdrH - rowsH;               // remainder
  const LBL_W = Math.round(w * 0.17);           // label column


  // ── 1. HEADER ─────────────────────────────────────────────────────────────
  const hdrY = Math.round(y);
  // No background fill on the header (saves toner)
  if (theme !== 'white') {
    doc.save().rect(x, hdrY, w, 5).fill(NAVY).restore();
    doc.save().rect(x, hdrY + 5, w, 3).fill(ACCENT).restore();
  }
  // Company name — fills the full width
  cellText(COMPANY.NAME, 'Helvetica-Bold', 28, NAVY, x + PAD, hdrY + hdrH * 0.06, hdrH * 0.34, w - PAD * 2, 'center');

  const rX = x + PAD * 2, rW = w - PAD * 4;
  doc.save().moveTo(rX, hdrY + hdrH * 0.44).lineTo(rX + rW, hdrY + hdrH * 0.44)
     .lineWidth(1.2).strokeColor(RULE_COL).stroke().restore();
  cellText(`${COMPANY.CITY_UPPER}        Tel: ${COMPANY.TEL}        ${COMPANY.WEB}`,
    'Helvetica', 12, TEXT, x + PAD, hdrY + hdrH * 0.44, hdrH * 0.20, w - PAD * 2, 'center');
  doc.save().moveTo(rX, hdrY + hdrH * 0.64).lineTo(rX + rW, hdrY + hdrH * 0.64)
     .lineWidth(0.8).strokeColor(RULE_COL).stroke().restore();
  cellText('DESPATCH PARTICULARS', 'Helvetica-Bold', 20, TITLE_COL,
    x + PAD, hdrY + hdrH * 0.66, hdrH * 0.32, w - PAD * 2, 'center');

  let cy = hdrY + hdrH;
  doc.save().moveTo(x, cy).lineTo(x + w, cy).lineWidth(BORDER).strokeColor(NAVY).stroke().restore();

  // ── 2. DETAIL ROWS (FROM / JOB NO / PROJECT / PANEL REF) ─────────────────
  const rowsY = cy;
  doc.save().rect(x, rowsY, LBL_W, rowsH).fill(LABEL_BG).restore();
  doc.save().moveTo(x + LBL_W, rowsY).lineTo(x + LBL_W, rowsY + rowsH)
     .lineWidth(THIN).strokeColor(LINE).stroke().restore();

  const valW = w - LBL_W - PAD * 2;
  [
    ['FROM',       COMPANY.NAME, 18, TEXT],
    ['JOB NO:',    jobNo,        20, TEXT],
    ['PROJECT:',   project,      20, TEXT],
    ['PANEL REF:', panelRef,     24, NAVY],
  ].forEach(([lbl, val, size, col], i) => {
    const ry = rowsY + i * rowH;
    if (i > 0) doc.save().moveTo(x, ry).lineTo(x + w, ry).lineWidth(THIN).strokeColor(LINE).stroke().restore();
    cellText(lbl, 'Helvetica-Bold', 14, LABEL_FG, x + PAD, ry, rowH, LBL_W - PAD * 2);
    cellText(val, 'Helvetica-Bold', size, col, x + LBL_W + PAD, ry, rowH, valW, 'left', 14);
  });

  cy = rowsY + rowsH;
  doc.save().moveTo(x, cy).lineTo(x + w, cy).lineWidth(BORDER).strokeColor(NAVY).stroke().restore();

  // ── 3. ARROWS + HANDLE WITH CARE ─────────────────────────────────────────
  const careY  = cy;
  const arrowW = Math.round(w * 0.36);
  const careW  = w - arrowW;
  doc.save().moveTo(x + arrowW, careY).lineTo(x + arrowW, careY + careH)
     .lineWidth(THIN).strokeColor(LINE).stroke().restore();

  // Two upward arrows, sized from the section height
  const aMX  = x + arrowW / 2;
  const aTop = careY + careH * 0.08;
  const aBot = careY + careH * 0.74;
  const aAH  = aBot - aTop;
  const hH   = aAH * 0.26;
  const sW   = Math.max(8, careH * 0.045);
  const hW   = sW * 3;
  const sp   = hW * 1.6;
  [-sp / 2, sp / 2].forEach(off => {
    const ax = aMX + off;
    doc.save().rect(ax - sW / 2, aTop + hH - 1, sW, aAH - hH + 1).fill(NAVY).restore();
    doc.save().moveTo(ax, aTop).lineTo(ax + hW / 2, aTop + hH)
       .lineTo(ax - hW / 2, aTop + hH).closePath().fill(NAVY).restore();
  });
  const lY = aBot + careH * 0.04;
  doc.save().moveTo(x + PAD * 2, lY).lineTo(x + arrowW - PAD * 2, lY)
     .lineWidth(1.2).strokeColor(NAVY).stroke().restore();
  cellText('THIS SIDE UP', 'Helvetica-Bold', 13, NAVY, x, lY + careH * 0.03, careH * 0.10, arrowW, 'center');

  // HANDLE WITH CARE — as large as the box allows, no fill (saves toner)
  const words = ['HANDLE', 'WITH', 'CARE'];
  const lineGap = careH * 0.04;
  let fS = (careH - PAD * 2 - lineGap * 2) / 3 / 0.95;
  doc.font('Helvetica-Bold');
  while (fS > 12 && doc.fontSize(fS).widthOfString('HANDLE') > careW - PAD * 4) fS -= 1;
  const blockH = fS * 0.72 * 3 + (fS * 0.28 + lineGap) * 2;
  let ty = careY + (careH - blockH) / 2;
  words.forEach(wd => {
    doc.font('Helvetica-Bold').fontSize(fS).fillColor(NAVY)
       .text(wd, x + arrowW, ty, { width: careW, align: 'center', lineBreak: false });
    ty += fS * 0.72 + fS * 0.28 + lineGap;
  });

  // Outer frame LAST so the header/label fills can't paint over its edges
  doc.save().rect(x, y, w, h).lineWidth(BORDER).strokeColor(NAVY).stroke().restore();
}
