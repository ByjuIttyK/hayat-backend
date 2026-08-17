// ---------------------------------------------------------------------------
// sinqLovRoutes.js — LOV endpoints for the Sales Inquiry (RFQ) screen.
//
// Serves the shape SalesInquiryEnt.tsx already expects from its LovModal:
//     GET /api/lov/:lovType?search=<term>   ->   [ { code, label }, ... ]
//
// Cooperates with whatever generic /api/lov/:lovType handler you already have
// (the one currently serving `customer`, `employee`, `salesman`, `engineer`,
// `reason`): any lovType not in LOV_MAP below falls through via next(), so the
// existing handler still gets its turn. That does mean MOUNT ORDER MATTERS —
// see the mounting note at the bottom of this file.
//
// TABLE NAME CASING: every table here is lowercase, which is how they are
// actually stored (information_schema.TABLES confirms inq_type_mst,
// sales_inquiry_status, sinq_compliance_mst, sinq_loc_mst, sinq_rcpt_mst).
// A `DESC SINQ_LOC_MST` succeeds on Windows because MySQL there runs
// lower_case_table_names=1 and folds the comparison — but the VPS runs
// lower_case_table_names=0, where an uppercase spelling would fail outright.
// Column names ARE case-insensitive in MySQL, so those stay as DESC showed
// them. Don't "tidy" these table names to match the column style.
// ---------------------------------------------------------------------------

const express = require("express");

// lovType -> where to read it from. `extra` columns are appended to each row
// as-is, which is how CONTACT_PR can ride along on a LOV row if you ever want
// the same trick for another master.
const LOV_MAP = {
    // Customer  (screen: CUST_CODE) — CONTACT_PR rides along on every row so
    // the RFQ screen can fill Contact Details straight from the picked row,
    // with no second round trip. Adding this entry means this file now serves
    // `customer` instead of your existing handler; if that one applies filters
    // this query doesn't (a cancelled/inactive flag, a branch restriction),
    // copy them into the `where` below or delete this entry and add CONTACT_PR
    // to your own handler's SELECT instead.
    customer: {
        table: "cus_mst",
        codeCol: "CUST_CODE",
        labelCol: "CUST_NAME",
        extra: ["CONTACT_PR"],
        orderBy: "CUST_NAME",
    },

    // Enquiry Status  (screen: SINQ_STAT)
    "inq-status": {
        table: "sales_inquiry_status",
        codeCol: "STAT_CODE",
        labelCol: "STAT_DESC",
    },

    // Enq Type  (screen: INQ_TYPE)
    "inq-type": {
        table: "inq_type_mst",
        codeCol: "INQ_TYPE_CODE",
        labelCol: "INQ_TYPE_DESC",
    },

    // Form Of Enquiry — how the enquiry was received  (screen: JOB_TYPE_CODE).
    // Registered under both names: "job-type" is what the screen currently
    // passes as lovType, "form-of-enquiry" is the honest name if you rename it.
    "job-type": {
        table: "sinq_rcpt_mst",
        codeCol: "RCP_CODE",
        labelCol: "RCP_DESC",
    },
    "form-of-enquiry": {
        table: "sinq_rcpt_mst",
        codeCol: "RCP_CODE",
        labelCol: "RCP_DESC",
    },

    // Compliance  (screen: INQ_COMPLIANCE)
    compliance: {
        table: "sinq_compliance_mst",
        codeCol: "CMPL_CODE",
        labelCol: "CMPL_NAME",
    },

    // Location  (screen: SINQ_LOC)
    location: {
        table: "sinq_loc_mst",
        codeCol: "SINQ_LOC_CODE",
        labelCol: "SINQ_LOC_NAME",
    },
};

module.exports = function (connection) {
    const router = express.Router();

    // Registers each path twice so this file works whether you mount it as
    // app.use(sinqLovRoutes(connection)) or app.use("/api", sinqLovRoutes(connection)).
    const get = (path, handler) => {
        router.get(path, handler);
        router.get("/api" + path, handler);
    };

    // ── GET /api/lov/:lovType?search=term ────────────────────────────────
    get("/lov/:lovType", function (req, res, next) {
        const cfg = LOV_MAP[String(req.params.lovType || "").toLowerCase()];
        if (!cfg) return next(); // not ours — let the existing handler answer

        const term = String(req.query.search || "").trim();
        const like = `%${term}%`;

        // Identifiers come from LOV_MAP (never from the request), so they're
        // safe to interpolate; the search term stays parameterised.
        let sql =
            `SELECT ${cfg.codeCol} AS code, ${cfg.labelCol} AS label` +
            (cfg.extra ? `, ${cfg.extra.join(", ")}` : "") +
            ` FROM ${cfg.table}`;
        const params = [];

        if (term) {
            sql += ` WHERE ${cfg.codeCol} LIKE ? OR ${cfg.labelCol} LIKE ?`;
            params.push(like, like);
        }
        sql += ` ORDER BY ${cfg.orderBy || cfg.codeCol} LIMIT 500`;

        connection.query(sql, params, function (err, rows) {
            if (err) {
                console.error(`LOV ${req.params.lovType} (${cfg.table}) failed:`, err.message);
                return res.status(500).json({ message: err.message });
            }
            res.json(rows || []);
        });
    });

    // ── GET /api/cust-contact/:custCode ──────────────────────────────────
    // Feeds Contact Details on the RFQ screen from the customer master. The
    // column is CONTACT_PR (not CONTACT_PER / CONTACT_PERSON).
    get("/cust-contact/:custCode", function (req, res) {
        connection.query(
            "SELECT CUST_CODE, CUST_NAME, CONTACT_PR FROM cus_mst WHERE CUST_CODE = ?",
            [req.params.custCode],
            function (err, rows) {
                if (err) {
                    console.error("cust-contact failed:", err.message);
                    return res.status(500).json({ message: err.message });
                }
                // {} rather than 404 for an unknown code — the screen treats a
                // missing CONTACT_PR key as "leave the field alone".
                res.json((rows && rows[0]) || {});
            }
        );
    });

    return router;
};

// ---------------------------------------------------------------------------
// MOUNTING — in HayatDb.js:
//
//     const sinqLovRoutes = require("./routes/sinqLovRoutes");
//     app.use(sinqLovRoutes(connection));
//
// Put that line ABOVE whatever currently serves /api/lov/:lovType. Express
// matches in registration order, so if the existing generic handler is
// registered first it will answer `inq-status`, `customer` etc. itself (and
// return rows without CONTACT_PR) before this file is ever consulted. Mounted
// first, this file answers the six masters in LOV_MAP and next()s everything
// else through to the old handler, so `employee` / `salesman` / `engineer` /
// `reason` keep working exactly as they do now.
// ---------------------------------------------------------------------------
