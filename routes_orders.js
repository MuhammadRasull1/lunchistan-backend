/** Оптовые заказы (основной клиентский поток) + заявки-лиды с лендинга. */
const db = require('./db');
const { sendTelegramReceipt } = require('./telegram');
const { auth, optionalAuth } = require('./auth');
const { isDateString, dateKey } = require('./lib');

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
    if (order.address) out.push(`📍 ${order.address}`);
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
      const totalAmount = num(body.totalMonthlyPrice ?? body.totalPrice, 0)
        || lines.reduce((s, l) => s + (l.lineTotal || l.unitPrice * l.portions * employeeCount), 0);
      const paymentMethod = PAYMENT_METHODS.has(body.paymentMethod) ? body.paymentMethod : null;

      const order = await db.tx(async (t) => {
        const o = await t.one(
          `INSERT INTO orders
             (company_id, source, is_lead, status, contact_name, contact_phone, company_name,
              address, comment, payment_method, employee_count, total_amount)
           VALUES ($1,$2,$3,'new',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [
            companyId,
            authed ? 'bulk' : 'lead',
            !authed,
            contactName,
            contactPhone,
            companyName,
            nonEmpty(body.address) ? body.address.trim() : null,
            nonEmpty(body.comment) ? body.comment.trim() : null,
            paymentMethod,
            employeeCount,
            Math.round(totalAmount),
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

      order.number = `ORD-${String(order.id).padStart(4, '0')}`;

      let telegramSent = true;
      try {
        const r = await sendTelegramReceipt(receiptText(order, lines));
        telegramSent = Boolean(r.ok);
      } catch (err) {
        telegramSent = false;
        console.error('Telegram-чек не отправлен:', err.message);
      }

      res.status(201).json({
        success: true,
        orderId: order.id,
        orderNumber: order.number,
        status: order.status,
        isLead: order.is_lead,
        telegramSent,
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
