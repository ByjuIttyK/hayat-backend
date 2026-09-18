// ============================================================================
//  routes/tbAudit.js
//  ---------------------------------------------------------------------------
//  Trial Balance Audit — finds the rows in tran_acc that stop the T.B. from
//  tallying, or that will quietly drop out of it.
//
//  GET /api/tb-audit                      → uses the full ac_period range
//  GET /api/tb-audit?from=YYYY-MM-DD&to=YYYY-MM-DD
//
//  tran_acc stores ONE amount column plus a DB_CR flag ('D' / 'C'), so Debit
//  and Credit are derived here:
//      Debit  = CASE WHEN DB_CR = 'D' THEN amount ELSE 0 END
//      Credit = CASE WHEN DB_CR = 'C' THEN amount ELSE 0 END
//  A leg whose DB_CR is neither D nor C therefore posts to NEITHER side — that
//  is its own check (BAD_DBCR) and a direct cause of an out-of-balance T.B.
//
//  The amount column and the ac_period date columns are discovered from the
//  live table on first call and reported back in the response, so no column
//  name is hard-coded. Override with these env vars if a guess is ever wrong:
//      TB_AUDIT_AMT_COL, TB_AUDIT_PERIOD_FROM_COL, TB_AUDIT_PERIOD_TO_COL
//
//  Register in HayatDb.js with the usual factory pattern:
//    app.use("/api", authMiddleware, require("./routes/tbAudit")(connection));
// ============================================================================
const express = require("express");

