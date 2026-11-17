/**
 * Foreign Purchase save — POST /api/save-frgnpurch
 * Screen: PinvFrgn.tsx
 *
 * Moved out of HayatDb.js. Registration in HayatDb.js (and delete the old
 * inline app.post("/api/save-frgnpurch", ...) block):
 *   const saveFrgnPurchRoutes = require('./routes/saveFrgnPurchRoutes');
 *   app.use('/api', saveFrgnPurchRoutes(connection));
 *
 * GET /api/next-frgn-pjv → { pjvNo }  next voucher no from pur_frgn_hdr only:
 *   highest FP######## + 1 (FP + 8 digits). Shown on screen in ADD mode.
 *
 * Numbering on save (multi-user): ADD claims the number with a plain INSERT.
 * If another user saved that number first, the next free one is taken from
 * pur_frgn_hdr (last FP row locked FOR UPDATE) and the claim repeats. The
 * number actually used comes back as pjvNo. EDIT updates the existing row.
 *
 * One transaction:
 *   pur_frgn_hdr   ADD: insert (renumbered on a clash); EDIT: update — with
 *                  SRV_NO (the Overseas SRV it was loaded from) and
 *                  PUR_TYPE = 'O' (Overseas)
 *   lcst_trn       this voucher's expense lines replaced: DELETE by VCHR_NO,
 *                  then INSERT the lines with an amount (lcst_trn has no unique
 *                  key, so the old ON DUPLICATE KEY only ever added rows)
 *   pur_frgn_items lines removed on screen are deleted, the rest upserted on
 *                  (PJV_NO, SR_NO)
 *   tran_acc       G/L posting, TRAN_TYPE '07', VCHR_NO = PJV No, DATTE = PJV date
 *                  (old type-07 rows of the voucher deleted, then re-posted):
 *                    Dr  Dr.Code (Inventory – Foreign Purchase)  Net Amount
 *                                (Items Total − Discount)
 *                    Cr  Supplier                                Amount Local
 *                                (Inv.Amount F.C × Rate)
 *                    Cr  each landed-cost expense a/c            its amount
 *                                (git_types.ACC_CODE by TYPE_CODE)
 *                    Dr  Purchase Discount 502-001-0-002         Discount
 *                                (Cr if the discount is negative)
 *                    Dr/Cr Round Off 6125                        the difference,
 *                                on whichever side balances the voucher
 *                  pur_frgn_hdr.RND_OFF keeps that difference (+ = Dr, − = Cr).
 * Any failure rolls the whole save back.
 *
 * GET /api/frgn-pjv-gl/:pjvNo → the voucher's tran_acc lines with account heads
 *   (the screen's "G/L Entry" button).
 */

const express = require('express');

const q = (conn, sql, params) =>
  new Promise((resolve, reject) =>
    conn.query(sql, params, (err, result) => (err ? reject(err) : resolve(result))));

const begin    = (conn) => new Promise((ok, ko) => conn.beginTransaction((e) => (e ? ko(e) : ok())));
const commit   = (conn) => new Promise((ok, ko) => conn.commit((e) => (e ? ko(e) : ok())));
const rollback = (conn) => new Promise((ok) => conn.rollback(() => ok()));

const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
const strOrNull = (v, n) => {
  const s = String(v ?? '').trim();
  return s ? (n ? s.slice(0, n) : s) : null;
};

const PUR_TRAN_TYPE = '07';
const PUR_DISC_AC   = '502-001-0-002';      // Purchase Discount A/c
const RND_OFF_AC    = '6125';               // Round Off A/c — takes the balance
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const ACC_DELETE = 'DELETE FROM tran_acc WHERE VCHR_NO = ? AND TRAN_TYPE = ?';
const ACC_INSERT = `
  INSERT INTO tran_acc (VCHR_NO, SR_NO, DATTE, TRAN_TYPE, ACC_CODE, DB_CR, AMOUNT, NARRATION1, NARRATION2)
  VALUES ?`;

/**
 * Builds and inserts the type-07 posting. Amounts are worked out here from
 * the voucher's own figures, the same way the screen shows them, so the G/L
 * always matches what was saved.
 */
