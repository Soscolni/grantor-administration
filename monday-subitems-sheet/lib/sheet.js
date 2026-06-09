// Read a tab from a public (link-shared) Google Sheet as CSV. No googleapis, no
// credentials — just built-in fetch, per the repo's "no framework / minimal deps"
// rule. The sheet must be shared as "anyone with the link can view".
//
// IMPORTANT: the gviz/export `sheet=<name>` parameter is UNRELIABLE for an
// unknown tab name — Google silently serves the FIRST sheet instead of erroring.
// So we never address a tab by name: we list the real tabs (name -> gid) from the
// htmlview page, fail if the requested tab is missing, and fetch the exact tab by
// gid. Addressing by gid is reliable (a bad gid 400s).

export class SheetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SheetError';
  }
}

// CSV export of one tab, addressed by gid (reliable, unlike sheet=<name>).
export const csvUrl = (sheetId, gid) =>
  `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;

const htmlviewUrl = (sheetId) =>
  `https://docs.google.com/spreadsheets/d/${sheetId}/htmlview`;

// Exact header labels (trimmed, case-insensitive) that mark a header row. Exact
// match — NOT substring — so a data value like "Stage 1" or "שלב ראשון" is never
// mistaken for a header. Add real header spellings here if a tab uses others.
const STAGE_HEADERS = new Set(['stage', 'status', 'שלב', 'סטטוס']);
const DESC_HEADERS = new Set([
  'task', 'tasks', 'task description', 'description', 'desc',
  'תיאור', 'תיאור המשימה', 'משימה', 'משימות', 'פירוט', 'פירוט המשימה',
]);
const normHeader = (s) => String(s).trim().toLowerCase();

// Decode the few escape sequences Google uses inside the htmlview JS strings
// (\/ \" \\ plus \xXX / \uXXXX), so tab names come out clean.
function decodeJsString(s) {
  return String(s)
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(["/\\])/g, '$1');
}

// Parse a tab name -> gid map from a Google Sheets htmlview page. The page embeds
// one `items.push({name: "Pre-Seed", pageUrl: "...gid=0", gid: "0", ...})` per tab.
// Pure (no network) so it's unit-testable. Returns Map<name, gid>.
export function parseTabsFromHtml(html) {
  const map = new Map();
  const re = /items\.push\(\{\s*name:\s*"((?:[^"\\]|\\.)*)"[^}]*?gid:\s*"(\d+)"/g;
  let m;
  while ((m = re.exec(String(html))) !== null) {
    map.set(decodeJsString(m[1]), m[2]);
  }
  return map;
}

// Fetch + parse the live tab list. Throws SheetError if the sheet isn't readable
// or no tabs parse (fail closed — never guess which sheet to use).
export async function listTabs(sheetId) {
  let res;
  try {
    res = await fetch(htmlviewUrl(sheetId), { redirect: 'follow' });
  } catch (err) {
    throw new SheetError(`לא ניתן להתחבר לגיליון Google: ${err.message}`);
  }
  const html = await res.text();
  if (!res.ok) {
    throw new SheetError(
      `לא ניתן לקרוא את הגיליון (HTTP ${res.status}). ודא שהוא משותף לצפייה (anyone with the link).`,
    );
  }
  const tabs = parseTabsFromHtml(html);
  if (tabs.size === 0) {
    throw new SheetError(
      'לא ניתן לקרוא את רשימת הלשוניות בגיליון. ודא שהוא משותף לצפייה (anyone with the link).',
    );
  }
  return tabs;
}

// Resolve a tab name to its gid: exact match, then a trimmed/case-insensitive
// convenience match. Throws SheetError (listing the tabs that DO exist) if missing.
function resolveGid(tabs, tabName) {
  if (tabs.has(tabName)) return tabs.get(tabName);
  const want = String(tabName).trim().toLowerCase();
  for (const [name, gid] of tabs) {
    if (name.trim().toLowerCase() === want) return gid;
  }
  throw new SheetError(
    `לא נמצאה לשונית בשם "${tabName}" בגיליון. לשוניות קיימות: ${[...tabs.keys()].join(', ')}.`,
  );
}

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

// Fetch a tab's tasks by name. Lists the real tabs, errors if the requested one
// is missing (SheetError, listing existing tabs), else fetches that exact tab by
// gid. SheetError → the caller posts a friendly note and creates nothing.
export async function fetchTasksFromSheet(sheetId, tabName) {
  const tabs = await listTabs(sheetId);
  const gid = resolveGid(tabs, tabName);
  let res;
  try {
    res = await fetch(csvUrl(sheetId, gid), { redirect: 'follow' });
  } catch (err) {
    throw new SheetError(`לא ניתן להוריד את הלשונית "${tabName}": ${err.message}`);
  }
  const body = await res.text();
  const ct = res.headers.get('content-type') || '';
  if (!res.ok || ct.includes('text/html') || body.trimStart().startsWith('<')) {
    throw new SheetError(`לא ניתן לקרוא את הלשונית "${tabName}" (gid ${gid}).`);
  }
  return pickColumns(parseCsv(body));
}
