# Wilsons HQ — Changelog

Records changes to the Wilsons HQ app going forward. Bump `APP_VERSION` in `server.js` with each release. (Versions before v20 were built earlier and aren't itemised here.)

## v29 — 19 July 2026
**Planning: task detail + activity log** (Phase 1.2 of the Planning roadmap — see `PLANNING-ROADMAP.md`).
- **Tap any task to open it** — from My work, Waiting on, Team or Projects — and see/edit everything: title, notes, due date, priority, project, assignee, site. Saves send only the fields that actually changed (a merge-style PUT), matching this app's existing costing-save safety pattern.
- **New activity trail per task**, append-only: who created it, every reassignment, every status change, and every edit — described in plain English (e.g. "Updated due date to 2026-08-15, priority to High") — plus any comments. Comments post straight from the detail view. Nothing is ever rewritten, only added to.
- **Mark done / reopen** is now also available from the detail view (not just the list checkbox), and stays in sync with it live.
- **New, additive-only data:** a `task_activity` table (`id, task_id, user_id, kind, text, ts`; `kind` ∈ create|assign|status|edit|comment) and two new routes, `GET /api/tasks/:id/activity` and `POST /api/tasks/:id/comment`. Nothing existing was changed — the routes already fell inside the existing Planning permission gate (it matches on the `/api/tasks` prefix), so no `server.js` routing changes were needed at all this round.
- **New "Planning task activity" sheet in the Excel backup** (most recent 1,000 entries — the complete, uncapped history is always in `app.db` inside the same zip), matching how the v28 routines table got its own sheet.
- **Correctness details verified in testing:** resending an unchanged assignee or status (which the new detail form does whenever you save other fields) no longer sends a spurious re-assignment email or silently re-stamps `done_at` — both are now gated on the value actually changing, confirmed with a live before/after test. Two same-millisecond activity rows (e.g. create+assign, logged in the same request) are kept in true insertion order via a `rowid` tiebreaker.
- Verified with a 30+ assertion test against the real module (not a copy), a full live-HTTP smoke test, the "delete planning.js, does HQ still boot" guard re-test, and a full browser walkthrough — see LOGBOOK.md Round 16 for detail.

## v28 — 19 July 2026
**Planning: recurring/routine tasks** (Phase 1.1 of the Planning roadmap — see `PLANNING-ROADMAP.md`).
- **New "Routines" tab in Planning.** Set up a task that repeats — daily, weekly (any combination of days), or monthly (a chosen day of the month, or the last day) — assign it to someone, and HQ creates the actual task automatically each time it falls due, on schedule. No need to remember to add it by hand.
- Tasks a routine created carry a small **↻ mark** in the task list, so it's always obvious which ones were generated automatically vs added by hand.
- Each routine can be **paused, resumed, edited or deleted** independently. Deleting a routine removes only the repeating rule — any tasks it already created are real history and are left exactly as they were (this app's consistent policy: never rewrite past records).
- **New, additive-only data:** a `task_templates` table (the routines themselves) and a `template_id` marker on `tasks` (which routine, if any, made this one). Nothing existing was changed — Planning's existing tasks/projects/team data and every other module are completely untouched.
- **Correctness foundation:** the server now pins its own clock to UK time (`Europe/London`), so the new routine scheduler can correctly answer "what day is it" across the GMT/BST switch — this is the first time the *server itself* (rather than the browser, which already did this correctly per the v26 fixes) has needed to know today's date. Verified with 27 unit tests covering month-end clamping, week wrap-around, leap years and the BST boundary, plus live end-to-end tests proving routines never duplicate a task for the same date even if the schedule is rewound, and that HQ boots and runs normally with the Planning module entirely removed.
- Checked every 30 minutes, and once when the app starts, so a routine due today shows up promptly without a long wait.

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
