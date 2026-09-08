/**
 * Telegram-бот Lunchistan — личные чеки, статусы заказов, помощь.
 * Работает через long polling (нативный API, без фреймворков).
 */
const db = require('./db');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;
let offset = 0;

// ── Отправка сообщений ─────────────────────────────────────────────
async function send(chatId, text, extra = {}) {
  if (!TOKEN) return;
  await fetch(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', ...extra }),
  }).catch((e) => console.error('bot send error:', e.message));
}

// ── Хендлеры команд ────────────────────────────────────────────────
async function handleStart(chatId, user) {
  const name = user?.first_name || 'друг';
  await send(chatId,
    `Привет, ${name}! 👋\n\n` +
    `Я бот *Lunchistan* — корпоративная доставка обедов.\n\n` +
    `📌 *Что я умею:*\n` +
    `/status — статус твоих заказов\n` +
    `/help — помощь\n\n` +
    `Оформить заказ можно в наше́м мини-приложении 👇`,
    {
      reply_markup: JSON.stringify({
        inline_keyboard: [[{ text: '🍱 Открыть меню', web_app: { url: process.env.TMA_URL || 'https://lunchistan.uz' } }]],
      }),
    },
  );
}

async function handleStatus(chatId, tgUserId) {
  if (!tgUserId) return send(chatId, '⚠️ Не удалось определить твой аккаунт.');

  const rows = await db.many(
    `SELECT id, status, total_amount, created_at
     FROM orders WHERE tg_user_id = $1 ORDER BY created_at DESC LIMIT 5`,
    [tgUserId],
  );

  if (!rows.length) return send(chatId, 'У тебя пока нет заказов. Открой мини-приложение и сделай первый заказ.');

  const statusEmoji = { new: '🟡', confirmed: '🟢', delivered: '✅', cancelled: '❌' };
  const lines = rows.map((r) => {
    const num = `ORD-${String(r.id).padStart(4, '0')}`;
    const status = statusEmoji[r.status] || '⚪';
    const dt = new Date(r.created_at).toLocaleDateString('ru-RU', { timeZone: 'Asia/Tashkent' });
    const sum = Number(r.total_amount).toLocaleString('ru-RU');
    return `${status} *${num}* — ${sum} UZS · ${dt}`;
  });

  await send(chatId, `📋 *Мои заказы:*\n\n${lines.join('\n')}\n\nПодробнее — в мини-приложении.`);
}

async function handleHelp(chatId) {
  await send(chatId,
    `ℹ️ *Помощь*\n\n` +
    `• Оформление заказа — через мини-приложение (кнопка ниже)\n` +
    `/status — мои последние заказы\n` +
    `/start — перезапустить бота\n\n` +
    `По вопросам: @${process.env.MANAGER_USERNAME || 'mansurov_dev'}`,
    {
      reply_markup: JSON.stringify({
        inline_keyboard: [[{ text: '🍱 Открыть меню', web_app: { url: process.env.TMA_URL || 'https://lunchistan.uz' } }]],
      }),
    },
  );
}

// ── Рассылка чека клиенту ──────────────────────────────────────────
async function sendClientReceipt(tgUserId, receiptText) {
  if (!tgUserId || !TOKEN) return;
  await send(tgUserId, receiptText);
}

// ── Напоминание о доставке (за день) ───────────────────────────────
// Ташкент = UTC+5 постоянно, без DST.
function dayKeyShift(n) {
  return new Date(Date.now() + n * 86400000 + 5 * 3600000).toISOString().slice(0, 10);
}

async function remindUpcoming() {
  if (!TOKEN) return;
  const tomorrow = dayKeyShift(1);
  const rows = await db.many(
    `SELECT DISTINCT o.id, o.tg_user_id, o.total_amount
     FROM orders o JOIN order_lines ol ON ol.order_id = o.id
     WHERE ol.date = $1
       AND o.tg_user_id IS NOT NULL
       AND o.status NOT IN ('cancelled', 'delivered')
       AND NOT EXISTS (SELECT 1 FROM delivery_reminders dr
                       WHERE dr.order_id = o.id AND dr.date = ol.date)`,
    [tomorrow],
  );

  for (const r of rows) {
    const sum = Number(r.total_amount).toLocaleString('ru-RU');
    await send(r.tg_user_id,
      `🌤 Напоминаем: завтра у тебя доставка *Lunchistan*!\n\n` +
      `🔖 №ORD-${String(r.id).padStart(4, '0')}\n` +
      `💰 ${sum} UZS\n\n` +
      `Если планы изменились — напиши нам заранее. Хорошего дня!`,
      {
        reply_markup: JSON.stringify({
          inline_keyboard: [[{ text: '🍱 Открыть меню', web_app: { url: process.env.TMA_URL || 'https://lunchistan.uz' } }]],
        }),
      },
    );
    await db.query(
      'INSERT INTO delivery_reminders (order_id, date) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [r.id, tomorrow],
    );
  }
}

// ── Обработка апдейтов (long polling) ──────────────────────────────
async function processUpdate(update) {
  const msg = update.message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const tgUserId = msg.from?.id;
  const text = msg.text.trim();

  if (text === '/start') return handleStart(chatId, msg.from);
  if (text === '/status') return handleStatus(chatId, tgUserId);
  if (text === '/help') return handleHelp(chatId);
}

async function poll() {
  if (!TOKEN) return;
  try {
    const res = await fetch(`${API}/getUpdates?offset=${offset}&timeout=30`);
    const data = await res.json();
    if (data.ok && data.result?.length) {
      for (const u of data.result) {
        offset = u.update_id + 1;
        await processUpdate(u).catch(console.error);
      }
    }
  } catch (e) {
    console.error('poll error:', e.message);
  }
  poll(); // рекурсия
}

// ── Запуск ──────────────────────────────────────────────────────────
function startBot() {
  if (!TOKEN) {
    console.warn('⚠️ TELEGRAM_BOT_TOKEN не задан — бот не запущен');
    return;
  }
  console.log('🤖 Lunchistan bot запущен (long polling + напоминания)');
  poll();
  remindUpcoming().catch(console.error);
  setInterval(() => remindUpcoming().catch(console.error), 60 * 60 * 1000);
}

module.exports = { startBot, sendClientReceipt };