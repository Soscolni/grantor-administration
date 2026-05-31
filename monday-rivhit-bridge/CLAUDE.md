# monday-rivhit-bridge

Bridges Monday.com → Rivhit. When someone clicks a **Button column** on a Monday row, this service reads the row + its subitems, builds a Rivhit `Document.New` call (a דרישת תשלום / `חשבון עסקה`), and writes the resulting document number + PDF link back into the same row.

No frontend — this is a webhook receiver. The day-to-day UI is the Monday board itself.

Sibling subdir [rivhit-poc/](../rivhit-poc/) is the playground for the Rivhit API and the source of the gotchas baked into [lib/rivhit.js](lib/rivhit.js). Read [rivhit-poc/CLAUDE.md](../rivhit-poc/CLAUDE.md) first if you're touching the Rivhit side of this code.

---

## Run

```
cd monday-rivhit-bridge
npm install
cp .env.example .env          # then fill in MONDAY_API_TOKEN and the column IDs
npm start                     # listens on PORT (default 3001)

# In another shell, expose it to Monday:
ngrok http 3001               # or: cloudflared tunnel --url http://localhost:3001
```

Default port is **3001** so this can run alongside `rivhit-poc/` (3000) without a clash.

---

## Monday board schema

Create a board with these columns. The column **titles** below are suggestions; the **column IDs** are what matters at runtime — discover them with `npm run discover-columns -- <board_id>` and paste into `.env`.

### Main row

