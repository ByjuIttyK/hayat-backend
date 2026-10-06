// routes/accTxnAnalysis.js
// Account Master › Transaction Value / Debits / Credits tabs (AccTxnAnalysis.tsx)
//
//   GET /api/acc-txn-analysis/:acc?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// from / to default to the current financial period in ac_period (START_DATE / END_DATE).
// Works for any code in ac_list (GL, customer or supplier).
//
// Register in HayatDb.js:
//   const accTxnAnalysis = require("./routes/accTxnAnalysis");
//   app.use("/api", accTxnAnalysis(connection));

const express = require("express");

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const num = (v) => Number(v) || 0;

module.exports = function (connection) {
  const router = express.Router();

  const q = (sql, params = []) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );

  router.get("/acc-txn-analysis/:acc", async (req, res) => {
    const acc = String(req.params.acc || "").trim();
    if (!acc) return res.status(400).json({ error: "Account code is required." });

    try {
      // Financial period — the default range and the bounds for the year chips
      const [p] = await q(
        `SELECT DATE_FORMAT(START_DATE, '%Y-%m-%d') AS s, DATE_FORMAT(END_DATE, '%Y-%m-%d') AS e
           FROM ac_period LIMIT 1`
      );
      const period = { start: p ? p.s : null, end: p ? p.e : null };

      const from = ISO.test(String(req.query.from || "")) ? String(req.query.from) : period.start;
      const to = ISO.test(String(req.query.to || "")) ? String(req.query.to) : period.end;
      if (!from || !to) return res.status(400).json({ error: "No financial period in ac_period — give From and To dates." });
      if (from > to) return res.status(400).json({ error: "From date is after To date." });

      const [accRow] = await q(`SELECT AC_CODE AS code, AC_HEAD AS head FROM ac_list WHERE AC_CODE = ? LIMIT 1`, [acc]);

      const W = `t.ACC_CODE = ? AND t.DATTE BETWEEN ? AND ?`;
      const P = [acc, from, to];
      const DC = `UPPER(TRIM(t.DB_CR))`;

      // Month × side. Vouchers are counted once per month even if they post several lines.
      const monthRows = await q(
        `SELECT DATE_FORMAT(t.DATTE, '%Y-%m') AS ym, ${DC} AS dc,
                SUM(COALESCE(t.AMOUNT, 0)) AS amt,
                COUNT(DISTINCT t.TRAN_TYPE, t.vchr_no) AS cnt
           FROM tran_acc t
          WHERE ${W}
          GROUP BY ym, dc`,
        P
      );

      // Totals per side + vouchers overall
      const sideRows = await q(
        `SELECT ${DC} AS dc, SUM(COALESCE(t.AMOUNT, 0)) AS amt,
                COUNT(DISTINCT t.TRAN_TYPE, t.vchr_no) AS cnt
           FROM tran_acc t
          WHERE ${W}
          GROUP BY dc`,
        P
      );
      const [all] = await q(
        `SELECT COUNT(DISTINCT t.TRAN_TYPE, t.vchr_no) AS cnt FROM tran_acc t WHERE ${W}`,
        P
      );

      // By transaction type, per side
      const typeRows = await q(
        `SELECT t.TRAN_TYPE AS type, ${DC} AS dc,
                tt.TYPE_DES AS des, tt.TYPE_ABBR AS abbr,
                SUM(COALESCE(t.AMOUNT, 0)) AS amt,
                COUNT(DISTINCT t.vchr_no) AS cnt
           FROM tran_acc t
           LEFT JOIN tran_type tt ON tt.TRAN_TYPE = t.TRAN_TYPE
          WHERE ${W}
          GROUP BY t.TRAN_TYPE, dc, tt.TYPE_DES, tt.TYPE_ABBR
          ORDER BY amt DESC`,
        P
      );

      // Largest 10 vouchers per side
      const topFor = (side) =>
        q(
          `SELECT t.TRAN_TYPE AS type, tt.TYPE_ABBR AS abbr, t.vchr_no AS vchrNo,
                  DATE_FORMAT(MIN(t.DATTE), '%d/%m/%Y') AS date,
                  SUM(COALESCE(t.AMOUNT, 0)) AS amount,
                  MAX(t.NARRATION1) AS narration
             FROM tran_acc t
             LEFT JOIN tran_type tt ON tt.TRAN_TYPE = t.TRAN_TYPE
            WHERE ${W} AND ${DC} = ?
            GROUP BY t.TRAN_TYPE, tt.TYPE_ABBR, t.vchr_no
            ORDER BY amount DESC
            LIMIT 10`,
          [...P, side]
        );
      const [topDr, topCr] = await Promise.all([topFor("D"), topFor("C")]);

      // Every month in the range, zero-filled
      const byYm = {};
      for (const r of monthRows) {
        const m = (byYm[r.ym] = byYm[r.ym] || { dr: 0, cr: 0, drCnt: 0, crCnt: 0 });
        if (r.dc === "D") { m.dr += num(r.amt); m.drCnt += num(r.cnt); }
        else if (r.dc === "C") { m.cr += num(r.amt); m.crCnt += num(r.cnt); }
      }
      const months = [];
      let y = Number(from.slice(0, 4)), mo = Number(from.slice(5, 7));
      const yEnd = Number(to.slice(0, 4)), mEnd = Number(to.slice(5, 7));
      while (y < yEnd || (y === yEnd && mo <= mEnd)) {
        const ym = `${y}-${String(mo).padStart(2, "0")}`;
        months.push({ ym, ...(byYm[ym] || { dr: 0, cr: 0, drCnt: 0, crCnt: 0 }) });
        mo += 1;
        if (mo > 12) { mo = 1; y += 1; }
      }

      const side = (dc) => sideRows.find((r) => r.dc === dc) || { amt: 0, cnt: 0 };
      const dr = side("D"), cr = side("C");
      const mapType = (r) => ({
        type: String(r.type || "").trim(),
        des: String(r.des || "").trim(),
        abbr: String(r.abbr || "").trim(),
        amt: num(r.amt),
        cnt: num(r.cnt),
      });
      const mapTop = (r) => ({
        type: String(r.type || "").trim(),
        abbr: String(r.abbr || r.type || "").trim(),
        vchrNo: String(r.vchrNo || "").trim(),
        date: r.date || "",
        amount: num(r.amount),
        narration: r.narration || "",
      });

      res.json({
        account: { code: acc, head: accRow ? accRow.head : "" },
        period,
        from,
        to,
        totals: {
          dr: num(dr.amt), cr: num(cr.amt),
          drCnt: num(dr.cnt), crCnt: num(cr.cnt),
          vouchers: num(all && all.cnt),
        },
        months,
        byType: {
          D: typeRows.filter((r) => r.dc === "D").map(mapType),
          C: typeRows.filter((r) => r.dc === "C").map(mapType),
        },
        top: { D: topDr.map(mapTop), C: topCr.map(mapTop) },
      });
    } catch (err) {
      console.error("acc-txn-analysis:", err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
