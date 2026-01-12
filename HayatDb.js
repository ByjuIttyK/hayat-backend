///https://www.js-tutorials.com/nodejs-tutorial/node-js-rest-api-add-edit-delete-record-mysql-using-express/

//https://www.youtube.com/watch?v=LmIsbzt-S_E
require('dotenv').config();
const cors = require("cors");
var http = require("http");
var express = require("express");
var app = express();
//old
var mysql = require("mysql2");  // Import MySQL client
// 👇 new version for async/await queries
const mysqlPromise = require("mysql2/promise");

const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

var bodyParser = require("body-parser");
const { error } = require("console");
const JWT_SECRET = process.env.JWT_SECRET;
//const express = require('express');
//const app = express();

app.use(express.json());  // ✅ Enables JSON request body parsing
app.use(express.urlencoded({ extended: true })); // ✅ Parses URL-encoded data

dbIp = process.env.DB_HOST;
//var dbIp = "192.168.1.11";  // MySQL server IP
//var dbIp = "192.168.162.69";  // MySQL server IP
var dbPort = "3306";         // Default MySQL port
var dbAddr = "http://" + dbIp + ":" + dbPort;
var clientAddr = "http://"+process.env.DB_HOST+":3000";  // Client address for CORS
//var clientAddr = "http://192.168.1.11:3000";  // Client address for CORS
// MySQL connection details
var connection = mysql.createPool({
  host: dbIp,
  port: dbPort,
  user: 'root',         // Replace with your MySQL username
  password: 'Digital@65',         // Replace with your MySQL password
  database: 'hayat',    // Your database name
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  typeCast: function (field, next) {
    if (field.type === 'JSON') {
      return field.string('utf8'); // Return JSON as string with utf8 encoding
    }
    return next();
  },
});

// Use CORS
app.use(cors());
app.use(function (req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", clientAddr);  // React port
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, PATCH, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "X-Requested-With,content-type");
  res.setHeader("Access-Control-Allow-Credentials", true);
  next();
});

// Start body-parser configuration
//  Commented on 22/2/2025 -start 
//app.use(express.json());
///app.use(bodyParser.json());
///app.use(bodyParser.urlencoded({ extended: true }));
/// End body-parser configuration
//  Commented on 22/2/2025 - end 
// Create app server
var server = app.listen(3001, dbIp, function () {
  var host = server.address().address;
  var port = server.address().port;

  console.log("Server listening at http://%s:%s", host, port);
});
const authMiddleware = require("./middleware/authMiddleware");

/* Public API (NO token required) */
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;

  connection.query(
    "SELECT * FROM users WHERE username = ? AND is_active = 1",
    [username],
    async (err, rows) => {

      if (err) {
        console.error("DB Error:", err);
        return res.status(500).json({ message: "Database error" });
      }

      if (rows.length === 0) {
        return res
          .status(401)
          .json({ message: "Invalid username or password" });
      }

      const user = rows[0];
    //  console.log("user =", user);

      try {
        const match = await bcrypt.compare(password, user.password_hash);

        if (!match) {
          return res
            .status(401)
            .json({ message: "Invalid username or password" });
        }
       // console.log("JWT_SECRET =", process.env.JWT_SECRET);

        const token = jwt.sign(
          { id: user.id, username: user.username, role: user.role },
          JWT_SECRET,
          { expiresIn: "8h" }
        );

        res.json({
          token,
          user: {
            username: user.username,
            role: user.role,
          },
        });

      } catch (bcryptErr) {
        console.error("Bcrypt error:", bcryptErr);
        res.status(500).json({ message: "Password check failed" });
      }
    }
  );
});
/* Protect everything below */
//app.use("/api", authMiddleware);
app.get('/api/column-metadata/:tableId', (req, res) => {
  //  console.log("Fetching column metadata");
  const { tableId } = req.params;

  const query = 'SELECT * FROM column_metadata WHERE module_name = ? ORDER BY column_id ';

  connection.query(query, [tableId], (err, rows) => {
    if (err) {
      console.error("Error executing query:", err);
      return res.status(500).json({ error: "Failed to fetch data" });
    }

    try {
      const metadata = {
        table_id: tableId,
        columns: rows.map(row => ({
          field: row.field,
          headerName: row.header_name,
          sortable: Boolean(row.sortable),
          editable: Boolean(row.editable),
          flex: row.flex,
          cellStyle: (() => {
            if (!row.cell_style) return {}; // Handle NULL
            try {
              return JSON.parse(row.cell_style);
            } catch (e) {
              console.error(`Invalid JSON in cell_style for field ${row.field}:`, e);
              return {}; // Return empty object on error
            }
          })(),
        })),
      };
      ////  console.log("column_metadata", metadata);
      res.json(metadata);
    } catch (err) {
      console.error("Error processing metadata:", err);
      res.status(500).json({ error: "Failed to process metadata" });
    }

  });
});

app.get('/api/smart-grid-columns/:tableId', (req, res) => {
  const { tableId } = req.params;

  if (!tableId) {
    console.error("Invalid tableId provided");
    return res.status(400).json({ error: "Invalid tableId" });
  }

  console.log("FETCHING ** smart_grid_columns metadata for tableId:", tableId);

  const query = 'SELECT * FROM smart_grid_columns WHERE module_name = ? order by column_id';

  connection.query(query, [tableId], (err, rows) => {
    if (err) {
      console.error("Error executing query:", err);
      return res.status(500).json({ error: "Failed to fetch data" });
    }
    try {
      const metadata = {
        table_id: tableId,
        columns: rows.map(row => ({
          field: row.field,
          headerName: row.header_name,
          sortable: Boolean(row.sortable),
          editable: Boolean(row.editable),
          hide: Boolean(row.hide),
          flex: row.flex,
          width: row.width,
          cellStyle: (() => {
            if (!row.cell_style) return {}; // Handle NULL
            try {
              return JSON.parse(row.cell_style);
            } catch (e) {
              console.error(`Invalid JSON in cell_style for field ${row.field}:`, e);
              return {}; // Return empty object on error
            }
          })(),
        })),
      };

      return res.json(metadata);
    } catch (err) {
      console.error("Error processing metadata:", err);
      return res.status(500).json({ error: "Failed to process metadata" });
    }
    // console.log("Rows fetched successfully:", rows);
    // return res.json(rows);
  });
});


app.get('/api/gridoptionsmst/:tableId', (req, res) => {
  console.log("Fetching gridOptionsMst", req.params.tableId);
  const { tableId } = req.params.tableId;
  const query = 'SELECT * FROM grid_option_mst WHERE module_name = ?';

  connection.query(query, [req.params.tableId], (err, rows, fields) => {
    if (err) {
      console.error("Error executing query:", err);
      return res.status(500).json({ error: "Failed to fetch grid_Option_Mst data" });
    }
    //  console.log('GRID =', rows);
    res.json(rows);
  });
});

app.get('/api/fetchentryform/:tableId/:submodule', (req, res) => {
  console.log("Fetching gridOptionsMst  ===>", req.params.tableId, req.params.submodule);
  const { tableId } = req.params.tableId;
  const query = 'SELECT * FROM grid_option_mst WHERE module_name = ? and  sub_module = ?';

  connection.query(query, [req.params.tableId, req.params.submodule], (err, rows, fields) => {
    if (err) {
      console.error("Error executing query:", err);
      return res.status(500).json({ error: "Failed to fetch grid_Option_Mst data" });
    }
    console.log('fetchentryform =', rows);
    res.json(rows);
  });
});
app.get('/api/report_parameters/:rep', (req, res) => {
  console.log("Fetching report_parameters", req.params.rep);
  // const { tableId } = req.params.rep;
  const query = 'SELECT * FROM report_parameters WHERE module_name = ?';

  connection.query(query, [req.params.rep], (err, rows, fields) => {
    if (err) {
      console.error("Error executing query:", err);
      return res.status(500).json({ error: "Failed to fetch report_parameters" });
    }
    console.log('GRID =', rows);
    res.json(rows);
  });
});
app.get('/lovmetadata/:rep', (req, res) => {
  console.log("Fetching Lov metatdata", req.params.rep);
  // const { tableId } = req.params.rep;
  const query = 'SELECT * FROM column_metadata_lov WHERE lovHdr = ?';

  connection.query(query, [req.params.rep], (err, rows, fields) => {
    if (err) {
      console.error("Error executing query:", err);
      return res.status(500).json({ error: "Failed to fetch column_metedata_lov" });
    }
    console.log('LOV Column_metatdata =', rows);
    res.json(rows);
  });
});

app.post("/save-lpo", async (req, res) => {
  try {
    console.log("save-lpo ==>", req.body);
    const { lpoNet, lpoItems } = req.body;
    if (!lpoNet || !lpoItems || !Array.isArray(lpoItems) || lpoItems.length === 0) {
      return res.status(400).json({ message: "Invalid lpo data format" });
    }
    console.log("LPO Net ==>", lpoNet);
    console.log("LPO Items ==>", lpoItems);
    connection.getConnection((err, conn) => {
      if (err) {
        console.error("Error getting connection:", err);
        return res.status(500).json({ message: "Error getting connection" });
      }

      conn.beginTransaction(async (err) => {
        if (err) {
          console.error("Transaction Error:", err);
          conn.release(); // Release the connection back to the pool
          return res.status(500).json({ message: "Transaction error", error: err });
        }

        try {
          // ✅ Step 1: Insert/Update NGP_NET table
          const netQuery = `
          INSERT INTO lpo_net (LPO_NO, LPO_DATE, SUP_CODE,NARRATION,AMOUNT) 
          VALUES (?, ?, ?, ?,?) 
          ON DUPLICATE KEY UPDATE 
          LPO_DATE= VALUES(LPO_DATE),
          SUP_CODE = VALUES(SUP_CODE),
          NARRATION = VALUES(NARRATION),
          AMOUNT= VALUES(AMOUNT);
        `;

          await new Promise((resolve, reject) => {
            conn.query(
              netQuery,
              [lpoNet.LpoNo, lpoNet.LpoDt, lpoNet.SupCd, lpoNet.Narration, lpoNet.Amount],
              (err, result) => {
                if (err) {
                  return reject(err);
                }
                console.log("NGP_NET Insert/Update:", result);
                resolve(result);
              }
            );
          });
          // ✅ Step 2: Insert/Update NGP_ITEMS table
          const itemsQuery = `
              INSERT INTO lpo_items (LPO_NO, SR_NO, MAIN_SR_NO, ITEM_CODE, ITEM_NAME, QTY,UNIT, RATE)
              VALUES ? 
              ON DUPLICATE KEY UPDATE 
              ITEM_CODE = COALESCE(VALUES(ITEM_CODE), ITEM_CODE), 
              ITEM_NAME = COALESCE(VALUES(ITEM_NAME), ITEM_NAME), 
              QTY       = COALESCE(VALUES(QTY), QTY), 
              UNIT      = COALESCE(VALUES(UNIT),UNIT), 
              RATE      = COALESCE(VALUES(RATE), RATE);
            `;
          const values = lpoItems.map(row => [
            row.LPO_NO, row.SR_NO, row.MAIN_SR_NO, row.ITEM_CODE, row.ITEM_NAME,
            row.QTY, row.UNIT, row.RATE
          ]);

          await new Promise((resolve, reject) => {
            conn.query(itemsQuery, [values], (err, result) => {
              if (err) {
                return reject(err);
              }
              console.log("LPO_ITEMS Insert/Update:", result);
              resolve(result);
            });
          });


          conn.commit((err) => {
            if (err) {
              console.error("Commit Error:", err);
              return res.status(500).json({ message: "Commit error", error: err });
            }
            conn.release(); // Release the connection back to the pool
            res.json({ message: "LPO saved successfully!" });
          });

        } catch (error) {
          console.error("Transaction Failed:", error);
          conn.rollback(() => {
            conn.release(); // Release the connection back to the pool
            res.status(500).json({ message: "Transaction failed, rolled back", error });
          });
        };
      });
    });
  } catch (error) {
    console.log("Lpo save - internal error :", error)
    res.status(500).json({ message: "Internal Server Error", error });
  }
});


app.post("/save-fpo", async (req, res) => {
  try {
    console.log("save-fpo ==>", req.body);
    const { lpoNet, lpoItems } = req.body;
    if (!lpoNet || !lpoItems || !Array.isArray(lpoItems) || lpoItems.length === 0) {
      return res.status(400).json({ message: "Invalid lpo data format" });
    }
    console.log("FPO Net ==>", lpoNet);
    console.log("FPO Items ==>", lpoItems);
    connection.getConnection((err, conn) => {
      if (err) {
        console.error("Error getting connection:", err);
        return res.status(500).json({ message: "Error getting connection" });
      }

      conn.beginTransaction(async (err) => {
        if (err) {
          console.error("Transaction Error:", err);
          conn.release(); // Release the connection back to the pool
          return res.status(500).json({ message: "Transaction error", error: err });
        }

        try {
          // ✅ Step 1: Insert/Update NGP_NET table
          const netQuery = `
          INSERT INTO fpo_net (FPO_NO,FPO_DATE, SUP_CODE,YR_REF_NO,PAY_TERMS,FPO_NOTES,AMOUNT) 
          VALUES (?, ?, ?, ?,?,?,?) 
          ON DUPLICATE KEY UPDATE 
          FPO_DATE= VALUES(FPO_DATE),
          SUP_CODE = VALUES(SUP_CODE),
          YR_REF_NO = VALUES(YR_REF_NO),
          PAY_TERMS = VALUES(PAY_TERMS),
          FPO_NOTES =  VALUES(FPO_NOTES),
          AMOUNT = VALUES(AMOUNT);
          `;

          await new Promise((resolve, reject) => {
            conn.query(
              netQuery,
              [lpoNet.FpoNo, lpoNet.FpoDt, lpoNet.SupCd, lpoNet.YourRef, lpoNet.Payterms, lpoNet.FpoNotes, lpoNet.Amount],
              (err, result) => {
                if (err) {
                  return reject(err);
                }
                console.log("FPO_NET Insert/Update:", result);
                resolve(result);
              }
            );
          });
          // ✅ Step 2: Insert/Update NGP_ITEMS table
          const itemsQuery = `
              INSERT INTO fpo_items (FPO_NO, SR_NO, MAIN_SR_NO, ITEM_CODE, ITEM_NAME, QTY,UNIT, RATE)
              VALUES ? 
              ON DUPLICATE KEY UPDATE 
              ITEM_CODE = COALESCE(VALUES(ITEM_CODE), ITEM_CODE), 
              ITEM_NAME = COALESCE(VALUES(ITEM_NAME), ITEM_NAME), 
              QTY       = COALESCE(VALUES(QTY), QTY), 
              UNIT      = COALESCE(VALUES(UNIT),UNIT), 
              RATE      = COALESCE(VALUES(RATE), RATE);
            `;
          const values = lpoItems.map(row => [
            row.FPO_NO, row.SR_NO, row.MAIN_SR_NO, row.ITEM_CODE, row.ITEM_NAME,
            row.QTY, row.UNIT, row.RATE
          ]);

          await new Promise((resolve, reject) => {
            conn.query(itemsQuery, [values], (err, result) => {
              if (err) {
                return reject(err);
              }
              console.log("FPO_ITEMS Insert/Update:", result);
              resolve(result);
            });
          });


          conn.commit((err) => {
            if (err) {
              console.error("Commit Error:", err);
              return res.status(500).json({ message: "Commit error", error: err });
            }
            conn.release(); // Release the connection back to the pool
            res.json({ message: "FPO saved successfully!" });
          });

        } catch (error) {
          console.error("Transaction Failed:", error);
          conn.rollback(() => {
            conn.release(); // Release the connection back to the pool
            res.status(500).json({ message: "Transaction failed, rolled back", error });
          });
        };
      });
    });
  } catch (error) {
    console.log("Fpo save - internal error :", error)
    res.status(500).json({ message: "Internal Server Error", error });
  }
});
app.post("/save-ngp", async (req, res) => {
  try {
    const { netData, itemsData } = req.body; // Extract form data & grid rows from payload

    if (!netData || !itemsData || !Array.isArray(itemsData) || itemsData.length === 0) {
      return res.status(400).json({ message: "Invalid data format" });
    }
    console.log("NGP_NET=>**", netData);
    // Start transaction
    connection.getConnection((err, conn) => {
      if (err) {
        console.error("Error getting connection:", err);
        return res.status(500).json({ message: "Error getting connection" });
      }

      conn.beginTransaction(async (err) => {
        if (err) {
          console.error("Transaction Error:", err);
          conn.release(); // Release the connection back to the pool
          return res.status(500).json({ message: "Transaction error", error: err });
        }

        try {
          // ✅ Step 1: Insert/Update NGP_NET table
          const netQuery = `
            INSERT INTO ngp_net (PRCH_NO, PRCH_DATE, SUP_CODE,NARRATION,AMOUNT,DISCOUNT) 
            VALUES (?, ?, ?, ?,?,?) 
            ON DUPLICATE KEY UPDATE 
            PRCH_DATE= VALUES(PRCH_DATE),
            SUP_CODE = VALUES(SUP_CODE),
            NARRATION = VALUES(NARRATION),
            AMOUNT = VALUES(AMOUNT),
            DISCOUNT = VALUES(DISCOUNT);
          `;

          await new Promise((resolve, reject) => {
            conn.query(
              netQuery,
              [netData.LpoNo, netData.LpoDt, netData.SupCd, netData.Narration, netData.AMOUNT, netData.discAmt],
              (err, result) => {
                if (err) {
                  return reject(err);
                }
                console.log("NGP_NET Insert/Update:", result);
                resolve(result);
              }
            );
          });

          // ✅ Step 2: Insert/Update NGP_ITEMS table
          const itemsQuery = `
            INSERT INTO ngp_items (PRCH_NO, SR_NO, ACC_CODE, NARRATION, JOB_NO, AMOUNT)
            VALUES ? 
            ON DUPLICATE KEY UPDATE 
            ACC_CODE = COALESCE(VALUES(ACC_CODE), ACC_CODE), 
            NARRATION = COALESCE(VALUES(NARRATION), NARRATION), 
            JOB_NO = COALESCE(VALUES(JOB_NO), JOB_NO), 
            AMOUNT = COALESCE(VALUES(AMOUNT), AMOUNT);
          `;

          const values = itemsData.map(row => [
            row.PRCH_NO, row.SR_NO, row.ACC_CODE, row.NARRATION, row.JOB_NO, row.AMOUNT
          ]);

          await new Promise((resolve, reject) => {
            conn.query(itemsQuery, [values], (err, result) => {
              if (err) {
                return reject(err);
              }
              console.log("NGP_ITEMS Insert/Update:", result);
              resolve(result);
            });
          });

          // ✅ Commit transaction if everything is successful
          conn.commit((err) => {
            if (err) {
              console.error("Commit Error:", err);
              return res.status(500).json({ message: "Commit error", error: err });
            }
            conn.release(); // Release the connection back to the pool
            res.json({ message: "Data saved successfully!" });
          });

        } catch (error) {
          console.error("Transaction Failed:", error);
          conn.rollback(() => {
            conn.release(); // Release the connection back to the pool
            res.status(500).json({ message: "Transaction failed, rolled back", error });
          });
        }
      });
    });
  } catch (error) {
    console.error("Server Error:", error);
    res.status(500).json({ message: "Internal Server Error", error });
  }
});
app.post("/save-localpurch", async (req, res) => {
  try {
    const { netData, itemsData } = req.body; // Extract form data & grid rows from payload

    if (!netData || !itemsData || !Array.isArray(itemsData) || itemsData.length === 0) {
      return res.status(400).json({ message: "Invalid data format" });
    }
    console.log("PURCHASE LOCAL HDR =>**", netData);
    console.log("PURCHASE LOCAL ITEMS =>** ", itemsData);
    // Start transaction
    connection.getConnection((err, conn) => {
      if (err) {
        console.error("Error getting connection:", err);
        return res.status(500).json({ message: "Error getting connection" });
      }

      conn.beginTransaction(async (err) => {
        if (err) {
          console.error("Transaction Error:", err);
          conn.release(); // Release the connection back to the pool
          return res.status(500).json({ message: "Transaction error", error: err });
        }

        try {
          // ✅ Step 1: Insert/Update NGP_NET table
          console.log("PjvNo, PjvDt==>", netData.PjvNo, netData.PjvDt);
          const netQuery = `
            INSERT INTO purchase_hdr (PJV_NO, PJV_DATE, SUP_CODE,NARRATION,INV_AMOUNT,DISCOUNT,VAT_AMOUNT) 
            VALUES (?, ?, ?, ?,?,?,?) 
            ON DUPLICATE KEY UPDATE 
            PJV_DATE= VALUES(PJV_DATE),
            SUP_CODE = VALUES(SUP_CODE),
            NARRATION = VALUES(NARRATION),
            INV_AMOUNT = VALUES(INV_AMOUNT),
            DISCOUNT = VALUES(DISCOUNT),
            VAT_AMOUNT = VALUES(VAT_AMOUNT);
          `;

          await new Promise((resolve, reject) => {
            conn.query(
              netQuery,
              [netData.PjvNo, netData.PjvDt, netData.SupCd,
              netData.Narration, netData.AMOUNT, netData.discAmt, netData.vatAmt],
              (err, result) => {
                if (err) {
                  return reject(err);
                }
                console.log("PURCHASE_HDR Insert/Update:", result);
                resolve(result);
              }
            );
          });

          // ✅ Step 2: Insert/Update NGP_ITEMS table
          const itemsQuery = `
            INSERT INTO purchase_items (SRV_NO, SR_NO, ITEM_CODE, QTY, COST)
            VALUES ? 
            ON DUPLICATE KEY UPDATE 
            ITEM_CODE = COALESCE(VALUES(ITEM_CODE), ITEM_CODE), 
            QTY = COALESCE(VALUES(QTY), QTY), 
            COST = COALESCE(VALUES(COST), COST);
            `;

          const values = itemsData.map(row => [
            row.SRV_NO, row.SR_NO, row.ITEM_CODE, row.QTY, row.COST
          ]);

          await new Promise((resolve, reject) => {
            conn.query(itemsQuery, [values], (err, result) => {
              if (err) {
                return reject(err);
              }
              console.log("PURCHASE_ITEMS Insert/Update:", result);
              resolve(result);
            });
          });

          // ✅ Commit transaction if everything is successful
          conn.commit((err) => {
            if (err) {
              console.error("Commit Error:", err);
              return res.status(500).json({ message: "Commit error", error: err });
            }
            conn.release(); // Release the connection back to the pool
            res.json({ message: "Data saved successfully!" });
          });

        } catch (error) {
          console.error("Transaction Failed:", error);
          conn.rollback(() => {
            conn.release(); // Release the connection back to the pool
            res.status(500).json({ message: "Transaction failed, rolled back", error });
          });
        }
      });
    });
  } catch (error) {
    console.error("Server Error:", error);
    res.status(500).json({ message: "Internal Server Error", error });
  }
});

app.post("/save-pret", async (req, res) => {
  try {
    const { netData, itemsData } = req.body; // Extract form data & grid rows from payload

    if (!netData || !itemsData || !Array.isArray(itemsData) || itemsData.length === 0) {
      return res.status(400).json({ message: "Invalid data format" });
    }
    console.log("PURCHASE RETURN=>**", netData);
    // Start transaction
    connection.getConnection((err, conn) => {
      if (err) {
        console.error("Error getting connection:", err);
        return res.status(500).json({ message: "Error getting connection" });
      }

      conn.beginTransaction(async (err) => {
        if (err) {
          console.error("Transaction Error:", err);
          conn.release(); // Release the connection back to the pool
          return res.status(500).json({ message: "Transaction error", error: err });
        }

        try {
          // ✅ Step 1: Insert/Update NGP_NET table
          console.log("PjvNo, PjvDt==>", netData.PjvNo, netData.PjvDt);
          const netQuery = `
            INSERT INTO pret_hdr (VCHR_NO, VCHR_DATE, SUP_CODE,NARRATION,INV_AMOUNT,VAT_PERC) 
            VALUES (?, ?, ?, ?,?,?) 
            ON DUPLICATE KEY UPDATE 
            VCHR_DATE= VALUES(VCHR_DATE),
            SUP_CODE = VALUES(SUP_CODE),
            NARRATION = VALUES(NARRATION),
            INV_AMOUNT = VALUES(INV_AMOUNT),
            VAT_PERC = VALUES(VAT_PERC);
           
          `;

          await new Promise((resolve, reject) => {
            conn.query(
              netQuery,
              [netData.PjvNo, netData.PjvDt, netData.SupCd,
              netData.Narration, netData.AMOUNT, netData.discAmt, netData.vatAmt],
              (err, result) => {
                if (err) {
                  return reject(err);
                }
                console.log("DO_HDR Insert/Update:", result);
                resolve(result);
              }
            );
          });

          // ✅ Step 2: Insert/Update NGP_ITEMS table
          const itemsQuery = `
            INSERT INTO pret_items (VCHR_NO, SR_NO, ITEM_CODE, QTY, COST)
            VALUES ? 
            ON DUPLICATE KEY UPDATE 
            ITEM_CODE = COALESCE(VALUES(ITEM_CODE), ITEM_CODE), 
            QTY = COALESCE(VALUES(QTY), QTY), 
            COST = COALESCE(VALUES(COST), COST);
            `;

          const values = itemsData.map(row => [
            row.VCHR_NO, row.SR_NO, row.ITEM_CODE, row.QTY, row.COST
          ]);

          await new Promise((resolve, reject) => {
            conn.query(itemsQuery, [values], (err, result) => {
              if (err) {
                return reject(err);
              }
              console.log("PUR_RET_ITEMS Insert/Update:", result);
              resolve(result);
            });
          });

          // ✅ Commit transaction if everything is successful
          conn.commit((err) => {
            if (err) {
              console.error("Commit Error:", err);
              return res.status(500).json({ message: "Commit error", error: err });
            }
            conn.release(); // Release the connection back to the pool
            res.json({ message: "Data saved successfully!" });
          });

        } catch (error) {
          console.error("Transaction Failed:", error);
          conn.rollback(() => {
            conn.release(); // Release the connection back to the pool
            res.status(500).json({ message: "Transaction failed, rolled back", error });
          });
        }
      });
    });
  } catch (error) {
    console.error("Server Error:", error);
    res.status(500).json({ message: "Internal Server Error", error });
  }
});

///D.)
app.post("/save-crnote", async (req, res) => {
  try {
    const { CrnHdr } = req.body;

    connection.getConnection((err, conn) => {
      if (err) {
        console.error("Error getting connection:", err);
        return res.status(500).json({ message: "Error getting connection" });
      }
      conn.beginTransaction(async (err) => {
        if (err) {
          console.error("Transaction Error:", err);
          conn.release(); // Release the connection back to the pool
          return res.status(500).json({ message: "Transaction error", error: err });
        }
        /* CrNoteNo: formik.values.CrNoteNo || null,
        CrNoteDt: format(parse(formik.values.CrNoteDt, "dd/MM/yyyy", new Date()), "yyyy-MM-dd") || null,
        CustCd: formik.values.CustCd || null,

        InvNo: formik.values.InvNo || null,
        AccCd: formik.values.AccCd || null,
        Narration: formik.values.Narration || null,
        SmanCd: formik.values.SmanCd || null,
        Amount: formik.values.grossAmt || null,
        VatAmt: formik.values.vatAmount || null*/
        try {
          // ✅ Step 1: Insert/Update NGP_NET table
          console.log("CrNoteNo, DoDt==>", CrnHdr);
          const netQuery = `
            INSERT INTO crnote_hdr ( VCHR_NO,VCHR_DATE, CUST_CODE, DEBIT_AC, 
                                     NARRATION, AMOUNT, VAT_AMT) 
            VALUES (?,?,?,?, 
                    ?,?,?) 
            ON DUPLICATE KEY UPDATE 
            VCHR_NO =VALUES(VCHR_NO),
            VCHR_DATE= VALUES(VCHR_DATE),
            CUST_CODE = VALUES(CUST_CODE),
            DEBIT_AC = VALUES(DEBIT_AC),
            NARRATION = VALUES(NARRATION),
            AMOUNT = VALUES(AMOUNT),
            VAT_AMT = VALUES (VAT_AMT);
          `;

          await new Promise((resolve, reject) => {
            conn.query(
              netQuery,
              [CrnHdr.CrNoteNo, CrnHdr.CrNoteDt, CrnHdr.CustCd,
              CrnHdr.AccCd, CrnHdr.Narration, CrnHdr.Amount, CrnHdr.vatAmt],
              (err, result) => {
                if (err) {
                  return reject(err);
                }
                console.log("CRNOTE_HDR Insert/Update:", result);
                resolve(result);
              }
            );
          });



          // ✅ Commit transaction if everything is successful
          conn.commit((err) => {
            if (err) {
              console.error("Commit Error:", err);
              return res.status(500).json({ message: "Commit error", error: err });
            }
            conn.release(); // Release the connection back to the pool
            res.json({ message: "CR Note Data saved successfully!" });
          });

        } catch (error) {
          console.error("Cr Note Transaction Failed:", error);
          conn.rollback(() => {
            conn.release(); // Release the connection back to the pool
            res.status(500).json({ message: " Cr Note Transaction failed, rolled back", error });
          });
        }
      });

    })
  } catch (error) {
    console.error("Transaction Failed:", error);
    conn.rollback(() => {
      conn.release(); // Release the connection back to the pool
      res.status(500).json({ message: "Transaction failed, rolled back", error });
    })
  };

})

