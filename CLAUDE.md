# grantor-administration

A multi-app monorepo for organization-administration automations. **Not** a single application — each automation is a self-contained subdirectory at the repo root.

## Layout convention

```
grantor-administration/
├── rivhit-poc/          # POC for Rivhit accounting API integration
└── <new-automation>/    # one subdir per automation, self-contained
```

Each subdir owns its own `package.json`, dependencies, and run command. There is intentionally no shared root-level `node_modules`, build system, or framework — the toolkit's purpose is breadth, and a shared monolith would couple unrelated automations.

When adding a new automation:
- Create a new subdir at the repo root, don't merge into an existing one.
- If it needs to talk to Rivhit, reuse the **thin-proxy pattern** described below — don't reinvent it, and don't import code across subdirs (copy a few files instead — these are independent apps).

## Thin-proxy pattern (for browser → external API)

When a browser page needs to call an external API that lacks CORS headers (Rivhit, banking, gov.il, most Israeli SaaS), the established pattern in this repo is:

1. **Tiny Node/Express server** in the subdir's `server.js` that:
   - Serves the static frontend from `./public/`.
   - Exposes one proxy route (e.g. `POST /api/:endpoint`) that forwards the JSON body to the upstream and pipes the response back.
   - Validates the endpoint name with a strict regex before forwarding — the proxy is open to anything on localhost, so don't let it become an arbitrary outbound HTTP gateway.
2. **Static HTML + vanilla JS** in `./public/`. No build step, no framework. Single `index.html` with inline `<script>` is fine for POCs; split into `app.js` / `app.css` only when one of them crosses ~600 lines.

Reference implementation: [rivhit-poc/server.js](rivhit-poc/server.js) (≈30 lines, the whole proxy).

Rationale for "no framework":
- Each automation is small (one page, a handful of endpoints).
- The user uses Node 22 — built-in `fetch` is available; no need for `node-fetch`/`axios`.
- React/Vue/etc. would add minutes of `npm install` and force a build step for what is currently a static file.

If a future automation legitimately needs SPA-grade UI (routing, complex state), that's the moment to introduce a framework — for that subdir only.

## Running an automation

Each subdir is self-contained:
```
cd <automation-name>
npm install        # only first time
npm start
```
Default port is 3000; override with `PORT=<n> npm start`.

## Running two apps in one Railway service (optional)

Each automation normally gets its own Railway service (Root Directory = the subdir). To run **several apps behind one service / one public URL** instead, the repo root has a small launcher — [launch.js](launch.js) + root [package.json](package.json) + [railway.json](railway.json):

- `postinstall` installs each subdir's deps into its own `node_modules` (no shared/hoisted deps — the apps stay self-contained).
- `npm start` → `launch.js` spawns each app as its own `node server.js` on an internal port and reverse-proxies by **path prefix**. It imports **no code** across subdirs (they remain independent processes), so the "don't couple subdirs" rule still holds.

Current routing (extend the `APPS` map to add more):

| Path | App |
| --- | --- |
| `/healthz` | the launcher itself (service liveness) |
| `/monday/webhook`, `/monday/webhook/receipt`, … | `monday-rivhit-bridge` (mounted at root) |
| `/subitems/...` | `monday-subitems-sheet` (prefix stripped) |

Deploy: a service with **Root Directory = repo root**. Its env vars are the **union** of the apps' vars (the rivhit set + `MONDAY_API_TOKEN`; the subitems board/column/sheet ids ship as defaults). `WEBHOOK_SHARED_SECRET`, if set, applies to **both** apps' webhooks. Re-point each Monday automation to the new domain (rivhit at `/monday/webhook…`, subitems at `/subitems/monday/webhook`). Adding this root launcher does **not** affect existing per-subdir services.

## Integrating Rivhit into a new automation

The Rivhit API mechanics live in [rivhit-poc/CLAUDE.md](rivhit-poc/CLAUDE.md). Read that first before writing any Rivhit code in a new subdir. The short version:
- POST JSON, `api_token` in body (not header).
- Always check `response.error_code === 0` — Rivhit returns HTTP 200 for logical errors.
- Browser cannot call `api.rivhit.co.il` directly (CORS) → use the proxy pattern above.

## Display preference

When building UIs that show API responses, render them as **tables / key-value cards / summary text**, not raw JSON dumps. Keep raw JSON available behind a collapsible `<details>` for debugging. This applies even to "API explorer / tester" panes that look like they want a JSON view by default.
