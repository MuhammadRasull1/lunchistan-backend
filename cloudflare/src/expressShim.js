/**
 * Тонкая совместимость с Express для Cloudflare Workers/Hono.
 *
 * routes.js, routes_orders.js, routes_owner.js, routes_delivery.js — те же
 * самые файлы, что использует Render (`../../routes.js` и т.д.), не копии.
 * Каждый экспортирует register(app) и пишет обработчики в стиле
 * Express: (req, res, next) => {...}, middleware цепочкой, res.status().json().
 *
 * Здесь app — не настоящий Express, а прослойка поверх Hono: каждый
 * app.get/post/put/delete(path, ...handlers) регистрирует один Hono-роут,
 * который внутри последовательно прогоняет express-style handlers с тем
 * же поведением next()/короткого замыкания, что и в Express.
 */

const INVALID_JSON = Symbol('invalid-json');

/** Строит req-подобный объект из Hono Context. Пустое тело → {} (как
 * express.json() на пустом POST), нечитаемый JSON → req.body = INVALID_JSON
 * (см. toHonoHandler — там это превращается в те же 400, что у Express
 * express.json() при синтаксической ошибке, вместо тихой подмены на {}). */
async function buildReq(c) {
  let body = {};
  const method = c.req.method;
  if (method !== 'GET' && method !== 'HEAD') {
    const text = await c.req.text();
    if (text && text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        body = INVALID_JSON;
      }
    }
  }
  const url = new URL(c.req.url);
  return {
    method,
    body,
    params: c.req.param(),
    query: Object.fromEntries(url.searchParams),
    headers: Object.fromEntries(c.req.raw.headers),
    // CF-Connecting-IP — реальный IP клиента на границе сети Cloudflare
    // (аналог req.ip за доверенным прокси в Express, см. server.js "trust proxy").
    ip: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown',
    user: undefined,
  };
}

/** Запускает цепочку express-style (req,res,next) в стиле Express: следующий
 * вызывается только если предыдущий вызвал next() без отправки ответа. */
function runChain(handlers, req) {
  return new Promise((resolve, reject) => {
    let i = 0;
    let settled = false;
    const result = { status: 200, body: undefined, sent: false };
    const res = {
      status(code) {
        result.status = code;
        return res;
      },
      json(body) {
        if (settled) return res;
        settled = true;
        result.body = body;
        result.sent = true;
        resolve(result);
        return res;
      },
    };
    function next(err) {
      if (settled) return;
      if (err) {
        settled = true;
        reject(err);
        return;
      }
      const handler = handlers[i++];
      if (!handler) {
        settled = true;
        resolve(result); // ни один res.json() не вызван — сообщаем вызывающему
        return;
      }
      Promise.resolve(handler(req, res, next)).catch((e) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      });
    }
    next();
  });
}

function toHonoHandler(handlers) {
  return async (c) => {
    const req = await buildReq(c);
    if (req.body === INVALID_JSON) {
      return c.json({ error: 'Невалидный JSON в теле запроса' }, 400);
    }
    const result = await runChain(handlers, req);
    if (!result.sent) {
      // Обработчик ничего не отправил (не должно случаться при корректной
      // регистрации, но не роняем Worker молча).
      return c.json({ error: 'Обработчик не отправил ответ' }, 500);
    }
    return c.json(result.body, result.status);
  };
}

class ExpressLikeApp {
  constructor(hono) {
    this.hono = hono;
  }
  get(path, ...handlers) {
    this.hono.get(path, toHonoHandler(handlers));
  }
  post(path, ...handlers) {
    this.hono.post(path, toHonoHandler(handlers));
  }
  put(path, ...handlers) {
    this.hono.put(path, toHonoHandler(handlers));
  }
  delete(path, ...handlers) {
    this.hono.delete(path, toHonoHandler(handlers));
  }
  // app.set('trust proxy', 1) — на Workers всегда реальный edge-запрос, no-op.
  set() {}
}

module.exports = { ExpressLikeApp, buildReq, runChain };
