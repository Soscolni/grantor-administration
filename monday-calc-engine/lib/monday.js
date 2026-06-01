// Monday GraphQL adapter (token-per-call) for the calc engine.
// API-Version 2025-01 so mirror/formula columns expose display_value — that's
// what lets us feed mirror/linked values into the calculations.
const MONDAY_GRAPHQL = 'https://api.monday.com/v2';
const MONDAY_API_VERSION = '2025-01';

const COLUMN_VALUE_FRAGMENT = `
  id
  type
  text
  ... on BoardRelationValue { linked_item_ids }
  ... on FormulaValue { display_value }
  ... on MirrorValue { display_value }
`;

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

// Full item with all column values (incl. relation linked ids + mirror/formula
// display values).
export async function fetchItem(token, itemId) {
  const data = await gql(
    token,
    `query($ids: [ID!]) {
       items(ids: $ids) {
         id name board { id }
         column_values { ${COLUMN_VALUE_FRAGMENT} }
       }
     }`,
    { ids: [String(itemId)] },
  );
  const item = data.items?.[0];
  if (!item) throw new Error(`item ${itemId} not found`);
  return item;
}

// Selected columns of several items at once — used to read a source column on
// linked items reached through a connection.
export async function fetchItemsColumns(token, itemIds, colIds) {
  if (itemIds.length === 0) return [];
  const data = await gql(
    token,
    `query($ids: [ID!], $cids: [String!]) {
       items(ids: $ids) {
         id name board { id }
         column_values(ids: $cids) { ${COLUMN_VALUE_FRAGMENT} }
       }
     }`,
    { ids: itemIds.map(String), cids: colIds.map(String) },
  );
  return data.items ?? [];
}

// Subitems of an item, in board order — one "row" per installment.
export async function fetchSubitems(token, itemId) {
  const data = await gql(
    token,
    `query($ids: [ID!]) {
       items(ids: $ids) {
         subitems {
           id name board { id }
           column_values { ${COLUMN_VALUE_FRAGMENT} }
         }
       }
     }`,
    { ids: [String(itemId)] },
  );
  return data.items?.[0]?.subitems ?? [];
}

export async function listColumns(token, boardId) {
  const data = await gql(
    token,
    `query($ids: [ID!]) { boards(ids: $ids) { columns { id title type } } }`,
    { ids: [String(boardId)] },
  );
  return data.boards?.[0]?.columns ?? [];
}

export async function updateColumns(token, boardId, itemId, columnValues) {
  return gql(
    token,
    `mutation($boardId: ID!, $itemId: ID!, $vals: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $vals) { id }
     }`,
    { boardId: String(boardId), itemId: String(itemId), vals: JSON.stringify(columnValues) },
  );
}

export function findCol(item, columnId) {
  if (!columnId) return null;
  return item.column_values?.find((c) => c.id === columnId) ?? null;
}

// A column's effective value: mirror/formula use display_value, others text.
export function readColValue(cv) {
  if (!cv) return '';
  return (cv.display_value ?? cv.text ?? '').trim();
}

export function parseNumber(text) {
  if (typeof text === 'number') return text;
  if (!text) return NaN;
  const cleaned = String(text).replace(/[^\d.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return NaN;
  return Number(cleaned);
}
