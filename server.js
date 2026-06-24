/*
 * Wilsons Production Manager — backend (database + API + logins)
 * Node 22+, zero npm dependencies (uses built-in node:sqlite + node:crypto + node:http).
 * Run:  node --experimental-sqlite server.js
 * Data: a single SQLite file (app.db) on persistent storage. Easy to back up (copy the file).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { buildXlsx } = require('./xlsx.js');

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || (process.env.HOME ? path.join(process.env.HOME, 'data') : __dirname);
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const DB_FILE = path.join(DATA_DIR, 'app.db');
const db = new DatabaseSync(DB_FILE);
try { db.exec('PRAGMA journal_mode = WAL;'); } catch (e) { /* some filesystems don't support WAL; default journal is fine */ }
try { db.exec('PRAGMA foreign_keys = ON;'); } catch (e) {}

/* ---------------- schema ---------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE, salt TEXT, hash TEXT, role TEXT DEFAULT 'staff', created TEXT);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER, expires INTEGER);
CREATE TABLE IF NOT EXISTS ingredients(id TEXT PRIMARY KEY, name TEXT, category TEXT, supplier TEXT, notes TEXT);
CREATE TABLE IF NOT EXISTS recipes(id TEXT PRIMARY KEY, brand TEXT, name TEXT, packs TEXT, ingredients TEXT, updated TEXT);
CREATE TABLE IF NOT EXISTS stock(ing_id TEXT PRIMARY KEY, opening REAL DEFAULT 0, reorder REAL DEFAULT 0, supplier TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS production(id TEXT PRIMARY KEY, date TEXT, recipe_id TEXT, product TEXT, pack TEXT, qty REAL, kg REAL, batch TEXT, by TEXT, created TEXT);
CREATE TABLE IF NOT EXISTS production_items(prod_id TEXT, ing_id TEXT, kg REAL);
CREATE INDEX IF NOT EXISTS idx_pi_ing ON production_items(ing_id);
CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, date TEXT, supplier TEXT, approval TEXT, ing_id TEXT, descr TEXT, qty REAL, ref TEXT, approved TEXT, temp TEXT, veh TEXT, qual TEXT, type TEXT, batch TEXT, initials TEXT, by TEXT, created TEXT);
CREATE INDEX IF NOT EXISTS idx_del_ing ON deliveries(ing_id);
CREATE TABLE IF NOT EXISTS adjustments(id TEXT PRIMARY KEY, date TEXT, ing_id TEXT, delta REAL, reason TEXT, by TEXT, created TEXT);
CREATE INDEX IF NOT EXISTS idx_adj_ing ON adjustments(ing_id);
CREATE TABLE IF NOT EXISTS suppliers(id TEXT PRIMARY KEY, name TEXT, approval TEXT, product TEXT, activity TEXT, address TEXT, postcode TEXT);
CREATE TABLE IF NOT EXISTS packaging(id TEXT PRIMARY KEY, name TEXT, type TEXT, qty REAL DEFAULT 0, reorder REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS change_log(id INTEGER PRIMARY KEY, ts TEXT, brand TEXT, recipe TEXT, type TEXT, field TEXT, old TEXT, new TEXT, by TEXT);
`);
// historical-import flag column (older DBs won't have it) — add if missing
try { db.exec('ALTER TABLE production ADD COLUMN hist INTEGER DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE deliveries ADD COLUMN hist INTEGER DEFAULT 0'); } catch (e) {}
try { db.exec("ALTER TABLE production ADD COLUMN basket TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE production ADD COLUMN mince_date TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE production ADD COLUMN cook_date TEXT DEFAULT ''"); } catch (e) {}

/* ---------------- seed (first run only) ---------------- */
function seedIfEmpty() {
  const n = db.prepare('SELECT count(*) c FROM ingredients').get().c;
  if (n > 0) return;
  let seed = {};
  try { seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8')); } catch (e) { console.log('No seed.json — starting empty.'); }
  const tx = db.prepare.bind(db);
  (seed.ingredients || []).forEach(i => db.prepare('INSERT OR IGNORE INTO ingredients(id,name,category,supplier,notes) VALUES(?,?,?,?,?)').run(i.id, i.name, i.category || '', i.supplier || '', i.notes || ''));
  (seed.recipes || []).forEach(r => db.prepare('INSERT OR IGNORE INTO recipes(id,brand,name,packs,ingredients,updated) VALUES(?,?,?,?,?,?)').run(r.id, r.brand, r.name, JSON.stringify(r.packs || []), JSON.stringify(r.ingredients || []), now()));
  const sd = seed.stockSeed || {};
  (seed.ingredients || []).forEach(i => { const z = sd[i.id] || {}; db.prepare('INSERT OR IGNORE INTO stock(ing_id,opening,reorder,supplier) VALUES(?,?,?,?)').run(i.id, z.opening || 0, z.reorder || 0, ''); });
  (seed.suppliers || []).forEach((s, k) => db.prepare('INSERT OR IGNORE INTO suppliers(id,name,approval,product,activity,address,postcode) VALUES(?,?,?,?,?,?,?)').run(s.id || ('s' + k), s.name, s.approval || '', s.product || '', s.activity || '', s.address || '', s.postcode || ''));
  (seed.packagingSeed || []).forEach((p, k) => db.prepare('INSERT OR IGNORE INTO packaging(id,name,type,qty,reorder) VALUES(?,?,?,?,?)').run(p.id || ('pk' + k), p.name, p.type || '', p.qty || 0, p.reorder || 0));
  console.log('Seeded database from seed.json.');
}
// One-time import of historical Production Log + Deliveries Log, and set current stock levels.
// Records are flagged hist=1 (kept for traceability, excluded from the live stock calculation).
function importHistory() {
  let seed = {};
  try { seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8')); } catch (e) { return; }
  if (!seed.productionSeed && !seed.deliveriesSeed && !seed.stockCurrent) return;
  db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)");
  const want = +(seed.historyVersion || 1);
  const haveRow = db.prepare("SELECT value FROM meta WHERE key='historyVersion'").get();
  const have = haveRow ? +haveRow.value : 0;
  if (have >= want) return; // already imported at this version or newer
  const insP = db.prepare('INSERT INTO production(id,date,recipe_id,product,pack,qty,kg,batch,basket,mince_date,cook_date,by,created,hist) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)');
  const insD = db.prepare('INSERT INTO deliveries(id,date,supplier,approval,ing_id,descr,qty,ref,approved,temp,veh,qual,type,batch,initials,by,created,hist) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)');
  const upS = db.prepare('INSERT INTO stock(ing_id,opening,reorder,supplier) VALUES(?,?,?,?) ON CONFLICT(ing_id) DO UPDATE SET opening=excluded.opening,reorder=excluded.reorder');
  db.exec('BEGIN');
  try {
    // replace any previously-imported history (only hist=1 rows; your own entries are untouched)
    db.prepare('DELETE FROM production_items WHERE prod_id IN (SELECT id FROM production WHERE hist=1)').run();
    db.prepare('DELETE FROM production WHERE hist=1').run();
    db.prepare('DELETE FROM deliveries WHERE hist=1').run();
    (seed.productionSeed || []).forEach(p => insP.run(uid('ph'), p.date || '', p.recipe_id || '', p.product || '', p.pack || '', +p.qty || 0, +p.kg || 0, p.batch || '', p.basket || '', p.mince || '', p.cook || '', 'history', now()));
    (seed.deliveriesSeed || []).forEach(d => insD.run(uid('dh'), d.date || '', d.supplier || '', d.approval || '', d.ing_id || '', d.descr || '', +d.qty || 0, d.ref || '', d.approved || '', d.temp || '', d.veh || '', d.qual || '', d.type || '', d.batch || '', d.initials || '', 'history', now()));
    const sc = seed.stockCurrent || {};
    Object.keys(sc).forEach(iid => upS.run(iid, +sc[iid].remaining || 0, +sc[iid].reorder || 0, ''));
    db.prepare("INSERT INTO meta(key,value) VALUES('historyVersion',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(want));
    db.exec('COMMIT');
    console.log('Imported history v' + want + ': ' + (seed.productionSeed || []).length + ' production rows, ' + (seed.deliveriesSeed || []).length + ' deliveries; set ' + Object.keys(sc).length + ' current stock levels.');
  } catch (e) { db.exec('ROLLBACK'); console.log('history import failed:', e.message); }
}
function ensureAdmin() {
  const n = db.prepare('SELECT count(*) c FROM users').get().c;
  if (n > 0) return;
  const pw = process.env.ADMIN_PASSWORD || 'wilsons';
  const { salt, hash } = hashPw(pw);
  db.prepare('INSERT INTO users(username,salt,hash,role,created) VALUES(?,?,?,?,?)').run('admin', salt, hash, 'admin', now());
  console.log('Created default admin user — username: admin, password: ' + (process.env.ADMIN_PASSWORD ? '(from ADMIN_PASSWORD)' : 'wilsons') + '  — CHANGE THIS.');
}

/* ---------------- helpers ---------------- */
function now() { return new Date().toISOString(); }
function uid(p) { return (p || '') + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }
function hashPw(pw, salt) { salt = salt || crypto.randomBytes(16).toString('hex'); return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') }; }
function verifyPw(pw, salt, hash) { try { return crypto.timingSafeEqual(Buffer.from(crypto.scryptSync(pw, salt, 64).toString('hex')), Buffer.from(hash)); } catch (e) { return false; } }
function json(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(b); }
function authUser(req) {
  const h = req.headers['authorization'] || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null; if (!tok) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token=?').get(tok);
  if (!s || s.expires < Date.now()) return null;
  return db.prepare('SELECT id,username,role FROM users WHERE id=?').get(s.user_id);
}

/* ---------------- computed stock ---------------- */
function stockSnapshot() {
  const ings = db.prepare('SELECT * FROM ingredients ORDER BY name').all();
  const st = {}; db.prepare('SELECT * FROM stock').all().forEach(s => st[s.ing_id] = s);
  const used = {}; db.prepare('SELECT ing_id, SUM(kg) k FROM production_items GROUP BY ing_id').all().forEach(r => used[r.ing_id] = r.k);
  const del = {}; db.prepare('SELECT ing_id, SUM(qty) q FROM deliveries WHERE hist IS NULL OR hist=0 GROUP BY ing_id').all().forEach(r => del[r.ing_id] = r.q);
  const adj = {}; db.prepare('SELECT ing_id, SUM(delta) d FROM adjustments GROUP BY ing_id').all().forEach(r => adj[r.ing_id] = r.d);
  return ings.map(i => {
    const s = st[i.id] || { opening: 0, reorder: 0, supplier: '' };
    const opening = s.opening || 0, deliveries = del[i.id] || 0, adjustments = adj[i.id] || 0, u = used[i.id] || 0;
    const remaining = opening + deliveries + adjustments - u;
    const reorder = s.reorder || 0;
    const status = reorder > 0 ? (remaining <= 0 ? 'out' : (remaining <= reorder ? 'low' : 'ok')) : (remaining < 0 ? 'out' : 'ok');
    return { id: i.id, name: i.name, category: i.category, opening, deliveries, adjustments, used: u, remaining, reorder, supplier: s.supplier || '', status };
  });
}

/* ---------------- Excel backup ---------------- */
function buildBackupXlsx() {
  const snap = stockSnapshot();
  const sheets = [];
  sheets.push({ name: 'Stock snapshot', rows: [['Ingredient', 'Category', 'Opening', 'Deliveries', 'Adjustments', 'Used', 'Remaining', 'Re-order pt', 'Supplier', 'Status'],
    ...snap.map(s => [s.name, s.category, s.opening, s.deliveries, s.adjustments, s.used, s.remaining, s.reorder, s.supplier, s.status])] });
  sheets.push({ name: 'Production', rows: [['Date', 'Product', 'Size', 'Bags', 'kg', 'Batch', 'By'],
    ...db.prepare('SELECT * FROM production ORDER BY date DESC, created DESC').all().map(p => [p.date, p.product, p.pack, p.qty, p.kg, p.batch, p.by])] });
  sheets.push({ name: 'Deliveries', rows: [['Date', 'Supplier', 'Ingredient', 'Description', 'Qty kg', 'Ref/PO', 'Approval', 'Approved', 'Temp', 'Vehicle', 'Quality', 'Type', 'Batch', 'Initials'],
    ...db.prepare('SELECT * FROM deliveries ORDER BY date DESC').all().map(d => { const ing = db.prepare('SELECT name FROM ingredients WHERE id=?').get(d.ing_id); return [d.date, d.supplier, ing ? ing.name : d.ing_id, d.descr, d.qty, d.ref, d.approval, d.approved, d.temp, d.veh, d.qual, d.type, d.batch, d.initials]; })] });
  sheets.push({ name: 'Adjustments', rows: [['Date', 'Ingredient', 'Change kg', 'Reason', 'By'],
    ...db.prepare('SELECT * FROM adjustments ORDER BY created DESC').all().map(a => { const ing = db.prepare('SELECT name FROM ingredients WHERE id=?').get(a.ing_id); return [a.date, ing ? ing.name : a.ing_id, a.delta, a.reason, a.by]; })] });
  sheets.push({ name: 'Packaging', rows: [['Item', 'Type', 'Qty', 'Re-order pt'], ...db.prepare('SELECT * FROM packaging').all().map(p => [p.name, p.type, p.qty, p.reorder])] });
  sheets.push({ name: 'Suppliers', rows: [['Trading name', 'Approval', 'Product', 'Activity', 'Address', 'Post code'], ...db.prepare('SELECT * FROM suppliers ORDER BY name').all().map(s => [s.name, s.approval, s.product, s.activity, s.address, s.postcode])] });
  sheets.push({ name: 'Ingredients', rows: [['Name', 'Category'], ...db.prepare('SELECT * FROM ingredients ORDER BY name').all().map(i => [i.name, i.category])] });
  const ri = [['Recipe', 'Brand', 'Ingredient', 'kg per 100kg']];
  db.prepare('SELECT * FROM recipes').all().forEach(r => { const items = JSON.parse(r.ingredients || '[]'); items.forEach(li => { const ing = db.prepare('SELECT name FROM ingredients WHERE id=?').get(li.ingId); ri.push([r.name, r.brand, ing ? ing.name : li.ingId, li.kg]); }); });
  sheets.push({ name: 'Recipe ingredients', rows: ri });
  return buildXlsx(sheets);
}
function writeDailyBackup() {
  try { const dir = path.join(DATA_DIR, 'backups'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'wilsons-backup-' + now().slice(0, 10) + '.xlsx'), buildBackupXlsx());
    // keep last 30
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.xlsx')).sort(); while (files.length > 30) fs.unlinkSync(path.join(dir, files.shift()));
  } catch (e) { console.log('daily backup failed:', e.message); }
}

/* ---------------- request body ---------------- */
function readBody(req) { return new Promise((resolve) => { let b = ''; req.on('data', c => { b += c; if (b.length > 12e6) req.destroy(); }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve(null); } }); }); }

