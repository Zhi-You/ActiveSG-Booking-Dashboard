// ==UserScript==
// @name         ActiveSG Booking Dashboard
// @namespace    local.activesg.dashboard
// @version      2.0.0
// @description  Read-only time × venue grid on ActiveSG after you log in. Never books anything.
// @match        https://activesg.gov.sg/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/**
 * Runs on activesg.gov.sg after you log in. Calls the same tRPC routes the
 * official page uses (same origin, same cookies, same Cloudflare pass).
 * Read-only: clicking a cell only navigates to ActiveSG's own booking UI.
 */
(function () {
  'use strict';

  if (window.__ASG_BOOKING_DASHBOARD__) return;
  window.__ASG_BOOKING_DASHBOARD__ = true;

  const ORIGIN = 'https://activesg.gov.sg';
  const FANOUT = 3;
  const CACHE_TTL_MS = 2 * 60 * 1000;
  const STORAGE_KEY = 'asg-dash-prefs';

  const ACTIVITY_LIST_PROBES = [
    ['activity.list', {}],
    ['activity.listAll', {}],
    ['activity.getAll', {}],
    ['activity.listForBooking', {}],
    ['activity.search', { query: '' }],
    ['activity.search', { search: '' }],
  ];

  const SLOT_PROBES = [
    'schedule.getAvailability',
    'schedule.getSlots',
    'schedule.listSlots',
    'schedule.getByDate',
    'booking.getAvailability',
  ];

  const cache = new Map();
  let slotProbe = null;
  let lastRawSample = null;

  function todayStr() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Singapore',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  function loadPrefs() {
    try {
      return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '{}');
    } catch {
      return {};
    }
  }

  function savePrefs(partial) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadPrefs(), ...partial }));
  }

  function unwrapTrpc(body) {
    if (!body || typeof body !== 'object') return body;
    if (body.error) {
      const msg =
        body.error.json?.message ||
        body.error.message ||
        body.error.data?.code ||
        JSON.stringify(body.error);
      const err = new Error(String(msg));
      err.code = body.error.data?.code || body.error.code;
      throw err;
    }
    const data = body.result?.data;
    if (data && typeof data === 'object' && 'json' in data) return data.json;
    return data;
  }

  async function trpcGet(procedure, json, meta) {
    const payload = { json };
    if (meta) payload.meta = meta;
    const url = `${ORIGIN}/api/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(payload))}`;
    const res = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    const text = await res.text();
    if (text.trimStart().startsWith('<')) {
      throw new Error(
        'ActiveSG returned a security check page. Reload this tab, finish the check, and log in if asked.'
      );
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`ActiveSG ${procedure} returned non-JSON (HTTP ${res.status})`);
    }
    if (!res.ok) {
      try {
        unwrapTrpc(body);
      } catch (e) {
        throw e;
      }
      throw new Error(`ActiveSG ${procedure} failed (HTTP ${res.status})`);
    }
    return unwrapTrpc(body);
  }

  function asArray(value) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object') return [];
    for (const key of ['items', 'results', 'activities', 'venues', 'data', 'records', 'list']) {
      if (Array.isArray(value[key])) return value[key];
    }
    const nested = Object.values(value).find((v) => Array.isArray(v));
    return nested || [];
  }

  function pick(obj, keys) {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const key of keys) {
      if (obj[key] != null && obj[key] !== '') return obj[key];
    }
    return undefined;
  }

  function normalizeActivity(raw) {
    const id = pick(raw, ['id', 'activityId', 'activity_id']);
    const name = pick(raw, ['name', 'title', 'label', 'activityName', 'displayName']);
    if (id == null || !name) return null;
    return { id: String(id), name: String(name) };
  }

  function normalizeVenue(raw) {
    const id = pick(raw, ['id', 'venueId', 'venue_id']);
    const name = pick(raw, ['name', 'venueName', 'title', 'label', 'displayName']);
    if (id == null || !name) return null;
    return { id: String(id), name: String(name), raw };
  }

  function formatHm(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'string') {
      const hm = value.match(/(\d{1,2}):(\d{2})/);
      if (hm) return `${hm[1].padStart(2, '0')}:${hm[2]}`;
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) {
        return d.toLocaleTimeString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZone: 'Asia/Singapore',
        });
      }
      return null;
    }
    if (typeof value === 'number') {
      if (value >= 0 && value < 24 * 60 && Number.isInteger(value)) {
        const h = Math.floor(value / 60);
        const m = value % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      }
      const d = new Date(value > 1e12 ? value : value * 1000);
      if (!Number.isNaN(d.getTime())) {
        return d.toLocaleTimeString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZone: 'Asia/Singapore',
        });
      }
    }
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Asia/Singapore',
      });
    }
    return null;
  }

  function asDateKey(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'string') {
      const iso = value.match(/\d{4}-\d{2}-\d{2}/);
      if (iso) return iso[0];
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return formatDateSgt(d);
      return null;
    }
    if (typeof value === 'number') {
      const d = new Date(value > 1e12 ? value : value * 1000);
      if (!Number.isNaN(d.getTime())) return formatDateSgt(d);
    }
    if (value instanceof Date) return formatDateSgt(value);
    if (typeof value === 'object') {
      return asDateKey(pick(value, ['date', 'day', 'startDate', 'startsAt', 'slotDate']));
    }
    return null;
  }

  function formatDateSgt(d) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Singapore',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  }

  function timeLabelFrom(node) {
    const start = formatHm(
      pick(node, ['startTime', 'start', 'timeFrom', 'time_from', 'from', 'begin', 'startAt', 'startsAt'])
    );
    const end = formatHm(pick(node, ['endTime', 'end', 'timeTo', 'time_to', 'to', 'finish', 'endAt', 'endsAt']));
    if (start && end) return `${start} - ${end}`;
    if (start) return start;
    if (typeof node.timeSlot === 'string') return node.timeSlot;
    if (typeof node.label === 'string' && /\d{1,2}:\d{2}/.test(node.label)) return node.label;
    return null;
  }

  function numericCount(node) {
    const n = pick(node, [
      'availableCount',
      'availableSlots',
      'vacancy',
      'remaining',
      'remainingSlots',
      'count',
      'quota',
      'slotsAvailable',
      'freeCount',
    ]);
    if (typeof n === 'number' && !Number.isNaN(n)) return n;
    if (typeof n === 'string' && n.trim() !== '' && !Number.isNaN(Number(n))) return Number(n);
    return null;
  }

  function isExplicitlyUnavailable(node) {
    const status = String(pick(node, ['status', 'availability', 'state', 'bookingStatus']) || '').toUpperCase();
    if (['UNAVAILABLE', 'FULL', 'BOOKED', 'CLOSED', 'NONE', 'SOLD_OUT'].includes(status)) return true;
    if (node.isAvailable === false || node.available === false || node.bookable === false) return true;
    if (node.is_available === 'N' || node.isAvailable === 'N') return true;
    const count = numericCount(node);
    if (count === 0) return true;
    return false;
  }

  function isAvailableSlot(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    if (isExplicitlyUnavailable(node)) return false;
    if (node.isAvailable === true || node.available === true || node.bookable === true) return true;
    if (node.is_available === 'Y' || node.isAvailable === 'Y') return true;
    const count = numericCount(node);
    if (count != null) return count > 0;
    const status = String(pick(node, ['status', 'availability', 'state']) || '').toUpperCase();
    if (['AVAILABLE', 'OPEN', 'VACANT', 'FREE'].includes(status)) return true;
    if (node.isBallot === true || node.ballot === true || String(node.type || '').toUpperCase() === 'BALLOT') {
      return true;
    }
    // Availability payloads often list only free sessions, with a time and no flag.
    if (timeLabelFrom(node)) return true;
    return false;
  }

  function slotCount(node) {
    const n = numericCount(node);
    if (n != null) return n;
    if (node.isBallot === true || node.ballot === true) return 1;
    return 1;
  }

  function pickDateBranch(data, date) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
    if (data[date] != null) return data[date];
    for (const key of ['dates', 'days', 'byDate', 'availabilityByDate', 'slotsByDate']) {
      const branch = data[key];
      if (branch && typeof branch === 'object' && !Array.isArray(branch) && branch[date] != null) {
        return branch[date];
      }
      if (Array.isArray(branch)) {
        const match = branch.find((item) => asDateKey(item) === date);
        if (match) return match;
      }
    }
    return data;
  }

  function extractSlots(data, date) {
    const scoped = pickDateBranch(data, date);
    const found = [];

    function visit(node, inheritedDate) {
      if (node == null) return;
      if (Array.isArray(node)) {
        node.forEach((child) => visit(child, inheritedDate));
        return;
      }
      if (typeof node !== 'object') return;

      const nodeDate = asDateKey(node) || inheritedDate;
      if (nodeDate && nodeDate !== date) {
        for (const value of Object.values(node)) {
          if (value && typeof value === 'object') visit(value, nodeDate);
        }
        return;
      }

      const label = timeLabelFrom(node);
      if (label && isAvailableSlot(node)) {
        found.push({
          label,
          count: slotCount(node),
          ballot: !!(node.isBallot || node.ballot),
        });
        return;
      }

      const nestedKeys = ['slots', 'timeslots', 'timeSlots', 'sessions', 'resources', 'courts', 'facilities', 'items'];
      let walked = false;
      for (const key of nestedKeys) {
        if (node[key] != null) {
          visit(node[key], nodeDate || inheritedDate);
          walked = true;
        }
      }
      if (walked) return;

      for (const value of Object.values(node)) {
        if (value && typeof value === 'object') visit(value, nodeDate || inheritedDate);
      }
    }

    visit(scoped, asDateKey(scoped) || date);

    const merged = new Map();
    for (const slot of found) {
      const prev = merged.get(slot.label) || { label: slot.label, count: 0, ballot: false };
      prev.count += slot.count;
      prev.ballot = prev.ballot || slot.ballot;
      merged.set(slot.label, prev);
    }
    return [...merged.values()];
  }

  function isAuthError(err) {
    const text = `${err.code || ''} ${err.message || ''}`.toLowerCase();
    return /unauthor|unauthorized|forbidden|not logged|unauthenticated|401|403/.test(text);
  }

  async function getActivities() {
    const collected = [];
    for (const [procedure, input] of ACTIVITY_LIST_PROBES) {
      try {
        const data = await trpcGet(procedure, input);
        const list = asArray(data).map(normalizeActivity).filter(Boolean);
        if (list.length) return list.sort((a, b) => a.name.localeCompare(b.name));
        if (normalizeActivity(data)) collected.push(normalizeActivity(data));
      } catch (err) {
        if (isAuthError(err)) throw err;
      }
    }

    const fromUrl = activityIdFromPage();
    if (fromUrl) {
      try {
        const one = await trpcGet('activity.get', { activityId: fromUrl });
        const normalized = normalizeActivity(one) || normalizeActivity({ ...one, id: fromUrl });
        if (normalized) return [normalized];
      } catch (err) {
        if (isAuthError(err)) throw err;
      }
    }

    const harvested = harvestActivitiesFromPage();
    if (harvested.length) return harvested;
    if (collected.length) return collected;
    throw new Error('Could not load the sport list from ActiveSG. Open a facility booking page, then click Refresh.');
  }

  function activityIdFromPage() {
    const url = new URL(location.href);
    const fromQuery = url.searchParams.get('activityId') || url.searchParams.get('activity_id');
    if (fromQuery) return fromQuery;
    const parts = url.pathname.split('/').filter(Boolean);
    const i = parts.findIndex((part) => /activity/i.test(part));
    if (i >= 0 && parts[i + 1]) return parts[i + 1];
    return null;
  }

  function harvestActivitiesFromPage() {
    const seen = new Map();
    for (const a of document.querySelectorAll('a[href]')) {
      try {
        const href = new URL(a.href, location.origin);
        if (href.origin !== ORIGIN) continue;
        const id = href.searchParams.get('activityId') || href.searchParams.get('activity_id');
        const name = (a.textContent || '').trim();
        if (id && name && name.length < 80) seen.set(String(id), { id: String(id), name });
      } catch {
        /* ignore bad hrefs */
      }
    }
    return [...seen.values()];
  }

  async function getVenues(activityId) {
    const data = await trpcGet(
      'venue.listByActivity',
      { activityId, postalCode: null },
      { values: { postalCode: ['undefined'] } }
    );
    const list = asArray(data).map(normalizeVenue).filter(Boolean);
    if (!list.length) throw new Error('No venues returned for this sport.');
    return list;
  }

  async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const idx = next++;
        results[idx] = await fn(items[idx], idx);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  }

  async function slotsForVenue(activityId, venue, date) {
    const summary = await trpcGet('schedule.getAvailabilitySummary', {
      venueId: venue.id,
      activityId,
    });
    lastRawSample = lastRawSample || { venue: venue.name, procedure: 'schedule.getAvailabilitySummary', data: summary };
    let slots = extractSlots(summary, date);
    if (slots.length) return slots;

    const probes = slotProbe ? [slotProbe] : SLOT_PROBES;
    for (const procedure of probes) {
      try {
        const extra = await trpcGet(procedure, { venueId: venue.id, activityId, date });
        lastRawSample = { venue: venue.name, procedure, data: extra };
        slots = extractSlots(extra, date);
        if (slots.length) {
          slotProbe = procedure;
          return slots;
        }
      } catch (err) {
        if (isAuthError(err)) throw err;
      }
    }
    return [];
  }

  async function getAvailability(activityId, date) {
    const cacheKey = `${activityId}:${date}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() < hit.expiresAt) return { ...hit.value, cached: true };

    lastRawSample = null;
    const venues = await getVenues(activityId);
    const perVenue = await mapWithConcurrency(venues, FANOUT, async (venue) => {
      try {
        const slots = await slotsForVenue(activityId, venue, date);
        return { venue: venue.name, venueId: venue.id, slots, error: null };
      } catch (err) {
        return { venue: venue.name, venueId: venue.id, slots: [], error: err.message };
      }
    });

    const grid = {};
    for (const row of perVenue) {
      for (const slot of row.slots) {
        grid[slot.label] ??= {};
        grid[slot.label][row.venue] ??= { count: 0, venueId: row.venueId, ballot: false };
        grid[slot.label][row.venue].count += slot.count;
        grid[slot.label][row.venue].ballot = grid[slot.label][row.venue].ballot || slot.ballot;
      }
    }

    const value = {
      activityId,
      date,
      generatedAt: new Date().toISOString(),
      venues: perVenue.map((v) => v.venue),
      venueIds: Object.fromEntries(perVenue.map((v) => [v.venue, v.venueId])),
      grid,
      errors: perVenue.filter((v) => v.error).map((v) => ({ venue: v.venue, error: v.error })),
      unparsed: perVenue.every((v) => v.slots.length === 0) && lastRawSample,
    };
    cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return { ...value, cached: false };
  }

  function bookingUrl(activityId, venueId, date) {
    const url = new URL(location.href);
    url.searchParams.set('activityId', activityId);
    url.searchParams.set('venueId', venueId);
    url.searchParams.set('date', date);
    if (!/venue/i.test(url.pathname)) {
      return `${ORIGIN}/facilities?activityId=${encodeURIComponent(activityId)}&venueId=${encodeURIComponent(venueId)}&date=${encodeURIComponent(date)}`;
    }
    return url.toString();
  }

  function heatColor(count) {
    if (count <= 0) return 'transparent';
    if (count === 1) return '#fde68a';
    if (count <= 3) return '#86efac';
    return '#22c55e';
  }

  const CSS = `
    :host { all: initial; }
    .wrap { font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #1a1a1a; }
    .toggle {
      position: fixed; top: 88px; right: 0; z-index: 2147483646;
      border: 0; border-radius: 8px 0 0 8px; background: #2563eb; color: #fff;
      padding: 10px 12px; font-size: 13px; cursor: pointer; box-shadow: 0 2px 8px rgb(0 0 0 / 20%);
    }
    .panel {
      position: fixed; top: 0; right: 0; z-index: 2147483645;
      width: min(92vw, 1100px); height: 100vh; background: #fff;
      box-shadow: -8px 0 24px rgb(0 0 0 / 18%);
      display: flex; flex-direction: column; transform: translateX(100%);
      transition: transform 160ms ease;
    }
    .panel.open { transform: translateX(0); }
    .header { padding: 16px 18px 10px; border-bottom: 1px solid #eee; }
    .header h1 { font-size: 16px; margin: 0 0 4px; }
    .sub { font-size: 12px; color: #666; margin: 0; }
    .controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; padding: 12px 18px; }
    .controls label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #555; }
    select, input[type='date'] { padding: 6px 8px; border-radius: 6px; border: 1px solid #ccc; font-size: 13px; }
    button.run { padding: 8px 14px; border: 0; border-radius: 6px; background: #2563eb; color: #fff; cursor: pointer; }
    button.run:disabled { opacity: 0.6; cursor: default; }
    .updated { font-size: 12px; color: #777; margin-left: auto; align-self: center; }
    .body { flex: 1; overflow: auto; padding: 0 18px 18px; }
    .error { color: #dc2626; font-size: 13px; }
    .warn { color: #b45309; font-size: 13px; }
    .empty { color: #777; font-size: 13px; }
    table { border-collapse: collapse; width: 100%; font-size: 12px; }
    th, td { border: 1px solid #e5e5e5; padding: 7px 8px; text-align: center; }
    th { background: #f5f5f5; position: sticky; top: 0; z-index: 1; }
    .time { white-space: nowrap; font-weight: 600; background: #fafafa; text-align: left; }
    .clickable { cursor: pointer; }
    .clickable:hover { outline: 2px solid #2563eb; }
    details { margin-top: 12px; font-size: 12px; color: #555; }
    pre { background: #f6f6f6; padding: 8px; overflow: auto; max-height: 240px; font-size: 11px; }
  `;

  function mount() {
    const host = document.createElement('div');
    host.id = 'asg-booking-dashboard';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';

    const toggle = document.createElement('button');
    toggle.className = 'toggle';
    toggle.textContent = 'Availability';

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <div class="header">
        <h1>ActiveSG Booking Dashboard</h1>
        <p class="sub">Read-only grid across every venue. Click a cell to open ActiveSG's own booking page. Nothing is booked for you.</p>
      </div>
      <div class="controls">
        <label>Sport<select id="sport"></select></label>
        <label>Date<input id="date" type="date" /></label>
        <button class="run" id="refresh" type="button">Load grid</button>
        <span class="updated" id="updated"></span>
      </div>
      <div class="body" id="body"><p class="empty">Log into ActiveSG if you have not already, pick a sport and date, then load the grid.</p></div>
    `;

    wrap.append(toggle, panel);
    shadow.append(style, wrap);
    document.documentElement.appendChild(host);

    const sportEl = panel.querySelector('#sport');
    const dateEl = panel.querySelector('#date');
    const refreshEl = panel.querySelector('#refresh');
    const updatedEl = panel.querySelector('#updated');
    const bodyEl = panel.querySelector('#body');
    const prefs = loadPrefs();
    dateEl.value = prefs.date || todayStr();

    toggle.addEventListener('click', () => {
      panel.classList.toggle('open');
      toggle.textContent = panel.classList.contains('open') ? 'Close' : 'Availability';
    });

    async function fillSports() {
      bodyEl.replaceChildren(p('empty', 'Loading sports…'));
      try {
        const sports = await getActivities();
        sportEl.replaceChildren();
        for (const sport of sports) {
          const opt = document.createElement('option');
          opt.value = sport.id;
          opt.textContent = sport.name;
          sportEl.appendChild(opt);
        }
        const preferred = prefs.sport && sports.some((s) => s.id === prefs.sport) ? prefs.sport : sports[0]?.id;
        if (preferred) sportEl.value = preferred;
        bodyEl.replaceChildren(
          p('empty', 'Pick a date and click Load grid. Requests go through this logged-in ActiveSG tab, a few venues at a time.')
        );
      } catch (err) {
        bodyEl.replaceChildren(p('error', humanError(err)));
      }
    }

    async function loadGrid() {
      const sport = sportEl.value;
      const date = dateEl.value;
      if (!sport || !date) return;
      savePrefs({ sport, date });
      refreshEl.disabled = true;
      refreshEl.textContent = 'Loading…';
      bodyEl.replaceChildren(p('empty', 'Fetching venues, then availability (max 3 at a time)…'));
      try {
        const data = await getAvailability(sport, date);
        renderGrid(data, sport, date);
        const time = new Date(data.generatedAt).toLocaleTimeString();
        updatedEl.textContent = `Updated ${time}${data.cached ? ' (cached)' : ''}`;
      } catch (err) {
        bodyEl.replaceChildren(p('error', humanError(err)));
      } finally {
        refreshEl.disabled = false;
        refreshEl.textContent = 'Load grid';
      }
    }

    function renderGrid(data, activityId, date) {
      const frag = document.createDocumentFragment();
      const times = Object.keys(data.grid).sort();

      if (data.errors.length) {
        frag.appendChild(
          p('warn', `Some venues failed to load: ${data.errors.map((e) => e.venue).join(', ')}`)
        );
      }

      if (times.length === 0) {
        frag.appendChild(p('empty', 'No available slots found for this sport and date — or the API shape could not be parsed.'));
        if (data.unparsed) {
          const details = document.createElement('details');
          details.open = true;
          const summary = document.createElement('summary');
          summary.textContent = 'Raw API sample (paste this back if the grid is empty)';
          const pre = document.createElement('pre');
          pre.textContent = JSON.stringify(data.unparsed, null, 2);
          details.append(summary, pre);
          frag.appendChild(details);
        }
        bodyEl.replaceChildren(frag);
        return;
      }

      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      headRow.appendChild(th('Time', 'time'));
      for (const venue of data.venues) headRow.appendChild(th(venue));
      thead.appendChild(headRow);
      const tbody = document.createElement('tbody');
      for (const time of times) {
        const tr = document.createElement('tr');
        tr.appendChild(td(time, 'time'));
        for (const venue of data.venues) {
          const cell = data.grid[time]?.[venue];
          const count = cell?.count ?? 0;
          const tdEl = td(count > 0 ? String(count) : '', count > 0 ? 'clickable' : '');
          tdEl.style.background = heatColor(count);
          tdEl.title = count > 0 ? 'Open ActiveSG booking for this venue' : 'No courts available';
          if (count > 0 && cell) {
            tdEl.addEventListener('click', () => {
              window.open(bookingUrl(activityId, cell.venueId, date), '_blank', 'noopener,noreferrer');
            });
          }
          tr.appendChild(tdEl);
        }
        tbody.appendChild(tr);
      }
      table.append(thead, tbody);
      frag.appendChild(table);
      bodyEl.replaceChildren(frag);
    }

    refreshEl.addEventListener('click', loadGrid);
    fillSports();
  }

  function th(text, className) {
    const n = document.createElement('th');
    if (className) n.className = className;
    n.textContent = text;
    return n;
  }

  function td(text, className) {
    const n = document.createElement('td');
    if (className) n.className = className;
    n.textContent = text;
    return n;
  }

  function p(className, text) {
    const n = document.createElement('p');
    n.className = className;
    n.textContent = text;
    return n;
  }

  function humanError(err) {
    if (isAuthError(err)) return 'ActiveSG says you are not logged in. Sign in on this tab, then click Load grid.';
    return err.message || String(err);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})();
