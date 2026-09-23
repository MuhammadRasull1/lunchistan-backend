/** Общие утилиты: время Asia/Tashkent, даты, меню, план дня «Команд». */
const db = require('./db');

const TZ = 'Asia/Tashkent';
const CUT_OFF_HOUR = 10;          // заказ/правка на «сегодня» — до 10:00
const MAX_SCHEDULE_DAYS = 90;

function tzNowParts() {
  const s = new Date().toLocaleString('sv-SE', { timeZone: TZ });
  return { date: s.slice(0, 10), time: s.slice(11, 19) };
}
function todayTz() {
  return tzNowParts().date;
}
function nowHourTz() {
  return Number(tzNowParts().time.slice(0, 2));
}

function isDateString(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** День закрыт для изменений: прошлый, либо «сегодня» после 10:00 (Asia/Tashkent). */
function isLockedDate(dateStr) {
  const now = tzNowParts();
  if (dateStr < now.date) return true;
  if (dateStr === now.date) return nowHourTz() >= CUT_OFF_HOUR;
  return false;
}

function maxDateStr() {
  const d = new Date();
  d.setDate(d.getDate() + MAX_SCHEDULE_DAYS);
  return d.toISOString().slice(0, 10);
}
function isScheduleDateOk(dateStr) {
  return isDateString(dateStr) && dateStr >= todayTz() && dateStr <= maxDateStr();
}

/** Нормализация DATE из драйвера (pg отдаёт Date, PGlite — строку/Date) в 'YYYY-MM-DD'. */
function dateKey(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** Границы календарного месяца, которому принадлежит dateStr — период счёта «Кор». */
function monthBounds(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // 0-й день след. месяца = последний день текущего
  return { start, end };
}

async function getSet(id) {
  return db.one('SELECT * FROM menu_sets WHERE id = $1', [id]);
}

/**
 * Блюда, предложенные на конкретную дату (активные, в порядке id). Заменяет
 * прежнюю «ротацию» defaultSetForDate — меню больше не повторяется по кругу,
 * владелец вносит его на каждую дату вручную через /api/owner/daily-menu.
 */
async function dayMenuSets(dateStr) {
  return db.many(
    `SELECT ms.* FROM daily_menu dm JOIN menu_sets ms ON ms.id = dm.set_id
     WHERE dm.date = $1 AND ms.is_active = true ORDER BY ms.id`,
    [dateStr],
  );
}

function publicUser(user, company) {
  return {
    id: user.id,
    role: user.role,
    name: user.name,
    phone: user.phone,
    companyId: user.company_id,
    companyName: company ? company.name : null,
    companyCode: company ? company.code : null,
    companySize: company ? company.size : null,
  };
}

async function employeesCount(companyId) {
  const r = await db.one("SELECT COUNT(*)::int AS c FROM users WHERE company_id = $1 AND role = 'employee'", [companyId]);
  return r ? r.c : 0;
}

async function companyByCode(code) {
  return db.one('SELECT * FROM companies WHERE code = $1', [String(code || '').trim().toUpperCase()]);
}

/** Финальный план дня «Команд»: сотрудники компании, запланированные на дату, + их выбор (невыбравшие → сет-дефолт). */
async function dayPlan(companyId, date) {
  const employees = await db.many(
    "SELECT id, name FROM users WHERE company_id = $1 AND role = 'employee' ORDER BY name",
    [companyId],
  );
  const scheduledRows = await db.many(
    `SELECT s.user_id FROM schedule s JOIN users u ON u.id = s.user_id
     WHERE u.company_id = $1 AND s.date = $2`,
    [companyId, date],
  );
  const scheduled = new Set(scheduledRows.map((r) => r.user_id));
  const choiceRows = await db.many(
    `SELECT c.* FROM choices c JOIN users u ON u.id = c.user_id
     WHERE u.company_id = $1 AND c.date = $2`,
    [companyId, date],
  );
  const choiceMap = new Map(choiceRows.map((c) => [c.user_id, c]));
  const menuSets = await dayMenuSets(date);
  const defaultSet = menuSets[0] ?? null;

  const rows = [];
  const bySet = new Map();
  for (const emp of employees) {
    if (!scheduled.has(emp.id)) continue;
    const ch = choiceMap.get(emp.id);
    let set;
    let fromDefault = false;
    if (ch) {
      set = await getSet(ch.set_id);
    } else {
      set = defaultSet;
      fromDefault = true;
    }
    // Меню на дату ещё не внесено (или сотрудник не выбрал, а дефолта нет) —
    // такая строка не должна попадать в подсчёт сумм/агрегатов по блюдам.
    rows.push({ employeeId: emp.id, employeeName: emp.name, set: set || null, chosen: Boolean(ch), fromDefault });
    if (!set) continue;
    const agg = bySet.get(set.id) || { setId: set.id, setName: set.name, setPrice: set.price, count: 0, defaults: 0, employees: [] };
    agg.count += 1;
    if (fromDefault) agg.defaults += 1;
    agg.employees.push(emp.name);
    bySet.set(set.id, agg);
  }

  const confirmedRow = await db.one(
    'SELECT 1 FROM confirmed_days WHERE company_id = $1 AND date = $2',
    [companyId, date],
  );
  const confirmed = Boolean(confirmedRow);
  const perSet = [...bySet.values()].sort((a, b) => b.count - a.count);

  return {
    date,
    locked: confirmed || isLockedDate(date),
    confirmed,
    totalEmployees: employees.length,
    scheduled: rows.length,
    unpicked: rows.filter((r) => !r.chosen).length,
    totalSum: rows.filter((r) => r.set).reduce((s, r) => s + r.set.price, 0),
    perSet,
    rows,
  };
}

module.exports = {
  TZ, CUT_OFF_HOUR, MAX_SCHEDULE_DAYS,
  tzNowParts, todayTz, nowHourTz,
  isDateString, isLockedDate, isScheduleDateOk, maxDateStr, dateKey, monthBounds,
  getSet, dayMenuSets,
  publicUser, employeesCount, companyByCode,
  dayPlan,
};
