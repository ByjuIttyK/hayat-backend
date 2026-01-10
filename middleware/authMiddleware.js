require("dotenv").config();
const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET;
//secret key above 
// generate by :
// // c:> node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ message: "Token missing" });
  }

  const token = authHeader.split(" ")[1]; // Bearer TOKEN

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // store user info
    next(); // allow API
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }
}

module.exports = authMiddleware;
