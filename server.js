const express = require('express');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const webpush = require('web-push');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'lunch.db');
const TIMEZONE = process.env.TZ || 'Asia/Baku';
const MAX_CLAIMS_PER_DAY = 2; // лимит: сколько порций можно забрать в день
// Ежедневное напоминание: 12:00 по TZ, только пн–пт (переопределяется для тестов)
const REMINDER_HOUR = parseInt(process.env.REMINDER_HOUR || '12', 10);
const REMINDER_MINUTE = parseInt(process.env.REMINDER_MINUTE || '0', 10);
// Версия приложения: меняется при каждом деплое → клиент сам обновляется (PWA на главном экране)
const APP_VERSION = process.env.APP_VERSION || String(Date.now().toString(36));

// Штат компании — для автокомплита имени (только имя + фамилия)
// Два «Farid Mammadov» различаются по роли
const ROSTER = [
  'Fuad Karimov','Gulnar Masumova','Aytaj Abdullayeva','Nikita Yudin','Nigar Humbatova',
  'Gunel Talibova','Gunay Eminova','Farid Mammadov (BA)','Orkhan Taghizade','Seynur Mammadov',
  'Ali Guliyev','Vusala Alakbarova','Samir Gakhramanov','Mirzakhan Aliyev','Rustam Ahmadov',
  'Afgan Mustafayev','Orkhan Huseynli','Shamil Omarov','Agil Atakishiyev','Maksim Vasilyev',
  'Rauf Aliyev','Vusal Shahbazov','Eljan Mahmudov','Orkhan Mamedov','Mehdi Asadli',
  'Khanim Pashayeva','Nazrin Khalilova','Alekper Aliev','Ruslan Aliiev','Jeyhun Jeyhunzade',
  'Elnur Khalilov','Habil Abiyev','Pervin Pashazade','Mansur Mustafayev','Ibrahim Ismayilov',
  'Martin Li','Arif Ahmadli','Sanam Ganbarova','Oruj Ahmadov','Ruslan Bayramov',
  'Fakhri Jafarov','Emil Gambarli','Eldaniz Abdullayev','Rufat Guliyev','Murad Ganiyev',
  'Fatima Hasanova','Enver Isayev','Sayyid Talishinskiy','Rasif Hatamkhanov',
  'Farid Mammadov (Backend)',
];

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// VAPID-ключи для Web Push — генерируются один раз и хранятся рядом с БД (переживают рестарты)
const VAPID_PATH = path.join(path.dirname(DB_PATH), 'vapid.json');
let vapidKeys;
try {
  vapidKeys = JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8'));
} catch {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_PATH, JSON.stringify(vapidKeys, null, 2));
}
webpush.setVapidDetails('mailto:lunch-share@example.com', vapidKeys.publicKey, vapidKeys.privateKey);
const PUSH_ENABLED = process.env.PUSH_ENABLED !== '0';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Миграция схемы: идентификация по device_id (телефону), имя — только отображаемое.
// Если таблица ещё старой схемы (по имени) — пересоздаём один раз; иначе сохраняем данные.
const skipCols = db.prepare(`PRAGMA table_info(skips)`).all();
const hasDeviceCol = skipCols.some((c) => c.name === 'device_id');
if (skipCols.length > 0 && !hasDeviceCol) {
  db.exec(`DROP TABLE IF EXISTS skips; DROP TABLE IF EXISTS people;`);
}
db.exec(`
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
  CREATE TABLE IF NOT EXISTS subs (
    device_id  TEXT PRIMARY KEY,
    sub        TEXT NOT NULL,
    lang       TEXT NOT NULL DEFAULT 'en',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS reminders (
    date     TEXT PRIMARY KEY,
    sent_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Очистка: удаляем мусорные имена из people (созданные GET-проверками и т.п.) —
// оставляем только тех, кто реально есть в штате (roster).
// Мусор = имена не из roster. Свои (не из штата) люди добавятся заново при первом действии.
db.prepare(`DELETE FROM people WHERE name NOT IN (${ROSTER.map(() => '?').join(',')})`)
  .run(...ROSTER);

// Разовый сброс: RESET_DB=1 очищает все имена и отметки, чтобы все выбрали заново.
// Сбрасывается только один раз (защита от повторного сброса при рестартах).
const RESET_FLAG = path.join(path.dirname(DB_PATH), '.reset_done');
if (process.env.RESET_DB === '1' && !fs.existsSync(RESET_FLAG)) {
  db.exec(`DELETE FROM people; DELETE FROM skips;`);
  fs.writeFileSync(RESET_FLAG, new Date().toISOString());
  console.log('[reset] DB cleared — everyone picks a name again');
}

const app = express();
app.use(express.json());
// Статика: HTML/sw/manifest НЕ кэшировать (иначе PWA на главном экране не увидит обновления),
// остальные ассеты (icon и т.п.) — с кэшем.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (/\.(html|js|json)$/.test(filePath) && !/\.(png|svg|ico)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  },
}));

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

// Закрепить имя за телефоном. Имя уникально: если его уже выбрал другой телефон — отказ.
// Возвращает { name } или { taken: true }
function lockNameFor(device, name) {
  const existing = db.prepare(`SELECT name FROM people WHERE device_id = ?`).get(device);
  if (existing) {
    db.prepare(`UPDATE people SET last_seen = datetime('now') WHERE device_id = ?`).run(device);
    return { name: existing.name }; // имя уже закреплено за этим телефоном
  }
  const taken = db.prepare(`SELECT 1 FROM people WHERE name = ? COLLATE NOCASE`).get(name);
  if (taken) return { taken: true }; // имя уже выбрал другой телефон
  db.prepare(`INSERT INTO people (device_id, name) VALUES (?, ?)`).run(device, name);
  return { name };
}

function getTodayState(device) {
  const date = todayStr();
  const skips = db.prepare(`SELECT name, claimed_by_name FROM skips WHERE date = ?`).all(date);
  const people = db.prepare(`SELECT DISTINCT name FROM people ORDER BY name COLLATE NOCASE`).all();
  let me = null;
  if (device) {
    const myName = db.prepare(`SELECT name FROM people WHERE device_id = ?`).get(device);
    const mySkip = db.prepare(`SELECT name, claimed_by_name FROM skips WHERE date = ? AND device_id = ?`)
      .get(date, device);
    const myClaims = db.prepare(`SELECT name FROM skips WHERE date = ? AND claimed_by_device = ?`)
      .all(date, device);
    me = {
      name: myName ? myName.name : null, // закреплённое имя телефона (первый выбор, навсегда)
      skip: mySkip ? { name: mySkip.name, claimed_by: mySkip.claimed_by_name || null } : null,
      claims: myClaims.map((c) => c.name),
    };
  }
  return {
    date,
    free: skips.filter((s) => !s.claimed_by_name).map((s) => s.name),
    claimed: skips.filter((s) => s.claimed_by_name).map((s) => ({ name: s.name, by: s.claimed_by_name })),
    people: people.map((p) => p.name),
    roster: ROSTER,
    claimLimit: MAX_CLAIMS_PER_DAY,
    me,
  };
}

// === Web Push ===

// Публичный VAPID-ключ — клиент подписывается на пуши
app.get('/api/vapid-public', (req, res) => {
  res.json({ key: vapidKeys.publicKey });
});

// Сохранить подписку устройства
app.post('/api/subscribe', (req, res) => {
  const device = sanitizeDevice(req.body && req.body.device);
  const sub = req.body && req.body.subscription;
  const lang = (req.body && req.body.lang === 'ru') ? 'ru' : 'en';
  if (!device || !sub || !sub.endpoint) return res.status(400).json({ error: 'invalid_params' });
  db.prepare(`INSERT INTO subs (device_id, sub, lang) VALUES (?, ?, ?)
              ON CONFLICT(device_id) DO UPDATE SET sub = excluded.sub, lang = excluded.lang, updated_at = datetime('now')`)
    .run(device, JSON.stringify(sub), lang);
  res.json({ ok: true });
});

// Удалить подписку устройства
app.post('/api/unsubscribe', (req, res) => {
  const device = sanitizeDevice(req.body && req.body.device);
  if (!device) return res.status(400).json({ error: 'invalid_params' });
  db.prepare(`DELETE FROM subs WHERE device_id = ?`).run(device);
  res.json({ ok: true });
});

// Отправить пуш устройству; невалидные подписки удаляются.
// Возвращает Promise с результатом: { ok } или { failed: statusCode }
function notifyDevice(deviceId, title, body, url) {
  if (!PUSH_ENABLED || !deviceId) return Promise.resolve({ ok: false, skipped: true });
  const row = db.prepare(`SELECT sub FROM subs WHERE device_id = ?`).get(deviceId);
  if (!row) return Promise.resolve({ ok: false, skipped: true });
  let sub;
  try { sub = JSON.parse(row.sub); } catch { return Promise.resolve({ ok: false, skipped: true }); }
  return webpush.sendNotification(sub, JSON.stringify({ title, body, url: url || '/' }))
    .then(() => ({ ok: true }))
    .catch((err) => {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) {
        db.prepare(`DELETE FROM subs WHERE device_id = ?`).run(deviceId); // подписка устарела
        console.log(`[push] sub ${deviceId.slice(0, 8)}… dead (${code}), removed`);
      } else if (code === 403) {
        console.log(`[push] sub ${deviceId.slice(0, 8)}… rejected (403)`);
      } else if (code) {
        console.log(`[push] sub ${deviceId.slice(0, 8)}… error ${code}`);
      } else {
        console.log(`[push] sub ${deviceId.slice(0, 8)}… error: ${err && err.message}`);
      }
      return { ok: false, failed: code || 'unknown' };
    });
}

// === API ===

// Админ-эндпоинты (бэкап/дамп/освобождение имени) — только с секретом
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
function adminAuth(req) {
  const t = req.get('x-admin-token');
  return ADMIN_TOKEN && t === ADMIN_TOKEN;
}

// Бэкап: скачать копию базы целиком
app.get('/api/admin/backup', (req, res) => {
  if (!adminAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  db.pragma('wal_checkpoint(TRUNCATE)');
  res.download(DB_PATH, `lunch-backup-${todayStr()}.db`);
});

// Дамп: кто занял какое имя, отметки сегодня, подписки (без деталей)
app.get('/api/admin/dump', (req, res) => {
  if (!adminAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  const people = db.prepare(`SELECT device_id, name, last_seen FROM people ORDER BY name`).all();
  const skipsToday = db.prepare(`SELECT date, device_id, name, claimed_by_name FROM skips WHERE date = ? ORDER BY name`).all(todayStr());
  const subs = db.prepare(`SELECT device_id, lang, updated_at FROM subs`).all();
  res.json({ date: todayStr(), people, skipsToday, subs });
});

// Освободить имя: удалить только записи people с этим именем (skips/subscriptions не трогаем)
app.post('/api/admin/free-name', (req, res) => {
  if (!adminAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  const name = sanitizeName(req.body && req.body.name);
  if (!name) return res.status(400).json({ error: 'invalid_params' });
  const r = db.prepare(`DELETE FROM people WHERE name = ? COLLATE NOCASE`).run(name);
  res.json({ ok: true, removed: r.changes, name });
});

// Закрепить имя за телефоном (первый выбор — навсегда; имя уникально для всех)
app.post('/api/name', (req, res) => {
  const device = sanitizeDevice(req.body && req.body.device);
  const name = sanitizeName(req.body && req.body.name);
  if (!device || !name) return res.status(400).json({ error: 'invalid_params' });
  const r = lockNameFor(device, name);
  if (r.taken) return res.status(409).json({ error: 'name_taken' });
  res.json({ name: r.name, locked: true });
});

// Версия приложения — клиент сравнивает и сам перезагружается при обновлении
app.get('/api/version', (req, res) => {
  res.json({ version: APP_VERSION });
});

// Состояние на сегодня (+ me по device).
// ВАЖНО: GET не создаёт записи в people — иначе мусорные имена (проверки, боты) попадают в базу.
app.get('/api/today', (req, res) => {
  const device = sanitizeDevice(req.query.device);
  res.json(getTodayState(device));
});

// Отметить «не обедаю» (один раз в день на телефон)
app.post('/api/skip', (req, res) => {
  const device = sanitizeDevice(req.body && req.body.device);
  const name = sanitizeName(req.body && req.body.name);
  if (!device || !name) return res.status(400).json({ error: 'invalid_params' });
  const date = todayStr();
  const locked = lockNameFor(device, name);
  if (locked.taken) return res.status(409).json({ error: 'name_taken' });
  db.prepare(`INSERT OR IGNORE INTO skips (date, device_id, name) VALUES (?, ?, ?)`)
    .run(date, device, locked.name);
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

  // лимит: не больше MAX_CLAIMS_PER_DAY порций в день на человека
  const cnt = db.prepare(`SELECT COUNT(*) AS c FROM skips WHERE date = ? AND claimed_by_device = ?`).get(date, device).c;
  if (cnt >= MAX_CLAIMS_PER_DAY) return res.status(409).json({ error: 'limit_reached' });

  const locked = lockNameFor(device, name);
  if (locked.taken) return res.status(409).json({ error: 'name_taken' });
  const r = db.prepare(`UPDATE skips SET claimed_by_device = ?, claimed_by_name = ?
                        WHERE date = ? AND name = ? AND claimed_by_device IS NULL`)
    .run(device, locked.name, date, from);
  if (r.changes === 0) return res.status(409).json({ error: 'already_claimed' });

  // пуш владельцу порции: её забрали
  notifyDevice(owner.device_id, '🍱 Lunch share', `${name} took your meal — it won't go to waste!`);
  res.json(getTodayState(device));
});

