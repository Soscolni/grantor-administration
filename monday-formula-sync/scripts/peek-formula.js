// Verify the API can actually read a formula column's value BEFORE you wire up
// the webhook. Formula reads are finicky (mirror/connected-board formulas come
// back empty), so confirm the value here first.
//
// Run:  node scripts/peek-formula.js <item_id> [<colId> ...]
//   - with col ids: prints those columns' values (uses the same fragment the
//     server does).
//   - without col ids: prints every column, so you can spot the formula one and
//     see whether its display_value is populated.

import 'dotenv/config';
import { gql, readColValue } from '../lib/monday.js';

const itemId = process.argv[2];
const colIds = process.argv.slice(3);
if (!itemId) {
  console.error('usage: node scripts/peek-formula.js <item_id> [<colId> ...]');
  process.exit(2);
}

const filter = colIds.length ? '(ids: $cids)' : '';
const data = await gql(
  `query($ids: [ID!]${colIds.length ? ', $cids: [String!]' : ''}) {
     items(ids: $ids) {
       id
       name
       board { id }
       column_values${filter} {
         id
         type
         text
         ... on FormulaValue { display_value }
         ... on MirrorValue { display_value }
       }
     }
   }`,
  colIds.length
    ? { ids: [String(itemId)], cids: colIds.map(String) }
    : { ids: [String(itemId)] },
);

const item = data.items?.[0];
if (!item) {
  console.error(`item ${itemId} not found`);
  process.exit(1);
}

console.log(`\nItem ${item.id} — ${item.name}  (board ${item.board?.id})`);
for (const cv of item.column_values || []) {
  const val = readColValue(cv);
  console.log(`  ${cv.id.padEnd(28)} ${cv.type.padEnd(12)} ${val === '' ? '(empty)' : val}`);
}
