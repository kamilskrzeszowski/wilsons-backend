/* Wilsons HQ — Planning module (tasks, projects, delegation).
 * ADDITIVE ONLY: creates its own tables, never touches existing ones.
 * Loaded + hooked from server.js inside try/catch so it can never take HQ down.
 */
'use strict';

let H = {
  now: () => new Date().toISOString(),
  uid: (p) => (p || '') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
};

const PROJECT_SEED = [
  { name: 'Germany Export Compliance', color: '#007985', meta: 'EHCs · vet sign-off · species attestation' },
  { name: 'DJL vs Winterbrook Review', color: '#7a3b8f', meta: 'Cost review · in-house blending' },
  { name: 'Fresh Range Fulfilment', color: '#3f7d3f', meta: 'Orders & channel delivery' },
  { name: 'Blairgowrie Line 2', color: '#143644', meta: 'Sanitation & restart' },
  { name: 'Drongan Racking', color: '#e2606c', meta: 'Pallet racking install' },
];

function init(db, helpers) {
  if (helpers) H = helpers;
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
    json(res, 200, { projects: db.prepare("SELECT * FROM projects WHERE status <> 'archived' ORDER BY created").all() });
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
    notify(db, assignee, user, { title: String(b.title).trim(), due: b.due || '', prio: b.prio || 'med', project_id: b.project_id || '' });
    json(res, 200, { id }); return true;
  }
  if (url.startsWith('/api/tasks/') && m === 'PUT') {
    const id = last(); const b = await readBody(req);
    if (!db.prepare('SELECT id FROM tasks WHERE id=?').get(id)) { json(res, 404, { error: 'not found' }); return true; }
    ['title', 'notes', 'project_id', 'due', 'prio', 'status', 'site'].forEach(f => {
      if (b[f] !== undefined) db.prepare('UPDATE tasks SET ' + f + '=? WHERE id=?').run(b[f], id);
    });
    if (b.assignee !== undefined) {
      const na = (b.assignee === '' || b.assignee === null) ? null : Number(b.assignee);
      db.prepare('UPDATE tasks SET assignee=? WHERE id=?').run(na, id);
      const t = db.prepare('SELECT title,due,prio,project_id FROM tasks WHERE id=?').get(id) || {};
      notify(db, na, user, t);
    }
    if (b.status !== undefined) db.prepare('UPDATE tasks SET done_at=? WHERE id=?').run(b.status === 'done' ? H.now() : '', id);
    db.prepare('UPDATE tasks SET updated=? WHERE id=?').run(H.now(), id);
    json(res, 200, { ok: true }); return true;
  }
  if (url.startsWith('/api/tasks/') && m === 'DELETE') {
    db.prepare('DELETE FROM tasks WHERE id=?').run(last());
    json(res, 200, { ok: true }); return true;
  }

  return false;
}

module.exports = { init, handle };
