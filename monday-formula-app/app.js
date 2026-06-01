import 'dotenv/config';
import express from 'express';
import { verifyMondayJwt } from './lib/jwt.js';
import {
  fetchItem,
  updateColumns,
  postItemUpdate,
  listColumns,
  findCol,
  readColValue,
} from './lib/monday.js';

const app = express();
// monday-code injects PORT (commonly 8080). Default matches that convention.
const PORT = Number(process.env.PORT) || 8080;
const SIGNING_SECRET = process.env.MONDAY_SIGNING_SECRET;

// Dev escape hatch: when ALLOW_UNSIGNED=1, skip JWT verification and fall back
// to MONDAY_API_TOKEN so you can curl the endpoints locally without Monday.
// NEVER set this in a deployed app.
const ALLOW_UNSIGNED = process.env.ALLOW_UNSIGNED === '1';

app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'monday-formula-app' }));

// ---- Custom integration ACTION: "copy formula column -> number column" ----
// Recipe input fields (configure these keys in the Developer Center):
//   itemId          (from the trigger)
//   boardId         (from the trigger)
//   formulaColumnId (dropdown, populated by POST /monday/fields/formula-columns)
//   numberColumnId  (dropdown, populated by POST /monday/fields/number-columns)
app.post('/monday/action/formula-sync', async (req, res) => {
  let token;
  try {
    token = authTokenFromRequest(req);
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }

  const fields = req.body?.payload?.inputFields ?? {};
  const { itemId, boardId, formulaColumnId, numberColumnId } = fields;
  if (!itemId || !boardId || !formulaColumnId || !numberColumnId) {
    return res.status(400).json({
      error: 'missing one of inputFields: itemId, boardId, formulaColumnId, numberColumnId',
    });
  }

  try {
    const item = await fetchItem(token, itemId, [formulaColumnId]);
    const raw = readColValue(findCol(item, formulaColumnId));
    if (!raw) {
      await note(token, itemId,
        `Formula sync: column "${formulaColumnId}" returned no value. ` +
        `Formulas referencing mirror or connected-board columns can't be read via the API.`);
      // 200 so Monday doesn't retry a permanent data problem.
      return res.status(200).json({ skipped: 'empty formula value' });
    }
    const num = parseNumber(raw);
    if (!Number.isFinite(num)) {
      await note(token, itemId,
        `Formula sync: value "${raw}" isn't numeric, can't write to number column "${numberColumnId}".`);
      return res.status(200).json({ skipped: 'non-numeric formula value' });
    }

    await updateColumns(token, item.board?.id || boardId, itemId, { [numberColumnId]: String(num) });
    console.log(`[formula-app] item ${itemId}: ${formulaColumnId} (${num}) -> ${numberColumnId}`);
    return res.status(200).json({});
  } catch (err) {
    // Unexpected/transient error: 500 lets Monday retry the action.
    console.error(`[formula-app] item ${itemId} failed:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ---- Remote-options endpoints that fill the recipe's column dropdowns ----
// Monday POSTs these when the user opens the dropdown; we return the board's
// columns of the relevant type. This is what spares users from ever finding a
// raw column id.
app.post('/monday/fields/formula-columns', (req, res) => columnOptions(req, res, 'formula'));
app.post('/monday/fields/number-columns', (req, res) => columnOptions(req, res, 'numbers'));

async function columnOptions(req, res, type) {
  let token;
  try {
    token = authTokenFromRequest(req);
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }
  const payload = req.body?.payload ?? {};
  const boardId = payload.boardId ?? payload.dependencyData?.boardId;
  if (!boardId) {
    // No board chosen yet — return an empty list rather than erroring.
    return res.status(200).json({ options: [] });
  }
  try {
    const columns = await listColumns(token, boardId);
    const options = columns
      .filter((c) => c.type === type)
      .map((c) => ({ value: c.id, title: c.title }));
    return res.status(200).json({ options });
  } catch (err) {
    console.error(`[formula-app] column options (${type}) failed:`, err.message);
    return res.status(500).json({ error: err.message });
  }
}

// Pull the API token for this request: the shortLivedToken from Monday's signed
// JWT, or MONDAY_API_TOKEN in unsigned dev mode.
function authTokenFromRequest(req) {
  const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (ALLOW_UNSIGNED && !raw) {
    const dev = process.env.MONDAY_API_TOKEN;
    if (!dev) throw new Error('ALLOW_UNSIGNED set but MONDAY_API_TOKEN missing');
    return dev;
  }
  const claims = verifyMondayJwt(raw, SIGNING_SECRET);
  if (!claims.shortLivedToken) throw new Error('JWT has no shortLivedToken');
  return claims.shortLivedToken;
}

function parseNumber(text) {
  if (!text) return NaN;
  const cleaned = String(text).replace(/[^\d.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return NaN;
  return Number(cleaned);
}

async function note(token, itemId, body) {
  try {
    await postItemUpdate(token, itemId, body);
  } catch (e) {
    console.error(`[formula-app] couldn't post item update for ${itemId}:`, e.message);
  }
}

app.listen(PORT, () => {
  console.log(`monday-formula-app listening on http://localhost:${PORT}`);
});