app.post("/save-drnote", async (req, res) => {
  try {
    const { CrnHdr } = req.body;

    connection.getConnection((err, conn) => {
      if (err) {
        console.error("Error getting connection:", err);
        return res.status(500).json({ message: "Error getting connection" });
      }
      conn.beginTransaction(async (err) => {
        if (err) {
          console.error("Transaction Error:", err);
          conn.release(); // Release the connection back to the pool
          return res.status(500).json({ message: "Transaction error", error: err });
        }
        /* CrNoteNo: formik.values.CrNoteNo || null,
        CrNoteDt: format(parse(formik.values.CrNoteDt, "dd/MM/yyyy", new Date()), "yyyy-MM-dd") || null,
        CustCd: formik.values.CustCd || null,

        InvNo: formik.values.InvNo || null,
        AccCd: formik.values.AccCd || null,
        Narration: formik.values.Narration || null,
        SmanCd: formik.values.SmanCd || null,
        Amount: formik.values.grossAmt || null,
        VatAmt: formik.values.vatAmount || null*/
        try {
          // ✅ Step 1: Insert/Update NGP_NET table
          console.log("DrNoteNo, DoDt==>", CrnHdr);
          const netQuery = `
            INSERT INTO drnote_hdr ( VCHR_NO,VCHR_DATE, CUST_CODE, CREDIT_AC, 
                                     NARRATION, AMOUNT, VAT_AMT) 
            VALUES (?,?,?,?, 
                    ?,?,?) 
            ON DUPLICATE KEY UPDATE 
            VCHR_NO =VALUES(VCHR_NO),
            VCHR_DATE= VALUES(VCHR_DATE),
            CUST_CODE = VALUES(CUST_CODE),
            CREDIT_AC = VALUES(CREDIT_AC),
            NARRATION = VALUES(NARRATION),
            AMOUNT = VALUES(AMOUNT),
            VAT_AMT = VALUES (VAT_AMT);
          `;

          await new Promise((resolve, reject) => {
            conn.query(
              netQuery,
              [CrnHdr.DrNoteNo, CrnHdr.DrNoteDt, CrnHdr.CustCd,
              CrnHdr.AccCd, CrnHdr.Narration, CrnHdr.Amount, CrnHdr.vatAmt],
              (err, result) => {
                if (err) {
                  return reject(err);
                }
                console.log("DRNOTE_HDR Insert/Update:", result);
                resolve(result);
              }
            );
          });



          // ✅ Commit transaction if everything is successful
          conn.commit((err) => {
            if (err) {
              console.error("Commit Error:", err);
              return res.status(500).json({ message: "Commit error", error: err });
            }
            conn.release(); // Release the connection back to the pool
            res.json({ message: "DR Note Data saved successfully!" });
          });

        } catch (error) {
          console.error("Dr Note Transaction Failed:", error);
          conn.rollback(() => {
            conn.release(); // Release the connection back to the pool
            res.status(500).json({ message: " Dr Note Transaction failed, rolled back", error });
          });
        }
      });

    })
  } catch (error) {
    console.error("Transaction Failed:", error);
    conn.rollback(() => {
      conn.release(); // Release the connection back to the pool
      res.status(500).json({ message: "Transaction failed, rolled back", error });
    })
  };

})

app.post("/save-do", async (req, res) => {
  console.log('save-do, start ===>')
  try {
    const { DoHdr, itemsData } = req.body; // Extract form data & grid rows from payload

    if (!DoHdr || !itemsData || !Array.isArray(itemsData) || itemsData.length === 0) {
      return res.status(400).json({ message: "Invalid data format" });
    }
    console.log("FAB DO HDR**", DoHdr);
    // Start transaction
    connection.getConnection((err, conn) => {
      if (err) {
        console.error("Error getting connection:", err);
        return res.status(500).json({ message: "Error getting connection" });
      }

      conn.beginTransaction(async (err) => {
        if (err) {
          console.error("Transaction Error:", err);
          conn.release(); // Release the connection back to the pool
          return res.status(500).json({ message: "Transaction error", error: err });
        }

        try {
          // ✅ Step 1: Insert/Update NGP_NET table
          console.log("DoNo, DoDt==>", DoHdr, DoHdr.DoNo, DoHdr.DoDt);
          const netQuery = `
            INSERT INTO fab_do_hdr ( INV_NO,INV_DATE, CUST_CODE, JOB_NO, 
                                     LPO_NO, LPO_DATE, DO_NO, CONTACT_PERSON,DO_APPROVED) 
            VALUES (?,?,?,?, 
                    ?,?,?,?,?) 
            ON DUPLICATE KEY UPDATE 
            INV_NO =VALUES(INV_NO),
            INV_DATE= VALUES(INV_DATE),
            CUST_CODE = VALUES(CUST_CODE),
            JOB_NO = VALUES(JOB_NO),
            LPO_NO = VALUES(LPO_NO),
            LPO_DATE = VALUES(LPO_DATE),
            DO_NO = VALUES (DO_NO),
            CONTACT_PERSON = VALUES(CONTACT_PERSON),
            DO_APPROVED = VALUES(DO_APPROVED);
          `;

          await new Promise((resolve, reject) => {
            conn.query(
              netQuery,
              [DoHdr.DoNo, DoHdr.DoDt, DoHdr.CustCd,
              DoHdr.JobNo, DoHdr.LpoNo, DoHdr.LpoDt, DoHdr.InvNo, DoHdr.Attn, DoHdr.DoAprv],
              (err, result) => {
                if (err) {
                  return reject(err);
                }
                console.log("DO_HDR Insert/Update:", result);
                resolve(result);
              }
            );
          });

          // ✅ Step 2: Insert/Update NGP_ITEMS table
          const itemsQuery = `
            INSERT INTO fab_do_dtl (INV_NO, SR_NO, INV_DATE, ITEM_CODE, INV_QTY, INV_UNIT)
            VALUES ?
            ON DUPLICATE KEY UPDATE 
            INV_NO = VALUES(INV_NO),
            SR_NO = VALUES(SR_NO),
            INV_DATE = VALUES(INV_DATE),
            ITEM_CODE = COALESCE(VALUES(ITEM_CODE), ITEM_CODE), 
            INV_QTY = COALESCE(VALUES(INV_QTY), INV_QTY), 
            INV_UNIT = COALESCE(VALUES(INV_UNIT), INV_UNIT);
            `;

          const values = itemsData.map(row => [
            DoHdr.DoNo, row.SR_NO, DoHdr.DoDt, row.ITEM_CODE, row.QTY, row.UNIT
          ]);

          await new Promise((resolve, reject) => {
            conn.query(itemsQuery, [values], (err, result) => {
              if (err) {
                return reject(err);
              }
              console.log("DO_ITEMS Insert/Update:", result);
              resolve(result);
            });
          });

          // ✅ Commit transaction if everything is successful
          conn.commit((err) => {
            if (err) {
              console.error("Commit Error:", err);
              return res.status(500).json({ message: "Commit error", error: err });
            }
            conn.release(); // Release the connection back to the pool
            res.json({ message: "Data saved successfully!" });
          });

        } catch (error) {
          console.error("Transaction Failed:", error);
          conn.rollback(() => {
            conn.release(); // Release the connection back to the pool
            res.status(500).json({ message: "Transaction failed, rolled back", error });
          });
        }
      });
    });
  } catch (error) {
    console.error("Server Error:", error);
    res.status(500).json({ message: "Internal Server Error", error });
  }
});
///
app.post("/save-rcp", async (req, res) => {
  console.log("SAVE RECEIPTS");
  try {
    const { vchrData, chqData, tranaccData, InvStlData } = req.body; // Extract form data & grid rows from payload
    //, StlData
    console.log("SAVE RECEIPTS 2", req.body);
    console.log("R.V vchrData=>**", vchrData);
    console.log("R.V ChqData=>**", chqData);
    console.log("R.V tranAccData=>**", tranaccData);
    console.log("R.V InvStlData=>**", InvStlData);
    //,StlData
    // Start transaction
    connection.getConnection((err, conn) => {
      if (err) {
        console.error("R.V Bank save -Error getting connection:", err);
        return res.status(500).json({ message: "R.V Bank save - Error getting connection" });
      }

      conn.beginTransaction(async (err) => {
        if (err) {
          console.error("Transaction Error:", err);
          conn.release(); // Release the connection back to the pool
          return res.status(500).json({ message: "Transaction error", error: err });
        }

        try {
          // ✅ Step 1: Insert/Update NGP_NET table
          // console.log("PjvNo, PjvDt==>", netData.PjvNo, netData.PjvDt);
          const vchrQuery = `
               INSERT INTO vouchers (TRAN_TYPE, VCHR_NO, DATTE,      CUST_CODE,    ACC_CODE,
                                     CUR_CODE ,CONV_RATE,NARRATION1, PAID_TO,    AMOUNT_FRGN,
                                      AMOUNT) 
               VALUES (?, ?, ?, ?,?,?, ?,?,?,?,?) 
               ON DUPLICATE KEY UPDATE 
               DATTE= VALUES(DATTE),
               CUST_CODE = VALUES(CUST_CODE),
               ACC_CODE= VALUES(ACC_CODE),
               CUR_CODE = VALUES(CUR_CODE),
               CONV_RATE = VALUES(CONV_RATE),
               NARRATION1 = VALUES(NARRATION1),
               PAID_TO = VALUES(PAID_TO),
               AMOUNT_FRGN = VALUES(AMOUNT_FRGN),
               AMOUNT = VALUES(AMOUNT);
              `;

          await new Promise((resolve, reject) => {
            conn.query(
              vchrQuery,
              [vchrData.TranType, vchrData.VchrNo, vchrData.VchrDate,
              vchrData.CustCd, vchrData.DrAc, vchrData.CurCd, vchrData.CovRt,
              vchrData.Particulars, vchrData.PaidTo,
              vchrData.FrgnAmt, vchrData.Amount],
              (err, result) => {
                if (err) {
                  return reject(err);
                }
                console.log("VOUCHERS Insert/Update:", result);
                resolve(result);
              }
            );
          });
          // ✅
          if (vchrData.TranType !== "05") {
            console.log('PDC_RCD insert start');

            for (const chq of chqData.filter(chq =>
              chq.ChqNo && chq.ChqNo.trim() !== "")) {
              const chqQuery = `
                  INSERT INTO pdc_rcd (
                    TRAN_TYPE, VCHR_NO, VCHR_DATE, CHQ_NO, CHQ_DATE,
                    PDC_CODE, CUST_CODE, CHQ_BANK, AMOUNT, NARRATION
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON DUPLICATE KEY UPDATE
                    VCHR_DATE = VALUES(VCHR_DATE),
                    CHQ_DATE = VALUES(CHQ_DATE),
                    PDC_CODE = VALUES(PDC_CODE),
                    CUST_CODE = VALUES(CUST_CODE),
                    CHQ_BANK = VALUES(CHQ_BANK),
                    AMOUNT = VALUES(AMOUNT),
                    NARRATION = VALUES(NARRATION);
                `;

              await new Promise((resolve, reject) => {
                conn.query(
                  chqQuery,
                  [
                    chq.TranType,
                    chq.VchrNo,
                    vchrData.VchrDate,   // still assuming it's a valid date string like '2025-05-15'
                    chq.ChqNo,
                    chq.ChqDt,
                    chq.PdcCode,
                    chq.CustCd,
                    chq.ChqBank,
                    chq.Amount,
                    chq.Narration
                  ],
                  (err, result) => {
                    if (err) {
                      console.error("Error inserting/updating chq row:", chq, err);
                      return reject(err);
                    }
                    console.log("Inserted/Updated row:", chq.VchrNo, result);
                    resolve(result);
                  }
                );
              });
            }
          }
          console.log('TRAN_ACC insert start');
          for (const trn of tranaccData) {
            const tranQuery = `
                  INSERT INTO tran_acc (
                    TRAN_TYPE, VCHR_NO, DATTE, SR_NO,ACC_CODE,
                     AMOUNT, DB_CR,NARRATION1,NARRATION2
                  ) VALUES (?, ?, ?, ?, ?,?, ?, ?,?)
                  ON DUPLICATE KEY UPDATE
                    DATTE = VALUES(DATTE),
                    ACC_CODE = VALUES(ACC_CODE),
                    AMOUNT = VALUES(AMOUNT),
                    DB_CR = VALUES(DB_CR),
                    AMOUNT = VALUES(AMOUNT),
                    NARRATION1 = VALUES(NARRATION1),
                    NARRATION2 = VALUES(NARRATION2);
                  `;

            await new Promise((resolve, reject) => {
              conn.query(
                tranQuery,
                [
                  trn.TranType,
                  trn.VchrNo,
                  vchrData.VchrDate,   // still assuming it's a valid date string like '2025-05-15'
                  trn.SrNo,
                  trn.AccCode,
                  trn.Amount,
                  trn.DbCr,
                  trn.Narration1,
                  trn.Narration2
                ],
                (err, result) => {
                  if (err) {
                    console.error("Error inserting/updating trn row:", trn, err);
                    return reject(err);
                  }
                  console.log("Inserted/Updated row:", trn.VchrNo, result);
                  resolve(result);
                }
              );
            });
          }
          console.log("InvStl INSERT START:");
          for (const trn of InvStlData) {
            const stlQuery = `
                  INSERT INTO adj_dtl (
                    SOURCE_TYPE, SOURCE_DOC, SOURCE_DATE, ACC_CODE,
                     STLD_TYPE,STLD_DOC,STLD_DATE,STLD_AMT
                  ) VALUES (?, ?, ?, ?, ?,?, ?, ?)
                  ON DUPLICATE KEY UPDATE
                   SOURCE_DATE=VALUES(SOURCE_DATE),
                   ACC_CODE=VALUES(ACC_CODE),
                   STLD_TYPE=VALUES(STLD_TYPE),
                   STLD_DOC =VALUES(STLD_DOC),
                   STLD_DATE = VALUES(STLD_DATE),
                   STLD_AMT = VALUES(STLD_AMT)
                  `;
            //PK SOURCE_TYPE,SOURCE_DOC, MAIN_SR_NO
            await new Promise((resolve, reject) => {
              conn.query(
                stlQuery,
                [
                  trn.TranType,
                  trn.SourceDoc,
                  trn.SourceDate,   // still assuming it's a valid date string like '2025-05-15'
                  trn.AccCode,
                  trn.StldType,
                  trn.StldDoc,
                  trn.StldDate,
                  trn.Amount
                ],
                (err, result) => {
                  if (err) {
                    console.error("Error inserting/updating adj_dtl row:", trn, err);
                    return reject(err);
                  }
                  console.log("Inserted/Updated adj_dtl row/END:", trn.VchrNo, result);
                  resolve(result);
                }
              );
            });
          }

          // ✅ Commit transaction if everything is successful
          conn.commit((err) => {
            if (err) {
              console.error("Commit Error:", err);
              return res.status(500).json({ message: "Commit error", error: err });
            }
            console.log('PDC_RCD insert end');
            conn.release(); // Release the connection back to the pool
            res.json({ message: "Data saved successfully!" });
          });

        } catch (error) {
          console.error("Receipt Voucher failed to save:", error);
          conn.rollback(() => {
            conn.release(); // Release the connection back to the pool
            res.status(500).json({ message: "Transaction Foreign Purchase failed, rolled back", error });
          });
        }
      });
    });
  } catch (error) {
    console.error("Server Error Foreign Purchase:", error);
    res.status(500).json({ message: "Internal Server Error :Bank Receipt Voucher ", error });
  }
})
app.post("/save-frgnpurch", async (req, res) => {
  try {
    const { netData, expData, itemsData } = req.body; // Extract form data & grid rows from payload

    if (!netData || !itemsData || !Array.isArray(itemsData) || itemsData.length === 0) {
      return res.status(400).json({ message: "Invalid data format" });
    }
    console.log("PURCHASE FOREIGN=>**", netData, expData, itemsData);
    // Start transaction
    connection.getConnection((err, conn) => {
      if (err) {
        console.error("Error getting connection:", err);
        return res.status(500).json({ message: "Error getting connection" });
      }

      conn.beginTransaction(async (err) => {
        if (err) {
          console.error("Transaction Error:", err);
          conn.release(); // Release the connection back to the pool
          return res.status(500).json({ message: "Transaction error", error: err });
        }

        try {
          // ✅ Step 1: Insert/Update NGP_NET table
          console.log("PjvNo, PjvDt==>", netData.PjvNo, netData.PjvDt);
          const netQuery = `
            INSERT INTO pur_frgn_hdr (PJV_NO, PJV_DATE,INV_NO, INV_DATE, PO_NO,SUP_CODE,
                                      ACC_CODE,NARRATION,INV_AMOUNT_FRGN,INV_AMOUNT_LOCAL,
                                      CURR_CODE, CONV_RATE,
                                      DISCOUNT,VAT_AMOUNT) 
            VALUES (?, ?, ?,?,?,?,?,?,?, ?,?,?,?,?) 
            ON DUPLICATE KEY UPDATE 
            PJV_DATE= VALUES(PJV_DATE),
            INV_NO = VALUES(INV_NO),
            INV_DATE = VALUES(INV_DATE),
            PO_NO = VALUES(PO_NO),
            SUP_CODE = VALUES(SUP_CODE),
            ACC_CODE = VALUES(ACC_CODE),
            NARRATION = VALUES(NARRATION),
            INV_AMOUNT_FRGN = VALUES(INV_AMOUNT_FRGN),
             INV_AMOUNT_LOCAL = VALUES(INV_AMOUNT_LOCAL),
            CURR_CODE = VALUES(CURR_CODE),
            CONV_RATE = VALUES(CONV_RATE),
            DISCOUNT = VALUES(DISCOUNT),
            VAT_AMOUNT = VALUES(VAT_AMOUNT);
          `;

          await new Promise((resolve, reject) => {
            conn.query(
              netQuery,
              [netData.PjvNo, netData.PjvDt, netData.InvNo, netData.InvDt, netData.FpoNo,
              netData.SupCd, netData.DrCd,
              netData.Narration, netData.InvAmtFc, netData.InvAmtLcl, netData.CrrCd, netData.ConvRt,
              netData.discAmt, netData.vatAmt],
              (err, result) => {
                if (err) {
                  return reject(err);
                }
                console.log("NGP_NET Insert/Update:", result);
                resolve(result);
              }
            );
          });
          // ✅ Step 2: Insert/Update G table
          const LcstTrnQuery = `
            INSERT INTO lcst_trn (VCHR_NO, GIT_TYPE,AMOUNT)
            VALUES ? 
            ON DUPLICATE KEY UPDATE 
            AMOUNT = COALESCE(VALUES(AMOUNT), AMOUNT);
            `;
          const expvalues = expData.map(row => [
            netData.PjvNo, row.expCode, row.amount
          ]);

          await new Promise((resolve, reject) => {
            conn.query(LcstTrnQuery, [expvalues], (err, result) => {
              if (err) {
                return reject(err);
              }
              console.log("CST_TRN Insert/Update:", result);
              resolve(result);
            });
          });

          // ✅ Step 3: Insert/Update NGP_ITEMS table
          const itemsQuery = `
            INSERT INTO pur_frgn_items (PJV_NO, SR_NO, ITEM_CODE, QTY, COST_FC,UNIT_COST)
            VALUES ? 
            ON DUPLICATE KEY UPDATE 
            ITEM_CODE = COALESCE(VALUES(ITEM_CODE), ITEM_CODE), 
            QTY = COALESCE(VALUES(QTY), QTY), 
            COST_FC = COALESCE(VALUES(COST_FC), COST_FC),
            UNIT_COST = COALESCE(VALUES(UNIT_COST), UNIT_COST);
            `;

          const values = itemsData.map(row => [
            netData.PjvNo, row.SR_NO, row.ITEM_CODE, row.QTY, row.COST_FC, row.UNIT_COST
          ]);

          await new Promise((resolve, reject) => {
            conn.query(itemsQuery, [values], (err, result) => {
              if (err) {
                return reject(err);
              }
              console.log("PUR_FRGN_ITEMS Insert/Update:", result);
              resolve(result);
            });
          });

          // ✅ Commit transaction if everything is successful
          conn.commit((err) => {
            if (err) {
              console.error("Commit Error:", err);
              return res.status(500).json({ message: "Commit error", error: err });
            }
            conn.release(); // Release the connection back to the pool
            res.json({ message: "Data saved successfully!" });
          });

        } catch (error) {
          console.error("Transaction Foreign Purchase Failed:", error);
          conn.rollback(() => {
            conn.release(); // Release the connection back to the pool
            res.status(500).json({ message: "Transaction Foreign Purchase failed, rolled back", error });
          });
        }
      });
    });
  } catch (error) {
    console.error("Server Error Foreign Purchase:", error);
    res.status(500).json({ message: "Internal Server Error :Foreign Purchase ", error });
  }
});



// Sample API: Get supplier list from MySQL database
app.get("/suplst", function (req, res) {
  console.log("Supplier List Request  (lov)");
  //const tableName= "SUP_MST";
  // Query to fetch supplier data from MySQL database
  connection.query(
    "SELECT SUP_CODE, SUP_NAME, SUP_ADR1, SUP_ADR2, SUP_ADR3, SUP_TEL1, " +
    " SUP_PERS,VAT_REG_NO,CN_CODE , DATE_FORMAT(START_DT , '%d/%m/%Y') AS START_DT " +
    " FROM sup_mst ORDER BY SUP_code",
    function (err, results, fields) {
      if (err) {
        console.error("Error executing query: ", err.message);
        return res.status(500).send("Error executing query.");
      }
      //console.log(results);
      // Return the query result as a JSON response
      res.json(results);
    }
  );
});

app.get("/cmpdetails", function (req, res) {
  // const tableName= "COMPANY";
  connection.query(
    "select NAME, PLACE, ADDRESS1 " + " FROM company",

    function (err, results, fields) {
      if (err) {
        console.error("Error executing query: ", err.message);
        return res.status(500).send("Error executing query.");
      }

      // Return the query result as a JSON response
      res.json(results);

    }
  );
});

app.get("/InvStlCust/:custcd", function (req, res) {
  console.log("InvStlCust", req.params.custcd);
  connection.query(
    "SELECT ACC_CODE CUST_CODE, VCHR_NO DOC_NO, TRAN_TYPE DOC_TYPE,DATE_FORMAT(DATTE,'%d/%m/%Y') DOC_DATE, NAR," +
    "DR_AMT, CR_AMT, BALANCE INV_AMT " +
    "FROM v_cust_outstanding_bill WHERE ACC_CODE = ?",
    [req.params.custcd],
    function (err, results) {
      if (err) {
        console.error("Error executing query:", err);  // Include the actual error
        return res.status(500).send("Error executing query.");
      }

      // Log the results (optional)
      console.log("Query results:", results);

      // Send the results as JSON
      res.json(results);
    }
  );
});

app.get("/InvStlSup/:custcd", function (req, res) {
  console.log("InvStlSup", req.params.custcd);
  connection.query(
    "SELECT ACC_CODE SUP_CODE, VCHR_NO DOC_NO, TRAN_TYPE DOC_TYPE,DATE_FORMAT(DATTE,'%d/%m/%Y') DOC_DATE, '' AS NAR," +
    "DR_AMT, CR_AMT, BALANCE INV_AMT " +
    "FROM v_sup_outstanding_bill WHERE BALANCE > 0 AND ACC_CODE = ?",
    [req.params.custcd],
    function (err, results) {
      if (err) {
        console.error("Error executing query:", err);  // Include the actual error
        return res.status(500).send("Error executing query.");
      }

      // Log the results (optional)
      console.log("Query results:", results);

      // Send the results as JSON
      res.json(results);
    }
  );
});
/*app.put("/saveInvItems", function (req, res) {
  const receivedData = req.body.data;
  // Process the received data (e.g., save to a database)
  console.log("-------------------------");
  var pool = orcl1.getPool();
  for (const row of receivedData) {
    // Process each row as needed
    console.log(
      "Row:",
      row.INV_NO,
      row.SR_NO,
      row.ITEM_CODE,
      row.ITEM_DES1,
      row.INV_QTY,
      row.INV_RATE,
      row.VAT_PERC,
      row.isNew
    );

    if (row.isNew===true) {
      console.log('Server Update invoice');
      pool.getConnection(function (err, conn) {
        conn.execute(
          "UPDATE Invoice SET  INV_RATE = :1 , INV_QTY = :2 ,VAT_PERC =:3 " +
            " WHERE INV_NO = :4 AND  SR_NO= :6",
          [
            row.INV_RATE,
            row.INV_QTY,
            row.VAT_PERC,
            row.INV_NO,
            row.ITEM_CODE,
            row.SR_NO,
          ],
          {
            outFormat: orcl1.OBJECT,
            autoCommit: true,
          },
          function (error, result) {
            if (error) {
              throw error;
           //   res.send("Sales Invoice items Not Updated !");
            } else {
              res.end(JSON.stringify(result));
              //console.log(result);
              conn.close();
             // res.send("Sales Invoice items Updated successfully");
            }
          }
        );
      });
    }
  }
  
});*/
app.put("/saveInvItems", function (req, res) {
  const receivedData = req.body.data;

  // Check if receivedData is an array
  if (!Array.isArray(receivedData)) {
    return res.status(400).send("Invalid data format");
  }

  var pool = orcl1.getPool();

  async function processRows() {
    let connection;
    let RowFlag = false;
    try {
      connection = await pool.getConnection();

      for (const row of receivedData) {
        console.log(
          "Row:",
          row.INV_NO,
          row.SR_NO,
          row.ITEM_CODE,
          row.ITEM_DES1,
          row.INV_UNIT,
          row.INV_QTY,
          row.INV_RATE,
          row.VAT_PERC,
          row.isNew
        );

        if (row.isNew === true) {
          console.log("Server Update invoice");
          RowFlag = true;
          const result = await connection.execute(
            "UPDATE Invoice SET INV_RATE = :1, INV_QTY = :2, VAT_PERC = :3 , ITEM_CODE = :4 ," +
            " ITEM_DES1 =:5, INV_UNIT =:6 WHERE INV_NO = :7 AND SR_NO = :8",
            [
              row.INV_RATE,
              row.INV_QTY,
              row.VAT_PERC,
              row.ITEM_CODE,
              row.ITEM_DES1,
              row.INV_UNIT,
              row.INV_NO,
              row.SR_NO,
            ],
            {
              outFormat: orcl1.OBJECT,
              autoCommit: true,
            }
          );

          console.log("Update result:", result);
        }
      }
      if (RowFlag) {
        res.send("Sales Invoice items Updated successfully");
      }
    } catch (error) {
      console.error("Error processing rows:", error);
      res.status(500).send("Error updating sales invoice items");
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch (closeError) {
          console.error("Error closing connection:", closeError);
        }
      }
    }
  }

  processRows();
});
////
app.post("/saveLpoItems", async function (req, res) {
  const receivedData = req.body.data;
  console.log("receivedData--", receivedData);
  // Check if receivedData is an array
  if (!Array.isArray(receivedData)) {
    return res.status(400).send("Invalid data format");
  }

  const pool = orcl1.getPool();

  async function processRows() {
    let connection;
    let rowFlag = false;
    try {
      connection = await pool.getConnection();

      for (const row of receivedData) {
        console.log("row =-----", row);
        const result = await connection.execute(
          "SELECT LPO_NO, SR_NO FROM lpo_items WHERE LPO_NO = :po AND SR_NO = :sr_no",
          [row.LPO_NO, row.SR_NO],
          {
            outFormat: orcl1.OBJECT,
          }
        );

        if (result.rows.length === 0) {
          // No matching rows found

          console.log(
            `No matching rows found for LPO_NO, So inserting rowa: ${row.LPO_NO} and SR_NO: ${result.SR_NO}`
          );
          await insertLpoItem(row, connection);
        } else {
          // Matching rows found
          console.log(`Query successful, rows found: ${result.rows.length}`);
          await updateLpoItem(row, connection);
          rowFlag = true;
        }
      }

      if (rowFlag) {
        res.send("LPO items updated successfully");
      } else {
        res.status(404).send("No matching rows found for any LPO_NO and SR_NO");
      }
    } catch (error) {
      console.error("Error processing rows:", error);

      res.status(500).send("Error updating LPO items");
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch (closeError) {
          console.error("Error closing connection:", closeError);
        }
      }
    }
  }

  async function updateLpoItem(row, connection) {
    if (row.isNew === true) {
      console.log("Server Update Lpoitems");
      const result = await connection.execute(
        "UPDATE LPO_ITEMS SET ITEM_CODE = :1, ITEM_NAME = :2, QTY = :3, RATE = :4, UNIT = :5, CAT_CODE = :6 WHERE LPO_NO = :7 AND SR_NO = :8",
        [
          row.ITEM_CODE,
          row.ITEM_NAME,
          row.QTY,
          row.RATE,
          row.UNIT,
          row.CAT_CODE,
          row.LPO_NO,
          row.SR_NO,
        ],
        {
          autoCommit: true,
        }
      );
      console.log("Update result (lpo_items):", result);
    } else if (
      row.ITEM_CODE === null &&
      row.ITEM_NAME === null &&
      row.QTY === null
    ) {
      const result = await connection.execute(
        "DELETE FROM lpo_items WHERE LPO_NO = :1 AND SR_NO = :2",
        [row.LPO_NO, row.SR_NO],
        {
          outFormat: orcl1.OBJECT,
          autoCommit: true,
        }
      );
      console.log("Delete result (lpo_items):", result);
    }
  }

  async function insertLpoItem(row, connection) {
    if (row.isNew === true) {
      console.log("Server Insert Lpoitems row--", row);
      const result = await connection.execute(
        "INSERT INTO  lpo_items ( LPO_NO, ITEM_CODE ," +
        " QTY , RATE ,  CAT_CODE , SR_NO)" +
        " VALUES (:1,:2,:3,:4,:5,:6) "[
        (row.LPO_NO,
          row.ITEM_CODE,
          row.QTY,
          row.RATE,
          row.CAT_CODE,
          row.SR_NO)
        ],
        {
          outFormat: orcl1.OBJECT,
          autoCommit: true,
        }
      );
      console.log("Insert result (lpo_items):", result);
    }
  }
  processRows();
});

