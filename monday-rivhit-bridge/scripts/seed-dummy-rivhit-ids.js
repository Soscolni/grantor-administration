// One-off: writes a dummy Rivhit customer_id into every customer-library row
// that doesn't already have one. Targets numeric_mm3szn0 on board 5096795864.
// Default is 97 (the demo merchant's default customer id "rivhit זהר").
//
// Usage: node scripts/seed-dummy-rivhit-ids.js [value]

import 'dotenv/config';
import { gql, updateColumns } from '../lib/monday.js';

const CUSTOMER_LIBRARY_BOARD_ID = '5096795864';
const COL_ID = 'numeric_mm3szn0';
const DUMMY = process.argv[2] || '97';

const data = await gql(
  `query {
     boards(ids: ["${CUSTOMER_LIBRARY_BOARD_ID}"]) {
       items_page(limit: 200) {
         items {
           id
           name
           column_values(ids: ["${COL_ID}"]) { id text }
         }
       }
     }
   }`,
  {},
);

const items = data.boards?.[0]?.items_page?.items ?? [];
console.log(`Found ${items.length} customer-library rows. Writing ${COL_ID}=${DUMMY} where empty.\n`);

let written = 0;
let skipped = 0;
for (const it of items) {
  const existing = (it.column_values?.[0]?.text || '').trim();
  if (existing) {
    console.log(`  skip ${it.id} (${it.name}) — already ${existing}`);
    skipped++;
    continue;
  }
  try {
    await updateColumns(CUSTOMER_LIBRARY_BOARD_ID, it.id, { [COL_ID]: DUMMY });
    console.log(`  wrote ${it.id} (${it.name}) ← ${DUMMY}`);
    written++;
  } catch (err) {
    console.error(`  FAILED ${it.id} (${it.name}): ${err.message}`);
  }
}

console.log(`\nDone. wrote=${written}, skipped=${skipped}, total=${items.length}.`);
