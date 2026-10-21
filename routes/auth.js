/* API ล๊อกอิน และออก JWT Token */
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../database/db');

const JWT_SECRET = 'YOUR_SECRET_KEY_2026';

// API Login
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare(`
    SELECT u.user_id, u.username, u.password_hash, u.full_name, r.role_code, r.role_name
    FROM users u JOIN roles r ON u.role_id = r.role_id
    WHERE u.username = ? AND u.is_active = 1
  `).get(username);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ message: 'Username หรือ Password ไม่ถูกต้อง' });
  }

  const token = jwt.sign(
    { userId: user.user_id, role: user.role_code, name: user.full_name },
    JWT_SECRET,
    { expiresIn: '8h' }
  );

  res.json({ token, role: user.role_code, name: user.full_name });
});

// Middleware เช็ก Role
const checkRole = (allowedRoles = []) => (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ message: 'No token' });

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role === 'ADMIN' || allowedRoles.includes(decoded.role)) {
      req.user = decoded;
      return next();
    }
    return res.status(403).json({ message: 'ไม่มีสิทธิ์เข้าถึง' });
  } catch (err) {
    return res.status(401).json({ message: 'Token ไม่ถูกต้องหรือหมดอายุ' });
  }
};

module.exports = { router, checkRole };