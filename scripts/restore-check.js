// Проверка бэкапа «туда-обратно»: восстанавливает файл в пустой временный PGlite (TZ=UTC, как сервер)
// и сравнивает КАЖДУЮ ячейку с исходным файлом. Запуск: node scripts/restore-check.js <файл.json.gz>
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const zlib = require('node:zlib');

const file = process.argv[2]; if (!file) { console.error('укажите файл'); process.exit(2); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lu-restore-'));
const env = { ...process.env, TZ: 'UTC', PGLITE_DIR: dir, RESTORE_CONFIRM: 'yes' }; delete env.DATABASE_URL;
execFileSync(process.execPath, [path.join(__dirname, 'restore.js'), file], { env, stdio: 'ignore' });

// значения к общему виду: числа-строки → числа, время → миллисекунды, объекты → JSON
const norm = v => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)) return Date.parse(v);
  return v;
};
const out = execFileSync(process.execPath, ['-e', `
  const db=require(${JSON.stringify(path.join(__dirname, '..', 'db'))});
  (async()=>{await db.ready();const r={};
   for(const {table_name:t} of await db.many("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"))
     r[t]=(await db.many('SELECT row_to_json(x) j FROM "'+t+'" x')).map(y=>y.j);
   process.stdout.write(JSON.stringify(r));await db.close()})()`], { env, maxBuffer: 1 << 28 }).toString();
const got = JSON.parse(out.slice(out.indexOf('{"')));
const want = JSON.parse(zlib.gunzipSync(fs.readFileSync(file))).tables;
let bad = 0;
for (const [t, rows] of Object.entries(want)) {
  const key = r => JSON.stringify(Object.keys(r).sort().map(k => norm(r[k])));
  const a = rows.map(key).sort(), b = (got[t] || []).map(key).sort();
  const miss = a.filter(x => !b.includes(x));
  if (a.length !== b.length || miss.length) { bad++; console.log(`❌ ${t}: в файле ${a.length}, восстановлено ${b.length}, не совпало ${miss.length}`, miss[0] || ''); }
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(bad ? `❌ расхождения в ${bad} таблицах` : `✅ все ${Object.keys(want).length} таблиц совпали по каждой ячейке`);
process.exit(bad ? 1 : 0);
