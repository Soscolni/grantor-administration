// Thin Monday GraphQL helper for monday-commission-bridge.
//
// Env-token style (one MONDAY_API_TOKEN for the whole bridge), matching
// monday-rivhit-bridge. API-Version 2025-01 — but note this bridge deliberately
// reads only RAW number + board_relation columns, never formula/mirror values,
// so the formula-read limitation never applies.
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

const COLUMN_VALUE_FRAGMENT = `
  id
  type
  text
  ... on BoardRelationValue { linked_item_ids }
  ... on MirrorValue { display_value }
  ... on FormulaValue { display_value }
`;

// Fetch one or more items. Pass colIds to limit to specific columns (cheaper),
// or omit to get them all. Returns the items array (each with column_values).
export async function fetchItems(itemIds, colIds = null) {
  const ids = itemIds.filter(Boolean).map(String);
  if (ids.length === 0) return [];
  const filter = colIds && colIds.length ? '(ids: $cids)' : '';
  const data = await gql(
    `query($ids: [ID!]${colIds && colIds.length ? ', $cids: [String!]' : ''}) {
       items(ids: $ids) {
         id
         name
         board { id }
         column_values${filter} { ${COLUMN_VALUE_FRAGMENT} }
       }
     }`,
    colIds && colIds.length
      ? { ids, cids: colIds.filter(Boolean).map(String) }
      : { ids },
  );
  return data.items ?? [];
}

// Create a new item on a board. `columnValues` is a flat { columnId: rawValue }
// map (a number column takes a plain numeric string). Returns the new item id.
export async function createItem(boardId, name, columnValues = {}) {
  const data = await gql(
    `mutation($boardId: ID!, $name: String!, $vals: JSON!) {
       create_item(board_id: $boardId, item_name: $name, column_values: $vals) { id }
     }`,
    { boardId: String(boardId), name: String(name), vals: JSON.stringify(columnValues) },
  );
  return data.create_item?.id;
}

export async function updateColumns(boardId, itemId, columnValues) {
  return gql(
    `mutation($boardId: ID!, $itemId: ID!, $vals: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $vals) { id }
     }`,
    { boardId: String(boardId), itemId: String(itemId), vals: JSON.stringify(columnValues) },
  );
}

// Post a comment to an item's updates feed — used for traceability and to
// surface errors on the row.
export async function postItemUpdate(itemId, body) {
  return gql(
    `mutation($itemId: ID!, $body: String!) {
       create_update(item_id: $itemId, body: $body) { id }
     }`,
    { itemId: String(itemId), body: String(body) },
  );
}

export function findCol(item, columnId) {
  if (!columnId) return null;
  return item?.column_values?.find((c) => c.id === columnId) ?? null;
}

// A column's effective value. Real columns use `text`; we still fall back to
// display_value defensively, but the bridge is configured to point only at raw
// number/relation columns.
export function readColValue(cv) {
  if (!cv) return '';
  return (cv.text ?? cv.display_value ?? '').trim();
}

export function parseNumber(text) {
  if (typeof text === 'number') return text;
  if (!text) return NaN;
  const cleaned = String(text).replace(/[^\d.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return NaN;
  return Number(cleaned);
}

// First linked item id from a board_relation column value, or null.
export function firstLinkedId(item, relationColId) {
  return findCol(item, relationColId)?.linked_item_ids?.[0] ?? null;
}

// All linked item ids from a board_relation column value.
export function linkedIds(item, relationColId) {
  return findCol(item, relationColId)?.linked_item_ids ?? [];
}
