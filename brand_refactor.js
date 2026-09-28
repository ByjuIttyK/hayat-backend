/**
 * brand_refactor.js — moves the company name / logo / contact details out of
 * the code and into ONE settings file, so the same code runs for Al Hayat
 * (production) and for the demo, with only .env and images differing.
 *
 * Works for both projects — put a copy in each root and run it there:
 * (first run company_table.sql on the database)
 *   E:\hayatprgs   (frontend: scans src\**\*.ts, *.tsx  → uses src\constants\company.ts)
 *   E:\hayatApi    (backend : scans **\*.js           → uses config\company.js)
 *
 *   node brand_refactor.js            → DRY RUN: shows every change, writes nothing
 *   node brand_refactor.js --apply    → writes the changes (+ creates the settings file)
 *   git diff                          → review
 *   git checkout -- .                 → undo everything, if needed
 *
 * The values come from the company table (see company_table.sql), so Al Hayat
 * and the demo differ only in their own database row and logo files.
 * Comment lines are never touched. Lines it is unsure about are only LISTED
 * (brand_review.txt) for you to look at.
 */
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const APPLY = process.argv.includes("--apply");
const FRONT = fs.existsSync(path.join(ROOT, "src"));
const BASE = FRONT ? path.join(ROOT, "src") : ROOT;

// Old / backup copies that are not used — left alone
const SKIP = /(^|[\\/])(node_modules|\.next|\.git|uploads|audit_logs|audit_archives)([\\/]|$)|(Old|OLD|\.HEAD)\.(tsx?|js)$|(BankReconciliation1|GlBnkTxnAutoPopulate1)\.tsx$|brand_refactor\.js$/;

// ── settings files ─────────────────────────────────────────────────────────
// The company details come from the `company` table (one row), through the
// backend: config/company.js reads it at start-up and serves it on the public
// route GET /api/company-info. The frontend fetches it once (CompanyGate in
// _app.tsx) and keeps a copy in localStorage for the next visit.
const FRONT_SETTINGS = `/**
 * company.ts — company name, logo and contact details used on screens and prints.
 * E:\\hayatprgs\\src\\constants\\company.ts
 *
 * Filled from the database table \`company\` via GET /api/company-info.
 * <CompanyGate> in pages/_app.tsx loads it before any screen is shown, so every
 * screen can simply use COMPANY.NAME, COMPANY.LOGO, ... directly.
 */
import { DbUrl } from "./globals";

export const COMPANY = {
  NAME: "",        // company.NAME — the one name, used everywhere
  NAME_TITLE: "",  // = NAME (kept as separate names so screens need no change later)
  SHORT: "",       // = NAME
  BRAND: "",       // = NAME (image alt text)
  NAME_LINE1: "",  // NAME split in two lines for the 2-line print headings
  NAME_LINE2: "",
  CITY: "",        // SHARJAH, U.A.E                          (company.PLACE)
  CITY_UPPER: "",
  ADDRESS: "",     // ADDRESS1, ADDRESS2, PLACE
  TEL: "",         // company.PHONE without the "Tel:" prefix
  EMAIL: "",
  WEB: "",
  LOGO: "",        // "/" + company.LOGO_FILENAME   (file in public/)
  LOGO_PNG: "",    // same name with .png — the watermark on the main menu
  INV_LOGO: "",    // "/" + company.INV_LOGO_FILENAME
};
type CompanyInfo = typeof COMPANY;

const CACHE_KEY = "companyInfo";

// last known values, so screens have them immediately on the next visit
if (typeof window !== "undefined") {
  try {
    const c = localStorage.getItem(CACHE_KEY);
    if (c) Object.assign(COMPANY, JSON.parse(c));
  } catch { /* ignore */ }
}

export const companyLoaded = () => COMPANY.NAME !== "";

let inFlight: Promise<CompanyInfo> | null = null;
export function loadCompany(): Promise<CompanyInfo> {
  if (!inFlight) {
    inFlight = fetch(\`\${DbUrl}/api/company-info\`)
      .then((r) => { if (!r.ok) throw new Error(\`company-info \${r.status}\`); return r.json(); })
      .then((d: CompanyInfo) => {
        Object.assign(COMPANY, d);
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch { /* ignore */ }
        return COMPANY;
      })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}
`;

const FRONT_GATE = `/**
 * CompanyGate.tsx — loads the company details (name, logo, ...) before any
 * screen is shown. Mounted once in src/pages/_app.tsx around <Component />.
 */
import React, { useEffect, useState } from "react";
import { loadCompany } from "../constants/company";

export default function CompanyGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    loadCompany()
      .catch((e) => console.error("Company details could not be loaded:", e))
      .finally(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, []);
  if (!ready) return null;          // a blink on the very first load only
  return <>{children}</>;
}
`;

