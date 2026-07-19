# Wilsons HQ — Changelog

Records changes to the Wilsons HQ app going forward. Bump `APP_VERSION` in `server.js` with each release. (Versions before v20 were built earlier and aren't itemised here.)

## v27 — 19 July 2026
**Search speed + backup completeness** (both raised by Kamil after the v26 go-live).
- **Ingredient search no longer lags.** The costing screen re-parsed its entire shared data store (recipes, purchases, prices) on *every keystroke*, three times over, then rebuilt the whole table — several seconds of freeze. Now: parsed data is cached and re-read only when it actually changes; the ingredient table is built once per redraw; and all five costing search boxes redraw only after a 180 ms pause in typing. Measured: keystrokes instant; one ~50 ms redraw after the pause. Displayed prices verified unchanged against the canonical pricing functions.
- **Backup audited end-to-end with real live data** (a copy of the 18 Jul live backup, through the real `/api/backup.zip` endpoint):
  - The **zip backup was already complete** — it contains `app.db`, the entire database, and Restore uses exactly that file. The daily-backup script also already pulls the zip. Nothing was ever missing from the zip.
  - The **readable Excel workbook** inside it was missing several things, now added (30 sheets total): **Planning projects & tasks**; **Batch ingredient usage** (every batch's frozen deductions — 2,800+ rows); **Costing change history** (who changed which costing data, when); Packaging **bag-to-product mappings**; Users **email + factory**; Production **recipe version** column; and the **menu layout** + **stock-freeze report** settings.
  - Deliberately *not* in the Excel (but in `app.db`): session tokens, invite links (secrets), the live-fill feed (transient), and the fill-PIN.

## v26 — 18 July 2026
**Full correctness audit + fixes** (audit report: `AUDIT-FINDINGS.md` in the project folder).
- **Best-before dates** no longer spill into the wrong month when filling on the 29th/30th/31st — they clamp to the last day of the target month (31 Aug + 18 months = 28/29 Feb, not 2 Mar). Defaults unchanged (12 months; Green Pantry 18; per-recipe override kept).
- **Julian codes & dates**: correct in the first hour after midnight during British Summer Time (they were a day behind).
- **Stock history frozen**: every batch permanently records what it consumed (recipe as of fill day). Editing a recipe now only affects future batches. One-time migration locks in existing rows; any figure that moved is reported in the server log and `meta.stockFreezeReport`. Partial cooks carry their share of the recorded usage.
- **Recipe versions** (new `recipe_versions` table, additive): every recipe change is snapshotted with who/when/what changed. Viewer in Recipe Library → recipe → *Version history*. New production rows record `recipe_version`. Included in the Excel backup.
- **Recipe Costing**: recipes with unpriced ingredients are flagged **provisional** everywhere, including the branded customer export (they were silently costed as if free). Sync deletions are now explicit (recycle bin) and renames keep the same recipe row/id. Save-data backup now includes categories, recycle bin, cost profiles and profile assignments. Unload-save uses `keepalive`.
- **KPI dashboard**: *Total Despatched* now includes Blair despatch; £/kg, rejects-% and absence-rate KPIs aggregate as period total ÷ total (not mean of daily rates); fiscal weeks/years reset each August; the "+ add standard change" button on Settings works.
- **Weekly plan saves** no longer fail silently after a Recipe Costing push mid-session.
- **Multipack pack labels** ("2 x 400g") parse as the whole pack weight in server, app and costing.
- Declared **composition percentages** now sum to exactly 100% (largest line absorbs the rounding).
- **Costing data can no longer be silently overwritten or lost** (the "typed prices disappeared" class of problem):
  - **Merge saves** — editing a price/delivery/supplier choice now sends only the entries you changed; the server folds them in. A browser with a stale copy (tab open overnight, tablet waking from sleep) used to save its whole stale list and wipe entries others had typed since — that cannot happen any more.
  - **Change history** (new `costing_kv_history` table, additive) — every change to every costing key keeps the previous value with who/when, last 25 per key. Admin endpoint `/api/costing-history` lists and returns them, so anything lost is visible and recoverable.
  - **Hand-set stock is import-proof** — stock levels set in the app are marked `edited=1`; a future seed/history re-import fills gaps only and never overwrites them.
- **Ingredients & lists tidy-up (Kamil's pre-deploy requests):**
  - Every list is now **alphabetical by default**: the costing Ingredients table, recipe tiles and search results, the Products table, all recipe dropdowns and ingredient pick-lists (in both Recipe Costing and the main app's Recipe Library, Planner and production screens).
  - The costing Ingredients tab has a **"Used in (process)" column** (Cold Press / Fresh Frozen / Fresh Ambient, from each recipe's category) — sortable, plus an **"All processes" filter** (including "Not used in any recipe").
  - A **Recipes count button** on each ingredient opens a panel listing every recipe that uses it, with the process, kg per batch and % of mix, and an Open link straight to the recipe.
  - Removed the half-hidden pink **"custom" badge** behind ingredient names (it only marked ingredients added after the original spreadsheet — no data lost; rows are now uniform). The ingredient CSV export includes the new Used-in and Recipes columns.
- **Costing screen space saved (Kamil's requests):**
  - **Add ingredient is now a pop-up** — the always-visible add form (name/supplier/price/delivery) that took a full row is replaced by a compact "＋ Add ingredient" button that opens a small dialog. Adds the same way and closes on success.
  - On **Products**, the standalone "★ Branded export" button is folded into the **Export ▾** menu alongside Excel / CSV / Print — the branded customer document is the first item.
  - The **category filter is now a segmented switch** (All · Cold Press · Fresh Frozen · Fresh Ambient), matching the D2C/Trade and Standard/Actual switches. The **brand filter** stays a dropdown (a switch would be too wide for that many brands) but is restyled as a pill to match the switches.

## v20 — July 2026
**Added the Planning module** — a new team-planning section (tasks, projects, delegation).
- **`planning.html`** (new) — served at `/planning`. Four views: **My work · Team · Waiting on · Projects**. Add tasks, assign/delegate to any user, mark done. Matches the HQ brand (navy/cream/coral, Bobby Jones + Effra).
- **`planning.js`** (new) — `projects` + `tasks` tables and the `/api/team`, `/api/projects`, `/api/tasks` routes. **Additive only** — no existing tables or routes changed.
- **`server.js`** — four small, guarded hooks (load module at startup, serve `/planning`, route `/api` planning calls). Wrapped in try/catch so the Planning module can never crash Wilsons HQ.
- Not yet in the home menu — reached via `/planning` for now (menu tile is a planned follow-up, kept separate to avoid risky edits to the main app).

## v19 and earlier — production management
Recipes, ingredients, production board, deliveries, stock, suppliers, packaging, KPI dashboard, product specs, recipe costing, complaints, change log, users/roles/invites, backup & restore, Excel export. (Built prior to this changelog.)
