import 'dotenv/config';
import express from 'express';
import { verifyMondayJwt, decodeMondayJwt } from './lib/jwt.js';
import {
  gql,
  fetchItem,
  fetchItemsColumns,
  fetchSubitems,
  listColumns,
  updateColumns,
  findCol,
  readColValue,
  parseNumber,
} from './lib/monday.js';
import { evaluate, extractRefs } from './lib/calc-expr.js';
import { commissionSchedule, rollup } from './lib/calcs.js';

const app = express();
const PORT = Number(process.env.PORT) || 8080;
const SIGNING_SECRET = process.env.MONDAY_SIGNING_SECRET;
const ALLOW_UNSIGNED = process.env.ALLOW_UNSIGNED === '1';

app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'monday-calc-engine' }));

// =====================================================================
// ACTION 1 — Generic expression: write `expression` evaluated over the item's
// columns into a number column. Refs are {columnId} or {relationColId->srcColId}.
// inputFields: { itemId, boardId, outputColumnId, expression }
// =====================================================================
app.post('/monday/action/expression', withAuth(async (req, res, token) => {
  const { itemId, boardId, outputColumnId, expression } = inputs(req);
  requireFields({ itemId, boardId, outputColumnId, expression });

  const item = await fetchItem(token, itemId);
  const vars = await resolveRefs(token, item, extractRefs(expression));
  const result = evaluate(expression, vars);
  if (!Number.isFinite(result)) {
    return skip(res, token, itemId, `Expression result is not a finite number (got ${result}).`);
  }
  await updateColumns(token, item.board?.id || boardId, itemId, { [outputColumnId]: String(result) });
  console.log(`[calc] expression item ${itemId} -> ${outputColumnId} = ${result}`);
  return res.status(200).json({ result });
}));

// =====================================================================
// ACTION 2 — Rollup: aggregate a value column across subitems / linked items
// and write the result onto this item. The cross-row ability formulas lack.
// inputFields: { itemId, boardId, scope, relationColumnId?, valueColumnId, op, outputColumnId }
//   scope: "subitems" | "linked"
//   op: sum | min | max | avg | count
// =====================================================================
app.post('/monday/action/rollup', withAuth(async (req, res, token) => {
  const f = inputs(req);
  const { itemId, boardId, scope, valueColumnId, op, outputColumnId } = f;
  requireFields({ itemId, boardId, scope, valueColumnId, op, outputColumnId });

  const item = await fetchItem(token, itemId);
  const rows = await loadRows(token, item, scope, f.relationColumnId);
  // valueColumnId may be a plain column id or "relCol->srcCol" to read a source.
  const values = await Promise.all(rows.map((r) => resolveValue(token, r, valueColumnId)));
  const result = rollup(values, op);
  if (!Number.isFinite(result)) {
    return skip(res, token, itemId, `Rollup result is not finite (op=${op}).`);
  }
  await updateColumns(token, item.board?.id || boardId, itemId, { [outputColumnId]: String(result) });
  console.log(`[calc] rollup ${op} item ${itemId} over ${rows.length} rows -> ${result}`);
  return res.status(200).json({ result, rows: rows.length });
}));

// =====================================================================
// ACTION 3 — Commission: walk installments in order applying the running rule
// F = min(R, capRate * P) and write each installment's collected amount. The
// flagship stateful calc from the tender guide.
// inputFields: { itemId, boardId, scope, relationColumnId?, amountColumnId,
//                outputColumnId, capPercent?, strategy?,
//                totalCommission? | (winningAmountColumnId? + commissionPercent?) }
// =====================================================================
app.post('/monday/action/commission', withAuth(async (req, res, token) => {
  const f = inputs(req);
  const { itemId, boardId, scope, amountColumnId, outputColumnId } = f;
  requireFields({ itemId, boardId, scope, amountColumnId, outputColumnId });

  const parent = await fetchItem(token, itemId);
  const total = resolveTotalCommission(parent, f);
  if (!Number.isFinite(total)) {
    return skip(res, token, itemId,
      'Could not determine total commission. Set totalCommission, or winningAmountColumnId + commissionPercent.');
  }
  const capRate = (f.capPercent != null ? Number(f.capPercent) : 25) / 100;
  const strategy = f.strategy === 'proportional' ? 'proportional' : 'aggressive';

  const rows = await loadRows(token, parent, scope, f.relationColumnId);
  // amountColumnId may be a plain column id or "relCol->srcCol".
  const amounts = await Promise.all(
    rows.map(async (r) => parseNumber(await resolveValue(token, r, amountColumnId))),
  );
  if (amounts.some((p) => !Number.isFinite(p))) {
    return skip(res, token, itemId, `An installment's "${amountColumnId}" value is missing or non-numeric.`);
  }

  const collected = commissionSchedule(amounts, { total, capRate, strategy });
  await Promise.all(rows.map((r, idx) =>
    updateColumns(token, r.board?.id || boardId, r.id, { [outputColumnId]: String(collected[idx]) }),
  ));
  console.log(`[calc] commission item ${itemId}: ${rows.length} installments, total ${total}, ${strategy}`);
  return res.status(200).json({ total, strategy, collected });
}));