///
//rest api to get all results
/* connection.query('select SUP_CODE, SUP_NAME, SUP_ADR1, SUP_ADR2, SUP_ADR3,  SUP_TEL1 ,EMAIL from SUP_MST ORDER BY SUP_NAME', function (error, results, fields) {
   if (error) throw error;
   res.end(JSON.stringify(results));
 });
});*/

//rest api to get a single employee data
app.get("/supplier/:id", function (req, res) {

  // console.log("Supplier Edit ");
  connection.query(
    "select SUP_CODE, SUP_NAME, SUP_ADR1, SUP_ADR2, SUP_ADR3,  SUP_TEL1 ," +
    "SUP_FAX1,EMAIL,SUP_PERS, CN_CODE ,LPO_LIMIT, CR_LIMIT,CR_PERIOD, VAT_REG_NO FROM sup_mst WHERE SUP_CODE=?",
    [req.params.id],

    function (err, result) {
      if (err) {
        throw error;
      }
      // console.log("Supplier  selected ", result);
      res.json(result);
    }
  );
});
app.get("/api/sup-next-code/:id", function (req, res) {

  console.log("Supplier NextCode ");
  const Name1 = req.params.id[0].trimStart();
  console.log("Supplier NextCode 1st Chr=", Name1);
  connection.query(
    "select Max(Substr(SUP_CODE,3,10))+1 As Sup_Code_Next " +
    " FROM sup_mst WHERE SUBSTR(LTRIM(SUP_NAME),1,1) =?",
    [Name1],

    function (err, result) {
      if (err) {
        throw error;
      }
      console.log("Next Sup code ", result);
      const nextCode = String(result[0]?.Sup_Code_Next || "1").padStart(4, "0");
      const newCode = "1" + Name1 + nextCode;



      console.log("New Sup code ", newCode);
      res.json(newCode);
    }
  );
});
// INSERT /UPDATE SUPPLIER 
app.post("/api/sup-save", async (req, res) => {

  const {
    SUP_CODE, SUP_NAME, SUP_ADR1, SUP_ADR2, SUP_ADR3, SUP_ADR4, SUP_ABBR, SUP_PIN,
    SUP_TEL1, SUP_FAX1, SUP_PERS, CN_CODE, SUP_TEL2, SUP_FAX2, SUP_TLX, SUP_ABR,
    OP_BAL, OP_DBCR, LOCAL_OVR, EMAIL, LPO_LIMIT, VAT_REG_NO, CR_LIMIT, CR_PERIOD
  } = req.body;
  console.log("Supplier  Save ", req.body);
  const sql = `
      INSERT INTO sup_mst 
      (SUP_CODE, SUP_NAME, SUP_ADR1, SUP_ADR2, SUP_ADR3, SUP_ADR4, SUP_ABBR, SUP_PIN, 
      SUP_TEL1, SUP_FAX1, SUP_PERS, CN_CODE, SUP_TEL2, SUP_FAX2, SUP_TLX, SUP_ABR, 
      OP_BAL, OP_DBCR, LOCAL_OVR, EMAIL, LPO_LIMIT, VAT_REG_NO, CR_LIMIT, CR_PERIOD) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) 
      ON DUPLICATE KEY UPDATE 
      SUP_NAME = VALUES(SUP_NAME), 
      SUP_ADR1 = VALUES(SUP_ADR1), 
      SUP_ADR2 = VALUES(SUP_ADR2), 
      SUP_ADR3 = VALUES(SUP_ADR3), 
      SUP_ADR4 = VALUES(SUP_ADR4), 
      SUP_ABBR = VALUES(SUP_ABBR), 
      SUP_PIN = VALUES(SUP_PIN), 
      SUP_TEL1 = VALUES(SUP_TEL1), 
      SUP_FAX1 = VALUES(SUP_FAX1), 
      SUP_PERS = VALUES(SUP_PERS), 
      CN_CODE = VALUES(CN_CODE), 
      SUP_TEL2 = VALUES(SUP_TEL2), 
      SUP_FAX2 = VALUES(SUP_FAX2), 
      SUP_TLX = VALUES(SUP_TLX), 
      SUP_ABR = VALUES(SUP_ABR), 
      OP_BAL = VALUES(OP_BAL), 
      OP_DBCR = VALUES(OP_DBCR), 
      LOCAL_OVR = VALUES(LOCAL_OVR), 
      EMAIL = VALUES(EMAIL), 
      LPO_LIMIT = VALUES(LPO_LIMIT), 
      VAT_REG_NO = VALUES(VAT_REG_NO), 
      CR_LIMIT = VALUES(CR_LIMIT), 
      CR_PERIOD = VALUES(CR_PERIOD)
  `;

  const values = [
    SUP_CODE, SUP_NAME, SUP_ADR1, SUP_ADR2, SUP_ADR3, SUP_ADR4, SUP_ABBR, SUP_PIN,
    SUP_TEL1, SUP_FAX1, SUP_PERS, CN_CODE, SUP_TEL2, SUP_FAX2, SUP_TLX, SUP_ABR,
    OP_BAL, OP_DBCR, LOCAL_OVR, EMAIL, LPO_LIMIT, VAT_REG_NO, CR_LIMIT, CR_PERIOD
  ];

  connection.query(sql, values, (err, result) => {
    if (err) {
      console.error("Error inserting/updating supplier:", err);
      return res.status(500).json({ error: "Database operation failed" });
    }
    res.status(201).json({ message: "Supplier saved successfully", affectedRows: result.affectedRows });
  });
});
//delete Sup DELETE RECORD
app.delete("/supDelete/:id", function (req, res, next) {
  var sql = "DELETE FROM sup_mst WHERE SUP_CODE = ?";
  connection.query(sql, [req.params.id], function (err, result) {
    if (err) throw err;
    console.log("Number of records deleted: " + result.affectedRows);
    conn.close();
  });
});
//rest api for CUSTOMERS
// Fetch a customer by ID
app.get("/api/customers/:id", (req, res) => {
  const { id } = req.params;
  console.log('/api/customers/' + id);
  connection.query("SELECT * FROM cus_mst WHERE CUST_CODE = ?", [id], (err, result) => {
    if (err) return res.status(500).json({ error: err });

    if (result.length > 0) {
      const { START_DT, ...filteredResult } = result[0]; // Remove START_DT from the result
      res.json(filteredResult);
    } else {
      res.status(404).json({ error: "Customer not found" });
    }
  });
});

app.post("/api/save-customer", (req, res) => {
  const data = req.body; // Receive data from frontend
  console.log("Save-Customer");
  if (!data || Object.keys(data).length === 0) {
    return res.status(400).json({ error: "No data provided" });
  }

  // Extract keys and values from the request body
  const columns = Object.keys(data).join(", ");
  const values = Object.values(data);
  const updateClause = Object.keys(data)
    .map((key) => `${key} = VALUES(${key})`)
    .join(", ");

  // MySQL Query with ON DUPLICATE KEY UPDATE
  const query = `INSERT INTO cus_mst (${columns}) VALUES (${values.map(() => "?").join(", ")}) 
                 ON DUPLICATE KEY UPDATE ${updateClause}`;

  connection.query(query, values, (err, result) => {
    if (err) {
      console.error("Error inserting/updating customer:", err);
      return res.status(500).json({ error: "Database error" });
    }
    res.json({ message: "Customer inserted/updated successfully", result });
  });
});

app.get("/cuslst", function (req, res) {
  console.log("Cuslist");
  // const tableName= "CUS_MST";
  connection.query(

    "select CUST_CODE, CUST_NAME, CUST_ADR1,CUST_ADR2, CUST_ADR3," +
    "CONTACT_PR, CN_CODE,CUS_ABBR,CUS_ABBR2, CUS_TEL1 ,CUS_TEL2," +
    "CUS_FAX1,CUS_FAX2,CR_LIMIT,PAYMENT_TERMS,SMAN_CODE,CUS_GRADE_CODE," +
    "CUS_LICENSE_FILE,CUS_LICENSE_EXPIRY,CUS_QUOTE_LIMIT,CUS_LIC_EXP_ALLOW," +
    "BLOCK_DO,CR_TERMS,VAT_REG_NO, NATION_CODE, EMAIL , START_DT " +
    " from cus_mst ",
    {},

    function (err, results, fields) {
      if (err) {
        console.error("Error executing query: ", err.message);
        return res.status(500).send("Error executing query.");
      }

      // Return the query result as a JSON response
      //  console.log(results);
      res.json(results);
    }
  );
});

app.get("/cuslovdropdown", function (req, res) {
  console.log("CusLOV Dropdown");

  connection.query(
    "select CUST_CODE, LTRIM(CUST_NAME) CUST_NAME, CUST_ADR1" +
    " from cus_mst   ORDER BY LTRIM(CUST_NAME)",

    function (error, results, fields) {
      if (error) throw error;
      res.json(results);

    }
  );
});

app.get("/cuslov/:cname", function (req, res) {
  connection.query(
    "select CUST_CODE, LTRIM(CUST_NAME) CUST_NAME, CUST_ADR1" +
    " from cus_mst  WHERE CUST_NAME LIKE :1 ORDER BY LTRIM(CUST_NAME)",
    [req.params.cname === "*" ? "%" : req.params.cname + "%"],

    function (error, results, fields) {
      if (error) console.error("Error executing query: ", err.message);
      return res.status(500).send("Error executing query.");
    },
    res.json(results)

  );
});
//col === "screwdriver" ? " selected " : "")
app.get("/customer/:id", function (req, res) {
  console.log("Customer Edit 1", req.params.id);

  const sql = `
    SELECT CUST_CODE, CUST_NAME, CUST_ADR1, CUST_ADR2
    FROM cus_mst
    WHERE CUST_CODE = ?
  `;

  connection.query(sql, [req.params.id], function (error, results) {
    if (error) {
      console.error("DB Error:", error);
      res.status(500).json({ error: "Internal Server Error" });

    } else {
      console.log(results);
      res.json(results);
    }
  });
});


//

app.get("/MaxVchrNo/:Tp", function (req, res) {
  console.log("MaxVchrNo TranType(Tp)", req.params.Tp);
  // var pool = orcl1.getPool();
  // pool.getConnection(function (err, conn) {
  //
  if (req.params.Tp == "SIV") {
    connection.execute(
      "select MAX(SIV_NO)   MXVCHR  FROM siv_hdr ",
      [],
      {
        outFormat: orcl1.OBJECT,
      },
      function (err, result) {
        if (err) {
          throw error;
        } else {
          console.log("Max SIV", result);
          res.json(result);
          //res.end(JSON.stringify(result.rows));
          //  conn.close();
        }
      }
    );
  } else if (req.params.Tp == "SRV") {
    connection.execute(
      "select MAX(SRV_NO)   MXVCHR  FROM srv_hdr ",


      function (err, result) {
        if (err) {
          throw error;
        } else {
          console.log("Max SRV", result);
          //res.end(JSON.stringify(result.rows));
          res.json(result);
          // conn.close();
        }
      }
    );
  } else if (req.params.Tp == "SADJ") {
    connection.query(
      "SELECT IFNULL(MAX(SUBSTR(VCHR_NO,4,7)), 0) AS MXVCHR FROM stk_hdr",
      [],

      function (err, result) {
        if (err) {
          throw error;
        } else {
          console.log("Max SADJ", result);
          res.json(result);
          //      conn.close();
        }
      }
    );
  } else if (req.params.Tp == "PRET") {
    connection.execute(
      "select Lpad(MAX(SUBSTR(VCHR_NO,1,6)+1) ||'RLV1',10,'0') MXVCHR  FROM pret_hdr ",
      [],

      function (err, result) {
        if (err) {
          throw error;
        } else {
          console.log("Max PRET", result);
          res.end(JSON.stringify(result.rows));
          // conn.close();
        }
      }
    );
  } else {
    connection.query(
      "select MAX(VCHR_NO)   MXVCHR  FROM tran_acc WHERE TRAN_TYPE =?",
      [req.params.Tp],

      function (err, result) {
        if (err) {
          throw error;
        } else {
          console.log("Max Vchr (tran_acc):", result);
          res.json(result);
          //  res.end(JSON.stringify(result.rows));
          //  conn.close();
        }
      }
    );
  }
});


