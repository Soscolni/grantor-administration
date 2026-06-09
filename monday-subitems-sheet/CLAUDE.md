# monday-subitems-sheet

Bridges Monday.com → a Google Sheet. When someone clicks a **Button column** on a row in board
[5098132295](https://grantor-force.monday.com/boards/5098132295), this service reads the row's
**"סוג המענק"** (grant type) value, opens the same-named **tab** in a Google Sheet, and creates one
**subitem** per task row: the **task description** becomes the subitem name and the **stage** is written
into a text column on the subitem.

No frontend — this is a webhook receiver. The day-to-day UI is the Monday board itself. It follows the
sibling `monday-rivhit-bridge` pattern (Express webhook + personal `MONDAY_API_TOKEN` + GraphQL,
Railway-deployed); `lib/monday.js` is copied from there and trimmed.

The Google Sheet is read with **zero dependencies** via the public gviz CSV endpoint — no `googleapis`,
no service account. This requires the sheet to stay shared as **"anyone with the link can view."**

---

## Run

```
cd monday-subitems-sheet
npm install
cp .env.example .env          # then fill in MONDAY_API_TOKEN + the two column IDs
npm test                      # parser unit tests (no network)
npm start                     # listens on PORT (default 3003)

# In another shell, expose it to Monday:
ngrok http 3003               # or: cloudflared tunnel --url http://localhost:3003
```

Default port is **3003** so it can run alongside the other bridges (3000–3002).

---

## How a click flows through the service

[server.js](server.js) → `processItem(itemId)`:

1. `POST /monday/webhook` receives `{ event: { pulseId, boardId } }`. Replies `200` immediately so
   Monday doesn't retry; outcomes are surfaced as item updates.
2. Pulls the item's name, existing subitems, and `COL_GRANT_TYPE` value in **one** GraphQL call
   ([fetchItemForProcessing](lib/monday.js)).
3. **Idempotency:** if the item already has subitems → posts "skipped" and stops. This is the only
   duplicate guard.
4. Reads the grant-type value verbatim → it's the **tab name** to open.
5. Fetches + parses that tab as CSV ([lib/sheet.js](lib/sheet.js)). A missing tab or a non-shared sheet
   → friendly note on the item, nothing created.
6. Creates one subitem per row (sequentially, preserving sheet order) via `create_subitem`
   ([createSubitem](lib/monday.js)) — name = description, `SUBITEM_STAGE_COL` = stage.
7. Posts a summary update (`נוצרו N תת-פריטים …`). Any error → an error update on the item.

---

## First-time setup

The two column IDs are environment-specific — discover them once:

```
npm run discover
```

This prints board 5098132295's columns (flagging the **"סוג המענק"** column → `COL_GRANT_TYPE`),
resolves the **subitems board**, and lists its **text** columns (→ `SUBITEM_STAGE_COL`). Paste both
into `.env`.

- **Subitems board doesn't exist until the parent board has a Subitems column.** If `discover` reports
  no subitems board, add a Subitems column (or one subitem) on the board in the Monday UI once, then
  re-run.
- **No text column on the subitems board?** Stage must go to a text column, so create one once:
  ```
  npm run discover -- create-stage-col <subitemsBoardId> "Stage"
  ```
  then paste the printed id into `SUBITEM_STAGE_COL`.

---

## Wiring up the Monday automation (one-time)

1. On board 5098132295, open **Automate → Create custom automation**.
2. Trigger: **When [Button] is clicked**, picking the button column.
3. Action: **Send a webhook** with URL `https://<your-host>/monday/webhook`
   (or `…/monday/webhook?secret=<WEBHOOK_SHARED_SECRET>` if you set a secret).
4. Save. Monday hits the URL once with a `challenge` payload; the service echoes it back automatically.

---

## Google Sheet

[Sheet](https://docs.google.com/spreadsheets/d/13f658G5KXGbmKvXR7m1U_j5mYX4Fd0upgWqTJwE6scc/edit) —
`GSHEET_ID` defaults to it. **Each tab is named after a grant type** (`Pre-Seed`, …). Each tab has two
columns: **stage** and **task description**.

- **Column order is an assumption: col0 = stage, col1 = description.** If the first row is a recognized
  header (a cell exactly equal to a stage label like `Stage`/`שלב` AND another cell exactly equal to a
  description label like `Task description`/`תיאור`), columns are mapped by header and that row is
  skipped. Matching is **exact** (not substring), so data values like `Stage 1` / `שלב ראשון` are never
  mistaken for a header. ⚠️ **Confirm against the real sheet** — if it's description-first, flip the
  indices in [pickColumns](lib/sheet.js); add header spellings to the label sets there if a tab uses
  others. Getting it wrong names subitems after stages.
- The sheet **must stay link-shared** ("anyone with the link can view"); otherwise the service can't
  read it, posts a note, and creates nothing.
- **Missing tab is detected reliably.** Google's CSV `sheet=<name>` export silently returns the FIRST
  sheet for an unknown name (it does NOT 404), so the service instead lists the real tabs from the
  sheet's `htmlview` page (name → gid) and fetches the requested tab **by gid**. A grant type with no
  matching tab → a note listing the tabs that do exist (e.g. `I4F` → "existing tabs: Pre-Seed"), nothing
  created. See [listTabs / fetchTasksFromSheet](lib/sheet.js).

Quick sanity check: open the sheet in an **incognito** window (no Google login) — it should load. To see
exactly what the service reads for a tab, export it by gid (gid `0` is the first tab):

```
https://docs.google.com/spreadsheets/d/13f658G5KXGbmKvXR7m1U_j5mYX4Fd0upgWqTJwE6scc/export?format=csv&gid=0
```

---

## Local testing without the tunnel

Fill `.env`, pick a real row whose "סוג המענק" has a matching tab and **no** subitems, then:

```
curl -X POST http://localhost:3003/monday/webhook \
  -H 'content-type: application/json' \
  -d '{"event":{"boardId":5098132295,"pulseId":<ITEM_ID>}}'
```

Subitems should appear (name = task, stage filled) plus a summary update. Re-run → "skipped, already
has subitems" (no duplicates). A row whose grant type has no matching tab → a graceful note, nothing
created. `GET /healthz` returns `200 OK` when the server is up.

---

## Deploy (Railway)

Same as the sibling bridges. New service → Root Directory `monday-subitems-sheet`; set
`MONDAY_API_TOKEN`, `COL_GRANT_TYPE`, `SUBITEM_STAGE_COL` (BOARD_TASKS / GSHEET_ID ship as defaults);
healthcheck `/healthz` (see [railway.json](railway.json)). Generate a domain and wire it into the
Monday automation above.

---

## Files

```
monday-subitems-sheet/
├── package.json          # express + dotenv; npm start / test / discover
├── server.js             # POST /monday/webhook + GET /healthz + processItem()
├── lib/
│   ├── monday.js         # gql, fetchItemForProcessing, createSubitem, postItemUpdate, findCol, readColValue
│   └── sheet.js          # listTabs, fetchTasksFromSheet, parseTabsFromHtml, parseCsv, pickColumns, SheetError
├── scripts/
│   └── discover.js       # column-ID discovery + guarded `create-stage-col` subcommand
├── test/
│   └── sheet.test.js     # node:test for parseCsv + pickColumns + parseTabsFromHtml (pure, no network)
├── railway.json          # NIXPACKS, npm start, healthcheck /healthz
├── .env.example          # template, safe to commit
└── CLAUDE.md             # this file
```

---

## Gotchas worth re-stating

- **`create_subitem`, not `create_item`.** It takes `parent_item_id` (not `board_id`); `create_item`
  would make a top-level row, not a subitem.
- **Stage must be a text column.** Text takes the bare string. A status column would need
  `{"label":"..."}` — `create_labels_if_missing:true` is set as a safety net but text is the contract.
- **Google's `sheet=<name>` CSV export lies for unknown tabs** — it serves the FIRST sheet instead of
  erroring. So tabs are resolved by gid (listed from `htmlview`), never by name. Don't "simplify" this
  back to `?sheet=<name>`, or every grant type without a tab would silently get the first tab's tasks.
- **Webhook returns 200 even on failure** so Monday doesn't retry; errors are posted as item updates.
- **Idempotency is read-then-create.** It covers retries/double-clicks but not two truly simultaneous
  clicks (same residual risk as the sibling bridges).
- **Tab name = grant-type value verbatim** (case/spacing/Hebrew matter) — no slug/lowercase.
