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

 router.post("/facat-save", async (req, res) => {
    const db = connection.promise();          // ← must stay
    const {
        Pmode, CAT_CODE, CAT_NAME,
        ASSET_GL_ACC, ACCUM_DEP_GL_ACC, DEP_EXP_GL_ACC,
        DEP_METHOD, USEFUL_LIFE_YEARS, DEP_RATE_PCT, ACTIVE_FLAG,
    } = req.body;

    if (!CAT_CODE || !CAT_NAME || !ASSET_GL_ACC || !ACCUM_DEP_GL_ACC || !DEP_EXP_GL_ACC) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    const cols = {
        CAT_NAME,
        ASSET_GL_ACC,
        ACCUM_DEP_GL_ACC,
        DEP_EXP_GL_ACC,
        DEP_METHOD: DEP_METHOD || "SLM",
        USEFUL_LIFE_YEARS: USEFUL_LIFE_YEARS === "" || USEFUL_LIFE_YEARS == null ? null : USEFUL_LIFE_YEARS,
        DEP_RATE_PCT: DEP_RATE_PCT === "" || DEP_RATE_PCT == null ? null : DEP_RATE_PCT,
        ACTIVE_FLAG: ACTIVE_FLAG || "Y",
    };

    try {
        if (Pmode === "EDIT") {
            const [r] = await db.query(
                "UPDATE hayat_fa.fa_category_mst SET ?, UPDATED_AT = NOW() WHERE CAT_CODE = ?",
                [cols, CAT_CODE]
            );
            if (r.affectedRows === 0) {
                return res.status(404).json({ error: "Category not found" });
            }
            return res.json({ CAT_CODE });
        }

        // ADD — optimistic insert with duplicate-key retry
        let codeToUse = CAT_CODE;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await db.query(
                    "INSERT INTO hayat_fa.fa_category_mst SET CAT_CODE = ?, ?",
                    [codeToUse, cols]
                );
                return res.json({ CAT_CODE: codeToUse });
            } catch (err) {
                if (err.code !== "ER_DUP_ENTRY") throw err;
                // Same expression as /facat-next-code — keep them identical
                const [[row]] = await db.query(
                    "select LPAD(COALESCE(MAX(CAT_CODE), 0) + 1, 3, '0') as MaxCatCode from hayat_fa.fa_category_mst"
                );
                codeToUse = row.MaxCatCode;
            }
        }
        return res.status(409).json({ error: "Could not allocate a unique category code" });
    } catch (err) {
        console.error("facat-save error:", err);
        return res.status(500).json({ error: "Error saving asset category" });
    }
});
// ── POST /faasset-save ──────────────────────────────────────────────
  router.post("/faasset-save", async (req, res) => {
    console.log('faasset-save api touched===>');
    const db = connection.promise();
    const {
      Pmode, ASSET_CODE, ASSET_NAME, CAT_CODE, LOCATION, JOB_NO, SUP_CODE,
      ACQ_DATE, ACQ_COST, ACQ_VCHR_TYPE, ACQ_VCHR_NO, DEP_METHOD, STATUS,
    } = req.body;

    if (!ASSET_CODE || !ASSET_NAME || !CAT_CODE || !ACQ_DATE || ACQ_COST == null || ACQ_COST === "") {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // '' → NULL for optional varchar columns
    const nz = (v) => (v === "" || v == null ? null : v);

    try {
      // Life & rate come from the category (not on the asset form, but NOT NULL in the table)
      const [[cat]] = await db.query(
        "SELECT USEFUL_LIFE_YEARS, DEP_RATE_PCT FROM hayat_fa.fa_category_mst WHERE CAT_CODE = ?",
        [CAT_CODE]
      );
      if (!cat) return res.status(400).json({ error: `Invalid category: ${CAT_CODE}` });

      const cols = {
        ASSET_NAME,
        CAT_CODE,
        LOCATION: nz(LOCATION),
        JOB_NO: nz(JOB_NO),
        SUP_CODE: nz(SUP_CODE),
        ACQ_DATE,                                  // 'YYYY-MM-DD' from <input type="date">
        ACQ_COST,
        ACQ_VCHR_TYPE: nz(ACQ_VCHR_TYPE),
        ACQ_VCHR_NO: nz(ACQ_VCHR_NO),
        DEP_METHOD: DEP_METHOD || "SLM",
        USEFUL_LIFE_YEARS: cat.USEFUL_LIFE_YEARS,
        DEP_RATE_PCT: cat.DEP_RATE_PCT,
        STATUS: STATUS || "ACTIVE",
      };

      if (Pmode === "EDIT") {
        // NBV re-computed from the NEW cost and the EXISTING accumulated depreciation.
        const [r] = await db.query(
          "UPDATE hayat_fa.fa_asset_mst SET ?, NBV = ACQ_COST - ACCUM_DEP WHERE ASSET_CODE = ?",
          [cols, ASSET_CODE]
        );
        if (r.affectedRows === 0) {
          return res.status(404).json({ error: "Asset not found" });
        }
        return res.json({ ASSET_CODE });
      }

      if (Pmode !== "ADD") {
        return res.status(400).json({ error: `Invalid Pmode: ${Pmode}` });
      }

      // ADD — new asset: no depreciation yet, so NBV = ACQ_COST.
      // SALVAGE_VALUE / ACCUM_DEP fall back to their column defaults (0.00).
      let codeToUse = ASSET_CODE;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await db.query(
            "INSERT INTO hayat_fa.fa_asset_mst SET ASSET_CODE = ?, ?, NBV = ?",
            [codeToUse, cols, ACQ_COST]
          );
          return res.json({ ASSET_CODE: codeToUse });
        } catch (err) {
          if (err.code !== "ER_DUP_ENTRY") throw err;
          // Same expression as /faasset-next-code — keep them identical
          const [[row]] = await db.query(
            "select LPAD(COALESCE(MAX(ASSET_CODE), 0) + 1, 3, '0') as MaxAssetCode from hayat_fa.fa_asset_mst"
          );
          codeToUse = row.MaxAssetCode;
        }
      }
      return res.status(409).json({ error: "Could not allocate a unique asset code" });
    } catch (err) {
      console.error("faasset-save error:", err);
      return res.status(500).json({ error: "Error saving fixed asset" });
    }
  });

  // ── GET /asset/:id — single-record fetch for EDIT/VIEW mode ─────────
  router.get("/asset/:id", function (req, res) {
    connection.query(
      "SELECT * FROM hayat_fa.fa_asset_mst WHERE ASSET_CODE = ?",
      [req.params.id],
      function (error, results) {
        if (error) {
          console.error("asset fetch error:", error);
          return res.status(500).json({ error: "Failed to fetch asset" });
        }
        res.json(results);
      }
    );
  });

  return router;
};