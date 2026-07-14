# Wilsons HQ — Changelog

Records changes to the Wilsons HQ app going forward. Bump `APP_VERSION` in `server.js` with each release. (Versions before v20 were built earlier and aren't itemised here.)

## v20 — July 2026
**Added the Planning module** — a new team-planning section (tasks, projects, delegation).
- **`planning.html`** (new) — served at `/planning`. Four views: **My work · Team · Waiting on · Projects**. Add tasks, assign/delegate to any user, mark done. Matches the HQ brand (navy/cream/coral, Bobby Jones + Effra).
- **`planning.js`** (new) — `projects` + `tasks` tables and the `/api/team`, `/api/projects`, `/api/tasks` routes. **Additive only** — no existing tables or routes changed.
- **`server.js`** — four small, guarded hooks (load module at startup, serve `/planning`, route `/api` planning calls). Wrapped in try/catch so the Planning module can never crash Wilsons HQ.
- Not yet in the home menu — reached via `/planning` for now (menu tile is a planned follow-up, kept separate to avoid risky edits to the main app).

## v19 and earlier — production management
Recipes, ingredients, production board, deliveries, stock, suppliers, packaging, KPI dashboard, product specs, recipe costing, complaints, change log, users/roles/invites, backup & restore, Excel export. (Built prior to this changelog.)
