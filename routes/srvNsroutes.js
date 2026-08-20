// fa_routes.js
const express = require('express');

module.exports = function (connection) {
  const router = express.Router();

  router.get('/srvlstns/:dys', function (req, res) {
  
  connection.query(
    "select a.SRV_NO,DATE_FORMAT(a.SRV_DATE,'%d/%m/%y') SRV_DATE, a.SUP_CODE," +
    " b.SUP_NAME, a.NARRATION, a.po_no as LPO_NO, a.INV_NO, a.INV_DATE" +
    " from srv_hdr_ns a LEFT OUTER JOIN  sup_mst b  ON (a.SUP_CODE = b.SUP_CODE) " +
    " where  a.SRV_DATE  >= CURDATE() - INTERVAL ? DAY and " +
    " a.SUP_CODE = b.SUP_CODE ORDER BY a.SRV_NO DESC",
    [req.params.dys],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        console.log("srv list", result);
        res.json(result);
      }
    }
  );
});

router.get("/srvhdrns/:srv", function (req, res) {

  //console.log('SRV Hdr. no'||srv);

  connection.query(
    "select a.SRV_NO,DATE_FORMAT(a.SRV_DATE,'%d/%m/%y') SRV_DATE, a.SUP_CODE," +
    " b.SUP_NAME, a.NARRATION, a.PO_NO as LPO_NO, a.INV_NO, a.INV_DATE " +
    " from srv_hdr_ns a, sup_mst b where a.SUP_CODE =b.SUP_CODE and  a.SRV_NO= ? ",
    [req.params.srv],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //    console.log("Oracle SRVHDR Read Data", result.rows);
        res.json(result);

      }
    }
  );
});

router.get("/srvitemsns/:srv", function (req, res) {

  connection.query(
    "select a.SRV_NO,DATE_FORMAT(a.SRV_DATE,'%d/%m/%y') AS SRV_DATE, a.LOC_CODE," +
    "a.ITEM_CODE, b.ITEM_NAME1, a.QTY, a.SR_NO, a.COST as RATE, a.SRV_UNIT as UOM" +
    " from srv_items_ns a left outer join  item_mst b on (a.ITEM_CODE =b.ITEM_CODE) where  a.SRV_NO= ? ORDER by a.Sr_no ",
    [req.params.srv],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //   console.log(" SRVItems", result);
        res.json(result)

      }
    }
  );
});

router.post("/save-srv-ns", async (req, res) => {
  try {
    console.log("SRV  NS Save ==>", req.body);
    const { netData, itemsData } = req.body;
    if (!netData || !itemsData || !Array.isArray(itemsData) || itemsData.length === 0) {
      return res.status(400).json({ message: "Invalid SRV data format" });
    }
    console.log("srv_hdr ==>", netData);
    console.log("SRV_ITEMS Items ==>", itemsData);
    connection.getConnection((err, conn) => {
      if (err) {
        console.error("Error getting connection:", err);
        return res.status(500).json({ message: "Error getting connection" });
      }

      conn.beginTransaction(async (err) => {
        if (err) {
          console.error("Transaction Error:", err);
          conn.release(); // Release the connection back to the pool
          return res.status(500).json({ message: "Transaction error", error: err });
        }

        try {
          // ✅ Step 1: Insert/Update srv_hdr table
          const netQuery = `INSERT INTO srv_hdr_ns (
          SRV_NO,SRV_DATE,PO_NO,SUP_CODE,NARRATION,INV_NO,INV_DATE )
                            VALUES ( ?, ?, ?, ?, ?, ?, ? )
          ON DUPLICATE KEY UPDATE
          SRV_DATE = VALUES(SRV_DATE),
          PO_NO = VALUES(PO_NO),
          SUP_CODE = VALUES(SUP_CODE),
          NARRATION = VALUES(NARRATION),
          INV_NO = VALUES(INV_NO),
          INV_DATE = VALUES(INV_DATE)
        `;
          await new Promise((resolve, reject) => {
            conn.query(
              netQuery,
              [
                netData.SrvNo, netData.SrvDt, netData.LpoNo, netData.SupCd,
                netData.Narration, netData.SupInvNo, netData.InvDt
              ],
              (err, result) => {
                if (err) {
                  return reject(err);
                }
                console.log("Srv_hdr Insert/Update:", result);
                resolve(result);
              }
            );
          });

          // ✅ Step 2: Insert/Update srv_items table
          const itemsQuery = `
              INSERT INTO srv_items_ns (SRV_NO,SRV_DATE,SR_NO,ITEM_CODE,QTY,COST)
              VALUES ? 
              ON DUPLICATE KEY UPDATE 
              SRV_NO= VALUES(SRV_NO),
              SRV_DATE = COALESCE(VALUES(SRV_DATE), SRV_DATE), 
              SR_NO = COALESCE(VALUES(SR_NO),SR_NO),
              ITEM_CODE = COALESCE(VALUES(ITEM_CODE),ITEM_CODE),
              QTY       = COALESCE(VALUES(QTY), QTY), 
              COST      = COALESCE(VALUES(COST), COST);
            `;
          const values = itemsData.map(row => [
            row.SRV_NO, row.SRV_DATE, row.SR_NO, row.ITEM_CODE,
            row.QTY, row.COST
          ]);

          await new Promise((resolve, reject) => {
            conn.query(itemsQuery, [values], (err, result) => {
              if (err) {
                return reject(err);
              }
              console.log("srv_items Insert/Update:", result);
              resolve(result);
            });
          });

          // ✅ Step 3: Delete rows removed on the client
          const srNos = itemsData
            .map(r => r.SR_NO)
            .filter(v => v !== null && v !== undefined && v !== "");

          const deleteQuery = srNos.length
            ? `DELETE FROM srv_items_ns WHERE SRV_NO = ? AND SR_NO NOT IN (?)`
            : `DELETE FROM srv_items_ns WHERE SRV_NO = ?`;

          const deleteParams = srNos.length
            ? [netData.SrvNo, srNos]
            : [netData.SrvNo];

          await new Promise((resolve, reject) => {
            conn.query(deleteQuery, deleteParams, (err, result) => {
              if (err) return reject(err);
              console.log("srv_items deleted:", result.affectedRows);
              resolve(result);
            });
          });


          conn.commit((err) => {
            if (err) {
              console.error("Commit Error:", err);
              return res.status(500).json({ message: "Commit error", error: err });
            }
            conn.release(); // Release the connection back to the pool
            res.json({ message: "S.R.V Non-Stock saved successfully!" });
          });

        } catch (error) {
          console.error("S.R.V NS Transaction Failed:", error);
          conn.rollback(() => {
            conn.release(); // Release the connection back to the pool
            res.status(500).json({ message: "SRV Transaction failed, rolled back", error });
          });
        };
      });
    });
  } catch (error) {
    console.log("SRV  NS save - internal error :", error)
    res.status(500).json({ message: "Internal Server Error (SRV)", error });
  }
});

  return router;
};