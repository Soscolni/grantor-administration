// Probe whether Rivhit customer_id == ח.פ for this account.
// Reads the customer-library board's ח.פ column, then calls Rivhit
// Customer.Get(customer_id=<ח.פ>) for each and reports whether it matches.
//
// Usage: node scripts/probe-customer-id-shape.js

import 'dotenv/config';
import { postRivhit } from '../lib/rivhit.js';
import { gql } from '../lib/monday.js';

const CUSTOMER_LIBRARY_BOARD_ID = '5096795864';
const HOFAL_COL_ID = 'text_mm3hbgwa'; // ח.פ
const SAMPLE_SIZE = 5;

const data = await gql(
  `query($ids: [ID!]) {
     boards(ids: $ids) {
       items_page(limit: ${SAMPLE_SIZE}) {
         items {
           id
           name
           column_values(ids: ["${HOFAL_COL_ID}"]) { id text }
         }
       }
     }
   }`,
  { ids: [CUSTOMER_LIBRARY_BOARD_ID] },
);

const items = data.boards?.[0]?.items_page?.items ?? [];
if (!items.length) {
  console.log('No items found on customer-library board.');
  process.exit(0);
}

console.log(`Probing ${items.length} customer-library record(s)…\n`);

for (const it of items) {
  const hp = (it.column_values?.[0]?.text || '').trim();
  console.log(`Monday item ${it.id} — ${it.name}`);
  console.log(`  ח.פ on Monday: "${hp}"`);
  if (!hp) {
    console.log('  (no ח.פ filled in — skipping Rivhit lookup)\n');
    continue;
  }
  const hpNum = Number(hp.replace(/\D/g, ''));
  // Try Customer.Get with customer_id = ח.פ.
  try {
    const cust = await postRivhit('Customer.Get', { customer_id: hpNum });
    console.log(`  Customer.Get(customer_id=${hpNum}) -> OK`);
    console.log(`    customer_id   = ${cust.customer_id}`);
    console.log(`    id_number     = ${cust.id_number}`);
    console.log(`    first_name    = ${cust.first_name}`);
    console.log(`    last_name     = ${cust.last_name}`);
    console.log(`    customer_name = ${cust.customer_name}`);
  } catch (e) {
    console.log(`  Customer.Get(customer_id=${hpNum}) -> FAIL: ${e.message}`);
  }
  console.log();
}
