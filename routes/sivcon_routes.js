// fa_routes.js
const express = require('express');

module.exports = function (connection) {
  const router = express.Router();

  router.get('/sivlstcon/:dys', function (req, res) {
   
  connection.query(
    "select a.SIV_NO,DATE_FORMAT(a.SIV_DATE,'%d/%m/%y')  as SIV_DATE, a.COST_CODE," +
    " b.CUST_NAME, a.NARRATION, a.JOB_NO " +
    " from siv_hdr_cons a left outer join cus_mst b  ON (a.CUST_CODE = b.CUST_CODE) " +
    " where   a.SIV_DATE  >= CURDATE() - INTERVAL ? DAY " +
    "  ORDER BY a.SIV_NO DESC",
    [req.params.dys],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //console.log("Oracle LPOLST", result);
        res.json(result);

      }
    }
  );
  });


router.get("/sivhdr-con/:siv", function (req, res) {

  connection.execute(
    "select a.SIV_NO,DATE_FORMAT(a.SIV_DATE,'%d/%m/%y') SIV_DATE, a.CUST_CODE," +
    " b.CUST_NAME, a.NARRATION, a.JOB_NO" +
    " from siv_hdr_cons a left join  cus_mst b  on (a.CUST_CODE =b.CUST_CODE) where  a.SIV_NO= ? ",
    [req.params.siv],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        // console.log("Oracle SIVHDR Read", result.rows);
        res.json(result);
      }
    }
  );
});

router.get("/sivitems-con/:siv", function (req, res) {

  console.log('SIV Items. ');

  connection.execute(
    "select a.SIV_NO,DATE_FORMAT(a.SIV_DATE,'%d/%m%y') SIV_DATE, a.LOC_CODE," +
    "a.ITEM_CODE, b.ITEM_NAME1, a.QTY, a.SR_NO, a.STD_COST " +
    " from siv_items_cons a Left outer join item_mst_cons b on ( a.ITEM_CODE =b.ITEM_CODE) where   a.SIV_NO= ? ORDER by lpad(a.Sr_no ,3,'0')",
    [req.params.siv],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        console.log("Oracle SIVItems", result);
        res.json(result);

      }
    }
  );
});


