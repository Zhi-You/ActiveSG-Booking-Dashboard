import { getVenuesForActivity, getSlots } from './activesgClient.js';
import { getCached, setCached } from './cache.js';

const TTL_MS = Number(process.env.CACHE_TTL_MS) || 2 * 60 * 1000;
const CONCURRENCY = Number(process.env.FANOUT_CONCURRENCY) || 6;

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

function timeLabel(from, to) {
  return `${String(from).slice(0, 5)} - ${String(to).slice(0, 5)}`;
}

/**
 * Fetches availability for every venue offering `activityId` on `date`, and pivots the
 * result into { "07:00 - 08:00": { "Venue A": { count, venueId }, ... }, ... } so the
 * client can render a single time-slot x venue grid instead of drilling per venue.
 */
export async function getAvailability(activityId, date) {
  const cacheKey = `${activityId}:${date}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return { ...cached, cached: true };
  }

  const venues = await getVenuesForActivity(activityId);

  const perVenue = await mapWithConcurrency(venues, CONCURRENCY, async (venue) => {
    try {
      const courts = await getSlots(activityId, venue.venue_id, date);
      const available = [];
      for (const court of courts) {
        for (const ts of court.timeslots || []) {
          if (ts.is_available === 'Y') {
            available.push({ label: timeLabel(ts.time_from, ts.time_to), court: court.short_name });
          }
        }
      }
      return { venue: venue.name, venueId: venue.venue_id, slots: available, error: null };
    } catch (e) {
      return { venue: venue.name, venueId: venue.venue_id, slots: [], error: e.message };
    }
  });

  const grid = {};
  for (const v of perVenue) {
    for (const s of v.slots) {
      grid[s.label] ??= {};
      grid[s.label][v.venue] ??= { count: 0, venueId: v.venueId };
      grid[s.label][v.venue].count += 1;
    }
  }

  const result = {
    activityId,
    date,
    generatedAt: new Date().toISOString(),
    venues: perVenue.map((v) => v.venue),
    grid,
    errors: perVenue.filter((v) => v.error).map((v) => ({ venue: v.venue, error: v.error })),
  };

  setCached(cacheKey, result, TTL_MS);
  return { ...result, cached: false };
}
