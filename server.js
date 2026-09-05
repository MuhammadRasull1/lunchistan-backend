require('dotenv').config();

const express = require('express');
const cors = require('cors');

const db = require('./db');
const { auth, verifyPassword, hashPassword, MIN_PASSWORD } = require('./auth');
const { register: registerTeams } = require('./routes');
const { register: registerOrders } = require('./routes_orders');
const { register: registerOwner } = require('./routes_owner');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

// ── Здоровье (для аптайм-мониторинга) ──────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, db: db.kind, ts: Date.now() }));
app.get('/', (req, res) => res.json({ service: 'lunchistan-backend', ok: true }));

// ── Меню из БД ────────────────────────────────────────────────────
app.get('/api/menu', async (req, res, next) => {
  try {
    const sets = await db.many('SELECT id, name, category, price FROM menu_sets ORDER BY id');
    res.json(sets);
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
  })
  .catch((err) => {
    console.error('Не удалось инициализировать БД:', err);
    process.exit(1);
  });
