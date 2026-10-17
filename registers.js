'use strict';
/* ============================================================================
 * registers.js — the official registers of approved establishments, in HQ.
 *
 * Four public lists, republished monthly:
 *   ew   FSA  England & Wales   CSV   (data.gov.uk "approved-food-establishments")
 *   ni   FSA  Northern Ireland  CSV   (data.gov.uk "approved-food-establishments-in-northern-ireland")
 *   sc   FSS  Scotland          XLSX  (foodstandards.gov.scot "approved-premises-register")
 *   abp  APHA ABP plants, GB    XLSX  (gov.uk "animal-by-product-operating-plants-approved-premises")
 *
 * Zero dependencies: CSV and XLSX (zip + sharedStrings) are parsed here. The same code
 * builds the shipped seed (estab-seed.json) and does the monthly refresh on the server.
 * Everything is best-effort: a failed download keeps the last good copy of that list.
 * ==========================================================================*/
const zlib = require('zlib');

const SOURCES = {
  ew: { label: 'FSA England & Wales', country: 'UK', page: 'https://www.data.gov.uk/dataset/approved-food-establishments', kind: 'csv' },
  ni: { label: 'FSA Northern Ireland', country: 'UK', page: 'https://www.data.gov.uk/dataset/approved-food-establishments-in-northern-ireland', kind: 'csv' },
  sc: { label: 'FSS Scotland', country: 'UK', page: 'https://www.foodstandards.gov.scot/publications-and-research/publications/approved-premises-register', kind: 'xlsx' },
  abp: { label: 'APHA ABP plants (GB)', country: 'UK', page: 'https://www.gov.uk/government/publications/animal-by-product-operating-plants-approved-premises', kind: 'xlsx' }
};

/* ---------- matching ---------- */
// "GB 2093" → "2093", "UK(NI) 9502 EC" → "9502", "IE 300 EC" → "300", "51/647/8003 (CAT3)" → "51/647/8003"
function normKey(s) {
  return String(s || '').toUpperCase()
    .replace(/\(CAT ?3\)/g, '').replace(/\b(EC|CE|WE|EG)\b/g, '')
    .replace(/^(UK\s*\(?NI\)?|GB|UK|NI|IRL|IE)\s*/, '')
    .replace(/[\s.]/g, '').replace(/[^A-Z0-9\/]/g, '');
}
// APHA numbers carry a suffix (…/ABP/STO); the first three groups are what people write down
function abpCore(s) { const m = String(s || '').toUpperCase().match(/^(\d{2}\/\d{3}\/\d{4})/); return m ? m[1] : ''; }

/* ---------- CSV ---------- */
function parseCsv(t) {
  const rows = []; let row = [], f = '', q = false; t = String(t).replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) { const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; } else f += c; }
  if (f || row.length) { row.push(f); rows.push(row); } return rows;
}

