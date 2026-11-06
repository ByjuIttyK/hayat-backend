// GET /api/srvhdr/:srv — SRV header (local and foreign)
// 06-Nov-2026: returns the foreign-purchase columns added to srv_hdr
//   CURR_CODE, CONVERT_RATE, INV_AMT_FC, FREIGHT_FOB, INV_AMT_LOCAL, EXP_AMOUNT, EFF_RATE
// SRV_DATE stays DATE_FORMAT '%d/%m/%y' — SrvEnt / SrvEntFP parse it that way.
app.get("/api/srvhdr/:srv", function (req, res) {
  connection.query(
    "SELECT a.SRV_NO, DATE_FORMAT(a.SRV_DATE,'%d/%m/%y') SRV_DATE, a.SUP_CODE," +
    "       b.SUP_NAME, a.NARRATION, a.PO_NO AS LPO_NO, a.INV_NO, a.INV_DATE, a.INV_AMOUNT," +
    "       a.CURR_CODE, a.CONVERT_RATE," +
    "       a.INV_AMT_FC, a.FREIGHT_FOB, a.INV_AMT_LOCAL, a.EXP_AMOUNT, a.EFF_RATE" +
    "  FROM srv_hdr a, sup_mst b" +
    " WHERE a.SUP_CODE = b.SUP_CODE AND a.SRV_NO = ?",
    [req.params.srv],
    function (err, result) {
      if (err) {
        // a bad request must not take the whole server down (was: throw err)
        console.error("srvhdr:", err);
        return res.status(500).json({ error: err.sqlMessage || err.message });
      }
      res.json(result);
    }
  );
});
