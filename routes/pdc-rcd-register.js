// ---------------------------------------------------------------------------
// pdc-rcd-register.js
//
// Read-only register of PDC received cheques. A status switch selects the
// slice: every cheque, only those still on hand (REALISED <> 'Y'), or only
// those already reversed (REALISED = 'Y'). Feeds a standalone report screen
// with a cheque-date range plus optional Bank and Party filters, exported
// to PDF or Excel.
//
// Nothing here writes. Registering it alongside the reversal route:
//   const pdcRcdRegister = require("./routes/pdc-rcd-register");
//   app.use("/api/pdc-rcd-register", authMiddleware, pdcRcdRegister(connection));
// ---------------------------------------------------------------------------

const CONFIG = {
  accMst: { table: "acc_mst", code: "ACC_CODE", desc: "ACC_HEAD" },
  cusMst: { table: "cus_mst", code: "CUST_CODE", name: "CUST_NAME" },
  company: {
    table: "company",
    name: "NAME",
    place: "PLACE",
    address1: "ADDRESS1",
    address2: "ADDRESS2",
    phone: "PHONE",
    email: "EMAIL",
    website: "WEB_SITE",
  },
};

// The three slices the screen can ask for. Anything unrecognised falls back
// to "pending", which is the safe default: it never shows a reversed cheque
// as if it were still on hand.
const STATUS_SQL = {
  all:      "1 = 1",
  pending:  "(p.REALISED IS NULL OR p.REALISED <> 'Y')",
  reversed: "p.REALISED = 'Y'",
};

const STATUS_TITLE = {
  all:      "PDC Received Register",
  pending:  "Pending PDC Received",
  reversed: "Reversed PDC Received",
};

const resolveStatus = (s) =>
  Object.prototype.hasOwnProperty.call(STATUS_SQL, String(s || "").toLowerCase())
    ? String(s).toLowerCase()
    : "pending";

