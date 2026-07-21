/* Minimal, dependency-free .xlsx (Excel) writer. sheets = [{name, rows:[[cell,...],...]}] -> Buffer */
const zlib = require('node:zlib');

function crc32(buf) { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; }

function zip(files) {
  const local = [], central = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'); const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const comp = zlib.deflateRawSync(data); const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    local.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  let cdSize = 0; central.forEach(b => cdSize += b.length);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

function colLetter(n) { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function escXml(s) { return ('' + s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c])); }
function safeSheetName(n) { return ('' + n).replace(/[\\\/\?\*\[\]:]/g, ' ').slice(0, 31) || 'Sheet'; }

/* ---- styling (v43) ----------------------------------------------------------------
   Added so a branded export can be a REAL .xlsx instead of an HTML table wearing a .xls
   extension — the trick that makes Excel warn the recipient "the file format and extension
   don't match… could be corrupted or unsafe", which is not something to send a customer or
   an auditor. Cells may now be either a bare value (exactly as before — the nightly backup
   is untouched) or {v, s} where s names one of the styles below. */
const BRAND = { navy: 'FF143644', coral: 'FFE2606C', cream: 'FFF7F4EC', pink: 'FFF6C1C7', red: 'FFB4231F', grey: 'FF6B7C86' };
// Order matters: these arrays are referenced by index from cellXfs, and Excel requires
// fills[0]=none and fills[1]=gray125 to exist before any of ours.
const XL_FONTS = [
  '<font><sz val="11"/><name val="Calibri"/></font>',
  `<font><b/><sz val="18"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>`,
  `<font><sz val="11"/><color rgb="${BRAND.pink}"/><name val="Calibri"/></font>`,
  `<font><b/><sz val="13"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>`,
  `<font><b/><sz val="12"/><color rgb="${BRAND.navy}"/><name val="Calibri"/></font>`,
  `<font><b/><sz val="10"/><color rgb="${BRAND.navy}"/><name val="Calibri"/></font>`,
  '<font><sz val="10"/><name val="Calibri"/></font>',
  `<font><b/><sz val="9"/><color rgb="${BRAND.red}"/><name val="Calibri"/></font>`,
  `<font><sz val="8"/><color rgb="${BRAND.grey}"/><name val="Calibri"/></font>`
];
const XL_FILLS = [
  '<fill><patternFill patternType="none"/></fill>',
  '<fill><patternFill patternType="gray125"/></fill>',
  `<fill><patternFill patternType="solid"><fgColor rgb="${BRAND.navy}"/><bgColor indexed="64"/></patternFill></fill>`,
  `<fill><patternFill patternType="solid"><fgColor rgb="${BRAND.coral}"/><bgColor indexed="64"/></patternFill></fill>`,
  `<fill><patternFill patternType="solid"><fgColor rgb="${BRAND.cream}"/><bgColor indexed="64"/></patternFill></fill>`
];
const XL_BORDERS = [
  '<border><left/><right/><top/><bottom/><diagonal/></border>',
  `<border><left/><right/><top/><bottom style="thin"><color rgb="${BRAND.navy}"/></bottom><diagonal/></border>`
];
// name -> index into cellXfs below. Callers use the name; the index never leaves this file.
const XL_STYLE = { def:0, title:1, subtitle:2, band:3, recipe:4, head:5, text:6, num:7, money:8, pct:9, total:10, totalMoney:11, totalNum:12, warn:13, note:14 };
const XL_CELLXFS = [
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment vertical="center"/></xf>',
  '<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>',
  '<xf numFmtId="0" fontId="3" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment vertical="center"/></xf>',
  '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
  '<xf numFmtId="0" fontId="5" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>',
  '<xf numFmtId="0" fontId="6" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
  '<xf numFmtId="0" fontId="6" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="right"/></xf>',
  '<xf numFmtId="164" fontId="6" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>',
  '<xf numFmtId="165" fontId="6" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>',
  '<xf numFmtId="0" fontId="5" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1"/>',
  '<xf numFmtId="164" fontId="5" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1"/>',
  '<xf numFmtId="0" fontId="5" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="right"/></xf>',
  '<xf numFmtId="0" fontId="7" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
  '<xf numFmtId="0" fontId="8" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>'
];
function stylesXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;£&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="0.0&quot;%&quot;"/></numFmts>'
    + `<fonts count="${XL_FONTS.length}">${XL_FONTS.join('')}</fonts>`
    + `<fills count="${XL_FILLS.length}">${XL_FILLS.join('')}</fills>`
    + `<borders count="${XL_BORDERS.length}">${XL_BORDERS.join('')}</borders>`
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + `<cellXfs count="${XL_CELLXFS.length}">${XL_CELLXFS.join('')}</cellXfs>`
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
}

function sheetXml(rows, opts) {
  opts = opts || {};
  let body = '';
  rows.forEach((row, ri) => {
    let cells = '';
    (row || []).forEach((raw, ci) => {
      // A cell is either a bare value (as it always was) or {v, s:'styleName'}.
      const obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : { v: raw };
      const val = obj.v;
      const sIdx = obj.s != null ? (XL_STYLE[obj.s] != null ? XL_STYLE[obj.s] : 0) : 0;
      const sAttr = sIdx ? ` s="${sIdx}"` : '';
      const ref = colLetter(ci) + (ri + 1);
      // A styled-but-empty cell still has to be written, otherwise a coloured band would
      // stop at the last cell that happened to hold text.
      if (val == null || val === '') { if (sIdx) cells += `<c r="${ref}"${sAttr}/>`; return; }
      if (typeof val === 'number' && isFinite(val)) cells += `<c r="${ref}"${sAttr}><v>${val}</v></c>`;
      else cells += `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${escXml(val)}</t></is></c>`;
    });
    body += `<row r="${ri + 1}">${cells}</row>`;
  });
  const cols = Array.isArray(opts.cols) && opts.cols.length
    ? `<cols>${opts.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${+w || 12}" customWidth="1"/>`).join('')}</cols>` : '';
  const merges = Array.isArray(opts.merges) && opts.merges.length
    ? `<mergeCells count="${opts.merges.length}">${opts.merges.map(r => `<mergeCell ref="${escXml(r)}"/>`).join('')}</mergeCells>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData>${merges}</worksheet>`;
}

function buildXlsx(sheets) {
  if (!sheets.length) sheets = [{ name: 'Empty', rows: [] }];
  const files = [];
  files.push({ name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>' });
  files.push({ name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' });
  files.push({ name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map((s, i) => `<sheet name="${escXml(safeSheetName(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>' });
  // styles.xml is relationship rId(N+1), after the N worksheets.
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` + '</Relationships>' });
  files.push({ name: 'xl/styles.xml', data: stylesXml() });
  sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows, { cols: s.cols, merges: s.merges }) }));
  return zip(files);
}

module.exports = { buildXlsx, zip };
