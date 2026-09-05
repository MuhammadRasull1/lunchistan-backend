const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'lunchistan.db');

const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin','employee')),
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS menu_sets (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    price INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schedule (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    PRIMARY KEY (user_id, date)
  );

  CREATE TABLE IF NOT EXISTS choices (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    set_id INTEGER NOT NULL,
    set_name TEXT NOT NULL,
    set_price INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, date)
  );

  CREATE TABLE IF NOT EXISTS confirmed_days (
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    confirmed_by INTEGER NOT NULL REFERENCES users(id),
    confirmed_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (company_id, date)
  );

  CREATE INDEX IF NOT EXISTS idx_schedule_user ON schedule(user_id);
  CREATE INDEX IF NOT EXISTS idx_choices_user ON choices(user_id);
  CREATE INDEX IF NOT EXISTS idx_confirmed_company ON confirmed_days(company_id);
`);

if (fs.existsSync(path.join(__dirname, 'seed_sets.json'))) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM menu_sets').get().c;
  if (count === 0) {
    const sets = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed_sets.json'), 'utf8'));
    const insert = db.prepare('INSERT INTO menu_sets (id, name, category, price) VALUES (?, ?, ?, ?)');
    db.exec('BEGIN');
    try {
      for (const row of sets) insert.run(row.id, row.name, row.category, row.price);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

function getUserByPhone(phone) {
  return db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getCompanyById(id) {
  return db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
}

module.exports = { db, getUserByPhone, getUserById, getCompanyById };