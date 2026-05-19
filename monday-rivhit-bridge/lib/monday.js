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

// Fetch one item plus its subitems' column values in a single round trip.
export async function fetchItemWithSubitems(itemId) {
  const data = await gql(
    `query($ids: [ID!]) {
       items(ids: $ids) {
         id
         name
         board { id }
         column_values { id text value type }
         subitems {
           id
           name
           board { id }
           column_values { id text value type }
         }
       }
     }`,
    { ids: [String(itemId)] },
  );
  const item = data.items?.[0];
  if (!item) throw new MondayError(`item ${itemId} not found`);
  return item;
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

// Look up a column_value by id from an item's column_values array.
// Returns { text, value, type } or null.
export function findCol(item, columnId) {
  if (!columnId) return null;
  return item.column_values?.find((c) => c.id === columnId) ?? null;
}