| Title | Type | Notes |
| --- | --- | --- |
| (item name) | — | Free-form label for the row. Not sent to Rivhit. |
| Customer ID | Numbers | Required. Rivhit `customer_id`. |
| Customer Name | Text | Auto-filled by the service from `Customer.Get` (display only). |
| Document Type | Dropdown | Labels must start with the numeric Rivhit type id, e.g. `8 / חשבון עסקה`. Default = 8. Seed labels from `Document.TypeList`. |
| Issue Date | Date | Optional; empty = today. |
| Comments | Long Text | Free text, printed on the document. |
| Status | Status | Required labels: **New**, **Generating**, **Done**, **Error**. The service drives transitions. |
| Generate | Button | Wire the Monday automation to this column (see below). |
| Document # | Text | Written by the service. |
| PDF Link | Link | Written by the service. Opens the Rivhit-hosted PDF. |
| Last Error | Long Text | Written by the service on failure (Rivhit's `client_message`). |

### Subitems

Each subitem = one line on the document.

| Title | Type | Notes |
| --- | --- | --- |
| (subitem name) | — | Used as `description`. **Required and non-empty** or the row is skipped. |
| Qty | Numbers | Defaults to 1 if blank. |
| Price NIS | Numbers | Required. |
| Catalog # | Text | Optional. Links to a Rivhit catalog item if it matches. |

---

## Wiring up the Monday automation (one-time)

1. On the board, open **Automate → Create custom automation**.
2. Trigger: **When [Button] is clicked**, picking the `Generate` button column.
3. Action: **Send a webhook** with URL:
   ```
   https://<your-tunnel-host>/monday/webhook
   ```
   Or with the optional shared secret:
   ```
   https://<your-tunnel-host>/monday/webhook?secret=<WEBHOOK_SHARED_SECRET>
   ```
4. Save. Monday hits the URL once with a `challenge` payload; the service echoes it back automatically and the integration goes live.

---

## How a click flows through the service

[server.js](server.js):

1. `POST /monday/webhook` receives `{ event: { pulseId, boardId, ... } }`.
2. Replies `200` immediately — Monday must not retry on logical failure (we'd double-bill).
3. Asynchronously sets Status → `Generating`.
4. Pulls the item + its subitems' column values in **one** GraphQL call ([lib/monday.js](lib/monday.js#fetchItemWithSubitems)).
5. Validates locally and builds the `Document.New` payload — date converted via [ymdToDmy()](lib/dates.js), empty subitems dropped.
6. POSTs to Rivhit via [lib/rivhit.js#postRivhit](lib/rivhit.js). That helper throws `RivhitError` if `error_code !== 0`.
7. On success: enriches `Customer Name` (best-effort `Customer.Get`), writes `Document #`, `PDF Link`, sets Status → `Done`.
8. On failure: writes `client_message` to `Last Error`, sets Status → `Error`.

---

## Gotchas worth re-stating

- **HTTP 200 always.** Rivhit returns 200 for logical errors too — check `error_code`. The wrapper in `lib/rivhit.js` already does this.
- **Webhook must return 200 even on failure.** Otherwise Monday retries.
- **Dates are `DD/MM/YYYY`.** Monday gives ISO; use `ymdToDmy()`.
- **Doc-type dropdown labels must start with the numeric Rivhit ID** (e.g. `8 / חשבון עסקה`). The service parses the leading number — if a label is just `חשבון עסקה`, generation fails with a clear error.
- **Status labels must exist.** Monday rejects a status update with an unknown label. Pre-create `New`, `Generating`, `Done`, `Error` on the Status column.
- **Subitems live on a separate Monday "subitems board"** with its own column IDs. `discover-columns.js` prints both sets in one go.
- **Customer ID is the only customer key.** No fuzzy search. If you want a customer-name dropdown later, build it from a separate Monday "Customers" board synced from `Customer.List`.

---

## Local testing without the tunnel

Once `.env` is filled in and you've created a real Monday row + subitems by hand, you can simulate a button click:

```
curl -X POST http://localhost:3001/monday/webhook \
  -H 'content-type: application/json' \
  -d '{"event":{"boardId":<BOARD_ID>,"pulseId":<ITEM_ID>}}'
```

Watch the Status column transition in Monday and check the server logs.

The `GET /healthz` endpoint returns `200 OK` if the server is up — useful for confirming the ngrok tunnel works before you wire Monday to it.

---

## Files

```
monday-rivhit-bridge/
├── package.json              # express + dotenv
├── server.js                 # POST /monday/webhook  +  GET /healthz
├── lib/
│   ├── dates.js              # ymdToDmy, todayDmy
│   ├── rivhit.js             # postRivhit() + RivhitError
│   └── monday.js             # gql(), fetchItemWithSubitems(), updateColumns(), findCol()
├── scripts/                  # diagnostic helpers, see "Diagnostic scripts" below
│   ├── discover-columns.js   # column IDs for main + subitem boards (npm run discover-columns)
│   ├── inspect-board.js      # like discover-columns + expands status/dropdown label values
│   ├── peek-items.js         # list first 25 rows + subitem counts (find an item_id)
│   ├── peek-row.js           # one row's column values, decoded via .env (verify the bridge will read it right)
│   ├── prep-positive-test.js # write known-good Document Type + Qty/Price to a row (set up green-path)
│   └── probe-customers.js    # sanity-check a list of customer IDs against Rivhit Customer.Get
├── .env.example              # template, safe to commit
└── CLAUDE.md                 # this file
```

---

## Diagnostic scripts

Only `discover-columns` has an npm-script entry; the rest are `node scripts/<name>.js <args>` because they're one-off diagnostics rather than daily tools. All of them load `.env` via `dotenv/config`.

| Script | Use it when |
| --- | --- |
| `discover-columns.js <board_id>` | First-time setup, or after adding/removing a column. Lists every column id on the main board AND the subitem-board. **Subitems live on a different `board_id`** — `change_multiple_column_values` for a subitem needs that subitem-board id, not the parent's. The fetch returns it via `subitem.board.id`. |
| `inspect-board.js <board_id>` | When a `change_multiple_column_values` call fails with "label not found". Expands `settings_str` for `status` and `dropdown` columns so you can see the exact label spellings Monday will accept. |
| `peek-items.js <board_id>` | Find an `item_id` to test against without opening the Monday UI. |
| `peek-row.js <item_id>` | After filling `.env`, run this to confirm every `COL_*` env var resolves to the value you expect *before* invoking the bridge. If a field prints `(empty)` here, the webhook will see it as empty too. |
| `prep-positive-test.js <item_id>` | Set Document Type = `8 / חשבון עסקה` and write Qty/Price to each subitem in one shot. Idempotent — safe to re-run. |
| `probe-customers.js <id> [<id> ...]` | Validate a list of `customer_id`s with `Customer.Get` before bulk-testing. Cheap way to weed out IDs that don't exist on the merchant. |

---

## End-to-end test recipe

The shortest path from a fresh `.env` to a green webhook hit:

```bash
# 1. Map column titles -> IDs and paste into .env.
npm run discover-columns -- <BOARD_ID>

# 2. Find a row to test against (create one in Monday if the board is empty).
node scripts/peek-items.js <BOARD_ID>

# 3. Verify your .env mapping actually decodes that row correctly.
node scripts/peek-row.js <ITEM_ID>

# 4. Fill in known-good test data on that row.
node scripts/prep-positive-test.js <ITEM_ID>

# 5. Sanity-check the customer id you put in the Customer ID column.
node scripts/probe-customers.js <CUSTOMER_ID>

# 6. Start the server and fire a synthetic click.
npm start &
curl -X POST http://localhost:3001/monday/webhook \
  -H 'content-type: application/json' \
  -d '{"event":{"boardId":<BOARD_ID>,"pulseId":<ITEM_ID>}}'

# 7. Watch the row's Status flip Generating -> Done in Monday,
#    and confirm Document # + PDF Link populate.
```

If step 7 ends in Status=Error, read the row's `Last Error` column — it contains Rivhit's `client_message` verbatim (truncated to 1900 chars).
