const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000';

export interface Sport {
  id: string;
  name: string;
}

export async function fetchSports(): Promise<Sport[]> {
  const res = await fetch(`${API_BASE}/api/sports`);
  if (!res.ok) throw new Error('Failed to load sports list');
  return res.json();
}

export interface GridCell {
  count: number;
  venueId: string;
}

export interface AvailabilityResponse {
  activityId: string;
  date: string;
  generatedAt: string;
  venues: string[];
  grid: Record<string, Record<string, GridCell>>;
  cached: boolean;
  errors: { venue: string; error: string }[];
}

export async function fetchAvailability(sport: string, date: string): Promise<AvailabilityResponse> {
  const res = await fetch(
    `${API_BASE}/api/availability?sport=${encodeURIComponent(sport)}&date=${encodeURIComponent(date)}`
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to load availability');
  }
  return res.json();
}
