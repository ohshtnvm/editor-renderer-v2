#!/usr/bin/env node
/* scripts/build-manifest.js — folder-driven content sections (v2).
 *
 * Cloudflare Pages can't list directories at runtime, so this build step scans
 * the content folders, validates each item's TSV, and writes ONE manifest the
 * renderer/editor consume:  public/content-manifest.json
 *
 * Convention (per item):
 *   public/{section}/{slug}/
 *     item.tsv         ← key<TAB>value rows (matches the repo's kv TSV style)
 *     cover.jpg        ← cover (else first image alphabetically; else item.tsv `cover`)
 *     photo-01.jpg …   ← gallery (auto-listed; or item.tsv `images` = a|b|c)
 *     guide.pdf        ← (downloads) the file referenced by item.tsv `file`
 *
 * Images may be LOCAL files in the folder (auto-detected) OR explicit URLs/paths
 * in item.tsv (`cover`, `images`). Markdown lives in *_md fields.
 *
 * Zero dependencies. Run:  node scripts/build-manifest.js   (or: npm run manifest)
 */
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const OUT = path.join(PUBLIC, 'content-manifest.json');

// section -> { folder, required fields, field coercions }
const SECTIONS = ['cases', 'downloads', 'shop'];
const REQUIRED = {
  shop: ['title', 'price', 'description_md'],
  cases: ['title', 'challenge_md', 'approach_md', 'results_md'],
  downloads: ['title', 'description_md', 'file'],
};

const IMG_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.svg'];
const TYPE_BY_EXT = {
  '.pdf': 'PDF', '.zip': 'ZIP', '.epub': 'EPUB', '.doc': 'DOC', '.docx': 'DOCX',
  '.xls': 'XLS', '.xlsx': 'XLSX', '.ppt': 'PPT', '.pptx': 'PPTX',
  '.mp3': 'MP3', '.mp4': 'MP4', '.png': 'PNG', '.jpg': 'JPG', '.csv': 'CSV', '.txt': 'TXT',
};

let warnings = 0;
const warn = (msg) => { warnings++; console.warn('  ⚠ ' + msg); };

/* ---- tiny TSV (key<TAB>value) parser, mirrors the repo's kv sheets ---- */
function parseItemTSV(text) {
  const o = {};
  for (const raw of String(text).split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trim().startsWith('//') || raw[0] === '#') continue;
    const tab = raw.indexOf('\t');
    if (tab === -1) continue;
    const key = raw.slice(0, tab).trim();
    const val = raw.slice(tab + 1).replace(/\\n/g, '\n');
    if (key) o[key] = val;
  }
  return o;
}

/* ---- coercion helpers ---- */
const bool = (v) => String(v).toLowerCase() === 'true';
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[^0-9.]/g, '')); return isNaN(n) ? null : n; };
const csv = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
const pipes = (v) => String(v || '').split('|').map((x) => x.trim()).filter(Boolean);
function metricsOf(v) { // "300%|Funding target;1M|First revenue" -> [{value,label}]
  return String(v || '').split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf('|'); return i === -1 ? { value: p, label: '' } : { value: p.slice(0, i).trim(), label: p.slice(i + 1).trim() };
  });
}
function humanSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + u[i];
}

// Resolve a cover/image reference (URL stays as-is; bare filename -> /section/slug/file)
function resolveRef(ref, base) {
  if (!ref) return '';
  return /^(https?:|data:|\/)/i.test(ref) ? ref : base + ref;
}

function imagesFor(item, dir, base) {
  let imgs = [];
  if (item.images) imgs = pipes(item.images).map((r) => resolveRef(r, base));
  else {
    try {
      imgs = fs.readdirSync(dir)
        .filter((f) => IMG_EXT.includes(path.extname(f).toLowerCase()))
        .sort()
        .map((f) => base + f);
    } catch (e) { /* no dir */ }
  }
  let cover = item.cover ? resolveRef(item.cover, base) : '';
  if (!cover) {
    const named = imgs.find((u) => /\/cover\.[a-z0-9]+$/i.test(u));
    cover = named || imgs[0] || '';
  }
  // ensure cover is first in the gallery, de-duped
  const gallery = [cover].concat(imgs.filter((u) => u !== cover)).filter(Boolean);
  return { cover: cover, images: gallery };
}

