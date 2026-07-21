'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || '/data/timecard.json';

const DEFAULT_STATE = {
  entries: [],
  settings: { weeklyTarget: 8, weekStart: 1 },
  activeShift: null
};

// ---------- Storage ----------
// Plain JSON file on disk (expected to live on a mounted Docker volume so it
// survives container restarts/rebuilds). A simple write queue avoids two
// concurrent requests corrupting the file — fine for a single-user tool.

function ensureDataFile() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_STATE, null, 2));
  }
}

function readState() {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      settings: Object.assign({}, DEFAULT_STATE.settings, parsed.settings || {}),
      activeShift: parsed.activeShift && typeof parsed.activeShift === 'object' ? parsed.activeShift : null
    };
  } catch (e) {
    console.error('Failed to read data file, starting fresh:', e.message);
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

let writeQueue = Promise.resolve();
function writeState(state) {
  writeQueue = writeQueue.then(() =>
    new Promise((resolve, reject) => {
      const tmp = DATA_FILE + '.tmp';
      fs.writeFile(tmp, JSON.stringify(state, null, 2), (err) => {
        if (err) return reject(err);
        fs.rename(tmp, DATA_FILE, (err2) => (err2 ? reject(err2) : resolve()));
      });
    })
  );
  return writeQueue;
}

// ---------- Auth ----------
// Optional HTTP Basic Auth, enabled only when both AUTH_USER and AUTH_PASS
// are set. Credentials come from the environment (docker-compose / .env),
// never baked into the image, so the built image stays shareable — anyone
// running it just supplies their own credentials, or none at all.

const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASS = process.env.AUTH_PASS || '';
const AUTH_ENABLED = Boolean(AUTH_USER && AUTH_PASS);

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still touch timingSafeEqual so short vs. long guesses take the same
    // rough amount of time either way.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAuth(req, res, next) {
  if (!AUTH_ENABLED || req.path === '/healthz') return next();

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sepIdx = decoded.indexOf(':');
    if (sepIdx !== -1) {
      const user = decoded.slice(0, sepIdx);
      const pass = decoded.slice(sepIdx + 1);
      if (timingSafeEqualStr(user, AUTH_USER) && timingSafeEqualStr(pass, AUTH_PASS)) {
        return next();
      }
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="Timecard", charset="UTF-8"');
  res.status(401).send('Authentication required.');
}

// ---------- App ----------

const app = express();
app.use(requireAuth);
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function validEntry(body) {
  if (!body || typeof body.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return null;
  const hours = Number(body.hours);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) return null;
  const note = typeof body.note === 'string' ? body.note.slice(0, 200) : '';
  return { date: body.date, hours: Math.round(hours * 100) / 100, note };
}

app.get('/api/state', (req, res) => {
  res.json(readState());
});

app.post('/api/entries', async (req, res) => {
  const parsed = validEntry(req.body);
  if (!parsed) return res.status(400).json({ error: 'Invalid entry. Expect { date: YYYY-MM-DD, hours: number, note?: string }.' });

  const state = readState();
  state.entries.push({
    id: crypto.randomUUID(),
    date: parsed.date,
    hours: parsed.hours,
    note: parsed.note,
    createdAt: Date.now()
  });
  await writeState(state);
  res.status(201).json(state);
});

app.delete('/api/entries/:id', async (req, res) => {
  const state = readState();
  const before = state.entries.length;
  state.entries = state.entries.filter((e) => e.id !== req.params.id);
  if (state.entries.length === before) return res.status(404).json({ error: 'Entry not found.' });
  await writeState(state);
  res.json(state);
});

// ---------- Live shift stopwatch ----------
// activeShift shape: { startedAt, date, note, runningSince, accumulatedMs }
// - date: local YYYY-MM-DD supplied by the client at start time (the client
//   knows the user's real timezone; the server only deals in ms offsets).
// - runningSince: ms timestamp of the current running segment, or null while paused.
// - accumulatedMs: time already banked from prior running segments.

function shiftElapsedMs(shift) {
  if (!shift) return 0;
  return shift.accumulatedMs + (shift.runningSince ? (Date.now() - shift.runningSince) : 0);
}

app.post('/api/shift/start', async (req, res) => {
  const state = readState();
  if (state.activeShift) return res.status(409).json({ error: 'A shift is already running. End or discard it first.' });

  const date = (typeof req.body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date))
    ? req.body.date
    : new Date().toISOString().slice(0, 10);
  const note = typeof req.body.note === 'string' ? req.body.note.slice(0, 200) : '';

  state.activeShift = { startedAt: Date.now(), date, note, runningSince: Date.now(), accumulatedMs: 0 };
  await writeState(state);
  res.status(201).json(state);
});

