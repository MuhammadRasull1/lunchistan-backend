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
  AUTH_MAX_ATTEMPTS: '100',
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

  console.log('\n── Меню по датам (daily_menu) ──');
  // 17.09.2026: блюда больше не повторяются по ротации — на каждую дату,
  // используемую ниже в тесте, владелец должен явно внести меню.
  for (const offset of [2, 3, 4, 5, 6]) {
    const d = futureDate(offset);
    const put = await api('PUT', `/api/owner/daily-menu/${d}`, { setIds: [1, 2, 3] }, ownerToken);
    check(`owner/daily-menu PUT на ${d} → сохранено`, put.status === 200 && put.data.setIds.length === 3, put.data);
  }
  const dayMenu = await api('GET', `/api/menu/day/${futureDate(2)}`);
  check('menu/day → 3 блюда', dayMenu.status === 200 && dayMenu.data.sets.length === 3, dayMenu.data);
  const emptyDayMenu = await api('GET', `/api/menu/day/${futureDate(30)}`);
  check('menu/day без меню → пусто', emptyDayMenu.status === 200 && emptyDayMenu.data.sets.length === 0, emptyDayMenu.data);
  const availableDates = await api('GET', '/api/menu/available-dates');
  check(
    'menu/available-dates включает внесённую дату, не включает пустую',
    availableDates.status === 200
      && availableDates.data.dates.includes(futureDate(2))
      && !availableDates.data.dates.includes(futureDate(30)),
    availableDates.data,
  );
  const orderNoMenu = await api('POST', '/api/orders', {
    contactName: 'Без меню', contactPhone: '+998900000099',
    lines: [{ date: futureDate(30), setId: 1, setName: 'Тест', portions: 1 }],
  });
  check('заказ на дату без внесённого меню → 400', orderNoMenu.status === 400, orderNoMenu.data);

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

  console.log('\n── Разлогин (срок жизни сессии) ──');
  const logoutReg = await api('POST', '/api/auth/register', {
    name: 'Разлогин', phone: '+998955559900', password: 'logout123', companyName: 'ЛогинФирма',
  });
  const logoutToken = logoutReg.data?.token;
  const beforeLogout = await api('GET', '/api/me', null, logoutToken);
  check('токен рабочий до разлогина', beforeLogout.status === 200, beforeLogout.data);
  const logout = await api('POST', '/api/auth/logout', null, logoutToken);
  check('logout → ok', logout.status === 200 && logout.data.ok === true, logout.data);
  const afterLogout = await api('GET', '/api/me', null, logoutToken);
  check('токен недействителен после разлогина → 401', afterLogout.status === 401, afterLogout.data);

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

  console.log('\n── «Кор»: подтверждение дня создаёт деньги (bug 3.1) ──');
  const confirmDate = futureDate(6);
  const confirm = await api('POST', `/api/manager/report/${confirmDate}/confirm`, {}, companyToken);
  check('confirm → 201', confirm.status === 201 && confirm.data.success === true, confirm.data);
  const summaryKor = await api('GET', '/api/owner/summary', null, ownerToken);
  check('в сводке появился korInvoiced > 0', summaryKor.data?.money?.korInvoiced > 0, summaryKor.data?.money);
  check('korUnpaid = korInvoiced (ещё не оплачено)', summaryKor.data.money.korUnpaid === summaryKor.data.money.korInvoiced, summaryKor.data.money);
  const invoices = await api('GET', '/api/owner/invoices', null, ownerToken);
  check('owner/invoices → есть счёт со статусом open', invoices.status === 200 && invoices.data.invoices.some((i) => i.status === 'open' && i.totalAmount > 0), invoices.data);
  const invoiceRow = invoices.data.invoices.find((i) => i.totalAmount > 0);
  const invoiceId = invoiceRow.id;
  const partial = Math.floor(invoiceRow.totalAmount / 2) || 1;
  const payment = await api('POST', `/api/owner/invoices/${invoiceId}/payments`, { amount: partial, method: 'card' }, ownerToken);
  check('частичная оплата → paidAmount учтён, статус ещё open', payment.status === 200 && payment.data.paidAmount === partial && payment.data.status === 'open', payment.data);
  const fullPayment = await api('POST', `/api/owner/invoices/${invoiceId}/payments`, { amount: payment.data.unpaidAmount, method: 'card' }, ownerToken);
  check('полная оплата → статус paid', fullPayment.status === 200 && fullPayment.data.status === 'paid' && fullPayment.data.unpaidAmount === 0, fullPayment.data);

  console.log('\n── Управление сотрудниками менеджером (bug 4f/4g) ──');
  // Отдельный одноразовый сотрудник — не трогаем «Сотрудник» из более ранних
  // тестов (на него завязана регрессия на дубль имени ниже по файлу).
  const tempEmpReg = await api('POST', '/api/auth/register', {
    name: 'Временный', phone: '+998955559911', password: 'temp1234', companyCode: reg.data.user.companyCode,
  });
  const empList = await api('GET', '/api/manager/employees', null, companyToken);
  check('менеджер видит список сотрудников', empList.status === 200 && empList.data.employees.some((e) => e.name === 'Временный'), empList.data);
  const empId = tempEmpReg.data.user.id;
  const resetPw = await api('POST', `/api/manager/employees/${empId}/reset-password`, {}, companyToken);
  check('сброс пароля сотрудника → новый пароль', resetPw.status === 200 && typeof resetPw.data.newPassword === 'string' && resetPw.data.newPassword.length >= 4, resetPw.data);
  const loginNewPw = await api('POST', '/api/auth/login', { phone: '+998955559911', password: resetPw.data.newPassword });
  check('вход с новым паролем после сброса', loginNewPw.status === 200, loginNewPw.data);
  const delEmp = await api('DELETE', `/api/manager/employees/${empId}`, null, companyToken);
  check('увольнение сотрудника → ok', delEmp.status === 200 && delEmp.data.ok === true, delEmp.data);
  const loginAfterDelete = await api('POST', '/api/auth/login', { phone: '+998955559911', password: resetPw.data.newPassword });
  check('уволенный сотрудник больше не может войти', loginAfterDelete.status === 401, loginAfterDelete.data);
  const summaryAfterFire = await api('GET', '/api/owner/summary', null, ownerToken);
  check('увольнение не откатило деньги за уже подтверждённый день (bug 4j)', summaryAfterFire.data.money.korInvoiced === summaryKor.data.money.korInvoiced, summaryAfterFire.data.money);

  console.log('\n── Клиент: отмена и повтор заказа (bug 4c/4d) ──');
  const repeatLines = await api('GET', `/api/my/orders/${orderId}/repeat-lines`, null, companyToken);
  check('repeat-lines → строки прошлого заказа', repeatLines.status === 200 && repeatLines.data.lines.length === 2, repeatLines.data);
  const cancelOrder2 = await api('POST', `/api/orders`, {
    employeeCount: 5, paymentMethod: 'cash', totalMonthlyPrice: 5 * 55000,
    lines: [{ date: futureDate(3), setId: 2, setName: 'Бефстроганов', portions: 1, unitPrice: 55000, lineTotal: 5 * 55000 }],
  }, companyToken);
  const cancel = await api('POST', `/api/my/orders/${cancelOrder2.data.orderId}/cancel`, null, companyToken);
  check('клиент отменяет свой new-заказ', cancel.status === 200 && cancel.data.status === 'cancelled', cancel.data);
  const cancelAgain = await api('POST', `/api/my/orders/${cancelOrder2.data.orderId}/cancel`, null, companyToken);
  check('повторная отмена уже отменённого → 409', cancelAgain.status === 409, cancelAgain.data);
  const cancelPaid = await api('POST', `/api/my/orders/${orderId}/cancel`, null, companyToken);
  check('отменить оплаченный заказ самостоятельно нельзя → 409', cancelPaid.status === 409, cancelPaid.data);

  console.log('\n── Дубль имени в компании (запрет) ──');
  const dupReg = await api('POST', '/api/auth/register', {
    name: '  сотрудник  ', phone: '+998955556688', password: 'emp1234', companyCode: reg.data.user.companyCode,
  });
  check('дубль имени (регистр/пробелы не спасают) → 409', dupReg.status === 409, dupReg.data);

  console.log('\n── Тёзки в разных компаниях ──');
  const co2 = await api('POST', '/api/auth/register', {
    name: 'Бошлиқ', phone: '+998955550001', password: 'boss1234', companyName: 'Вторая фирма',
  });
  const code2 = co2.data?.user?.companyCode;
  const twin = await api('POST', '/api/auth/register', {
    name: 'Сотрудник', phone: '+998955550002', password: 'twin1234', companyCode: code2,
  });
  check('тёзка в другой компании регистрируется', twin.status === 201, twin.data);
  const twinLogin = await api('POST', '/api/auth/login', { name: 'Сотрудник', password: 'twin1234' });
  check('тёзка входит по своему паролю без кода', twinLogin.status === 200 && twinLogin.data.user.companyCode === code2, twinLogin.data);
  const firstLogin = await api('POST', '/api/auth/login', { name: 'Сотрудник', password: 'emp1234' });
  check('первый тёзка входит в свою компанию', firstLogin.status === 200 && firstLogin.data.user.companyCode === reg.data.user.companyCode, firstLogin.data);

  const same = await api('POST', '/api/auth/register', {
    name: 'Одинаковый', phone: '+998955550003', password: 'same1234', companyCode: code2,
  });
  check('подготовка: тёзка с тем же паролем', same.status === 201, same.data);
  const same2 = await api('POST', '/api/auth/register', {
    name: 'Одинаковый', phone: '+998955550004', password: 'same1234', companyCode: reg.data.user.companyCode,
  });
  check('подготовка: второй такой же в другой компании', same2.status === 201, same2.data);
  const ambiguous = await api('POST', '/api/auth/login', { name: 'Одинаковый', password: 'same1234' });
  check('неразличимые тёзки → 409 + needCompanyCode', ambiguous.status === 409 && ambiguous.data.needCompanyCode === true, ambiguous.data);
  const resolved = await api('POST', '/api/auth/login', { name: 'Одинаковый', password: 'same1234', companyCode: code2 });
  check('с кодом команды вход проходит', resolved.status === 200 && resolved.data.user.companyCode === code2, resolved.data);
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
