-- Схема Lunchistan (PostgreSQL / PGlite). Идемпотентна — можно гонять при каждом старте.

-- ── Компании и пользователи ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
  id         SERIAL PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  size       INTEGER,
  -- Координаты и адрес компании (доставка B2B — на завод/офис)
  lat        DOUBLE PRECISION,
  lon        DOUBLE PRECISION,
  address    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Миграция для существующих БД: поля доставки в companies.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS lon DOUBLE PRECISION;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS address TEXT;

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  company_id    INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('owner','admin','employee')),
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Меню ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS menu_sets (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  category TEXT NOT NULL,
  price    INTEGER NOT NULL
);

-- ── Контур «Команды»: расписание сотрудников и их выбор ─────────────
CREATE TABLE IF NOT EXISTS schedule (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date    DATE NOT NULL,
  PRIMARY KEY (user_id, date)
);

CREATE TABLE IF NOT EXISTS choices (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       DATE NOT NULL,
  set_id     INTEGER NOT NULL,
  set_name   TEXT NOT NULL,
  set_price  INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, date)
);

CREATE TABLE IF NOT EXISTS confirmed_days (
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  date         DATE NOT NULL,
  confirmed_by INTEGER NOT NULL REFERENCES users(id),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, date)
);

-- ── Оптовые заказы (основной клиентский поток) и заявки-лиды ────────
CREATE TABLE IF NOT EXISTS orders (
  id              SERIAL PRIMARY KEY,
  company_id      INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  source          TEXT NOT NULL DEFAULT 'bulk' CHECK (source IN ('bulk','lead','teams')),
  is_lead         BOOLEAN NOT NULL DEFAULT false,
  status          TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','confirmed','in_progress','delivered','paid','cancelled')),
  contact_name    TEXT,
  contact_phone   TEXT,
  company_name    TEXT,
  address         TEXT,
  -- Доставка «до двери»: координаты и детали ориентира
  dest_lat        DOUBLE PRECISION,
  dest_lon        DOUBLE PRECISION,
  dest_detail     TEXT,             -- подъезд/этаж/домофон/ориентир одной строкой
  delivery_fee    BIGINT NOT NULL DEFAULT 0,
  comment         TEXT,
  tg_user_id      BIGINT,           -- реальный Telegram ID клиента из TMA
  tg_username     TEXT,             -- реальный @username клиента из TMA
  payment_method  TEXT CHECK (payment_method IN ('corporate','card','cash')),
  employee_count  INTEGER NOT NULL DEFAULT 1,
  total_amount    BIGINT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Миграция для уже существующих БД: новые колонки TG-контакта и доставки в orders.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tg_user_id BIGINT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tg_username TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dest_lat DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dest_lon DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dest_detail TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee BIGINT NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
-- Защита от задвоения заказа при двойном клике/ретрае сети: один и тот же
-- ключ с фронтенда не создаст второй заказ (см. routes_orders.js).
CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key_uidx
  ON orders (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Зоны доставки (круги от кухни). Чистая математика — без внешних API карт.
CREATE TABLE IF NOT EXISTS delivery_zones (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  center_lat  DOUBLE PRECISION NOT NULL,
  center_lon  DOUBLE PRECISION NOT NULL,
  radius_m    INTEGER NOT NULL,     -- радиус в метрах
  price       BIGINT NOT NULL DEFAULT 0,
  min_order   BIGINT NOT NULL DEFAULT 0,  -- бесплатно при заказе ≥ min_order
  priority    INTEGER NOT NULL DEFAULT 100, -- меньше = главнее
  active      BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_delivery_zones_active ON delivery_zones(active);

CREATE TABLE IF NOT EXISTS order_lines (
  id          SERIAL PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  set_id      INTEGER,
  set_name    TEXT NOT NULL,
  main_dish   TEXT,
  salad       TEXT,
  beverage    TEXT,
  excluded    TEXT,            -- JSON-массив исключённых ингредиентов
  portions    INTEGER NOT NULL DEFAULT 1,   -- на одного сотрудника
  unit_price  BIGINT NOT NULL DEFAULT 0,
  line_total  BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS order_status_log (
  id         SERIAL PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status     TEXT NOT NULL,
  note       TEXT,
  changed_by INTEGER REFERENCES users(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Напоминания о доставке клиенту в Telegram (за день, по одной на дату заказа).
CREATE TABLE IF NOT EXISTS delivery_reminders (
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  date     DATE NOT NULL,
  sent_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, date)
);

CREATE INDEX IF NOT EXISTS idx_schedule_user     ON schedule(user_id);
CREATE INDEX IF NOT EXISTS idx_choices_user      ON choices(user_id);
CREATE INDEX IF NOT EXISTS idx_choices_date      ON choices(date);
CREATE INDEX IF NOT EXISTS idx_confirmed_company ON confirmed_days(company_id);
CREATE INDEX IF NOT EXISTS idx_orders_company    ON orders(company_id);
CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
CREATE INDEX IF NOT EXISTS idx_order_lines_order ON order_lines(order_id);
CREATE INDEX IF NOT EXISTS idx_order_lines_date  ON order_lines(date);