module.exports = function (connection) {
  const express = require("express");
  const router = express.Router();
  const db = connection.promise();

  // Company letterhead — read once and cached, same pattern as the
  // reversal route so both reports carry identical headings.
  let companyCache = null;
  const getCompany = async () => {
    if (companyCache) return companyCache;
    const { company } = CONFIG;
    try {
      const [rows] = await db.query(
        `SELECT ${company.name}     AS name,
                ${company.place}    AS place,
                ${company.address1} AS address1,
                ${company.address2} AS address2,
                ${company.phone}    AS phone,
                ${company.email}    AS email,
                ${company.website}  AS website
         FROM ${company.table} LIMIT 1`
      );
      const r = rows[0] || {};
      companyCache = {
        name: r.name || "",
        address: [r.address1, r.address2, r.place].filter(Boolean).join(", "),
        contact: [r.phone, r.email, r.website].filter(Boolean).join("  |  "),
      };
    } catch (err) {
      console.error("[pdc-rcd-register/company]", err.message);
      companyCache = { name: "", address: "", contact: "" };
    }
    return companyCache;
  };

  // -------------------------------------------------------------------------
  // GET /api/pdc-rcd-register/filters?status=all|pending|reversed
  // Dropdown sources — only banks and parties that actually appear on a
  // cheque in the selected slice, so the user can't pick a combination with
  // no rows. The screen re-reads this whenever the status switch changes.
  // -------------------------------------------------------------------------
  router.get("/filters", async (req, res) => {
    try {
      const { accMst, cusMst } = CONFIG;
      const status = resolveStatus(req.query.status);
      const statusSql = STATUS_SQL[status];

      const [banks] = await db.query(
        `SELECT DISTINCT
           p.CHQ_BANK                     AS code,
           COALESCE(a.${accMst.desc}, p.CHQ_BANK) AS name
         FROM pdc_rcd p
         LEFT JOIN ${accMst.table} a ON a.${accMst.code} = p.CHQ_BANK
         WHERE ${statusSql}
           AND p.CHQ_BANK IS NOT NULL AND p.CHQ_BANK <> ''
         ORDER BY name`
      );

      const [parties] = await db.query(
        `SELECT DISTINCT
           p.CUST_CODE                      AS code,
           COALESCE(c.${cusMst.name}, p.CUST_CODE) AS name
         FROM pdc_rcd p
         LEFT JOIN ${cusMst.table} c ON c.${cusMst.code} = p.CUST_CODE
         WHERE ${statusSql}
           AND p.CUST_CODE IS NOT NULL AND p.CUST_CODE <> ''
         ORDER BY name`
      );

      res.json({ status, banks, parties });
    } catch (err) {
      console.error("[pdc-rcd-register/filters]", err);
      res.status(500).json({ message: "Failed to load filter lists" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/pdc-rcd-register/pending
  //   ?fromDate=YYYY-MM-DD & toDate=YYYY-MM-DD
  //   &status=all|pending|reversed  (default: pending)
  //   &bank=<CHQ_BANK>     (optional)
  //   &party=<CUST_CODE>   (optional)
  //
  // Flat list sorted by cheque date. Returns the rows plus the company
  // letterhead, the report title for the chosen status, and a resolved
  // description of the filters, so the PDF and Excel headings can state
  // exactly what was run without a second call.
  //
  // The reversal columns (JV no and date) come back on every slice but only
  // carry a value on reversed rows; the screen shows them for "all" and
  // "reversed" and hides them for "pending", where they are always empty.
  // -------------------------------------------------------------------------
  router.get("/pending", async (req, res) => {
    const { fromDate, toDate, bank, party } = req.query;
    if (!fromDate || !toDate) {
      return res.status(400).json({ message: "fromDate and toDate are required" });
    }

    try {
      const { accMst, cusMst } = CONFIG;
      const status = resolveStatus(req.query.status);

      // CHQ_DATE is a datetime. Comparing it directly against a plain date
      // string measures against midnight, so a cheque dated on the last day
      // of the range with any time on it falls outside the filter. DATE()
      // strips the time from both sides and makes the range inclusive.
      const where = [
        STATUS_SQL[status],
        "DATE(p.CHQ_DATE) >= ?",
        "DATE(p.CHQ_DATE) <= ?",
      ];
      const args = [fromDate, toDate];

      if (bank)  { where.push("p.CHQ_BANK  = ?"); args.push(bank);  }
      if (party) { where.push("p.CUST_CODE = ?"); args.push(party); }

      const [rows] = await db.query(
        `SELECT
           p.TRAN_TYPE,
           p.VCHR_NO,
           p.CHQ_NO,
           p.CHQ_DATE,
           DATE_FORMAT(p.CHQ_DATE, '%d/%m/%Y')   AS CHQ_DATE_FMT,
           p.PDC_CODE,
           COALESCE(a.${accMst.desc},  '')       AS PDC_HEAD,
           p.CHQ_BANK,
           COALESCE(bk.${accMst.desc}, '')       AS BANK_NAME,
           p.AMOUNT,
           p.CUST_CODE,
           COALESCE(c.${cusMst.name},  '')       AS PARTY,
           p.REALISED,
           p.JV_NO_RLZ,
           DATE_FORMAT(p.JV_DATE_RLZ, '%d/%m/%Y') AS JV_DATE_RLZ_FMT
         FROM pdc_rcd p
         LEFT JOIN ${accMst.table} a  ON a.${accMst.code}  = p.PDC_CODE
         LEFT JOIN ${accMst.table} bk ON bk.${accMst.code} = p.CHQ_BANK
         LEFT JOIN ${cusMst.table} c  ON c.${cusMst.code}  = p.CUST_CODE
         WHERE ${where.join(" AND ")}
         ORDER BY p.CHQ_DATE, p.CHQ_NO`,
        args
      );

      // Resolve the chosen filters to readable names for the report heading.
      let bankName = "";
      if (bank) {
        const [r] = await db.query(
          `SELECT ${accMst.desc} AS name FROM ${accMst.table} WHERE ${accMst.code} = ?`,
          [bank]
        );
        bankName = r[0]?.name || bank;
      }

      let partyName = "";
      if (party) {
        const [r] = await db.query(
          `SELECT ${cusMst.name} AS name FROM ${cusMst.table} WHERE ${cusMst.code} = ?`,
          [party]
        );
        partyName = r[0]?.name || party;
      }

      res.json({
        company: await getCompany(),
        title:   STATUS_TITLE[status],
        filters: {
          fromDate,
          toDate,
          status,
          bank:      bank  || "",
          bankName,
          party:     party || "",
          partyName,
        },
        rows,
        count: rows.length,
        total: rows.reduce((s, r) => s + (Number(r.AMOUNT) || 0), 0),
      });
    } catch (err) {
      console.error("[pdc-rcd-register/pending]", err);
      res.status(500).json({ message: "Failed to load the PDC register" });
    }
  });

  return router;
};
