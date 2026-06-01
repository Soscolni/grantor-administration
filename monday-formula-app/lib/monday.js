// Monday GraphQL helper for the app.
//
// Differs from monday-formula-sync/lib/monday.js in one way: every call takes a
// `token` argument (the per-request shortLivedToken from the JWT) instead of
// reading MONDAY_API_TOKEN from the environment. The app authenticates *as the
// user who triggered the recipe*, so there's no shared personal token.
//
// API-Version is still pinned to 2025-01 — the first version where formula
// columns expose their computed value via FormulaValue.display_value.
const MONDAY_GRAPHQL = 'https://api.monday.com/v2';
const MONDAY_API_VERSION = '2025-01';

export async function gql(token, query, variables = {}) {
  if (!token) throw new Error('no Monday token for this request');
  const res = await fetch(MONDAY_GRAPHQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: token,
      'API-Version': MONDAY_API_VERSION,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) {
    throw new Error(json.errors?.[0]?.message || `Monday GraphQL ${res.status}`);
  }
  return json.data;
}

// Read one item's selected columns. Formula columns surface their computed
// value in display_value, so we ask for the FormulaValue fragment explicitly.
export async function fetchItem(token, itemId, colIds) {
  const data = await gql(
    token,
    `query($ids: [ID!], $cids: [String!]) {
       items(ids: $ids) {
         id
         name
         board { id }
         column_values(ids: $cids) {
           id
           type
           text
           ... on FormulaValue { display_value }
           ... on MirrorValue { display_value }
         }
       }
     }`,
    { ids: [String(itemId)], cids: colIds.map(String) },
  );
  const item = data.items?.[0];
  if (!item) throw new Error(`item ${itemId} not found`);
  return item;
}

// Write columns. For a number column the value is a plain numeric string.
export async function updateColumns(token, boardId, itemId, columnValues) {
  return gql(
    token,
    `mutation($boardId: ID!, $itemId: ID!, $vals: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $vals) {
         id
       }
     }`,
    { boardId: String(boardId), itemId: String(itemId), vals: JSON.stringify(columnValues) },
  );
}

// Best-effort: surface a human-readable reason on the item's updates feed.
export async function postItemUpdate(token, itemId, body) {
  return gql(
    token,
    `mutation($itemId: ID!, $body: String!) {
       create_update(item_id: $itemId, body: $body) { id }
     }`,
    { itemId: String(itemId), body: String(body) },
  );
}

// List a board's columns — backs the remote-options dropdowns in the recipe.
export async function listColumns(token, boardId) {
  const data = await gql(
    token,
    `query($ids: [ID!]) {
       boards(ids: $ids) { columns { id title type } }
     }`,
    { ids: [String(boardId)] },
  );
  return data.boards?.[0]?.columns ?? [];
}

export function findCol(item, columnId) {
  if (!columnId) return null;
  return item.column_values?.find((c) => c.id === columnId) ?? null;
}

export function readColValue(cv) {
  if (!cv) return '';
  return (cv.display_value ?? cv.text ?? '').trim();
}
