// Резервная копия боевой базы: все таблицы схемы public → JSON.gz вне репозитория.
// Только чтение (SELECT). Схема восстанавливается из schema.sql, данные — scripts/restore.js.
// Запуск: node scripts/backup.js   (берёт DATABASE_URL из .env)
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const os = require('node:os');
const { Client } = require('pg');

const DIR = process.env.BACKUP_DIR || path.join(os.homedir(), 'lunchistan-backups');
const KEEP = Number(process.env.BACKUP_KEEP || 30);

(async () => {
  const MIN_H = Number(process.env.BACKUP_MIN_HOURS || 0); // для cron: не чаще раза в N часов
  if (MIN_H && fs.existsSync(DIR)) {
    const newest = fs.readdirSync(DIR).filter(f => f.endsWith('.json.gz')).map(f => fs.statSync(path.join(DIR, f)).mtimeMs).sort().pop();
    if (newest && Date.now() - newest < MIN_H * 3600e3) return;
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL не задан');
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'); // согласованный снимок
  const { rows: tables } = await c.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1");
  const dump = { createdAt: new Date().toISOString(), tables: {} };
  for (const { table_name: t } of tables) {
    const { rows } = await c.query(`SELECT * FROM "${t}"`);
    dump.tables[t] = rows;
  }
  await c.query('COMMIT');
  await c.end();

  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const stamp = dump.createdAt.slice(0, 16).replace(/[:T]/g, '-');
  const file = path.join(DIR, `lunchistan-${stamp}.json.gz`);
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(dump)), { mode: 0o600 });

  const old = fs.readdirSync(DIR).filter(f => /^lunchistan-.*\.json\.gz$/.test(f)).sort().reverse().slice(KEEP);
  old.forEach(f => fs.unlinkSync(path.join(DIR, f)));

  const counts = Object.entries(dump.tables).map(([t, r]) => `${t}:${r.length}`).join(' ');
  console.log(`✅ ${file}\n   ${counts}${old.length ? `\n   удалено старых: ${old.length}` : ''}`);
})().catch(e => { console.error('❌ бэкап не удался:', e.message); process.exit(1); });
