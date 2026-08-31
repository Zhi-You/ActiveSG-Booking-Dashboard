# ActiveSG Booking Dashboard

A personal, **read-only** overlay for [activesg.gov.sg](https://activesg.gov.sg).

The official site makes you pick a sport, then a venue, then one location's times. This flips that around: after **you** log into ActiveSG, a panel on the page shows **every venue at once** on a time-slot × venue grid. Clicking an available cell opens ActiveSG's own booking page. Nothing is booked for you.

This is a browser extension (or Tampermonkey script). It is not a website, and it cannot be hosted on GitHub Pages.

The previous Node.js + React app is kept under `Obsolete/` for reference. It cannot talk to today's ActiveSG stack (Singpass + Cloudflare). **Use `project/`.**

---

## Using the dashboard

1. Install from [`project/`](project/README.md) (Chrome/Edge unpacked extension, or Tampermonkey).
2. Open [https://activesg.gov.sg](https://activesg.gov.sg) and sign in with Singpass as you normally do.
3. Click **Availability** on the right.
4. Choose a sport and a date, then **Load grid**.

| What you see | What it means |
| --- | --- |
| Empty cell | No courts parsed as free at that venue for that time |
| Number | How many courts look free |
| Pale yellow / green | 1 court / 2+ courts |

5. Click a coloured cell to open ActiveSG's booking UI for that venue. Finish the booking there.

The grid loads when you ask for it. The same sport+date is cached for 2 minutes so repeat clicks are cheap. Venues are fetched a few at a time.

---

## Install

**Chrome or Edge**

1. Go to `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** → select the `project` folder.
4. Open ActiveSG and log in.

**Tampermonkey**

Paste `project/inject.js` as a new userscript (it already includes the header). Do not run the extension and the userscript at the same time.

Full notes: [`project/README.md`](project/README.md).

---

## How it works

You log in. The script runs in that tab and calls ActiveSG's own tRPC routes (`venue.listByActivity`, `schedule.getAvailabilitySummary`, …) with the cookies the page already has. There is no stored ActiveSG password and no booking API.

If the grid comes back empty, expand **Raw API sample** in the panel and use that JSON to adjust parsing in `project/inject.js`. Do not paper over a shape mismatch somewhere else.

---

## Limits

- Built for one person, on their own logged-in browser. Not a public service.
- Peak slots may be balloted; a simple “free courts” grid will not always apply.
- ActiveSG may change endpoints or JSON at any time.
- Never automate booking or payment. Never ship this as a shared multi-user deployment.
