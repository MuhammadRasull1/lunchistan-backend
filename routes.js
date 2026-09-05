/** Контур «Команды»: регистрация/вход, расписание сотрудника, выбор блюд, сводка и подтверждение менеджера. */
const crypto = require('node:crypto');
const db = require('./db');
const { sendTelegramReceipt } = require('./telegram');
const {
  MIN_PASSWORD, hashPassword, verifyPassword, createSession, auth, adminOnly,
} = require('./auth');
const {
  isDateString, isLockedDate, isScheduleDateOk, dateKey,
  setCount, getSet, defaultSetForDate, publicUser, employeesCount, companyByCode,
  todayTz, dayPlan,
} = require('./lib');

function requireFields(res, body, fields) {
  for (const f of fields) {
    if (!body || typeof body[f] !== 'string' || body[f].trim().length === 0) {
      res.status(400).json({ error: `Поле "${f}" обязательно` });
      return false;
    }
  }
  return true;
}

async function makeCompanyCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ123456789';
  for (;;) {
    const code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const exists = await db.one('SELECT 1 FROM companies WHERE code = $1', [code]);
    if (!exists) return code;
  }
}

function register(app) {
  // Регистрация: с companyCode — сотрудник в существующую компанию; без — создание компании + менеджер (admin).
  app.post('/api/auth/register', async (req, res, next) => {
    try {
      const { name, phone, password, companyName, companyCode, companySize } = req.body || {};
      if (!requireFields(res, { name, phone, password }, ['name', 'phone', 'password'])) return;
      if (password.length < MIN_PASSWORD) {
        return res.status(400).json({ error: `Пароль должен быть не короче ${MIN_PASSWORD} символов` });
      }
      if (await db.one('SELECT 1 FROM users WHERE phone = $1', [String(phone).trim()])) {
        return res.status(409).json({ error: 'Телефон уже зарегистрирован' });
      }

      let company;
      let role = 'employee';
      if (companyCode) {
        company = await companyByCode(companyCode);
        if (!company) return res.status(400).json({ error: 'Неверный код команды' });
      } else {
        if (!requireFields(res, { companyName }, ['companyName'])) return;
        const code = await makeCompanyCode();
        const size = Number.isInteger(companySize) && companySize > 0 ? companySize : null;
        company = await db.one(
          'INSERT INTO companies (code, name, size) VALUES ($1,$2,$3) RETURNING *',
          [code, companyName.trim(), size],
        );
        role = 'admin';
      }

      const user = await db.one(
        'INSERT INTO users (company_id, role, name, phone, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [company.id, role, name.trim(), String(phone).trim(), hashPassword(password)],
      );
      const token = await createSession(user.id);
      res.status(201).json({ token, user: publicUser(user, company) });
    } catch (err) { next(err); }
  });

  app.post('/api/auth/login', async (req, res, next) => {
    try {
      const { phone, password } = req.body || {};
      if (!requireFields(res, { phone, password }, ['phone', 'password'])) return;
      const user = await db.one('SELECT * FROM users WHERE phone = $1', [String(phone).trim()]);
      if (!user || !verifyPassword(password, user.password_hash)) {
        return res.status(401).json({ error: 'Неверный телефон или пароль' });
      }
      const company = user.company_id ? await db.one('SELECT * FROM companies WHERE id = $1', [user.company_id]) : null;
      const token = await createSession(user.id);
      res.json({ token, user: publicUser(user, company) });
    } catch (err) { next(err); }
  });

  app.get('/api/me', auth, async (req, res, next) => {
    try {
      const company = req.user.company_id
        ? await db.one('SELECT * FROM companies WHERE id = $1', [req.user.company_id])
        : null;
      res.json({
        user: publicUser(req.user, company),
        employeesCount: company ? await employeesCount(company.id) : 0,
      });
    } catch (err) { next(err); }
  });

  // ── Сотрудник: расписание ───────────────────────────────────────
  app.get('/api/my/days', auth, async (req, res, next) => {
    try {
      const days = (await db.many('SELECT date FROM schedule WHERE user_id = $1 ORDER BY date', [req.user.id]))
        .map((r) => dateKey(r.date));
      const choiceRows = await db.many('SELECT * FROM choices WHERE user_id = $1', [req.user.id]);
      const choiceMap = new Map(choiceRows.map((c) => [dateKey(c.date), c]));

      const out = [];
      for (const date of days) {
        const ch = choiceMap.get(date);
        const def = await defaultSetForDate(date);
        out.push({
          date,
          locked: isLockedDate(date),
          choice: ch ? { setId: ch.set_id, setName: ch.set_name, setPrice: ch.set_price } : null,
          defaultSet: def ? { setId: def.id, setName: def.name, setPrice: def.price } : null,
        });
      }
      res.json({ days: out });
    } catch (err) { next(err); }
  });

  app.put('/api/my/days', auth, async (req, res, next) => {
    try {
      const { dates } = req.body || {};
      if (!Array.isArray(dates)) return res.status(400).json({ error: 'Поле "dates" должно быть массивом' });
      const clean = [...new Set(dates)].sort();
      for (const date of clean) {
        if (!isScheduleDateOk(date)) return res.status(400).json({ error: `Дата "${date}" недоступна для расписания` });
      }

      await db.tx(async (t) => {
        for (const date of clean) {
          await t.query('INSERT INTO schedule (user_id, date) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, date]);
        }
        const existing = (await t.many('SELECT date FROM schedule WHERE user_id = $1', [req.user.id])).map((r) => dateKey(r.date));
        const keep = new Set(clean);
        for (const date of existing) {
          if (!keep.has(date)) {
            await t.query('DELETE FROM schedule WHERE user_id = $1 AND date = $2', [req.user.id, date]);
            await t.query('DELETE FROM choices WHERE user_id = $1 AND date = $2', [req.user.id, date]);
          }
        }
      });

      const result = (await db.many('SELECT date FROM schedule WHERE user_id = $1 ORDER BY date', [req.user.id]))
        .map((r) => dateKey(r.date));
      res.json({ dates: result });
    } catch (err) { next(err); }
  });

  app.put('/api/my/days/:date/choice', auth, async (req, res, next) => {
    try {
      const date = req.params.date;
      if (!isDateString(date)) return res.status(400).json({ error: 'Поле "date" неверного формата' });
      if (isLockedDate(date)) return res.status(409).json({ error: 'Этот день уже закрыт для выбора' });
      const scheduled = await db.one('SELECT 1 FROM schedule WHERE user_id = $1 AND date = $2', [req.user.id, date]);
      if (!scheduled) return res.status(400).json({ error: 'День не в вашем расписании' });

      const setId = Number((req.body || {}).setId);
      const set = Number.isInteger(setId) && (await setCount()) ? await getSet(setId) : null;
      if (!set) return res.status(400).json({ error: 'Сет не найден' });

      await db.query(
        `INSERT INTO choices (user_id, date, set_id, set_name, set_price) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id, date) DO UPDATE SET set_id = EXCLUDED.set_id, set_name = EXCLUDED.set_name,
           set_price = EXCLUDED.set_price, updated_at = now()`,
        [req.user.id, date, set.id, set.name, set.price],
      );
      res.json({ date, choice: { setId: set.id, setName: set.name, setPrice: set.price } });
    } catch (err) { next(err); }
  });

  // ── Менеджер: сводка и подтверждение ────────────────────────────
  app.get('/api/manager/dates', auth, adminOnly, async (req, res, next) => {
    try {
      const rows = await db.many(
        `SELECT s.date, COUNT(*)::int AS scheduled
         FROM schedule s JOIN users u ON u.id = s.user_id
         WHERE u.company_id = $1 AND s.date >= $2
         GROUP BY s.date ORDER BY s.date LIMIT 90`,
        [req.user.company_id, todayTz()],
      );
      const confirmed = new Set(
        (await db.many('SELECT date FROM confirmed_days WHERE company_id = $1', [req.user.company_id])).map((r) => dateKey(r.date)),
      );
      res.json({
        dates: rows.map((r) => {
          const date = dateKey(r.date);
          return { date, scheduled: r.scheduled, locked: isLockedDate(date) || confirmed.has(date), confirmed: confirmed.has(date) };
        }),
      });
    } catch (err) { next(err); }
  });

  app.get('/api/manager/report', auth, adminOnly, async (req, res, next) => {
    try {
      const date = req.query.date;
      if (!date) return res.status(400).json({ error: 'Укажите параметр date=YYYY-MM-DD' });
      if (!isDateString(date)) return res.status(400).json({ error: 'Дата должна быть в формате YYYY-MM-DD' });
      res.json(await dayPlan(req.user.company_id, date));
    } catch (err) { next(err); }
  });

  app.post('/api/manager/report/:date/confirm', auth, adminOnly, async (req, res, next) => {
    try {
      const date = req.params.date;
      if (!isDateString(date)) return res.status(400).json({ error: 'Дата должна быть в формате YYYY-MM-DD' });
      if (isLockedDate(date)) return res.status(409).json({ error: 'Этот день уже закрыт' });
      const already = await db.one('SELECT 1 FROM confirmed_days WHERE company_id = $1 AND date = $2', [req.user.company_id, date]);
      if (already) return res.status(409).json({ error: 'День уже подтверждён' });

      const plan = await dayPlan(req.user.company_id, date);
      await db.query('INSERT INTO confirmed_days (company_id, date, confirmed_by) VALUES ($1,$2,$3)', [req.user.company_id, date, req.user.id]);

      const company = await db.one('SELECT * FROM companies WHERE id = $1', [req.user.company_id]);
      const fmt = (x) => x.split('-').reverse().join('.');
      const lines = plan.perSet.map((s) => `• ${s.setName} × ${s.count} — ${(s.setPrice * s.count).toLocaleString('ru-RU')} UZS`);
      if (plan.perSet.length === 0) lines.push('— нет запланированных сотрудников');
      const message = [
        '🍱 *Lunchistan — заказ подтверждён*',
        `📅 ${fmt(date)}`,
        `🏢 ${company.name}`,
        '',
        '🍽 Меню:',
        ...lines,
        ...(plan.unpicked > 0 ? ['', `⚠️ Не выбрали (сет по умолчанию): ${plan.unpicked}`] : []),
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

      res.status(201).json({ success: true, telegramSent, plan: await dayPlan(req.user.company_id, date) });
    } catch (err) { next(err); }
  });
}

module.exports = { register, requireFields };
