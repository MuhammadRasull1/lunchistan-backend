/**
 * Слой доступа к БД для Cloudflare Workers — тот же публичный интерфейс
 * (query/one/many/tx), что и в ../../db.js (Render/Node), поэтому lib.js
 * и routes*.js работают без изменений на обеих платформах (см. alias
 * "./db" → этот файл в wrangler.toml).
 *
 * DATABASE_URL читается из process.env — как и остальной общий код
 * (telegram.js, logistics.js, auth.js): с nodejs_compat Workers сам
 * зеркалит переменные/секреты Worker'а в process.env, отдельного моста
 * не нужно (проверено эмпирически 17.09.2026).
 *
 * Драйвер — @neondatabase/serverless: neon() для одиночных запросов (просто
 * HTTP, без установки соединения), Pool (WebSocket) — только там, где нужна
 * настоящая транзакция (BEGIN/COMMIT с несколькими запросами на одном
 * соединении), как в tx().
 *
 * Схема (schema.sql) здесь НЕ мигрируется и НЕ сидируется: Worker работает
 * с той же продовой Neon-базой, что уже мигрирована и заполнена Render'ом.
 */
const { neon, Pool } = require('@neondatabase/serverless');

let connectionString = null;
let sql = null;

function ensureInit() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL не задан в окружении Worker');
  if (url !== connectionString) {
    connectionString = url;
    sql = neon(connectionString);
  }
}

async function query(text, params = []) {
  ensureInit();
  // sql(text, params) — обычный вызов (не тег-темплейт), по умолчанию
  // возвращает массив строк напрямую (fullResults: false).
  const rows = await sql(text, params);
  return { rows };
}

async function one(text, params) {
  const { rows } = await query(text, params);
  return rows[0] || null;
}

async function many(text, params) {
  const { rows } = await query(text, params);
  return rows;
}

function wrapClient(client) {
  return {
    query: (t, p) => client.query(t, p),
    one: async (t, p) => (await client.query(t, p)).rows[0] || null,
    many: async (t, p) => (await client.query(t, p)).rows,
  };
}

/** Транзакция — отдельное WebSocket-соединение на время колбэка (в отличие
 * от query/one/many выше, которые ходят по HTTP без сохранения соединения). */
async function tx(fn) {
  ensureInit();
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  const scoped = wrapClient(client);
  try {
    await client.query('BEGIN');
    const result = await fn(scoped);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

async function ready() {}
async function close() {}

module.exports = {
  ready, query, one, many, tx, close,
  get kind() { return 'neon-http'; },
};
