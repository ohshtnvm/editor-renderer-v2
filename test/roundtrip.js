#!/usr/bin/env node
/* test/roundtrip.js — TSV round-trip + compatibility self-test.
 *
 * Asserts the hard requirement from the brief:
 *   parseTSV(serializeTSV(parseTSV(original)))  deep-equals  parseTSV(original)
 * and that serializeTSV(parseTSV(original)) === original (modulo trailing ws),
 * which is what guarantees the editor's export still loads in the renderer.
 *
 * Run:  node test/roundtrip.js
 */
const fs = require('fs');
const path = require('path');

// Load core.js (a browser classic script) into Node by faking `window`.
global.window = global;
require(path.join(__dirname, '..', 'public', 'core.js'));
const Core = global.Core;

const TSV = fs.readFileSync(path.join(__dirname, '..', 'public', 'coach-data.tsv'), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); }
  else { console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); failures++; }
}

console.log('TSV round-trip self-test\n');

// 1. Identity round-trip (the contract)
const r = Core.selfTest(TSV);
check('parseTSV(serializeTSV(parseTSV(seed))) deep-equals parseTSV(seed)', r.ok);

// 2. serialize(parse(t)) equals t modulo trailing whitespace per line
const reser = Core.serializeTSV(Core.parseTSV(TSV));
const norm = (s) => s.replace(/[ \t]+$/gm, '').replace(/\r\n/g, '\n').replace(/\n+$/,'\n');
check('serializeTSV(parseTSV(seed)) === seed (modulo trailing whitespace)',
  norm(reser) === norm(TSV),
  firstDiff(norm(reser), norm(TSV)));

// 3. Sheets + markers preserved
const st = Core.parseTSV(TSV);
const expected = ['config','nav','meta','hero','about','services','testimonials','pricing','faq','blog','cta_final','footer'];
check('all #sheet markers present and in order', JSON.stringify(st.order) === JSON.stringify(expected),
  'got: ' + JSON.stringify(st.order));

// 4. | lists, single-line HTML cells, *_alt pairings survive
check('pipe list preserved (about.points splits into multiple items)',
  Core.list(Core.kvVal(st, 'about', 'points')).length >= 2);
check('single-line HTML cell preserved (about.story starts with <p>)',
  Core.kvVal(st, 'about', 'story').startsWith('<p>') && !Core.kvVal(st, 'about', 'story').includes('\n'));
check('image/_alt pairing intact (hero.image + hero.image_alt both set)',
  !!Core.kvVal(st, 'hero', 'image') && !!Core.kvVal(st, 'hero', 'image_alt'));

// 5. Idempotence: serialize twice is stable
check('serialize is idempotent', Core.serializeTSV(Core.parseTSV(reser)) === reser);

console.log('\n' + (failures ? '✗ ' + failures + ' check(s) failed' : '✓ all checks passed'));
process.exit(failures ? 1 : 0);

function firstDiff(a, b) {
  const la = a.split('\n'), lb = b.split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) return 'first diff at line ' + (i + 1) + ':\n      out: ' + JSON.stringify(la[i]) + '\n      exp: ' + JSON.stringify(lb[i]);
  }
  return '';
}
