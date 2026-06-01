// One-off helper. Prints every column on a board with its id + type so you can
// pick the formula column to read and the number column to write.
//
// Run:  npm run discover-columns -- <board_id>
//
// Requires MONDAY_API_TOKEN in .env. Look for type "formula" (source) and
// type "numbers" (destination).

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
for (const c of board.columns) {
  const flag = c.type === 'formula' ? '  <-- formula (read)' : c.type === 'numbers' ? '  <-- numbers (write)' : '';
  console.log(`  ${c.id.padEnd(28)} ${c.type.padEnd(12)} ${c.title}${flag}`);
}
console.log('\nWire your webhook URL as:');
console.log('  .../monday/webhook/formula-sync?formula=<formulaColId>&target=<numberColId>');
