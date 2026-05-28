// One-off probe: prints Rivhit's full Document.TypeList and the labels on the
// customer-library status column color_mm3q8b5r (אופן דרישת תשלום).
//
// Usage:  node scripts/probe-doc-types.js

import 'dotenv/config';
import { postRivhit } from '../lib/rivhit.js';
import { gql } from '../lib/monday.js';

const CUSTOMER_LIBRARY_BOARD_ID = '5096795864';
const PAYMENT_METHOD_COL = 'color_mm3q8b5r';

console.log('=== Rivhit Document.TypeList ===');
try {
  const data = await postRivhit('Document.TypeList', {});
  const rows = data?.document_types ?? data ?? [];
  if (Array.isArray(rows)) {
    for (const r of rows) {
      console.log(`  ${String(r.document_type ?? r.id ?? '?').padStart(3)}: ${r.description ?? r.name ?? r.document_type_description ?? JSON.stringify(r)}`);
    }
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
} catch (err) {
  console.error('Document.TypeList failed:', err.message);
}

console.log(`\n=== Customer-library status column ${PAYMENT_METHOD_COL} (board ${CUSTOMER_LIBRARY_BOARD_ID}) ===`);
try {
  const data = await gql(
    `query($ids: [ID!], $cids: [String!]) {
       boards(ids: $ids) {
         columns(ids: $cids) { id title type settings_str }
       }
     }`,
    { ids: [CUSTOMER_LIBRARY_BOARD_ID], cids: [PAYMENT_METHOD_COL] },
  );
  const col = data.boards?.[0]?.columns?.[0];
  if (!col) {
    console.log('column not found');
  } else {
    console.log(`title: ${col.title}`);
    const s = JSON.parse(col.settings_str);
    const labels = s.labels || {};
    console.log('labels:');
    for (const [k, v] of Object.entries(labels)) {
      console.log(`  ${k}: ${v}`);
    }
  }
} catch (err) {
  console.error('column probe failed:', err.message);
}
