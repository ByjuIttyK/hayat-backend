/**
 * company.js — company name, logo and contact details for PDFs, Excel files,
 * e-mails and the frontend. Read from the `company` table (first row).
 * E:\hayatApi\config\company.js
 *
 * In HayatDb.js, BEFORE  app.use("/api", authMiddleware)  (the login screen needs it):
 *   const COMPANY = require("./config/company");
 *   COMPANY.load(connection);
 *   app.get("/api/company-info", async (req, res) => {
 *     if (!COMPANY.NAME) await COMPANY.load(connection);
 *     res.json(COMPANY);
 *   });
 */
const COMPANY = {
  NAME: "", NAME_TITLE: "", SHORT: "", BRAND: "",
  NAME_LINE1: "", NAME_LINE2: "",
  CITY: "", CITY_UPPER: "", ADDRESS: "",
  TEL: "", EMAIL: "", WEB: "",
  LOGO: "", LOGO_PNG: "", INV_LOGO: "",
};

const t = (v) => (v == null ? "" : String(v).trim());

// Split the name into two lines of similar length for the two-line print
// headings, e.g. "AL HAYAT ELECT. SWITCHGEAR IND. LLC." → "AL HAYAT ELECT." / "SWITCHGEAR IND. LLC."
function splitName(name) {
  const w = name.split(/\s+/).filter(Boolean);
  if (w.length < 2) return [name, ""];
  let best = 1, bestLen = Infinity;
  for (let i = 1; i < w.length; i++) {
    const len = Math.max(w.slice(0, i).join(" ").length, w.slice(i).join(" ").length);
    if (len < bestLen) { bestLen = len; best = i; }
  }
  return [w.slice(0, best).join(" "), w.slice(best).join(" ")];
}

function fromRow(r) {
  const name  = t(r.NAME);                                     // the one company name, used everywhere
  const city  = t(r.PLACE).replace(/\s*,\s*/g, ", ");          // "SHARJAH ,U.A.E" → "SHARJAH, U.A.E"
  const logo  = t(r.LOGO_FILENAME) ? "/" + t(r.LOGO_FILENAME).replace(/^\/+/, "") : "";
  const inv   = t(r.INV_LOGO_FILENAME) ? "/" + t(r.INV_LOGO_FILENAME).replace(/^\/+/, "") : logo;
  const [line1, line2] = splitName(name);
  return {
    NAME: name,
    NAME_TITLE: name,
    SHORT: name,
    BRAND: name,
    NAME_LINE1: line1,
    NAME_LINE2: line2,
    CITY: city,
    CITY_UPPER: city.toUpperCase(),
    ADDRESS: [t(r.ADDRESS1), t(r.ADDRESS2), city].filter(Boolean).join(", "),
    TEL: t(r.PHONE).replace(/^tel\s*:\s*/i, ""),
    EMAIL: t(r.EMAIL),
    WEB: t(r.WEB_SITE),
    LOGO: logo,
    LOGO_PNG: logo ? logo.replace(/\.[a-z0-9]+$/i, ".png") : "",
    INV_LOGO: inv,
  };
}

// load(connection) — reads the table; safe to call again to refresh
Object.defineProperty(COMPANY, "load", {
  enumerable: false,                         // not sent by res.json(COMPANY)
  value: (connection) => new Promise((resolve) => {
    connection.query("SELECT * FROM company ORDER BY CMP_CODE LIMIT 1", (err, rows) => {
      if (err) console.error("[company] could not read the company table:", err.message);
      else if (rows && rows[0]) Object.assign(COMPANY, fromRow(rows[0]));
      else console.error("[company] the company table is empty");
      resolve(COMPANY);
    });
  }),
});

module.exports = COMPANY;
