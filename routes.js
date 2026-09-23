/** Контур «Команды»: регистрация/вход, расписание сотрудника, выбор блюд, сводка и подтверждение менеджера. */
const crypto = require('node:crypto');
const db = require('./db');
const { sendTelegramReceipt } = require('./telegram');
const {
  MIN_PASSWORD, hashPassword, verifyPassword, isLegacyHash, createSession, destroySession, auth, adminOnly,
} = require('./auth');
const {
  isDateString, isLockedDate, isScheduleDateOk, dateKey,
  dayMenuSets, publicUser, employeesCount, companyByCode,
  todayTz, dayPlan, monthBounds,
} = require('./lib');

/**
 * День уже подтверждён менеджером для этой компании? Подтверждённый день —
 * снимок, отправленный на кухню в Telegram; расписание/выбор блюда после
 * этого меняться не должны (см. ОШИБКИ.md — раньше это никак не проверялось).
 */
async function isDayConfirmed(companyId, date) {
  if (!companyId) return false;
  const row = await db.one('SELECT 1 FROM confirmed_days WHERE company_id = $1 AND date = $2', [companyId, date]);
  return Boolean(row);
}

/**
 * Деньги за подтверждённый день «Команд» (bug 3.1 из аудита 12.09: раньше
 * confirm ничего не создавал, кроме отметки+Telegram — выручка «Кор» нигде
 * не считалась). Пишет застывший снимок plan.perSet (не пересчитывается
 * задним числом при увольнении — чинит заодно и bug 4j) и пересобирает счёт
 * компании за календарный месяц из всех снимков этого месяца.
 */
async function snapshotConfirmedDay(t, companyId, date, plan) {
  for (const s of plan.perSet) {
    await t.query(
      `INSERT INTO confirmed_day_lines (company_id, date, set_id, set_name, set_price, count, line_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (company_id, date, set_id) DO UPDATE SET
         set_name = EXCLUDED.set_name, set_price = EXCLUDED.set_price,
         count = EXCLUDED.count, line_total = EXCLUDED.line_total`,
      [companyId, date, s.setId, s.setName, s.setPrice, s.count, s.setPrice * s.count],
    );
  }
  const { start, end } = monthBounds(date);
  const totalRow = await t.one(
    'SELECT COALESCE(SUM(line_total),0)::bigint AS total FROM confirmed_day_lines WHERE company_id = $1 AND date BETWEEN $2 AND $3',
    [companyId, start, end],
  );
  await t.query(
    `INSERT INTO invoices (company_id, period_start, period_end, total_amount)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (company_id, period_start, period_end)
     DO UPDATE SET total_amount = EXCLUDED.total_amount, updated_at = now()`,
    [companyId, start, end, totalRow.total],
  );
}

/**
 * Простой rate-limit по IP без внешних зависимостей: код команды — 6 символов
 * из 34-символьного алфавита, без throttling его можно перебрать роботом и
 * "войти" сотрудником в чужую компанию (см. ОШИБКИ.md). Состояние в памяти
 * процесса — сбрасывается при рестарте и не шарится между инстансами, для
 * масштаба этого приложения (один Render-инстанс) этого достаточно.
 */
const authAttempts = new Map(); // ip -> число попыток в текущем окне
const AUTH_WINDOW_MS = 5 * 60 * 1000;
// Настраивается через env только ради смоук-теста (растущий файл с каждой
// сессией упирался в дефолт 15 login/register за 5 минут) — прод не трогаем.
const AUTH_MAX_ATTEMPTS = Number(process.env.AUTH_MAX_ATTEMPTS) || 15;
// Раньше окно сбрасывалось таймером setInterval — на верхнем уровне модуля
// это запрещено рантаймом Cloudflare Workers ("Disallowed operation called
// within global scope"). Ленивый сброс при первом запросе после AUTH_WINDOW_MS
// даёт то же поведение (скользящее окно на 5 минут) без глобального таймера,
// работает одинаково на Render и Workers.
let authWindowStart = Date.now();

