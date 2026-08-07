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

// Валидация тела заказа. Поддерживает как текущий формат фронтенда
// (lines/totalMonthlyPrice/...), так и прежний формат (days/meals/...)
function validateOrder(body) {
  const errors = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['Тело запроса отсутствует или имеет неверный формат'];
  }

  const hasLines = Array.isArray(body.lines) && body.lines.length > 0;
  const hasLegacyItems = Array.isArray(body.days) && body.days.length > 0
    && Array.isArray(body.meals) && body.meals.length > 0;

  if (!hasLines && !hasLegacyItems) {
    errors.push('Необходимо передать непустой массив "lines" либо оба поля "days" и "meals"');
  }

  if (body.totalMonthlyPrice === undefined && body.totalPrice === undefined) {
    errors.push('Необходимо указать "totalMonthlyPrice" или "totalPrice"');
  }

  if (body.lines !== undefined && !Array.isArray(body.lines)) {
    errors.push('Поле "lines" должно быть массивом');
  }

  if (body.beverages !== undefined && !Array.isArray(body.beverages)) {
    errors.push('Поле "beverages" должно быть массивом');
  }

  // Числовые поля проверяются, только если они присутствуют
  ['totalMonthlyPrice', 'totalPrice', 'employeeCount', 'workDaysCount', 'portions'].forEach((field) => {
    if (body[field] !== undefined && (typeof body[field] !== 'number' || !Number.isFinite(body[field]))) {
      errors.push(`Поле "${field}" должно быть числом`);
    }
  });

  return errors;
}

// Формирование читаемого чека для Telegram.
// Поддерживает текущий формат фронтенда (lines/totalMonthlyPrice/...)
// и прежний формат (days/meals/totalPrice).
function formatReceipt(order) {
  const dateTime = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent' });
  const out = ['🍱 *Новый заказ Lunchistan*', `🕒 ${dateTime}`, ''];

  if (Array.isArray(order.lines) && order.lines.length > 0) {
    out.push('🧾 Состав заказа:');
    order.lines.forEach((item) => {
      const name = item.name || item.title || item.mealName || 'Позиция';
      const parts = [`• ${name}`];
      if (item.day) parts.push(`(${item.day})`);
      if (item.quantity !== undefined) parts.push(`x${item.quantity}`);
      if (typeof item.unitPrice === 'number') parts.push(`— ${item.unitPrice.toLocaleString('ru-RU')} UZS/шт`);
      const lineTotal = item.total ?? item.lineTotal;
      if (typeof lineTotal === 'number') parts.push(`= ${lineTotal.toLocaleString('ru-RU')} UZS`);
      out.push(parts.join(' '));
    });
  } else {
    const meals = order.meals.map((m) => (typeof m === 'string' ? m : m.name)).join(', ');
    out.push(`📅 Дни: ${order.days.join(', ')}`, `🍽 Блюда: ${meals}`);
  }

  if (Array.isArray(order.beverages) && order.beverages.length > 0) {
    out.push(`🥤 Напитки: ${order.beverages.map((b) => (typeof b === 'string' ? b : b.name)).join(', ')}`);
  }

  if (order.activeDays !== undefined) {
    out.push(`📅 Активные дни: ${Array.isArray(order.activeDays) ? order.activeDays.join(', ') : order.activeDays}`);
  }
  if (order.workDaysCount !== undefined) out.push(`📆 Рабочих дней: ${order.workDaysCount}`);
  if (order.portions !== undefined) out.push(`📦 Порций: ${order.portions}`);
  if (order.employeeCount !== undefined) out.push(`👥 Сотрудников: ${order.employeeCount}`);
  if (order.paymentMethod) out.push(`💳 Способ оплаты: ${order.paymentMethod}`);

  const total = order.totalMonthlyPrice ?? order.totalPrice;
  if (total !== undefined) out.push(`💰 Итого: ${total.toLocaleString('ru-RU')} UZS`);

  if (order.customerName) out.push(`👤 Клиент: ${order.customerName}`);
  if (order.phone) out.push(`📞 Телефон: ${order.phone}`);
  if (order.comment) out.push(`💬 Комментарий: ${order.comment}`);

  out.push('', '✅ Заказ принят в обработку');

  return out.join('\n');
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