async function postFrgnPurchase(conn, v) {
  await q(conn, ACC_DELETE, [v.pjvNo, PUR_TRAN_TYPE]);

  // Expense accounts from git_types
  const codes = v.expLines.map(([code]) => code);
  const accOf = {};
  if (codes.length) {
    const rows = await q(conn, 'SELECT TRIM(TYPE_CODE) AS TC, ACC_CODE FROM git_types WHERE TRIM(TYPE_CODE) IN (?)', [codes]);
    rows.forEach((r) => { accOf[r.TC] = r.ACC_CODE; });
    const missing = codes.filter((c) => !accOf[c]);
    if (missing.length) throw new Error(`No expense A/c in git_types for code(s) ${missing.join(', ')}`);
  }

  const lines = [];                       // [acc, 'D'|'C', amount]
  if (v.netAmt)   lines.push([v.drCode, 'D', v.netAmt]);
  if (v.amtLocal) lines.push([v.supCode, 'C', v.amtLocal]);
  v.expLines.forEach(([code, amt]) => { if (round2(amt)) lines.push([accOf[code], 'C', round2(amt)]); });
  if (v.discount > 0) lines.push([PUR_DISC_AC, 'D', v.discount]);
  else if (v.discount < 0) lines.push([PUR_DISC_AC, 'C', -v.discount]);

  // Difference → Round Off A/c, on the side that balances (same figure as RND_OFF)
  if (v.rndOff > 0) lines.push([RND_OFF_AC, 'D', v.rndOff]);
  else if (v.rndOff < 0) lines.push([RND_OFF_AC, 'C', -v.rndOff]);

  if (!lines.length) return;
  if (!v.drCode) throw new Error('Dr.Code is required to post the purchase');
  if (!v.supCode) throw new Error('Supplier is required to post the purchase');

  const narr1 = (v.narration || '').slice(0, 80) || null;
  const narr2 = [v.invNo && `Inv ${v.invNo}`, v.srvNo && `SRV ${v.srvNo}`].filter(Boolean).join(' / ').slice(0, 80) || null;
  await q(conn, ACC_INSERT, [lines.map(([acc, dbCr, amt], i) => [
    v.pjvNo, String(i + 1).padStart(3, '0'), v.pjvDate, PUR_TRAN_TYPE, acc, dbCr, round2(amt), narr1, narr2,
  ])]);
}

const PJV_PREFIX = 'FP';
const PJV_DIGITS = 8;            // FP00008226
const MAX_CLAIMS = 10;
const isDup = (e) => !!e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062);