// lpoitems
app.get("/lpoitemget", function (req, res) {
  console.log(req.params);
  connection.query(
    "select LPO_NO,SR_NO, JOB_NO, ITEM_CODE,ITEM_NAME, QTY, UNIT," +
    "RATE " +
    "FROM lpo_items ",
    [req.params.id],
    function (error, results, fields) {
      if (error) throw error;
      //console.log(results);
      res.end(JSON.stringify(results));
      conn.close();
      //FROM CUS_MST WHERE CUST_CODE=?
    }
  );
});
app.get("/invadj/:tp/:vchr", function (req, res) {
  console.log("vouchers", req.params);

  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    conn.execute(
      "select SOURCE_TYPE,SOURCE_DOC,SOURCE_DATE, ACC_CODE,STLD_DOC ,STLD_TYPE, STLD_AMT " +
      "FROM adj_dtl WHERE SOURCE_TYPE = :1 AND SOURCE_DOC =:2 ",
      [req.params.tp, req.params.vchr],
      {
        outFormat: orcl1.OBJECT,
      },
      function (err, result) {
        if (err) {
          throw error;
        } else {
          console.log("Oracle Adj Dtl", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});
app.get("/vouchers/:tp/:vchr", function (req, res) {
  console.log("vouchers", req.params);
  connection.query(  //DATE_FORMAT(a.LPO_DATE, '%d/%m/%Y') AS
    "select a.TRAN_TYPE,a.VCHR_NO,DATE_FORMAT(a.DATTE, '%d/%m/%Y') AS DATTE, a.CUST_CODE," +
    "a.PAID_TO ,a.NARRATION1,a.PAID_TO, a.ACC_CODE, b.CUST_NAME ,C.ACC_HEAD , a.AMOUNT, a.AMOUNT_FRGN" +
    " FROM vouchers a " +
    " LEFT OUTER JOIN  cus_mst b ON a.CUST_CODE = b.CUST_CODE " +
    " LEFT OUTER JOIN acc_mst c ON a.ACC_CODE = c.ACC_CODE " +
    " WHERE a.TRAN_TYPE = ? AND a.VCHR_NO =?   ",
    [req.params.tp, req.params.vchr],
    function (err, results, fields) {
      if (err) {
        console.error("Error executing query: ", err.message);
        return res.status(500).send("Error executing query.");
      }

      // Return the query result as a JSON response
      console.log(results);
      res.json(results);
    }
  );
});


app.get("/accled/:acc/:dt1/:dt2", function (req, res) {
  console.log("Accled", req.params);
  console.log("date=", req.params.dt1.substring(4, 16).trim());

  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    /*select TRAN_ACC.ROWID,ROWNUM SR_NO,TRAN_TYPE,VCHR_NO,"+
    "To_char(DATTE,'DD/MM/YYYY') DATTE, TO_CHAR(DATTE,'YY/MM/DD') DTSORT,"+
    " ACC_CODE,AMOUNT, DB_CR, NARRATION1," +
    " NARRATION2, JOB_NO,USERNAME," +
    " DECODE(DB_CR,'D', AMOUNT, 0 ) DEBIT_AMT, DECODE(DB_CR,'C', AMOUNT, 0 ) CREDIT_AMT,  " +
    " b.CHQ_NO, b.CHQ_DATE, 0 BAL FROM TRAN_ACC, V_ALL_CHEQUES b "+
    " WHERE TRAN_ACC.TRAN_TYPE=b.TRAN_TYPE(+) AND TRAN_ACC.VCHR_NO=b.VCHR_NO(+) " +
    " AND TRAN_ACC.ACC_CODE = :1 ORDER BY 6"*/
    conn.execute(
      "select a.ROWID,ROWNUM SR_NO,a.TRAN_TYPE,a.VCHR_NO," +
      "To_char(a.DATTE,'DD/MM/YYYY') DATTE, TO_CHAR(a.DATTE,'YY/MM/DD') DTSORT," +
      "a.ACC_CODE,a.AMOUNT, a.DB_CR, a.NARRATION1," +
      "NARRATION2, JOB_NO,USERNAME,   " +
      " DECODE(DB_CR,'D', a.AMOUNT, 0 ) DEBIT_AMT, DECODE(DB_CR,'C', a.AMOUNT, 0 ) CREDIT_AMT, " +
      " b.CHQ_NO, b.CHQ_DATE, 0 BAL FROM tran_acc a, V_ALL_CHEQUES b  " +
      "WHERE a.TRAN_TYPE=b.TRAN_TYPE(+) AND a.VCHR_NO=b.VCHR_NO(+) " +
      "AND a.ACC_CODE = :1 " +
      "AND a.DATTE BETWEEN TO_DATE(:2,'DD/MM/YY') AND  TO_DATE(:3,'DD/MM/YY') ORDER BY 6",
      [req.params.acc, req.params.dt1, req.params.dt2],
      {
        outFormat: orcl1.OBJECT,
      },
      function (err, result) {
        if (err) {
          throw error;
        } else {
          console.log("Oracle TranAcc Led", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});
app.get("/ledopbal/:acc/:dt1", function (req, res) {
  console.log("Accled O/p Bal", req.params);
  // console.log("date=",req.params.dt1.substring(4, 16).trim());

  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    conn.execute(
      "select SUM(DECODE(DB_CR,'D', a.AMOUNT,a.AMOUNT*(-1))) AMOUNT" +
      " FROM tran_acc a  " +
      "WHERE  a.ACC_CODE = :1 " +
      "AND a.DATTE < TO_DATE(:2,'DD/MM/YY') ",
      [req.params.acc, req.params.dt1],
      {
        outFormat: orcl1.OBJECT,
      },
      function (err, result) {
        if (err) {
          throw error;
        } else {
          console.log("Led. O/P bal ", result.rows);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});

app.get("/tranacc/:tp/:vchr", function (req, res) {
  console.log("tranacc entered :", req.params);
  connection.query(
    "  SELECT a.SR_NO, a.TRAN_TYPE,a.VCHR_NO, DATE_FORMAT(a.DATTE, '%d/%m/%Y')  DATTE," +
    "   a.ACC_CODE, a.AMOUNT,  a.DB_CR, a.NARRATION1,a.NARRATION2, a.JOB_NO, " +
    "   a.USERNAME,b.AC_HEAD AS ACC_HEAD , " +
    "   CASE WHEN a.DB_CR = 'D' THEN a.AMOUNT ELSE 0 END AS AMOUNT_DR, " +
    "  CASE WHEN a.DB_CR = 'C' THEN a.AMOUNT ELSE 0 END AS AMOUNT_CR " +
    " FROM tran_acc  a " +
    " LEFT JOIN AC_LIST b ON a.ACC_CODE = b.AC_CODE " +
    " WHERE a.TRAN_TYPE = ? AND a.VCHR_NO = ?",
    [req.params.tp, req.params.vchr],
    //LEFT JOIN = ALL ROWS OF LEFT TABLE  (TRAN_ACC Here)
    function (err, result) {
      if (err) {
        console.error("Error executing query: ", err.message);
        return res.status(500).send("Error executing query.");
      } else {
        console.log(" TranAcc :", result);
        res.json(result);
      }
    }
  );
});

app.get("/tranaccDR/:tp/:vchr", function (req, res) {
  console.log("tranacc", req.params);

  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    //
    conn.execute(
      "select TRAN_ACC.ROWID,ROWNUM SR_NO,TRAN_TYPE,VCHR_NO,DATTE, ACC_CODE,AMOUNT, DB_CR, NARRATION1," +
      "NARRATION2, JOB_NO,USERNAME," +
      "DECODE(DB_CR,'D', AMOUNT, 0 ) DEBIT_AMT, DECODE(DB_CR,'C', AMOUNT, 0 ) CREDIT_AMT,  " +
      "AC_NAME ACC_HEAD FROM tran_acc, ac_list  WHERE ACC_CODE = AC_CODE AND TRAN_TYPE = :1 AND VCHR_NO =:2  and DB_CR='D'",
      [req.params.tp, req.params.vchr],
      {
        outFormat: orcl1.OBJECT,
      },
      function (err, result) {
        if (err) {
          throw error;
        } else {
          //console.log("Oracle gLmST", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});

app.get("/pdcrcd/:tp/:vchr", function (req, res) {
  console.log("Cheque", req.params);

  connection.query(
    "select MAIN_SR_NO SR_NO ,TRAN_TYPE,VCHR_NO,DATE_FORMAT(VCHR_DATE,'%d/%m/%Y') VCHR_DATE, CHQ_NO, " +
    " DATE_FORMAT(CHQ_DATE,'%d/%m/%Y') CHQ_DATE, PDC_CODE, " +
    "CHQ_BANK, AMOUNT,  NARRATION DRAWN_BANK " +
    "FROM pdc_rcd WHERE TRAN_TYPE = ? AND VCHR_NO = ? ORDER BY CHQ_DATE",
    [req.params.tp, req.params.vchr],
    function (err, result) {
      if (err) {
        console.error("Error executing query: ", err.message);
        return res.status(500).send("Error executing query.");
        //throw error;
      } else {
        console.log("Pdcrcd", result);
        res.json(result);
        //conn.close();
      }
    }
  );
});


app.get("/pdcisu/:tp/:vchr", function (req, res) {
  console.log("Cheque", req.params);

  connection.query(
    "select MAIN_SR_NO SR_NO ,TRAN_TYPE,VCHR_NO,DATE_FORMAT(VCHR_DATE,'%d/%m/%Y') VCHR_DATE, CHQ_NO, " +
    " DATE_FORMAT(CHQ_DATE,'%d/%m/%Y') CHQ_DATE, PDC_CODE, " +
    "CHQ_BANK, AMOUNT,  NARRATION DRAWN_BANK " +
    "FROM pdc_isu WHERE TRAN_TYPE = ? AND VCHR_NO = ? ORDER BY CHQ_DATE",
    [req.params.tp, req.params.vchr],
    function (err, result) {
      if (err) {
        console.error("Error executing query: ", err.message);
        return res.status(500).send("Error executing query.");
        //throw error;
      } else {
        console.log("PdcIsu", result);
        res.json(result);
        //conn.close();
      }
    }
  );
});
app.get("/pdcrcdreg/:tp/", function (req, res) {
  console.log("tranacc", req.params);
  const { start_date, end_date } = req.query;
  connection.query(
    "select MAIN_SR_NO SR_NO ,TRAN_TYPE,VCHR_NO,DATE_FORMAT(VCHR_DATE,'%d/%m/%Y') VCHR_DATE, CHQ_NO, " +
    " DATE_FORMAT(CHQ_DATE,'%d/%m/%Y') CHQ_DATE, PDC_CODE, " +
    "CHQ_BANK, AMOUNT,  NARRATION DRAWN_BANK " +
    "FROM pdc_rcd WHERE TRAN_TYPE = ? AND VCHR_NO = ? ORDER BY CHQ_DATE",
    [req.params.tp, req.params.vchr],
    function (err, result) {
      if (err) {
        console.error("Error executing query: ", err.message);
        return res.status(500).send("Error executing query.");
        //throw error;
      } else {
        console.log("Pdcrcd", result);
        res.json(result);
        //conn.close();
      }
    }
  );
});

//
app.get("/lpoMaxNo", function (req, res) {
  console.log("lpoMaxNo");
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    //
    conn.execute(
      "select MAX(LPO_NO)   MXLPO  FROM lpo_net",
      {},
      {
        outFormat: orcl1.OBJECT,
      },
      function (err, result) {
        if (err) {
          throw error;
        } else {
          //console.log("Oracle gLmST", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});
//Customer Put - ADD
app.post("/lpoupd", function (req, res, next) {
  Pmode = "INSERT";
  let lpo = req.body;
  console.log("Entered lpoud SERVER");
  console.log("lpoupd **", req.body);
  let sql =
    "INSERT INTO lpo_items (LPO_NO,LPO_DATE,SUP_CODE,ITEM_CODE,QTY,RATE) VALUES " +
    "('" +
    lpo[0].LPO_NO +
    "','" +
    lpo[0].LPO_DATE +
    "','" +
    lpo[0].SUP_CODE +
    "','" +
    lpo[0].ITEM_CODE +
    "'," +
    lpo[0].QTY +
    "," +
    lpo[0].RATE +
    ")";
  connection.query(sql, function (error, results, fields) {
    if (error) throw error;
    res.end(JSON.stringify(results));
    conn.close();
  });
});
app.post("/lpoHdrUpd", function (req, res, next) {
  Pmode = "INSERT";
  let lpo = req.body;
  console.log("Entered lpoHdrUpd SERVER");
  console.log("lpoHdrUpd **", req.body);
  let sql =
    "INSERT INTO lpo_net (LPO_NO,LPO_DATE,SUP_CODE,AMOUNT) VALUES " +
    "('" +
    lpo.lpono +
    "','" +
    lpo.lpodate.substring(0, 10) +
    "','" +
    lpo.supcode +
    "'," +
    100 +
    ")";
  connection.query(sql, function (error, results, fields) {
    if (error) throw error;
    res.end(JSON.stringify(results));
    conn.close();
  });
});
app.get("/fpoMaxNo", function (req, res) {
  console.log("fpoMaxNo");
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    //
    conn.execute(
      "select MAX(FPO_NO)   MXLPO  FROM fpo_net",
      {},
      {
        outFormat: orcl1.OBJECT,
      },
      function (err, result) {
        if (err) {
          throw error;
        } else {
          //console.log("Oracle gLmST", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});

app.get("/Rplnlst", function (req, res) {
  console.log("Report Line List ");

  //const tableName= "RPLN_MST";
  connection.query(
    "select REPORT_LN, RP_HEAD,PRIMARY_GROUP from rpln_mst ORDER BY PRIMARY_GROUP,REPORT_LN",
    {},

    function (err, results, fields) {
      if (err) {
        console.error("Error executing query: ", err.message);
        return res.status(500).send("Error executing query.");
      }

      // Return the query result as a JSON response
      res.json(results);
    }
  );
});
app.get("/RplnMst/:id", function (req, res) {
  //const RplnData = req.body;
  console.log("Report Line Get ", req.params.id);

  //const tableName= "RPLN_MST";
  connection.query(
    "select REPORT_LN, RP_HEAD ,PRIMARY_GROUP from rpln_mst WHERE REPORT_LN = ?",
    [req.params.id],

    function (err, results) {
      if (err) {
        console.error("Error executing query: ", err.message);
        return res.status(500).send("Error executing query.");
      }

      // Return the query result as a JSON response
      console.log('RPLN_MST ', results);
      res.json(results);

    }
  );
});
app.post("/api/save-rpln", (req, res) => {
  const data = req.body; // Receive data from frontend
  console.log("Save-Report Liner");
  if (!data || Object.keys(data).length === 0) {
    return res.status(400).json({ error: "No data provided" });
  }

  // Extract keys and values from the request body
  const columns = Object.keys(data).join(", ");
  const values = Object.values(data);
  const updateClause = Object.keys(data)
    .map((key) => `${key} = VALUES(${key})`)
    .join(", ");

  // MySQL Query with ON DUPLICATE KEY UPDATE
  const query = `INSERT INTO rpln_mst (${columns}) VALUES (${values.map(() => "?").join(", ")}) 
                 ON DUPLICATE KEY UPDATE ${updateClause}`;

  connection.query(query, values, (err, result) => {
    if (err) {
      console.error("Error inserting/updating Main Group:", err);
      return res.status(500).json({ error: "Database error (RPLN_MST)" });
    }
    res.json({ message: "Main Group inserted/updated successfully", result });
  });
});
app.get("/Gllst", function (req, res) {
  console.log("Gl List ");
  // const tableName= "GL_MST";
  connection.query(
    "select REPORT_LN, GL_CODE, GL_HEAD from gl_mst ORDER BY REPORT_LN,GL_CODE",
    {},

    function (err, results, fields) {
      if (err) {
        console.error("Error executing query: ", err.message);
        return res.status(500).send("Error executing query.");
      }

      // Return the query result as a JSON response
      // res.json({tableName, data:results});
      res.json(results);
    }
  );
});

app.get("/banklst", function (req, res) {
  console.log("Bank List ");
  // const tableName= "BANK_MST";
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    conn.execute(
      "select BANK_CODE,BANK_NAME from bank_mst ORDER BY BANK_NAME",
      {},
      {
        outFormat: orcl1.OBJECT,
      },
      function (err, result) {
        if (err) {
          throw error;
        } else {
          console.log("Oracle Bank Mst", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});
app.get("/Aclist/:id", function (req, res) {
  console.log("Aclist ");
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    conn.execute(
      "select AC_CODE, AC_NAME" + " FROM ac_list WHERE AC_CODE=:1",
      [req.params.id],
      {
        outFormat: orcl1.OBJECT,
      },
      function (error, result) {
        if (error) {
          throw error;
        } else {
          console.log("Oracle  - Rcvd Code check", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});
app.get("/Aclist", function (req, res) {
  console.log("Aclist ");

  connnection.execute(
    "select AC_CODE, AC_NAME" + " FROM ac_list  ORDER BY AC_NAME",
    {},

    function (error, results, fields) {
      if (error) {
        throw error;
      }
      res.json(results);

    }
  );
});
app.get("/Accsubcatlist", function (req, res) {
  console.log("AccSubCat ");

  connection.query(
    "select REPORT_LN, GL_CODE, SUB_CAT_CODE, SUB_CAT_DESC FROM acc_sub_cat  ORDER BY 1,2,3 ",
    {},

    function (error, results) {
      if (error) {
        throw error;
      }
      res.json(results);

    }
  );
});

//update gl_mst
app.put("/glmst/:id", function (req, res, next) {
  let bank1 = req.body;

  console.log("GL Edit ");
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    conn.execute(
      "UPDATE GL_MST SET GL_HEAD=:1, GL_CODE=:2 ," +
      " REPORT_LN =:3" +
      " where REPORT_LN=:4 and GL_CODE =:5",
      [
        bank1.glhead,
        bank1.glcode,
        bank1.reportln,
        bank1.reportln,
        bank1.glcode,
      ],
      {
        outFormat: orcl1.OBJECT,
        autoCommit: true,
      },
      function (error, results) {
        if (error) throw error;
        res.end(JSON.stringify(results));
        conn.close();
      }
    );
  });
});



app.get("/Acclist", function (req, res) {
  console.log("Acc mst List ");
  //const tableName= "ACC_MST";
  connection.query(
    " SELECT A.REPORT_LN, A.GL_CODE, B.GL_HEAD, A.ACC_CODE, A.ACC_HEAD " +
    " FROM acc_mst A " +
    " LEFT OUTER JOIN GL_MST B ON A.REPORT_LN = B.REPORT_LN AND A.GL_CODE = B.GL_CODE " +
    " ORDER BY A.REPORT_LN, A.GL_CODE, A.ACC_CODE ",
    {},
    function (err, results, fields) {
      if (err) {
        throw err;
      }
      console.log(results);
      res.json(results);
      //  res.json({tableName, data:results});
    }
  )
});


app.get("/api/accmst/:id", function (req, res) {
  console.log("GL Code Edit ", req.params.id);

  connection.query(
    "select  ACC_CODE, ACC_HEAD,REPORT_LN, GL_CODE, OP_BAL, OP_DBCR" +
    " FROM acc_mst WHERE ACC_CODE=?",
    [req.params.id],

    function (error, result) {
      if (error) {
        throw error;
      } else {
        console.log(" Accmst edt", result);
        res.json(result);

      }
    }
  );
});

app.post("/api/save-accmst", (req, res) => {
  const data = req.body; // Receive data from frontend
  console.log("Save-Accmst");
  if (!data || Object.keys(data).length === 0) {
    return res.status(400).json({ error: "No data provided" });
  }

  // Extract keys and values from the request body
  const columns = Object.keys(data).join(", ");
  const values = Object.values(data);
  const updateClause = Object.keys(data)
    .map((key) => `${key} = VALUES(${key})`)
    .join(", ");

  // MySQL Query with ON DUPLICATE KEY UPDATE
  const query = `INSERT INTO acc_mst (${columns}) VALUES (${values.map(() => "?").join(", ")}) 
                   ON DUPLICATE KEY UPDATE ${updateClause}`;

  connection.query(query, values, (err, result) => {
    if (err) {
      console.error("Error inserting/updating Accounts Master:", err);
      return res.status(500).json({ error: "Database error" });
    }
    res.json({ message: "G/L A/c Code inserted/updated successfully", result });
  });
});

app.get("/banklst", function (req, res) {
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    conn.execute(
      "select BANK_CODE,BANK_NAME from bank_mst ORDER BY BANK_CODE",
      {},
      {
        outFormat: orcl1.OBJECT,
      },
      function (err, result) {
        if (err) {
          throw error;
        } else {
          //console.log("Oracle gLmST", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});
app.get("/bankmst/:id", function (req, res) {
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    conn.execute(
      "select BANK_CODE, BANK_NAME" + " FROM bank_mst WHERE BANK_CODE=:id",
      [req.params.id],
      {
        outFormat: orcl1.OBJECT,
      },
      function (error, result) {
        if (error) {
          throw error;
        } else {
          console.log("Oracle  - Bank edt", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});
app.put("/bankmst/:id", function (req, res, next) {
  let bank1 = req.body;
  console.log("bank edt", bank1);

  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    // console.log("Tran type Update on Server *1 " + req.params.id + " * 1st ");
    conn.execute(
      "UPDATE BANK_MST SET BANK_NAME=:1 " + " where BANK_CODE=:2 ",
      [bank1.bankname, bank1.bankcode],
      {
        outFormat: orcl1.OBJECT,
        autoCommit: true,
      },
      function (error, results) {
        if (error) throw error;
        res.end(JSON.stringify(results));
        conn.close();
      }
    );
  });
});

app.get("/nationmst/:id", function (req, res) {
  console.log("nation_mst Id", req.params.id);
  connection.query(
    "select NATION_CODE, NATION_NAME ,NATIONALITY, CUR_CODE, CUR_NAME,DHS_CONV_RATE" +
    " FROM nation_mst WHERE NATION_CODE= ?",
    [req.params.id],

    function (error, result) {
      if (error) {
        throw error;
      } else {
        console.log(" - Nation mst", result);
        res.json(result);

      }
    }
  );
});

app.get("/currencymst/:id", function (req, res) {
  console.log("nation_mst Id", req.params.id);
  connection.query(
    "select NATION_CODE, NATION_NAME ,NATIONALITY, CUR_CODE, CUR_NAME,DHS_CONV_RATE" +
    " FROM nation_mst WHERE CUR_CODE= ?",
    [req.params.id],

    function (error, result) {
      if (error) {
        throw error;
      } else {
        console.log(" - Nation mst", result);
        res.json(result);

      }
    }
  );
});
app.get("/currencylov", function (req, res) {
  console.log("Currency List");
  connection.query(
    "select CUR_CODE, CUR_NAME,DHS_CONV_RATE" +
    " FROM nation_mst  WHERE CUR_CODE IS NOT NULL order by CUR_CODE",
    [req.params.id],

    function (error, result) {
      if (error) {
        throw error;
      } else {
        console.log(" Currency List ", result);
        res.json(result);

      }
    }
  );
});
app.post("/api/save-nationmst", (req, res) => {
  const data = req.body; // Receive data from frontend
  console.log("Save-Nations");
  if (!data || Object.keys(data).length === 0) {
    return res.status(400).json({ error: "No data provided" });
  }

  // Extract keys and values from the request body
  const columns = Object.keys(data).join(", ");
  const values = Object.values(data);
  const updateClause = Object.keys(data)
    .map((key) => `${key} = VALUES(${key})`)
    .join(", ");

  // MySQL Query with ON DUPLICATE KEY UPDATE
  const query = `INSERT INTO nation_mst (${columns}) VALUES (${values.map(() => "?").join(", ")}) 
                   ON DUPLICATE KEY UPDATE ${updateClause}`;

  connection.query(query, values, (err, result) => {
    if (err) {
      console.error("Error inserting/updating Nation Master:", err);
      return res.status(500).json({ error: "Database error" });
    }
    res.json({ message: "Nations inserted/updated successfully", result });
  });
});


app.get("/trantypelst", function (req, res) {
  // const tableName= "tran_type";
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    conn.execute(
      "select TRAN_TYPE,TYPE_DES, TYPE_ABBR from tran_type ORDER BY TRAN_TYPE",
      {},
      {
        outFormat: orcl1.OBJECT,
      },
      function (err, result) {
        if (err) {
          throw error;
        } else {
          //console.log("Oracle gLmST", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});
app.get("/trantypent/:id", function (req, res) {
  console.log("Tran.Type Edit ");

  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    conn.execute(
      "select TRAN_TYPE, TYPE_DES, TYPE_ABBR" +
      " FROM tran_type WHERE TRAN_TYPE=:id",
      [req.params.id],
      {
        outFormat: orcl1.OBJECT,
      },
      function (error, result) {
        if (error) {
          throw error;
        } else {
          console.log("Oracle  - Trans Type edt", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});
//update gl_mst
app.put("/trantypent/:id", function (req, res, next) {
  let bank1 = req.body;

  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    conn.execute(
      "UPDATE TRAN_TYPE SET TYPE_DES=:1, TRAN_TYPE=:2 ," +
      " TYPE_ABBR =:3" +
      " where TRAN_TYPE=:4 ",
      [bank1.typedes, bank1.trantype, bank1.typeabbr, bank1.trantype],
      {
        outFormat: orcl1.OBJECT,
        autoCommit: true,
      },
      function (error, results) {
        if (error) throw error;
        res.end(JSON.stringify(results));
        conn.close();
      }
    );
  });
});

app.get("/nationlst", function (req, res) {
  console.log("Nation List ");
  // const tableName= "NATION_MST";
  connection.query(
    "select NATION_CODE,NATION_NAME, CUR_CODE," +
    " CUR_NAME, round(DHS_CONV_RATE,4) DHS_CONV_RATE from nation_mst ORDER BY NATION_CODE",
    {},

    function (err, results, fields) {
      if (err) {
        throw err;
      }
      //    console.log("Nation_mst :", results);
      res.json(results)

    }

  );
});

app.get("/loclist", function (req, res) {
  //console.log('Loc.List ');

  connection.query(
    "select LOC_CODE,LOC_NAME, LOC_NAME from loc_mst ORDER BY LOC_CODE",
    [],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //console.log("Oracle gLmST", result);
        res.json(result);

      }
    }
  );
});

app.get("/locent/:id", function (req, res) {
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    conn.execute(
      "select LOC_CODE, LOC_NAME " + " FROM loc_mst WHERE LOC_CODE=:id",
      [req.params.id],
      {
        outFormat: orcl1.OBJECT,
      },
      function (error, result) {
        if (error) {
          throw error;
        } else {
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});
app.post("/locent", function (req, res) {
  //insert
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    let sql = "INSERT INTO loc_mst (LOC_CODE, LOC_NAME) VALUES (:1,:2) ";

    //console.log(sql);
    conn.execute(
      sql,
      {
        1: req.body.loccode,
        2: req.body.locname,
      },
      {
        outFormat: orcl1.OBJECT,
        autoCommit: true,
      },
      function (error, result) {
        if (error) {
          throw error;
        } else {
          //console.log("Oracle  -Loc insert success", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});

app.put("/locent/:id", function (req, res) {
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    conn.execute(
      "UPDATE loc_mst SET LOC_NAME = :1 " + " WHERE LOC_CODE=:2",
      [req.body.locname, req.body.loccode],
      {
        outFormat: orcl1.OBJECT,
        autoCommit: true,
      },
      function (error, result) {
        if (error) {
          throw error;
        } else {
          console.log("Oracle  -Loc edit success", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});
app.delete("/locdel/:id", function (req, res) {
  // console.log("Oracle  -Loc delete entered");
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    let sql = "DELETE FROM loc_mst WHERE LOC_CODE= :1 ";

    conn.execute(
      sql,
      {
        1: req.params.id,
      },
      {
        outFormat: orcl1.OBJECT,
        autoCommit: true,
      },
      function (error, result) {
        if (error) {
          throw error;
        } else {
          // console.log("Oracle  -Loc delete success", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});
app.get("/Vatlst", function (req, res) {
  //console.log('Salesman List ');
  //const tableName = 'VAT_MST';
  connection.query(
    "select VAT_REG_NO,VAT_PERC" +
    " from vat_mst ORDER BY 1",
    {},

    function (err, results, fields) {
      if (err) {
        throw err;
      }
      //  console.log("Oracle on t", result);
      res.json(results);
      //res.json({tableName, data:results});
    }
  );
});
app.get("/vatmst/:id", function (req, res) {

  connection.query(
    "select * FROM vat_mst WHERE VAT_REG_NO=? ",
    [req.params.id],

    function (error, results) {
      if (error) throw error;
      res.json(results);


    }
  );
});

app.post("/api/save-mst", (req, res) => {
  // console.log("Full Request Body:", req.body); // Debugging

  const { TABLE_NAME, ...data } = req.body;  // Extract TABLE_NAME separately

  if (!TABLE_NAME) {
    return res.status(400).json({ error: "TABLE_NAME is required" });
  }

  if (!data || Object.keys(data).length === 0) {
    return res.status(400).json({ error: "No data provided" });
  }

  const columns = Object.keys(data).join(", ");
  const values = Object.values(data);
  const updateClause = Object.keys(data)
    .map((key) => `${key} = VALUES(${key})`)
    .join(", ");

  const query = `INSERT INTO ${TABLE_NAME} (${columns}) VALUES (${values.map(() => "?").join(", ")}) 
                 ON DUPLICATE KEY UPDATE ${updateClause}`;

  connection.query(query, values, (err, result) => {
    if (err) {
      console.error("Error inserting/updating record:", err);
      return res.status(500).json({ error: "Database error" });
    }
    res.json({ message: "Record inserted/updated successfully", result });
  });
});

app.get("/Smanlst", function (req, res) {
  //console.log('Salesman List ');
  // const tableName = 'SMAN_MST';
  connection.query(
    "select * from sman_mst ORDER BY SMAN_CODE",

    function (err, results, fields) {
      if (err) {
        throw err;
      }
      console.log("SmanMst", results);
      res.json(results);
      //res.json({tableName, data:results});
    }
  );
});

app.get("/smanmst/:id", function (req, res) {

  connection.query(
    "select SMAN_CODE, SMAN_NAME ,SMAN_MOBILE,SMAN_DESIGNATION,SMAN_EMAIL, USER_NAME, LOGIN_USER," +
    "SMAN_ACTIVE FROM sman_mst WHERE SMAN_CODE=? ",
    [req.params.id],

    function (error, results) {
      if (error) throw error;
      res.json(results);

      console.log(results);
    }
  );
});
app.post("/api/save-smanmst", (req, res) => {
  const data = req.body; // Receive data from frontend
  console.log("Save-Sman_mst");
  if (!data || Object.keys(data).length === 0) {
    return res.status(400).json({ error: "No data provided" });
  }

  // Extract keys and values from the request body
  const columns = Object.keys(data).join(", ");
  const values = Object.values(data);
  const updateClause = Object.keys(data)
    .map((key) => `${key} = VALUES(${key})`)
    .join(", ");

  // MySQL Query with ON DUPLICATE KEY UPDATE
  const query = `INSERT INTO sman_mst (${columns}) VALUES (${values.map(() => "?").join(", ")}) 
                   ON DUPLICATE KEY UPDATE ${updateClause}`;

  connection.query(query, values, (err, result) => {
    if (err) {
      console.error("Error inserting/updating Sman Master:", err);
      return res.status(500).json({ error: "Database error" });
    }
    res.json({ message: "Sales-Man inserted/updated successfully", result });
  });
})
app.get("/qttrmlst", function (req, res) {

  connection.query(
    "select SR_NO, TERMS_HDR, TERMS_DETAILS" +
    "  from quot_terms_cond_mst ORDER BY SR_NO",

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //console.log("Oracle vatMst", result);
        res.json(result);

      }
    }
  );
});
app.get("/qtTermEntQt/:id", function (req, res) {

  connection.query(
    "select Distinct SR_NO, TERMS_HDR, TERMS_DETAILS" +
    "  from quot_terms_cond WHERE QUOT_NO = ? ORDER BY  SR_NO",
    [req.params.id],
    function (err, result) {
      if (err) {
        throw err;
      } else {
        //   console.log("QtTermEntQt", result);
        res.json(result);

      }
    }
  );
});
app.get("/quotnotes/:id", function (req, res) {

  connection.query(
    "select Distinct SR_NO, NOT_ES" +
    "  from quot_notes WHERE QUOT_NO = ? ORDER BY  SR_NO",
    [req.params.id],
    function (err, result) {
      if (err) {
        throw err;
      } else {
        console.log("QuotNotes", result);
        res.json(result);

      }
    }
  );
});
app.get("/qtDocUpload/:id", function (req, res) {

  connection.query(
    "select Distinct QUOT_NO,SR_NO, INQ_DOC" +
    "  from quot_inq_docs WHERE QUOT_NO = ? ORDER BY  SR_NO",
    [req.params.id],
    function (err, result) {
      if (err) {
        throw err;
      } else {
        //   console.log("QtTermEntQt", result);
        res.json(result);

      }
    }
  );
});
//"LPO_NO", "LPO_DATE", "SUP_CODE", "CANCELLED", "REQ_NO","APPROVED_BY"
app.get("/quotetrment/:id", function (req, res) {
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    conn.execute(
      "select SR_NO,  TERMS_HDR, TERMS_DETAILS" +
      "  from quot_terms_cond_mst " +
      " WHERE sr_no=:id",
      [req.params.id],
      {
        outFormat: orcl1.OBJECT,
      },
      function (error, result) {
        if (error) {
          throw error;
        } else {
          //   console.log("Oracle-Sinq Loc", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});
//
app.get("/lpolst/:dys", function (req, res) {
  console.log("LpoList");

  connection.query(
    "SELECT a.LPO_NO, DATE_FORMAT(a.LPO_DATE, '%d/%m/%Y') AS LPO_DATE, a.JOB_NO,a.SUP_CODE, " +
    "b.SUP_NAME, a.AMOUNT, a.ATTN, a.CANCELLED, a.REQ_NO, a.SMAN_CODE, a.NARRATION " +
    "FROM lpo_net a " +
    "JOIN sup_mst b ON a.SUP_CODE = b.SUP_CODE " +
    "WHERE a.LPO_DATE >= CURDATE() - INTERVAL ? DAY " +
    "ORDER BY a.LPO_NO DESC",
    [req.params.dys], // Passing the :dys parameter as a placeholder
    function (err, results, fields) {
      if (err) {
        throw err;
      }
      res.json(results);

    }
  );
});
app.get("/lporeg", function (req, res) {

  const { start_date, end_date } = req.query; // Retrieve query parameters

  if (!start_date || !end_date) {
    return res.status(400).json({ error: "Missing start_date or end_date" });
  }

  console.log(" lporeg: Received start_date:", start_date);
  console.log(" lporeg: Received end_date:", end_date);


  connection.query(
    "SELECT a.LPO_NO, DATE_FORMAT(a.LPO_DATE, '%d/%m/%Y') AS LPO_DATE, a.JOB_NO,a.SUP_CODE, " +
    "b.SUP_NAME, a.AMOUNT, a.ATTN, a.PAY_TERMS, a.PLACE_DLV,a.DELIVERY_REQ,a.CANCELLED, a.REQ_NO, a.SMAN_CODE, a.NARRATION " +
    "FROM lpo_net a " +
    "JOIN sup_mst b ON a.SUP_CODE = b.SUP_CODE " +
    "WHERE a.LPO_DATE >= ? AND a.LPO_DATE <= ?" +
    "ORDER BY a.LPO_NO ASC",
    [start_date, end_date], // Passing the :dys parameter as a placeholder
    function (err, results, fields) {
      if (err) {
        throw err;
      }
      res.json(results);
    }
  );
});

app.get("/joblist", function (req, res) {


  //[req.params.dys],
  connection.query(
    "select a.JOB_NO,DATE_FORMAT(a.START_DATE,'%d/%m/%Y') START_DATE, a.CUST_CODE," +
    " b.CUST_NAME, a.CONTRACT_AMT, a.CONSULTANT, a.CANCEL_IND, a.PROJ_NAME, a.APPROVED_BY ,a.LPO_NO ," +
    " date_format(a.LPO_DATE,'%d/%m/%Y') LPO_DATE from job_card a, cus_mst b where  " +
    " a.CUST_CODE = b.CUST_CODE ORDER BY a.JOB_NO DESC",

    // a.START_DATE >= SYSDATE - 1800 and
    function (err, result) {
      if (err) {
        throw err;
      } else {
        console.log(" JOBLST", result);
        //  res.end(JSON.stringify(result.rows));
        res.json(result);
      }
    }
  );
});

//
app.get("/fpolst/:dys", function (req, res) {
  connection.query(
    "select DISTINCT a.FPO_NO,DATE_FORMAT(a.FPO_DATE,'%d/%m/%Y') FPO_DATE, a.SUP_CODE," +
    " b.SUP_NAME, a.AMOUNT, a.YR_REF_NO, a.PAY_TERMS,a.CANCELLED, a.REQ_NO, a.PREPARED_BY,a.FPO_NOTES" +
    " from fpo_net a left outer join  sup_mst b ON b.SUP_CODE = a.SUP_CODE  " +
    "  WHERE  a.FPO_DATE >= CURDATE() - INTERVAL ? DAY ORDER BY a.FPO_NO DESC",

    [req.params.dys],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //console.log("Oracle FPOLST", result);
        res.json(result);

      }
    }
  );
});
app.get("/fporeg", function (req, res) {
  const { start_date, end_date } = req.query;
  connection.query(
    "select a.FPO_NO,DATE_FORMAT(a.FPO_DATE,'%d/%m/%Y') FPO_DATE, a.SUP_CODE," +
    " b.SUP_NAME, a.AMOUNT, a.YR_REF_NO,a.PAY_TERMS,c.CUR_NAME, a.CANCELLED, a.REQ_NO, a.PREPARED_BY" +
    " from fpo_net a left outer join  sup_mst b ON b.SUP_CODE = a.SUP_CODE  " +
    "LEFT OUTER JOIN nation_mst c on c.CUR_CODE = a.CURR_ENCY " +
    "  WHERE  a.FPO_DATE >= ? AND a.FPO_DATE <= ?  ORDER BY a.FPO_NO ASC",

    [start_date, end_date],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //console.log("Oracle FPOLST", result);
        res.json(result);

      }
    }
  );
});
app.get("/fponet/:fpoNo", function (req, res) {
  //const { fpoNo } = req.query;
  console.log('Fpo No:', req.params.fpoNo);
  connection.query(
    "select a.FPO_NO,DATE_FORMAT(a.FPO_DATE,'%d/%m/%Y') FPO_DATE, a.SUP_CODE," +
    " b.SUP_NAME, a.AMOUNT, a.CURR_ENCY, a.PAY_TERMS ,a.FPO_NOTES " +
    " from fpo_net a LEFT OUTER JOIN  sup_mst b ON b.SUP_CODE = a.SUP_CODE  " +
    "  WHERE  a.FPO_NO = ?  ",
    [req.params.fpoNo],
    function (err, result) {
      if (err) {
        throw err;
      } else {
        console.log("Fpo_Net", result);
        res.json(result);
      }
    }
  );
});
app.get("/fpoitems/:fpoNo", function (req, res) {
  //const { fpoNo } = req.query;
  connection.query(
    "select a.FPO_NO,DATE_FORMAT(a.FPO_DATE,'%d/%m/%Y') FPO_DATE, a.SUP_CODE," +
    " b.SUP_NAME, a.SR_NO,a.QTY, a.UNIT,a.RATE,a.LOC_CODE,a.ITEM_CODE, a.ITEM_NAME " +
    " from fpo_items a left outer join  sup_mst b ON b.SUP_CODE = a.SUP_CODE  " +
    "  WHERE  a.FPO_NO = ?   ORDER BY a.SR_NO ASC",
    [req.params.fpoNo],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        console.log("Fpo_items ==>>>", result);
        res.json(result);

      }
    }
  );
});
app.get("/pinvfrgnlst/:dys", function (req, res) {
  connection.query(
    "SELECT a.PJV_NO, DATE_FORMAT(a.PJV_DATE,'%d/%m%Y') PJV_DATE, " +
    "a.PO_NO, a.INV_NO, DATE_FORMAT(a.INV_DATE,'%d/%m%Y') INV_DATE, a.SUP_CODE,b.SUP_NAME,  " +
    "a.DISCOUNT, a.RND_OFF, a.VAT_AMOUNT, a.INV_AMOUNT_FRGN , a.CURR_CODE, a.CONV_RATE " +
    " FROM pur_frgn_hdr a left outer join sup_mst b ON a.SUP_CODE = b.SUP_CODE " +
    "WHERE a.PJV_DATE >= CURDATE() - INTERVAL ? DAY ORDER BY a.PJV_NO DESC",
    [req.params.dys],  // Ensure the parameter is correctly passed as an array

    function (err, result) {
      if (err) {
        console.error("Database Query Error:", err);
        res.status(500).json({ error: "Database query failed" });
      } else {
        res.json(result);
      }
    }
  );
});


app.get("/srvlst/:dys", function (req, res) {
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    // console.log('SRV List. ');

    conn.execute(
      "select a.SRV_NO,To_char(a.SRV_DATE,'DD/MM/RRRR') SRV_DATE, a.SUP_CODE," +
      " b.SUP_NAME, a.NARRATION, a.LPO_NO, a.INV_NO, a.INV_DATE" +
      " from srv_hdr a, sup_mst b where  a.SRV_DATE >= SYSDATE - :dys and " +
      " a.SUP_CODE = b.SUP_CODE ORDER BY a.SRV_NO DESC",
      [req.params.dys],
      {
        outFormat: orcl1.OBJECT,
      },
      function (err, result) {
        if (err) {
          throw err;
        } else {
          //console.log("Oracle LPOLST", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});
app.get("/srvhdr/:srv", function (req, res) {
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    //console.log('SRV Hdr. no'||srv);

    conn.execute(
      "select a.SRV_NO,To_char(a.SRV_DATE,'YYYY-MM-DD') SRV_DATE, a.SUP_CODE," +
      " b.SUP_NAME, a.NARRATION, a.LPO_NO, a.INV_NO, a.INV_DATE ,a.ROWID" +
      " from srv_hdr a, sup_mst b where a.SUP_CODE =b.SUP_CODE and  a.SRV_NO= :srv ",
      [req.params.srv],
      {
        outFormat: orcl1.OBJECT,
      },
      function (err, result) {
        if (err) {
          throw err;
        } else {
          //    console.log("Oracle SRVHDR Read Data", result.rows);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});
app.get("/srvitems/:srv", function (req, res) {
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    //console.log('SRV Items. ');

    conn.execute(
      "select a.SRV_NO,To_char(a.SRV_DATE,'DD/MM/RRRR') SRV_DATE, a.LOC_CODE," +
      "a.ITEM_CODE, b.ITEM_NAME1, a.QTY, a.SR_NO, a.STD_COST" +
      " from srv_items a, item_mst b where a.ITEM_CODE =b.ITEM_CODE and  a.SRV_NO= :srv ORDER by a.Sr_no ",
      [req.params.srv],
      {
        outFormat: orcl1.OBJECT,
      },
      function (err, result) {
        if (err) {
          throw err;
        } else {
          //   console.log("Oracle SRVItems", result.rows);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});

app.get("/sivlst/:dys", function (req, res) {
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    // console.log('SIV List. ');

    conn.execute(
      "select a.SIV_NO,To_char(a.SIV_DATE,'DD/MM/RRRR') SIV_DATE, a.COST_CODE," +
      " b.CUST_NAME, a.NARRATION, a.JOB_NO, a.PANEL_NO " +
      " from siv_hdr a, cus_mst b where  a.SIV_DATE >= SYSDATE - :dys and " +
      " a.CUST_CODE = b.CUST_CODE(+) ORDER BY a.SIV_NO DESC",
      [req.params.dys],
      {
        outFormat: orcl1.OBJECT,
      },
      function (err, result) {
        if (err) {
          throw err;
        } else {
          //console.log("Oracle LPOLST", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});
app.get("/sivhdr/:siv", function (req, res) {
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    // console.log('SIV Hdr. no' || siv);

    conn.execute(
      "select a.ROWID,a.SIV_NO,To_char(a.SIV_DATE,'DD/MM/RRRR') SIV_DATE, a.CUST_CODE," +
      " b.CUST_NAME, a.NARRATION, a.JOB_NO, a.PANEL_NO" +
      " from siv_hdr a, cus_mst b where a.CUST_CODE =b.CUST_CODE(+) and  a.SIV_NO= :siv ",
      [req.params.siv],
      {
        outFormat: orcl1.OBJECT,
      },
      function (err, result) {
        if (err) {
          throw err;
        } else {
          // console.log("Oracle SIVHDR Read", result.rows);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});
app.get("/sivitems/:srv", function (req, res) {
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    //console.log('SIV Items. ');

    conn.execute(
      "select a.ROWID,a.SIV_NO,To_char(a.SIV_DATE,'DD/MM/RRRR') SIV_DATE, a.LOC_CODE," +
      "a.ITEM_CODE, b.ITEM_NAME1, a.QTY, a.SR_NO, a.STD_COST,a.ROWID" +
      " from siv_items a, item_mst b where a.ITEM_CODE =b.ITEM_CODE and  a.SIV_NO= :srv ORDER by lpad(a.Sr_no ,3,'0')",
      [req.params.srv],
      {
        outFormat: orcl1.OBJECT,
      },
      function (err, result) {
        if (err) {
          throw err;
        } else {
          // console.log("Oracle SRVItems", result.rows);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});
app.get("/sadjlst", function (req, res) {
  connection.query(
    "select a.VCHR_NO,DATE_FORMAT(a.VCHR_DATE,'%d/%m/%y') AS VCHR_DATE," +
    "  a.NARRATION" +
    " from stk_hdr a ORDER BY a.VCHR_NO ",
    [],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        // console.log("Oracle SIVHDR Read", result.rows);
        res.json(result);

      }
    }
  );
});

app.get("/sadjhdr/:siv", function (req, res) {
  console.log('sadjhdr', req.params.siv);

  connection.query(
    "select a.VCHR_NO,DATE_FORMAT(a.VCHR_DATE,'%d/%m/%Y') VCHR_DATE," +
    "  a.NARRATION" +
    " from stk_hdr a WHERE a.VCHR_NO=  ? ",
    [req.params.siv],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        console.log("STK_HDR Read", result);
        res.json(result);
      }
    }
  );
});

app.get("/sadjitems/:srv", function (req, res) {

  //console.log('SADJ Items. ');

  connection.query(
    "select a.VCHR_NO,DATE_FORMAT(a.VCHR_DATE,'%d/%m/%Y') VCHR_DATE, a.LOC_CODE," +
    "a.ITEM_CODE, b.ITEM_NAME1, a.QTY, a.SR_NO, a.STD_COST,a.NARRATION " +
    " from stk_adj a left outer join item_mst b ON a.ITEM_CODE =b.ITEM_CODE WHERE  a.VCHR_NO= ? ORDER by a.SR_NO",
    [req.params.srv],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        // console.log("Oracle SRVItems", result.rows);
        res.json(result);

      }
    }
  );
});

app.get("/invlst/:dys", function (req, res) {

  connection.query(
    "select a.INV_NO,DATE_FORMAT(a.INV_DATE,'%d/%m/%Y') INV_DATE, a.CUST_CODE," +
    " b.CUST_NAME, a.ADDL_CUST_NAME, c.SMAN_NAME  SMAN_CODE, a.CAN_CEL,a.DISCOUNT,a.AMOUNT" +
    " from net_sales a  " +
    " Left join sman_mst c ON a.SMAN_CODE = c.SMAN_CODE " +
    " left outer join cus_mst b  ON a.CUST_CODE = b.CUST_CODE where  a.INV_DATE >= CURDATE() -INTERVAL ? DAY  " +
    "   ORDER BY a.INV_NO DESC",
    [req.params.dys],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //console.log("Oracle LPOLST", result);
        res.json(result);

      }
    }
  );
});

app.get("/jobsalreg", function (req, res) {


  const { start_date, end_date } = req.query;
  console.log('JOBSALREG == param ', start_date, end_date);
  connection.query(
    "select a.INV_NO,DATE_FORMAT(a.INV_DATE, '%d/%m/%Y') INV_DATE, a.CUST_CODE," +
    " b.CUST_NAME, a.CASH_CUST_NAME,a.JOB_NO, a.DO_NO,  INV_CANCELLED ," +
    "a.LPO_NO,DATE_FORMAT(a.LPO_DATE, '%d/%m/%Y') LPO_DATE,a.NET_AMT AMOUNT, a.INV_UPLOAD_FILE," +
    " a.CONTRACT_AMT_PERCENT,a.INV_ACK,a.QUOT_NO ,a.CURR_CODE, a.CONVERT_RATE " +
    " from fab_inv_hdr a left outer join cus_mst b ON  a.CUST_CODE = b.CUST_CODE where  a.INV_DATE BETWEEN ? AND ? ",
    [start_date, end_date],

    function (err, result) {
      if (err) {
        console.error("Error executing query:", err);
        res.status(500).json({ error: "Query execution error" });
      } else {
        console.log("FABINVHDR =", result)
        res.json(result);
      }

    });
}
);

app.get("/invhdr/:id", function (req, res) {
  // console.log ('Quotent Params');
  // console.log(req.params.id);
  //const id1 = req.params.id;
  //console.log(id1);
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    //WHERE QUOT_NO =:po order by sr_no'
    //[req.params.po]
    //
    conn.execute(
      "select a.INV_NO,a.INV_DATE, a.CUST_CODE,c.CUST_NAME," +
      " a.SMAN_CODE,a.ADDL_CUST_NAME, b.SMAN_NAME, a.REMARKS1" +
      " FROM net_sales a, sman_mst b , cus_mst c " +
      " WHERE INV_NO =:id and a.SMAN_CODE =b.SMAN_CODE(+) and a.CUST_CODE = c.CUST_CODE(+)",
      [req.params.id],
      {
        outFormat: orcl1.OBJECT,
      },
      function (error, results, fields) {
        if (error) throw error;
        res.end(JSON.stringify(results.rows));
        conn.close();
        console.log("INV_HDR");
        // console.log(results);
      }
    );
  });
});

app.get("/invitem/:id", function (req, res) {

  //[req.params.po]
  //
  connection.query(
    "select INV_NO,SR_NO ,'' AS ITEM_CODE, INV_ITEM_DESC ITEM_DES1 , INV_QTY, INV_UNIT ,INV_RATE , VAT_PERC ," +
    " round(Inv_qty*Inv_rate,2) AMOUNT" +
    " FROM fab_inv_dtl  WHERE INV_NO = ? " +
    " and  INV_QTY||INV_RATE IS NOT NULL order by sr_no",
    [req.params.id],

    function (error, results) {
      if (error) throw error;
      res.json(results)
      // conn.close();
      //  console.log(results);
    }
  );
});


app.get("/quotlst/:dys", function (req, res) {


  connection.query(
    "select a.QUOT_NO,DATE_FORMAT(a.QUOT_DATE, '%d/%m/%Y') AS QUOT_DATE, a.CUST_CODE," +
    " a.PROJECT_NAME,a.SUBJECT, a.YOUR_REF,a.INQ_NO," +
    " a.ATTN,b.CUST_NAME, a.DETAILS, a.NARRATION, a.ENGG_CODE SMAN_CODE,c.ENG_NAME, " +
    "a.CANCELLED ,a.PAYMENT_TERMS,a.AMOUNT" +
    " from quot_hdr a  " +
    " left outer join cus_mst b on a.cust_code = b.cust_code " +
    " left outer join eng_mst c on  a.engg_code = c.eng_code  " +
    " where  a.QUOT_DATE >= CURDATE() - INTERVAL ? DAY ORDER BY DATE_FORMAT(a.QUOT_DATE, '%Y/%m/%d') DESC",
    [req.params.dys],

    function (err, results, fields) {
      if (err) {
        throw err;
      } else {
        // console.log("Oracle QUOTLST", results);
        res.json(results);

      }
    }
  );
});

app.get("/quothdr/:id", function (req, res) {

  const sql = `
    SELECT 
      a.QUOT_NO,
      a.CUST_CODE,
      a.ATTN,
      a.NARRATION,
      c.CUST_NAME,
      a.PROJECT_NAME,
      a.SUBJECT,
      a.YOUR_REF,
      a.PAYMENT_TERMS ,
      a.ENGG_CODE AS SMAN_CODE,
      a.DETAILS,
      b.SMAN_NAME,c.CUS_QUOTE_LIMIT,
      a.TEL_NO,
      a.FAX_NO,a.CURR_CODE,
      a.INQ_NO,a.REV_NO,a.QUOT_APPROVED,a.QUOT_APPROVED_BY

    from quot_hdr a
    left join sman_mst b on a.engg_code = b.sman_code
    left join cus_mst c on a.cust_code = c.cust_code
    WHERE a.QUOT_NO = ?
  `;

  connection.execute(sql, [req.params.id], (error, results) => {
    if (error) {
      console.error('Error executing query:', error);
      return res.status(500).json({ error: 'Database error' });
    }

    res.json(results);
  });
});



app.get("/quotitem/:id", function (req, res) {

  connection.query(
    "select QUOT_NO,SR_NO , ITEM_CODE, ITEM_NAME , QTY, UNIT ,RATE ," +
    " round(qty*rate,2) AMOUNT" +
    " FROM quot_item  WHERE QUOT_NO = ? " +
    "  order by sr_no",
    [req.params.id],

    function (error, results) {
      if (error) throw error;
      console.log('quotitem', results);
      res.json(results);

    }
  );
});

app.get("/quotent1/:id", function (req, res) {
  var pool = orcl1.getPool();
  // console.log('QUOTE Entry.'+`${:id}`);
  pool.getConnection(function (err, conn) {
    conn.execute(
      "select a.* " + " from quot_item a   " + " ORDER BY a.SR_NO ",
      [req.params.id],
      {
        outFormat: orcl1.OBJECT,
      },
      function (err, result) {
        if (err) {
          throw err;
        } else {
          console.log("Oracle QuotEntry", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});

app.get("/sinqlst/:dys", function (req, res) {
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    // console.log('sinq List. ');

    conn.execute(
      "select a.INQ_NO, To_char(a.INQ_DATE,'DD/MM/RRRR') INQ_DATE," +
      "a.QUOTE_NO,To_char(a.QUOTE_DATE,'DD/MM/RRRR') QUOT_DATE, a.CUST_CODE," +
      " b.CUST_NAME, a.SUBJECT, a.INQ_NO, a.ENGG_CODE, a.INQ_TYPE " +
      " from sales_inquiry a, cus_mst b where  a.INQ_DATE >= SYSDATE - :dys and " +
      " a.CUST_CODE = b.CUST_CODE(+) ORDER BY a.INQ_NO DESC",
      [req.params.dys],
      {
        outFormat: orcl1.OBJECT,
      },
      function (err, result) {
        if (err) {
          throw err;
        } else {
          //console.log("Oracle LPOLST", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});

app.get("/invlist/:dys", function (req, res) {
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    // console.log('INV.List. ');

    conn.execute(
      "select a.INV_NO,To_char(a.INV_DATE,'DD/MM/RRRR') INV_DATE, a.CUST_CODE," +
      " b.CUST_NAME, a.ADDL_CUST_NAME, a.DO_NO, a.SMAN_CODE, a.CAN_CEL ,a.LPO_NO,a.AMOUNT" +
      " from net_sales a, cus_mst b where  a.INV_DATE >= SYSDATE - :dys and " +
      " a.CUST_CODE = b.CUST_CODE(+) ORDER BY a.INV_NO DESC",
      [req.params.dys],
      {
        outFormat: orcl1.OBJECT,
      },
      function (err, result) {
        if (err) {
          throw err;
        } else {
          console.log("Oracle INVLST", result.rows);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});
app.get("/fabinvlist/:dys", function (req, res) {


  connection.query(
    "select a.INV_NO,DATE_FORMAT(a.INV_DATE, '%d/%m/%Y') INV_DATE, a.CUST_CODE," +
    " b.CUST_NAME, a.CASH_CUST_NAME,a.JOB_NO, a.DO_NO,  INV_CANCELLED ," +
    "a.LPO_NO,a.NET_AMT AMOUNT, a.INV_UPLOAD_FILE," +
    " a.CONTRACT_AMT_PERCENT,a.INV_ACK,a.QUOT_NO " +
    " from fab_inv_hdr a    " +
    " left outer join cus_mst b on b.cust_code = a.cust_code " +
    " where  a.INV_DATE >= CURDATE() - INTERVAL ? DAY  ORDER BY a.INV_NO DESC",
    [req.params.dys],

    function (err, results, fields) {
      if (err) {
        console.error("Error executing query:", err);
        res.status(500).json({ error: "Query execution error" });
      } else {
        res.json(results);
      }

    }
  );
});

app.get("/fabinvhdr/:inv", function (req, res) {
  console.log('FAB INV HDR== param ', req.params.inv);
  connection.query(
    "select a.INV_NO,DATE_FORMAT(a.INV_DATE, '%d/%m/%Y') INV_DATE, a.CUST_CODE," +
    " b.CUST_NAME, a.CASH_CUST_NAME,a.JOB_NO, a.DO_NO,  INV_CANCELLED ," +
    "a.LPO_NO,DATE_FORMAT(a.LPO_DATE, '%d/%m/%Y') LPO_DATE,a.NET_AMT AMOUNT, a.INV_UPLOAD_FILE," +
    " a.CONTRACT_AMT_PERCENT,a.INV_ACK,a.QUOT_NO ,a.CURR_CODE, a.CONVERT_RATE " +
    " from fab_inv_hdr a left outer join cus_mst b ON  a.CUST_CODE = b.CUST_CODE where  a.INV_NO =?  ",
    [req.params.inv],

    function (err, result) {
      if (err) {
        console.error("Error executing query:", err);
        res.status(500).json({ error: "Query execution error" });
      } else {
        console.log("FABINVHDR =", result)
        res.json(result);
      }

    });
}
);

app.get("/fabinvitems/:vchr", function (req, res) {
  console.log('Fab_INv_dtl.', req.params.vchr);
  connection.query(
    "select a.INV_NO,DATE_FORMAT(a.INV_DATE, '%d/%m/%Y') INV_DATE," +
    " a.PANEL_NO,a.INV_ITEM_DESC , a.VAT_PERC, " +
    "a.INV_QTY, a.INV_RATE ,a.SR_NO, (a.INV_QTY *a.INV_RATE) AMOUNT" +
    " from fab_inv_dtl a where a.Inv_no = ?" +
    "  ORDER BY a.SR_NO",
    [req.params.vchr],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //     console.log("FAB_INV_ITEMS", result);
        res.json(result);

      }
    }
  );
});

app.get("/sretlst/:dys", function (req, res) {
  connection.query(
    "select a.SRET_NO,DATE_FORMAT(a.SRET_DATE,'%d/%m/%Y') SRET_DATE, a.CUST_CODE," +
    " b.CUST_NAME, a.NARRATION1, a.INV_NO, a.SMAN_CODE, a.AMOUNT" +
    " from sret_hdr a left outer join cus_mst b  ON a.CUST_CODE = b.CUST_CODE " +
    " where  a.SRET_DATE >= CURDATE() - INTERVAL ? DAY " +
    " ORDER BY a.SRET_NO DESC",
    [req.params.dys],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        // console.log("Oracle SRET LST", result.rows);
        res.json(result);

      }
    }
  );
});
app.get("/srethdr/:vchr", function (req, res) {
  console.log("SRet.Note  req:=", req.params.vchr);
  connection.query(

    "select a.SRET_NO,DATE_FORMAT(a.SRET_DATE,'%d/%m/%Y') SRET_DATE, a.CUST_CODE," +
    " b.CUST_NAME, a.NARRATION1, a.INV_NO, a.SMAN_CODE, a.AMOUNT FROM  sret_hdr " +
    " WHERE  a.VCHR_NO = ? ",

    [req.params.vchr],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        console.log("Sal.Ret.Hdr ", result);
        res.json(result);

      }
    }
  );
});
app.get("/sretitems/:vchr", function (req, res) {
  console.log("SRet.Note  req:=", req.params.vchr);
  connection.query(

    "select a.SRET_NO,DATE_FORMAT(a.SRET_DATE,'%d/%m/%Y') SRET_DATE, a.LOC_CODE," +
    " a.ITEM_CODE, a.SR_NO, a.QTY, a.COST, a.DISC_PER" +
    "FROM sret_items " +
    " WHERE  a.SRETNO = ? ",

    [req.params.vchr],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        console.log("Sal.Ret.Items ", result);
        res.json(result);

      }
    }
  );
});


app.get("/salretreg", function (req, res) {
  const { start_date, end_date } = req.query;
  connection.query(
    "select a.SRET_NO,DATE_FORMAT(a.SRET_DATE,'%d/%m/%Y') SRET_DATE, a.CUST_CODE," +
    " b.CUST_NAME, a.NARRATION1, a.INV_NO, a.SMAN_CODE, a.AMOUNT" +
    " from sret_hdr a left outer join cus_mst b ON a.CUST_CODE = b.CUST_CODE where  a.SRET_DATE BETWEEN ? AND ?  " +
    "  ORDER BY a.SRET_NO DESC",
    [start_date, end_date],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        // console.log("Oracle SRET LST", result.rows);
        res.json(result);

      }
    }
  );
});
app.get("/crntlst/:dys", function (req, res) {

  connection.query(
    "select a.VCHR_NO,DATE_FORMAT(a.VCHR_DATE,'%d/%m%Y') VCHR_DATE, a.CUST_CODE," +
    " COALESCE(b.CUST_NAME,'Invalid Customer') AS CUST_NAME, a.NARRATION, a.DEBIT_AC,a.VAT_AMT,  a.AMOUNT" +
    " from crnote_hdr a left outer join cus_mst b ON b.CUST_CODE = a.CUST_CODE" +
    " WHERE  a.VCHR_DATE >= CURDATE() - INTERVAL ? DAY  " +
    "  ORDER BY a.VCHR_NO DESC",
    [req.params.dys],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //console.log("Oracle Cr.Note LST", result.rows);
        res.json(result);

      }
    }
  );
});


app.get("/crnotereg", function (req, res) {

  connection.query(
    "select a.VCHR_NO,DATE_FORMAT(a.VCHR_DATE,'%d/%m%Y') VCHR_DATE, a.CUST_CODE," +
    " b.CUST_NAME, a.NARRATION, a.DEBIT_AC,a.VAT_AMT,  a.AMOUNT" +
    " from crnote_hdr a left outer join cus_mst b ON b.CUST_CODE = a.CUST_CODE" +
    " WHERE  a.VCHR_DATE between ? and ? " +
    "  ORDER BY a.VCHR_NO DESC",
    [req.query.start_date, req.query.end_date],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //console.log("Oracle Cr.Note LST", result.rows);
        res.json(result);

      }
    }
  );
});
app.get("/crntHdr/:vchr", function (req, res) {
  console.log("Oracle Cr.Note  req:=", req.params.vchr);
  connection.query(
    "select a.VCHR_NO,DATE_FORMAT(a.VCHR_DATE,'%d/%m/%Y') VCHR_DATE, a.CUST_CODE," +
    " b.CUST_NAME, a.NARRATION, a.DEBIT_AC,a.VAT_AMT,  a.AMOUNT" +
    " from crnote_hdr a left outer join cus_mst b ON b.CUST_CODE = a.CUST_CODE" +
    " WHERE  a.VCHR_NO = ? ",

    [req.params.vchr],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        console.log("Oracle Cr.Note ", result);
        res.json(result);

      }
    }
  );
});

app.get("/drntHdr/:vchr", function (req, res) {
  console.log("Oracle Cr.Note  req:=", req.params.vchr);
  connection.query(
    "select a.VCHR_NO,DATE_FORMAT(a.VCHR_DATE,'%d/%m/%Y') VCHR_DATE, a.CUST_CODE," +
    " b.CUST_NAME, a.NARRATION, a.CREDIT_AC,a.VAT_AMT,  a.AMOUNT" +
    " from drnote_hdr a left outer join cus_mst b ON b.CUST_CODE = a.CUST_CODE" +
    " WHERE  a.VCHR_NO = ? ",

    [req.params.vchr],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        console.log("Oracle Cr.Note ", result);
        res.json(result);

      }
    }
  );
});
app.get("/drntlst/:dys", function (req, res) {

  connection.query(
    "select a.VCHR_NO,DATE_FORMAT(a.VCHR_DATE,'%d/%m%Y') VCHR_DATE, a.CUST_CODE," +
    " b.CUST_NAME, a.NARRATION, a.CREDIT_AC,  a.AMOUNT" +
    " from drnote_hdr a left outer join cus_mst b ON b.CUST_CODE = a.CUST_CODE" +
    " WHERE  a.VCHR_DATE >= CURDATE() - INTERVAL ? DAY  " +
    "  ORDER BY a.VCHR_NO DESC",
    [req.params.dys],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //console.log("Oracle Cr.Note LST", result.rows);
        res.json(result);

      }
    }
  );
});


app.get("/drnotereg", function (req, res) {

  connection.query(
    "select a.VCHR_NO,DATE_FORMAT(a.VCHR_DATE,'%d/%m%Y') VCHR_DATE, a.CUST_CODE," +
    " b.CUST_NAME, a.NARRATION, a.CREDIT_AC,  a.AMOUNT" +
    " from drnote_hdr a left outer join cus_mst b ON b.CUST_CODE = a.CUST_CODE" +
    " WHERE  a.VCHR_DATE between ? and ? " +
    "  ORDER BY a.VCHR_NO DESC",
    [req.query.start_date, req.query.end_date],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //console.log("Oracle Cr.Note LST", result.rows);
        res.json(result);

      }
    }
  );
});
app.get("/pinvlst/:dys", function (req, res) {

  connection.query(
    "select a.PJV_NO,DATE_FORMAT(a.PJV_DATE,'%d/%m/%Y') PJV_DATE, a.SUP_CODE," +
    " a.PO_NO,a.INV_NO, DATE_FORMAT(a.INV_DATE,'%d/%m/%Y') INV_DATE , " +
    "a.SRV_NO,b.SUP_NAME, a.INV_AMOUNT, a.VAT_PERC,  a.DISCOUNT,a.RND_OFF" +
    " from purchase_hdr a, sup_mst b where  a.PJV_DATE >= CURDATE() - INTERVAL ? DAY and " +
    " a.SUP_CODE = b.SUP_CODE ORDER BY a.PJV_NO DESC",
    [req.params.dys],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        result = result.map((row) => ({
          ...row,
          INV_AMOUNT: row.INV_AMOUNT ? parseFloat(row.INV_AMOUNT) : 0, // Ensure it's a number
        }));
        //console.log(" Purchase LC LST", result);
        res.json(result);


      }
    }
  );
});
app.get("/ngpnet/:vch", function (req, res) {
  connection.query(
    "select a.PRCH_NO,DATE_FORMAT(a.PRCH_DATE,'%d/%m/%Y') PRCH_DATE, a.SUP_CODE," +
    " b.SUP_NAME, a.AMOUNT, a.DISCOUNT,a.LPO_NO,a.INV_NO, a.INV_DATE,a.NARRATION  " +
    " from ngp_net a left outer join  sup_mst b on b.sup_code = a.SUP_CODE  WHERE  a.PRCH_NO =?  " +
    " ORDER BY a.PRCH_NO DESC",
    [req.params.vch],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //   console.log("Oracle Purchase LC LST", result.rows);
        res.json(result);
        console.log("NGP_NET", result)
      }
    }
  );
});
app.get("/ngpitems/:vch", function (req, res) {
  connection.query(
    "select a.PRCH_NO,a.SR_NO, a.ACC_CODE," +
    " b.ACC_HEAD, a.NARRATION , COALESCE(a.JOB_NO, 'N/A') AS JOB_NO, a.AMOUNT" +
    " from ngp_items a left outer join  acc_mst b on b.ACC_CODE = a.ACC_CODE  WHERE  a.PRCH_NO =?  " +
    " AND a.ACC_CODE IS NOT NULL " +
    " ORDER BY a.SR_NO",
    [req.params.vch],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //   console.log("Oracle Purchase LC LST", result.rows);
        result = result.map((row) => ({
          ...row,
          AMOUNT: row.AMOUNT ? parseFloat(row.AMOUNT) : 0, // Ensure it's a number
        }));
        res.json(result);
        console.log("NGP_ITEMS", result)
      }
    }
  );
});

app.get("/purchaseHdr/:vch", function (req, res) {
  connection.query(
    "select a.PJV_NO,DATE_FORMAT(a.PJV_DATE,'%d/%m/%Y') PJV_DATE, a.SUP_CODE," +
    " b.SUP_NAME, COALESCE(a.INV_AMOUNT, 0) AS INV_AMOUNT , COALESCE(a.DISCOUNT,0) AS DISCOUNT ,a.PO_NO,a.INV_NO, " +
    " DATE_FORMAT(a.INV_DATE,'%d/%m/%Y') INV_DATE ,a.NARRATION ,COALESCE(a.VAT_AMOUNT,0) AS VAT_AMOUNT " +
    " from purchase_hdr a left outer join  sup_mst b on b.sup_code = a.SUP_CODE  WHERE  a.PJV_NO =?  ",

    [req.params.vch],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //   console.log("Oracle Purchase LC LST", result.rows);
        res.json(result);
        console.log("PURCHASE_HDR", result)
      }
    }
  );
});
app.get("/purchaseitems/:vch", function (req, res) {
  connection.query(
    "select a.SRV_NO,a.SR_NO, a.ACC_CODE," +
    " b.ACC_HEAD,  a.ITEM_CODE, c.ITEM_NAME1 as ITEM_NAME ,COALESCE(a.JOB_NO, 'N/A') AS JOB_NO, " +
    " a.QTY, a.COST AS RATE, ROUND( COALESCE(a.QTY,0) * COALESCE(a.COST,0) ,2) AS AMOUNT " +
    " from purchase_items a left outer join  acc_mst b on b.ACC_CODE = a.ACC_CODE " +
    " LEFT OUTER JOIN ITEM_MST c ON c.ITEM_CODE = a.ITEM_CODE" +
    " WHERE  a.SRV_NO =?  " +
    " AND a.ACC_CODE IS NOT NULL " +
    " ORDER BY a.SR_NO",
    [req.params.vch],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //   console.log("Oracle Purchase LC LST", result.rows);
        result = result.map((row) => ({
          ...row,
          //     QTY: row.QTY ? parseFloat(row.QTY) : 0, // Ensure it's a number
          //    COST: row.COST ? parseFloat(row.COST) : 0, // Ensure it's a number
          AMOUNT: row.AMOUNT ? parseFloat(row.AMOUNT) : 0,
        }));
        res.json(result);
        console.log("PURCHASE_ITEMS", result, req.params.vch)
      }
    }
  );
});
app.get("/api/getMaxDoc/:table/:field", async (req, res) => {
  const { table, field } = req.params;

  try {
    const pool = mysqlPromise.createPool({
      host: dbIp,
      user: "root",
      password: "Digital@65",
      database: "hayat",
    });

    const [rows] = await pool.query(`CALL get_max_docno(?, ?)`, [table, field]);
    const result = rows[0][0].max_value;
    switch (table) {
      case "PRET_HDR":
        {
          res.json({ maxValue: String(Number(result.substring(0, 6)) + 1).padStart(6, "0") + 'RLV1' });
          console.log("maxDoc=", result);
          break;

        }
      case "CRNOTE_HDR":
        {
          res.json({ maxValue: 'CR' + String(Number(result.substring(2, 10)) + 1).padStart(8, "0") });
          console.log("maxDoc CRNOTE_HDR =", result.substring(2, 10));
          break;
        }
      default: {
        res.json({ maxValue: String(Number(result) + 1).padStart(10, "0") });
        console.log("maxDoc=", result);
        break;
      }
    }
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/purfrgnhdr/:vch", function (req, res) {
  connection.query(
    "select a.PJV_NO,DATE_FORMAT(a.PJV_DATE,'%d/%m/%Y') PJV_DATE, a.SUP_CODE," +
    " b.SUP_NAME, a.ACC_CODE,a.INV_AMOUNT_FRGN, a.INV_AMOUNT_LOCAL,a.CURR_CODE, a.CONV_RATE," +
    " a.DISCOUNT,a.PO_NO,a.INV_NO, " +
    " DATE_FORMAT(a.INV_DATE,'%d/%m/%Y') INV_DATE ,a.NARRATION ,a.VAT_AMOUNT " +
    " from pur_frgn_hdr a left outer join  sup_mst b on b.sup_code = a.SUP_CODE  WHERE  a.PJV_NO =?  ",

    [req.params.vch],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //   console.log("Oracle Purchase LC LST", result.rows);
        res.json(result);
        console.log("PURCHASE_HDR", result)
      }
    }
  );
});
app.get("/gittypesfp/:vch", function (req, res) {
  connection.query(
    `SELECT a.GIT_TYPE AS expCode, b.TYPE_DES AS expHead, a.ACC_CODE, a.AMOUNT as amount
     FROM lcst_trn a , git_types b where a.GIT_TYPE= b.TYPE_CODE
     AND VCHR_NO = ? 
  
     UNION ALL
  
     SELECT TYPE_CODE AS expCode, TYPE_DES AS expHead, '' AS ACC_CODE, NULL  
     FROM git_types g
     WHERE NOT EXISTS (
         SELECT 1 FROM lcst_trn t WHERE t.VCHR_NO = ? AND t.GIT_TYPE = g.TYPE_CODE
     )
  
     ORDER BY expCode`,
    [req.params.vch, req.params.vch],  // Pass the parameter twice
    function (err, result) {
      if (err) {
        throw err;
      } else {
        res.json(result);
        console.log("Git Types", result);
      }
    }
  );
});
app.get("/purfrgnitems/:vch", function (req, res) {
  connection.query(
    "select a.PJV_NO,a.SR_NO, " +
    "  a.ITEM_CODE, c.ITEM_NAME1 ITEM_DESC , " +
    " a.QTY, COALESCE(a.COST_FC,0) COST_FC, a.UNIT_COST,ROUND( COALESCE(a.QTY,0) * COALESCE(a.UNIT_COST,0) ,2) AS AMOUNT " +
    " from pur_frgn_items a " +
    " left outer join item_mst c on c.item_code = a.item_code" +
    " WHERE  a.PJV_NO =?  " +
    " ORDER BY a.SR_NO",
    [req.params.vch],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //   console.log("Oracle Purchase LC LST", result.rows);
        result = result.map((row) => ({
          ...row,
          //     QTY: row.QTY ? parseFloat(row.QTY) : 0, // Ensure it's a number
          //    COST: row.COST ? parseFloat(row.COST) : 0, // Ensure it's a number
          AMOUNT: row.AMOUNT ? parseFloat(row.AMOUNT) : 0,
        }));
        res.json(result);
        console.log("PUR_FRGN_ITEMS", result, req.params.vch)
      }
    }
  );
});

app.get("/tranaccNext/:vch", function (req, res) {
  connection.query(
    "select a.PJV_NO,DATE_FORMAT(a.PJV_DATE,'%d/%m/%Y') PJV_DATE, a.SUP_CODE," +
    " b.SUP_NAME, a.ACC_CODE,a.INV_AMOUNT_FRGN, a.INV_AMOUNT_LOCAL,a.CURR_CODE, a.CONV_RATE," +
    " a.DISCOUNT,a.PO_NO,a.INV_NO, " +
    " DATE_FORMAT(a.INV_DATE,'%d/%m/%Y') INV_DATE ,a.NARRATION ,a.VAT_AMOUNT " +
    " from pur_frgn_hdr a left outer join  sup_mst b on b.sup_code = a.SUP_CODE  WHERE  a.PJV_NO =?  ",

    [req.params.vch],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //   console.log("Oracle Purchase LC LST", result.rows);
        res.json(result);
        console.log("TRAN_ACC", result)
      }
    }
  );
});
app.get("/prethdr/:vch", function (req, res) {
  connection.query(
    "select a.VCHR_NO,DATE_FORMAT(a.VCHR_DATE,'%d/%m/%Y') as VCHR_DATE, a.SUP_CODE," +
    " b.SUP_NAME, a.INV_AMOUNT, a.INV_NO, a.INV_DATE,a.NARRATION ,a.DISCOUNT" +
    " from pret_hdr a left outer join sup_mst b ON  a.SUP_CODE = b.SUP_CODE  where  a.VCHR_NO = ? " +
    " ORDER BY a.VCHR_NO DESC",
    [req.params.vch],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        console.log("PRET_HDR", result.rows);
        res.json(result);

      }
    }
  );
});

app.get("/ngplst/:dys", function (req, res) {
  connection.query(
    "select a.PRCH_NO,DATE_FORMAT(a.PRCH_DATE,'%d/%m/%Y') PRCH_DATE, a.SUP_CODE," +
    " b.SUP_NAME, a.AMOUNT, a.LPO_NO,a.JOB_NO,a.INV_NO,DATE_FORMAT(a.INV_DATE,'%d/%m/%Y') INV_DATE,a.NARRATION " +
    " from ngp_net a left outer join sup_mst b on b.SUP_CODE = a.SUP_CODE  " +
    " where  a.PRCH_DATE >= CURDATE() - INTERVAL ? DAY   " +
    " ORDER BY a.PRCH_NO DESC",

    [req.params.dys],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //  console.log("Oracle Purchase LC LST", result.rows);
        res.json(result)
      }
    }
  );
});

app.get("/pretlst/:dys", function (req, res) {


  connection.query(
    "select a.VCHR_NO, DATE_FORMAT(a.VCHR_DATE,'%d/%m%Y') VCHR_DATE," +
    "a.PJV_NO,DATE_FORMAT(a.PJV_DATE,'%d/%m%Y') PJV_DATE, a.SUP_CODE," +
    " b.SUP_NAME, a.INV_AMOUNT,  VAT_PERC,NARRATION ,DISCOUNT" +
    " from pret_hdr a left outer join sup_mst b ON  a.SUP_CODE = b.SUP_CODE " +
    " where  a.VCHR_DATE >= CURDATE() - INTERVAL ? DAY " +
    " ORDER BY a.VCHR_NO DESC",
    [req.params.dys],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //   console.log("Oracle Pret  LST", result.rows);
        res.json(result);

      }
    }
  );
});
app.get("/nextdo", function (req, res) {
  connection.query(
    "select (Max(a.INV_NO)+1) AS NextDo " +
    " from fab_do_hdr a ",
    function (err, results, fields) {
      if (err) {
        throw err;
      } else {
        console.log("Next  DO No.", results[0].NextDo)
        const strDo = String(results[0].NextDo).trim();
        console.log('Str D/O =>', strDo.padStart(10, 0));

        //padStart(10, '0'));
        //.padStart(10, '0')
        res.json(strDo.padStart(10, 0));

      }
    }
  );
});

app.get("/dolist/:dys", function (req, res) {
  connection.query(
    "select a.INV_NO DO_NO, DATE_FORMAT(a.INV_DATE,'%d/%m/%Y') DO_DATE, a.CUST_CODE," +
    " b.CUST_NAME, a.JOB_NO, a.DO_NO INV_NO, a.DO_APPROVED, a.QUOT_NO ," +
    " a.LPO_NO, DATE_FORMAT(a.LPO_DATE,'%d%m%Y') AS LPO_DATE, a.CONTACT_PERSON " +
    " from fab_do_hdr a, cus_mst b where  a.INV_DATE >= CURDATE() - INTERVAL ? DAY and " +
    " a.CUST_CODE = b.CUST_CODE ORDER BY a.INV_NO DESC",
    [req.params.dys],

    function (err, results, fields) {
      if (err) {
        throw err;
      } else {
        //    console.log("Oracle DO LST", result.rows);
        res.json(results);

      }
    }
  );
});
app.get("/fabdohdr/:doNo", function (req, res) {
  console.log("DO_HDR", req.params.doNo);
  connection.query(
    "SELECT a.INV_NO ,a.DO_NO, DATE_FORMAT(a.INV_DATE,'%d/%m/%Y') AS DO_DATE, a.CUST_CODE, " +
    "b.CUST_NAME, a.JOB_NO,  a.DO_APPROVED, a.QUOT_NO, a.LPO_NO,a.CONTACT_PERSON, " +
    "DATE_FORMAT(a.LPO_DATE,'%d/%m/%Y') AS LPO_DATE , a.DO_APPROVED " +
    "FROM fab_do_hdr a " +
    "left outer join cus_mst b on a.cust_code = b.cust_code " +
    "WHERE a.INV_NO = ?",
    [req.params.doNo],   // <-- Missing comma before!
    (err, results) => {
      if (err) {
        console.error(err);
        res.status(500).send("Database error");
        return;
      }
      console.log(results);
      res.json(results);
    }
  );
});

app.get("/jobdoreg", function (req, res) {
  const { start_date, end_date } = req.query;

  console.log("DO_REG", start_date);
  connection.query(
    "SELECT a.INV_NO AS DO_NO, DATE_FORMAT(a.INV_DATE,'%d/%m/%Y') AS DO_DATE, a.CUST_CODE, " +
    "b.CUST_NAME, a.JOB_NO, a.DO_NO, a.PAYMENT_TERMS, a.QUOT_NO, a.LPO_NO,a.CONTACT_PERSON, " +
    "DATE_FORMAT(a.LPO_DATE,'%d/%m/%Y') AS LPO_DATE , a.PRINTED_BY " +
    "from fab_do_hdr a " +
    "left outer join cus_mst b on a.cust_code = b.cust_code " +
    "WHERE a.INV_DATE BETWEEN ? AND ? ORDER BY INV_DATE, INV_NO",
    [start_date, end_date],   // <-- Missing comma before!
    (err, results) => {
      if (err) {
        console.error(err);
        res.status(500).send("Database error");
        return;
      }
      console.log(results);
      res.json(results);
    }
  );
});
app.get("/fabdoitems/:doNo", function (req, res) {
  console.log("DO_DO_DTL", req.params.doNo);
  connection.query(
    "SELECT a.INV_NO DO_NO, DATE_FORMAT(a.INV_DATE,'%d%m%Y') AS DO_DATE,  " +
    " a.SR_NO,  a.ITEM_CODE,a.INV_ITEM_DESC AS ITEM_DESC ,a.INV_QTY AS QTY ,a.INV_UNIT as UNIT  " +
    "from fab_do_dtl a " +
    "WHERE a.INV_NO = ? order by a.sr_no",
    [req.params.doNo],   // <-- Missing comma before!
    (err, results) => {
      if (err) {
        console.error(err);
        res.status(500).send("Database error");
        return;
      }
      console.log('Fab do Details', results);
      res.json(results);
    }
  );
});
app.get("/pretitems/:vchr", function (req, res) {


  connection.query(
    "select a.VCHR_NO,DATE_FORMAT(a.VCHR_DATE,'%d%m%Y') VCHR_DATE," +
    " a.ITEM_CODE, b.ITEM_NAME1,a.QTY, a.COST ,a.SR_NO, (a.QTY * a.COST) AMOUNT" +
    " from pret_items a" +
    " left outer join item_mst b  on a.loc_code = b.loc_code and a.item_code = b.item_code " +
    " where  a.vchr_no = ? " +
    "  ORDER BY a.SR_NO",
    [req.params.vchr],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        console.log(" Pret_items ", result);
        res.json(result);
        // conn.close();
      }
    }
  );
});

app.get("/netsales/:vchr", function (req, res) {
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    //console.log('Sales Invoice Net_Sales ');

    conn.execute(
      "select a.INV_NO,a.INV_DATE," +
      " a.CUST_CODE, a.LPO_NO, a.ADDL_CUST_NAME, a.AMOUNT, a.DISCOUNT, a.ROUND_OFF, " +
      " a.CURR_ENCY, a.VAT_PERC, a.VAT_AMOUNT, a.SMAN_CODE, a.DISC_PER " +
      " from net_sales a where a.INV_NO = :vchr",
      [req.params.vchr],
      {
        outFormat: orcl1.OBJECT,
      },
      function (err, result) {
        if (err) {
          throw err;
        } else {
          //   console.log("Oracle Sinv Netsales ", result.rows);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});

app.get("/sinvitems/:vchr", function (req, res) {
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    // console.log('Sales Invoice Items ');

    conn.execute(
      "select a.INV_NO,To_char(a.INV_DATE,'DD/MM/RRRR') INV_DATE," +
      " a.ITEM_CODE,a.ITEM_DES1, a.INV_QTY, a.INV_RATE ,Nvl(a.SR_NO, ROWNUM) SR_NO, nvl(a.INV_QTY,0) * Nvl(a.INV_RATE,0) AMOUNT" +
      " from invoice a where a.Inv_no = :vchr" +
      "  ORDER BY Nvl(a.SR_NO, ROWNUM)",
      [req.params.vchr],
      {
        outFormat: orcl1.OBJECT,
      },
      function (err, result) {
        if (err) {
          throw err;
        } else {
          //   console.log("Oracle Sinv Items ", result.rows);
          res.end(JSON.stringify(result.rows));
        }
        conn.close();
      }
    );
  });
});

app.get("/sadjlst/:dys", function (req, res) {


  connection.query(
    "select a.VCHR_NO,To_char(a.VCHR_DATE,'DD/MM/RRRR') VCHR_DATE," +
    " a.NARRATION " +
    " from stk_hdr a where  a.VCHR_DATE >= SYSDATE - :dys " +
    "  ORDER BY a.VCHR_NO DESC",
    [req.params.dys],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //console.log("Oracle LPOLST", result);
        res.json(result)

      }
    }
  );

});

app.get("/gtrnlst/:dys", function (req, res) {
  connection.query(
    "select a.GTRN_NO,DATE_FORMAT(a.GTRN_DATE,'%d/%m/%Y') GTRN_DATE," +
    " a.GTRN_NARRATION  AS NARRATION" +
    " from gtrn_hdr a where  a.GTRN_DATE >= CURDATE() -INTERVAL ? DAY " +
    "  ORDER BY a.GTRN_NO DESC",
    [req.params.dys],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //console.log("Oracle LPOLST", result);
        res.json(result)
        //  conn.close();
      }
    }
  );
});
app.get("/gtrnitems/:vch", function (req, res) {
  connection.query(
    "select a.GTRN_NO,DATE_FORMAT(a.GTRN_DATE,'%d/%m/%Y') GTRN_DATE," +
    " a.LOC_FROM, a.LOC_TO ,a.ITEM_CODE, a.QTY,a.SR_NO, a.UNIT_COST,' ' as UOM " +
    " from gtrn_items a where  a.GTRN_NO =?  " +
    "  ORDER BY a.SR_NO  DESC",
    [req.params.vch],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //console.log("Oracle LPOLST", result);
        res.json(result)
        //  conn.close();
      }
    }
  );
});


//
app.get("/trnlst/:tp/:dys/:dbcr", function (req, res) {
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    // console.log('TRAN List. ', req.params.tp, req.params.dys);

    conn.execute(
      "select a.TRAN_TYPE,a.VCHR_NO,To_char(a.DATTE,'DD/MM/RRRR') DATTE, a.ACC_CODE," +
      " b.AC_NAME, a.AMOUNT, a.DB_CR,a.NARRATION1,a.NARRATION2,a.JOB_NO, a.PANEL_NO,  a.USERNAME " +
      " from tran_acc a, ac_list b where  a.TRAN_TYPE =:tp and a.DATTE >= SYSDATE - :dys and " +
      " a.DB_cr = NVL(:dbcr,'C') AND a.ACC_CODE = b.AC_CODE ORDER BY a.VCHR_NO DESC",
      [req.params.tp, req.params.dys, req.params.dbcr],
      {
        outFormat: orcl1.OBJECT,
      },
      function (err, result) {
        if (err) {
          throw err;
        } else {
          //console.log("Oracle LPOLST", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});

app.get("/sinqcomplst", function (req, res) {
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    conn.execute(
      "select CMPL_CODE,CMPL_NAME" +
      "  from sinq_compliance_mst ORDER BY cmpl_codE",
      {},
      {
        outFormat: orcl1.OBJECT,
      },
      function (err, result) {
        if (err) {
          throw err;
        } else {
          //console.log("Oracle SmanMst", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});
app.get("/sinqloclst", function (req, res) {
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    // console.log('Sales Loc Lst. ');

    conn.execute(
      "select SINQ_LOC_CODE,SINQ_LOC_NAME" +
      "  from sinq_loc_mst ORDER BY SINQ_LOC_CODE",
      {},
      {
        outFormat: orcl1.OBJECT,
      },
      function (err, result) {
        if (err) {
          throw err;
        } else {
          //console.log("Oracle SmanMst", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});
app.get("/sinqloc/:id", function (req, res) {
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    conn.execute(
      "select SINQ_LOC_CODE, SINQ_LOC_NAME " +
      "FROM sinq_loc_mst WHERE SINQ_LOC_CODE=:id",
      [req.params.id],
      {
        outFormat: orcl1.OBJECT,
      },
      function (error, result) {
        if (error) {
          throw error;
        } else {
          //  console.log("Oracle-Sinq Loc", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});
app.get("/locmst/:id", function (req, res) {
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    conn.execute(
      "select LOC_CODE, LOC_NAME " + "FROM loc_mst WHERE LOC_CODE=:id",
      [req.params.id],
      {
        outFormat: orcl1.OBJECT,
      },
      function (error, result) {
        if (error) {
          throw error;
        } else {
          //console.log("Oracle-LocMst ", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});

app.get("/catlst", function (req, res) {
  connection.query(

    "select CAT_CODE, CAT_NAME" + " from cat_mst order by CAT_CODE",
    {},

    function (error, results, fields) {
      if (error) throw error;
      res.json(results);

      //console.log(results);
    }
  );
});


app.get("/catmst/:id", function (req, res) {

  connection.query(
    "select CAT_CODE, CAT_NAME " + "FROM cat_mst WHERE CAT_CODE=?",
    [req.params.id],

    function (error, result) {
      if (error) {
        throw error;
      } else {
        //console.log("Oracle-LocMst ", result);
        res.json(result);

      }
    }
  );
});

//Save to cat_mst
app.post("/api/save-catmst", (req, res) => {
  const data = req.body; // Receive data from frontend
  console.log("Save-Cat_mst");
  if (!data || Object.keys(data).length === 0) {
    return res.status(400).json({ error: "No data provided" });
  }

  // Extract keys and values from the request body
  const columns = Object.keys(data).join(", ");
  const values = Object.values(data);
  const updateClause = Object.keys(data)
    .map((key) => `${key} = VALUES(${key})`)
    .join(", ");

  // MySQL Query with ON DUPLICATE KEY UPDATE
  const query = `INSERT INTO cat_mst (${columns}) VALUES (${values.map(() => "?").join(", ")}) 
                   ON DUPLICATE KEY UPDATE ${updateClause}`;

  connection.query(query, values, (err, result) => {
    if (err) {
      console.error("Error inserting/updating catg.Master:", err);
      return res.status(500).json({ error: "Database error" });
    }
    res.json({ message: "Catg. Code inserted/updated successfully", result });
  });
})
app.get("/itmsubcat/:cat/:scat", function (req, res) {
  console.log("itmscatent entered" + req.params.cat + " - " + req.params.scat);

  connection.query(
    "select a.CAT_CODE,b.CAT_NAME, a.SUB_CAT_CODE, a.SUB_CAT_NAME " +
    "FROM item_subcat a, CAT_MST b WHERE a.cat_code = b.cat_code and a.CAT_CODE=? AND a.SUB_CAT_CODE =?",
    [req.params.cat, req.params.scat],

    function (error, result) {
      if (error) {
        throw error;
      } else {
        console.log("ITEM_SUBCAT ", result);
        res.json(result);

      }
    }
  );
});

app.put("/itmscatedt", function (req, res, next) {
  //--
  /*
  let bank1 = req.body;
  console.log('Sman edt', bank1);

  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    // console.log("Tran type Update on Server *1 " + req.params.id + " * 1st ");
    conn.execute("UPDATE SMAN_MST SET SMAN_NAME=:1, SMAN_DESIGNATION =:2, SMAN_MOBILE =:3, SMAN_EMAIL = :4" +
      " where SMAN_CODE=:5 ", [bank1.smanname, bank1.smandes, bank1.smanmobile,
        bank1.smanemail, bank1.smancode
      ], {
        outFormat: orcl1.OBJECT,
        autoCommit: true
      },
      function (error, results) {
        if (error) throw error;
        res.end(JSON.stringify(results));
        conn.close();
      });
  });*/

  //--
  let bank1 = req.body;
  // console.log('Item Scatg edt', bank1);

  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    //  console.log("Update Item scat on Server *1 " + bank1.catcode+"-"+bank1.scatcode + " * 1st "+bank1.scatname);
    conn.execute(
      "UPDATE ITEM_SUBCAT SET  SUB_CAT_NAME = :1 " +
      " WHERE CAT_CODE = :2 AND SUB_CAT_CODE = :3",
      [bank1.scatname, bank1.catcode, bank1.scatcode],
      {
        outFormat: orcl1.OBJECT,
        autoCommit: true,
      },
      function (error, results) {
        // console.log ("Itmscatedt update over"+results.rows);
        if (error) throw error;
        res.end(JSON.stringify(results));
        conn.close();
      }
    );
  });
});
app.get("/sinqtypelst", function (req, res) {
  // console.log('Sales Enq.Type. ');

  connection.query(
    "select INQ_TYPE_CODE,INQ_TYPE_DESC" +
    "  from inq_type_mst ORDER BY INQ_TYPE_CODE",

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //console.log("Oracle SmanMst", result);
        res.json(result);
        //  conn.close();
      }
    }
  );
});

app.get("/sinqtype/:id", function (req, res) {
  connection.query(
    "select INQ_TYPE_CODE, INQ_TYPE_DESC " +
    "FROM inq_type_mst WHERE INQ_TYPE_CODE=?",
    [req.params.id],

    function (error, result) {
      if (error) {
        throw error;
      } else {
        // console.log("Oracle-Sinq Type", result);
        res.json(result)

      }
    }
  );
});
app.post("/api/save-sinqstat", (req, res) => {
  const data = req.body; // Receive data from frontend
  console.log("Save-J inq_type_mst");
  if (!data || Object.keys(data).length === 0) {
    return res.status(400).json({ error: "No data provided" });
  }

  // Extract keys and values from the request body
  const columns = Object.keys(data).join(", ");
  const values = Object.values(data);
  const updateClause = Object.keys(data)
    .map((key) => `${key} = VALUES(${key})`)
    .join(", ");

  // MySQL Query with ON DUPLICATE KEY UPDATE
  const query = `INSERT INTO inq_type_mst (${columns}) VALUES (${values.map(() => "?").join(", ")}) 
                   ON DUPLICATE KEY UPDATE ${updateClause}`;

  connection.query(query, values, (err, result) => {
    if (err) {
      console.error("Error inserting/updating Inq Type Master Master:", err);
      return res.status(500).json({ error: "Database error" });
    }
    res.json({ message: "Inq Type Master  inserted/updated successfully", result });
  });
})
app.put("/sinqtype/:id", function (req, res, next) {
  let bank1 = req.body;
  // console.log('Sinq Type edt', bank1);

  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    // console.log("Tran type Update on Server *1 " + req.params.id + " * 1st ");
    conn.execute(
      "UPDATE INQ_TYPE_MST SET INQ_TYPE_DESC=:1 " + " where INQ_TYPE_CODE=:2 ",
      [bank1.inqtypedesc, bank1.inqtypecode],
      {
        outFormat: orcl1.OBJECT,
        autoCommit: true,
      },
      function (error, results) {
        if (error) throw error;
        res.end(JSON.stringify(results));
        conn.close();
      }
    );
  });
});
app.get("/enqformlst", function (req, res) {
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    // console.log('Sales Enq Form of enq. ');

    conn.execute(
      "select RCP_CODE,RCP_DESC" + "  from sinq_rcpt_mst ORDER BY RCP_CODE",
      {},
      {
        outFormat: orcl1.OBJECT,
      },
      function (err, result) {
        if (err) {
          throw err;
        } else {
          //console.log("Oracle SmanMst", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});
app.get("/enqformMst/:id", function (req, res) {
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    conn.execute(
      "select RCP_CODE, RCP_DESC " + " FROM sinq_rcpt_mst WHERE RCP_CODE=:id",
      [req.params.id],
      {
        outFormat: orcl1.OBJECT,
      },
      function (error, result) {
        if (error) {
          throw error;
        } else {
          // console.log("Oracle  -S.Inq Form edt", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});
/*  */
app.put("/enqformMst/:id", function (req, res, next) {
  let bank1 = req.body;
  // console.log('Sman edt', bank1);

  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    // console.log("Tran type Update on Server *1 " + req.params.id + " * 1st ");

    // console.log("Tran type Update on Server *1 " + req.params.id + " * 1st ");
    conn.execute(
      "UPDATE SINQ_RCPT_MST SET RCP_DESC=:1" + " where RCP_CODE=:2 ",
      [bank1.rcpdesc, bank1.rcpcode],
      {
        outFormat: orcl1.OBJECT,
        autoCommit: true,
      },
      function (error, results) {
        if (error) throw error;
        res.end(JSON.stringify(results));
        conn.close();
      }
    );
  });
});
/*    */
app.get("/enqstatlist", function (req, res) {
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    //console.log('Sales Enq List ');

    conn.execute(
      "select STAT_CODE,STAT_DESC" +
      "  from sales_inquiry_status ORDER BY STAT_CODE",
      {},
      {
        outFormat: orcl1.OBJECT,
      },
      function (err, result) {
        if (err) {
          throw err;
        } else {
          //console.log("Oracle SmanMst", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});
app.get("/enqstat/:id", function (req, res) {
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    conn.execute(
      "select STAT_CODE, STAT_DESC " +
      " FROM sales_inquiry_status WHERE STAT_CODE=:id",
      [req.params.id],
      {
        outFormat: orcl1.OBJECT,
      },
      function (error, result) {
        if (error) {
          throw error;
        } else {
          // console.log("Oracle  -S.Inq edt", result);
          res.end(JSON.stringify(result.rows));
          conn.close();
        }
      }
    );
  });
});
app.put("/enqstat/:id", function (req, res, next) {
  let bank1 = req.body;
  // console.log('Sman edt', bank1);

  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    // console.log("Tran type Update on Server *1 " + req.params.id + " * 1st ");

    // console.log("Tran type Update on Server *1 " + req.params.id + " * 1st ");
    conn.execute(
      "UPDATE SALES_INQUIRY_STATUS SET STAT_DESC=:1" + " where STAT_CODE=:2 ",
      [bank1.statdesc, bank1.statcode],
      {
        outFormat: orcl1.OBJECT,
        autoCommit: true,
      },
      function (error, results) {
        if (error) throw error;
        res.end(JSON.stringify(results));
        conn.close();
      }
    );
  });
});
//
app.post("/invhdrpost", function (req, res, next) {
  // res.json(req.body);
  //var Pmode;
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    //  console.log("Entered lpoud-cusent SERVER");
    var postData = req.body;

    const RcvdInvdt = req.body.invDt;
    const OrclInvdt = new Date(RcvdInvdt).toJSON();
    console.log("sInv.Hdr Insert  Orclinvdt=" + OrclInvdt);
    // console.log("supname.postdata=" + postData.custcode);
    //console.log("supname.SUP_NAME="+req.body.SUP_NAME);
    // /TO_DATE('${OrclInvdt}', 'YYYY-MM-DD"T"HH24:MI:SS.SSS"Z"')
    Pmode = "INSERT";
    let sql =
      "INSERT INTO net_sales (INV_NO, INV_DATE, CUST_CODE,AMOUNT) VALUES " +
      "('" +
      req.body.invNo +
      "','" +
      "01-JAN-24" +
      "','" +
      req.body.CustCd +
      "','" +
      req.body.TotAmt +
      "')";
  });
});
//
app.put("/invhdrput/:id", (req, res, next) => {
  // console.log(res.json(req.body));
  //var Pmode;
  console.log("InvHdrPut");
  const { id } = req.params;
  // const { updatedField1, updatedField2 } = req.body;
  const netsal = req.body;

  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    if (err) {
      console.error("Error getting connection:", err.message);
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }
    // pool.getConnection(function (err, conn) {
    var postData = req.body;

    var Pmode = "UPDATE";
    console.log("PMODE=" + Pmode);
    console.log("InvDt=" + netsal.invDt);

    conn.execute(
      "UPDATE NET_SALES  SET " +
      " CUST_CODE= :1 ,AMOUNT =:2 , ADDL_CUST_NAME=:3, SMAN_CODE =:4 , REMARKS1 = :5" +
      " WHERE INV_NO = :7 ",
      [
        netsal.CustCd,
        netsal.TotAmt,
        netsal.AddlCustDtl,
        netsal.Smancd,
        netsal.CusTel,
        id,
      ],
      {
        outFormat: orcl1.OBJECT,
        autoCommit: false,
      },
      function (error, results) {
        if (error) {
          console.error("Error updating record:", error.message);
          res.status(500).json({ error: "Internal Server Error" });
          conn.close();
          return;
        }
        //  conn.close();
      }
    );
    console.log("Updated invoice items");
    //

    conn.commit(function (err) {
      if (err) {
        console.error("Error committing transaction:", err.message);
        res.status(500).json({ error: "Internal Server Error" });
      } else {
        console.log("finished");
        res.send("Sales Invoice items updated successfully!");
      }
      conn.close();
    });
    // INV_DATE = To_char(:6 ,'DD/MM/YY')
    //formattedDate,
  });
});
//
app.put("/sinvacc", function (req, res, next) {
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    //  console.log("Entered lpoud-cusent SERVER");
    var putData = req.body;

    const RcvdInvdt = req.body.invDt;
    const OrclInvdt = new Date(RcvdInvdt).toJSON().substring(0, 10);
    console.log("sInv.Hdr Insert  Orclinvdt=" + OrclInvdt);
    console.log("sinvacc:", putData);
    let Ttype;
    let dbCr;
    Ttype = "06";
    dbCr = "D";
    //Delete

    let sql = "DELETE FROM tran_acc WHERE TRAN_TYPE =:1 AND VCHR_NO=:2 ";

    conn.execute(
      sql,
      {
        1: Ttype,
        2: putData.invNo,
      },
      {
        outFormat: orcl1.OBJECT,
        autoCommit: true,
      },
      function (error, result) {
        if (error) {
          throw error;
        } else {
          console.log("Tran_acc sales inv  delete success", result);
          res.end(JSON.stringify(result.rows));
          // conn.close();
        }
      }
    );

    //
    Pmode = "INSERT";
    conn.execute(
      "INSERT INTO  tran_acc (  TRAN_TYPE, VCHR_NO, DATTE, " +
      " ACC_CODE , NARRATION1 , NARRATION2, AMOUNT , DB_CR )" +
      " VALUES (:1,:2,TO_DATE(:3,'YYYY-MM-DD'),:4,:5,:6,:7,:8) ",
      [
        Ttype,
        putData.invNo,
        OrclInvdt,
        putData.CustCd,
        putData.CustName,
        putData.AddlCustDtl,
        putData.TotAmt,
        dbCr,
      ],
      {
        outFormat: orcl1.OBJECT,
        autoCommit: true,
      },
      function (err, results) {
        if (err) {
          console.error("Sal_invV Tranacc insert ", err.message);
          //callback(err.message)
        } else {
          console.log(
            "Rows inserted (Sales Invoice/Tranacc)" + results.rowsAffected
          );
          res.end(JSON.stringify(results));
          // conn.close();
        }
        // conn.close();
      }
    );
    dbCr = "C";
    //SALES cR 30101
    conn.execute(
      "INSERT INTO  tran_acc (  TRAN_TYPE, VCHR_NO, DATTE, " +
      " ACC_CODE , NARRATION1 , NARRATION2, AMOUNT , DB_CR )" +
      " VALUES (:1,:2,TO_DATE(:3,'YYYY-MM-DD'),:4,:5,:6,:7,:8) ",
      [
        Ttype,
        putData.invNo,
        OrclInvdt,
        "30101",
        putData.CustName,
        putData.AddlCustDtl,
        putData.totGross,
        dbCr,
      ],
      {
        outFormat: orcl1.OBJECT,
        autoCommit: true,
      },
      function (err, results) {
        if (err) {
          console.error("Sal_invV Tranacc insert ", err.message);
          //callback(err.message)
        } else {
          console.log(
            "Rows inserted (Sales Invoice/Tranacc/Gross Amt Cr - Sales)" +
            results.rowsAffected
          );
          res.end(JSON.stringify(results));
        }
        // conn.close();
      }
    );
    //
    conn.execute(
      "INSERT INTO  tran_acc (  TRAN_TYPE, VCHR_NO, DATTE, " +
      " ACC_CODE , NARRATION1 , NARRATION2, AMOUNT , DB_CR )" +
      " VALUES (:1,:2,TO_DATE(:3,'YYYY-MM-DD'),:4,:5,:6,:7,:8) ",
      [
        Ttype,
        putData.invNo,
        OrclInvdt,
        "20007",
        "V.A.T " + putData.CustName,
        putData.AddlCustDtl,
        putData.totVat,
        dbCr,
      ],
      {
        outFormat: orcl1.OBJECT,
        autoCommit: true,
      },
      function (err, results) {
        if (err) {
          console.error("Sal_invV Tranacc insert ", err.message);
          //callback(err.message)
        } else {
          console.log(
            "Rows inserted (Sales Invoice/Tranacc/VAT Amt Cr - VAT)" +
            results.rowsAffected
          );
          res.end(JSON.stringify(results));
          conn.close();
        }
        // conn.close();
      }
    );
    //
  });
});
//


//delete Cus DELETE RECORD
app.delete("/cusDelete/:id", function (req, res, next) {
  var sql = "DELETE FROM cus_mst WHERE CUST_CODE = ?";
  connection.query(sql, [req.params.id], function (err, result) {
    if (err) throw err;
    //  console.log("Number of records deleted: " + result.affectedRows);
  });
});
//Cmp Name
app.get("/cmpname", function (req, res) {
  connection.query(
    "select NAME, PLACE " + " FROM company ",
    [],

    function (error, results) {
      if (error) throw error;
      res.json(results);

    }
  );
});


// Item Master
app.get("/itemlst/:catg", function (req, res) {
  console.log("ITEMLST 11");

  connection.query(
    "select LOC_CODE, ITEM_CODE , ITEM_NAME1 , CL_STOCK, ITEM_UNIT, CAT_CODE, SUB_CAT, BRAND" +
    " FROM item_mst  WHERE CAT_CODE like ? AND ITEM_NAME1 <>'.' order by ITEM_NAME1",
    [req.params.catg],

    //Decode(:catg,'null','%', :catg)
    function (error, results) {
      if (error) throw error;
      res.json(results);
    }
  );
});

app.get("/itmlst", function (req, res) {
  //console.log(catg)
  //const tableName= 'ITEM_MST';
  connection.query(
    "select LOC_CODE, ITEM_CODE , ITEM_NAME1 ,OP_STOCK, CL_STOCK, ITEM_UNIT, CAT_CODE, SUB_CAT, BRAND, cl_stock," +
    "COST_PRICE, ITEM_DATE, SUP_CODE,SALES_ACCOUNT  FROM item_mst  order by cat_code, sub_cat,item_code",
    [],

    //Decode(:catg,'null','%', :catg)
    function (error, results) {
      if (error) throw error;
      res.json(results);
      //res.json({tableName, data:results});

    }
  );
});


app.get("/items/:id", function (req, res) {

  connection.query(
    "select  ITEM_CODE, ITEM_NAME1,LOC_CODE, CAT_CODE, SUB_CAT, OP_STOCK,OP_RATE, CL_STOCK, " +
    "ITEM_UNIT,  COST_PRICE, SALE_PRICE , REORD_QTY, REORD_LVL ,MAX_LEVEL,ITEM_PACK, " +
    " ITEM_PACK_FACTOR,SUP_CODE, SALES_ACCOUNT,BRAND " +
    " FROM item_mst WHERE ITEM_CODE= ?",
    [req.params.id],

    function (error, results) {
      if (error) throw error;
      res.json(results);

      console.log(results);
    }
  );
});
app.get("/stkval", function (req, res) {
  const endDt = req.query.end_date;
  console.log('enddate =', endDt);
  const sql = `
    SELECT 
      a.LOC_CODE, 
      a.ITEM_CODE, 
      a.ITEM_NAME1,
      IFNULL(c.CL_STOCK, 0) AS CL_STOCK,
      IFNULL(uc.UNIT_COST, 0) AS UNIT_COST,
      ROUND(IFNULL(c.CL_STOCK, 0) * IFNULL(uc.UNIT_COST, 0),2) AS AMOUNT,
      a.ITEM_UNIT,
      a.CAT_CODE
    from item_mst as a
    left join (
      select item_code, sum(qty) as cl_stock
      from stock_trans
      group by item_code
    ) as c on a.item_code = c.item_code
    left join (
      select 
        item_code,
        loc_code,
        avgcost(loc_code, item_code, ?) as unit_cost
      from item_mst
    ) AS uc ON a.ITEM_CODE = uc.item_code AND a.LOC_CODE = uc.loc_code
    ORDER BY a.ITEM_NAME1
  `;

  connection.query(sql, [endDt], function (error, results) {
    if (error) throw error;
    console.log(results);
    res.json(results);
  });
});

app.get("/stkledOp/:id/:stdt", function (req, res) {

  connection.query(
    "select  sum(qty) as OPBAL  " +
    " FROM stock_trans WHERE ITEM_CODE= ? and  DOC_DATE < ?",
    [req.params.id, req.params.stdt],

    function (error, results) {
      if (error) throw error;
      res.json(results);

      console.log(results);
    }
  );
});

app.get("/stkled/:id/:stdt/:enddt", function (req, res) {

  connection.query(
    "select  DOC_NO, DATE_FORMAT(DOC_DATE,'%d/%m/%Y') AS DOC_DATE,LOC_CODE, ITEM_CODE, " +
    " JOB_NO, STD_COST,STOCK_TRAN_TYPE,SUP_CODE,NARRATION,SORT_ORD ," +
    " CASE WHEN QTY>0 THEN QTY ELSE 0 END  AS QTY_IN ," +
    " CASE WHEN QTY<=0 THEN QTY ELSE 0 END  AS QTY_OUT ," +
    " CASE WHEN QTY<=0 THEN AVGCOST(LOC_CODE,ITEM_CODE,DOC_DATE)  ELSE STD_COST END  AS STD_COST " +
    " FROM stock_trans WHERE ITEM_CODE= ? AND DOC_DATE BETWEEN ? AND ? ORDER BY date_format(DOC_DATE,'%Y/%m/%d') , SORT_ORD",
    [req.params.id, req.params.stdt, req.params.enddt],

    function (error, results) {
      if (error) throw error;
      res.json(results);

      console.log(results);
    }
  );
});
app.post("/api/save-itemmst", (req, res) => {
  const data = req.body; // Receive data from frontend
  console.log("Save-Items");
  if (!data || Object.keys(data).length === 0) {
    return res.status(400).json({ error: "No data provided" });
  }

  // Extract keys and values from the request body
  const columns = Object.keys(data).join(", ");
  const values = Object.values(data);
  const updateClause = Object.keys(data)
    .map((key) => `${key} = VALUES(${key})`)
    .join(", ");

  // MySQL Query with ON DUPLICATE KEY UPDATE
  const query = `INSERT INTO item_mst (${columns}) VALUES (${values.map(() => "?").join(", ")}) 
                   ON DUPLICATE KEY UPDATE ${updateClause}`;

  connection.query(query, values, (err, result) => {
    if (err) {
      console.error("Error inserting/updating Item Master:", err);
      return res.status(500).json({ error: "Database error" });
    }
    res.json({ message: "Itens inserted/updated successfully", result });
  });
});
app.delete("/itemdel/:itmcd", function (req, res, next) {
  // res.json(req.body);
  //var Pmode;

  var postData = req.body;
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    //console.log("supname.SUP_NAME="+req.body.SUP_NAME);
    conn.execute(
      "DELETE FROM item_mst WHERE ITEM_CODE =:1",
      {
        1: req.params.itmcd,
      },
      {
        outFormat: orcl1.OBJECT,
        autoCommit: true,
      },
      function (error, results, fields) {
        if (error) throw error;

        // console.log("Deleted Item", req.params.itmcd);
        res.end();
      }
    );
  });
});
// Sales man List


app.get("/itmscatlst", function (req, res) {
  //tableName ='ITEM_SUBCAT';
  connection.query(
    "select a.CAT_CODE, b.CAT_NAME, a.SUB_CAT_CODE, a.SUB_CAT_NAME" +
    " from item_subcat a LEFT OUTER JOIN CAT_MST b ON b.CAT_CODE = a.CAT_CODE",

    {},

    function (error, results, fields) {
      if (error) throw error;
      res.json(results);
      // res.json({tableName, data:results});
      //  console.log(results.rows);

      //console.log(results);
    }
  );
});

app.get("/lpoitems/:po", function (req, res) {
  console.log("LPO No=");
  console.log(req.params.po);

  connection.query(
    "select LPO_NO,JOB_NO,SR_NO,MAIN_SR_NO,ITEM_CODE , ITEM_NAME , QTY, UNIT ,RATE ," +
    " round(qty*rate,2) AMOUNT" +
    " FROM lpo_items WHERE LPO_NO =? order by sr_no",
    [req.params.po],

    function (error, results, fields) {
      if (error) throw error;
      res.json(results);
      console.log(results);
    }
  );
});

//lpoNet
app.get("/lponet/:po", function (req, res) {
  // console.log(req.params)

  connection.query(
    "select LPO_NO,DATE_FORMAT(LPO_DATE,'%d/%m/%Y') LPO_DATE,SUP_CODE , AMOUNT, VAT_PERC, VAT_AMOUNT,NARRATION, " +
    "REQ_NO,PLACE_DLV , ATTN ,DATE_REQ ,SMAN_CODE,'' SUPP_REF_NO ,'' PAY_TERMS  ,'' DELIVERY_REQ ," +
    "'' LPO_APPROVED, '' APPROVED_BY  ,DISCOUNT  " +
    " FROM lpo_net WHERE LPO_NO =?",
    [req.params.po],

    function (error, results, fields) {
      if (error) throw error;
      res.json(results);
      //console.log(results);
    }
  );
});

app.put("/lpoitemsput/:id", function (req, res, next) {
  let lpoitem = req.body;
  // console.log("xxx y", lpoitem);

  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    //console.log("LPO Items Update on Server *1 " + lpoitem.LPO_NO+" - " +lpoitem[0].SR_NO+ " * 1st ");
    conn.execute(
      "UPDATE LPO_ITEMS SET  ITEM_CODE=:1 ," +
      " ITEM_NAME =:2, QTY = :3, RATE =:4 " +
      " where LPO_NO =:5 AND SR_NO = :6",
      [
        lpoitem[0].ITEM_CODE,
        lpoitem[0].ITEM_NAME,
        lpoitem[0].QTY,
        lpoitem[0].RATE,
        lpoitem[0].LPO_NO,
        lpoitem[0].SR_NO,
      ],
      {
        outFormat: orcl1.OBJECT,
        autoCommit: true,
      },
      function (error, results) {
        if (error) throw error;
        res.end(JSON.stringify(results.row));
        conn.close();
      }
    );
  });
});
app.put("/lpohdrput/:id", function (req, res, next) {
  let lpoitem = req.body;
  console.log("LPO No -Put- Update", lpoitem);

  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    //console.log("LPO Items Update on Server *1 " + lpoitem[0].LPO_NO+" - " +lpoitem[0].SR_NO+ " * 1st ");
    conn.execute(
      "UPDATE LPO_NET SET   SUP_CODE =:1, NARRATION =:2," +
      " AMOUNT =:3, DISCOUNT = :4,  PLACE_DLV = :5, ATTN=:6 " +
      " where LPO_NO =:7 ",
      [
        lpoitem.SupCd,
        lpoitem.Narration,
        lpoitem.netAmt,
        lpoitem.discount,
        lpoitem.placedlv,
        lpoitem.Attn,
        lpoitem.LpoNo,
      ],
      {
        outFormat: orcl1.OBJECT,
        autoCommit: true,
      },
      function (error, results) {
        if (error) throw error;
        console.log("Rows updated (LpoNet)" + results.rowsAffected);
        res.end(JSON.stringify(results.row));
        conn.close();
      }
    );
  });
});
app.put("/rvtranacc/:dat", function (req, res, next) {
  let rcpitem = req.body;
  // console.log("rvtranacc- start - 1", rcpitem);

  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    //console.log("LPO Items Update on Server *1 " + lpoitem.LPO_NO+" - " +lpoitem[0].SR_NO+ " * 1st ");
    let amt;
    let Dbcr;

    for (let i = 0; i < rcpitem.length; i++) {
      // console.log("ROWID=", putData[0].ROWID, putData[0].ROWID == null);

      amt = 0;
      if (putData[0].DEBIT_AMT > 0) {
        amt = putData[0].DEBIT_AMT;
        Dbcr = "D";
      } else if (putData[0].CREDIT_AMT > 0) {
        amt = putData[0].CREDIT_AMT;
        Dbcr = "C";
      }
      // console.log('Amt,Dt', amt, putData[0].DATTE);
      if (putData[0].ROWID !== null) {
        //  console.log("Update ");
        conn.execute(
          "UPDATE TRAN_ACC SET  SR_NO=:1 ," +
          " ACC_CODE =:2, NARRATION1 = :3, JOB_NO =:4 , AMOUNT =:5, DB_CR =:6,DATTE =TO_DATE(:7,'DD-MM-YYYY') " +
          " WHERE  ROWID=:8 ",
          [
            putData[0].SR_NO,
            putData[0].ACC_CODE,
            putData[0].NARRATION1,
            putData[0].JOB_NO,
            amt,
            Dbcr,
            putData[0].DATTE,
            putData[0].ROWID,
          ],
          {
            outFormat: orcl1.OBJECT,
            autoCommit: true,
          },
          function (err, results) {
            if (err) {
              //     console.error("RV Tranacc Updated ", err.message);
              //callback(err.message)
            } else {
              //   console.log("Rows updated (Rv/Tranacc)" + results.rowsAffected);
              res.end(JSON.stringify(results));
              conn.close();
            }
          }
        );
      } else {
        // console.log("Insert ", amt);
        if (amt !== 0) {
          conn.execute(
            "INSERT INTO  tran_acc (  TRAN_TYPE, VCHR_NO, DATTE,SR_NO , " +
            " ACC_CODE , NARRATION1 , JOB_NO  , AMOUNT , DB_CR )" +
            " VALUES (:1,:2,TO_DATE(:3,'DD-MM-YYYY'),:4,:5,:6,:7,:8,:9 ) ",
            [
              putData[0].TRAN_TYPE,
              putData[0].VCHR_NO,
              putData[0].DATTE,
              putData[0].SR_NO,
              putData[0].ACC_CODE,
              putData[0].NARRATION1,
              putData[0].JOB_NO,
              amt,
              Dbcr,
            ],
            {
              outFormat: orcl1.OBJECT,
              autoCommit: true,
            },
            function (err, results) {
              if (err) {
                console.error("RV Tranacc insert ", err.message);
                //callback(err.message)
              } else {
                //   console.log("Rows inserted (Rv/Tranacc)" + results.rowsAffected);
                res.end(JSON.stringify(results));
                conn.close();
              }
              // conn.close();
            }
          );
        }
      }
    }
  });
});
app.delete("/rvdelrow", function (req, res, next) {
  var postData = req.body.dat;
  //console.log('Delete  req', req.body.dat);
  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    conn.execute(
      "select rowid, TRAN_TYPE,VCHR_NO , AMOUNT, ACC_CODE, DB_CR" +
      " FROM tran_acc WHERE TRAN_TYPE =:tp AND VCHR_NO =:vch",
      [postData[0].TRAN_TYPE, postData[0].VCHR_NO],
      {
        outFormat: orcl1.OBJECT,
      },
      function (error, results, fields) {
        if (error) throw error;
        res.end(JSON.stringify(results.rows));
        // console.log('Delete Select', results.rows);
        for (let i = 0; i < results.rows.length; i++) {
          let RowInGrid = false;
          for (let y = 0; y < postData.length; y++) {
            //   console.log('check', y, postData[y].AMOUNT, postData[y].ROWID);
            if (!(postData[y].ROWID == "null")) {
              if (results.rows[i].ROWID.includes(postData[y].ROWID)) {
                RowInGrid = true;
              }
            }
          }
          if (!RowInGrid && !(results.rows[i].ROWID == "null")) {
            //   console.log('You can Delete :', results.rows[i])
            conn.execute(
              "DELETE FROM tran_acc " + "  WHERE  ROWID =:rwid",
              [results.rows[i].ROWID],
              {
                autoCommit: true,
              },
              function (err, delresult) {
                if (err) {
                  console.log("error delete", err);
                }
                // res.json({message:'row deleted'});
                console.log("Deleted entry", results.rows);
              }
            );
          }
        }
        //conn.close();
      }
    );
  });
});
app.put("/rvinvstl/:dat", function (req, res, next) {
  let rcpitem = req.body;
  //console.log("rvinvstl- start - 1", rcpitem);

  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    //console.log("LPO Items Update on Server *1 " + lpoitem.LPO_NO+" - " +lpoitem[0].SR_NO+ " * 1st ");
    let amt;
    let Dbcr;

    for (let i = 0; i < rcpitem.length; i++) {
      // console.log("ROWID=", putData[0].ROWID, putData[0].ROWID == null);

      amt = 0;
      if (putData[0].DEBIT_AMT > 0) {
        amt = putData[0].DEBIT_AMT;
        Dbcr = "D";
      } else if (putData[0].CREDIT_AMT > 0) {
        amt = putData[0].CREDIT_AMT;
        Dbcr = "C";
      }
      //  console.log('Amt,Dt', amt, putData[0].DATTE);
      if (putData[0].ROWID !== null) {
        //   console.log("Update ");
        conn.execute(
          "UPDATE ADJ_DTL SET  SR_NO=:1 ," +
          " ACC_CODE =:2, NARRATION1 = :3, JOB_NO =:4 , AMOUNT =:5, DB_CR =:6,DATTE =TO_DATE(:7,'DD-MM-YYYY') " +
          " WHERE  ROWID=:8 ",
          [
            putData[0].SR_NO,
            putData[0].ACC_CODE,
            putData[0].NARRATION1,
            putData[0].JOB_NO,
            amt,
            Dbcr,
            putData[0].DATTE,
            putData[0].ROWID,
          ],
          {
            outFormat: orcl1.OBJECT,
            autoCommit: true,
          },
          function (err, results) {
            if (err) {
              console.error("RV Tranacc Updated ", err.message);
              //callback(err.message)
            } else {
              console.log("Rows updated (Rv/Tranacc)" + results.rowsAffected);
              res.end(JSON.stringify(results));
              conn.close();
            }
          }
        );
      } else {
        //  console.log("Insert ", amt);
        if (amt !== 0) {
          conn.execute(
            "INSERT INTO  tran_acc (  TRAN_TYPE, VCHR_NO, DATTE,SR_NO , " +
            " ACC_CODE , NARRATION1 , JOB_NO  , AMOUNT , DB_CR )" +
            " VALUES (:1,:2,TO_DATE(:3,'DD-MM-YYYY'),:4,:5,:6,:7,:8,:9 ) ",
            [
              putData[0].TRAN_TYPE,
              putData[0].VCHR_NO,
              putData[0].DATTE,
              putData[0].SR_NO,
              putData[0].ACC_CODE,
              putData[0].NARRATION1,
              putData[0].JOB_NO,
              amt,
              Dbcr,
            ],
            {
              outFormat: orcl1.OBJECT,
              autoCommit: true,
            },
            function (err, results) {
              if (err) {
                console.error("RV Tranacc insert ", err.message);
                //callback(err.message)
              } else {
                console.log(
                  "Rows inserted (Rv/Tranacc)" + results.rowsAffected
                );
                res.end(JSON.stringify(results));
                conn.close();
              }
              // conn.close();
            }
          );
        }
      }
    }
  });
});
///
app.put("/sivhdrupd/:hdr", function (req, res, next) {
  let sivhdr = req.body;
  var pool = orcl1.getPool();
  // console.log("Siv HDR ", sivhdr);
  // console.log("Siv HDR SIV No:", sivhdr.vchrno);
  //Hdr
  pool.getConnection(function (err, conn) {
    //  for (let i = 0; i < sivitem.length; i++) {
    // console.log("ROWID=", sivitem[i].ROWID, sivitem[i].ROWID == null);

    if (sivhdr.ROWID !== null) {
      //  console.log("Update ");
      conn.execute(
        "UPDATE SIV_HDR SET  SIV_DATE =TO_DATE(:1,'DD-MM-YYYY'), " +
        " JOB_NO =:2,PANEL_NO =:3, NARRATION= :4  " +
        " WHERE  ROWID=:5 ",
        [
          sivhdr.vchrdate,
          sivhdr.jobno,
          sivhdr.panelno,
          sivhdr.narr,
          sivhdr.ROWID,
        ],
        {
          outFormat: orcl1.OBJECT,
          autoCommit: true,
        },
        function (err, results) {
          if (err) {
            console.error("Siv Hdr Updated ", err.message);
            //callback(err.message)
          } else {
            console.log("Rows updated (SivItems)" + results.rowsAffected);
            res.end(JSON.stringify(results));
            conn.close();
          }
        }
      );
    } else {
      // console.log("Insert Sivhdr");
      if (sivhdr.vchrno !== 0) {
        conn.execute(
          "INSERT INTO  siv_hdr (  SIV_NO, SIV_DATE,  " +
          " JOB_NO  , PANEL_NO , NARRATION )" +
          " VALUES (LPAD(:1,10,'0'),TO_DATE(:2,'DD-MM-YYYY'),:3,:4,:5 ) ",
          [
            sivhdr.vchrno,
            sivhdr.vchrdate,
            sivhdr.jobno,
            sivhdr.panelno,
            sivhdr.narr,
          ],
          {
            outFormat: orcl1.OBJECT,
            autoCommit: true,
          },
          function (err, results) {
            if (err) {
              console.error("Siv hdr insert ", err.message);
              //callback(err.message)
            } else {
              console.log("Rows inserted (Sivhdr)" + results.rowsAffected);
              res.end(JSON.stringify(results));
              conn.close();
            }
            // conn.close();
          }
        );
      }
    }
    //   }
  });
});

//
app.post("/invitmupd/:id", function (req, res, next) {
  let bank1 = req.body;
  console.log("SAlES Inv Item.Edit");

  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    // console.log("Tran type Update on Server *1 " + req.params.id + " * 1st ");
    conn.execute(
      "UPDATE INVOICE  SET INV_RATE=:1 " + " where INV_NO=:2  AND SR_NO =:3",
      [bank1.inv_rate, bank1.INV_NO, bank1.SR_NO],
      {
        outFormat: orcl1.OBJECT,
        autoCommit: true,
      },
      function (error, results) {
        if (error) throw error;
        res.end(JSON.stringify(results));
        conn.close();
      }
    );
  });
});

app.put("/updateInvoice", (req, res) => {
  const updatedRows = req.body;
  console.log("Entered  updateInvoice");
  console.log(req.body);
  console.log("---------------");
  if (!updatedRows) {
    console.log("UpdatedRows null");
    return res.status(400).json({ message: "Missing data in request body" });
  }
  updatedRows.forEach((updatedRow) => {
    const index = data.findIndex((row) => row.id === updatedRow.id);
    conolse.log("data.Index=", index);
    if (index !== -1) {
      data[index] = { ...data[index], ...updatedRow };
    }
  });

  res.json({ message: "Data updated successfully" });
});
app.put("/sivitmupd/:dat", function (req, res, next) {
  let sivitem = req.body;
  var pool = orcl1.getPool();
  // console.log("Siv Upd array length =", sivitem.length);
  // console.log("Siv gUpd req.body =", req.body);
  //Hdr
  pool.getConnection(function (err, conn) {
    for (let i = 0; i < sivitem.length; i++) {
      // console.log("ROWID=", sivitem[i].ROWID, sivitem[i].ROWID  == null);
      //   console.log('ItemCode,  ROWID=', sivitem[i].ROWID);
      if (sivitem[i].ROWID !== "null") {
        console.log("Update ROWID= ", sivitem[i].ROWID);
        conn.execute(
          "UPDATE SIV_ITEMS SET  SIV_DATE =TO_DATE(:1,'DD-MM-YYYY'), SR_NO=:2 ," +
          " JOB_NO =:3,ITEM_CODE =:4, QTY= :5  " +
          " WHERE  ROWID=:6 ",
          [
            sivitem[i].SIV_DATE,
            sivitem[i].SR_NO,
            sivitem[i].JOB_NO,
            sivitem[i].ITEM_CODE,
            sivitem[i].QTY,
            sivitem[i].ROWID,
          ],
          {
            outFormat: orcl1.OBJECT,
            autoCommit: true,
          },
          function (err, results) {
            if (err) {
              console.error("Siv Item Updated ", err.message);
              //callback(err.message)
            } else {
              console.log("Rows updated (SivItems)" + results.rowsAffected);
              res.end(JSON.stringify(results));
              conn.close();
            }
          }
        );
      } else {
        // console.log("Insert SivItems", sivitem[i].ITEM_CODE);
        if (sivitem[i].QTY !== 0 && sivitem[i].ITEM_CODE !== null) {
          conn.execute(
            "INSERT INTO  siv_items (  SIV_NO, SIV_DATE, SR_NO , " +
            " JOB_NO  , ITEM_CODE ,QTY )" +
            " VALUES (LPAD(:1,10,'0'),TO_DATE(:2,'DD-MM-YYYY'),:3,:4,:5,:6 ) ",
            [
              sivitem[i].SIV_NO,
              sivitem[i].SIV_DATE,
              sivitem[i].SR_NO,
              sivitem[i].JOB_NO,
              sivitem[i].ITEM_CODE,
              sivitem[i].QTY,
            ],
            {
              outFormat: orcl1.OBJECT,
              autoCommit: true,
            },
            function (err, results) {
              if (err) {
                console.error("Siv Items insert error:", err.message);
                //callback(err.message)
              } else {
                console.log("Rows inserted (Sivitems)" + results.rowsAffected);
                res.end(JSON.stringify(results));
                conn.close();
              }
              // conn.close();
            }
          );
        }
      }
    }
  });
});
// NgpNGP
app.put("/ngphdrupd/:hdr", function (req, res, next) {
  let sivhdr = req.body;
  var pool = orcl1.getPool();
  // console.log("NGP HDR Write ", sivhdr);
  // console.log("NGP HDR SRV No:", sivhdr.vchrno);
  // console.log("NGP HDR ROWID:", sivhdr.ROWID);
  // console.log("NGP Date:", sivhdr.vchrdate);
  //Hdr
  pool.getConnection(function (err, conn) {
    //  for (let i = 0; i < sivitem.length; i++) {
    // console.log("ROWID=", sivitem[i].ROWID, sivitem[i].ROWID == null);

    if (sivhdr.ROWID !== null) {
      // console.log("Update NGPNET start ");
      conn.execute(
        "UPDATE NGP_NET SET  PRCH_DATE =to_date(Substr(:1,1,10),'YYYY-MM-DD'), " +
        "  NARRATION= :2 , SUP_CODE =:3,INV_NO =:4, INV_DATE=to_date(substr(:5,1,10),'YYYY-MM-DD') " +
        " WHERE  ROWID=:6 ",
        [
          sivhdr.prch_date,
          sivhdr.narration,
          sivhdr.sup_code,
          sivhdr.inv_no,
          sivhdr.inv_date,
          sivhdr.ROWID,
        ],
        {
          outFormat: orcl1.OBJECT,
          autoCommit: true,
        },

        function (err, results) {
          if (err) {
            console.error("Ngpnet Updated ", err.message);
            //callback(err.message)
          } else {
            console.log("Rows updated (NgpNet)" + results.rowsAffected);
            res.end(JSON.stringify(results));
            conn.close();
          }
        }
      );
    } else {
      // console.log("Insert NGPNet");
      if (sivhdr.vchrno !== 0) {
        conn.execute(
          "INSERT INTO  ngp_net  (  PRCH_NO, PRCH_DATE,  " +
          " NARRATION, SUP_CODE,INV_NO, INV_DATE,LPO_NO )" +
          " VALUES (LPAD(:1,10,'0'),TO_DATE(substr(:2,1,10),'DD-MM-YYYY'),:3 ,:4,:5,TO_DATE(substr(:6,1,10),'DD-MM-YYYY'),:7 ) ",
          [
            sivhdr.prch_no,
            sivhdr.prch_date,
            sivhdr.narration,
            sivhdr.sup_code,
            sivhdr.inv_no,
            sivhdr.inv_date,
            siv_hdr.lpo_no,
          ],
          {
            outFormat: orcl1.OBJECT,
            autoCommit: true,
          },
          function (err, results) {
            if (err) {
              console.error("Ngp Net insert ", err.message);
              //callback(err.message)
            } else {
              console.log("Rows inserted (Ngpnet)" + results.rowsAffected);
              res.end(JSON.stringify(results));
              conn.close();
            }
            // conn.close();
          }
        );
      }
    }
    //   }
  });
});

//
//SRV - Start
// app.put('/sivhdrupd/:hdr', function (req, res, next) {
app.put("/srvhdrupd/:hdr", function (req, res, next) {
  let sivhdr = req.body;
  var pool = orcl1.getPool();

  //Hdr
  pool.getConnection(function (err, conn) {
    //  for (let i = 0; i < sivitem.length; i++) {
    // console.log("ROWID=", sivitem[i].ROWID, sivitem[i].ROWID == null);

    if (sivhdr.ROWID !== null) {
      //console.log("Update SRVHDR start ");
      conn.execute(
        "UPDATE SRV_HDR SET  SRV_DATE =to_date(:1,'YYYY-MM-DD'), " +
        "  NARRATION= :2  " +
        " WHERE  ROWID=:3 ",
        [sivhdr.vchrdate, sivhdr.narr, sivhdr.ROWID],
        {
          outFormat: orcl1.OBJECT,
          autoCommit: true,
        },

        function (err, results) {
          if (err) {
            console.error("Srv Hdr Updated ", err.message);
            //callback(err.message)
          } else {
            console.log("Rows updated (SrvHdr)" + results.rowsAffected);
            res.end(JSON.stringify(results));
            conn.close();
          }
        }
      );
    } else {
      //  console.log("Insert SRvhdr");
      if (sivhdr.vchrno !== 0) {
        conn.execute(
          "INSERT INTO  srv_hdr (  SRV_NO, SRV_DATE,  " +
          " NARRATION )" +
          " VALUES (LPAD(:1,10,'0'),TO_DATE(:2,'DD-MM-YYYY'),:3 ) ",
          [sivhdr.vchrno, sivhdr.vchrdate, sivhdr.narr],
          {
            outFormat: orcl1.OBJECT,
            autoCommit: true,
          },
          function (err, results) {
            if (err) {
              console.error("Siv hdr insert ", err.message);
              //callback(err.message)
            } else {
              console.log("Rows inserted (Sivhdr)" + results.rowsAffected);
              res.end(JSON.stringify(results));
              conn.close();
            }
            // conn.close();
          }
        );
      }
    }
    //   }
  });
});

//
app.put("/srvitmupd/:dat", function (req, res, next) {
  let sivitem = req.body;
  var pool = orcl1.getPool();
  // console.log("Siv Upd array length =", sivitem.length);
  // console.log("Siv gUpd req.body =", req.body);
  //Hdr
  pool.getConnection(function (err, conn) {
    for (let i = 0; i < sivitem.length; i++) {
      // console.log("ROWID=", sivitem[i].ROWID, sivitem[i].ROWID  == null);
      //   console.log('ItemCode,  ROWID=', sivitem[i].ROWID);
      if (sivitem[i].ROWID !== "null") {
        console.log("Update ROWID= ", sivitem[i].ROWID);
        conn.execute(
          "UPDATE SIV_ITEMS SET  SIV_DATE =TO_DATE(:1,'DD-MM-YYYY'), SR_NO=:2 ," +
          " JOB_NO =:3,ITEM_CODE =:4, QTY= :5  " +
          " WHERE  ROWID=:6 ",
          [
            sivitem[i].SIV_DATE,
            sivitem[i].SR_NO,
            sivitem[i].JOB_NO,
            sivitem[i].ITEM_CODE,
            sivitem[i].QTY,
            sivitem[i].ROWID,
          ],
          {
            outFormat: orcl1.OBJECT,
            autoCommit: true,
          },
          function (err, results) {
            if (err) {
              console.error("Siv Item Updated ", err.message);
              //callback(err.message)
            } else {
              console.log("Rows updated (SivItems)" + results.rowsAffected);
              res.end(JSON.stringify(results));
              conn.close();
            }
          }
        );
      } else {
        console.log("Insert SivItems", sivitem[i].ITEM_CODE);
        if (sivitem[i].QTY !== 0 && sivitem[i].ITEM_CODE !== null) {
          conn.execute(
            "INSERT INTO  siv_items (  SIV_NO, SIV_DATE, SR_NO , " +
            " JOB_NO  , ITEM_CODE ,QTY )" +
            " VALUES (LPAD(:1,10,'0'),TO_DATE(:2,'DD-MM-YYYY'),:3,:4,:5,:6 ) ",
            [
              sivitem[i].SIV_NO,
              sivitem[i].SIV_DATE,
              sivitem[i].SR_NO,
              sivitem[i].JOB_NO,
              sivitem[i].ITEM_CODE,
              sivitem[i].QTY,
            ],
            {
              outFormat: orcl1.OBJECT,
              autoCommit: true,
            },
            function (err, results) {
              if (err) {
                console.error("Siv Items insert error:", err.message);
                //callback(err.message)
              } else {
                console.log("Rows inserted (Sivitems)" + results.rowsAffected);
                res.end(JSON.stringify(results));
                conn.close();
              }
              // conn.close();
            }
          );
        }
      }
    }
  });
});
app.put("/ngptranupd/:dat", function (req, res, next) {
  let sivitem = req.body;
  var pool = orcl1.getPool();
  //console.log("Ngp tranacc array length =", sivitem.length);
  //console.log("Ngp tranacc Upd req.body =", req.body);
  //Hdr
  pool.getConnection(function (err, conn) {
    for (let i = 0; i < sivitem.length; i++) {
      // console.log("ROWID=", sivitem[i].ROWID, sivitem[i].ROWID  == null);
      //    console.log('Tranacc,  ROWID=', sivitem[i].ROWID);
      if (sivitem[i].ROWID !== "null") {
        //   console.log("Update ROWID= ", sivitem[i].ROWID);
        conn.execute(
          "UPDATE TRAN_ACC SET  DATTE =TO_DATE(Substr(:1,1,10),'DD-MM-YYYY'), SR_NO=:2 ," +
          " JOB_NO =:3,ACC_CODE =:4, AMOUNT= :5  ,NARRATION1 =:6, DB_CR='D'" +
          " WHERE  ROWID=:7 ",
          [
            sivitem[i].DATTE,
            sivitem[i].SR_NO,
            sivitem[i].JOB_NO,
            sivitem[i].ACC_CODE,
            sivitem[i].AMOUNT,
            sivitem[i].NARRATION,
            sivitem[i].ROWID,
          ],
          {
            outFormat: orcl1.OBJECT,
            autoCommit: true,
          },
          function (err, results) {
            if (err) {
              console.error("Ngp Tranacc Updated ", err.message);
              //callback(err.message)
            } else {
              console.log("Rows updated (Tranacc Ngp)" + results.rowsAffected);
              res.end(JSON.stringify(results));
              conn.close();
            }
          }
        );
      } else {
        //  console.log("Insert Tranacc", sivitem[i].ACC_CODE);
        if (sivitem[i].AMOUNT !== 0 && sivitem[i].ACC_CODE !== null) {
          conn.execute(
            "INSERT INTO  tran_acc (  VCHR_NO, DATTE, SR_NO , " +
            " JOB_NO  , ACC_CODE ,AMOUNT,DB_CR,NARRATION1 )" +
            " VALUES (LPAD(:1,10,'0'),TO_DATE(SUBSTR(:2,1,10),'DD-MM-YYYY'),:3,:4,:5,:6 ) ",
            [
              sivitem[i].PRCH_NO,
              sivitem[i].PRCH_DATE,
              sivitem[i].SR_NO,
              sivitem[i].JOB_NO,
              sivitem[i].ACC_CODE,
              sivitem[i].AMOUNT,
              "D",
              sivitem[0].NARRATION,
            ],
            {
              outFormat: orcl1.OBJECT,
              autoCommit: true,
            },
            function (err, results) {
              if (err) {
                console.error("Tran acc:", err.message);
                //callback(err.message)
              } else {
                console.log("Rows inserted (Sivitems)" + results.rowsAffected);
                res.end(JSON.stringify(results));
                conn.close();
              }
              // conn.close();
            }
          );
        }
      }
    }
  });
});
//SRV - End
//Details
//STK ADJ HDR Update
app.put("/sadjhdrupd/:hdr", function (req, res, next) {
  let sivhdr = req.body;
  var pool = orcl1.getPool();
  //Hdr
  pool.getConnection(function (err, conn) {
    //  for (let i = 0; i < sivitem.length; i++) {
    // console.log("ROWID=", sivitem[i].ROWID, sivitem[i].ROWID == null);

    if (sivhdr.ROWID !== null) {
      // console.log("Update STK_HDR start ");
      conn.execute(
        "UPDATE STK_HDR SET  VCHR_DATE =to_date(:1,'DD/MM/RRRR'), " +
        "  NARRATION= :2  " +
        " WHERE  ROWID=:3 ",
        [sivhdr.vchrdate, sivhdr.narr, sivhdr.ROWID],
        {
          outFormat: orcl1.OBJECT,
          autoCommit: true,
        },

        function (err, results) {
          if (err) {
            console.error("Sadj Hdr Updated ", err.message);
            //callback(err.message)
          } else {
            console.log("Rows updated (SrvHdr)" + results.rowsAffected);
            res.end(JSON.stringify(results));
            conn.close();
          }
        }
      );
    } else {
      // console.log("Insert Sadjhdr");
      if (sivhdr.vchrno !== 0) {
        conn.execute(
          "INSERT INTO  stk_hdr (  VCHR_NO, VCHR_DATE,  " +
          " NARRATION )" +
          " VALUES (LPAD(:1,10,'0'),TO_DATE(:2,'DD-MM-YYYY'),:3 ) ",
          [sivhdr.vchrno, sivhdr.vchrdate, sivhdr.narr],
          {
            outFormat: orcl1.OBJECT,
            autoCommit: true,
          },
          function (err, results) {
            if (err) {
              console.error("Sadj hdr insert ", err.message);
              //callback(err.message)
            } else {
              console.log("Rows inserted (Sadjhdr)" + results.rowsAffected);
              res.end(JSON.stringify(results));
              conn.close();
            }
            // conn.close();
          }
        );
      }
    }
    //   }
  });
});
app.put("/sadjitmupd/:dat", function (req, res, next) {
  let sivitem = req.body;
  var pool = orcl1.getPool();
  //console.log("Sadj Upd array length =", sivitem.length);
  //console.log("Sadj Upd req.body =", req.body);
  //Hdr
  pool.getConnection(function (err, conn) {
    for (let i = 0; i < sivitem.length; i++) {
      // console.log("ROWID=", sivitem[i].ROWID, sivitem[i].ROWID  == null);
      // console.log('ItemCode,  ROWID=', sivitem[i].ROWID);
      if (sivitem[i].ROWID !== "null") {
        console.log("Update ROWID= ", sivitem[i].ROWID);
        conn.execute(
          "UPDATE STK_ADJ SET  VCHR_DATE =TO_DATE(SUBSTR(:1,1,10),'MM/DD/YYYY'), SR_NO=:2 ," +
          " NARRATION =:3,ITEM_CODE =:4, QTY= :5  ,STD_COST = :6" +
          " WHERE  ROWID=:7 ",
          [
            sivitem[i].VCHR_DATE,
            sivitem[i].SR_NO,
            sivitem[i].NARRATION,
            sivitem[i].ITEM_CODE,
            sivitem[i].QTY,
            sivitem[i].STD_COST,
            sivitem[i].ROWID,
          ],
          {
            outFormat: orcl1.OBJECT,
            autoCommit: true,
          },
          function (err, results) {
            if (err) {
              console.error("Sadj Item Updated ", err.message);
              //callback(err.message)
            } else {
              console.log("Rows updated (SadjItems)" + results.rowsAffected);
              res.end(JSON.stringify(results));
              conn.close();
            }
          }
        );
      } else {
        //  console.log("Insert SadjItems", sivitem[i].ITEM_CODE);
        if (sivitem[i].QTY !== 0 && sivitem[i].ITEM_CODE !== null) {
          conn.execute(
            "INSERT INTO  stk_adj (  VCHR_NO, VCHR_DATE, SR_NO , " +
            " NARRATION  , ITEM_CODE ,QTY )" +
            " VALUES (LPAD(:1,10,'0'),TO_DATE(:2,'DD-MM-YYYY'),:3,:4,:5,:6 ) ",
            [
              sivitem[i].VCHR_NO,
              sivitem[i].VCHR_DATE,
              sivitem[i].SR_NO,
              sivitem[i].NARRATION,
              sivitem[i].ITEM_CODE,
              sivitem[i].QTY,
            ],
            {
              outFormat: orcl1.OBJECT,
              autoCommit: true,
            },
            function (err, results) {
              if (err) {
                console.error("Sadj Items insert error:", err.message);
                //callback(err.message)
              } else {
                console.log("Rows inserted (Sadjitems)" + results.rowsAffected);
                res.end(JSON.stringify(results));
                conn.close();
              }
              // conn.close();
            }
          );
        }
      }
    }
  });
});

app.get("/jobcard/:jobNo", function (req, res) {
  // console.log("Job list ");

  connection.query(
    "select  JOB_NO, PROJ_NAME, DATE_FORMAT(START_DATE,'d%m%Y') AS START_DATE, LPO_NO, " +
    " DATE_FORMAT(LPO_DATE,'d%m%Y') AS LPO_DATE ,CUST_CODE, MEANS_PAYMENTS, CONTACT_PER,MEANS_TRANSPORT ," +
    " PLACE_OF_DLV , REVENUE_AC,SMAN_CODE,CURR_CODE, CONVERT_RATE FROM job_card  WHERE JOB_NO =?", [req.params.jobNo],

    function (error, result) {
      if (error) {
        throw error;
      } else {
        console.log("Job Card", result);
        res.json(result);

      }
    }
  );
});
app.get("/joblst", function (req, res) {
  // console.log("Job list ");

  connection.query(
    "select  JOB_NO, PROJ_NAME, DATE_FORMAT(START_DATE,'d%m%Y') AS START_DATE, LPO_NO, " +
    " DATE_FORMAT(LPO_DATE,'d%m%Y') AS LPO_DATE ,CUST_CODE, MEANS_PAYMENTS, CONTACT_PR,MEANS_TRANSPORT ," +
    +" PLACE_OF_DEIVERY , SMAN_CODE FROM job_card  ORDER BY JOB_NO DESC", [],

    function (error, result) {
      if (error) {
        throw error;
      } else {
        //   console.log("Oracle  -Aclist", result);
        res.json(result);

      }
    }
  );
});

app.get("/jobstatlst", function (req, res) {
  connection.query(
    "select STAT_CODE, STAT_DESC" + " FROM job_status_mst  ORDER BY STAT_CODE ",
    {},

    function (error, result) {
      if (error) {
        throw error;
      } else {
        //   console.log("Oracle  -Aclist", result);
        res.json(result);

      }
    }
  );
});
app.get("/jobstatmst/:id", function (req, res) {
  connection.query(
    "select STAT_CODE, STAT_DESC  FROM job_status_mst  where STAT_CODE =? ",
    [req.params.id],

    function (error, result) {
      if (error) {
        throw error;
      } else {
        //   console.log("Oracle  -Aclist", result);
        res.json(result);

      }
    }
  );
});
app.post("/api/save-jobstat", (req, res) => {
  const data = req.body; // Receive data from frontend
  console.log("Save-Job_stat_mst");
  if (!data || Object.keys(data).length === 0) {
    return res.status(400).json({ error: "No data provided" });
  }

  // Extract keys and values from the request body
  const columns = Object.keys(data).join(", ");
  const values = Object.values(data);
  const updateClause = Object.keys(data)
    .map((key) => `${key} = VALUES(${key})`)
    .join(", ");

  // MySQL Query with ON DUPLICATE KEY UPDATE
  const query = `INSERT INTO job_status_mst (${columns}) VALUES (${values.map(() => "?").join(", ")}) 
                 ON DUPLICATE KEY UPDATE ${updateClause}`;

  connection.query(query, values, (err, result) => {
    if (err) {
      console.error("Error inserting/updating Job Status Master:", err);
      return res.status(500).json({ error: "Database error" });
    }
    res.json({ message: "Job Status  inserted/updated successfully", result });
  });
})
//SELECT TRAN_TYPE, VCHR_NO, DATTE, CUST_CODE, ACC_CODE, CHEQUE_NO, AMOUNT, NARRATION1, NARRATION2, BANK_NAME, PAID_TO, CASE WHEN CAN_CEL = 'Y' THEN 'Yes' WHEN CAN_CEL = 'N' THEN 'No' ELSE 'Unknown' END AS CAN_CEL, ACC_CODE2, AMOUNT2, JOB_NO, VCHR_TYPE, CUR_CODE, CONV_RATE, AMOUNT_FRGN FROM VOUCHERS;
app.get("/vchrlst/:tranId", function (req, res) {
  if (req.params.tranId !== '05') {
    connection.query(
      "SELECT TRAN_TYPE, VCHR_NO, DATE_FORMAT(DATTE,'%d/%m/%Y') DATTE, CUST_CODE, ACC_CODE, CHEQUE_NO, AMOUNT, NARRATION1, NARRATION2, " +
      " BANK_NAME, PAID_TO, CAN_CEL," +
      " ACC_CODE2, AMOUNT2, JOB_NO,  CUR_CODE, CONV_RATE, AMOUNT_FRGN FROM vouchers WHERE TRAN_TYPE=? order by vchr_no desc",
      [req.params.tranId],

      function (error, result) {
        if (error) {
          throw error;
        } else {
          //   console.log("Oracle  -Aclist", result);
          res.json(result);

        }
      }

    );
  } else {
    connection.query(
      "SELECT TRAN_TYPE, VCHR_NO, DATE_FORMAT(DATTE,'%d/%m/%Y') DATTE, '' as CUST_CODE, " +
      " ACC_CODE, '' AS CHEQUE_NO, AMOUNT, NARRATION1, NARRATION2, " +
      "DB_CR " +
      "  from tran_acc WHERE TRAN_TYPE=? order by vchr_no desc",
      [req.params.tranId],

      function (error, result) {
        if (error) {
          throw error;
        } else {
          //   console.log("Oracle  -Aclist", result);
          res.json(result);

        }
      }

    );

  };
});

app.get('/LedOp/:acode/:stdt', function (req, res) {
  const acCode = req.params.acode;
  const stDt = req.params.stdt;

  console.log('Leddsp O/P Bal ', acCode, stDt);
  connection.query("SELECT " +
    "SUM(CASE WHEN db_cr = 'D' THEN AMOUNT ELSE AMOUNT * -1 END) AS OPBAL " + // ← removed comma
    "FROM tran_acc WHERE ACC_CODE = ? AND DATTE < ?",
    [acCode, stDt],
    function (error, result) {
      if (error) {
        console.log("Ledger O/P bal.data select error", error);
        res.status(500).send("Server error - select st. for ledger OP Bal");
      } else {
        console.log(result);
        res.json(result);
      }
    });
}
);

app.get('/Leddsp/:acode/:stdt/:enddt', function (req, res) {
  const acCode = req.params.acode;
  const stDt = req.params.stdt;
  const endDt = req.params.enddt;
  console.log('Leddsp', acCode, stDt, endDt);
  connection.query("select SR_NO,TRAN_TYPE,VCHR_NO, DATE_FORMAT(DATTE,'%d/%m/%Y') DATTE,JOB_NO, NARRATION1, NARRATION2, " +
    " CASE WHEN db_cr ='D' THEN AMOUNT ELSE 0 END AS AMOUNT_DR ," +
    " CASE WHEN db_cr ='C' THEN AMOUNT ELSE 0 END  AS AMOUNT_CR FROM tran_acc WHERE ACC_CODE = ? AND " +
    " DATTE BETWEEN ? AND ? ORDER BY DATE_FORMAT(DATTE,'%Y/%m/%d'), TRAN_TYPE ,VCHR_NO ", [acCode, stDt, endDt],
    function (error, result) {
      if (error) {
        console.log("Ledger data select error", error);
        res.status(500).send("Server error - select st. for ledger");
      } else {
        //  console.log(result);
        res.json(result);
      }

    }
  );
});
app.get('/Tbal/:dt', function (req, res) {
  console.log('Tbal query =', req.query); // Should log: { RegType: 'TBAL', endDate: '2025-06-13' }

  const endDate = req.params.dt;

  if (!endDate) {
    return res.status(400).send("Missing required parameter: endDate");
  }

  connection.query('CALL GetTbalDetail(?)', [endDate], function (error, result) {
    if (error) {
      console.error(error);
      res.status(500).send("Server Error");
    } else {
      res.json(result[0]); // Only return the result set
    }
  });
});
app.get('/PandL/:dt', function (req, res) {
  console.log('P&L params =', req.params); // Should log: { RegType: 'TBAL', endDate: '2025-06-13' }

  const endDate = req.params.dt;

  if (!endDate) {
    return res.status(400).send("Missing required parameter: endDate");
  }

  connection.query('CALL GetPL(?)', [endDate], function (error, result1) {
    if (error) {
      console.error(error);
      res.status(500).send("Server Error , Error in populating Pl_output table ");
    } else {
      connection.query('Select * from V_pandL order by PlCat,MainSort', function (error, result) {
        if (error) {
          console.error(error);
          res.status(500).send("Server Error V_pandL");
        } else {

          res.json(result); // Only return the result set
        }
      });

    }
  });
});
app.get('/Blsht/:dt', function (req, res) {
  console.log('BLSHT params =', req.params); // Should log: { RegType: 'TBAL', endDate: '2025-06-13' }

  const endDate = req.params.dt;

  if (!endDate) {
    return res.status(400).send("Missing required parameter: endDate");
  }

  connection.query('CALL GetBs(?)', [endDate], function (error, result1) {
    if (error) {
      console.error(error);
      res.status(500).send("Server Error , Error in populating Bl_output table ");
    } else {
      connection.query('Select * from V_balsht order by PlCat,MainSort', function (error, result) {
        if (error) {
          console.error(error);
          res.status(500).send("Server Error V_pandL");
        } else {

          res.json(result); // Only return the result set
        }
      });

    }
  });
});
app.get("/tranlst/:tranId", function (req, res) {
  const { start_date, end_date } = req.query; // <-- ✅ Extract from query string

  console.log('params =', req.params);       // { tranId: 'something' }
  console.log('query  =', req.query);        // { start_date: '2024-01-01', end_date: '2024-01-31' }

  connection.query(
    "SELECT TRAN_TYPE, VCHR_NO, DATE_FORMAT(DATTE,'%d/%m/%Y') AS DATTE, ACC_CODE, AMOUNT," +
    "IF(DB_CR='D', AMOUNT, 0) AS AMOUNT_DR, " +
    "IF(DB_CR='C', AMOUNT, 0) AS AMOUNT_CR, " +
    "DB_CR, NARRATION1, NARRATION2, JOB_NO " +
    "FROM tran_acc WHERE TRAN_TYPE = ? AND DATTE BETWEEN ? AND ? ORDER BY VCHR_NO , db_cr desc",
    [req.params.tranId, start_date, end_date],
    function (error, result) {
      if (error) {
        throw error;
      } else {
        res.json(result);
      }
    }
  );

});

//
app.get("/pcashlst/:id", function (req, res) {
  console.log('Petty cash ');
  connection.query(
    "SELECT VCHR_NO, VCHR_DATE, CHQ_NO, CHQ_DATE, PAY_VCHR_NO, PAY_VCHR_DATE, " +
    "AMOUNT, ACC_CODE_CR, DE_CR, RG_PTYPE, NARRATION FROM pcashexp_hdr  order by vchr_no desc",
    function (error, result) {
      if (error) {
        //  throw error;
        console.error("Error fetching data:", error);
        return res.status(500).json({ message: "Database error", error });
      } else {
        console.log("Pcashexp_hdr ==>", result);
        res.json(result);

      }
    }
  )
});
app.get("/pdcrcdreg", function (req, res) {

  connection.query(
    "select TRAN_TYPE,VCHR_NO,DATE_FORMAT(VCHR_DATE,'%d/%m/%Y') VCHR_DATE, CHQ_NO, " +
    " DATE_FORMAT(CHQ_DATE,'%d/%m/%Y') CHQ_DATE, PDC_CODE, CUST_CODE, " +
    "CHQ_BANK, AMOUNT,  NARRATION " +
    "FROM pdc_rcd  where  chq_date BETWEEN ? AND ? ORDER BY CHQ_DATE",
    [req.query.start_date, req.query.end_date],
    function (err, result) {
      if (err) {
        throw err;
      } else {
        //console.log("Oracle gLmST", result);
        res.json(result);

      }
    }
  );
});
app.get("/pdcrcdlst/:dys", function (req, res) {

  connection.query(
    "select TRAN_TYPE,VCHR_NO,DATE_FORMAT(VCHR_DATE,'%d/%m/%Y') VCHR_DATE, CHQ_NO, " +
    " DATE_FORMAT(CHQ_DATE,'%d/%m/%Y') CHQ_DATE, PDC_CODE, CUST_CODE, " +
    "CHQ_BANK, AMOUNT,  NARRATION " +
    "FROM pdc_rcd  where  chq_date >= CURDATE() - INTERVAL ? DAY ORDER BY CHQ_DATE",
    [req.params.dys],
    function (err, result) {
      if (err) {
        throw err;
      } else {
        //console.log("Oracle gLmST", result);
        res.json(result);

      }
    }
  );
});
app.get("/pdcisulst/:dys", function (req, res) {

  connection.query(
    "select TRAN_TYPE,VCHR_NO,DATE_FORMAT(VCHR_DATE,'%d/%m/%Y') VCHR_DATE, CHQ_NO, " +
    " DATE_FORMAT(CHQ_DATE,'%d/%m/%Y') CHQ_DATE, PDC_CODE, SUP_CODE, " +
    "CHQ_BANK, AMOUNT,  NARRATION " +
    "FROM pdc_isu ORDER BY CHQ_DATE",

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //console.log("Oracle gLmST", result);
        res.json(result);

      }
    }
  );
});



