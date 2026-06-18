"use strict";
/**
 * docAttachRoute.js
 * File attachment routes — stores files on disk, metadata in DB.
 *
 * Install:  npm install multer uuid
 * Mount in HayatDb.js:
 *   const docRoute = require('./docAttachRoute')(connection);
 *   app.use('/api', docRoute);
 *
 * Files stored at:  E:\hayatApi\uploads\<MODULE>\<REF_NO>\<uuid.ext>
 */

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const router  = express.Router();

const BASE_DIR = path.join(__dirname, 'uploads');

// ── Allowed file types ────────────────────────────────────────────────────
const ALLOWED_EXT = [
  '.pdf', '.jpg', '.jpeg', '.png', '.gif', '.bmp',
  '.xlsx', '.xls', '.csv',
  '.docx', '.doc',
  '.dwg', '.dxf',
  '.msg', '.eml',
  '.txt', '.zip',
];

module.exports = function (connection) {

  const db = (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, r) => err ? reject(err) : resolve(r))
    );

  // ── Multer storage — folder per MODULE/REF_NO ─────────────────────────
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const { module, refNo } = req.params;
      const dir = path.join(BASE_DIR, module.toUpperCase(), String(refNo));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext        = path.extname(file.originalname).toLowerCase();
      const storedName = `${uuidv4()}${ext}`;
      cb(null, storedName);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 },   // 20 MB per file
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (ALLOWED_EXT.includes(ext)) {
        cb(null, true);
      } else {
        cb(new Error(`File type ${ext} not allowed`), false);
      }
    },
  });

  // ── POST /api/docs/upload/:module/:refNo ──────────────────────────────
  // Body: multipart/form-data, field name "files" (up to 10 at once)
  // Header: x-user-id = logged-in username
  router.post('/docs/upload/:module/:refNo',
    upload.array('files', 10),
    async (req, res) => {
      const { module, refNo } = req.params;
      const userId = req.headers['x-user-id'] || 'system';
      try {
        if (!req.files || req.files.length === 0)
          return res.status(400).json({ error: 'No files uploaded' });

        const rows = req.files.map(f => [
          module.toUpperCase(),
          String(refNo),
          f.originalname,
          f.filename,
          path.extname(f.originalname).replace('.', '').toLowerCase(),
          f.size,
          f.mimetype || '',
          req.body.remarks || '',
          userId,
        ]);

        await db(
          `INSERT INTO doc_attachments
             (MODULE, REF_NO, FILE_NAME, STORED_NAME, FILE_EXT,
              FILE_SIZE, MIME_TYPE, REMARKS, UPLOADED_BY)
           VALUES ?`,
          [rows]
        );
        console.log(`[docs] Uploaded ${rows.length} file(s) → ${module}/${refNo}`);
        res.json({ success: true, count: rows.length });
      } catch (err) {
        console.error('[docs upload]', err.message);
        res.status(500).json({ error: err.message });
      }
    }
  );

  // ── GET /api/docs/list/:module/:refNo ─────────────────────────────────
  router.get('/docs/list/:module/:refNo', async (req, res) => {
    const { module, refNo } = req.params;
    try {
      const rows = await db(
        `SELECT ID, FILE_NAME, FILE_EXT, FILE_SIZE,
                MIME_TYPE, REMARKS, UPLOADED_BY, UPLOADED_AT
         FROM   doc_attachments
         WHERE  MODULE = ? AND REF_NO = ?
         ORDER  BY UPLOADED_AT DESC`,
        [module.toUpperCase(), String(refNo)]
      );
      res.json(rows);
    } catch (err) {
      console.error('[docs list]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/docs/download/:id ────────────────────────────────────────
  // Streams the file directly to browser (inline for images/PDFs, attachment for others)
  router.get('/docs/download/:id', async (req, res) => {
    try {
      const [doc] = await db(
        `SELECT * FROM doc_attachments WHERE ID = ?`, [req.params.id]);
      if (!doc) return res.status(404).json({ error: 'Record not found' });

      const filePath = path.join(
        BASE_DIR, doc.MODULE, doc.REF_NO, doc.STORED_NAME);

      if (!fs.existsSync(filePath))
        return res.status(404).json({ error: 'File missing on disk' });

      // Open inline for PDF/images, force download for others
      const inlineTypes = ['pdf', 'jpg', 'jpeg', 'png', 'gif'];
      const disposition = inlineTypes.includes(doc.FILE_EXT)
        ? `inline; filename="${doc.FILE_NAME}"`
        : `attachment; filename="${doc.FILE_NAME}"`;

      res.setHeader('Content-Disposition', disposition);
      res.setHeader('Content-Type', doc.MIME_TYPE || 'application/octet-stream');
      res.setHeader('Content-Length', doc.FILE_SIZE);

      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      console.error('[docs download]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── DELETE /api/docs/:id ──────────────────────────────────────────────
  // Removes DB record AND disk file
  router.delete('/docs/:id', async (req, res) => {
    try {
      const [doc] = await db(
        `SELECT * FROM doc_attachments WHERE ID = ?`, [req.params.id]);
      if (!doc) return res.status(404).json({ error: 'Record not found' });

      // Delete disk file
      const filePath = path.join(
        BASE_DIR, doc.MODULE, doc.REF_NO, doc.STORED_NAME);
      try { fs.unlinkSync(filePath); } catch { /* file already gone — ignore */ }

      await db(`DELETE FROM doc_attachments WHERE ID = ?`, [req.params.id]);
      console.log(`[docs] Deleted ID=${req.params.id} file=${doc.FILE_NAME}`);
      res.json({ success: true });
    } catch (err) {
      console.error('[docs delete]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
