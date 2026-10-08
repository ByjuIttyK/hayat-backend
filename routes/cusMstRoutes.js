// routes/cusMstRoutes.js
// ─────────────────────────────────────────────────────────────────────────────
// Customer Master (CusEnt.tsx) — all routes for the screen in one file.
//
//   GET  /api/cus-dd/salesmen  → [{ SMAN_CODE, SMAN_NAME }]      from sman_mst
//   GET  /api/cus-dd/nations   → [{ NATION_CODE, NATION_NAME }]  from nation_mst
//   POST /api/save-customer    → insert / update cus_mst
//
// Register in HayatDb.js (one line, replaces cusDropLists and the old
// app.post("/api/save-customer") block):
//   app.use(require("./routes/cusMstRoutes")(connection));
// Table names are lower-case to match the VPS (case-sensitive on Linux).
// ─────────────────────────────────────────────────────────────────────────────
const express = require("express");

// ── Columns the Customer Master screen edits ────────────────────────────────
// The payload may carry every cus_mst column (the screen loads the whole row),
// but anything not listed here is ignored, so:
//   • blank DATE columns such as PP_EXPIRY / VISA_EXPIRY are never sent as ''
//     (the ER_TRUNCATED_WRONG_VALUE error), and
//   • on EDIT, columns this screen doesn't show (OP_BAL, CONTACT_PR, PP_FILE…)
//     keep their stored values untouched.
const CUS_SAVE_COLS = [
    "CUST_CODE", "CUST_NAME",
    "CUST_ADR1", "CUST_ADR2", "CUST_ADR3", "CUST_ADR4",
    "CUS_TEL1", "CUS_FAX1", "EMAIL", "CN_CODE",
    "PAYMENT_TERMS", "CR_LIMIT", "CR_TERMS", "VAT_REG_NO",
    "SMAN_CODE", "NATION_CODE", "CUS_QUOTE_LIMIT",
    "CUS_LICENSE_FILE", "CUS_LICENSE_EXPIRY", "CUS_LIC_EXP_ALLOW", "BLOCK_DO",
];
const CUS_DATE_COLS = new Set(["CUS_LICENSE_EXPIRY"]);
const CUS_NUM_COLS = new Set(["CR_LIMIT", "CUS_QUOTE_LIMIT"]);

// '' / undefined → NULL for dates, 0 for amounts; text stays as typed.
const cusVal = (col, v) => {
    if (CUS_DATE_COLS.has(col)) {
        if (v === undefined || v === null || String(v).trim() === "") return null;
        return String(v).slice(0, 10);                 // yyyy-MM-dd
    }
    if (CUS_NUM_COLS.has(col)) {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
    }
    return v === undefined || v === null ? "" : String(v);
};

module.exports = (connection) => {
    const router = express.Router();

    // ── Salesman list ── SMAN_ACTIVE is NULL on existing rows, so only an
    //    explicit 'N' is excluded.
    router.get("/api/cus-dd/salesmen", (req, res) => {
        connection.query(
            `SELECT SMAN_CODE, TRIM(SMAN_NAME) AS SMAN_NAME
               FROM sman_mst
              WHERE IFNULL(SMAN_ACTIVE, 'Y') <> 'N'
              ORDER BY SMAN_CODE`,
            (err, rows) => {
                if (err) {
                    console.error("[cus-dd/salesmen]", err.message);
                    return res.status(500).json({ error: err.message });
                }
                res.json(rows);
            }
        );
    });

    // ── Nation list ──
    router.get("/api/cus-dd/nations", (req, res) => {
        connection.query(
            `SELECT NATION_CODE, TRIM(NATION_NAME) AS NATION_NAME
               FROM nation_mst
              ORDER BY NATION_NAME`,
            (err, rows) => {
                if (err) {
                    console.error("[cus-dd/nations]", err.message);
                    return res.status(500).json({ error: err.message });
                }
                res.json(rows);
            }
        );
    });

    // ── Save customer (ADD and EDIT) ──
    router.post("/api/save-customer", (req, res) => {
        const b = req.body || {};
        const code = String(b.CUST_CODE || "").trim();
        if (!code) return res.status(400).json({ error: "Customer Code is required" });

        const values = CUS_SAVE_COLS.map(c => (c === "CUST_CODE" ? code : cusVal(c, b[c])));
        const updates = CUS_SAVE_COLS
            .filter(c => c !== "CUST_CODE")
            .map(c => `${c} = VALUES(${c})`)
            .join(", ");

        const sql =
            `INSERT INTO cus_mst (${CUS_SAVE_COLS.join(", ")})
             VALUES (${CUS_SAVE_COLS.map(() => "?").join(", ")})
             ON DUPLICATE KEY UPDATE ${updates}`;

        connection.query(sql, values, (err, result) => {
            if (err) {
                console.error("[save-customer]", err.code, err.sqlMessage);
                return res.status(500).json({ error: err.sqlMessage || err.message });
            }
            res.json({ ok: true, custCode: code, affectedRows: result.affectedRows });
        });
    });

    return router;
};
