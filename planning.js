/* Wilsons HQ — Planning module (tasks, projects, delegation, recurring routines).
 * ADDITIVE ONLY: creates its own tables, never touches existing ones.
 * Loaded + hooked from server.js inside try/catch so it can never take HQ down.
 */
'use strict';

let H = {
  now: () => new Date().toISOString(),
  uid: (p) => (p || '') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
};
let DB = null; // stashed at init() so runRoutines() can run from a setInterval tick (no per-request ctx)

const PROJECT_SEED = [
  { name: 'Germany Export Compliance', color: '#007985', meta: 'EHCs · vet sign-off · species attestation' },
  { name: 'DJL vs Winterbrook Review', color: '#7a3b8f', meta: 'Cost review · in-house blending' },
  { name: 'Fresh Range Fulfilment', color: '#3f7d3f', meta: 'Orders & channel delivery' },
  { name: 'Blairgowrie Line 2', color: '#143644', meta: 'Sanitation & restart' },
  { name: 'Drongan Racking', color: '#e2606c', meta: 'Pallet racking install' },
];

function init(db, helpers) {
  if (helpers) H = helpers;
  DB = db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects(
      id TEXT PRIMARY KEY, name TEXT, color TEXT DEFAULT '#6f7b82', meta TEXT DEFAULT '',
      status TEXT DEFAULT 'active', created TEXT, created_by INTEGER
    );
    CREATE TABLE IF NOT EXISTS tasks(
      id TEXT PRIMARY KEY, title TEXT, notes TEXT DEFAULT '', project_id TEXT DEFAULT '',
      assignee INTEGER, created_by INTEGER, due TEXT DEFAULT '', prio TEXT DEFAULT 'med',
      status TEXT DEFAULT 'open', site TEXT DEFAULT '', email_link TEXT DEFAULT '',
      created TEXT, updated TEXT, done_at TEXT DEFAULT ''
    );
  `);
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)'); } catch (e) {}
  // v28: which routine (if any) generated this task — so it can be shown with a repeat marker,
  // and so the scheduler can tell "have I already made today's copy of this routine?"
  try { db.exec("ALTER TABLE tasks ADD COLUMN template_id TEXT DEFAULT ''"); } catch (e) {}
  // v31: subtasks/checklist — a JSON array of {text,done}, e.g. '[{"text":"Order totes","done":false}]'.
  // A JSON column (not a separate table) since a task's checklist is small, always loaded with the
  // task itself, and never queried independently — exactly the case the roadmap flagged as fine for this.
  try { db.exec("ALTER TABLE tasks ADD COLUMN checklist TEXT DEFAULT ''"); } catch (e) {}
  // v34: email → task (Phase 4). ext_id is the Graph message id — the dedupe key so re-polling an
  // email that's still tagged (e.g. because clearing its category failed) never creates a second
  // task. source distinguishes an imported task from one typed in by hand.
  try { db.exec("ALTER TABLE tasks ADD COLUMN ext_id TEXT DEFAULT ''"); } catch (e) {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN source TEXT DEFAULT 'manual'"); } catch (e) {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_ext_id ON tasks(ext_id)"); } catch (e) {}
  // v28: recurring/routine task templates. `rule` is a small string the server understands:
  //   'daily'  |  'weekly:mon,thu'  (any of sun/mon/tue/wed/thu/fri/sat)  |  'monthly:15'  |  'monthly:last'
  // `next_due` is the next date (YYYY-MM-DD, UK local) this routine should generate a task for.
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_templates(
      id TEXT PRIMARY KEY, title TEXT, notes TEXT DEFAULT '', project_id TEXT DEFAULT '',
      assignee INTEGER, prio TEXT DEFAULT 'med', site TEXT DEFAULT '',
      rule TEXT, next_due TEXT, active INTEGER DEFAULT 1,
      created_by INTEGER, created TEXT
    );
  `);
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_templates_active ON task_templates(active, next_due)'); } catch (e) {}
  // v29: activity trail for a task — one row per create/assign/status-change/edit/comment, so
  // delegation has a record of what was said and done. Never rewritten, only appended to.
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_activity(
      id TEXT PRIMARY KEY, task_id TEXT, user_id INTEGER, kind TEXT, text TEXT DEFAULT '', ts TEXT
    );
  `);
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_activity_task ON task_activity(task_id, ts)'); } catch (e) {}
  // v33: guards the daily digest email against double-sending — one row per user+date+kind, so a
  // restart (or an overlapping 5-min tick) that re-checks "have I sent today's digest" always finds
  // the answer here rather than relying on in-memory state that a restart would lose.
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders_sent(
      user_id INTEGER, date TEXT, kind TEXT, sent_at TEXT,
      PRIMARY KEY(user_id, date, kind)
    );
  `);
  // seed a starter set of projects only if there are none yet (idempotent)
  try {
    if (db.prepare('SELECT count(*) c FROM projects').get().c === 0) {
      const ins = db.prepare('INSERT INTO projects(id,name,color,meta,status,created) VALUES(?,?,?,?,?,?)');
      PROJECT_SEED.forEach(p => ins.run(H.uid('p'), p.name, p.color, p.meta, 'active', H.now()));
    }
  } catch (e) {}
}

