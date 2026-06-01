# monday-commission-bridge

On a **פעימות** button click, computes the commission to collect for that
installment and creates a row in **חשבוניות וגביה** with the amount + an
explanation of how it was derived.

No frontend — a webhook receiver, same thin-bridge pattern as
[monday-rivhit-bridge](../monday-rivhit-bridge/).

## Why this exists (and why it's a bridge, not a Monday formula/app)

The "remaining to collect" (`נותר לגבות`, **R**) is a **running balance** across
a grant's installments — `R = total commission − Σ already collected`. A per-row
Monday formula can't carry that running total, automations can't trigger off
formula columns, and the value lives behind a **mirror of a formula**, which the
Monday API **cannot read** (formula/mirror columns built on other mirror/connect
columns come back empty — an API-level limit no app can escape).

This bridge sidesteps all of it by reading only **raw** number and connection
columns and doing the math itself:

```
פעימה (P, link→grant)  →  הגשת מענק (winning W, link→agreement, link→all פעימות)
                       →  הסכם (rate %, cap %)
total = W × rate
schedule = walk the grant's installments in order, F_i = min(R, cap × P_i)
F = this installment's value   →   new row in חשבוניות וגביה
```

Reading a *real* column on a *connected* board is fully supported — `lib/monday.js`
follows `board_relation.linked_item_ids` and reads the linked item's real column,
exactly like the Rivhit bridge does. It never touches a mirror or formula.

## Boards

| Board | id | Role |
|---|---|---|
| הגשות מענקים | 5097243021 | winning amount **W** |
| הסכמים | 5097242066 | commission **rate** %, per-installment **cap** % |
| פעימות | 5097251047 | each payment **P** — **trigger board** |
| חשבוניות וגביה | 5097251687 | **output** — bridge creates a row here |

Link chain: **פעימה → הגשה → הסכם**. Remaining R is recomputed by summing the
F of earlier installments (in order).

## Run

```
cd monday-commission-bridge
npm install
cp .env.example .env       # fill MONDAY_API_TOKEN + the COL_* ids
npm start                  # listens on PORT (default 3002)
ngrok http 3002            # expose to Monday
```

## Map the column ids (one-time)

```
# all columns on all four boards (find the numbers + board_relation ids):
npm run discover-boards -- 5097243021 5097242066 5097251047 5097251687
# confirm the chain resolves on a real row:
node scripts/discover.mjs <a real פעימה item id>
```
Both read the token from `MONDAY_API_TOKEN` (set it in the shell first). Paste the
ids into `.env` — see `.env.example` for what each one is.

## Wire the Monday automation

On the **פעימות** board: **Automate → When [button] is clicked → Send a webhook**
to `https://<tunnel>/monday/webhook` (add `?secret=<WEBHOOK_SHARED_SECRET>` if set).
Monday's one-time `challenge` is echoed automatically.

## How a click flows ([server.js](server.js))

1. `POST /monday/webhook` with `{ event: { pulseId, boardId } }`; replies 200 at
   once, processes async (no double-billing on retry).
2. Reads the clicked פעימה (P + grant link), follows to the grant (W + agreement
   link + all פעימות), follows to the agreement (rate + cap).
3. `total = W × rate`; `commissionSchedule()` walks the grant's installments in
   order to get this one's `F = min(R, cap × P)`.
4. `create_item` in חשבוניות וגביה: amount = F, name = the explanation.
5. Posts a traceability update on the פעימה. Any missing link/number → a clear
   error update on the row, nothing created.

## Gotchas

- **Only raw columns.** Point the `COL_*` ids at `numbers`/`board_relation`
  columns, **never** a `formula_`/`lookup_` (mirror) column — those read empty.
- **Percent storage.** `RATE_AS_PERCENT`/`CAP_AS_PERCENT` handle `25` vs `0.25`
  (blank = auto: a value > 1 is divided by 100).
- **Ordering.** Set `COL_PEIMA_ORDER` (a date/sequence column) so installments
  sort deterministically; otherwise they're ordered by item id (creation order).
- **Idempotency.** Each click creates a new חשבוניות וגביה row — clicking twice
  makes two. (A future guard could mark a פעימה as processed and skip.)
- **Webhook returns 200 even on failure** so Monday doesn't retry; errors land as
  an update on the row.

## Files

```
monday-commission-bridge/
├── package.json
├── server.js                 # POST /monday/webhook + GET /healthz + orchestration
├── lib/
│   ├── monday.js             # gql, fetchItems, createItem, follow-relation helpers
│   └── calcs.js              # commissionSchedule(), round2()
├── scripts/
│   ├── discover-boards.mjs   # columns of all 4 boards (npm run discover-boards)
│   └── discover.mjs          # per-item: confirm the link chain resolves
├── test/calcs.test.js        # commission math (npm test)
├── .env.example
└── CLAUDE.md
```

## Local test without the tunnel

```
curl -X POST "http://localhost:3002/monday/webhook" \
  -H "content-type: application/json" \
  -d '{"event":{"boardId":5097251047,"pulseId":<PEIMA_ID>}}'
```
Then check חשבוניות וגביה for the new row and the פעימה's updates feed.
