import 'dotenv/config';
import { gql } from '../lib/monday.js';

const boardId = process.argv[2];
if (!boardId) {
  console.error('usage: node scripts/inspect-board.js <board_id>');
  process.exit(2);
}

const data = await gql(
  `query($ids: [ID!]) {
     boards(ids: $ids) {
       id
       name
       columns { id title type settings_str }
     }
   }`,
  { ids: [String(boardId)] },
);

const board = data.boards?.[0];
if (!board) {
  console.error('not found');
  process.exit(1);
}

console.log(`Board ${board.id} — ${board.name}`);
for (const c of board.columns) {
  console.log(`\n${c.id}  (${c.type})  ${c.title}`);
  if (c.type === 'status' || c.type === 'dropdown') {
    try {
      const settings = JSON.parse(c.settings_str || '{}');
      if (c.type === 'status') {
        const labels = settings.labels || {};
        for (const [idx, label] of Object.entries(labels)) {
          console.log(`    [${idx}] ${label}`);
        }
      } else if (c.type === 'dropdown') {
        const labels = settings.labels || [];
        for (const l of labels) console.log(`    ${l.id ?? '?'}: ${l.name}`);
      }
    } catch (e) {
      console.log('    (could not parse settings_str)');
    }
  }
}
