// One-off probe for the production board on grantor-force.monday.com.
// Reports: status column labels, board_relation target board + a sample of its
// columns, and a sample row's column values. Read-only.
//
// Usage:  node scripts/probe-prod-board.js <board_id>

import 'dotenv/config';
import { gql } from '../lib/monday.js';

const boardId = process.argv[2];
if (!boardId) {
  console.error('usage: node scripts/probe-prod-board.js <board_id>');
  process.exit(2);
}

const data = await gql(
  `query($ids: [ID!]) {
     boards(ids: $ids) {
       id
       name
       columns { id title type settings_str }
       items_page(limit: 3) {
         items {
           id
           name
           column_values {
             id
             type
             text
             value
             ... on BoardRelationValue {
               linked_item_ids
               linked_items { id name board { id name } }
             }
             ... on MirrorValue {
               display_value
             }
             ... on StatusValue {
               label
             }
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

console.log(`Board ${board.id} — ${board.name}\n`);

const statusCol = board.columns.find((c) => c.type === 'status');
if (statusCol) {
  console.log(`Status column: ${statusCol.id}  (${statusCol.title})`);
  try {
    const s = JSON.parse(statusCol.settings_str);
    const labels = s.labels || {};
    console.log('  labels:');
    for (const [k, v] of Object.entries(labels)) {
      console.log(`    ${k}: ${v}`);
    }
  } catch (e) {
    console.log(`  (could not parse settings_str: ${e.message})`);
  }
  console.log();
}

const relCol = board.columns.find((c) => c.type === 'board_relation');
if (relCol) {
  console.log(`Board-relation column: ${relCol.id}  (${relCol.title})`);
  try {
    const s = JSON.parse(relCol.settings_str);
    console.log(`  linked board ids: ${JSON.stringify(s.boardIds)}`);
  } catch (e) {
    console.log(`  (could not parse settings_str: ${e.message})`);
  }
  console.log();
}

const mirrorCols = board.columns.filter((c) => c.type === 'mirror');
for (const m of mirrorCols) {
  console.log(`Mirror column: ${m.id}  (${m.title})`);
  try {
    const s = JSON.parse(m.settings_str);
    console.log(`  mirrors column: ${s.relation_column ? Object.keys(s.relation_column).join(',') : '(no relation_column)'} / linked column ${s.displayed_column_id || JSON.stringify(s.displayed_linked_columns) || '?'}`);
  } catch (e) {
    console.log(`  (could not parse settings_str: ${e.message})`);
  }
  console.log();
}

console.log('Sample items:');
for (const it of board.items_page?.items ?? []) {
  console.log(`  - ${it.id} — ${it.name}`);
  for (const cv of it.column_values) {
    const extras = [];
    if (cv.linked_items?.length) {
      extras.push(`linked: ${cv.linked_items.map((l) => `${l.id}@board${l.board?.id}:"${l.name}"`).join(', ')}`);
    }
    if (cv.display_value !== undefined) extras.push(`displayed: "${cv.display_value}"`);
    if (cv.label !== undefined && cv.label !== null) extras.push(`label: "${cv.label}"`);
    if (cv.text) extras.push(`text: "${cv.text}"`);
    const extra = extras.length ? `  [${extras.join(' | ')}]` : '';
    console.log(`      ${cv.id.padEnd(28)} ${cv.type.padEnd(14)}${extra}`);
  }
}

// If we found a linked customer-library item, fetch that board's columns too.
const sampleRel = board.items_page?.items
  ?.flatMap((it) => it.column_values)
  ?.find((cv) => cv.linked_items?.length);
if (sampleRel) {
  const linkedBoardId = sampleRel.linked_items[0]?.board?.id;
  if (linkedBoardId) {
    console.log(`\nFetching linked board ${linkedBoardId}…`);
    const d2 = await gql(
      `query($ids: [ID!]) {
         boards(ids: $ids) {
           id name
           columns { id title type }
         }
       }`,
      { ids: [String(linkedBoardId)] },
    );
    const lb = d2.boards?.[0];
    if (lb) {
      console.log(`Linked board ${lb.id} — ${lb.name}`);
      for (const c of lb.columns) {
        console.log(`  ${c.id.padEnd(28)} ${c.type.padEnd(14)} ${c.title}`);
      }
    }
  }
}
