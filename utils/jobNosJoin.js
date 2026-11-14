// utils/jobNosJoin.js
// Job numbers of a voucher, for the RV / PV lists (14-Nov-2026).
//
// Two sources, merged and de-duplicated:
//   1. Settled invoices:  adj_dtl (SOURCE_TYPE, SOURCE_DOC = voucher), STLD_TYPE '06' (sales invoice)
//                         → STLD_DOC → fab_inv_hdr.INV_NO → JOB_NO
//                         (STLD_TYPE stops a supplier invoice with the same number matching)
//   2. Voucher lines:     tran_acc.JOB_NO of the voucher's own lines
//
// Returns a LEFT JOIN aliased "jn" giving per voucher:
//   jn.JOB_NOS   '3119, 3398, 3399'   (sorted, comma separated)
//   jn.JOB_COUNT 3
//
// Usage (the main table must be aliased "v"):
//   const jobs = jobNosJoin(tranId);
//   sql:    "... " + jobs.sql + "WHERE v.TRAN_TYPE = ? ..."
//   select: "COALESCE(NULLIF(v.JOB_NO,''), jn.JOB_NOS) AS JOB_NO, jn.JOB_COUNT, "
//   params: [...before, ...jobs.params, ...after]   — jobs.params has 2 values
//
// Indexes that keep it fast:
//   CREATE INDEX ix_adj_src ON adj_dtl (SOURCE_TYPE, SOURCE_DOC, STLD_DOC);
//   CREATE INDEX ix_tranacc_type_vchr_job ON tran_acc (TRAN_TYPE, VCHR_NO, JOB_NO);
//   fab_inv_hdr.INV_NO should be the primary key or indexed.

module.exports = function jobNosJoin(tranId) {
  const t = String(tranId);
  const sql =
    "LEFT OUTER JOIN (" +
    "  SELECT TRAN_TYPE, VCHR_NO, " +
    "         GROUP_CONCAT(DISTINCT JOB_NO ORDER BY JOB_NO SEPARATOR ', ') AS JOB_NOS, " +
    "         COUNT(DISTINCT JOB_NO) AS JOB_COUNT " +
    "  FROM (" +
    "    SELECT a.SOURCE_TYPE AS TRAN_TYPE, a.SOURCE_DOC AS VCHR_NO, f.JOB_NO " +
    "      FROM adj_dtl a " +
    "      JOIN fab_inv_hdr f ON f.INV_NO = a.STLD_DOC " +
    "     WHERE a.SOURCE_TYPE = ? AND a.STLD_TYPE = '06' " +   // 06 = fab / sales invoice
    "    UNION ALL " +
    "    SELECT TRAN_TYPE, VCHR_NO, JOB_NO FROM tran_acc WHERE TRAN_TYPE = ? " +
    "  ) jx " +
    "  WHERE JOB_NO IS NOT NULL AND JOB_NO <> '' " +
    "  GROUP BY TRAN_TYPE, VCHR_NO) jn " +
    "  ON jn.TRAN_TYPE = v.TRAN_TYPE AND jn.VCHR_NO = v.VCHR_NO ";
  return { sql, params: [t, t] };
};
