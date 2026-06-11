///https://www.js-tutorials.com/nodejs-tutorial/node-js-rest-api-add-edit-delete-record-mysql-using-express/

//https://www.youtube.com/watch?v=LmIsbzt-S_E
require('dotenv').config();
const cors = require("cors");
var http = require("http");
var express = require("express");
var app = express();
//old
//var mysql = require("mysql2");  // Import MySQL client
// 👇 new version for async/await queries
//const mysqlPromise = require("mysql2/promise");

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
const dbPort = '3306';
console.log('dbIp===>', process.env.DB_HOST);
//var dbIp = "192.168.1.11";  // MySQL server IP
//var dbIp = "192.168.162.69";  // MySQL server IP
//var dbPort = "3306";         // Default MySQL port
var dbAddr = "http://" + dbIp + ":" + dbPort;
var clientAddr = "http://" + process.env.DB_HOST + ":3000";  // Client address for CORS
//var clientAddr = "http://192.168.1.11:3000";  // Client address for CORS
// MySQL connection details

// Use CORS
app.use(cors());
app.use(function (req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", clientAddr);  // React port
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, PATCH, DELETE");
  //res.setHeader("Access-Control-Allow-Headers", "X-Requested-With,content-type");
  res.setHeader("Access-Control-Allow-Headers", "X-Requested-With,content-type,Authorization");
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

var server = app.listen(3001, '0.0.0.0', function () {
  var host = server.address().address;
  var port = server.address().port;

  console.log("Server listening at http://%s:%s", host, port);
});

const connection = require('./db/connection');
const authMiddleware = require("./middleware/authMiddleware");



// ─── Helper to convert DD/MM/YYYY to YYYY-MM-DD ──────────────────────
const toMySQLDate = (dateStr) => {
  if (!dateStr) return null;
  // If already in YYYY-MM-DD format, return as is
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return dateStr.substring(0, 10);
  // Convert DD/MM/YYYY to YYYY-MM-DD
  const parts = dateStr.split('/');
  if (parts.length === 3) return `${parts[2]}-${parts[1]}-${parts[0]}`;
  return null;
};

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
/* Public API (NO token required) */
app.post("/api/register", async (req, res) => {
  const { username, password, role = "user" } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: "Username and password are required" });
  }

  if (password.length < 6) {
    return res.status(400).json({ message: "Password must be at least 6 characters" });
  }

  try {
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);

    connection.query(
      "INSERT INTO users (username, password_hash, role, is_active) VALUES (?, ?, ?, 1)",
      [username, password_hash, role],
      (err, result) => {
        if (err) {
          // MySQL duplicate entry error
          if (err.code === "ER_DUP_ENTRY") {
            return res.status(409).json({ message: "Username already exists" });
          }
          console.error("DB Error:", err);
          return res.status(500).json({ message: "Database error" });
        }

        res.status(201).json({
          message: "User created successfully",
          userId: result.insertId,
        });
      }
    );
  } catch (err) {
    console.error("Bcrypt error:", err);
    res.status(500).json({ message: "Password hashing failed" });
  }
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
  //const { tableId } = req.params.tableId;
  const query = 'SELECT * FROM grid_option_mst WHERE module_name = ?';

  connection.query(query, [req.params.tableId], (err, rows, fields) => {
    if (err) {
      console.error("Error executing query:", err);
      return res.status(500).json({ error: "Failed to fetch grid_Option_Mst data" });
    }
    console.log('GRID =', rows);
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
app.get('/api/lovmetadata/:rep', (req, res) => {
  console.log("Fetching Lov metatdata", req.params.rep);
  // const { tableId } = req.params.rep;
  const query = 'SELECT * FROM column_metadata_lov WHERE lovHdr = ?';

  connection.query(query, [req.params.rep], (err, rows, fields) => {
    if (err) {
      console.error("Error executing query:", err);
      return res.status(500).json({ error: "Failed to fetch column_metedata_lov" });
    }
    console.log('LOV Column_metatdata ,rep =', rows, req.params.rep);
    res.json(rows);
  });
});

app.post("/api/save-lpo", async (req, res) => {
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
          INSERT INTO lpo_net (LPO_NO, LPO_DATE, SUP_CODE,NARRATION,AMOUNT,ATTN,SMAN_CODE) 
          VALUES (?, ?, ?, ?,?,?,?) 
          ON DUPLICATE KEY UPDATE 
          LPO_DATE= VALUES(LPO_DATE),
          SUP_CODE = VALUES(SUP_CODE),
          NARRATION = VALUES(NARRATION),
          AMOUNT= VALUES(AMOUNT),
          ATTN = VALUES(ATTN),
          SMAN_CODE = VALUES(SMAN_CODE);
        `;

          await new Promise((resolve, reject) => {
            conn.query(
              netQuery,
              [lpoNet.LpoNo, lpoNet.LpoDt, lpoNet.SupCd, lpoNet.Narration,
              lpoNet.Amount, lpoNet.Attn, lpoNet.SmanCd],
              (err, result) => {
                if (err) {
                  return reject(err);
                }
                console.log("LPO_NET Insert/Update:", result);
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


// ─── Add this route to your existing Express app (server.js) ─────────────────
// Place after the authMiddleware require line

// GET /api/job-list
// Returns all records from job_card table, ordered by START_DATE desc
app.get("/api/job-list", (req, res) => {
  const sql = `
SELECT
  a.JOB_NO,
  DATE_FORMAT(a.START_DATE, '%Y-%m-%d')       AS START_DATE,
  a.CUST_CODE, b.CUST_NAME,
  a.LPO_NO,
  DATE_FORMAT(a.LPO_DATE, '%Y-%m-%d')         AS LPO_DATE,
  a.CONTRACT_AMT,
  a.CONTRACT_AMT * (1+a.VAT_PERC/100) AS NET_CONTRACT_AMT,
  a.DESIGNER,
  a.DURATION,
  DATE_FORMAT(a.COMMISSION_DATE, '%Y-%m-%d')  AS COMMISSION_DATE,
  a.PROJ_NAME,
  a.DETAILS,
  a.CANCEL_IND,
  a.DIV_CODE,
  a.CLOSED,
  DATE_FORMAT(a.DATE_OF_APPROVAL, '%Y-%m-%d') AS DATE_OF_APPROVAL,
  a.SMAN_CODE,
  a.REVISION_NO,
  a.QUOT_REF,
  a.PLACE_OF_DLV,
  a.MEANS_TRANSPORT,
  a.MEANS_PAYMENTS,
  a.CONTACT_PER,
  a.CONTACT_NO,
  a.ALLOTTED_MAT_COST,
  a.JOB_APPROVED,
  a.APPROVED_BY,
  a.COMMISSION_AMT,
  a.UNALLOC_EXP,
  DATE_FORMAT(a.CLOSED_DATE, '%Y-%m-%d')      AS CLOSED_DATE,
  a.REV_NO,
  a.CURR_CODE,
  a.FOR_AMOUNT,
  a.CONVERT_RATE,
  a.VAT_PERC,
  a.COMPO_EST_COST,
  a.BUS_BAR_EST_COST,
  a.CONSU_EST_COST,
  a.LABOUR_EST_COST,
  a.CONSULTANT,
  f.InvAmt AS TOT_INV_AMT,
  ((a.CONTRACT_AMT * (1+a.VAT_PERC/100) )- f.InvAmt) as BALANCE_TO_INVOICE
FROM job_card a
LEFT JOIN cus_mst b ON a.CUST_CODE = b.CUST_CODE
LEFT JOIN (
  SELECT job_no, SUM(NET_AMT) AS InvAmt
  FROM fab_inv_hdr
  GROUP BY job_no
) f ON f.job_no = a.JOB_NO
ORDER BY a.START_DATE DESC;
  `;

  connection.query(sql, (err, rows) => {
    if (err) {
      console.error("job-list query error:", err);
      return res.status(500).json({ message: "Database error", error: err.message });
    }
    console.log('job-list', rows);
    res.json(rows);
  });
});
app.post("/api/jobcard-save", async (req, res) => {
  try {
    console.log("jobcard-save ==>", req.body);

    const { jobCard, jobPanel } = req.body;
    console.log("save -1");
    console.log("jobNo:", jobCard.jobNo);  // ADD THIS
    console.log("Full jobCard:", JSON.stringify(jobCard, null, 2));  // ADD THIS

    if (!jobCard || !jobCard.jobNo) {
      return res.status(400).json({ message: "Invalid job card data format" });
    }
    console.log('Save-2');
    console.log("Job Card Data ==>", jobCard);
    console.log('Save-3');
    console.log('Job Card -Panels===>>', jobPanel);
    connection.getConnection((err, conn) => {
      if (err) {
        console.error("Error getting connection:", err);
        return res.status(500).json({ message: "Error getting connection" });
      }

      conn.beginTransaction(async (err) => {
        if (err) {
          console.error("Transaction Error:", err);
          conn.release();
          return res.status(500).json({ message: "Transaction error", error: err });
        }

        try {
          const jobCardQuery = `
            INSERT INTO job_card (
              JOB_NO, START_DATE, CUST_CODE, LPO_NO, LPO_DATE,
              CONTRACT_AMT, DESIGNER, DURATION,
              PROJ_NAME, DATE_OF_APPROVAL, SMAN_CODE,
              REVISION_NO, QUOT_REF, PLACE_OF_DLV,
              MEANS_TRANSPORT, MEANS_PAYMENTS,
              CONTACT_PER, CONTACT_NO,
              ALLOTTED_MAT_COST, JOB_APPROVED, APPROVED_BY,
              COMMISSION_AMT, CURR_CODE, FOR_AMOUNT,
              CONVERT_RATE, VAT_PERC, CONSULTANT
            )
            VALUES (?, ?, ?, ?, ?,  ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?,  ?, ?)
            ON DUPLICATE KEY UPDATE
              START_DATE        = VALUES(START_DATE),
              CUST_CODE         = VALUES(CUST_CODE),
              LPO_NO            = VALUES(LPO_NO),
              LPO_DATE          = VALUES(LPO_DATE),
              CONTRACT_AMT      = VALUES(CONTRACT_AMT),
              DESIGNER          = VALUES(DESIGNER),
              DURATION          = VALUES(DURATION),
              PROJ_NAME         = VALUES(PROJ_NAME),
              DATE_OF_APPROVAL  = VALUES(DATE_OF_APPROVAL),
              SMAN_CODE         = VALUES(SMAN_CODE),
              REVISION_NO       = VALUES(REVISION_NO),
              QUOT_REF          = VALUES(QUOT_REF),
              PLACE_OF_DLV      = VALUES(PLACE_OF_DLV),
              MEANS_TRANSPORT   = VALUES(MEANS_TRANSPORT),
              MEANS_PAYMENTS    = VALUES(MEANS_PAYMENTS),
              CONTACT_PER       = VALUES(CONTACT_PER),
              CONTACT_NO        = VALUES(CONTACT_NO),
              ALLOTTED_MAT_COST = VALUES(ALLOTTED_MAT_COST),
              JOB_APPROVED      = VALUES(JOB_APPROVED),
              APPROVED_BY       = VALUES(APPROVED_BY),
              COMMISSION_AMT    = VALUES(COMMISSION_AMT),
              CURR_CODE         = VALUES(CURR_CODE),
              FOR_AMOUNT        = VALUES(FOR_AMOUNT),
              CONVERT_RATE      = VALUES(CONVERT_RATE),
              VAT_PERC          = VALUES(VAT_PERC),
              CONSULTANT        = VALUES(CONSULTANT);
          `;

          await new Promise((resolve, reject) => {
            conn.query(
              jobCardQuery,
              [
                jobCard.jobNo,
                toMySQLDate(jobCard.startDate),
                jobCard.customerCode || null,
                jobCard.lpoNo || null,
                toMySQLDate(jobCard.lpoDate),
                jobCard.contractAmountGross || null,
                jobCard.engineerDesigner || null,
                jobCard.duration || null,
                jobCard.project || null,
                toMySQLDate(jobCard.dateOfApproval) || null,
                jobCard.sManCode || null,
                jobCard.revisionNo || null,
                jobCard.quotationRef || null,
                jobCard.placeOfDelivery || null,
                jobCard.meansOfTransport || null,
                jobCard.meansOfPayment || null,
                jobCard.contactPerson || null,
                jobCard.contactNo || null,
                jobCard.allottedMatCost || null,
                jobCard.jobApproved || null,
                jobCard.approvedBy || null,
                jobCard.commissionAgreed || null,
                jobCard.currCode || null,
                jobCard.contractAmountGrossDHS || null,
                jobCard.convertRate || null,
                jobCard.vatPercent || null,
                jobCard.consultant || null,
              ],
              (err, result) => {
                if (err) return reject(err);
                console.log("JOB_CARD Insert/Update:", result);
                resolve(result);
              }
            );
          });



          // ✅ Step 2: Insert/Update NGP_ITEMS table
          const itemsQuery = `
              INSERT INTO job_panels (JOB_NO, SR_NO, PANEL_REF, QTY,DRAW_NO,DELIVERY_REQ,REMARKS)
              VALUES ? 
              ON DUPLICATE KEY UPDATE 
              PANEL_REF = COALESCE(VALUES(PANEL_REF), PANEL_REF), 
              QTY = COALESCE(VALUES(QTY), QTY), 
              DRAW_NO      = COALESCE(VALUES(DRAW_NO), DRAW_NO), 
              DELIVERY_REQ      = COALESCE(VALUES(DELIVERY_REQ),DELIVERY_REQ), 
              REMARKS      = COALESCE(VALUES(REMARKS), REMARKS);
            `;
          const values = jobPanel.panels.map(row => [
            jobPanel.jobNo, row.srNo, row.panelRef, row.qty, row.drawNo,
            toMySQLDate(row.deliveryReq), row.remarks
          ]);

          await new Promise((resolve, reject) => {
            conn.query(itemsQuery, [values], (err, result) => {
              if (err) {
                return reject(err);
              }
              console.log("Job Panels Insert/Update:", result);
              resolve(result);
            });
          });

          // ✅ Commit transaction
          conn.commit((err) => {
            if (err) {
              console.error("Commit Error:", err);
              return conn.rollback(() => {
                conn.release();
                res.status(500).json({ message: "Commit error", error: err });
              });
            }
            conn.release();
            console.log("✅ Job Card saved successfully:", jobCard.jobNo);
            res.status(200).json({ message: "Job card saved successfully", jobNo: jobCard.jobNo });
          });

        } catch (queryErr) {
          console.error("Query Error:", queryErr);
          conn.rollback(() => {
            conn.release();
            res.status(500).json({ message: "Query error", error: queryErr });
          });
        }
      });
    });

  } catch (err) {
    console.error("Server Error:", err);
    res.status(500).json({ message: "Server error", error: err });
  }
});

app.post("/api/save-fpo", async (req, res) => {
  try {
    console.log("save-fpo ==>", req.body);
    const { lpoNet, lpoItems } = req.body;
    if (!lpoNet || !lpoItems || !Array.isArray(lpoItems) || lpoItems.length === 0) {
      return res.status(400).json({ message: "Invalid lpo data format" });
    }
    console.log("FPO Net 1 ==>", lpoNet);
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
          INSERT INTO fpo_net (FPO_NO,FPO_DATE, SUP_CODE,YR_REF_NO,PAY_TERMS,FPO_NOTES,SMAN_CODE,AMOUNT) 
          VALUES (?, ?, ?, ?,?,?,?,?) 
          ON DUPLICATE KEY UPDATE 
          FPO_DATE= VALUES(FPO_DATE),
          SUP_CODE = VALUES(SUP_CODE),
          YR_REF_NO = VALUES(YR_REF_NO),
          PAY_TERMS = VALUES(PAY_TERMS),
          FPO_NOTES =  VALUES(FPO_NOTES),
          SMAN_CODE = VALUES(SMAN_CODE),
          AMOUNT = VALUES(AMOUNT);
          `;

          await new Promise((resolve, reject) => {
            conn.query(
              netQuery,
              [lpoNet.FpoNo, lpoNet.FpoDt, lpoNet.SupCd, lpoNet.YourRef, lpoNet.Payterms, lpoNet.FpoNotes, lpoNet.SmanCd, lpoNet.Amount],
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
app.post("/api/save-ngp", async (req, res) => {
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
app.post("/api/save-localpurch", async (req, res) => {
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
            INSERT INTO purchase_hdr (PJV_NO, PJV_DATE, SUP_CODE,NARRATION,
                                      INV_NO, INV_DATE,PO_NO,INV_AMOUNT,DISCOUNT,VAT_AMOUNT) 
            VALUES (?, ?, ?, ?,?,?,?,?,?,?) 
            ON DUPLICATE KEY UPDATE 
            PJV_DATE= VALUES(PJV_DATE),
            SUP_CODE = VALUES(SUP_CODE),
            NARRATION = VALUES(NARRATION),
            INV_NO = VALUES(INV_NO),
            INV_DATE = VALUES(INV_DATE),
            PO_NO = VALUES(PO_NO),
            INV_AMOUNT = VALUES(INV_AMOUNT),
            DISCOUNT = VALUES(DISCOUNT),
            VAT_AMOUNT = VALUES(VAT_AMOUNT);
          `;

          await new Promise((resolve, reject) => {
            conn.query(
              netQuery,
              [netData.PjvNo, netData.PjvDt, netData.SupCd,
              netData.Narration, netData.InvNo, netData.InvDt, netData.LpoNo,
              netData.AMOUNT, netData.discAmt, netData.vatAmt],
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

app.post("/api/save-pret", async (req, res) => {
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

//// Quote saves
app.post("/api/save-qtNotes", async (req, res) => {
  try {
    console.log("save-Quote-Notes ==>", req.body);
    res.json({ message: "Notes saved successfully!" });
  } catch (error) {
    console.error("Transaction Failed:", error);
    conn.rollback(() => {
      conn.release(); // Release the connection back to the pool
      res.status(500).json({ message: "Transaction failed, rolled back", error });
    });
  };
});

app.post("/api/save-qtTechDtl", async (req, res) => {
  try {
    console.log("save-Quote-TechDtl ==>", req.body);
    res.json({ message: "Tech Dtl saved successfully!" });
  } catch (error) {
    console.error("Transaction Failed:", error);
    conn.rollback(() => {
      conn.release(); // Release the connection back to the pool
      res.status(500).json({ message: "Tech Dtl Transaction failed, rolled back", error });
    });
  };
});

app.post("/api/save-qtDoc", async (req, res) => {
  try {
    console.log("save-Quote-Doc-Upload ==>", req.body);
    const lpoItems = req.body;
    if (!Array.isArray(lpoItems) || lpoItems.length === 0) {

      return res.status(400).json({ message: "Invalid Document Upload data format" });
    }

    console.log("Qt Doc.Upload Items ==>", lpoItems);
    connection.getConnection((err, conn) => {
      if (err) {
        console.error("Error getting connection:", err);
        return res.status(500).json({ message: "Error getting connection" });
      }

      conn.beginTransaction(async (err) => {
        try {
          if (err) {
            console.error("Qt.Doc.Transaction Error:", err);
            conn.release(); // Release the connection back to the pool
            return res.status(500).json({ message: "Transaction error", error: err });
          }

          // ✅ Step 2: Insert/Update NGP_ITEMS table
          const itemsQuery = `
              INSERT INTO quot_inq_docs (QUOT_NO, SR_NO, INQ_DOC)
              VALUES ? 
              ON DUPLICATE KEY UPDATE 
              INQ_DOC = COALESCE(VALUES(INQ_DOC), INQ_DOC)
            `;
          const values = lpoItems.map(row => [
            row.QUOT_NO, row.SR_NO, row.INQ_DOC
          ]);

          await new Promise((resolve, reject) => {
            conn.query(itemsQuery, [values], (err, result) => {
              if (err) {
                return reject(err);
              }
              console.log("quot_terms_ITEMS Insert/Update:", result);
              resolve(result);
            });
          });


          conn.commit((err) => {
            if (err) {
              console.error("Commit Error:", err);
              return res.status(500).json({ message: "Commit error", error: err });
            }
            conn.release(); // Release the connection back to the pool
            res.json({ message: "Quot Doc. saved successfully!" });
          });

        } catch (error) {
          console.error("Qout.Doc.Transaction Failed:", error);
          conn.rollback(() => {
            conn.release(); // Release the connection back to the pool
            res.status(500).json({ message: "Transaction failed, rolled back", error });
          });
        };
      });
    });
  } catch (error) {
    console.log("QT Doc  save - internal error :", error)
    res.status(500).json({ message: "Qt.Doc. save Internal Server Error", error });
  }
});

app.post("/api/save-quotation", async (req, res) => {
  try {
    console.log("Save-Quote-items ==>", req.body);
    const { qtHdr, lpoItems } = req.body;
    /* if (!Array.isArray(lpoItems) || lpoItems.length === 0) {
 
       return res.status(400).json({ message: "Invalid Quotation data format" });
     }*/
    console.log("Qt Hdr. ==>", qtHdr);
    console.log("Qt Items. ==>", lpoItems);
    connection.getConnection((err, conn) => {
      if (err) {
        console.error("Error getting connection:", err);
        return res.status(500).json({ message: "Error getting connection" });
      }

      conn.beginTransaction(async (err) => {
        try {
          if (err) {
            console.error("Qt.Save.Transaction Error:", err);
            conn.release(); // Release the connection back to the pool
            return res.status(500).json({ message: "Transaction error", error: err });
          }

          const hdrQuery = `
            INSERT INTO QUOT_HDR 
              (QUOT_NO, CUST_CODE, PAYMENT_TERMS, ENGG_CODE, ATTN, YOUR_REF, SUBJECT, 
                PROJECT_NAME, CURR_CODE, REV_NO, INQ_NO, TEL_NO)
            VALUES (?, ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              CUST_CODE     = VALUES(CUST_CODE),
              PAYMENT_TERMS = VALUES(PAYMENT_TERMS),
              ENGG_CODE      = VALUES(ENGG_CODE),
              ATTN          = VALUES(ATTN),
              YOUR_REF      = VALUES(YOUR_REF),
              SUBJECT       = VALUES(SUBJECT),
              PROJECT_NAME     = VALUES(PROJECT_NAME),
              CURR_CODE     = VALUES(CURR_CODE),
              REV_NO        = VALUES(REV_NO),
              INQ_NO        = VALUES(INQ_NO),
              TEL_NO        = VALUES(TEL_NO)
          `;

          const hdrValues = [
            qtHdr.QtNo, qtHdr.CustCd, qtHdr.PayTrm, qtHdr.EngCd,
            qtHdr.Attn, qtHdr.YourRef, qtHdr.Subject, qtHdr.ProjName,
            qtHdr.CurrCd, qtHdr.RevNo, qtHdr.inqNo, qtHdr.TelNo
          ];

          await new Promise((resolve, reject) => {
            conn.query(hdrQuery, hdrValues, (err, result) => {
              if (err) {
                console.error("HDR Query Error:", err);
                return reject(err);
              }
              console.log("QUOT_HDR Insert/Update:", result);
              resolve(result);
            });
          });


          if (Array.isArray(lpoItems) && lpoItems.length > 0) {
            //
            const itemQuery = `
              INSERT INTO quot_item (QUOT_NO, SR_NO, LOC_CODE, ITEM_CODE, ITEM_NAME, QTY, RATE)
              VALUES ? 
              ON DUPLICATE KEY UPDATE 
                LOC_CODE  = COALESCE(VALUES(LOC_CODE), LOC_CODE),
                ITEM_CODE = VALUES(ITEM_CODE),
                ITEM_NAME = VALUES(ITEM_NAME),
                QTY       = VALUES(QTY),
                RATE      = VALUES(RATE)
            `;
            const values = lpoItems.map(row => [
              qtHdr.QtNo, row.SR_NO, row.LOC_CODE, row.ITEM_CODE, row.ITEM_NAME, row.QTY, row.RATE
            ]);

            await new Promise((resolve, reject) => {
              conn.query(itemQuery, [values], (err, result) => {  // ✅ query string, not lpoItems
                if (err) return reject(err);
                console.log("quot_ITEMS Insert/Update:", result);
                resolve(result);
              });
            });
          };
          //
          conn.commit((err) => {
            if (err) {
              console.error("Commit Error:", err);
              return res.status(500).json({ message: "Commit error", error: err });
            }
            conn.release(); // Release the connection back to the pool
            res.json({ message: "Quot saved successfully!" });
          });


        } catch (error) {
          console.error("Qout.Transaction Failed:", error);
          conn.rollback(() => {
            conn.release(); // Release the connection back to the pool
            res.status(500).json({ message: "Transaction failed, rolled back", error });
          });
        };
      });

    });

  } catch (error) {
    console.log("QT  save - internal error :", error)
    res.status(500).json({ message: "Qt.Doc. save Internal Server Error", error });
  }
});
app.post("/api/save-qtTermsCond", async (req, res) => {
  try {
    // console.log("save-Quote-Terms -cond ==>", req.body);
    const lpoItems = req.body;
    if (!Array.isArray(lpoItems) || lpoItems.length === 0) {

      return res.status(400).json({ message: "Invalid T&C data format" });
    }

    console.log("Qt Terms Items ==>", lpoItems);
    connection.getConnection((err, conn) => {
      if (err) {
        console.error("Error getting connection:", err);
        return res.status(500).json({ message: "Error getting connection" });
      }

      conn.beginTransaction(async (err) => {
        try {
          if (err) {
            console.error("Transaction Error:", err);
            conn.release(); // Release the connection back to the pool
            return res.status(500).json({ message: "Transaction error", error: err });
          }

          // ✅ Step 2: Insert/Update NGP_ITEMS table
          const itemsQuery = `
              INSERT INTO quot_terms_cond (QUOT_NO, SR_NO, TERMS_HDR, TERMS_DETAILS)
              VALUES ? 
              ON DUPLICATE KEY UPDATE 
              TERMS_HDR = COALESCE(VALUES(TERMS_HDR), TERMS_HDR), 
              TERMS_DETAILS = COALESCE(VALUES(TERMS_DETAILS), TERMS_DETAILS)
            
            `;
          const values = lpoItems.map(row => [
            row.QUOT_NO, row.SR_NO, row.TERMS_HDR, row.TERMS_DETAILS

          ]);

          await new Promise((resolve, reject) => {
            conn.query(itemsQuery, [values], (err, result) => {
              if (err) {
                return reject(err);
              }
              //  console.log("quot_terms_ITEMS Insert/Update:", result);
              resolve(result);
            });
          });


          conn.commit((err) => {
            if (err) {
              console.error("Commit Error:", err);
              return res.status(500).json({ message: "Commit error", error: err });
            }
            conn.release(); // Release the connection back to the pool
            res.json({ message: "Ters & Cond. saved successfully!" });
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
    console.log("QT Terms Cond  save - internal error :", error)
    res.status(500).json({ message: "Internal Server Error", error });
  }
});





///Quote Save


app.post("/api/save-fabinv", async (req, res) => {
  try {
    console.log("save-Proj.Invoice ==>", req.body);
    const { fabInvNet, sretItems } = req.body;
    if (!fabInvNet || !sretItems || !Array.isArray(sretItems) || sretItems.length === 0) {
      return res.status(400).json({ message: "Invalid Project Invoice data format" });
    }
    console.log("FABINV_HDR ==>", fabInvNet);
    console.log("FABINV Items ==>", fabInvItems);
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
          const netQuery = `INSERT INTO fab_inv_hdr (
          INV_NO, INV_DATE, CUST_CODE, JOB_NO,
          LPO_NO, LPO_DATE, DO_NO, DO_DATE,
          DISCOUNT, NET_AMT, CASH_CUST_NAME, INV_CANCELLED,
          PROJECT_DETAIL, PAYMENT_TERMS, LUMPSUM, QUOT_NO,
          FINAL_INV, CURR_CODE, CONVERT_RATE, VAT_PERC,
          VAT_AMOUNT, CR_DAYS, RCP_TYPE, BANK_CODE,
          COMMI_AMT, CONTRACT_AMT_PERCENT, INV_ACK, ACK_DATE,
          ACK_USER
      )
      VALUES (
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?
      )
      ON DUPLICATE KEY UPDATE
          INV_DATE = VALUES(INV_DATE),
          CUST_CODE = VALUES(CUST_CODE),
          JOB_NO = VALUES(JOB_NO),
          LPO_NO = VALUES(LPO_NO),
          LPO_DATE = VALUES(LPO_DATE),
          DO_NO = VALUES(DO_NO),
          DO_DATE = VALUES(DO_DATE),
          DISCOUNT = VALUES(DISCOUNT),
          NET_AMT = VALUES(NET_AMT),
          CASH_CUST_NAME = VALUES(CASH_CUST_NAME),
          INV_CANCELLED = VALUES(INV_CANCELLED),
          PROJECT_DETAIL = VALUES(PROJECT_DETAIL),
          PAYMENT_TERMS = VALUES(PAYMENT_TERMS),
          LUMPSUM = VALUES(LUMPSUM),
          QUOT_NO = VALUES(QUOT_NO),
          FINAL_INV = VALUES(FINAL_INV),
          CURR_CODE = VALUES(CURR_CODE),
          CONVERT_RATE = VALUES(CONVERT_RATE),
          VAT_PERC = VALUES(VAT_PERC),
          VAT_AMOUNT = VALUES(VAT_AMOUNT),
          CR_DAYS = VALUES(CR_DAYS),
          RCP_TYPE = VALUES(RCP_TYPE),
          BANK_CODE = VALUES(BANK_CODE),
          COMMI_AMT = VALUES(COMMI_AMT),
          CONTRACT_AMT_PERCENT = VALUES(CONTRACT_AMT_PERCENT),
          INV_ACK = VALUES(INV_ACK),
          ACK_DATE = VALUES(ACK_DATE),
          ACK_USER = VALUES(ACK_USER);`;

          await new Promise((resolve, reject) => {
            conn.query(
              netQuery,
              [
                fabInvNet.InvNo, fabInvNet.InvDate, fabInvNet.CustCode, fabInvNet.JobNo,
                fabInvNet.LpoNo, fabInvNet.LpoDate, fabInvNet.DoNo, fabInvNet.DoDate,
                fabInvNet.Discount, fabInvNet.NetAmt, fabInvNet.CashCustName, fabInvNet.InvCancelled,
                fabInvNet.ProjectDetail, fabInvNet.PaymentTerms, fabInvNet.Lumpsum, fabInvNet.QuotNo,
                fabInvNet.FinalInv, fabInvNet.CurrCode, fabInvNet.ConvertRate, fabInvNet.VatPerc,
                fabInvNet.VatAmount, fabInvNet.CrDays, fabInvNet.RcpType, fabInvNet.BankCode,
                fabInvNet.CommiAmt, fabInvNet.ContractAmtPercent, fabInvNet.InvAck, fabInvNet.AckDate,
                fabInvNet.AckUser
              ],
              (err, result) => {
                if (err) {
                  return reject(err);
                }
                console.log("fab_inv_hdr Insert/Update:", result);
                resolve(result);
              }
            );
          });

          // ✅ Step 2: Insert/Update NGP_ITEMS table
          const itemsQuery = `
              INSERT INTO fab_inv_dtl (INV_NO, SR_NO, PANEL_NO, INV_ITEM_DESC, INV_QTY,INV_UNIT, INV_RATE)
              VALUES ? 
              ON DUPLICATE KEY UPDATE 
              PANEL_NO = COALESCE(VALUES(PANEL_NO), PANEL_NO), 
              INV_ITEM_DESC = COALESCE(VALUES(INV_ITEM_DESC), INV_ITEM_DESC), 
              INV_QTY       = COALESCE(VALUES(INV_QTY), INV_QTY), 
              INV_UNIT      = COALESCE(VALUES(INV_UNIT),INV_UNIT), 
              INV_RATE      = COALESCE(VALUES(INV_RATE), INV_RATE);
            `;
          const values = fabInvItems.map(row => [
            row.INV_NO, row.SR_NO, row.ITEM_CODE, row.INV_ITEM_DESC,
            row.INV_QTY, row.INV_UNIT, row.INV_RATE
          ]);

          await new Promise((resolve, reject) => {
            conn.query(itemsQuery, [values], (err, result) => {
              if (err) {
                return reject(err);
              }
              console.log("fab_inv_dtl Insert/Update:", result);
              resolve(result);
            });
          });


          conn.commit((err) => {
            if (err) {
              console.error("Commit Error:", err);
              return res.status(500).json({ message: "Commit error", error: err });
            }
            conn.release(); // Release the connection back to the pool
            res.json({ message: "Project Invoice saved successfully!" });
          });

        } catch (error) {
          console.error("Proj. Inv. Transaction Failed:", error);
          conn.rollback(() => {
            conn.release(); // Release the connection back to the pool
            res.status(500).json({ message: "Proj Inv. Transaction failed, rolled back", error });
          });
        };
      });
    });
  } catch (error) {
    console.log("Project Inv save - internal error :", error)
    res.status(500).json({ message: "Internal Server Error (Project Invoice)", error });
  }
});



app.post("/api/save-siv", async (req, res) => {
  try {
    console.log("SIV Save ==>", req.body);
    const { netData, itemsData } = req.body;
    if (!netData || !itemsData || !Array.isArray(itemsData) || itemsData.length === 0) {
      return res.status(400).json({ message: "Invalid SRV data format" });
    }
    console.log("SIV_HDR ==>", netData);
    console.log("SIV_ITEMS Items ==>", itemsData);
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
          const netQuery = `INSERT INTO siv_hdr (
          SIV_NO,SIV_DATE,JOB_NO,CUST_CODE,NARRATION)
                            VALUES ( ?, ?, ?, ?,?  )
          ON DUPLICATE KEY UPDATE
          SIV_DATE = VALUES(SIV_DATE),
          JOB_NO = VALUES(JOB_NO),
          CUST_CODE = VALUES(CUST_CODE),
          NARRATION = VALUES(NARRATION)
        `;
          await new Promise((resolve, reject) => {
            conn.query(
              netQuery,
              [
                netData.SivNo, netData.SivDt, netData.JobNo, netData.CustCd,
                netData.Narration
              ],
              (err, result) => {
                if (err) {
                  return reject(err);
                }
                console.log("Siv_hdr Insert/Update:", result);
                resolve(result);
              }
            );
          });

          // ✅ Step 2: Insert/Update NGP_ITEMS table
          const itemsQuery = `
              INSERT INTO siv_items (SIV_NO,SIV_DATE,SR_NO,ITEM_CODE,QTY,STD_COST)
              VALUES ? 
              ON DUPLICATE KEY UPDATE 
              SIV_NO= VALUES(SIV_NO),
              SIV_DATE = COALESCE(VALUES(SIV_DATE), SIV_DATE), 
              SR_NO = COALESCE(VALUES(SR_NO),SR_NO),
              ITEM_CODE = COALESCE(VALUES(ITEM_CODE),ITEM_CODE),
              QTY       = COALESCE(VALUES(QTY), QTY), 
              STD_COST  = COALESCE(VALUES(STD_COST), STD_COST);
            `;
          const values = itemsData.map(row => [
            netData.SivNo, netData.SivDt, row.SR_NO, row.ITEM_CODE,
            row.QTY, row.STD_COST
          ]);

          await new Promise((resolve, reject) => {
            conn.query(itemsQuery, [values], (err, result) => {
              if (err) {
                return reject(err);
              }
              console.log("siv_items Insert/Update:", result);
              resolve(result);
            });
          });


          conn.commit((err) => {
            if (err) {
              console.error("Commit Error:", err);
              return res.status(500).json({ message: "Commit error", error: err });
            }
            conn.release(); // Release the connection back to the pool
            res.json({ message: "S.I.V saved successfully!" });
          });

        } catch (error) {
          console.error("S.I.V Transaction Failed:", error);
          conn.rollback(() => {
            conn.release(); // Release the connection back to the pool
            res.status(500).json({ message: "SIV Transaction failed, rolled back", error });
          });
        };
      });
    });
  } catch (error) {
    console.log("SIV save - internal error :", error)
    res.status(500).json({ message: "Internal Server Error (SRV)", error });
  }
});



app.post("/api/save-srv", async (req, res) => {
  try {
    console.log("SRV Save ==>", req.body);
    const { netData, itemsData } = req.body;
    if (!netData || !itemsData || !Array.isArray(itemsData) || itemsData.length === 0) {
      return res.status(400).json({ message: "Invalid SRV data format" });
    }
    console.log("SRV_HDR ==>", netData);
    console.log("SRV_ITEMS Items ==>", itemsData);
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
          const netQuery = `INSERT INTO srv_hdr (
          SRV_NO,SRV_DATE,PO_NO,SUP_CODE,NARRATION )
                            VALUES ( ?, ?, ?, ?,?  )
          ON DUPLICATE KEY UPDATE
          SRV_DATE = VALUES(SRV_DATE),
          PO_NO = VALUES(PO_NO),
          SUP_CODE = VALUES(SUP_CODE),
          NARRATION = VALUES(NARRATION)
        `;
          await new Promise((resolve, reject) => {
            conn.query(
              netQuery,
              [
                netData.SrvNo, netData.SrvDt, netData.LpoNo, netData.SupCd,
                netData.Narration, netData.netAmt
              ],
              (err, result) => {
                if (err) {
                  return reject(err);
                }
                console.log("Srv_hdr Insert/Update:", result);
                resolve(result);
              }
            );
          });

          // ✅ Step 2: Insert/Update NGP_ITEMS table
          const itemsQuery = `
              INSERT INTO srv_items (SRV_NO,SRV_DATE,SR_NO,ITEM_CODE,QTY,STD_COST)
              VALUES ? 
              ON DUPLICATE KEY UPDATE 
              SRV_NO= VALUES(SRV_NO),
              SRV_DATE = COALESCE(VALUES(SRV_DATE), SRV_DATE), 
              SR_NO = COALESCE(VALUES(SR_NO),SR_NO),
              ITEM_CODE = COALESCE(VALUES(ITEM_CODE),ITEM_CODE),
              QTY       = COALESCE(VALUES(QTY), QTY), 
              STD_COST  = COALESCE(VALUES(STD_COST), STD_COST);
            `;
          const values = itemsData.map(row => [
            row.SRV_NO, row.SRV_DATE, row.SR_NO, row.ITEM_CODE,
            row.QTY, row.RATE
          ]);

          await new Promise((resolve, reject) => {
            conn.query(itemsQuery, [values], (err, result) => {
              if (err) {
                return reject(err);
              }
              console.log("srv_items Insert/Update:", result);
              resolve(result);
            });
          });


          conn.commit((err) => {
            if (err) {
              console.error("Commit Error:", err);
              return res.status(500).json({ message: "Commit error", error: err });
            }
            conn.release(); // Release the connection back to the pool
            res.json({ message: "S.R.V saved successfully!" });
          });

        } catch (error) {
          console.error("S.R.V Transaction Failed:", error);
          conn.rollback(() => {
            conn.release(); // Release the connection back to the pool
            res.status(500).json({ message: "SRV Transaction failed, rolled back", error });
          });
        };
      });
    });
  } catch (error) {
    console.log("SRV save - internal error :", error)
    res.status(500).json({ message: "Internal Server Error (SRV)", error });
  }
});

app.post("/api/save-sret", async (req, res) => {
  try {
    console.log("Sales Return ==>", req.body);
    const { sretNet, sretItems } = req.body;
    if (!sretNet || !sretItems || !Array.isArray(sretItems) || sretItems.length === 0) {
      return res.status(400).json({ message: "Invalid Sales Return data format" });
    }
    console.log("SRET_HDR ==>", sretNet);
    console.log("SRET_ITEMS Items ==>", sretItems);
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
          const netQuery = `INSERT INTO sret_hdr (
          SRET_NO,SRET_DATE,INV_NO,CUST_CODE,
          DR_CODE,NARRATION1,NARRATION2,
          SMAN_CODE,DISCOUNT,AMOUNT
      )
      VALUES (
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?
          
      )
      ON DUPLICATE KEY UPDATE
          SRET_DATE = VALUES(SRET_DATE),
           INV_NO = VALUES(INV_NO),
          CUST_CODE = VALUES(CUST_CODE),
           DR_CODE = VALUES(DR_CODE),
          NARRATION1 = VALUES(NARRATION1),
          NARRATION2 = VALUES(NARRATION2),
          SMAN_CODE = VALUES(SMAN_CODE),
          DISCOUNT = VALUES(DISCOUNT),
          AMOUNT = VALUES(AMOUNT);`;
          await new Promise((resolve, reject) => {
            conn.query(
              netQuery,
              [
                sretNet.SretNo, sretNet.SretDt, sretNet.invNo, sretNet.CustCd,
                sretNet.AccCd, sretNet.Narration1, sretNet.Narration2,
                sretNet.SmanCd, sretNet.Discount, sretNet.TotAmt
              ],
              (err, result) => {
                if (err) {
                  return reject(err);
                }
                console.log("sret_hdr Insert/Update:", result);
                resolve(result);
              }
            );
          });

          // ✅ Step 2: Insert/Update NGP_ITEMS table
          const itemsQuery = `
              INSERT INTO sret_items (SRET_NO,SRET_DATE,SR_NO,ITEM_CODE,QTY,INV_RATE,VAT_PERC)
              VALUES ? 
              ON DUPLICATE KEY UPDATE 
              SRET_NO= VALUES(SRET_NO),
              SRET_DATE = COALESCE(VALUES(SRET_DATE), SRET_DATE), 
              SR_NO = COALESCE(VALUES(SR_NO),SR_NO),
              ITEM_CODE = COALESCE(VALUES(ITEM_CODE),ITEM_CODE),
              QTY       = COALESCE(VALUES(QTY), QTY), 
              INV_RATE      = COALESCE(VALUES(INV_RATE), INV_RATE),
              VAT_PERC = COALESCE(VALUES(VAT_PERC),VAT_PERC);
            `;
          const values = sretItems.map(row => [
            sretNet.SretNo, sretNet.SretDt, row.SR_NO, row.ITEM_CODE,
            row.QTY, row.INV_RATE, row.VAT_PERC
          ]);

          await new Promise((resolve, reject) => {
            conn.query(itemsQuery, [values], (err, result) => {
              if (err) {
                return reject(err);
              }
              console.log("fab_inv_dtl Insert/Update:", result);
              resolve(result);
            });
          });


          conn.commit((err) => {
            if (err) {
              console.error("Commit Error:", err);
              return res.status(500).json({ message: "Commit error", error: err });
            }
            conn.release(); // Release the connection back to the pool
            res.json({ message: "Project Invoice saved successfully!" });
          });

        } catch (error) {
          console.error("Proj. Inv. Transaction Failed:", error);
          conn.rollback(() => {
            conn.release(); // Release the connection back to the pool
            res.status(500).json({ message: "Proj Inv. Transaction failed, rolled back", error });
          });
        };
      });
    });
  } catch (error) {
    console.log("Project Inv save - internal error :", error)
    res.status(500).json({ message: "Internal Server Error (Project Invoice)", error });
  }
});



app.post("/api/save-crnote", async (req, res) => {
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
                                     NARRATION, AMOUNT, VAT_AMT,SMAN_CODE) 
            VALUES (?,?,?,?, 
                    ?,?,?,?) 
            ON DUPLICATE KEY UPDATE 
            VCHR_NO =VALUES(VCHR_NO),
            VCHR_DATE= VALUES(VCHR_DATE),
            CUST_CODE = VALUES(CUST_CODE),
            DEBIT_AC = VALUES(DEBIT_AC),
            NARRATION = VALUES(NARRATION),
            AMOUNT = VALUES(AMOUNT),
            VAT_AMT = VALUES (VAT_AMT),
            SMAN_CODE = VALUES(SMAN_CODE);
          `;

          await new Promise((resolve, reject) => {
            conn.query(
              netQuery,
              [CrnHdr.CrNoteNo, CrnHdr.CrNoteDt, CrnHdr.CustCd,
              CrnHdr.AccCd, CrnHdr.Narration, CrnHdr.Amount, CrnHdr.vatAmt, CrnHdr.SmanCd],
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

app.post("/api/save-drnote", async (req, res) => {
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
                                     SMAN_CODE,NARRATION, AMOUNT, VAT_AMT) 
            VALUES (?,?,?,?, 
                    ?,?,?,?) 
            ON DUPLICATE KEY UPDATE 
            VCHR_NO =VALUES(VCHR_NO),
            VCHR_DATE= VALUES(VCHR_DATE),
            CUST_CODE = VALUES(CUST_CODE),
            CREDIT_AC = VALUES(CREDIT_AC),
            SMAN_CODE = VALUES(SMAN_CODE),
            NARRATION = VALUES(NARRATION),
            AMOUNT = VALUES(AMOUNT),
            VAT_AMT = VALUES (VAT_AMT);
          `;

          await new Promise((resolve, reject) => {
            conn.query(
              netQuery,
              [CrnHdr.DrNoteNo, CrnHdr.DrNoteDt, CrnHdr.CustCd,
              CrnHdr.AccCd, CrnHdr.SmanCd, CrnHdr.Narration, CrnHdr.Amount, CrnHdr.vatAmt],
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

app.post("/api/save-do", async (req, res) => {
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
app.post("/api/save-rcp", async (req, res) => {
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
          console.log('TRAN_ACC insert start', tranaccData);
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
app.post("/api/save-frgnpurch", async (req, res) => {
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
///


app.post("/api/save-sadj", async (req, res) => {
  try {
    const { netData, itemsData } = req.body; // Extract form data & grid rows from payload

    if (!netData || !itemsData || !Array.isArray(itemsData) || itemsData.length === 0) {
      return res.status(400).json({ message: "Invalid data format" });
    }
    console.log("STOCK ADJUSTMENT=>**", netData);
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
          // console.log("PjvNo, PjvDt==>", netData.PjvNo, netData.PjvDt);
          const netQuery = `
            INSERT INTO STK_hdr (VCHR_NO, VCHR_DATE,NARRATION) 
            VALUES (?, ?, ?) 
            ON DUPLICATE KEY UPDATE 
            VCHR_DATE= VALUES(VCHR_DATE),
            NARRATION = VALUES(NARRATION);
          `;

          await new Promise((resolve, reject) => {
            conn.query(
              netQuery,
              [netData.VchrNo, netData.VchrDt,
              netData.Narration],
              (err, result) => {
                if (err) {
                  return reject(err);
                }
                console.log("STK_HDR Insert/Update:", result);
                resolve(result);
              }
            );
          });

          // ✅ Step 2: Insert/Update NGP_ITEMS table
          const itemsQuery = `
            INSERT INTO Stk_adj (VCHR_NO, SR_NO, ITEM_CODE, QTY)
            VALUES ? 
            ON DUPLICATE KEY UPDATE 
            ITEM_CODE = COALESCE(VALUES(ITEM_CODE), ITEM_CODE), 
            QTY = COALESCE(VALUES(QTY), QTY);
            `;

          const values = itemsData.map(row => [
            row.VCHR_NO, row.SR_NO, row.ITEM_CODE, row.QTY
          ]);

          await new Promise((resolve, reject) => {
            conn.query(itemsQuery, [values], (err, result) => {
              if (err) {
                return reject(err);
              }
              console.log("STK_ADJ (items) Insert/Update:", result);
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


app.post("/api/save-gtrn", async (req, res) => {
  try {
    const { netData, itemsData } = req.body; // Extract form data & grid rows from payload

    if (!netData || !itemsData || !Array.isArray(itemsData) || itemsData.length === 0) {
      return res.status(400).json({ message: "Invalid data format" });
    }
    console.log("GOODS TRANSFER=>**", netData);
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
          // console.log("PjvNo, PjvDt==>", netData.PjvNo, netData.PjvDt);
          const netQuery = `
            INSERT INTO gtrn_hdr (GTRN_NO, GTRN_DATE,GTRN_NARRATION, LOC_FROM,LOC_TO) 
            VALUES (?, ?, ?,?,?) 
            ON DUPLICATE KEY UPDATE 
            GTRN_DATE= VALUES(GTRN_DATE),
            GTRN_NARRATION = VALUES(GTRN_NARRATION),
            LOC_FROM = VALUES(LOC_FROM),
            LOC_TO = VALUES(LOC_TO);
          `;

          await new Promise((resolve, reject) => {
            conn.query(
              netQuery,
              [netData.GtrnNo, netData.GtrnDt,
              netData.Narration, netData.LocFrom, netData.LocTo],
              (err, result) => {
                if (err) {
                  return reject(err);
                }
                console.log("gtrn_hdr Insert/Update:", result);
                resolve(result);
              }
            );
          });

          // ✅ Step 2: Insert/Update NGP_ITEMS table
          const itemsQuery = `
            INSERT INTO  gtrn_items (GTRN_NO, SR_NO, ITEM_CODE, LOC_FROM, LOC_TO,QTY)
            VALUES ? 
            ON DUPLICATE KEY UPDATE 
            ITEM_CODE = COALESCE(VALUES(ITEM_CODE), ITEM_CODE), 
            LOC_FROM = VALUES(LOC_FROM),
            LOC_TO = VALUES(LOC_TO),
            QTY = COALESCE(VALUES(QTY), QTY);
            `;

          const values = itemsData.map(row => [
            netData.GtrnNo, row.SR_NO, row.ITEM_CODE, netData.LocFrom, netData.LocTo, row.QTY
          ]);

          await new Promise((resolve, reject) => {
            conn.query(itemsQuery, [values], (err, result) => {
              if (err) {
                return reject(err);
              }
              console.log("GTRN_ITEMS (items) Insert/Update:", result);
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

// Sample API: Get supplier list from MySQL database
app.get("/api/suplst", function (req, res) {
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

app.get("/api/cmpdetails", function (req, res) {
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

app.get("/api/SupAgeingInv", function (req, res) {
  const as_at_date = req.query.as_at_date ||
    new Date().toISOString().split('T')[0];
  // const p_sman = req.query.p_sman ? req.query.p_sman.trim().toUpperCase() : null;
  const p_cus = req.query.p_cus ? req.query.p_cus.trim().toUpperCase() : null;

  console.log("SupAgeingInv", { as_at_date, p_cus });

  connection.query(
    "CALL SP_SUP_AGEING_INV(?, ?)",
    [as_at_date, p_cus],
    function (err, results) {
      if (err) {
        console.error("Error executing query:", err);
        return res.status(500).send("Error executing query.");
      }

      console.log("Query results:", results);

      // SP results come in results[0]
      res.json(results[0]);
    }
  );
});

app.get("/api/CusAgeingInv", function (req, res) {
  const as_at_date = req.query.as_at_date ||
    new Date().toISOString().split('T')[0];
  const p_sman = req.query.p_sman ? req.query.p_sman.trim().toUpperCase() : null;
  const p_cus = req.query.p_cus ? req.query.p_cus.trim().toUpperCase() : null;

  console.log("CusAgeingInv", { as_at_date, p_sman, p_cus });

  connection.query(
    "CALL SP_CUS_AGEING_INV(?, ?, ?)",
    [as_at_date, p_sman, p_cus],
    function (err, results) {
      if (err) {
        console.error("Error executing query:", err);
        return res.status(500).send("Error executing query.");
      }

      console.log("Query results:", results);

      // SP results come in results[0]
      res.json(results[0]);
    }
  );
});

app.get("/api/CustSt", function (req, res) {
  const as_on_date = req.query.as_on_date || new Date().toISOString().split('T')[0];
  const p_cus = req.query.p_cus ? req.query.p_cus.trim().toUpperCase() : null;

  console.log("CustSt ==>", { as_on_date, p_cus });

  let sql = "SELECT CUST_CODE, TRAN_TYPE, VCHR_NO, DATE_FORMAT(DATTE,'%d/%m/%y') AS DATTE," +
    " NAR, DR_AMT, CR_AMT, BALANCE" +
    " FROM v_cust_outstanding_bill" +
    " WHERE DATTE < ?";
  let params = [as_on_date];

  // ✅ Only add ACC_CODE filter if p_cus is provided
  if (p_cus) {
    sql += " AND CUST_CODE = ?";
    params.push(p_cus);
  }

  console.log("SQL ==>", sql, params);

  connection.query(sql, params, function (err, results) {
    if (err) {
      console.error("Error executing query:", err);
      return res.status(500).send("Error executing query.");
    }
    console.log("Query results count:", results.length);
    res.json(results);
  });
});

app.get("/api/SupSt", function (req, res) {
  const as_on_date = req.query.as_on_date || new Date().toISOString().split('T')[0];
  const p_cus = req.query.p_cus ? req.query.p_cus.trim().toUpperCase() : null;

  console.log("SupSt ==>", { as_on_date, p_cus });

  let sql = "SELECT ACC_CODE, TRAN_TYPE, VCHR_NO, DATE_FORMAT(DATTE,'%d/%m/%y') AS DATTE," +
    "  DR_AMT, CR_AMT, BALANCE,'' AS NAR" +
    " FROM v_sup_outstanding_bill" +
    " WHERE DATTE < ?";
  let params = [as_on_date];

  // ✅ Only add ACC_CODE filter if p_cus is provided
  if (p_cus) {
    sql += " AND ACC_CODE = ?";
    params.push(p_cus);
  }

  console.log("SQL ==>", sql, params);

  connection.query(sql, params, function (err, results) {
    if (err) {
      console.error("Error executing query:", err);
      return res.status(500).send("Error executing query.");
    }
    console.log("Query results count:", results.length);
    res.json(results);
  });
});

app.get("/api/InvStlCust/:custcd", function (req, res) {
  console.log("InvStlCust", req.params.custcd);
  connection.query(
    "SELECT  CUST_CODE, VCHR_NO DOC_NO, TRAN_TYPE DOC_TYPE,DATE_FORMAT(DATTE,'%d/%m/%Y') DOC_DATE, NAR," +
    "DR_AMT, CR_AMT, BALANCE INV_AMT " +
    "FROM v_cust_outstanding_bill WHERE CUST_CODE = ?",
    [req.params.custcd],
    function (err, results) {
      if (err) {
        console.error("Error executing query:", err);  // Include the actual error
        return res.status(500).send("Error executing query.");
      }

      // Log the results (optional)
      console.log("Query results InvStlCust:", results);

      // Send the results as JSON
      res.json(results);
    }
  );
});

app.get("/api/InvStlSup/:custcd", function (req, res) {
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
app.put("/api/saveInvItems", function (req, res) {
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
app.post("/api/saveLpoItems", async function (req, res) {
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
app.get("/api/supplier/:id", function (req, res) {

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
app.delete("/api/supDelete/:id", function (req, res, next) {
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
      console.log('Customers:', result)
      res.json(filteredResult);
    } else {
      res.status(404).json({ error: "Customer not found" });
    }
  });
});

app.post("/api/save-customer", (req, res) => {
  const data = req.body; // Receive data from frontend
  console.log("Save-Customer", expData);
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

app.get("/api/cuslst", function (req, res) {
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

app.get("/api/cuslovdropdown", function (req, res) {
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

app.get("/api/cuslov/:cname", function (req, res) {
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
app.get("/api/customer/:id", function (req, res) {
  console.log("Customer Edit 1", req.params.id);

  const sql = `
    SELECT CUST_CODE, CUST_NAME, CUST_ADR1, CUST_ADR2,PP_EXPIRY, VISA_EXPIRY,CUS_LICENSE_EXPIRY 
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

app.get("/api/MaxVchrNo/:Tp", function (req, res) {
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
app.get("/api/lpoitemget", function (req, res) {
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
app.get("/api/invadj/:tp/:vchr", function (req, res) {
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
app.get("/api/vouchers/:tp/:vchr", function (req, res) {
  console.log("vouchers", req.params);
  connection.query(  //DATE_FORMAT(a.LPO_DATE, '%d/%m/%Y') AS
    "select a.TRAN_TYPE,a.VCHR_NO,DATE_FORMAT(a.DATTE, '%d/%m/%Y') AS DATTE, a.CUST_CODE," +
    "a.PAID_TO ,a.NARRATION1,a.PAID_TO, a.ACC_CODE, b.CUST_NAME ,c.ACC_HEAD , a.AMOUNT, a.AMOUNT_FRGN" +
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
app.get("/api/payvoucher/:tp/:vchr", function (req, res) {
  console.log("vouchers", req.params);
  connection.query(  //DATE_FORMAT(a.LPO_DATE, '%d/%m/%Y') AS
    "select a.TRAN_TYPE,a.VCHR_NO,DATE_FORMAT(a.DATTE, '%d/%m/%Y') AS DATTE, a.CUST_CODE," +
    "a.PAID_TO ,a.NARRATION1,a.PAID_TO, a.ACC_CODE, b.SUP_NAME ,c.ACC_HEAD , a.AMOUNT, a.AMOUNT_FRGN" +
    " FROM vouchers a " +
    " LEFT OUTER JOIN  sup_mst b ON a.CUST_CODE = b.SUP_CODE " +
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

app.get('/api/bankRecon/edit/:docNo', async (req, res) => {
  const { docNo } = req.params;

  try {
    // ─── Fetch Header ────────────────────────────────────────────────────
    connection.query(
      `SELECT DOC_NO,BANK_CODE,DATE_FORMAT(CLOS_DT,'%Y-%m-%d') as CLOS_DT,
      STMT_BAL,CHQ_DPST,CHQ_INS,DATE_FORMAT(START_DT,'%Y-%m-%d') AS START_DT 
       FROM bnkrcnl_hdr WHERE DOC_NO = ?`,
      [docNo],
      (err, headerRows) => {
        if (err) {
          console.error('Error fetching header:', err);
          return res.status(500).json({ error: 'Database error', details: err.message });
        }

        if (headerRows.length === 0) {
          return res.status(404).json({ error: 'Document not found' });
        }

        // ─── Fetch Detail ────────────────────────────────────────────────
        connection.query(
          `SELECT DOC_NO,SR_NO,BANK_CODE,VCHR_NO, DATE_FORMAT(DATTE,'%d/%m/%Y') as DATTE,NARRATION,
          CHQ_NO,CHQ_DATE,DEBIT,CREDIT,CLEARED AS IS_CLEARED, 
          DATE_FORMAT(CLOS_DT,'%d/%m/%Y') as CLEARED_DATE
           FROM bnkrcnl_dtl WHERE DOC_NO = ? ORDER BY SR_NO`,
          [docNo],
          (err, detailRows) => {
            if (err) {
              console.error('Error fetching detail:', err);
              return res.status(500).json({ error: 'Database error', details: err.message });
            }

            // ─── Fetch Deposits ──────────────────────────────────────────
            connection.query(
              `SELECT DOC_NO,SR_NO,date_format(DEPOSIT_DATE,'%d/%m/%Y') as DEPOSIT_DATE,
                   CHQ_NO,DATE_FORMAT(CHQ_DATE,'%d/%m/%Y') AS CHQ_DATE,AMOUNT,
                   DATE_FORMAT(CLEARED_DATE,'%d/%m/%Y') AS CLEARED_DATE
                   FROM deposit_notin_ledger WHERE DOC_NO = ? ORDER BY SR_NO`,
              [docNo],
              (err, depositRows) => {
                if (err) {
                  console.error('Error fetching deposits:', err);
                  return res.status(500).json({ error: 'Database error', details: err.message });
                }

                // ─── Fetch Withdrawals ───────────────────────────────────
                connection.query(
                  `SELECT DOC_NO,SR_NO,date_format(WDRAW_DATE,'%d/%m/%Y') as WDRAW_DATE,
                   CHQ_NO,DATE_FORMAT(CHQ_DATE,'%d/%m/%Y') AS CHQ_DATE,AMOUNT,
                   DATE_FORMAT(CLEARED_DATE,'%d/%m/%Y') AS CLEARED_DATE
                   FROM withdrawal_notin_ledger WHERE DOC_NO = ? ORDER BY SR_NO`,
                  [docNo],
                  (err, withdrawalRows) => {
                    if (err) {
                      console.error('Error fetching withdrawals:', err);
                      return res.status(500).json({ error: 'Database error', details: err.message });
                    }

                    // ─── Return all together ─────────────────────────────
                    return res.status(200).json({
                      success: true,
                      header: headerRows[0],
                      ledgerRows: detailRows,
                      depositRows: depositRows,
                      withdrawalRows: withdrawalRows,
                    });
                  }
                );
              }
            );
          }
        );
      }
    );
  } catch (err) {
    console.error('bankRecon fetch error:', err);
    return res.status(500).json({ success: false, message: 'Fetch failed.', error: err.message });
  }
});


app.get("/api/bankRecon/ledger/", function (req, res) {

  const { bankCode, startDate, endDate } = req.query;

  console.log("Bank Reco:", bankCode, startDate, endDate);
  connection.query(
    "select a.TRAN_TYPE AS TRAN_TYPE,a.VCHR_NO AS VCHR_NO ," +
    "DATE_FORMAT(a.DATTE,'%d/%m/%Y') as DATTE, " +
    " a.NARRATION1 AS DETAILS," +
    " a.CHQ_NO as CHQ_NO,DATE_FORMAT(a.CHQ_DATE,'%d/%m/%Y') AS CHQ_DATE, DEBIT,CREDIT FROM V_BANK_RECO a  " +
    "WHERE  a.ACC_CODE = ? " +
    "AND a.DATTE BETWEEN ? AND ? ORDER BY a.CHQ_DATE",
    [bankCode, startDate, endDate],

    function (err, result) {
      if (err) {
        throw error;
      } else {
        console.log("Bank Reco:", result);
        res.json(result);

      }
    }
  );
});

app.post('/api/bankRecon/save', async (req, res) => {
  const {
    docNo, bankCode, startDate, endDate,
    ledgerRows, depositRows, withdrawalRows,
    stmtBal, chqDpst, chqIns,
  } = req.body;

  // const conn = await connection.getConnection();
  const conn = await connection.promise().getConnection();
  try {
    await conn.beginTransaction();

    // ─── Generate DOC_NO if not provided ────────────────────────────────
    let finalDocNo = docNo;
    if (!finalDocNo) {
      finalDocNo = `BR${Date.now().toString(36).slice(-8)}`.slice(0, 10);
    }

    // ─── Upsert Header (PK: DOC_NO) ─────────────────────────────────────
    await conn.query(
      `INSERT INTO bnkrcnl_hdr
         (DOC_NO, BANK_CODE, START_DT, CLOS_DT, STMT_BAL, CHQ_DPST, CHQ_INS)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         BANK_CODE = VALUES(BANK_CODE),
         START_DT  = VALUES(START_DT),
         CLOS_DT   = VALUES(CLOS_DT),
         STMT_BAL  = VALUES(STMT_BAL),
         CHQ_DPST  = VALUES(CHQ_DPST),
         CHQ_INS   = VALUES(CHQ_INS)`,
      [finalDocNo, bankCode, toMySQLDate(startDate), toMySQLDate(endDate), stmtBal || 0, chqDpst || 0, chqIns || 0]
    );

    // ─── Upsert bnkrcnl_dtl (PK: DOC_NO + SR_NO) ───────────────────────
    const allLedgerRows = ledgerRows || [];
    if (allLedgerRows.length > 0) {
      const ledgerValues = allLedgerRows.map((r, index) => [
        finalDocNo,
        index + 1,        // SR_NO    
        r.BANK_CODE || bankCode,
        r.VCHR_NO || null,
        toMySQLDate(r.DATTE),      // ✅
        r.NARRATION || null,
        r.CLEARED || 'N',
        toMySQLDate(endDate),      // ✅
        r.CHQ_NO || null,
        toMySQLDate(r.CHQ_DATE),   // ✅
        r.DEBIT || 0,
        r.CREDIT || 0,
      ]);

      await conn.query(
        `INSERT INTO bnkrcnl_dtl
       (DOC_NO, SR_NO, BANK_CODE, VCHR_NO, DATTE, NARRATION, CLEARED, CLOS_DT, CHQ_NO, CHQ_DATE, DEBIT, CREDIT)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       BANK_CODE  = VALUES(BANK_CODE),
       VCHR_NO    = VALUES(VCHR_NO),
       DATTE      = VALUES(DATTE),
       NARRATION  = VALUES(NARRATION),
       CLEARED    = VALUES(CLEARED),
       CLOS_DT    = VALUES(CLOS_DT),
       CHQ_NO     = VALUES(CHQ_NO),
       CHQ_DATE   = VALUES(CHQ_DATE),
       DEBIT      = VALUES(DEBIT),
       CREDIT     = VALUES(CREDIT)`,
        [ledgerValues]
      );
    }

    // ─── Upsert deposit_notin_ledger (PK: DOC_NO + SR_NO) ───────────────
    const allDepositRows = depositRows || [];
    if (allDepositRows.length > 0) {
      const depositValues = allDepositRows.map((r, index) => [
        finalDocNo,
        index + 1,
        toMySQLDate(r.DEPOSIT_DATE) || null,
        r.CHQ_NO || null,
        toMySQLDate(r.CHQ_DATE) || null,
        r.AMOUNT || 0,

        toMySQLDate(r.CLEARED_DATE) || null,
      ]);

      await conn.query(
        `INSERT INTO deposit_notin_ledger
           (DOC_NO, SR_NO, DEPOSIT_DATE, CHQ_NO, CHQ_DATE, AMOUNT, CLEARED_DATE)
         VALUES ?
         ON DUPLICATE KEY UPDATE
           DEPOSIT_DATE  = VALUES(DEPOSIT_DATE),
           CHQ_NO        = VALUES(CHQ_NO),
           CHQ_DATE      = VALUES(CHQ_DATE),
           AMOUNT        = VALUES(AMOUNT),
        
           CLEARED_DATE  = VALUES(CLEARED_DATE)`,
        [depositValues]
      );
    }

    // ─── Upsert withdrawal_notin_ledger (PK: DOC_NO + SR_NO) ────────────
    const allWithdrawalRows = withdrawalRows || [];
    if (allWithdrawalRows.length > 0) {
      const withdrawalValues = allWithdrawalRows.map((r, index) => [
        finalDocNo,
        index + 1,
        toMySQLDate(r.WDRAW_DATE) || null,
        r.CHQ_NO || null,
        toMySQLDate(r.CHQ_DATE) || null,
        r.AMOUNT || 0,
        toMySQLDate(r.CLEARED_DATE) || null,
      ]);

      await conn.query(
        `INSERT INTO withdrawal_notin_ledger
           (DOC_NO, SR_NO, WDRAW_DATE, CHQ_NO, CHQ_DATE, AMOUNT, CLEARED_DATE)
         VALUES ?
         ON DUPLICATE KEY UPDATE
           WDRAW_DATE    = VALUES(WDRAW_DATE),
           CHQ_NO        = VALUES(CHQ_NO),
           CHQ_DATE      = VALUES(CHQ_DATE),
           AMOUNT        = VALUES(AMOUNT),
           CLEARED_DATE  = VALUES(CLEARED_DATE)`,
        [withdrawalValues]
      );
    }

    await conn.commit();

    return res.status(200).json({
      success: true,
      docNo: finalDocNo,
      message: 'Bank reconciliation saved successfully.',
    });

  } catch (err) {
    await conn.rollback();
    console.error('bankRecon/save error:', err);
    return res.status(500).json({
      success: false,
      message: 'Save failed.',
      error: err.message,
    });

  } finally {
    conn.release();
  }
});
app.get("/api/bankrecolst", function (req, res) {
  connection.query(
    `SELECT ST_NO AS DOC_NO,
            ACC_HEAD AS BANK_NAME,
            BANK_CODE,
            DATE_FORMAT(FROM_DATE, '%d/%m/%Y') AS FROM_DATE,
            DATE_FORMAT(TO_DATE,   '%d/%m/%Y') AS TO_DATE,
            ST_OP_BAL,
            GL_DR_TOTAL, GL_CR_TOTAL,
            D_NIL_TOTAL, W_NIL_TOTAL,
            ARRIVED_BAL, ST_CL_BAL,
            VARIANCE,    RECO_STATUS,
            DATE_FORMAT(CREATED_AT,'%d/%m/%Y') AS CREATED_AT,  UPDATED_AT,  CREATED_BY
     FROM bank_st_hdr
     JOIN acc_mst ON (acc_code = bank_code)
     ORDER BY ST_NO DESC`,
    function (err, result) {
      if (err) throw err;
      res.json(result);
    }
  );
});
app.get("/api/accled/:acc/:dt1/:dt2", function (req, res) {
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

app.get("/api/accOpbal", function (req, res) {

  // console.log("date=",req.params.dt1.substring(4, 16).trim());

  const { bankCode, startDate, endDate } = req.query;
  console.log("Accled O/p Bal", bankCode, startDate, endDate);
  connection.query(
    "select SUM(case when a.DB_CR='D' then  a.AMOUNT else a.AMOUNT*(-1) end ) as BALANCE" +
    " FROM tran_acc a  " +
    " WHERE  a.ACC_CODE = ? " +
    " AND a.DATTE < ? ",
    [bankCode, endDate],
    function (err, result) {
      if (err) {
        throw err;
      } else {
        console.log("Led. O/P bal ", result);
        res.json(result[0]);

      }
    }
  );
});


app.get("/api/ledopbal/:acc/:dt1", function (req, res) {
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

app.get("/api/tranacc/:tp/:vchr", function (req, res) {
  console.log("tranacc entered :", req.params);
  connection.query(
    "  SELECT a.SR_NO, a.TRAN_TYPE,a.VCHR_NO, DATE_FORMAT(a.DATTE, '%d/%m/%Y')  DATTE," +
    "   a.ACC_CODE, a.AMOUNT,  a.DB_CR, a.NARRATION1,a.NARRATION2, a.JOB_NO, " +
    "   a.USERNAME,b.AC_HEAD AS ACC_HEAD , " +
    "   CASE WHEN a.DB_CR = 'D' THEN a.AMOUNT ELSE 0 END AS AMOUNT_DR, " +
    "  CASE WHEN a.DB_CR = 'C' THEN a.AMOUNT ELSE 0 END AS AMOUNT_CR " +
    " FROM tran_acc  a " +
    " LEFT JOIN ac_list b ON a.ACC_CODE = b.AC_CODE " +
    " WHERE a.TRAN_TYPE = ? AND a.VCHR_NO = ? ORDER BY a.SR_NO",
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

app.get("/api/tranaccDR/:tp/:vchr", function (req, res) {
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

app.get("/api/pdcrcd/:tp/:vchr", function (req, res) {
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


app.get("/api/pdcisu/:tp/:vchr", function (req, res) {
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
app.get("/api/pdcrcdreg/:tp/", function (req, res) {
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
app.get("/api/lpoMaxNo", function (req, res) {
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
app.post("/api/lpoupd", function (req, res, next) {
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
app.post("/api/lpoHdrUpd", function (req, res, next) {
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
app.get("/api/fpoMaxNo", function (req, res) {
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

app.get("/api/Rplnlst", function (req, res) {
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
app.get("/api/RplnMst/:id", function (req, res) {
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
app.get("/api/Gllst", function (req, res) {
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

app.get("/api/banklst", function (req, res) {
  console.log("Bank List ");
  // const tableName= "BANK_MST";

  connection.query(
    "select BANK_CODE,BANK_NAME from bank_mst ORDER BY BANK_NAME",

    function (err, result) {
      if (err) {
        throw error;
      } else {
        console.log("Bank Mst", result);
        res.json(result);
      }
    }
  );
});
app.get("/api/bankonlylst", function (req, res) {
  console.log("Bank List ");
  // const tableName= "BANK_MST";

  connection.query(
    "select BANK_CODE,BANK_NAME from bank_mst WHERE CASH='B' and PDC_IND ='N' ORDER BY BANK_CODE",

    function (err, result) {
      if (err) {
        throw error;
      } else {
        console.log("Bank Mst", result);
        res.json(result);
      }
    }
  );
});

app.get("/api/Aclist/:id", function (req, res) {
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
app.get("/api/Aclist", function (req, res) {
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
app.get("/api/Accsubcatlist", function (req, res) {
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
app.put("/api/glmst/:id", function (req, res, next) {
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



app.get("/api/acclist", function (req, res) {
  console.log("Acc mst List ");
  //const tableName= "ACC_MST";
  connection.query(
    " SELECT A.REPORT_LN, A.GL_CODE, B.GL_HEAD, A.ACC_CODE, A.ACC_HEAD " +
    " FROM acc_mst A " +
    " LEFT OUTER JOIN gl_mst B ON A.REPORT_LN = B.REPORT_LN AND A.GL_CODE = B.GL_CODE " +
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

app.put("/api/bankmst/:id", function (req, res, next) {
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

app.get("/api/nationmst/:id", function (req, res) {
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

app.get("/api/currencymst/:id", function (req, res) {
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
app.get("/api/currencylov", function (req, res) {
  console.log("Currency List");
  connection.query(
    "select CUR_CODE, CUR_NAME,DHS_CONV_RATE" +
    " FROM nation_mst  WHERE CUR_CODE IS NOT NULL order by CUR_CODE",
    [],

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


app.get("/api/trantypelst", function (req, res) {
  // const tableName= "tran_type";

  connection.query(
    "select TRAN_TYPE,TYPE_DES, TYPE_ABBR from tran_type ORDER BY TRAN_TYPE",
    [],

    function (error, result) {
      if (error) {
        throw error;
      } else {
        console.log(" Tran.Type ", result);
        res.json(result);

      }
    });

});
app.get("/api/trantypent/:id", function (req, res) {
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
app.put("/api/trantypent/:id", function (req, res, next) {
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

app.get("/api/nationlst", function (req, res) {
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

app.get("/api/loclist", function (req, res) {
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

app.get("/api/locent/:id", function (req, res) {
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
app.post("/api/locent", function (req, res) {
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

app.put("/api/locent/:id", function (req, res) {
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
app.delete("/api/locdel/:id", function (req, res) {
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
app.get("/api/Vatlst", function (req, res) {
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
app.get("/api/vatmst/:id", function (req, res) {

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

app.get("/api/Smanlst", function (req, res) {
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

app.get("/api/smanmst/:id", function (req, res) {

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
app.get("/api/qttrmlst", function (req, res) {

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
app.get("/api/qtTechDtl/:id", function (req, res) {

  connection.query(
    "select Distinct SR_NO, para_id, TECH_DETAIL_LINE" +
    "  from quot_technical_details WHERE QUOT_NO = ? ORDER BY  SR_NO",
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
})
app.get("/api/qtTermEntQt/:id", function (req, res) {

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
app.get("/api/quotnotes/:id", function (req, res) {

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
app.get("/api/qtDocUpload/:id", function (req, res) {

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
app.get("/api/quotetrment/:id", function (req, res) {
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
app.get("/api/lpolst/:dys", function (req, res) {
  console.log("LpoList");

  connection.query(
    "SELECT a.LPO_NO, DATE_FORMAT(a.LPO_DATE, '%d/%m/%Y') AS LPO_DATE, a.JOB_NO,a.SUP_CODE, " +
    "b.SUP_NAME,a.PLACE_DLV,a.PAY_TERMS, a.DELIVERY_REQ,a.AMOUNT, a.ATTN, a.CANCELLED, a.REQ_NO, a.SMAN_CODE, a.NARRATION " +
    "FROM lpo_net a " +
    "LEFT OUTER JOIN sup_mst b ON (a.SUP_CODE = b.SUP_CODE) " +
    "WHERE a.LPO_DATE >= CURDATE() - INTERVAL ? DAY " +
    "ORDER BY a.LPO_NO DESC",
    [req.params.dys], // Passing the :dys parameter as a placeholder
    function (err, results) {
      if (err) {
        throw err;
      }
      //console.log(res.json(results));
      res.json(results);

    }
  );
});
app.get("/api/lporeg", function (req, res) {

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

app.get("/api/jobpanels", function (req, res) {
  //[req.params.dys],
  connection.query(
    "select a.JOB_NO,a.SR_NO, a.PANEL_REF,a.QTY" +
    "  from job_panels a ORDER BY a.JOB_NO DESC,a.SR_NO",

    // a.START_DATE >= SYSDATE - 1800 and
    function (err, result) {
      if (err) {
        throw err;
      } else {
        console.log(" job panels", result);
        //  res.end(JSON.stringify(result.rows));
        res.json(result);
      }
    }
  );
});


app.get("/api/jobpanels/:jbNo", function (req, res) {
  //[req.params.dys],
  connection.query(
    "	SELECT SR_NO,	PANEL_REF,	QTY,	DRAW_NO,	DELIVERY_REQ,	REMARKS,	COST_MAT,	COST_CONS," +
    "	LABOUR_CHARGES,	TRANSPORT_EXP,	OTHER_EXP,	CNSU_STOCK,	START_DATE,	END_DATE,	AMOUNT," +
    "	UNIT_RATE FROM job_panels where job_no = ? Order by Sr_no", [req.params.jbNo],

    // a.START_DATE >= SYSDATE - 1800 and
    function (err, result) {
      if (err) {
        throw err;
      } else {
        console.log(" job panels", result);
        //  res.end(JSON.stringify(result.rows));
        res.json(result);
      }
    }
  );
});




app.get("/api/joblist", function (req, res) {
  //[req.params.dys],
  connection.query(
    `SELECT 
    a.JOB_NO,
    DATE_FORMAT(a.START_DATE, '%d/%m/%Y') AS START_DATE,
    a.CUST_CODE,
    b.CUST_NAME,
    a.CONTRACT_AMT,
    a.CONSULTANT,
    a.CANCEL_IND,
    a.PROJ_NAME,
    a.APPROVED_BY,
    a.LPO_NO,
    DATE_FORMAT(a.LPO_DATE, '%d/%m/%Y') AS LPO_DATE,
    f.InvAmt AS TOT_INV_AMT,
    IFNULL(a.NET_AMT, 0) - IFNULL(f.InvAmt, 0) AS BAL_TO_INVOICE
  FROM job_card a
  JOIN cus_mst b ON a.CUST_CODE = b.CUST_CODE
  LEFT JOIN (
    SELECT job_no, SUM(NET_AMT) AS InvAmt
    FROM fab_inv_hdr
    GROUP BY job_no
  ) f ON f.job_no = a.JOB_NO
  ORDER BY a.JOB_NO DESC`,

    function (err, result) {
      if (err) {
        throw err;
      } else {
        console.log("JOBLST", result);
        res.json(result);
      }
    }
  );
});
//

app.get("/api/joblistQuote/:jobNo", function (req, res) {
  //[req.params.dys],
  connection.query(
    "select a.JOB_NO,DATE_FORMAT(a.START_DATE,'%d/%m/%Y') START_DATE, a.CUST_CODE," +
    " b.CUST_NAME, a.CONTRACT_AMT,QUOT_REF, a.PROJ_NAME, a.APPROVED_BY ,a.LPO_NO ," +
    " date_format(a.LPO_DATE,'%d/%m/%Y') LPO_DATE from job_card a, cus_mst b where  " +
    " a.CUST_CODE = b.CUST_CODE  AND  a.JOB_NO = ? ORDER BY a.JOB_NO DESC", [req.params.jobNo],

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
app.get("/api/fpolst/:dys", function (req, res) {
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
app.get("/api/fporeg", function (req, res) {
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
app.get("/api/fponet/:fpoNo", function (req, res) {
  //const { fpoNo } = req.query;
  console.log('Fpo No:', req.params.fpoNo);
  connection.query(
    "select a.FPO_NO,DATE_FORMAT(a.FPO_DATE,'%d/%m/%Y') FPO_DATE, a.SUP_CODE," +
    " b.SUP_NAME, a.AMOUNT, a.CURR_ENCY, a.PAY_TERMS ,a.FPO_NOTES, a.SMAN_CODE  " +
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
app.get("/api/fpoitems/:fpoNo", function (req, res) {
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
app.get("/api/pinvfrgnlst/:dys", function (req, res) {
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


app.get("/api/srvlst/:dys", function (req, res) {

  connection.query(
    "select a.SRV_NO,DATE_FORMAT(a.SRV_DATE,'%d/%m%y') SRV_DATE, a.SUP_CODE," +
    " b.SUP_NAME, a.NARRATION, a.po_no as LPO_NO, a.INV_NO, a.INV_DATE" +
    " from srv_hdr a LEFT OUTER JOIN  sup_mst b  ON (a.SUP_CODE = b.SUP_CODE) " +
    " where  a.SRV_DATE  >= CURDATE() - INTERVAL ? DAY and " +
    " a.SUP_CODE = b.SUP_CODE ORDER BY a.SRV_NO DESC",
    [req.params.dys],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        console.log("srv list", result);
        res.json(result);
      }
    }
  );
});

app.get("/api/srvhdr/:srv", function (req, res) {

  //console.log('SRV Hdr. no'||srv);

  connection.query(
    "select a.SRV_NO,DATE_FORMAT(a.SRV_DATE,'%d/%m/%y') SRV_DATE, a.SUP_CODE," +
    " b.SUP_NAME, a.NARRATION, a.PO_NO as LPO_NO, a.INV_NO, a.INV_DATE " +
    " from srv_hdr a, sup_mst b where a.SUP_CODE =b.SUP_CODE and  a.SRV_NO= ? ",
    [req.params.srv],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        //    console.log("Oracle SRVHDR Read Data", result.rows);
        res.json(result);

      }
    }
  );
});

app.get("/api/srvitems/:srv", function (req, res) {

  connection.query(
    "select a.SRV_NO,DATE_FORMAT(a.SRV_DATE,'%d/%m/%y') AS SRV_DATE, a.LOC_CODE," +
    "a.ITEM_CODE, b.ITEM_NAME1, a.QTY, a.SR_NO, a.COST, a.SRV_UNIT as UOM" +
    " from srv_items a left outer join  item_mst b on (a.ITEM_CODE =b.ITEM_CODE) where  a.SRV_NO= ? ORDER by a.Sr_no ",
    [req.params.srv],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        console.log("Oracle SRVItems", result);
        res.json(result)

      }
    }
  );
});


app.get("/api/sivlst/:dys", function (req, res) {


  connection.query(
    "select a.SIV_NO,DATE_FORMAT(a.SIV_DATE,'%d/%m/%y')  as SIV_DATE, a.COST_CODE," +
    " b.CUST_NAME, a.NARRATION, a.JOB_NO, a.PANEL_NO " +
    " from siv_hdr a left outer join cus_mst b  ON (a.CUST_CODE = b.CUST_CODE) " +
    " where   a.SIV_DATE  >= CURDATE() - INTERVAL ? DAY " +
    "  ORDER BY a.SIV_NO DESC",
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

app.get("/api/sivhdr/:siv", function (req, res) {

  connection.execute(
    "select a.SIV_NO,DATE_FORMAT(a.SIV_DATE,'%d/%m/%y') SIV_DATE, a.CUST_CODE," +
    " b.CUST_NAME, a.NARRATION, a.JOB_NO, a.PANEL_NO" +
    " from siv_hdr a left join  cus_mst b  on (a.CUST_CODE =b.CUST_CODE) where  a.SIV_NO= ? ",
    [req.params.siv],

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

app.get("/api/sivitems/:siv", function (req, res) {

  console.log('SIV Items. ');

  connection.execute(
    "select a.SIV_NO,DATE_FORMAT(a.SIV_DATE,'%d/%m%y') SIV_DATE, a.LOC_CODE," +
    "a.ITEM_CODE, b.ITEM_NAME1, a.QTY, a.SR_NO, a.STD_COST " +
    " from siv_items a Left outer join item_mst b on ( a.ITEM_CODE =b.ITEM_CODE) where   a.SIV_NO= ? ORDER by lpad(a.Sr_no ,3,'0')",
    [req.params.siv],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        console.log("Oracle SIVItems", result);
        res.json(result);

      }
    }
  );
});

app.get("/api/sivitemsjob/:job", function (req, res) {

  //console.log('SIV Items. ');

  connection.execute(
    "select a.SIV_NO,DATE_FORMAT(a.SIV_DATE,'%d/%m/%y') AS SIV_DATE, a.LOC_CODE,a.SR_NO," +
    " a.ITEM_CODE, b.ITEM_NAME1, a.QTY, a.SR_NO, a.STD_COST, a.JOB_NO " +
    " from siv_items a left outer join  item_mst b on  a.ITEM_CODE = b.ITEM_CODE where " +
    " a.JOB_NO = ? ORDER by a.SIV_NO,a.SR_NO",
    [req.params.job],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        // console.log("Oracle SRVItems", result.rows);
        res.json(result);
        // conn.close();
      }
    }
  );

});


app.get("/api/sadjlst", function (req, res) {
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

app.get("/api/sadjhdr/:siv", function (req, res) {
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

app.get("/api/sadjitems/:srv", function (req, res) {

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

app.get("/api/invlst/:dys", function (req, res) {

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

app.get("/api/jobsalreg", function (req, res) {


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

app.get("/api/invhdr/:id", function (req, res) {
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

app.get("/api/invitem/:id", function (req, res) {

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


app.get("/api/quotlst/:dys", function (req, res) {


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

app.get("/api/quothdr/:id", function (req, res) {

  const sql = `
    SELECT 
      a.QUOT_NO,
      DATE_FORMAT(a.QUOT_DATE,'%d/%m/%Y) AS QUOT_DATE,
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
      a.INQ_NO,a.REV_NO,a.QUOT_APPROVED,a.QUOT_APPROVED_BY,a.QUOT_LIMIT_APPROVED_BY

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



app.get("/api/quotitem/:id", function (req, res) {

  connection.query(
    "select QUOT_NO,  DATE_FORMAT(a.QUOT_DATE,'%d/%m/%Y) AS QUOT_DATE ,SR_NO , ITEM_CODE, ITEM_NAME , QTY, UNIT ,RATE ," +
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

app.get("/api/quotent1/:id", function (req, res) {
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

app.get("/api/sinqlst/:dys", function (req, res) {
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

app.get("/api/invlist/:dys", function (req, res) {
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
app.get("/api/fabinvlist/:dys", function (req, res) {


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


app.get("/api/fabinvjob/:job", function (req, res) {
  console.log('FAB INV HDR== param ', req.params.job);
  connection.query(
    "select a.INV_NO,a.INV_DATE, a.CUST_CODE," +
    " b.CUST_NAME, a.CASH_CUST_NAME,a.JOB_NO, a.DO_NO,  INV_CANCELLED ,PROJECT_DETAIL," +
    "a.LPO_NO,DATE_FORMAT(a.LPO_DATE, '%d/%m/%Y') LPO_DATE,a.NET_AMT , a.INV_UPLOAD_FILE, b.CONTACT_PR," +
    " a.CONTRACT_AMT_PERCENT,a.INV_ACK,a.QUOT_NO ,a.CURR_CODE, a.CONVERT_RATE ,a.CR_DAYS " +
    " from fab_inv_hdr a left outer join cus_mst b ON  a.CUST_CODE = b.CUST_CODE where  a.JOB_NO =?  ",
    [req.params.job],

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


app.get("/api/fabinvhdr/:inv", function (req, res) {
  console.log('FAB INV HDR== param ', req.params.inv);
  connection.query(
    "select a.INV_NO,a.INV_DATE, a.CUST_CODE," +
    " b.CUST_NAME, a.CASH_CUST_NAME,a.JOB_NO, a.DO_NO,  INV_CANCELLED ,PROJECT_DETAIL," +
    "a.LPO_NO,DATE_FORMAT(a.LPO_DATE, '%d/%m/%Y') LPO_DATE,a.NET_AMT AMOUNT, a.INV_UPLOAD_FILE," +
    " a.CONTRACT_AMT_PERCENT,a.INV_ACK,a.QUOT_NO ,a.CURR_CODE, a.CONVERT_RATE ,a.CR_DAYS " +
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

app.get("/api/fabinvitems/:vchr", function (req, res) {
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

app.get("/api/sretlst/:dys", function (req, res) {
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
app.get("/api/srethdr/:vchr", function (req, res) {
  console.log("SRet.Note  req:=", req.params.vchr);
  connection.query(

    "select a.SRET_NO,DATE_FORMAT(a.SRET_DATE,'%d/%m/%Y') SRET_DATE, a.CUST_CODE," +
    " b.CUST_NAME, a.NARRATION1, a.INV_NO, a.SMAN_CODE, a.AMOUNT ,a.DISCOUNT, DR_CODE,c.ACC_HEAD FROM  sret_hdr a " +
    " left outer join cus_mst b on a.cust_code = b.cust_code" +
    " left outer join acc_mst c on a.dr_code =c.acc_code " +
    " WHERE    a.SRET_NO = ? ",

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
app.get("/api/sretitems/:vchr", function (req, res) {
  console.log("SRet.Note  req:=", req.params.vchr);
  connection.query(

    "select a.SRET_NO,DATE_FORMAT(a.SRET_DATE,'%d/%m/%Y') SRET_DATE, a.LOC_CODE," +
    " a.ITEM_CODE, a.SR_NO, a.QTY, a.COST, a.INV_RATE,a.VAT_PERC " +
    " FROM sret_items a" +
    " WHERE  a.SRET_NO = ? ",

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


app.get("/api/salretreg", function (req, res) {
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
app.get("/api/crntlst/:dys", function (req, res) {

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


app.get("/api/crnotereg", function (req, res) {

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
app.get("/api/crntHdr/:vchr", function (req, res) {
  console.log(" Cr.Note  req:=", req.params.vchr);
  connection.query(
    "select a.VCHR_NO,DATE_FORMAT(a.VCHR_DATE,'%d/%m/%Y') VCHR_DATE, a.CUST_CODE," +
    " b.CUST_NAME, a.NARRATION, a.DEBIT_AC,a.SMAN_CODE,a.VAT_AMT,  a.AMOUNT " +
    " from crnote_hdr a left outer join cus_mst b ON b.CUST_CODE = a.CUST_CODE " +
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


app.get("/api/drawingReg", function (req, res) {
  const { start_date, end_date } = req.query;
  const query = `
        SELECT 
            SL_NO,
            DATE_FORMAT(DRAW_DATE, '%d/%m/%Y')     AS DRAW_DATE,
            CLIENT_NAME,
            PROJECT_NAME,
            QUOTE_REF,
            COMPUTER_LOCATION,
            DRAWN_NAME,
            PANEL_REF,
            DRAWING_NO,
            DATE_FORMAT(DATE_OF_SUBM, '%d/%m/%Y')  AS DATE_OF_SUBM,
            EXT_REV,
            JOB_NO,
            DATE_FORMAT(APPROVAL_DATE, '%d/%m/%Y') AS APPROVAL_DATE
        FROM drawing_register
        ORDER BY DRAW_DATE DESC, SL_NO;
    `;

  connection.query(query, function (error, result) {
    if (error) {
      console.error("Drawing register error:", error);
      res.status(500).json({ error: "Database query failed" });
    } else {
      console.log("Drawing register:", result);
      res.json(result);
    }
  });
});

app.get("/api/getDrawReg/:id", function (req, res) {
  console.log("getDrawReg is called");
  // const { drawNo } = req.query;
  const drawNo = decodeURIComponent(req.query.drawNo)
  const query = `
        SELECT 
            SL_NO,
            DATE_FORMAT(DRAW_DATE, '%Y-%m-%d')     AS DRAW_DATE,
            CLIENT_NAME,
            PROJECT_NAME,
            QUOTE_REF,
            COMPUTER_LOCATION,
            DRAWN_NAME,
            PANEL_REF,
            DRAWING_NO,
            DATE_FORMAT(DATE_OF_SUBM, '%Y-%m-%d')  AS DATE_OF_SUBM,
            EXT_REV,
            JOB_NO,
            DATE_FORMAT(APPROVAL_DATE, '%Y-%m-%d') AS APPROVAL_DATE
        FROM drawing_register
        WHERE DRAWING_NO = ?
        ORDER BY DRAW_DATE DESC, SL_NO;
    `;

  connection.query(query, [req.params.id], function (error, result) {
    if (error) {
      console.error("Drawing register Id retreival error:", error);
      res.status(500).json({ error: "Database query failed" });
    } else {
      console.log("Drawing register for ID :", result);
      res.json(result);
    }
  });
});


app.get("/api/drntHdr/:vchr", function (req, res) {
  console.log("Oracle Cr.Note  req:=", req.params.vchr);
  connection.query(
    "select a.VCHR_NO,DATE_FORMAT(a.VCHR_DATE,'%d/%m/%Y') VCHR_DATE, a.CUST_CODE," +
    " b.CUST_NAME,a.SMAN_CODE, a.NARRATION, a.CREDIT_AC,a.VAT_AMT,  a.AMOUNT" +
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
app.get("/api/drntlst/:dys", function (req, res) {

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


app.get("/api/drnotereg", function (req, res) {

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
app.get("/api/pinvlst/:dys", function (req, res) {

  connection.query(
    "select a.PJV_NO,DATE_FORMAT(a.PJV_DATE,'%d/%m/%Y') PJV_DATE, a.SUP_CODE," +
    " a.PO_NO,a.INV_NO, DATE_FORMAT(a.INV_DATE,'%d/%m/%Y') INV_DATE , " +
    " '' as SRV_NO,b.SUP_NAME, a.INV_AMOUNT, a.VAT_PERC,  a.DISCOUNT,a.RND_OFF" +
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
app.get("/api/ngpnet/:vch", function (req, res) {
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
app.get("/api/ngpitems/:vch", function (req, res) {
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

app.get("/api/purchaseHdr/:vch", function (req, res) {
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
app.get("/api/purchaseitems/:vch", function (req, res) {
  connection.query(
    "select a.SRV_NO,a.SR_NO, a.ACC_CODE," +
    " b.ACC_HEAD,  a.ITEM_CODE, c.ITEM_NAME1 as ITEM_NAME ,COALESCE(a.JOB_NO, 'N/A') AS JOB_NO, " +
    " a.QTY, a.COST AS RATE, ROUND( COALESCE(a.QTY,0) * COALESCE(a.COST,0) ,2) AS AMOUNT " +
    " from purchase_items a left outer join  acc_mst b on b.ACC_CODE = a.ACC_CODE " +
    " LEFT OUTER JOIN item_mst c ON c.ITEM_CODE = a.ITEM_CODE" +
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
app.get("/api/purchaseItemsJob/:Job", function (req, res) {
  connection.query(
    "select a.SRV_NO,a.SR_NO, a.ACC_CODE," +
    " b.ACC_HEAD,  a.ITEM_CODE, c.ITEM_NAME1 as ITEM_NAME1 ,a.LPO_NO,COALESCE(a.JOB_NO, 'N/A') AS JOB_NO, " +
    " a.QTY, a.COST , ROUND( COALESCE(a.QTY,0) * COALESCE(a.COST,0) ,2) AS AMOUNT " +
    " from purchase_items a left outer join  acc_mst b on b.ACC_CODE = a.ACC_CODE " +
    " LEFT OUTER JOIN item_mst c ON c.ITEM_CODE = a.ITEM_CODE" +
    " WHERE  a.JOB_NO = ?  " +
    " ORDER BY a.SR_NO",
    [req.params.Job],

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
app.get("/api/grtnitemsjob/:Job", function (req, res) {
  connection.query(
    "select a.SRV_NO,DATE_FORMAT(b.SRV_DATE,'%d/%m/%y') AS SRV_DATE ,a.LOC_CODE ," +
    " a.PROD_CODE AS ITEM_CODE, c.ITEM_NAME1 as ITEM_NAME1 ,COALESCE(b.JOB_NO, 'N/A') AS JOB_NO, " +
    " a.QTY, a.UNIT_COST COST, ROUND( COALESCE(a.QTY,0) * COALESCE(a.UNIT_COST,0) ,2) AS AMOUNT " +
    " from goods_rtn_items a   " +
    " LEFT OUTER JOIN item_mst c ON a.PROD_CODE = c.ITEM_CODE " +
    ", goods_rtn_Hdr b" +
    " WHERE  b.JOB_NO = ? and a.SRV_NO =b.SRV_NO  " +
    " ORDER BY a.SRV_NO",
    [req.params.Job],

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


app.get("/api/variationsjob/:Job", function (req, res) {
  connection.query(
    "select a.VAR_DESC,DATE_FORMAT(a.VAR_DATE,'%d/%m/%y') AS VAR_DATE , a.AMOUNT " +
    " from job_variations a   " +
    " WHERE  a.JOB_NO = ?   " +
    " ORDER BY a.VAR_DATE",
    [req.params.Job],

    function (err, result) {
      if (err) {
        throw err;
      } else {

        res.json(result);
        console.log("JOB VARIATIONS", result, req.params.vch)
      }
    }
  );
});



app.get("/api/expaccjob/:Job", function (req, res) {
  connection.query(
    "select a.EXP_CODE,a.ACC_CODE , b.ACC_HEAD " +
    " from job_expenses_link a   " +
    " LEFT OUTER JOIN acc_mst b ON a.ACC_CODE = b.ACC_CODE " +
    " WHERE  a.JOB_NO = ?   " +
    " ORDER BY a.EXP_CODE",
    [req.params.Job],

    function (err, result) {
      if (err) {
        throw err;
      } else {

        res.json(result);
        console.log("JOB LINKED ACCOUNTS", result, req.params.vch)
      }
    }
  );
});

app.get("/api/getMaxDoc/:table/:field", async (req, res) => {
  const { table, field } = req.params;

  try {
    /*  const pool = mysqlPromise.createPool({
        host: dbIp,
        user: "root",
        password: "Digital@65",
        database: "hayat",
      });*/

    const [rows] = await connection.promise().query(`CALL get_max_docno(?, ?)`, [table, field]);
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
        console.log("maxDoc (default)=", result);
        break;
      }
    }
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/purfrgnhdr/:vch", function (req, res) {
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
app.get("/api/gittypesfp/:vch", function (req, res) {
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
app.get("/api/purfrgnitems/:vch", function (req, res) {
  connection.query(
    "select a.PJV_NO, CAST(a.SR_NO AS CHAR) AS SR_NO, " +
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

app.get("/api/tranaccNext/:vch", function (req, res) {
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
app.get("/api/prethdr/:vch", function (req, res) {
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

app.get("/api/ngplst/:dys", function (req, res) {
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

app.get("/api/pretlst/:dys", function (req, res) {


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
app.get("/api/nextdo", function (req, res) {
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

app.get("/api/dolist/:dys", function (req, res) {
  connection.query(
    "select a.INV_NO DO_NO, DATE_FORMAT(a.INV_DATE,'%d/%m/%Y') DO_DATE, a.CUST_CODE," +
    " b.CUST_NAME, a.JOB_NO, a.DO_NO INV_NO, a.DO_APPROVED, a.QUOT_NO ," +
    " a.LPO_NO, DATE_FORMAT(a.LPO_DATE,'%d%m%Y') AS LPO_DATE, a.CONTACT_PERSON " +
    " from fab_do_hdr a LEFT OUTER JOIN cus_mst b  ON (a.CUST_CODE = b.CUST_CODE) " +
    " where  a.INV_DATE >= CURDATE() - INTERVAL ? DAY  " +
    "  ORDER BY a.INV_NO DESC",
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
app.get("/api/fabdohdr/:doNo", function (req, res) {
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

app.get("/api/jobdoreg", function (req, res) {
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
app.get("/api/fabdoitems/:doNo", function (req, res) {
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
app.get("/api/pretitems/:vchr", function (req, res) {


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

app.get("/api/netsales/:vchr", function (req, res) {
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

app.get("/api/sinvitems/:vchr", function (req, res) {
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

app.get("/api/itemsal", function (req, res) {
  // console.log('Sales Invoice Items ');
  const { ItemCd, start_date, end_date } = req.query;
  console.log(ItemCd, start_date, end_date);

  const invFilter = ItemCd
    ? (`AND ITEM_CODE = ?`)
    : "";
  const params = ItemCd
    ? [start_date, end_date, ItemCd]
    : [start_date, end_date];

  connection.query(
    "SELECT t.* , n.CUST_CODE, c.CUST_NAME, i.ITEM_NAME1 FROM (" +
    "  SELECT a.INV_NO, DATE_FORMAT(a.INV_DATE,'%d/%m/%Y') AS INV_DATE," +
    "  a.ITEM_CODE, a.ITEM_DES1, a.INV_QTY, a.INV_UNIT,a.INV_RATE," +
    "  COALESCE(a.SR_NO, ROW_NUMBER() OVER (ORDER BY a.INV_NO)) AS SR_NO," +
    "  COALESCE(a.INV_QTY,0) * COALESCE(a.INV_RATE,0) AS AMOUNT" +
    "  FROM invoice a  " +
    " WHERE a.INV_DATE between ? and ? " +
    ` ${invFilter} ` +
    " ) t left outer join net_sales n on (t.inv_no= n.INV_NO) " +
    "  LEFT outer join cus_mst c on (c.CUST_CODE =n.CUST_CODE) " +
    "  LEFT outer join item_mst i on (i.ITEM_CODE = t.ITEM_CODE) ORDER BY SR_NO",
    params,

    function (err, result) {
      if (err) {
        throw err;
      } else {
        console.log("Invoice Items ", result);
        res.json(result);
      }

    }
  );
});

app.get("/api/itempur", function (req, res) {
  // console.log('Sales Invoice Items ');
  const { ItemCd, start_date, end_date } = req.query;
  console.log(ItemCd, start_date, end_date);


  const query =
    "SELECT t.*, DATE_FORMAT(n.PJV_DATE,'%d/%m/%Y') AS PRCH_DATE, n.SUP_CODE, c.SUP_NAME, i.ITEM_NAME1 " +
    "FROM (" +
    "  SELECT a.SRV_NO as PRCH_NO, " +
    "  a.ITEM_CODE, a.QTY, a.ITEM_UNIT, a.COST, " +
    "  COALESCE(a.SR_NO, ROW_NUMBER() OVER (ORDER BY a.SRV_NO)) AS SR_NO, " +
    "  COALESCE(a.QTY,0) * COALESCE(a.COST,0) AS AMOUNT " +
    "  FROM purchase_items a " +
    (ItemCd ? "WHERE a.ITEM_CODE = ? " : "") +
    ") t " +
    "LEFT OUTER JOIN purchase_hdr n ON (t.PRCH_NO = n.PJV_NO) " +
    "LEFT OUTER JOIN sup_mst c ON (c.SUP_CODE = n.SUP_CODE) " +
    "LEFT OUTER JOIN item_mst i ON (i.ITEM_CODE = t.ITEM_CODE) " +
    "WHERE n.PJV_DATE BETWEEN ? AND ? " +
    "ORDER BY t.SR_NO";

  // Build params conditionally
  const params = ItemCd
    ? [ItemCd, start_date, end_date]
    : [start_date, end_date];
  connection.query(query, params, function (err, result) {
    if (err) {
      throw err;
    } else {
      console.log("Purchase Items ", result);
      res.json(result);
    }
  });
});

app.get("/api/custsal", function (req, res) {
  // console.log('Sales Invoice Items ');
  const { ItemCd, start_date, end_date } = req.query;

  console.log('custsal==>', ItemCd, start_date, end_date);
  const invFilter = ItemCd
    ? (`AND CUST_CODE = ?`)
    : "";
  const params = ItemCd
    ? [start_date, end_date, ItemCd, start_date, end_date, ItemCd]
    : [start_date, end_date, start_date, end_date];

  connection.query(
    "SELECT t.* ,  c.CUST_NAME,j.PROJ_NAME,j.CONTACT_PER ,j.DESIGNER ,j.PLACE_OF_DLV ,j.MEANS_PAYMENTS, " +
    " j.MEANS_TRANSPORT FROM (" +
    "  SELECT a.INV_NO, DATE_FORMAT(a.INV_DATE,'%d/%m/%Y') AS INV_DATE," +
    "  a.CUST_CODE,  '' AS JOB_NO, a.LPO_NO, '' AS QUOT_NO,'' AS CONTRACT_AMT_PERCENT, a.AMOUNT" +
    "  FROM net_sales a  " +
    " WHERE a.INV_DATE between ? and ? " +
    `${invFilter} ` +
    " UNION ALL " +
    "  SELECT a.INV_NO, DATE_FORMAT(a.INV_DATE,'%d/%m/%Y') AS INV_DATE," +
    "  a.CUST_CODE,   a.JOB_NO, a.LPO_NO,  a.QUOT_NO, a.CONTRACT_AMT_PERCENT,a.NET_AMT AS AMOUNT " +
    "  FROM fab_inv_hdr a  " +
    " WHERE  a.INV_DATE between ? and ? " +
    `${invFilter} ` +
    " ) t    LEFT outer join cus_mst c on (c.CUST_CODE =t.CUST_CODE) " +
    " LEFT OUTER JOIN job_card j on (j.JOB_NO = t.JOB_NO) " +
    "  ORDER BY 1",
    params,

    function (err, result) {
      if (err) {
        throw err;
      } else {
        console.log("Cust.Sales ", result);
        res.json(result);
      }

    }
  );
});


app.get("/api/jobsal", function (req, res) {
  // console.log('Sales Invoice Items ');
  const { ItemCd, start_date, end_date } = req.query;

  console.log('custsal==>', ItemCd, start_date, end_date);
  const invFilter = ItemCd
    ? (`AND JOB_NO = ?`)
    : "";
  const params = ItemCd
    ? [start_date, end_date, ItemCd, start_date, end_date, ItemCd]
    : [start_date, end_date, start_date, end_date];

  connection.query(
    "SELECT t.* ,  c.CUST_NAME,j.PROJ_NAME,j.CONTACT_PER ,j.DESIGNER ,j.PLACE_OF_DLV ,j.MEANS_PAYMENTS, " +
    " j.MEANS_TRANSPORT ,n.CUR_NAME ,s.SMAN_NAME FROM (" +
    "  SELECT a.INV_NO, DATE_FORMAT(a.INV_DATE,'%d/%m/%Y') AS INV_DATE," +
    "  a.CUST_CODE,  a.CURR_CODE, a.JOB_NO, a.LPO_NO,  a.DO_NO, a.CONTRACT_AMT_PERCENT,a.NET_AMT AS AMOUNT " +
    "  FROM fab_inv_hdr a  " +
    " WHERE  a.INV_DATE between ? and ? " +
    `${invFilter} ` +
    " ) t    LEFT outer join cus_mst c on (c.CUST_CODE =t.CUST_CODE) " +
    " LEFT OUTER JOIN job_card j on (j.JOB_NO = t.JOB_NO) " +
    " LEFT OUTER JOIN nation_mst n on (n.CUR_CODE= t.CURR_CODE) " +
    " LEFT OUTER JOIN sman_mst s on (s.SMAN_CODE= j.SMAN_CODE) " +
    "  ORDER BY 1",
    params,

    function (err, result) {
      if (err) {
        throw err;
      } else {
        console.log("Cust.Sales ", result);
        res.json(result);
      }

    }
  );
});

// groupBy parameter: "SUP"  = group by Supplier then Item
//                   "ITEM" = group by Item then Supplier

//function getPurchaseReport(groupBy, start_date, end_date, res) {
app.get("/api/purchaseReport", function (req, res) {
  let selectCols, groupCols;
  const { groupBy, groupType, start_date, end_date, ItemCd } = req.query;
  console.log("groupBy =", groupBy, ItemCd);
  if (groupBy === "SUP") {

    if (groupType == "SUM") {
      selectCols = "SUP_CODE, SUP_NAME, ITEM_CODE, ITEM_NAME";
      groupCols = "SUP_CODE, SUP_NAME, ITEM_CODE, ITEM_NAME";  // match SELECT
    } else {
      selectCols = "PJV_NO,DATE_FORMAT(PJV_DATE,'%d/%m/%Y') AS PJV_DATE,SUP_CODE, SUP_NAME, ITEM_CODE, ITEM_NAME,ITEM_UNIT";
      groupCols = "PJV_NO,PJV_DATE,SUP_CODE, SUP_NAME, ITEM_CODE, ITEM_NAME,QTY, ITEM_UNIT,COST";  // match SELECT
    }

  } else {
    if (groupType == "SUM") {
      selectCols = "ITEM_CODE, ITEM_NAME, SUP_CODE, SUP_NAME";
      groupCols = "ITEM_CODE, ITEM_NAME, SUP_CODE, SUP_NAME";  // match SELECT
    } else {
      selectCols = "PJV_NO,DATE_FORMAT(PJV_DATE,'%d/%m/%Y') AS PJV_DATE,SUP_CODE, SUP_NAME, ITEM_CODE, ITEM_NAME,ITEM_UNIT";
      groupCols = "PJV_NO,PJV_DATE,SUP_CODE, SUP_NAME, ITEM_CODE, ITEM_NAME,QTY,ITEM_UNIT,COST";  // match SELECT
    }
  }
  // Conditional filter based on groupBy
  // If ItemCd is provided, add the filter — otherwise skip it
  const itemFilter = ItemCd
    ? (groupBy === "SUP" ? `AND SUP_CODE = ?` : `AND ITEM_CODE = ?`)
    : "";


  // Only include ItemCd in params if it's provided
  const params = ItemCd
    ? [start_date, end_date, ItemCd]
    : [start_date, end_date];

  const query =
    `SELECT ${selectCols}, ` +
    `SUM(QTY) AS TOTAL_QTY,  MAX(COST) AS COST ,SUM(AMOUNT) AS TOTAL_AMOUNT ` +
    `FROM V_Purchase_Details ` +
    `WHERE PJV_DATE BETWEEN ? AND ? ` +
    `${itemFilter} ` +
    `GROUP BY ${groupCols} ` +
    `ORDER BY ${groupCols}`;

  connection.query(query, params, (err, result) => {
    if (err) {
      throw err;
    } else {
      console.log("Purchase Report", result);
      res.json(result);
    }
  });
});

app.get("/api/suppur", function (req, res) {
  // console.log('Sales Invoice Items ');
  const { ItemCd, start_date, end_date } = req.query;
  //console.log('custsal==>',ItemCd,start_date,end_date);
  const query =
    "SELECT t.*, c.SUP_NAME FROM (" +
    "  SELECT a.PJV_NO, DATE_FORMAT(a.PJV_DATE,'%d/%m/%Y') AS PJV_DATE," +
    "  a.SUP_CODE, a.PO_NO, a.INV_NO, DATE_FORMAT(a.INV_DATE,'%d/%m/%Y') AS INV_DATE, a.INV_AMOUNT as AMOUNT," +
    "  a.DISCOUNT, a.VAT_PERC, a.RND_OFF " +
    "  FROM purchase_hdr a " +
    "  WHERE a.PJV_DATE BETWEEN ? AND ? " +
    (ItemCd ? "AND a.SUP_CODE = ? " : "") +
    ") t " +
    "LEFT OUTER JOIN sup_mst c ON (c.SUP_CODE = t.SUP_CODE) " +
    "ORDER BY t.PJV_NO";

  const params = ItemCd
    ? [start_date, end_date, ItemCd]
    : [start_date, end_date];

  connection.query(query, params, function (err, result) {
    if (err) {
      throw err;
    } else {
      console.log("Sup.Purchase", result);
      res.json(result);
    }
  });
});
app.get("/api/supdueinv", function (req, res) {
  const { end_date } = req.query;
  console.log('end_date=', end_date);
  // Option A — Use end_date from frontend (flexible)
  const query = `
    SELECT 
      a.ACC_CODE, 
      a.VCHR_NO, 
      a.TRAN_TYPE, 
      DATE_FORMAT(a.DATTE,'%d/%m/%Y') AS DATTE, 
      b.SUP_NAME,
      a.DR_AMT, 
      a.CR_AMT,
      a.BALANCE,
      b.CR_PERIOD,
      DATEDIFF(?, a.DATTE) AS OVERDUE_DAYS
    FROM v_sup_outstanding_bill a  
    JOIN sup_mst b ON a.ACC_CODE = b.SUP_CODE
    WHERE DATEDIFF(?, a.DATTE) > b.CR_PERIOD
    ORDER BY a.DATTE 
  `;

  const params = [end_date, end_date];  // ✅ passed twice for both DATEDIFF usages

  connection.query(query, params, function (err, result) {
    if (err) {
      console.error("Sup Overdue Bills Error:", err);
      return res.status(500).json({ error: "Database error", details: err.message }); // ✅ proper error handling
    }
    console.log("Sup.Overdue Bills", result);
    res.json(result);
  });
});


app.get("/api/sadjlst/:dys", function (req, res) {
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

app.get("/api/gtrnlst/:dys", function (req, res) {
  connection.query(
    "select a.GTRN_NO,DATE_FORMAT(a.GTRN_DATE,'%d/%m/%Y') GTRN_DATE," +
    " a.GTRN_NARRATION  AS NARRATION,LOC_FROM,LOC_TO" +
    " from gtrn_hdr a where  a.GTRN_DATE >= CURDATE() -INTERVAL ? DAY " +
    "  ORDER BY a.GTRN_NO DESC",
    [req.params.dys],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        console.log("gtrn list===>>", result);
        res.json(result)
        //  conn.close();
      }
    }
  );
});
app.get("/api/gtrnhdr/:Vch", function (req, res) {
  connection.query(
    "select a.GTRN_NO,DATE_FORMAT(a.GTRN_DATE,'%d/%m/%Y') GTRN_DATE," +
    " a.GTRN_NARRATION  AS NARRATION,LOC_FROM, LOC_TO " +
    " from gtrn_hdr a where  a.GTRN_NO =? " +
    "  ORDER BY a.GTRN_NO DESC",
    [req.params.Vch],

    function (err, result) {
      if (err) {
        throw err;
      } else {
        console.log("gtrn lHdr===>>", result);
        res.json(result)
        //  conn.close();
      }
    }
  );
});

app.get("/api/gtrnitems/:vch", function (req, res) {
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
app.get("/api/trnlst/:tp/:dys/:dbcr", function (req, res) {
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

app.get("/api/sinqcomplst", function (req, res) {
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
app.get("/api/sinqloclst", function (req, res) {
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
app.get("/api/sinqloc/:id", function (req, res) {
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
app.get("/api/locmst/:id", function (req, res) {
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

app.get("/api/catlst", function (req, res) {
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


app.get("/api/catmst/:id", function (req, res) {

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
app.get("/api/itmsubcat/:cat/:scat", function (req, res) {
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

app.get("/api/sinqtypelst", function (req, res) {
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

app.get("/api/sinqtype/:id", function (req, res) {
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
app.put("/api/sinqtype/:id", function (req, res, next) {
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
app.get("/api/enqformlst", function (req, res) {
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
app.get("/api/enqformMst/:id", function (req, res) {
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
app.put("/api/enqformMst/:id", function (req, res, next) {
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
app.get("/api/enqstatlist", function (req, res) {
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
app.get("/api/enqstat/:id", function (req, res) {
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
app.put("/api/enqstat/:id", function (req, res, next) {
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
app.post("/api/invhdrpost", function (req, res, next) {
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
app.put("/api/invhdrput/:id", (req, res, next) => {
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
app.put("/api/sinvacc", function (req, res, next) {
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
app.delete("/api/cusDelete/:id", function (req, res, next) {
  var sql = "DELETE FROM cus_mst WHERE CUST_CODE = ?";
  connection.query(sql, [req.params.id], function (err, result) {
    if (err) throw err;
    //  console.log("Number of records deleted: " + result.affectedRows);
  });
});
//Cmp Name
app.get("/api/cmpname", function (req, res) {
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
app.get("/api/itemlst/:catg", function (req, res) {
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

app.get("/api/itmlst", function (req, res) {
  //console.log(catg)
  //const tableName= 'ITEM_MST';
  connection.query(
    "select LOC_CODE, ITEM_CODE , ITEM_NAME1,ARTICLE_CODE,OP_STOCK, CL_STOCK, ITEM_UNIT, CAT_CODE, SUB_CAT, BRAND, cl_stock," +
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


app.get("/api/items/:id", function (req, res) {

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
app.get("/api/stkval/:reptp", async function (req, res) {
  const endDt = req.query.end_date;
  const catCode = req.query.ItemCat || null;  // ✅ optional filter
  const repType = req.params.reptp;
  console.log('api = stkval  **** enddate =', endDt, ' cat_code =', catCode, 'repType=', repType);

  try {
    // Step 1: Get items with stock
    const stockSql = `
      SELECT 
        a.LOC_CODE,
        a.ITEM_CODE,
        a.ITEM_NAME1,
        a.ITEM_UNIT,
        a.CAT_CODE,
        IFNULL(SUM(s.qty), 0) AS CL_STOCK
      FROM item_mst AS a
      LEFT JOIN stock_trans AS s ON a.item_code = s.item_code
      WHERE (? IS NULL OR a.CAT_CODE = ?)    -- ✅ optional cat_code filter
      GROUP BY a.LOC_CODE, a.ITEM_CODE, a.ITEM_NAME1, a.ITEM_UNIT, a.CAT_CODE
      HAVING CL_STOCK <> 0
      ORDER BY a.ITEM_NAME1
    `;

    const [stockResults] = await connection.promise().query(stockSql, [catCode, catCode]);
    if (!stockResults.length) return res.json([]);
    if (repType === "STKVAL") {
      // Step 2: Call avgcost only for filtered items that have stock
      const costSql = `
      SELECT 
        item_code,
        loc_code,
        avgcost(loc_code, item_code, ?) AS unit_cost
      FROM item_mst
      WHERE item_code IN (?)
      AND (? IS NULL OR CAT_CODE = ?)        -- ✅ optional cat_code filter
    `;

      const itemCodes = [...new Set(stockResults.map((r) => r.ITEM_CODE))];
      const [costResults] = await connection.promise().query(costSql, [endDt, itemCodes, catCode, catCode]);

      // Step 3: Merge in JS
      const costMap = {};
      costResults.forEach((r) => {
        costMap[`${r.loc_code}_${r.item_code}`] = r.unit_cost;
      });

      const finalData = stockResults.map((row) => {
        const unitCost = costMap[`${row.LOC_CODE}_${row.ITEM_CODE}`] || 0;
        return {
          ...row,
          UNIT_COST: unitCost,
          AMOUNT: Math.round(row.CL_STOCK * unitCost * 100) / 100,
        };
      });

      res.json(finalData);
    } else {
      res.json(stockResults);
    }
  } catch (error) {
    console.error("Error in /api/stkval:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/stkledOp/:id/:stdt", function (req, res) {
  console.log('stkledOp===>', req.params.id)
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

app.get("/api/stkled/:id/:stdt/:enddt", function (req, res) {

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
app.delete("/api/itemdel/:itmcd", function (req, res, next) {
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


app.get("/api/itmscatlst", function (req, res) {
  //tableName ='ITEM_SUBCAT';
  connection.query(
    "select a.CAT_CODE, b.CAT_NAME, a.SUB_CAT_CODE, a.SUB_CAT_NAME" +
    " from item_subcat a LEFT OUTER JOIN cat_mst b ON b.CAT_CODE = a.CAT_CODE",

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

app.get("/api/lpoitems/:po", function (req, res) {
  console.log("LPO No=");
  console.log(req.params.po);

  connection.query(
    "select LPO_NO,JOB_NO,SR_NO,MAIN_SR_NO,ITEM_CODE , ITEM_NAME , QTY, UNIT ,RATE ," +
    " round(qty*rate,2) AMOUNT" +
    " FROM lpo_items WHERE LPO_NO =? order by sr_no",
    [req.params.po],

    function (error, results) {
      if (error) throw error;
      res.json(results);
      console.log('Lpo_items ==>', results);
    }
  );
});

//lpoNet
app.get("/api/lponet/:po", function (req, res) {
  // console.log(req.params)

  connection.query(
    "select a.LPO_NO,DATE_FORMAT(a.LPO_DATE,'%d/%m/%Y') LPO_DATE,a.SUP_CODE ,b.SUP_NAME ," +
    " a.AMOUNT, a.VAT_PERC, a.VAT_AMOUNT,a.NARRATION, " +
    "a.REQ_NO,a.PLACE_DLV , a.ATTN ,a.DATE_REQ ,a.SMAN_CODE, a.SUPP_REF_NO , a.PAY_TERMS  , a.DELIVERY_REQ ," +
    " a.LPO_APPROVED,  a.APPROVED_BY  ,a.DISCOUNT  " +
    " FROM lpo_net a LEFT OUTER JOIN sup_mst b on (a.SUP_CODE=b.SUP_CODE) WHERE LPO_NO =?",
    [req.params.po],

    function (error, results, fields) {
      if (error) throw error;
      res.json(results);
      // console.log("LPONET ->",results);
    }
  );
});

app.put("/api/lpoitemsput/:id", function (req, res, next) {
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
app.put("/api/lpohdrput/:id", function (req, res, next) {
  let lpoitem = req.body;
  console.log("LPO No -Put- Update", lpoitem);

  var pool = orcl1.getPool();
  pool.getConnection(function (err, conn) {
    //console.log("LPO Items Update on Server *1 " + lpoitem[0].LPO_NO+" - " +lpoitem[0].SR_NO+ " * 1st ");
    conn.execute(
      "UPDATE LPO_NET SET   SUP_CODE =:1, NARRATION =:2," +
      " AMOUNT =:3, DISCOUNT = :4,  PLACE_DLV = :5, ATTN=:6 ,SMAN_CODE=:7" +
      " where LPO_NO =:7 ",
      [
        lpoitem.SupCd,
        lpoitem.Narration,
        lpoitem.netAmt,
        lpoitem.discount,
        lpoitem.placedlv,
        lpoitem.Attn,
        lpoitem.LpoNo,
        lpoitem.Smancd,
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
app.put("/api/rvtranacc/:dat", function (req, res, next) {
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
app.delete("/api/rvdelrow", function (req, res, next) {
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
app.put("/api/rvinvstl/:dat", function (req, res, next) {
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
app.put("/api/sivhdrupd/:hdr", function (req, res, next) {
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
app.post("/api/invitmupd/:id", function (req, res, next) {
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

app.put("/api/updateInvoice", (req, res) => {
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
app.put("/api/sivitmupd/:dat", function (req, res, next) {
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

//
//SRV - Start
// app.put('/sivhdrupd/:hdr', function (req, res, next) {
app.put("/api/srvhdrupd/:hdr", function (req, res, next) {
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


app.get("/api/jobcard/:jobNo", function (req, res) {
  // console.log("Job list ");
  const query = `
            SELECT 
                JOB_NO,
                PROJ_NAME,
                START_DATE,
                CUST_CODE,
                LPO_NO,
                LPO_DATE,
                CONTRACT_AMT,
                DESIGNER,
                DURATION,
                COMMISSION_DATE,
                PLACE_OF_DLV,
                MEANS_TRANSPORT,
                MEANS_PAYMENTS,
                CONTACT_PER,
                CONTACT_NO,
                ALLOTTED_MAT_COST,
                COMMISSION_AMT,
                CLOSED_DATE,
                QUOT_REF,
                REVISION_NO,
                VAT_PERC,
                CONSULTANT,
                SMAN_CODE,
                DATE_OF_APPROVAL
            FROM job_card
            WHERE JOB_NO = ?
        `;
  connection.query(query, [req.params.jobNo],

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

app.get("/api/jobanalysis", function (req, res) {
  // console.log("Job list ");
  const { start_date, end_date } = req.query;
  const query = `SELECT 
    a.JOB_NO,
    DATE_FORMAT(b.START_DATE, '%d/%m/%y') AS START_DATE,
    a.PROJ_NAME,
    b.CONTRACT_AMT AS CONTRACT_AMOUNT,
    c.CUST_NAME,
    a.SALES,
    a.MATERIAL,
    a.LABOUR,
    a.OTHERS,
    (COALESCE(a.MATERIAL,0)+ COALESCE(a.LABOUR,0)+ COALESCE(a.OTHERS,0)) TOTAL_COST,
    a.PROFIT,
    COALESCE(x.AMT, 0) AS COLLECTION,
    a.SALES - COALESCE(x.AMT, 0) AS OUTSTANDING,
    COALESCE(a.MATERIAL, 0) + COALESCE(a.LABOUR, 0) + COALESCE(a.OTHERS, 0) AS EXPENSES
FROM v_job_profit_analysis_table AS a
JOIN job_card AS b ON a.job_no = b.job_no
LEFT OUTER JOIN cus_mst c ON b.CUST_CODE = c.CUST_CODE
LEFT JOIN (
    SELECT 
        b.JOB_NO,
        SUM(l.stld_amt) AS AMT
    FROM adj_dtl l
    LEFT JOIN fab_inv_hdr b ON l.stld_doc = b.inv_no
    WHERE l.stld_type IN ('06')
    GROUP BY b.JOB_NO
) AS x ON x.JOB_NO = a.JOB_NO
WHERE b.start_date BETWEEN ? AND ?
ORDER BY a.job_no DESC;
        `;
  connection.query(query, [start_date, end_date],

    function (error, result) {
      if (error) {
        throw error;
      } else {
        console.log("Job profit analysis :", result);
        res.json(result);

      }
    }
  );
});


app.get("/api/jobreg", function (req, res) {
  // console.log("Job list ");
  const { start_date, end_date } = req.query;
  const query = `
            SELECT 
                JOB_NO,
                PROJ_NAME,
                DATE_FORMAT(START_DATE,'%d/%m/%y') AS START_DATE,
                job_card.CUST_CODE,
                CUST_NAME,
                LPO_NO,
                DATE_FORMAT(LPO_DATE,'%d/%m/%y')  AS LPO_DATE,
                CONTRACT_AMT,
                DESIGNER,
                DURATION,
                COMMISSION_DATE,
                PLACE_OF_DLV,
                MEANS_TRANSPORT,
                MEANS_PAYMENTS,
                CONTACT_PER,
                CONTACT_NO,
                ALLOTTED_MAT_COST,
                COMMISSION_AMT,
                CLOSED_DATE,
                QUOT_REF,
                REVISION_NO,
                VAT_PERC,
                CONSULTANT,
                job_card.SMAN_CODE,
                DATE_OF_APPROVAL
            FROM job_card left outer join cus_mst on (JOB_CARD.cust_code = cus_mst.CUST_CODE)
            where job_card.start_date between  ? and ?
            order by job_no desc
        `;
  connection.query(query, [start_date, end_date],

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

app.get("/api/joblst", function (req, res) {
  // console.log("Job list ");

  connection.query(
    `select  a.JOB_NO, a.PROJ_NAME, DATE_FORMAT(a.START_DATE,'d%m%Y') AS START_DATE, a.LPO_NO,
    DATE_FORMAT(a.LPO_DATE,'d%m%Y') AS LPO_DATE ,a.CUST_CODE, a.MEANS_PAYMENTS, a.CONTACT_PER, a.MEANS_TRANSPORT ,
     a.PLACE_OF_DLV , a.SMAN_CODE FROM job_card as a  ORDER BY a.JOB_NO DESC;`,

    function (error, result) {
      if (error) {
        throw error;
      } else {
        console.log("joblst==>", result);
        res.json(result);

      }
    }
  );
});

app.get("/api/jobstatlst", function (req, res) {
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
app.get("/api/jobstatmst/:id", function (req, res) {
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
app.get("/api/vchrlst/:tranId", function (req, res) {
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
          console.log("Vchr list", result);
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
//app.get('/LedOp/:acode/:stdt', function (req, res) {
app.get('/api/ledBal/:acode/:stdt', function (req, res) {
  const acCode = req.params.acode;
  const stDt = req.params.stdt;

  console.log('Leddsp O/P Bal ', acCode, stDt);
  connection.query("SELECT " +
    "SUM(CASE WHEN db_cr = 'D' THEN AMOUNT ELSE AMOUNT * -1 END) AS BAL " + // ← removed comma
    "FROM tran_acc WHERE ACC_CODE = ? AND DATTE <= ?",
    [acCode, stDt],
    function (error, result) {
      if (error) {
        console.log("Ledger  bal.data select error", error);
        res.status(500).send("Server error - select st. for ledger OP Bal");
      } else {
        console.log(result);
        res.json(result);
      }
    });
}
);

app.get('/api/LedOp/:acode/:stdt', function (req, res) {
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

app.get('/api/Leddsp/:acode/:stdt/:enddt', function (req, res) {
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
app.get('/api/Tbal/:dt', function (req, res) {
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
app.get('/api/PandL/:dt', function (req, res) {
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
app.get('/api/Blsht/:dt', function (req, res) {
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


app.get('/api/supbal', function (req, res) {
  //  const acCode = req.params.acode;
  const { end_date } = req.query;

  console.log('Sup.Leddsp  Bal ', end_date);
  connection.query(
    "SELECT SUP_CODE, SUP_NAME, BALANCE, " +
    "CASE WHEN BALANCE > 0 THEN BALANCE ELSE 0 END AS DR_BALANCE, " +
    "CASE WHEN BALANCE < 0 THEN ABS(BALANCE) ELSE 0 END AS CR_BALANCE " +
    "FROM ( " +
    "  SELECT b.SUP_CODE, b.SUP_NAME, " +
    "  SUM(CASE WHEN db_cr = 'D' THEN AMOUNT ELSE AMOUNT * -1 END) AS BALANCE " +
    "  FROM tran_acc a JOIN sup_mst b ON a.ACC_CODE = b.SUP_CODE " +
    "  WHERE DATTE < ? " +
    "  GROUP BY b.SUP_CODE, b.SUP_NAME " +
    ") AS summary ORDER BY SUP_CODE",
    [end_date],

    function (error, result) {
      if (error) {
        console.log("Sup.Bal Select error", error);
        res.status(500).send("Server error - select Sup.Bal");
      } else {
        console.log(result);
        res.json(result);
      }
    });
}
);
app.get("/api/tranlst", function (req, res) {
  const { ItemCd, start_date, end_date } = req.query; // <-- ✅ Extract from query string

  console.log('params =', req.params);       // { tranId: 'something' }
  console.log('query  =', req.query);        // { start_date: '2024-01-01', end_date: '2024-01-31' }

  connection.query(
    "SELECT TRAN_TYPE, VCHR_NO, DATE_FORMAT(DATTE,'%d/%m/%Y') AS DATTE, ACC_CODE,AC_HEAD, AMOUNT," +
    "IF(DB_CR='D', AMOUNT, 0) AS DR_AMOUNT, " +
    "IF(DB_CR='C', AMOUNT, 0) AS CR_AMOUNT, " +
    "DB_CR, NARRATION1, NARRATION2, JOB_NO " +
    "FROM tran_acc " +
    " JOIN  ac_list   on ac_code = acc_code " +
    " WHERE TRAN_TYPE = ? AND DATTE BETWEEN ? AND ? " +
    " ORDER BY VCHR_NO , db_cr desc",
    [ItemCd, start_date, end_date],
    function (error, result) {
      if (error) {
        throw error;
      } else {
        res.json(result);
      }
    }
  );

});
app.get("/api/trnprn/:tranId/:Vchr", function (req, res) {
  const { VchrNo } = req.query; // <-- ✅ Extract from query string

  console.log('params =', req.params);       // { tranId: 'something' }
  console.log('query  =', req.query);        // { start_date: '2024-01-01', end_date: '2024-01-31' }

  connection.query(
    "SELECT a.TRAN_TYPE, a.VCHR_NO, DATE_FORMAT(a.DATTE,'%d/%m/%Y') AS DATTE, a.ACC_CODE,b.AC_HEAD, a.AMOUNT," +
    "IF(a.DB_CR='D', a.AMOUNT, 0) AS AMOUNT_DR, " +
    "IF(a.DB_CR='C', a.AMOUNT, 0) AS AMOUNT_CR, " +
    "a.DB_CR, a.NARRATION1, a.NARRATION2, a.JOB_NO " +
    "FROM tran_acc a, AC_List b WHERE a.TRAN_TYPE = ? AND a.VCHR_NO = ? " +
    "  and a.ACC_CODE = b.AC_CODE ORDER BY a.SR_NO ",
    [req.params.tranId, req.params.Vchr],
    function (error, result) {
      if (error) {
        throw error;
      } else {
        res.json(result);
      }
    }
  );

});


app.get('/api/JobLeddsp/:jobNo/:stdt/:enddt', function (req, res) {
  const jobNo = req.params.jobNo;
  const stDt = req.params.stdt;
  const endDt = req.params.enddt;
  console.log('Leddsp', jobNo, stDt, endDt);
  connection.query("select DOC_TYPE AS TRAN_TYPE ,DOC_NO AS VCHR_NO, DATE_FORMAT(DOC_DATE,'%d/%m/%Y') AS DATTE,JOB_NO, NARRATION1, CUST_CODE, " +
    " ITEM_DESC, QTY, UNIT_RATE, " +
    "  INCOME AS AMOUNT_DR ," +
    " EXPENSES AS AMOUNT_CR FROM v_job_ledger WHERE JOB_NO = ? AND " +
    " DOC_DATE BETWEEN ? AND ? ORDER BY DATE_FORMAT(DOC_DATE,'%Y/%m/%d'), DOC_TYPE ,DOC_NO ", [jobNo, stDt, endDt],
    function (error, result) {
      if (error) {
        console.log(" Job Ledger data select error", error);
        res.status(500).send("Server error - select st. for Job-ledger");
      } else {
        console.log(result);
        res.json(result);
      }

    }
  );
});


//
app.get("/api/pcashlst/:id", function (req, res) {
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
app.get("/api/pdcrcdreg", function (req, res) {

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
app.get("/api/pdcrcdlst/:dys", function (req, res) {

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

app.get("/api/pdcRcdBal/:cus", function (req, res) {

  connection.query(
    "select CUST_CODE, SUM(AMOUNT)  AS BAL " +
    " FROM pdc_rcd  where  CUST_CODE = ? and  REALISED='Y' ",
    [req.query.cus],
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
app.get("/api/pdcisulst/:dys", function (req, res) {

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

//Jv Routes
const jvRoutes = require('./JvExcelEntryRoutes');
app.use('/api/jv', jvRoutes);

//RV Routes
const rvXlRoutes = require('./rv_excel_api');
const rvBuildRoute = require('./build_rv_excel');
app.use('/api', rvXlRoutes);
app.use('/api', rvBuildRoute);

//PV Excel
//const pvXlRoutes=require('./pv_excel_api.js');
//app.use('/api',pvXlRoutes);
//const pvBuildRoutes = require('./build_pv_excel');
//app.use('/api',pvBuildRoutes);

//
const pvXlRoutes = require('./pv_excel_api');
const pvBuildRoute = require('./build_pv_excel');
app.use(pvXlRoutes);              // routes already include /api/
app.use('/api', pvBuildRoute);    // exposes POST /api/build-pv-excel
//
const bnkRecoRoutes = require('./bankRecoRoutes');
app.use( bnkRecoRoutes);

//
//const payChqApi = require("./routes/pay_chq_batch_api");
const payChqApi = require("./pay_chq_batch_api");
app.use("/pdc_batch", payChqApi);
app.use("/pay_chq",   payChqApi.chqRouter);

