/** Пароли (scrypt), токены сессий, middleware авторизации. */
const crypto = require('node:crypto');
const db = require('./db');

const MIN_PASSWORD = 4;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(candidate, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function createSession(userId) {
  const token = newToken();
  await db.query('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, userId]);
  return token;
}

async function userFromToken(token) {
  if (!token) return null;
  const row = await db.one(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1`,
    [token],
  );
  return row || null;
}

function bearer(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

/** Обязательная авторизация. */
async function auth(req, res, next) {
  try {
    const user = await userFromToken(bearer(req));
    if (!user) return res.status(401).json({ error: 'Требуется авторизация' });
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** Мягкая авторизация: req.user заполняется, если токен валиден, иначе null. */
async function optionalAuth(req, res, next) {
  try {
    req.user = await userFromToken(bearer(req));
    next();
  } catch (err) {
    next(err);
  }
}

function adminOnly(req, res, next) {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'owner')) {
    return res.status(403).json({ error: 'Доступно только менеджеру' });
  }
  next();
}

function ownerOnly(req, res, next) {
  if (!req.user || req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Доступно только владельцу' });
  }
  next();
}

module.exports = {
  MIN_PASSWORD,
  hashPassword,
  verifyPassword,
  createSession,
  userFromToken,
  auth,
  optionalAuth,
  adminOnly,
  ownerOnly,
};
