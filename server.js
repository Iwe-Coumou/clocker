'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || '/data/clocker.json';

// Read once at boot so the footer can show which build is running. Falls back
// to empty rather than crashing if package.json is ever missing or unreadable.
const APP_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '';
  } catch (e) {
    return '';
  }
})();

// The project was called Timecard before it was renamed to Clocker, and the
// data file was named to match. Installs that predate the rename still have
// their hours in timecard.json, so it's read once as a fallback — see
// loadState. The old file is never deleted; it stays as a rollback.
const LEGACY_DATA_FILE = path.join(path.dirname(DATA_FILE), 'timecard.json');

const DEFAULT_STATE = {
  entries: [],
  settings: { weeklyTarget: 8, weekStart: 1 },
  activeShift: null
};

// ---------- Storage ----------
// The JSON file on disk (expected to live on a mounted Docker volume) is the
// durable copy; `state` below is the authoritative one while the process runs.
// Loading once at boot rather than re-reading per request is what makes
// mutations safe: two requests arriving back to back both mutate the same
// object, so neither can read a stale copy and clobber the other's write.

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---------- Duration granularity ----------
// The minute is the unit of this app: it's what the forms accept, what the
// editor shows and what every total is rendered in. Durations are therefore
// snapped to a whole number of minutes before they are stored, so the stored
// value is exactly the one the user sees.
//
// The alternative — storing a finer value and rounding only on display — makes
// totals lie. Hours used to be kept to 2 decimals, a 36 second grid: an entry
// of 4.23h read back as "4h 14m", and saving it one minute longer wrote 4.25h,
// growing it by 1.2 minutes. A week of 7.99h then jumped from "7:59" to "8:01"
// on a one minute edit. Whole minutes in, whole minutes out, no drift.
//
// Note the result is a full precision double (5 minutes is 0.08333…h), not a
// rounded decimal — rounding *that* would put the residue straight back.
function quantizeHours(hours) {
  return Math.round(hours * 60) / 60;
}