function authRateLimit(req, res, next) {
  const now = Date.now();
  if (now - authWindowStart > AUTH_WINDOW_MS) {
    authAttempts.clear();
    authWindowStart = now;
  }
  const ip = req.ip || 'unknown';
  const n = (authAttempts.get(ip) || 0) + 1;
  authAttempts.set(ip, n);
  if (n > AUTH_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Слишком много попыток входа/регистрации. Попробуйте через несколько минут.' });
  }
  next();
}

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
  app.post('/api/auth/register', authRateLimit, async (req, res, next) => {
    try {
      const { name, phone, password, companyName, companyCode, companySize } = req.body || {};
      if (!requireFields(res, { name, password }, ['name', 'password'])) return;
      if (password.length < MIN_PASSWORD) {
        return res.status(400).json({ error: `Пароль должен быть не короче ${MIN_PASSWORD} символов` });
      }
      const effectivePhone = phone && String(phone).trim()
        ? String(phone).trim()
        : `user_${crypto.randomBytes(8).toString('hex')}`;
      if (await db.one('SELECT 1 FROM users WHERE phone = $1', [effectivePhone])) {
        return res.status(409).json({ error: 'Пользователь уже зарегистрирован' });
      }

      let company;
      let role = 'employee';
      if (companyCode) {
        company = await companyByCode(companyCode);
        if (!company) return res.status(400).json({ error: 'Неверный код команды' });
        // Внутри одной компании имя должно быть уникальным — иначе вход по имени
        // (см. /api/auth/login) не может однозначно понять, кто из двух Иванов
        // logins, и молча выбирает первого попавшегося (см. ОШИБКИ.md).
        const nameTaken = await db.one(
          'SELECT 1 FROM users WHERE company_id = $1 AND LOWER(TRIM(name)) = LOWER(TRIM($2))',
          [company.id, name],
        );
        if (nameTaken) {
          return res.status(409).json({ error: 'В этой команде уже есть человек с таким именем — добавьте фамилию или инициал' });
        }
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
        [company.id, role, name.trim(), effectivePhone, await hashPassword(password)],
      );
      const token = await createSession(user.id);
      res.status(201).json({ token, user: publicUser(user, company) });
    } catch (err) { next(err); }
  });

  app.post('/api/auth/login', authRateLimit, async (req, res, next) => {
    try {
      const { phone, name, password, companyCode } = req.body || {};
      if (!requireFields(res, { password }, ['password'])) return;

      let user = null;
      if (phone && String(phone).trim()) {
        user = await db.one('SELECT * FROM users WHERE phone = $1', [String(phone).trim()]);
        if (!user || !(await verifyPassword(password, user.password_hash))) {
          return res.status(401).json({ error: 'Неверное имя или пароль' });
        }
      } else if (name && String(name).trim()) {
        // Имя уникально внутри компании, но не между компаниями: «Иван» может
        // работать сразу в нескольких компаниях-клиентах. Сначала сужаем по коду
        // команды (если его прислали), затем — по паролю. Раньше при нескольких
        // тёзках вход молча отдавал 401 «неверный пароль», хотя пароль был верный,
        // а поля для кода в форме входа нет — человек блокировался навсегда.
        let matches = await db.many(
          'SELECT * FROM users WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) ORDER BY id LIMIT 10',
          [String(name).trim()],
        );
        if (companyCode && String(companyCode).trim()) {
          const company = await companyByCode(companyCode);
          matches = company ? matches.filter((m) => m.company_id === company.id) : [];
        }
        const checked = await Promise.all(
          matches.map(async (m) => ({ m, ok: await verifyPassword(password, m.password_hash) })),
        );
        const byPassword = checked.filter((c) => c.ok).map((c) => c.m);
        if (byPassword.length > 1) {
          return res.status(409).json({
            error: 'В системе несколько человек с таким именем. Введите код команды',
            needCompanyCode: true,
          });
        }
        user = byPassword[0] || null;
      }

      if (!user) {
        return res.status(401).json({ error: 'Неверное имя или пароль' });
      }
      // Ленивый перехеш: пользователь ещё на старом scrypt (заведён до
      // 17.09.2026) — раз пароль уже проверен, обновляем хеш на PBKDF2 тут же,
      // без отдельной миграции и без смены пароля пользователем.
      if (isLegacyHash(user.password_hash)) {
        const upgraded = await hashPassword(password);
        await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [upgraded, user.id]);
      }
      const company = user.company_id ? await db.one('SELECT * FROM companies WHERE id = $1', [user.company_id]) : null;
      const token = await createSession(user.id);
      res.json({ token, user: publicUser(user, company) });
    } catch (err) { next(err); }
  });

  app.post('/api/auth/logout', auth, async (req, res, next) => {
    try {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      await destroySession(token);
      res.json({ ok: true });
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
        const menuSets = await dayMenuSets(date);
        const def = menuSets[0] ?? null;
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

      const existing = (await db.many('SELECT date FROM schedule WHERE user_id = $1', [req.user.id])).map((r) => dateKey(r.date));
      const existingSet = new Set(existing);
      const keep = new Set(clean);
      // Реально меняются только даты, которых не было и теперь есть, или были и пропали —
      // неизменную часть расписания (в т.ч. today после 10:00) трогать не запрещаем.
      const changedDates = [...new Set([...clean.filter((d) => !existingSet.has(d)), ...existing.filter((d) => !keep.has(d))])];
      for (const date of changedDates) {
        // Дедлайн 10:00 действовал только на выбор блюда, не на само расписание —
        // можно было добавить/убрать себя из плана дня после дедлайна (см. ОШИБКИ.md).
        if (isLockedDate(date)) return res.status(409).json({ error: `Дата "${date}" уже закрыта для изменений (дедлайн 10:00)` });
        if (await isDayConfirmed(req.user.company_id, date)) {
          return res.status(409).json({ error: `День "${date}" уже подтверждён менеджером, расписание не меняется` });
        }
      }

      await db.tx(async (t) => {
        for (const date of clean) {
          await t.query('INSERT INTO schedule (user_id, date) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, date]);
        }
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
      if (await isDayConfirmed(req.user.company_id, date)) {
        return res.status(409).json({ error: 'День уже подтверждён менеджером, выбор блюда больше не меняется' });
      }
      const scheduled = await db.one('SELECT 1 FROM schedule WHERE user_id = $1 AND date = $2', [req.user.id, date]);
      if (!scheduled) return res.status(400).json({ error: 'День не в вашем расписании' });

      const menuSets = await dayMenuSets(date);
      if (!menuSets.length) return res.status(400).json({ error: 'Меню на эту дату ещё не внесено' });

      const setId = Number((req.body || {}).setId);
      const set = Number.isInteger(setId) ? menuSets.find((s) => s.id === setId) : null;
      if (!set) return res.status(400).json({ error: 'Блюдо не предложено на эту дату' });

      await db.query(
        `INSERT INTO choices (user_id, date, set_id, set_name, set_price) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id, date) DO UPDATE SET set_id = EXCLUDED.set_id, set_name = EXCLUDED.set_name,
           set_price = EXCLUDED.set_price, updated_at = now()`,
        [req.user.id, date, set.id, set.name, set.price],
      );
      res.json({ date, choice: { setId: set.id, setName: set.name, setPrice: set.price } });
    } catch (err) { next(err); }
  });

  // ── Менеджер: управление сотрудниками (bug 4f/4g, аудит 12.09) ────
  // Раньше менеджер не мог ни увидеть список сотрудников, ни удалить
  // уволенного, ни сбросить забытый пароль (у сотрудников нет
  // почты/телефона для восстановления) — только напрямую в БД.
  app.get('/api/manager/employees', auth, adminOnly, async (req, res, next) => {
    try {
      const rows = await db.many(
        "SELECT id, name, phone, created_at FROM users WHERE company_id = $1 AND role = 'employee' ORDER BY name",
        [req.user.company_id],
      );
      res.json({ employees: rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, createdAt: r.created_at })) });
    } catch (err) { next(err); }
  });

  app.delete('/api/manager/employees/:id', auth, adminOnly, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'Неверный id сотрудника' });
      const emp = await db.one("SELECT id FROM users WHERE id = $1 AND company_id = $2 AND role = 'employee'", [id, req.user.company_id]);
      if (!emp) return res.status(404).json({ error: 'Сотрудник не найден в вашей команде' });
      // confirmed_day_lines — снимок, не связан с users, увольнение на него не влияет (см. 3.1).
      await db.query('DELETE FROM users WHERE id = $1', [id]);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  app.post('/api/manager/employees/:id/reset-password', auth, adminOnly, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'Неверный id сотрудника' });
      const emp = await db.one("SELECT id FROM users WHERE id = $1 AND company_id = $2 AND role = 'employee'", [id, req.user.company_id]);
      if (!emp) return res.status(404).json({ error: 'Сотрудник не найден в вашей команде' });
      // Забыл пароль = потерял аккаунт навсегда (bug 4g) — у сотрудников нет
      // почты для восстановления, только менеджер лично выдаёт новый пароль.
      const newPassword = crypto.randomBytes(4).toString('hex'); // 8 hex-символов, MIN_PASSWORD=4 хватает с запасом
      await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(newPassword), id]);
      res.json({ ok: true, newPassword });
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
      await db.tx(async (t) => {
        await t.query('INSERT INTO confirmed_days (company_id, date, confirmed_by) VALUES ($1,$2,$3)', [req.user.company_id, date, req.user.id]);
        await snapshotConfirmedDay(t, req.user.company_id, date, plan);
      });

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

  // Повторная отправка чека для уже подтверждённого дня — если Telegram не
  // доставил сообщение при confirm, раньше не было способа попробовать снова
  // (confirm второй раз давал 409 «уже подтверждён»).
  app.post('/api/manager/report/:date/resend', auth, adminOnly, async (req, res, next) => {
    try {
      const date = req.params.date;
      if (!isDateString(date)) return res.status(400).json({ error: 'Дата должна быть в формате YYYY-MM-DD' });
      const already = await db.one('SELECT 1 FROM confirmed_days WHERE company_id = $1 AND date = $2', [req.user.company_id, date]);
      if (!already) return res.status(400).json({ error: 'Этот день ещё не подтверждён — сначала confirm' });

      const plan = await dayPlan(req.user.company_id, date);
      const company = await db.one('SELECT * FROM companies WHERE id = $1', [req.user.company_id]);
      const fmt = (x) => x.split('-').reverse().join('.');
      const lines = plan.perSet.map((s) => `• ${s.setName} × ${s.count} — ${(s.setPrice * s.count).toLocaleString('ru-RU')} UZS`);
      if (plan.perSet.length === 0) lines.push('— нет запланированных сотрудников');
      const message = [
        '🍱 *Lunchistan — заказ подтверждён (повтор)*',
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
        console.error('Не удалось повторно отправить чек в Telegram:', err.message);
      }
      res.json({ success: true, telegramSent });
    } catch (err) { next(err); }
  });
}

module.exports = { register, requireFields };
