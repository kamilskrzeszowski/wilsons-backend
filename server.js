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
const { buildXlsx, zip } = require('./xlsx.js');

const APP_VERSION = 'v21';   // bump this each release so the app can confirm the newest code is live
// v20 — added Planning module (tasks, projects, delegation) at /planning
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || (process.env.HOME ? path.join(process.env.HOME, 'data') : __dirname);
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const DB_FILE = path.join(DATA_DIR, 'app.db');
// If an uploaded backup is waiting to be applied (from the Restore button), swap it in now —
// the data being replaced is kept alongside as app.db.pre-restore-<time>.
try {
  const pending = path.join(DATA_DIR, 'app.db.restore-pending');
  if (fs.existsSync(pending)) {
    if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, path.join(DATA_DIR, 'app.db.pre-restore-' + new Date().toISOString().replace(/[:.]/g, '-')));
    ['-wal', '-shm'].forEach(s => { try { fs.unlinkSync(DB_FILE + s); } catch (e) {} });
    fs.renameSync(pending, DB_FILE);
    console.log('Restored database from uploaded backup (previous data kept as app.db.pre-restore-*).');
  }
} catch (e) { console.log('restore apply failed:', e.message); }
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
try { db.exec("ALTER TABLE users ADD COLUMN prefs TEXT DEFAULT ''"); } catch (e) {}   // per-person home-screen preferences
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
db.exec("CREATE TABLE IF NOT EXISTS costing_kv(key TEXT PRIMARY KEY, value TEXT, updated TEXT)");
db.exec("CREATE TABLE IF NOT EXISTS complaints(id TEXT PRIMARY KEY, ref TEXT, data TEXT, created TEXT, updated TEXT, by TEXT)");
db.exec("CREATE INDEX IF NOT EXISTS idx_complaints_ref ON complaints(ref)");
db.exec("CREATE TABLE IF NOT EXISTS invites(token TEXT PRIMARY KEY, label TEXT, role TEXT, perms TEXT, created TEXT, expires INTEGER, used_by TEXT, used_at TEXT)");
db.exec("CREATE TABLE IF NOT EXISTS kpi_kv(key TEXT PRIMARY KEY, value TEXT, updated TEXT)");
db.exec("CREATE TABLE IF NOT EXISTS specs_kv(key TEXT PRIMARY KEY, value TEXT, updated TEXT)");
try { db.exec("ALTER TABLE users ADD COLUMN factory TEXT DEFAULT ''"); } catch (e) {}          // '', 'ayr' or 'blair'
try { db.exec("ALTER TABLE recipes ADD COLUMN source TEXT DEFAULT ''"); } catch (e) {}         // 'costing' = created/synced from Recipe Costing
try { db.exec("ALTER TABLE recipes ADD COLUMN color TEXT DEFAULT ''"); } catch (e) {}          // recipe tile colour, set in Recipe Costing
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
// One-time import of the complaints history (from the customer-service spreadsheet).
// Runs once per seed version; the flag in meta stops it re-importing over live entries.
function importComplaintsSeed() {
  try {
    const f = path.join(__dirname, 'complaints-seed.json');
    if (!fs.existsSync(f)) return;
    const seed = JSON.parse(fs.readFileSync(f, 'utf8'));
    const want = +(seed.version || 1);
    const row = db.prepare("SELECT value FROM meta WHERE key='complaintsSeedV'").get();
    if (row && +row.value >= want) return;
    const ins = db.prepare('INSERT INTO complaints(id,ref,data,created,updated,by) VALUES(?,?,?,?,?,?)');
    db.exec('BEGIN');
    try {
      // a newer seed replaces ONLY its own previous import — complaints logged in the app are untouched
      db.prepare("DELETE FROM complaints WHERE by='history import'").run();
      (seed.complaints || []).forEach(c => ins.run(uid('cp'), c.ref || '', JSON.stringify(c), now(), now(), 'history import'));
      db.prepare("INSERT INTO meta(key,value) VALUES('complaintsSeedV',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(want));
      db.exec('COMMIT');
      console.log('Imported ' + (seed.complaints || []).length + ' complaints from the customer-service spreadsheet.');
    } catch (e) { db.exec('ROLLBACK'); console.log('complaints import failed:', e.message); }
  } catch (e) { console.log('complaints seed read failed:', e.message); }
}
// One-time import of the product specifications (the boss's exported fresh-specs data, 20 products).
function importSpecsSeed() {
  try {
    const f = path.join(__dirname, 'specs-seed.json');
    if (!fs.existsSync(f)) return;
    const seed = JSON.parse(fs.readFileSync(f, 'utf8'));
    const want = +(seed.version || 1);
    const row = db.prepare("SELECT value FROM meta WHERE key='specsSeedV'").get();
    if (row && +row.value >= want) return;
    if (!db.prepare("SELECT key FROM specs_kv WHERE key='data'").get()) {
      db.prepare('INSERT INTO specs_kv(key,value,updated) VALUES(?,?,?)').run('data', JSON.stringify(seed.data || { products: [] }), now());
      console.log('Imported ' + ((seed.data || {}).products || []).length + ' product specifications.');
    }
    db.prepare("INSERT INTO meta(key,value) VALUES('specsSeedV',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(want));
  } catch (e) { console.log('specs seed failed:', e.message); }
}
// One-time import of the KPI dashboard's data + settings (full daily history from Aug 2025).
function importKpiSeed() {
  try {
    const f = path.join(__dirname, 'kpi-seed.json');
    if (!fs.existsSync(f)) return;
    const seed = JSON.parse(fs.readFileSync(f, 'utf8'));
    const want = +(seed.version || 1);
    const row = db.prepare("SELECT value FROM meta WHERE key='kpiSeedV'").get();
    if (row && +row.value >= want) return;
    const up = db.prepare('INSERT INTO kpi_kv(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated');
    // seed only fills gaps — it never overwrites data already entered in the app
    if (!db.prepare("SELECT key FROM kpi_kv WHERE key='raw'").get()) up.run('raw', JSON.stringify(seed.raw || {}), now());
    if (!db.prepare("SELECT key FROM kpi_kv WHERE key='settings'").get()) up.run('settings', JSON.stringify(seed.settings || {}), now());
    db.prepare("INSERT INTO meta(key,value) VALUES('kpiSeedV',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(want));
    console.log('Imported KPI dashboard history + settings (seed v' + want + ').');
  } catch (e) { console.log('kpi seed failed:', e.message); }
}
// One-time gap-fill of KPI history from the ops spreadsheets (reasons, targets, safety, volumes).
// Only ever fills EMPTY cells — never overwrites a number entered in the app.
function backfillKpiFromHistory() {
  try {
    const f = path.join(__dirname, 'kpi-backfill.json');
    if (!fs.existsSync(f)) return;
    const bf = JSON.parse(fs.readFileSync(f, 'utf8'));
    const want = 1;
    const row = db.prepare("SELECT value FROM meta WHERE key='kpiBackfillV'").get();
    if (row && +row.value >= want) return;
    const rrow = db.prepare("SELECT value FROM kpi_kv WHERE key='raw'").get();
    if (!rrow) return;                                   // nothing to fill yet
    const raw = JSON.parse(rrow.value); raw.in = raw.in || {}; raw.dates = raw.dates || [];
    const idx = {}; raw.dates.forEach((d, i) => idx[d] = i);
    let filled = 0;
    Object.keys(bf.in || {}).forEach(field => {
      const col = bf.in[field];
      if (!raw.in[field]) raw.in[field] = raw.dates.map(() => null);
      (bf.dates || []).forEach((d, i) => {
        const v = col[i]; if (v == null || v === '') return;
        const ri = idx[d]; if (ri == null) return;        // only dates already in the calendar
        const cur = raw.in[field][ri];
        if (cur == null || cur === '') { raw.in[field][ri] = v; filled++; }
      });
    });
    db.prepare('INSERT INTO kpi_kv(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated').run('raw', JSON.stringify(raw), now());
    db.prepare("INSERT INTO meta(key,value) VALUES('kpiBackfillV',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(want));
    console.log('KPI history gap-fill: ' + filled + ' empty cells filled from the ops spreadsheets.');
  } catch (e) { console.log('kpi backfill failed:', e.message); }
}
// One-time reconciliation: make the KPI history AGREE with the hand-kept Summary Report (the master).
// Unlike the gap-fill above, this OVERWRITES the listed columns for exactly the listed dates, so the
// KPI's recovered/spent/variance reproduce the Summary figures. Guarded by meta 'kpiReconcileV'.
function reconcileKpiFromSummary() {
  try {
    const f = path.join(__dirname, 'kpi-reconcile.json');
    if (!fs.existsSync(f)) return;
    const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
    const want = rec.version || 1;
    const row = db.prepare("SELECT value FROM meta WHERE key='kpiReconcileV'").get();
    if (row && +row.value >= want) return;
    const rrow = db.prepare("SELECT value FROM kpi_kv WHERE key='raw'").get();
    if (!rrow) return;
    const raw = JSON.parse(rrow.value); raw.in = raw.in || {}; raw.dates = raw.dates || [];
    const idx = {}; raw.dates.forEach((d, i) => idx[d] = i);
    let set = 0, days = 0;
    Object.keys(rec.days || {}).forEach(date => {
      const ri = idx[date]; if (ri == null) return;          // only dates already in the calendar
      const day = rec.days[date]; days++;
      Object.keys(day).forEach(col => {
        if (!raw.in[col]) raw.in[col] = raw.dates.map(() => null);
        raw.in[col][ri] = day[col];                          // authoritative overwrite (incl. null / 0)
        set++;
      });
    });
    db.prepare('INSERT INTO kpi_kv(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated').run('raw', JSON.stringify(raw), now());
    db.prepare("INSERT INTO meta(key,value) VALUES('kpiReconcileV',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(want));
    console.log('KPI reconcile: aligned ' + days + ' days (' + set + ' cells) to the Summary Report.');
  } catch (e) { console.log('kpi reconcile failed:', e.message); }
}
// One-time: add the PAH white-label recipes to Recipe Costing. Additive — new ingredients are only
// created when they don't already exist (matched case-insensitively); existing ingredients are reused.
// Guarded by meta 'pahRecipesV'. Writes the costing store (wpf_custom / wpf_customings) AND the shared
// recipes/ingredients tables so the recipe appears in Costing and across the app.
function importPahRecipes() {
  try {
    const f = path.join(__dirname, 'pah-recipes-seed.json');
    if (!fs.existsSync(f)) return;
    const seed = JSON.parse(fs.readFileSync(f, 'utf8'));
    const want = seed.version || 1;
    const row = db.prepare("SELECT value FROM meta WHERE key='pahRecipesV'").get();
    if (row && +row.value >= want) return;
    const brand = seed.brand || 'PAH';
    const ckvGet = k => { const r = db.prepare('SELECT value FROM costing_kv WHERE key=?').get(k); return r ? r.value : null; };
    const ckvSet = (k, v) => db.prepare('INSERT INTO costing_kv(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated').run(k, v, now());
    let newIng = 0, newRec = 0;

    // 1) ingredients table + costing ingredient list (only ones that don't already exist)
    const ingByName = {}; db.prepare('SELECT id,name FROM ingredients').all().forEach(i => ingByName[i.name.trim().toLowerCase()] = i.id);
    let customings = []; try { customings = JSON.parse(ckvGet('wpf_customings') || '[]'); if (!Array.isArray(customings)) customings = []; } catch (e) { customings = []; }
    const ciByName = new Set(customings.map(x => String(x.name || '').trim().toLowerCase()));
    (seed.newIngredients || []).forEach(ni => {
      const key = String(ni.name || '').trim().toLowerCase(); if (!key) return;
      if (!ingByName[key]) { const iid = uid('i'); db.prepare('INSERT INTO ingredients(id,name,category,supplier,notes) VALUES(?,?,?,?,?)').run(iid, ni.name.trim(), ni.category || '', '', 'added for PAH white-label recipes'); ingByName[key] = iid; newIng++; }
      if (!ciByName.has(key)) { customings.push({ name: ni.name.trim(), supplier: '', custom: true, selPerTonne: ni.gbpPerKg != null ? ni.gbpPerKg * 1000 : null, selTransPerKg: null, djlPerTonne: null, djlPerKg: null, djlTransPerKg: null, monthlyUsageKg: null, spendMonth: null }); ciByName.add(key); }
    });
    ckvSet('wpf_customings', JSON.stringify(customings));

    // 2) costing recipe store (wpf_custom) — append recipes not already present
    let custom = []; try { custom = JSON.parse(ckvGet('wpf_custom') || '[]'); if (!Array.isArray(custom)) custom = []; } catch (e) { custom = []; }
    const haveCostName = new Set(custom.map(r => String(r.name || '').trim().toLowerCase()));
    (seed.recipes || []).forEach(rc => {
      const costName = brand + ' — ' + rc.appName;                 // "PAH — Chicken"
      if (haveCostName.has(costName.trim().toLowerCase())) return;
      custom.push({ name: costName, appName: rc.appName, brand, custom: { perKg: 0 }, batchSize: rc.batchSize || 100, wastePct: rc.wastePct != null ? rc.wastePct : 0.05,
        ingredients: (rc.ingredients || []).map(i => ({ name: i.name, kg: +i.kg || 0, perKg: +i.perKg || 0 })) });
    });
    ckvSet('wpf_custom', JSON.stringify(custom));

    // 3) shared recipes table (so the recipe shows across the app immediately) — keyed by name+brand
    const keyOf = (n, b) => String(n || '').trim().toLowerCase() + '|' + String(b || '').trim().toLowerCase();
    const haveRec = new Set(db.prepare('SELECT name,brand FROM recipes').all().map(r => keyOf(r.name, r.brand)));
    (seed.recipes || []).forEach(rc => {
      if (haveRec.has(keyOf(rc.appName, brand))) return;
      const ings = (rc.ingredients || []).map(i => { const iid = ingByName[String(i.name).trim().toLowerCase()]; return iid ? { ingId: iid, kg: +i.kg || 0 } : null; }).filter(Boolean);
      const id = 'pah-' + String(rc.appName).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      db.prepare("INSERT INTO recipes(id,brand,name,packs,ingredients,updated,source,color) VALUES(?,?,?,?,?,?,'costing',?)")
        .run(id, brand, rc.appName, '[]', JSON.stringify(ings), now(), '#b7772a');
      newRec++;
    });

    db.prepare("INSERT INTO meta(key,value) VALUES('pahRecipesV',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(want));
    console.log('PAH recipes: added ' + newRec + ' recipes and ' + newIng + ' new ingredient(s).');
  } catch (e) { console.log('pah recipes import failed:', e.message); }
}
// One-time: the wider PAH ranges (Fresh Frozen / Ambient · Dog / Cat). Groups the first 7 PAH recipes
// under an "Initial recipes" range and adds the rest, one range per spreadsheet tab. Additive; guarded
// by meta 'pahRangesV'. Concept recipes carry no prices, so new ingredients are added unpriced.
function importPahRanges() {
  try {
    const f = path.join(__dirname, 'pah-ranges-seed.json');
    if (!fs.existsSync(f)) return;
    const seed = JSON.parse(fs.readFileSync(f, 'utf8'));
    const want = seed.version || 1;
    const row = db.prepare("SELECT value FROM meta WHERE key='pahRangesV'").get();
    if (row && +row.value >= want) return;
    const brand = seed.brand || 'PAH';
    const initialRange = seed.initialRange || 'Initial recipes';
    const ckvGet = k => { const r = db.prepare('SELECT value FROM costing_kv WHERE key=?').get(k); return r ? r.value : null; };
    const ckvSet = (k, v) => db.prepare('INSERT INTO costing_kv(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated').run(k, v, now());
    let newIng = 0, newRec = 0;

    // 1) new ingredients (concept recipes give no prices, so these are added without a price)
    const ingByName = {}; db.prepare('SELECT id,name FROM ingredients').all().forEach(i => ingByName[i.name.trim().toLowerCase()] = i.id);
    let customings = []; try { customings = JSON.parse(ckvGet('wpf_customings') || '[]'); if (!Array.isArray(customings)) customings = []; } catch (e) { customings = []; }
    const ciByName = new Set(customings.map(x => String(x.name || '').trim().toLowerCase()));
    (seed.newIngredients || []).forEach(ni => {
      const key = String(ni.name || '').trim().toLowerCase(); if (!key) return;
      if (!ingByName[key]) { const iid = uid('i'); db.prepare('INSERT INTO ingredients(id,name,category,supplier,notes) VALUES(?,?,?,?,?)').run(iid, ni.name.trim(), ni.category || '', '', 'added for PAH ' + brand + ' concept ranges'); ingByName[key] = iid; newIng++; }
      if (!ciByName.has(key)) { customings.push({ name: ni.name.trim(), supplier: '', custom: true, selPerTonne: null, selTransPerKg: null, djlPerTonne: null, djlPerKg: null, djlTransPerKg: null, monthlyUsageKg: null, spendMonth: null }); ciByName.add(key); }
    });
    ckvSet('wpf_customings', JSON.stringify(customings));

    // 2) costing recipe store: label the existing initial PAH recipes, then add the new ranged ones
    let custom = []; try { custom = JSON.parse(ckvGet('wpf_custom') || '[]'); if (!Array.isArray(custom)) custom = []; } catch (e) { custom = []; }
    custom.forEach(r => { if (String(r.brand || '').trim().toLowerCase() === brand.toLowerCase() && !r.range) r.range = initialRange; });
    const haveCostName = new Set(custom.map(r => String(r.name || '').trim().toLowerCase()));
    (seed.recipes || []).forEach(rc => {
      const uniqueApp = rc.range + ' — ' + rc.appName;             // unique within the brand so the app-wide sync keeps them distinct
      const costName = brand + ' — ' + uniqueApp;
      if (haveCostName.has(costName.trim().toLowerCase())) return;
      custom.push({ name: costName, appName: uniqueApp, brand, range: rc.range, custom: { perKg: 0 }, batchSize: rc.batchSize || 100, wastePct: rc.wastePct != null ? rc.wastePct : 0.05,
        ingredients: (rc.ingredients || []).map(i => ({ name: i.name, kg: +i.kg || 0, perKg: +i.perKg || 0 })) });
    });
    ckvSet('wpf_custom', JSON.stringify(custom));

    // 3) shared recipes table — unique name per range ("<Range> — <Recipe>"), keyed by name+brand
    const keyOf = (n, b) => String(n || '').trim().toLowerCase() + '|' + String(b || '').trim().toLowerCase();
    const haveRec = new Set(db.prepare('SELECT name,brand FROM recipes').all().map(r => keyOf(r.name, r.brand)));
    (seed.recipes || []).forEach(rc => {
      const recName = rc.range + ' — ' + rc.appName;
      if (haveRec.has(keyOf(recName, brand))) return;
      const ings = (rc.ingredients || []).map(i => { const iid = ingByName[String(i.name).trim().toLowerCase()]; return iid ? { ingId: iid, kg: +i.kg || 0 } : null; }).filter(Boolean);
      const id = 'pah-' + String(recName).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      db.prepare("INSERT INTO recipes(id,brand,name,packs,ingredients,updated,source,color) VALUES(?,?,?,?,?,?,'costing',?)")
        .run(id, brand, recName, '[]', JSON.stringify(ings), now(), '#0072ce');
      newRec++;
    });

    db.prepare("INSERT INTO meta(key,value) VALUES('pahRangesV',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(want));
    console.log('PAH ranges: added ' + newRec + ' recipes and ' + newIng + ' new ingredient(s).');
  } catch (e) { console.log('pah ranges import failed:', e.message); }
}
// One-time: make sure every costed recipe has a product spec. ADDITIVE and NON-DESTRUCTIVE — existing
// specs are never touched or overwritten; a draft spec is created only for a recipe that has no spec with
// the same brand+name. New specs are DRAFTS: the Composition is auto-filled from the recipe's ingredients
// (real data); everything else uses the same [placeholder] template the app's own drafts use, for the
// team to complete. Guarded by meta 'recipeSpecsV'.
function ensureRecipeSpecs() {
  try {
    const want = 2;
    const row = db.prepare("SELECT value FROM meta WHERE key='recipeSpecsV'").get();
    if (row && +row.value >= want) return;
    const srow = db.prepare("SELECT value FROM specs_kv WHERE key='data'").get();
    let data = { products: [] };
    if (srow) { try { data = JSON.parse(srow.value) || { products: [] }; } catch (e) { data = { products: [] }; } }
    if (!Array.isArray(data.products)) data.products = [];
    const keyOf = (b, n) => String(b || '').trim().toLowerCase() + '|' + String(n || '').trim().toLowerCase();
    const byKey = {}; data.products.forEach(p => { byKey[keyOf(p.brand, p.name)] = p; });

    // spec template pieces — kept identical to the Bowlprint draft template in specs.html
    const FA = [[5,188,198,247],[6,216,227,284],[7,242,255,318],[8,267,281,352],[9,292,307,384],[10,316,333,416],[12,362,382,477],[15,428,451,564],[20,532,560,700],[25,628,662,827],[30,721,758,948],[35,809,851,1064],[40,894,941,1176]];
    const AN_LABELS = ['Crude protein','Crude fat','Crude fibre','Crude ash','Moisture','Calcium','Phosphorus'];
    const ADULT_NOTE = 'Grams per day for adult dogs at maintenance. Introduce gradually over 5–7 days (start ~25% new food, increasing daily). Serve at room temperature; always provide fresh drinking water. Adjust to keep your dog in ideal body condition.';
    const DISC = 'The composition, analytical constituents, additives and claims stated are based on the current approved recipe together with formulation data and laboratory analysis gathered during development. This document is provided for the customer’s internal review and to inform final artwork; approval of on-pack content and label declarations remains the responsibility of the customer. Information is supplied in good faith and believed accurate to the best of our knowledge.';
    const DEFMETA = () => [{ l: 'Spec ref', v: '[ add code ]' }, { l: 'Revision', v: '1.0 (draft)' }, { l: 'Issued', v: '[ add date ]' }, { l: 'Pack', v: '[ add pack ]' }];
    const general = (nameLine, cp) => [
      { l: 'Product name', v: nameLine }, { l: 'Life stage', v: '[ Adult / Puppy ]' },
      { l: 'Food type', v: cp ? 'Cold-pressed complete dry food' : 'Complete wet food · gently steamed, ready to eat' },
      { l: 'Pack format', v: '[ add pack format ]' }, { l: 'Net weight', v: '[ add net weight ]' },
      { l: 'Barcode (EAN-13)', v: '[ add 13-digit code ]' }, { l: 'Case configuration', v: '[ add case config ]' },
      { l: 'Storage', v: 'Cool, dry place, out of direct sunlight' }, { l: 'After opening', v: cp ? 'Reseal; use within the best-before period' : 'Refrigerate & use within 4 days' },
      { l: 'Shelf life', v: '[ XX months from production ]' }, { l: 'Country of origin', v: 'United Kingdom' }];

    const ingNames = {}; db.prepare('SELECT id,name FROM ingredients').all().forEach(i => ingNames[i.id] = i.name);
    const compOf = ingsJson => {
      let ings = []; try { ings = JSON.parse(ingsJson || '[]'); } catch (e) {}
      const total = ings.reduce((a, g) => a + (+g.kg || 0), 0) || 1;
      const parts = ings.slice().sort((a, b) => (+b.kg || 0) - (+a.kg || 0)).map(g => { const pct = (+g.kg || 0) / total * 100; const p = pct >= 1 ? Math.round(pct * 10) / 10 : Math.round(pct * 1000) / 1000; return (ingNames[g.ingId] || g.ingId) + ' (' + p + '%)'; });
      return parts.length ? parts.join(', ') + '.' : '';
    };

    const recipes = db.prepare('SELECT id,brand,name,ingredients,color FROM recipes ORDER BY brand,name').all();
    let created = 0, linked = 0;
    recipes.forEach(r => {
      const ref = String(r.brand || '').trim() + ' ' + String(r.name || '').trim();   // "Brand Name" — resolves via /api/recipe-composition
      const ex = byKey[keyOf(r.brand, r.name)];
      if (ex) {                                                      // spec already exists — don't overwrite; just link our own drafts so composition stays live
        if (ex.id && String(ex.id).startsWith('rx-') && !ex.recipeRef) { ex.recipeRef = ref; linked++; }
        return;
      }
      const cp = /cold pressed/i.test(r.brand || '');
      const spec = {
        id: 'rx-' + (String(r.brand || '') + '-' + String(r.name || '')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        name: r.name, recipeRef: ref, subtitle: '[ complete the subtitle ]', descriptor: cp ? 'Cold-pressed · [ complete the details ]' : 'Gently steamed · [ complete the details ]',
        accent: r.color || '#f37d89', range: cp ? 'Cold Press' : 'Fresh', brand: r.brand || 'White Label', logo: null, meta: DEFMETA(),
        sections: [
          { kind: 'chips', title: 'Key facts', show: true, data: ['Draft', '[ add ]'] },
          { kind: 'text', title: 'Composition', show: true, wide: true, data: compOf(r.ingredients) },
          { kind: 'analytical', title: 'Analytical constituents', show: true, data: { rows: AN_LABELS.map(l => ({ l, v: '' })), energy: '' } },
          { kind: 'additives', title: 'Additives / kg', show: true, data: { vitamins: '', trace: '' } },
          { kind: 'kv', title: 'General characteristics', show: true, wide: true, data: general(r.name, cp) },
          { kind: 'feedAdult', title: 'Feeding guide', show: true, wide: true, data: { note: ADULT_NOTE, table: JSON.parse(JSON.stringify(FA)) } },
          { kind: 'claims', title: 'Claims & statements', show: true, wide: true, data: ['[ add claims ]'] },
          { kind: 'disclaimer', title: 'Notes & sign-off', show: true, wide: true, data: DISC }
        ]
      };
      data.products.push(spec); byKey[keyOf(r.brand, r.name)] = spec; created++;
    });
    db.prepare('INSERT INTO specs_kv(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated').run('data', JSON.stringify(data), now());
    db.prepare("INSERT INTO meta(key,value) VALUES('recipeSpecsV',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(want));
    console.log('Recipe specs: created ' + created + ' draft spec(s), linked ' + linked + ' existing draft(s) to their recipe; existing specs left untouched.');
  } catch (e) { console.log('recipe specs failed:', e.message); }
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
  const u = db.prepare('SELECT id,username,role,perms,factory FROM users WHERE id=?').get(s.user_id);
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
  sheets.push({ name: 'Production', rows: [['Date', 'Product', 'Size', 'Bags', 'kg', 'Batch', 'Basket', 'Mince date', 'Cook date', 'Retort', 'Julian', 'Best before', 'Filled date', 'Temp start', 'Temp finish', 'Fill start', 'Fill finish', 'Operators', 'Stack', 'Stack complete', 'Trays', 'Historical import', 'By'],
    ...db.prepare('SELECT * FROM production ORDER BY date DESC, created DESC').all().map(p => [p.date, p.product, p.pack, p.qty, p.kg, p.batch, p.basket, p.mince_date, p.cook_date, p.retort, p.julian_code, p.best_before, p.filled_date, p.temp_start, p.temp_finish, p.fill_start, p.fill_finish, p.operators, p.stack_id, p.stack_complete ? 'yes' : 'no', p.trays, p.hist ? 'yes' : '', p.by])] });
  sheets.push({ name: 'Deliveries', rows: [['Date', 'Supplier', 'Ingredient', 'Description', 'Qty kg', 'Ref/PO', 'Approval', 'Approved', 'Temp', 'Vehicle', 'Quality', 'Type', 'Batch', 'Initials', 'Historical import'],
    ...db.prepare('SELECT * FROM deliveries ORDER BY date DESC').all().map(d => { const ing = db.prepare('SELECT name FROM ingredients WHERE id=?').get(d.ing_id); return [d.date, d.supplier, ing ? ing.name : d.ing_id, d.descr, d.qty, d.ref, d.approval, d.approved, d.temp, d.veh, d.qual, d.type, d.batch, d.initials, d.hist ? 'yes' : '']; })] });
  sheets.push({ name: 'Adjustments', rows: [['Date', 'Ingredient', 'Change kg', 'Reason', 'By'],
    ...db.prepare('SELECT * FROM adjustments ORDER BY created DESC').all().map(a => { const ing = db.prepare('SELECT name FROM ingredients WHERE id=?').get(a.ing_id); return [a.date, ing ? ing.name : a.ing_id, a.delta, a.reason, a.by]; })] });
  sheets.push({ name: 'Packaging', rows: [['Item', 'Type', 'Qty', 'Re-order pt'], ...db.prepare('SELECT * FROM packaging').all().map(p => [p.name, p.type, p.qty, p.reorder])] });
  sheets.push({ name: 'Suppliers', rows: [['Trading name', 'Approval', 'Product', 'Activity', 'Address', 'Post code'], ...db.prepare('SELECT * FROM suppliers ORDER BY name').all().map(s => [s.name, s.approval, s.product, s.activity, s.address, s.postcode])] });
  sheets.push({ name: 'Ingredients', rows: [['Name', 'Category', 'Supplier', 'Notes'], ...db.prepare('SELECT * FROM ingredients ORDER BY name').all().map(i => [i.name, i.category, i.supplier || '', i.notes || ''])] });
  sheets.push({ name: 'Recipes', rows: [['Recipe', 'Brand', 'Pack sizes', 'Shelf life (months)', 'Last updated'],
    ...db.prepare('SELECT * FROM recipes ORDER BY brand, name').all().map(r => { let packs = []; try { packs = JSON.parse(r.packs || '[]'); } catch (e) {} return [r.name, r.brand, packs.join(', '), r.shelf_months != null ? r.shelf_months : '', r.updated || '']; })] });
  const ri = [['Recipe', 'Brand', 'Ingredient', 'kg per 100kg']];
  db.prepare('SELECT * FROM recipes').all().forEach(r => { const items = JSON.parse(r.ingredients || '[]'); items.forEach(li => { const ing = db.prepare('SELECT name FROM ingredients WHERE id=?').get(li.ingId); ri.push([r.name, r.brand, ing ? ing.name : li.ingId, li.kg]); }); });
  sheets.push({ name: 'Recipe ingredients', rows: ri });
  // Pick & Mix traceability
  sheets.push({ name: 'Mixes', rows: [['Date', 'Recipe', 'Mix batch', 'kg', 'By'],
    ...db.prepare('SELECT * FROM mixes ORDER BY date DESC, created DESC').all().map(x => { const r = db.prepare('SELECT name FROM recipes WHERE id=?').get(x.recipe_id); return [x.date, r ? r.name : x.recipe_id, x.batch, x.kg, x.by]; })] });
  sheets.push({ name: 'Mix ingredients', rows: [['Mix date', 'Mix batch', 'Ingredient', 'Ingredient batch code', 'kg'],
    ...db.prepare('SELECT m.date d, m.batch b, mi.ing_id, mi.batch_code, mi.qty FROM mix_items mi JOIN mixes m ON m.id=mi.mix_id ORDER BY m.date DESC').all().map(x => { const ing = db.prepare('SELECT name FROM ingredients WHERE id=?').get(x.ing_id); return [x.d, x.b, ing ? ing.name : x.ing_id, x.batch_code, x.qty]; })] });
  sheets.push({ name: 'Change log', rows: [['When', 'Brand', 'Recipe', 'Type', 'Field', 'Old', 'New', 'By'],
    ...db.prepare('SELECT * FROM change_log ORDER BY id DESC').all().map(c => [c.ts, c.brand, c.recipe, c.type, c.field, c.old, c.new, c.by])] });
  sheets.push({ name: 'Complaints', rows: [['Case Ref', 'Complaint date', 'Customer', 'Customer type', 'Complaint type', 'CS status', 'Ops status', 'CS owner', 'Ops owner', 'Site', 'Operator', 'Channel', 'Order no', 'Order date', 'Resolved date', 'Courier issue', 'Tracking', 'Courier claim', 'Quality category', 'Quality detail', 'FO retrieval', 'Product range', 'Product', 'Notes', 'Resolution notes', 'Ops notes', 'Logged by'],
    ...db.prepare('SELECT * FROM complaints ORDER BY created DESC').all().map(r => { let c = {}; try { c = JSON.parse(r.data || '{}'); } catch (e) {} return [r.ref, c.cdate || '', c.customer || '', c.custType || '', c.ctype || '', c.csStatus || '', c.opsStatus || '', c.csOwner || '', c.opsOwner || '', c.site || '', c.operator || '', c.channel || '', c.orderNo || '', c.orderDate || '', c.rdate || '', c.courierIssue || '', c.courierTracking || '', c.courierClaim || '', c.qualityCat || '', c.qualitySub || '', c.foRetrieval || '', c.productRange || '', c.product || '', c.notes || '', c.resolutionNotes || '', c.opsNotes || '', r.by || '']; })] });
  // KPI dashboard data — daily inputs table + settings
  try {
    const kraw = (function () { const r = db.prepare("SELECT value FROM kpi_kv WHERE key='raw'").get(); return r ? JSON.parse(r.value) : null; })();
    if (kraw && kraw.dates) {
      const cols = Object.keys(kraw.in || {});
      sheets.push({ name: 'KPI daily input', rows: [['Date', ...cols], ...kraw.dates.map((d, i) => [d, ...cols.map(c => { const v = (kraw.in[c] || [])[i]; return v == null ? '' : v; })])] });
    }
    const kset = db.prepare("SELECT value FROM kpi_kv WHERE key='settings'").get();
    if (kset) { const v = kset.value || ''; const rows = [['Part', 'KPI settings (JSON)']]; for (let i = 0, p = 1; i < v.length || p === 1; i += 30000, p++) rows.push([p, v.slice(i, i + 30000)]); sheets.push({ name: 'KPI settings', rows }); }
  } catch (e) {}
  // product specifications — raw restorable copy
  try {
    const sp = db.prepare("SELECT value FROM specs_kv WHERE key='data'").get();
    if (sp) { const v = sp.value || ''; const rows = [['Part', 'Product specs (JSON)']]; for (let i = 0, pn = 1; i < v.length || pn === 1; i += 30000, pn++) rows.push([pn, v.slice(i, i + 30000)]); sheets.push({ name: 'Product specs raw', rows }); }
  } catch (e) {}
  sheets.push({ name: 'Users', rows: [['Username', 'Role', 'Created', 'Permissions'],
    ...db.prepare('SELECT username, role, created, perms FROM users ORDER BY username').all().map(u => [u.username, u.role, u.created || '', u.perms || '(preset by role)'])] });
  // app settings (weekly plans, filling targets, home layout, PIN is excluded) — raw, chunked for Excel's cell limit
  const st = [['Setting', 'Part', 'Value (JSON)']];
  db.prepare("SELECT key, value FROM meta WHERE key IN ('weekPlans','fillTargets','homeConfig','historyVersion')").all().forEach(r => { const v = r.value || ''; for (let i = 0, part = 1; i < v.length || part === 1; i += 30000, part++) st.push([r.key, part, v.slice(i, i + 30000)]); });
  sheets.push({ name: 'App settings', rows: st });
  // ---- costing module data (shared figures) — one backup covers everything ----
  try {
    const kv = {}; db.prepare('SELECT key,value FROM costing_kv').all().forEach(r => kv[r.key] = r.value);
    const P = (k, fb) => { try { const v = JSON.parse(kv[k]); return v == null ? fb : v; } catch (e) { return fb; } };
    if (Object.keys(kv).length) {
      const prices = P('wpf_prices', {}), ship = P('wpf_ship', {}), renames = P('wpf_renames', {}), supo = P('wpf_supnames', {});
      const pn = [...new Set([...Object.keys(prices), ...Object.keys(ship), ...Object.keys(renames), ...Object.keys(supo)])].sort();
      sheets.push({ name: 'Costing prices', rows: [['Ingredient', 'Target £/kg (override)', 'Delivery £/kg (override)', 'Renamed to', 'Supplier override'],
        ...pn.map(n => [n, prices[n] != null ? prices[n] : '', ship[n] != null ? ship[n] : '', renames[n] || '', supo[n] || ''])] });
      sheets.push({ name: 'Costing purchases', rows: [['Date', 'Ingredient', 'Supplier', 'kg', '£ per kg', 'Delivery £ per kg', 'Note'],
        ...P('wpf_purchases', []).map(p => [p.date || '', p.ing || '', p.supplier || '', p.kg || 0, p.perKg || 0, p.delPerKg || 0, p.note || ''])] });
      const rc = P('wpf_reccost', {}); const rcRows = [['Recipe', 'Waste %', 'Pack kg', 'Sell £ ex VAT', 'Extra cost items']];
      Object.keys(rc).sort().forEach(n => { const st = rc[n] || {}; const packs = Array.isArray(st.packs) ? st.packs : [];
        if (!packs.length) rcRows.push([n, st.wastePct != null ? st.wastePct * 100 : '', '', '', '']);
        packs.forEach(p => rcRows.push([n, st.wastePct != null ? st.wastePct * 100 : '', p.kg || '', p.sell || '', (p.items || []).join(', ')])); });
      sheets.push({ name: 'Costing pack sizes', rows: rcRows });
      sheets.push({ name: 'Costing cost items', rows: [['Item', 'Basis', 'Cost', 'Applied to every pack'],
        ...P('wpf_costitems', []).map(i => [i.name || '', i.basis || '', i.cost || 0, i.std ? 'yes' : 'no'])] });
      sheets.push({ name: 'Costing supplier prices', rows: [['Supplier', 'Ingredient', '£ per kg', 'Delivery £ per kg'],
        ...P('wpf_supdb', []).map(s => [s.supplier || '', s.ing || '', s.perKg || 0, s.del || 0])] });
      const cr = P('wpf_custom', []); const crRows = [['Custom recipe', 'Batch kg', 'Ingredient', 'kg', 'Sheet £/kg']];
      cr.forEach(r => (r.ingredients || []).forEach(i => crRows.push([r.name || '', r.batchSize || '', i.name || '', i.kg || 0, i.perKg || 0])));
      sheets.push({ name: 'Costing custom recipes', rows: crRows });
      // raw copy — everything needed to restore the costing module exactly (values chunked for Excel's cell limit)
      const raw = [['Key', 'Part', 'Value (JSON)']];
      Object.keys(kv).sort().forEach(k => { const v = kv[k] || ''; for (let i = 0, part = 1; i < v.length || part === 1; i += 30000, part++) raw.push([k, part, v.slice(i, i + 30000)]); });
      sheets.push({ name: 'Costing raw data', rows: raw });
    }
  } catch (e) { sheets.push({ name: 'Costing raw data', rows: [['Could not add costing sheets: ' + e.message]] }); }
  return buildXlsx(sheets);
}
// The FULL backup: one zip holding a readable Excel of every record + the exact database file.
// Restoring the zip brings back absolutely everything (stock, suppliers, production, users, costing, settings).
function buildFullBackupZip() {
  const stamp = now().slice(0, 10);
  const xlsx = buildBackupXlsx();
  const snap = path.join(DATA_DIR, 'backup-snap-' + Date.now() + '.db');
  db.exec("VACUUM INTO '" + snap.replace(/'/g, "''") + "'");   // consistent point-in-time copy of the whole database
  const dbBuf = fs.readFileSync(snap);
  try { fs.unlinkSync(snap); } catch (e) {}
  const readme = 'Wilsons HQ - full backup, ' + stamp + '\r\n\r\n' +
    'wilsons-data-' + stamp + '.xlsx : every record in readable Excel sheets.\r\n' +
    'app.db : the complete database - every table, record, setting and login.\r\n\r\n' +
    'TO RESTORE EVERYTHING: sign in as admin, press the "Restore" button (top right,\r\n' +
    'next to Backup) and choose this .zip file. The data being replaced is saved\r\n' +
    'aside on the server automatically before anything changes.\r\n';
  return zip([
    { name: 'README.txt', data: readme },
    { name: 'wilsons-data-' + stamp + '.xlsx', data: xlsx },
    { name: 'app.db', data: dbBuf }
  ]);
}
function writeDailyBackup() {
  try { const dir = path.join(DATA_DIR, 'backups'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'wilsons-backup-' + now().slice(0, 10) + '.zip'), buildFullBackupZip());
    // keep last 30 (counting older Excel-only backups too)
    const files = fs.readdirSync(dir).filter(f => /\.(xlsx|zip)$/.test(f)).sort(); while (files.length > 30) fs.unlinkSync(path.join(dir, files.shift()));
  } catch (e) { console.log('daily backup failed:', e.message); }
}
/* raw request body (for backup uploads) with a size cap */
function readRaw(req, cap) { return new Promise(resolve => { const chunks = []; let n = 0; req.on('data', c => { n += c.length; if (n > cap) { req.destroy(); resolve(null); } else chunks.push(c); }); req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', () => resolve(null)); }); }
/* minimal zip reader (for backups made by this app's own zip writer: deflate, no data descriptors) */
function extractZipEntry(buf, wantName) {
  let off = 0;
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.slice(off + 30, off + 30 + nameLen).toString('utf8');
    const dataStart = off + 30 + nameLen + extraLen;
    if (name === wantName) {
      const data = buf.slice(dataStart, dataStart + compSize);
      return method === 0 ? Buffer.from(data) : require('node:zlib').inflateRawSync(data);
    }
    off = dataStart + compSize;
  }
  throw new Error('"' + wantName + '" not found in the zip');
}

/* ---------------- request body ---------------- */
function readBody(req) { return new Promise((resolve) => { let b = ''; req.on('data', c => { b += c; if (b.length > 12e6) req.destroy(); }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve(null); } }); }); }

/* ---------------- routes ---------------- */
let planning = null; // Planning module (tasks/projects) — loaded at startup, guarded.
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const m = req.method;
  try {
    // --- auth ---
    if (url === '/api/login' && m === 'POST') {
      const b = await readBody(req); const u = db.prepare('SELECT * FROM users WHERE username=?').get((b.username || '').trim());
      if (!u || !verifyPw(b.password || '', u.salt, u.hash)) return json(res, 401, { error: 'Invalid username or password' });
      // display accounts (office wall screen) stay signed in for a year; everyone else 30 days
      let isDisplay = false; try { const p = u.perms ? JSON.parse(u.perms) : null; isDisplay = !!(p && p.display); } catch (e) {}
      const token = crypto.randomBytes(32).toString('hex'); const expires = Date.now() + (isDisplay ? 365 : 30) * 24 * 3600 * 1000;
      db.prepare('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)').run(token, u.id, expires);
      let perms = null; try { perms = u.perms ? JSON.parse(u.perms) : null; } catch (e) {}
      return json(res, 200, { token, user: { id: u.id, username: u.username, role: u.role, perms, factory: u.factory || '' } });
    }
    // --- invite links: the invited person checks the invite and creates their own account (no sign-in yet) ---
    if (url === '/api/invite-info' && m === 'GET') {
      const q = new URLSearchParams((req.url.split('?')[1] || ''));
      const inv = db.prepare('SELECT * FROM invites WHERE token=?').get(q.get('code') || '');
      if (!inv) return json(res, 404, { error: 'This invite link is not valid.' });
      if (inv.used_by) return json(res, 410, { error: 'This invite has already been used.' });
      if (inv.expires < Date.now()) return json(res, 410, { error: 'This invite has expired — ask for a new one.' });
      return json(res, 200, { ok: true, label: inv.label, role: inv.role });
    }
    if (url === '/api/invite-accept' && m === 'POST') {
      const b = await readBody(req);
      const inv = db.prepare('SELECT * FROM invites WHERE token=?').get((b && b.code) || '');
      if (!inv) return json(res, 404, { error: 'This invite link is not valid.' });
      if (inv.used_by) return json(res, 410, { error: 'This invite has already been used.' });
      if (inv.expires < Date.now()) return json(res, 410, { error: 'This invite has expired — ask for a new one.' });
      const uname = (b.username || '').trim();
      if (!/^[a-zA-Z0-9._-]{2,30}$/.test(uname)) return json(res, 400, { error: 'Pick a username of 2–30 letters or numbers (no spaces).' });
      if (!b.password || String(b.password).length < 4) return json(res, 400, { error: 'Pick a password of at least 4 characters.' });
      const { salt, hash } = hashPw(String(b.password));
      try { db.prepare('INSERT INTO users(username,salt,hash,role,created,perms) VALUES(?,?,?,?,?,?)').run(uname, salt, hash, inv.role || 'staff', now(), inv.perms || ''); }
      catch (e) { return json(res, 400, { error: 'That username is already taken — pick another.' }); }
      db.prepare('UPDATE invites SET used_by=?, used_at=? WHERE token=?').run(uname, now(), inv.token);
      const u = db.prepare('SELECT * FROM users WHERE username=?').get(uname);
      const token = crypto.randomBytes(32).toString('hex'); const expires = Date.now() + 30 * 24 * 3600 * 1000;
      db.prepare('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)').run(token, u.id, expires);
      let perms = null; try { perms = u.perms ? JSON.parse(u.perms) : null; } catch (e) {}
      console.log('Invite accepted: ' + uname + ' (' + (inv.label || 'no label') + ')');
      return json(res, 200, { token, user: { id: u.id, username: u.username, role: u.role, perms, factory: u.factory || '' } });
    }
    // FULL backup (zip: Excel + exact database) — admins, or ?key=BACKUP_KEY for the automated daily download
    if (url === '/api/backup.zip' && m === 'GET') {
      const q = new URLSearchParams((req.url.split('?')[1] || '')); const key = q.get('key');
      const u = authUser(req);
      const ok = (u && u.role === 'admin') || (process.env.BACKUP_KEY && key && key === process.env.BACKUP_KEY);
      if (!ok) return json(res, 401, { error: 'unauthorized' });
      const buf = buildFullBackupZip();
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="wilsons-backup-' + now().slice(0, 10) + '.zip"' });
      res.end(buf); return;
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
    // --- brand assets (fonts + images for the new look) — served from backend/assets ---
    if (m === 'GET' && url.startsWith('/assets/')) {
      const ASSETS = { 'logo-grapefruit.svg': 'image/svg+xml', 'wilson-pup.png': 'image/png', 'tartan.png': 'image/png', 'BobbyJones-Regular.otf': 'font/otf', 'Effra_Rg.ttf': 'font/ttf', 'Effra_Md.ttf': 'font/ttf', 'Effra_Bd.ttf': 'font/ttf', 'chart.umd.min.js': 'application/javascript', 'xlsx.full.min.js': 'application/javascript' };
      const f = decodeURIComponent(url.slice('/assets/'.length));
      if (!ASSETS[f]) { res.writeHead(404); return res.end(); }
      fs.readFile(path.join(__dirname, 'assets', f), (e, data) => {
        if (e) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': ASSETS[f], 'Cache-Control': 'public, max-age=86400' });
        res.end(data);
      });
      return;
    }
    // --- KPI dashboard page: signed-in users with the KPI (or KPI input) permission ---
    if (url === '/kpi' && m === 'GET') {
      const q = new URLSearchParams((req.url.split('?')[1] || ''));
      const tok = q.get('token') || '';
      const s = tok ? db.prepare('SELECT * FROM sessions WHERE token=?').get(tok) : null;
      let u = null;
      if (s && s.expires > Date.now()) u = db.prepare('SELECT id,username,role,perms,factory FROM users WHERE id=?').get(s.user_id);
      let allowed = false;
      if (u) {
        if (u.role === 'admin') allowed = true;
        else { try { const p = u.perms ? JSON.parse(u.perms) : null; allowed = !!(p && p.view && (p.view.kpi || p.view.kpiinput)); } catch (e) {} }
      }
      if (!allowed) { res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<p style="font-family:sans-serif;padding:30px">Please sign in to Wilsons HQ first, then open the KPI Dashboard from the menu.</p>'); }
      fs.readFile(path.join(__dirname, 'kpi.html'), (e, data) => {
        if (e) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('KPI module not installed.'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(data);
      });
      return;
    }
    // --- Product Specs page: signed-in users with the specs permission ---
    if (url === '/specs' && m === 'GET') {
      const q = new URLSearchParams((req.url.split('?')[1] || ''));
      const tok = q.get('token') || '';
      const s = tok ? db.prepare('SELECT * FROM sessions WHERE token=?').get(tok) : null;
      let u = null;
      if (s && s.expires > Date.now()) u = db.prepare('SELECT id,username,role,perms,factory FROM users WHERE id=?').get(s.user_id);
      let allowed = false;
      if (u) {
        if (u.role === 'admin') allowed = true;
        else { try { const p = u.perms ? JSON.parse(u.perms) : null; allowed = !!(p && p.view && p.view.specs); } catch (e) {} }
      }
      if (!allowed) { res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<p style="font-family:sans-serif;padding:30px">Please sign in to Wilsons HQ first, then open Product Specs from the menu.</p>'); }
      fs.readFile(path.join(__dirname, 'specs.html'), (e, data) => {
        if (e) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Specs module not installed.'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(data);
      });
      return;
    }
    // --- Costing module page: only for signed-in users who are admins or have the costing permission ---
    if (url === '/costing' && m === 'GET') {
      const q = new URLSearchParams((req.url.split('?')[1] || ''));
      const tok = q.get('token') || '';
      const s = tok ? db.prepare('SELECT * FROM sessions WHERE token=?').get(tok) : null;
      let u = null;
      if (s && s.expires > Date.now()) u = db.prepare('SELECT id,username,role,perms,factory FROM users WHERE id=?').get(s.user_id);
      let allowed = false;
      if (u) {
        if (u.role === 'admin') allowed = true;
        else { try { const p = u.perms ? JSON.parse(u.perms) : null; allowed = !!(p && p.view && p.view.costing); } catch (e) {} }
      }
      if (!allowed) { res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<p style="font-family:sans-serif;padding:30px">Please sign in to Wilsons HQ first, then open Recipe Costing from the menu.</p>'); }
      fs.readFile(path.join(__dirname, 'costing.html'), (e, data) => {
        if (e) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Costing module not installed.'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(data);
      });
      return;
    }
    // --- Planning page: served to anyone; the page itself checks your login (Bearer token
    //     from localStorage) and redirects to sign-in if needed. Data is protected by the API. ---
    if (url === '/planning' && m === 'GET') {
      fs.readFile(path.join(__dirname, 'planning.html'), (e, data) => {
        if (e) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Planning module not installed.'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(data);
      });
      return;
    }
    if (url.startsWith('/api/')) {
      const user = authUser(req);
      if (!user) return json(res, 401, { error: 'Not signed in' });

      if (url === '/api/me') return json(res, 200, { user });

      // --- Planning module (tasks/projects/delegation) — guarded so it can never break HQ ---
      if (planning) { try { if (await planning.handle({ url, method: m, req, res, user, db, json, readBody })) return; } catch (e) { return json(res, 500, { error: 'planning: ' + (e && e.message || e) }); } }

      // ---- restore EVERYTHING from an uploaded backup (admins only) ----
      // Accepts the backup .zip (or a bare app.db). The file is safety-checked, the current
      // database is kept aside, and the server restarts itself to swap the data in.
      if (url === '/api/restore' && m === 'POST') {
        if (user.role !== 'admin') return json(res, 403, { error: 'admins only' });
        const buf = await readRaw(req, 200e6);
        if (!buf || buf.length < 512) return json(res, 400, { error: 'No file received.' });
        let dbBuf = null;
        if (buf.slice(0, 15).toString('binary') === 'SQLite format 3') dbBuf = buf;
        else if (buf[0] === 0x50 && buf[1] === 0x4b) { try { dbBuf = extractZipEntry(buf, 'app.db'); } catch (e) {} }
        if (!dbBuf || dbBuf.slice(0, 15).toString('binary') !== 'SQLite format 3') return json(res, 400, { error: 'That file is not a Wilsons backup. Use the .zip from the Backup button (or an app.db file).' });
        const cand = path.join(DATA_DIR, 'restore-candidate.db');
        fs.writeFileSync(cand, dbBuf);
        try {
          const t = new DatabaseSync(cand);
          const names = t.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
          const counts = { ingredients: 0, production: 0 };
          for (const need of ['users', 'ingredients', 'recipes', 'production', 'stock', 'suppliers']) if (!names.includes(need)) throw new Error('it is missing the "' + need + '" table');
          counts.ingredients = t.prepare('SELECT count(*) c FROM ingredients').get().c;
          counts.production = t.prepare('SELECT count(*) c FROM production').get().c;
          t.close();
          console.log('Restore upload accepted by ' + user.username + ': ' + counts.ingredients + ' ingredients, ' + counts.production + ' production rows. Restarting to apply.');
        } catch (e) { try { fs.unlinkSync(cand); } catch (_) {} return json(res, 400, { error: 'Backup file failed the safety check — ' + e.message + '.' }); }
        fs.renameSync(cand, path.join(DATA_DIR, 'app.db.restore-pending'));
        json(res, 200, { ok: true, restarting: true });
        setTimeout(() => process.exit(42), 400);   // 42 = restart-to-restore (the launcher and Railway both restart the app)
        return;
      }

      // ---- personal home-screen preferences (each person's own shortcuts / KPI picks / complaint slicers) ----
      if (url === '/api/myprefs' && m === 'GET') {
        const r = db.prepare('SELECT prefs FROM users WHERE id=?').get(user.id);
        let prefs = null; try { prefs = r && r.prefs ? JSON.parse(r.prefs) : null; } catch (e) {}
        return json(res, 200, { prefs });
      }
      if (url === '/api/myprefs' && m === 'PUT') {
        const b = await readBody(req);
        db.prepare('UPDATE users SET prefs=? WHERE id=?').run(JSON.stringify((b && b.prefs) || {}), user.id);
        return json(res, 200, { ok: true });
      }

      // ---- KPI dashboard: shared data + settings ----
      const kpiView = user.role === 'admin' || !!(user.perms && user.perms.view && (user.perms.view.kpi || user.perms.view.kpiinput));
      const kpiSettingsEdit = user.role === 'admin' || !!(user.perms && user.perms.edit && user.perms.edit.kpi);
      const kpiInputEdit = user.role === 'admin' || !!(user.perms && user.perms.edit && (user.perms.edit.kpiinput || user.perms.edit.kpi));
      const kpiGet = k => { const r = db.prepare('SELECT value FROM kpi_kv WHERE key=?').get(k); try { return r ? JSON.parse(r.value) : null; } catch (e) { return null; } };
      const kpiSet = (k, v) => db.prepare('INSERT INTO kpi_kv(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated').run(k, JSON.stringify(v), now());
      if (url === '/api/kpi' && m === 'GET') {
        if (!kpiView) return json(res, 403, { error: 'no KPI access' });
        const raw = kpiGet('raw') || { dates: [], in: {} };
        // Complaint KPIs are ALWAYS taken live from the complaints tracker (the single source of
        // truth) — counted by complaint date, so they can never drift from the log.
        try {
          const idx = {}; (raw.dates || []).forEach((d, i) => idx[d] = i);
          const d2c = (raw.dates || []).map(() => 0), trade = (raw.dates || []).map(() => 0), amazon = (raw.dates || []).map(() => 0);
          db.prepare('SELECT data FROM complaints').all().forEach(r => {
            let c = {}; try { c = JSON.parse(r.data || '{}'); } catch (e) {}
            const i = idx[(c.cdate || '').slice(0, 10)]; if (i == null) return;
            if (c.custType === 'Wilsons D2C') d2c[i]++;
            else if (c.custType === 'Wilsons Trade') trade[i]++;
            else if (c.custType === 'Wilsons Amazon') amazon[i]++;
          });
          raw.in = raw.in || {}; raw.in['D2C Complaints'] = d2c; raw.in['Trade Complaints'] = trade; raw.in['Amazon Complaints'] = amazon;
        } catch (e) {}
        return json(res, 200, { raw, settings: kpiGet('settings'), refresh: kpiGet('refresh'), caps: { settings: kpiSettingsEdit, input: kpiInputEdit } });
      }
      if (url === '/api/kpi' && m === 'PUT') {
        const b = await readBody(req); if (!b) return json(res, 400, { error: 'bad request' });
        const stamp = new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        if (b.settings !== undefined) { if (!kpiSettingsEdit) return json(res, 403, { error: 'no permission to change KPI settings' }); kpiSet('settings', b.settings); }
        if (b.raw !== undefined) { if (!kpiInputEdit) return json(res, 403, { error: 'no permission to change KPI data' }); kpiSet('raw', b.raw); kpiSet('refresh', stamp); }
        // one day's numbers from the input screen — merged on the server so two people can't clobber each other
        if (b.day && b.day.date) {
          if (!kpiInputEdit) return json(res, 403, { error: 'no permission to enter KPI data' });
          const raw = kpiGet('raw') || { dates: [], in: {} };
          const d = String(b.day.date).slice(0, 10);
          if (!raw.dates.length || d > raw.dates[raw.dates.length - 1]) {
            // extend the calendar day-by-day up to the entered date
            let cur = raw.dates.length ? raw.dates[raw.dates.length - 1] : d;
            while (cur < d) {
              const nd = new Date(cur + 'T00:00:00Z'); nd.setUTCDate(nd.getUTCDate() + 1);
              cur = nd.toISOString().slice(0, 10);
              raw.dates.push(cur);
              Object.keys(raw.in).forEach(k => raw.in[k].push(null));
            }
          }
          const idx = raw.dates.indexOf(d);
          if (idx < 0) return json(res, 400, { error: 'That date is before the start of the KPI history.' });
          Object.keys(b.day.values || {}).forEach(col => {
            if (!raw.in[col]) raw.in[col] = raw.dates.map(() => null);
            while (raw.in[col].length < raw.dates.length) raw.in[col].push(null);
            const v = b.day.values[col];
            // numbers stay numbers; text fields (reasons / out-of-stocks / notes) are kept as text
            const n = Number(v);
            raw.in[col][idx] = (v === '' || v == null) ? null : (Number.isFinite(n) && String(v).trim() !== '' ? n : String(v));
          });
          kpiSet('raw', raw); kpiSet('refresh', stamp);
        }
        return json(res, 200, { ok: true });
      }

      // ---- product specifications: shared data (admins + users with the specs permission) ----
      const specsView = user.role === 'admin' || !!(user.perms && user.perms.view && user.perms.view.specs);
      const specsEdit = user.role === 'admin' || !!(user.perms && user.perms.edit && user.perms.edit.specs);
      if (url === '/api/specs' && m === 'GET') {
        if (!specsView) return json(res, 403, { error: 'no specs access' });
        const r = db.prepare("SELECT value FROM specs_kv WHERE key='data'").get();
        let data = { products: [] }; try { data = r ? JSON.parse(r.value) : data; } catch (e) {}
        return json(res, 200, { data, caps: { edit: specsEdit } });
      }
      if (url === '/api/specs' && m === 'PUT') {
        if (!specsEdit) return json(res, 403, { error: 'no permission to edit specs' });
        const b = await readBody(req);
        db.prepare("INSERT INTO specs_kv(key,value,updated) VALUES('data',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated").run(JSON.stringify((b && b.data) || { products: [] }), now());
        return json(res, 200, { ok: true });
      }

      // ---- recipe sync: Recipe Costing is the source of truth for recipes ----
      // Costing pushes its full recipe list; we upsert into the app's recipes so the
      // Recipe Library, Editor, Mixing Sheets and Planner all see the same recipes.
      // Only recipes tagged source='costing' are ever updated — hand-made app recipes are never touched.
      if (url === '/api/costing-recipe-sync' && m === 'POST') {
        const canCost = user.role === 'admin' || !!(user.perms && user.perms.view && user.perms.view.costing);
        if (!canCost) return json(res, 403, { error: 'no costing access' });
        const b = await readBody(req); const list = (b && b.recipes) || [];
        const adopt = !!(b && b.adopt);   // one-time takeover of app-made recipes (Recipe Costing becomes the single place recipes are managed)
        const ingByName = {}; db.prepare('SELECT id,name FROM ingredients').all().forEach(i => ingByName[i.name.trim().toLowerCase()] = i.id);
        // recipes are matched by name + brand together — several brands have a "Chicken"
        const keyOfRec = (name, brand) => String(name || '').trim().toLowerCase() + '|' + String(brand || '').trim().toLowerCase();
        let created = 0, updated = 0, adopted = 0; const skipped = [];
        db.exec('BEGIN');
        try {
          const byKey = {}; db.prepare('SELECT id, name, brand, source FROM recipes').all().forEach(r => byKey[keyOfRec(r.name, r.brand)] = r);
          list.forEach(rc => {
            const name = String(rc.name || '').trim(); if (!name) return;
            const ings = (rc.ingredients || []).map(g => {
              const key = String(g.name || '').trim(); if (!key) return null;
              let iid = ingByName[key.toLowerCase()];
              if (!iid) { iid = uid('i'); db.prepare('INSERT INTO ingredients(id,name,category,supplier,notes) VALUES(?,?,?,?,?)').run(iid, key, '', '', 'added by Recipe Costing sync'); ingByName[key.toLowerCase()] = iid; }
              return { ingId: iid, kg: +g.kg || 0 };
            }).filter(Boolean);
            const packs = (rc.packs || []).map(k => (String(k).match(/kg|g$/i) ? String(k) : (+k >= 1 ? k + 'kg' : Math.round(k * 1000) + 'g')));
            const ex = byKey[keyOfRec(name, rc.brand)];
            if (ex && ex.source !== 'costing' && !adopt) { skipped.push(name); return; }   // never clobber a hand-made app recipe unless adopting
            if (ex) {
              db.prepare("UPDATE recipes SET brand=?, packs=?, ingredients=?, updated=?, color=?, source='costing' WHERE id=?")
                .run(rc.brand || '', JSON.stringify(packs), JSON.stringify(ings), now(), String(rc.color || ''), ex.id);
              if (ex.source !== 'costing') adopted++; else updated++;
            } else {
              db.prepare("INSERT INTO recipes(id,brand,name,packs,ingredients,updated,source,color) VALUES(?,?,?,?,?,?,'costing',?)")
                .run(uid('r'), rc.brand || '', name, JSON.stringify(packs), JSON.stringify(ings), now(), String(rc.color || ''));
              created++;
            }
          });
          // costing is authoritative for its own recipes: remove synced copies it no longer has
          const pushed = new Set(list.map(rc => keyOfRec(rc.name, rc.brand)));
          db.prepare("SELECT id,name,brand FROM recipes WHERE source='costing'").all().forEach(r => { if (!pushed.has(keyOfRec(r.name, r.brand))) db.prepare('DELETE FROM recipes WHERE id=?').run(r.id); });
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); return json(res, 500, { error: 'sync failed: ' + e.message }); }
        return json(res, 200, { ok: true, created, updated, adopted, skipped });
      }
      // ---- version stamp: lets the app confirm the newest code is actually live ----
      if (url === '/api/version' && m === 'GET') return json(res, 200, { version: APP_VERSION });
      // ---- sidebar menu layout: admins choose which screens sit in Production / Technical / Office ----
      if (url === '/api/menu-layout' && m === 'GET') {
        const row = db.prepare("SELECT value FROM meta WHERE key='menuLayout'").get();
        let v = null; try { v = row ? JSON.parse(row.value) : null; } catch (e) {}
        return json(res, 200, { layout: v });
      }
      if (url === '/api/menu-layout' && m === 'PUT') {
        if (user.role !== 'admin') return json(res, 403, { error: 'admins only' });
        const b = await readBody(req);
        if (b && b.layout) db.prepare("INSERT INTO meta(key,value) VALUES('menuLayout',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(b.layout));
        else db.prepare("DELETE FROM meta WHERE key='menuLayout'").run();
        return json(res, 200, { ok: true });
      }
      // recipe composition as percentages (for Product Specs — "fill composition from recipe")
      if (url === '/api/recipe-composition' && m === 'GET') {
        const q = new URLSearchParams((req.url.split('?')[1] || ''));
        const name = (q.get('name') || '').trim().toLowerCase();
        const r = db.prepare('SELECT * FROM recipes WHERE lower(name)=?').get(name) || db.prepare("SELECT * FROM recipes WHERE lower(brand || ' ' || name)=?").get(name);
        if (!r) return json(res, 404, { error: 'recipe not found' });
        let ings = []; try { ings = JSON.parse(r.ingredients || '[]'); } catch (e) {}
        const total = ings.reduce((a, g) => a + (+g.kg || 0), 0) || 1;
        const names = {}; db.prepare('SELECT id,name FROM ingredients').all().forEach(i => names[i.id] = i.name);
        const parts = ings.slice().sort((a, b) => (+b.kg || 0) - (+a.kg || 0))
          .map(g => { const pct = (+g.kg || 0) / total * 100; const p = pct >= 1 ? Math.round(pct * 10) / 10 : Math.round(pct * 1000) / 1000; return (names[g.ingId] || g.ingId) + ' (' + p + '%)'; });
        return json(res, 200, { name: r.name, brand: r.brand, composition: parts.join(', ') + '.' });
      }

      // ---- complaints log (customer service) ----
      if (url === '/api/complaints' && m === 'GET') {
        return json(res, 200, db.prepare('SELECT * FROM complaints ORDER BY created DESC').all().map(r => { let d = {}; try { d = JSON.parse(r.data || '{}'); } catch (e) {} return { id: r.id, ref: r.ref, by: r.by, created: r.created, updated: r.updated, ...d }; }));
      }
      if (url === '/api/complaints' && m === 'POST') {
        const b = await readBody(req); const d = (b && b.data) || {};
        // next case ref continues the spreadsheet numbering (C3136… onwards)
        let maxN = 0; db.prepare('SELECT ref FROM complaints').all().forEach(r => { const mm = /^C(\d+)$/.exec(r.ref || ''); if (mm) maxN = Math.max(maxN, +mm[1]); });
        const ref = 'C' + (maxN + 1);
        d.ref = ref; const id = uid('cp');
        db.prepare('INSERT INTO complaints(id,ref,data,created,updated,by) VALUES(?,?,?,?,?,?)').run(id, ref, JSON.stringify(d), now(), now(), user.username);
        return json(res, 200, { ok: true, id, ref });
      }
      if (url.startsWith('/api/complaints/') && m === 'PUT') {
        const id = decodeURIComponent(url.split('/').pop());
        const ex = db.prepare('SELECT * FROM complaints WHERE id=?').get(id);
        if (!ex) return json(res, 404, { error: 'not found' });
        const b = await readBody(req); const d = (b && b.data) || {};
        d.ref = ex.ref;   // the case ref never changes
        db.prepare('UPDATE complaints SET data=?, updated=? WHERE id=?').run(JSON.stringify(d), now(), id);
        return json(res, 200, { ok: true });
      }
      if (url.startsWith('/api/complaints/') && m === 'DELETE') {
        if (user.role !== 'admin') return json(res, 403, { error: 'admins only' });
        db.prepare('DELETE FROM complaints WHERE id=?').run(decodeURIComponent(url.split('/').pop()));
        return json(res, 200, { ok: true });
      }

      // ---- account invites (admins create; the person sets their own password via the link) ----
      if (url === '/api/invites' && m === 'GET') {
        if (user.role !== 'admin') return json(res, 403, { error: 'admins only' });
        return json(res, 200, db.prepare('SELECT * FROM invites ORDER BY created DESC').all().map(i => ({ token: i.token, label: i.label, role: i.role, created: i.created, expires: i.expires, used_by: i.used_by, used_at: i.used_at, expired: !i.used_by && i.expires < Date.now() })));
      }
      if (url === '/api/invites' && m === 'POST') {
        if (user.role !== 'admin') return json(res, 403, { error: 'admins only' });
        const b = await readBody(req);
        const token = crypto.randomBytes(16).toString('hex');
        const expires = Date.now() + 7 * 24 * 3600 * 1000;   // links last 7 days
        db.prepare('INSERT INTO invites(token,label,role,perms,created,expires) VALUES(?,?,?,?,?,?)')
          .run(token, (b.label || '').trim(), b.role === 'admin' ? 'admin' : 'staff', b.perms ? JSON.stringify(b.perms) : '', now(), expires);
        return json(res, 200, { ok: true, token, expires });
      }
      if (url.startsWith('/api/invites/') && m === 'DELETE') {
        if (user.role !== 'admin') return json(res, 403, { error: 'admins only' });
        db.prepare('DELETE FROM invites WHERE token=?').run(decodeURIComponent(url.split('/').pop()));
        return json(res, 200, { ok: true });
      }

      // ---- shared costing data (admins + users with the costing permission) ----
      // The costing module keeps its figures here so every user sees the same numbers,
      // saved key-by-key like the rest of the app (last write wins per key).
      const canCosting = user.role === 'admin' || !!(user.perms && user.perms.view && user.perms.view.costing);
      if (url === '/api/costing' && m === 'GET') {
        if (!canCosting) return json(res, 403, { error: 'no costing access' });
        const data = {}; db.prepare('SELECT key,value FROM costing_kv').all().forEach(r => data[r.key] = r.value);
        return json(res, 200, { data });
      }
      if (url === '/api/costing' && m === 'PUT') {
        if (!canCosting) return json(res, 403, { error: 'no costing access' });
        const b = await readBody(req); const d = (b && b.data) || {};
        const up = db.prepare('INSERT INTO costing_kv(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated');
        const del = db.prepare('DELETE FROM costing_kv WHERE key=?');
        db.exec('BEGIN');
        try {
          Object.keys(d).forEach(k => { if (!/^wpf_[a-z]+$/.test(k)) return; if (d[k] == null) del.run(k); else up.run(k, String(d[k]), now()); });
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); return json(res, 500, { error: 'write failed' }); }
        return json(res, 200, { ok: true });
      }
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
      if (url === '/api/users' && m === 'GET') { if (user.role !== 'admin') return json(res, 403, { error: 'admins only' }); return json(res, 200, db.prepare('SELECT id,username,role,created,perms,factory FROM users').all().map(u => { try { u.perms = u.perms ? JSON.parse(u.perms) : null; } catch (e) { u.perms = null; } return u; })); }
      if (url === '/api/users' && m === 'POST') { if (user.role !== 'admin') return json(res, 403, { error: 'admins only' }); const b = await readBody(req); if (!b.username || !b.password) return json(res, 400, { error: 'username & password required' }); const { salt, hash } = hashPw(b.password); const perms = b.perms ? JSON.stringify(b.perms) : ''; try { db.prepare('INSERT INTO users(username,salt,hash,role,created,perms,factory) VALUES(?,?,?,?,?,?,?)').run(b.username.trim(), salt, hash, b.role || 'staff', now(), perms, b.factory || ''); } catch (e) { return json(res, 400, { error: 'username already exists' }); } return json(res, 200, { ok: true }); }
      if (url.startsWith('/api/users/') && m === 'PUT') { if (user.role !== 'admin') return json(res, 403, { error: 'admins only' }); const id = decodeURIComponent(url.split('/').pop()); const b = await readBody(req); const ex = db.prepare('SELECT id FROM users WHERE id=?').get(id); if (!ex) return json(res, 404, { error: 'not found' }); if (b.role) db.prepare('UPDATE users SET role=? WHERE id=?').run(b.role, id); if (b.perms !== undefined) db.prepare('UPDATE users SET perms=? WHERE id=?').run(b.perms ? JSON.stringify(b.perms) : '', id); if (b.factory !== undefined) db.prepare('UPDATE users SET factory=? WHERE id=?').run(b.factory || '', id); if (b.password) { const { salt, hash } = hashPw(b.password); db.prepare('UPDATE users SET salt=?,hash=? WHERE id=?').run(salt, hash, id); } return json(res, 200, { ok: true }); }
      if (url.startsWith('/api/users/') && m === 'DELETE') { if (user.role !== 'admin') return json(res, 403, { error: 'admins only' }); const id = decodeURIComponent(url.split('/').pop()); if (+id === user.id) return json(res, 400, { error: 'cannot delete yourself' }); db.prepare('DELETE FROM users WHERE id=?').run(id); return json(res, 200, { ok: true }); }

      return json(res, 404, { error: 'not found' });
    }

    // static (serve the app if index.html is bundled)
    if (m === 'GET') { fs.readFile(path.join(__dirname, 'index.html'), (e, data) => { if (e) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('Wilsons Production Manager API is running. Front-end not bundled yet.'); } res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(data); }); return; }
    res.writeHead(405); res.end();
  } catch (e) { json(res, 500, { error: 'server error: ' + e.message }); }
});

seedIfEmpty(); ensureAdmin(); importHistory(); backfillHistoryCooked(); importComplaintsSeed(); importKpiSeed(); backfillKpiFromHistory(); reconcileKpiFromSummary(); importPahRecipes(); importPahRanges(); importSpecsSeed(); ensureRecipeSpecs();
try { planning = require('./planning.js'); planning.init(db, { now, uid }); console.log('Planning module loaded.'); } catch (e) { console.log('planning module failed to load:', e.message); }
// nightly server-side Excel backup (kept in DATA_DIR/backups), plus one on boot
try { writeDailyBackup(); } catch (e) {}
setInterval(() => { try { writeDailyBackup(); } catch (e) {} }, 24 * 3600 * 1000);
server.listen(PORT, () => console.log('Wilsons HQ ' + APP_VERSION + ' backend on port ' + PORT + '  (db: ' + DB_FILE + ')'));
