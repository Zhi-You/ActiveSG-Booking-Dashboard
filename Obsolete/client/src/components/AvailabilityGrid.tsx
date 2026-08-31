import type { AvailabilityResponse } from '../api';

interface Props {
  data: AvailabilityResponse;
  activityId: string;
  date: string;
}

function toEpochSeconds(dateStr: string): number {
  return Math.floor(new Date(`${dateStr}T00:00:00+08:00`).getTime() / 1000);
}

function bookingUrl(activityId: string, venueId: string, date: string): string {
  const ts = toEpochSeconds(date);
  return `https://members.myactivesg.com/facilities/view/activity/${activityId}/venue/${venueId}?time_from=${ts}`;
}

function heatColor(count: number): string {
  if (count <= 0) return 'transparent';
  if (count === 1) return '#fde68a';
  if (count <= 3) return '#86efac';
  return '#22c55e';
}

export default function AvailabilityGrid({ data, activityId, date }: Props) {
  const times = Object.keys(data.grid).sort();
  const venues = data.venues;

  if (times.length === 0) {
    return <p className="empty-state">No available slots found for this sport and date.</p>;
  }

  return (
    <div className="grid-wrapper">
      <table className="availability-grid">
        <thead>
          <tr>
            <th className="time-col">Time</th>
            {venues.map((v) => (
              <th key={v}>{v}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {times.map((time) => (
            <tr key={time}>
              <td className="time-col">{time}</td>
              {venues.map((v) => {
                const cell = data.grid[time]?.[v];
                const count = cell?.count ?? 0;
                return (
                  <td
                    key={v}
                    style={{ background: heatColor(count) }}
                    className={count > 0 ? 'clickable' : ''}
                    onClick={() => {
                      if (count > 0 && cell) {
                        window.open(bookingUrl(activityId, cell.venueId, date), '_blank', 'noopener,noreferrer');
                      }
                    }}
                    title={count > 0 ? 'Click to open the official ActiveSG booking page' : 'No courts available'}
                  >
                    {count > 0 ? count : ''}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
