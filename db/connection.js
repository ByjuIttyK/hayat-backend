// db/connection.js
// MySQL connection pool — shared across all route modules
// Extracted from HayatDb.js

require('dotenv').config();
const mysql = require('mysql2');

const dbIp   = process.env.DB_HOST;
const dbPort = '3306';

const connection = mysql.createPool({
  host:     dbIp,
  port:     dbPort,
  user:     'root',
  password: 'Digital@65',
  database: 'hayat',
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  charset:            'utf8mb4',
  typeCast: function (field, next) {
    if (field.type === 'JSON') {
      return field.string('utf8');
    }
    return next();
  },
});

module.exports = connection;
//module.exports = connection.promise();
