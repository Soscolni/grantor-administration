# monday-formula-sync

Copies a Monday **formula** column's computed value into a **number** column on
the same row, so the value can be used by Monday automations.

## Why this exists

Monday formula columns are computed on the fly and **can't be referenced by
automations** ("when number changes…", "if number is greater than…", etc.).
This webhook closes that gap: click a button on the row → the formula's current
value is read via the API and written into a real number column → automations
can now trigger off that number column.

No frontend — this is a webhook receiver. The UI is the Monday board itself.
Sibling [monday-rivhit-bridge/](../monday-rivhit-bridge/) is the original
"button click → edit a column" webhook this one is modelled on; the Monday
GraphQL helper in [lib/monday.js](lib/monday.js) is a trimmed copy of that
subdir's (copied, not imported — these are independent apps).

## The one thing that makes this possible

Formula columns only return their computed value on **API version 2025-01 and
later**, via the `FormulaValue.display_value` field. On older versions a formula
column comes back with empty `text`/`value` and there's nothing to copy.
`lib/monday.js` pins `API-Version: 2025-01` for exactly this reason.

Monday's read-formula limitations (as of this writing) — worth knowing because
they show up as "empty value" failures, not errors:
- Formulas that reference **mirror** or **connected-board** columns can't be
  read through the API → `display_value` comes back empty.
- Up to **5 formula columns** per request, **10,000 formula reads/min**.

Ref: <https://developer.monday.com/api-reference/changelog/new-ability-to-read-the-formula-column>

---

## Run

```
cd monday-formula-sync
npm install
cp .env.example .env          # then fill in MONDAY_API_TOKEN (+ optional bits)
npm start                     # listens on PORT (default 3002)

# In another shell, expose it to Monday:
ngrok http 3002               # or: cloudflared tunnel --url http://localhost:3002
```

Default port is **3002** so it can run alongside `rivhit-poc/` (3000) and
`monday-rivhit-bridge/` (3001).

---

## Picking which columns to copy

There are two ways to tell the webhook which formula → number copy to do. Pick
one; per-automation query params win if both are present.

### A) Per-automation (recommended for multiple boards/columns)

Put the column ids straight in the webhook URL. One deployment can then serve
any number of boards and automations — each Monday "Send webhook" action carries
its own ids:

```
https://<tunnel-host>/monday/webhook/formula-sync?formula=<formulaColId>&target=<numberColId>
```

### B) Default mapping in `.env`

If the URL has no `?formula=&target=`, the service falls back to `SYNC_PAIRS`, a
JSON object that can hold several pairs (one click syncs them all):

```
SYNC_PAIRS={"formula_abc":"numeric_xyz","formula_def":"numeric_uvw"}
```

Discover the ids with:

```
npm run discover-columns -- <board_id>
```

Look for type `formula` (the source) and type `numbers` (the destination).

---

## Wiring up the Monday automation (one-time)

1. On the board: **Automate → Create custom automation**.
2. Trigger: **When [Button] is clicked**, picking a button column (e.g. "Sync
   total").
3. Action: **Send a webhook** with the URL from section A (or B).
   Add `&secret=<WEBHOOK_SHARED_SECRET>` if you set that env var.
4. Save. Monday sends a one-time `challenge`; the service echoes it back
   automatically and the integration goes live.

Now build the automation you actually wanted on top of the **number** column the
webhook fills — it updates whenever the button is clicked.

> Tip: you can also chain it. Have a first automation click the button (or hit
> this webhook) on a schedule / on change, so the number column stays in sync
> without a human clicking.

---

## How a click flows through the service

[server.js](server.js):

1. `POST /monday/webhook/formula-sync` receives `{ event: { pulseId, boardId } }`.
2. Replies `200` immediately so Monday won't retry; problems are reported as an
   update on the item.
3. Resolves the formula → number pairs (query params, else `SYNC_PAIRS`).
4. Reads the formula column(s) via `FormulaValue.display_value`
   ([lib/monday.js#fetchItem](lib/monday.js)).
5. Parses each value to a number (strips `₪`, `,`, `%`, keeps sign + decimal).
6. Writes the number column(s) with `change_multiple_column_values`.
7. On any per-pair problem (empty/non-numeric value) posts a clear update on the
   row and still writes the pairs that did succeed.

---

## Gotchas worth re-stating

- **Needs API version 2025-01+.** Pinned in `lib/monday.js`. Don't downgrade it.
- **Empty value ≠ bug.** A formula referencing a mirror/connected-board column
  reads back empty — that's a Monday limitation, surfaced as an item update.
- **Webhook returns 200 even on failure.** Otherwise Monday retries.
- **Number column wants a string.** `change_multiple_column_values` takes
  `"1234.56"`, not the JS number — the service stringifies it.
- **Validate before wiring.** Run `node scripts/peek-formula.js <item_id>
  <formulaColId>` and confirm the value prints (not `(empty)`) before you build
  the automation on top of it.

---

## Files

```
monday-formula-sync/
├── package.json              # express + dotenv
├── server.js                 # POST /monday/webhook/formula-sync + GET /healthz
├── lib/
│   └── monday.js             # gql() (API 2025-01), fetchItem(), updateColumns(), findCol(), readColValue()
├── scripts/
│   ├── discover-columns.js   # list a board's columns + types (npm run discover-columns)
│   └── peek-formula.js       # read a formula value for one item (verify before wiring)
├── .env.example              # template, safe to commit
└── CLAUDE.md                 # this file
```

---

## Local testing without the tunnel

With `.env` filled and a real row that has a populated formula column:

```bash
# 1. Find the formula + number column ids.
npm run discover-columns -- <BOARD_ID>

# 2. Confirm the API can read the formula value for a specific row.
node scripts/peek-formula.js <ITEM_ID> <FORMULA_COL_ID>

# 3. Start the server and fire a synthetic button click.
npm start &
curl -X POST 'http://localhost:3002/monday/webhook/formula-sync?formula=<FORMULA_COL_ID>&target=<NUMBER_COL_ID>' \
  -H 'content-type: application/json' \
  -d '{"event":{"boardId":<BOARD_ID>,"pulseId":<ITEM_ID>}}'

# 4. Watch the number column on that row update to the formula's value.
```

`GET /healthz` returns `200 OK` if the server is up — handy for confirming the
tunnel before wiring Monday to it.
