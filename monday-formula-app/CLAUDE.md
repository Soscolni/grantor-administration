# monday-formula-app

The **native Monday app** version of [monday-formula-sync](../monday-formula-sync/).

Same job — copy a **formula** column's computed value into a **number** column so
Monday automations can use it — but delivered as a real app instead of an
external webhook bridge:

- **No personal API token.** Each request carries a Monday-signed JWT with a
  short-lived token scoped to the app; we call the API *as the triggering user*.
- **No tunnel / no server to babysit.** Deploy to **monday-code** (Monday's
  serverless hosting) with the `mapps` CLI.
- **No column ids to hunt for.** The recipe's two column pickers are **dropdowns**
  populated by this app, filtered to `formula` (source) and `numbers` (target).
- **Reusable as a recipe.** Combine our custom action with any built-in trigger
  (button, column change, status change, schedule).

The hard part — reading a formula via `FormulaValue.display_value` on API
version 2025-01 — is identical to the bridge; `lib/monday.js` is the same logic,
just taking a per-request token instead of an env var.

---

## How it maps to the bridge

| Bridge (`monday-formula-sync`) | App (`monday-formula-app`) |
| --- | --- |
| `POST /monday/webhook/formula-sync` | `POST /monday/action/formula-sync` (custom action) |
| Column ids in the URL / `SYNC_PAIRS` | `inputFields` from the recipe's dropdowns |
| `MONDAY_API_TOKEN` from `.env` | `shortLivedToken` from the signed JWT |
| Shared-secret query param | JWT signature verified with the app's Signing Secret |
| ngrok / self-host | monday-code |

---

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /health` | Liveness check. |
| `POST /monday/action/formula-sync` | The custom action. Reads `payload.inputFields` = `{ itemId, boardId, formulaColumnId, numberColumnId }`, copies the value, returns `200 {}`. |
| `POST /monday/fields/formula-columns` | Remote options: lists the board's `formula` columns for the source dropdown. |
| `POST /monday/fields/number-columns` | Remote options: lists the board's `numbers` columns for the target dropdown. |

All three POST routes require Monday's JWT in the `Authorization` header (the app
verifies it with `MONDAY_SIGNING_SECRET` and uses the embedded `shortLivedToken`).

---

## Run / deploy

### Local (without Monday)

```
cd monday-formula-app
npm install
cp .env.example .env
# set ALLOW_UNSIGNED=1 and MONDAY_API_TOKEN=<personal token> for local curling
npm start            # http://localhost:8080
```

`ALLOW_UNSIGNED=1` bypasses JWT verification and uses `MONDAY_API_TOKEN`, so you
can exercise the routes locally. **Never set it on a deployed app.**

### On monday-code

```
npm i -g @mondaycom/apps-cli      # the `mapps` CLI
mapps init                        # authenticate with a Developer Center token
mapps code:push                   # build + deploy this folder to monday-code
mapps code:env -m set -k MONDAY_SIGNING_SECRET -v <your app signing secret>
```

monday-code injects `PORT`; the app already reads it. Grab the deployed base URL
from the push output — you'll paste it into the recipe config below.

---

## Wiring it in the Developer Center (one-time)

1. **Create the app**: Developer Center → *Create app*. Copy its **Signing
   Secret** (Basic Information) into monday-code env as `MONDAY_SIGNING_SECRET`.
2. **OAuth scopes** (Authorization / Permissions): `boards:read`,
   `boards:write` (write the number column). Add `me:read`; add an updates scope
   if you want the failure notes posted to items.
3. **Add an Integration feature** → create a **Custom action** block:
   - **Action URL**: `https://<monday-code-url>/monday/action/formula-sync`
   - **Input fields**:
     | Field key | Type | Source |
     | --- | --- | --- |
     | `itemId` | Item ID | from the trigger |
     | `boardId` | Board ID | from the trigger |
     | `formulaColumnId` | custom dropdown (remote options) → `https://<url>/monday/fields/formula-columns`, dependent on `boardId` | user picks |
     | `numberColumnId` | custom dropdown (remote options) → `https://<url>/monday/fields/number-columns`, dependent on `boardId` | user picks |

     (Prefer not to build custom field endpoints? Use Monday's built-in **Column**
     field type for the two columns instead — you lose the formula/number
     filtering but skip the `/monday/fields/*` routes.)
4. **Create a recipe**: a built-in trigger + this action, e.g.
   *"When a column changes, copy {formulaColumnId} into {numberColumnId}."*
5. **Install** the app on your account and add the recipe to a board.

The recipe's dropdowns now list only formula columns (source) and number columns
(target) for the chosen board — no ids, no `.env`.

---

## Gotchas (mostly the same platform limits)

- **API version 2025-01+** — pinned in `lib/monday.js`. Formula reads need it.
- **Some formulas read empty** — those referencing mirror/connected-board
  columns. The action posts a note on the item and returns `200` (no retry).
- **Don't trigger on the formula column** (formulas don't fire automations) or on
  the **target number column** (infinite loop). Trigger on the inputs / a status.
- **Return codes drive retries**: `200` = done (incl. permanent data problems we
  don't want retried); `500` = transient, Monday retries. The action follows this.
- **shortLivedToken is ~1 minute** for integration recipes — use it within the
  request, don't stash it.

---

## Files

```
monday-formula-app/
├── package.json          # express + dotenv
├── app.js                # action endpoint + remote-options endpoints + /health
├── lib/
│   ├── jwt.js            # verifyMondayJwt() — HS256 verify of Monday's signed requests
│   └── monday.js         # token-per-call gql(), fetchItem(), updateColumns(), listColumns()
├── .env.example
└── CLAUDE.md             # this file
```
