-- Схема Lunchistan (PostgreSQL / PGlite). Идемпотентна — можно гонять при каждом старте.

-- ── Компании и пользователи ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
  id         SERIAL PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  size       INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
  comment         TEXT,
  payment_method  TEXT CHECK (payment_method IN ('corporate','card','cash')),
  employee_count  INTEGER NOT NULL DEFAULT 1,
  total_amount    BIGINT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

CREATE INDEX IF NOT EXISTS idx_schedule_user     ON schedule(user_id);
CREATE INDEX IF NOT EXISTS idx_choices_user      ON choices(user_id);
CREATE INDEX IF NOT EXISTS idx_choices_date      ON choices(date);
CREATE INDEX IF NOT EXISTS idx_confirmed_company ON confirmed_days(company_id);
CREATE INDEX IF NOT EXISTS idx_orders_company    ON orders(company_id);
CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
CREATE INDEX IF NOT EXISTS idx_order_lines_order ON order_lines(order_id);
CREATE INDEX IF NOT EXISTS idx_order_lines_date  ON order_lines(date);
