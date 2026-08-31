# ActiveSG Booking Dashboard

A personal, **read-only** dashboard for finding ActiveSG facility slots.

The official ActiveSG app makes you pick a sport, then a venue, then scroll through that one location's times. This dashboard flips that around: pick a sport and a date, and see **every venue at once** on a single time-slot × venue grid. When you find a slot you want, click it — the official ActiveSG booking page opens in a new tab.

This app never books, pays, or holds anything for you. It only solves discovery.

> **This is a local tool, not a hosted website.** It needs your ActiveSG login on a small server that runs on your machine. It cannot be published as a GitHub Page (see [Why not GitHub Pages?](#why-not-github-pages)).

---

## Using the dashboard

Once the server and client are running (see [Run it locally](#run-it-locally)), open the URL Vite prints — usually **http://localhost:5173**.

1. **Choose a sport** from the dropdown. The list comes from ActiveSG (badminton, tennis, etc.).
2. **Choose a date.** Today's date is selected by default.
3. Wait for the grid to load. Rows are time slots; columns are venues that offer that sport.

| What you see | What it means |
| --- | --- |
| Empty cell | No courts available at that venue for that time |
| Number | How many courts are free |
| Pale yellow | 1 court |
| Light green | 2–3 courts |
| Dark green | 4 or more |

4. **Click an available cell** to open ActiveSG's own booking page for that venue and date in a new tab. Complete the booking there as you normally would.
5. The grid **refreshes every 2 minutes** on its own. Use **Refresh now** if you want an immediate update. If the timestamp says `(cached)`, you're seeing a result the server already fetched recently — that's intentional, so the dashboard doesn't hammer ActiveSG.

If some venues fail to load, a warning lists them. The rest of the grid still works.

---

## Run it locally

You need **[Node.js 18+](https://nodejs.org/)** (the server uses built-in `fetch`).

You also need your own ActiveSG email and password. They stay in a local `.env` file and are never sent to the browser.

### 1. Server

```bash
cd server
npm install
cp .env.example .env
```

Open `server/.env` and fill in:

```
ACTIVESG_EMAIL=you@example.com
ACTIVESG_PASSWORD=your_password_here
```

Then start it:

```bash
npm start
```

The API listens on **http://localhost:4000** by default.

### 2. Client

In a second terminal:

```bash
cd client
npm install
npm run dev
```

Open the URL Vite prints (usually **http://localhost:5173**).

You only need `client/.env` if you changed the server port:

```bash
cp .env.example .env
# then set VITE_API_BASE to match
```

### First-time check

The ActiveSG URLs this project calls are **not an official public API** — they come from older community reverse-engineering, and they may have changed.

Before you rely on the grid, open the official ActiveSG site or app, search for a facility with a network inspector, and compare the request URLs and JSON against `server/src/activesgClient.js`. If something doesn't match, patch **that file only**.

---

## Why not GitHub Pages?

GitHub Pages only serves static files (HTML/CSS/JS). This project is two pieces:

- a **Node.js server** that logs into ActiveSG and fans out venue requests
- a **React page** that talks only to that local server

Your password and ActiveSG session token must stay on the server. Putting them in client-side code (the only way a GitHub Page could call ActiveSG) would expose them to anyone who opens the site.

Pushing the **source code** to GitHub is fine. Hosting a **live dashboard** on GitHub Pages is not. Keep running it on your own machine.

When you do push:

- `.env` is already in `.gitignore` — never commit it
- Do not publish this as a shared or public service

---

## Configuration

All settings are environment variables. Copy from `.env.example`; don't hardcode secrets.

| Variable | Where | Default | Purpose |
| --- | --- | --- | --- |
| `ACTIVESG_EMAIL` | `server/.env` | — | Your ActiveSG login |
| `ACTIVESG_PASSWORD` | `server/.env` | — | Your ActiveSG password |
| `PORT` | `server/.env` | `4000` | Local API port |
| `CACHE_TTL_MS` | `server/.env` | `120000` (2 min) | How long a sport+date result is reused |
| `FANOUT_CONCURRENCY` | `server/.env` | `6` | Max venues queried at once |
| `VITE_API_BASE` | `client/.env` | `http://localhost:4000` | Where the UI talks to the API |

Keep `CACHE_TTL_MS` and the client's refresh interval in the same ballpark. The client currently refreshes every 2 minutes to match the default cache. Don't drop these to a tight polling loop against ActiveSG.

---

## How it works (for developers)

```
You  →  React client  →  local Express API  →  ActiveSG
              │                  │
              │                  ├─ login once, keep the token
              │                  ├─ list venues for the sport
              │                  └─ fetch slots per venue (max 6 at a time)
              │
              └─ never calls ActiveSG APIs itself
                 (clicking a cell only opens ActiveSG's website)
```

1. The client calls `GET /api/sports`. The server asks ActiveSG for `facility/activity/all` and returns `{ id, name }[]`.
2. You pick a sport and date. The client calls `GET /api/availability?sport=&date=`.
3. The server loads venues for that sport, fans out one slots request per venue with bounded concurrency, and pivots the result into `{ [timeLabel]: { [venueName]: { count, venueId } } }`.
4. That result is cached in memory for `CACHE_TTL_MS`, keyed by `sport:date`.
5. The client draws the grid and polls on the same interval. An available cell builds a deep link to ActiveSG's official booking page.

Login, the session token, and the venue fan-out stay on the server. They must not move into the browser.

### Project layout

```
ActiveSGBookingDashboard/
  server/
    src/
      activesgClient.js   # the only file with raw ActiveSG URLs/fields
      aggregate.js        # fan-out + pivot into the time × venue grid
      cache.js            # in-memory TTL cache (no extra deps)
      server.js           # Express: /api/sports, /api/availability, /api/health
    .env.example
  client/
    src/
      api.ts              # typed fetch wrappers — components use this, not fetch
      App.tsx             # sport/date state and the refresh loop
      components/AvailabilityGrid.tsx
      App.css
    .env.example
```

### Conventions

**Server** — plain JavaScript ESM, no TypeScript, no build step. Use Node 18+ `fetch` (not axios / node-fetch). Config via `process.env` / `.env` only. A single venue failing during fan-out must not fail the whole request (catch per venue, report in `errors[]`). Keep concurrency bounded with `FANOUT_CONCURRENCY`; don't `Promise.all` the full venue list.

**Client** — function components and hooks only (no Redux/Zustand). All server traffic goes through `api.ts`. Styling is plain CSS in `App.css` — no Tailwind, CSS-in-JS, or UI kits.

If ActiveSG requests start failing, the fix belongs in `activesgClient.js`. Don't paper over an API-shape mismatch elsewhere.

---

## Known limitations

- **OCBC Arena badminton** uses a separate system (`bookings.sportshub.com.sg`). There is a stub fetch in `activesgClient.js`, but it is **not** wired into the grid — the JSON shape was never confirmed against a live response.
- Sports and venues are loaded live from ActiveSG, so any sport they offer should appear — *if* the unofficial endpoints are still current.
- The unofficial API this talks to (`members.myactivesg.com:8889/api/...`) was reverse-engineered years ago by community projects ([active-sg-badminton](https://github.com/terencelimzhengwei/active-sg-badminton), [davidheryanto/activesg](https://github.com/davidheryanto/activesg)). It was not verified against the live API while this dashboard was built. Treat a mismatch as an `activesgClient.js` problem.

---

## Usage boundaries

This is a **single-user, read-only personal tool**.

- Don't add automated or scripted booking, payments, multi-tenant support, or a public shared deployment.
- Don't move ActiveSG login or token handling into client-side code.
- Keep fan-out concurrency bounded and the cache TTL non-trivial.
- Never commit `.env` files.