// Email the assignee that a task was assigned to them — only when it's someone OTHER than the
// person doing the assigning, and only if server.js provided a notifier. Never throws.
function notify(db, assigneeId, byUser, t) {
  try {
    if (!H.notifyAssign || !assigneeId || assigneeId === byUser.id) return;
    let project = '';
    try { if (t.project_id) project = (db.prepare('SELECT name FROM projects WHERE id=?').get(t.project_id) || {}).name || ''; } catch (e) {}
    H.notifyAssign({ assigneeId: assigneeId, byName: byUser.username, title: t.title, due: t.due || '', prio: t.prio || 'med', project: project });
  } catch (e) {}
}

/* ---------------- activity trail (v29) ----------------
 * One append-only row per meaningful thing that happened to a task. `text` is a plain-English,
 * already-resolved sentence (server has the DB, so it resolves names/projects here rather than
 * pushing that lookup onto the client) — the client only needs to show the actor's avatar (from
 * user_id, via the same person() lookup used everywhere else) next to it. Never throws: a logging
 * failure must not block the actual task change. */
function logActivity(db, taskId, userId, kind, text) {
  try {
    db.prepare('INSERT INTO task_activity(id,task_id,user_id,kind,text,ts) VALUES(?,?,?,?,?,?)')
      .run(H.uid('a'), taskId, userId, kind, text || '', H.now());
  } catch (e) { console.log('planning activity log failed:', e.message); }
}
function titlecaseName(u) { return String(u || '').replace(/[._-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }
function nameOf(db, userId) {
  if (userId === null || userId === undefined) return '';
  try { const u = db.prepare('SELECT username FROM users WHERE id=?').get(userId); return u ? u.username : ''; } catch (e) { return ''; }
}
function assignText(db, uid) {
  if (uid === null || uid === undefined) return 'Unassigned';
  const name = titlecaseName(nameOf(db, uid));
  return name ? ('Assigned to ' + name) : 'Assigned';
}
const EDIT_FIELD_LABEL = { title: 'title', notes: 'notes', site: 'site' };
const PRIO_LABEL = { high: 'High', med: 'Medium', low: 'Low' };
// Describes what a single field change means in plain English, e.g. "priority to High". Falls back
// to just the field's label for free-text fields where inlining the value would be unwieldy.
function fieldChangeText(db, field, newVal) {
  if (field === 'prio') return 'priority to ' + (PRIO_LABEL[newVal] || newVal);
  if (field === 'due') return newVal ? ('due date to ' + newVal) : 'due date cleared';
  if (field === 'project_id') {
    if (!newVal) return 'project cleared';
    let p = null; try { p = db.prepare('SELECT name FROM projects WHERE id=?').get(newVal); } catch (e) {}
    return 'project to ' + (p ? p.name : newVal);
  }
  return EDIT_FIELD_LABEL[field] || field;
}
function parseChecklist(raw) {
  try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
// Describes a checklist change in plain English by diffing old vs new. Handles the three ways the
// client ever actually changes a checklist (add one item, remove one item, toggle one item's done
// state) with a specific line; anything odd (e.g. two changes landing in one PUT) falls back to a
// generic line rather than guessing.
function checklistChangeText(before, after) {
  if (after.length > before.length) {
    const added = after.slice(before.length);
    return added.length === 1 ? ('Added checklist item “' + added[0].text + '”') : ('Added ' + added.length + ' checklist items');
  }
  if (after.length < before.length) {
    return before.length - after.length === 1 ? 'Removed a checklist item' : ('Removed ' + (before.length - after.length) + ' checklist items');
  }
  for (let i = 0; i < after.length; i++) {
    if (before[i] && after[i] && before[i].done !== after[i].done) {
      return (after[i].done ? 'Checked off “' : 'Unchecked “') + after[i].text + '”';
    }
  }
  return 'Updated checklist';
}

/* ---------------- recurring routines: date engine ----------------
 * All "today"/date-only logic below reads LOCAL Date getters (getFullYear/getMonth/getDate), which
 * server.js pins to Europe/London (process.env.TZ) — so this is correct across the GMT/BST switch
 * the same way the browser-side date fixes elsewhere in this app are. Never use toISOString() for
 * a date-only value: it's UTC and would be a day out for the first hour of a BST day. */
const DOW_CODES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function isoDateLocal(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function todayISOLocal() { return isoDateLocal(new Date()); }
function parseISODateLocal(s) { const p = String(s || '').split('-').map(Number); if (p.length !== 3 || p.some(n => !Number.isFinite(n))) return null; return new Date(p[0], p[1] - 1, p[2]); }
function daysInMonth(year, month0) { return new Date(year, month0 + 1, 0).getDate(); }
// Validates a rule string; returns a normalised copy, or null if it doesn't make sense.
function parseRule(rule) {
  rule = String(rule || '').trim().toLowerCase();
  if (rule === 'daily') return rule;
  if (/^weekly:/.test(rule)) {
    const days = rule.slice(7).split(',').map(s => s.trim()).filter(Boolean);
    if (!days.length || !days.every(d => DOW_CODES.includes(d))) return null;
    return 'weekly:' + [...new Set(days)].sort((a, b) => DOW_CODES.indexOf(a) - DOW_CODES.indexOf(b)).join(',');
  }
  if (/^monthly:/.test(rule)) {
    const spec = rule.slice(8).trim();
    if (spec === 'last') return 'monthly:last';
    const n = parseInt(spec, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 31 && String(n) === spec) return 'monthly:' + n;
    return null;
  }
  return null;
}
// The day-of-month a 'monthly:...' rule means for a given year/month, clamped to that month's
// actual length (so "monthly:31" in February means the 28th/29th, not an overflow into March —
// the same clamp-don't-overflow approach the recipe best-before fix uses).
function monthlyDayFor(spec, year, month0) {
  const dim = daysInMonth(year, month0);
  if (spec === 'last') return dim;
  const n = parseInt(spec, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, dim);
}
// First occurrence ON OR AFTER startISO (inclusive) — used once, when a routine is created/edited.
function firstDueOnOrAfter(rule, startISO) {
  const start = parseISODateLocal(startISO); if (!start) return null;
  if (rule === 'daily') return isoDateLocal(start);
  if (rule.startsWith('weekly:')) {
    const wanted = rule.slice(7).split(',').map(d => DOW_CODES.indexOf(d)).filter(n => n >= 0);
    if (!wanted.length) return null;
    for (let i = 0; i < 14; i++) { const d = new Date(start); d.setDate(d.getDate() + i); if (wanted.includes(d.getDay())) return isoDateLocal(d); }
    return null;
  }
  if (rule.startsWith('monthly:')) {
    const spec = rule.slice(8);
    let year = start.getFullYear(), month0 = start.getMonth();
    let day = monthlyDayFor(spec, year, month0);
    if (day != null) { const c = new Date(year, month0, day); if (c >= start) return isoDateLocal(c); }
    month0++; if (month0 > 11) { month0 = 0; year++; }
    day = monthlyDayFor(spec, year, month0);
    return day == null ? null : isoDateLocal(new Date(year, month0, day));
  }
  return null;
}
// Next occurrence STRICTLY AFTER fromISO — used to advance a routine once its due task is made.
function nextDueAfter(rule, fromISO) {
  const from = parseISODateLocal(fromISO); if (!from) return null;
  if (rule === 'daily') { const d = new Date(from); d.setDate(d.getDate() + 1); return isoDateLocal(d); }
  if (rule.startsWith('weekly:')) {
    const wanted = rule.slice(7).split(',').map(d => DOW_CODES.indexOf(d)).filter(n => n >= 0);
    if (!wanted.length) return null;
    for (let i = 1; i <= 14; i++) { const d = new Date(from); d.setDate(d.getDate() + i); if (wanted.includes(d.getDay())) return isoDateLocal(d); }
    return null;
  }
  if (rule.startsWith('monthly:')) {
    const spec = rule.slice(8);
    let year = from.getFullYear(), month0 = from.getMonth() + 1; if (month0 > 11) { month0 = 0; year++; }
    const day = monthlyDayFor(spec, year, month0);
    return day == null ? null : isoDateLocal(new Date(year, month0, day));
  }
  return null;
}
// Generate today's due routine tasks. Idempotent (safe to call repeatedly/on overlapping ticks):
// checks for an existing task from this template with this exact due date before creating one.
// Deliberately does NOT send an assignment email for routine-generated tasks (that would mean a
// daily routine emailing someone every single day) — email reminders are a separate, later phase.
function runRoutines() {
  if (!DB) return 0;
  let created = 0;
  const todayIso = todayISOLocal();
  let templates = [];
  try { templates = DB.prepare('SELECT * FROM task_templates WHERE active=1 AND next_due IS NOT NULL AND next_due <> \'\' AND next_due <= ?').all(todayIso); }
  catch (e) { console.log('planning routines: could not read templates:', e.message); return 0; }
  templates.forEach(t => {
    try {
      const exists = DB.prepare('SELECT id FROM tasks WHERE template_id=? AND due=?').get(t.id, t.next_due);
      if (!exists) {
        const id = H.uid('t');
        DB.prepare(`INSERT INTO tasks(id,title,notes,project_id,assignee,created_by,due,prio,status,site,email_link,template_id,created,updated)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id, t.title, t.notes || '', t.project_id || '', t.assignee, t.created_by, t.next_due, t.prio || 'med', 'open', t.site || '', '', t.id, H.now(), H.now());
        created++;
      }
      const nd = nextDueAfter(t.rule, t.next_due);
      DB.prepare('UPDATE task_templates SET next_due=? WHERE id=?').run(nd || '', t.id);
    } catch (e) { console.log('planning routines: template ' + t.id + ' failed:', e.message); }
  });
  return created;
}

/* ---------------- daily digest email (v33) ----------------
 * Wall-clock, not boot-relative: a 5-min tick (server.js) calls this, and for each opted-in user it
 * checks "has their preferred send time passed today, and have I not already sent" — guarded by
 * reminders_sent so a restart or an overlapping tick never double-sends. Skips entirely, cheaply,
 * if mail is off/paused. A user with zero open tasks is marked "handled" without sending anything
 * (an assignment later that same day is already covered by the existing notifyAssign email). */
const DOW_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function friendlyDate(iso) {
  const d = parseISODateLocal(iso); if (!d) return iso;
  return DOW_FULL[d.getDay()] + ' ' + d.getDate() + ' ' + MON_FULL[d.getMonth()];
}
function nowHM() { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
// Returns the HTML for the body of the digest, or null if this person has no open tasks at all
// (in which case nothing is sent — see the caller). Tasks with no due date are deliberately left
// out of the three time-based buckets below; a digest is about timing, not the whole backlog.
function digestBodyHtml(db, userId, todayIso) {
  const tasks = db.prepare("SELECT * FROM tasks WHERE assignee=? AND status<>'done'").all(userId);
  if (!tasks.length) return null;
  const byDue = (a, b) => (a.due || '').localeCompare(b.due || '');
  const overdue = tasks.filter(t => t.due && t.due < todayIso).sort(byDue);
  const dueToday = tasks.filter(t => t.due === todayIso);
  const soon = tasks.filter(t => t.due && t.due > todayIso).sort(byDue).slice(0, 5);
  const row = t => '<div style="padding:6px 0;border-bottom:1px solid #eee">' + escHtml(t.title) + (t.due ? ' <span style="color:#8a97a0">— ' + escHtml(t.due) + '</span>' : '') + '</div>';
  const section = (label, rows, color) => rows.length ? ('<p style="margin:14px 0 4px;font-weight:700;color:' + color + '">' + escHtml(label) + ' (' + rows.length + ')</p>' + rows.map(row).join('')) : '';
  const body = section('Overdue', overdue, '#c0563b') + section('Due today', dueToday, '#e0a13f') + section('Coming up', soon, '#4b5f6d');
  return body || '<p style="margin:0">Nothing urgent — but you do have open tasks assigned. Take a look when you get a chance.</p>';
}
async function runReminders() {
  if (!DB) return 0;
  if (!H.mailOn || !H.mailOn()) return 0;
  let sent = 0;
  const todayIso = todayISOLocal();
  const hm = nowHM();
  let users = [];
  try { users = DB.prepare("SELECT id, username, email, digest_time FROM users WHERE digest_opt_in=1 AND email<>''").all(); }
  catch (e) { console.log('planning reminders: could not read users:', e.message); return 0; }
  for (const u of users) {
    try {
      const target = /^\d{2}:\d{2}$/.test(u.digest_time || '') ? u.digest_time : '07:30';
      if (hm < target) continue;
      const already = DB.prepare('SELECT 1 FROM reminders_sent WHERE user_id=? AND date=? AND kind=?').get(u.id, todayIso, 'digest');
      if (already) continue;
      const body = digestBodyHtml(DB, u.id, todayIso);
      if (body == null) { DB.prepare('INSERT INTO reminders_sent(user_id,date,kind,sent_at) VALUES(?,?,?,?)').run(u.id, todayIso, 'digest', H.now()); continue; }
      const subject = 'Your tasks — ' + friendlyDate(todayIso);
      await H.sendMail(u.email, subject, H.emailShell(subject, body, 'Open Planning', '/planning'));
      DB.prepare('INSERT INTO reminders_sent(user_id,date,kind,sent_at) VALUES(?,?,?,?)').run(u.id, todayIso, 'digest', H.now());
      sent++;
    } catch (e) { console.log('planning reminders: user ' + u.id + ' failed:', e.message); }
  }
  return sent;
}

/* ---------------- email → task (v34, Phase 4; v35 adds teammate routing; v36 adds notification) ----
 * Outlook category → task. Tag an email with the agreed category (default "Task") and it's
 * assigned to you (the mailbox owner); tag it "Task: Jane" instead and it's assigned straight to
 * whichever teammate that names — this tick polls the watched mailbox for messages carrying either
 * form, creates one task per message, then tries to clear the specific category so it isn't
 * re-imported. Anyone other than the mailbox owner who picks up a task this tick gets a single
 * combined email once the whole tick is done, not one email per task. ext_id (the Graph message id)
 * is the real dedupe guard — clearing the category is best-effort cleanup, not the safety mechanism,
 * so a failed clear just means the same message
 * gets looked at again next tick (and is correctly skipped, not duplicated).
 * Gated on TWO switches, not one: mailOn() (the general email on/off), and emailImportEnabled()
 * (its own explicit opt-in, since this feature also WRITES to a real mailbox, not just reads). */
function normalizeForMatch(s) { return String(s || '').toLowerCase().replace(/[._-]+/g, ' ').trim().replace(/\s+/g, ' '); }
function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// Resolves a category suffix like "Jane" or "jane.doe" to exactly one user. Never guesses: zero
// matches or more than one both return null, so the caller falls back to the mailbox owner rather
// than risk assigning to the wrong person on a hunch.
function resolveAssigneeFromSuffix(db, suffix) {
  const target = normalizeForMatch(suffix);
  if (!target) return null;
  const users = db.prepare('SELECT id, username FROM users').all();
  const exact = users.filter(u => normalizeForMatch(u.username) === target);
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) return null;
  const prefix = users.filter(u => { const n = normalizeForMatch(u.username); return n.startsWith(target) || target.startsWith(n); });
  return prefix.length === 1 ? prefix[0].id : null;
}
async function runEmailImport() {
  if (!DB) return 0;
  if (!H.mailOn || !H.mailOn()) return 0;
  if (!H.emailImportEnabled || !H.emailImportEnabled()) return 0;
  if (!H.graphFetch || !H.mailFrom) return 0;
  const mailbox = H.mailFrom;
  const owner = DB.prepare('SELECT id, username FROM users WHERE email=?').get(mailbox);
  if (!owner) { console.log('planning email-import: no HQ user account matches the watched mailbox (' + mailbox + ') — skipping'); return 0; }
  const category = H.mailTaskCategory || 'Task';
  const suffixRe = new RegExp('^' + escapeRegex(category) + '\\s*:\\s*(.+)$', 'i');
  let messages = [];
  try {
    // startswith() catches both "Task" and "Task: Name" in one query; each result is re-checked
    // against suffixRe/exact-match below rather than trusted, in case the filter is broader than
    // intended (e.g. it would also technically match an unrelated "Taskforce" category).
    const filter = "categories/any(c:startswith(c,'" + category.replace(/'/g, "''") + "'))";
    const path = '/users/' + encodeURIComponent(mailbox) + '/messages?$filter=' + encodeURIComponent(filter) + '&$select=id,subject,bodyPreview,webLink,categories&$top=25';
    const data = await H.graphFetch('GET', path);
    messages = (data && data.value) || [];
    if (messages.length === 25) console.log('planning email-import: hit the 25-message cap this tick — any further tagged emails will be picked up on a later tick');
  } catch (e) { console.log('planning email-import: could not fetch tagged messages:', e.message); return 0; }
  let imported = 0;
  const toNotify = new Map(); // assigneeId -> [{title,due,prio,project}] — one combined email per person per tick
  for (const msg of messages) {
    try {
      const cats = msg.categories || [];
      const matched = cats.find(c => c === category) || cats.find(c => suffixRe.test(c));
      if (!matched) { console.log('planning email-import: message ' + msg.id + ' looked like a match but has no real ' + category + ' category on closer look — skipping'); continue; }
      const suffixMatch = matched.match(suffixRe);
      let assignee = owner.id, assignNote = '';
      if (suffixMatch) {
        const resolved = resolveAssigneeFromSuffix(DB, suffixMatch[1]);
        if (resolved) assignee = resolved;
        else assignNote = ' (couldn’t match the teammate named in “' + matched + '” — assigned to you instead)';
      }
      const existing = DB.prepare('SELECT id FROM tasks WHERE ext_id=?').get(msg.id);
      if (!existing) {
        const id = H.uid('t');
        DB.prepare(`INSERT INTO tasks(id,title,notes,project_id,assignee,created_by,due,prio,status,site,email_link,ext_id,source,created,updated)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id, msg.subject || '(no subject)', msg.bodyPreview || '', '', assignee, owner.id, '', 'med', 'open', '', msg.webLink || '', msg.id, 'outlook', H.now(), H.now());
        logActivity(DB, id, owner.id, 'create', 'Created from an email' + assignNote);
        if (assignee !== owner.id) {
          logActivity(DB, id, owner.id, 'assign', assignText(DB, assignee));
          if (!toNotify.has(assignee)) toNotify.set(assignee, []);
          toNotify.get(assignee).push({ title: msg.subject || '(no subject)', due: '', prio: 'med', project: '' });
        }
        imported++;
      }
      // Attempted every time this message is seen, whether just-created or a repeat visit — a
      // repeat visit only happens because a prior clear failed, so this is the natural retry.
      try {
        const remaining = cats.filter(c => c !== matched);
        await H.graphFetch('PATCH', '/users/' + encodeURIComponent(mailbox) + '/messages/' + encodeURIComponent(msg.id), { categories: remaining });
      } catch (e) { console.log('planning email-import: could not clear the category on message ' + msg.id + ':', e.message); }
    } catch (e) { console.log('planning email-import: message ' + msg.id + ' failed:', e.message); }
  }
  if (H.notifyAssignBatch) {
    for (const [assigneeId, tasks] of toNotify) {
      try { H.notifyAssignBatch({ assigneeId: assigneeId, byName: owner.username, tasks: tasks }); } catch (e) {}
    }
  }
  return imported;
}

// Returns true if it handled the route, false otherwise. Wrapped in try/catch by server.js.
async function handle(ctx) {
  const { url, method, req, res, user, db, json, readBody } = ctx;
  const m = method;
  const last = () => decodeURIComponent(url.split('/').pop());

  // Team members (any signed-in user) — for the assignee picker.
  if (url === '/api/team' && m === 'GET') {
    const team = db.prepare('SELECT id, username, role, factory FROM users ORDER BY username').all();
    json(res, 200, { team }); return true;
  }

  // Projects
  if (url === '/api/projects' && m === 'GET') {
    // Archived projects are included deliberately — the client filters them out of pickers, but
    // still needs them to resolve the project pill/name on tasks that were assigned before archiving.
    json(res, 200, { projects: db.prepare('SELECT * FROM projects ORDER BY created').all() });
    return true;
  }
  if (url === '/api/projects' && m === 'POST') {
    const b = await readBody(req);
    if (!b.name || !String(b.name).trim()) { json(res, 400, { error: 'Project name required' }); return true; }
    const id = H.uid('p');
    db.prepare('INSERT INTO projects(id,name,color,meta,status,created,created_by) VALUES(?,?,?,?,?,?,?)')
      .run(id, String(b.name).trim(), b.color || '#6f7b82', b.meta || '', 'active', H.now(), user.id);
    json(res, 200, { id }); return true;
  }
  if (url.startsWith('/api/projects/') && m === 'PUT') {
    const id = last(); const b = await readBody(req);
    if (!db.prepare('SELECT id FROM projects WHERE id=?').get(id)) { json(res, 404, { error: 'not found' }); return true; }
    ['name', 'color', 'meta', 'status'].forEach(f => { if (b[f] !== undefined) db.prepare('UPDATE projects SET ' + f + '=? WHERE id=?').run(b[f], id); });
    json(res, 200, { ok: true }); return true;
  }

  // Tasks
  if (url === '/api/tasks' && m === 'GET') {
    json(res, 200, { tasks: db.prepare('SELECT * FROM tasks ORDER BY created DESC').all() });
    return true;
  }
  if (url === '/api/tasks' && m === 'POST') {
    const b = await readBody(req);
    if (!b.title || !String(b.title).trim()) { json(res, 400, { error: 'Task title required' }); return true; }
    const id = H.uid('t');
    const assignee = (b.assignee !== undefined && b.assignee !== null && b.assignee !== '') ? Number(b.assignee) : user.id;
    db.prepare('INSERT INTO tasks(id,title,notes,project_id,assignee,created_by,due,prio,status,site,email_link,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, String(b.title).trim(), b.notes || '', b.project_id || '', assignee, user.id, b.due || '', b.prio || 'med', 'open', b.site || '', b.email_link || '', H.now(), H.now());
    logActivity(db, id, user.id, 'create', 'Created');
    if (assignee !== user.id) logActivity(db, id, user.id, 'assign', assignText(db, assignee));
    notify(db, assignee, user, { title: String(b.title).trim(), due: b.due || '', prio: b.prio || 'med', project_id: b.project_id || '' });
    json(res, 200, { id }); return true;
  }
  if (url.startsWith('/api/tasks/') && m === 'PUT') {
    const id = last(); const b = await readBody(req);
    const before = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!before) { json(res, 404, { error: 'not found' }); return true; }
    // Only the plain fields — assignee and status get their own activity kind below.
    const editedFields = ['title', 'notes', 'project_id', 'due', 'prio', 'site'].filter(f => b[f] !== undefined && b[f] !== before[f]);
    ['title', 'notes', 'project_id', 'due', 'prio', 'status', 'site'].forEach(f => {
      if (b[f] !== undefined) db.prepare('UPDATE tasks SET ' + f + '=? WHERE id=?').run(b[f], id);
    });
    if (editedFields.length) logActivity(db, id, user.id, 'edit', 'Updated ' + editedFields.map(f => fieldChangeText(db, f, b[f])).join(', '));
    if (b.checklist !== undefined) {
      const newList = Array.isArray(b.checklist) ? b.checklist.map(it => ({ text: String((it || {}).text || '').trim(), done: !!(it || {}).done })).filter(it => it.text) : [];
      const newJson = JSON.stringify(newList);
      if (newJson !== (before.checklist || '[]')) {
        const oldList = parseChecklist(before.checklist);
        db.prepare('UPDATE tasks SET checklist=? WHERE id=?').run(newJson, id);
        logActivity(db, id, user.id, 'edit', checklistChangeText(oldList, newList));
      }
    }
    if (b.assignee !== undefined) {
      const na = (b.assignee === '' || b.assignee === null) ? null : Number(b.assignee);
      const priorAssignee = (before.assignee === null || before.assignee === undefined) ? null : before.assignee;
      db.prepare('UPDATE tasks SET assignee=? WHERE id=?').run(na, id);
      if (na !== priorAssignee) {
        logActivity(db, id, user.id, 'assign', assignText(db, na));
        const t = { title: b.title !== undefined ? b.title : before.title, due: b.due !== undefined ? b.due : before.due, prio: b.prio !== undefined ? b.prio : before.prio, project_id: b.project_id !== undefined ? b.project_id : before.project_id };
        notify(db, na, user, t);
      }
    }
    if (b.status !== undefined && b.status !== before.status) {
      db.prepare('UPDATE tasks SET done_at=? WHERE id=?').run(b.status === 'done' ? H.now() : '', id);
      logActivity(db, id, user.id, 'status', b.status === 'done' ? 'Marked done' : 'Reopened');
    }
    db.prepare('UPDATE tasks SET updated=? WHERE id=?').run(H.now(), id);
    json(res, 200, { ok: true }); return true;
  }
  if (url.startsWith('/api/tasks/') && m === 'DELETE') {
    db.prepare('DELETE FROM tasks WHERE id=?').run(last());
    json(res, 200, { ok: true }); return true;
  }
  // Activity trail + comments (v29)
  if (/^\/api\/tasks\/[^/]+\/activity$/.test(url) && m === 'GET') {
    const id = decodeURIComponent(url.split('/')[3]);
    // rowid tiebreaker: two rows logged in the same request (e.g. create+assign) can share the same
    // millisecond timestamp; rowid preserves true insertion order when ts alone can't.
    json(res, 200, { activity: db.prepare('SELECT * FROM task_activity WHERE task_id=? ORDER BY ts ASC, rowid ASC').all(id) });
    return true;
  }
  if (/^\/api\/tasks\/[^/]+\/comment$/.test(url) && m === 'POST') {
    const id = decodeURIComponent(url.split('/')[3]);
    if (!db.prepare('SELECT id FROM tasks WHERE id=?').get(id)) { json(res, 404, { error: 'not found' }); return true; }
    const b = await readBody(req);
    const text = String(b.text || '').trim();
    if (!text) { json(res, 400, { error: 'Comment text required' }); return true; }
    logActivity(db, id, user.id, 'comment', text);
    db.prepare('UPDATE tasks SET updated=? WHERE id=?').run(H.now(), id);
    json(res, 200, { ok: true }); return true;
  }

  // Recurring / routine task templates (v28)
  if (url === '/api/task-templates' && m === 'GET') {
    json(res, 200, { templates: db.prepare('SELECT * FROM task_templates ORDER BY active DESC, next_due ASC, created ASC').all() });
    return true;
  }
  if (url === '/api/task-templates' && m === 'POST') {
    const b = await readBody(req);
    if (!b.title || !String(b.title).trim()) { json(res, 400, { error: 'Routine title required' }); return true; }
    const rule = parseRule(b.rule);
    if (!rule) { json(res, 400, { error: 'Please choose a valid repeat pattern.' }); return true; }
    const start = /^\d{4}-\d{2}-\d{2}$/.test(b.start || '') ? b.start : todayISOLocal();
    const nextDue = firstDueOnOrAfter(rule, start);
    if (!nextDue) { json(res, 400, { error: 'Could not work out when this routine should first run.' }); return true; }
    const id = H.uid('rt');
    const assignee = (b.assignee !== undefined && b.assignee !== null && b.assignee !== '') ? Number(b.assignee) : user.id;
    db.prepare('INSERT INTO task_templates(id,title,notes,project_id,assignee,prio,site,rule,next_due,active,created_by,created) VALUES(?,?,?,?,?,?,?,?,?,1,?,?)')
      .run(id, String(b.title).trim(), b.notes || '', b.project_id || '', assignee, b.prio || 'med', b.site || '', rule, nextDue, user.id, H.now());
    json(res, 200, { id, next_due: nextDue }); return true;
  }
  if (url.startsWith('/api/task-templates/') && m === 'PUT') {
    const id = last(); const b = await readBody(req);
    const ex = db.prepare('SELECT * FROM task_templates WHERE id=?').get(id);
    if (!ex) { json(res, 404, { error: 'not found' }); return true; }
    ['title', 'notes', 'project_id', 'prio', 'site'].forEach(f => { if (b[f] !== undefined) db.prepare('UPDATE task_templates SET ' + f + '=? WHERE id=?').run(b[f], id); });
    if (b.assignee !== undefined) { const na = (b.assignee === '' || b.assignee === null) ? null : Number(b.assignee); db.prepare('UPDATE task_templates SET assignee=? WHERE id=?').run(na, id); }
    if (b.rule !== undefined || b.start !== undefined) {
      const rule = parseRule(b.rule !== undefined ? b.rule : ex.rule);
      if (!rule) { json(res, 400, { error: 'Please choose a valid repeat pattern.' }); return true; }
      const start = /^\d{4}-\d{2}-\d{2}$/.test(b.start || '') ? b.start : (ex.next_due || todayISOLocal());
      const nextDue = firstDueOnOrAfter(rule, start);
      if (!nextDue) { json(res, 400, { error: 'Could not work out when this routine should next run.' }); return true; }
      db.prepare('UPDATE task_templates SET rule=?, next_due=? WHERE id=?').run(rule, nextDue, id);
    }
    if (b.active !== undefined) db.prepare('UPDATE task_templates SET active=? WHERE id=?').run(b.active ? 1 : 0, id);
    const now = db.prepare('SELECT next_due FROM task_templates WHERE id=?').get(id);
    json(res, 200, { ok: true, next_due: now ? now.next_due : null }); return true;
  }
  if (url.startsWith('/api/task-templates/') && m === 'DELETE') {
    // Deletes the routine only. Tasks it already generated are real history and are left exactly as
    // they are (this app's convention throughout is to never rewrite past records).
    db.prepare('DELETE FROM task_templates WHERE id=?').run(last());
    json(res, 200, { ok: true }); return true;
  }

  // Schedule view (v32): everything due in a date range — real tasks, plus routine occurrences
  // that haven't been generated into a real task yet. Read-only; the calendar grid is client-side.
  if (url === '/api/schedule' && m === 'GET') {
    const q = new URLSearchParams(req.url.split('?')[1] || '');
    const from = /^\d{4}-\d{2}-\d{2}$/.test(q.get('from') || '') ? q.get('from') : todayISOLocal();
    const to = /^\d{4}-\d{2}-\d{2}$/.test(q.get('to') || '') ? q.get('to') : from;
    const tasks = db.prepare('SELECT * FROM tasks WHERE due >= ? AND due <= ? ORDER BY due').all(from, to);
    const occurrences = [];
    // Occurrences depend only on the rule + the requested range, not on the template's own
    // next_due bookmark (that's just the scheduler's "next one to generate" pointer) — so this
    // reuses the exact same rule-walk functions the scheduler itself uses, just over a wider span.
    // NEVER synthesise an occurrence before today, though: a past date either has a real generated
    // task (already covered by `tasks` above) or it doesn't — a virtual "this should have happened"
    // marker on a past day the routine may not have even existed for yet would just be misleading.
    try {
      const today = todayISOLocal();
      const occFrom = from > today ? from : today;
      if (occFrom <= to) {
        const templates = db.prepare('SELECT * FROM task_templates WHERE active=1').all();
        templates.forEach(t => {
          let d = firstDueOnOrAfter(t.rule, occFrom);
          while (d && d <= to) {
            const alreadyGenerated = tasks.some(x => x.template_id === t.id && x.due === d);
            if (!alreadyGenerated) occurrences.push({ date: d, template_id: t.id, title: t.title, assignee: t.assignee, project_id: t.project_id || '', prio: t.prio || 'med' });
            d = nextDueAfter(t.rule, d);
          }
        });
      }
    } catch (e) { console.log('planning schedule: occurrence walk failed:', e.message); }
    json(res, 200, { tasks, occurrences }); return true;
  }

  return false;
}

module.exports = { init, handle, runRoutines, runReminders, runEmailImport };
