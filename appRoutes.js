/**
 * Регистрация всех API-маршрутов Lunchistan на переданном app —
 * общий код для Render (server.js, настоящий Express) и Cloudflare Workers
 * (cloudflare/src/index.js, ExpressLikeApp поверх Hono, см. cloudflare/src/expressShim.js).
 * Никакого запуска сервера/бота здесь нет — это делает каждый entry сам.
 */
const db = require('./db');
const { isDateString, todayTz } = require('./lib');
const { auth, ownerOnly, verifyPassword, hashPassword, MIN_PASSWORD } = require('./auth');
const { register: registerTeams } = require('./routes');
const { register: registerOrders } = require('./routes_orders');
const { register: registerOwner } = require('./routes_owner');
const { register: registerDelivery } = require('./routes_delivery');

const MENU_FIELDS = 'id, name, category, price, description, image_url, calories, proteins, fats, carbs, composition';
const CATEGORIES = ['hot', 'salad', 'side', 'fastfood', 'appetizer', 'soup'];
const SETTINGS_KEYS = ['payment_card_number', 'payment_card_holder'];

function plusDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function validateMenuInput(body, { partial = false } = {}) {
  const errors = [];
  const out = {};

  const need = (key) => !partial || body[key] !== undefined;

  if (need('name')) {
    if (typeof body.name !== 'string' || !body.name.trim()) errors.push('name обязателен');
    else out.name = body.name.trim();
  }
  if (need('category')) {
    if (!CATEGORIES.includes(body.category)) errors.push(`category должен быть одним из: ${CATEGORIES.join(', ')}`);
    else out.category = body.category;
  }
  if (need('price')) {
    if (!Number.isInteger(body.price) || body.price <= 0) errors.push('price должен быть положительным целым числом');
    else out.price = body.price;
  }
  if (body.description !== undefined) out.description = String(body.description || '');
  if (body.image_url !== undefined) out.image_url = body.image_url ? String(body.image_url) : null;
  for (const k of ['calories', 'proteins', 'fats', 'carbs']) {
    if (body[k] !== undefined) {
      if (body[k] !== null && (!Number.isInteger(body[k]) || body[k] < 0)) errors.push(`${k} должен быть целым числом ≥ 0`);
      else out[k] = body[k];
    }
  }
  if (body.composition !== undefined) {
    if (!Array.isArray(body.composition) || body.composition.some((c) => typeof c?.name !== 'string')) {
      errors.push('composition должен быть массивом [{name, icon?, optional?}]');
    } else {
      out.composition = JSON.stringify(body.composition.map((c) => ({
        name: c.name, icon: c.icon || '', optional: !!c.optional,
      })));
    }
  }
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== 'boolean') errors.push('is_active должен быть true/false');
    else out.is_active = body.is_active;
  }
  return { errors, out };
}

