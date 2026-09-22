# Wilsons HQ — Project Notes & Handoff

Read this first if you're picking up the project — a new Claude chat, or a developer. It exists so continuity lives **with the code**, not inside any one chat window.

## What this is
Wilsons HQ is Wilsons Pet Food's internal **operations platform** — one app the team logs into. It began as production management (recipes, production, KPIs, compliance) and is being extended into a unified platform with a **Planning** section (tasks, projects, delegation) for Kamil (Head of Operations) and his team.

## How it's built & runs
- **Backend:** a single Node file, `server.js` — Node 22 with **built-in `node:sqlite`** (zero npm dependencies). Real database in `app.db` (SQLite) on Railway's persistent volume (`$HOME/data`).
- **Auth:** username/password with salted hashing + session tokens. Users have roles (`admin`/`staff`) and an **invite system** (admins invite; the person sets their own password). Browser stores the token as `localStorage['wpm_token']`; API calls send `Authorization: Bearer <token>`.
- **Front-end:** static HTML pages served by `server.js` — `index.html` (main SPA), `kpi.html`, `specs.html`, `costing.html`, `planning.html`. Fonts + logo in `assets/`. Brand: navy `#143644`, warm cream `#f7f4ec`, coral `#e2606c`; Bobby Jones (display) + Effra (body).
- **Repo → deploy:** GitHub **`kamilskrzeszowski/wilsons-backend`** → **Railway** auto-deploys (`npm start` = `node --experimental-sqlite server.js`). Live at **https://wilsons-backend-production.up.railway.app**.
- **Version:** `APP_VERSION` in `server.js`; see `CHANGELOG.md`.

## Golden rules
- **Additive only.** Never modify or drop existing tables/routes/data. New features add new tables + new routes.
- **Take a Backup (the app's Backup button) before every deploy** — it exports the whole database.
- **Keep the approved design as-is.**
- Kamil is a **non-developer** — explain in plain English, avoid jargon, and check before anything needing new accounts/services. Ask rather than guess.

## Planning module (current work)
- Files: `planning.html`, `planning.js`, plus small guarded hooks in `server.js`.
- Tables: `projects`, and `tasks` (a task has: `assignee` = a user id, `created_by`, `project_id`, `due`, `prio`, `status`, `site`).
- Reached at `/planning`. It serves to anyone; the page checks your login and redirects to sign-in if needed — data is protected by the API.

## Roadmap / what's next
1. **Home-menu tile** for Planning (do carefully — `index.html` is a large single-page app).
2. **Invite Stephanie** (and the ops team) as users → they become assignable → real delegation.
3. **Reminders** — the always-on server nudges people when tasks are due/overdue.
4. **Email-to-staff** — assign emails from Outlook. Kamil wants (a) a button in Outlook and (b) forward-with-a-note. Simplest start: tag an email with an Outlook **category** → the app turns it into an assigned task.
5. **Fold in the earlier ops-app** (Outlook 3×/day action-item sweep + AI reply drafting in Kamil's voice — currently a separate app) once the core is solid.
