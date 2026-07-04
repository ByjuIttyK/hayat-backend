// fa_routes.js
const express = require('express');

module.exports = function (connection) {
  const router = express.Router();

  router.get('/facatlst', function (req, res) {
    connection.query(
      "select CAT_CODE, CAT_NAME, ASSET_GL_ACC, ACCUM_DEP_GL_ACC, DEP_EXP_GL_ACC, DEP_METHOD, USEFUL_LIFE_YEARS, DEP_RATE_PCT, ACTIVE_FLAG from hayat_fa.fa_category_mst order by CAT_CODE",
      {},
      function (error, results) {
        if (error) throw error;
        res.json(results);
      }
    );
  });

  // fa_asset_mst, fa_dep_run_hdr, transfer, disposal routes go here too...
  router.get('/faassetlst', function (req, res) {
    connection.query(
      "SELECT ASSET_CODE, ASSET_NAME, CAT_CODE, LOCATION, JOB_NO, SUP_CODE, ACQ_DATE, ACQ_COST, ACQ_VCHR_TYPE, ACQ_VCHR_NO, DEP_METHOD, STATUS FROM  hayat_fa.fa_asset_mst order by asset_code",
      {},
      function (error, results) {
        if (error) throw error;
        res.json(results);
      }
    );
  });
  // Next catg Code

  router.get('/facat-next-code/:id', function (req, res) {
    connection.query(
      "select LPAD(COALESCE(MAX(CAT_CODE), 0) + 1, 3, '0') as MaxCatCode from hayat_fa.fa_category_mst",
      {},
      function (error, results) {
        //  if (error) throw error;
        if (error) {
          console.error("facat-next-code error:", error);
          return res.status(500).json({ error: "Failed to generate category code" });
        }
        console.log('facatg=',results);
        res.json(results);
      }
    );
  });

   router.get('/faasset-next-code/:id', function (req, res) {
    connection.query(
      "select LPAD(COALESCE(MAX(ASSET_CODE), 0) + 1, 3, '0') as MaxAssetCode from hayat_fa.fa_asset_mst",
      {},
      function (error, results) {
        //  if (error) throw error;
        if (error) {
          console.error("facat-next-code error:", error);
          return res.status(500).json({ error: "Failed to generate asset code" });
        }
        console.log('faAssetCd=',results);
        res.json(results);
      }
    );
  });
  return router;
};