import 'dotenv/config';
import express from 'express';
import {
  fetchItemWithCustomerRivhitId,
  updateColumns,
  postItemUpdate,
  findCol,
} from './lib/monday.js';
import { postRivhit, RivhitError } from './lib/rivhit.js';
import { ymdToDmy, todayDmy } from './lib/dates.js';

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'monday-rivhit-bridge' }));

const DOC_TYPE_MAP = parseDocTypeMap(process.env.DOC_TYPE_MAP);
const RIVHIT_RECEIPT_TYPE = Number(process.env.RIVHIT_RECEIPT_TYPE || 2);
// Rivhit payment_type for receipt-flow documents. 9 = העברה בנקאית.
const RIVHIT_RECEIPT_PAYMENT_TYPE = Number(process.env.RIVHIT_RECEIPT_PAYMENT_TYPE || 9);
// Israeli VAT rate, used to gross up the pre-VAT amount in numeric_mm3w2bn0
// (סכום לפני מע"מ) before sending it to Rivhit doc types whose
// `price_include_vat` flag is true.
const VAT_RATE = Number(process.env.VAT_RATE || 0.18);

// Invoice flow (חשבונית מס / חשבון חיוב) — wired to the main "Generate" button.
app.post('/monday/webhook', (req, res) => handleWebhook(req, res, processInvoice));

// Receipt flow (קבלה) — wired to a second button column on the row,
// clicked after the customer pays.
app.post('/monday/webhook/receipt', (req, res) => handleWebhook(req, res, processReceipt));

function handleWebhook(req, res, processor) {
  // Monday URL-verification: first request after saving the automation has only
  // a `challenge` field, which we echo back unmodified.
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
  // Reply 200 immediately so Monday doesn't retry on logical failure;
  // we'll surface errors via item updates.
  res.status(200).json({ accepted: true, itemId: pulseId });
  processor(pulseId, boardId).catch((err) => {
    console.error(`[bridge] unhandled error for item ${pulseId}:`, err);
  });
}

async function processInvoice(itemId, boardId) {
  const cols = readColumnEnv();
  if (cols.status && cols.statusGeneratingLabel) {
    await safeUpdate(boardId, itemId, { [cols.status]: { label: cols.statusGeneratingLabel } });
  }
  try {
    const ctx = await loadContext(itemId, cols);

    const mirrorLabel = normalizeLabel(findCol(ctx.item, cols.docTypeMirror)?.text || '');
    if (!mirrorLabel) {
      throw new Error('Customer has no "אופן דרישת תשלום" set — fill it on the customer-library record.');
    }
    const docTypeId = DOC_TYPE_MAP[mirrorLabel];
    if (!Number.isFinite(docTypeId)) {
      throw new Error(
        `Unknown "אופן דרישת תשלום" value "${mirrorLabel}". Configure DOC_TYPE_MAP. Known: ${Object.keys(DOC_TYPE_MAP).join(', ') || '(none)'}.`,
      );
    }

    const linePriceNis = await computeLinePrice(docTypeId, ctx.amount);
    const data = await issueDocument(itemId, ctx, docTypeId, linePriceNis);

    const updates = {};
    if (cols.docNumber) updates[cols.docNumber] = String(data.document_number ?? '');
    if (cols.pdfLink && data.document_link) {
      updates[cols.pdfLink] = {
        url: data.document_link,
        text: `${mirrorLabel} #${data.document_number}`,
      };
    }
    if (cols.status && cols.statusDoneLabel) {
      updates[cols.status] = { label: cols.statusDoneLabel };
    }
    await safeUpdate(boardId, itemId, updates);
    console.log(`[bridge] invoice item ${itemId} done: doc #${data.document_number}`);
  } catch (err) {
    await reportError(itemId, err);
  }
}

async function processReceipt(itemId, boardId) {
  const cols = readColumnEnv();
  try {
    const ctx = await loadContext(itemId, cols);
    const linePriceNis = await computeLinePrice(RIVHIT_RECEIPT_TYPE, ctx.amount);
    const data = await issueDocument(itemId, ctx, RIVHIT_RECEIPT_TYPE, linePriceNis, {
      payments: [{
        payment_type: RIVHIT_RECEIPT_PAYMENT_TYPE,
        amount_nis: linePriceNis,
      }],
    });
    if (cols.receiptPdfLink && data.document_link) {
      await safeUpdate(boardId, itemId, {
        [cols.receiptPdfLink]: {
          url: data.document_link,
          text: `קבלה #${data.document_number}`,
        },
      });
    }
    console.log(`[bridge] receipt item ${itemId} done: doc #${data.document_number}`);
  } catch (err) {
    await reportError(itemId, err);
  }
}

