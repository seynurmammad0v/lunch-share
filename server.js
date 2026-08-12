const express = require('express');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'lunch.db');
const TIMEZONE = process.env.TZ || 'Asia/Baku';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS skips (
    date       TEXT NOT NULL,
    name       TEXT NOT NULL,
    claimed_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (date, name)
  );
  CREATE TABLE IF NOT EXISTS people (
    name      TEXT PRIMARY KEY,
    last_seen TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function todayStr() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 40) return null;
  // только буквы, цифры, пробелы, дефис, апостроф, точка
  if (!/^[\p{L}\p{N} \-'.]+$/u.test(name)) return null;
  return name;
}

function touchPerson(name) {
  db.prepare(`INSERT INTO people (name) VALUES (?) 
              ON CONFLICT(name) DO UPDATE SET last_seen = datetime('now')`)
    .run(name);
}

function getTodayState() {
  const date = todayStr();
  const skips = db.prepare(`SELECT name, claimed_by FROM skips WHERE date = ?`)
    .all(date);
  const people = db.prepare(`SELECT name FROM people ORDER BY name COLLATE NOCASE`).all();
  return {
    date,
    free: skips.filter((s) => !s.claimed_by).map((s) => s.name),
    claimed: skips.filter((s) => s.claimed_by).map((s) => ({ name: s.name, by: s.claimed_by })),
    people: people.map((p) => p.name),
  };
}

// === API ===

// Состояние на сегодня
app.get('/api/today', (req, res) => {
  res.json(getTodayState());
});

// Отметить «не обедаю» (один раз в день на человека)
app.post('/api/skip', (req, res) => {
  const name = sanitizeName(req.body && req.body.name);
  if (!name) return res.status(400).json({ error: 'invalid_name' });
  const date = todayStr();
  touchPerson(name);
  // идемпотентно: повторная отметка НЕ сбрасывает уже совершённый claim
  db.prepare(`INSERT OR IGNORE INTO skips (date, name) VALUES (?, ?)`)
    .run(date, name);
  res.json(getTodayState());
});

// Отменить отметку — только если порцию ещё никто не забрал
app.post('/api/unship', (req, res) => {
  const name = sanitizeName(req.body && req.body.name);
  if (!name) return res.status(400).json({ error: 'invalid_name' });
  const date = todayStr();
  const r = db.prepare(`DELETE FROM skips WHERE date = ? AND name = ? AND claimed_by IS NULL`)
    .run(date, name);
  if (r.changes === 0) {
    // порция уже забрана — отменить отметку нельзя
    const row = db.prepare(`SELECT claimed_by FROM skips WHERE date = ? AND name = ?`).get(date, name);
    if (row && row.claimed_by) {
      return res.status(409).json({ error: 'already_claimed', by: row.claimed_by });
    }
  }
  res.json(getTodayState());
});

// Забрать порцию
app.post('/api/claim', (req, res) => {
  const from = sanitizeName(req.body && req.body.from);
  const by = sanitizeName(req.body && req.body.by);
  if (!from || !by) return res.status(400).json({ error: 'invalid_name' });
  if (from === by) return res.status(400).json({ error: 'self_claim' });
  const date = todayStr();
  touchPerson(by);
  const r = db.prepare(`UPDATE skips SET claimed_by = ? 
                        WHERE date = ? AND name = ? AND claimed_by IS NULL`)
    .run(by, date, from);
  if (r.changes === 0) {
    // порция уже забрана кем-то или не существует
    const exists = db.prepare(`SELECT 1 FROM skips WHERE date = ? AND name = ?`).get(date, from);
    return res.status(409).json({ error: exists ? 'already_claimed' : 'no_skip' });
  }
  res.json(getTodayState());
});

// Освободить порцию (только тот, кто забрал)
app.post('/api/unclaim', (req, res) => {
  const from = sanitizeName(req.body && req.body.from);
  const by = sanitizeName(req.body && req.body.by);
  if (!from || !by) return res.status(400).json({ error: 'invalid_name' });
  const date = todayStr();
  db.prepare(`UPDATE skips SET claimed_by = NULL 
              WHERE date = ? AND name = ? AND claimed_by = ?`)
    .run(date, from, by);
  res.json(getTodayState());
});

app.listen(PORT, () => {
  console.log(`lunch-share listening on :${PORT} (TZ=${TIMEZONE})`);
});
