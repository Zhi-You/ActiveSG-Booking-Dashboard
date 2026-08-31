import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchAvailability, fetchSports, type AvailabilityResponse, type Sport } from './api';
import AvailabilityGrid from './components/AvailabilityGrid';

const REFRESH_MS = 2 * 60 * 1000; // matches the server's default cache TTL

function todayStr(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export default function App() {
  const [sports, setSports] = useState<Sport[]>([]);
  const [sport, setSport] = useState<string>('');
  const [date, setDate] = useState<string>(todayStr());
  const [data, setData] = useState<AvailabilityResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchSports()
      .then((list) => {
        setSports(list);
        if (list.length > 0) setSport((prev) => prev || list[0].id);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const load = useCallback(async () => {
    if (!sport || !date) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchAvailability(sport, date);
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [sport, date]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const lastUpdated = useMemo(() => {
    if (!data?.generatedAt) return null;
    return new Date(data.generatedAt).toLocaleTimeString();
  }, [data]);

  return (
    <div className="app">
      <h1>ActiveSG Booking Dashboard</h1>

      <div className="controls">
        <label>
          Sport
          <select value={sport} onChange={(e) => setSport(e.target.value)}>
            {sports.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <button onClick={load} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh now'}
        </button>
        {lastUpdated && (
          <span className="updated">
            Updated {lastUpdated}
            {data?.cached ? ' (cached)' : ''}
          </span>
        )}
      </div>

      {error && <p className="error">Error: {error}</p>}
      {data && !error && <AvailabilityGrid data={data} activityId={sport} date={date} />}
      {data && data.errors.length > 0 && (
        <p className="warn">Some venues failed to load: {data.errors.map((e) => e.venue).join(', ')}</p>
      )}
    </div>
  );
}
