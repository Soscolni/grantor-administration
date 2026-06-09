// Read a tab from a public (link-shared) Google Sheet as CSV via the gviz
// export endpoint. No googleapis, no credentials — just built-in fetch, per the
// repo's "no framework / minimal deps" rule. The sheet must be shared as
// "anyone with the link can view" for this to work.

export class SheetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SheetError';
  }
}

// gviz CSV export for a single named tab. encodeURIComponent is required —
// tab names can contain spaces or Hebrew (grant-type values).
export const gvizUrl = (sheetId, tabName) =>
  `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`;

// Exact header labels (trimmed, case-insensitive) that mark a header row. Exact
// match — NOT substring — so a data value like "Stage 1" or "שלב ראשון" is never
// mistaken for a header. Add real header spellings here if a tab uses others.
const STAGE_HEADERS = new Set(['stage', 'status', 'שלב', 'סטטוס']);
const DESC_HEADERS = new Set([
  'task', 'tasks', 'task description', 'description', 'desc',
  'תיאור', 'תיאור המשימה', 'משימה', 'משימות', 'פירוט', 'פירוט המשימה',
]);
const normHeader = (s) => String(s).trim().toLowerCase();

// Hand-rolled RFC-4180-ish parser: handles quoted fields, embedded commas,
// doubled quotes ("") and CRLF/LF. Never split(',') — task descriptions
// contain commas. Returns an array of rows, each an array of string cells.
export function parseCsv(text) {
  const s = String(text);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; } // escaped quote
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === ',') { row.push(field); field = ''; i += 1; continue; }
    if (ch === '\r') { i += 1; continue; } // normalize CRLF -> LF
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += ch; i += 1;
  }
  // Flush the trailing field/row unless the input ended on a newline that
  // already pushed it.
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Map raw CSV rows to [{ stage, description }].
// Column order: if the first row is a recognizable header (a stage label in one
// column AND a description label in a different column), map by those columns and
// skip it. Otherwise fall back to col0 = stage, col1 = description (DOCUMENTED
// ASSUMPTION — confirm against the real sheet; flip the indices below if it's
// description-first). A task needs a non-empty description (= the subitem name).
export function pickColumns(rows) {
  const nonEmpty = rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  if (nonEmpty.length === 0) return [];

  const header = nonEmpty[0];
  const sIdx = header.findIndex((c) => STAGE_HEADERS.has(normHeader(c)));
  const dIdx = header.findIndex((c) => DESC_HEADERS.has(normHeader(c)));
  const hasHeader = sIdx !== -1 && dIdx !== -1 && sIdx !== dIdx;

  const stageIdx = hasHeader ? sIdx : 0;
  const descIdx = hasHeader ? dIdx : 1;
  const dataRows = hasHeader ? nonEmpty.slice(1) : nonEmpty;

  const tasks = [];
  for (const r of dataRows) {
    const description = String(r[descIdx] ?? '').trim();
    const stage = String(r[stageIdx] ?? '').trim();
    if (!description) continue;
    tasks.push({ stage, description });
  }
  return tasks;
}

// Fetch a tab and return its tasks. Throws SheetError on a missing tab or a
// non-shared sheet (gviz answers those with HTTP 200 + an HTML body rather than
// a clean 404), so the caller can post a friendly note and create nothing.
export async function fetchTasksFromSheet(sheetId, tabName) {
  const url = gvizUrl(sheetId, tabName);
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (err) {
    throw new SheetError(`לא ניתן להתחבר לגיליון Google: ${err.message}`);
  }
  const body = await res.text();
  const ct = res.headers.get('content-type') || '';
  if (!res.ok || ct.includes('text/html') || body.trimStart().startsWith('<')) {
    throw new SheetError(
      `לא ניתן לקרוא את הלשונית "${tabName}". ודא שהלשונית קיימת ושהגיליון משותף לצפייה (anyone with the link).`,
    );
  }
  return pickColumns(parseCsv(body));
}
