/** Пароли (scrypt), токены сессий, middleware авторизации, проверка Telegram initData. */
const crypto = require('node:crypto');
const db = require('./db');

const MIN_PASSWORD = 4;
// Сколько секунд doверяем initData с момента auth_date (Telegram сам не задаёт
// жёсткого лимита — 24ч покрывает обычную сессию TMA, не давая протухшей
// ссылке работать вечно).
const INIT_DATA_MAX_AGE_SEC = Number(process.env.INIT_DATA_MAX_AGE_SEC || 86400);

/**
 * Проверяет подпись Telegram WebApp initData (см. core.telegram.org/bots/webapps).
 * secretKey = HMAC_SHA256("WebAppData", BOT_TOKEN)
 * hash сравнивается с HMAC_SHA256(secretKey, data_check_string).
 * Возвращает { id, username } верифицированного пользователя или null,
 * если подписи нет/не совпала/истекла/не задан TELEGRAM_BOT_TOKEN.
 */
function verifyTelegramInitData(initDataRaw) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || typeof initDataRaw !== 'string' || !initDataRaw) return null;

  let params;
  try {
    params = new URLSearchParams(initDataRaw);
  } catch {
    return null;
  }

  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(computedHash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || Date.now() / 1000 - authDate > INIT_DATA_MAX_AGE_SEC) return null;

  let user;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    return null;
  }
  if (!user || !Number.isInteger(user.id)) return null;

  return { id: user.id, username: typeof user.username === 'string' ? user.username : null };
}

/** Достаёт заголовок с initData (см. lib/telegram.ts на фронте) и верифицирует. */
function verifiedTelegramUserFromRequest(req) {
  const raw = req.headers['x-telegram-init-data'];
  return verifyTelegramInitData(typeof raw === 'string' ? raw : null);
}

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
  verifyTelegramInitData,
  verifiedTelegramUserFromRequest,
};