async function loadContext(itemId, cols) {
  const item = await fetchItemWithCustomerRivhitId(itemId, {
    customerRelationColId: cols.customerRelation,
    customerLibraryRivhitIdColId: cols.customerLibraryRivhitIdCol,
  });
  if (!Number.isFinite(item.customerRivhitId) || item.customerRivhitId <= 0) {
    throw new Error(
      'No Rivhit customer ID found. Make sure the row has a linked customer in "ספריית לקוחות" ' +
      'with a numeric "מספר לקוח ברווחית" filled in.',
    );
  }
  const description = (item.name || '').trim();
  if (!description) {
    throw new Error('Row has no name — Monday item is missing the title used as the line description.');
  }
  const amountText = (findCol(item, cols.amount)?.text || '').trim();
  const amount = parseAmount(amountText);
  if (!Number.isFinite(amount)) {
    throw new Error(`Amount is missing or unparseable (got "${amountText}").`);
  }
  const issueDateText = (findCol(item, cols.issueDate)?.text || '').trim();
  const issueDate = issueDateText ? ymdToDmy(issueDateText) : todayDmy();
  return { item, customerId: item.customerRivhitId, description, amount, issueDate };
}

async function issueDocument(itemId, ctx, docTypeId, linePriceNis, extras = {}) {
  const payload = {
    document_type: docTypeId,
    customer_id: ctx.customerId,
    issue_date: ctx.issueDate,
    items: [{ description: ctx.description, quantity: 1, price_nis: linePriceNis }],
    ...extras,
  };
  console.log(
    `[bridge] Document.New for item ${itemId}, customer ${ctx.customerId}, type ${docTypeId}, preVat ${ctx.amount}, sentPrice ${linePriceNis}`,
  );
  return postRivhit('Document.New', payload);
}

// Cache Rivhit's Document.TypeList so we know per-type whether `price_nis`
// is interpreted as VAT-inclusive (price_include_vat=true) or as the
// pre-VAT amount Rivhit should gross up itself (price_include_vat=false).
// Fresh per process; types rarely change at runtime.
let docTypeListPromise = null;
async function loadDocTypeList() {
  if (!docTypeListPromise) {
    docTypeListPromise = postRivhit('Document.TypeList', {})
      .then((data) => data?.document_type_list || [])
      .catch((err) => {
        docTypeListPromise = null;
        throw err;
      });
  }
  return docTypeListPromise;
}

// Convert the pre-VAT amount from Monday into the value to send as
// items[0].price_nis: gross up by VAT_RATE when the doc type expects
// VAT-inclusive prices, pass through when it doesn't. Fail open
// (no VAT applied) when the type is unknown — clearer to debug the
// wrong total than to silently misbill.
async function computeLinePrice(docTypeId, preVatAmount) {
  let typeList;
  try {
    typeList = await loadDocTypeList();
  } catch (err) {
    console.warn(`[bridge] Document.TypeList lookup failed (assuming exclusive): ${err.message}`);
    return preVatAmount;
  }
  const meta = typeList.find((t) => t.document_type === docTypeId);
  if (!meta) {
    console.warn(`[bridge] doc type ${docTypeId} not in Document.TypeList; sending pre-VAT amount as-is`);
    return preVatAmount;
  }
  if (meta.price_include_vat) {
    return Math.round(preVatAmount * (1 + VAT_RATE) * 100) / 100;
  }
  return preVatAmount;
}

async function reportError(itemId, err) {
  const human = err instanceof RivhitError
    ? `Rivhit: ${err.clientMessage || err.message} (error_code=${err.errorCode})`
    : err.message || String(err);
  console.error(`[bridge] item ${itemId} failed:`, human);
  try {
    await postItemUpdate(itemId, `Rivhit document generation failed:\n${human}`);
  } catch (e) {
    console.error(`[bridge] also failed to post item update for ${itemId}:`, e.message);
  }
}

function parseDocTypeMap(raw) {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [normalizeLabel(k), Number(v)]),
    );
  } catch (e) {
    console.warn('[bridge] DOC_TYPE_MAP is not valid JSON, falling back to {}:', e.message);
    return {};
  }
}

function normalizeLabel(s) {
  return String(s).trim().replace(/\s+/g, ' ');
}

function parseAmount(text) {
  if (!text) return NaN;
  const cleaned = text.replace(/[^\d.\-]/g, '');
  return Number(cleaned);
}

function readColumnEnv() {
  return {
    customerRelation: process.env.COL_CUSTOMER_RELATION,
    customerLibraryRivhitIdCol: process.env.CUSTOMER_LIBRARY_RIVHIT_ID_COL,
    docTypeMirror: process.env.COL_DOC_TYPE_MIRROR,
    issueDate: process.env.COL_ISSUE_DATE,
    amount: process.env.COL_AMOUNT,
    status: process.env.COL_STATUS,
    docNumber: process.env.COL_DOC_NUMBER,
    pdfLink: process.env.COL_PDF_LINK,
    receiptPdfLink: process.env.COL_RECEIPT_PDF_LINK,
    statusDoneLabel: process.env.STATUS_DONE_LABEL,
    statusGeneratingLabel: process.env.STATUS_GENERATING_LABEL,
  };
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
