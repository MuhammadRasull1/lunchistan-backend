/** Оптовые заказы (основной клиентский поток) + заявки-лиды с лендинга. */
const db = require('./db');
const { sendTelegramReceipt } = require('./telegram');
const { sendClientReceipt } = require('./bot');
const { auth, optionalAuth, verifiedTelegramUserFromRequest } = require('./auth');
const { isDateString, dateKey } = require('./lib');
const { quote } = require('./logistics');

const PAYMENT_METHODS = new Set(['corporate', 'card', 'cash']);
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Приводит тело заказа с фронтенда к массиву строк {date,setName,...}. */
function extractLines(body) {
  const src = Array.isArray(body.lines) && body.lines.length ? body.lines
    : Array.isArray(body.days) && body.days.length && typeof body.days[0] === 'object' ? body.days
      : [];
  return src
    .filter((l) => l && typeof l === 'object' && !Array.isArray(l))
    .map((l) => ({
      date: String(l.date || ''),
      setId: Number.isInteger(l.setId) ? l.setId : null,
      setName: String(l.setName || l.mainDish || 'Сет'),
      mainDish: String(l.mainDish || l.setName || ''),
      salad: String(l.salad || ''),
      beverage: String(l.beverage || ''),
      excluded: Array.isArray(l.excludedIngredients) ? l.excludedIngredients : [],
      portions: Math.max(1, num(l.portions, 1)),
      unitPrice: num(l.unitPrice ?? l.price, 0),
      lineTotal: num(l.lineTotal ?? l.total, 0),
    }));
}

/** Реальные цены блюд из БД по setId (единственный источник правды — не то, что прислал клиент). */
async function pricesForSetIds(setIds) {
  const ids = [...new Set(setIds.filter((id) => Number.isInteger(id)))];
  if (!ids.length) return new Map();
  const rows = await db.many('SELECT id, price FROM menu_sets WHERE id = ANY($1)', [ids]);
  return new Map(rows.map((r) => [r.id, Number(r.price)]));
}

function validate(lines, body) {
  const errors = [];
  if (lines.length === 0) errors.push('Не передан состав заказа (lines / days)');
  const seen = new Set();
  for (const l of lines) {
    if (!isDateString(l.date)) errors.push(`Некорректная дата: "${l.date}"`);
    else if (seen.has(l.date)) errors.push(`Дубликат даты: ${l.date}`);
    else seen.add(l.date);
    if (!nonEmpty(l.setName)) errors.push('У одной из строк нет блюда');
  }
  if (body.paymentMethod && !PAYMENT_METHODS.has(body.paymentMethod)) {
    errors.push('Неизвестный способ оплаты');
  }
  return errors;
}

function receiptText(order, lines) {
  const dt = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent' });
  const fmtDate = (v) => String(v).split('-').reverse().join('.');
  const out = [
    order.is_lead ? '📨 *Новая заявка Lunchistan*' : '🍱 *Новый заказ Lunchistan*',
    `🕒 ${dt}`,
    `🔖 №${order.number}`,
    '',
  ];
  if (order.company_name || order.contact_name) {
    out.push(`🏢 ${order.company_name || '—'}`);
    out.push(`👤 ${order.contact_name || '—'}${order.contact_phone ? ` · ${order.contact_phone}` : ''}`);
    // Ссылка на реальный аккаунт Telegram: username → t.me, иначе прямой ID.
    const tgLink = order.tg_username
      ? `https://t.me/${order.tg_username.replace(/^@/, '')}`
      : order.tg_user_id ? `tg://user?id=${order.tg_user_id}` : null;
    if (tgLink) out.push(`✈️ ${tgLink}`);
    out.push('');
  }
  // Доставка «до двери»: адрес + детали + ссылка на карту
  if (order.dest_lat != null && order.dest_lon != null) {
    const mapUrl = `https://yandex.com/maps/?pt=${order.dest_lon},${order.dest_lat}&z=17&l=map`;
    out.push(`🚚 Доставка: ${order.address || 'по координатам'}${order.dest_detail ? `\n   ${order.dest_detail}` : ''}`);
    out.push(`🗺 ${mapUrl}`);
    if (order.delivery_fee) out.push(`🚗 Доставка: ${Number(order.delivery_fee).toLocaleString('ru-RU')} UZS`);
    out.push('');
  }
  out.push('🧾 Состав:');
  for (const l of lines) {
    out.push(`📅 ${fmtDate(l.date)} — ${l.setName} × ${l.portions} порц./сотр.`);
  }
  out.push('');
  if (order.employee_count) out.push(`👥 Сотрудников: ${order.employee_count}`);
  if (order.payment_method) out.push(`💳 Оплата: ${order.payment_method}`);
  if (order.total_amount) out.push(`💰 Итого: ${Number(order.total_amount).toLocaleString('ru-RU')} UZS`);
  if (order.comment) out.push(`💬 ${order.comment}`);
  return out.join('\n');
}