const BACK_SETTINGS = `/**
 * company.js — company name, logo and contact details for PDFs, Excel files,
 * e-mails and the frontend. Read from the \`company\` table (first row).
 * E:\\hayatApi\\config\\company.js
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
  const w = name.split(/\\s+/).filter(Boolean);
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
  const city  = t(r.PLACE).replace(/\\s*,\\s*/g, ", ");          // "SHARJAH ,U.A.E" → "SHARJAH, U.A.E"
  const logo  = t(r.LOGO_FILENAME) ? "/" + t(r.LOGO_FILENAME).replace(/^\\/+/, "") : "";
  const inv   = t(r.INV_LOGO_FILENAME) ? "/" + t(r.INV_LOGO_FILENAME).replace(/^\\/+/, "") : logo;
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
    TEL: t(r.PHONE).replace(/^tel\\s*:\\s*/i, ""),
    EMAIL: t(r.EMAIL),
    WEB: t(r.WEB_SITE),
    LOGO: logo,
    LOGO_PNG: logo ? logo.replace(/\\.[a-z0-9]+$/i, ".png") : "",
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
`;

// ── replacement rules (applied in this order, per line) ────────────────────
// kind: "all" = every file, "tsx" = JSX files only, "text" = .ts/.js files only
const LIT = {
  "AL HAYAT ELECT. SWITCHGEAR IND. LLC.": "NAME",
  "AL HAYAT ELECT. SWITCHGEAR IND. LLC": "NAME",
  "Al Hayat Elect. Switchgear Ind. LLC": "NAME_TITLE",
  "Al Hayat Switchgear Co.LLC": "SHORT",
  "Al Hayat Switchgear LLC": "SHORT",
  "AL HAYAT ELECT.": "NAME_LINE1",
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const RULES = [];
const rule = (kind, re, rep, note) => RULES.push({ kind, re, rep, note });

// product name — plain text, no setting needed
rule("all", /Al Hayat ERP \/ Telltron/g, "Telltron ERP");
rule("all", /Al Hayat ERP/g, "Telltron ERP");
rule("all", /"HayatERP"/g, '"Telltron ERP"');

if (FRONT) {
  // images
  rule("all", /src="\/HayatLogo\.jpg"/g, "src={COMPANY.LOGO}");
  rule("all", /src="\/HayatLogo\.png"/g, "src={COMPANY.LOGO_PNG}");
  rule("all", /alt="Al Hayat"/g, "alt={COMPANY.BRAND}");
  rule("all", /["']\/HayatLogo\.jpg["']/g, "COMPANY.LOGO");
  rule("all", /["']\/HayatInv\.jpg["']/g, "COMPANY.INV_LOGO");

  // one-off lines seen in the scan
  rule("all", /'Al Hayat Switchgear LLC — Manufacturing ERP'/g, "`${COMPANY.SHORT} — Manufacturing ERP`");
  rule("all", /Tel: \+971 6 553 5805    \|    www\.alhayatswitchgear\.com/g, "Tel: ${COMPANY.TEL}    |    ${COMPANY.WEB}");
  rule("all", /Shed No\. 3, Indl\. Area 17, Sharjah, UAE&nbsp;&nbsp;·&nbsp;&nbsp;Tel: \+971 6 553 5805&nbsp;&nbsp;·&nbsp;&nbsp;info@alhayatswitchgear\.com/g,
    "${COMPANY.ADDRESS}&nbsp;&nbsp;·&nbsp;&nbsp;Tel: ${COMPANY.TEL}&nbsp;&nbsp;·&nbsp;&nbsp;${COMPANY.EMAIL}");
  rule("all", /"E-mail:info@alhayatswitchgear\.com"/g, '"E-mail:" + COMPANY.EMAIL');
  rule("all", /"Website: www\.alhayatswitchgear\.com"/g, '"Website: " + COMPANY.WEB');
  rule("all", /const CO_NAME2 = ("[^"]*");/g, "const CO_NAME2 = COMPANY.NAME_LINE2 || $1;");
  rule("tsx", /Al Hayat Elect\. Switchgear Ind\. L\.L\.C &nbsp;·&nbsp; Sharjah, U\.A\.E/g, "{COMPANY.NAME_TITLE} &nbsp;·&nbsp; {COMPANY.CITY}");
  rule("tsx", /<span>Al Hayat Switchgear<\/span>/g, "<span>{COMPANY.SHORT}</span>");
} else {
  rule("all", /'\/HayatLogo\.jpg'/g, "COMPANY.LOGO");
  rule("all", /'SHARJAH, U\.A\.E     Tel: \+971 6 553 5805     www\.alhayatswitchgear\.com'/g,
    "`${COMPANY.CITY_UPPER}     Tel: ${COMPANY.TEL}     ${COMPANY.WEB}`");
  rule("all", /\(Al Hayat Switchgear\)/g, "(${COMPANY.SHORT})");            // AI prompt text (template)
  rule("all", /FROM hayat\.job_card/g, "FROM job_card");                  // same DB as the connection
}

for (const [text, key] of Object.entries(LIT)) {
  const t = esc(text);
  // attribute:  name="TEXT"  → name={COMPANY.X}   (JSX only)
  if (FRONT) rule("tsx", new RegExp(`(\\w)="${t}"`, "g"), `$1={COMPANY.${key}}`);
  // whole string literal "TEXT" / 'TEXT'  → COMPANY.X
  rule("all", new RegExp(`(["'])${t}\\1`, "g"), `COMPANY.${key}`);
  // inside a template string:  — TEXT`   or  >TEXT<  in HTML templates  → ${COMPANY.X}
  rule("all", new RegExp(`— ${t}\``, "g"), `— \${COMPANY.${key}}\``);
  rule("text", new RegExp(`>${t}<`, "g"), `>\${COMPANY.${key}}<`);
  // JSX text (what is left in a .tsx on a code line)
  if (FRONT && key !== "NAME_LINE1") rule("tsx", new RegExp(`(^|[\\s>])${t}(?=[\\s<—]|$)`, "g"), `$1{COMPANY.${key}}`);
}

// ── helpers ────────────────────────────────────────────────────────────────
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (SKIP.test(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (FRONT ? /\.(tsx?)$/.test(e.name) : /\.js$/.test(e.name)) out.push(p);
  }
  return out;
};
const isComment = (l) => /^\s*(\/\/|\/\*|\*|\{\/\*)/.test(l);
const REVIEW = /hayat|553 5805|SWITCHGEAR/i;
const REVIEW_OK = /JVForm_hayat|E:\\\\?hayat|hayatApi|hayatprgs|HayatDb|hayat_fa\.|USER_NAME: "HAYAT"|placeholder: "HAYAT"|ws\.protect\("hayat"|Password: hayat|password.*hayat|hayaterp\.cloud|COMPANY\./i;

const settingsRel = (file) => {
  const target = FRONT ? path.join(ROOT, "src", "constants", "company") : path.join(ROOT, "config", "company");
  let rel = path.relative(path.dirname(file), target).split(path.sep).join("/");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
};

// ── run ────────────────────────────────────────────────────────────────────
let changedFiles = 0, changedLines = 0;
const review = [];

for (const file of walk(BASE)) {
  const rel = path.relative(ROOT, file);
  const src = fs.readFileSync(file, "utf8");
  const nl = src.includes("\r\n") ? "\r\n" : "\n";
  const lines = src.split(/\r?\n/);
  const isTsx = file.endsWith(".tsx");
  let touched = false;

  lines.forEach((line, i) => {
    if (isComment(line)) return;
    let out = line;
    for (const r of RULES) {
      if (r.kind === "tsx" && !isTsx) continue;
      if (r.kind === "text" && isTsx) continue;
      out = out.replace(r.re, r.rep);
    }
    if (out !== line) {
      console.log(`CHANGE  ${rel}:${i + 1}\n   - ${line.trim()}\n   + ${out.trim()}`);
      lines[i] = out; touched = true; changedLines++;
    }
    if (REVIEW.test(out) && !REVIEW_OK.test(out)) review.push(`${rel}:${i + 1}   ${out.trim()}`);
  });

  if (!touched) continue;
  changedFiles++;
  const usesCompany = lines.some((l) => /COMPANY\./.test(l));
  const hasImport = lines.some((l) => /constants\/company|config\/company/.test(l));
  if (usesCompany && !hasImport) {
    const imp = FRONT
      ? `import { COMPANY } from "${settingsRel(file)}";`
      : `const COMPANY = require("${settingsRel(file)}");`;
    // after a leading "use client" / 'use strict' directive, otherwise at the very top
    const d = lines.findIndex((l) => l.trim() !== "");
    const at = d >= 0 && /^["']use (client|strict)["'];?\s*$/.test(lines[d].trim()) ? d + 1 : 0;
    lines.splice(at, 0, imp);
    console.log(`IMPORT  ${rel}: ${imp}`);
  }
  if (APPLY) fs.writeFileSync(file, lines.join(nl), "utf8");
}

// settings files (written only if they do not exist yet)
const toCreate = FRONT
  ? [[path.join(ROOT, "src", "constants", "company.ts"), FRONT_SETTINGS],
     [path.join(ROOT, "src", "components", "CompanyGate.tsx"), FRONT_GATE]]
  : [[path.join(ROOT, "config", "company.js"), BACK_SETTINGS]];
for (const [file, body] of toCreate) {
  if (fs.existsSync(file)) continue;
  console.log(`\nCREATE  ${path.relative(ROOT, file)}`);
  if (APPLY) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, "utf8");
  }
}

fs.writeFileSync(path.join(ROOT, "brand_review.txt"), review.join("\n"), "utf8");
console.log(`\n${changedLines} line(s) in ${changedFiles} file(s) ${APPLY ? "CHANGED" : "would change (dry run — add --apply to write)"}.`);
console.log(`${review.length} line(s) still mention the company — listed in brand_review.txt for a look.`);
