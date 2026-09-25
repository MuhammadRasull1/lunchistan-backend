/**
 * Счётчики попыток в БД (аудит 25.09.2026, В-3/В-5). Раньше счётчик жил в памяти
 * процесса: у каждого изолята Cloudflare Worker он свой и обнуляется при перезапуске,
 * так что лимит «15 попыток за 5 минут» на деле почти ничего не ограничивал.
 * Одна строка на ключ (ip:…, login:…, lead:…), окно фиксированное — сбрасывается,
 * когда истекло.
 */
const db = require('./db');

async function hit(key, windowMs) {
  const now = Date.now();
  const row = await db.one(
    `INSERT INTO rate_limits (key, window_start, n) VALUES ($1, $2, 1)
     ON CONFLICT (key) DO UPDATE SET
       n = CASE WHEN rate_limits.window_start < $3 THEN 1 ELSE rate_limits.n + 1 END,
       window_start = CASE WHEN rate_limits.window_start < $3 THEN $2 ELSE rate_limits.window_start END
     RETURNING n`,
    [key, now, now - windowMs],
  );
  // изредка подчищаем старые строки, чтобы таблица не росла бесконечно
  if (Math.random() < 0.01) {
    db.query('DELETE FROM rate_limits WHERE window_start < $1', [now - 24 * 3600 * 1000]).catch(() => {});
  }
  return Number(row.n);
}

async function peek(key, windowMs) {
  const row = await db.one('SELECT n, window_start FROM rate_limits WHERE key = $1', [key]);
  if (!row || Number(row.window_start) < Date.now() - windowMs) return 0;
  return Number(row.n);
}

async function reset(key) {
  await db.query('DELETE FROM rate_limits WHERE key = $1', [key]);
}

module.exports = { hit, peek, reset };