async function orderWithLines(id) {
  const order = await db.one('SELECT * FROM orders WHERE id = $1', [id]);
  if (!order) return null;
  const lines = await db.many('SELECT * FROM order_lines WHERE order_id = $1 ORDER BY date', [id]);
  return {
    id: order.id,
    number: `ORD-${String(order.id).padStart(4, '0')}`,
    status: order.status,
    source: order.source,
    isLead: order.is_lead,
    companyId: order.company_id,
    companyName: order.company_name,
    contactName: order.contact_name,
    contactPhone: order.contact_phone,
    tgUserId: order.tg_user_id,
    tgUsername: order.tg_username,
    address: order.address,
    comment: order.comment,
    paymentMethod: order.payment_method,
    employeeCount: order.employee_count,
    totalAmount: Number(order.total_amount),
    createdAt: order.created_at,
    lines: lines.map((l) => ({
      date: dateKey(l.date),
      setId: l.set_id,
      setName: l.set_name,
      mainDish: l.main_dish,
      salad: l.salad,
      beverage: l.beverage,
      excluded: l.excluded ? JSON.parse(l.excluded) : [],
      portions: l.portions,
      unitPrice: Number(l.unit_price),
      lineTotal: Number(l.line_total),
    })),
  };
}

function register(app) {
  /**
   * Создание заказа.
   *  - с валидным токеном  → заказ компании (source=bulk, is_lead=false, status=new);
   *  - без токена          → заявка-лид (source=lead, is_lead=true) — нужны контакты.
   */
  app.post('/api/orders', optionalAuth, async (req, res, next) => {
    try {
      const body = req.body || {};
      const lines = extractLines(body);
      const errors = validate(lines, body);
      if (errors.length) return res.status(400).json({ error: 'Некорректные данные заказа', details: errors });

      const authed = Boolean(req.user);
      const contactName = nonEmpty(body.contactName) ? body.contactName.trim() : (req.user ? req.user.name : null);
      const contactPhone = nonEmpty(body.contactPhone) ? body.contactPhone.trim() : (req.user ? req.user.phone : null);

      let companyId = null;
      let companyName = nonEmpty(body.companyName) ? body.companyName.trim() : null;
      if (authed && req.user.company_id) {
        companyId = req.user.company_id;
        const c = await db.one('SELECT name FROM companies WHERE id = $1', [companyId]);
        companyName = companyName || (c ? c.name : null);
      }

      if (!authed && (!contactName || !contactPhone)) {
        return res.status(400).json({ error: 'Для заявки без входа укажите contactName и contactPhone' });
      }

      const employeeCount = Math.max(1, num(body.employeeCount, 1));

      // Цену НЕ берём из тела запроса — только из БД по setId. Клиент прислал
      // unitPrice/lineTotal/totalMonthlyPrice просто для отображения себе,
      // сервер это игнорирует (см. ОШИБКИ.md — раньше можно было заказать за 1 сум).
      const realPrices = await pricesForSetIds(lines.map((l) => l.setId));
      if (authed) {
        const unknownSet = lines.find((l) => !realPrices.has(l.setId));
        if (unknownSet) {
          return res.status(400).json({ error: `Неизвестное блюдо в заказе (id: ${unknownSet.setId})` });
        }
        for (const l of lines) {
          l.unitPrice = realPrices.get(l.setId);
          l.lineTotal = l.unitPrice * l.portions * employeeCount;
        }
      } else {
        // Заявка-лид без входа: если setId всё же указан — тоже доверяем только БД;
        // иначе (внешняя заявка без каталога) — цифры от клиента, но не отрицательные.
        for (const l of lines) {
          if (realPrices.has(l.setId)) {
            l.unitPrice = realPrices.get(l.setId);
            l.lineTotal = l.unitPrice * l.portions * employeeCount;
          } else {
            l.unitPrice = Math.max(0, l.unitPrice);
            l.lineTotal = Math.max(0, l.lineTotal || l.unitPrice * l.portions * employeeCount);
          }
        }
      }

      const totalAmount = authed
        ? lines.reduce((s, l) => s + l.lineTotal, 0)
        : Math.max(0, num(body.totalMonthlyPrice ?? body.totalPrice, 0)) || lines.reduce((s, l) => s + l.lineTotal, 0);

      const paymentMethod = PAYMENT_METHODS.has(body.paymentMethod) ? body.paymentMethod : null;

      // Telegram-личность — только из подписанной initData (заголовок), никогда из тела
      // запроса: иначе можно было создать заказ «от имени» произвольного tg_user_id
      // и заспамить его чеком/увидеть его данные через /status.
      const verifiedTg = verifiedTelegramUserFromRequest(req);

      // Идемпотентность: повторный клик/ретрай с тем же ключом не создаёт второй заказ.
      const idempotencyKey = nonEmpty(body.idempotencyKey) ? body.idempotencyKey.trim().slice(0, 100) : null;
      if (idempotencyKey) {
        const existing = await db.one('SELECT * FROM orders WHERE idempotency_key = $1', [idempotencyKey]);
        if (existing) {
          return res.status(200).json({
            success: true,
            orderId: existing.id,
            orderNumber: `ORD-${String(existing.id).padStart(4, '0')}`,
            status: existing.status,
            isLead: existing.is_lead,
            telegramSent: true, // уже был отправлен при первом (реальном) создании
            deliveryFee: Number(existing.delivery_fee) || 0,
            deliveryZone: null,
            totalWithDelivery: Number(existing.total_amount),
          });
        }
      }

      // Доставка «до двери»: координаты + детали (подъезд/этаж/домофон/ориентир)
      const destLat = typeof body.destLat === 'number' && Number.isFinite(body.destLat) ? body.destLat : null;
      const destLon = typeof body.destLon === 'number' && Number.isFinite(body.destLon) ? body.destLon : null;
      const destDetail = nonEmpty(body.destDetail) ? body.destDetail.trim().slice(0, 500) : null;

      let deliveryQuote = null;
      if (destLat != null && destLon != null) {
        deliveryQuote = await quote(destLat, destLon, totalAmount);
        if (!deliveryQuote.ok) {
          return res.status(400).json({ error: 'Некорректные координаты доставки' });
        }
      }
      const deliveryFee = deliveryQuote ? deliveryQuote.fee : 0;

      let order;
      try {
        order = await db.tx(async (t) => {
          const o = await t.one(
            `INSERT INTO orders
               (company_id, source, is_lead, status, contact_name, contact_phone, company_name,
                address, dest_lat, dest_lon, dest_detail, delivery_fee, comment, tg_user_id,
                tg_username, payment_method, employee_count, total_amount, idempotency_key)
             VALUES ($1,$2,$3,'new',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
            [
              companyId,
              authed ? 'bulk' : 'lead',
              !authed,
              contactName,
              contactPhone,
              companyName,
              nonEmpty(body.address) ? body.address.trim() : null,
              destLat,
              destLon,
              destDetail,
              deliveryFee,
              nonEmpty(body.comment) ? body.comment.trim() : null,
              verifiedTg ? verifiedTg.id : null,
              verifiedTg ? verifiedTg.username : null,
              paymentMethod,
              employeeCount,
              Math.round(totalAmount),
              idempotencyKey,
            ],
          );
        for (const l of lines) {
          await t.query(
            `INSERT INTO order_lines
               (order_id, date, set_id, set_name, main_dish, salad, beverage, excluded, portions, unit_price, line_total)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              o.id, l.date, l.setId, l.setName, l.mainDish, l.salad, l.beverage,
              JSON.stringify(l.excluded), l.portions, Math.round(l.unitPrice),
              Math.round(l.lineTotal || l.unitPrice * l.portions * employeeCount),
            ],
          );
        }
          await t.query('INSERT INTO order_status_log (order_id, status, note) VALUES ($1,$2,$3)', [o.id, 'new', 'Создан']);
          return o;
        });
      } catch (err) {
        // Гонка двойного клика: обе попытки прошли проверку "нет такого ключа"
        // до того, как первая закоммитилась — вторая словит нарушение уникальности.
        if (idempotencyKey && err.code === '23505') {
          const existing = await db.one('SELECT * FROM orders WHERE idempotency_key = $1', [idempotencyKey]);
          if (existing) {
            return res.status(200).json({
              success: true,
              orderId: existing.id,
              orderNumber: `ORD-${String(existing.id).padStart(4, '0')}`,
              status: existing.status,
              isLead: existing.is_lead,
              telegramSent: true,
              deliveryFee: Number(existing.delivery_fee) || 0,
              deliveryZone: null,
              totalWithDelivery: Number(existing.total_amount),
            });
          }
        }
        throw err;
      }

      order.number = `ORD-${String(order.id).padStart(4, '0')}`;

      let telegramSent = true;
      try {
        const r = await sendTelegramReceipt(receiptText(order, lines));
        telegramSent = Boolean(r.ok);
      } catch (err) {
        telegramSent = false;
        console.error('Telegram-чек не отправлен:', err.message);
      }

      // Чек клиенту в личку
      if (order.tg_user_id) {
        const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const clientReceipt = [
          '✅ <b>Ваш заказ Lunchistan принят!</b>',
          '',
          `🔖 №${order.number}`,
          `📅 ${esc(lines.map((l) => l.date).join(', '))}`,
          `💰 ${Number(order.total_amount).toLocaleString('ru-RU')} UZS`,
        ];
        if (order.dest_lat != null) {
          clientReceipt.push(`📍 ${esc(order.address || 'по координатам')}`);
          if (order.dest_detail) clientReceipt.push(`🚪 ${esc(order.dest_detail)}`);
        }
        if (order.delivery_fee) {
          clientReceipt.push(`🚗 Доставка: ${esc(Number(order.delivery_fee).toLocaleString('ru-RU'))} UZS`);
        }
        clientReceipt.push(
          '',
          '🚚 Мы скоро свяжемся с вами для подтверждения.',
          '📦 Статус заказа: /status',
        );
        sendClientReceipt(order.tg_user_id, clientReceipt.join('\n')).catch(() => {});
      }

      res.status(201).json({
        success: true,
        orderId: order.id,
        orderNumber: order.number,
        status: order.status,
        isLead: order.is_lead,
        telegramSent,
        deliveryFee,
        deliveryZone: deliveryQuote ? deliveryQuote.zone : null,
        totalWithDelivery: Math.round(totalAmount) + deliveryFee,
      });
    } catch (err) { next(err); }
  });

  // Заказы моей компании
  app.get('/api/my/orders', auth, async (req, res, next) => {
    try {
      if (!req.user.company_id) return res.json({ orders: [] });
      const rows = await db.many(
        'SELECT id FROM orders WHERE company_id = $1 ORDER BY created_at DESC LIMIT 50',
        [req.user.company_id],
      );
      const orders = [];
      for (const r of rows) orders.push(await orderWithLines(r.id));
      res.json({ orders });
    } catch (err) { next(err); }
  });

  app.get('/api/my/orders/:id', auth, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const order = Number.isInteger(id) ? await orderWithLines(id) : null;
      if (!order || order.companyId !== req.user.company_id) return res.status(404).json({ error: 'Заказ не найден' });
      res.json(order);
    } catch (err) { next(err); }
  });
}

module.exports = { register, orderWithLines };
