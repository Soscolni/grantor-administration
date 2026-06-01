// Dump columns (id / title / type) for one or more boards, so we can map the
// commission data model precisely. Read-only.
//
// Run (token via env keeps it out of shell history):
//   $env:MONDAY_API_TOKEN="<token>"; node monday-commission-bridge/scripts/discover-boards.mjs <boardId> [<boardId> ...]

const boardIds = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
const token = process.env.MONDAY_API_TOKEN;
if (!boardIds.length || !token) {
  console.error('usage: $env:MONDAY_API_TOKEN="<token>"; node discover-boards.mjs <boardId> [<boardId> ...]');
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

const data = await gql(
  `query($ids:[ID!]){ boards(ids:$ids){ id name columns{ id title type } } }`,
  { ids: boardIds },
);

for (const b of data.boards || []) {
  console.log(`\n=== ${b.name} (board ${b.id}) ===`);
  for (const c of b.columns) {
    // Flag the column types that matter for wiring: links and raw numbers.
    const flag = c.type === 'board_relation' ? '   <-- connects boards'
      : c.type === 'numbers' ? '   <-- raw number'
      : (c.type === 'formula' || c.type === 'mirror' || c.type === 'lookup') ? '   (computed — NOT read by the bridge)'
      : '';
    console.log(`  ${c.id.padEnd(26)} ${String(c.type).padEnd(16)} ${c.title}${flag}`);
  }
}
