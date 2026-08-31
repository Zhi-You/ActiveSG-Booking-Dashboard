# ActiveSG Booking Dashboard (browser)

A personal, **read-only** overlay on [activesg.gov.sg](https://activesg.gov.sg). You log into ActiveSG as usual. This then draws a **time × venue** grid for one sport and date, using the same APIs the official page already calls in your tab.

It never books, pays, or holds a slot. Clicking an available cell only opens ActiveSG's own booking page.

The old Node/React app could not reach ActiveSG (Cloudflare + Singpass). That code is in `Obsolete/`. This folder is the current implementation.

---

## Using the dashboard

1. Install the extension **or** the userscript (not both).
2. Open [https://activesg.gov.sg](https://activesg.gov.sg) and **log in with Singpass**.
3. Click **Availability** on the right edge of the page.
4. Pick a sport and a date, then **Load grid**.
5. Rows are time slots; columns are venues. A number is how many courts look free.
6. Click a coloured cell to jump to ActiveSG's booking UI for that venue. Complete the booking there.

The grid is loaded on demand (not a tight polling loop). Results for the same sport+date are reused for 2 minutes. Venues are queried a few at a time.

If the grid is empty but the official site has slots, expand **Raw API sample** and keep that JSON — the live response shape still needs a match in `inject.js`.

---

## Install — Chrome or Edge (recommended)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked** and choose this `project` folder (the one that contains `manifest.json`).
4. Visit `https://activesg.gov.sg` and log in.

To update after pulling new code: on the extensions page, click **Reload** on this extension, then refresh the ActiveSG tab.

Do not publish this to the Chrome Web Store as a public product. It is a personal tool.

---

## Install — Tampermonkey

Use this only if you are not loading the Chrome extension (running both duplicates the panel).

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Create a new script and paste the full contents of `inject.js` (it already has the userscript header).
3. Save, then open `https://activesg.gov.sg` and log in.

---

## How it works

The script runs **inside your already-logged-in ActiveSG tab**. Requests go to:

- `activity.list` (and a few fallbacks) / `activity.get` — sports
- `venue.listByActivity` — venues for a sport
- `schedule.getAvailabilitySummary` — availability per venue (plus a short list of fallbacks if that payload has no times)

Same origin, same cookies, same Cloudflare pass. There is no password in a `.env` file and no login inside this tool.

Fan-out is capped at **3 venues at a time**. One venue failing does not fail the whole grid.

---

## Limits

- Peak-hour slots on ActiveSG are often a **ballot**, not “N courts free”. The grid may be incomplete or empty for those.
- ActiveSG can rename tRPC procedures or wrap the JSON differently. Fixes belong in `inject.js`.
- This is unofficial. Keep usage personal and infrequent. Do not turn it into a booking bot or a shared hosted service.

---

## Files

```
project/
  manifest.json   Chrome/Edge extension manifest
  inject.js       Overlay UI + tRPC calls (also a Tampermonkey userscript)
  README.md
```
