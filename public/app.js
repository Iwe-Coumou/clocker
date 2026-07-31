(() => {
  'use strict';

  const DOW_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // ---------- State ----------
  // Source of truth lives server-side (a JSON file on the Docker volume).
  // The client keeps a local copy for rendering and refreshes it from
  // whatever the API returns after every mutation.

  let entries = [];
  let settings = { weeklyTarget: 8, weekStart: 1 };
  // { date, note, running, elapsedMs, receivedAt } | null — see applyState.
  let activeShift = null;
  let ledgerRange = 'week'; // 'week' | 'all'
  let openDays = new Set();
  let editingId = null; // entry id currently open for inline editing

  const connBanner = document.getElementById('connBanner');
  let reconnectTimer = null;

  function setConnected(ok){
    connBanner.hidden = ok;
    if (!ok){
      scheduleReconnectCheck();
    } else if (reconnectTimer){
      clearInterval(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnectCheck(){
    if (reconnectTimer) return; // already polling
    reconnectTimer = setInterval(async () => {
      try{
        const state = await apiCall('/api/state');
        applyState(state); // sets connected true, which clears this interval
        renderAll();
      }catch(e){
        // still down — keep polling silently, no need to spam the user
      }
    }, 3000);
  }

  function applyState(state){
    entries = Array.isArray(state.entries) ? state.entries : [];
    settings = Object.assign(settings, state.settings || {});
    // The server sends elapsed duration rather than a start timestamp, and we
    // stamp arrival with our own clock. Every subsequent tick is then a delta
    // between two readings of the *same* clock, so a device whose time is off
    // from the host's still shows the correct elapsed time.
    activeShift = state.activeShift
      ? Object.assign({}, state.activeShift, { receivedAt: Date.now() })
      : null;
    setConnected(true);
    if (state.version){
      document.getElementById('appVersion').textContent = 'Clocker v' + state.version;
    }
    renderShift();
  }

  async function apiCall(path, options){
    const res = await fetch(path, Object.assign({
      headers: { 'Content-Type': 'application/json' }
    }, options));
    if (!res.ok){
      let msg = `Request failed (${res.status})`;
      try{ const body = await res.json(); if (body && body.error) msg = body.error; }catch(e){}
      throw new Error(msg);
    }
    return res.json();
  }

  function delay(ms){
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Retries a few times before giving up — smooths over the container still
  // finishing startup when the page loads for the very first time.
  async function loadState(retries = 5, gapMs = 700){
    for (let attempt = 0; attempt < retries; attempt++){
      try{
        const state = await apiCall('/api/state');
        applyState(state);
        return;
      }catch(e){
        if (attempt === retries - 1){
          setConnected(false);
          throw e;
        }
        await delay(gapMs);
      }
    }
  }

  // ---------- Date helpers (local, no timezone drift) ----------

  function todayStr(){
    const d = new Date();
    return toDateStr(d);
  }
  function toDateStr(d){
    const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  }
  function parseDateStr(s){
    const [y,m,d] = s.split('-').map(Number);
    return new Date(y, m-1, d);
  }
  function addDays(d, n){
    const nd = new Date(d);
    nd.setDate(nd.getDate()+n);
    return nd;
  }
  function startOfWeek(dateStr){
    const d = parseDateStr(dateStr);
    const dow = d.getDay(); // 0=Sun..6=Sat
    const ws = settings.weekStart; // 0 or 1
    const diff = (dow - ws + 7) % 7;
    return addDays(d, -diff);
  }
  function fmtDayLabel(dateStr){
    const d = parseDateStr(dateStr);
    return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`;
  }
  function fmtDow(dateStr){
    return DOW_SHORT[parseDateStr(dateStr).getDay()];
  }
  // Durations are stored as decimal hours but always shown as H:MM. Decimal
  // hours are unreadable at a glance (0.42h) and rounding them to something
  // readable loses real minutes — a 25 minute session is not half an hour.
  //
  // Every stored duration is a whole number of minutes (the server snaps them),
  // so this rounding only mops up float noise: no total can display a minute
  // that isn't in the data, and no edit can shift a total by more than it added.
  function fmtHM(h){
    const totalMin = Math.round(h * 60);
    const hh = Math.floor(totalMin / 60);
    const mm = totalMin % 60;
    return `${hh}:${String(mm).padStart(2, '0')}`;
  }
  // Wall-clock time of an absolute timestamp, in the viewer's locale — so a
  // 24h locale gets 14:05 and a 12h one gets 2:05 PM.
  function fmtTimeOfDay(ms){
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function fmtHMSigned(h){
    const sign = h > 0 ? '+' : (h < 0 ? '\u2212' : '');
    return sign + fmtHM(Math.abs(h));
  }

  // ---------- Aggregation ----------

  function entriesByDay(){
    const map = new Map();
    for (const e of entries){
      if (!map.has(e.date)) map.set(e.date, []);
      map.get(e.date).push(e);
    }
    return map;
  }

  function dayTotal(dateStr, byDay){
    const list = byDay.get(dateStr);
    if (!list) return 0;
    return list.reduce((s,e) => s + e.hours, 0);
  }

  function weekKeyOf(dateStr){
    return toDateStr(startOfWeek(dateStr));
  }

  function weekTotal(weekStartStr, byDay){
    const start = parseDateStr(weekStartStr);
    let total = 0, daysLogged = 0;
    for (let i=0;i<7;i++){
      const ds = toDateStr(addDays(start,i));
      const t = dayTotal(ds, byDay);
      if (t > 0) daysLogged++;
      total += t;
    }
    return { total, daysLogged };
  }

  // ---------- CRUD ----------

  async function addEntry(dateStr, hours, note){
    try{
      const state = await apiCall('/api/entries', {
        method: 'POST',
        body: JSON.stringify({ date: dateStr, hours, note: note || '' })
      });
      applyState(state);
      renderAll();
    }catch(e){
      setConnected(false);
      window.alert('Could not save that entry: ' + e.message);
    }
  }

  async function updateEntry(id, fields){
    try{
      const state = await apiCall('/api/entries/' + encodeURIComponent(id), {
        method: 'PATCH',
        body: JSON.stringify(fields)
      });
      editingId = null;
      // A changed date moves the entry to a different day — make sure that
      // day is expanded so the edit doesn't look like it vanished.
      openDays.add(fields.date);
      applyState(state);
      renderAll();
    }catch(e){
      setConnected(false);
      window.alert('Could not save that change: ' + e.message);
    }
  }

  async function deleteEntry(id){
    try{
      const state = await apiCall('/api/entries/' + encodeURIComponent(id), { method: 'DELETE' });
      applyState(state);
      renderAll();
    }catch(e){
      setConnected(false);
      window.alert('Could not delete that entry: ' + e.message);
    }
  }

  // ---------- Rendering ----------

  function renderAll(){
    const byDay = entriesByDay();
    renderHero(byDay);
    renderShift();
    renderLedger(byDay);
    renderHistory(byDay);
  }

  // ---------- Live shift ----------

  function shiftElapsedMs(shift){
    if (!shift) return 0;
    return shift.elapsedMs + (shift.running ? (Date.now() - shift.receivedAt) : 0);
  }

  function fmtClock(ms){
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  function renderShift(){
    const clockEl = document.getElementById('shiftClock');
    const statusEl = document.getElementById('shiftStatus');
    const startBtn = document.getElementById('shiftStartBtn');
    const pauseBtn = document.getElementById('shiftPauseBtn');
    const resumeBtn = document.getElementById('shiftResumeBtn');
    const endBtn = document.getElementById('shiftEndBtn');
    const cancelBtn = document.getElementById('shiftCancelBtn');
    const noteInput = document.getElementById('shiftNoteInput');
    const dateBadge = document.getElementById('shiftDateBadge');

    clockEl.textContent = fmtClock(shiftElapsedMs(activeShift));

    if (!activeShift){
      statusEl.textContent = 'Not running';
      clockEl.classList.remove('is-running', 'is-paused');
      startBtn.hidden = false;
      pauseBtn.hidden = true;
      resumeBtn.hidden = true;
      endBtn.hidden = true;
      cancelBtn.hidden = true;
      noteInput.disabled = false;
      dateBadge.hidden = true;
      return;
    }

    dateBadge.hidden = false;
    dateBadge.textContent = activeShift.startedAt
      ? `started ${fmtDayLabel(activeShift.date)}, ${fmtTimeOfDay(activeShift.startedAt)}`
      : 'started ' + fmtDayLabel(activeShift.date);
    noteInput.disabled = true;
    if (!noteInput.value) noteInput.value = activeShift.note || '';
    startBtn.hidden = true;
    cancelBtn.hidden = false;

    if (activeShift.running){
      statusEl.textContent = 'Running';
      clockEl.classList.add('is-running');
      clockEl.classList.remove('is-paused');
      pauseBtn.hidden = false;
      resumeBtn.hidden = true;
      endBtn.hidden = false;
    } else {
      statusEl.textContent = 'Paused';
      clockEl.classList.add('is-paused');
      clockEl.classList.remove('is-running');
      pauseBtn.hidden = true;
      resumeBtn.hidden = false;
      endBtn.hidden = false;
    }
  }

  // Ticks the visible clock every second between server round-trips; harmless
  // no-op while no shift is running.
  setInterval(() => {
    if (activeShift && activeShift.running){
      document.getElementById('shiftClock').textContent = fmtClock(shiftElapsedMs(activeShift));
    }
  }, 1000);

  function renderHero(byDay){
    const today = todayStr();
    const wkStart = startOfWeek(today);
    const wkStartStr = toDateStr(wkStart);
    const { total, daysLogged } = weekTotal(wkStartStr, byDay);
    const target = settings.weeklyTarget;

    document.getElementById('weekTotal').textContent = fmtHM(total);
    const remaining = target - total;
    const sub = document.getElementById('weekSub');
    if (remaining > 0){
      sub.textContent = `of ${fmtHM(target)} this week \u00b7 ${fmtHM(remaining)} left`;
    } else if (remaining === 0){
      sub.textContent = `of ${fmtHM(target)} this week \u00b7 quota met exactly`;
    } else {
      sub.textContent = `of ${fmtHM(target)} this week \u00b7 ${fmtHMSigned(remaining)} over`;
    }

    const wkEnd = addDays(wkStart, 6);
    document.getElementById('weekRangeLabel').textContent =
      `${fmtDayLabel(toDateStr(wkStart))} \u2013 ${fmtDayLabel(toDateStr(wkEnd))}`;
    document.getElementById('daysLoggedLabel').textContent = `${daysLogged} / 7`;

    const statusEl = document.getElementById('statusLabel');
    if (total >= target && target > 0){
      statusEl.textContent = 'Quota met';
      statusEl.style.color = 'var(--teal)';
    } else if (total > 0){
      statusEl.textContent = 'In progress';
      statusEl.style.color = 'var(--brass-bright)';
    } else {
      statusEl.textContent = 'Not started';
      statusEl.style.color = 'var(--paper-dim)';
    }

    drawPunchStrip(total, target);
  }

  function drawPunchStrip(total, target){
    const svg = document.getElementById('punchStrip');
    const segCount = Math.max(1, Math.round(target) || 1);
    const segHours = target / segCount;
    const vbW = 640, vbH = 100;
    const gap = 8;
    const segW = (vbW - gap*(segCount-1)) / segCount;
    const segH = 56;
    const y = (vbH - segH) / 2;

    let svgParts = [];
    for (let i=0;i<segCount;i++){
      const x = i * (segW + gap);
      const segStart = i * segHours;
      const fillFrac = Math.max(0, Math.min(1, (total - segStart) / segHours));

      svgParts.push(`<rect x="${x}" y="${y}" width="${segW}" height="${segH}" rx="6" fill="none" stroke="rgba(236,231,219,0.22)" stroke-width="1.5"/>`);
      if (fillFrac > 0){
        const fillColor = total > target ? '#c0524a' : '#c8993f';
        svgParts.push(`<rect x="${x}" y="${y}" width="${segW*fillFrac}" height="${segH}" rx="6" fill="${fillColor}"/>`);
      }
    }
    svg.innerHTML = svgParts.join('');
  }

  function renderLedger(byDay){
    const container = document.getElementById('ledgerList');
    const emptyEl = document.getElementById('ledgerEmpty');
    container.innerHTML = '';

    let dates = Array.from(byDay.keys()).sort().reverse();

    if (ledgerRange === 'week'){
      const wkStartStr = toDateStr(startOfWeek(todayStr()));
      const wkStart = parseDateStr(wkStartStr);
      const validSet = new Set();
      for (let i=0;i<7;i++) validSet.add(toDateStr(addDays(wkStart,i)));
      dates = dates.filter(d => validSet.has(d));
    }

    emptyEl.hidden = dates.length > 0;
    if (dates.length === 0) return;

    for (const dateStr of dates){
      const sessions = byDay.get(dateStr).slice().sort((a,b) => (a.createdAt||0) - (b.createdAt||0));
      const total = sessions.reduce((s,e) => s+e.hours, 0);

      const row = document.createElement('div');
      row.className = 'day-row' + (openDays.has(dateStr) ? ' is-open' : '');

      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'day-row-head';
      head.innerHTML = `
        <span class="day-left">
          <span class="day-date">${fmtDayLabel(dateStr)}${dateStr === todayStr() ? ' \u00b7 today' : ''}</span>
          <span class="day-dow">${fmtDow(dateStr)}</span>
        </span>
        <span class="day-right">
          <span class="day-total">${fmtHM(total)}</span>
          <span class="day-caret">\u25b8</span>
        </span>`;
      head.addEventListener('click', () => {
        if (openDays.has(dateStr)) openDays.delete(dateStr); else openDays.add(dateStr);
        row.classList.toggle('is-open');
      });

      const sessionsWrap = document.createElement('div');
      sessionsWrap.className = 'day-sessions';
      for (const s of sessions){
        sessionsWrap.appendChild(s.id === editingId ? buildSessionEditor(s) : buildSessionRow(s));
      }

      row.appendChild(head);
      row.appendChild(sessionsWrap);
      container.appendChild(row);
    }
  }

  // ---------- Session rows (display + inline edit) ----------

  function splitHours(hours){
    let h = Math.floor(hours);
    let m = Math.round((hours - h) * 60);
    if (m === 60){ h += 1; m = 0; } // float noise can push 2h to 1h 60m
    return { h, m };
  }

  // The inverse of splitHours: the h/m a form collected, as the decimal hours
  // the API speaks. Deliberately not rounded to a couple of decimals — that
  // would drop part of a minute, and the editor round-trips through here on
  // every save, so the loss would compound each time an entry was touched.
  function hoursFromHM(h, m){
    return (h * 60 + m) / 60;
  }

  // Only stopwatch entries carry start/end times; ones typed into the form
  // have nothing to report, so the line is omitted entirely rather than
  // padded with placeholders.
  function sessionTimesHtml(s){
    if (!s.startedAt || !s.endedAt) return '';
    const span = `${fmtTimeOfDay(s.startedAt)} – ${fmtTimeOfDay(s.endedAt)}`;
    // Sub-minute pauses round to "0m", which is noise — treat them as none.
    const paused = (s.pausedMs && s.pausedMs >= 60000)
      ? ` · paused ${fmtHM(s.pausedMs / 3600000)}`
      : '';
    return `<span class="session-times">${span}${paused}</span>`;
  }

  function buildSessionRow(s){
    const item = document.createElement('div');
    item.className = 'session-item';
    item.innerHTML = `
      <span class="session-info">
        <span class="session-line">
          <span class="session-dur">${fmtHM(s.hours)}</span>
          <span class="session-note">${escapeHtml(s.note || '')}</span>
        </span>
        ${sessionTimesHtml(s)}
      </span>
      <span class="session-actions">
        <button class="session-btn session-edit" type="button" aria-label="Edit session">✎</button>
        <button class="session-btn session-del" type="button" aria-label="Delete session">✕</button>
      </span>`;

    item.querySelector('.session-edit').addEventListener('click', (ev) => {
      ev.stopPropagation();
      editingId = s.id;
      openDays.add(s.date); // keep the day expanded around the open editor
      renderLedger(entriesByDay());
    });
    item.querySelector('.session-del').addEventListener('click', (ev) => {
      ev.stopPropagation();
      deleteEntry(s.id);
    });
    return item;
  }

  function buildSessionEditor(s){
    const { h, m } = splitHours(s.hours);
    const form = document.createElement('form');
    form.className = 'session-item session-editor';
    form.innerHTML = `
      <div class="editor-grid">
        <input type="date" class="edit-date" value="${s.date}" required aria-label="Date">
        <span class="editor-duration">
          <input type="number" class="edit-hours" min="0" max="24" step="1" value="${h}" inputmode="numeric" aria-label="Hours">
          <span class="duration-unit">h</span>
          <input type="number" class="edit-mins" min="0" max="59" step="1" value="${m}" inputmode="numeric" aria-label="Minutes">
          <span class="duration-unit">m</span>
        </span>
      </div>
      <input type="text" class="edit-note" value="${escapeHtml(s.note || '')}" placeholder="Note (optional)" maxlength="120" aria-label="Note">
      <div class="editor-actions">
        <button type="submit" class="editor-save">Save</button>
        <button type="button" class="editor-cancel">Cancel</button>
      </div>`;

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const hours = hoursFromHM(
        parseInt(form.querySelector('.edit-hours').value, 10) || 0,
        parseInt(form.querySelector('.edit-mins').value, 10) || 0
      );
      if (hours <= 0){
        form.querySelector('.edit-hours').focus();
        return;
      }
      updateEntry(s.id, {
        date: form.querySelector('.edit-date').value || s.date,
        hours,
        note: form.querySelector('.edit-note').value.trim()
      });
    });

    form.querySelector('.editor-cancel').addEventListener('click', () => {
      editingId = null;
      renderLedger(entriesByDay());
    });

    return form;
  }

  function renderHistory(byDay){
    const target = settings.weeklyTarget;
    const today = todayStr();
    const currentWkKey = toDateStr(startOfWeek(today));

    const weekKeys = new Set();
    for (const dateStr of byDay.keys()) weekKeys.add(weekKeyOf(dateStr));
    weekKeys.add(currentWkKey);

    let weeks = Array.from(weekKeys).sort().reverse().slice(0, 8);
    const weekData = weeks.map(wk => {
      const { total, daysLogged } = weekTotal(wk, byDay);
      return { wk, total, daysLogged };
    });

    const chart = document.getElementById('historyChart');
    const table = document.getElementById('historyTable');
    chart.innerHTML = '';
    table.innerHTML = '';

    const maxVal = Math.max(target, ...weekData.map(w => w.total), 1);
    const chartOrder = weekData.slice().reverse(); // oldest -> newest, left to right

    for (const w of chartOrder){
      const pct = Math.max(2, (w.total / maxVal) * 100);
      const isCurrent = w.wk === currentWkKey;
      const isOver = w.total > target;
      const col = document.createElement('div');
      col.className = 'hbar-col';
      const start = parseDateStr(w.wk);
      col.innerHTML = `
        <div class="hbar-track"><div class="hbar ${isOver ? 'is-over' : (isCurrent ? 'is-current' : '')}" style="height:${pct}%"></div></div>
        <div class="hbar-label">${MONTH_SHORT[start.getMonth()]} ${start.getDate()}</div>`;
      chart.appendChild(col);
    }

    for (const w of weekData){
      const start = parseDateStr(w.wk);
      const end = addDays(start, 6);
      const diff = w.total - target;
      const row = document.createElement('div');
      row.className = 'hist-row';
      const totalClass = diff > 0 ? 'is-over' : (diff === 0 ? 'is-met' : '');
      row.innerHTML = `
        <span class="hist-range">${fmtDayLabel(toDateStr(start))} \u2013 ${fmtDayLabel(toDateStr(end))}${w.wk === currentWkKey ? ' (current)' : ''}</span>
        <span class="hist-total ${totalClass}">${fmtHM(w.total)}${diff !== 0 ? ` <span style="opacity:.7;font-weight:400">(${fmtHMSigned(diff)})</span>` : ''}</span>`;
      table.appendChild(row);
    }
  }

  function escapeHtml(str){
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------- Form wiring ----------

  const dateInput = document.getElementById('dateInput');
  const hoursInput = document.getElementById('hoursInput');
  const minutesInput = document.getElementById('minutesInput');
  const noteInput = document.getElementById('noteInput');
  const entryForm = document.getElementById('entryForm');

  dateInput.value = todayStr();
  dateInput.max = todayStr();

  entryForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const dateStr = dateInput.value || todayStr();
    const h = parseInt(hoursInput.value, 10) || 0;
    const m = parseInt(minutesInput.value, 10) || 0;
    const totalHours = hoursFromHM(h, m);
    if (totalHours <= 0){
      hoursInput.focus();
      return;
    }
    addEntry(dateStr, totalHours, noteInput.value.trim());
    hoursInput.value = '0';
    minutesInput.value = '0';
    noteInput.value = '';
    hoursInput.focus();
  });

  document.getElementById('quickChips').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.chip');
    if (!btn) return;
    const mins = parseInt(btn.dataset.mins, 10);
    addEntry(todayStr(), hoursFromHM(0, mins), '');
  });

  // ---------- Live shift buttons ----------

  const shiftNoteInput = document.getElementById('shiftNoteInput');

  document.getElementById('shiftStartBtn').addEventListener('click', async () => {
    const note = shiftNoteInput.value.trim();
    try{
      const state = await apiCall('/api/shift/start', {
        method: 'POST',
        body: JSON.stringify({ date: todayStr(), note })
      });
      applyState(state);
    }catch(e){
      window.alert('Could not start the shift: ' + e.message);
    }
  });

  document.getElementById('shiftPauseBtn').addEventListener('click', async () => {
    try{
      const state = await apiCall('/api/shift/pause', { method: 'POST' });
      applyState(state);
    }catch(e){
      window.alert('Could not pause: ' + e.message);
    }
  });

  document.getElementById('shiftResumeBtn').addEventListener('click', async () => {
    try{
      const state = await apiCall('/api/shift/resume', { method: 'POST' });
      applyState(state);
    }catch(e){
      window.alert('Could not resume: ' + e.message);
    }
  });

  document.getElementById('shiftEndBtn').addEventListener('click', async () => {
    try{
      const state = await apiCall('/api/shift/end', { method: 'POST' });
      applyState(state);
      shiftNoteInput.value = '';
      renderAll(); // new entry needs to show up in the ledger/history/week total
    }catch(e){
      window.alert('Could not end the shift: ' + e.message);
    }
  });

  document.getElementById('shiftCancelBtn').addEventListener('click', async () => {
    const proceed = window.confirm('Discard this shift without logging any time?');
    if (!proceed) return;
    try{
      const state = await apiCall('/api/shift/cancel', { method: 'POST' });
      applyState(state);
      shiftNoteInput.value = '';
    }catch(e){
      window.alert('Could not discard the shift: ' + e.message);
    }
  });

  document.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      ledgerRange = btn.dataset.range;
      renderLedger(entriesByDay());
    });
  });

  // ---------- Settings dialog ----------

  const settingsDialog = document.getElementById('settingsDialog');
  const weeklyTargetInput = document.getElementById('weeklyTargetInput');
  const weekStartInput = document.getElementById('weekStartInput');

  document.getElementById('settingsBtn').addEventListener('click', () => {
    weeklyTargetInput.value = settings.weeklyTarget;
    weekStartInput.value = String(settings.weekStart);
    settingsDialog.showModal();
  });

  settingsDialog.addEventListener('close', async () => {
    const t = parseFloat(weeklyTargetInput.value);
    const weeklyTarget = (!isNaN(t) && t > 0) ? t : settings.weeklyTarget;
    const weekStart = parseInt(weekStartInput.value, 10) === 0 ? 0 : 1;
    try{
      const state = await apiCall('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ weeklyTarget, weekStart })
      });
      applyState(state);
      renderAll();
    }catch(e){
      setConnected(false);
      window.alert('Could not save settings: ' + e.message);
    }
  });

  // Downloads come straight from the server so they always reflect what's
  // actually persisted on disk, not the browser's copy.
  function download(url, filename){
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  document.getElementById('exportBtn').addEventListener('click', () => {
    download('/api/export', `clocker-backup-${todayStr()}.json`);
  });

  document.getElementById('exportCsvBtn').addEventListener('click', () => {
    download('/api/export.csv', `clocker-${todayStr()}.csv`);
  });

  // Both import buttons share this; `mode` is 'replace' or 'merge'. Replace
  // warns because it's destructive; merge only adds, so it just confirms the
  // count and reports how many were new versus already present.
  function handleImport(ev, mode){
    const file = ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try{
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.entries)) throw new Error('Invalid file');
        const proceed = window.confirm(mode === 'merge'
          ? `Merge ${data.entries.length} entries from this backup into the data already on the server? Entries already present are skipped, not duplicated.`
          : `This backup contains ${data.entries.length} entries. Importing will replace all data currently stored on the server. Continue?`
        );
        if (!proceed) return;
        const state = await apiCall('/api/import', {
          method: 'POST',
          body: JSON.stringify({ entries: data.entries, settings: data.settings, mode })
        });
        applyState(state);
        renderAll();
        weeklyTargetInput.value = settings.weeklyTarget;
        weekStartInput.value = String(settings.weekStart);
        if (mode === 'merge' && state.imported){
          const { added, skipped } = state.imported;
          window.alert(`Added ${added} new ${added === 1 ? 'entry' : 'entries'}` +
            (skipped ? `, skipped ${skipped} already present.` : '.'));
        }
      }catch(e){
        window.alert('Could not import that backup: ' + e.message);
      }
      ev.target.value = '';
    };
    reader.readAsText(file);
  }

  document.getElementById('importInput').addEventListener('change', (ev) => handleImport(ev, 'replace'));
  document.getElementById('mergeInput').addEventListener('change', (ev) => handleImport(ev, 'merge'));

  document.getElementById('clearAllBtn').addEventListener('click', async () => {
    const proceed = window.confirm('Erase all logged entries on the server? This cannot be undone. Export a backup first if you want to keep a copy.');
    if (!proceed) return;
    try{
      const state = await apiCall('/api/clear', { method: 'POST' });
      applyState(state);
      renderAll();
    }catch(e){
      setConnected(false);
      window.alert('Could not clear entries: ' + e.message);
    }
  });

  document.getElementById('connRetryBtn').addEventListener('click', async () => {
    try{
      await loadState();
      renderAll();
    }catch(e){ /* banner already shown */ }
  });

  // ---------- Init ----------

  (async () => {
    try{
      await loadState();
    }catch(e){
      // setConnected(false) already called inside loadState; render with
      // whatever empty defaults we have so the UI isn't blank.
    }
    renderAll();
  })();
})();
