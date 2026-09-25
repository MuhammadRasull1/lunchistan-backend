/**
 * Сквозной UI-тест: клиент заказывает в приложении → владелец видит заказ в Core и подтверждает →
 * клиент видит новый статус. Всё на локальном PGlite, прод не трогается.
 *
 * Нужны соседние репозитории ../lunchistan-frontend и ../lunchistan-core (с node_modules) и Playwright
 * с chromium. Путь к Playwright — переменная PLAYWRIGHT (по умолчанию ~/dowork-hunter/node_modules/playwright).
 * Запуск: node test/e2e-ui.mjs   Скриншоты шагов: test/.e2e-shots/
 */
import { rmSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = new URL('..', import.meta.url).pathname;
const SHOTS = path.join(ROOT, 'test/.e2e-shots');
const PGDIR = path.join(ROOT, '.pglite-e2e');
const PW = process.env.PLAYWRIGHT || path.join(homedir(), 'dowork-hunter/node_modules/playwright/index.mjs');
const API = 'http://127.0.0.1:5611';
const CLIENT = 'http://127.0.0.1:5711';
const CORE = 'http://127.0.0.1:5712';
const OWNER = { phone: '+998900000000', password: 'owner-pass' };

const { chromium } = await import(PW);
rmSync(PGDIR, { recursive: true, force: true });
rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

const procs = [];
function start(cmd, args, cwd, env) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  p.stderr.on('data', (d) => { if (/error/i.test(d) && !/CloudStorage/.test(d)) process.stderr.write(`  [${path.basename(cwd)}!] ${d}`); });
  procs.push(p);
  return p;
}
function stopAll() {
  for (const p of procs) { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* уже завершился */ } }
}
process.on('exit', stopAll);

let passed = 0, failed = 0;
function check(name, ok, extra) {
  if (ok) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.log(`  ❌ ${name}`, extra ?? ''); }
}
async function waitUrl(url) {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) return; } catch { /* ещё не поднялся */ } await sleep(500); }
  throw new Error(`не поднялся ${url}`);
}
const dayKey = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
// ближайшие два будних дня, начиная с завтра — на них клиент и закажет
const weekdays = [];
for (let n = 1; weekdays.length < 2; n++) { const d = new Date(); d.setDate(d.getDate() + n); if (d.getDay() % 6) weekdays.push(n); }

