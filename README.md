# lunchistan-backend

API для Lunchistan: меню, **оптовые заказы**, контур **«Команды»** (аккаунты компаний, выбор блюд сотрудниками), **сводка владельца**.

- Node.js (CommonJS) + Express 5
- БД: **PostgreSQL** (Neon) через `pg`; если `DATABASE_URL` не задан — локальный встроенный **PGlite** (`./.pglite`), удобно для разработки
- Схема — `schema.sql` (идемпотентная, применяется при каждом старте)

## Запуск локально

```bash
npm install
npm start          # без DATABASE_URL → PGlite, файл ./.pglite
npm test           # смоук-тест всех эндпойнтов на временной БД
```

`.env` (см. `.env.example`):

| Переменная | Назначение |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (Neon). Пусто → PGlite локально |
| `OWNER_PHONE`, `OWNER_PASSWORD` | Аккаунт владельца (дядя). Создаётся при первом старте, если заданы оба |
| `OWNER_NAME` | Имя владельца (по умолчанию «Владелец») |
| `TELEGRAM_BOT_TOKEN`, `CHAT_ID` | Уведомления о заказах/заявках в Telegram |

## Деплой на Render (сервис `lunchistan-backend`)

Автодеплой из GitHub уже настроен — пуш в `main` запускает сборку.

**Перед первым деплоем этой версии — задать в Render → Environment:**

1. `DATABASE_URL` — из панели Neon: **Project → Connection string → Pooled connection** (`postgresql://…-pooler.…neon.tech/…?sslmode=require`)
2. `OWNER_PHONE` — телефон дяди (в формате `+998…`)
3. `OWNER_PASSWORD` — временный пароль (дядя сменит после первого входа: `POST /api/auth/password`)
4. `TELEGRAM_BOT_TOKEN`, `CHAT_ID` — уже заданы, оставить

Первый старт сам создаст таблицы, загрузит 56 сетов меню и аккаунт владельца.

> Здоровье сервиса: `GET /health` → `{ ok: true }` (для аптайм-мониторинга).

## Эндпойнты

### Меню
- `GET /api/menu` — 56 сетов

### Авторизация
- `POST /api/auth/register` — `{name, phone, password, companyName, companySize?}` → компания + admin; либо `{name, phone, password, companyCode}` → сотрудник
- `POST /api/auth/login` — `{phone, password}`
- `POST /api/auth/password` — `{oldPassword, newPassword}` (нужен токен)
- `GET /api/me`

### Оптовые заказы
- `POST /api/orders` — с токеном → заказ компании; без токена → **заявка-лид** (нужны `contactName`, `contactPhone`).
  Тело: `{ employeeCount, paymentMethod, address?, comment?, companyName?, totalMonthlyPrice, lines:[{date,setId,setName,mainDish,salad,beverage,portions,unitPrice,lineTotal}] }`
- `GET /api/my/orders`, `GET /api/my/orders/:id` — заказы моей компании

### Команды
- `GET/PUT /api/my/days`, `PUT /api/my/days/:date/choice`
- `GET /api/manager/dates`, `GET /api/manager/report?date=`, `POST /api/manager/report/:date/confirm`

### Владелец (`role = owner`)
- `GET /api/owner/summary?from&to` — заказы по статусам, деньги (заказано/оплачено/долг), лист по датам, «Команды», новые заявки
- `GET /api/owner/kitchen?date=` — что и сколько готовить на дату
- `GET /api/owner/orders?status&leads`, `GET /api/owner/orders/:id`
- `POST /api/owner/orders/:id/status` — `{status, note}` (`new|confirmed|in_progress|delivered|paid|cancelled`)
