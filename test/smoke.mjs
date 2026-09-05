/**
 * Смоук-тест против локального PGlite (без DATABASE_URL).
 * Запуск: npm test  (или: node test/smoke.mjs)
 * Чистит свою временную БД перед стартом.
 */
import { rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 5599;
const BASE = `http://127.0.0.1:${PORT}`;
const PGDIR = new URL('../.pglite-test', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

rmSync(PGDIR, { recursive: true, force: true });

const env = {
  ...process.env,
  PORT: String(PORT),
  PGLITE_DIR: PGDIR,
  DATABASE_URL: '',
  OWNER_PHONE: '+998900000000',
  OWNER_PASSWORD: 'owner-pass',
  TELEGRAM_BOT_TOKEN: '',
  CHAT_ID: '',
};

const server = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', (d) => process.stdout.write(`  [srv] ${d}`));
server.stderr.on('data', (d) => process.stderr.write(`  [srv!] ${d}`));

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ` — ${JSON.stringify(extra)}` : ''}`); }
}

async function api(method, path, body, token) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* no body */ }
  return { status: r.status, data };
}

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/health');
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('сервер не поднялся');
}

try {
  await waitUp();
  console.log('\n── Меню ──');
  const menu = await api('GET', '/api/menu');
  check('GET /api/menu → 56 сетов', menu.status === 200 && menu.data.length === 56, { n: menu.data?.length });

  console.log('\n── Владелец ──');
  const badLogin = await api('POST', '/api/auth/login', { phone: '+998900000000', password: 'wrong' });
  check('login с неверным паролем → 401', badLogin.status === 401);
  const ownerLogin = await api('POST', '/api/auth/login', { phone: '+998900000000', password: 'owner-pass' });
  check('login владельца → token + role owner', ownerLogin.status === 200 && ownerLogin.data.user.role === 'owner', ownerLogin.data);
  const ownerToken = ownerLogin.data?.token;

  const summaryNoAuth = await api('GET', '/api/owner/summary');
  check('owner/summary без токена → 401', summaryNoAuth.status === 401);

  console.log('\n── Компания + оптовый заказ ──');
  const reg = await api('POST', '/api/auth/register', {
    name: 'Иван', phone: '+998911112233', password: 'pass1234', companyName: 'Souvenir', companySize: 60,
  });
  check('регистрация компании → admin', reg.status === 201 && reg.data.user.role === 'admin', reg.data);
  const companyToken = reg.data?.token;

  const order = await api('POST', '/api/orders', {
    employeeCount: 60,
    paymentMethod: 'corporate',
    address: 'Ташкент, Завод',
    totalMonthlyPrice: 60 * 2 * 55000,
    lines: [
      { date: futureDate(2), setId: 1, setName: 'Аджахури с курицей', mainDish: 'Аджахури', salad: 'Оливье', beverage: 'Вода', portions: 1, unitPrice: 55000, lineTotal: 60 * 55000 },
      { date: futureDate(3), setId: 2, setName: 'Бефстроганов с рисом', mainDish: 'Бефстроганов', salad: 'Винегрет', beverage: 'Компот', portions: 1, unitPrice: 55000, lineTotal: 60 * 55000 },
    ],
  }, companyToken);
  check('оптовый заказ компании → 201 + номер', order.status === 201 && /^ORD-\d{4}$/.test(order.data.orderNumber || ''), order.data);
  check('заказ компании не lead', order.data?.isLead === false);

  const myOrders = await api('GET', '/api/my/orders', null, companyToken);
  check('GET /api/my/orders → 1 заказ с 2 строками', myOrders.data?.orders?.length === 1 && myOrders.data.orders[0].lines.length === 2, myOrders.data);

  console.log('\n── Заявка-лид (без входа) ──');
  const leadNoContact = await api('POST', '/api/orders', { lines: [{ date: futureDate(2), setName: 'Плов', portions: 1 }] });
  check('лид без контактов → 400', leadNoContact.status === 400);
  const lead = await api('POST', '/api/orders', {
    contactName: 'Пётр', contactPhone: '+998933334455', companyName: 'НоваяФирма',
    lines: [{ date: futureDate(4), setName: 'Плов', portions: 1, unitPrice: 55000, lineTotal: 55000 }],
    totalMonthlyPrice: 55000,
  });
  check('лид с контактами → 201 + isLead', lead.status === 201 && lead.data.isLead === true, lead.data);

  console.log('\n── Сводка владельца ──');
  const summary = await api('GET', '/api/owner/summary', null, ownerToken);
  check('owner/summary → 200', summary.status === 200);
  check('в сводке 1 новая заявка', summary.data?.leads?.new === 1, summary.data?.leads);
  check('деньги: ordered > 0, unpaid = ordered', summary.data?.money?.ordered > 0 && summary.data.money.unpaid === summary.data.money.ordered, summary.data?.money);
  check('byDate непустой (лист кухни)', Array.isArray(summary.data?.byDate) && summary.data.byDate.length >= 1, summary.data?.byDate);

  const kitchen = await api('GET', `/api/owner/kitchen?date=${futureDate(2)}`, null, ownerToken);
  check('owner/kitchen на дату → есть строки', kitchen.status === 200 && kitchen.data.totalPortions === 60, kitchen.data);

  console.log('\n── Смена статуса ──');
  const orderId = order.data.orderId;
  const paid = await api('POST', `/api/owner/orders/${orderId}/status`, { status: 'paid', note: 'оплата пришла' }, ownerToken);
  check('статус → paid', paid.status === 200 && paid.data.status === 'paid', paid.data);
  const summary2 = await api('GET', '/api/owner/summary', null, ownerToken);
  check('после оплаты unpaid уменьшился', summary2.data.money.unpaid < summary2.data.money.ordered, summary2.data.money);

  console.log('\n── Смена пароля ──');
  const pw = await api('POST', '/api/auth/password', { oldPassword: 'owner-pass', newPassword: 'new-owner-pass' }, ownerToken);
  check('смена пароля владельца → ok', pw.status === 200 && pw.data.ok === true, pw.data);
  const reLogin = await api('POST', '/api/auth/login', { phone: '+998900000000', password: 'new-owner-pass' });
  check('вход с новым паролем', reLogin.status === 200);

  console.log('\n── Команды (регрессия) ──');
  const empReg = await api('POST', '/api/auth/register', {
    name: 'Сотрудник', phone: '+998955556677', password: 'emp1234', companyCode: reg.data.user.companyCode,
  });
  check('сотрудник по коду → employee', empReg.status === 201 && empReg.data.user.role === 'employee', empReg.data);
  const empToken = empReg.data?.token;
  const setDays = await api('PUT', '/api/my/days', { dates: [futureDate(5), futureDate(6)] }, empToken);
  check('сотрудник задал расписание', setDays.status === 200 && setDays.data.dates.length === 2, setDays.data);
  const choice = await api('PUT', `/api/my/days/${futureDate(5)}/choice`, { setId: 3 }, empToken);
  check('сотрудник выбрал сет', choice.status === 200 && choice.data.choice.setId === 3, choice.data);
  const mgrReport = await api('GET', `/api/manager/report?date=${futureDate(5)}`, null, companyToken);
  check('менеджер видит план дня', mgrReport.status === 200 && mgrReport.data.scheduled === 1, mgrReport.data);
} catch (err) {
  failed++;
  console.error('\n💥 Тест упал:', err);
} finally {
  server.kill('SIGKILL');
  await sleep(300);
  rmSync(PGDIR, { recursive: true, force: true });
  console.log(`\n${failed === 0 ? '🎉' : '⚠️ '} Итог: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

function futureDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
