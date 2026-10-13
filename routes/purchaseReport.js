// /api/purchaseReport — Supplier-wise / Item-wise purchase report (RepParamForm SUPPURGROUP)
// Replaces the existing app.get("/api/purchaseReport", ...) block in HayatDb.js.
//
// Changes from the old version:
//  • A SQL error no longer does `throw err` inside the callback — that killed the whole
//    Node process, so the report (and every other screen) just stopped responding.
//    It now returns 500 with the MySQL message, which shows in the browser's Network tab.
//  • View name in lower case (v_purchase_details) — required on the Linux VPS.
//  • Detail rows are ordered by the real PJV_DATE column, not the dd/mm/yyyy text alias.
//  • To-date includes the whole end day even if PJV_DATE carries a time.
//  • groupBy / groupType default to Party-wise / Summary when not passed.

app.get("/api/purchaseReport", (req, res) => {
  const { groupBy = "SUP", groupType = "SUM", start_date, end_date, ItemCd } = req.query;
  if (!start_date || !end_date) {
    return res.status(400).json({ error: "start_date and end_date are required" });
  }

  const bySup = String(groupBy).toUpperCase() !== "ITEM";      // SUP = Party wise, ITEM = Item wise
  const detail = String(groupType).toUpperCase() === "DTL";    // SUM = Summary, DTL = Detailed

  const keyCols = bySup
    ? "v.SUP_CODE, v.SUP_NAME, v.ITEM_CODE, v.ITEM_NAME"
    : "v.ITEM_CODE, v.ITEM_NAME, v.SUP_CODE, v.SUP_NAME";

  let selectCols, groupCols, orderCols;
  if (detail) {
    selectCols = `v.PJV_NO, DATE_FORMAT(v.PJV_DATE,'%d/%m/%Y') AS PJV_DATE, ${keyCols}, v.ITEM_UNIT`;
    groupCols = `v.PJV_NO, v.PJV_DATE, ${keyCols}, v.ITEM_UNIT, v.QTY, v.COST`;
    orderCols = `${bySup ? "v.SUP_CODE" : "v.ITEM_CODE"}, v.PJV_DATE, v.PJV_NO, ${bySup ? "v.ITEM_CODE" : "v.SUP_CODE"}`;
  } else {
    selectCols = keyCols;
    groupCols = keyCols;
    orderCols = keyCols;
  }

  // Code box on the parameter screen: supplier code when Party wise, item code when Item wise
  const code = String(ItemCd || "").trim();
  const codeFilter = code ? (bySup ? " AND v.SUP_CODE = ?" : " AND v.ITEM_CODE = ?") : "";
  const params = code ? [start_date, end_date, code] : [start_date, end_date];

  const sql =
    `SELECT ${selectCols},
            SUM(v.QTY) AS TOTAL_QTY, MAX(v.COST) AS COST, SUM(v.AMOUNT) AS TOTAL_AMOUNT,
            SUM(v.DISC_AMT) AS TOTAL_DISC, SUM(v.VAT_AMOUNT) AS TOTAL_VAT, SUM(v.NET_AMOUNT) AS NET_AMOUNT
       FROM v_purchase_details v
      WHERE v.PJV_DATE >= ? AND v.PJV_DATE < DATE_ADD(?, INTERVAL 1 DAY)${codeFilter}
      GROUP BY ${groupCols}
      ORDER BY ${orderCols}`;

  connection.query(sql, params, (err, rows) => {
    if (err) {
      console.error("purchaseReport:", err.sqlMessage || err.message, "\n", sql, params);
      return res.status(500).json({ error: err.sqlMessage || err.message });
    }
    console.log(`purchaseReport ${bySup ? "SUP" : "ITEM"}/${detail ? "DTL" : "SUM"} ${start_date}..${end_date} ${code || "(all)"}: ${rows.length} rows`);
    res.json(rows);
  });
});
