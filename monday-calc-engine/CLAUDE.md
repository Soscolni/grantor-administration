# monday-calc-engine

A Monday app that gives you **formula abilities Monday doesn't have natively**,
and writes the result into a **real column** — so automations, the Rivhit flow,
and everything else can use it.

It's the generalization of [monday-formula-app](../monday-formula-app/): instead
of *copying* a formula's output (which is blocked for mirror/connected formulas),
this app reads the **inputs** and **computes the value itself**. It never asks
Monday for a formula's value, so the formula-read limitations never apply.

## The abilities it adds

| Native Monday gap | This app |
| --- | --- |
| Formula columns can't be used in automations | Result is written to a plain number column → fully automatable |
| Formulas over mirror/connected-board columns can't be read via the API | Reads the **real source column** through the connection (`relCol->srcCol`) and computes — never touches the blocked formula |
| Formulas are per-row; no running totals / cross-row math | Rollup + sequential calcs across subitems / linked items |
| No way to carry state between rows (e.g. a running balance) | The commission calc walks installments in order, carrying `R` |

## Two design choices baked in (per the project's decisions)

- **Mirrored values come from the source, not the mirror.** Anywhere you name an
  input column you can instead write `relationColId->sourceColId`; the app
  follows the connection to the linked item and reads the **actual** column
  value there. (Reading the mirror's own `display_value` still works for plain
  `columnId` refs, but the `->` form is the robust path.)
- **You write the formula in the app, not auto-imported from Monday.** The
  expression mode lets you author the calculation directly (`min({R}, 0.25*{P})`)
  — the app becomes the source of truth, no Monday formula column required.

---

## Endpoints (each is a custom action you wire into a recipe)

### 1. Expression — `POST /monday/action/expression`
Evaluate an expression over the item's columns, write the number.

`inputFields`: `itemId`, `boardId`, `outputColumnId`, `expression`

- Refs in the expression: `{columnId}` (this item) or `{relColId->srcColId}`
  (value read from the linked item's source column).
- Functions: `min, max, round(x[,d]), floor, ceil, abs, if(cond,a,b)`;
  operators `+ - * / %`, comparisons `< <= > >= == !=`.
- Example: `min({numeric_remaining}, 0.25 * {connect_deal->numeric_installment})`

### 2. Rollup — `POST /monday/action/rollup`
Aggregate a column across subitems / linked items onto this item.

`inputFields`: `itemId`, `boardId`, `scope` (`subitems`|`linked`),
`relationColumnId` (when `scope=linked`), `valueColumnId` (plain or `rel->src`),
`op` (`sum|min|max|avg|count`), `outputColumnId`

### 3. Commission — `POST /monday/action/commission`
The tender calc: walk installments in order applying `F = min(R, capRate × P)`
and write each installment's collected amount. (Flagship stateful example.)

`inputFields`: `itemId`, `boardId`, `scope` (`subitems`|`linked`),
`relationColumnId?`, `amountColumnId` (plain or `rel->src`), `outputColumnId`,
`capPercent?` (default 25), `strategy?` (`aggressive`|`proportional`), and the
total commission via **either** `totalCommission` **or**
`winningAmountColumnId` + `commissionPercent`.

### Dropdown helpers
`POST /monday/fields/number-columns`, `/relation-columns`, `/any-columns` —
populate the recipe's column pickers (filtered by type) so users pick from a
list instead of pasting ids.

All POST routes require Monday's signed JWT (verified with `MONDAY_SIGNING_SECRET`;
the embedded `shortLivedToken` is used for the API calls).

---

## The calc core is independently tested

The math — the expression evaluator (`lib/calc-expr.js`) and the stateful calcs
(`lib/calcs.js`) — is pure and unit-tested, including the exact worked examples
from the tender guide:

```
npm test     # node --test
```

`commissionSchedule([10000,40000,50000], { total: 5000, capRate: 0.25 })`
→ `[2500, 2500, 0]` (aggressive) — matches the guide.

---

## Run / deploy

### Local (without Monday)
```
cd monday-calc-engine
npm install
cp .env.example .env       # set ALLOW_UNSIGNED=1 + MONDAY_API_TOKEN to curl locally
npm start                  # http://localhost:8080
```

### On monday-code
```
npm i -g @mondaycom/apps-cli
mapps init
mapps code:push
mapps code:secret -m set -k MONDAY_SIGNING_SECRET -v <app signing secret>
```
Then in the Developer Center add an **Integration** feature, create a **custom
action** per endpoint above (Run URL = `https://<base><path>`), define its input
fields with the keys listed, wire the column dropdowns to the `/monday/fields/*`
routes, and build a recipe (built-in trigger + your action). See
[../monday-formula-app/CLAUDE.md](../monday-formula-app/CLAUDE.md) for the full
Developer-Center walkthrough — the wiring is the same, just more fields.

> What's tested here vs. not: the calc engine is unit-tested and the HTTP
> routing/auth is smoke-tested. The end-to-end recipe (Developer Center field
> mapping + monday-code) needs your Monday account to validate — it can't be
> exercised from this repo.

---

## Gotchas

- **API 2025-01+** pinned in `lib/monday.js` (mirror/formula `display_value`).
- **Don't trigger on the output column** (loop) or on a formula column (never
  fires). Trigger on the inputs, a status, a button, or a schedule.
- **Order matters for commission.** Installments are read in board order
  (subitems) or relation order (linked). If you need a strict order, sort by an
  index/date column — a v2 `orderBy` field.
- **Return codes**: `200` = done (incl. permanent data problems we don't retry,
  surfaced as an item update); `500` = transient, Monday retries.

---

## Files

```
monday-calc-engine/
├── package.json
├── app.js               # 3 action endpoints + dropdown helpers + /health
├── lib/
│   ├── jwt.js           # verify Monday's signed requests (HS256)
│   ├── monday.js        # token-per-call gql + item/subitem/linked fetchers
│   ├── calc-expr.js     # safe expression evaluator (no eval) + extractRefs
│   └── calcs.js         # commissionSchedule(), rollup(), round2()
├── test/engine.test.js  # unit tests for the calc core
├── .env.example
└── CLAUDE.md            # this file
```
