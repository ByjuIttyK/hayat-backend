const express = require("express");

// Factory-pattern router — matches your existing convention
module.exports = function (connection) {
  const router = express.Router();

  router.post('/save-current-chq', async (req, res) => {
    const { currentChqData } = req.body;

    if (!currentChqData || currentChqData.length === 0) {
      return res.status(200).json({
        message: 'No current cheques to save'
      });
    }

    // `connection` here is a raw (callback-style) mysql2 Pool.
    // .promise() gives us the Promise-wrapped version.
    // We must pull ONE dedicated connection out of the pool for the
    // whole transaction — otherwise START TRANSACTION / INSERT / COMMIT
    // could each run on a *different* pooled connection and the
    // transaction would do nothing.
    const promisePool = connection.promise();
    let conn;

    try {
      conn = await promisePool.getConnection();
      await conn.beginTransaction();

      for (const chq of currentChqData) {
        const insertQuery = `
          INSERT INTO current_chq 
          (TRAN_TYPE, VCHR_NO, VCHR_DATE, CHQ_NO, CHQ_DATE, CHQ_BANK, 
           PDC_CODE, SUP_CODE, AMOUNT, NARRATION, JV_NO_RLZ, JV_DATE_RLZ, 
           REALISED, MAIN_SR_NO)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            CHQ_DATE = VALUES(CHQ_DATE),
            CHQ_BANK = VALUES(CHQ_BANK),
            AMOUNT = VALUES(AMOUNT),
            NARRATION = VALUES(NARRATION)
        `;

        const params = [
          chq.TranType,
          chq.VchrNo,
          chq.VchrDate,
          chq.ChqNo,
          chq.ChqDate,
          chq.ChqBank,
          chq.PdcCode,
          chq.SupCode,
          chq.Amount,
          chq.Narration,
          chq.JvNoRlz,
          chq.JvDateRlz,
          chq.Realised,
          chq.MainSrNo
        ];

        await conn.execute(insertQuery, params);
      }

      await conn.commit();

      res.status(200).json({
        success: true,
        message: `${currentChqData.length} current cheque(s) saved successfully`,
        count: currentChqData.length
      });

    } catch (error) {
      if (conn) {
        try {
          await conn.rollback();
        } catch (rollbackError) {
          console.error('Error during rollback:', rollbackError);
        }
      }

      console.error('Error saving current cheques:', error);
      res.status(500).json({
        success: false,
        message: 'Error saving current cheques',
        error: error.message
      });
    } finally {
      // Always return the connection to the pool
      if (conn) conn.release();
    }
  });

  return router;
};
