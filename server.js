require('dotenv').config();

const express = require('express');
const cors = require('cors');

const db = require('./db');
const { auth, ownerOnly, verifyPassword, hashPassword, MIN_PASSWORD } = require('./auth');
const { register: registerTeams } = require('./routes');
const { register: registerOrders } = require('./routes_orders');
const { register: registerOwner } = require('./routes_owner');
const { register: registerDelivery } = require('./routes_delivery');
const { startBot } = require('./bot');

const app = express();
// Render (как большинство PaaS) стоит перед приложением как обратный прокси —
// без этого req.ip всегда возвращает IP самого прокси, а не реального клиента,
// и любой rate-limit по IP (см. routes.js authRateLimit) бьёт по всем сразу.
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

// ── Здоровье (для аптайм-мониторинга) ──────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, db: db.kind, ts: Date.now() }));
app.get('/', (req, res) => res.json({ service: 'lunchistan-backend', ok: true }));

// ── Меню из БД ────────────────────────────────────────────────────
// До 11.09.2026 фронт брал меню из захардкоженного mockMenu.ts, а эта ручка отдавала
// только id/name/category/price — теперь единый источник правды для клиентов, «Команд»
// и владельца, редактируется через /api/owner/menu ниже.
const MENU_FIELDS = 'id, name, category, price, description, image_url, calories, proteins, fats, carbs, composition';
const CATEGORIES = ['hot', 'salad', 'side', 'fastfood', 'appetizer', 'soup'];

app.get('/api/menu', async (req, res, next) => {
  try {
    const sets = await db.many(
      `SELECT ${MENU_FIELDS} FROM menu_sets WHERE is_active = true ORDER BY id`
    );
    res.json(sets);
  } catch (err) { next(err); }
});

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
    // composition — jsonb; без явного каста Postgres не может вывести тип параметра из UPDATE ... SET
    const setSql = setCols.map((k, i) => `${k} = $${i + 2}${k === 'composition' ? '::jsonb' : ''}`).join(', ');
    const { rows } = await db.query(
      `UPDATE menu_sets SET ${setSql}, updated_at = now() WHERE id = $1 RETURNING ${MENU_FIELDS}, is_active`,
      [id, ...setCols.map((k) => out[k])]
    );
    if (!rows.length) return res.status(404).json({ error: 'Блюдо не найдено' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// Мягкое удаление — блюдо пропадает из каталога, но старые заказы (где оно хранится
// текстом в order_lines) остаются читаемыми. Восстановить — повторным PUT is_active=true.
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

// ── Настройки бизнеса — публичные (клиенту на checkout нужен номер карты) ──
// Плоский список ключей, а не эквайринг: дядя решил 11.09.2026 просто показывать
// номер карты, перевод клиент делает сам вручную — не полноценный приём платежей.
const SETTINGS_KEYS = ['payment_card_number', 'payment_card_holder'];

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
    if (!verifyPassword(oldPassword || '', req.user.password_hash)) {
      return res.status(401).json({ error: 'Текущий пароль неверный' });
    }
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(newPassword), req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Контуры ───────────────────────────────────────────────────────
registerTeams(app);   // /api/auth/*, /api/me, /api/my/days*, /api/manager/*
registerOrders(app);  // /api/orders, /api/my/orders*
registerOwner(app);   // /api/owner/*
registerDelivery(app);// /api/delivery/*, /api/my/address

// Невалидный JSON
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Невалидный JSON в теле запроса' });
  }
  next(err);
});

// Прочие ошибки
app.use((err, req, res, _next) => {
  console.error('💥', err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

db.ready()
  .then(() => {
    app.listen(PORT, () => console.log(`🚀 Lunchistan backend на :${PORT}`));
    startBot();
  })
  .catch((err) => {
    console.error('Не удалось инициализировать БД:', err);
    process.exit(1);
  });
