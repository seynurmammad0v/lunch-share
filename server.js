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
// Идентификация по device_id (телефону), имя — только отображаемое.
// Старые тестовые таблицы (идентификация по имени) сбрасываются.
db.exec(`
  DROP TABLE IF EXISTS skips;
  DROP TABLE IF EXISTS people;
  CREATE TABLE IF NOT EXISTS people (
    device_id TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    last_seen TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS skips (
    date               TEXT NOT NULL,
    device_id          TEXT NOT NULL,
    name               TEXT NOT NULL,
    claimed_by_device  TEXT,
    claimed_by_name    TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (date, device_id)
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
  if (!/^[\p{L}\p{N} \-'.]+$/u.test(name)) return null;
  return name;
}

function sanitizeDevice(raw) {
  if (typeof raw !== 'string') return null;
  const d = raw.trim();
  if (!d || d.length > 64) return null;
  if (!/^[0-9a-zA-Z\-]+$/.test(d)) return null;
  return d;
}

// Обновить отображаемое имя device (и во всех его записях за сегодня)
function syncName(device, name, date) {
  db.prepare(`INSERT INTO people (device_id, name) VALUES (?, ?)
              ON CONFLICT(device_id) DO UPDATE SET
                name = excluded.name,
                last_seen = datetime('now')`)
    .run(device, name);
  db.prepare(`UPDATE skips SET name = ? WHERE device_id = ? AND date = ?`)
    .run(name, device, date);
}

function getTodayState(device) {
  const date = todayStr();
  const skips = db.prepare(`SELECT name, claimed_by_name FROM skips WHERE date = ?`).all(date);
  const people = db.prepare(`SELECT DISTINCT name FROM people ORDER BY name COLLATE NOCASE`).all();
  let me = null;
  if (device) {
    const mySkip = db.prepare(`SELECT name, claimed_by_name FROM skips WHERE date = ? AND device_id = ?`)
      .get(date, device);
    const myClaims = db.prepare(`SELECT name FROM skips WHERE date = ? AND claimed_by_device = ?`)
      .all(date, device);
    me = {
      skip: mySkip ? { name: mySkip.name, claimed_by: mySkip.claimed_by_name || null } : null,
      claims: myClaims.map((c) => c.name),
    };
  }
  return {
    date,
    free: skips.filter((s) => !s.claimed_by_name).map((s) => s.name),
    claimed: skips.filter((s) => s.claimed_by_name).map((s) => ({ name: s.name, by: s.claimed_by_name })),
    people: people.map((p) => p.name),
    me,
  };
}

// === API ===

// Состояние на сегодня (+ me по device)
app.get('/api/today', (req, res) => {
  const device = sanitizeDevice(req.query.device);
  const name = sanitizeName(req.query.name);
  const date = todayStr();
  if (device && name) syncName(device, name, date); // смена имени с этого телефона
  res.json(getTodayState(device));
});

// Отметить «не обедаю» (один раз в день на телефон)
app.post('/api/skip', (req, res) => {
  const device = sanitizeDevice(req.body && req.body.device);
  const name = sanitizeName(req.body && req.body.name);
  if (!device || !name) return res.status(400).json({ error: 'invalid_params' });
  const date = todayStr();
  syncName(device, name, date);
  db.prepare(`INSERT OR IGNORE INTO skips (date, device_id, name) VALUES (?, ?, ?)`)
    .run(date, device, name);
  res.json(getTodayState(device));
});

// Отменить отметку — только с того же телефона и только если порцию не забрали
app.post('/api/unship', (req, res) => {
  const device = sanitizeDevice(req.body && req.body.device);
  if (!device) return res.status(400).json({ error: 'invalid_params' });
  const date = todayStr();
  const r = db.prepare(`DELETE FROM skips WHERE date = ? AND device_id = ? AND claimed_by_device IS NULL`)
    .run(date, device);
  if (r.changes === 0) {
    const row = db.prepare(`SELECT claimed_by_name FROM skips WHERE date = ? AND device_id = ?`).get(date, device);
    if (row && row.claimed_by_name) {
      return res.status(409).json({ error: 'already_claimed', by: row.claimed_by_name });
    }
  }
  res.json(getTodayState(device));
});

// Забрать порцию — нельзя забрать у самого себя (по телефону)
app.post('/api/claim', (req, res) => {
  const device = sanitizeDevice(req.body && req.body.device);
  const name = sanitizeName(req.body && req.body.name);
  const from = sanitizeName(req.body && req.body.from);
  if (!device || !name || !from) return res.status(400).json({ error: 'invalid_params' });
  const date = todayStr();

  const owner = db.prepare(`SELECT device_id, claimed_by_name FROM skips WHERE date = ? AND name = ?`).get(date, from);
  if (!owner) {
    // записи с таким именем нет — может, это собственная порция под старым именем?
    const mine = db.prepare(`SELECT 1 FROM skips WHERE date = ? AND device_id = ?`).get(date, device);
    if (mine) return res.status(400).json({ error: 'self_claim' });
    return res.status(404).json({ error: 'no_skip' });
  }
  if (owner.device_id === device) return res.status(400).json({ error: 'self_claim' });
  if (owner.claimed_by_name) return res.status(409).json({ error: 'already_claimed' });

  syncName(device, name, date);
  const r = db.prepare(`UPDATE skips SET claimed_by_device = ?, claimed_by_name = ?
                        WHERE date = ? AND name = ? AND claimed_by_device IS NULL`)
    .run(device, name, date, from);
  if (r.changes === 0) return res.status(409).json({ error: 'already_claimed' });
  res.json(getTodayState(device));
});

// Вернуть порцию — только тот телефон, который забрал
app.post('/api/unclaim', (req, res) => {
  const device = sanitizeDevice(req.body && req.body.device);
  const from = sanitizeName(req.body && req.body.from);
  if (!device || !from) return res.status(400).json({ error: 'invalid_params' });
  const date = todayStr();
  db.prepare(`UPDATE skips SET claimed_by_device = NULL, claimed_by_name = NULL
              WHERE date = ? AND name = ? AND claimed_by_device = ?`)
    .run(date, from, device);
  res.json(getTodayState(device));
});

app.listen(PORT, () => {
  console.log(`lunch-share listening on :${PORT} (TZ=${TIMEZONE})`);
});