app.post('/api/shift/pause', async (req, res) => {
  const state = readState();
  const shift = state.activeShift;
  if (!shift) return res.status(400).json({ error: 'No shift is running.' });
  if (!shift.runningSince) return res.status(400).json({ error: 'Shift is already paused.' });

  shift.accumulatedMs += Date.now() - shift.runningSince;
  shift.runningSince = null;
  await writeState(state);
  res.json(state);
});

app.post('/api/shift/resume', async (req, res) => {
  const state = readState();
  const shift = state.activeShift;
  if (!shift) return res.status(400).json({ error: 'No shift to resume.' });
  if (shift.runningSince) return res.status(400).json({ error: 'Shift is already running.' });

  shift.runningSince = Date.now();
  await writeState(state);
  res.json(state);
});

app.post('/api/shift/end', async (req, res) => {
  const state = readState();
  const shift = state.activeShift;
  if (!shift) return res.status(400).json({ error: 'No shift is running.' });

  const totalMs = shiftElapsedMs(shift);
  const hours = Math.min(24, Math.round((totalMs / 3600000) * 100) / 100);
  state.activeShift = null;

  if (hours > 0) {
    state.entries.push({
      id: crypto.randomUUID(),
      date: shift.date,
      hours,
      note: shift.note || '',
      createdAt: Date.now()
    });
  }
  await writeState(state);
  res.json(state);
});

app.post('/api/shift/cancel', async (req, res) => {
  const state = readState();
  if (!state.activeShift) return res.status(400).json({ error: 'No shift to discard.' });
  state.activeShift = null;
  await writeState(state);
  res.json(state);
});

app.put('/api/settings', async (req, res) => {
  const state = readState();
  const target = Number(req.body && req.body.weeklyTarget);
  const weekStart = Number(req.body && req.body.weekStart);
  if (Number.isFinite(target) && target > 0) state.settings.weeklyTarget = target;
  if (weekStart === 0 || weekStart === 1) state.settings.weekStart = weekStart;
  await writeState(state);
  res.json(state);
});

app.post('/api/import', async (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.entries)) return res.status(400).json({ error: 'Invalid backup file: missing entries array.' });

  const cleanEntries = [];
  for (const e of body.entries) {
    const parsed = validEntry(e);
    if (!parsed) continue;
    cleanEntries.push({
      id: (typeof e.id === 'string' && e.id) ? e.id : crypto.randomUUID(),
      date: parsed.date,
      hours: parsed.hours,
      note: parsed.note,
      createdAt: Number.isFinite(e.createdAt) ? e.createdAt : Date.now()
    });
  }

  const state = readState();
  state.entries = cleanEntries;
  if (body.settings) {
    const target = Number(body.settings.weeklyTarget);
    const weekStart = Number(body.settings.weekStart);
    if (Number.isFinite(target) && target > 0) state.settings.weeklyTarget = target;
    if (weekStart === 0 || weekStart === 1) state.settings.weekStart = weekStart;
  }
  await writeState(state);
  res.json(state);
});

app.post('/api/clear', async (req, res) => {
  const state = readState();
  state.entries = [];
  await writeState(state);
  res.json(state);
});

app.get('/api/export', (req, res) => {
  const state = readState();
  const payload = Object.assign({ exportedAt: new Date().toISOString() }, state);
  res.setHeader('Content-Disposition', `attachment; filename="timecard-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(payload);
});

app.get('/healthz', (req, res) => res.send('ok'));

app.listen(PORT, () => {
  ensureDataFile();
  console.log(`Timecard listening on port ${PORT}, data file: ${DATA_FILE}`);
  console.log(AUTH_ENABLED
    ? `Basic auth enabled (user: ${AUTH_USER})`
    : 'Basic auth disabled — set AUTH_USER and AUTH_PASS to require a login.');
});
