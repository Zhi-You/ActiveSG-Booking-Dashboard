// ==UserScript==
// @name         ActiveSG Booking Dashboard
// @namespace    local.activesg.dashboard
// @version      2.6.1
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
  const FANOUT = 10;
  const BATCH_SIZE = 16;
  const CACHE_TTL_MS = 30 * 60 * 1000;
  const STORAGE_KEY = 'asg-dash-prefs';
  const SLOT_CACHE_KEY = 'asg-dash-slot-cache-v8';
  const DASH_HEADER = { Accept: 'application/json', 'x-asg-dash': '1' };
  const MIN_PANEL_WIDTH = 320;

  const ACTIVITY_LIST_PROBES = [
    ['activity.list', {}],
    ['activity.listAll', {}],
    ['activity.getAll', {}],
    ['activity.listForBooking', {}],
    ['activity.search', { query: '' }],
    ['activity.search', { search: '' }],
  ];

  const SLOT_PROCEDURES = [
    'schedule.getAvailabilitySummary',
    'schedule.getTimeslots',
    'schedule.getAvailableTimeslots',
    'schedule.listTimeslots',
    'schedule.getInstantTimeslots',
    'schedule.getInstantAvailability',
    'schedule.getAvailability',
    'schedule.getSlots',
    'schedule.listSlots',
    'schedule.getByDate',
    'timeslot.list',
    'timeslot.getAvailable',
    'booking.getTimeslots',
    'booking.getAvailableTimeslots',
    'booking.getAvailability',
  ];

  const venueCache = new Map();
  const dayCache = new Map();
  const slotSourceByActivity = new Map();
  const discoveredProcs = new Set();
  const officialCalls = [];
  let lastDebug = null;

  window.addEventListener('asg-trpc', (event) => {
    const detail = event.detail || {};
    const url = detail.url || '';
    const match = String(url).match(/\/api\/trpc\/([^?]+)/);
    const procs = match ? match[1].split(',').filter(Boolean) : [];
    for (const proc of procs) discoveredProcs.add(proc);
    const inputs = Array.isArray(detail.inputs) ? detail.inputs : [];
    inputs.forEach((input, i) => {
      const procedure = procs[i] || procs[0];
      if (!procedure || !input || typeof input !== 'object') return;
      officialCalls.push({ procedure, input });
      if (officialCalls.length > 80) officialCalls.shift();
    });
  });

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

  function dayKey(activityId, date) {
    return `${activityId}:${date}`;
  }

  function readPersistedDays() {
    try {
      return JSON.parse(sessionStorage.getItem(SLOT_CACHE_KEY) || '{}');
    } catch {
      return {};
    }
  }

  function writePersistedDays(store) {
    try {
      sessionStorage.setItem(SLOT_CACHE_KEY, JSON.stringify(store));
    } catch {
      /* quota — in-memory cache still works */
    }
  }

  function getCachedDay(activityId, date) {
    const key = dayKey(activityId, date);
    const mem = dayCache.get(key);
    if (mem && Date.now() < mem.expiresAt && mem.value?.date === date) return mem.value;
    const persisted = readPersistedDays()[key];
    if (persisted && Date.now() < persisted.expiresAt && persisted.value?.date === date) {
      dayCache.set(key, persisted);
      return persisted.value;
    }
    return null;
  }

  function putCachedDay(activityId, date, value, expiresAt) {
    const key = dayKey(activityId, date);
    const entry = { value, expiresAt };
    dayCache.set(key, entry);
    const store = readPersistedDays();
    store[key] = entry;
    writePersistedDays(store);
  }

  function clearCachedDay(activityId, date) {
    const key = dayKey(activityId, date);
    dayCache.delete(key);
    const store = readPersistedDays();
    delete store[key];
    writePersistedDays(store);
    slotSourceByActivity.delete(activityId);
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
      headers: DASH_HEADER,
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

  async function trpcBatch(procedure, jsonInputs) {
    if (jsonInputs.length === 1) return [await trpcGet(procedure, jsonInputs[0])];
    const path = jsonInputs.map(() => procedure).join(',');
    const input = {};
    jsonInputs.forEach((json, i) => {
      input[i] = { json };
    });
    const url = `${ORIGIN}/api/trpc/${path}?batch=1&input=${encodeURIComponent(JSON.stringify(input))}`;
    const res = await fetch(url, {
      credentials: 'include',
      headers: DASH_HEADER,
    });
    const text = await res.text();
    if (text.trimStart().startsWith('<')) {
      throw new Error('ActiveSG returned a security check page. Reload this tab, finish the check, and log in if asked.');
    }
    const body = JSON.parse(text);
    const rows = Array.isArray(body)
      ? body
      : Object.keys(body)
          .sort((a, b) => Number(a) - Number(b))
          .map((k) => body[k]);
    if (!res.ok) throw new Error(`ActiveSG ${procedure} batch failed (HTTP ${res.status})`);
    return rows.map((row) => unwrapTrpc(row));
  }

  function asArray(value) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object') return [];
    if (Array.isArray(value.pages)) {
      return value.pages.flatMap((page) => asArray(page));
    }
    for (const key of ['items', 'results', 'activities', 'venues', 'data', 'records', 'list', 'nodes']) {
      if (Array.isArray(value[key])) return value[key];
    }
    const nested = Object.values(value).find((v) => Array.isArray(v) && v !== value.pages);
    return nested || [];
  }

  function pageMeta(data) {
    const items = asArray(data);
    return {
      items,
      nextCursor: data?.nextCursor ?? data?.next_cursor ?? data?.endCursor ?? data?.nextPageCursor,
      hasNextPage: data?.hasNextPage ?? data?.hasMore ?? data?.has_more,
      total: data?.total ?? data?.totalCount ?? data?.total_count ?? data?.itemCount,
    };
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
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
      if (/T|\d{2}:\d{2}|GMT|Z|\+\d{2}/.test(value)) {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) return formatDateSgt(parsed);
      }
      const iso = value.match(/\d{4}-\d{2}-\d{2}/);
      if (iso) return iso[0];
      return null;
    }
    if (typeof value === 'number') {
      const d = new Date(value > 1e12 ? value : value * 1000);
      if (!Number.isNaN(d.getTime())) return formatDateSgt(d);
    }
    if (value instanceof Date) return formatDateSgt(value);
    if (typeof value === 'object') {
      return asDateKey(pick(value, ['date', 'startDate', 'startsAt', 'slotDate']));
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

  function isDateOnlyValue(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
  }

  function formatHmIfTime(value) {
    if (isDateOnlyValue(value)) return null;
    return formatHm(value);
  }

  function timeLabelFrom(node) {
    const start = formatHmIfTime(
      pick(node, ['startTime', 'start', 'timeFrom', 'time_from', 'from', 'begin', 'startAt', 'startsAt', 'time'])
    );
    const end = formatHmIfTime(pick(node, ['endTime', 'end', 'timeTo', 'time_to', 'to', 'finish', 'endAt', 'endsAt']));
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
    if (!node || typeof node !== 'object') return false;
    const status = String(pick(node, ['status', 'availability', 'state', 'bookingStatus']) || '').toUpperCase();
    if (
      ['UNAVAILABLE', 'FULL', 'BOOKED', 'CLOSED', 'NONE', 'SOLD_OUT', 'OCCUPIED', 'DISABLED', 'NOT_AVAILABLE'].includes(
        status
      )
    ) {
      return true;
    }
    if (node.isAvailable === false || node.available === false || node.bookable === false) return true;
    if (node.isBookable === false || node.instantAvailable === false || node.isInstantAvailable === false) return true;
    if (node.is_available === 'N' || node.isAvailable === 'N') return true;
    if (node.booked === true || node.isFull === true || node.isClosed === true) return true;
    const count = numericCount(node);
    if (count === 0) return true;
    return false;
  }

  function hasAvailabilityFlag(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    return (
      node.isAvailable != null ||
      node.available != null ||
      node.bookable != null ||
      node.isBookable != null ||
      node.instantAvailable != null ||
      node.isInstantAvailable != null ||
      node.is_available != null ||
      node.availableCount != null ||
      node.availableSlots != null ||
      node.vacancy != null ||
      node.remaining != null ||
      node.remainingSlots != null ||
      node.slotsAvailable != null ||
      node.freeCount != null
    );
  }

  function isBallotNode(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    if (node.isBallot === true || node.ballot === true || node.isInstant === false) return true;
    if (node.isInstant === true || node.instant === true) return false;
    for (const key of ['type', 'slotType', 'bookingType', 'kind', 'mode', 'sessionType', 'availabilityType', 'category']) {
      const value = String(node[key] || '').toLowerCase();
      if (value.includes('ballot')) return true;
    }
    return false;
  }

  function isInstantSlot(node, requireFlag) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    if (isBallotNode(node) || isExplicitlyUnavailable(node)) return false;
    if (node.isAvailable === true || node.available === true || node.bookable === true) return true;
    if (node.isBookable === true || node.instantAvailable === true || node.isInstantAvailable === true) return true;
    if (node.is_available === 'Y' || node.isAvailable === 'Y') return true;
    const count = numericCount(node);
    if (count != null) return count > 0;
    const status = String(pick(node, ['status', 'availability', 'state']) || '').toUpperCase();
    if (['AVAILABLE', 'OPEN', 'VACANT', 'FREE', 'INSTANT'].includes(status)) return true;
    if (requireFlag) return false;
    return Boolean(timeLabelFrom(node));
  }

  function slotCount(node) {
    const n = numericCount(node);
    if (n != null) return n;
    return 1;
  }

  function dateFromNode(node) {
    if (!node || typeof node !== 'object') return null;
    const direct = asDateKey(node);
    if (direct) return direct;
    return asDateKey(
      pick(node, ['startTime', 'start', 'startsAt', 'startAt', 'timeFrom', 'datetime', 'startDate', 'slotDate'])
    );
  }

  function slotDateOf(node, inheritedDate, assumeDate) {
    const own = dateFromNode(node);
    if (own) return { date: own, fromAssume: false };
    if (inheritedDate) return { date: inheritedDate, fromAssume: false };
    if (assumeDate) return { date: assumeDate, fromAssume: true };
    return { date: null, fromAssume: false };
  }

  const NESTED_SLOT_KEYS = [
    'slots',
    'timeslots',
    'timeSlots',
    'sessions',
    'resources',
    'courts',
    'facilities',
    'items',
    'dates',
    'days',
    'instantSlots',
    'instant',
    'times',
    'hours',
    'availability',
    'schedule',
    'windows',
    'periods',
    'bookableSlots',
    'availableSlots',
    'instantAvailability',
  ];

  function payloadRequiresAvailabilityFlag(data) {
    let found = false;
    const seen = new Set();
    function walk(node) {
      if (found || node == null || seen.has(node)) return;
      if (typeof node !== 'object') return;
      seen.add(node);
      if (hasAvailabilityFlag(node)) {
        found = true;
        return;
      }
      if (Array.isArray(node)) {
        node.slice(0, 40).forEach(walk);
        return;
      }
      for (const value of Object.values(node).slice(0, 40)) walk(value);
    }
    walk(data);
    return found;
  }

  function extractAllInstantSlots(data, assumeDate) {
    const found = [];
    const requireFlag = payloadRequiresAvailabilityFlag(data);

    function pushSlot(slotDate, label, count, fromAssume) {
      if (!slotDate || !label || !count) return;
      found.push({ date: slotDate, label, count, fromAssume: Boolean(fromAssume) });
    }

    function visit(node, inheritedDate, inheritedBallot) {
      if (node == null) return;
      if (typeof node === 'string') {
        if (looksLikeTimeLabel(node) && !requireFlag) {
          const resolved = slotDateOf({}, inheritedDate, assumeDate);
          pushSlot(resolved.date, formatHm(node) || node, 1, resolved.fromAssume);
        }
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((child) => visit(child, inheritedDate, inheritedBallot));
        return;
      }
      if (typeof node !== 'object') return;

      const ballot = inheritedBallot || isBallotNode(node);
      const ownDate = dateFromNode(node) || inheritedDate;
      const hasNested = NESTED_SLOT_KEYS.some((key) => node[key] != null && typeof node[key] === 'object');

      const label = timeLabelFrom(node);
      if (label && !ballot && isInstantSlot(node, requireFlag) && !hasNested) {
        const resolved = slotDateOf(node, inheritedDate, assumeDate);
        pushSlot(resolved.date, label, slotCount(node), resolved.fromAssume);
      }

      if (node.instantSlots != null || node.instant != null) {
        visit(node.instantSlots ?? node.instant, ownDate, false);
      }

      let walked = false;
      for (const [key, value] of Object.entries(node)) {
        if (isBallotKey(key) || value == null) continue;
        const keyDate = asDateKey(key);
        if (keyDate && typeof value === 'object') {
          walked = true;
          visit(value, keyDate, ballot);
          continue;
        }
        const keyTime = formatHmIfTime(key);
        if (keyTime && !ballot) {
          walked = true;
          if (typeof value === 'number' || typeof value === 'boolean') {
            if (value) {
              const resolved = slotDateOf({}, ownDate, assumeDate);
              pushSlot(resolved.date, keyTime, typeof value === 'number' ? value : 1, resolved.fromAssume);
            }
          } else if (value && typeof value === 'object') {
            if (!timeLabelFrom(value) && isInstantSlot({ ...value, startTime: keyTime }, requireFlag)) {
              const resolved = slotDateOf(value, ownDate, assumeDate);
              pushSlot(resolved.date, keyTime, slotCount(value), resolved.fromAssume);
            }
            visit(value, ownDate, ballot);
          }
        }
      }

      for (const key of NESTED_SLOT_KEYS) {
        if (node[key] != null && !isBallotKey(key) && !asDateKey(key)) {
          visit(node[key], ownDate, ballot);
          walked = true;
        }
      }

      if (walked) {
        for (const [key, value] of Object.entries(node)) {
          if (isBallotKey(key) || asDateKey(key) || NESTED_SLOT_KEYS.includes(key) || formatHmIfTime(key)) continue;
          if (value && typeof value === 'object') visit(value, ownDate, ballot);
        }
        return;
      }

      for (const [key, value] of Object.entries(node)) {
        if (isBallotKey(key)) continue;
        if (value && typeof value === 'object') visit(value, ownDate, ballot);
      }
    }

    visit(data, null, isBallotNode(data));
    if (!assumeDate) return found.filter((slot) => !slot.fromAssume);
    const hasExplicit = found.some((slot) => !slot.fromAssume);
    if (hasExplicit) return found.filter((slot) => slot.date === assumeDate && !slot.fromAssume);
    return found.filter((slot) => slot.date === assumeDate);
  }

  function looksLikeTimeLabel(value) {
    return typeof value === 'string' && (/^\d{1,2}:\d{2}/.test(value) || /\d{1,2}\s*(am|pm)/i.test(value));
  }

  function mergeSlotsForDate(allSlots, date) {
    const merged = new Map();
    for (const slot of allSlots) {
      if (slot.date !== date) continue;
      const prev = merged.get(slot.label) || { label: slot.label, count: 0 };
      prev.count += slot.count;
      merged.set(slot.label, prev);
    }
    return [...merged.values()];
  }

  function isBallotKey(key) {
    return /ballot/i.test(String(key || ''));
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
    const cached = venueCache.get(activityId);
    if (cached && Date.now() < cached.expiresAt) return cached.venues;
    const byId = new Map();

    function absorb(data) {
      let added = 0;
      for (const raw of asArray(data)) {
        const venue = normalizeVenue(raw);
        if (venue && !byId.has(venue.id)) {
          byId.set(venue.id, venue);
          added += 1;
        }
      }
      return added;
    }

    const firstShapes = [
      [{ activityId, limit: 100, cursor: null }, null],
      [{ activityId, take: 100 }, null],
      [{ activityId }, null],
      [{ activityId, postalCode: null }, { values: { postalCode: ['undefined'] } }],
    ];

    let firstData = null;
    let firstJson = { activityId };
    for (const [json, meta] of firstShapes) {
      try {
        const data = await trpcGet('venue.listByActivity', json, meta);
        absorb(data);
        const metaPage = pageMeta(data);
        if (!firstData || metaPage.nextCursor || metaPage.hasNextPage || asArray(data).length > asArray(firstData).length) {
          firstData = data;
          firstJson = json;
        }
      } catch (err) {
        if (isAuthError(err)) throw err;
      }
    }

    if (firstData) {
      let data = firstData;
      const seenCursors = new Set();
      for (let page = 0; page < 40; page++) {
        const meta = pageMeta(data);
        const reachedTotal = meta.total != null && byId.size >= Number(meta.total);
        const cursor = meta.nextCursor;
        const cursorKey = cursor != null && cursor !== '' ? String(cursor) : '';
        const cursorLooksNew = Boolean(cursorKey) && !seenCursors.has(cursorKey);
        const hasNext = meta.hasNextPage === true || cursorLooksNew;
        const fullPage = [8, 10, 12, 15, 20, 24, 25, 30, 50, 100].includes(meta.items.length);

        if (reachedTotal || meta.hasNextPage === false) break;
        if (!hasNext && !fullPage) break;
        if (cursorKey) seenCursors.add(cursorKey);

        const nextInputs = [];
        if (cursorLooksNew) {
          nextInputs.push({ ...firstJson, cursor, limit: firstJson.limit || 100 });
          nextInputs.push({ activityId, cursor, limit: 100 });
        }
        nextInputs.push({ activityId, page: page + 2, pageSize: 100, limit: 100 });
        nextInputs.push({ activityId, skip: byId.size, take: 100, offset: byId.size, limit: 100 });

        let nextData = null;
        let added = 0;
        for (const json of nextInputs) {
          try {
            nextData = await trpcGet('venue.listByActivity', json);
            added = absorb(nextData);
            if (asArray(nextData).length) break;
          } catch (err) {
            if (isAuthError(err)) throw err;
          }
        }
        if (!nextData || !asArray(nextData).length) break;
        if (added === 0 && !pageMeta(nextData).nextCursor) break;
        data = nextData;
      }
    }

    try {
      absorb(
        await trpcGet(
          'venue.listByActivity',
          { activityId, postalCode: null },
          { values: { postalCode: ['undefined'] } }
        )
      );
    } catch (err) {
      if (isAuthError(err)) throw err;
    }

    for (const venue of harvestVenuesFromPage()) {
      if (!byId.has(venue.id)) byId.set(venue.id, venue);
    }

    if (!byId.size) throw new Error('No venues returned for this sport.');
    const venues = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
    venueCache.set(activityId, { venues, expiresAt: Date.now() + CACHE_TTL_MS });
    return venues;
  }

  function harvestVenuesFromPage() {
    const seen = new Map();
    for (const a of document.querySelectorAll('a[href]')) {
      try {
        const href = new URL(a.href, location.origin);
        if (href.origin !== ORIGIN) continue;
        const id = href.searchParams.get('venueId') || href.searchParams.get('venue_id');
        const name = (a.textContent || '').trim();
        if (id && name && name.length < 80) seen.set(String(id), { id: String(id), name });
      } catch {
        /* ignore bad hrefs */
      }
    }
    return [...seen.values()];
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

  function clipJson(value, depth) {
    if (depth == null) depth = 0;
    if (value == null || typeof value !== 'object') return value;
    if (depth > 4) return '[…]';
    if (Array.isArray(value)) return value.slice(0, 8).map((item) => clipJson(item, depth + 1));
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 24)) {
      out[key] = clipJson(item, depth + 1);
    }
    return out;
  }

  function isUselessSlotProcedure(procedure) {
    return /limit|count|quota|capacity|pass\.|activity\.|venue\.list/i.test(procedure);
  }

  function inputHasDate(json) {
    if (!json || typeof json !== 'object') return false;
    return Object.entries(json).some(([key, value]) => {
      if (/date|start|end|from|to|day/i.test(key) && value != null && value !== '') return true;
      if (value && typeof value === 'object') return inputHasDate(value);
      return false;
    });
  }

  function inputHasVenue(json) {
    return Boolean(json && (json.venueId != null || json.venue_id != null));
  }

  function officialCallDigest() {
    const seen = new Set();
    const out = [];
    for (const call of officialCalls) {
      const key = `${call.procedure}:${Object.keys(call.input).sort().join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ procedure: call.procedure, inputKeys: Object.keys(call.input) });
    }
    return out;
  }

  function classifyPayload(data, date) {
    if (data == null) return { kind: 'empty', slots: [] };
    if (typeof data !== 'object') return { kind: 'scalar', slots: [], preview: data };
    const keys = Array.isArray(data) ? [] : Object.keys(data);
    const badgeish =
      !Array.isArray(data) &&
      ('ballotAvailability' in data || 'nextInstantTimeslot' in data) &&
      keys.length <= 8 &&
      data.slots == null &&
      data.timeslots == null &&
      data.timeSlots == null &&
      data.dates == null &&
      data.days == null &&
      !Array.isArray(data.availability);
    if (badgeish) return { kind: 'badge', slots: [], preview: clipJson(data) };
    if (Array.isArray(data) && data.length === 0) return { kind: 'empty-list', slots: [] };
    const slots = extractAllInstantSlots(data, date);
    const anyDated = extractAllInstantSlots(data, null);
    if (slots.length || anyDated.length) return { kind: 'slots', slots, preview: clipJson(data) };
    if (Array.isArray(data)) return { kind: 'empty-list', slots: [], preview: clipJson(data.slice(0, 4)) };
    return { kind: 'unknown', slots: [], preview: clipJson(data) };
  }

  function slotInputBuilders() {
    return [
      (venue, activityId, date) => ({ venueId: venue.id, activityId, date }),
      (venue, activityId, date) => ({ venueId: venue.id, activityId, startDate: date, endDate: date }),
      (venue, activityId, date) => ({
        venueId: venue.id,
        activityId,
        startTime: `${date}T00:00:00.000+08:00`,
        endTime: `${date}T23:59:59.999+08:00`,
      }),
      (venue, activityId, date) => ({
        venueId: venue.id,
        activityId,
        start: `${date}T00:00:00.000+08:00`,
        end: `${addDaysIso(date, 1)}T00:00:00.000+08:00`,
      }),
    ];
  }

  function adaptOfficialInput(template, venue, activityId, date) {
    const json = JSON.parse(JSON.stringify(template));
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        const k = key.toLowerCase();
        if (k === 'venueid' || k === 'venue_id') node[key] = venue.id;
        else if (k === 'activityid' || k === 'activity_id') node[key] = activityId;
        else if (
          typeof value === 'string' &&
          /\d{4}-\d{2}-\d{2}/.test(value) &&
          /date|start|end|from|to|day/i.test(key)
        ) {
          node[key] = value.replace(/\d{4}-\d{2}-\d{2}/, date);
        } else if (value && typeof value === 'object') walk(value);
      }
    }
    walk(json);
    if (json.activityId == null) json.activityId = activityId;
    if (inputHasVenue(template)) json.venueId = venue.id;
    return json;
  }

  async function trySlotCall(procedure, json, date) {
    const data = await trpcGet(procedure, json);
    return { data, ...classifyPayload(data, date) };
  }

  function noteProbe(debug, row) {
    debug.probes.push(row);
    if (debug.probes.length > 48) debug.probes.splice(0, debug.probes.length - 48);
  }

  async function findSlotSource(venues, activityId, date, debug) {
    const cached = slotSourceByActivity.get(activityId);
    if (cached) return cached;

    const probeVenues = venues.slice(0, 3);
    const official = [];
    const seenOfficial = new Set();
    for (let i = officialCalls.length - 1; i >= 0; i--) {
      const call = officialCalls[i];
      if (isUselessSlotProcedure(call.procedure)) continue;
      if (call.procedure.includes('Summary') && !inputHasDate(call.input)) continue;
      if (!inputHasDate(call.input) && !/timeslot|getSlots|listSlots/i.test(call.procedure)) continue;
      const key = `${call.procedure}:${Object.keys(call.input).sort().join(',')}`;
      if (seenOfficial.has(key)) continue;
      seenOfficial.add(key);
      official.push(call);
      if (official.length >= 8) break;
    }
    debug.officialSlotCandidates = official.map((call) => ({
      procedure: call.procedure,
      inputKeys: Object.keys(call.input),
    }));

    function rememberSource(source, venue, result) {
      debug.chosen = {
        procedure: source.procedure,
        venue: venue.name,
        kind: result.kind,
        slotCount: result.slots.length,
      };
      if (debug.samples.length < 3) {
        debug.samples.push({
          venue: venue.name,
          procedure: source.procedure,
          kind: result.kind,
          data: result.preview != null ? result.preview : clipJson(result.data),
        });
      }
      slotSourceByActivity.set(activityId, source);
    }

    for (const call of official) {
      for (const venue of probeVenues) {
        try {
          const result = await trySlotCall(call.procedure, adaptOfficialInput(call.input, venue, activityId, date), date);
          noteProbe(debug, {
            procedure: call.procedure,
            venue: venue.name,
            kind: result.kind,
            slotCount: result.slots.length,
          });
          if (result.kind === 'slots') {
            const source = {
              procedure: call.procedure,
              buildInput: (v, a, d) => adaptOfficialInput(call.input, v, a, d),
            };
            rememberSource(source, venue, result);
            return source;
          }
        } catch (err) {
          if (isAuthError(err)) throw err;
          noteProbe(debug, { procedure: call.procedure, venue: venue.name, kind: 'error', error: err.message });
        }
      }
    }

    const procedures = [];
    const seenProc = new Set();
    for (const proc of [...discoveredProcs, ...SLOT_PROCEDURES]) {
      if (!proc || isUselessSlotProcedure(proc) || seenProc.has(proc)) continue;
      if (!/schedule\.|timeslot|slot|availability|booking\./i.test(proc)) continue;
      seenProc.add(proc);
      procedures.push(proc);
    }

    for (const buildInput of slotInputBuilders()) {
      const venue = probeVenues[0];
      const rows = await mapWithConcurrency(procedures, FANOUT, async (procedure) => {
        try {
          return { procedure, result: await trySlotCall(procedure, buildInput(venue, activityId, date), date) };
        } catch (err) {
          if (isAuthError(err)) throw err;
          return { procedure, result: { kind: 'error', slots: [], error: err.message } };
        }
      });
      for (const row of rows) {
        noteProbe(debug, {
          procedure: row.procedure,
          venue: venue.name,
          kind: row.result.kind,
          slotCount: row.result.slots.length,
          error: row.result.error,
        });
        if (row.result.kind === 'slots') {
          const source = { procedure: row.procedure, buildInput };
          rememberSource(source, venue, row.result);
          return source;
        }
      }
    }

    for (const venue of probeVenues.slice(1)) {
      const buildInput = slotInputBuilders()[0];
      const rows = await mapWithConcurrency(procedures, FANOUT, async (procedure) => {
        try {
          return { procedure, result: await trySlotCall(procedure, buildInput(venue, activityId, date), date) };
        } catch (err) {
          if (isAuthError(err)) throw err;
          return { procedure, result: { kind: 'error', slots: [], error: err.message } };
        }
      });
      for (const row of rows) {
        noteProbe(debug, {
          procedure: row.procedure,
          venue: venue.name,
          kind: row.result.kind,
          slotCount: row.result.slots.length,
          error: row.result.error,
        });
        if (row.result.kind === 'slots') {
          const source = { procedure: row.procedure, buildInput };
          rememberSource(source, venue, row.result);
          return source;
        }
      }
    }

    const badge = debug.probes.find((row) => row.kind === 'badge' || row.kind === 'scalar');
    if (badge && debug.samples.length === 0) debug.samples.push(badge);
    return null;
  }

  async function fetchSlotsForDate(venues, activityId, date, onProgress) {
    const debug = {
      venueCount: venues.length,
      officialCalls: officialCallDigest(),
      officialSlotCandidates: [],
      probes: [],
      samples: [],
      chosen: null,
    };
    lastDebug = debug;
    if (!venues.length) return [];

    const source = await findSlotSource(venues, activityId, date, debug);
    if (!source) return venues.map((venue) => ({ venue: venue.name, venueId: venue.id, slots: [], error: null }));

    const results = new Array(venues.length);
    for (let i = 0; i < venues.length; i += BATCH_SIZE) {
      const chunk = venues.slice(i, i + BATCH_SIZE);
      try {
        const payloads = await trpcBatch(
          source.procedure,
          chunk.map((venue) => source.buildInput(venue, activityId, date))
        );
        chunk.forEach((venue, j) => {
          const classified = classifyPayload(payloads[j], date);
          if (classified.kind === 'slots' && debug.samples.length < 2) {
            debug.samples.push({
              venue: venue.name,
              procedure: source.procedure,
              kind: classified.kind,
              data: classified.preview,
            });
          }
          results[i + j] = { venue: venue.name, venueId: venue.id, slots: classified.slots, error: null };
        });
      } catch (err) {
        if (isAuthError(err)) throw err;
        await mapWithConcurrency(chunk, FANOUT, async (venue, j) => {
          try {
            const data = await trpcGet(source.procedure, source.buildInput(venue, activityId, date));
            const classified = classifyPayload(data, date);
            results[i + j] = { venue: venue.name, venueId: venue.id, slots: classified.slots, error: null };
          } catch (inner) {
            results[i + j] = { venue: venue.name, venueId: venue.id, slots: [], error: inner.message };
          }
        });
      }
      onProgress?.(Math.min(i + chunk.length, venues.length), venues.length);
    }
    return results;
  }

  function gridFromVenues(perVenue, date) {
    const grid = {};
    for (const row of perVenue) {
      const slots = mergeSlotsForDate(row.slots, date).filter((slot) => slot.count > 0);
      if (!slots.length) continue;
      for (const slot of slots) {
        grid[slot.label] ??= {};
        grid[slot.label][row.venue] ??= { count: 0, venueId: row.venueId };
        grid[slot.label][row.venue].count += slot.count;
      }
    }
    return grid;
  }

  async function getAvailability(activityId, date, onProgress) {
    const cachedDay = getCachedDay(activityId, date);
    if (cachedDay) return cachedDay;

    lastDebug = null;
    const venues = await getVenues(activityId);
    const perVenue = await fetchSlotsForDate(venues, activityId, date, onProgress);
    const errors = perVenue.filter((v) => v.error).map((v) => ({ venue: v.venue, error: v.error }));
    const grid = gridFromVenues(perVenue, date);
    const generatedAt = new Date().toISOString();
    const value = {
      activityId,
      date,
      generatedAt,
      cached: false,
      venues: [],
      grid,
      errors,
      unparsed: Object.keys(grid).length === 0 ? lastDebug : null,
      venueCount: venues.length,
    };
    if (slotSourceByActivity.has(activityId) || Object.keys(grid).length) {
      putCachedDay(activityId, date, { ...value, cached: true }, Date.now() + CACHE_TTL_MS);
    }
    return value;
  }

  function addDaysIso(iso, days) {
    const date = new Date(`${iso}T12:00:00+08:00`);
    date.setDate(date.getDate() + days);
    return formatDateSgt(date);
  }

  function dateWindow() {
    const start = todayStr();
    return Array.from({ length: 15 }, (_, i) => addDaysIso(start, i));
  }

  function dateCardParts(iso) {
    const date = new Date(`${iso}T12:00:00+08:00`);
    return {
      dow: date.toLocaleDateString('en-SG', { weekday: 'short', timeZone: 'Asia/Singapore' }),
      rest: date.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', timeZone: 'Asia/Singapore' }),
    };
  }

  function displayTime(label) {
    const start = String(label).split(' - ')[0].trim();
    const hm = start.match(/(\d{1,2}):(\d{2})/);
    if (!hm) return label;
    let hour = Number(hm[1]);
    const minute = hm[2];
    const ampm = hour >= 12 ? 'pm' : 'am';
    hour = hour % 12 || 12;
    return `${hour}:${minute} ${ampm}`;
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

  const CSS = `
    :host { all: initial; }
    .wrap { font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #111; }
    .toggle {
      position: fixed; top: 88px; right: 0; z-index: 2147483646;
      border: 0; border-radius: 10px 0 0 10px; background: #111; color: #fff;
      padding: 10px 14px; font-size: 13px; font-weight: 600; cursor: pointer;
    }
    .panel {
      position: fixed; top: 0; right: 0; z-index: 2147483645;
      width: 560px; max-width: 92vw; min-width: 320px; height: 100vh; background: #fff;
      box-shadow: -12px 0 32px rgb(0 0 0 / 12%);
      display: flex; flex-direction: column; transform: translateX(100%);
      transition: transform 160ms ease;
    }
    .panel.open { transform: translateX(0); }
    .panel.dragging { transition: none; user-select: none; }
    .resizer {
      position: absolute; left: 0; top: 0; bottom: 0; width: 10px; cursor: ew-resize;
      z-index: 3;
    }
    .resizer::after {
      content: ''; position: absolute; left: 3px; top: 50%; transform: translateY(-50%);
      width: 3px; height: 48px; border-radius: 99px; background: #d4d4d4;
    }
    .chrome { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .top { padding: 20px 20px 0; }
    .instant {
      display: inline-flex; align-items: center; gap: 8px;
      background: #111; color: #fff; border-radius: 999px; padding: 8px 14px 8px 10px;
      font-weight: 700; font-size: 15px;
    }
    .instant svg { display: block; }
    .sport-row { margin: 16px 0 0; }
    .sport-row label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: #666; }
    select {
      appearance: none; background: #fff; border: 1px solid #e5e5e5; border-radius: 12px;
      padding: 10px 12px; font-size: 14px; color: #111;
    }
    .dates {
      display: flex; gap: 10px; overflow-x: auto; padding: 16px 20px 8px;
      scrollbar-width: thin;
    }
    .date-card {
      flex: 0 0 86px; height: 86px; border: 1px solid #e8e8e8; border-radius: 16px;
      background: #fff; cursor: pointer; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 4px; color: #111;
    }
    .date-card .dow { font-weight: 700; font-size: 16px; }
    .date-card .rest { font-size: 13px; color: #555; }
    .date-card.selected { border: 3px solid #111; background: #fafafa; }
    .hint { margin: 8px 20px 0; color: #6b6b6b; font-size: 14px; }
    .meta-row {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      margin: 4px 20px 0;
    }
    .meta { margin: 0; font-size: 12px; color: #999; }
    .refresh {
      flex: 0 0 auto; border: 1px solid #e8e8e8; border-radius: 999px; background: #fff;
      padding: 6px 12px; font-size: 12px; font-weight: 600; color: #111; cursor: pointer;
    }
    .refresh:hover { border-color: #111; }
    .refresh:disabled { color: #999; cursor: default; border-color: #eee; }
    .body { flex: 1; overflow: auto; padding: 16px 20px 24px; display: flex; flex-direction: column; gap: 12px; }
    .error { color: #b91c1c; font-size: 14px; margin: 0; }
    .warn { color: #92400e; font-size: 13px; margin: 0; }
    .empty { color: #6b6b6b; font-size: 14px; margin: 0; }
    .slot {
      border: 1px solid #e8e8e8; border-radius: 16px; padding: 14px 16px; background: #fff;
    }
    .slot-time {
      text-align: center; font-size: 18px; font-weight: 600; padding: 4px 0 12px; color: #111;
    }
    .venues { display: flex; flex-direction: column; gap: 8px; }
    .venue {
      border: 1px solid #e8e8e8; border-radius: 12px; background: #fff; cursor: pointer;
      padding: 10px 12px; display: flex; justify-content: space-between; align-items: center;
      font-size: 14px; color: #111; text-align: left; width: 100%;
    }
    .venue:hover { border-color: #111; }
    .venue .count { color: #666; font-size: 13px; }
    details { font-size: 12px; color: #555; }
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
    const resizer = document.createElement('div');
    resizer.className = 'resizer';
    resizer.title = 'Drag to resize';
    panel.appendChild(resizer);
    const chrome = document.createElement('div');
    chrome.className = 'chrome';
    chrome.innerHTML = `
      <div class="top">
        <div class="instant">
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="10" fill="none" stroke="white" stroke-width="1.8"/>
            <path d="M13 4.5L7.5 13h4.2L11 19.5 16.5 11h-4.2L13 4.5z" fill="white"/>
          </svg>
          Instant
        </div>
        <div class="sport-row">
          <label>Sport<select id="sport"></select></label>
        </div>
      </div>
      <div class="dates" id="dates"></div>
      <p class="hint">Each slot is 1 hour long. Instant booking only.</p>
      <div class="meta-row">
        <p class="meta" id="updated"></p>
        <button type="button" class="refresh" id="refresh" title="Clear cache and reload this day">Clear cache</button>
      </div>
      <div class="body" id="body"><p class="empty">Log into ActiveSG, then pick a day.</p></div>
    `;
    panel.appendChild(chrome);

    wrap.append(toggle, panel);
    shadow.append(style, wrap);
    document.documentElement.appendChild(host);

    const sportEl = panel.querySelector('#sport');
    const datesEl = panel.querySelector('#dates');
    const updatedEl = panel.querySelector('#updated');
    const refreshEl = panel.querySelector('#refresh');
    const bodyEl = panel.querySelector('#body');
    const prefs = loadPrefs();
    const days = dateWindow();
    let selectedDate = days.includes(prefs.date) ? prefs.date : days[0];
    let loading = false;
    let loadToken = 0;

    function applyWidth(px) {
      const max = Math.floor(window.innerWidth * 0.92);
      const width = Math.min(max, Math.max(MIN_PANEL_WIDTH, Math.round(px)));
      panel.style.width = `${width}px`;
      return width;
    }
    applyWidth(Number(prefs.width) || 560);

    resizer.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      panel.classList.add('dragging');
      resizer.setPointerCapture(event.pointerId);
      const onMove = (move) => {
        applyWidth(window.innerWidth - move.clientX);
      };
      const onUp = (up) => {
        resizer.releasePointerCapture(up.pointerId);
        resizer.removeEventListener('pointermove', onMove);
        resizer.removeEventListener('pointerup', onUp);
        panel.classList.remove('dragging');
        savePrefs({ width: panel.getBoundingClientRect().width });
      };
      resizer.addEventListener('pointermove', onMove);
      resizer.addEventListener('pointerup', onUp);
    });

    function renderDateCards() {
      datesEl.replaceChildren();
      for (const iso of days) {
        const parts = dateCardParts(iso);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'date-card' + (iso === selectedDate ? ' selected' : '');
        const dow = document.createElement('span');
        dow.className = 'dow';
        dow.textContent = parts.dow;
        const rest = document.createElement('span');
        rest.className = 'rest';
        rest.textContent = parts.rest;
        btn.append(dow, rest);
        btn.addEventListener('click', () => {
          selectedDate = iso;
          savePrefs({ date: iso });
          renderDateCards();
          loadDay();
        });
        datesEl.appendChild(btn);
      }
    }

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
        renderDateCards();
        await loadDay();
      } catch (err) {
        renderDateCards();
        bodyEl.replaceChildren(p('error', humanError(err)));
      }
    }

    async function loadDay(force) {
      const sport = sportEl.value;
      if (!sport || !selectedDate) return;
      savePrefs({ sport, date: selectedDate });
      if (force) clearCachedDay(sport, selectedDate);
      const token = ++loadToken;
      loading = true;
      refreshEl.disabled = true;
      const already = !force && getCachedDay(sport, selectedDate);
      if (!already) bodyEl.replaceChildren(p('empty', 'Finding instant slots…'));
      try {
        const data = await getAvailability(sport, selectedDate, (done, total) => {
          if (token !== loadToken || already) return;
          bodyEl.replaceChildren(p('empty', `Loading venues ${done} of ${total}…`));
        });
        if (token !== loadToken) return;
        renderSlots(data, sport, selectedDate);
        const time = new Date(data.generatedAt).toLocaleTimeString();
        const suffix = data.cached ? ' (cached)' : '';
        const venues = data.venueCount ? ` · ${data.venueCount} venues` : '';
        updatedEl.textContent = `Updated ${time}${suffix}${venues}`;
      } catch (err) {
        if (token !== loadToken) return;
        bodyEl.replaceChildren(p('error', humanError(err)));
      } finally {
        if (token === loadToken) {
          loading = false;
          refreshEl.disabled = false;
        }
      }
    }

    refreshEl.addEventListener('click', () => {
      if (loading) return;
      loadDay(true);
    });

    function renderSlots(data, activityId, date) {
      const frag = document.createDocumentFragment();
      const times = Object.keys(data.grid).sort();

      if (data.errors.length) {
        frag.appendChild(p('warn', `Some venues failed to load: ${data.errors.map((e) => e.venue).join(', ')}`));
      }

      if (times.length === 0) {
        frag.appendChild(
          p(
            'empty',
            slotSourceByActivity.has(activityId)
              ? 'No instant booking slots at any venue on this day.'
              : 'Could not find ActiveSG’s Instant times API. Open Instant booking, pick any venue and a date so times load, then click Clear cache.'
          )
        );
        if (data.unparsed) {
          const details = document.createElement('details');
          const summary = document.createElement('summary');
          summary.textContent = 'Debug (paste this back if times are still missing)';
          const pre = document.createElement('pre');
          pre.textContent = JSON.stringify(data.unparsed, null, 2);
          details.append(summary, pre);
          frag.appendChild(details);
        }
        bodyEl.replaceChildren(frag);
        return;
      }

      for (const time of times) {
        const venues = Object.entries(data.grid[time]).filter(([, cell]) => cell.count > 0);
        if (!venues.length) continue;
        const card = document.createElement('div');
        card.className = 'slot';
        const heading = document.createElement('div');
        heading.className = 'slot-time';
        heading.textContent = displayTime(time);
        const list = document.createElement('div');
        list.className = 'venues';
        for (const [venue, cell] of venues.sort((a, b) => a[0].localeCompare(b[0]))) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'venue';
          const name = document.createElement('span');
          name.textContent = venue;
          const count = document.createElement('span');
          count.className = 'count';
          count.textContent = cell.count === 1 ? '1 court' : `${cell.count} courts`;
          btn.append(name, count);
          btn.addEventListener('click', () => {
            window.open(bookingUrl(activityId, cell.venueId, date), '_blank', 'noopener,noreferrer');
          });
          list.appendChild(btn);
        }
        card.append(heading, list);
        frag.appendChild(card);
      }
      bodyEl.replaceChildren(frag);
    }

    sportEl.addEventListener('change', loadDay);
    fillSports();
  }

  function p(className, text) {
    const n = document.createElement('p');
    n.className = className;
    n.textContent = text;
    return n;
  }

  function humanError(err) {
    if (isAuthError(err)) return 'ActiveSG says you are not logged in. Sign in on this tab, then pick a day.';
    return err.message || String(err);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})();
