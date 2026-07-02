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
try { db.exec("ALTER TABLE users ADD COLUMN perms TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE production ADD COLUMN julian_code TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE production ADD COLUMN best_before TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE production ADD COLUMN filled_date TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE production ADD COLUMN temp_start TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE production ADD COLUMN temp_finish TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE production ADD COLUMN fill_start TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE production ADD COLUMN fill_finish TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE production ADD COLUMN retort TEXT DEFAULT ''"); } catch (e) {}
db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)");
db.exec("CREATE TABLE IF NOT EXISTS live_fills(who TEXT PRIMARY KEY, basket TEXT, products TEXT, fill_start TEXT, operators INTEGER, updated TEXT)");
db.exec("CREATE TABLE IF NOT EXISTS mixes(id TEXT PRIMARY KEY, date TEXT, recipe_id TEXT, batch TEXT, kg REAL, by TEXT, created TEXT)");
db.exec("CREATE TABLE IF NOT EXISTS mix_items(mix_id TEXT, ing_id TEXT, batch_code TEXT, qty REAL)");
try { db.exec("ALTER TABLE recipes ADD COLUMN shelf_months INTEGER"); } catch (e) {}
try { db.exec("ALTER TABLE production ADD COLUMN seq REAL DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE production ADD COLUMN operators INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE production ADD COLUMN stack_id TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE production ADD COLUMN stack_complete INTEGER DEFAULT 1"); } catch (e) {}
try { db.exec("ALTER TABLE production ADD COLUMN trays INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE production ADD COLUMN bag_pkg TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE production ADD COLUMN bag_qty REAL DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE packaging ADD COLUMN map_recipe TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE packaging ADD COLUMN map_pack TEXT DEFAULT ''"); } catch (e) {}

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
    (seed.productionSeed || []).forEach(p => insP.run(uid('ph'), p.date || '', p.recipe_id || '', p.product || '', p.pack || '', +p.qty || 0, +p.kg || 0, p.batch || '', p.basket || '', p.mince || '', (p.cook || p.date || ''), 'history', now()));
    (seed.deliveriesSeed || []).forEach(d => insD.run(uid('dh'), d.date || '', d.supplier || '', d.approval || '', d.ing_id || '', d.descr || '', +d.qty || 0, d.ref || '', d.approved || '', d.temp || '', d.veh || '', d.qual || '', d.type || '', d.batch || '', d.initials || '', 'history', now()));
    const sc = seed.stockCurrent || {};
    Object.keys(sc).forEach(iid => upS.run(iid, +sc[iid].remaining || 0, +sc[iid].reorder || 0, ''));
    db.prepare("INSERT INTO meta(key,value) VALUES('historyVersion',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(want));
    db.exec('COMMIT');
    console.log('Imported history v' + want + ': ' + (seed.productionSeed || []).length + ' production rows, ' + (seed.deliveriesSeed || []).length + ' deliveries; set ' + Object.keys(sc).length + ' current stock levels.');
  } catch (e) { db.exec('ROLLBACK'); console.log('history import failed:', e.message); }
}
// one-time: treat already-imported history as cooked so it shows in Record Production (cooked-only) + finished goods
function backfillHistoryCooked() {
  try {
    const done = db.prepare("SELECT value FROM meta WHERE key='histCookedV'").get();
    if (done && done.value === '1') return;
    const r = db.prepare("UPDATE production SET cook_date = (CASE WHEN filled_date IS NOT NULL AND filled_date <> '' THEN filled_date ELSE date END) WHERE hist=1 AND (cook_date IS NULL OR cook_date='')").run();
    db.prepare("INSERT INTO meta(key,value) VALUES('histCookedV','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
    if (r && r.changes) console.log('Marked ' + r.changes + ' historical production rows as cooked (cook_date backfilled).');
  } catch (e) { console.log('history-cooked backfill failed:', e.message); }
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
  const u = db.prepare('SELECT id,username,role,perms FROM users WHERE id=?').get(s.user_id);
  if (u) { try { u.perms = u.perms ? JSON.parse(u.perms) : null; } catch (e) { u.perms = null; } }
  return u;
}

/* ---------------- computed stock ---------------- */
function packKgOf(label) { const m = /([\d.]+)\s*(kg|g)/i.exec(label || ''); if (!m) return 0; return m[2].toLowerCase() === 'kg' ? parseFloat(m[1]) : parseFloat(m[1]) / 1000; }
// bags consumed at FILL: find the packaging item mapped to a product+size, and adjust its live count
function bagPkgFor(recipe_id, pack) { if (!recipe_id || !pack) return null; try { return db.prepare("SELECT id FROM packaging WHERE map_recipe=? AND map_pack=?").get(recipe_id, pack) || null; } catch (e) { return null; } }
function bagAdjust(pkgId, delta) { if (pkgId && delta) db.prepare('UPDATE packaging SET qty=qty+? WHERE id=?').run(delta, pkgId); }
// ingredients are consumed when a batch is COOKED into finished product (not at fill), computed from recipe % of cooked bags.
// Historical rows (hist=1) are excluded — the imported opening stock already accounts for them.
function ingUsedCooked() {
  const used = {};
  const recipes = {}; db.prepare('SELECT id, ingredients FROM recipes').all().forEach(r => { try { recipes[r.id] = JSON.parse(r.ingredients || '[]'); } catch (e) { recipes[r.id] = []; } });
  const rows = db.prepare("SELECT recipe_id, pack, qty FROM production WHERE (hist IS NULL OR hist=0) AND cook_date IS NOT NULL AND cook_date <> ''").all();
  rows.forEach(row => { const ings = recipes[row.recipe_id]; if (!ings || !ings.length) return; const base = ings.reduce((a, li) => a + (+li.kg || 0), 0); if (base <= 0) return; const factor = ((+row.qty || 0) * packKgOf(row.pack)) / base; ings.forEach(li => { used[li.ingId] = (used[li.ingId] || 0) + (+li.kg || 0) * factor; }); });
  return used;
}
function stockSnapshot() {
  const ings = db.prepare('SELECT * FROM ingredients ORDER BY name').all();
  const st = {}; db.prepare('SELECT * FROM stock').all().forEach(s => st[s.ing_id] = s);
  const used = ingUsedCooked();
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
      let perms = null; try { perms = u.perms ? JSON.parse(u.perms) : null; } catch (e) {}
      return json(res, 200, { token, user: { id: u.id, username: u.username, role: u.role, perms } });
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
          stock: stockSnapshot(),
          weekPlans: (function () { const r = db.prepare("SELECT value FROM meta WHERE key='weekPlans'").get(); try { return r ? JSON.parse(r.value) : {}; } catch (e) { return {}; } })(),
          fillTargets: (function () { const r = db.prepare("SELECT value FROM meta WHERE key='fillTargets'").get(); try { return r ? JSON.parse(r.value) : null; } catch (e) { return null; } })(),
          homeConfig: (function () { const r = db.prepare("SELECT value FROM meta WHERE key='homeConfig'").get(); try { return r ? JSON.parse(r.value) : null; } catch (e) { return null; } })()
        });
      }
      // shared weekly production plan (one JSON blob in meta) — drives the filling dashboard
      if (url === '/api/plan' && m === 'GET') { const r = db.prepare("SELECT value FROM meta WHERE key='weekPlans'").get(); let v = {}; try { v = r ? JSON.parse(r.value) : {}; } catch (e) {} return json(res, 200, { weekPlans: v }); }
      if (url === '/api/plan' && m === 'PUT') { const b = await readBody(req); db.prepare("INSERT INTO meta(key,value) VALUES('weekPlans',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(b.weekPlans || {})); return json(res, 200, { ok: true }); }
      // filling-line target rates (packs-per-minute per pack size, by operator count)
      if (url === '/api/fill-targets' && m === 'GET') { const r = db.prepare("SELECT value FROM meta WHERE key='fillTargets'").get(); let v = null; try { v = r ? JSON.parse(r.value) : null; } catch (e) {} return json(res, 200, { fillTargets: v }); }
      if (url === '/api/fill-targets' && m === 'PUT') { const b = await readBody(req); db.prepare("INSERT INTO meta(key,value) VALUES('fillTargets',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(b.fillTargets || {})); return json(res, 200, { ok: true }); }
      // home-screen tile layout (order + custom names) — shared across accounts
      if (url === '/api/home-config' && m === 'GET') { const r = db.prepare("SELECT value FROM meta WHERE key='homeConfig'").get(); let v = null; try { v = r ? JSON.parse(r.value) : null; } catch (e) {} return json(res, 200, { homeConfig: v }); }
      if (url === '/api/home-config' && m === 'PUT') { const b = await readBody(req); db.prepare("INSERT INTO meta(key,value) VALUES('homeConfig',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(b.homeConfig || {})); return json(res, 200, { ok: true }); }
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
        const ins = db.prepare('INSERT INTO production(id,date,recipe_id,product,pack,qty,kg,batch,basket,mince_date,cook_date,julian_code,best_before,filled_date,temp_start,temp_finish,fill_start,fill_finish,retort,operators,stack_id,stack_complete,trays,by,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
        const insItem = db.prepare('INSERT INTO production_items(prod_id,ing_id,kg) VALUES(?,?,?)');
        db.exec('BEGIN');
        try {
          lines.forEach(l => { const id = uid('p');
            ins.run(id, b.date, l.recipe_id, l.product, l.pack, +l.qty, +l.kg, l.batch || '', l.basket || '', l.mince || '', l.cook || '', l.julian || '', l.bestBefore || '', l.filled || '', l.tempStart || '', l.tempFinish || '', l.fillStart || '', l.fillFinish || '', l.retort || '', +l.operators || 0, l.stackId || '', (l.stackComplete == null ? 1 : (l.stackComplete ? 1 : 0)), +l.trays || 0, user.username, now());
            (l.deductions || []).forEach(d => insItem.run(id, d.ing_id, +d.kg));
            // bags off stock — only when this comes from the Filling Sheet, and only if the product+size is mapped to a bag
            if (b.fromFill) { const pk = bagPkgFor(l.recipe_id, l.pack); if (pk) { const bags = +l.qty || 0; bagAdjust(pk.id, -bags); db.prepare('UPDATE production SET bag_pkg=?, bag_qty=? WHERE id=?').run(pk.id, bags, id); } }
          });
          // completeness + trays are properties of the whole stack — apply the latest fill's value to every row of that stack
          const stackState = {};
          lines.forEach(l => { if (l.stackId) stackState[l.stackId] = { c: (l.stackComplete == null ? 1 : (l.stackComplete ? 1 : 0)), t: +l.trays || 0 }; });
          const updSC = db.prepare('UPDATE production SET stack_complete=?, trays=? WHERE stack_id=?');
          Object.keys(stackState).forEach(sid => updSC.run(stackState[sid].c, stackState[sid].t, sid));
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); return json(res, 500, { error: 'write failed' }); }
        return json(res, 200, { ok: true, count: lines.length });
      }
      if (url.startsWith('/api/production/') && m === 'PUT') {
        const id = decodeURIComponent(url.split('/').pop());
        const b = await readBody(req);
        const ex = db.prepare('SELECT * FROM production WHERE id=?').get(id);
        if (!ex) return json(res, 404, { error: 'not found' });
        db.exec('BEGIN');
        try {
          if (ex.bag_pkg) bagAdjust(ex.bag_pkg, +ex.bag_qty || 0);   // put the old bags back before re-applying
          db.prepare('UPDATE production SET date=?,recipe_id=?,product=?,pack=?,qty=?,kg=?,batch=?,basket=?,mince_date=?,cook_date=?,julian_code=?,best_before=?,filled_date=?,temp_start=?,temp_finish=?,fill_start=?,fill_finish=?,retort=?,operators=?,stack_id=?,stack_complete=?,trays=? WHERE id=?')
            .run(b.date || '', b.recipe_id || '', b.product || '', b.pack || '', +b.qty || 0, +b.kg || 0, b.batch || '', b.basket || '', b.mince || '', b.cook || '', b.julian || '', b.bestBefore || '', b.filled || '', b.tempStart || '', b.tempFinish || '', b.fillStart || '', b.fillFinish || '', b.retort || '', (b.operators == null ? 0 : +b.operators || 0), b.stackId || '', (b.stackComplete == null ? 1 : (b.stackComplete ? 1 : 0)), +b.trays || 0, id);
          // re-apply bag deduction only if this row was a fill deduction to begin with
          let nbp = '', nbq = 0; if (ex.bag_pkg) { const pk = bagPkgFor(b.recipe_id || '', b.pack || ''); if (pk) { nbq = +b.qty || 0; nbp = pk.id; bagAdjust(pk.id, -nbq); } }
          db.prepare('UPDATE production SET bag_pkg=?, bag_qty=? WHERE id=?').run(nbp, nbq, id);
          db.prepare('DELETE FROM production_items WHERE prod_id=?').run(id);
          const insItem = db.prepare('INSERT INTO production_items(prod_id,ing_id,kg) VALUES(?,?,?)');
          (b.deductions || []).forEach(d => insItem.run(id, d.ing_id, +d.kg));
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); return json(res, 500, { error: 'write failed' }); }
        return json(res, 200, { ok: true });
      }
      // filling-sheet manual-time PIN (operational deterrent, default 1234)
      if (url === '/api/fillpin/verify' && m === 'POST') { const b = await readBody(req); const row = db.prepare("SELECT value FROM meta WHERE key='fillPin'").get(); const pin = row ? row.value : '1234'; return json(res, 200, { ok: (b.pin || '') === pin }); }
      if (url === '/api/fillpin/change' && m === 'POST') { const b = await readBody(req); const row = db.prepare("SELECT value FROM meta WHERE key='fillPin'").get(); const pin = row ? row.value : '1234'; if ((b.current || '') !== pin && user.role !== 'admin') return json(res, 200, { ok: false, error: 'Current PIN is wrong' }); if (!b.next || !/^\d{4,8}$/.test(b.next)) return json(res, 200, { ok: false, error: 'New PIN must be 4–8 digits' }); db.prepare("INSERT INTO meta(key,value) VALUES('fillPin',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(b.next); return json(res, 200, { ok: true }); }
      // set per-recipe shelf life (months) — used for best-before on the filling sheet
      if (url === '/api/recipe-details' && m === 'POST') {
        const b = await readBody(req); if (!b.id) return json(res, 400, { error: 'id required' });
        const v = (b.shelfMonths === '' || b.shelfMonths == null) ? null : (+b.shelfMonths || 0);
        db.prepare('UPDATE recipes SET shelf_months=? WHERE id=?').run(v, b.id);
        return json(res, 200, { ok: true });
      }
      // drag-reorder: set a manual sequence on production rows (order of ids = new order)
      if (url === '/api/production/reorder' && m === 'POST') {
        const b = await readBody(req); const ids = b.ids || [];
        const up = db.prepare('UPDATE production SET seq=? WHERE id=?');
        db.exec('BEGIN'); try { ids.forEach((id, i) => up.run(i + 1, id)); db.exec('COMMIT'); }
        catch (e) { db.exec('ROLLBACK'); return json(res, 500, { error: 'write failed' }); }
        return json(res, 200, { ok: true, count: ids.length });
      }
      // finished goods = production that has been cooked (cook date set), grouped by product + size
      if (url === '/api/finished-goods' && m === 'GET') {
        return json(res, 200, db.prepare("SELECT product, pack, SUM(qty) bags, SUM(kg) kg, COUNT(*) lines, MAX(cook_date) last_cook FROM production WHERE cook_date IS NOT NULL AND cook_date <> '' GROUP BY product, pack ORDER BY product, pack").all());
      }
      // stacks = filling units (a trolley-load of ~13 trays), grouped by stack_id for carry-over/top-up tracking
      if (url === '/api/stacks' && m === 'GET') {
        return json(res, 200, db.prepare("SELECT stack_id, MAX(basket) basket, GROUP_CONCAT(DISTINCT product) products, SUM(qty) bags, MAX(trays) trays, MIN(stack_complete) complete, MAX(CASE WHEN cook_date IS NOT NULL AND cook_date<>'' THEN 1 ELSE 0 END) cooked, MIN(CASE WHEN filled_date IS NULL OR filled_date='' THEN date ELSE filled_date END) filled, COUNT(*) lines, GROUP_CONCAT(id) ids FROM production WHERE stack_id IS NOT NULL AND stack_id<>'' GROUP BY stack_id ORDER BY filled DESC, basket").all());
      }
      // cooking person assembles a cook: stamp cook_date + retort on selected fills; split a fill if only some bags are used
      if (url === '/api/cook' && m === 'POST') {
        const b = await readBody(req); const items = b.items || []; const cd = b.cook_date || ''; const rt = b.retort || '';
        const get = db.prepare('SELECT * FROM production WHERE id=?');
        const upWhole = db.prepare('UPDATE production SET cook_date=?, retort=? WHERE id=?');
        const upRemain = db.prepare('UPDATE production SET qty=?, kg=? WHERE id=?');
        const insSplit = db.prepare('INSERT INTO production(id,date,recipe_id,product,pack,qty,kg,batch,basket,mince_date,cook_date,julian_code,best_before,filled_date,temp_start,temp_finish,fill_start,fill_finish,retort,operators,stack_id,stack_complete,trays,by,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
        db.exec('BEGIN');
        try {
          items.forEach(it => { const row = get.get(it.id); if (!row) return; const take = Math.min(+it.bags || 0, row.qty); if (take <= 0) return;
            if (take >= row.qty) { upWhole.run(cd, rt, row.id); }
            else { const kgPer = row.qty ? row.kg / row.qty : 0; const nid = uid('p');
              insSplit.run(nid, row.date, row.recipe_id, row.product, row.pack, take, +(kgPer * take).toFixed(3), row.batch, row.basket, row.mince_date, cd, row.julian_code, row.best_before, row.filled_date, row.temp_start, row.temp_finish, row.fill_start, row.fill_finish, rt, row.operators, row.stack_id, row.stack_complete, row.trays, user.username, now());
              upRemain.run(row.qty - take, +(row.kg - kgPer * take).toFixed(3), row.id);
              if (row.bag_pkg) { db.prepare('UPDATE production SET bag_pkg=?, bag_qty=? WHERE id=?').run(row.bag_pkg, take, nid); db.prepare('UPDATE production SET bag_qty=? WHERE id=?').run((+row.bag_qty || 0) - take, row.id); } }
          });
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); return json(res, 500, { error: 'cook write failed' }); }
        return json(res, 200, { ok: true, count: items.length });
      }
      // live "currently filling" feed — the floor reports an in-progress basket so other accounts see the countdown
      if (url === '/api/live-fill' && m === 'POST') { const b = await readBody(req); db.prepare("INSERT INTO live_fills(who,basket,products,fill_start,operators,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(who) DO UPDATE SET basket=excluded.basket,products=excluded.products,fill_start=excluded.fill_start,operators=excluded.operators,updated=excluded.updated").run(user.username, b.basket || '', b.products || '', b.fillStart || '', +b.operators || 0, now()); return json(res, 200, { ok: true }); }
      if (url === '/api/live-fill' && m === 'DELETE') { const q = new URLSearchParams((req.url.split('?')[1] || '')); const who = q.get('who'); if (who && user.role === 'admin') db.prepare('DELETE FROM live_fills WHERE who=?').run(who); else db.prepare('DELETE FROM live_fills WHERE who=?').run(user.username); return json(res, 200, { ok: true }); }
      if (url === '/api/live-fills' && m === 'GET') { const cutoff = new Date(Date.now() - 4 * 3600 * 1000).toISOString(); return json(res, 200, db.prepare('SELECT who, basket, products, fill_start, operators, updated FROM live_fills WHERE updated >= ? ORDER BY fill_start').all(cutoff)); }

      // ---- ingredient batch traceability (Pick & Mix) ----
      // batch lots for an ingredient, from deliveries, with remaining after mix consumption + FIFO suggestion
      if (url === '/api/ingredient-batches' && m === 'GET') {
        const q = new URLSearchParams((req.url.split('?')[1] || '')); const ing = q.get('ing_id') || '';
        const del = db.prepare("SELECT batch, MIN(date) first_date, MAX(date) last_date, SUM(qty) delivered, GROUP_CONCAT(DISTINCT supplier) supplier FROM deliveries WHERE ing_id=? AND batch IS NOT NULL AND batch<>'' GROUP BY batch").all(ing);
        const used = {}; db.prepare("SELECT batch_code, SUM(qty) u FROM mix_items WHERE ing_id=? GROUP BY batch_code").all(ing).forEach(r => { used[r.batch_code] = r.u || 0; });
        const lots = del.map(d => ({ batch: d.batch, first_date: d.first_date, last_date: d.last_date, supplier: d.supplier || '', delivered: d.delivered || 0, used: used[d.batch] || 0, remaining: (d.delivered || 0) - (used[d.batch] || 0) }));
        let fifo = null; lots.slice().sort((a, b) => String(a.first_date).localeCompare(String(b.first_date))).forEach(l => { if (!fifo && l.remaining > 0.0001) fifo = l.batch; });
        lots.sort((a, b) => String(b.last_date).localeCompare(String(a.last_date)));
        return json(res, 200, { ing_id: ing, fifo, lots });
      }
      if (url === '/api/mixes' && m === 'GET') return json(res, 200, db.prepare('SELECT * FROM mixes ORDER BY date DESC, created DESC').all());
      if (url === '/api/mixes' && m === 'POST') {
        const b = await readBody(req); const id = uid('mx');
        db.prepare('INSERT INTO mixes(id,date,recipe_id,batch,kg,by,created) VALUES(?,?,?,?,?,?,?)').run(id, b.date || '', b.recipe_id || '', b.batch || '', +b.kg || 0, user.username, now());
        const ins = db.prepare('INSERT INTO mix_items(mix_id,ing_id,batch_code,qty) VALUES(?,?,?,?)');
        (b.items || []).forEach(it => { if (it.ing_id && it.batch_code) ins.run(id, it.ing_id, it.batch_code, +it.qty || 0); });
        return json(res, 200, { ok: true, id });
      }
      if (url.startsWith('/api/mixes/') && m === 'GET') { const id = decodeURIComponent(url.split('/').pop()); const mix = db.prepare('SELECT * FROM mixes WHERE id=?').get(id); if (!mix) return json(res, 404, { error: 'not found' }); mix.items = db.prepare('SELECT ing_id,batch_code,qty FROM mix_items WHERE mix_id=?').all(id); return json(res, 200, mix); }
      if (url.startsWith('/api/mixes/') && m === 'DELETE') { const id = decodeURIComponent(url.split('/').pop()); db.prepare('DELETE FROM mix_items WHERE mix_id=?').run(id); db.prepare('DELETE FROM mixes WHERE id=?').run(id); return json(res, 200, { ok: true }); }
      // recall: which mixes used an ingredient batch code
      if (url === '/api/trace/batch' && m === 'GET') { const q = new URLSearchParams((req.url.split('?')[1] || '')); const code = q.get('code') || ''; return json(res, 200, db.prepare('SELECT m.id,m.date,m.recipe_id,m.batch,m.kg,mi.ing_id,mi.qty FROM mix_items mi JOIN mixes m ON m.id=mi.mix_id WHERE mi.batch_code=? ORDER BY m.date DESC').all(code)); }
      // mark a stack complete / still-open (used when a part-full stack is topped up later)
      if (url === '/api/stack/complete' && m === 'POST') {
        const b = await readBody(req); if (!b.stack_id) return json(res, 400, { error: 'stack_id required' });
        db.prepare('UPDATE production SET stack_complete=? WHERE stack_id=?').run(b.complete ? 1 : 0, b.stack_id);
        return json(res, 200, { ok: true });
      }
      // office: assign a cook date (and retort) to a set of production rows in one go
      if (url === '/api/production/assign-cook' && m === 'POST') {
        const b = await readBody(req); const ids = b.ids || [];
        const up = db.prepare('UPDATE production SET cook_date=?' + (b.retort != null ? ',retort=?' : '') + ' WHERE id=?');
        db.exec('BEGIN');
        try { ids.forEach(id => { if (b.retort != null) up.run(b.cook || '', b.retort || '', id); else up.run(b.cook || '', id); }); db.exec('COMMIT'); }
        catch (e) { db.exec('ROLLBACK'); return json(res, 500, { error: 'write failed' }); }
        return json(res, 200, { ok: true, count: ids.length });
      }
      if (url.startsWith('/api/production/') && m === 'DELETE') {
        const id = decodeURIComponent(url.split('/').pop());
        const ex = db.prepare('SELECT bag_pkg,bag_qty FROM production WHERE id=?').get(id);
        if (ex && ex.bag_pkg) bagAdjust(ex.bag_pkg, +ex.bag_qty || 0);   // return the bags
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
        packaging: { table: 'packaging', cols: ['id', 'name', 'type', 'qty', 'reorder', 'map_recipe', 'map_pack'] }
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
      if (url === '/api/users' && m === 'GET') { if (user.role !== 'admin') return json(res, 403, { error: 'admins only' }); return json(res, 200, db.prepare('SELECT id,username,role,created,perms FROM users').all().map(u => { try { u.perms = u.perms ? JSON.parse(u.perms) : null; } catch (e) { u.perms = null; } return u; })); }
      if (url === '/api/users' && m === 'POST') { if (user.role !== 'admin') return json(res, 403, { error: 'admins only' }); const b = await readBody(req); if (!b.username || !b.password) return json(res, 400, { error: 'username & password required' }); const { salt, hash } = hashPw(b.password); const perms = b.perms ? JSON.stringify(b.perms) : ''; try { db.prepare('INSERT INTO users(username,salt,hash,role,created,perms) VALUES(?,?,?,?,?,?)').run(b.username.trim(), salt, hash, b.role || 'staff', now(), perms); } catch (e) { return json(res, 400, { error: 'username already exists' }); } return json(res, 200, { ok: true }); }
      if (url.startsWith('/api/users/') && m === 'PUT') { if (user.role !== 'admin') return json(res, 403, { error: 'admins only' }); const id = decodeURIComponent(url.split('/').pop()); const b = await readBody(req); const ex = db.prepare('SELECT id FROM users WHERE id=?').get(id); if (!ex) return json(res, 404, { error: 'not found' }); if (b.role) db.prepare('UPDATE users SET role=? WHERE id=?').run(b.role, id); if (b.perms !== undefined) db.prepare('UPDATE users SET perms=? WHERE id=?').run(b.perms ? JSON.stringify(b.perms) : '', id); if (b.password) { const { salt, hash } = hashPw(b.password); db.prepare('UPDATE users SET salt=?,hash=? WHERE id=?').run(salt, hash, id); } return json(res, 200, { ok: true }); }
      if (url.startsWith('/api/users/') && m === 'DELETE') { if (user.role !== 'admin') return json(res, 403, { error: 'admins only' }); const id = decodeURIComponent(url.split('/').pop()); if (+id === user.id) return json(res, 400, { error: 'cannot delete yourself' }); db.prepare('DELETE FROM users WHERE id=?').run(id); return json(res, 200, { ok: true }); }

      return json(res, 404, { error: 'not found' });
    }

    // static (serve the app if index.html is bundled)
    if (m === 'GET') { fs.readFile(path.join(__dirname, 'index.html'), (e, data) => { if (e) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('Wilsons Production Manager API is running. Front-end not bundled yet.'); } res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(data); }); return; }
    res.writeHead(405); res.end();
  } catch (e) { json(res, 500, { error: 'server error: ' + e.message }); }
});

seedIfEmpty(); ensureAdmin(); importHistory(); backfillHistoryCooked();
// nightly server-side Excel backup (kept in DATA_DIR/backups), plus one on boot
try { writeDailyBackup(); } catch (e) {}
setInterval(() => { try { writeDailyBackup(); } catch (e) {} }, 24 * 3600 * 1000);
server.listen(PORT, () => console.log('Wilsons Production Manager backend on port ' + PORT + '  (db: ' + DB_FILE + ')'));
