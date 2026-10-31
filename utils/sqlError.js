// Turns MySQL errors into a clean HTTP response.
// SIGNAL SQLSTATE '45000' from triggers/procs = business rule -> show message to user.
function sendSqlError(res, err, fallback = 'Save failed') {
  if (err && (err.code === 'ER_SIGNAL_EXCEPTION' || err.sqlState === '45000')) {
    return res.status(422).json({ success: false, userError: true, message: err.sqlMessage });
  }
  if (err && err.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ success: false, userError: true, message: 'Duplicate entry: ' + err.sqlMessage });
  }
  console.error(err);
  return res.status(500).json({ success: false, message: err?.sqlMessage || err?.message || fallback });
}
module.exports = { sendSqlError };