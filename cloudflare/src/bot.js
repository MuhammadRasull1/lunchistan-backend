/**
 * Telegram-бот Lunchistan для Cloudflare Workers — та же логика, что в
 * ../../bot.js (Render), но апдейты приходят через webhook, а не через
 * long polling (у Workers нет постоянно работающего процесса для poll()).
 *
 * sendClientReceipt(tgUserId, text) — сигнатура ДОЛЖНА совпадать с оригиналом:
 * её вызывает ../../routes_orders.js (общий файл, не копия), передавая ровно
 * 2 аргумента, без env — поэтому здесь, как и в ../../telegram.js/logistics.js,
 * токен читается из process.env напрямую, а не пробрасывается параметром.
 */
const db = require('./db');

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const api = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

async function send(chatId, text, extra = {}) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  const res = await fetch(`${api()}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra }),
  }).catch((e) => { console.error('bot send error:', e.message); return null; });
  if (res) {
    const data = await res.json().catch(() => null);
    if (data && !data.ok) console.error('Telegram API reply:', JSON.stringify(data).slice(0, 300));
  }
}

const menuButton = () => JSON.stringify({
  inline_keyboard: [[{ text: '🍱 Открыть меню', web_app: { url: process.env.TMA_URL || 'https://lunchistan-app.pages.dev' /* lunchistan.uz не существует — кнопка «Открыть меню» вела в пустоту (25.09.2026) */ } }]],
});

async function handleStart(chatId, user) {
  const name = user?.first_name || 'друг';
  await send(chatId,
    `👋 Здравствуйте, <b>${esc(name)}</b>!\n\n` +
    `Вы в <b>Lunchistan</b> — корпоративная доставка обедов 🍱\n\n` +
    `🧭 <b>Что я умею:</b>\n` +
    `📦 /status — ваши последние заказы\n\n` +
    `🛒 Оформить заказ можно в мини-приложении 👇`,
    { reply_markup: menuButton() },
  );
}

async function handleStatus(chatId, tgUserId) {
  if (!tgUserId) return send(chatId, '⚠️ Не удалось определить ваш аккаунт.');

  const rows = await db.many(
    `SELECT id, status, total_amount, created_at
     FROM orders WHERE tg_user_id = $1 ORDER BY created_at DESC LIMIT 5`,
    [tgUserId],
  );

  if (!rows.length) {
    return send(chatId,
      `📭 У вас пока нет заказов.\n\n` +
      `🛒 Загляните в меню и сделайте первый заказ 👇`,
      { reply_markup: menuButton() },
    );
  }

  const statusEmoji = { new: '🟡', confirmed: '🟢', delivered: '✅', cancelled: '❌' };
  const lines = rows.map((r) => {
    const num = `ORD-${String(r.id).padStart(4, '0')}`;
    const emoji = statusEmoji[r.status] || '⚪';
    const dt = new Date(r.created_at).toLocaleDateString('ru-RU', { timeZone: 'Asia/Tashkent' });
    const sum = Number(r.total_amount).toLocaleString('ru-RU');
    return `${emoji} <b>${num}</b> — ${sum} UZS · ${dt}`;
  });

  await send(chatId,
    `📋 <b>Мои заказы:</b>\n\n${lines.join('\n')}\n\n` +
    `ℹ️ Подробнее — в мини-приложении.`,
    { reply_markup: menuButton() },
  );
}

/** Вызывается из routes_orders.js (2 аргумента, без env — см. шапку файла). */
async function sendClientReceipt(tgUserId, receiptText) {
  if (!tgUserId || !process.env.TELEGRAM_BOT_TOKEN) return;
  await send(tgUserId, receiptText, { reply_markup: menuButton() });
}

// Ташкент = UTC+5 постоянно, без DST.
function dayKeyShift(n) {
  return new Date(Date.now() + n * 86400000 + 5 * 3600000).toISOString().slice(0, 10);
}

async function remindUpcoming() {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
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
      `🌤 <b>Напоминание</b>: завтра у вас доставка <b>Lunchistan</b>! 🍱\n\n` +
      `🔖 №ORD-${String(r.id).padStart(4, '0')}\n` +
      `💰 ${sum} UZS\n\n` +
      `Если планы изменились — напишите нам заранее. Хорошего дня! ✨`,
      { reply_markup: menuButton() },
    );
    await db.query(
      'INSERT INTO delivery_reminders (order_id, date) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [r.id, tomorrow],
    );
  }
}

/** Один апдейт из вебхука Telegram (вместо poll()+processUpdate на Render).
 * Вызывается только из index.js этого Worker'а — сигнатуру контролирую сам. */
async function handleUpdate(update) {
  const msg = update.message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const tgUserId = msg.from?.id;
  const text = msg.text.trim();

  if (text === '/start') return handleStart(chatId, msg.from);
  if (text === '/status') return handleStatus(chatId, tgUserId);
}

module.exports = { handleUpdate, sendClientReceipt, remindUpcoming };
