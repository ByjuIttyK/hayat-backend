module.exports = function (connection) {
  const express = require('express');
  const router = express.Router();

  router.post('/run-stream', async (req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    const conn = connection.promise();

    const send = (obj) => res.write(JSON.stringify(obj) + '\n');

    try {
      const [rows] = await conn.query(
        'SELECT table_name, reset_field_1, reset_field_2, order_field FROM srno_config'
      );

      for (const cfg of rows) {
        const t = cfg.table_name;
        try {
          // Step 1: ensure a join key exists
          const [aiCols] = await conn.query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
               AND EXTRA LIKE '%auto_increment%' LIMIT 1`,
            [t]
          );

          let keyCol;
          if (aiCols.length === 0) {
            await conn.query(`ALTER TABLE \`${t}\` ADD COLUMN \`srno_row_id\` BIGINT AUTO_INCREMENT UNIQUE`);
            keyCol = 'srno_row_id';
            send({ table: t, step: 'add_key', status: 'added srno_row_id' });
          } else {
            keyCol = aiCols[0].COLUMN_NAME;
            send({ table: t, step: 'add_key', status: `using existing key (${keyCol})` });
          }

          // Step 2: renumber
          let partition = `\`${cfg.reset_field_1}\``;
          if (cfg.reset_field_2) partition += `, \`${cfg.reset_field_2}\``;
          const orderBy = cfg.order_field ? `\`${cfg.order_field}\`` : `\`${keyCol}\``;

          const sql = `
            UPDATE \`${t}\` tgt
            JOIN (
              SELECT \`${keyCol}\` AS _key,
                     ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY ${orderBy}) AS _rn
              FROM \`${t}\`
            ) src ON tgt.\`${keyCol}\` = src._key
            SET tgt.\`SR_NO\` = LPAD(src._rn, 4, '0')
          `;
          const [result] = await conn.query(sql);
          send({ table: t, step: 'renumber', status: 'ok', rowsUpdated: result.affectedRows });

        } catch (tableErr) {
          send({ table: t, step: 'error', status: tableErr.message });
          // continue to next table rather than aborting the whole run
        }
      }

      send({ done: true });
      res.end();
    } catch (err) {
      send({ done: true, fatalError: err.message });
      res.end();
    }
  });

  return router;
};