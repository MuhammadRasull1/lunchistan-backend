// Восстановление данных из бэкапа scripts/backup.js в базу из DATABASE_URL
// (или в локальный PGlite, если DATABASE_URL пуст). Схему создаёт db.ready() по schema.sql,
// затем таблицы очищаются и заливаются заново. ⚠️ Стирает текущие данные целевой базы.
// Запуск: RESTORE_CONFIRM=yes node scripts/restore.js ~/lunchistan-backups/<файл>.json.gz
const fs = require('node:fs');
const zlib = require('node:zlib');
const db = require('../db');

(async () => {
  const file = process.argv[2];
  if (!file) throw new Error('укажите файл бэкапа');
  if (process.env.RESTORE_CONFIRM !== 'yes') throw new Error('нужно RESTORE_CONFIRM=yes — целевая база будет перезаписана');
  const dump = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
  await db.ready();

  // порядок вставки: родители раньше детей (по внешним ключам)
  const fks = await db.many(`SELECT tc.table_name AS child, ccu.table_name AS parent
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
    WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public'`);
  const tables = Object.keys(dump.tables);
  const order = []; const seen = new Set();
  const visit = (t) => { if (seen.has(t)) return; seen.add(t);
    fks.filter(f => f.child === t && f.parent !== t).forEach(f => visit(f.parent)); if (tables.includes(t)) order.push(t); };
  tables.forEach(visit);

  await db.tx(async (s) => { const q = (t, p) => s.query(t, p);
    await q(`TRUNCATE ${order.map(t => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
    for (const t of order) {
      for (const row of dump.tables[t]) {
        const cols = Object.keys(row);
        const vals = cols.map(k => (row[k] !== null && typeof row[k] === 'object' && !(row[k] instanceof Date)) ? JSON.stringify(row[k]) : row[k]);
        await q(`INSERT INTO "${t}" (${cols.map(k => `"${k}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, vals);
      }
    }
    // счётчики автоинкремента — за максимальный id
    const seqs = await q(`SELECT table_name, column_name, pg_get_serial_sequence('"'||table_name||'"', column_name) AS s
      FROM information_schema.columns WHERE table_schema='public' AND column_default LIKE 'nextval%'`);
    for (const r of (seqs.rows || seqs)) if (r.s) await q(`SELECT setval('${r.s}', GREATEST((SELECT COALESCE(MAX("${r.column_name}"),0) FROM "${r.table_name}"),1))`);
  });
  const counts = [];
  for (const t of order) counts.push(`${t}:${(await db.one(`SELECT count(*)::int AS n FROM "${t}"`)).n}`);
  console.log('✅ восстановлено из', dump.createdAt, '\n  ', counts.join(' '));
  await db.close();
})().catch(e => { console.error('❌ восстановление не удалось:', e.message); process.exit(1); });