/* ---------------- routes ---------------- */
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const m = req.method;
  try {
    // --- auth ---
    if (url === '/api/login' && m === 'POST') {
      const b = await readBody(req); const u = db.prepare('SELECT * FROM users WHERE username=?').get((b.username || '').trim());
      if (!u || !verifyPw(b.password || '', u.salt, u.hash)) return json(res, 401, { error: 'Invalid username or password' });
      const token = crypto.randomBytes(32).toString('hex'); const expires = Date.now() + 30 * 24 * 3600 * 1000;
      db.prepare('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)').run(token, u.id, expires);
      return json(res, 200, { token, user: { id: u.id, username: u.username, role: u.role } });
    }
    // Excel backup — auth via Bearer token OR ?key=BACKUP_KEY (for an automated PC download)
    if (url === '/api/backup.xlsx' && m === 'GET') {
      const q = new URLSearchParams((req.url.split('?')[1] || '')); const key = q.get('key');
      const ok = authUser(req) || (process.env.BACKUP_KEY && key && key === process.env.BACKUP_KEY);
      if (!ok) return json(res, 401, { error: 'unauthorized' });
      const buf = buildBackupXlsx();
      res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="wilsons-backup-' + now().slice(0, 10) + '.xlsx"' });
      res.end(buf); return;
    }
    if (url.startsWith('/api/')) {
      const user = authUser(req);
      if (!user) return json(res, 401, { error: 'Not signed in' });

      if (url === '/api/me') return json(res, 200, { user });
      if (url === '/api/logout' && m === 'POST') { const h = req.headers['authorization'] || ''; db.prepare('DELETE FROM sessions WHERE token=?').run(h.slice(7)); return json(res, 200, { ok: true }); }

      // one-shot load of all reference data + computed stock
      if (url === '/api/bootstrap' && m === 'GET') {
        return json(res, 200, {
          user,
          ingredients: db.prepare('SELECT * FROM ingredients ORDER BY name').all(),
          recipes: db.prepare('SELECT * FROM recipes').all().map(r => ({ ...r, packs: JSON.parse(r.packs || '[]'), ingredients: JSON.parse(r.ingredients || '[]') })),
          suppliers: db.prepare('SELECT * FROM suppliers ORDER BY name').all(),
          packaging: db.prepare('SELECT * FROM packaging').all(),
          stock: stockSnapshot()
        });
      }
      if (url === '/api/stock' && m === 'GET') return json(res, 200, stockSnapshot());

      // stock settings (opening / reorder / supplier)
      if (url === '/api/stock' && m === 'PUT') {
        const b = await readBody(req); if (!b || !b.ing_id) return json(res, 400, { error: 'ing_id required' });
        db.prepare('INSERT INTO stock(ing_id,opening,reorder,supplier) VALUES(?,?,?,?) ON CONFLICT(ing_id) DO UPDATE SET opening=excluded.opening,reorder=excluded.reorder,supplier=excluded.supplier')
          .run(b.ing_id, +b.opening || 0, +b.reorder || 0, b.supplier || '');
        return json(res, 200, { ok: true });
      }

      // production (record a day's lines, computes deductions)
      if (url === '/api/production' && m === 'GET') return json(res, 200, db.prepare('SELECT * FROM production ORDER BY date DESC, created DESC').all());
      if (url === '/api/production' && m === 'POST') {
        const b = await readBody(req); const lines = b.lines || [];
        const ins = db.prepare('INSERT INTO production(id,date,recipe_id,product,pack,qty,kg,batch,basket,mince_date,cook_date,by,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
        const insItem = db.prepare('INSERT INTO production_items(prod_id,ing_id,kg) VALUES(?,?,?)');
        db.exec('BEGIN');
        try {
          lines.forEach(l => { const id = uid('p');
            ins.run(id, b.date, l.recipe_id, l.product, l.pack, +l.qty, +l.kg, l.batch || '', l.basket || '', l.mince || '', l.cook || '', user.username, now());
            (l.deductions || []).forEach(d => insItem.run(id, d.ing_id, +d.kg));
          });
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); return json(res, 500, { error: 'write failed' }); }
        return json(res, 200, { ok: true, count: lines.length });
      }
      if (url.startsWith('/api/production/') && m === 'DELETE') {
        const id = decodeURIComponent(url.split('/').pop());
        db.prepare('DELETE FROM production_items WHERE prod_id=?').run(id);
        db.prepare('DELETE FROM production WHERE id=?').run(id);
        return json(res, 200, { ok: true });
      }

      // deliveries
      if (url === '/api/deliveries' && m === 'GET') return json(res, 200, db.prepare('SELECT * FROM deliveries ORDER BY date DESC, created DESC').all());
      if (url === '/api/deliveries' && m === 'POST') {
        const b = await readBody(req); const id = uid('d');
        db.prepare('INSERT INTO deliveries(id,date,supplier,approval,ing_id,descr,qty,ref,approved,temp,veh,qual,type,batch,initials,by,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, b.date, b.supplier || '', b.approval || '', b.ing_id, b.descr || '', +b.qty || 0, b.ref || '', b.approved || '', b.temp || '', b.veh || '', b.qual || '', b.type || '', b.batch || '', b.initials || '', user.username, now());
        return json(res, 200, { ok: true, id });
      }
      if (url.startsWith('/api/deliveries/') && m === 'DELETE') { db.prepare('DELETE FROM deliveries WHERE id=?').run(decodeURIComponent(url.split('/').pop())); return json(res, 200, { ok: true }); }

      // adjustments (stocktake)
      if (url === '/api/adjustments' && m === 'GET') return json(res, 200, db.prepare('SELECT * FROM adjustments ORDER BY created DESC').all());
      if (url === '/api/adjustments' && m === 'POST') {
        const b = await readBody(req); const id = uid('a');
        db.prepare('INSERT INTO adjustments(id,date,ing_id,delta,reason,by,created) VALUES(?,?,?,?,?,?,?)').run(id, b.date || now().slice(0, 10), b.ing_id, +b.delta || 0, b.reason || '', user.username, now());
        return json(res, 200, { ok: true, id });
      }
      if (url.startsWith('/api/adjustments/') && m === 'DELETE') { db.prepare('DELETE FROM adjustments WHERE id=?').run(decodeURIComponent(url.split('/').pop())); return json(res, 200, { ok: true }); }

      // generic CRUD for simple collections
      const coll = {
        ingredients: { table: 'ingredients', cols: ['id', 'name', 'category', 'supplier', 'notes'] },
        suppliers: { table: 'suppliers', cols: ['id', 'name', 'approval', 'product', 'activity', 'address', 'postcode'] },
        packaging: { table: 'packaging', cols: ['id', 'name', 'type', 'qty', 'reorder'] }
      };
      for (const key in coll) {
        const c = coll[key];
        if (url === '/api/' + key && m === 'GET') return json(res, 200, db.prepare('SELECT * FROM ' + c.table).all());
        if (url === '/api/' + key && m === 'POST') { const b = await readBody(req); if (!b.id) b.id = uid(key[0]); db.prepare('INSERT INTO ' + c.table + '(' + c.cols.join(',') + ') VALUES(' + c.cols.map(() => '?').join(',') + ')').run(...c.cols.map(k => b[k] != null ? b[k] : '')); return json(res, 200, { ok: true, id: b.id }); }
        if (url.startsWith('/api/' + key + '/') && m === 'PUT') { const id = decodeURIComponent(url.split('/').pop()); const b = await readBody(req); const set = c.cols.filter(k => k !== 'id'); db.prepare('UPDATE ' + c.table + ' SET ' + set.map(k => k + '=?').join(',') + ' WHERE id=?').run(...set.map(k => b[k] != null ? b[k] : ''), id); return json(res, 200, { ok: true }); }
        if (url.startsWith('/api/' + key + '/') && m === 'DELETE') { db.prepare('DELETE FROM ' + c.table + ' WHERE id=?').run(decodeURIComponent(url.split('/').pop())); return json(res, 200, { ok: true }); }
      }

      // recipes (ingredients/packs stored as JSON)
      if (url === '/api/recipes' && m === 'GET') return json(res, 200, db.prepare('SELECT * FROM recipes').all().map(r => ({ ...r, packs: JSON.parse(r.packs || '[]'), ingredients: JSON.parse(r.ingredients || '[]') })));
      if (url === '/api/recipes' && m === 'POST') { const b = await readBody(req); const id = b.id || uid('r'); db.prepare('INSERT INTO recipes(id,brand,name,packs,ingredients,updated) VALUES(?,?,?,?,?,?)').run(id, b.brand, b.name, JSON.stringify(b.packs || []), JSON.stringify(b.ingredients || []), now()); return json(res, 200, { ok: true, id }); }
      if (url.startsWith('/api/recipes/') && m === 'PUT') { const id = decodeURIComponent(url.split('/').pop()); const b = await readBody(req); db.prepare('UPDATE recipes SET brand=?,name=?,packs=?,ingredients=?,updated=? WHERE id=?').run(b.brand, b.name, JSON.stringify(b.packs || []), JSON.stringify(b.ingredients || []), now(), id); return json(res, 200, { ok: true }); }
      if (url.startsWith('/api/recipes/') && m === 'DELETE') { db.prepare('DELETE FROM recipes WHERE id=?').run(decodeURIComponent(url.split('/').pop())); return json(res, 200, { ok: true }); }

      // user admin (admins only)
      if (url === '/api/users' && m === 'GET') { if (user.role !== 'admin') return json(res, 403, { error: 'admins only' }); return json(res, 200, db.prepare('SELECT id,username,role,created FROM users').all()); }
      if (url === '/api/users' && m === 'POST') { if (user.role !== 'admin') return json(res, 403, { error: 'admins only' }); const b = await readBody(req); if (!b.username || !b.password) return json(res, 400, { error: 'username & password required' }); const { salt, hash } = hashPw(b.password); try { db.prepare('INSERT INTO users(username,salt,hash,role,created) VALUES(?,?,?,?,?)').run(b.username.trim(), salt, hash, b.role || 'staff', now()); } catch (e) { return json(res, 400, { error: 'username already exists' }); } return json(res, 200, { ok: true }); }

      return json(res, 404, { error: 'not found' });
    }

    // static (serve the app if index.html is bundled)
    if (m === 'GET') { fs.readFile(path.join(__dirname, 'index.html'), (e, data) => { if (e) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('Wilsons Production Manager API is running. Front-end not bundled yet.'); } res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(data); }); return; }
    res.writeHead(405); res.end();
  } catch (e) { json(res, 500, { error: 'server error: ' + e.message }); }
});

seedIfEmpty(); ensureAdmin(); importHistory();
// nightly server-side Excel backup (kept in DATA_DIR/backups), plus one on boot
try { writeDailyBackup(); } catch (e) {}
setInterval(() => { try { writeDailyBackup(); } catch (e) {} }, 24 * 3600 * 1000);
server.listen(PORT, () => console.log('Wilsons Production Manager backend on port ' + PORT + '  (db: ' + DB_FILE + ')'));