// Вернуть порцию — только тот телефон, который забрал
app.post('/api/unclaim', (req, res) => {
  const device = sanitizeDevice(req.body && req.body.device);
  const from = sanitizeName(req.body && req.body.from);
  if (!device || !from) return res.status(400).json({ error: 'invalid_params' });
  const date = todayStr();
  const r = db.prepare(`UPDATE skips SET claimed_by_device = NULL, claimed_by_name = NULL
              WHERE date = ? AND name = ? AND claimed_by_device = ?`)
    .run(date, from, device);
  if (r.changes > 0) {
    // пуш владельцу порции: она снова свободна
    const owner = db.prepare(`SELECT device_id FROM skips WHERE date = ? AND name = ?`).get(date, from);
    if (owner) notifyDevice(owner.device_id, '🍱 Lunch share', `Your meal is available again — anyone can take it.`);
  }
  res.json(getTodayState(device));
});

// === Ежедневное напоминание: пн–пт в 12:00 (TZ) ===

function tzParts(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE, weekday: 'short', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { weekday: get('weekday'), hour: parseInt(get('hour'), 10), minute: parseInt(get('minute'), 10) };
}

async function sendDailyReminder() {
  const now = new Date();
  const { weekday, hour, minute } = tzParts(now);
  const isWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday);
  const isTime = hour === REMINDER_HOUR && minute === REMINDER_MINUTE;
  if (!isWeekday || !isTime) return;

  const date = todayStr();
  const ins = db.prepare(`INSERT OR IGNORE INTO reminders (date) VALUES (?)`).run(date);
  if (ins.changes === 0) return; // уже отправлено сегодня

  const subs = db.prepare(`SELECT device_id, lang, updated_at FROM subs`).all();
  let sent = 0, failed = 0;
  for (const s of subs) {
    const title = s.lang === 'ru' ? 'Обед' : 'Lunch';
    const body = s.lang === 'ru'
      ? `Не забудь отдать свою порцию — если не обедаешь сегодня, отметься!`
      : `Don't forget to give your meal away — if you're not eating today, mark it!`;
    const r = await notifyDevice(s.device_id, title, body);
    if (r.ok) sent++; else failed++;
    console.log(`[reminder] sub ${s.device_id.slice(0, 8)}… ${r.ok ? 'OK' : 'FAIL ' + (r.failed || r.skipped)} (subscribed ${s.updated_at})`);
  }
  console.log(`[reminder] ${date} ${hour}:${minute} → delivered ${sent}, failed ${failed} of ${subs.length}`);
}

// проверяем каждые 30 секунд
setInterval(sendDailyReminder, 30 * 1000);
sendDailyReminder(); // при старте (на случай, если подняли ровно в 12:00)

app.listen(PORT, () => {
  console.log(`lunch-share listening on :${PORT} (TZ=${TIMEZONE}, reminder ${REMINDER_HOUR}:${String(REMINDER_MINUTE).padStart(2, '0')} Mon-Fri)`);
});
