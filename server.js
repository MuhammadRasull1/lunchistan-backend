require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { db } = require('./db');
const { register: registerRoutes } = require('./routes');
const { sendTelegramReceipt } = require('./telegram');

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

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

function isDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Валидация тела заказа. Поддерживает:
// 1. текущий формат фронтенда (lines/totalMonthlyPrice/...);
// 2. новый формат дней (days: [{date, mainDish, salad, beverage}] / totalMonthlyPrice);
// 3. прежний формат (days: строки-даты + meals + totalPrice).
function validateOrder(body) {
  const errors = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['Тело запроса отсутствует или имеет неверный формат'];
  }

  const hasDaysArray = Array.isArray(body.days);
  const hasNewDays = hasDaysArray && body.days.length > 0
    && body.days.every((d) => d !== null && typeof d === 'object' && !Array.isArray(d));
  const hasLegacyDays = hasDaysArray && body.days.length > 0
    && body.days.every((d) => typeof d === 'string');
  const hasLines = Array.isArray(body.lines) && body.lines.length > 0;
  const hasLegacyItems = hasLegacyDays && Array.isArray(body.meals) && body.meals.length > 0;

  if (body.days !== undefined && !hasDaysArray) {
    errors.push('Поле "days" должно быть массивом');
  }

  if (!hasLines && !hasNewDays && !hasLegacyItems) {
    errors.push('Необходимо передать непустой массив "lines", либо массив "days" (объекты с "date"), либо оба поля "days" и "meals"');
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

  if (hasLines) {
    let hasInvalidLine = false;
    let missingMainDish = false;
    let missingSalad = false;
    let missingBeverage = false;

    body.lines.forEach((line) => {
      if (!line || typeof line !== 'object' || Array.isArray(line)) {
        hasInvalidLine = true;
        return;
      }
      if (!isNonEmptyString(line.mainDish)) missingMainDish = true;
      if (!isNonEmptyString(line.salad)) missingSalad = true;
      if (!isNonEmptyString(line.beverage)) missingBeverage = true;
    });

    if (hasInvalidLine) errors.push('Некорректная структура заказа.');
    if (missingMainDish) errors.push('Не выбрано основное блюдо для одного или нескольких дней.');
    if (missingSalad) errors.push('Не выбран салат для одного или нескольких дней.');
    if (missingBeverage) errors.push('Не выбран напиток для одного или нескольких дней.');
  }

  if (hasNewDays) {
    let hasInvalidDay = false;
    let missingDate = false;
    let invalidDate = false;
    let duplicateDate = false;
    let missingMainDish = false;
    let missingSalad = false;
    let missingBeverage = false;
    const seenDates = new Set();

    body.days.forEach((day) => {
      if (!day || typeof day !== 'object' || Array.isArray(day)) {
        hasInvalidDay = true;
        return;
      }
      if (!isNonEmptyString(day.date)) {
        missingDate = true;
      } else if (!isDateString(day.date)) {
        invalidDate = true;
      } else if (seenDates.has(day.date)) {
        duplicateDate = true;
      } else {
        seenDates.add(day.date);
      }
      if (!isNonEmptyString(day.mainDish)) missingMainDish = true;
      if (!isNonEmptyString(day.salad)) missingSalad = true;
      if (!isNonEmptyString(day.beverage)) missingBeverage = true;
    });

    if (hasInvalidDay) errors.push('Некорректная структура дня.');
    if (missingDate) errors.push('Не указана дата для одного или нескольких дней.');
    if (invalidDate) errors.push('Дата должна быть в формате YYYY-MM-DD.');
    if (duplicateDate) errors.push('Обнаружены дубликаты дат в поле "days".');
    if (missingMainDish) errors.push('Не выбрано основное блюдо для одного или нескольких дней.');
    if (missingSalad) errors.push('Не выбран салат для одного или нескольких дней.');
    if (missingBeverage) errors.push('Не выбран напиток для одного или нескольких дней.');
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
function formatDayDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

function formatReceipt(order) {
  const dateTime = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent' });
  const out = ['🍱 *Новый заказ Lunchistan*', `🕒 ${dateTime}`, ''];

  if (Array.isArray(order.days) && order.days.length > 0
    && order.days.every((d) => d !== null && typeof d === 'object' && !Array.isArray(d))) {
    out.push('🧾 Состав заказа:');
    order.days.forEach((day) => {
      out.push(`📅 ${formatDayDate(day.date)}`);
      out.push(`  🥩 Основное: ${day.mainDish}`);
      out.push(`  🥗 Салат: ${day.salad}`);
      out.push(`  🥤 Напиток: ${day.beverage}`);
      if (order.employeeCount !== undefined) out.push(`  🔢 Порции: ${order.employeeCount}`);
    });
  } else if (Array.isArray(order.lines) && order.lines.length > 0) {
    out.push('🧾 Состав заказа:');
    order.lines.forEach((item) => {
      out.push(`• ${item.day || 'День'}`);
      out.push(`  🥩 Основное: ${item.mainDish}`);
      out.push(`  🥗 Салат: ${item.salad}`);
      out.push(`  🥤 Напиток: ${item.beverage}`);
      const parts = [];
      if (item.quantity !== undefined) parts.push(`x${item.quantity}`);
      if (typeof item.unitPrice === 'number') parts.push(`— ${item.unitPrice.toLocaleString('ru-RU')} UZS/шт`);
      const lineTotal = item.total ?? item.lineTotal;
      if (typeof lineTotal === 'number') parts.push(`= ${lineTotal.toLocaleString('ru-RU')} UZS`);
      if (parts.length > 0) out.push(`  ${parts.join(' ')}`);
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
// (реализация вынесена в telegram.js, общая для легаси-заказов и подтверждения дней)

// ── Новый контур: аккаунты, расписание, выбор блюд, сводка менеджера ──
registerRoutes(app);

app.post('/api/orders', async (req, res) => {
  const order = req.body;
  const errors = validateOrder(order);

  if (errors.length > 0) {
    return res.status(400).json({ error: 'Некорректные данные заказа', details: errors });
  }

  if (Array.isArray(order.days) && order.days.length > 0
    && order.days.every((d) => d !== null && typeof d === 'object' && !Array.isArray(d))) {
    order.workDaysCount = order.days.length;
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