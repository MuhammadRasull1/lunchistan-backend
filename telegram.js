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
  if (!data.ok) console.error('Ошибка Telegram API:', data);
  return data;
}

module.exports = { sendTelegramReceipt };