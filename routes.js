const crypto = require('node:crypto');
const { db, getUserByPhone, getUserById, getCompanyById } = require('./db');
const { sendTelegramReceipt } = require('./telegram');

const TZ = 'Asia/Tashkent';
const CUT_OFF_HOUR = 10;
const MAX_SCHEDULE_DAYS = 90;
const MIN_PASSWORD = 4;

// ── Утилиты ────────────────────────────────────────────────────────

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

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
  const [year, month, day] = v.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
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

function setCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM menu_sets').get().c;
}

function getSet(id) {
  return db.prepare('SELECT * FROM menu_sets WHERE id = ?').get(id);
}

/** Сет по умолчанию для даты — та же «порядковая» ротация, что и на фронтенде: от 1-го числа текущего месяца → (ordinal-1) % N + 1. */
function defaultSetForDate(dateStr) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = new Date(y, m - 1, d);
  const ordinal = Math.floor((target.getTime() - monthStart.getTime()) / 86400000) + 1;
  const n = setCount();
  const idx = ((ordinal - 1) % n + n) % n;
  return getSet(idx + 1);
}

function makeCompanyCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ123456789';
  let code = '';
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (db.prepare('SELECT 1 FROM companies WHERE code = ?').get(code));
  return code;
}

function companyByCode(code) {
  return db.prepare('SELECT * FROM companies WHERE code = ?').get(String(code || '').trim().toUpperCase());
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

function employeesCount(companyId) {
  return db.prepare("SELECT COUNT(*) AS c FROM users WHERE company_id = ? AND role = 'employee'").get(companyId).c;
}

function createSession(userId) {
  const token = newToken();
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  return token;
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' });
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return res.status(401).json({ error: 'Сессия недействительна' });
  const user = getUserById(session.user_id);
  if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
  req.user = user;
  req.token = token;
  next();
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Доступно только менеджеру' });
  next();
}

function requireFields(res, body, fields) {
  for (const field of fields) {
    if (!body || typeof body[field] !== 'string' || body[field].trim().length === 0) {
      res.status(400).json({ error: `Поле "${field}" обязательно` });
      return false;
    }
  }
  return true;
}

/** Финальный план дня: все сотрудники компании, запланированные на дату, с их выбором; невыбравшие получают сет-дефолт. */
function dayPlan(companyId, date) {
  const employees = db.prepare("SELECT id, name FROM users WHERE company_id = ? AND role = 'employee' ORDER BY name").all(companyId);
  const scheduled = new Set(db.prepare('SELECT user_id FROM schedule WHERE date = ?').all(date).map(r => r.user_id));
  const choiceRows = db.prepare('SELECT * FROM choices WHERE date = ?').all(date);
  const choiceMap = new Map(choiceRows.map(c => [c.user_id, c]));

  const rows = [];
  const bySet = new Map();
  for (const emp of employees) {
    if (!scheduled.has(emp.id)) continue;
    const ch = choiceMap.get(emp.id);
    let setId;
    let fromDefault = false;
    if (ch) {
      setId = ch.set_id;
    } else {
      setId = defaultSetForDate(date).id;
      fromDefault = true;
    }
    const set = getSet(setId);
    rows.push({ employeeId: emp.id, employeeName: emp.name, set, chosen: Boolean(ch), fromDefault });
    const agg = bySet.get(setId) || { setId, setName: set.name, setPrice: set.price, count: 0, defaults: 0, employees: [] };
    agg.count += 1;
    if (fromDefault) agg.defaults += 1;
    agg.employees.push(emp.name);
    bySet.set(setId, agg);
  }

  const confirmed = Boolean(db.prepare('SELECT 1 FROM confirmed_days WHERE company_id = ? AND date = ?').get(companyId, date));
  const locked = confirmed || isLockedDate(date);
  const perSet = [...bySet.values()].sort((a, b) => b.count - a.count);

  return {
    date,
    locked,
    confirmed,
    totalEmployees: employees.length,
    scheduled: rows.length,
    unpicked: rows.filter(r => !r.chosen).length,
    totalSum: rows.reduce((s, r) => s + r.set.price, 0),
    perSet,
    rows,
  };
}

// ── Роуты ──────────────────────────────────────────────────────────

function register(app) {
  // Регистрация: с companyCode — сотрудник в существующую компанию; без — создание компании + менеджер (admin).
  app.post('/api/auth/register', (req, res) => {
    const { name, phone, password, companyName, companyCode, companySize } = req.body || {};
    if (!requireFields(res, { name, phone, password }, ['name', 'phone', 'password'])) return;
    if (password.length < MIN_PASSWORD) {
      return res.status(400).json({ error: `Пароль должен быть не короче ${MIN_PASSWORD} символов` });
    }
    if (getUserByPhone(String(phone).trim())) {
      return res.status(409).json({ error: 'Телефон уже зарегистрирован' });
    }

    let company;
    let role = 'employee';
    if (companyCode) {
      company = companyByCode(companyCode);
      if (!company) return res.status(400).json({ error: 'Неверный код команды' });
    } else {
      if (!requireFields(res, { companyName }, ['companyName'])) return;
      const code = makeCompanyCode();
      const size = Number.isInteger(companySize) && companySize > 0 ? companySize : null;
      db.prepare('INSERT INTO companies (code, name, size) VALUES (?, ?, ?)').run(code, companyName.trim(), size);
      company = getCompanyById(db.prepare('SELECT id FROM companies ORDER BY id DESC LIMIT 1').get().id);
      role = 'admin';
    }

    const passwordHash = hashPassword(password);
    const userRes = db.prepare('INSERT INTO users (company_id, role, name, phone, password_hash) VALUES (?, ?, ?, ?, ?)')
      .run(company.id, role, name.trim(), phone.trim(), passwordHash);
    const user = getUserById(userRes.lastInsertRowid);
    const token = createSession(user.id);

    res.status(201).json({ token, user: publicUser(user, company) });
  });

  app.post('/api/auth/login', (req, res) => {
    const { phone, password } = req.body || {};
    if (!requireFields(res, { phone, password }, ['phone', 'password'])) return;
    const user = getUserByPhone(String(phone).trim());
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Неверный телефон или пароль' });
    }
    const company = getCompanyById(user.company_id);
    const token = createSession(user.id);
    res.json({ token, user: publicUser(user, company) });
  });

  app.get('/api/me', auth, (req, res) => {
    const company = getCompanyById(req.user.company_id);
    res.json({ user: publicUser(req.user, company), employeesCount: employeesCount(company.id) });
  });

  // ── Сотрудник: расписание (токены) ───────────────────────────────
  app.get('/api/my/days', auth, (req, res) => {
    const days = db.prepare('SELECT date FROM schedule WHERE user_id = ? ORDER BY date').all(req.user.id).map(r => r.date);
    const choiceRows = db.prepare('SELECT * FROM choices WHERE user_id = ?').all(req.user.id);
    const choiceMap = new Map(choiceRows.map(c => [c.date, c]));
    res.json({
      days: days.map(date => {
        const ch = choiceMap.get(date);
        const def = defaultSetForDate(date);
        return {
          date,
          locked: isLockedDate(date),
          choice: ch ? { setId: ch.set_id, setName: ch.set_name, setPrice: ch.set_price } : null,
          defaultSet: { setId: def.id, setName: def.name, setPrice: def.price },
        };
      }),
    });
  });

  app.put('/api/my/days', auth, (req, res) => {
    const { dates } = req.body || {};
    if (!Array.isArray(dates)) return res.status(400).json({ error: 'Поле "dates" должно быть массивом' });
    const clean = [...new Set(dates)].sort();
    for (const date of clean) {
      if (!isScheduleDateOk(date)) {
        return res.status(400).json({ error: `Дата "${date}" недоступна для расписания` });
      }
    }

    const add = db.prepare('INSERT OR IGNORE INTO schedule (user_id, date) VALUES (?, ?)');
    db.exec('BEGIN');
    try {
      for (const date of clean) add.run(req.user.id, date);
      const existing = db.prepare('SELECT date FROM schedule WHERE user_id = ?').all(req.user.id).map(r => r.date);
      const keep = new Set(clean);
      const remove = db.prepare('DELETE FROM schedule WHERE user_id = ? AND date = ?');
      const removeChoice = db.prepare('DELETE FROM choices WHERE user_id = ? AND date = ?');
      for (const date of existing) {
        if (!keep.has(date)) {
          remove.run(req.user.id, date);
          removeChoice.run(req.user.id, date);
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    res.json({ dates: db.prepare('SELECT date FROM schedule WHERE user_id = ? ORDER BY date').all(req.user.id).map(r => r.date) });
  });

  app.put('/api/my/days/:date/choice', auth, (req, res) => {
    const date = req.params.date;
    if (!isDateString(date)) return res.status(400).json({ error: 'Поле "date" неверного формата' });
    if (isLockedDate(date)) return res.status(409).json({ error: 'Этот день уже закрыт для выбора' });
    const scheduled = db.prepare('SELECT 1 FROM schedule WHERE user_id = ? AND date = ?').get(req.user.id, date);
    if (!scheduled) return res.status(400).json({ error: 'День не в вашем расписании' });

    const setId = Number((req.body || {}).setId);
    const set = setCount() && Number.isInteger(setId) ? getSet(setId) : null;
    if (!set) return res.status(400).json({ error: 'Сет не найден' });

    db.prepare('INSERT INTO choices (user_id, date, set_id, set_name, set_price) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET set_id=excluded.set_id, set_name=excluded.set_name, set_price=excluded.set_price, updated_at=datetime(\'now\')')
      .run(req.user.id, date, set.id, set.name, set.price);
    res.json({ date, choice: { setId: set.id, setName: set.name, setPrice: set.price } });
  });

  // ── Менеджер: сводка и подтверждение ─────────────────────────────
  app.get('/api/manager/dates', auth, adminOnly, (req, res) => {
    const rows = db.prepare(`
      SELECT s.date, COUNT(*) AS scheduled
      FROM schedule s
      JOIN users u ON u.id = s.user_id
      WHERE u.company_id = ? AND s.date >= ?
      GROUP BY s.date
      ORDER BY s.date
      LIMIT 90
    `).all(req.user.company_id, todayTz());

    const confirmed = new Set(db.prepare('SELECT date FROM confirmed_days WHERE company_id = ?').all(req.user.company_id).map(r => r.date));
    res.json({
      dates: rows.map(r => ({
        date: r.date,
        scheduled: r.scheduled,
        locked: isLockedDate(r.date) || confirmed.has(r.date),
        confirmed: confirmed.has(r.date),
      })),
    });
  });

  app.get('/api/manager/report', auth, adminOnly, (req, res) => {
    const date = req.query.date;
    if (!date) return res.status(400).json({ error: 'Укажите параметр date=YYYY-MM-DD' });
    if (!isDateString(date)) return res.status(400).json({ error: 'Дата должна быть в формате YYYY-MM-DD' });
    res.json(dayPlan(req.user.company_id, date));
  });

  app.post('/api/manager/report/:date/confirm', auth, adminOnly, async (req, res) => {
    const date = req.params.date;
    if (!isDateString(date)) return res.status(400).json({ error: 'Дата должна быть в формате YYYY-MM-DD' });
    if (isLockedDate(date)) return res.status(409).json({ error: 'Этот день уже закрыт' });
    const already = db.prepare('SELECT 1 FROM confirmed_days WHERE company_id = ? AND date = ?').get(req.user.company_id, date);
    if (already) return res.status(409).json({ error: 'День уже подтверждён' });

    const plan = dayPlan(req.user.company_id, date);
    db.prepare('INSERT INTO confirmed_days (company_id, date, confirmed_by) VALUES (?, ?, ?)').run(req.user.company_id, date, req.user.id);

    const company = getCompanyById(req.user.company_id);
    const fmt = x => x.split('-').reverse().join('.');
    const lines = plan.perSet.map(s => `• ${s.setName} × ${s.count} — ${(s.setPrice * s.count).toLocaleString('ru-RU')} UZS`);
    if (plan.perSet.length === 0) lines.push('— нет запланированных сотрудников');
    const message = [
      '🍱 *Lunchistan — заказ подтверждён*',
      `📅 ${fmt(date)}`,
      `🏢 ${company.name}`,
      '',
      '🍽 Меню:',
      ...lines,
      ...(plan.unpicked > 0 ? [``, `⚠️ Не выбрали (сет по умолчанию): ${plan.unpicked}`] : []),
      '',
      `👥 Запланировано: ${plan.scheduled} порций`,
      `💰 Итого: ${plan.totalSum.toLocaleString('ru-RU')} UZS`,
    ].join('\n');

    let telegramSent = true;
    try {
      const result = await sendTelegramReceipt(message);
      telegramSent = Boolean(result.ok);
    } catch (err) {
      telegramSent = false;
      console.error('Не удалось отправить чек в Telegram:', err.message);
    }

    res.status(201).json({ success: true, telegramSent, plan: dayPlan(req.user.company_id, date) });
  });
}

module.exports = { register, dayPlan };