function registerAppRoutes(app) {
  // ── Здоровье (для аптайм-мониторинга) ──────────────────────────────
  app.get('/health', (req, res) => res.json({ ok: true, db: db.kind, ts: Date.now() }));
  app.get('/', (req, res) => res.json({ service: 'lunchistan-backend', ok: true }));

  // ── Меню из БД ────────────────────────────────────────────────────
  app.get('/api/menu', async (req, res, next) => {
    try {
      const sets = await db.many(
        `SELECT ${MENU_FIELDS} FROM menu_sets WHERE is_active = true ORDER BY id`
      );
      res.json(sets);
    } catch (err) { next(err); }
  });

  // Меню на конкретную дату — 17.09.2026: заменяет прежнюю детерминированную
  // «ротацию» блюда по номеру дня. Блюда на дату теперь вносит владелец вручную
  // (/api/owner/daily-menu), заказ доступен только для дат с внесённым меню.
  app.get('/api/menu/day/:date', async (req, res, next) => {
    try {
      const { date } = req.params;
      if (!isDateString(date)) return res.status(400).json({ error: 'Дата должна быть в формате YYYY-MM-DD' });
      const sets = await db.many(
        `SELECT ${MENU_FIELDS} FROM daily_menu dm JOIN menu_sets ms ON ms.id = dm.set_id
         WHERE dm.date = $1 AND ms.is_active = true ORDER BY ms.id`,
        [date],
      );
      res.json({ date, sets });
    } catch (err) { next(err); }
  });

  app.get('/api/menu/available-dates', async (req, res, next) => {
    try {
      const today = todayTz();
      const from = isDateString(req.query.from) ? req.query.from : today;
      const to = isDateString(req.query.to) ? req.query.to : plusDays(today, 60);
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      const rows = await db.many(
        `SELECT DISTINCT dm.date::text AS date
         FROM daily_menu dm JOIN menu_sets ms ON ms.id = dm.set_id
         WHERE ms.is_active = true AND dm.date BETWEEN $1 AND $2
         ORDER BY dm.date::text`,
        [lo, hi],
      );
      res.json({ dates: rows.map((r) => r.date) });
    } catch (err) { next(err); }
  });

  // ── Меню — управление владельцем (дядя/брат правят сами, без деплоя кода) ──
  app.get('/api/owner/menu', auth, ownerOnly, async (req, res, next) => {
    try {
      const sets = await db.many(`SELECT ${MENU_FIELDS}, is_active FROM menu_sets ORDER BY id`);
      res.json(sets);
    } catch (err) { next(err); }
  });

  app.post('/api/owner/menu', auth, ownerOnly, async (req, res, next) => {
    try {
      const { errors, out } = validateMenuInput(req.body || {});
      if (errors.length) return res.status(400).json({ error: errors.join('; ') });

      const { rows } = await db.query(
        `INSERT INTO menu_sets (name, category, price, description, image_url, calories, proteins, fats, carbs, composition)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE($10::jsonb, '[]'::jsonb))
         RETURNING ${MENU_FIELDS}`,
        [out.name, out.category, out.price, out.description || '', out.image_url ?? null,
          out.calories ?? null, out.proteins ?? null, out.fats ?? null, out.carbs ?? null, out.composition]
      );
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  });

  app.put('/api/owner/menu/:id', auth, ownerOnly, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'Некорректный id' });

      const { errors, out } = validateMenuInput(req.body || {}, { partial: true });
      if (errors.length) return res.status(400).json({ error: errors.join('; ') });
      if (!Object.keys(out).length) return res.status(400).json({ error: 'Нечего обновлять' });

      const setCols = Object.keys(out);
      const setSql = setCols.map((k, i) => `${k} = $${i + 2}${k === 'composition' ? '::jsonb' : ''}`).join(', ');
      const { rows } = await db.query(
        `UPDATE menu_sets SET ${setSql}, updated_at = now() WHERE id = $1 RETURNING ${MENU_FIELDS}, is_active`,
        [id, ...setCols.map((k) => out[k])]
      );
      if (!rows.length) return res.status(404).json({ error: 'Блюдо не найдено' });
      res.json(rows[0]);
    } catch (err) { next(err); }
  });

  app.delete('/api/owner/menu/:id', auth, ownerOnly, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'Некорректный id' });
      const { rows } = await db.query(
        'UPDATE menu_sets SET is_active = false, updated_at = now() WHERE id = $1 RETURNING id',
        [id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Блюдо не найдено' });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ── Меню на дату — управление владельцем ────────────────────────────
  app.get('/api/owner/daily-menu/:date', auth, ownerOnly, async (req, res, next) => {
    try {
      const { date } = req.params;
      if (!isDateString(date)) return res.status(400).json({ error: 'Дата должна быть в формате YYYY-MM-DD' });
      const rows = await db.many('SELECT set_id FROM daily_menu WHERE date = $1 ORDER BY set_id', [date]);
      res.json({ date, setIds: rows.map((r) => r.set_id) });
    } catch (err) { next(err); }
  });

  app.put('/api/owner/daily-menu/:date', auth, ownerOnly, async (req, res, next) => {
    try {
      const { date } = req.params;
      if (!isDateString(date)) return res.status(400).json({ error: 'Дата должна быть в формате YYYY-MM-DD' });

      const { setIds } = req.body || {};
      if (!Array.isArray(setIds) || setIds.some((id) => !Number.isInteger(id))) {
        return res.status(400).json({ error: 'Поле "setIds" должно быть массивом id блюд' });
      }
      const clean = [...new Set(setIds)];

      if (clean.length) {
        const existing = await db.many('SELECT id FROM menu_sets WHERE id = ANY($1)', [clean]);
        const existingIds = new Set(existing.map((r) => r.id));
        const unknown = clean.filter((id) => !existingIds.has(id));
        if (unknown.length) {
          return res.status(400).json({ error: `Блюдо не найдено в каталоге (id: ${unknown.join(', ')})` });
        }
      }

      await db.tx(async (t) => {
        await t.query('DELETE FROM daily_menu WHERE date = $1', [date]);
        for (const setId of clean) {
          await t.query('INSERT INTO daily_menu (date, set_id) VALUES ($1,$2)', [date, setId]);
        }
      });
      res.json({ date, setIds: clean });
    } catch (err) { next(err); }
  });

  // ── Настройки бизнеса — публичные (клиенту на checkout нужен номер карты) ──
  app.get('/api/settings', async (req, res, next) => {
    try {
      const rows = await db.many('SELECT key, value FROM settings WHERE key = ANY($1)', [SETTINGS_KEYS]);
      const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      res.json({
        paymentCardNumber: byKey.payment_card_number || null,
        paymentCardHolder: byKey.payment_card_holder || null,
      });
    } catch (err) { next(err); }
  });

  app.put('/api/owner/settings', auth, ownerOnly, async (req, res, next) => {
    try {
      const { paymentCardNumber, paymentCardHolder } = req.body || {};
      const updates = [
        ['payment_card_number', paymentCardNumber],
        ['payment_card_holder', paymentCardHolder],
      ].filter(([, v]) => v !== undefined);

      for (const [key, value] of updates) {
        const clean = typeof value === 'string' ? value.trim() : value;
        await db.query(
          `INSERT INTO settings (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
          [key, clean || null],
        );
      }
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ── Смена пароля (в т.ч. владельцем после первого входа) ───────────
  app.post('/api/auth/password', auth, async (req, res, next) => {
    try {
      const { oldPassword, newPassword } = req.body || {};
      if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD) {
        return res.status(400).json({ error: `Новый пароль должен быть не короче ${MIN_PASSWORD} символов` });
      }
      if (!(await verifyPassword(oldPassword || '', req.user.password_hash))) {
        return res.status(401).json({ error: 'Текущий пароль неверный' });
      }
      await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(newPassword), req.user.id]);
      // остальные устройства выходят — иначе украденная сессия жила бы ещё 30 дней (аудит 25.09, М-5)
      const header = req.headers.authorization || '';
      const current = header.startsWith('Bearer ') ? header.slice(7) : '';
      await db.query('DELETE FROM sessions WHERE user_id = $1 AND token <> $2', [req.user.id, current]);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ── Контуры ───────────────────────────────────────────────────────
  registerTeams(app);   // /api/auth/*, /api/me, /api/my/days*, /api/manager/*
  registerOrders(app);  // /api/orders, /api/my/orders*
  registerOwner(app);   // /api/owner/*
  registerDelivery(app);// /api/delivery/*, /api/my/address
}

module.exports = { registerAppRoutes };
