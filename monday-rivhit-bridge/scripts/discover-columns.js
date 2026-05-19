// One-off helper. Prints every column (main board + subitem board) for a given
// Monday board so you can paste the IDs into .env.
//
// Run:  npm run discover-columns -- <board_id>
//
// Requires MONDAY_API_TOKEN in .env.

import 'dotenv/config';
import { gql } from '../lib/monday.js';

const boardId = process.argv[2];
if (!boardId) {
  console.error('usage: npm run discover-columns -- <board_id>');
  process.exit(2);
}

const data = await gql(
  `query($ids: [ID!]) {
     boards(ids: $ids) {
       id
       name
       columns { id title type }
       items_page(limit: 50) {
         items {
           subitems {
             board { id name columns { id title type } }
           }
         }
       }
     }
   }`,
  { ids: [String(boardId)] },
);

const board = data.boards?.[0];
if (!board) {
  console.error(`No board found for id ${boardId}.`);
  process.exit(1);
}

console.log(`\nBoard ${board.id} — ${board.name}`);
console.log('Main columns:');
for (const c of board.columns) {
  console.log(`  ${c.id.padEnd(28)} ${c.type.padEnd(12)} ${c.title}`);
}

// Find the first row that actually has a subitem so we can fetch the
// subitem-board's columns. The first row on a board may have zero subitems.
const subBoard = board.items_page?.items
  ?.flatMap((it) => it.subitems ?? [])
  .find((s) => s?.board)?.board;

if (subBoard) {
  console.log(`\nSubitem board ${subBoard.id} — ${subBoard.name}`);
  for (const c of subBoard.columns) {
    console.log(`  ${c.id.padEnd(28)} ${c.type.padEnd(12)} ${c.title}`);
  }
} else {
  console.log('\nNo subitems exist yet on this board — add at least one row with one subitem, then re-run.');
}
