import 'dotenv/config';
import express from 'express';
import {
  fetchItems,
  createItem,
  postItemUpdate,
  findCol,
  readColValue,
  parseNumber,
  firstLinkedId,
  linkedIds,
} from './lib/monday.js';
import { commissionSchedule, round2 } from './lib/calcs.js';

const app = express();
const PORT = Number(process.env.PORT) || 3002;

app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'monday-commission-bridge' }));

// Button on a פעימות row -> compute the commission and create a חשבוניות וגביה row.
app.post('/monday/webhook', handleWebhook);

function handleWebhook(req, res) {
  // Monday URL-verification handshake.
  if (req.body?.challenge) return res.json({ challenge: req.body.challenge });

  const expectedSecret = process.env.WEBHOOK_SHARED_SECRET;
  if (expectedSecret && req.query.secret !== expectedSecret) {
    return res.status(401).json({ error: 'bad secret' });
  }
  const event = req.body?.event ?? {};
  const { pulseId, boardId } = event;
  if (!pulseId || !boardId) {
    return res.status(400).json({ error: 'missing event.pulseId or event.boardId' });
  }
  const allow = process.env.BOARD_PEIMOT;
  if (allow && String(boardId) !== String(allow)) {
    return res.status(200).json({ skipped: 'board not allow-listed' });
  }

  // Reply 200 immediately so Monday doesn't retry; outcomes are surfaced as
  // updates on the row.
  res.status(200).json({ accepted: true, itemId: pulseId });
  processPeima(pulseId).catch((err) => console.error(`[commission] unhandled for ${pulseId}:`, err));
}

async function processPeima(peimaId) {
  const cols = readColumnEnv();
  try {
    // 1. The clicked פעימה: amount P + link to its grant.
    const [peima] = await fetchItems([peimaId], [cols.peimaAmount, cols.peimaOrder, cols.peimaToGrant]);
    if (!peima) throw new Error(`פעימה ${peimaId} not found`);
    const P = need(parseNumber(readColValue(findCol(peima, cols.peimaAmount))), 'סכום הפעימה (P)');

    // 2. Follow link -> הגשת מענק: winning amount W + link to agreement + siblings.
    const grantId = firstLinkedId(peima, cols.peimaToGrant);
    if (!grantId) throw new Error('הפעימה אינה מקושרת להגשת מענק (check COL_PEIMA_TO_GRANT)');
    const [grant] = await fetchItems([grantId], [cols.grantWinning, cols.grantToAgreement, cols.grantToPeimot]);
    if (!grant) throw new Error(`הגשת מענק ${grantId} not found`);
    const W = need(parseNumber(readColValue(findCol(grant, cols.grantWinning))), 'סכום הזכייה (W)');

    // 3. Follow link -> הסכם: commission rate + per-installment cap.
    const agreementId = firstLinkedId(grant, cols.grantToAgreement);
    if (!agreementId) throw new Error('הגשת המענק אינה מקושרת להסכם (check COL_GRANT_TO_AGREEMENT)');
    const [agreement] = await fetchItems([agreementId], [cols.agreementRate, cols.agreementCap]);
    if (!agreement) throw new Error(`הסכם ${agreementId} not found`);
    const rate = need(asRate(parseNumber(readColValue(findCol(agreement, cols.agreementRate))), process.env.RATE_AS_PERCENT), 'אחוז עמלה (rate)');
    const cap = need(asRate(parseNumber(readColValue(findCol(agreement, cols.agreementCap))), process.env.CAP_AS_PERCENT), 'אחוז מקסימלי לפעימה (cap)');

    // 4. Gather all פעימות of this grant (include the clicked one) and order them.
    const siblingIds = unique([...linkedIds(grant, cols.grantToPeimot), String(peimaId)]);
    const siblings = await fetchItems(siblingIds, [cols.peimaAmount, cols.peimaOrder].filter(Boolean));
    siblings.sort((a, b) => compareKeys(orderKey(a, cols.peimaOrder), orderKey(b, cols.peimaOrder)));
    const orderedP = siblings.map((s, i) =>
      need(parseNumber(readColValue(findCol(s, cols.peimaAmount))), `סכום פעימה #${i + 1}`));
    const idx = siblings.findIndex((s) => String(s.id) === String(peimaId));
    if (idx < 0) throw new Error('could not locate the clicked פעימה among the grant’s installments');

    // 5/6. Compute the schedule and pull this installment's F (+ R for the note).
    const total = round2(W * rate);
    const schedule = commissionSchedule(orderedP, { total, capRate: cap });
    const F = schedule[idx];
    const R = round2(total - schedule.slice(0, idx).reduce((a, b) => a + b, 0));

    // 7. Create the חשבוניות וגביה row: amount + an explanatory name.
    const name =
      `עמלה לגבייה ₪${F} | פעימה ${idx + 1}/${siblings.length}: ` +
      `min(נותר ₪${R}, ${pct(cap)}% × ₪${P}) | ` +
      `עמלה כוללת ₪${total} = ${pct(rate)}% × ₪${W}`;
    const newId = await createItem(cols.invoicesBoard, name, { [cols.invoiceAmount]: String(F) });

    // 8. Traceability note on the פעימה.
    await postItemUpdate(peimaId,
      `נוצרה דרישת גבייה (₪${F}) בלוח חשבוניות וגביה (item ${newId}).\n${name}`);
    console.log(`[commission] פעימה ${peimaId}: F=${F} -> invoice ${newId}`);
  } catch (err) {
    await reportError(peimaId, err);
  }
}

