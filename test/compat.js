#!/usr/bin/env node
/* test/compat.js — proves the TSV compatibility contract (brief requirement #5):
 * a TSV exported from the editor loads UNCHANGED in the *original* renderer.
 *
 * We inline the ORIGINAL parser from ohshtnvm/spiritual-coach-site verbatim and
 * assert that original.parse(seed) === original.parse(serialize(parse(seed))),
 * and that it survives an edit too.
 *
 * Run:  node test/compat.js
 */
const fs = require('fs');
const path = require('path');
global.window = global;
require(path.join(__dirname, '..', 'public', 'core.js'));
const Core = global.Core;
const seed = fs.readFileSync(path.join(__dirname, '..', 'public', 'coach-data.tsv'), 'utf8');

/* ---- ORIGINAL parser, copied verbatim from the source repo's index.html ---- */
function parseMultiSheetTSV(text) {
  const sheets = {};
  let cur = null, headers = null;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    if (raw.trim().startsWith('//')) continue;
    if (raw[0] === '#') { cur = raw.slice(1).trim(); sheets[cur] = []; headers = null; continue; }
    if (cur === null) continue;
    const cells = raw.split('\t');
    if (headers === null) { headers = cells.map(h => h.trim()); sheets[cur].__headers = headers; continue; }
    const row = {};
    headers.forEach((h, i) => { row[h] = (cells[i] != null ? cells[i] : '').replace(/\\n/g, '\n').trim(); });
    sheets[cur].push(row);
  }
  return sheets;
}
// Normalize the original parser's output (rows + headers) for comparison.
function norm(sheets) {
  const o = {};
  for (const k of Object.keys(sheets)) o[k] = { headers: sheets[k].__headers, rows: sheets[k].slice() };
  return JSON.stringify(o);
}

let failures = 0;
const check = (name, cond) => { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) failures++; };

console.log('Original-renderer compatibility test\n');

// 1. Editor export of the untouched seed loads identically in the ORIGINAL parser.
const exported = Core.serializeTSV(Core.parseTSV(seed));
check('original.parse(seed) === original.parse(editorExport(seed))',
  norm(parseMultiSheetTSV(seed)) === norm(parseMultiSheetTSV(exported)));

// 2. After an edit (headline + new service + toggle), the original parser still
//    reads every sheet, the edit, and the structure — no format breakage.
const st = Core.ensureSchema(Core.parseTSV(seed));
const hi = Core.kvIdx(st, 'hero', 'headline');
Core.setCell(st, 'hero', hi, 'value', 'A *brand new* headline');
Core.rowsOf(st, 'services').push({ name: 'Added Service', slug: 'added', description: 'x', icon: 'star', order: '4', cta_text: 'Go' });
const editedExport = Core.serializeTSV(st);
const orig = parseMultiSheetTSV(editedExport);

check('original parser sees all 12 sheets', Object.keys(orig).length >= 12);
check('original parser reads the edited headline',
  orig.hero.find(r => r.key === 'headline').value === 'A *brand new* headline');
check('original parser reads the added service (now 4 rows)', orig.services.length === 4);
check('original parser keeps | lists intact',
  orig.about.find(r => r.key === 'points').value.split('|').length >= 2);
check('original parser keeps single-line HTML cells intact',
  /^<p>/.test(orig.faq[0].answer) && orig.faq[0].answer.indexOf('\n') === -1);
check('original parser keeps image/_alt pairings',
  !!orig.hero.find(r => r.key === 'image').value && !!orig.hero.find(r => r.key === 'image_alt').value);

console.log('\n' + (failures ? '✗ ' + failures + ' check(s) failed' : '✓ all checks passed'));
process.exit(failures ? 1 : 0);
