// Thin Monday GraphQL helpers. Copied from monday-rivhit-bridge/lib/monday.js
// and trimmed/extended for this bridge (subitem creation + idempotency read).
// These subdirs are independent apps — we copy a few files rather than import
// across them (see the repo root CLAUDE.md).

const MONDAY_GRAPHQL = 'https://api.monday.com/v2';
// 2025-01 reads formula/mirror columns via display_value and supports
// create_subitem with create_labels_if_missing.
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

// Pull everything processItem needs in one round-trip: the item name, whether
// it already has subitems (idempotency guard), and the grant-type column value.
// Returns the raw item ({ id, name, subitems[], column_values[] }) or null.
export async function fetchItemForProcessing(itemId, grantTypeColId) {
  const data = await gql(
    `query($ids: [ID!], $cids: [String!]) {
       items(ids: $ids) {
         id
         name
         subitems { id }
         column_values(ids: $cids) {
           id type text
           ... on MirrorValue { display_value }
           ... on FormulaValue { display_value }
         }
       }
     }`,
    { ids: [String(itemId)], cids: [String(grantTypeColId)] },
  );
  return data.items?.[0] ?? null;
}

// Create one subitem under a parent item. NOTE: create_subitem takes
// parent_item_id, NOT board_id — Monday routes the row onto the parent's
// subitems board automatically. (create_item would make a top-level row.)
// `columnValues` is a flat { columnId: rawValue } map; a TEXT column takes a
// bare string. create_labels_if_missing is harmless on text and future-proofs
// against the stage column being a status column.
export async function createSubitem(parentItemId, name, columnValues = {}) {
  const data = await gql(
    `mutation($parent: ID!, $name: String!, $vals: JSON!) {
       create_subitem(
         parent_item_id: $parent,
         item_name: $name,
         column_values: $vals,
         create_labels_if_missing: true
       ) { id board { id } }
     }`,
    {
      parent: String(parentItemId),
      name: String(name),
      vals: JSON.stringify(columnValues),
    },
  );
  return { id: data.create_subitem?.id, boardId: data.create_subitem?.board?.id };
}

// Post a comment to the item's updates feed. Used for surfacing skips/errors
// and the success summary.
export async function postItemUpdate(itemId, body) {
  return gql(
    `mutation($itemId: ID!, $body: String!) {
       create_update(item_id: $itemId, body: $body) { id }
     }`,
    { itemId: String(itemId), body: String(body) },
  );
}

// Look up a column_value by id from an item's column_values array.
// Returns the raw column_value object or null.
export function findCol(item, columnId) {
  if (!columnId) return null;
  return item?.column_values?.find((c) => c.id === columnId) ?? null;
}

// Read a column's human-readable value. status/dropdown/text expose it via
// `text`; mirror/formula expose it via `display_value`. Prefer text, fall back
// to display_value (|| so an empty-string text falls through), then trim.
export function readColValue(cv) {
  if (!cv) return '';
  return String(cv.text || cv.display_value || '').trim();
}
