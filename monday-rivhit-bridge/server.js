import 'dotenv/config';
import express from 'express';
import { fetchItemWithSubitems, updateColumns, findCol } from './lib/monday.js';
import { postRivhit, RivhitError } from './lib/rivhit.js';
import { ymdToDmy, todayDmy } from './lib/dates.js';

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'monday-rivhit-bridge' }));

// Monday automation -> "Send webhook" action posts here.
app.post('/monday/webhook', async (req, res) => {
  // 1. URL-verification handshake. Monday's first request after you save the
  // automation contains only a `challenge` field, and the URL is considered
  // verified once we echo it back unmodified.
  if (req.body?.challenge) {
    return res.json({ challenge: req.body.challenge });
  }

  // 2. Optional shared-secret check. Append ?secret=... to the webhook URL
  // in the Monday automation if you set WEBHOOK_SHARED_SECRET.
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

  // 3. Always 200 to Monday so it doesn't retry on logical failure.
  // Surface errors via the Last Error column + Status=Error instead.
  res.status(200).json({ accepted: true, itemId: pulseId });
  processItem(pulseId, boardId).catch((err) => {
    console.error(`[bridge] unhandled error for item ${pulseId}:`, err);
  });
});

async function processItem(itemId, boardId) {
  const cols = readColumnEnv();

  // Mark Generating early so the user sees feedback in Monday immediately.
  await safeUpdate(boardId, itemId, {
    [cols.status]: { label: 'Generating' },
  });

  try {
    const item = await fetchItemWithSubitems(itemId);

    const customerIdRaw = (findCol(item, cols.customerId)?.text || '').trim();
    const customerId = Number(customerIdRaw);
    if (!Number.isFinite(customerId) || customerId <= 0) {
      throw new Error(`Customer ID is missing or invalid (got "${customerIdRaw}")`);
    }

    const docTypeLabel = (findCol(item, cols.docType)?.text || '').trim();
    const docTypeId = extractLeadingNumber(docTypeLabel);
    if (!Number.isFinite(docTypeId)) {
      throw new Error(`Document Type is missing or unparseable (got "${docTypeLabel}"). Expected the dropdown label to start with the numeric Rivhit type id, e.g. "8 / חשבון עסקה".`);
    }

    const issueDateText = (findCol(item, cols.issueDate)?.text || '').trim();
    const issueDate = issueDateText ? ymdToDmy(issueDateText) : todayDmy();

    const comments = (findCol(item, cols.comments)?.text || '').trim() || undefined;

    const items = (item.subitems || [])
      .map((si) => {
        const desc = (si.name || '').trim();
        const qtyText = (findCol(si, cols.subQty)?.text || '').trim();
        const priceText = (findCol(si, cols.subPrice)?.text || '').trim();
        const cat = (findCol(si, cols.subCatalog)?.text || '').trim();
        const quantity = Number(qtyText) || 1;
        const price = Number(priceText);
        return { desc, quantity, price, cat };
      })
      .filter((row) => row.desc && Number.isFinite(row.price))
      .map((row) => ({
        catalog_number: row.cat || undefined,
        description: row.desc,
        quantity: row.quantity,
        price_nis: row.price,
      }));

    if (items.length === 0) {
      throw new Error('No usable subitems found. Each subitem needs a name (description) and a numeric Price NIS.');
    }

    const payload = {
      document_type: docTypeId,
      customer_id: customerId,
      issue_date: issueDate,
      comments,
      items,
    };

    console.log(`[bridge] Document.New for item ${itemId}, customer ${customerId}, type ${docTypeId}, ${items.length} line(s)`);
    const data = await postRivhit('Document.New', payload);

    // Best-effort customer-name enrichment. Failure is non-fatal — the
    // document is already created in Rivhit by this point.
    let customerName = '';
    if (cols.customerName) {
      try {
        const c = await postRivhit('Customer.Get', { customer_id: customerId });
        customerName = [c?.first_name, c?.last_name].filter(Boolean).join(' ').trim()
          || c?.customer_name
          || '';
      } catch (err) {
        console.warn(`[bridge] Customer.Get failed (non-fatal):`, err.message);
      }
    }

    const updates = {
      [cols.status]: { label: 'Done' },
      [cols.docNumber]: String(data.document_number ?? ''),
      [cols.lastError]: { text: '' },
    };
    if (cols.pdfLink && data.document_link) {
      updates[cols.pdfLink] = { url: data.document_link, text: `Doc #${data.document_number}` };
    }
    if (cols.customerName && customerName) {
      updates[cols.customerName] = customerName;
    }
    await safeUpdate(boardId, itemId, updates);
    console.log(`[bridge] item ${itemId} done: doc #${data.document_number}`);
  } catch (err) {
    const human = err instanceof RivhitError
      ? `Rivhit: ${err.clientMessage || err.message} (error_code=${err.errorCode})`
      : err.message || String(err);
    console.error(`[bridge] item ${itemId} failed:`, human);
    await safeUpdate(boardId, itemId, {
      [cols.status]: { label: 'Error' },
      [cols.lastError]: { text: human.slice(0, 1900) },
    });
  }
}

function readColumnEnv() {
  return {
    customerId: process.env.COL_CUSTOMER_ID,
    customerName: process.env.COL_CUSTOMER_NAME,
    docType: process.env.COL_DOC_TYPE,
    issueDate: process.env.COL_ISSUE_DATE,
    comments: process.env.COL_COMMENTS,
    status: process.env.COL_STATUS,
    docNumber: process.env.COL_DOC_NUMBER,
    pdfLink: process.env.COL_PDF_LINK,
    lastError: process.env.COL_LAST_ERROR,
    subQty: process.env.SUBCOL_QTY,
    subPrice: process.env.SUBCOL_PRICE,
    subCatalog: process.env.SUBCOL_CATALOG,
  };
}

function extractLeadingNumber(label) {
  const m = String(label).match(/^\s*(\d+)/);
  return m ? Number(m[1]) : NaN;
}

async function safeUpdate(boardId, itemId, columnValues) {
  const cleaned = Object.fromEntries(
    Object.entries(columnValues).filter(([k]) => k && k !== 'undefined'),
  );
  if (Object.keys(cleaned).length === 0) return;
  try {
    await updateColumns(boardId, itemId, cleaned);
  } catch (err) {
    console.error(`[bridge] Monday update failed for item ${itemId}:`, err.message);
  }
}

app.listen(PORT, () => {
  console.log(`monday-rivhit-bridge listening on http://localhost:${PORT}`);
});
