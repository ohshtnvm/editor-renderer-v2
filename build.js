#!/usr/bin/env node
/* build.js — regenerates the two DERIVED parts of index.html from the TSV:
 *   1. the static SEO <head> block (so link-preview / search crawlers that do
 *      NOT run JavaScript still see real title/description/OG/Twitter/JSON-LD);
 *   2. the embedded fallback TSV (so the site still renders offline / file://).
 *
 * Content lives ONLY in public/coach-data.tsv — this script never invents
 * content, it just mirrors the current TSV. Run it after editing the TSV:
 *   node build.js
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'public');
const TSV = path.join(DIR, 'coach-data.tsv');
const HTML = path.join(DIR, 'index.html');

if (!fs.existsSync(TSV)) {
  console.error('✗ public/coach-data.tsv not found — nothing to embed.');
  process.exit(1);
}

// Load the shared engine (classic script) to reuse its SEO generator.
global.window = global;
require(path.join(DIR, 'core.js'));
const Core = global.window.Core;

const tsvText = fs.readFileSync(TSV, 'utf8');
let html = fs.readFileSync(HTML, 'utf8');

// 1. Static SEO head block ---------------------------------------------------
const seoRe = /(<!-- SEO:start[\s\S]*?-->)([\s\S]*?)(<!-- SEO:end -->)/;
if (seoRe.test(html)) {
  const state = Core.parseTSV(tsvText);
  const seo = Core.seoTags(state).replace(/\$/g, '$$$$');
  html = html.replace(seoRe, (_, open, __, close) => open + '\n' + seo + '\n' + close);
  console.log('✓ Generated static SEO <head> from coach-data.tsv');
} else {
  console.warn('• No SEO markers found in index.html — skipping SEO injection');
}

// 2. Embedded fallback TSV ---------------------------------------------------
const re = /(<script id="fallback-tsv"[^>]*>)([\s\S]*?)(<\/script>)/;
if (!re.test(html)) {
  console.error('✗ Could not find the fallback-tsv block in index.html');
  process.exit(1);
}
const safe = tsvText.replace(/\$/g, '$$$$'); // `$` is special in replacements
html = html.replace(re, (_, open, __, close) => open + '\n' + safe + '\n' + close);

fs.writeFileSync(HTML, html, 'utf8');
console.log('✓ Synced embedded fallback TSV inside index.html');
