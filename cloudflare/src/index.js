/**
 * Точка входа Cloudflare Worker — аналог ../../server.js для Render, но без
 * запуска Node-сервера: registerAppRoutes(app) — тот же общий файл
 * (../../appRoutes.js), что даёт /api/menu, /api/owner/*, /api/orders,
 * /api/my/*, /api/manager/*, /api/delivery/* и т.д., дословно как на Render.
 *
 * Плюс здесь же: приём Telegram-вебхука (вместо long polling из ../../bot.js)
 * и cron-обработчик для remindUpcoming (вместо setInterval раз в час).
 *
 * ES Module (import/export default) — так требует Wrangler для формата
 * Worker'а, дающего доступ к nodejs_compat так, как нужно нашим require()
 * зависимостям (appRoutes.js и всё, что за ним, остаются CommonJS —
 * esbuild сам сводит их в этот бандл).
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ExpressLikeApp } from './expressShim.js';
import { registerAppRoutes } from '../../appRoutes.js';
import { handleUpdate, remindUpcoming } from './bot.js';

const hono = new Hono();
hono.use('*', cors());

registerAppRoutes(new ExpressLikeApp(hono));

// Telegram шлёт апдейты сюда (WEBHOOK_SECRET проверяется отдельным заголовком
// X-Telegram-Bot-Api-Secret-Token — Telegram сам подставляет его, если он был
// передан в setWebhook; секрет хранится как секрет Worker'а, не в коде).
hono.post('/telegram-webhook', async (c) => {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expected) {
    const got = c.req.header('x-telegram-bot-api-secret-token');
    if (got !== expected) return c.json({ error: 'forbidden' }, 403);
  }
  let update;
  try {
    update = await c.req.json();
  } catch {
    return c.json({ ok: true }); // Telegram ретраит непонятные ответы — не даём поводов
  }
  await handleUpdate(update).catch((e) => console.error('handleUpdate error:', e));
  return c.json({ ok: true });
});

hono.onError((err, c) => {
  console.error('💥', err);
  return c.json({ error: 'Внутренняя ошибка сервера' }, 500);
});

export default {
  fetch: hono.fetch,
  // Cron Trigger (wrangler.toml [triggers] crons) — замена setInterval из
  // ../../bot.js startBot(): на Workers нет постоянно живущего процесса.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(remindUpcoming().catch((e) => console.error('remindUpcoming error:', e)));
  },
};
