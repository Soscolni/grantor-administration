// Per-item discovery: show which links are populated on a row and list the
// columns of every board it connects to. Read-only. Use it to confirm the
// chain פעימה -> הגשה -> הסכם resolves before wiring .env.
//
// Run (token via env keeps it out of shell history):
//   $env:MONDAY_API_TOKEN="<token>"; node monday-commission-bridge/scripts/discover.mjs <ITEM_ID>
//   or: node monday-commission-bridge/scripts/discover.mjs <ITEM_ID> <TOKEN>

const itemId = process.argv[2];
const token = process.argv[3] || process.env.MONDAY_API_TOKEN;
if (!itemId || !token) {
  console.error('usage: node discover.mjs <ITEM_ID> [<TOKEN>]   (or set MONDAY_API_TOKEN)');
  process.exit(2);
}

const API = 'https://api.monday.com/v2';
async function gql(query, variables) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': '2025-01' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

function printColumns(label, columns) {
  console.log(`\n=== ${label} ===`);
  for (const c of columns) console.log(`  ${c.id.padEnd(26)} ${String(c.type).padEnd(16)} ${c.title}`);
}

const d = await gql(
  `query($ids:[ID!]){ items(ids:$ids){ id name
     board{ id name columns{ id title type } }
     column_values{ id type ... on BoardRelationValue{ linked_item_ids } } } }`,
  { ids: [itemId] },
);
const item = d.items?.[0];
if (!item) { console.error(`item ${itemId} not found`); process.exit(1); }

printColumns(`This row's board: ${item.board.name} (${item.board.id})`, item.board.columns);

const rels = (item.column_values || []).filter((c) => c.linked_item_ids?.length);
if (!rels.length) console.log('\n(no connected-board links populated on this row)');
for (const r of rels) {
  const ld = await gql(
    `query($ids:[ID!]){ items(ids:$ids){ id name board{ id name columns{ id title type } } } }`,
    { ids: [String(r.linked_item_ids[0])] },
  );
  const li = ld.items?.[0];
  if (!li) continue;
  console.log(`\n  link column "${r.id}" -> item ${r.linked_item_ids[0]} (${r.linked_item_ids.length} linked)`);
  printColumns(`Linked board: ${li.board.name} (${li.board.id})`, li.board.columns);
}