router.post("/save-siv-con", async (req, res) => {
  try {
    console.log("SIV CONS Save ==>", req.body);
    const { netData, itemsData } = req.body;
    if (!netData || !itemsData || !Array.isArray(itemsData) || itemsData.length === 0) {
      return res.status(400).json({ message: "Invalid SIV data format" });
    }

    // Anchor for both the header and the DELETE. Taken from netData, which is
    // where the item rows get their SIV_NO from anyway (see the values map
    // below), so there is only one source of truth for it.
    const sivNo = String(netData.SivNo ?? "").trim();
    if (!sivNo) {
      return res.status(400).json({ message: "SIV No is required" });
    }

    // The SR_NO list to KEEP — everything else on this SIV is deleted.
    //
    // Every row must carry one. A row without an SR_NO is indistinguishable
    // from a row the user deleted, so the DELETE could remove a line that is
    // still on screen. In that case the prune is skipped and the save falls
    // back to upsert-only: a stale row survives, which a second save fixes,
    // whereas a wrongly deleted issue line is gone.
    const keepSrNos = itemsData.map(r =>
      r.SR_NO === null || r.SR_NO === undefined ? "" : String(r.SR_NO).trim());
    const canPrune = keepSrNos.every(s => s !== "");
    if (!canPrune) {
      console.warn("save-siv: a line arrived without SR_NO — skipping the prune of removed rows",
        { sivNo });
    }

    console.log("siv_hdr ==>", netData);
    console.log("siv_items Items ==>", itemsData);
    connection.getConnection((err, conn) => {
      if (err) {
        console.error("Error getting connection:", err);
        return res.status(500).json({ message: "Error getting connection" });
      }

      conn.beginTransaction(async (err) => {
        if (err) {
          console.error("Transaction Error:", err);
          conn.release();
          return res.status(500).json({ message: "Transaction error", error: err });
        }

        try {
          // ✅ Step 1: Insert/Update siv_hdr
           // ✅ Step 1: Insert/Update siv_hdr
          //
          // Column list matches siv_hdr as it actually is: SIV_NO, SIV_DATE,
          // INV_NO, DO_NO, CUST_CODE, NARRATION, JOB_NO, LOC_CODE, PANEL_NO,
          // SIV_TYPE, COST_CODE, STOCK_CODE. There is NO amount column — the
          // header figure is derived from SUM(QTY * STD_COST) over siv_items,
          // so netData.Amount is deliberately not written anywhere.
          const netQuery = `
  INSERT INTO siv_hdr_cons
    (SIV_NO, SIV_DATE, JOB_NO,  CUST_CODE, NARRATION, SIV_TYPE)
  VALUES (?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    SIV_DATE  = VALUES(SIV_DATE),
    JOB_NO    = VALUES(JOB_NO),
    CUST_CODE = VALUES(CUST_CODE),
    NARRATION = VALUES(NARRATION),
    SIV_TYPE  = VALUES(SIV_TYPE)`;

          // siv_hdr.SIV_TYPE is varchar(1): 'M' = Materials (panel-charged),
          // 'C' = Consumables (job-level, PANEL_NO null). Clamped to one char
          // so a longer value can't be truncated by MySQL or rejected under
          // strict mode.
          const sivType = String(netData.SivType || "M").toUpperCase().charAt(0);

          // A consumables issue has no panel. The screen already sends null;
          // normalising here also stops an empty string landing in PANEL_NO
          // as '' from any other caller.

          // SivEnt does not send CustCd, so this is undefined — and mysql2
          // rejects undefined bind parameters outright ("Bind parameters must
          // not contain undefined"). Coerced to null so the column simply
          // stays empty, which is what it was before this screen existed.
          const custCode = netData.CustCd ?? null;

          await new Promise((resolve, reject) => {
            conn.query(
              netQuery,
              [
                sivNo, netData.SivDt, netData.JobNo,
                custCode, netData.Narration, sivType
              ],
              (err, result) => {
                if (err) return reject(err);
                console.log("Siv_hdr Insert/Update:", result);
                resolve(result);
              }
            );
          });
          // ✅ Step 2: Delete the lines removed from the grid
          //
          // Before the upsert, not after: an SR_NO reused within the same save
          // (line 003 deleted, a new item keyed into that slot) would otherwise
          // be written and then deleted again, because it is absent from the
          // keep-list under its old identity.
          //
          // The nested array is deliberate — the driver flattens one level per
          // placeholder, so [sivNo, keepSrNos] gives a scalar for the first ?
          // and an expanded ('001','002',…) list for the second.
          if (canPrune) {
            const delQuery =
              "DELETE FROM siv_items_cons WHERE SIV_NO = ? AND SR_NO NOT IN (?)";
            await new Promise((resolve, reject) => {
              conn.query(delQuery, [sivNo, keepSrNos], (err, result) => {
                if (err) return reject(err);
                console.log("siv_items removed lines:", result.affectedRows);
                resolve(result);
              });
            });
          }

          // ✅ Step 3: Insert/Update siv_items
          const itemsQuery = `
              INSERT INTO siv_items_cons(SIV_NO,SIV_DATE,SR_NO,ITEM_CODE,QTY,STD_COST)
              VALUES ? 
              ON DUPLICATE KEY UPDATE 
              SIV_DATE  = VALUES(SIV_DATE), 
              ITEM_CODE = VALUES(ITEM_CODE),
              QTY       = VALUES(QTY), 
              STD_COST  = VALUES(STD_COST);
            `;
          // SIV_NO and SR_NO are gone from the UPDATE list: they are the key
          // that matched the row in the first place, so assigning them back to
          // themselves does nothing.
          //
          // COALESCE is gone from the rest. It made clearing a value
          // impossible — issuing a corrected QTY of 0, or blanking a cost,
          // sent NULL and COALESCE quietly restored the old figure, so the
          // screen and the table disagreed with no error anywhere.
          const values = itemsData.map(row => [
            sivNo, netData.SivDt, row.SR_NO, row.ITEM_CODE,
            row.QTY, row.STD_COST
          ]);

          await new Promise((resolve, reject) => {
            conn.query(itemsQuery, [values], (err, result) => {
              if (err) return reject(err);
              console.log("siv_items Insert/Update:", result);
              resolve(result);
            });
          });

          conn.commit((err) => {
            if (err) {
              console.error("Commit Error:", err);
              // The old version returned here without releasing, so every
              // failed commit cost the pool a connection permanently.
              return conn.rollback(() => {
                conn.release();
                res.status(500).json({ message: "Commit error", error: err });
              });
            }
            conn.release();
            res.json({ message: "S.I.V (Consu) saved successfully!" });
          });

        } catch (error) {
          console.error("S.I.V (Consu) Transaction Failed:", error);
          conn.rollback(() => {
            conn.release();
            res.status(500).json({ message: "SIV Consu.Transaction failed, rolled back", error });
          });
        }
      });
    });
  } catch (error) {
    console.log("SIV  Consu. save - internal error :", error)
    res.status(500).json({ message: "Internal Server Error (SIV)", error });
  }
});
 

  return router;
};