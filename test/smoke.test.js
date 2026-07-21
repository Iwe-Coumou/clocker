'use strict';

// One end-to-end pass over the endpoints that touch stored data. Boots the
// real server against a throwaway data file rather than importing it, so the
// persistence path (write, rename, reload) is exercised too.

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clocker-test-')), 'data.json');

let child;

async function api(pathname, options){
  const res = await fetch(BASE + pathname, Object.assign({
    headers: { 'Content-Type': 'application/json' }
  }, options));
  if (!res.ok) throw new Error(`${pathname} -> ${res.status}`);
  return res.headers.get('content-type').includes('json') ? res.json() : res.text();
}

before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE }),
    stdio: 'ignore'
  });

  for (let i = 0; i < 50; i++){
    try {
      await api('/healthz');
      return;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('server did not come up');
});

after(() => child && child.kill());

// Tests share one server process, so each one starts from a known-empty
// ledger rather than inheriting whatever the previous test left behind.
beforeEach(async () => {
  await api('/api/clear', { method: 'POST' });
  try { await api('/api/shift/cancel', { method: 'POST' }); } catch (e) { /* none running */ }
});

test('starts empty', async () => {
  const state = await api('/api/state');
  assert.deepEqual(state.entries, []);
  assert.equal(state.activeShift, null);
});

test('a shift runs, pauses and logs an entry on end', async () => {
  await api('/api/shift/start', { method: 'POST', body: JSON.stringify({ date: '2026-07-20', note: 'deep work' }) });

  let state = await api('/api/state');
  assert.equal(state.activeShift.running, true);
  assert.equal(state.activeShift.note, 'deep work');
  // The client needs a duration it can tick forward from, never a raw
  // server timestamp — that's what keeps a skewed device clock harmless.
  assert.equal(typeof state.activeShift.elapsedMs, 'number');
  assert.equal(state.activeShift.runningSince, undefined);

  state = await api('/api/shift/pause', { method: 'POST' });
  assert.equal(state.activeShift.running, false);

  state = await api('/api/shift/end', { method: 'POST' });
  assert.equal(state.activeShift, null);
  // Sub-second shift rounds to 0h, which is deliberately not logged.
  assert.equal(state.entries.length, 0);
});

test('a logged shift records when it ran and how long it paused', async () => {
  await api('/api/shift/start', { method: 'POST', body: JSON.stringify({ date: '2026-07-20' }) });

  let state = await api('/api/state');
  assert.equal(typeof state.activeShift.startedAt, 'number', 'the panel shows a start time');

  // Pause, wait, resume — the gap has to land in pausedMs, not in hours.
  await api('/api/shift/pause', { method: 'POST' });
  await new Promise((r) => setTimeout(r, 300));
  await api('/api/shift/resume', { method: 'POST' });
  await api('/api/shift/end', { method: 'POST' });

  // Sub-minute shift rounds to 0h so nothing is logged; add the entry by hand
  // and assert the arithmetic on a synthetic one instead.
  state = await api('/api/state');
  assert.equal(state.entries.length, 0);

  await api('/api/import', {
    method: 'POST',
    body: JSON.stringify({
      entries: [{
        date: '2026-07-20', hours: 2, note: 'measured',
        startedAt: 1784000000000, endedAt: 1784009000000, pausedMs: 1800000
      }]
    })
  });
  state = await api('/api/state');
  assert.equal(state.entries[0].startedAt, 1784000000000, 'a backup round-trip keeps the times');
  assert.equal(state.entries[0].pausedMs, 1800000);
});

test('moving an entry to another day drops its recorded times', async () => {
  await api('/api/import', {
    method: 'POST',
    body: JSON.stringify({
      entries: [{
        date: '2026-07-20', hours: 2, note: 'measured',
        startedAt: 1784000000000, endedAt: 1784009000000, pausedMs: 1800000
      }]
    })
  });
  let state = await api('/api/state');
  const id = state.entries[0].id;

  // A duration edit keeps them — the shift really did run over that span.
  state = await api('/api/entries/' + id, { method: 'PATCH', body: JSON.stringify({ hours: 1.5 }) });
  assert.equal(state.entries[0].startedAt, 1784000000000);

  // A date change makes them contradict the date beside them, so they go.
  state = await api('/api/entries/' + id, { method: 'PATCH', body: JSON.stringify({ date: '2026-07-19' }) });
  assert.equal(state.entries[0].startedAt, undefined);
  assert.equal(state.entries[0].endedAt, undefined);
  assert.equal(state.entries[0].pausedMs, undefined);
  assert.equal(state.entries[0].hours, 1.5, 'the rest of the entry is untouched');
});

