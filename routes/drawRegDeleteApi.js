// routes/drawRegDeleteApi.js
// Delete one Drawing Register record and its panels, from the Drawing List
// (InfoGrid/DRAWREG) Delete button.
// Register in HayatDb.js:
//   const drawRegDeleteApi = require("./routes/drawRegDeleteApi");
//   app.use("/api", drawRegDeleteApi(connection));
//
// DELETE /api/drawing-register/:id      (:id = drawing_register.SRNO_ROW_ID, the "Rec. Id")
//   → { message, drawingNo, panelsDeleted }
//
// The record is addressed by SRNO_ROW_ID, not DRAWING_NO: older drawing
// numbers are shared by several records, and deleting by number would take
// the other records (and their panels) with it.
// Panels go first, then the header, in one transaction — a failure leaves both.

const express = require("express");

// Column in drawing_reg_panel that holds the header's srno_row_id.
const PANEL_HDR_COL = "HDR_ROW_ID";

module.exports = function (connection) {
  const router = express.Router();

  const getConn = () =>
    new Promise((resolve, reject) =>
      connection.getConnection((err, conn) => (err ? reject(err) : resolve(conn))));
  const q = (conn, sql, params) =>
    new Promise((resolve, reject) =>
      conn.query(sql, params, (err, result) => (err ? reject(err) : resolve(result))));

  router.delete("/drawing-register/:id", async (req, res) => {
    const id = String(req.params.id ?? "").trim();
    if (!/^\d+$/.test(id)) {
      return res.status(400).json({ message: "A valid Rec. Id is required" });
    }

    let conn;
    try {
      conn = await getConn();
      await q(conn, "START TRANSACTION");

      const hdr = await q(
        conn,
        "SELECT DRAWING_NO FROM drawing_register WHERE SRNO_ROW_ID = ? FOR UPDATE",
        [id]
      );
      if (!hdr.length) {
        await q(conn, "ROLLBACK");
        return res.status(404).json({ message: `Drawing record ${id} not found` });
      }

      const pnl = await q(
        conn,
        `DELETE FROM drawing_reg_panel WHERE \`${PANEL_HDR_COL}\` = ?`,
        [id]
      );
      const del = await q(conn, "DELETE FROM drawing_register WHERE SRNO_ROW_ID = ?", [id]);

      await q(conn, "COMMIT");
      const drawingNo = hdr[0].DRAWING_NO;
      console.log(`drawing_register ${id} (${drawingNo}) deleted; panels: ${pnl.affectedRows}`);
      res.json({
        message: `Drawing ${drawingNo} deleted (${pnl.affectedRows} panel line(s))`,
        drawingNo,
        panelsDeleted: pnl.affectedRows,
        headerDeleted: del.affectedRows,
      });
    } catch (err) {
      if (conn) await q(conn, "ROLLBACK").catch(() => {});
      console.error("drawing-register delete failed:", err);
      res.status(500).json({ message: err.sqlMessage || "Delete failed, nothing was removed" });
    } finally {
      if (conn) conn.release();
    }
  });

  return router;
};
