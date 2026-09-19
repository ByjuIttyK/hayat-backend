// ---------------------------------------------------------------------------
// ADD THIS INSIDE routes/vatPurchaseReport.js
// (after the existing router.get("/vat-purchase-report", ...) block,
//  just before `return router;`)
// ---------------------------------------------------------------------------

  // Column definitions for the PUR_REG grid, driven by column_metadata
  router.get("/vat-purchase-report/columns", (req, res) => {
    const sql = `
      SELECT column_id, field, header_name, sortable, editable, flex, cell_style
      FROM column_metadata
      WHERE module_name = 'PUR_REG'
      ORDER BY column_id`;

    connection.getConnection((err, conn) => {
      if (err) {
        console.error("vat-purchase-report/columns: pool error", err);
        return res.status(500).json({ error: "Database connection failed" });
      }

      conn.query(sql, (qErr, rows) => {
        conn.release();
        if (qErr) {
          console.error("vat-purchase-report/columns: query error", qErr);
          return res.status(500).json({ error: "Failed to load column metadata" });
        }

        const cols = rows.map((r) => {
          let cellStyle = null;
          try {
            cellStyle = r.cell_style ? JSON.parse(r.cell_style) : null;
          } catch (e) {
            cellStyle = null;
          }
          return {
            column_id: r.column_id,
            field: r.field,
            header_name: r.header_name,
            sortable: !!r.sortable,
            editable: !!r.editable,
            flex: Number(r.flex || 1),
            cell_style: cellStyle,
          };
        });

        res.json(cols);
      });
    });
  });
