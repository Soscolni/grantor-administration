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
├── scripts/
│   └── discover-columns.js   # prints column IDs for both main and subitem boards
├── .env.example              # template, safe to commit
└── CLAUDE.md                 # this file
```
