import 'dotenv/config';
import express from 'express';
import { fetchItem, updateColumns, postItemUpdate, findCol, readColValue } from './lib/monday.js';

const app = express();
const PORT = Number(process.env.PORT) || 3002;

app.use(express.json({ limit: '1mb' }));

// Monday column ids are lowercase letters, digits and underscores
// (e.g. "formula_abc", "numeric_mm3w2bn0"). Validate anything we pull from a
// query string before it lands in a GraphQL variable.
const COL_ID_RE = /^[a-zA-Z0-9_]+$/;

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'monday-formula-sync' }));

// One endpoint, two ways to say which columns to copy:
//   1. Per-automation override:  ?formula=<colId>&target=<colId>
//      Lets a single deployment serve many boards/automations — each Monday
//      "Send webhook" action just carries its own column ids in the URL.
//   2. Default from env SYNC_PAIRS (JSON { formulaColId: targetColId, ... }),
//      used when the query params are absent. Supports several pairs at once.
app.post('/monday/webhook/formula-sync', handleWebhook);

function handleWebhook(req, res) {
  // Monday URL-verification: the first request after saving the automation has
  // only a `challenge` field, which we echo back unmodified.
  if (req.body?.challenge) {
    return res.json({ challenge: req.body.challenge });
  }
  const expectedSecret = process.env.WEBHOOK_SHARED_SECRET;
  if (expectedSecret && req.query.secret !== expectedSecret) {
    return res.status(401).json({ error: 'bad secret' });
  }
  const event = req.body?.event ?? {};
  const { pulseId, boardId } = event;
  if (!pulseId || !boardId) {
    return res.status(400).json({ error: 'missing event.pulseId or event.boardId' });
  }
  if (process.env.MONDAY_BOARD_ID && String(boardId) !== String(process.env.MONDAY_BOARD_ID)) {
    return res.status(200).json({ skipped: 'board not allow-listed' });
  }

  let pairs;
  try {
    pairs = resolvePairs(req);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Reply 200 immediately so Monday doesn't retry; problems are surfaced as an
  // update on the item itself.
  res.status(200).json({ accepted: true, itemId: pulseId, pairs: pairs.length });
  processSync(pulseId, boardId, pairs).catch((err) => {
    console.error(`[formula-sync] unhandled error for item ${pulseId}:`, err);
  });
}

// Decide which (formula -> target) copies to perform for this request.
function resolvePairs(req) {
  const { formula, target } = req.query;
  if (formula || target) {
    if (!formula || !target) {
      throw new Error('pass both ?formula=<colId> and ?target=<colId> (or neither, to use SYNC_PAIRS)');
    }
    return [validatePair(formula, target)];
  }
  const raw = process.env.SYNC_PAIRS;
  if (!raw) {
    throw new Error('no mapping: pass ?formula=<colId>&target=<colId> or set SYNC_PAIRS in .env');
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`SYNC_PAIRS is not valid JSON: ${e.message}`);
  }
  const pairs = Object.entries(obj).map(([f, t]) => validatePair(f, t));
  if (pairs.length === 0) throw new Error('SYNC_PAIRS is empty');
  return pairs;
}

function validatePair(formula, target) {
  if (!COL_ID_RE.test(formula) || !COL_ID_RE.test(target)) {
    throw new Error(`invalid column id in pair "${formula}" -> "${target}"`);
  }
  return { formula, target };
}

async function processSync(itemId, boardId, pairs) {
  try {
    // Read only the formula columns (Monday caps formula reads at 5/request;
    // one button typically syncs 1).
    const formulaIds = [...new Set(pairs.map((p) => p.formula))];
    const item = await fetchItem(itemId, formulaIds);

    const updates = {};
    const problems = [];
    for (const { formula, target } of pairs) {
      const raw = readColValue(findCol(item, formula));
      if (!raw) {
        problems.push(
          `Formula column "${formula}" returned no value. ` +
          `Formulas that reference mirror or connected-board columns can't be read through the Monday API (yet).`,
        );
        continue;
      }
      const num = parseNumber(raw);
      if (!Number.isFinite(num)) {
        problems.push(
          `Formula column "${formula}" value "${raw}" isn't numeric, so it can't be written to number column "${target}".`,
        );
        continue;
      }
      updates[target] = String(num);
    }

    if (Object.keys(updates).length > 0) {
      // Prefer the board id reported by the item itself; fall back to the
      // webhook's boardId.
      await updateColumns(item.board?.id || boardId, itemId, updates);
    }
    if (problems.length > 0) {
      await reportProblem(itemId, problems.join('\n'));
    }
    console.log(
      `[formula-sync] item ${itemId}: wrote ${Object.keys(updates).length} column(s)` +
      (problems.length ? `, ${problems.length} problem(s)` : ''),
    );
  } catch (err) {
    await reportProblem(itemId, err.message || String(err));
  }
}

// Turn a formula display value into a number Monday's number column accepts.
// Strips currency symbols, thousands separators, %, etc. Keeps sign + decimal.
function parseNumber(text) {
  if (!text) return NaN;
  const cleaned = String(text).replace(/[^\d.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return NaN;
  return Number(cleaned);
}

async function reportProblem(itemId, message) {
  console.error(`[formula-sync] item ${itemId}:`, message);
  try {
    await postItemUpdate(itemId, `Formula sync couldn't complete:\n${message}`);
  } catch (e) {
    console.error(`[formula-sync] also failed to post item update for ${itemId}:`, e.message);
  }
}

app.listen(PORT, () => {
  console.log(`monday-formula-sync listening on http://localhost:${PORT}`);
});
