/* One-off: append the keys that used to be HARDCODED in the renderer into
 * coach-data.tsv (Part 2 hardening). Existing lines are preserved byte-for-byte;
 * we only INSERT new "key<TAB>value" rows at the end of the relevant sheet,
 * just before the blank line that terminates it. Re-running is idempotent. */
const fs = require('fs');
const path = require('path');
const T = '\t';
const file = path.join(__dirname, '..', 'public', 'coach-data.tsv');

const additions = {
  config: [
    // moved verbatim from hardcoded <head>/JS:
    ['robots', 'index, follow'],
    ['og_type', 'website'],
    ['twitter_card', 'summary_large_image'],
    ['schema_type', 'Person'],
    ['aggregate_rating', '5'],
    // optional brand logo mark (inline <svg>, image/SVG URL, or data: URI):
    ['logo_svg', ''],
    // new optional SEO knobs (empty -> renderer falls back gracefully):
    ['favicon', ''],
    ['theme_color', ''],
    ['og_site_name', ''],
    ['og_image_alt', ''],
    ['twitter_site', ''],
    ['twitter_image', ''],
    ['schema_logo', ''],
    ['schema_telephone', ''],
    ['schema_address', ''],
  ],
  hero: [
    ['badge_icon', 'sparkles'], // was hardcoded `ti ti-sparkles` on the badge
  ],
  meta: [
    // UI labels moved out of the renderer:
    ['footer_explore_heading', 'Explore'],
    ['footer_contact_heading', 'Contact'],
    ['footer_getstarted_heading', 'Get started'],
    ['pricing_popular_label', 'Most popular'],
    ['blog_readmore_text', 'Read article'],
    ['blog_back_text', 'Back'],
    ['loading_text', 'Loading site…'],
  ],
};

const raw = fs.readFileSync(file, 'utf8');
const EOL = raw.includes('\r\n') ? '\r\n' : '\n';
let lines = raw.split(/\r?\n/);

function existingKeys(sheet) {
  const keys = new Set();
  let i = lines.indexOf('#' + sheet);
  if (i < 0) return keys;
  for (i = i + 2; i < lines.length; i++) {       // +2 skips marker + header row
    const ln = lines[i];
    if (ln === '' || ln[0] === '#') break;
    keys.add(ln.split(T)[0]);
  }
  return keys;
}

// Insert rows just before the terminating blank line of a sheet.
function insertInto(sheet, rows) {
  const have = existingKeys(sheet);
  const toAdd = rows.filter(([k]) => !have.has(k)).map(([k, v]) => k + T + v);
  if (!toAdd.length) return;
  const start = lines.indexOf('#' + sheet);
  if (start < 0) throw new Error('sheet not found: ' + sheet);
  let end = start + 1;
  while (end < lines.length && lines[end] !== '' && !(end > start + 1 && lines[end][0] === '#')) end++;
  // `end` now points at the blank line (or first line of next sheet / EOF)
  lines.splice(end, 0, ...toAdd);
}

for (const [sheet, rows] of Object.entries(additions)) insertInto(sheet, rows);

fs.writeFileSync(file, lines.join(EOL), 'utf8');
console.log('✓ TSV keys ensured');
