// Item Sub Category helper routes
// Register in HayatDb.js:  app.use("/api", require("./routes/subCatMstRoutes")(connection));
// (or paste the two router.get blocks into the route file that already has save-subcatmst)
const express = require("express");

module.exports = function (connection) {
    const router = express.Router();

    // Category dropdown — cat_mst (location 01)
    router.get("/subcat/cat-list", (req, res) => {
        const sql = `SELECT CAT_CODE, CAT_NAME
                       FROM cat_mst
                      WHERE LOC_CODE = '01'
                      ORDER BY CAT_CODE`;
        connection.query(sql, (err, rows) => {
            if (err) {
                console.error("cat-list error:", err);
                return res.status(500).json({ error: err.message });
            }
            res.json(rows);
        });
    });

    // Next available SUB_CAT_CODE for a category: LPAD(MAX+1, 2, '0')
    // Only numeric codes are considered; NULL / non-numeric codes are ignored.
    router.get("/subcat/next-code/:catCode", (req, res) => {
        const sql = `SELECT LPAD(IFNULL(MAX(CAST(SUB_CAT_CODE AS UNSIGNED)), 0) + 1, 2, '0') AS NEXT_CODE
                       FROM item_subcat
                      WHERE CAT_CODE = ?
                        AND SUB_CAT_CODE REGEXP '^[0-9]+$'`;
        connection.query(sql, [req.params.catCode], (err, rows) => {
            if (err) {
                console.error("next-code error:", err);
                return res.status(500).json({ error: err.message });
            }
            res.json({ NEXT_CODE: rows[0]?.NEXT_CODE || "01" });
        });
    });

    // ---- Save (ADD / EDIT) ----
    const q = (sql, params = []) =>
        new Promise((resolve, reject) =>
            connection.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
        );

    const nextCodeSql = `SELECT LPAD(IFNULL(MAX(CAST(SUB_CAT_CODE AS UNSIGNED)), 0) + 1, 2, '0') AS NEXT_CODE
                           FROM item_subcat
                          WHERE CAT_CODE = ?
                            AND SUB_CAT_CODE REGEXP '^[0-9]+$'`;

    router.post("/save-subcatmst", async (req, res) => {
        const { Pmode, CAT_CODE, SUB_CAT_NAME } = req.body;
        let { SUB_CAT_CODE } = req.body;

        if (!CAT_CODE || !SUB_CAT_NAME) {
            return res.status(400).json({ error: "Catg. Code and Sub Catg. Name are required" });
        }

        try {
            if (Pmode === "ADD") {
                SUB_CAT_CODE = String(SUB_CAT_CODE || "").trim().padStart(2, "0");

                // item_subcat has no PK, so check for a clash ourselves;
                // if the code was taken meanwhile, give the next free one
                const dup = await q(
                    `SELECT 1 FROM item_subcat WHERE CAT_CODE = ? AND SUB_CAT_CODE = ? LIMIT 1`,
                    [CAT_CODE, SUB_CAT_CODE]
                );
                let reassigned = false;
                if (dup.length) {
                    const r = await q(nextCodeSql, [CAT_CODE]);
                    SUB_CAT_CODE = r[0]?.NEXT_CODE || "01";
                    reassigned = true;
                }

                await q(
                    `INSERT INTO item_subcat (CAT_CODE, SUB_CAT_CODE, SUB_CAT_NAME) VALUES (?, ?, ?)`,
                    [CAT_CODE, SUB_CAT_CODE, SUB_CAT_NAME]
                );
                return res.json({ success: true, SUB_CAT_CODE, reassigned });
            }

            if (Pmode === "EDIT") {
                // codes are locked on the screen; only the name changes.
                // <=> matches old rows where SUB_CAT_CODE is NULL
                const r = await q(
                    `UPDATE item_subcat
                        SET SUB_CAT_NAME = ?
                      WHERE CAT_CODE = ?
                        AND SUB_CAT_CODE <=> ?`,
                    [SUB_CAT_NAME, CAT_CODE, SUB_CAT_CODE || null]
                );
                return res.json({ success: true, affectedRows: r.affectedRows });
            }

            res.status(400).json({ error: "Invalid mode" });
        } catch (err) {
            console.error("save-subcatmst error:", err);
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