/* ---------- XLSX (zip of xml) ---------- */
function zipEntries(buf) {
  const out = {}; let p = buf.length - 22; while (p >= 0 && buf.readUInt32LE(p) !== 0x06054b50) p--; if (p < 0) throw new Error('not a zip');
  const n = buf.readUInt16LE(p + 10); let cd = buf.readUInt32LE(p + 16);
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(cd) !== 0x02014b50) break;
    const method = buf.readUInt16LE(cd + 10), csize = buf.readUInt32LE(cd + 20), nl = buf.readUInt16LE(cd + 28), el = buf.readUInt16LE(cd + 30), cl = buf.readUInt16LE(cd + 32), off = buf.readUInt32LE(cd + 42);
    const name = buf.toString('utf8', cd + 46, cd + 46 + nl);
    out[name] = { method, csize, off }; cd += 46 + nl + el + cl;
  }
  return out;
}
function zipRead(buf, entries, name) {
  const e = entries[name]; if (!e) return null;
  const nl = buf.readUInt16LE(e.off + 26), el = buf.readUInt16LE(e.off + 28); const start = e.off + 30 + nl + el;
  const data = buf.subarray(start, start + e.csize);
  return e.method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
}
function xmlText(s) { return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d)); }
function xlsxSheets(buf) {
  const z = zipEntries(buf);
  const ssx = zipRead(buf, z, 'xl/sharedStrings.xml'); const ss = ssx ? [...ssx.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => xmlText([...m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map(x => x[1]).join(''))) : [];
  const wb = zipRead(buf, z, 'xl/workbook.xml').toString('utf8');
  const rels = zipRead(buf, z, 'xl/_rels/workbook.xml.rels').toString('utf8');
  const relMap = {}; [...rels.matchAll(/<Relationship [^>]*>/g)].forEach(r => { const id = (r[0].match(/Id="([^"]+)"/) || [])[1], t = (r[0].match(/Target="([^"]+)"/) || [])[1]; if (id && t) relMap[id] = t.replace(/^\/?xl\//, '').replace(/^\//, ''); });
  return [...wb.matchAll(/<sheet [^>]*>/g)].map(s => {
    const name = xmlText((s[0].match(/name="([^"]*)"/) || [])[1] || ''), hidden = /state="hidden"/.test(s[0]), rid = (s[0].match(/r:id="([^"]+)"/) || [])[1];
    const path = 'xl/' + (relMap[rid] || ''); const x = zipRead(buf, z, path); if (!x) return { name, hidden, rows: [] };
    const rows = [...x.toString('utf8').matchAll(/<row [^>]*>([\s\S]*?)<\/row>/g)].map(r => {
      const o = {}; [...r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].forEach(c => {
        const col = c[1], attrs = c[2] || '', inner = c[3] || ''; let v = '';
        const vm = inner.match(/<v>([^<]*)<\/v>/); const im = inner.match(/<is>[\s\S]*?<t[^>]*>([^<]*)<\/t>/);
        if (/t="s"/.test(attrs) && vm) v = ss[+vm[1]] || ''; else if (im) v = xmlText(im[1]); else if (vm) v = xmlText(vm[1]);
        o[col] = String(v).trim(); }); return o; });
    return { name, hidden, rows };
  });
}

/* ---------- the four parsers → uniform rows {src,no,key,core,name,addr,pc,act,cat} ---------- */
function rowsFromFsaCsv(src, text) {
  const r = parseCsv(text); const h = r[0] || []; const ix = n => h.findIndex(x => String(x).replace(/^﻿/, '') === n);
  const iNo = ix('AppNo'), iName = ix('TradingName'), iA = [ix('Address1'), ix('Address2'), ix('Address3'), ix('Town')], iPc = ix('Postcode'), iAct = ix('All_Activities'), iC = ix('Country');
  if (iNo < 0 || iName < 0) throw new Error('unexpected CSV columns');
  const out = []; for (const row of r.slice(1)) { const no = String(row[iNo] || '').trim(); if (!no) continue;
    out.push({ src, no, key: normKey(no), core: '', name: String(row[iName] || '').trim(), addr: iA.map(i => i >= 0 ? row[i] : '').filter(Boolean).join(', '), pc: iPc >= 0 ? row[iPc] : '', act: iAct >= 0 ? row[iAct] : '', cat: iC >= 0 ? row[iC] : '' }); }
  return out;
}
function rowsFromFss(buf) {
  const sh = xlsxSheets(buf).find(s => s.rows.some(r => /approval number/i.test(r.B || ''))) || xlsxSheets(buf)[0];
  const out = []; let on = false;
  for (const r of sh.rows) { if (!on) { if (/approval number/i.test(r.B || '')) on = true; continue; }
    const no = String(r.B || '').trim(); if (!no || !/^[A-Z]{0,2}\s?\d{3,4}$/i.test(no)) continue;
    out.push({ src: 'sc', no, key: normKey(no), core: '', name: r.C || '', addr: [r.D, r.E, r.F, r.G].filter(Boolean).join(', '), pc: r.H || '', act: r.I || '', cat: 'Scotland' }); }
  return out;
}
function rowsFromApha(buf) {
  const seen = {}; const out = [];
  for (const sh of xlsxSheets(buf)) { if (sh.hidden) continue;
    for (const r of sh.rows) { const no = String(r.A || '').trim(); if (!no || /approval number/i.test(no) || !/\d/.test(no)) continue;
      const k = no + '|' + (r.B || ''); let rec = seen[k];
      if (!rec) { rec = seen[k] = { src: 'abp', no, key: normKey(no), core: abpCore(no), name: r.B || '', addr: r.C || '', pc: r.D || '', act: '', cat: '', _acts: new Set(), _cats: new Set() }; out.push(rec); }
      if (r.E) rec._acts.add(String(r.E).replace(/^SECTION [IVX]+ /, '')); if (r.G) rec._acts.add(r.G); if (r.F) rec._cats.add(String(r.F)); } }
  out.forEach(r => { r.act = [...r._acts].join(' · '); r.cat = [...r._cats].length ? 'ABP cat ' + [...r._cats].join('/') : ''; delete r._acts; delete r._cats; });
  return out;
}

/* ---------- finding this month's files ---------- */
async function getText(url, ms) { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms || 60000); try { const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0 WilsonsHQ' } }); if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url); return await r.text(); } finally { clearTimeout(t); } }
async function getBuf(url, ms) { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms || 120000); try { const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0 WilsonsHQ' } }); if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url); return Buffer.from(await r.arrayBuffer()); } finally { clearTimeout(t); } }
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// a sortable "issue" (YYYY-MM) read out of a file name/url, e.g. "…01-10-2026.csv", "APMS-NI-October-2026.csv", "…_October_2026.xlsx", "/2026-09/…"
function issueOf(s) {
  s = String(s || '');
  let m = s.match(/(\d{2})-(\d{2})-(\d{4})/); if (m) return m[3] + '-' + m[2];
  m = s.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-_ ]?(\d{4})/i); if (m) return m[2] + '-' + String(MONTHS[m[1].slice(0, 3).toLowerCase()]).padStart(2, '0');
  m = s.match(/(\d{4})-(\d{2})\//); if (m) return m[1] + '-' + m[2];
  m = s.match(/(\d{4})(\d{2})\d{2}\.csv/i); if (m) return m[1] + '-' + m[2];
  return '';
}
function links(html, re) { return [...new Set([...String(html).matchAll(/href="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&')).filter(u => re.test(u)))]; }
async function latestFile(src) {
  const S = SOURCES[src]; const html = await getText(S.page, 45000);
  let cands;
  if (src === 'ew') cands = links(html, /fsaopendata\.blob\.core\.windows\.net\/.*\.csv$/i).filter(u => !/NI/i.test(u.split('/').pop()));
  else if (src === 'ni') cands = links(html, /fsaopendata\.blob\.core\.windows\.net\/.*NI.*\.csv$/i);
  else if (src === 'sc') cands = links(html, /\.xlsx?$/i).map(u => u.startsWith('http') ? u : 'https://www.foodstandards.gov.scot' + u);
  else cands = links(html, /assets\.publishing\.service\.gov\.uk\/.*\.xlsx?$/i);
  cands = cands.map(u => ({ u, issue: issueOf(u) })).filter(c => c.issue).sort((a, b) => b.issue.localeCompare(a.issue));
  if (!cands.length) throw new Error('no dated file found on ' + S.page);
  return cands[0];
}
async function fetchSource(src) {
  const f = await latestFile(src); let rows;
  if (SOURCES[src].kind === 'csv') rows = rowsFromFsaCsv(src, await getText(f.u, 120000));
  else { const buf = await getBuf(f.u, 180000); rows = src === 'sc' ? rowsFromFss(buf) : rowsFromApha(buf); }
  if (rows.length < 50) throw new Error(src + ': only ' + rows.length + ' rows parsed — not replacing');
  return { src, issue: f.issue, url: f.u, n: rows.length, rows };
}
async function fetchAll(log) {
  const out = { built: new Date().toISOString(), sources: [], rows: [] };
  for (const src of Object.keys(SOURCES)) { try { const r = await fetchSource(src); out.sources.push({ src, label: SOURCES[src].label, issue: r.issue, url: r.url, n: r.n }); out.rows.push(...r.rows); if (log) log(SOURCES[src].label + ': ' + r.n + ' rows, issue ' + r.issue); } catch (e) { out.sources.push({ src, label: SOURCES[src].label, error: e.message }); if (log) log(SOURCES[src].label + ' FAILED: ' + e.message); } }
  return out;
}

/* ---------- database side ---------- */
function ensureTables(db) {
  db.exec("CREATE TABLE IF NOT EXISTS establishments(src TEXT, no TEXT, key TEXT, core TEXT, name TEXT, addr TEXT, pc TEXT, act TEXT, cat TEXT)");
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_estab_key ON establishments(key)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_estab_core ON establishments(core)'); } catch (e) {}
  db.exec("CREATE TABLE IF NOT EXISTS register_sources(src TEXT PRIMARY KEY, label TEXT, issue TEXT, url TEXT, n INTEGER, fetched TEXT, error TEXT DEFAULT '')");
}
// replace one source's rows (inside a transaction) — only called with a successful parse
function loadSource(db, s, rows, fetched) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM establishments WHERE src=?').run(s.src);
    const ins = db.prepare('INSERT INTO establishments(src,no,key,core,name,addr,pc,act,cat) VALUES(?,?,?,?,?,?,?,?,?)');
    rows.forEach(r => ins.run(r.src, r.no, r.key, r.core || '', r.name, r.addr || '', r.pc || '', r.act || '', r.cat || ''));
    db.prepare("INSERT INTO register_sources(src,label,issue,url,n,fetched,error) VALUES(?,?,?,?,?,?,'') ON CONFLICT(src) DO UPDATE SET label=excluded.label, issue=excluded.issue, url=excluded.url, n=excluded.n, fetched=excluded.fetched, error=''").run(s.src, s.label || SOURCES[s.src].label, s.issue || '', s.url || '', rows.length, fetched);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function loadSeed(db, seed) {
  ensureTables(db); if (!seed || !Array.isArray(seed.rows)) return 0; let n = 0;
  for (const s of seed.sources || []) { if (s.error) continue; const rows = seed.rows.filter(r => r.src === s.src); if (!rows.length) continue;
    const cur = db.prepare('SELECT issue FROM register_sources WHERE src=?').get(s.src);
    if (cur && cur.issue && cur.issue > (s.issue || '')) continue;   // a fresher monthly refresh already loaded — keep it
    loadSource(db, s, rows, seed.built || new Date().toISOString()); n += rows.length; }
  return n;
}
async function refresh(db, log) {
  ensureTables(db); const res = await fetchAll(log);
  for (const s of res.sources) { if (s.error) { try { db.prepare("INSERT INTO register_sources(src,label,issue,url,n,fetched,error) VALUES(?,?,'','',0,'',?) ON CONFLICT(src) DO UPDATE SET error=excluded.error").run(s.src, s.label, s.error); } catch (e) {} continue; }
    loadSource(db, s, res.rows.filter(r => r.src === s.src), res.built); }
  return res.sources;
}
function status(db) { ensureTables(db); return db.prepare('SELECT * FROM register_sources ORDER BY src').all().map(s => Object.assign(s, { label: s.label || (SOURCES[s.src] || {}).label })); }
// search by number (as written anywhere) or by name; exact number first, then number prefix, then name
function search(db, q, limit) {
  ensureTables(db); q = String(q || '').trim(); if (!q) return []; const lim = limit || 12;
  const k = normKey(q), core = abpCore(q); const out = []; const seen = new Set();
  const push = r => { const id = r.src + '|' + r.no + '|' + r.name; if (seen.has(id)) return; seen.add(id); out.push(Object.assign(r, { label: (SOURCES[r.src] || {}).label || r.src })); };
  if (k) {
    db.prepare('SELECT * FROM establishments WHERE key=? OR (core<>\'\' AND core=?) LIMIT ?').all(k, core || k, lim).forEach(push);
    if (out.length < lim && k.length >= 2) db.prepare('SELECT * FROM establishments WHERE key LIKE ? OR (core<>\'\' AND core LIKE ?) ORDER BY length(key) LIMIT ?').all(k + '%', (core || k) + '%', lim).forEach(push);
  }
  if (out.length < lim && q.replace(/[^a-z]/gi, '').length >= 3) db.prepare('SELECT * FROM establishments WHERE name LIKE ? COLLATE NOCASE ORDER BY name LIMIT ?').all('%' + q + '%', lim).forEach(push);
  return out.slice(0, lim);
}
function lookupExact(db, no) { ensureTables(db); const k = normKey(no), core = abpCore(no); if (!k) return null; return db.prepare('SELECT * FROM establishments WHERE key=? OR (core<>\'\' AND core=?) LIMIT 1').get(k, core || k) || null; }

module.exports = { SOURCES, normKey, abpCore, parseCsv, xlsxSheets, rowsFromFsaCsv, rowsFromFss, rowsFromApha, fetchAll, fetchSource, latestFile, issueOf, ensureTables, loadSeed, refresh, status, search, lookupExact };
