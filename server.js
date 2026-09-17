require('dotenv').config();

const express = require('express');
const cors = require('cors');

const db = require('./db');
const { registerAppRoutes } = require('./appRoutes');
const { startBot } = require('./bot');

const app = express();
// Render (как большинство PaaS) стоит перед приложением как обратный прокси —
// без этого req.ip всегда возвращает IP самого прокси, а не реального клиента,
// и любой rate-limit по IP (см. routes.js authRateLimit) бьёт по всем сразу.
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

registerAppRoutes(app);

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
