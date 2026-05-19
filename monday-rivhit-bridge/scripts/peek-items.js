import 'dotenv/config';
import { gql } from '../lib/monday.js';

const boardId = process.argv[2];
if (!boardId) {
  console.error('usage: node scripts/peek-items.js <board_id>');
  process.exit(2);
}

const data = await gql(
  `query($ids: [ID!]) {
     boards(ids: $ids) {
       items_page(limit: 25) {
         items {
           id
           name
           subitems { id name }
         }
       }
     }
   }`,
  { ids: [String(boardId)] },
);

const items = data.boards?.[0]?.items_page?.items ?? [];
if (items.length === 0) {
  console.log('(no rows on the board yet)');
} else {
  console.log(`${items.length} row(s):`);
  for (const it of items) {
    const subs = it.subitems ?? [];
    console.log(`  ${it.id}  "${it.name}"  — ${subs.length} subitem(s)`);
    for (const s of subs) console.log(`      └ ${s.id}  "${s.name}"`);
  }
}
