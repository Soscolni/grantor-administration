import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3000;
const RIVHIT_BASE = 'https://api.rivhit.co.il/online/RivhitOnlineAPI.svc';

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// POST /api/<Endpoint.Name>  ->  RIVHIT_BASE/<Endpoint.Name>
// The proxy exists so the browser page can call the Rivhit API from the
// same origin and avoid CORS issues with api.rivhit.co.il.
app.post('/api/:endpoint', async (req, res) => {
  const { endpoint } = req.params;
  if (!/^[A-Za-z][A-Za-z0-9.]+$/.test(endpoint)) {
    return res.status(400).json({ error: 'invalid endpoint name' });
  }
  const url = `${RIVHIT_BASE}/${endpoint}`;
  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(req.body ?? {}),
    });
    const text = await upstream.text();
    res
      .status(upstream.status)
      .type(upstream.headers.get('content-type') || 'application/json')
      .send(text);
  } catch (err) {
    res.status(502).json({ error: 'upstream fetch failed', message: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Rivhit POC running at http://localhost:${PORT}`);
});
