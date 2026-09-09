/**
 * Слой доступа к данным. Один интерфейс — два драйвера:
 *  - production: PostgreSQL (Neon) через `pg`, если задан DATABASE_URL;
 *  - локально/дев: встроенный PGlite (Postgres в процессе Node), файл в ./.pglite.
 *
 * Диалект SQL одинаковый (Postgres), поэтому запросы в routes.* не зависят от драйвера.
 */
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const SEED_SETS_PATH = path.join(__dirname, 'seed_sets.json');

let driver = null;          // { query(text, params), connect?(), end() }
let kind = null;            // 'pg' | 'pglite'
let readyPromise = null;

async function build() {
  const url = process.env.DATABASE_URL;

  if (url) {
    const { Pool } = require('pg');
    const needSsl = !/localhost|127\.0\.0\.1/.test(url);
    const pool = new Pool({
      connectionString: url,
      ssl: needSsl ? { rejectUnauthorized: false } : false,
      max: Number(process.env.PG_POOL_MAX || 5),
      idleTimeoutMillis: 30000,
    });
    kind = 'pg';
    driver = {
      query: (text, params) => pool.query(text, params),
      exec: (sql) => pool.query(sql),           // многооператорный скрипт (simple protocol)
      connect: () => pool.connect(),
      end: () => pool.end(),
    };
  } else {
    const { PGlite } = require('@electric-sql/pglite');
    const dir = process.env.PGLITE_DIR || path.join(__dirname, '.pglite');
    const pg = new PGlite(dir);
    await pg.waitReady;
    kind = 'pglite';
    driver = {
      query: (text, params) => pg.query(text, params || []),
      exec: (sql) => pg.exec(sql),
      connect: null,
      end: () => pg.close(),
    };
  }

  await migrate();
  await seed();
  console.log(`🗄  БД готова (${kind === 'pg' ? 'PostgreSQL / Neon' : 'PGlite (локально)'})`);
  return driver;
}

function ready() {
  if (!readyPromise) readyPromise = build();
  return readyPromise;
}

async function migrate() {
  await driver.exec(SCHEMA_SQL);
}

async function seed() {
  // Меню
  const { rows } = await driver.query('SELECT COUNT(*)::int AS c FROM menu_sets');
  if (rows[0].c === 0 && fs.existsSync(SEED_SETS_PATH)) {
    const sets = JSON.parse(fs.readFileSync(SEED_SETS_PATH, 'utf8'));
    for (const s of sets) {
      await driver.query(
        'INSERT INTO menu_sets (id, name, category, price) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING',
        [s.id, s.name, s.category, s.price],
      );
    }
    console.log(`🍱 Загружено меню: ${sets.length} сетов`);
  }

  // Зоны доставки (круги от кухни). Заполняются только при пустой таблице.
  const zones = await driver.query('SELECT COUNT(*)::int AS c FROM delivery_zones');
  if (zones.rows[0].c === 0) {
    const defaults = [
      { name: 'Центр', center_lat: 41.3111, center_lon: 69.2797, radius_m: 3000, price: 10000, min_order: 0, priority: 1 },
      { name: 'Город', center_lat: 41.3111, center_lon: 69.2797, radius_m: 8000, price: 15000, min_order: 0, priority: 2 },
      { name: 'Пригород', center_lat: 41.3111, center_lon: 69.2797, radius_m: 15000, price: 25000, min_order: 0, priority: 3 },
    ];
    for (const z of defaults) {
      await driver.query(
        `INSERT INTO delivery_zones (name, center_lat, center_lon, radius_m, price, min_order, priority)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [z.name, z.center_lat, z.center_lon, z.radius_m, z.price, z.min_order, z.priority],
      );
    }
    console.log('🚚 Зоны доставки: Центр / Город / Пригород');
  }

  // Аккаунт владельца (дядя). Данные — из env, чтобы не хранить в коде.
  const phone = (process.env.OWNER_PHONE || '').trim();
  const password = process.env.OWNER_PASSWORD || '';
  if (phone && password) {
    const existing = await driver.query('SELECT id FROM users WHERE role = $1 LIMIT 1', ['owner']);
    if (existing.rows.length === 0) {
      const { hashPassword } = require('./auth');
      let company = (await driver.query("SELECT id FROM companies WHERE code = 'LUNCHISTAN'")).rows[0];
      if (!company) {
        company = (await driver.query(
          "INSERT INTO companies (code, name) VALUES ('LUNCHISTAN', 'Lunchistan') RETURNING id",
        )).rows[0];
      }
      await driver.query(
        'INSERT INTO users (company_id, role, name, phone, password_hash) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (phone) DO NOTHING',
        [company.id, 'owner', process.env.OWNER_NAME || 'Владелец', phone, hashPassword(password)],
      );
      console.log(`👤 Создан аккаунт владельца: ${phone}`);
    }
  } else {
    console.warn('⚠️  OWNER_PHONE / OWNER_PASSWORD не заданы — аккаунт владельца не создан');
  }
}

// ── Публичный интерфейс ────────────────────────────────────────────
async function query(text, params) {
  await ready();
  return driver.query(text, params);
}

async function one(text, params) {
  const res = await query(text, params);
  return res.rows[0] || null;
}

async function many(text, params) {
  const res = await query(text, params);
  return res.rows;
}

// PGlite имеет одно физическое соединение на процесс: если два tx() выполняются
// конкурентно (обычное дело при await в Node), их BEGIN/COMMIT/ROLLBACK
// перемешиваются на одном соединении — вторая транзакция может закоммититься
// (или откатиться) внутри первой. Нашли на аудите: API успевал ответить
// 201 с orderId, который тут же пропадал при откате параллельной транзакции.
// Лечим сериализацией через цепочку промисов — каждая новая транзакция ждёт
// завершения предыдущей, что бы с ней ни случилось.
let pgliteChain = Promise.resolve();

async function runPgliteTx(fn) {
  const scoped = wrapClient((t, p) => driver.query(t, p || []));
  await driver.query('BEGIN');
  try {
    const result = await fn(scoped);
    await driver.query('COMMIT');
    return result;
  } catch (err) {
    await driver.query('ROLLBACK');
    throw err;
  }
}

/** Транзакция. Колбэк получает { query, one, many } на «своём» соединении. */
async function tx(fn) {
  await ready();

  if (kind === 'pg') {
    const client = await driver.connect();
    const scoped = wrapClient((t, p) => client.query(t, p));
    try {
      await client.query('BEGIN');
      const result = await fn(scoped);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  const result = pgliteChain.then(() => runPgliteTx(fn), () => runPgliteTx(fn));
  pgliteChain = result.catch(() => {}); // не даём упавшей транзакции заблокировать очередь навсегда
  return result;
}

function wrapClient(q) {
  return {
    query: q,
    one: async (t, p) => (await q(t, p)).rows[0] || null,
    many: async (t, p) => (await q(t, p)).rows,
  };
}

async function close() {
  if (driver) await driver.end();
}

module.exports = { ready, query, one, many, tx, close, get kind() { return kind; } };