// --- helpers ---

// Normalise a percentage to a fraction. flag "1" => value is percent (25 -> .25),
// "0" => already a fraction, unset => auto (anything > 1 is treated as percent).
function asRate(v, flag) {
  if (!Number.isFinite(v)) return NaN;
  if (flag === '1') return v / 100;
  if (flag === '0') return v;
  return v > 1 ? v / 100 : v;
}

function pct(frac) {
  return round2(frac * 100);
}

function need(value, label) {
  if (!Number.isFinite(value)) throw new Error(`${label} חסר או אינו מספרי`);
  return value;
}

function unique(arr) {
  return [...new Set(arr.map(String))];
}

// Ordering key for installments: an explicit order column if configured
// (numeric, else its raw text — ISO dates sort lexically), otherwise the item
// id (≈ creation order).
function orderKey(item, orderCol) {
  if (orderCol) {
    const raw = readColValue(findCol(item, orderCol));
    const n = parseNumber(raw);
    if (Number.isFinite(n)) return n;
    if (raw) return raw;
  }
  return Number(item.id);
}

function compareKeys(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

async function reportError(peimaId, err) {
  const msg = err?.message || String(err);
  console.error(`[commission] item ${peimaId} failed:`, msg);
  try {
    await postItemUpdate(peimaId, `חישוב עמלה נכשל:\n${msg}`);
  } catch (e) {
    console.error(`[commission] also failed to post update for ${peimaId}:`, e.message);
  }
}

function readColumnEnv() {
  return {
    invoicesBoard: process.env.BOARD_INVOICES,
    peimaAmount: process.env.COL_PEIMA_AMOUNT,
    peimaOrder: process.env.COL_PEIMA_ORDER,
    peimaToGrant: process.env.COL_PEIMA_TO_GRANT,
    grantWinning: process.env.COL_GRANT_WINNING,
    grantToAgreement: process.env.COL_GRANT_TO_AGREEMENT,
    grantToPeimot: process.env.COL_GRANT_TO_PEIMOT,
    agreementRate: process.env.COL_AGREEMENT_RATE,
    agreementCap: process.env.COL_AGREEMENT_CAP,
    invoiceAmount: process.env.COL_INVOICE_AMOUNT,
  };
}

app.listen(PORT, () => {
  console.log(`monday-commission-bridge listening on http://localhost:${PORT}`);
});
