# rivhit-poc

POC web page for the Rivhit Online REST API. Started 2026-05-19. Static HTML + vanilla JS frontend, tiny Express proxy so the browser can hit the API from the same origin.

Run: `npm install && npm start` → http://localhost:3000.

---

## Rivhit API — quick reference

Canonical sources (always check these before guessing — Rivhit's docs are split across three sites and the readme.io URLs sometimes 404):

- Operation index: https://api.rivhit.co.il/online/RivhitOnlineAPI.svc/help (115 endpoints, with per-op help at `/help/operations/<OperationCamelCase>` — note: NOT the dotted name. `Document.New` → `/help/operations/DocumentCreate`. Mapping is irregular; search the help index if you don't find one.)
- Readme.io reference (sometimes more readable): https://rivhit-api.readme.io/reference
- Knowledge base (Hebrew, with demo credentials): https://www.rivhit.co.il/knowledgebase/api-%D7%A8%D7%99%D7%95%D7%95%D7%97%D7%99%D7%AA/

### Base URL & shape

- **Base:** `https://api.rivhit.co.il/online/RivhitOnlineAPI.svc/<Endpoint.Name>`
- **All endpoints are POST**, `Content-Type: application/json`. No headers needed — `api_token` is a top-level field in every body.
- **Response envelope is always**:
  ```json
  { "error_code": 0, "client_message": "", "debug_message": "", "data": { ... } }
  ```
  HTTP status is 200 even for logical errors. **You MUST check `error_code` — never trust the HTTP status alone.** A non-zero `error_code` is a real failure; `client_message` is safe to surface to end-users.

### Demo merchant (public test credentials)

| Field | Value |
| --- | --- |
| Business ID | `8888` |
| Login (admin UI) | `DEMO` / `123` |
| `api_token` | `0279BF82-CD57-49BA-837C-930F0E2EB805` |
| Web admin URL | https://invoice.rivhit-co-il-dev.s977.upress.link/login.aspx |

The demo merchant is **shared** with everyone using the docs — data is messy and accumulates: ~57k customers, hundreds of document types, fake "POC test" documents from other developers. Treat it as a sandbox you write to but never read meaningfully from for analytics.

---

## Gotchas (things that wasted time the first time around)

### 1. Date format is `DD/MM/YYYY`, not ISO

`issue_date`, `from_date`, `to_date`, etc. all expect `DD/MM/YYYY` (or `DD-MM-YY`). Sending `2026-05-19` returns a non-obvious error. The HTML form uses `<input type=date>` which gives `yyyy-mm-dd`, so there is a `ymdToDmy()` helper at the bottom of `public/index.html` — use it whenever feeding the API.

### 2. `error_code` ≠ HTTP status

```js
// WRONG — accepts logical failures as success:
if (response.ok) showSuccess();

// RIGHT:
const json = await response.json();
if (json.error_code === 0) showSuccess(json.data);
else showError(json.client_message);
```

### 3. There is no document literally called "דרישת תשלום" in the standard catalog

The demo merchant's `Document.TypeList` does **not** contain "דרישת תשלום". A real merchant *may* have a custom type with that name (Rivhit lets businesses define their own), but you cannot assume document_type 9 = payment-demand the way you'd assume 1 = invoice.

**The closest semantic match in any merchant is `document_type: 8` (חשבון עסקה)** — a billing document that requests payment without triggering the VAT event. Use it as the default, but always populate the type dropdown from the live `Document.TypeList` so production merchants can pick their actual configured type.

Document types that **are** stable across merchants (per Israeli accounting convention):
- 1 = חשבונית מס (tax invoice — triggers VAT)
- 2 = חשבון קבלה / חשבונית מס קבלה (tax invoice + receipt combined)
- 3 = חשבון זיכוי (credit note)
- 4 = תעודת משלוח (delivery note)
- 6 = הצעת מחיר (price quote)
- 7 = הזמנה (order)
- 8 = חשבון עסקה (proforma / billing demand — VAT-neutral)

Everything ≥9 is merchant-specific. **Always load `Document.TypeList` and let the user pick** rather than hardcoding.

### 4. `Customer.List` is huge

Demo has ~57k customers, real merchants often >10k. Never load the full list into a UI dropdown. Use `Customer.Get` with an ID when the user knows it, or `Customer.List` with strict filters (`customer_type`, `created_after`) when searching. There is no built-in fuzzy search.

### 5. `items[]` field names in `Document.New`

Each item row uses these exact names (other names silently get ignored or fail):
- `catalog_number` (string, optional — links to a catalog item if it exists)
- `description` (string)
- `quantity` (decimal)
- `price_nis` (decimal — unit price in ILS)
- `exempt_vat` (boolean, optional — overrides the document's default)
- `currency_id`, `price_mtc`, `exchange_rate` (only when not ILS)

**Do not send `vat`/`tax_rate`** — VAT handling is per-item via `exempt_vat` and per-document via the type config.

### 6. Successful `Document.New` returns a usable PDF link immediately

The response includes `document_link` — a Rivhit-hosted PDF URL. No separate "generate PDF" call needed. The URL is stable and public-by-obscurity (UUID in path), good for emailing to customers.

### 7. CORS — the browser CANNOT call `api.rivhit.co.il` directly

`api.rivhit.co.il` does not send CORS headers. A pure-frontend integration is impossible from a real browser. The proxy in `server.js` exists for this reason; don't try to "simplify" by removing it.

### 8. The `/help/operations/...` URLs are flaky

Fetching them from outside a browser returns 400/404 intermittently. The readme.io mirrors at `rivhit-api.readme.io` sometimes 404 even for endpoints that exist. When in doubt, just hit the actual API with curl and read the error message — it's often the fastest path.

---

## Project structure

```
rivhit-poc/
├── package.json         # only dep: express
├── server.js            # Express proxy. Single route: POST /api/:endpoint
├── public/
│   └── index.html       # Single-page UI. Two tabs:
│                        #   • Create Payment Demand (the real form)
│                        #   • API Explorer (renders responses as tables/cards)
└── CLAUDE.md            # this file
```

`server.js` validates the endpoint name with `/^[A-Za-z][A-Za-z0-9.]+$/` before forwarding — keep that regex if you add features. The proxy must not become an open outbound gateway.

`public/index.html` is a single file by design. Inline styles + script are fine while it's under ~700 lines. Split into `app.js`/`app.css` only when one of those crosses that threshold or the page gets a build step.

---

## Adding a new endpoint to the API Explorer

Append an entry to the `ENDPOINTS` array near the top of the `<script>` block in `index.html`:

```js
{ name: 'Customer.New', hint: 'Create a customer.', body: { last_name: '', phone: '' } },
```

If the response has a list shape worth rendering as a table, add the list-key + preferred columns to `PREFERRED_COLS` further down. Unknown list shapes fall back to "first 8 keys of the first row" — good enough for exploration, ugly for daily use.
