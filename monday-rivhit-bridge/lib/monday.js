const MONDAY_GRAPHQL = 'https://api.monday.com/v2';

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
      'API-Version': '2024-10',
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

// Fetch the clicked item, then follow the customer relation to read the
// linked customer's Rivhit numeric ID in a second round-trip.
// Returns the item with `customerRivhitId` (Number, or NaN if missing) added.
export async function fetchItemWithCustomerRivhitId(itemId, {
  customerRelationColId,
  customerLibraryRivhitIdColId,
}) {
  if (!customerRelationColId) {
    throw new MondayError('COL_CUSTOMER_RELATION is not configured');
  }
  const data = await gql(
    `query($ids: [ID!]) {
       items(ids: $ids) {
         id
         name
         board { id }
         column_values {
           id text value type
           ... on BoardRelationValue { linked_item_ids linked_items { id } }
           ... on MirrorValue { display_value }
         }
       }
     }`,
    { ids: [String(itemId)] },
  );
  const item = data.items?.[0];
  if (!item) throw new MondayError(`item ${itemId} not found`);

  // Mirror columns return their value in display_value, not text. Normalize so
  // callers can use findCol(...).text uniformly.
  for (const cv of item.column_values || []) {
    if (cv.type === 'mirror' && cv.display_value != null && !cv.text) {
      cv.text = cv.display_value;
    }
  }

  const rel = item.column_values?.find((c) => c.id === customerRelationColId);
  const linkedId = rel?.linked_item_ids?.[0] ?? rel?.linked_items?.[0]?.id;
  let customerRivhitId = NaN;
  if (linkedId && customerLibraryRivhitIdColId) {
    const linkedData = await gql(
      `query($ids: [ID!], $cids: [String!]) {
         items(ids: $ids) {
           column_values(ids: $cids) { id text value type }
         }
       }`,
      { ids: [String(linkedId)], cids: [customerLibraryRivhitIdColId] },
    );
    const cv = linkedData.items?.[0]?.column_values?.[0];
    const raw = (cv?.text || '').trim();
    customerRivhitId = Number(raw);
  }
  return { ...item, customerRivhitId };
}

// `columnValues` is a flat { columnId: rawValue } map.
// Rules of thumb per column type:
//   - status:    { label: "Done" }    or   { index: 2 }
//   - text:      "plain string"
//   - long_text: { text: "..." }
//   - link:      { url: "...", text: "..." }
//   - numbers:   "42"   (string, not number)
//   - date:      { date: "YYYY-MM-DD" }
//   - dropdown:  { labels: ["..."] }
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

// Post a comment to the item's updates feed. Used for surfacing errors on
// boards that don't have a dedicated "Last Error" column.
export async function postItemUpdate(itemId, body) {
  return gql(
    `mutation($itemId: ID!, $body: String!) {
       create_update(item_id: $itemId, body: $body) { id }
     }`,
    { itemId: String(itemId), body: String(body) },
  );
}

// Look up a column_value by id from an item's column_values array.
// Returns { text, value, type } or null.
export function findCol(item, columnId) {
  if (!columnId) return null;
  return item.column_values?.find((c) => c.id === columnId) ?? null;
}
