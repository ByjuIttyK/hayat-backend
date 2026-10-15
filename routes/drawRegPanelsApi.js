// routes/drawRegPanelsApi.js
// Register in HayatDb.js:
//   const drawRegPanelsApi = require("./routes/drawRegPanelsApi");
//   app.use("/api", drawRegPanelsApi(connection));

const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  // Panels of one Drawing Register record (HDR_ROW_ID = drawing_register.srno_row_id)
  router.get("/drawreg-panels/:hdrId", (req, res) => {
    const hdrId = Number(req.params.hdrId);
    if (!hdrId) return res.json([]);

    const sql = `SELECT srno_row_id, SR_NO, QUOT_SR_NO, ITEM_CODE, QTY,
                        PANEL_DETAILS, DRAWING_NO, REV_NO
                   FROM drawing_reg_panel
                  WHERE HDR_ROW_ID = ?
                  ORDER BY SR_NO`;

    connection.query(sql, [hdrId], (err, rows) => {
      if (err) {
        console.error("drawreg-panels:", err.message);
        return res.status(500).json({ error: err.message });
      }
      res.json(rows);
    });
  });

  return router;
};
