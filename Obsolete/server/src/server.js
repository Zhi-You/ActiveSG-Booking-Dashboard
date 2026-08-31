import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { getAllActivities } from './activesgClient.js';
import { getAvailability } from './aggregate.js';

const app = express();
app.use(cors());

app.get('/api/sports', async (req, res) => {
  try {
    const activities = await getAllActivities();
    res.json(activities.map((a) => ({ id: a.activity_id, name: a.name })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/availability', async (req, res) => {
  const { sport, date } = req.query;
  if (!sport || !date) {
    return res.status(400).json({ error: 'sport and date query params are required' });
  }
  try {
    const data = await getAvailability(String(sport), String(date));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`ActiveSG dashboard API listening on http://localhost:${PORT}`);
});
