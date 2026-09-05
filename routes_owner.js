/** Сводка владельца (дядя): заказы, деньги/долги, лист для кухни, новые заявки. */
const db = require('./db');
const { sendTelegramReceipt } = require('./telegram');
const { auth, ownerOnly } = require('./auth');
const { isDateString, dateKey, todayTz } = require('./lib');
const { orderWithLines } = require('./routes_orders');

const STATUSES = ['new', 'confirmed', 'in_progress', 'delivered', 'paid', 'cancelled'];

function rangeFromQuery(q) {
  const today = todayTz();
  const plus = (days) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const from = isDateString(q.from) ? q.from : today;
  const to = isDateString(q.to) ? q.to : plus(7);
  return from <= to ? { from, to } : { from: to, to: from };
}

function register(app) {
  // ── Сводка ──────────────────────────────────────────────────────
  app.get('/api/owner/summary', auth, ownerOnly, async (req, res, next) => {
    try {
      const { from, to } = rangeFromQuery(req.query);

      const statusRows = await db.many(
        "SELECT status, COUNT(*)::int AS c FROM orders WHERE is_lead = false GROUP BY status",
      );
      const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
      let ordersTotal = 0;
      for (const r of statusRows) { byStatus[r.status] = r.c; ordersTotal += r.c; }

      const money = await db.one(`
        SELECT
          COALESCE(SUM(total_amount) FILTER (WHERE is_lead = false AND status <> 'cancelled'), 0)::bigint AS ordered,
          COALESCE(SUM(total_amount) FILTER (WHERE is_lead = false AND status = 'paid'), 0)::bigint AS paid
        FROM orders`);
      const ordered = Number(money.ordered);
      const paid = Number(money.paid);

      // Лист для кухни по датам диапазона (оптовые/подтверждённые заказы)
      const kitchenRows = await db.many(`
        SELECT ol.date::text AS date, ol.set_name,
               SUM(ol.portions * o.employee_count)::int AS portions,
               SUM(ol.line_total)::bigint AS amount
        FROM order_lines ol JOIN orders o ON o.id = ol.order_id
        WHERE o.is_lead = false AND o.status <> 'cancelled'
          AND ol.date BETWEEN $1 AND $2
        GROUP BY ol.date, ol.set_name
        ORDER BY ol.date, portions DESC`, [from, to]);

      const byDateMap = new Map();
      for (const r of kitchenRows) {
        const date = dateKey(r.date);
        if (!byDateMap.has(date)) byDateMap.set(date, { date, portions: 0, amount: 0, bySet: [] });
        const d = byDateMap.get(date);
        d.portions += r.portions;
        d.amount += Number(r.amount);
        d.bySet.push({ setName: r.set_name, portions: r.portions });
      }

      // «Команды»: сколько порций запланировано в диапазоне (грубо, по выбору сотрудников)
      const teams = await db.one(`
        SELECT COUNT(*)::int AS picked,
               COALESCE(SUM(c.set_price), 0)::bigint AS amount
        FROM choices c JOIN schedule s ON s.user_id = c.user_id AND s.date = c.date
        WHERE c.date BETWEEN $1 AND $2`, [from, to]);

      const leadsRows = await db.many(
        "SELECT id, contact_name, contact_phone, company_name, created_at FROM orders WHERE is_lead = true AND status = 'new' ORDER BY created_at DESC LIMIT 20",
      );

      res.json({
        range: { from, to },
        orders: { total: ordersTotal, byStatus },
        money: { ordered, paid, unpaid: ordered - paid },
        byDate: [...byDateMap.values()],
        teams: { pickedPortions: teams.picked, amount: Number(teams.amount) },
        leads: {
          new: leadsRows.length,
          recent: leadsRows.map((l) => ({
            id: l.id,
            number: `ORD-${String(l.id).padStart(4, '0')}`,
            contactName: l.contact_name,
            contactPhone: l.contact_phone,
            companyName: l.company_name,
            createdAt: l.created_at,
          })),
        },
      });
    } catch (err) { next(err); }
  });

  // ── Лист для кухни на конкретную дату ──────────────────────────
  app.get('/api/owner/kitchen', auth, ownerOnly, async (req, res, next) => {
    try {
      const date = req.query.date;
      if (!isDateString(date)) return res.status(400).json({ error: 'Укажите date=YYYY-MM-DD' });

      const bulk = await db.many(`
        SELECT ol.set_name, ol.beverage, ol.salad, ol.excluded,
               SUM(ol.portions * o.employee_count)::int AS portions,
               o.company_name
        FROM order_lines ol JOIN orders o ON o.id = ol.order_id
        WHERE o.is_lead = false AND o.status <> 'cancelled' AND ol.date = $1
        GROUP BY ol.set_name, ol.beverage, ol.salad, ol.excluded, o.company_name
        ORDER BY portions DESC`, [date]);

      const totalPortions = bulk.reduce((s, r) => s + r.portions, 0);
      res.json({
        date,
        totalPortions,
        lines: bulk.map((r) => ({
          setName: r.set_name,
          salad: r.salad,
          beverage: r.beverage,
          excluded: r.excluded ? JSON.parse(r.excluded) : [],
          portions: r.portions,
          company: r.company_name,
        })),
      });
    } catch (err) { next(err); }
  });

  // ── Список заказов ─────────────────────────────────────────────
  app.get('/api/owner/orders', auth, ownerOnly, async (req, res, next) => {
    try {
      const params = [];
      const where = [];
      if (req.query.status && STATUSES.includes(req.query.status)) {
        params.push(req.query.status); where.push(`status = $${params.length}`);
      }
      if (req.query.leads === '1') where.push('is_lead = true');
      else if (req.query.leads === '0') where.push('is_lead = false');
      const sql = `SELECT id FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 100`;
      const rows = await db.many(sql, params);
      const orders = [];
      for (const r of rows) orders.push(await orderWithLines(r.id));
      res.json({ orders });
    } catch (err) { next(err); }
  });

  app.get('/api/owner/orders/:id', auth, ownerOnly, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const order = Number.isInteger(id) ? await orderWithLines(id) : null;
      if (!order) return res.status(404).json({ error: 'Заказ не найден' });
      const log = await db.many('SELECT status, note, changed_at FROM order_status_log WHERE order_id = $1 ORDER BY changed_at', [id]);
      res.json({ ...order, log });
    } catch (err) { next(err); }
  });

  // ── Смена статуса заказа ───────────────────────────────────────
  app.post('/api/owner/orders/:id/status', auth, ownerOnly, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const { status, note } = req.body || {};
      if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Неизвестный статус' });
      const order = await db.one('SELECT * FROM orders WHERE id = $1', [id]);
      if (!order) return res.status(404).json({ error: 'Заказ не найден' });

      await db.tx(async (t) => {
        await t.query('UPDATE orders SET status = $1, updated_at = now() WHERE id = $2', [status, id]);
        await t.query('INSERT INTO order_status_log (order_id, status, note, changed_by) VALUES ($1,$2,$3,$4)',
          [id, status, typeof note === 'string' ? note : null, req.user.id]);
      });

      if (status === 'confirmed' || status === 'cancelled') {
        try {
          await sendTelegramReceipt(`🔔 Заказ ORD-${String(id).padStart(4, '0')} → *${status}*${note ? `\n${note}` : ''}`);
        } catch { /* не критично */ }
      }
      res.json(await orderWithLines(id));
    } catch (err) { next(err); }
  });
}

module.exports = { register };