function loadState() {
  ensureDataDir();

  // Prefer the current file; fall back to the pre-rename one exactly once.
  // The first write after that lands on DATA_FILE, so the migration completes
  // itself with no manual step and no risk of reading a stale legacy file
  // later on.
  let source = DATA_FILE;
  if (!fs.existsSync(DATA_FILE)) {
    if (!fs.existsSync(LEGACY_DATA_FILE)) return JSON.parse(JSON.stringify(DEFAULT_STATE));
    console.log(`Migrating data from ${LEGACY_DATA_FILE} to ${DATA_FILE} (the old file is left in place).`);
    source = LEGACY_DATA_FILE;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(source, 'utf8'));
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

const state = loadState();

// Writes are still serialized through a queue so a burst of mutations can't
// interleave two fs.writeFile calls onto the same path. Each write snapshots
// the state at queue time, so a later mutation can't corrupt an in-flight one.
let writeQueue = Promise.resolve();
function persist() {
  const snapshot = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.then(() =>
    new Promise((resolve, reject) => {
      const tmp = DATA_FILE + '.tmp';
      fs.writeFile(tmp, snapshot, (err) => {
        if (err) return reject(err);
        fs.rename(tmp, DATA_FILE, (err2) => (err2 ? reject(err2) : resolve()));
      });
    })
  );
  return writeQueue;
}

// Entries written before durations were snapped to whole minutes sit on the
// old 36 second grid, so their totals keep drifting until they're squared up.
// Rounding each to its nearest minute moves any one entry by at most 30
// seconds and leaves the displayed H:MM alone.
function normalizeStoredHours() {
  let changed = 0;
  for (const entry of state.entries) {
    if (!Number.isFinite(entry.hours)) continue;
    const snapped = quantizeHours(entry.hours);
    if (snapped !== entry.hours) {
      entry.hours = snapped;
      changed++;
    }
  }
  return changed;
}

const renormalized = normalizeStoredHours();
if (renormalized > 0) {
  console.log(`Rounded ${renormalized} entr${renormalized === 1 ? 'y' : 'ies'} to whole minutes.`);
}

// Complete a legacy migration eagerly rather than waiting for the user's next
// edit, so the new file exists from the first boot onward.
if (renormalized > 0 || (!fs.existsSync(DATA_FILE) && fs.existsSync(LEGACY_DATA_FILE))) persist();

// ---------- Auth ----------
// Optional HTTP Basic Auth, enabled only when both AUTH_USER and AUTH_PASS
// are set. Credentials come from the environment (docker-compose / .env),
// never baked into the image, so the built image stays shareable — anyone
// running it just supplies their own credentials, or none at all.

const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASS = process.env.AUTH_PASS || '';
const AUTH_ENABLED = Boolean(AUTH_USER && AUTH_PASS);

// Hashing first gives both sides a fixed 32-byte width, so the comparison
// itself is constant time regardless of how long the submitted guess was —
// comparing the raw strings would leak the secret's length via timing.
function timingSafeEqualStr(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
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
      // Both comparisons always run — short-circuiting on the username would
      // reveal whether it was the user or the password that was wrong.
      const userOk = timingSafeEqualStr(user, AUTH_USER);
      const passOk = timingSafeEqualStr(pass, AUTH_PASS);
      if (userOk && passOk) return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="Clocker", charset="UTF-8"');
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
  return { date: body.date, hours: quantizeHours(hours), note };
}

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

// Every response goes through here so the client never has to interpret a
// server timestamp against its own clock. `runningSince` is meaningless on a
// device whose clock is off by minutes; a plain elapsed duration is not.
function publicState() {
  return {
    version: APP_VERSION,
    entries: state.entries,
    settings: state.settings,
    activeShift: state.activeShift
      ? {
          date: state.activeShift.date,
          note: state.activeShift.note,
          running: Boolean(state.activeShift.runningSince),
          elapsedMs: shiftElapsedMs(state.activeShift),
          // Absolute, unlike elapsedMs — it's rendered as a wall-clock time,
          // not used for any duration arithmetic, so clock skew can't
          // accumulate into a wrong stopwatch reading.
          startedAt: state.activeShift.startedAt
        }
      : null
  };
}

app.get('/api/state', (req, res) => {
  res.json(publicState());
});

app.post('/api/entries', async (req, res) => {
  const parsed = validEntry(req.body);
  if (!parsed) return res.status(400).json({ error: 'Invalid entry. Expect { date: YYYY-MM-DD, hours: number, note?: string }.' });

  state.entries.push({
    id: crypto.randomUUID(),
    date: parsed.date,
    hours: parsed.hours,
    note: parsed.note,
    createdAt: Date.now()
  });
  await persist();
  res.status(201).json(publicState());
});

app.patch('/api/entries/:id', async (req, res) => {
  const entry = state.entries.find((e) => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found.' });

  // Merge onto the existing entry first so a partial update (say, note only)
  // is validated against the entry's current date and hours.
  const parsed = validEntry({
    date: req.body && req.body.date !== undefined ? req.body.date : entry.date,
    hours: req.body && req.body.hours !== undefined ? req.body.hours : entry.hours,
    note: req.body && req.body.note !== undefined ? req.body.note : entry.note
  });
  if (!parsed) return res.status(400).json({ error: 'Invalid entry. Expect { date: YYYY-MM-DD, hours: number, note?: string }.' });

  // Moving an entry to another day invalidates its recorded start/end, which
  // are absolute timestamps on the original day — keeping them would show a
  // clock time that contradicts the date next to it. Duration edits are fine:
  // the shift really did run over that span, the user is just billing it
  // differently.
  if (parsed.date !== entry.date) {
    delete entry.startedAt;
    delete entry.endedAt;
    delete entry.pausedMs;
  }

  entry.date = parsed.date;
  entry.hours = parsed.hours;
  entry.note = parsed.note;
  entry.updatedAt = Date.now();
  await persist();
  res.json(publicState());
});

app.delete('/api/entries/:id', async (req, res) => {
  const before = state.entries.length;
  state.entries = state.entries.filter((e) => e.id !== req.params.id);
  if (state.entries.length === before) return res.status(404).json({ error: 'Entry not found.' });
  await persist();
  res.json(publicState());
});

app.post('/api/shift/start', async (req, res) => {
  if (state.activeShift) return res.status(409).json({ error: 'A shift is already running. End or discard it first.' });

  const date = (typeof req.body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date))
    ? req.body.date
    : new Date().toISOString().slice(0, 10);
  const note = typeof req.body.note === 'string' ? req.body.note.slice(0, 200) : '';

  state.activeShift = { startedAt: Date.now(), date, note, runningSince: Date.now(), accumulatedMs: 0 };
  await persist();
  res.status(201).json(publicState());
});

app.post('/api/shift/pause', async (req, res) => {
  const shift = state.activeShift;
  if (!shift) return res.status(400).json({ error: 'No shift is running.' });
  if (!shift.runningSince) return res.status(400).json({ error: 'Shift is already paused.' });

  shift.accumulatedMs += Date.now() - shift.runningSince;
  shift.runningSince = null;
  await persist();
  res.json(publicState());
});

app.post('/api/shift/resume', async (req, res) => {
  const shift = state.activeShift;
  if (!shift) return res.status(400).json({ error: 'No shift to resume.' });
  if (shift.runningSince) return res.status(400).json({ error: 'Shift is already running.' });

  shift.runningSince = Date.now();
  await persist();
  res.json(publicState());
});

app.post('/api/shift/end', async (req, res) => {
  const shift = state.activeShift;
  if (!shift) return res.status(400).json({ error: 'No shift is running.' });

  const endedAt = Date.now();
  const totalMs = shiftElapsedMs(shift);
  // The stopwatch counts seconds, but a logged entry is whole minutes like
  // every other one — a shift is rounded to the nearest minute as it lands.
  const hours = Math.min(24, quantizeHours(totalMs / 3600000));
  // Paused time needs no separate bookkeeping: whatever wall-clock time the
  // shift spanned but didn't bank as worked time is, by definition, paused.
  const pausedMs = Math.max(0, endedAt - shift.startedAt - totalMs);
  state.activeShift = null;

  if (hours > 0) {
    state.entries.push({
      id: crypto.randomUUID(),
      date: shift.date,
      hours,
      note: shift.note || '',
      createdAt: endedAt,
      // Only entries that came from the stopwatch carry these; ones typed into
      // the form have no start or end to report, and the UI omits the line.
      startedAt: shift.startedAt,
      endedAt,
      pausedMs
    });
  }
  await persist();
  res.json(publicState());
});

app.post('/api/shift/cancel', async (req, res) => {
  if (!state.activeShift) return res.status(400).json({ error: 'No shift to discard.' });
  state.activeShift = null;
  await persist();
  res.json(publicState());
});

app.put('/api/settings', async (req, res) => {
  const target = Number(req.body && req.body.weeklyTarget);
  const weekStart = Number(req.body && req.body.weekStart);
  if (Number.isFinite(target) && target > 0) state.settings.weeklyTarget = target;
  if (weekStart === 0 || weekStart === 1) state.settings.weekStart = weekStart;
  await persist();
  res.json(publicState());
});

// Two ways to bring a backup in:
//  - replace (default): the file becomes the whole ledger, as it always has.
//  - merge: the file's entries are added to what's already here. This is how a
//    second machine's hours come home — run the app on a laptop for a while,
//    export, then merge that export into the main install.
//
// Merge dedupes on the entry id, which is a UUID minted once when the entry is
// created and preserved through every export/import. So an entry the target
// already holds is skipped rather than doubled, which makes a merge safe to
// repeat and safe to run with overlapping backups. Content is deliberately not
// used to match: two sessions with the same date, hours and note are a real
// pattern (the app sums same-day sessions), not a duplicate.
app.post('/api/import', async (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.entries)) return res.status(400).json({ error: 'Invalid backup file: missing entries array.' });
  const merge = body.mode === 'merge';

  // In merge mode the current entries stay and their ids are already taken;
  // in replace mode we start from empty.
  const cleanEntries = merge ? state.entries.slice() : [];
  const seenIds = new Set(cleanEntries.map((e) => e.id));
  let added = 0;
  let skipped = 0;

  for (const e of body.entries) {
    const parsed = validEntry(e);
    if (!parsed) continue;

    // A merge skips any entry we already hold by id — that's the dedupe. In
    // replace mode the set only guards against a single file listing one id
    // twice, which would otherwise create two entries sharing an id.
    if (typeof e.id === 'string' && e.id && seenIds.has(e.id)) {
      skipped++;
      continue;
    }

    const id = (typeof e.id === 'string' && e.id && !seenIds.has(e.id)) ? e.id : crypto.randomUUID();
    seenIds.add(id);
    const entry = {
      id,
      date: parsed.date,
      hours: parsed.hours,
      note: parsed.note,
      createdAt: Number.isFinite(e.createdAt) ? e.createdAt : Date.now()
    };
    // Carried through so a backup round-trip doesn't quietly strip the
    // start/end times off stopwatch entries. Absent on hand-typed ones.
    if (Number.isFinite(e.startedAt)) entry.startedAt = e.startedAt;
    if (Number.isFinite(e.endedAt)) entry.endedAt = e.endedAt;
    if (Number.isFinite(e.pausedMs)) entry.pausedMs = e.pausedMs;
    cleanEntries.push(entry);
    added++;
  }

  state.entries = cleanEntries;
  // A merge is additive by nature: it shouldn't quietly reset the target or
  // week-start on the machine it's merged into. Only a replace adopts the
  // backup's settings.
  if (!merge && body.settings) {
    const target = Number(body.settings.weeklyTarget);
    const weekStart = Number(body.settings.weekStart);
    if (Number.isFinite(target) && target > 0) state.settings.weeklyTarget = target;
    if (weekStart === 0 || weekStart === 1) state.settings.weekStart = weekStart;
  }
  await persist();
  // The extra `imported` field lets the client report what a merge did; the
  // client's applyState ignores it, so replace callers are unaffected.
  res.json(Object.assign({ imported: { added, skipped, mode: merge ? 'merge' : 'replace' } }, publicState()));
});