/** Next FP voucher no after the highest one in pur_frgn_hdr. */
async function nextFrgnPjvNo(db, lock) {
  const rows = await q(db,
    `SELECT PJV_NO FROM pur_frgn_hdr
      WHERE PJV_NO LIKE ? ORDER BY PJV_NO DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [`${PJV_PREFIX}%`]);
  const last = rows.length ? String(rows[0].PJV_NO).trim() : '';
  const n = Number(last.slice(PJV_PREFIX.length).replace(/\D/g, '')) || 0;
  return PJV_PREFIX + String(n + 1).padStart(PJV_DIGITS, '0');
}

const HDR_INSERT = `
  INSERT INTO pur_frgn_hdr
    (PJV_NO, PJV_DATE, INV_NO, INV_DATE, PO_NO, SRV_NO, SUP_CODE,
     ACC_CODE, NARRATION, INV_AMOUNT_FRGN, INV_AMOUNT_LOCAL,
     CURR_CODE, CONV_RATE, DISCOUNT, VAT_AMOUNT, PUR_TYPE, RND_OFF, EFF_RATE)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const HDR_UPSERT = `
  INSERT INTO pur_frgn_hdr
    (PJV_NO, PJV_DATE, INV_NO, INV_DATE, PO_NO, SRV_NO, SUP_CODE,
     ACC_CODE, NARRATION, INV_AMOUNT_FRGN, INV_AMOUNT_LOCAL,
     CURR_CODE, CONV_RATE, DISCOUNT, VAT_AMOUNT, PUR_TYPE, RND_OFF, EFF_RATE)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    PJV_DATE         = VALUES(PJV_DATE),
    INV_NO           = VALUES(INV_NO),
    INV_DATE         = VALUES(INV_DATE),
    PO_NO            = VALUES(PO_NO),
    SRV_NO           = VALUES(SRV_NO),
    SUP_CODE         = VALUES(SUP_CODE),
    ACC_CODE         = VALUES(ACC_CODE),
    NARRATION        = VALUES(NARRATION),
    INV_AMOUNT_FRGN  = VALUES(INV_AMOUNT_FRGN),
    INV_AMOUNT_LOCAL = VALUES(INV_AMOUNT_LOCAL),
    CURR_CODE        = VALUES(CURR_CODE),
    CONV_RATE        = VALUES(CONV_RATE),
    DISCOUNT         = VALUES(DISCOUNT),
    VAT_AMOUNT       = VALUES(VAT_AMOUNT),
    PUR_TYPE         = VALUES(PUR_TYPE),
    RND_OFF          = VALUES(RND_OFF),
    EFF_RATE         = VALUES(EFF_RATE)`;

const ITEMS_UPSERT = `
  INSERT INTO pur_frgn_items (PJV_NO, SR_NO, ITEM_CODE, QTY, COST_FC, UNIT_COST)
  VALUES ?
  ON DUPLICATE KEY UPDATE
    ITEM_CODE = COALESCE(VALUES(ITEM_CODE), ITEM_CODE),
    QTY       = COALESCE(VALUES(QTY), QTY),
    COST_FC   = COALESCE(VALUES(COST_FC), COST_FC),
    UNIT_COST = COALESCE(VALUES(UNIT_COST), UNIT_COST)`;

module.exports = function (connection) {
  const router = express.Router();

  // ── Next voucher no (pur_frgn_hdr only) ─────────────────────────────────
  router.get('/next-frgn-pjv', async (req, res) => {
    try {
      res.json({ pjvNo: await nextFrgnPjvNo(connection, false) });
    } catch (err) {
      console.error('[next-frgn-pjv]', err);
      res.status(500).json({ error: err.sqlMessage || err.message });
    }
  });

  // ── G/L entry of a voucher (screen's G/L Entry button) ───────────────────
  router.get('/frgn-pjv-gl/:pjvNo', async (req, res) => {
    try {
      const rows = await q(connection,
        `SELECT t.SR_NO, t.ACC_CODE, a.AC_HEAD, t.DB_CR, t.AMOUNT, t.NARRATION1, t.NARRATION2,
                DATE_FORMAT(t.DATTE, '%d/%m/%Y') AS DATTE
           FROM tran_acc t
      LEFT JOIN ac_list a ON a.AC_CODE = t.ACC_CODE
          WHERE t.VCHR_NO = ? AND t.TRAN_TYPE = ?
       ORDER BY t.SR_NO`,
        [String(req.params.pjvNo || '').trim(), PUR_TRAN_TYPE]);
      res.json(rows);
    } catch (err) {
      console.error('[frgn-pjv-gl]', err);
      res.status(500).json({ error: err.sqlMessage || err.message });
    }
  });

  router.post('/save-frgnpurch', (req, res) => {
    const { netData, expData, itemsData } = req.body || {};
    if (!netData || !Array.isArray(itemsData) || itemsData.length === 0) {
      return res.status(400).json({ message: 'Invalid data format' });
    }
    const clientPjvNo = strOrNull(netData.PjvNo, 10);
    if (!clientPjvNo) return res.status(400).json({ message: 'Voucher No is required' });
    const mode = String(netData.Mode || '').toUpperCase();   // ADD / EDIT

    // Header values after PJV_NO (the number is settled inside the transaction)
    const hdrRest = [
      netData.PjvDt || null,
      strOrNull(netData.InvNo, 20),
      netData.InvDt || null,
      strOrNull(netData.FpoNo, 10),
      strOrNull(netData.SrvNo, 10),
      strOrNull(netData.SupCd),
      strOrNull(netData.DrCd),
      strOrNull(netData.Narration, 30),
      numOrNull(netData.InvAmtFc),
      numOrNull(netData.InvAmtLcl),
      strOrNull(netData.CrrCd),
      numOrNull(netData.ConvRt),
      numOrNull(netData.discAmt ?? netData.DiscAmt),
      numOrNull(netData.vatAmt ?? netData.VatAmt),
      'O',                                   // PUR_TYPE — this screen is always Overseas
      null,                                  // RND_OFF  — set below from the figures
      null,                                  // EFF_RATE — set below
    ];

    // Expense lines with a code and a non-zero amount.
    const expLines = (Array.isArray(expData) ? expData : [])
      .filter((r) => r && strOrNull(r.expCode) && numOrNull(r.amount))
      .map((r) => [strOrNull(r.expCode), numOrNull(r.amount)]);

    const lines = itemsData.filter((r) => strOrNull(r.ITEM_CODE));
    const keepSrNos = lines.map((r) => String(r.SR_NO ?? '').trim());
    const canPrune = keepSrNos.length > 0 && keepSrNos.every((s) => s !== '');
    const itemRest = lines.map((r) => [
      r.SR_NO, strOrNull(r.ITEM_CODE), numOrNull(r.QTY), numOrNull(r.COST_FC), numOrNull(r.UNIT_COST),
    ]);
    if (!itemRest.length) return res.status(400).json({ message: 'No item lines to save' });

    // ── Figures for the G/L (same arithmetic as the screen) ──
    const invAmtFc = numOrNull(netData.InvAmtFc) || 0;
    const convRt   = numOrNull(netData.ConvRt) || 0;
    const expTotal = expLines.reduce((s, e) => s + (Number(e[1]) || 0), 0);
    const amtLocal = round2(invAmtFc * convRt);
    const effRate  = ((invAmtFc || 1) * convRt + expTotal) / (invAmtFc || 1);
    const itemsTot = round2(lines.reduce((s, r) => s + (numOrNull(r.QTY) || 0) * (numOrNull(r.COST_FC) || 0) * effRate, 0));
    const discount = round2(numOrNull(netData.discAmt ?? netData.DiscAmt) || 0);
    const netAmt   = round2(itemsTot - discount);
    // Dr side = Net Amount + Discount = Items Total; Cr side = Amount Local + expenses.
    // Whatever is left between them is the round off (+ = Dr, − = Cr).
    const rndOff   = round2(amtLocal + expTotal - itemsTot);
    hdrRest[9]  = amtLocal;                // INV_AMOUNT_LOCAL — always Inv.Amount F.C × Rate
    hdrRest[15] = rndOff;                  // RND_OFF
    hdrRest[16] = Math.round(effRate * 10000) / 10000;   // EFF_RATE (decimal 12,4)

    // ADD: plain INSERT; if the number was taken meanwhile, take the next free one.
    const claim = async (conn) => {
      let no = clientPjvNo;
      for (let i = 0; i < MAX_CLAIMS; i++) {
        try {
          await q(conn, HDR_INSERT, [no, ...hdrRest]);
          return no;
        } catch (e) {
          if (!isDup(e)) throw e;
          no = await nextFrgnPjvNo(conn, true);
        }
      }
      throw new Error('Could not allocate a free Voucher No — please try Save again');
    };

    connection.getConnection(async (err, conn) => {
      if (err) {
        console.error('[save-frgnpurch] getConnection:', err);
        return res.status(500).json({ message: 'Error getting connection' });
      }
      try {
        await begin(conn);

        let pjvNo;
        if (mode === 'ADD') {
          pjvNo = await claim(conn);
        } else {
          pjvNo = clientPjvNo;
          await q(conn, HDR_UPSERT, [pjvNo, ...hdrRest]);
        }

        await q(conn, 'DELETE FROM lcst_trn WHERE VCHR_NO = ?', [pjvNo]);
        if (expLines.length) {
          await q(conn, 'INSERT INTO lcst_trn (VCHR_NO, GIT_TYPE, AMOUNT) VALUES ?',
            [expLines.map((e) => [pjvNo, ...e])]);
        }

        if (canPrune) {
          await q(conn, 'DELETE FROM pur_frgn_items WHERE PJV_NO = ? AND SR_NO NOT IN (?)', [pjvNo, keepSrNos]);
        }
        await q(conn, ITEMS_UPSERT, [itemRest.map((r) => [pjvNo, ...r])]);

        await postFrgnPurchase(conn, {
          pjvNo, pjvDate: netData.PjvDt || null,
          drCode: strOrNull(netData.DrCd), supCode: strOrNull(netData.SupCd),
          netAmt, amtLocal, expLines, discount, rndOff,
          narration: strOrNull(netData.Narration), invNo: strOrNull(netData.InvNo), srvNo: strOrNull(netData.SrvNo),
        });

        await commit(conn);
        res.json({ message: 'Data saved successfully!', pjvNo, renumbered: pjvNo !== clientPjvNo });
      } catch (error) {
        console.error('[save-frgnpurch] failed, rolled back:', error);
        await rollback(conn);
        res.status(500).json({
          message: 'Foreign Purchase save failed, rolled back',
          error: error && error.sqlMessage ? error.sqlMessage : (error && error.message) || error,
        });
      } finally {
        conn.release();
      }
    });
  });

  return router;
};