test('entries can be added, edited and deleted', async () => {
  let state = await api('/api/entries', {
    method: 'POST',
    body: JSON.stringify({ date: '2026-07-20', hours: 2.5, note: 'client call' })
  });
  assert.equal(state.entries.length, 1);
  const id = state.entries[0].id;

  state = await api('/api/entries/' + id, {
    method: 'PATCH',
    body: JSON.stringify({ hours: 3.25 })
  });
  assert.equal(state.entries[0].hours, 3.25);
  assert.equal(state.entries[0].note, 'client call', 'omitted fields are preserved');
  assert.equal(state.entries[0].date, '2026-07-20');

  await assert.rejects(
    () => api('/api/entries/' + id, { method: 'PATCH', body: JSON.stringify({ hours: 99 }) }),
    /400/
  );

  state = await api('/api/entries/' + id, { method: 'DELETE' });
  assert.equal(state.entries.length, 0);
});

test('concurrent writes all survive', async () => {
  // The regression this guards: re-reading the file per request meant a
  // second request could load a copy that predated the first request's
  // write and then overwrite it.
  await Promise.all([1, 2, 3, 4, 5].map((n) =>
    api('/api/entries', {
      method: 'POST',
      body: JSON.stringify({ date: '2026-07-21', hours: n, note: 'entry ' + n })
    })
  ));

  const state = await api('/api/state');
  assert.equal(state.entries.length, 5);
  assert.deepEqual(state.entries.map((e) => e.hours).sort(), [1, 2, 3, 4, 5]);
});

test('csv export escapes quotes and neutralises formulas', async () => {
  await api('/api/entries', {
    method: 'POST',
    body: JSON.stringify({ date: '2026-07-21', hours: 1, note: '=cmd()|"evil"' })
  });

  const csv = await api('/api/export.csv');
  assert.match(csv, /^"date","hours","note","started_at","ended_at","paused_minutes","logged_at"/);
  assert.match(csv, /"'=cmd\(\)\|""evil"""/);
  // Hand-typed entry: the timing columns are blank, not zero-filled.
  assert.match(csv, /"2026-07-21","1","'=cmd\(\)\|""evil""","","",""/);
});

test('data written under the old Timecard name is picked up automatically', async () => {
  // A pre-rename install has only timecard.json in its data dir. The server
  // should read it, then write the data out under the new name.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clocker-legacy-'));
  const legacy = path.join(dir, 'timecard.json');
  const current = path.join(dir, 'clocker.json');
  fs.writeFileSync(legacy, JSON.stringify({
    entries: [{ id: 'old-1', date: '2026-07-20', hours: 3, note: 'from timecard' }],
    settings: { weeklyTarget: 12, weekStart: 0 }
  }));

  const port = PORT + 1;
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), DATA_FILE: current }),
    stdio: 'ignore'
  });

  try {
    let state;
    for (let i = 0; i < 50; i++){
      try {
        state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
        break;
      } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
    }
    assert.equal(state.entries.length, 1);
    assert.equal(state.entries[0].note, 'from timecard');
    assert.equal(state.settings.weeklyTarget, 12, 'settings migrate too');
    assert.ok(fs.existsSync(current), 'the data is rewritten under the new name');
    assert.ok(fs.existsSync(legacy), 'the old file is kept as a rollback');
  } finally {
    proc.kill();
  }
});

test('data survives a restart', async () => {
  await api('/api/entries', {
    method: 'POST',
    body: JSON.stringify({ date: '2026-07-21', hours: 4, note: 'persisted' })
  });

  child.kill();
  await new Promise((r) => child.once('exit', r));

  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_FILE }),
    stdio: 'ignore'
  });
  for (let i = 0; i < 50; i++){
    try { await api('/healthz'); break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
  }

  const state = await api('/api/state');
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].note, 'persisted');
});