/* ---- per-section mappers (apply defaults + coercions; renderer stays dumb) ---- */
function mapShop(it, media) {
  return {
    slug: it.slug, title: it.title,
    price: num(it.price), currency: (it.currency || 'PHP').toUpperCase(),
    sale_price: it.sale_price ? num(it.sale_price) : null,
    description_md: it.description_md || '',
    category: it.category || '', tags: csv(it.tags), sku: it.sku || '',
    availability: it.availability || 'in_stock',
    cta_label: it.cta_label || 'Buy Now', cta_url: it.cta_url || '',
    featured: bool(it.featured), sort_order: num(it.sort_order) != null ? num(it.sort_order) : 9999,
    cover: media.cover, images: media.images,
  };
}
function mapCase(it, media) {
  return {
    slug: it.slug, title: it.title, client: it.client || '', industry: it.industry || '',
    services: csv(it.services), date: it.date || '', duration: it.duration || '',
    challenge_md: it.challenge_md || '', approach_md: it.approach_md || '', results_md: it.results_md || '',
    metrics: metricsOf(it.metrics), testimonial_md: it.testimonial_md || '', testimonial_author: it.testimonial_author || '',
    tags: csv(it.tags), external_url: it.external_url || '',
    featured: bool(it.featured), sort_order: num(it.sort_order) != null ? num(it.sort_order) : 9999,
    cover: media.cover, images: media.images,
  };
}
function mapDownload(it, media, dir, base) {
  // file: local filename (auto size/type) or URL
  let file = { url: '', type: it.file_type || '', size: it.file_size || '', bytes: null };
  if (it.file) {
    file.url = resolveRef(it.file, base);
    const ext = path.extname(it.file).toLowerCase();
    if (!file.type) file.type = TYPE_BY_EXT[ext] || (ext ? ext.slice(1).toUpperCase() : 'FILE');
    if (!/^(https?:)/i.test(it.file)) {
      try { const st = fs.statSync(path.join(dir, it.file)); file.bytes = st.size; if (!file.size) file.size = humanSize(st.size); }
      catch (e) { warn(base + 'item.tsv references missing file: ' + it.file); }
    }
  }
  return {
    slug: it.slug, title: it.title, description_md: it.description_md || '',
    file: file, gated: bool(it.gated), email_list_tag: it.email_list_tag || '',
    cta_label: it.cta_label || 'Download Free', category: it.category || '', tags: csv(it.tags),
    published_date: it.published_date || '', featured: bool(it.featured),
    sort_order: num(it.sort_order) != null ? num(it.sort_order) : 9999,
    cover: media.cover, images: media.images,
  };
}

function sortItems(a, b) {
  if (a.featured !== b.featured) return a.featured ? -1 : 1;
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
  return String(b.date || b.published_date || '').localeCompare(String(a.date || a.published_date || ''));
}

/* ---- scan one section folder ---- */
function buildSection(section) {
  const folder = path.join(PUBLIC, section);
  if (!fs.existsSync(folder)) return [];
  const slugs = fs.readdirSync(folder, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const items = [];
  for (const slug of slugs) {
    const dir = path.join(folder, slug);
    const tsvPath = path.join(dir, 'item.tsv');
    if (!fs.existsSync(tsvPath)) { warn(section + '/' + slug + ': no item.tsv — skipped'); continue; }
    const it = parseItemTSV(fs.readFileSync(tsvPath, 'utf8'));
    if (!it.slug) it.slug = slug;
    const missing = REQUIRED[section].filter((f) => !String(it[f] || '').trim());
    if (missing.length) { warn(section + '/' + slug + ': missing required [' + missing.join(', ') + '] — skipped'); continue; }
    const base = '/' + section + '/' + slug + '/';
    const media = imagesFor(it, dir, base);
    items.push(section === 'shop' ? mapShop(it, media) : section === 'cases' ? mapCase(it, media) : mapDownload(it, media, dir, base));
  }
  items.sort(sortItems);
  return items;
}

/* ---- run ---- */
console.log('Building content manifest…\n');
const manifest = { generated: new Date().toISOString() };
let total = 0;
for (const s of SECTIONS) {
  const items = buildSection(s);
  manifest[s] = items;
  total += items.length;
  console.log('  ' + (items.length ? '✓' : '·') + ' ' + s + ': ' + items.length + ' item' + (items.length === 1 ? '' : 's'));
}
fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log('\n' + (warnings ? '⚠ ' + warnings + ' warning(s). ' : '') + total + ' item(s) → public/content-manifest.json');
