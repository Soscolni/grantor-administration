import 'dotenv/config';
import express from 'express';
import {
  fetchItemForProcessing,
  createSubitem,
  postItemUpdate,
  findCol,
  readColValue,
} from './lib/monday.js';
import { fetchTasksFromSheet, SheetError } from './lib/sheet.js';

const app = express();
const PORT = Number(process.env.PORT) || 3003;

// Defaults ship in code so the service runs with only MONDAY_API_TOKEN set;
// every value is overridable via env (same posture as the sibling bridges).
const BOARD_TASKS = process.env.BOARD_TASKS || '5098132295';
const GSHEET_ID = process.env.GSHEET_ID || '13f658G5KXGbmKvXR7m1U_j5mYX4Fd0upgWqTJwE6scc';
// Column IDs discovered via `npm run discover`; shipped as defaults (overridable
// via env) so the service runs with only MONDAY_API_TOKEN set.
const COL_GRANT_TYPE = process.env.COL_GRANT_TYPE || 'dropdown_mm3ykhzk';
const SUBITEM_STAGE_COL = process.env.SUBITEM_STAGE_COL || 'text_mm45tada';

app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'monday-subitems-sheet' }));

app.post('/monday/webhook', handleWebhook);

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
  if (BOARD_TASKS && String(boardId) !== String(BOARD_TASKS)) {
    return res.status(200).json({ skipped: 'board not allow-listed' });
  }
  // Reply 200 immediately so Monday doesn't retry on logical failure; we surface
  // outcomes (skip / errors / summary) via item updates.
  res.status(200).json({ accepted: true, itemId: pulseId });
  processItem(pulseId).catch((err) => {
    console.error(`[subitems] unhandled error for item ${pulseId}:`, err);
  });
}

async function processItem(itemId) {
  try {
    if (!COL_GRANT_TYPE) throw new Error('COL_GRANT_TYPE is not configured — run `npm run discover`.');
    if (!SUBITEM_STAGE_COL) throw new Error('SUBITEM_STAGE_COL is not configured — run `npm run discover`.');

    const item = await fetchItemForProcessing(itemId, COL_GRANT_TYPE);
    if (!item) throw new Error(`פריט ${itemId} לא נמצא`);

    // Idempotency: skip if the item already has subitems (covers retries /
    // double clicks). This is the only duplicate guard.
    if (item.subitems?.length) {
      await postItemUpdate(itemId, `דילגתי: לפריט כבר יש ${item.subitems.length} תת-פריטים.`);
      console.log(`[subitems] item ${itemId} skipped: already has ${item.subitems.length} subitems`);
      return;
    }

    const grantType = readColValue(findCol(item, COL_GRANT_TYPE));
    if (!grantType) throw new Error('עמודת "סוג המענק" ריקה — אין שם לשונית לחפש בגיליון.');

    // Tab name = grant-type value, verbatim (case/spacing matter). SheetError
    // (missing tab / non-shared sheet) bubbles to catch -> note on the item.
    const tasks = await fetchTasksFromSheet(GSHEET_ID, grantType);
    if (tasks.length === 0) {
      await postItemUpdate(itemId, `הלשונית "${grantType}" קיימת אך לא נמצאו בה משימות.`);
      console.log(`[subitems] item ${itemId}: tab "${grantType}" had no tasks`);
      return;
    }

    // Create sequentially to preserve sheet order and avoid rate-limit bursts.
    const created = [];
    for (const task of tasks) {
      const sub = await createSubitem(itemId, task.description, {
        [SUBITEM_STAGE_COL]: task.stage,
      });
      created.push(sub.id);
    }

    await postItemUpdate(itemId, `נוצרו ${created.length} תת-פריטים מתוך הלשונית "${grantType}" בגיליון.`);
    console.log(`[subitems] item ${itemId}: created ${created.length} subitems from tab "${grantType}"`);
  } catch (err) {
    await reportError(itemId, err);
  }
}

async function reportError(itemId, err) {
  const human = err instanceof SheetError ? err.message : (err.message || String(err));
  console.error(`[subitems] item ${itemId} failed:`, human);
  try {
    await postItemUpdate(itemId, `יצירת תת-פריטים מהגיליון נכשלה:\n${human}`);
  } catch (e) {
    console.error(`[subitems] also failed to post item update for ${itemId}:`, e.message);
  }
}

app.listen(PORT, () => {
  console.log(`monday-subitems-sheet listening on http://localhost:${PORT}`);
});
