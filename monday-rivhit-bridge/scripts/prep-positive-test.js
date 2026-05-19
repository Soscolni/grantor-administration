// One-off: prepare a Monday row for a positive end-to-end test.
//
// Sets the Document Type dropdown on the parent row and fills Qty/Price NIS
// on each subitem. Idempotent — re-running is fine.
//
//   node scripts/prep-positive-test.js <item_id>

import 'dotenv/config';
import { fetchItemWithSubitems, updateColumns } from '../lib/monday.js';

const itemId = process.argv[2];
if (!itemId) {
  console.error('usage: node scripts/prep-positive-test.js <item_id>');
  process.exit(2);
}

const item = await fetchItemWithSubitems(itemId);
const parentBoardId = item.board.id;

await updateColumns(parentBoardId, item.id, {
  [process.env.COL_DOC_TYPE]: { labels: ['8 / חשבון עסקה'] },
});
console.log(`parent ${item.id} -> Document Type set to "8 / חשבון עסקה"`);

for (const [i, sub] of (item.subitems ?? []).entries()) {
  const subBoardId = sub.board.id;
  await updateColumns(subBoardId, sub.id, {
    [process.env.SUBCOL_QTY]: '1',
    [process.env.SUBCOL_PRICE]: String(100 + i * 50),
  });
  console.log(`  subitem ${sub.id} "${sub.name}" -> qty=1 price=${100 + i * 50}`);
}
