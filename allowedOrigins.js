/**
 * С каких сайтов браузеру можно ходить в API (аудит 25.09.2026, М-7). Раньше было cors() = любой сайт.
 * Авторизация по Bearer-токену, не cookie, так что CSRF и раньше не грозил — это закрывает чтение
 * публичных ответов API чужими страницами. На запросы без Origin (вебхук Telegram, cron, сторож,
 * curl) CORS не влияет вообще.
 */
const ALLOWED = [
  /^https:\/\/([a-z0-9-]+\.)?lunchistan-(app|core)\.pages\.dev$/, // прод + превью-сборки Cloudflare Pages
  /^https:\/\/(www\.)?lunchistan\.uz$/, // будущий домен (TMA_URL по умолчанию раньше вёл сюда)
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/, // разработка и сквозной тест
];

function isAllowedOrigin(origin) {
  return typeof origin === 'string' && ALLOWED.some((re) => re.test(origin));
}

module.exports = { isAllowedOrigin };
