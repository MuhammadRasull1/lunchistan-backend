require('dotenv').config();

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

// MVP данные для Ланчистана
const menu = [
  {
    id: 1,
    name: "Фирменный Плов Lunchistan",
    description: "Настоящий праздничный плов с нежным мясом и ароматными специями для сытного обеда всей команды.",
    price: 45000,
    imageUrl: "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?q=80&w=1000"
  }
];

app.get('/api/menu', (req, res) => {
  res.json(menu);
});

// Валидация тела заказа, приходящего из Telegram Mini App
function validateOrder(body) {
  const errors = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['Тело запроса отсутствует или имеет неверный формат'];
  }

  if (!Array.isArray(body.days) || body.days.length === 0) {
    errors.push('Поле "days" обязательно и должно быть непустым массивом');
  }

  if (!Array.isArray(body.meals) || body.meals.length === 0) {
    errors.push('Поле "meals" обязательно и должно быть непустым массивом');
  }

  if (body.beverages !== undefined && !Array.isArray(body.beverages)) {
    errors.push('Поле "beverages" должно быть массивом');
  }

  if (typeof body.portions !== 'number' || !Number.isFinite(body.portions)) {
    errors.push('Поле "portions" обязательно и должно быть числом');
  }

  if (typeof body.employeeCount !== 'number' || !Number.isFinite(body.employeeCount)) {
    errors.push('Поле "employeeCount" обязательно и должно быть числом');
  }

  if (typeof body.totalPrice !== 'number' || !Number.isFinite(body.totalPrice)) {
    errors.push('Поле "totalPrice" обязательно и должно быть числом');
  }

  return errors;
}

// Формирование читаемого чека для Telegram
function formatReceipt(order) {
  const dateTime = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent' });
  const meals = order.meals.map((m) => (typeof m === 'string' ? m : m.name)).join(', ');
  const beverages = Array.isArray(order.beverages) && order.beverages.length > 0
    ? order.beverages.map((b) => (typeof b === 'string' ? b : b.name)).join(', ')
    : 'не выбраны';

  const lines = [
    '🍱 *Новый заказ Lunchistan*',
    `🕒 ${dateTime}`,
    '',
    `📅 Дни: ${order.days.join(', ')}`,
    `🍽 Блюда: ${meals}`,
    `🥤 Напитки: ${beverages}`,
    `📦 Порций: ${order.portions}`,
    `👥 Сотрудников: ${order.employeeCount}`,
    `💰 Итого: ${order.totalPrice.toLocaleString('ru-RU')} UZS`,
  ];

  if (order.customerName) lines.push(`👤 Клиент: ${order.customerName}`);
  if (order.phone) lines.push(`📞 Телефон: ${order.phone}`);
  if (order.comment) lines.push(`💬 Комментарий: ${order.comment}`);

  lines.push('', '✅ Заказ принят в обработку');

  return lines.join('\n');
}

// Отправка чека через Telegram Bot API
async function sendTelegramReceipt(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.CHAT_ID;

  if (!token || !chatId) {
    console.warn('⚠️ TELEGRAM_BOT_TOKEN или CHAT_ID не заданы — чек не отправлен');
    return { ok: false, skipped: true };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' }),
  });

  const data = await response.json();
  if (!data.ok) {
    console.error('Ошибка Telegram API:', data);
  }
  return data;
}

app.post('/api/orders', async (req, res) => {
  const order = req.body;
  const errors = validateOrder(order);

  if (errors.length > 0) {
    return res.status(400).json({ error: 'Некорректные данные заказа', details: errors });
  }

  const receipt = formatReceipt(order);
  let telegramSent = true;

  try {
    const result = await sendTelegramReceipt(receipt);
    telegramSent = Boolean(result.ok);
  } catch (err) {
    telegramSent = false;
    console.error('Не удалось отправить чек в Telegram:', err.message);
  }

  res.status(201).json({ success: true, message: 'Заказ принят', telegramSent });
});

// Обработка невалидного JSON в теле запроса
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Невалидный JSON в теле запроса' });
  }
  next(err);
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер Lunchistan успешно запущен на http://localhost:${PORT}`);
});