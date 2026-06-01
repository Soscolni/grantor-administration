// Thin Monday GraphQL helper for monday-formula-sync.
//
// Copied (not imported) from monday-rivhit-bridge per the repo convention that
// each automation is self-contained. Trimmed to just what this webhook needs:
// read a formula column's computed value and write a number column back.
//
// NOTE: API-Version is pinned to 2025-01 — that's the first version where
// formula columns expose their computed value via `... on FormulaValue
// { display_value }`. On older versions formula columns return empty text and
// this whole automation is impossible.
//   https://developer.monday.com/api-reference/changelog/new-ability-to-read-the-formula-column
const MONDAY_GRAPHQL = 'https://api.monday.com/v2';
const MONDAY_API_VERSION = '2025-01';

export class MondayError extends Error {
  constructor(message, { status, errors } = {}) {
    super(message);
    this.name = 'MondayError';
    this.status = status;
    this.errors = errors;
  }
}

export async function gql(query, variables = {}) {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) throw new Error('MONDAY_API_TOKEN is not set');
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
    throw new MondayError(
      json.errors?.[0]?.message || `Monday GraphQL ${res.status}`,
      { status: res.status, errors: json.errors },
    );
  }
  return json.data;
}

// Fetch one item's selected column values. Formula columns surface their
// computed value in `display_value`, not `text`/`value`, so we ask for the
// FormulaValue fragment explicitly. (MirrorValue is included too so a "formula"
// that's really a mirror still resolves to something readable.)
//
// `colIds` should list only the formula columns you want to read — Monday caps
// formula reads at 5 columns per request.
export async function fetchItem(itemId, colIds) {
  const data = await gql(
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
  if (!item) throw new MondayError(`item ${itemId} not found`);
  return item;
}

// `columnValues` is a flat { columnId: rawValue } map. For a number column the
// raw value is a plain numeric string, e.g. { numeric_abc: "1234.56" }.
export async function updateColumns(boardId, itemId, columnValues) {
  return gql(
    `mutation($boardId: ID!, $itemId: ID!, $vals: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $vals) {
         id
       }
     }`,
    {
      boardId: String(boardId),
      itemId: String(itemId),
      vals: JSON.stringify(columnValues),
    },
  );
}

// Post a comment to the item's updates feed — used to surface a clear,
// human-readable reason when a sync can't complete.
export async function postItemUpdate(itemId, body) {
  return gql(
    `mutation($itemId: ID!, $body: String!) {
       create_update(item_id: $itemId, body: $body) { id }
     }`,
    { itemId: String(itemId), body: String(body) },
  );
}

// Look up a column_value by id from an item's column_values array.
export function findCol(item, columnId) {
  if (!columnId) return null;
  return item.column_values?.find((c) => c.id === columnId) ?? null;
}

// Read a column's effective value: formula/mirror columns use display_value,
// everything else uses text.
export function readColValue(cv) {
  if (!cv) return '';
  return (cv.display_value ?? cv.text ?? '').trim();
}
