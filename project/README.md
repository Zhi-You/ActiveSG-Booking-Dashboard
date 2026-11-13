# ActiveSG Booking Dashboard

A personal overlay on [activesg.gov.sg](https://activesg.gov.sg). After you log in, pick a sport and a day (up to two weeks ahead) to see **instant** booking slots across venues. Click a venue to open ActiveSG’s own booking page. This tool never books anything for you.

## Install

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** and select this `project` folder.
4. Go to [https://activesg.gov.sg](https://activesg.gov.sg), sign in, then click **Availability** on the right.

After you change the code, click **Reload** on the extension, then refresh the ActiveSG tab.

## Map

Click **Map** in the Availability panel to open a Singapore map in a new tab. Keep the ActiveSG tab open: the map gets its data from it.

- **All venues** — every venue for the sport.
- **Instant slots** — pick a day; only venues with open Instant slots that day are shown, with their times.
- **Ballot** — venues currently open for ballot.

Tick **Also show other venues** to see the rest in grey. Venue locations come from ActiveSG when available, otherwise from [OneMap](https://www.onemap.gov.sg/) search (cached in the map tab). Locations matched only by name are marked approximate.
