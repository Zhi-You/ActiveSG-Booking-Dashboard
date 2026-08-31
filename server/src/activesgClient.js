// All raw calls to ActiveSG's (unofficial, reverse-engineered) member API live in this
// file. If ActiveSG changes their endpoints, this should be the only file you need to
// touch. See the README for how to re-verify these against the live app.

const BASE = 'https://members.myactivesg.com:8889/api/index.php';

const session = {
  token: null,
  expiresAt: 0,
};

async function login() {
  const email = process.env.ACTIVESG_EMAIL;
  const password = process.env.ACTIVESG_PASSWORD;
  if (!email || !password) {
    throw new Error('ACTIVESG_EMAIL / ACTIVESG_PASSWORD are not set in .env');
  }

  let res;
  try {
    res = await fetch(`${BASE}/v2/account/account_login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        login_type: 'normal',
        user_name: email,
        password,
        platform: 'android',
      }),
    });
  } catch (e) {
    const cause = e.cause?.code || e.message;
    throw new Error(
      `Cannot reach the old ActiveSG API at ${BASE} (${cause}). That host no longer accepts connections — see README.`
    );
  }

  if (!res.ok) {
    throw new Error(`ActiveSG login request failed with HTTP ${res.status}`);
  }

  const data = await res.json();
  if (data.status_code !== 1010 || !data.results?.access_token) {
    throw new Error(`ActiveSG login failed: ${data.message || JSON.stringify(data)}`);
  }

  session.token = data.results.access_token;
  // Refresh proactively before we know it'd expire. Adjust if you find the real TTL.
  session.expiresAt = Date.now() + 25 * 60 * 1000;
  return session.token;
}

async function getToken() {
  if (!session.token || Date.now() > session.expiresAt) {
    await login();
  }
  return session.token;
}

async function authedGet(path, { retrying = false } = {}) {
  const token = await getToken();
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'X-authorization': token },
  });

  if (res.status === 401 && !retrying) {
    // Token may have been invalidated server-side; force a fresh login once.
    session.token = null;
    return authedGet(path, { retrying: true });
  }

  if (!res.ok) {
    throw new Error(`ActiveSG request failed (${res.status}): ${path}`);
  }

  return res.json();
}

export async function getAllActivities() {
  const data = await authedGet('/facility/activity/all?platform=android');
  return data.results ?? [];
}

export async function getVenuesForActivity(activityId) {
  const data = await authedGet(`/facility/venue/${activityId}?platform=android`);
  return data.results ?? [];
}

export async function getSlots(activityId, venueId, date) {
  const data = await authedGet(
    `/facility/slots?platform=android&activity_id=${encodeURIComponent(activityId)}&venue_id=${encodeURIComponent(venueId)}&date=${encodeURIComponent(date)}`
  );
  return data.results && data.results !== false ? data.results : [];
}

// OCBC Arena runs on a separate booking system with its own global feed (no login
// required). Not wired into aggregate.js yet — see README "Known limitations".
export async function getArenaSlotsRaw() {
  const res = await fetch('https://bookings.sportshub.com.sg/json/sportsBookings.php');
  if (!res.ok) {
    throw new Error(`Arena feed request failed (${res.status})`);
  }
  return res.json();
}