app.post('/api/clear', async (req, res) => {
  state.entries = [];
  await persist();
  res.json(publicState());
});

// JSON export is the restore path — it round-trips through /api/import.
app.get('/api/export', (req, res) => {
  const payload = Object.assign({ exportedAt: new Date().toISOString() }, publicState());
  res.setHeader('Content-Disposition', `attachment; filename="clocker-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(payload);
});

// CSV export is the hand-off path — for a spreadsheet or an invoice, not for
// restoring back into the app.
function csvCell(value) {
  const str = String(value == null ? '' : value);
  // A leading =, +, - or @ makes a spreadsheet treat the cell as a formula;
  // prefixing an apostrophe keeps notes as literal text.
  const safe = /^[=+\-@]/.test(str) ? "'" + str : str;
  return '"' + safe.replace(/"/g, '""') + '"';
}

app.get('/api/export.csv', (req, res) => {
  // Whole minutes are what's actually stored; the decimal hours beside them are
  // a convenience for invoicing and are rounded to 2 places, so a column of
  // them can be a hair off the column of minutes. Sum the minutes to be exact.
  const rows = [['date', 'hours', 'minutes', 'note', 'started_at', 'ended_at', 'paused_minutes', 'logged_at']];
  const sorted = state.entries.slice().sort((a, b) => (a.date === b.date
    ? (a.createdAt || 0) - (b.createdAt || 0)
    : a.date.localeCompare(b.date)));

  for (const e of sorted) {
    rows.push([
      e.date,
      Number(e.hours.toFixed(2)),
      Math.round(e.hours * 60),
      e.note || '',
      // Blank on hand-typed entries rather than faked — an empty cell reads
      // correctly in a spreadsheet as "not measured".
      e.startedAt ? new Date(e.startedAt).toISOString() : '',
      e.endedAt ? new Date(e.endedAt).toISOString() : '',
      Number.isFinite(e.pausedMs) ? Math.round(e.pausedMs / 60000) : '',
      e.createdAt ? new Date(e.createdAt).toISOString() : ''
    ]);
  }

  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="clocker-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

app.get('/healthz', (req, res) => res.send('ok'));

app.listen(PORT, () => {
  console.log(`Clocker listening on port ${PORT}, data file: ${DATA_FILE}`);
  console.log(AUTH_ENABLED
    ? `Basic auth enabled (user: ${AUTH_USER})`
    : 'Basic auth disabled — set AUTH_USER and AUTH_PASS to require a login.');
});
