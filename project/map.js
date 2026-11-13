/**
 * Full-tab Singapore map of ActiveSG venues. Data comes from the signed-in
 * ActiveSG tab (inject.js answers asg:map:* messages); this page only draws.
 * Read-only: "Open in ActiveSG" opens ActiveSG's own booking page.
 */
(function () {
  'use strict';

  const TILE = 256;
  const MIN_ZOOM = 11;
  const MAX_ZOOM = 19;
  const BOUNDS = { minLat: 1.13, maxLat: 1.49, minLng: 103.57, maxLng: 104.13 };
  const SG_OVERVIEW = [
    { lat: 1.24, lng: 103.62 },
    { lat: 1.47, lng: 104.03 },
  ];
  const GEO_CACHE_KEY = 'asg-geo-v1';
  const GEO_MISS_RETRY_MS = 24 * 60 * 60 * 1000;
  const GEO_GAP_MS = 220;
  const ONEMAP_SEARCH = 'https://www.onemap.gov.sg/api/common/elastic/search';
  const COLORS = { venue: '#1d4ed8', slots: '#16a34a', ballot: '#7c3aed', muted: '#9ca3af' };
  const NAME_STOP_WORDS = new Set(['the', 'and', 'hall', 'halls', 'sports', 'sport', 'court', 'courts', 'indoor', 'outdoor', 'multi', 'purpose', 'singapore']);

  const params = new URLSearchParams(location.search);
  let tabId = params.get('tab') ? Number(params.get('tab')) : null;

  const $ = (id) => document.getElementById(id);
  const els = {
    sport: $('sport'),
    modeButtons: [...document.querySelectorAll('.modes button')],
    showAll: $('show-all'),
    showAllWrap: $('show-all-wrap'),
    dates: $('dates'),
    status: $('status'),
    actions: $('actions'),
    list: $('list'),
    map: $('map'),
    tiles: $('tiles'),
    markers: $('markers'),
    popup: $('popup'),
    legend: $('legend'),
  };

  const state = {
    sports: [],
    days: [],
    sport: null,
    date: null,
    mode: ['venues', 'instant', 'ballot'].includes(params.get('mode')) ? params.get('mode') : 'venues',
    venues: [],
    instant: null,
    ballot: null,
    selectedId: null,
    showAll: false,
    loading: null,
    error: null,
  };

  const venuesBySport = new Map();
  const instantByKey = new Map();
  const ballotBySport = new Map();
  const coords = new Map();
  const geoFailed = new Set();
  const geoQueue = [];
  const geoQueued = new Set();
  let geoRunning = false;
  let sportToken = 0;
  let modeToken = 0;

  // ---------- helpers ----------

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function inSingapore(lat, lng) {
    return lat > BOUNDS.minLat && lat < BOUNDS.maxLat && lng > BOUNDS.minLng && lng < BOUNDS.maxLng;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function dateLabel(iso) {
    const d = new Date(`${iso}T12:00:00+08:00`);
    return {
      dow: d.toLocaleDateString('en-SG', { weekday: 'short', timeZone: 'Asia/Singapore' }),
      rest: d.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', timeZone: 'Asia/Singapore' }),
    };
  }

  function sportName() {
    return state.sports.find((s) => s.id === state.sport)?.name || 'this sport';
  }

  // ---------- talking to the ActiveSG tab ----------

  function isMissingReceiver(err) {
    return /receiving end does not exist|could not establish connection|no tab with id/i.test(String(err?.message || err));
  }

  async function sendTo(id, message) {
    const res = await chrome.tabs.sendMessage(id, message);
    if (!res) throw new Error('The ActiveSG tab did not answer. Refresh that tab, then click Retry.');
    if (!res.ok) {
      const err = new Error(res.error || 'ActiveSG request failed.');
      err.auth = res.auth;
      throw err;
    }
    return res.data;
  }

  async function ask(type, payload) {
    const message = { type, ...payload };
    if (tabId != null) {
      try {
        return await sendTo(tabId, message);
      } catch (err) {
        if (!isMissingReceiver(err)) throw err;
      }
    }
    const tabs = await chrome.tabs.query({ url: 'https://activesg.gov.sg/*' });
    for (const tab of tabs) {
      if (tab.id === tabId) continue;
      try {
        const data = await sendTo(tab.id, message);
        tabId = tab.id;
        return data;
      } catch (err) {
        if (!isMissingReceiver(err)) throw err;
      }
    }
    const err = new Error(
      "Couldn't reach an ActiveSG tab. Open or refresh activesg.gov.sg (sign in if asked), then click Retry."
    );
    err.noTab = true;
    throw err;
  }

  async function openBooking(venue) {
    try {
      const url = await ask('asg:map:url', { activityId: state.sport, venueId: venue.id, date: state.date });
      chrome.tabs.create({ url });
    } catch (err) {
      showError(err, null);
    }
  }

  // ---------- geocoding (OneMap) ----------

  function readGeoCache() {
    try {
      return JSON.parse(localStorage.getItem(GEO_CACHE_KEY) || '{}');
    } catch {
      return {};
    }
  }

  const geoCache = readGeoCache();

  function saveGeoCache() {
    try {
      localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(geoCache));
    } catch {
      /* storage full: geocoding still works for this session */
    }
  }

  function nameTokens(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !NAME_STOP_WORDS.has(t));
  }

  function geocodeAttempts(venue) {
    const attempts = [];
    const seen = new Set();
    function add(q, source, strict) {
      const query = String(q || '').replace(/\s+/g, ' ').trim();
      if (query.length < 3 || seen.has(query.toLowerCase())) return;
      seen.add(query.toLowerCase());
      attempts.push({ query, source, strict });
    }
    if (venue.postal) add(venue.postal, 'postal', false);
    if (venue.address) add(venue.address, 'address', false);
    const base = String(venue.name).replace(/\(.*?\)/g, ' ');
    add(base, 'name', true);
    const expanded = base
      .replace(/\bPri\b\.?/gi, 'Primary')
      .replace(/\bSec\b\.?/gi, 'Secondary')
      .replace(/\bSch\b\.?/gi, 'School');
    add(expanded, 'name', true);
    add(expanded.replace(/\b(multi[- ]?purpose\s+)?(indoor\s+)?(sports?\s+)?(hall|halls|courts?)\b/gi, ' '), 'guess', true);
    return attempts;
  }

  async function oneMapSearch(query) {
    const url = `${ONEMAP_SEARCH}?searchVal=${encodeURIComponent(query)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url);
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        return Array.isArray(body.results) ? body.results : [];
      } catch {
        await sleep(800 * (attempt + 1));
      }
    }
    return [];
  }

  function pickResult(results, venueName, strict) {
    const wanted = nameTokens(venueName);
    let best = null;
    let bestScore = -1;
    for (const r of results) {
      const lat = Number(r.LATITUDE);
      const lng = Number(r.LONGITUDE);
      if (!inSingapore(lat, lng)) continue;
      const hay = `${r.SEARCHVAL} ${r.BUILDING} ${r.ADDRESS}`.toLowerCase();
      const score = wanted.filter((t) => hay.includes(t)).length;
      if (score > bestScore) {
        bestScore = score;
        best = { lat, lng, label: r.ADDRESS || r.SEARCHVAL };
      }
    }
    if (!best) return null;
    if (strict && bestScore < 1) return null;
    return best;
  }

  async function geocodeVenue(venue) {
    for (const attempt of geocodeAttempts(venue)) {
      const results = await oneMapSearch(attempt.query);
      await sleep(GEO_GAP_MS);
      const hit = pickResult(results, venue.name, attempt.strict);
      if (hit) return { ...hit, source: attempt.source };
    }
    return null;
  }

  function enqueueGeocode(venues) {
    for (const venue of venues) {
      if (coords.has(venue.id) || geoQueued.has(venue.id) || geoFailed.has(venue.id)) continue;
      const cached = geoCache[venue.id];
      if (cached?.miss && Date.now() - cached.at < GEO_MISS_RETRY_MS) {
        geoFailed.add(venue.id);
        continue;
      }
      geoQueued.add(venue.id);
      geoQueue.push(venue);
    }
    runGeocodeQueue();
  }

  async function runGeocodeQueue() {
    if (geoRunning) return;
    geoRunning = true;
    while (geoQueue.length) {
      const venue = geoQueue.shift();
      let hit = null;
      try {
        hit = await geocodeVenue(venue);
      } catch {
        hit = null;
      }
      if (hit) {
        coords.set(venue.id, hit);
        geoCache[venue.id] = hit;
      } else {
        geoFailed.add(venue.id);
        geoCache[venue.id] = { miss: true, at: Date.now() };
      }
      saveGeoCache();
      geoQueued.delete(venue.id);
      scheduleRefresh();
    }
    geoRunning = false;
    refresh();
    if (!userMoved) fitToVisible();
  }

  function absorbKnownCoords(venues) {
    for (const venue of venues) {
      if (venue.lat != null && venue.lng != null && inSingapore(venue.lat, venue.lng)) {
        coords.set(venue.id, { lat: venue.lat, lng: venue.lng, label: venue.address, source: 'activesg' });
      } else if (!coords.has(venue.id) && geoCache[venue.id]?.lat != null) {
        coords.set(venue.id, geoCache[venue.id]);
      }
    }
  }

  // ---------- map engine ----------

  const view = { lat: 1.3521, lng: 103.8198, zoom: 12 };
  const tileImgs = new Map();
  const markerEls = new Map();
  let userMoved = false;
  let frame = 0;

  function project(lat, lng, zoom) {
    const size = TILE * 2 ** zoom;
    const sin = Math.sin((lat * Math.PI) / 180);
    return {
      x: ((lng + 180) / 360) * size,
      y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
    };
  }

  function unproject(x, y, zoom) {
    const size = TILE * 2 ** zoom;
    const n = Math.PI - (2 * Math.PI * y) / size;
    return {
      lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))),
      lng: (x / size) * 360 - 180,
    };
  }

  function clampView() {
    view.zoom = clamp(view.zoom, MIN_ZOOM, MAX_ZOOM);
    view.lat = clamp(view.lat, BOUNDS.minLat, BOUNDS.maxLat);
    view.lng = clamp(view.lng, BOUNDS.minLng, BOUNDS.maxLng);
  }

  function origin() {
    const W = els.map.clientWidth;
    const H = els.map.clientHeight;
    const c = project(view.lat, view.lng, view.zoom);
    return { x: c.x - W / 2, y: c.y - H / 2, W, H };
  }

  function tileUrl(z, x, y) {
    return `https://www.onemap.gov.sg/maps/tiles/Default/${z}/${x}/${y}.png`;
  }

  function fallbackTileUrl(z, x, y) {
    const sub = 'abcd'[(x + y) % 4];
    return `https://${sub}.basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`;
  }

  function scheduleDraw() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  }

  function draw() {
    const o = origin();
    const z = view.zoom;
    const n = 2 ** z;
    const want = new Set();
    const x0 = Math.floor(o.x / TILE);
    const x1 = Math.floor((o.x + o.W) / TILE);
    const y0 = Math.max(0, Math.floor(o.y / TILE));
    const y1 = Math.min(n - 1, Math.floor((o.y + o.H) / TILE));
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = `${z}/${x}/${y}`;
        want.add(key);
        let img = tileImgs.get(key);
        if (!img) {
          img = new Image();
          img.alt = '';
          img.decoding = 'async';
          img.addEventListener('error', () => {
            if (img.dataset.fallback) {
              img.style.visibility = 'hidden';
              return;
            }
            img.dataset.fallback = '1';
            img.src = fallbackTileUrl(z, x, y);
          });
          img.src = tileUrl(z, x, y);
          tileImgs.set(key, img);
          els.tiles.appendChild(img);
        }
        img.style.transform = `translate(${Math.round(x * TILE - o.x)}px, ${Math.round(y * TILE - o.y)}px)`;
      }
    }
    for (const [key, img] of tileImgs) {
      if (!want.has(key)) {
        img.remove();
        tileImgs.delete(key);
      }
    }

    for (const marker of markerEls.values()) {
      const p = project(marker.lat, marker.lng, z);
      marker.el.style.transform = `translate(${Math.round(p.x - o.x)}px, ${Math.round(p.y - o.y)}px)`;
    }

    const selected = state.selectedId && markerEls.get(state.selectedId);
    if (selected && !els.popup.hidden) {
      const p = project(selected.lat, selected.lng, z);
      els.popup.style.transform = `translate(${Math.round(p.x - o.x)}px, ${Math.round(p.y - o.y)}px) translate(-50%, calc(-100% - 18px))`;
    } else {
      els.popup.hidden = true;
    }

    els.map.classList.toggle('show-labels', z >= 14);
  }

  function zoomAround(nextZoom, clientX, clientY) {
    nextZoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    if (nextZoom === view.zoom) return;
    const rect = els.map.getBoundingClientRect();
    const o = origin();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const anchor = unproject(o.x + px, o.y + py, view.zoom);
    const p = project(anchor.lat, anchor.lng, nextZoom);
    const center = unproject(p.x - px + o.W / 2, p.y - py + o.H / 2, nextZoom);
    view.zoom = nextZoom;
    view.lat = center.lat;
    view.lng = center.lng;
    clampView();
    userMoved = true;
    scheduleDraw();
  }

  function zoomCenter(delta) {
    const rect = els.map.getBoundingClientRect();
    zoomAround(view.zoom + delta, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  function fitTo(points) {
    if (!points.length) points = SG_OVERVIEW;
    const W = Math.max(200, els.map.clientWidth - 80);
    const H = Math.max(200, els.map.clientHeight - 80);
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;
    for (const pt of points) {
      minLat = Math.min(minLat, pt.lat);
      maxLat = Math.max(maxLat, pt.lat);
      minLng = Math.min(minLng, pt.lng);
      maxLng = Math.max(maxLng, pt.lng);
    }
    let zoom = MIN_ZOOM;
    for (let z = 16; z >= MIN_ZOOM; z--) {
      const a = project(maxLat, minLng, z);
      const b = project(minLat, maxLng, z);
      if (b.x - a.x <= W && b.y - a.y <= H) {
        zoom = z;
        break;
      }
    }
    const ne = project(maxLat, maxLng, zoom);
    const sw = project(minLat, minLng, zoom);
    const center = unproject((ne.x + sw.x) / 2, (ne.y + sw.y) / 2, zoom);
    view.zoom = zoom;
    view.lat = center.lat;
    view.lng = center.lng;
    clampView();
    scheduleDraw();
  }

  function fitToVisible() {
    const primary = [];
    const all = [];
    for (const marker of markerEls.values()) {
      all.push(marker);
      if (!marker.el.classList.contains('muted')) primary.push(marker);
    }
    fitTo(primary.length ? primary : all);
  }

  function centerOn(lat, lng, minZoom) {
    view.zoom = Math.max(view.zoom, minZoom);
    view.lat = lat;
    view.lng = lng;
    clampView();
    userMoved = true;
    scheduleDraw();
  }

  function bindMapInteractions() {
    let drag = null;
    els.map.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (event.target.closest('.marker, .popup, .zoom, .legend, .attribution')) return;
      const c = project(view.lat, view.lng, view.zoom);
      drag = { id: event.pointerId, sx: event.clientX, sy: event.clientY, cx: c.x, cy: c.y, moved: false };
      els.map.setPointerCapture(event.pointerId);
    });
    els.map.addEventListener('pointermove', (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.sx;
      const dy = event.clientY - drag.sy;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      drag.moved = true;
      els.map.classList.add('dragging');
      const center = unproject(drag.cx - dx, drag.cy - dy, view.zoom);
      view.lat = center.lat;
      view.lng = center.lng;
      clampView();
      userMoved = true;
      scheduleDraw();
    });
    const endDrag = (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      if (!drag.moved) closePopup();
      els.map.releasePointerCapture(event.pointerId);
      els.map.classList.remove('dragging');
      drag = null;
    };
    els.map.addEventListener('pointerup', endDrag);
    els.map.addEventListener('pointercancel', endDrag);

    let wheelLockedUntil = 0;
    els.map.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const now = performance.now();
        if (now < wheelLockedUntil || event.deltaY === 0) return;
        wheelLockedUntil = now + 180;
        zoomAround(view.zoom + (event.deltaY < 0 ? 1 : -1), event.clientX, event.clientY);
      },
      { passive: false }
    );
    els.map.addEventListener('dblclick', (event) => {
      if (event.target.closest('.marker, .popup, .zoom, .legend, .attribution')) return;
      zoomAround(view.zoom + 1, event.clientX, event.clientY);
    });

    $('zoom-in').addEventListener('click', () => zoomCenter(1));
    $('zoom-out').addEventListener('click', () => zoomCenter(-1));
    $('zoom-fit').addEventListener('click', () => {
      userMoved = false;
      fitToVisible();
    });
    window.addEventListener('resize', scheduleDraw);
  }

  // ---------- what each venue looks like in the current mode ----------

  function modeData() {
    if (state.mode === 'instant') return state.instant;
    if (state.mode === 'ballot') return state.ballot;
    return true;
  }

  function venueStatus(venue) {
    if (state.mode === 'instant') {
      const slots = state.instant?.byVenue?.[venue.id] || [];
      return { primary: slots.length > 0, kind: slots.length ? 'slots' : 'muted', slots };
    }
    if (state.mode === 'ballot') {
      const ballot = state.ballot?.[venue.id] || null;
      return { primary: Boolean(ballot?.ballotable), kind: ballot?.ballotable ? 'ballot' : 'muted', ballot };
    }
    return { primary: true, kind: 'venue' };
  }

  function isShown(status) {
    if (!modeData()) return true;
    return status.primary || state.showAll;
  }

  function ballotText(ballot) {
    if (!ballot) return 'Ballot status unknown';
    const status = ballot.ballotStatus
      ? ballot.ballotStatus.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
      : 'Unknown';
    return ballot.ballotable ? `Ballot: ${status}` : `Ballot: ${status.toLowerCase()}`;
  }

  // ---------- rendering ----------

  function renderMarkers() {
    els.markers.replaceChildren();
    markerEls.clear();
    const ready = Boolean(modeData());
    const rows = state.venues
      .map((venue) => ({ venue, status: venueStatus(venue), pos: coords.get(venue.id) }))
      .filter((row) => row.pos && isShown(row.status))
      .sort((a, b) => Number(a.status.primary) - Number(b.status.primary));

    for (const { venue, status, pos } of rows) {
      const kind = ready ? status.kind : 'muted';
      const marker = el('div', `marker ${kind}${venue.id === state.selectedId ? ' selected' : ''}`);
      marker.title = venue.name;
      const dot = el('span', 'dot', kind === 'slots' ? String(status.slots.length) : null);
      marker.append(dot, el('span', 'label', venue.name));
      marker.addEventListener('click', (event) => {
        event.stopPropagation();
        selectVenue(venue.id, false);
      });
      els.markers.appendChild(marker);
      markerEls.set(venue.id, { el: marker, lat: pos.lat, lng: pos.lng });
    }
  }

  function listRows() {
    const rows = state.venues.map((venue) => ({ venue, status: venueStatus(venue) }));
    const byName = (a, b) => a.venue.name.localeCompare(b.venue.name);
    if (state.mode === 'venues' || !modeData()) return rows.sort(byName);
    const primary = rows.filter((row) => row.status.primary).sort(byName);
    if (!state.showAll) return primary;
    return primary.concat(rows.filter((row) => !row.status.primary).sort(byName));
  }

  function timeChips(venue, slots) {
    const wrap = el('div', 'chips');
    for (const slot of slots) {
      const chip = el('button', 'chip', slot.count > 1 ? `${slot.time} ×${slot.count}` : slot.time);
      chip.type = 'button';
      chip.title = 'Open this venue on ActiveSG';
      chip.addEventListener('click', (event) => {
        event.stopPropagation();
        openBooking(venue);
      });
      wrap.appendChild(chip);
    }
    return wrap;
  }

  function renderList() {
    const frag = document.createDocumentFragment();
    const ready = Boolean(modeData());
    for (const { venue, status } of listRows()) {
      const item = el('li', `item${venue.id === state.selectedId ? ' selected' : ''}`);
      item.dataset.id = venue.id;
      const name = el('div', 'name');
      const swatch = el('span', 'swatch');
      swatch.style.background = COLORS[ready ? status.kind : 'muted'];
      name.append(swatch, document.createTextNode(venue.name));
      item.appendChild(name);

      const pos = coords.get(venue.id);
      const address = venue.address || pos?.label;
      if (address) item.appendChild(el('div', 'detail', address));
      if (!pos) {
        item.appendChild(
          el('div', 'unplaced', geoFailed.has(venue.id) ? 'Location not found' : 'Finding location…')
        );
      }

      if (ready && state.mode === 'instant' && status.slots?.length) {
        item.appendChild(timeChips(venue, status.slots));
      } else if (ready && state.mode === 'ballot') {
        const parts = [ballotText(status.ballot)];
        if (status.ballot?.nextInstant) parts.push(`Next instant: ${status.ballot.nextInstant}`);
        item.appendChild(el('div', 'detail', parts.join(' · ')));
      }

      item.addEventListener('click', () => selectVenue(venue.id, true));
      frag.appendChild(item);
    }
    els.list.replaceChildren(frag);
  }

  function renderLegend() {
    const entries = [];
    if (state.mode === 'venues') entries.push(['venue', 'Venue']);
    if (state.mode === 'instant') {
      entries.push(['slots', 'Has Instant slots (number = open hours)']);
      if (state.showAll) entries.push(['muted', 'No Instant slots this day']);
    }
    if (state.mode === 'ballot') {
      entries.push(['ballot', 'Open for ballot']);
      if (state.showAll) entries.push(['muted', 'Not open for ballot']);
    }
    els.legend.replaceChildren(
      ...entries.map(([kind, text]) => {
        const row = el('span');
        const swatch = el('span', 'swatch');
        swatch.style.background = COLORS[kind];
        row.append(swatch, document.createTextNode(text));
        return row;
      })
    );
  }

  function statusText() {
    if (state.error) return state.error;
    if (state.loading) return state.loading;
    const total = state.venues.length;
    let main = `${total} ${sportName()} venues`;
    if (state.mode === 'instant' && state.instant) {
      const { dow, rest } = dateLabel(state.date);
      const count = state.venues.filter((v) => venueStatus(v).primary).length;
      main = state.instant.sourceFound
        ? `${dow} ${rest}: ${count} of ${total} venues have Instant slots`
        : `Couldn't read Instant times for ${sportName()}. Open the Availability panel on ActiveSG for details.`;
    } else if (state.mode === 'ballot' && state.ballot) {
      const count = state.venues.filter((v) => venueStatus(v).primary).length;
      main = `${count} of ${total} venues are open for ballot`;
    }
    const pending = state.venues.filter((v) => geoQueued.has(v.id)).length;
    const missing = state.venues.filter((v) => !coords.has(v.id) && geoFailed.has(v.id)).length;
    const extras = [];
    if (pending) extras.push(`placing ${pending} more on the map…`);
    if (missing) extras.push(`${missing} couldn't be located`);
    return extras.length ? `${main} · ${extras.join(' · ')}` : main;
  }

  function renderStatus() {
    els.status.textContent = statusText();
    els.status.classList.toggle('error', Boolean(state.error));
  }

  function renderModes() {
    for (const button of els.modeButtons) {
      const active = button.dataset.mode === state.mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    }
    els.dates.hidden = state.mode !== 'instant';
    els.showAllWrap.hidden = state.mode === 'venues';
  }

  function renderDates() {
    const frag = document.createDocumentFragment();
    for (const iso of state.days) {
      const { dow, rest } = dateLabel(iso);
      const card = el('button', `date-card${iso === state.date ? ' selected' : ''}`);
      card.type = 'button';
      card.append(el('span', 'dow', dow), el('span', 'rest', rest));
      card.addEventListener('click', () => setDate(iso));
      frag.appendChild(card);
    }
    els.dates.replaceChildren(frag);
  }

  function renderPopup() {
    const venue = state.venues.find((v) => v.id === state.selectedId);
    const pos = venue && coords.get(venue.id);
    if (!venue || !pos || !markerEls.has(venue.id)) {
      els.popup.hidden = true;
      return;
    }
    const status = venueStatus(venue);
    const close = el('button', 'close', '×');
    close.type = 'button';
    close.title = 'Close';
    close.addEventListener('click', closePopup);
    const parts = [close, el('h2', null, venue.name)];
    const address = venue.address || pos.label;
    if (address) parts.push(el('p', 'address', address));
    if (pos.source === 'guess') parts.push(el('p', 'approx', 'Approximate location (matched by name)'));

    if (state.mode === 'instant' && state.instant) {
      const { dow, rest } = dateLabel(state.date);
      if (status.slots.length) {
        parts.push(el('p', 'note', `Instant slots on ${dow} ${rest}:`), timeChips(venue, status.slots));
      } else {
        parts.push(el('p', 'note', `No Instant slots on ${dow} ${rest}.`));
      }
    } else if (state.mode === 'ballot' && state.ballot) {
      parts.push(el('p', 'note', ballotText(status.ballot)));
      if (status.ballot?.nextInstant) parts.push(el('p', 'note', `Next instant slot: ${status.ballot.nextInstant}`));
    }

    const open = el('button', 'open', 'Open in ActiveSG');
    open.type = 'button';
    open.style.marginTop = '8px';
    open.addEventListener('click', () => openBooking(venue));
    parts.push(open);

    els.popup.replaceChildren(...parts);
    els.popup.hidden = false;
  }

  function refresh() {
    renderMarkers();
    renderList();
    renderLegend();
    renderStatus();
    renderPopup();
    draw();
  }

  let refreshTimer = 0;
  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = 0;
      const hadMarkers = markerEls.size > 0;
      refresh();
      if (!hadMarkers && markerEls.size && !userMoved) fitToVisible();
    }, 300);
  }

  function selectVenue(id, fromList) {
    state.selectedId = id;
    refresh();
    const pos = coords.get(id);
    if (fromList && pos) centerOn(pos.lat, pos.lng, 15);
    if (!fromList) {
      els.list.querySelector(`.item[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  }

  function closePopup() {
    if (!state.selectedId) return;
    state.selectedId = null;
    refresh();
  }

  function showError(err, retry) {
    state.error = err?.message || String(err);
    state.loading = null;
    renderStatus();
    const buttons = [];
    if (retry) {
      const again = el('button', null, 'Retry');
      again.type = 'button';
      again.addEventListener('click', () => {
        state.error = null;
        els.actions.hidden = true;
        retry();
      });
      buttons.push(again);
    }
    if (err?.noTab || err?.auth) {
      const open = el('button', 'secondary', 'Open ActiveSG');
      open.type = 'button';
      open.addEventListener('click', () => chrome.tabs.create({ url: 'https://activesg.gov.sg/' }));
      buttons.push(open);
    }
    els.actions.replaceChildren(...buttons);
    els.actions.hidden = buttons.length === 0;
  }

  function clearError() {
    state.error = null;
    els.actions.hidden = true;
  }

  // ---------- loading ----------

  async function loadModeData() {
    const mySport = sportToken;
    const myMode = ++modeToken;
    const stale = () => mySport !== sportToken || myMode !== modeToken;
    try {
      if (state.mode === 'instant') {
        const key = `${state.sport}|${state.date}`;
        if (!instantByKey.has(key)) {
          const { dow, rest } = dateLabel(state.date);
          state.loading = `Loading Instant slots for ${dow} ${rest}… (the first load of a day takes a few seconds)`;
          renderStatus();
          const data = await ask('asg:map:instant', { activityId: state.sport, date: state.date });
          instantByKey.set(key, data);
          if (stale()) return;
        }
        if (stale()) return;
        state.instant = instantByKey.get(key);
      } else if (state.mode === 'ballot') {
        if (!ballotBySport.has(state.sport)) {
          state.loading = 'Checking which venues are open for ballot…';
          renderStatus();
          const sport = state.sport;
          const data = await ask('asg:map:ballot', { activityId: sport });
          ballotBySport.set(sport, data);
          if (stale()) return;
        }
        if (stale()) return;
        state.ballot = ballotBySport.get(state.sport);
      }
      state.loading = null;
      refresh();
      if (!userMoved) fitToVisible();
    } catch (err) {
      if (stale()) return;
      showError(err, loadModeData);
    }
  }

  async function loadSport() {
    const mySport = ++sportToken;
    clearError();
    state.venues = [];
    state.instant = null;
    state.ballot = null;
    state.selectedId = null;
    state.loading = `Loading ${sportName()} venues…`;
    refresh();
    try {
      let venues = venuesBySport.get(state.sport);
      if (!venues) {
        venues = await ask('asg:map:venues', { activityId: state.sport });
        venuesBySport.set(state.sport, venues);
      }
      if (mySport !== sportToken) return;
      state.venues = venues;
      absorbKnownCoords(venues);
      enqueueGeocode(venues);
      state.loading = null;
      userMoved = false;
      refresh();
      fitToVisible();
      await loadModeData();
    } catch (err) {
      if (mySport !== sportToken) return;
      showError(err, loadSport);
    }
  }

  function setMode(mode) {
    if (mode === state.mode) return;
    state.mode = mode;
    state.instant = instantByKey.get(`${state.sport}|${state.date}`) || null;
    state.ballot = ballotBySport.get(state.sport) || null;
    clearError();
    renderModes();
    userMoved = false;
    refresh();
    loadModeData();
  }

  function setDate(iso) {
    if (iso === state.date) return;
    state.date = iso;
    state.instant = instantByKey.get(`${state.sport}|${state.date}`) || null;
    clearError();
    renderDates();
    refresh();
    loadModeData();
  }

  function bindControls() {
    for (const button of els.modeButtons) {
      button.addEventListener('click', () => setMode(button.dataset.mode));
    }
    els.sport.addEventListener('change', () => {
      state.sport = els.sport.value;
      loadSport();
    });
    els.showAll.addEventListener('change', () => {
      state.showAll = els.showAll.checked;
      refresh();
    });
  }

  async function start() {
    clearError();
    state.loading = 'Connecting to your ActiveSG tab…';
    renderStatus();
    try {
      const init = await ask('asg:map:init');
      state.sports = init.sports || [];
      state.days = init.days || [];
      const wantedSport = params.get('sport') || init.prefs?.sport;
      state.sport = state.sports.some((s) => s.id === wantedSport) ? wantedSport : state.sports[0]?.id;
      const wantedDate = params.get('date') || init.prefs?.date;
      state.date = state.days.includes(wantedDate) ? wantedDate : state.days[0];
      els.sport.replaceChildren(
        ...state.sports.map((s) => {
          const opt = el('option', null, s.name);
          opt.value = s.id;
          return opt;
        })
      );
      els.sport.value = state.sport || '';
      els.sport.disabled = false;
      renderModes();
      renderDates();
      if (!state.sport) throw new Error('ActiveSG returned no sports.');
      await loadSport();
    } catch (err) {
      showError(err, start);
    }
  }

  bindMapInteractions();
  bindControls();
  renderModes();
  fitTo(SG_OVERVIEW);
  start();
})();