let browser, current; // current — страница, которую снять при сбое
try {
  console.log('── Поднимаю стек ──');
  start(process.execPath, ['server.js'], ROOT, {
    PORT: '5611', PGLITE_DIR: PGDIR, DATABASE_URL: '', TELEGRAM_BOT_TOKEN: '', CHAT_ID: '',
    OWNER_PHONE: OWNER.phone, OWNER_PASSWORD: OWNER.password, AUTH_MAX_ATTEMPTS: '100',
  });
  const vite = (repo, port) => start('npx', ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    path.join(ROOT, '..', repo), { VITE_API_BASE_URL: API });
  vite('lunchistan-frontend', 5711);
  vite('lunchistan-core', 5712);
  await Promise.all([waitUrl(`${API}/api/menu`), waitUrl(CLIENT), waitUrl(CORE)]);

  const login = await (await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(OWNER),
  })).json();
  for (let n = 1; n <= 10; n++) {
    await fetch(`${API}/api/owner/daily-menu/${dayKey(n)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` },
      body: JSON.stringify({ setIds: [1, 2, 3, 4] }),
    });
  }
  check('меню на 10 дней назначено владельцем', !!login.token);

  browser = await chromium.launch({ args: ['--use-angle=swiftshader'] });
  const shot = (p, name) => p.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  const pageErrors = [];

  console.log('\n── Клиент: регистрация и заказ ──');
  const client = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  current = client;
  client.on('pageerror', (e) => pageErrors.push(e.message));
  await client.goto(CLIENT, { waitUntil: 'networkidle' });
  await client.getByRole('button', { name: 'Начать' }).click();
  await client.locator('input').first().fill('Тест Клиент');
  await client.locator('button.ob-next').click();
  await client.locator('input[type=password]').fill('pass1234'); // ≥ 6 символов (MIN_PASSWORD)
  await client.locator('button.ob-next').click();
  await client.locator('.ob-path').nth(1).click();
  const fields = client.locator('form input:not([type=checkbox])');
  await fields.nth(0).fill('E2E Компания');
  await fields.nth(1).fill('10');
  await client.locator('label:has(.ob-consent__input)').click();
  const reg = client.waitForResponse((r) => r.url().endsWith('/api/auth/register'));
  await client.locator('button.ob-next').click();
  check('регистрация компании → 201', (await reg).status() === 201);
  await client.getByRole('button', { name: 'Выбрать дни' }).waitFor();
  await shot(client, '01-catalog');

  await client.getByRole('button', { name: 'Выбрать дни' }).click();
  for (const n of weekdays) {
    const d = new Date(); d.setDate(d.getDate() + n);
    // календарь показывает месяц — если будний день в следующем месяце, листаем
    if (d.getMonth() !== new Date().getMonth()) await client.locator('.modal-overlay button:has(svg)').nth(2).click().catch(() => {});
    await client.locator('button').filter({ hasText: new RegExp(`^${d.getDate()}$`) }).first().click();
  }
  await client.getByRole('button', { name: 'Подтвердить' }).click();
  for (const dish of ['Аджахури', 'Бефстроганов']) {
    await client.getByRole('button', { name: 'Выбрать блюдо' }).first().click();
    await client.locator(`.modal-overlay .set-card:has-text("${dish}")`).first().click();
    await client.getByRole('button', { name: 'Выбрать', exact: true }).last().click();
    await sleep(500);
  }
  check('на оба дня выбраны блюда', (await client.getByRole('button', { name: 'Изменить блюдо' }).count()) === 2);
  await shot(client, '02-days-chosen');

  // В обычном браузере своя кнопка «Оформить» должна быть видна (до 25.09 пряталась в расчёте на Telegram MainButton)
  const orderBtn = client.getByRole('button', { name: 'Оформить предзаказ' });
  check('в браузере видна кнопка «Оформить предзаказ»', await orderBtn.isVisible().catch(() => false));
  await orderBtn.click();
  await client.getByRole('button', { name: /Оплатить/ }).waitFor();
  await client.evaluate(() => window.scrollTo(0, 0)); await sleep(400);
  await shot(client, '03a-cart-top');
  const phoneField = client.locator('input').nth(1);
  check('телефон в корзине не подставлен служебным user_…', !(await phoneField.inputValue()).startsWith('user_'), await phoneField.inputValue());
  check('в корзине склонения: «2 дня · 1 сотрудник · 2 порции»', (await client.getByText('2 дня · 1 сотрудник · 2 порции').count()) > 0);
  await phoneField.fill('+998901234567');
  await client.getByRole('button', { name: 'Наличными курьеру' }).click();
  await shot(client, '03-cart');
  const order = client.waitForResponse((r) => r.url().endsWith('/api/orders') && r.request().method() === 'POST');
  await client.getByRole('button', { name: /Оплатить/ }).click();
  const orderRes = await order;
  const orderData = await orderRes.json();
  check('заказ оформлен → 201 и номер', orderRes.status() === 201 && /^ORD-\d{4}$/.test(orderData.orderNumber || ''), orderData);
  await client.getByText('Заказ оформлен').waitFor();
  await shot(client, '04-success');

  console.log('\n── Владелец в Core ──');
  const core = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  current = core;
  core.on('pageerror', (e) => pageErrors.push(e.message));
  await core.goto(CORE, { waitUntil: 'networkidle' });
  await core.locator('input').nth(0).fill(OWNER.phone);
  await core.locator('input').nth(1).fill(OWNER.password);
  await core.getByRole('button', { name: 'Войти' }).click();
  await core.getByRole('button', { name: 'Все заказы' }).click();
  await core.getByText(orderData.orderNumber).first().click();
  await core.getByText('+998901234567').first().waitFor();
  check('Core видит заказ с телефоном клиента', true);
  await shot(core, '05-core-order');
  const status = core.waitForResponse((r) => r.url().includes('/status'));
  await core.getByRole('button', { name: 'Подтверждён' }).click();
  check('владелец подтвердил заказ → 200', (await status).status() === 200);

  current = client;
  console.log('\n── Клиент видит статус ──');
  await client.getByRole('button', { name: 'Сделать новый заказ' }).click().catch(() => {});
  await client.getByRole('button', { name: 'Кабинет' }).click();
  await client.getByRole('button', { name: 'Обновить' }).click().catch(() => {});
  const row = client.getByRole('button', { name: new RegExp(`${orderData.orderNumber}.*Подтверждён`) });
  await row.waitFor({ timeout: 10000 }).catch(() => {});
  check('клиент видит «Подтверждён» в кабинете', (await row.count()) > 0);
  await shot(client, '06-client-cabinet');

  check('нет JS-ошибок на страницах', pageErrors.length === 0, pageErrors.slice(0, 3));
} catch (err) {
  failed++;
  console.log(`  ❌ сценарий прервался: ${err.message.split('\n')[0]}`);
  const at = err.message.match(/waiting for (.+)/)?.[1];
  if (at) console.log(`     на шаге: ${at}`);
  await current?.screenshot({ path: path.join(SHOTS, '99-failure.png') }).catch(() => {});
} finally {
  await browser?.close();
  stopAll();
  rmSync(PGDIR, { recursive: true, force: true });
}

console.log(`\n${failed ? '💥' : '🎉'} Итог: ${passed} passed, ${failed} failed · скриншоты: ${SHOTS}`);
process.exit(failed ? 1 : 0);
