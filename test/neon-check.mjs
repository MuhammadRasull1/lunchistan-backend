/**
 * Разовая проверка против настоящего Neon Postgres.
 * Запуск:  DATABASE_URL="postgres://..." node test/neon-check.mjs
 * Прогоняет миграцию + сид меню, проверяет «сложные» SQL из routes_owner на
 * временных данных внутри транзакции с ROLLBACK — реальных данных не оставляет.
 */
import db from '../db.js';

const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m, e) => { console.log(`  ❌ ${m}`); if (e) console.log(e); process.exitCode = 1; };

try {
  await db.ready();
  ok(`подключение к Neon, драйвер = ${db.kind}`);

  const menu = await db.one('SELECT COUNT(*)::int AS c FROM menu_sets');
  menu.c === 56 ? ok(`меню: ${menu.c} сетов`) : bad(`меню: ${menu.c} (ожидалось 56)`);

  const owners = await db.one("SELECT COUNT(*)::int AS c FROM users WHERE role = 'owner'");
  console.log(`  ℹ️  аккаунтов владельца: ${owners.c} (создаётся на Render по OWNER_PHONE/OWNER_PASSWORD)`);

  // Проверяем сложные запросы владельца на временных данных, всё откатываем.
  await db.tx(async (t) => {
    const co = await t.one("INSERT INTO companies (code, name, size) VALUES ('ZZTEST', 'ТестCo', 10) RETURNING id");
    const o = await t.one(
      `INSERT INTO orders (company_id, source, is_lead, status, contact_name, contact_phone,
        company_name, payment_method, employee_count, total_amount)
       VALUES ($1,'bulk',false,'new','Тест','+998','ТестCo','corporate',10,5500000) RETURNING id`,
      [co.id],
    );
    await t.query(
      `INSERT INTO order_lines (order_id, date, set_id, set_name, main_dish, salad, beverage, excluded, portions, unit_price, line_total)
       VALUES ($1, CURRENT_DATE + 2, 1, 'Аджахури', 'Аджахури', 'Оливье', 'Вода', '[]', 1, 55000, 550000)`,
      [o.id],
    );

    const money = await t.one(`
      SELECT COALESCE(SUM(total_amount) FILTER (WHERE is_lead = false AND status <> 'cancelled'), 0)::bigint AS ordered,
             COALESCE(SUM(total_amount) FILTER (WHERE is_lead = false AND status = 'paid'), 0)::bigint AS paid
      FROM orders`);
    Number(money.ordered) >= 5500000 ? ok('SQL: FILTER + ::bigint (деньги)') : bad('деньги', money);

    const kitchen = await t.many(`
      SELECT ol.date::text AS date, ol.set_name,
             SUM(ol.portions * o.employee_count)::int AS portions,
             SUM(ol.line_total)::bigint AS amount
      FROM order_lines ol JOIN orders o ON o.id = ol.order_id
      WHERE o.is_lead = false AND o.status <> 'cancelled'
        AND ol.date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7
      GROUP BY ol.date, ol.set_name ORDER BY ol.date, portions DESC`);
    kitchen.length === 1 && kitchen[0].portions === 10
      ? ok('SQL: JOIN + GROUP BY + ::text/::int (лист кухни)')
      : bad('лист кухни', kitchen);

    const teams = await t.one(`
      SELECT COUNT(*)::int AS picked, COALESCE(SUM(c.set_price), 0)::bigint AS amount
      FROM choices c JOIN schedule s ON s.user_id = c.user_id AND s.date = c.date
      WHERE c.date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7`);
    ok(`SQL: команды-агрегат (picked=${teams.picked})`);

    throw { rollback: true };
  }).catch((e) => {
    if (e && e.rollback) ok('временные данные откатаны (ROLLBACK)');
    else throw e;
  });

  const stillClean = await db.one("SELECT COUNT(*)::int AS c FROM orders");
  stillClean.c === 0 ? ok('в orders пусто — мусор не остался') : bad(`в orders ${stillClean.c} строк`);

  console.log('\n🎉 Neon готов к деплою');
} catch (err) {
  bad('проверка упала', err);
} finally {
  await db.close();
  process.exit(process.exitCode || 0);
}
