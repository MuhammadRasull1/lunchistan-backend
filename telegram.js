/** Экранирование пользовательского текста для parse_mode HTML. */
function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Чеки уходят в HTML: раньше был legacy Markdown без экранирования — один «_» в username или
// названии компании давал 400 «can't parse entities», и кухня не узнавала о заказе (аудит 25.09, В-4).
// Все пользовательские поля в сообщениях — только через esc().
async function sendTelegramReceipt(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.CHAT_ID;

  if (!token) {
    console.warn('⚠️ TELEGRAM_BOT_TOKEN не задан — чек не отправлен');
    return { ok: false, skipped: true };
  }
  // Раньше без CHAT_ID в окружении чек тихо уходил в личку разработчика
  // (хардкод-фолбэк) — теперь громко отказываем, чтобы чужие чеки/деньги
  // физически не могли уйти не туда (см. аудит 12.09, ОШИБКИ.md).
  if (!chatId) {
    console.error('🚨 CHAT_ID не задан в окружении — чек НЕ отправлен (раньше ушёл бы разработчику)');
    return { ok: false, skipped: true, reason: 'chat_id_missing' };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML', disable_web_page_preview: true }),
  });

  const data = await response.json();
  if (!data.ok) console.error('Ошибка Telegram API:', data);
  return data;
}

module.exports = { sendTelegramReceipt, esc };