module.exports = function (connection) {
  const router = express.Router();

  const q = (sql, params = []) =>
    new Promise((resolve, reject) => {
      connection.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });

  const TOL = 0.004;   // rounding noise, not a discrepancy
  const CAP = 5000;    // max rows returned per check

  const n = (v) => Number(v ?? 0) || 0;
  const iso = (d) => {
    if (!d) return null;
    if (typeof d === "string") return d.slice(0, 10);
    try { return new Date(d).toISOString().slice(0, 10); } catch { return null; }
  };

  // ── Column discovery (once per process) ──────────────────────────────────
  let schema = null;

  const colsOf = async (table) => {
    const rows = await q(`SHOW COLUMNS FROM ${table}`);
    return rows.map(r => String(r.Field ?? r.field ?? r.COLUMN_NAME));
  };

  const pick = (names, exact, loose) => {
    for (const re of exact) { const hit = names.find(c => re.test(c)); if (hit) return hit; }
    return names.find(c => loose.test(c)) || null;
  };

  const resolveSchema = async () => {
    if (schema) return schema;

    const tranCols = await colsOf("tran_acc");
    const amt =
      process.env.TB_AUDIT_AMT_COL ||
      pick(tranCols,
        [/^amount$/i, /^amt$/i, /^tran_amount$/i, /^trn_amount$/i, /^value$/i, /^amount_lc$/i],
        /amount|amt/i);
    if (!amt) throw new Error("Could not find the amount column in tran_acc — set TB_AUDIT_AMT_COL");

    const dbcr = pick(tranCols, [/^db_cr$/i, /^dbcr$/i, /^dr_cr$/i], /db.?cr|dr.?cr/i) || "DB_CR";

    let periodFromCol = null, periodToCol = null, hasPeriod = false;
    try {
      const pCols = await colsOf("ac_period");
      hasPeriod = true;
      periodFromCol =
        process.env.TB_AUDIT_PERIOD_FROM_COL ||
        pick(pCols, [/^start_date$/i, /^from_date$/i, /^period_from$/i, /^st_date$/i, /^begin_date$/i],
          /(start|from|begin).*(date|dt)|(date|dt).*(start|from)/i);
      periodToCol =
        process.env.TB_AUDIT_PERIOD_TO_COL ||
        pick(pCols, [/^end_date$/i, /^to_date$/i, /^period_to$/i, /^en_date$/i, /^close_date$/i],
          /(end|to|close).*(date|dt)|(date|dt).*(end|to)/i);
    } catch (e) {
      console.log("tb-audit: ac_period unreadable —", e.code || e.message);
    }

    schema = { amt, dbcr, hasPeriod, periodFromCol, periodToCol };
    console.log("tb-audit schema:", JSON.stringify(schema));
    return schema;
  };

  // ── The whole Dr / Cr derivation lives in these two helpers ──────────────
  const DR = (s, a = "t") => `CASE WHEN UPPER(TRIM(${a}.${s.dbcr})) = 'D' THEN COALESCE(${a}.${s.amt},0) ELSE 0 END`;
  const CR = (s, a = "t") => `CASE WHEN UPPER(TRIM(${a}.${s.dbcr})) = 'C' THEN COALESCE(${a}.${s.amt},0) ELSE 0 END`;

  // ── Check catalogue ──────────────────────────────────────────────────────
  // CRITICAL = the T.B. will not tally / the row silently vanishes from it
  // WARNING  = suspect data that does not by itself unbalance the T.B.
  const buildChecks = (s) => {
    const dr = DR(s), cr = CR(s);
    const amt = `COALESCE(t.${s.amt},0)`;

    return [
      {
        code: "UNBALANCED",
        label: "Dr / Cr untallied vouchers",
        severity: "CRITICAL",
        hint: "SUM(Debit) <> SUM(Credit) for the voucher — the single biggest cause of a T.B. out of balance",
        // Null-dated legs come in too, so a voucher unbalanced BECAUSE a leg
        // has no date shows up here as well as in BAD_DATE.
        sql: `
          SELECT t.TRAN_TYPE, ty.TYPE_ABBR, t.VCHR_NO,
                 MIN(t.DATTE) AS DATTE, COUNT(*) AS LEGS,
                 SUM(${dr}) AS DR, SUM(${cr}) AS CR
            FROM tran_acc t
            LEFT JOIN tran_type ty ON ty.TRAN_TYPE = t.TRAN_TYPE
           WHERE (t.DATTE BETWEEN ? AND ? OR t.DATTE IS NULL)
           GROUP BY t.TRAN_TYPE, ty.TYPE_ABBR, t.VCHR_NO
          HAVING ABS(SUM(${dr}) - SUM(${cr})) > ?
           ORDER BY ABS(SUM(${dr}) - SUM(${cr})) DESC
           LIMIT ${CAP + 1}`,
        args: (f, t) => [f, t, TOL],
        map: (r) => ({
          TRAN_TYPE: r.TRAN_TYPE, TYPE_ABBR: r.TYPE_ABBR, VCHR_NO: r.VCHR_NO,
          SR_NO: null, DATTE: iso(r.DATTE), ACC_CODE: null, AC_HEAD: null,
          AMOUNT_DR: n(r.DR), AMOUNT_CR: n(r.CR), DIFF: n(r.DR) - n(r.CR),
          DETAIL: `${r.LEGS} leg${Number(r.LEGS) === 1 ? "" : "s"}, out by ${(n(r.DR) - n(r.CR)).toFixed(2)}`,
        }),
        amount: (r) => Math.abs(r.DIFF),
      },

      {
        code: "BAD_DBCR",
        label: "DB_CR flag not D or C",
        severity: "CRITICAL",
        hint: "The leg is neither a Debit nor a Credit, so its amount reaches neither side of the T.B.",
        sql: `
          SELECT t.TRAN_TYPE, ty.TYPE_ABBR, t.VCHR_NO, t.SR_NO, t.DATTE, t.ACC_CODE,
                 a.AC_HEAD, t.${s.dbcr} AS FLAG, ${amt} AS AMT
            FROM tran_acc t
            LEFT JOIN ac_list   a  ON a.AC_CODE    = t.ACC_CODE
            LEFT JOIN tran_type ty ON ty.TRAN_TYPE = t.TRAN_TYPE
           WHERE (UPPER(TRIM(COALESCE(t.${s.dbcr},''))) NOT IN ('D','C'))
             AND (t.DATTE BETWEEN ? AND ? OR t.DATTE IS NULL)
           ORDER BY t.DATTE
           LIMIT ${CAP + 1}`,
        args: (f, t) => [f, t],
        map: (r) => ({
          TRAN_TYPE: r.TRAN_TYPE, TYPE_ABBR: r.TYPE_ABBR, VCHR_NO: r.VCHR_NO,
          SR_NO: r.SR_NO, DATTE: iso(r.DATTE), ACC_CODE: r.ACC_CODE, AC_HEAD: r.AC_HEAD,
          AMOUNT_DR: 0, AMOUNT_CR: 0, DIFF: n(r.AMT),
          DETAIL: (r.FLAG === null || String(r.FLAG).trim() === "")
            ? `DB_CR is blank — ${n(r.AMT).toFixed(2)} posts nowhere`
            : `DB_CR = '${r.FLAG}' — ${n(r.AMT).toFixed(2)} posts nowhere`,
        }),
        amount: (r) => Math.abs(r.DIFF),
      },

      {
        code: "ORPHAN_AC",
        label: "A/c code not in ac_list",
        severity: "CRITICAL",
        hint: "ACC_CODE matches no acc_mst / cus_mst / sup_mst row, so the amount is posted nowhere and never reaches the T.B.",
        sql: `
          SELECT t.TRAN_TYPE, ty.TYPE_ABBR, t.VCHR_NO, t.SR_NO, t.DATTE, t.ACC_CODE,
                 ${dr} AS DR, ${cr} AS CR
            FROM tran_acc t
            LEFT JOIN ac_list   a  ON a.AC_CODE    = t.ACC_CODE
            LEFT JOIN tran_type ty ON ty.TRAN_TYPE = t.TRAN_TYPE
           WHERE a.AC_CODE IS NULL
             AND (t.DATTE BETWEEN ? AND ? OR t.DATTE IS NULL)
           ORDER BY t.ACC_CODE, t.DATTE
           LIMIT ${CAP + 1}`,
        args: (f, t) => [f, t],
        map: (r) => ({
          TRAN_TYPE: r.TRAN_TYPE, TYPE_ABBR: r.TYPE_ABBR, VCHR_NO: r.VCHR_NO,
          SR_NO: r.SR_NO, DATTE: iso(r.DATTE), ACC_CODE: r.ACC_CODE, AC_HEAD: null,
          AMOUNT_DR: n(r.DR), AMOUNT_CR: n(r.CR), DIFF: 0,
          DETAIL: !r.ACC_CODE || !String(r.ACC_CODE).trim()
            ? "A/c code is blank"
            : `'${r.ACC_CODE}' does not exist in ac_list`,
        }),
        amount: (r) => Math.abs(r.AMOUNT_DR) + Math.abs(r.AMOUNT_CR),
      },

      {
        code: "BAD_DATE",
        label: "Null / out-of-period dates",
        severity: "CRITICAL",
        hint: "DATTE is null, zero, or falls outside the window — the leg is excluded from a dated T.B. while its contra leg is not",
        sql: `
          SELECT t.TRAN_TYPE, ty.TYPE_ABBR, t.VCHR_NO, t.SR_NO, t.DATTE, t.ACC_CODE,
                 a.AC_HEAD, ${dr} AS DR, ${cr} AS CR
            FROM tran_acc t
            LEFT JOIN ac_list   a  ON a.AC_CODE    = t.ACC_CODE
            LEFT JOIN tran_type ty ON ty.TRAN_TYPE = t.TRAN_TYPE
           WHERE t.DATTE IS NULL
              OR CAST(t.DATTE AS CHAR) IN ('0000-00-00', '0000-00-00 00:00:00')
              OR t.DATTE < ?
              OR t.DATTE > ?
           ORDER BY t.DATTE IS NULL DESC, t.DATTE
           LIMIT ${CAP + 1}`,
        args: (f, t) => [f, t],
        map: (r, ctx) => {
          const d = iso(r.DATTE);
          let why;
          if (!d || d.startsWith("0000")) why = "Date is null / zero";
          else if (d > ctx.to) why = `Dated ${d} — after ${ctx.to}`;
          else why = `Dated ${d} — before ${ctx.from}`;
          return {
            TRAN_TYPE: r.TRAN_TYPE, TYPE_ABBR: r.TYPE_ABBR, VCHR_NO: r.VCHR_NO,
            SR_NO: r.SR_NO, DATTE: d, ACC_CODE: r.ACC_CODE, AC_HEAD: r.AC_HEAD,
            AMOUNT_DR: n(r.DR), AMOUNT_CR: n(r.CR), DIFF: 0, DETAIL: why,
          };
        },
        amount: (r) => Math.abs(r.AMOUNT_DR) + Math.abs(r.AMOUNT_CR),
      },

      {
        code: "NO_KEY",
        label: "Blank Tran Type / Vchr.No",
        severity: "CRITICAL",
        hint: "A leg with no voucher key cannot be matched to its contra leg by any report",
        sql: `
          SELECT t.TRAN_TYPE, ty.TYPE_ABBR, t.VCHR_NO, t.SR_NO, t.DATTE, t.ACC_CODE,
                 a.AC_HEAD, ${dr} AS DR, ${cr} AS CR
            FROM tran_acc t
            LEFT JOIN ac_list   a  ON a.AC_CODE    = t.ACC_CODE
            LEFT JOIN tran_type ty ON ty.TRAN_TYPE = t.TRAN_TYPE
           WHERE t.TRAN_TYPE IS NULL OR TRIM(t.TRAN_TYPE) = ''
              OR t.VCHR_NO   IS NULL OR TRIM(t.VCHR_NO)   = ''
           ORDER BY t.DATTE
           LIMIT ${CAP + 1}`,
        args: () => [],
        map: (r) => ({
          TRAN_TYPE: r.TRAN_TYPE, TYPE_ABBR: r.TYPE_ABBR, VCHR_NO: r.VCHR_NO,
          SR_NO: r.SR_NO, DATTE: iso(r.DATTE), ACC_CODE: r.ACC_CODE, AC_HEAD: r.AC_HEAD,
          AMOUNT_DR: n(r.DR), AMOUNT_CR: n(r.CR), DIFF: 0,
          DETAIL: !r.TRAN_TYPE || !String(r.TRAN_TYPE).trim()
            ? "Tran Type is blank" : "Vchr.No is blank",
        }),
        amount: (r) => Math.abs(r.AMOUNT_DR) + Math.abs(r.AMOUNT_CR),
      },

      {
        code: "SINGLE_LEG",
        label: "One-sided vouchers",
        severity: "WARNING",
        hint: "The voucher has a single tran_acc row — a double entry needs at least two",
        sql: `
          SELECT t.TRAN_TYPE, ty.TYPE_ABBR, t.VCHR_NO, MIN(t.DATTE) AS DATTE,
                 MIN(t.ACC_CODE) AS ACC_CODE,
                 SUM(${dr}) AS DR, SUM(${cr}) AS CR
            FROM tran_acc t
            LEFT JOIN tran_type ty ON ty.TRAN_TYPE = t.TRAN_TYPE
           WHERE (t.DATTE BETWEEN ? AND ? OR t.DATTE IS NULL)
             AND COALESCE(t.VCHR_NO,'') <> ''
           GROUP BY t.TRAN_TYPE, ty.TYPE_ABBR, t.VCHR_NO
          HAVING COUNT(*) = 1
           ORDER BY DATTE
           LIMIT ${CAP + 1}`,
        args: (f, t) => [f, t],
        map: (r) => ({
          TRAN_TYPE: r.TRAN_TYPE, TYPE_ABBR: r.TYPE_ABBR, VCHR_NO: r.VCHR_NO,
          SR_NO: null, DATTE: iso(r.DATTE), ACC_CODE: r.ACC_CODE, AC_HEAD: null,
          AMOUNT_DR: n(r.DR), AMOUNT_CR: n(r.CR), DIFF: n(r.DR) - n(r.CR),
          DETAIL: "Only one leg posted for this voucher",
        }),
        amount: (r) => Math.abs(r.DIFF),
      },

      {
        code: "SPLIT_DATE",
        label: "Legs of one voucher on different dates",
        severity: "WARNING",
        hint: "The Dr and Cr legs carry different DATTE values, so a dated T.B. can pick up one and not the other",
        sql: `
          SELECT t.TRAN_TYPE, ty.TYPE_ABBR, t.VCHR_NO,
                 MIN(t.DATTE) AS D_MIN, MAX(t.DATTE) AS D_MAX,
                 COUNT(DISTINCT t.DATTE) AS D_CNT,
                 SUM(${dr}) AS DR, SUM(${cr}) AS CR
            FROM tran_acc t
            LEFT JOIN tran_type ty ON ty.TRAN_TYPE = t.TRAN_TYPE
           WHERE (t.DATTE BETWEEN ? AND ? OR t.DATTE IS NULL)
             AND COALESCE(t.VCHR_NO,'') <> ''
           GROUP BY t.TRAN_TYPE, ty.TYPE_ABBR, t.VCHR_NO
          HAVING COUNT(DISTINCT t.DATTE) > 1
           ORDER BY D_MIN
           LIMIT ${CAP + 1}`,
        args: (f, t) => [f, t],
        map: (r) => ({
          TRAN_TYPE: r.TRAN_TYPE, TYPE_ABBR: r.TYPE_ABBR, VCHR_NO: r.VCHR_NO,
          SR_NO: null, DATTE: iso(r.D_MIN), ACC_CODE: null, AC_HEAD: null,
          AMOUNT_DR: n(r.DR), AMOUNT_CR: n(r.CR), DIFF: n(r.DR) - n(r.CR),
          DETAIL: `${r.D_CNT} different dates: ${iso(r.D_MIN)} .. ${iso(r.D_MAX)}`,
        }),
        amount: () => 0,
      },

      {
        code: "DUP_SR",
        label: "Duplicate Sr.No within a voucher",
        severity: "WARNING",
        hint: "Two legs share TRAN_TYPE + VCHR_NO + SR_NO — usually a re-migrated voucher, and often a doubled amount",
        sql: `
          SELECT t.TRAN_TYPE, ty.TYPE_ABBR, t.VCHR_NO, t.SR_NO,
                 MIN(t.DATTE) AS DATTE, COUNT(*) AS CNT,
                 SUM(${dr}) AS DR, SUM(${cr}) AS CR
            FROM tran_acc t
            LEFT JOIN tran_type ty ON ty.TRAN_TYPE = t.TRAN_TYPE
           WHERE (t.DATTE BETWEEN ? AND ? OR t.DATTE IS NULL)
             AND COALESCE(t.VCHR_NO,'') <> ''
           GROUP BY t.TRAN_TYPE, ty.TYPE_ABBR, t.VCHR_NO, t.SR_NO
          HAVING COUNT(*) > 1
           ORDER BY DATTE
           LIMIT ${CAP + 1}`,
        args: (f, t) => [f, t],
        map: (r) => ({
          TRAN_TYPE: r.TRAN_TYPE, TYPE_ABBR: r.TYPE_ABBR, VCHR_NO: r.VCHR_NO,
          SR_NO: r.SR_NO, DATTE: iso(r.DATTE), ACC_CODE: null, AC_HEAD: null,
          AMOUNT_DR: n(r.DR), AMOUNT_CR: n(r.CR), DIFF: 0,
          DETAIL: `Sr.No ${r.SR_NO} appears ${r.CNT} times`,
        }),
        amount: () => 0,
      },

      {
        code: "ZERO_LINE",
        label: "Legs with no amount",
        severity: "WARNING",
        hint: "The amount is zero or null — harmless to the T.B. total but it clutters every ledger",
        sql: `
          SELECT t.TRAN_TYPE, ty.TYPE_ABBR, t.VCHR_NO, t.SR_NO, t.DATTE, t.ACC_CODE,
                 a.AC_HEAD
            FROM tran_acc t
            LEFT JOIN ac_list   a  ON a.AC_CODE    = t.ACC_CODE
            LEFT JOIN tran_type ty ON ty.TRAN_TYPE = t.TRAN_TYPE
           WHERE ${amt} = 0
             AND (t.DATTE BETWEEN ? AND ? OR t.DATTE IS NULL)
           ORDER BY t.DATTE
           LIMIT ${CAP + 1}`,
        args: (f, t) => [f, t],
        map: (r) => ({
          TRAN_TYPE: r.TRAN_TYPE, TYPE_ABBR: r.TYPE_ABBR, VCHR_NO: r.VCHR_NO,
          SR_NO: r.SR_NO, DATTE: iso(r.DATTE), ACC_CODE: r.ACC_CODE, AC_HEAD: r.AC_HEAD,
          AMOUNT_DR: 0, AMOUNT_CR: 0, DIFF: 0, DETAIL: "Amount is zero",
        }),
        amount: () => 0,
      },

      {
        code: "NEG_AMT",
        label: "Negative amounts",
        severity: "WARNING",
        hint: "A negative amount — normally it should have been posted on the other side with the DB_CR flag flipped",
        sql: `
          SELECT t.TRAN_TYPE, ty.TYPE_ABBR, t.VCHR_NO, t.SR_NO, t.DATTE, t.ACC_CODE,
                 a.AC_HEAD, t.${s.dbcr} AS FLAG, ${dr} AS DR, ${cr} AS CR
            FROM tran_acc t
            LEFT JOIN ac_list   a  ON a.AC_CODE    = t.ACC_CODE
            LEFT JOIN tran_type ty ON ty.TRAN_TYPE = t.TRAN_TYPE
           WHERE ${amt} < 0
             AND (t.DATTE BETWEEN ? AND ? OR t.DATTE IS NULL)
           ORDER BY t.DATTE
           LIMIT ${CAP + 1}`,
        args: (f, t) => [f, t],
        map: (r) => ({
          TRAN_TYPE: r.TRAN_TYPE, TYPE_ABBR: r.TYPE_ABBR, VCHR_NO: r.VCHR_NO,
          SR_NO: r.SR_NO, DATTE: iso(r.DATTE), ACC_CODE: r.ACC_CODE, AC_HEAD: r.AC_HEAD,
          AMOUNT_DR: n(r.DR), AMOUNT_CR: n(r.CR), DIFF: 0,
          DETAIL: `Negative amount on a '${r.FLAG}' leg`,
        }),
        amount: (r) => Math.abs(r.AMOUNT_DR) + Math.abs(r.AMOUNT_CR),
      },

      {
        code: "ORPHAN_TYPE",
        label: "Tran Type not in tran_type master",
        severity: "WARNING",
        hint: "No master row, so the voucher has no abbreviation and no entry screen to open it with",
        sql: `
          SELECT t.TRAN_TYPE, NULL AS TYPE_ABBR, t.VCHR_NO, MIN(t.DATTE) AS DATTE,
                 SUM(${dr}) AS DR, SUM(${cr}) AS CR
            FROM tran_acc t
            LEFT JOIN tran_type ty ON ty.TRAN_TYPE = t.TRAN_TYPE
           WHERE ty.TRAN_TYPE IS NULL
             AND COALESCE(t.TRAN_TYPE,'') <> ''
             AND (t.DATTE BETWEEN ? AND ? OR t.DATTE IS NULL)
           GROUP BY t.TRAN_TYPE, t.VCHR_NO
           ORDER BY t.TRAN_TYPE, DATTE
           LIMIT ${CAP + 1}`,
        args: (f, t) => [f, t],
        map: (r) => ({
          TRAN_TYPE: r.TRAN_TYPE, TYPE_ABBR: null, VCHR_NO: r.VCHR_NO,
          SR_NO: null, DATTE: iso(r.DATTE), ACC_CODE: null, AC_HEAD: null,
          AMOUNT_DR: n(r.DR), AMOUNT_CR: n(r.CR), DIFF: 0,
          DETAIL: `Tran Type '${r.TRAN_TYPE}' has no master row`,
        }),
        amount: () => 0,
      },
    ];
  };

  // ── GET /api/tb-audit ────────────────────────────────────────────────────
  router.get("/tb-audit", async (req, res) => {
    try {
      const s = await resolveSchema();

      // Window: explicit params win, else the full ac_period range, else a
      // wide fallback so the screen still runs with no ac_period at all.
      let from = req.query.from ? String(req.query.from).slice(0, 10) : null;
      let to   = req.query.to   ? String(req.query.to).slice(0, 10)   : null;

      let periodFrom = null, periodTo = null;
      if (s.hasPeriod && s.periodFromCol && s.periodToCol) {
        try {
          const p = await q(
            `SELECT DATE_FORMAT(MIN(${s.periodFromCol}), '%Y-%m-%d') AS P_FROM,
                    DATE_FORMAT(MAX(${s.periodToCol}),   '%Y-%m-%d') AS P_TO
               FROM ac_period`
          );
          periodFrom = p?.[0]?.P_FROM ?? null;
          periodTo   = p?.[0]?.P_TO   ?? null;
        } catch (e) {
          console.log("tb-audit: ac_period query failed —", e.sqlMessage || e.message);
        }
      }

      from = from || periodFrom || "1900-01-01";
      to   = to   || periodTo   || "2999-12-31";
      const ctx = { from, to };

      // Headline: does the whole window tally at all?
      const [tot] = await q(
        `SELECT SUM(${DR(s)}) AS DR, SUM(${CR(s)}) AS CR, COUNT(*) AS LEGS
           FROM tran_acc t
          WHERE t.DATTE BETWEEN ? AND ?`,
        [from, to]
      );

      const rows = [];
      const checks = [];

      for (const c of buildChecks(s)) {
        let raw = [];
        let failed = null;
        try {
          raw = await q(c.sql, c.args(from, to));
        } catch (e) {
          failed = e.sqlMessage || e.message;
          console.log(`tb-audit: check ${c.code} failed —`, failed);
        }

        const truncated = raw.length > CAP;
        if (truncated) raw.length = CAP;

        let amount = 0;
        for (const r of raw) {
          const row = { CHECK_CODE: c.code, SEVERITY: c.severity, ...c.map(r, ctx) };
          amount += c.amount(row);
          rows.push(row);
        }

        checks.push({
          CHECK_CODE: c.code, LABEL: c.label, SEVERITY: c.severity, HINT: c.hint,
          ROWS: raw.length, AMOUNT: Number(amount.toFixed(2)),
          TRUNCATED: truncated, ERROR: failed,
        });
      }

      const dr = n(tot?.DR), cr = n(tot?.CR);
      res.json({
        period: { from, to, acPeriodFrom: periodFrom, acPeriodTo: periodTo },
        totals: {
          DR: dr, CR: cr, DIFF: Number((dr - cr).toFixed(2)),
          LEGS: Number(tot?.LEGS ?? 0),
          BALANCED: Math.abs(dr - cr) <= TOL,
        },
        // Which columns the audit resolved — surfaced in the screen's tooltip
        // so a wrong guess is visible rather than silent.
        schema: {
          amountColumn: s.amt, dbCrColumn: s.dbcr,
          periodFromColumn: s.periodFromCol, periodToColumn: s.periodToCol,
        },
        checks,
        rows,
        cap: CAP,
        ranAt: new Date().toISOString(),
      });
    } catch (err) {
      console.log("tb-audit failed:", err);
      res.status(500).json({ error: "Trial Balance audit failed", detail: err.sqlMessage || err.message });
    }
  });

  return router;
};
