// One-off helper for first-time setup. Two modes:
//
//   npm run discover                         (read-only)
//     Dumps board BOARD_TASKS columns -> find COL_GRANT_TYPE ("סוג המענק"),
//     resolves the subitems board and lists its TEXT columns -> SUBITEM_STAGE_COL.
//
//   npm run discover -- create-stage-col <subitemsBoardId> "Stage"   (writes!)
//     Creates a text column on the subitems board, for when none exists yet.
//     Copy the printed id into SUBITEM_STAGE_COL in .env.
//
// Requires MONDAY_API_TOKEN in .env.

import 'dotenv/config';
import { gql } from '../lib/monday.js';

const [sub, ...rest] = process.argv.slice(2);

if (sub === 'create-stage-col') {
  await createStageCol(rest);
} else {
  await discover();
}

async function discover() {
  const boardId = process.env.BOARD_TASKS || '5098132295';
  const data = await gql(
    `query($ids: [ID!]) {
       boards(ids: $ids) {
         id
         name
         columns { id title type settings_str }
         items_page(limit: 50) {
           items { subitems { board { id name columns { id title type } } } }
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
    const star = c.title === 'סוג המענק' ? '  <-- COL_GRANT_TYPE' : '';
    console.log(`  ${c.id.padEnd(28)} ${c.type.padEnd(12)} ${c.title}${star}`);
  }

  const grant = board.columns.find((c) => c.title === 'סוג המענק');
  if (grant) console.log(`\nCOL_GRANT_TYPE=${grant.id}`);
  else console.log('\n(!) No column titled "סוג המענק" found — set COL_GRANT_TYPE by hand.');

  // Resolve the subitems board. Primary: parse the "subtasks" column's
  // settings_str.boardIds (works even with zero subitems, as long as the
  // Subitems column exists). Fallback: a real subitem's board from items_page.
  let subBoardId = null;
  const subtasksCol = board.columns.find((c) => c.type === 'subtasks');
  if (subtasksCol) {
    try {
      subBoardId = JSON.parse(subtasksCol.settings_str || '{}').boardIds?.[0] ?? null;
    } catch { /* ignore malformed settings_str */ }
  }
  const liveSubBoard = board.items_page?.items
    ?.flatMap((it) => it.subitems ?? [])
    .find((s) => s?.board)?.board;
  if (!subBoardId && liveSubBoard) subBoardId = liveSubBoard.id;

  if (!subBoardId) {
    console.log(
      '\nNo subitems board found. Add a Subitems column (or one subitem) on the board ' +
      'in the Monday UI once, then re-run.',
    );
    return;
  }

  // List the subitems board columns (reuse the live copy if we have it).
  let subColumns = liveSubBoard?.id === subBoardId ? liveSubBoard.columns : null;
  let subName = liveSubBoard?.id === subBoardId ? liveSubBoard.name : '';
  if (!subColumns) {
    const sd = await gql(
      `query($ids: [ID!]) { boards(ids: $ids) { id name columns { id title type } } }`,
      { ids: [String(subBoardId)] },
    );
    subColumns = sd.boards?.[0]?.columns ?? [];
    subName = sd.boards?.[0]?.name ?? '';
  }

  console.log(`\nSubitems board ${subBoardId} — ${subName}`);
  for (const c of subColumns) {
    const star = c.type === 'text' ? '  <-- text (candidate SUBITEM_STAGE_COL)' : '';
    console.log(`  ${c.id.padEnd(28)} ${c.type.padEnd(12)} ${c.title}${star}`);
  }

  const textCols = subColumns.filter((c) => c.type === 'text');
  if (textCols.length === 1) {
    console.log(`\nSUBITEM_STAGE_COL=${textCols[0].id}`);
  } else if (textCols.length === 0) {
    console.log(
      `\nNo text column on the subitems board. Create one:\n` +
      `  npm run discover -- create-stage-col ${subBoardId} "Stage"`,
    );
  } else {
    console.log('\nMultiple text columns — pick the one for "stage" and set SUBITEM_STAGE_COL.');
  }
}

async function createStageCol(args) {
  const [boardId, title] = args;
  if (!boardId || !title) {
    console.error('usage: npm run discover -- create-stage-col <subitemsBoardId> "<title>"');
    process.exit(2);
  }
  const data = await gql(
    `mutation($board: ID!, $title: String!) {
       create_column(board_id: $board, title: $title, column_type: text) { id title type }
     }`,
    { board: String(boardId), title: String(title) },
  );
  const col = data.create_column;
  console.log(`Created text column on board ${boardId}: ${col.id} (${col.title})`);
  console.log(`\nSUBITEM_STAGE_COL=${col.id}`);
}