// ---- Remote-options endpoints that populate the recipe's column dropdowns ----
app.post('/monday/fields/number-columns', columnOptions((c) => c.type === 'numbers'));
app.post('/monday/fields/relation-columns', columnOptions((c) => c.type === 'board_relation'));
app.post('/monday/fields/any-columns', columnOptions(() => true));

// ====================== helpers ======================

function inputs(req) {
  return req.body?.payload?.inputFields ?? {};
}

function requireFields(obj) {
  const missing = Object.entries(obj).filter(([, v]) => v == null || v === '').map(([k]) => k);
  if (missing.length) {
    const err = new Error(`missing inputFields: ${missing.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }
}

// Resolve one ref against a row:
//   "colId"               -> read that column directly.
//   "relColId->srcColId"  -> follow the connection and read the REAL source
//                            column on the linked item. This is the robust way
//                            to bring a mirrored value into a calc: instead of
//                            trusting the mirror, we read the actual source.
async function resolveValue(token, row, ref) {
  if (ref.includes('->')) {
    const [relColId, srcColId] = ref.split('->').map((s) => s.trim());
    const linkedId = findCol(row, relColId)?.linked_item_ids?.[0];
    if (!linkedId) return '';
    const [linked] = await fetchItemsColumns(token, [linkedId], [srcColId]);
    return readColValue(findCol(linked, srcColId));
  }
  return readColValue(findCol(row, ref));
}

// Resolve every {ref} in an expression to a vars map.
async function resolveRefs(token, item, refs) {
  const vars = {};
  for (const ref of refs) vars[ref] = await resolveValue(token, item, ref);
  return vars;
}

// Load the set of "rows" for cross-row calcs.
async function loadRows(token, item, scope, relationColumnId) {
  if (scope === 'subitems') return fetchSubitems(token, item.id);
  if (scope === 'linked') {
    const rel = findCol(item, relationColumnId);
    const ids = rel?.linked_item_ids ?? [];
    return fetchItemsColumns(token, ids, []); // all columns of each linked item
  }
  throw Object.assign(new Error(`unknown scope "${scope}" (use "subitems" or "linked")`), { statusCode: 400 });
}

function resolveTotalCommission(parent, f) {
  if (f.totalCommission != null && f.totalCommission !== '') return Number(f.totalCommission);
  if (f.winningAmountColumnId && f.commissionPercent != null) {
    const win = parseNumber(readColValue(findCol(parent, f.winningAmountColumnId)));
    return win * (Number(f.commissionPercent) / 100);
  }
  return NaN;
}

// Wrap an async handler with JWT auth + uniform error handling.
function withAuth(handler) {
  return async (req, res) => {
    let token;
    try {
      token = authToken(req);
    } catch (err) {
      return res.status(401).json({ error: err.message });
    }
    try {
      await handler(req, res, token);
    } catch (err) {
      const code = err.statusCode || 500;
      console.error(`[calc] ${req.path} failed (${code}):`, err.message);
      if (!res.headersSent) res.status(code).json({ error: err.message });
    }
  };
}

function columnOptions(predicate) {
  return withAuth(async (req, res, token) => {
    const p = req.body?.payload ?? {};
    const boardId = p.boardId ?? p.dependencyData?.boardId;
    if (!boardId) return res.status(200).json({ options: [] });
    const columns = await listColumns(token, boardId);
    const options = columns.filter(predicate).map((c) => ({ value: c.id, title: c.title }));
    return res.status(200).json({ options });
  });
}

function authToken(req) {
  const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (ALLOW_UNSIGNED && !raw) {
    const dev = process.env.MONDAY_API_TOKEN;
    if (!dev) throw new Error('ALLOW_UNSIGNED set but MONDAY_API_TOKEN missing');
    return dev;
  }
  // Verify the signature when a secret is configured; otherwise decode the
  // token and trust its embedded (genuine, short-lived) shortLivedToken. The
  // fallback keeps the app working when the monday-code secret store is empty.
  const claims = SIGNING_SECRET
    ? verifyMondayJwt(raw, SIGNING_SECRET)
    : decodeMondayJwt(raw);
  if (!SIGNING_SECRET) {
    console.warn('[calc] MONDAY_SIGNING_SECRET not set — decoding JWT without signature verification');
  }
  if (!claims.shortLivedToken) throw new Error('JWT has no shortLivedToken');
  return claims.shortLivedToken;
}

// A permanent data problem: post a note on the item and return 200 (no retry).
async function skip(res, token, itemId, message) {
  console.warn(`[calc] item ${itemId} skipped: ${message}`);
  try {
    await gql(token,
      `mutation($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`,
      { itemId: String(itemId), body: `Calc engine couldn't complete:\n${message}` });
  } catch { /* best effort: surfacing the reason shouldn't mask the original */ }
  return res.status(200).json({ skipped: message });
}

app.listen(PORT, () => {
  console.log(`monday-calc-engine listening on http://localhost:${PORT}`);
});
