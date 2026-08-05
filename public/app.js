(() => {
  'use strict';

  const DOW_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const MONTH_LONG = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  // ---------- State ----------
  // Source of truth lives server-side (a JSON file on the Docker volume).
  // The client keeps a local copy for rendering and refreshes it from
  // whatever the API returns after every mutation.

  let entries = [];
  let settings = { weeklyTarget: 8, weekStart: 1 };
  // { date, note, running, elapsedMs, receivedAt } | null — see applyState.
  let activeShift = null;
  let ledgerRange = 'week'; // 'week' | 'all'
  let historyView = 'week'; // 'week' | 'month'
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
    dataVersion++; // every derived table below is keyed to this — see entriesByDay
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
  // Every mutation funnels through applyState, which bumps dataVersion, so a
  // derived table stays valid until that number moves. Caching earns its keep
  // here: the once-a-second shift tick asks for the current week's goal, which
  // walks a whole month of days, and rebuilding the day index on each of those
  // ticks would mean re-scanning every entry ever logged.

  let dataVersion = 0;

  let byDayCache = null;
  let byDayVersion = -1;
  function entriesByDay(){
    if (byDayVersion === dataVersion) return byDayCache;
    const map = new Map();
    for (const e of entries){
      if (!map.has(e.date)) map.set(e.date, []);
      map.get(e.date).push(e);
    }
    byDayCache = map;
    byDayVersion = dataVersion;
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

  // ---------- The running balance and the rolling goal ----------
  // The week is the contracted unit, and being ahead or behind it is one
  // continuous fact about your hours — not something a calendar boundary can
  // end. So whatever a week banks above or below the contracted figure is
  // handed to the next week as a carry, indefinitely: a 12 hour week against an
  // 8 hour contract leaves next week asking for 4, a 4 hour week leaves it
  // asking for 12.
  //
  // Nothing resets this automatically. A month boundary is just a calendar, and
  // zeroing on one would delete hours that were really worked. Forgiving the
  // balance is a decision, so it's a button — see settings.balanceAnchor, the
  // week the count starts from.

  function nextWeekStart(weekStartStr){ return toDateStr(addDays(parseDateStr(weekStartStr), 7)); }
  function prevWeekStart(weekStartStr){ return toDateStr(addDays(parseDateStr(weekStartStr), -7)); }

  function firstLoggedWeek(){
    let first = null;
    for (const dateStr of entriesByDay().keys()){
      const wk = weekKeyOf(dateStr);
      if (!first || wk < first) first = wk;
    }
    return first;
  }

  // Where the balance starts counting: the settle point if there is one, the
  // first logged week otherwise — and the later of the two once both exist,
  // since settling is meant to draw a line under everything before it.
  function balanceStart(){
    const anchor = settings.balanceAnchor
      ? toDateStr(startOfWeek(settings.balanceAnchor))
      : null;
    const first = firstLoggedWeek();
    if (anchor && first) return anchor > first ? anchor : first;
    return anchor || first || toDateStr(startOfWeek(todayStr()));
  }

  // Every week from the start of the balance through the current one, each with
  // the goal it was actually held to. Built in one pass because a week's goal
  // depends on every week before it.
  let scheduleCache = null;
  let scheduleVersion = -1;
  function schedule(){
    if (scheduleVersion === dataVersion) return scheduleCache;

    const byDay = entriesByDay();
    const base = settings.weeklyTarget;
    const currentWk = toDateStr(startOfWeek(todayStr()));
    let last = currentWk;
    for (const dateStr of byDay.keys()){
      const wk = weekKeyOf(dateStr);
      if (wk > last) last = wk; // a backdated entry can sit past this week
    }

    const rows = [];
    const index = new Map();
    let banked = 0;
    let wk = balanceStart();
    // The bound is a guard against a corrupt anchor date, not a real limit —
    // 5000 weeks is close to a century of them.
    for (let i = 0; wk <= last && i < 5000; i++){
      // What the contract had asked for by the end of last week, against what
      // was actually banked by then. Positive means ahead.
      const carryIn = banked - i * base;
      // Clamping at zero never loses a surplus: the goal is derived from the
      // running totals, so anything the clamp swallows is still in `banked` and
      // shows up as a lower goal the week after.
      const goal = Math.max(0, base - carryIn);
      const week = weekTotal(wk, byDay);
      banked += week.total;
      const row = { wk, index: i, total: week.total, daysLogged: week.daysLogged, goal, carryIn };
      rows.push(row);
      index.set(wk, row);
      wk = nextWeekStart(wk);
    }

    scheduleCache = { rows, index, start: rows.length ? rows[0].wk : currentWk, currentWk };
    scheduleVersion = dataVersion;
    return scheduleCache;
  }

  function weekRow(weekStartStr){ return schedule().index.get(weekStartStr); }

  // The contracted weekly hours, adjusted by everything banked before this week.
  function weekGoal(weekStartStr){
    const row = weekRow(weekStartStr);
    return row ? row.goal : settings.weeklyTarget;
  }

  // How you stood at the end of last week. Deliberately not the balance
  // including this week: the current week is still in progress, and counting
  // its unworked hours as a debt would show a fresh Monday as 8:00 behind.
  function settledBalance(){
    const row = weekRow(schedule().currentWk);
    return row ? row.carryIn : 0;
  }

  // ---------- Calendar months (descriptive only) ----------
  // The month view makes no claim about over or under — that signal lives on
  // the weekly scale, where the contract is. So a month here is just the plain
  // calendar month a day falls in, and its numbers are only what was logged.

  function monthKeyOf(dateStr){ return dateStr.slice(0, 7); }
  function monthName(monthKey){ return MONTH_LONG[Number(monthKey.slice(5, 7)) - 1]; }
  function fmtMonthLabel(monthKey){ return `${monthName(monthKey)} ${monthKey.slice(0, 4)}`; }

  function daysInMonth(monthKey){
    const [y, m] = monthKey.split('-').map(Number);
    return new Date(y, m, 0).getDate(); // day 0 of the next month is the last of this one
  }

  function prevMonthKey(monthKey){
    const [y, m] = monthKey.split('-').map(Number);
    const d = new Date(y, m - 2, 1); // m is 1-based here, and we want the month before
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  let monthCache = new Map();
  let monthCacheVersion = -1;
  function monthStats(monthKey){
    if (monthCacheVersion !== dataVersion){
      monthCache.clear();
      monthCacheVersion = dataVersion;
    }
    if (monthCache.has(monthKey)) return monthCache.get(monthKey);

    let total = 0;
    let daysLogged = 0;
    for (const [dateStr, list] of entriesByDay()){
      if (monthKeyOf(dateStr) !== monthKey) continue;
      const dayHours = list.reduce((sum, e) => sum + e.hours, 0);
      if (dayHours > 0) daysLogged++;
      total += dayHours;
    }

    // Per-week rather than per-month is what makes a 28 day February comparable
    // to a 31 day August, and it's the figure that sits next to the contract.
    // The month in progress is divided by the days that have actually happened,
    // not the whole month — otherwise a good first week reads as a terrible
    // month right up until the last day of it.
    const today = todayStr();
    const days = monthKey === monthKeyOf(today)
      ? Math.max(1, Number(today.slice(8, 10)))
      : daysInMonth(monthKey);
    const weeks = days / 7;
    const stats = { monthKey, total, daysLogged, weeks, perWeek: total / weeks };
    monthCache.set(monthKey, stats);
    return stats;
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
    renderShiftProjection();

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

  // ---------- Overtime projection & chime ----------
  // While a shift runs, project the week's total as it *will* stand once this
  // shift is logged — the hours already banked this week plus the live elapsed
  // — and chime the moment that projection crosses the week's goal. The shift's
  // own date decides which week it lands in, so the projection matches where
  // the hours will actually go, not just "this week".
  //
  // The bar it has to clear is the *adjusted* goal, not the flat contracted
  // figure: on a week trimmed to 4:00 because the month is already running
  // ahead, the fifth hour is the one worth a chime.

  function projectedWeek(){
    const wkStartStr = toDateStr(startOfWeek(activeShift ? activeShift.date : todayStr()));
    const logged = weekTotal(wkStartStr, entriesByDay()).total;
    const total = logged + shiftElapsedMs(activeShift) / 3600000;
    const target = weekGoal(wkStartStr);
    // A goal of zero is a real answer, not a missing one — the month is already
    // covered through this week, so the very first minute is over.
    return { total, target, over: total > target };
  }

  function renderShiftProjection(){
    const el = document.getElementById('shiftProjection');
    if (!activeShift){
      el.hidden = true;
      el.classList.remove('is-over');
      return;
    }
    const { total, target, over } = projectedWeek();
    el.hidden = false;
    el.classList.toggle('is-over', over);
    const tail = over
      ? `${fmtHM(total - target)} over`
      : `${fmtHM(target - total)} to go`;
    el.innerHTML = `Week would be <strong>${fmtHM(total)}</strong> / ${fmtHM(target)} · ${tail}`;
  }

  // A single AudioContext, created and unlocked by the user gesture that starts
  // or resumes a shift — browsers block audio that isn't tied to one.
  let audioCtx = null;
  function ensureAudio(){
    if (audioCtx) return audioCtx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
    return audioCtx;
  }
  function resumeAudio(){
    const ctx = ensureAudio();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }
  function playChime(){
    const ctx = ensureAudio();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    // A rising two-tone (A5 -> D6) — a notification, not an alarm.
    [880, 1174.66].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = now + i * 0.18;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0008, t + 0.4);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.42);
    });
  }

  function notifyOvertime(){
    try{
      if (window.Notification && Notification.permission === 'granted'){
        new Notification('Clocker', { body: 'This shift has taken you into overtime for the week.' });
      }
    }catch(e){ /* the chime is the real signal; a notification is a bonus */ }
  }

  const CHIME_KEY = 'clocker.overtimeChime';
  function chimeEnabled(){ return localStorage.getItem(CHIME_KEY) !== '0'; } // default on

  // Fires once per crossing. Keyed to the shift's start time so ending one
  // shift and starting another re-arms cleanly, and seeded on first sight so a
  // shift that begins *already* in overtime doesn't chime on tick one — only a
  // genuine crossing during the session does. Dropping back under (an edit, a
  // discarded sibling entry) re-arms it.
  let monitoredStart = null;
  let overtimeSeen = false;
  function checkOvertime(){
    if (!activeShift){ monitoredStart = null; return; }
    const { over } = projectedWeek();
    if (monitoredStart !== activeShift.startedAt){
      monitoredStart = activeShift.startedAt;
      overtimeSeen = over;
      return;
    }
    if (over && !overtimeSeen){
      if (chimeEnabled()){ playChime(); notifyOvertime(); }
      overtimeSeen = true;
    } else if (!over){
      overtimeSeen = false;
    }
  }

  // Ticks the visible clock every second between server round-trips; harmless
  // no-op while no shift is running.
  setInterval(() => {
    if (activeShift && activeShift.running){
      document.getElementById('shiftClock').textContent = fmtClock(shiftElapsedMs(activeShift));
      renderShiftProjection();
      checkOvertime();
    }
  }, 1000);

  function renderHero(byDay){
    const today = todayStr();
    const wkStart = startOfWeek(today);
    const wkStartStr = toDateStr(wkStart);
    const { total, daysLogged } = weekTotal(wkStartStr, byDay);
    const week = weekRow(wkStartStr);
    const base = settings.weeklyTarget;
    const goal = week ? week.goal : base;
    const carryIn = week ? week.carryIn : 0;

    document.getElementById('weekTotal').textContent = fmtHM(total);
    const remaining = goal - total;
    const sub = document.getElementById('weekSub');
    if (goal <= 0){
      sub.textContent = 'nothing required this week \u00b7 you\u2019re already ahead';
    } else if (remaining > 0){
      sub.textContent = `of ${fmtHM(goal)} this week \u00b7 ${fmtHM(remaining)} left`;
    } else if (remaining === 0){
      sub.textContent = `of ${fmtHM(goal)} this week \u00b7 goal met exactly`;
    } else {
      // "over" already carries the sign \u2014 fmtHMSigned here would read "\u221212:00 over".
      sub.textContent = `of ${fmtHM(goal)} this week \u00b7 ${fmtHM(-remaining)} over`;
    }

    // Only worth a line once the goal has actually moved off the contracted
    // figure \u2014 on an ordinary week it would just be noise. Half a minute is the
    // threshold because that's the point below which nothing here can render a
    // difference anyway.
    const carryNote = document.getElementById('carryNote');
    if (Math.abs(carryIn) < 1 / 120){
      carryNote.hidden = true;
    } else {
      carryNote.hidden = false;
      carryNote.textContent = carryIn > 0
        ? `${fmtHM(base)} contracted \u00b7 ${fmtHM(carryIn)} already banked ahead`
        : `${fmtHM(base)} contracted \u00b7 ${fmtHM(-carryIn)} still owed`;
    }

    const wkEnd = addDays(wkStart, 6);
    document.getElementById('weekRangeLabel').textContent =
      `${fmtDayLabel(toDateStr(wkStart))} \u2013 ${fmtDayLabel(toDateStr(wkEnd))}`;
    document.getElementById('daysLoggedLabel').textContent = `${daysLogged} / 7`;

    const balanceEl = document.getElementById('balanceValue');
    balanceEl.textContent = Math.abs(carryIn) < 1 / 120 ? 'level' : fmtHMSigned(carryIn);
    balanceEl.style.color = carryIn > 0
      ? 'var(--teal)'
      : (carryIn < 0 ? 'var(--brass-bright)' : 'var(--paper)');

    const statusEl = document.getElementById('statusLabel');
    if (goal <= 0){
      statusEl.textContent = 'Covered';
      statusEl.style.color = 'var(--teal)';
    } else if (total >= goal){
      statusEl.textContent = 'Goal met';
      statusEl.style.color = 'var(--teal)';
    } else if (total > 0){
      statusEl.textContent = 'In progress';
      statusEl.style.color = 'var(--brass-bright)';
    } else {
      statusEl.textContent = 'Not started';
      statusEl.style.color = 'var(--paper-dim)';
    }

    drawPunchStrip(total, goal);
  }

  function drawPunchStrip(total, target){
    const svg = document.getElementById('punchStrip');
    const vbW = 640, vbH = 100;
    const gap = 8;
    const segH = 56;
    const y = (vbH - segH) / 2;

    // A goal of zero means the month is already covered through this week.
    // There's no quota left to divide into segments, and an empty grid would
    // read as "nothing done" \u2014 the opposite of the truth \u2014 so show it filled.
    if (target <= 0){
      svg.innerHTML = `<rect x="0" y="${y}" width="${vbW}" height="${segH}" rx="6" fill="#4fa69a"/>`;
      return;
    }

    // One box per hour reads beautifully at a normal 8:00 goal, but a goal that
    // has absorbed weeks of deficit would shred the strip into slivers. Past a
    // dozen the boxes stop being hours and just become a proportional gauge.
    const segCount = Math.min(12, Math.max(1, Math.round(target) || 1));
    const segHours = target / segCount;
    const segW = (vbW - gap*(segCount-1)) / segCount;

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
    document.getElementById('historyChart').innerHTML = '';
    document.getElementById('historyTable').innerHTML = '';
    document.getElementById('historySummary').hidden = true;
    if (historyView === 'month') renderMonthHistory(byDay);
    else renderWeekHistory(byDay);
  }

  // One bar per period, scaled against the tallest thing on show \u2014 the totals
  // and the goals both, so a bar that falls short of its goal looks short.
  function drawHistoryBars(rows){
    const chart = document.getElementById('historyChart');
    const maxVal = Math.max(1, ...rows.map((r) => Math.max(r.total, r.goal)));
    for (const r of rows.slice().reverse()){ // oldest -> newest, left to right
      const pct = Math.max(2, (r.total / maxVal) * 100);
      const cls = r.total > r.goal ? 'is-over' : (r.isCurrent ? 'is-current' : '');
      const col = document.createElement('div');
      col.className = 'hbar-col';
      col.innerHTML = `
        <div class="hbar-track"><div class="hbar ${cls}" style="height:${pct}%"></div></div>
        <div class="hbar-label">${r.label}</div>`;
      chart.appendChild(col);
    }
  }

  function histRow(rangeHtml, valueHtml, totalClass){
    const row = document.createElement('div');
    row.className = 'hist-row';
    row.innerHTML = `
      <span class="hist-range">${rangeHtml}</span>
      <span class="hist-total ${totalClass || ''}">${valueHtml}</span>`;
    return row;
  }

  // The periods to show, newest first: an unbroken run back from the current
  // one, stopping at the oldest with anything logged (or the cap, whichever
  // comes first). Unbroken matters now that goals carry — a skipped week is
  // precisely why the week after it asks for more, so leaving it out of the
  // table would hide the reason the number moved. Stopping at the oldest entry
  // is what keeps a brand-new ledger from opening on a wall of empty periods.
  function periodsBack(current, previous, oldest, cap){
    const out = [];
    let key = current;
    while (out.length < cap){
      out.push(key);
      const prev = previous(key);
      if (!oldest || prev < oldest) break;
      key = prev;
    }
    return out;
  }

  // Weeks are where the contract lives, so this is the view that judges: each
  // week against the goal it was actually held to, with the running balance
  // underneath it.
  function renderWeekHistory(byDay){
    const currentWkKey = toDateStr(startOfWeek(todayStr()));

    const weeks = periodsBack(currentWkKey, prevWeekStart, firstLoggedWeek(), 8).map((wk) => {
      const row = weekRow(wk);
      const start = parseDateStr(wk);
      return {
        wk,
        total: row ? row.total : weekTotal(wk, byDay).total,
        goal: row ? row.goal : null, // null means the week predates the settle point
        isCurrent: wk === currentWkKey,
        label: `${MONTH_SHORT[start.getMonth()]} ${start.getDate()}`
      };
    });

    // A settled week has no goal to fall short of, so it is never drawn "over".
    drawHistoryBars(weeks.map((w) => ({
      total: w.total,
      goal: w.goal === null ? w.total : w.goal,
      isCurrent: w.isCurrent,
      label: w.label
    })));

    const table = document.getElementById('historyTable');
    for (const w of weeks){
      const start = parseDateStr(w.wk);
      const range = `${fmtDayLabel(toDateStr(start))} – ${fmtDayLabel(toDateStr(addDays(start, 6)))}`;

      // Weeks before the settle point did have goals at the time, but that
      // slate was deliberately wiped. Re-deriving one would assert something
      // the user cancelled, so show what was worked and nothing more.
      if (w.goal === null){
        table.appendChild(histRow(
          `${range} <span class="hist-flag is-quiet">settled</span>`,
          fmtHM(w.total),
          'is-settled'
        ));
        continue;
      }

      const diff = w.total - w.goal;
      // A week whose goal was trimmed or raised says so, otherwise a 4:00 week
      // reading "goal met" is a mystery months later.
      const shifted = Math.abs(w.goal - settings.weeklyTarget) >= 1 / 120;
      table.appendChild(histRow(
        range + (w.isCurrent ? ' (current)' : '') +
          (shifted ? ' <span class="hist-flag">adjusted</span>' : ''),
        `${fmtHM(w.total)}<span class="hist-goal"> / ${fmtHM(w.goal)}</span>` +
          (diff !== 0 ? ` <span class="hist-diff">(${fmtHMSigned(diff)})</span>` : ''),
        diff > 0 ? 'is-over' : (diff === 0 && w.total > 0 ? 'is-met' : '')
      ));
    }

    renderBalanceSummary();
  }

  function renderBalanceSummary(){
    const balance = settledBalance();
    const summary = document.getElementById('historySummary');
    summary.hidden = false;
    if (Math.abs(balance) < 1 / 120){
      summary.innerHTML = 'Running balance through last week: <strong class="is-met">level</strong>.';
      return;
    }
    summary.innerHTML = 'Running balance through last week: ' +
      `<strong class="${balance > 0 ? 'is-over' : 'is-under'}">${fmtHMSigned(balance)}</strong> ` +
      `${balance > 0 ? 'ahead of' : 'behind'} contract, counted from ${fmtDayLabel(schedule().start)}.`;
  }

  // Months make no claim about over or under: no target, no balance, no
  // colouring. Just what was logged, and enough shape to read it by.
  function renderMonthHistory(byDay){
    const currentKey = monthKeyOf(todayStr());
    let oldest = null;
    for (const dateStr of byDay.keys()){
      const key = monthKeyOf(dateStr);
      if (!oldest || key < oldest) oldest = key;
    }

    const ordered = periodsBack(currentKey, prevMonthKey, oldest, 1000);
    const months = ordered.slice(0, 12).map(monthStats);
    const currentYear = String(new Date().getFullYear());

    drawHistoryBars(months.map((m) => ({
      total: m.total,
      goal: 0, // nothing to fall short of, so no month bar is ever "over"
      isCurrent: m.monthKey === currentKey,
      // The year only earns a place on the label once the bar isn't from it.
      label: MONTH_SHORT[Number(m.monthKey.slice(5, 7)) - 1] +
        (m.monthKey.slice(0, 4) === currentYear ? '' : ` '${m.monthKey.slice(2, 4)}`)
    })));

    const table = document.getElementById('historyTable');
    for (const m of months){
      const isCurrent = m.monthKey === currentKey;
      table.appendChild(histRow(
        `${fmtMonthLabel(m.monthKey)}${isCurrent ? ' (current)' : ''} \u00b7 ` +
          `${m.daysLogged} day${m.daysLogged === 1 ? '' : 's'}`,
        `${fmtHM(m.total)}<span class="hist-goal"> \u00b7 ${fmtHM(m.perWeek)}/wk</span>`
      ));
    }

    // A plain total across everything on record, descriptive like the rest of
    // this view. The over/under signal lives in the Weeks tab.
    const all = ordered.map(monthStats);
    const total = all.reduce((sum, m) => sum + m.total, 0);
    const summary = document.getElementById('historySummary');
    if (total <= 0){
      summary.hidden = true;
      return;
    }
    summary.hidden = false;
    summary.innerHTML = `<strong>${fmtHM(total)}</strong> logged across ${all.length} ` +
      `month${all.length === 1 ? '' : 's'}, since ${fmtMonthLabel(all[all.length - 1].monthKey)}.`;
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
    resumeAudio(); // unlock the chime while we have the click gesture
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
    resumeAudio();
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

  // Scoped to the group that was clicked — there is more than one toggle on the
  // page now, and a page-wide selector would clear the other one's active state.
  function wireToggle(groupId, onPick){
    const group = document.getElementById(groupId);
    group.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.toggle-btn');
      if (!btn || btn.classList.contains('is-active')) return;
      group.querySelectorAll('.toggle-btn').forEach(b => b.classList.toggle('is-active', b === btn));
      onPick(btn.dataset.value);
    });
  }

  wireToggle('ledgerToggle', (value) => {
    ledgerRange = value;
    renderLedger(entriesByDay());
  });

  wireToggle('historyToggle', (value) => {
    historyView = value;
    renderHistory(entriesByDay());
  });

  // ---------- Settings dialog ----------

  const settingsDialog = document.getElementById('settingsDialog');
  const weeklyTargetInput = document.getElementById('weeklyTargetInput');
  const weekStartInput = document.getElementById('weekStartInput');
  const overtimeChimeInput = document.getElementById('overtimeChimeInput');

  const settleBalance = document.getElementById('settleBalance');
  const settleSince = document.getElementById('settleSince');

  function renderSettleRow(){
    const balance = settledBalance();
    const level = Math.abs(balance) < 1 / 120;
    settleBalance.textContent = level ? 'level' : fmtHMSigned(balance);
    settleBalance.className = 'settle-value' +
      (level ? '' : (balance > 0 ? ' is-over' : ' is-under'));
    settleSince.textContent = entries.length
      ? `counted from ${fmtDayLabel(schedule().start)}`
      : 'nothing logged yet';
  }

  document.getElementById('settingsBtn').addEventListener('click', () => {
    weeklyTargetInput.value = settings.weeklyTarget;
    weekStartInput.value = String(settings.weekStart);
    overtimeChimeInput.checked = chimeEnabled();
    renderSettleRow();
    settingsDialog.showModal();
  });

  // Anchors the balance to this week, so every week before it stops counting.
  // Sent on its own rather than folded into the dialog's close handler: this is
  // a deliberate, confirmed action, not a preference that saves on the way out.
  document.getElementById('settleBtn').addEventListener('click', async () => {
    const balance = settledBalance();
    const standing = Math.abs(balance) < 1 / 120
      ? 'level'
      : `${fmtHM(Math.abs(balance))} ${balance > 0 ? 'ahead of' : 'behind'} contract`;
    const proceed = window.confirm(
      `You're currently ${standing}. Settling clears that and starts counting again from this week. ` +
      `Your logged entries are kept — only the running balance restarts. Continue?`
    );
    if (!proceed) return;
    try{
      const state = await apiCall('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ balanceAnchor: toDateStr(startOfWeek(todayStr())) })
      });
      applyState(state);
      renderAll();
      renderSettleRow();
    }catch(e){
      setConnected(false);
      window.alert('Could not settle the balance: ' + e.message);
    }
  });

  // The chime preference is per-device (you might want sound on a desktop but
  // not a phone), so it lives in localStorage rather than the synced settings.
  // Enabling it is a click, so it's also the moment to ask for notification
  // permission and unlock audio while a gesture is in hand.
  overtimeChimeInput.addEventListener('change', () => {
    localStorage.setItem(CHIME_KEY, overtimeChimeInput.checked ? '1' : '0');
    if (overtimeChimeInput.checked){
      resumeAudio();
      if (window.Notification && Notification.permission === 'default'){
        Notification.requestPermission();
      }
    }
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
