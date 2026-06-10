/* =============================================================================
 * core.js — the shared TSV → DOM engine.
 *
 * ONE module, used by BOTH the live renderer (index.html, editable:false) and
 * the visual editor (editor.html, editable:true). Because both go through the
 * exact same render path, the editor's Preview is byte-for-byte what ships.
 *
 * Loaded as a CLASSIC script (not an ES module) so it also works from file://
 * (ES module imports are blocked under file:// by the browser). It exposes a
 * single global: window.Core.
 *
 * Public API:
 *   Core.parseTSV(text)            -> state
 *   Core.serializeTSV(state)       -> string   (exact inverse of parseTSV)
 *   Core.render(state, mount, opts)-> void     (opts.editable toggles edit mode)
 *   Core.applyHead(state)          -> void     (title/meta/OG/Twitter/JSON-LD)
 *   Core.ensureSchema(state)       -> state    (adds known optional keys; editor only)
 *   Core.selfTest(text)            -> {ok, ...}(round-trip assertion on a TSV)
 *   plus small utilities (esc, list, bool, money, kvObj, ...).
 *
 * STATE SHAPE (the single source of truth the editor mutates):
 *   {
 *     order:  ['config','nav','meta', ...],          // sheet order, preserved
 *     sheets: { config: { headers:['key','value'],
 *                         rows:[ {key:'coach_name', value:'Maya Patel'}, ... ] },
 *               services: { headers:[...], rows:[ {name:'...', ...}, ... ] },
 *               ... }
 *   }
 * Every sheet is modelled identically (headers + array-of-row-objects), whether
 * it is a key/value sheet or a table sheet. This keeps round-tripping trivial.
 * ========================================================================== */
(function (global) {
  'use strict';

  /* ===========================================================================
   * 1. TSV PARSE / SERIALIZE  (must be exact inverses)
   * ========================================================================= */

  // Parse multi-sheet TSV into the state object. PURE: no schema mutation, no
  // trimming of values (so it is losslessly reversible). Header cells are kept
  // verbatim too. Blank lines and `//` comment lines are structural and dropped.
  function parseTSV(text) {
    const state = { order: [], sheets: {} };
    let cur = null, headers = null;
    const lines = String(text).split(/\r?\n/);
    for (const raw of lines) {
      if (raw.trim() === '') continue;            // blank separator line
      if (raw.trim().startsWith('//')) continue;  // comment line
      if (raw[0] === '#') {                        // sheet marker
        cur = raw.slice(1).trim();
        if (!state.sheets[cur]) { state.sheets[cur] = { headers: [], rows: [] }; state.order.push(cur); }
        headers = null;
        continue;
      }
      if (cur === null) continue;                  // content before first #sheet
      const cells = raw.split('\t');
      if (headers === null) {                       // first row of a sheet = header
        headers = cells.slice();
        state.sheets[cur].headers = headers;
        continue;
      }
      const row = {};
      headers.forEach((h, i) => { row[h] = unescapeCell(cells[i] != null ? cells[i] : ''); });
      state.sheets[cur].rows.push(row);
    }
    return state;
  }

  // Serialize state back to TSV. Exact inverse of parseTSV: emits the #sheet
  // markers, the header row, then one tab-joined line per row (cells in header
  // order). Sheets are separated by a single blank line; file ends with one
  // newline. Real newlines inside a cell are encoded as the two chars "\n" so
  // every cell stays on ONE line (the single-line-HTML-cell contract).
  function serializeTSV(state) {
    const blocks = (state.order || Object.keys(state.sheets)).map((name) => {
      const sh = state.sheets[name];
      if (!sh) return '#' + name;
      const headerLine = sh.headers.join('\t');
      const rowLines = sh.rows.map((row) =>
        sh.headers.map((h) => escapeCell(row[h] != null ? row[h] : '')).join('\t')
      );
      return ['#' + name, headerLine].concat(rowLines).join('\n');
    });
    return blocks.join('\n\n') + '\n';
  }

  // Cell <-> line escaping: literal "\n" / "\t" in the file map to real
  // newline / tab in memory and back. (The seed uses neither inside cells, so
  // these are no-ops there — but they make the format robust for the editor.)
  function unescapeCell(s) { return String(s).replace(/\\n/g, '\n').replace(/\\t/g, '\t'); }
  function escapeCell(s)   { return String(s).replace(/\r?\n/g, '\\n').replace(/\t/g, '\\t'); }

  /* ===========================================================================
   * 2. STATE ACCESSORS
   * ========================================================================= */

  function getSheet(state, name) { return state.sheets[name] || { headers: [], rows: [] }; }
  function rowsOf(state, name) { return getSheet(state, name).rows; }

  // key/value sheet -> plain object (last write wins)
  function kvObj(state, name) {
    const o = {};
    rowsOf(state, name).forEach((r) => { const k = r.key != null ? r.key : r.Key; if (k != null && k !== '') o[k] = (r.value != null ? r.value : (r.Value != null ? r.Value : '')); });
    return o;
  }
  function kvVal(state, name, key) { const o = kvObj(state, name); return o[key] != null ? o[key] : ''; }
  function kvIdx(state, name, key) { return rowsOf(state, name).findIndex((r) => r.key === key); }

  // section-heading meta: rows whose key starts with `${prefix}_` -> {suffix:value}
  function metaGroup(state, prefix) {
    const o = {};
    rowsOf(state, 'meta').forEach((r) => {
      if ((r.key || '').indexOf(prefix + '_') === 0) o[r.key.slice(prefix.length + 1)] = r.value || '';
    });
    return o;
  }

  function getCell(state, sheet, rowIdx, key) {
    const sh = state.sheets[sheet]; if (!sh) return '';
    const row = sh.rows[rowIdx]; if (!row) return '';
    return row[key] != null ? row[key] : '';
  }
  function setCell(state, sheet, rowIdx, key, val) {
    const sh = state.sheets[sheet]; if (!sh) return;
    const row = sh.rows[rowIdx]; if (!row) return;
    row[key] = val;
  }

  /* ===========================================================================
   * 3. SMALL UTILITIES
   * ========================================================================= */

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const list = (s, sep) => String(s || '').split(sep || '|').map((x) => x.trim()).filter(Boolean);
  const bool = (s) => String(s).toLowerCase() === 'true';
  function money(n, cur) {
    const num = Number(String(n).replace(/[^0-9.]/g, ''));
    if (!num) return n || '';
    cur = String(cur || 'USD').toUpperCase().trim();
    // Use Intl so ANY valid ISO 4217 code works (EUR, GBP, JPY, INR, PHP, …),
    // not just a hand-maintained list. Whole-number display to match the design.
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(num);
    } catch (e) {
      const sym = { USD: '$', EUR: '€', GBP: '£', CAD: 'C$', AUD: 'A$' }[cur];
      return (sym || (cur + ' ')) + num.toLocaleString();
    }
  }
  function shade(hex, pct) {
    const n = parseInt(String(hex).replace('#', ''), 16);
    if (isNaN(n)) return hex;
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const f = (t) => Math.max(0, Math.min(255, Math.round(t + (t * pct / 100))));
    return '#' + [f(r), f(g), f(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  // Auto-size Unsplash URLs (pure logic; preserves any other host untouched).
  function uimg(url, w) {
    if (url && url.includes('images.unsplash.com') && !url.includes('&w=')) {
      return url + (url.includes('?') ? '&' : '?') + 'w=' + w + '&q=75&auto=format&fit=crop';
    }
    return url;
  }
  function fmtDate(d) { if (!d) return ''; const dt = new Date(d); return isNaN(dt) ? d : dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); }

  // Minimal, dependency-free Markdown -> HTML for the *_md content fields.
  // Supports: # headings, **bold**, *italic*/_italic_, `code`, [links](url),
  // - / * bullet lists, 1. ordered lists, > blockquotes, and paragraphs.
  function mdInline(s) {
    s = esc(s);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => '<a href="' + u + '" target="_blank" rel="noopener">' + t + '</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/_([^_\n]+)_/g, '<em>$1</em>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    return s;
  }
  function mdToHtml(md) {
    const blocks = String(md || '').replace(/\r\n/g, '\n').split(/\n{2,}/);
    let out = '';
    for (const raw of blocks) {
      const block = raw.trim();
      if (!block) continue;
      const lines = block.split('\n');
      const h = block.match(/^(#{1,6})\s+([\s\S]*)$/);
      if (h && lines.length === 1) { const lvl = Math.min(h[1].length + 1, 4); out += '<h' + lvl + '>' + mdInline(h[2]) + '</h' + lvl + '>'; continue; }
      if (lines.every((l) => /^>\s?/.test(l))) { out += '<blockquote>' + mdInline(lines.map((l) => l.replace(/^>\s?/, '')).join(' ')) + '</blockquote>'; continue; }
      if (lines.every((l) => /^[-*]\s+/.test(l))) { out += '<ul>' + lines.map((l) => '<li>' + mdInline(l.replace(/^[-*]\s+/, '')) + '</li>').join('') + '</ul>'; continue; }
      if (lines.every((l) => /^\d+\.\s+/.test(l))) { out += '<ol>' + lines.map((l) => '<li>' + mdInline(l.replace(/^\d+\.\s+/, '')) + '</li>').join('') + '</ol>'; continue; }
      out += '<p>' + mdInline(lines.join(' ')) + '</p>';
    }
    return out;
  }

  // Render an icon value. Supports: inline SVG (starts with "<svg"), an image
  // URL (http/https/data), or a Tabler webfont icon name (e.g. "sparkles").
  function iconMarkup(val, fallbackName, extraCls) {
    const v = String(val || '').trim();
    const cls = extraCls ? ' ' + extraCls : '';
    if (/^<svg[\s>]/i.test(v)) return '<span class="cms-svg' + cls + '">' + v + '</span>';
    if (/^(https?:|data:)/i.test(v)) return '<img class="cms-svg-img' + cls + '" src="' + esc(v) + '" alt="" aria-hidden="true">';
    const name = v || fallbackName || 'point';
    return '<i class="ti ti-' + esc(name) + cls + '"></i>';
  }

  /* ===========================================================================
   * 4. ALT-TEXT SUGGESTIONS  (so an image alt is never empty)
   * ========================================================================= */
  function suggestAlt(state, role, ctx) {
    const c = kvObj(state, 'config');
    const name = c.coach_name || 'the coach';
    ctx = ctx || {};
    switch (role) {
      case 'hero':        return 'Portrait of ' + name;
      case 'about':       return name + ' at work';
      case 'testimonial': return 'Photo of ' + (ctx.author || 'a happy client');
      case 'blog':        return (ctx.title ? ctx.title + ' — article image' : 'Article cover image');
      case 'og':          return name + ' — ' + (c.coach_title || 'coaching');
      default:            return name;
    }
  }

  /* ===========================================================================
   * 5. THEME + DOCUMENT ASSETS
   * ========================================================================= */
  function ensureAssets() {
    if (!document.getElementById('core-site-css')) {
      const st = document.createElement('style'); st.id = 'core-site-css'; st.textContent = SITE_CSS; document.head.appendChild(st);
    }
    if (!document.getElementById('core-edit-css')) {
      const st = document.createElement('style'); st.id = 'core-edit-css'; st.textContent = EDIT_CSS; document.head.appendChild(st);
    }
    if (!document.getElementById('core-tabler')) {
      addPreconnect('https://fonts.googleapis.com');
      addPreconnect('https://fonts.gstatic.com', true);
      addPreconnect('https://cdn.jsdelivr.net');
      const l = document.createElement('link'); l.id = 'core-tabler'; l.rel = 'stylesheet';
      l.href = 'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.31.0/dist/tabler-icons.min.css';
      document.head.appendChild(l);
    }
  }
  function addPreconnect(href, cross) {
    const l = document.createElement('link'); l.rel = 'preconnect'; l.href = href; if (cross) l.crossOrigin = 'anonymous'; document.head.appendChild(l);
  }
  function applyTheme(state) {
    const c = kvObj(state, 'config');
    const root = document.documentElement;
    const set = (k, v) => { if (v) root.style.setProperty(k, v); };
    set('--primary', c.primary_color); set('--secondary', c.secondary_color);
    set('--accent', c.accent_color); set('--text', c.text_dark); set('--bg-alt', c.bg_light);
    if (c.primary_color) set('--primary-dark', shade(c.primary_color, -18));
    if (c.font_heading || c.font_body) {
      const fams = Array.from(new Set([c.font_heading, c.font_body].filter(Boolean)))
        .map((fn) => fn.replace(/ /g, '+') + ':wght@400;500;600;700;800').join('&family=');
      let l = document.getElementById('core-fonts');
      if (!l) { l = document.createElement('link'); l.id = 'core-fonts'; l.rel = 'stylesheet'; document.head.appendChild(l); }
      l.href = 'https://fonts.googleapis.com/css2?family=' + fams + '&display=swap';
      if (c.font_heading) set('--font-head', "'" + c.font_heading + "',sans-serif");
      if (c.font_body) set('--font-body', "'" + c.font_body + "',sans-serif");
    }
  }

  /* ===========================================================================
   * 6. applyHead — title, meta, canonical, favicon, robots, OG, Twitter, JSON-LD
   * ========================================================================= */
  function setMeta(attr, key, val) {
    let el = document.querySelector('meta[' + attr + '="' + key + '"]');
    if (!val) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('meta'); el.setAttribute(attr, key); document.head.appendChild(el); }
    el.setAttribute('content', val);
  }
  function setLink(rel, href) {
    let el = document.querySelector('link[rel="' + rel + '"]');
    if (!href) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('link'); el.setAttribute('rel', rel); document.head.appendChild(el); }
    el.setAttribute('href', href);
  }
  // Pure: compute every SEO value (with fallbacks) from state. Shared by the
  // runtime applyHead AND the build-time seoTags, so they can never diverge.
  function seoValues(state) {
    const c = kvObj(state, 'config');
    const title = c.meta_title || c.coach_name || 'Coach';
    const metas = [
      ['name', 'description', c.meta_description],
      ['name', 'keywords', c.meta_keywords],
      ['name', 'robots', c.robots || 'index, follow'],
      ['name', 'theme-color', c.theme_color || c.primary_color],
      ['property', 'og:type', c.og_type || 'website'],
      ['property', 'og:title', c.og_title || c.meta_title || c.coach_name],
      ['property', 'og:description', c.og_description || c.meta_description],
      ['property', 'og:image', c.og_image],
      ['property', 'og:image:alt', c.og_image_alt || suggestAlt(state, 'og')],
      ['property', 'og:url', c.site_domain],
      ['property', 'og:site_name', c.og_site_name || c.coach_name],
      ['name', 'twitter:card', c.twitter_card || 'summary_large_image'],
      ['name', 'twitter:title', c.meta_title || c.coach_name],
      ['name', 'twitter:description', c.meta_description],
      ['name', 'twitter:image', c.twitter_image || c.og_image],
      ['name', 'twitter:site', c.twitter_site]
    ];
    return { c: c, title: title, metas: metas, canonical: c.site_domain || '/', favicon: c.favicon || '', jsonld: jsonLdString(state, c) };
  }

  // Runtime: write the SEO values into the live document <head>.
  function applyHead(state) {
    const v = seoValues(state);
    document.title = v.title;
    v.metas.forEach((m) => setMeta(m[0], m[1], m[2]));
    setLink('canonical', v.canonical);
    setLink('icon', v.favicon);
    buildJsonLd(state, v.c);
  }

  // Build-time: render a STATIC <head> SEO block as an HTML string. This is what
  // makes link previews / search crawlers (which don't run JS) see real tags.
  // build.js injects this into index.html between the SEO markers.
  function seoTags(state) {
    const v = seoValues(state);
    let out = '<title>' + esc(v.title) + '</title>\n';
    v.metas.forEach((m) => { if (m[2]) out += '<meta ' + m[0] + '="' + m[1] + '" content="' + esc(m[2]) + '">\n'; });
    out += '<link rel="canonical" href="' + esc(v.canonical) + '">\n';
    if (v.favicon) out += '<link rel="icon" href="' + esc(v.favicon) + '">\n';
    out += '<script id="jsonld" type="application/ld+json">' + v.jsonld.replace(/</g, '\\u003c') + '</' + 'script>';
    return out;
  }

  // Pure: the JSON-LD @graph as a string.
  function jsonLdString(state, c) {
    c = c || kvObj(state, 'config');
    const faq = rowsOf(state, 'faq'), services = rowsOf(state, 'services'), tst = rowsOf(state, 'testimonials');
    const sameAs = [c.linkedin, c.twitter, c.instagram, c.facebook].filter(Boolean);
    const personType = c.schema_type || 'Person';
    const graph = [
      { '@type': personType, 'name': c.coach_name, 'jobTitle': c.coach_title, 'description': c.meta_description,
        'image': c.og_image, 'url': c.site_domain, 'telephone': c.schema_telephone || c.phone, 'sameAs': sameAs },
      { '@type': 'Organization', 'name': c.coach_name, 'url': c.site_domain, 'logo': c.schema_logo || c.og_image,
        'email': c.email, 'telephone': c.schema_telephone || c.phone,
        'address': c.schema_address || undefined, 'sameAs': sameAs }
    ];
    services.forEach((s) => graph.push(Object.assign(
      { '@type': 'Service', 'name': s.name, 'description': s.description, 'provider': { '@type': personType, 'name': c.coach_name } },
      s.price ? { 'offers': { '@type': 'Offer', 'price': String(s.price).replace(/[^0-9.]/g, ''), 'priceCurrency': c.currency || 'USD' } } : {}
    )));
    if (faq.length) graph.push({ '@type': 'FAQPage', 'mainEntity': faq.map((f) => ({ '@type': 'Question', 'name': f.question, 'acceptedAnswer': { '@type': 'Answer', 'text': (f.answer || '').replace(/<[^>]+>/g, '') } })) });
    if (tst.length) {
      const avg = c.aggregate_rating || avgRating(tst);
      graph.push({ '@type': 'Product', 'name': (c.coach_name || 'Coaching') + ' Coaching',
        'aggregateRating': { '@type': 'AggregateRating', 'ratingValue': String(avg), 'reviewCount': String(tst.length) },
        'review': tst.map((t) => ({ '@type': 'Review', 'author': { '@type': 'Person', 'name': t.client_name }, 'reviewRating': { '@type': 'Rating', 'ratingValue': String(t.rating || 5) }, 'reviewBody': t.testimonial })) });
    }
    return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }, (k, val) => val === undefined ? undefined : val);
  }
  // Runtime: set the live #jsonld <script> from jsonLdString.
  function buildJsonLd(state, c) {
    let el = document.getElementById('jsonld');
    if (!el) { el = document.createElement('script'); el.id = 'jsonld'; el.type = 'application/ld+json'; document.head.appendChild(el); }
    el.textContent = jsonLdString(state, c);
  }
  function avgRating(tst) {
    const nums = tst.map((t) => Number(t.rating || 5)).filter((n) => !isNaN(n));
    if (!nums.length) return '5';
    return (Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10).toString();
  }

  /* ===========================================================================
   * 7. FIELD HELPERS  (one code path for preview + edit)
   *    In preview they emit plain content; in edit they emit editable controls
   *    in the SAME DOM positions.
   * ========================================================================= */
  function makeFields(state, editable) {
    const E = editable;
    const ref = (sheet, row, key) => sheet + '|' + row + '|' + key;

    return {
      E: E,
      val: (sheet, row, key) => getCell(state, sheet, row, key),

      // Plain text bound to a cell, wrapped in `tag`.
      text(sheet, row, key, o) {
        o = o || {};
        const v = getCell(state, sheet, row, key);
        const cls = o.cls ? ' class="' + o.cls + '"' : '';
        if (E) {
          return '<' + (o.tag || 'span') + cls + ' data-cms-text="' + esc(ref(sheet, row, key)) +
            '" contenteditable="plaintext-only"' + (o.ph ? ' data-cms-ph="' + esc(o.ph) + '"' : '') + '>' + esc(v) + '</' + (o.tag || 'span') + '>';
        }
        if (!o.tag) return esc(v);
        return '<' + o.tag + cls + '>' + esc(v) + '</' + o.tag + '>';
      },

      // Heading with `*highlight*` markers. Preview swaps to <span class=hl>;
      // edit shows the raw source (with asterisks) so it round-trips exactly.
      headline(sheet, row, key, o) {
        o = o || {};
        const v = getCell(state, sheet, row, key);
        if (E) return '<' + (o.tag || 'h1') + ' data-cms-text="' + esc(ref(sheet, row, key)) + '" contenteditable="plaintext-only">' + esc(v) + '</' + (o.tag || 'h1') + '>';
        const hl = esc(v).replace(/\*(.+?)\*/g, '<span class="hl">$1</span>');
        return '<' + (o.tag || 'h1') + '>' + hl + '</' + (o.tag || 'h1') + '>';
      },

      // Inline HTML cell. Preview injects the HTML; edit shows it + a pencil
      // that opens the HTML cell editor (kept single-line on save).
      html(sheet, row, key, o) {
        o = o || {};
        const v = getCell(state, sheet, row, key);
        const cls = 'cms-html' + (o.cls ? ' ' + o.cls : '');
        if (E) {
          return '<div class="' + cls + ' cms-editable-html" data-cms-html="' + esc(ref(sheet, row, key)) + '">' +
            '<button type="button" class="cms-edit-btn cms-html-btn" title="Edit HTML"><i class="ti ti-code"></i></button>' +
            '<div class="cms-html-body">' + v + '</div></div>';
        }
        return '<div class="' + cls + '">' + v + '</div>';
      },

      // Image url + alt, given as independent refs (url and alt may live in
      // different rows — e.g. kv sheets store image/image_alt separately).
      // Preview = <img>; edit adds an overlay edit button.
      img(us, ur, uk, as, ar, ak, o) {
        o = o || {};
        const url = getCell(state, us, ur, uk);
        // o.altText overrides the alt attribute (used where a sheet has no
        // dedicated alt cell, e.g. testimonials borrow a generated alt).
        const alt = o.altText != null ? o.altText : getCell(state, as, ar, ak);
        const w = o.w || 900;
        const attrs = (o.attrs || '');
        const imgTag = '<img src="' + esc(uimg(url, w)) + '" alt="' + esc(alt) + '"' + attrs + '>';
        if (E) {
          return '<div class="cms-img-wrap" data-cms-img="' + esc(us + '|' + ur + '|' + uk) + '" data-cms-alt="' + esc(as + '|' + ar + '|' + ak) + '" data-cms-role="' + esc(o.role || '') + '" data-cms-altreal="' + (o.altReal ? '1' : '') + '">' +
            imgTag + '<button type="button" class="cms-edit-btn cms-img-btn" title="Edit image"><i class="ti ti-photo-edit"></i></button></div>';
        }
        return imgTag;
      },

      // Icon / SVG cell. Preview renders the icon; edit makes it clickable.
      icon(sheet, row, key, o) {
        o = o || {};
        const v = getCell(state, sheet, row, key);
        const inner = iconMarkup(v, o.fallback, o.cls);
        if (E) {
          return '<span class="cms-icon-wrap" data-cms-icon="' + esc(ref(sheet, row, key)) + '" title="Edit icon" role="button" tabindex="0">' + inner + '<i class="ti ti-pencil cms-icon-pencil"></i></span>';
        }
        return inner;
      },

      // List cell ("a|b|c"). `renderItem(text, i)` builds each preview <li>/node.
      list(sheet, row, key, renderItem, o) {
        o = o || {};
        const sep = o.sep || '|';
        const items = list(getCell(state, sheet, row, key), sep);
        if (!E) return items.map((it, i) => renderItem(esc(it), i, it)).join('');
        const lis = items.map((it, i) =>
          '<li class="cms-li" data-cms-li="' + i + '"><span class="cms-li-text" contenteditable="plaintext-only">' + esc(it) + '</span>' +
          '<button type="button" class="cms-li-del" title="Remove"><i class="ti ti-x"></i></button></li>').join('');
        return '<ul class="cms-list-edit" data-cms-list="' + esc(ref(sheet, row, key)) + '" data-cms-sep="' + esc(sep) + '">' + lis +
          '<li class="cms-li-add"><button type="button" class="cms-li-addbtn" title="Add item"><i class="ti ti-plus"></i> Add</button></li></ul>';
      },

      // Small attribute chip (anchors, slugs, order, dates, ratings…). Edit only.
      chip(sheet, row, key, label) {
        if (!E) return '';
        const v = getCell(state, sheet, row, key);
        return '<label class="cms-chip"><span class="cms-chip-k">' + esc(label || key) + '</span>' +
          '<span class="cms-chip-v" contenteditable="plaintext-only" data-cms-text="' + esc(ref(sheet, row, key)) + '">' + esc(v) + '</span></label>';
      },

      // Boolean toggle (is_popular, featured, show_*). Edit only.
      toggle(sheet, row, key, label) {
        if (!E) return '';
        const on = bool(getCell(state, sheet, row, key));
        return '<button type="button" class="cms-toggle' + (on ? ' on' : '') + '" data-cms-toggle="' + esc(ref(sheet, row, key)) + '">' +
          '<i class="ti ti-' + (on ? 'check' : 'square') + '"></i> ' + esc(label || key) + '</button>';
      }
    };
  }

  // Wrap a chips row (edit only).
  function chipsRow(html) { return html ? '<div class="cms-chips">' + html + '</div>' : ''; }

  /* ===========================================================================
   * 8. SECTION BUILDERS
   * ========================================================================= */
  // The little brand mark next to the name. Uses config.logo_svg if set
  // (inline <svg>, an image/SVG URL, or a data: URI); otherwise the CSS dot.
  // In edit mode it's clickable -> opens the icon modal bound to config.logo_svg.
  function logoMark(state, f) {
    let idx = kvIdx(state, 'config', 'logo_svg');
    if (idx < 0 && f.E) { getSheet(state, 'config').rows.push({ key: 'logo_svg', value: '' }); idx = kvIdx(state, 'config', 'logo_svg'); }
    const svg = idx >= 0 ? (getSheet(state, 'config').rows[idx].value || '') : '';
    const inner = svg ? '<span class="logo-mark">' + iconMarkup(svg) + '</span>' : '<span class="dot"></span>';
    if (f.E && idx >= 0) {
      return '<span class="cms-icon-wrap cms-logo-edit" data-cms-icon="config|' + idx + '|value" title="Edit logo image" role="button" tabindex="0">' + inner + '<i class="ti ti-pencil cms-icon-pencil"></i></span>';
    }
    return inner;
  }

  function header(state, f) {
    const c = kvObj(state, 'config');
    const logoIdx = kvIdx(state, 'config', 'logo_text') >= 0 ? kvIdx(state, 'config', 'logo_text') : kvIdx(state, 'config', 'coach_name');
    const ctaIdx = kvIdx(state, 'config', 'cta_primary_text');
    const navRows = rowsOf(state, 'nav');
    // Nav links stay plain; editing happens in a modal (keeps the bar uncluttered).
    const navHtml = navRows.map((r) => '<a href="' + esc(r.anchor) + '">' + esc(r.label) + '</a>').join('');
    // Auto nav links for folder-driven sections that have items (hidden when empty).
    const contentNav = CONTENT_DEFS.filter((d) => hasContent(state, d.key))
      .map((d) => '<a href="#' + d.key + '">' + esc(metaGroup(state, d.key).nav || d.label) + '</a>').join('');
    const navEdit = f.E ? '<button type="button" class="cms-nav-editbtn" data-cms-editnav title="Edit navigation"><i class="ti ti-pencil"></i> Nav</button>' : '';
    return '<header><div class="container nav">' +
      '<a href="#top" class="logo">' + logoMark(state, f) + f.text('config', logoIdx, 'value', { tag: 'span' }) + '</a>' +
      '<nav class="nav-links">' + navHtml + contentNav + navEdit + '</nav>' +
      '<div class="nav-cta">' +
      '<button class="btn btn-primary" data-book><i class="ti ti-calendar"></i>' + f.text('config', ctaIdx, 'value', { tag: 'span' }) + '</button>' +
      '<button class="burger" aria-label="Menu"><i class="ti ti-menu-2"></i></button>' +
      '</div></div></header>';
  }

  function heroSection(state, f) {
    const i = sheetIndexer(state, 'hero');
    const stats = [['stat1_value', 'stat1_label'], ['stat2_value', 'stat2_label'], ['stat3_value', 'stat3_label']]
      .filter(([v]) => i.has(v))
      .map(([v, l]) => '<div class="stat">' + f.text('hero', i.row, v, { tag: 'div', cls: 'v' }) + f.text('hero', i.row, l, { tag: 'div', cls: 'l' }) + '</div>').join('');
    const hasFloat = i.has('float_value');
    const hasBadge = i.has('badge'), hasSecondary = i.has('cta_secondary_text');
    return section('hero', 'hero', 'top', '<div class="container hero-grid">' +
      '<div class="hero-text reveal">' +
      ((hasBadge || f.E) ? '<div class="hero-badge">' + f.icon('hero', i.row, 'badge_icon', { fallback: 'sparkles' }) + f.text('hero', i.row, 'badge') + '</div>' : '') +
      f.headline('hero', i.row, 'headline', { tag: 'h1' }) +
      f.text('hero', i.row, 'subheadline', { tag: 'p', cls: 'hero-sub' }) +
      '<div class="hero-actions">' +
      '<button class="btn btn-primary" data-book><i class="ti ti-calendar"></i>' + f.text('hero', i.row, 'cta_text', { tag: 'span' }) + '</button>' +
      ((hasSecondary || f.E) ? '<a class="btn btn-ghost" href="' + esc(f.val('hero', i.row, 'cta_secondary_url') || '#services') + '">' + f.text('hero', i.row, 'cta_secondary_text', { tag: 'span' }) + '</a>' +
        (f.E ? f.chip('hero', i.row, 'cta_secondary_url', 'secondary link') : '') : '') +
      '</div>' +
      (stats ? '<div class="hero-stats">' + stats + '</div>' : '') +
      '</div>' +
      '<div class="hero-media reveal">' +
      f.img('hero', i.row, 'image', 'image_alt', { w: 900, role: 'hero', attrs: ' width="900" height="1125" fetchpriority="high"' }) +
      (hasFloat ? '<div class="hero-float"><div class="ic">' + f.icon('hero', i.row, 'float_icon', { fallback: 'trophy' }) + '</div>' +
        '<div>' + f.text('hero', i.row, 'float_value', { tag: 'div', cls: 't1' }) + f.text('hero', i.row, 'float_label', { tag: 'div', cls: 't2' }) + '</div></div>' : '') +
      '</div></div>', state, f);
  }

  function aboutSection(state, f) {
    const i = sheetIndexer(state, 'about');
    const pts = f.list('about', i.row, 'points', (item) => '<li><i class="ti ti-circle-check-filled"></i><span>' + item + '</span></li>');
    return section('about', 'about', 'about', '<div class="container about-grid">' +
      '<div class="about-media reveal">' + f.img('about', i.row, 'image', 'image_alt', { w: 800, role: 'about', attrs: ' loading="lazy" width="800" height="800"' }) + '</div>' +
      '<div class="reveal">' +
      f.text('about', i.row, 'eyebrow', { tag: 'span', cls: 'eyebrow' }) +
      f.text('about', i.row, 'heading', { tag: 'h2' }) +
      f.text('about', i.row, 'intro', { tag: 'p', cls: 'intro' }) +
      f.html('about', i.row, 'story', { cls: 'story' }) +
      (f.E ? '<ul class="about-points cms-list-host">' + pts + '</ul>' : (pts ? '<ul class="about-points">' + pts + '</ul>' : '')) +
      f.text('about', i.row, 'signature', { tag: 'div', cls: 'sig' }) +
      '</div></div>', state, f);
  }

  function cardSection(opts) {
    // generic builder for services/testimonials/pricing/faq/blog
    const { state, f, sheet, sectionCls, sectionId, metaPrefix, defaultHeading, wrapCls, sort, card } = opts;
    const rows = rowsOf(state, sheet);
    if (!f.E && !rows.length) return '';
    const meta = metaGroup(state, metaPrefix);
    let idxs = rows.map((_, i) => i);
    if (sort) idxs = idxs.slice().sort((a, b) => (+rows[a].order || 0) - (+rows[b].order || 0));
    const cards = idxs.map((i) => {
      const inner = card(rows[i], i);
      if (!f.E) return inner;
      return '<div class="cms-card-wrap">' + inner +
        '<button type="button" class="cms-card-del cms-card-del-abs" data-cms-delcard="' + sheet + '|' + i + '" title="Delete"><i class="ti ti-x"></i></button></div>';
    }).join('');
    const addBtn = f.E ? '<button type="button" class="cms-card-add cms-card-add-block" data-cms-addcard="' + sheet + '"><i class="ti ti-plus"></i> Add ' + esc(sheet.replace(/s$/, '')) + '</button>' : '';
    return section(sectionCls, sectionCls, sectionId,
      '<div class="container">' + sectionHead(state, f, metaPrefix, defaultHeading) +
      '<div class="' + wrapCls + '">' + cards + '</div>' + addBtn + '</div>', state, f);
  }

  function servicesSection(state, f) {
    const c = kvObj(state, 'config');
    return cardSection({
      state, f, sheet: 'services', sectionCls: 'services', sectionId: 'services', metaPrefix: 'services',
      defaultHeading: 'Services', wrapCls: 'cards', sort: true,
      card: (s, i) => {
        const feats = f.list('services', i, 'deliverables', (d) => '<li><i class="ti ti-check"></i><span>' + d + '</span></li>');
        const price = f.val('services', i, 'price');
        return '<div class="s-card reveal">' +
          '<div class="s-icon">' + f.icon('services', i, 'icon', { fallback: 'target-arrow' }) + '</div>' +
          f.text('services', i, 'target_audience', { tag: 'div', cls: 's-aud' }) +
          f.text('services', i, 'name', { tag: 'h3' }) +
          f.text('services', i, 'description', { tag: 'p', cls: 's-desc' }) +
          '<div class="s-meta">' +
          ((s.duration || f.E) ? '<span><i class="ti ti-clock"></i>' + f.text('services', i, 'duration', { tag: 'span' }) + '</span>' : '') +
          ((s.frequency || f.E) ? '<span><i class="ti ti-calendar-repeat"></i>' + f.text('services', i, 'frequency', { tag: 'span' }) + '</span>' : '') +
          '</div>' +
          '<ul class="feat cms-list-host">' + feats + '</ul>' +
          '<div class="s-foot">' +
          (price || f.E ? '<div class="s-price">' + (price ? money(price, c.currency) : (f.E ? '<span class="cms-muted">no price</span>' : '')) + ' <small>' + f.text('services', i, 'pricing_model', { tag: 'span' }) + '</small></div>' : '') +
          (price ? '<button class="btn btn-primary" data-book>' + f.text('services', i, 'cta_text', { tag: 'span' }) + '</button>'
            : '<a class="btn btn-primary" href="#pricing">' + f.text('services', i, 'cta_text', { tag: 'span' }) + '</a>') +
          '</div>' +
          chipsRow(f.E ? f.chip('services', i, 'price', 'price') + f.chip('services', i, 'slug', 'slug') + f.chip('services', i, 'order', 'order') : '') +
          '</div>';
      }
    });
  }

  function testimonialsSection(state, f) {
    return cardSection({
      state, f, sheet: 'testimonials', sectionCls: 'testimonials', sectionId: 'testimonials', metaPrefix: 'testimonials',
      defaultHeading: 'What clients say', wrapCls: 't-cards', sort: false,
      card: (t, i) => {
        const rating = Math.max(0, Math.min(5, +(t.rating || 5)));
        const stars = f.E
          ? '<div class="stars cms-stars">' + [1, 2, 3, 4, 5].map((n) =>
              '<span class="cms-star' + (n <= rating ? ' on' : '') + '" data-cms-star="' + n + '" data-cms-starref="testimonials|' + i + '|rating" title="' + n + ' star' + (n > 1 ? 's' : '') + '">' + (n <= rating ? '★' : '☆') + '</span>').join('') + '</div>'
          : '<div class="stars">' + '★'.repeat(rating) + '☆'.repeat(5 - rating) + '</div>';
        const photo = t.photo
          ? f.img('testimonials', i, 'photo', 'client_name', { w: 96, role: 'testimonial', altReal: false, altText: suggestAlt(state, 'testimonial', { author: t.client_name }), attrs: ' loading="lazy" width="48" height="48"' })
          : '<div class="ph">' + esc((t.client_name || '?').charAt(0)) + '</div>';
        return '<div class="t-card reveal">' +
          stars +
          f.text('testimonials', i, 'testimonial', { tag: 'p', cls: 't-quote' }) +
          ((t.result_value || f.E) ? '<div class="t-result"><span class="rv">' + f.text('testimonials', i, 'result_value', { tag: 'span' }) + '</span><span class="rl">' + f.text('testimonials', i, 'result_metric', { tag: 'span' }) + '</span></div>' : '') +
          '<div class="t-author">' + photo + '<div>' +
          f.text('testimonials', i, 'client_name', { tag: 'div', cls: 'n' }) +
          '<div class="r">' + f.text('testimonials', i, 'role', { tag: 'span' }) + (t.company || f.E ? ', ' + f.text('testimonials', i, 'company', { tag: 'span' }) : '') + '</div>' +
          '</div></div>' +
          chipsRow(f.E ? f.chip('testimonials', i, 'industry', 'industry') : '') +
          '</div>';
      }
    });
  }

  function pricingSection(state, f) {
    const c = kvObj(state, 'config');
    return cardSection({
      state, f, sheet: 'pricing', sectionCls: 'pricing', sectionId: 'pricing', metaPrefix: 'pricing',
      defaultHeading: 'Pricing', wrapCls: 'p-cards', sort: true,
      card: (p, i) => {
        const inc = f.list('pricing', i, 'features', (x) => '<li class="yes"><i class="ti ti-check"></i><span>' + x + '</span></li>');
        const exc = f.list('pricing', i, 'excluded', (x) => '<li class="no"><i class="ti ti-x"></i><span>' + x + '</span></li>');
        const per = p.billing && p.billing !== 'one-time' ? '/' + esc(p.billing) : '';
        const popular = bool(p.is_popular);
        const popLabel = metaGroup(state, 'pricing').popular_label || 'Most popular';
        return '<div class="p-card reveal ' + (popular ? 'popular' : '') + '">' +
          (popular ? '<div class="p-tag">' + esc(popLabel) + '</div>' : '') +
          f.text('pricing', i, 'tier_name', { tag: 'div', cls: 'p-name' }) +
          f.text('pricing', i, 'target_audience', { tag: 'div', cls: 'p-aud' }) +
          '<div class="p-price"><span class="amt">' + money(p.price, p.currency || c.currency) + '</span><span class="per">' + per + '</span></div>' +
          f.text('pricing', i, 'duration', { tag: 'div', cls: 'p-dur' }) +
          '<ul class="p-feat cms-list-host">' + inc + exc + '</ul>' +
          '<button class="btn ' + (popular ? 'btn-primary' : 'btn-ghost') + '" data-book>' + f.text('pricing', i, 'cta_text', { tag: 'span' }) + '</button>' +
          chipsRow(f.E ? f.toggle('pricing', i, 'is_popular', 'popular') + f.chip('pricing', i, 'price', 'price') + f.chip('pricing', i, 'currency', 'cur') + f.chip('pricing', i, 'billing', 'billing') + f.chip('pricing', i, 'slug', 'slug') + f.chip('pricing', i, 'order', 'order') : '') +
          '</div>';
      }
    });
  }

  function faqSection(state, f) {
    return cardSection({
      state, f, sheet: 'faq', sectionCls: 'faq', sectionId: 'faq', metaPrefix: 'faq',
      defaultHeading: 'Frequently asked questions', wrapCls: 'faq-wrap', sort: true,
      card: (q, i) => '<div class="faq-item' + (f.E ? ' open' : '') + '"><button class="faq-q">' + f.text('faq', i, 'question', { tag: 'span' }) + '<i class="ti ti-plus"></i></button>' +
        '<div class="faq-a"><div class="faq-a-inner">' + f.html('faq', i, 'answer') + chipsRow(f.E ? f.chip('faq', i, 'category', 'category') + f.chip('faq', i, 'order', 'order') : '') + '</div></div></div>'
    });
  }

  function blogSection(state, f) {
    const meta = metaGroup(state, 'blog');
    const readMore = meta.readmore_text || 'Read article';
    return cardSection({
      state, f, sheet: 'blog', sectionCls: 'blog', sectionId: 'blog', metaPrefix: 'blog',
      defaultHeading: 'Latest insights', wrapCls: 'b-cards', sort: false,
      card: (b, i) => '<article class="b-card reveal" data-post="' + i + '">' +
        f.img('blog', i, 'image', 'image_alt', { w: 700, role: 'blog', attrs: ' loading="lazy" width="700" height="394"' }) +
        '<div class="b-body">' +
        f.text('blog', i, 'category', { tag: 'div', cls: 'b-cat' }) +
        f.text('blog', i, 'title', { tag: 'h3' }) +
        f.text('blog', i, 'meta_description', { tag: 'p', cls: 'b-ex' }) +
        '<div class="b-meta"><span><i class="ti ti-calendar"></i> ' + esc(fmtDate(b.publish_date)) + '</span>' +
        (b.reading_time || f.E ? '<span><i class="ti ti-clock"></i> ' + f.text('blog', i, 'reading_time', { tag: 'span' }) + ' min</span>' : '') + '</div>' +
        (f.E ? '<button type="button" class="cms-edit-article" data-cms-html="blog|' + i + '|content"><i class="ti ti-code"></i> Edit article HTML</button>'
          : '<span class="b-more">' + esc(readMore) + ' <i class="ti ti-arrow-right"></i></span>') +
        chipsRow(f.E ? f.chip('blog', i, 'publish_date', 'date') + f.chip('blog', i, 'slug', 'slug') + f.chip('blog', i, 'tags', 'tags') + f.chip('blog', i, 'author', 'author') + f.toggle('blog', i, 'featured', 'featured') : '') +
        '</div></article>'
    });
  }

  function ctaSection(state, f) {
    const i = sheetIndexer(state, 'cta_final');
    if (!f.E && !i.has('heading')) return '';
    return '<section class="cta-final"><div class="container reveal">' +
      f.text('cta_final', i.row, 'heading', { tag: 'h2' }) +
      f.text('cta_final', i.row, 'subheadline', { tag: 'p' }) +
      '<button class="btn btn-light" data-book><i class="ti ti-calendar"></i> ' + f.text('cta_final', i.row, 'cta_text', { tag: 'span' }) + '</button>' +
      '</div></section>';
  }

  function footer(state, f) {
    const c = kvObj(state, 'config');
    const m = metaGroup(state, 'footer');
    const fi = sheetIndexer(state, 'footer');
    const navRows = rowsOf(state, 'nav');
    const links = navRows.map((r) => '<a href="' + esc(r.anchor) + '">' + esc(r.label) + '</a>').join('');
    const socials = [['linkedin', 'brand-linkedin'], ['twitter', 'brand-x'], ['instagram', 'brand-instagram'], ['facebook', 'brand-facebook']];
    let soc;
    if (f.E) {
      // Edit mode: preview the icons that have a URL, plus a single button that
      // opens the "manage social links" modal (add / remove handled there).
      const prev = socials.filter(([key]) => c[key]).map(([key, icon]) => '<span class="f-social-prev" title="' + key + '"><i class="ti ti-' + icon + '"></i></span>').join('');
      soc = '<div class="f-social">' + prev +
        '<button type="button" class="cms-soc-editbtn" data-cms-editsocials title="Add / remove social links"><i class="ti ti-pencil"></i></button></div>';
    } else {
      const links2 = socials.map(([key, icon]) => {
        const url = c[key]; if (!url) return '';
        return '<a href="' + esc(url) + '" target="_blank" rel="noopener" aria-label="' + key + '"><i class="ti ti-' + icon + '"></i></a>';
      }).join('');
      soc = links2 ? '<div class="f-social">' + links2 + '</div>' : '';
    }
    const logoIdx = kvIdx(state, 'config', 'logo_text') >= 0 ? kvIdx(state, 'config', 'logo_text') : kvIdx(state, 'config', 'coach_name');
    const contact = [];
    const emailIdx = kvIdx(state, 'config', 'email'), phoneIdx = kvIdx(state, 'config', 'phone'), locIdx = kvIdx(state, 'config', 'location');
    if (c.email || f.E) contact.push(f.E ? f.text('config', emailIdx, 'value', { tag: 'div' }) : '<a href="mailto:' + esc(c.email) + '">' + esc(c.email) + '</a>');
    if (c.phone || f.E) contact.push(f.E ? f.text('config', phoneIdx, 'value', { tag: 'div' }) : '<a href="tel:' + esc(c.phone) + '">' + esc(c.phone) + '</a>');
    if (c.location || f.E) contact.push(f.E ? f.text('config', locIdx, 'value', { tag: 'div' }) : '<p>' + esc(c.location) + '</p>');
    const ctaIdx = kvIdx(state, 'config', 'cta_primary_text');
    return '<footer><div class="container">' +
      '<div class="f-grid">' +
      '<div class="f-brand"><div class="logo">' + logoMark(state, f) + f.text('config', logoIdx, 'value', { tag: 'span' }) + '</div>' +
      f.text('footer', fi.row, 'about_text', { tag: 'p' }) +
      soc + '</div>' +
      '<div class="f-col"><h4>' + (f.E ? metaText(state, f, 'footer_explore_heading', 'Explore') : esc(m.explore_heading || 'Explore')) + '</h4>' + links + '</div>' +
      '<div class="f-col"><h4>' + (f.E ? metaText(state, f, 'footer_contact_heading', 'Contact') : esc(m.contact_heading || 'Contact')) + '</h4>' + contact.join('') + '</div>' +
      '<div class="f-col"><h4>' + (f.E ? metaText(state, f, 'footer_getstarted_heading', 'Get started') : esc(m.getstarted_heading || 'Get started')) + '</h4>' +
      f.text('footer', fi.row, 'cta_text', { tag: 'p' }) +
      '<button class="btn btn-primary" data-book style="margin-top:6px">' + f.text('config', ctaIdx, 'value', { tag: 'span' }) + '</button></div>' +
      '</div>' +
      '<div class="f-bottom">© ' + new Date().getFullYear() + ' ' + esc(c.coach_name || '') + '. ' + f.text('footer', fi.row, 'copyright', { tag: 'span' }) + '</div>' +
      '</div></footer>';
  }

  // helper: editable meta key (footer headings, etc.); creates row if absent
  function metaText(state, f, key, fallback) {
    let idx = kvIdx(state, 'meta', key);
    if (idx < 0) { getSheet(state, 'meta').rows.push({ key: key, value: fallback }); idx = kvIdx(state, 'meta', key); }
    return f.text('meta', idx, 'value', { tag: 'span' });
  }

  /* ---- section scaffolding ---- */
  function sectionHead(state, f, prefix, defHeading) {
    const eyebrowKey = prefix + '_eyebrow', headingKey = prefix + '_heading', introKey = prefix + '_intro';
    const ei = ensureMetaIdx(state, eyebrowKey), hi = ensureMetaIdx(state, headingKey, defHeading), ii = ensureMetaIdx(state, introKey);
    const toggleKey = 'show_' + prefix;
    const tIdx = kvIdx(state, 'config', toggleKey);
    const tog = (f.E && tIdx >= 0) ? f.toggle('config', tIdx, toggleKey, 'show section') : '';
    return '<div class="section-head reveal">' +
      f.text('meta', ei, 'value', { tag: 'span', cls: 'eyebrow' }) +
      f.text('meta', hi, 'value', { tag: 'h2' }) +
      f.text('meta', ii, 'value', { tag: 'p' }) +
      (tog ? '<div class="cms-section-toggle">' + tog + '</div>' : '') +
      '</div>';
  }
  function ensureMetaIdx(state, key, fallback) {
    let idx = kvIdx(state, 'meta', key);
    if (idx < 0) { getSheet(state, 'meta').rows.push({ key: key, value: fallback || '' }); idx = kvIdx(state, 'meta', key); }
    return idx;
  }

  // wraps a section, applying a "hidden on live" badge in edit mode
  function section(cls, baseCls, id, inner, state, f) {
    const hidden = f.E && !flagOn(state, 'show_' + baseCls);
    return '<section class="' + cls + (hidden ? ' cms-hidden-live' : '') + '" id="' + id + '">' +
      (hidden ? '<div class="cms-hidden-badge"><i class="ti ti-eye-off"></i> Hidden on live site</div>' : '') +
      inner + '</section>';
  }

  function flagOn(state, key) { const v = kvVal(state, 'config', key); return (v === '' || v === undefined) ? true : bool(v); }

  // returns {row:0, has(key)} for single-row (kv-style) sheets rendered as one object
  function sheetIndexer(state, name) {
    const kv = kvObj(state, name);
    // ensure a synthetic flat row exists mapping keys -> the kv rows.
    // For kv sheets each key is its own row; we expose row index via kvIdx at call sites.
    // To let f.text(sheet, row, key) work on kv sheets, we treat (row=index-of-key, key='value').
    return {
      has: (k) => kv[k] !== undefined && kv[k] !== '',
      // NOTE: hero/about/etc are kv sheets, so f.text needs (rowIdxOfKey,'value').
      row: 0
    };
  }

  /* ===========================================================================
   * 9. RENDER
   * ========================================================================= */
  function render(state, mount, opts) {
    opts = opts || {};
    const editable = !!opts.editable;
    ensureAssets();
    applyTheme(state);

    // For kv-style sheets, field helpers need (rowIndexOfKey, 'value'). We wrap
    // f.text so that callers can pass a *key* for kv sheets and we resolve it.
    const baseF = makeFields(state, editable);
    const f = wrapKvFields(state, baseF);

    const showLive = (base) => flagOn(state, 'show_' + base);
    const html =
      header(state, f) +
      '<main class="cms-main" aria-live="polite">' +
      heroSection(state, f) +
      aboutSection(state, f) +
      servicesSection(state, f) +
      ((editable || showLive('testimonials')) ? testimonialsSection(state, f) : '') +
      ((editable || showLive('pricing')) ? pricingSection(state, f) : '') +
      ((editable || showLive('faq')) ? faqSection(state, f) : '') +
      ((editable || showLive('blog')) ? blogSection(state, f) : '') +
      contentSections(state, editable) +
      ctaSection(state, f) +
      '</main>' +
      footer(state, f);

    mount.__ctx = { state: state, opts: opts };
    mount.innerHTML = html;
    mount.classList.toggle('cms-editable', editable);

    ensureGlobalChrome();
    wireInteractions(state, mount, editable);
    if (editable) wireEditing(state, mount, opts);
    observeReveal(mount);
  }

  // kv sheets (config, meta, hero, about, cta_final, footer) store one key per
  // row. Section builders call f.text('hero', i.row, 'headline') with i.row=0 —
  // but the real row is the index of the {key:'headline'} row, value column.
  // This wrapper rewrites kv-sheet field calls to (rowIdxOfKey, 'value').
  const KV_SHEETS = { config: 1, meta: 1, hero: 1, about: 1, cta_final: 1, footer: 1 };
  function wrapKvFields(state, f) {
    const remap = (sheet, row, key) => {
      if (KV_SHEETS[sheet] && key !== 'value') {
        let idx = kvIdx(state, sheet, key);
        if (idx < 0) { getSheet(state, sheet).rows.push({ key: key, value: '' }); idx = kvIdx(state, sheet, key); }
        return [sheet, idx, 'value'];
      }
      return [sheet, row, key];
    };
    return {
      E: f.E,
      val: (s, r, k) => { const a = remap(s, r, k); return f.val(a[0], a[1], a[2]); },
      text: (s, r, k, o) => { const a = remap(s, r, k); return f.text(a[0], a[1], a[2], o); },
      headline: (s, r, k, o) => { const a = remap(s, r, k); return f.headline(a[0], a[1], a[2], o); },
      html: (s, r, k, o) => { const a = remap(s, r, k); return f.html(a[0], a[1], a[2], o); },
      img: (s, r, uk, ak, o) => {
        const a = remap(s, r, uk); const b = remap(s, r, ak);
        const oo = Object.assign({}, o);
        // alt is a real, editable alt cell when the ORIGINAL key looks like one
        if (oo.altReal === undefined) oo.altReal = /(_alt)$/.test(ak);
        return f.img(a[0], a[1], a[2], b[0], b[1], b[2], oo);
      },
      icon: (s, r, k, o) => { const a = remap(s, r, k); return f.icon(a[0], a[1], a[2], o); },
      list: (s, r, k, ri, o) => { const a = remap(s, r, k); return f.list(a[0], a[1], a[2], ri, o); },
      chip: (s, r, k, l) => { const a = remap(s, r, k); return f.chip(a[0], a[1], a[2], l); },
      toggle: (s, r, k, l) => { const a = remap(s, r, k); return f.toggle(a[0], a[1], a[2], l); }
    };
  }

  /* ===========================================================================
   * 10. GLOBAL CHROME (book modal + blog post overlay) — created once in <body>
   * ========================================================================= */
  function ensureGlobalChrome() {
    if (!document.getElementById('book-modal')) {
      const m = document.createElement('div'); m.className = 'modal'; m.id = 'book-modal'; m.setAttribute('aria-hidden', 'true');
      m.innerHTML = '<div class="modal-box"><button class="modal-close" data-close-book aria-label="Close"><i class="ti ti-x"></i></button><iframe id="cal-frame" title="Booking calendar" loading="lazy"></iframe></div>';
      document.body.appendChild(m);
      m.addEventListener('click', (e) => { if (e.target.id === 'book-modal') closeBook(); });
      m.querySelector('[data-close-book]').addEventListener('click', closeBook);
    }
    if (!document.getElementById('post-overlay')) {
      const ov = document.createElement('div'); ov.className = 'post-overlay'; ov.id = 'post-overlay';
      ov.innerHTML = '<button class="post-back" id="post-back"><i class="ti ti-arrow-left"></i> Back</button><div id="post-content"></div>';
      document.body.appendChild(ov);
      ov.querySelector('#post-back').addEventListener('click', closePost);
    }
    if (!window.__coreKeydown) {
      window.__coreKeydown = true;
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeBook(); const ov = document.getElementById('post-overlay'); if (ov && ov.classList.contains('open')) closePost(); } });
    }
  }
  let CURRENT_CAL = '';
  function openBook() {
    const m = document.getElementById('book-modal'), fr = document.getElementById('cal-frame');
    if (CURRENT_CAL && !fr.src) fr.src = CURRENT_CAL.startsWith('http') ? CURRENT_CAL : 'https://cal.com/' + CURRENT_CAL + '?embed=true&theme=light';
    m.classList.add('open'); m.setAttribute('aria-hidden', 'false'); document.body.style.overflow = 'hidden';
  }
  function closeBook() { const m = document.getElementById('book-modal'); if (!m) return; m.classList.remove('open'); m.setAttribute('aria-hidden', 'true'); document.body.style.overflow = ''; }
  function closePost() { const ov = document.getElementById('post-overlay'); if (!ov) return; ov.classList.remove('open'); document.body.style.overflow = ''; }

  /* ===========================================================================
   * 11. LIVE INTERACTIONS
   * ========================================================================= */
  function wireInteractions(state, mount, editable) {
    const c = kvObj(state, 'config');
    CURRENT_CAL = c.calcom_link || '';
    if (editable) {
      // In edit mode, suppress navigation-y behaviors so editing is unobstructed
      // (otherwise clicking the logo / nav anchors jumps the page and blurs the
      // contenteditable before you can type).
      mount.querySelectorAll('[data-book]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); }));
      mount.querySelectorAll('a[href^="#"]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); }));
      return;
    }
    mount.querySelectorAll('[data-book]').forEach((b) => b.addEventListener('click', openBook));
    mount.querySelectorAll('.faq-q').forEach((q) => q.addEventListener('click', () => q.closest('.faq-item').classList.toggle('open')));
    const blog = rowsOf(state, 'blog');
    mount.querySelectorAll('[data-post]').forEach((cd) => cd.addEventListener('click', () => openPost(state, blog, +cd.dataset.post)));
    // folder-driven content cards -> detail overlay
    mount.querySelectorAll('[data-content]').forEach((cd) => cd.addEventListener('click', () => {
      const p = cd.getAttribute('data-content').split('|'); openContentDetail(state, p[0], p[1]);
    }));
    const burger = mount.querySelector('.burger'), navLinks = mount.querySelector('.nav-links');
    if (burger && navLinks) {
      burger.addEventListener('click', () => navLinks.classList.toggle('open'));
      navLinks.addEventListener('click', (e) => { if (e.target.tagName === 'A') navLinks.classList.remove('open'); });
    }
  }
  function openPost(state, blog, i) {
    const b = blog[i]; if (!b) return;
    const c = kvObj(state, 'config');
    document.getElementById('post-content').innerHTML =
      '<div class="post-hero"><img src="' + esc(uimg(b.image, 1400)) + '" alt="' + esc(b.image_alt) + '"><div class="scrim"></div>' +
      '<div class="post-head"><div class="container"><div class="b-cat">' + esc(b.category) + '</div><h1>' + esc(b.title) + '</h1>' +
      '<div class="pm"><span><i class="ti ti-user"></i> ' + esc(b.author || c.coach_name) + '</span><span><i class="ti ti-calendar"></i> ' + esc(fmtDate(b.publish_date)) + '</span>' +
      (b.reading_time ? '<span><i class="ti ti-clock"></i> ' + esc(b.reading_time) + ' min read</span>' : '') + '</div></div></div></div>' +
      '<article class="post-body">' + (b.content || '') +
      '<p style="margin-top:40px"><button class="btn btn-primary" data-book><i class="ti ti-calendar"></i> ' + esc(c.cta_primary_text || 'Book a call') + '</button></p></article>';
    const ov = document.getElementById('post-overlay');
    ov.classList.add('open'); document.body.style.overflow = 'hidden'; ov.scrollTop = 0;
    ov.querySelector('[data-book]').addEventListener('click', openBook);
  }

  /* ===========================================================================
   * 11b. FOLDER-DRIVEN CONTENT SECTIONS — cases / shop / downloads
   *      Data comes from state.content (the build-manifest.json), not the TSV.
   *      Renders only when a section has >=1 item (empty sections hide entirely).
   * ========================================================================= */
  const CONTENT_DEFS = [
    { key: 'cases', label: 'Case Studies', heading: 'Case studies' },
    { key: 'shop', label: 'Shop', heading: 'Shop' },
    { key: 'downloads', label: 'Free Downloads', heading: 'Free downloads' }
  ];
  function contentItems(state, key) { return (state.content && Array.isArray(state.content[key])) ? state.content[key] : []; }
  function hasContent(state, key) { return contentItems(state, key).length > 0; }
  function contentSections(state, editable) { return CONTENT_DEFS.map((d) => contentSection(state, d, editable)).join(''); }

  function contentSection(state, def, editable) {
    const items = contentItems(state, def.key);
    if (!items.length) return '';
    const meta = metaGroup(state, def.key);
    const head = '<div class="section-head reveal">' +
      (meta.eyebrow ? '<span class="eyebrow">' + esc(meta.eyebrow) + '</span>' : '') +
      '<h2>' + esc(meta.heading || def.heading) + '</h2>' +
      (meta.intro ? '<p>' + esc(meta.intro) + '</p>' : '') + '</div>';
    const cards = items.map((it) => contentCard(def.key, it, editable)).join('');
    return '<section class="content-sec content-' + def.key + '" id="' + def.key + '"><div class="container">' +
      head + '<div class="c-grid">' + cards + '</div></div></section>';
  }
  function badgeOf(it) {
    if (it.availability === 'sold_out') return '<span class="c-badge sold">Sold out</span>';
    if (it.availability === 'preorder') return '<span class="c-badge pre">Pre-order</span>';
    return '';
  }
  function priceHTML(it) {
    if (it.sale_price) return '<span class="c-price"><span class="old">' + money(it.price, it.currency) + '</span> <span class="now">' + money(it.sale_price, it.currency) + '</span></span>';
    return '<span class="c-price"><span class="now">' + money(it.price, it.currency) + '</span></span>';
  }
  function coverImg(it, w, alt) {
    const src = it.cover ? uimg(it.cover, w) : '';
    return src ? '<img src="' + esc(src) + '" alt="' + esc(alt || it.title) + '" loading="lazy">' : '<div class="c-nocover"><i class="ti ti-photo"></i></div>';
  }
  function contentCard(key, it, editable) {
    const attr = ' data-content="' + esc(key + '|' + it.slug) + '"' + (editable ? ' data-content-edit="1"' : '');
    const feat = it.featured ? ' is-featured' : '';
    const edithint = editable ? '<span class="c-edit"><i class="ti ti-pencil"></i> Edit</span>' : '';
    if (key === 'shop') {
      return '<article class="c-card' + feat + '"' + attr + '><div class="c-cover">' + coverImg(it, 700) + badgeOf(it) + '</div>' +
        '<div class="c-body">' + (it.category ? '<div class="c-eyebrow">' + esc(it.category) + '</div>' : '') +
        '<h3>' + esc(it.title) + '</h3>' + priceHTML(it) + '</div>' + edithint + '</article>';
    }
    if (key === 'cases') {
      const m = it.metrics && it.metrics[0];
      return '<article class="c-card' + feat + '"' + attr + '><div class="c-cover">' + coverImg(it, 700) + '</div>' +
        '<div class="c-body">' + (it.industry ? '<div class="c-eyebrow">' + esc(it.industry) + '</div>' : '') +
        '<h3>' + esc(it.title) + '</h3>' + (it.client ? '<div class="c-sub">' + esc(it.client) + '</div>' : '') +
        (m ? '<div class="c-topmetric"><span class="v">' + esc(m.value) + '</span> <span class="l">' + esc(m.label) + '</span></div>' : '') +
        '</div>' + edithint + '</article>';
    }
    const fileMeta = it.file ? [it.file.type, it.file.size].filter(Boolean).join(' · ') : '';
    return '<article class="c-card' + feat + '"' + attr + '><div class="c-cover">' + coverImg(it, 700) + '</div>' +
      '<div class="c-body">' + (it.category ? '<div class="c-eyebrow">' + esc(it.category) + '</div>' : '') +
      '<h3>' + esc(it.title) + '</h3>' +
      (fileMeta ? '<div class="c-file"><i class="ti ti-file-download"></i> ' + esc(fileMeta) + (it.gated ? ' · <i class="ti ti-lock"></i> email' : '') + '</div>' : '') +
      '</div>' + edithint + '</article>';
  }

  /* ---- detail overlay (reuses the blog post overlay) ---- */
  function findContent(state, key, slug) { return contentItems(state, key).find((x) => x.slug === slug); }
  function galleryHTML(it) {
    const imgs = (it.images && it.images.length ? it.images : (it.cover ? [it.cover] : []));
    if (!imgs.length) return '';
    const main = '<img id="cd-main" class="cd-main" src="' + esc(uimg(imgs[0], 1200)) + '" alt="' + esc(it.title) + '">';
    const thumbs = imgs.length > 1 ? '<div class="cd-thumbs">' + imgs.map((u, i) =>
      '<img class="cd-thumb' + (i === 0 ? ' on' : '') + '" data-full="' + esc(uimg(u, 1200)) + '" src="' + esc(uimg(u, 200)) + '" alt="">').join('') + '</div>' : '';
    return '<div class="cd-gallery">' + main + thumbs + '</div>';
  }
  function metaRowHTML(pairs) {
    const cells = pairs.filter((p) => p[1]).map((p) => '<div><span class="k">' + esc(p[0]) + '</span><span class="v">' + esc(p[1]) + '</span></div>').join('');
    return cells ? '<div class="cd-meta">' + cells + '</div>' : '';
  }
  function tagPills(tags) { return (tags && tags.length) ? '<div class="cd-tags">' + tags.map((t) => '<span>' + esc(t) + '</span>').join('') + '</div>' : ''; }
  function shopDetail(it) {
    const soldOut = it.availability === 'sold_out';
    const cta = '<a class="btn btn-primary cd-cta' + (soldOut ? ' disabled' : '') + '"' +
      (soldOut || !it.cta_url ? '' : ' href="' + esc(it.cta_url) + '" target="_blank" rel="noopener"') + '>' +
      (soldOut ? 'Sold out' : esc(it.cta_label || 'Buy Now')) + '</a>';
    return '<div class="cd-headline"><h1>' + esc(it.title) + '</h1><div class="cd-priceline">' + priceHTML(it) + ' ' + badgeOf(it) + '</div></div>' +
      '<div class="post-body">' + mdToHtml(it.description_md) + '</div>' +
      metaRowHTML([['SKU', it.sku], ['Category', it.category], ['Availability', (it.availability || '').replace(/_/g, ' ')]]) +
      tagPills(it.tags) + '<div class="cd-actions">' + cta + '</div>';
  }
  function caseDetail(it) {
    const stats = (it.metrics && it.metrics.length) ? '<div class="cd-metrics">' + it.metrics.map((m) =>
      '<div class="cd-metric"><div class="v">' + esc(m.value) + '</div><div class="l">' + esc(m.label) + '</div></div>').join('') + '</div>' : '';
    const block = (title, md) => md ? '<h2>' + title + '</h2>' + mdToHtml(md) : '';
    const quote = it.testimonial_md ? '<div class="cd-quote">' + mdToHtml(it.testimonial_md) +
      (it.testimonial_author ? '<div class="cd-quote-by">— ' + esc(it.testimonial_author) + '</div>' : '') + '</div>' : '';
    const live = it.external_url ? '<div class="cd-actions"><a class="btn btn-ghost" href="' + esc(it.external_url) + '" target="_blank" rel="noopener">View live project <i class="ti ti-external-link"></i></a></div>' : '';
    return '<div class="cd-headline"><h1>' + esc(it.title) + '</h1></div>' +
      metaRowHTML([['Client', it.client], ['Industry', it.industry], ['Services', (it.services || []).join(', ')], ['Timeline', it.duration], ['Date', fmtDate(it.date)]]) +
      stats + '<div class="post-body">' + block('The challenge', it.challenge_md) + block('The approach', it.approach_md) + block('The results', it.results_md) + '</div>' +
      quote + tagPills(it.tags) + live;
  }
  function downloadDetail(it) {
    const fileMeta = it.file ? [it.file.type, it.file.size].filter(Boolean).join(' · ') : '';
    let action;
    if (it.gated) {
      action = '<form class="cd-gate" data-gate="' + esc(it.email_list_tag || '') + '" data-file="' + esc(it.file ? it.file.url : '') + '">' +
        '<label class="cd-gate-label">Enter your email and we’ll send it over</label>' +
        '<div class="cd-gate-row"><input type="email" required placeholder="you@example.com"><button class="btn btn-primary" type="submit">' + esc(it.cta_label || 'Download Free') + '</button></div>' +
        '<div class="cd-gate-done" hidden></div></form>';
    } else {
      action = '<div class="cd-actions"><a class="btn btn-primary" href="' + esc(it.file ? it.file.url : '#') + '" download target="_blank" rel="noopener"><i class="ti ti-download"></i> ' + esc(it.cta_label || 'Download Free') + '</a></div>';
    }
    return '<div class="cd-headline"><h1>' + esc(it.title) + '</h1>' + (fileMeta ? '<div class="cd-filemeta"><i class="ti ti-file-text"></i> ' + esc(fileMeta) + '</div>' : '') + '</div>' +
      '<div class="post-body">' + mdToHtml(it.description_md) + '</div>' + tagPills(it.tags) + action;
  }
  function openContentDetail(state, key, slug) {
    const it = findContent(state, key, slug); if (!it) return;
    const inner = key === 'shop' ? shopDetail(it) : key === 'cases' ? caseDetail(it) : downloadDetail(it);
    document.getElementById('post-content').innerHTML =
      '<div class="cd-wrap"><div class="container cd-container">' + galleryHTML(it) + '<div class="cd-content">' + inner + '</div></div></div>';
    const ov = document.getElementById('post-overlay');
    ov.classList.add('open'); document.body.style.overflow = 'hidden'; ov.scrollTop = 0;
    if (history && history.replaceState) history.replaceState(null, '', '#' + key + '/' + (slug || ''));
    const main = document.getElementById('cd-main');
    ov.querySelectorAll('.cd-thumb').forEach((t) => t.addEventListener('click', () => {
      if (main) main.src = t.getAttribute('data-full');
      ov.querySelectorAll('.cd-thumb').forEach((x) => x.classList.remove('on')); t.classList.add('on');
    }));
    const form = ov.querySelector('[data-gate]');
    if (form) form.addEventListener('submit', (e) => {
      e.preventDefault();
      const email = (form.querySelector('input[type=email]').value || '').trim(); if (!email) return;
      const tag = form.getAttribute('data-gate'), file = form.getAttribute('data-file');
      // TODO: wire to your email provider. POST { email, tag } to a Pages Function
      // (e.g. functions/subscribe.js) — never put an API key in client code.
      console.log('[lead-capture stub] subscribe', { email: email, tag: tag });
      form.querySelector('.cd-gate-label').setAttribute('hidden', '');
      form.querySelector('.cd-gate-row').setAttribute('hidden', '');
      const done = form.querySelector('.cd-gate-done');
      done.removeAttribute('hidden');
      done.innerHTML = 'Thanks! Your download is ready. <a class="btn btn-primary" href="' + esc(file) + '" download target="_blank" rel="noopener"><i class="ti ti-download"></i> Download now</a>';
    });
  }

  function observeReveal(mount) {
    if (!('IntersectionObserver' in window)) { mount.querySelectorAll('.reveal').forEach((el) => el.classList.add('in')); return; }
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: .12 });
    mount.querySelectorAll('.reveal').forEach((el) => io.observe(el));
  }

  /* ===========================================================================
   * 12. EDIT WIRING  (state-as-source-of-truth; never scrape the DOM)
   * ========================================================================= */
  function parseRef(s) { const p = s.split('|'); return { sheet: p[0], row: +p[1], key: p[2] }; }

  function wireEditing(state, mount, opts) {
    const onChange = () => { if (opts.onChange) opts.onChange(state); };
    const rerender = () => render(state, mount, opts);

    // inline text + chips
    mount.querySelectorAll('[data-cms-text]').forEach((el) => {
      const startVal = el.textContent;
      el.addEventListener('input', () => {
        const r = parseRef(el.getAttribute('data-cms-text'));
        setCell(state, r.sheet, r.row, r.key, el.textContent.replace(/\r?\n/g, ' '));
        onChange();
      });
      // prevent Enter from inserting newlines in plaintext fields
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
      // Chips drive a SEPARATE computed display (price symbol, formatted amount,
      // card order, formatted date), so re-render when the value changes to keep
      // that display in sync. Inline body text shows what you type, so it doesn't.
      if (el.classList.contains('cms-chip-v')) {
        el.addEventListener('blur', () => { if (el.textContent !== startVal) { rerender(); } });
      }
    });

    // editable lists
    mount.querySelectorAll('[data-cms-list]').forEach((ul) => {
      const r = parseRef(ul.getAttribute('data-cms-list'));
      const sep = ul.getAttribute('data-cms-sep') || '|';
      const recompute = () => {
        const items = Array.prototype.map.call(ul.querySelectorAll('.cms-li-text'), (s) => s.textContent.trim()).filter((x) => x !== '');
        setCell(state, r.sheet, r.row, r.key, items.join(sep)); onChange();
      };
      ul.querySelectorAll('.cms-li-text').forEach((s) => {
        s.addEventListener('input', recompute);
        s.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); s.blur(); } });
      });
      ul.querySelectorAll('.cms-li-del').forEach((btn) => btn.addEventListener('click', () => {
        const items = list(getCell(state, r.sheet, r.row, r.key), sep);
        const li = btn.closest('.cms-li'); const idx = +li.getAttribute('data-cms-li');
        items.splice(idx, 1); setCell(state, r.sheet, r.row, r.key, items.join(sep)); onChange(); rerender();
      }));
      const addBtn = ul.querySelector('.cms-li-addbtn');
      if (addBtn) addBtn.addEventListener('click', () => {
        const items = list(getCell(state, r.sheet, r.row, r.key), sep);
        items.push('New item'); setCell(state, r.sheet, r.row, r.key, items.join(sep)); onChange(); rerender();
      });
    });

    // toggles (booleans)
    mount.querySelectorAll('[data-cms-toggle]').forEach((btn) => btn.addEventListener('click', () => {
      const r = parseRef(btn.getAttribute('data-cms-toggle'));
      const cur = bool(getCell(state, r.sheet, r.row, r.key));
      setCell(state, r.sheet, r.row, r.key, cur ? 'false' : 'true'); onChange(); rerender();
      if (r.sheet === 'config') applyHead(state);
    }));

    // HTML cell editors (pencil + "edit article")
    mount.querySelectorAll('[data-cms-html]').forEach((el) => {
      const trigger = el.matches('button') ? el : el.querySelector('.cms-html-btn');
      if (!trigger) return;
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const r = parseRef(el.getAttribute('data-cms-html'));
        if (opts.onEditHtml) opts.onEditHtml(r, () => { rerender(); onChange(); });
      });
    });

    // image editors
    mount.querySelectorAll('[data-cms-img]').forEach((wrap) => {
      const btn = wrap.querySelector('.cms-img-btn');
      if (!btn) return;
      btn.addEventListener('click', () => {
        const urlRef = parseRef(wrap.getAttribute('data-cms-img'));
        const altRef = parseRef(wrap.getAttribute('data-cms-alt'));
        const role = wrap.getAttribute('data-cms-role') || '';
        const altReal = wrap.getAttribute('data-cms-altreal') === '1';
        if (opts.onEditImage) opts.onEditImage({ urlRef, altRef, role, altReal }, () => { rerender(); onChange(); });
      });
    });

    // icon editors
    mount.querySelectorAll('[data-cms-icon]').forEach((wrap) => {
      const open = () => {
        const r = parseRef(wrap.getAttribute('data-cms-icon'));
        if (opts.onEditIcon) opts.onEditIcon(r, () => { rerender(); onChange(); });
      };
      wrap.addEventListener('click', open);
      wrap.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });

    // card delete
    mount.querySelectorAll('[data-cms-delcard]').forEach((btn) => btn.addEventListener('click', () => {
      const p = btn.getAttribute('data-cms-delcard').split('|'); const sheet = p[0], idx = +p[1];
      const rows = rowsOf(state, sheet);
      if (rows[idx] == null) return;
      if (!window.confirm('Delete this ' + sheet.replace(/s$/, '') + '?')) return;
      rows.splice(idx, 1); onChange(); rerender();
    }));

    // card add
    mount.querySelectorAll('[data-cms-addcard]').forEach((btn) => btn.addEventListener('click', () => {
      const sheet = btn.getAttribute('data-cms-addcard');
      addBlankCard(state, sheet); onChange(); rerender();
    }));

    // clickable star rating
    mount.querySelectorAll('[data-cms-star]').forEach((st) => st.addEventListener('click', () => {
      const r = parseRef(st.getAttribute('data-cms-starref'));
      setCell(state, r.sheet, r.row, r.key, st.getAttribute('data-cms-star')); onChange(); rerender();
    }));

    // nav editor (modal)
    const navBtn = mount.querySelector('[data-cms-editnav]');
    if (navBtn) navBtn.addEventListener('click', () => { if (opts.onEditNav) opts.onEditNav(() => { rerender(); onChange(); }); });

    // social links editor (modal)
    const socBtn = mount.querySelector('[data-cms-editsocials]');
    if (socBtn) socBtn.addEventListener('click', () => { if (opts.onEditSocials) opts.onEditSocials(() => { rerender(); onChange(); }); });

    // folder-driven content cards -> editor's content form (browser can't write
    // files, so the editor produces item.tsv for download — see editor.html).
    mount.querySelectorAll('[data-content-edit]').forEach((cd) => cd.addEventListener('click', () => {
      const p = cd.getAttribute('data-content').split('|');
      if (opts.onEditContent) opts.onEditContent(p[0], p[1]);
    }));
  }

  // Append a blank card to a table sheet, using the sheet's column schema.
  function addBlankCard(state, sheet) {
    const sh = getSheet(state, sheet);
    const row = {};
    sh.headers.forEach((h) => { row[h] = ''; });
    // sensible defaults so a fresh card is visible/usable
    const defaults = {
      nav: { label: 'New link', anchor: '#about' },
      services: { name: 'New service', description: 'Describe this service.', icon: 'sparkles', cta_text: 'Learn more', order: String(sh.rows.length + 1) },
      testimonials: { client_name: 'New client', testimonial: 'Their words here.', rating: '5' },
      pricing: { tier_name: 'New tier', price: '0', currency: 'USD', billing: 'monthly', is_popular: 'false', cta_text: 'Get started', order: String(sh.rows.length + 1) },
      faq: { question: 'New question?', answer: '<p>Answer here.</p>', order: String(sh.rows.length + 1) },
      blog: { title: 'New post', meta_description: 'Short summary.', content: '<p>Write your article.</p>', publish_date: new Date().toISOString().slice(0, 10), author: kvVal(state, 'config', 'coach_name'), featured: 'false', reading_time: '5' }
    };
    Object.assign(row, defaults[sheet] || {});
    // alt prefill for image-bearing sheets
    if (sh.headers.indexOf('image_alt') >= 0) row.image_alt = suggestAlt(state, sheet === 'blog' ? 'blog' : 'about', { title: row.title });
    sh.rows.push(row);
  }

  /* ===========================================================================
   * 13. SCHEMA HELPERS for the editor (optional keys + self-test)
   * ========================================================================= */
  // Known optional keys the renderer/applyHead can use. ensureSchema adds any
  // that are missing (empty) so the editor can always bind them. NOT called by
  // parseTSV — the round-trip self-test stays pure.
  const OPTIONAL_CONFIG = ['logo_svg', 'favicon', 'robots', 'theme_color', 'og_type', 'og_title', 'og_description', 'og_site_name', 'og_image_alt',
    'twitter_card', 'twitter_site', 'twitter_image', 'schema_type', 'schema_logo', 'schema_telephone', 'schema_address', 'aggregate_rating'];
  const OPTIONAL_META = ['footer_explore_heading', 'footer_contact_heading', 'footer_getstarted_heading',
    'pricing_popular_label', 'blog_readmore_text', 'blog_back_text', 'loading_text'];
  function ensureSchema(state) {
    const ensure = (sheet, keys) => {
      if (!state.sheets[sheet]) { state.sheets[sheet] = { headers: ['key', 'value'], rows: [] }; if (state.order.indexOf(sheet) < 0) state.order.push(sheet); }
      keys.forEach((k) => { if (kvIdx(state, sheet, k) < 0) state.sheets[sheet].rows.push({ key: k, value: '' }); });
    };
    ensure('config', OPTIONAL_CONFIG);
    ensure('meta', OPTIONAL_META);
    if (!state.sheets.hero || kvIdx(state, 'hero', 'badge_icon') < 0) ensure('hero', ['badge_icon']);
    return state;
  }

  // Round-trip assertion required by the brief.
  function selfTest(text) {
    const a = parseTSV(text);
    const b = parseTSV(serializeTSV(a));
    const ok = deepEqual(a, b);
    return { ok: ok, a: a, b: b };
  }
  function deepEqual(x, y) {
    if (x === y) return true;
    if (typeof x !== typeof y) return false;
    if (Array.isArray(x)) { if (!Array.isArray(y) || x.length !== y.length) return false; return x.every((v, i) => deepEqual(v, y[i])); }
    if (x && y && typeof x === 'object') {
      const kx = Object.keys(x), ky = Object.keys(y);
      if (kx.length !== ky.length) return false;
      return kx.every((k) => deepEqual(x[k], y[k]));
    }
    return false;
  }

  /* ===========================================================================
   * 14. SITE CSS  (layout only — zero content; identical for live + preview)
   * ========================================================================= */
  const SITE_CSS = `
:root{
  --primary:#1D9E75; --primary-dark:#157a5a; --secondary:#0f172a; --accent:#f59e0b;
  --text:#1f2937; --muted:#64748b; --bg:#ffffff; --bg-alt:#f6f8f7; --bg-dark:#0f172a;
  --border:#e6eae8; --radius:14px; --shadow:0 6px 24px rgba(15,23,42,.07);
  --shadow-lg:0 20px 50px rgba(15,23,42,.12);
  --font-head:'Plus Jakarta Sans',system-ui,sans-serif; --font-body:'Inter',system-ui,sans-serif;
  --maxw:1180px;
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{font-family:var(--font-body);color:var(--text);background:var(--bg);line-height:1.6;font-size:16px;overflow-x:hidden}
img{max-width:100%;display:block}
a{color:inherit;text-decoration:none}
h1,h2,h3,h4{font-family:var(--font-head);line-height:1.15;color:var(--secondary);font-weight:800;letter-spacing:-.02em}
.container{max-width:var(--maxw);margin:0 auto;padding:0 24px}
section{padding:84px 0}
.eyebrow{display:inline-block;font-size:.8rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--primary);margin-bottom:14px}
.section-head{max-width:680px;margin:0 auto 52px;text-align:center}
.section-head h2{font-size:clamp(1.8rem,3.6vw,2.7rem);margin-bottom:14px}
.section-head p{color:var(--muted);font-size:1.08rem}
.btn{display:inline-flex;align-items:center;gap:8px;font-family:var(--font-head);font-weight:700;font-size:.98rem;
  padding:13px 26px;border-radius:999px;border:2px solid transparent;cursor:pointer;transition:.2s;min-height:46px;white-space:nowrap}
.btn-primary{background:var(--primary);color:#fff}
.btn-primary:hover{background:var(--primary-dark);transform:translateY(-2px);box-shadow:var(--shadow-lg)}
.btn-ghost{background:transparent;color:var(--secondary);border-color:var(--border)}
.btn-ghost:hover{border-color:var(--primary);color:var(--primary)}
.btn-light{background:#fff;color:var(--secondary)}
.btn-light:hover{transform:translateY(-2px);box-shadow:var(--shadow-lg)}
header{position:sticky;top:0;z-index:50;background:rgba(255,255,255,.88);backdrop-filter:blur(12px);border-bottom:1px solid var(--border)}
.nav{display:flex;align-items:center;justify-content:space-between;height:70px}
.logo{font-family:var(--font-head);font-weight:800;font-size:1.25rem;color:var(--secondary);display:flex;align-items:center;gap:9px;white-space:nowrap}
.logo .dot{width:11px;height:11px;border-radius:50%;background:var(--primary);display:inline-block;flex-shrink:0}
.logo .logo-mark{display:inline-flex;align-items:center;justify-content:center;font-size:1.5rem;color:var(--primary);flex-shrink:0}
.logo-mark svg,.logo-mark img{width:1.5rem;height:1.5rem;display:block}
.nav-links{display:flex;align-items:center;gap:30px}
.nav-links a{font-weight:600;font-size:.95rem;color:var(--text);transition:.15s}
.nav-links a:hover{color:var(--primary)}
.nav-cta{display:flex;align-items:center;gap:14px}
.burger{display:none;background:none;border:0;font-size:1.6rem;color:var(--secondary);cursor:pointer}
.hero{padding:72px 0 90px;background:linear-gradient(180deg,var(--bg-alt),var(--bg))}
.hero-grid{display:grid;grid-template-columns:1.05fr .95fr;gap:56px;align-items:center}
.hero-badge{display:inline-flex;align-items:center;gap:8px;background:#fff;border:1px solid var(--border);
  padding:7px 15px;border-radius:999px;font-size:.85rem;font-weight:600;color:var(--muted);margin-bottom:22px;box-shadow:var(--shadow)}
.hero-badge i{color:var(--primary)}
.hero h1{font-size:clamp(2.2rem,5vw,3.6rem);margin-bottom:20px}
.hero h1 .hl{color:var(--primary)}
.hero-sub{font-size:1.18rem;color:var(--muted);margin-bottom:30px;max-width:540px}
.hero-actions{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:36px}
.hero-stats{display:flex;gap:34px;flex-wrap:wrap}
.stat .v{font-family:var(--font-head);font-size:1.9rem;font-weight:800;color:var(--secondary)}
.stat .l{font-size:.86rem;color:var(--muted);font-weight:500}
.hero-media{position:relative}
.hero-media img{border-radius:24px;box-shadow:var(--shadow-lg);width:100%;aspect-ratio:4/5;object-fit:cover}
.hero-float{position:absolute;left:-20px;bottom:28px;background:#fff;border-radius:14px;padding:14px 18px;
  box-shadow:var(--shadow-lg);display:flex;align-items:center;gap:12px;border:1px solid var(--border)}
.hero-float .ic{width:40px;height:40px;border-radius:10px;background:var(--primary);color:#fff;display:grid;place-items:center;font-size:1.2rem}
.hero-float .t1{font-weight:800;font-family:var(--font-head);color:var(--secondary);line-height:1.1}
.hero-float .t2{font-size:.8rem;color:var(--muted)}
.about-grid{display:grid;grid-template-columns:.9fr 1.1fr;gap:56px;align-items:center}
.about-media img{border-radius:22px;box-shadow:var(--shadow-lg);aspect-ratio:1/1;object-fit:cover;width:100%}
.about h2{font-size:clamp(1.8rem,3.6vw,2.6rem);margin-bottom:18px}
.about .intro{font-size:1.15rem;color:var(--text);font-weight:500;margin-bottom:16px}
.about .story{color:var(--muted);margin-bottom:24px}
.about .story p{margin-bottom:12px}
.about-points{list-style:none;display:grid;gap:13px;margin-bottom:26px}
.about-points li{display:flex;gap:12px;align-items:flex-start;font-weight:500}
.about-points i{color:var(--primary);font-size:1.3rem;flex-shrink:0}
.sig{font-family:var(--font-head);font-weight:800;color:var(--secondary);font-size:1.1rem}
.services{background:var(--bg-alt)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:26px}
.s-card{background:#fff;border:1px solid var(--border);border-radius:var(--radius);padding:30px;transition:.2s;display:flex;flex-direction:column}
.s-card:hover{transform:translateY(-4px);box-shadow:var(--shadow-lg);border-color:transparent}
.s-icon{width:54px;height:54px;border-radius:14px;background:color-mix(in srgb,var(--primary) 14%,#fff);
  color:var(--primary);display:grid;place-items:center;font-size:1.6rem;margin-bottom:18px}
.s-card h3{font-size:1.35rem;margin-bottom:6px}
.s-aud{font-size:.82rem;font-weight:700;color:var(--primary);text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px}
.s-desc{color:var(--muted);margin-bottom:18px}
.s-meta{display:flex;gap:16px;font-size:.85rem;color:var(--muted);margin-bottom:18px;flex-wrap:wrap}
.s-meta span{display:inline-flex;align-items:center;gap:6px}
.s-meta i{color:var(--primary)}
.feat{list-style:none;display:grid;gap:9px;margin-bottom:22px}
.feat li{display:flex;gap:10px;font-size:.94rem}
.feat i{color:var(--primary);font-size:1.1rem;flex-shrink:0}
.s-foot{margin-top:auto;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.s-price{font-family:var(--font-head);font-weight:800;font-size:1.5rem;color:var(--secondary)}
.s-price small{font-size:.8rem;font-weight:500;color:var(--muted)}
.t-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:26px}
.t-card{background:#fff;border:1px solid var(--border);border-radius:var(--radius);padding:30px;box-shadow:var(--shadow);display:flex;flex-direction:column}
.stars{color:var(--accent);font-size:1.05rem;margin-bottom:14px;letter-spacing:2px}
.t-quote{font-size:1.05rem;color:var(--text);margin-bottom:20px;flex-grow:1}
.t-quote::before{content:'\\201C';font-family:Georgia,serif;font-size:2.6rem;line-height:0;color:var(--primary);vertical-align:-.4em;margin-right:4px}
.t-result{background:var(--bg-alt);border-radius:10px;padding:12px 14px;margin-bottom:18px;display:flex;align-items:baseline;gap:8px}
.t-result .rv{font-family:var(--font-head);font-weight:800;color:var(--primary);font-size:1.3rem}
.t-result .rl{font-size:.82rem;color:var(--muted)}
.t-author{display:flex;align-items:center;gap:13px}
.t-author img{width:48px;height:48px;border-radius:50%;object-fit:cover}
.t-author .ph{width:48px;height:48px;border-radius:50%;background:var(--primary);color:#fff;display:grid;place-items:center;font-weight:800;font-family:var(--font-head)}
.t-author .n{font-weight:700;color:var(--secondary);line-height:1.2}
.t-author .r{font-size:.85rem;color:var(--muted)}
.pricing{background:var(--bg-alt)}
.p-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:26px;align-items:stretch}
.p-card{background:#fff;border:1px solid var(--border);border-radius:18px;padding:32px;display:flex;flex-direction:column;position:relative;transition:.2s}
.p-card:hover{transform:translateY(-4px);box-shadow:var(--shadow-lg)}
.p-card.popular{border:2px solid var(--primary);box-shadow:var(--shadow-lg)}
.p-tag{position:absolute;top:-13px;left:50%;transform:translateX(-50%);background:var(--primary);color:#fff;
  font-size:.75rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:6px 16px;border-radius:999px}
.p-name{font-family:var(--font-head);font-weight:800;font-size:1.3rem;color:var(--secondary);margin-bottom:4px}
.p-aud{font-size:.88rem;color:var(--muted);margin-bottom:18px}
.p-price{display:flex;align-items:baseline;gap:6px;margin-bottom:6px}
.p-price .amt{font-family:var(--font-head);font-size:2.6rem;font-weight:800;color:var(--secondary)}
.p-price .per{color:var(--muted);font-size:.95rem}
.p-dur{font-size:.85rem;color:var(--muted);margin-bottom:22px}
.p-feat{list-style:none;display:grid;gap:11px;margin-bottom:26px}
.p-feat li{display:flex;gap:10px;font-size:.94rem}
.p-feat i{font-size:1.15rem;flex-shrink:0}
.p-feat .yes i{color:var(--primary)}
.p-feat .no{color:var(--muted)}
.p-feat .no i{color:#cbd5e1}
.p-card .btn{margin-top:auto;justify-content:center}
.faq-wrap{max-width:780px;margin:0 auto;display:grid;gap:12px}
.faq-item{background:#fff;border:1px solid var(--border);border-radius:12px;overflow:hidden}
.faq-q{width:100%;text-align:left;background:none;border:0;padding:20px 22px;font-family:var(--font-head);
  font-weight:700;font-size:1.05rem;color:var(--secondary);cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:16px}
.faq-q i{color:var(--primary);transition:.25s;flex-shrink:0;font-size:1.3rem}
.faq-item.open .faq-q i{transform:rotate(45deg)}
.faq-a{max-height:0;overflow:hidden;transition:max-height .3s ease;color:var(--muted)}
.faq-a-inner{padding:0 22px 20px}
.faq-item.open .faq-a{max-height:1200px}
.b-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:28px}
.b-card{background:#fff;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;transition:.2s;cursor:pointer;display:flex;flex-direction:column}
.b-card:hover{transform:translateY(-4px);box-shadow:var(--shadow-lg)}
.b-card img{aspect-ratio:16/9;object-fit:cover;width:100%}
.b-body{padding:24px;display:flex;flex-direction:column;flex-grow:1}
.b-cat{font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--primary);margin-bottom:10px}
.b-card h3{font-size:1.25rem;margin-bottom:10px;line-height:1.25}
.b-ex{color:var(--muted);font-size:.95rem;margin-bottom:16px;flex-grow:1}
.b-meta{font-size:.83rem;color:var(--muted);display:flex;gap:14px;align-items:center}
.b-more{margin-top:14px;font-weight:700;color:var(--primary);display:inline-flex;align-items:center;gap:6px;font-size:.92rem}
.cta-final{background:var(--secondary);color:#fff;text-align:center;border-radius:0}
.cta-final h2{color:#fff;font-size:clamp(1.9rem,4vw,2.8rem);margin-bottom:16px}
.cta-final p{color:rgba(255,255,255,.8);font-size:1.15rem;max-width:560px;margin:0 auto 30px}
footer{background:var(--bg-dark);color:#cbd5e1;padding:60px 0 28px}
.f-grid{display:grid;grid-template-columns:1.6fr 1fr 1fr 1.2fr;gap:40px;margin-bottom:44px}
.f-brand .logo{color:#fff;margin-bottom:14px}
.f-brand p{color:#94a3b8;max-width:320px;font-size:.95rem}
.f-col h4{color:#fff;font-size:.95rem;margin-bottom:16px;font-family:var(--font-head)}
.f-col a,.f-col p,.f-col div{display:block;color:#94a3b8;font-size:.93rem;margin-bottom:10px;transition:.15s}
.f-col a:hover{color:var(--primary)}
.f-social{display:flex;gap:12px;margin-top:6px;flex-wrap:wrap}
.f-social a{width:40px;height:40px;border-radius:10px;background:rgba(255,255,255,.07);display:grid;place-items:center;font-size:1.2rem;color:#cbd5e1}
.f-social a:hover{background:var(--primary);color:#fff}
.f-bottom{border-top:1px solid rgba(255,255,255,.1);padding-top:24px;text-align:center;color:#64748b;font-size:.88rem}
.modal{position:fixed;inset:0;z-index:100;display:none;align-items:center;justify-content:center;padding:20px;background:rgba(15,23,42,.6);backdrop-filter:blur(4px)}
.modal.open{display:flex}
.modal-box{background:#fff;border-radius:18px;width:100%;max-width:980px;height:min(86vh,760px);position:relative;overflow:hidden;box-shadow:var(--shadow-lg)}
.modal-close{position:absolute;top:12px;right:12px;z-index:2;width:38px;height:38px;border-radius:50%;border:0;background:#fff;
  box-shadow:var(--shadow);cursor:pointer;font-size:1.3rem;color:var(--secondary);display:grid;place-items:center}
.modal-box iframe{width:100%;height:100%;border:0}
.post-overlay{position:fixed;inset:0;z-index:90;background:var(--bg);overflow-y:auto;display:none}
.post-overlay.open{display:block}
.post-hero{position:relative;height:42vh;min-height:300px}
.post-hero img{width:100%;height:100%;object-fit:cover}
.post-hero .scrim{position:absolute;inset:0;background:linear-gradient(180deg,rgba(15,23,42,.1),rgba(15,23,42,.75))}
.post-back{position:fixed;top:20px;left:20px;z-index:3;background:#fff;border:0;border-radius:999px;padding:10px 18px;
  font-weight:700;font-family:var(--font-head);box-shadow:var(--shadow-lg);cursor:pointer;display:inline-flex;gap:8px;align-items:center;color:var(--secondary)}
.post-head{position:absolute;bottom:0;left:0;right:0;color:#fff;padding:40px 0}
.post-head .container{max-width:760px}
.post-head .b-cat{color:#fff;opacity:.9}
.post-head h1{color:#fff;font-size:clamp(1.8rem,4vw,2.8rem);margin-bottom:14px}
.post-head .pm{color:rgba(255,255,255,.85);font-size:.9rem;display:flex;gap:16px;flex-wrap:wrap}
.post-body{max-width:760px;margin:0 auto;padding:54px 24px 90px;font-size:1.1rem;line-height:1.8;color:var(--text)}
.post-body h2{font-size:1.7rem;margin:36px 0 14px}
.post-body h3{font-size:1.3rem;margin:28px 0 10px}
.post-body p{margin-bottom:20px}
.post-body ul,.post-body ol{margin:0 0 20px 24px}
.post-body li{margin-bottom:8px}
.post-body blockquote{border-left:4px solid var(--primary);padding:6px 0 6px 22px;margin:24px 0;color:var(--muted);font-style:italic;font-size:1.15rem}
.post-body a{color:var(--primary);text-decoration:underline}
.loading{min-height:60vh;display:grid;place-items:center;color:var(--muted);font-weight:600;gap:14px}
.spin{width:34px;height:34px;border:3px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:sp 1s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
.reveal{opacity:0;transform:translateY(20px);transition:.6s ease}
.reveal.in{opacity:1;transform:none}
.cms-svg svg,.cms-svg-img{width:1em;height:1em;display:inline-block;vertical-align:-.125em}
/* ---- folder-driven content sections (cases / shop / downloads) ---- */
.content-cases{background:var(--bg-alt)}
.content-downloads{background:var(--bg-alt)}
.c-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:26px}
.c-card{position:relative;background:#fff;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;cursor:pointer;transition:.2s;display:flex;flex-direction:column}
.c-card:hover{transform:translateY(-4px);box-shadow:var(--shadow-lg)}
.c-card.is-featured{border-color:var(--primary);box-shadow:var(--shadow)}
.c-cover{position:relative;aspect-ratio:4/3;background:var(--bg-alt)}
.c-cover img{width:100%;height:100%;object-fit:cover}
.c-nocover{width:100%;height:100%;display:grid;place-items:center;color:var(--muted);font-size:2rem}
.c-badge{position:absolute;top:12px;left:12px;font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:5px 11px;border-radius:999px;color:#fff}
.c-badge.sold{background:var(--secondary)}
.c-badge.pre{background:var(--accent)}
.c-body{padding:20px;display:flex;flex-direction:column;gap:6px;flex-grow:1}
.c-eyebrow{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--primary)}
.c-card h3{font-size:1.2rem;line-height:1.25}
.c-sub{color:var(--muted);font-size:.92rem}
.c-price{font-family:var(--font-head);margin-top:4px}
.c-price .now{font-weight:800;font-size:1.3rem;color:var(--secondary)}
.c-price .old{text-decoration:line-through;color:var(--muted);font-weight:600;margin-right:6px;font-size:1rem}
.c-topmetric{margin-top:auto;display:flex;align-items:baseline;gap:7px}
.c-topmetric .v{font-family:var(--font-head);font-weight:800;font-size:1.45rem;color:var(--primary)}
.c-topmetric .l{font-size:.82rem;color:var(--muted)}
.c-file{margin-top:auto;font-size:.85rem;color:var(--muted);display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.c-file i{color:var(--primary)}
/* content detail (inside the post overlay) */
.cd-wrap{padding:54px 0 90px}
.cd-container{display:grid;grid-template-columns:1.05fr .95fr;gap:48px;align-items:start;max-width:1080px}
.cd-gallery{position:sticky;top:24px}
.cd-main{width:100%;border-radius:18px;box-shadow:var(--shadow-lg);aspect-ratio:4/3;object-fit:cover}
.cd-thumbs{display:flex;gap:10px;margin-top:12px;flex-wrap:wrap}
.cd-thumb{width:72px;height:72px;border-radius:10px;object-fit:cover;cursor:pointer;border:2px solid transparent;opacity:.7;transition:.15s}
.cd-thumb.on,.cd-thumb:hover{opacity:1;border-color:var(--primary)}
.cd-headline h1{font-size:clamp(1.7rem,3.4vw,2.4rem);margin-bottom:10px}
.cd-priceline{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.cd-filemeta{color:var(--muted);font-size:.95rem;display:inline-flex;gap:7px;align-items:center;margin-bottom:8px}
.cd-filemeta i{color:var(--primary)}
.cd-meta{display:grid;grid-template-columns:1fr 1fr;gap:10px 18px;margin:20px 0;padding:18px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
.cd-meta .k{display:block;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:700}
.cd-meta .v{font-weight:600;color:var(--secondary)}
.cd-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:16px;margin:24px 0}
.cd-metric{background:var(--bg-alt);border-radius:14px;padding:18px;text-align:center}
.cd-metric .v{font-family:var(--font-head);font-weight:800;font-size:2rem;color:var(--primary);line-height:1}
.cd-metric .l{font-size:.84rem;color:var(--muted);margin-top:6px}
.cd-quote{border-left:4px solid var(--primary);padding:6px 0 6px 22px;margin:28px 0;font-style:italic;color:var(--text)}
.cd-quote p{font-size:1.15rem;margin-bottom:8px}
.cd-quote-by{font-style:normal;font-weight:700;color:var(--secondary);font-size:.92rem}
.cd-tags{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0}
.cd-tags span{background:var(--bg-alt);border:1px solid var(--border);border-radius:999px;padding:4px 12px;font-size:.8rem;color:var(--muted)}
.cd-actions{margin-top:24px}
.cd-cta.disabled{background:var(--muted);pointer-events:none;opacity:.7}
.cd-gate{margin-top:24px;background:var(--bg-alt);border:1px solid var(--border);border-radius:14px;padding:20px}
.cd-gate-label{display:block;font-weight:600;margin-bottom:10px;color:var(--secondary)}
.cd-gate-row{display:flex;gap:10px;flex-wrap:wrap}
.cd-gate-row input{flex:1;min-width:200px;padding:12px 14px;border:1px solid var(--border);border-radius:10px;font-size:1rem}
.cd-gate-done .btn{margin-top:4px}
@media(max-width:820px){.cd-container{grid-template-columns:1fr;gap:28px}.cd-gallery{position:static}}
@media(max-width:920px){
  .hero-grid,.about-grid{grid-template-columns:1fr;gap:36px}
  .hero-media{order:-1}
  .about-media{order:-1}
  .f-grid{grid-template-columns:1fr 1fr}
}
@media(max-width:720px){
  section{padding:60px 0}
  .nav-links{position:fixed;inset:70px 0 auto 0;background:#fff;flex-direction:column;gap:0;padding:10px 24px 24px;
    border-bottom:1px solid var(--border);box-shadow:var(--shadow);display:none}
  .nav-links.open{display:flex}
  .nav-links a{padding:13px 0;width:100%;border-bottom:1px solid var(--border)}
  .burger{display:block}
  .nav .nav-cta .btn{display:none}
  .hero-stats{gap:24px}
  .f-grid{grid-template-columns:1fr}
}
`;

  /* ===========================================================================
   * 15. EDIT-MODE CSS  (affordances; only matters when editable:true)
   * ========================================================================= */
  const EDIT_CSS = `
.cms-editable [contenteditable]{outline:none;border-radius:4px;transition:box-shadow .12s,background .12s}
.cms-editable [contenteditable]:hover{box-shadow:0 0 0 2px rgba(29,158,117,.25)}
.cms-editable [contenteditable]:focus{box-shadow:0 0 0 2px var(--primary);background:rgba(29,158,117,.06)}
.cms-editable [contenteditable]:empty:before{content:attr(data-cms-ph);color:var(--muted);opacity:.6}
.cms-editable .btn[data-book]{cursor:default}
.cms-img-wrap{position:relative;display:block}
.cms-edit-btn{position:absolute;top:8px;right:8px;z-index:3;border:0;border-radius:8px;background:rgba(15,23,42,.82);color:#fff;
  width:34px;height:34px;display:grid;place-items:center;cursor:pointer;font-size:1.05rem;box-shadow:var(--shadow)}
.cms-edit-btn:hover{background:var(--primary)}
.cms-html{position:relative}
.cms-editable-html{outline:1px dashed rgba(29,158,117,.4);outline-offset:4px;border-radius:6px}
.cms-html-btn{top:-6px;right:-6px}
.cms-icon-wrap{position:relative;cursor:pointer;display:inline-grid;place-items:center}
.cms-icon-pencil{position:absolute;top:-8px;right:-10px;font-size:.7em;background:var(--primary);color:#fff;border-radius:50%;padding:2px}
.cms-list-edit{list-style:none;display:grid;gap:8px;margin:0 0 18px;padding:0}
.cms-list-edit .cms-li{display:flex;align-items:center;gap:8px}
.cms-li-text{flex:1;padding:4px 8px;border:1px solid var(--border);border-radius:6px;background:#fff;min-height:1.6em}
.cms-li-del{border:0;background:#fee2e2;color:#b91c1c;border-radius:6px;width:26px;height:26px;cursor:pointer;flex-shrink:0}
.cms-li-addbtn{border:1px dashed var(--primary);background:transparent;color:var(--primary);border-radius:6px;padding:5px 12px;cursor:pointer;font-weight:600}
.cms-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px;padding-top:14px;border-top:1px dashed var(--border)}
.cms-chip{display:inline-flex;align-items:center;gap:6px;background:var(--bg-alt);border:1px solid var(--border);border-radius:999px;padding:3px 10px;font-size:.78rem;color:var(--muted)}
.cms-chip-k{font-weight:700;text-transform:uppercase;letter-spacing:.04em;font-size:.68rem}
.cms-chip-v{min-width:30px;padding:1px 4px;border-radius:4px;background:#fff;color:var(--text);font-weight:600}
.cms-toggle{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);background:#fff;border-radius:999px;padding:4px 12px;font-size:.78rem;cursor:pointer;color:var(--muted);font-weight:600}
.cms-toggle.on{background:var(--primary);color:#fff;border-color:var(--primary)}
.cms-card-wrap{position:relative}
.cms-card-del-abs{position:absolute;top:10px;right:10px;z-index:4}
.cms-card-del{border:0;background:#fee2e2;color:#b91c1c;border-radius:8px;width:30px;height:30px;cursor:pointer;display:grid;place-items:center}
.cms-card-del:hover{background:#b91c1c;color:#fff}
.cms-card-add-block{display:inline-flex;align-items:center;gap:6px;margin-top:24px;border:2px dashed var(--primary);background:transparent;color:var(--primary);border-radius:12px;padding:12px 22px;cursor:pointer;font-weight:700;font-family:var(--font-head)}
.cms-card-add-block:hover{background:var(--primary);color:#fff}
.cms-nav-item{display:inline-flex;align-items:center;gap:4px}
.cms-nav-add{border:1px dashed var(--primary);background:transparent;color:var(--primary);border-radius:50%;width:26px;height:26px;cursor:pointer}
.cms-edit-article{margin-top:14px;border:1px solid var(--primary);background:transparent;color:var(--primary);border-radius:8px;padding:7px 12px;cursor:pointer;font-weight:600;display:inline-flex;gap:6px;align-items:center}
.cms-section-toggle{margin-top:14px}
.cms-soc-edit{display:inline-flex;align-items:center;gap:4px;color:#94a3b8}
.cms-muted{color:var(--muted);font-style:italic;font-size:.9rem}
.cms-hidden-live{position:relative;outline:2px dashed #f59e0b;outline-offset:-8px}
.cms-hidden-badge{position:absolute;top:10px;left:50%;transform:translateX(-50%);background:#f59e0b;color:#fff;font-size:.72rem;font-weight:700;padding:4px 12px;border-radius:999px;z-index:5;display:inline-flex;gap:6px;align-items:center}
.cms-card-wrap .cms-html-btn{right:-6px}
/* When a card's image sits under the top-right delete button, move the image's
   own edit button to the TOP-LEFT so the two never overlap. */
.cms-card-wrap .cms-img-btn{left:8px;right:auto}
.cms-nav-editbtn{border:1px dashed var(--primary);background:transparent;color:var(--primary);border-radius:999px;padding:5px 12px;cursor:pointer;font:600 .82rem var(--font-body),sans-serif;display:inline-flex;gap:5px;align-items:center}
.cms-nav-editbtn:hover{background:var(--primary);color:#fff}
.cms-soc-editbtn{width:40px;height:40px;border-radius:10px;border:1px dashed var(--primary);background:transparent;color:var(--primary);cursor:pointer;display:grid;place-items:center;font-size:1.1rem}
.cms-soc-editbtn:hover{background:var(--primary);color:#fff}
.f-social-prev{width:40px;height:40px;border-radius:10px;background:rgba(255,255,255,.07);display:grid;place-items:center;font-size:1.2rem;color:#cbd5e1}
.cms-stars{display:inline-flex;gap:3px}
.cms-star{cursor:pointer;font-size:1.15rem;line-height:1;color:#cbd5e1;transition:transform .1s}
.cms-star.on{color:var(--accent)}
.cms-star:hover{transform:scale(1.2)}
.cms-editable .c-card{outline:1px dashed transparent;outline-offset:3px}
.cms-editable .c-card:hover{outline-color:rgba(29,158,117,.5)}
.c-edit{position:absolute;top:10px;right:10px;z-index:3;background:rgba(15,23,42,.82);color:#fff;border-radius:999px;padding:5px 11px;font:600 .75rem var(--font-body),sans-serif;display:inline-flex;gap:5px;align-items:center;opacity:0;transition:.15s}
.cms-editable .c-card:hover .c-edit{opacity:1}
`;

  /* ===========================================================================
   * 16. EXPORT
   * ========================================================================= */
  global.Core = {
    parseTSV, serializeTSV, render, applyHead, seoTags, seoValues, ensureSchema, selfTest,
    mdToHtml, openContentDetail, contentItems, CONTENT_DEFS,
    // utilities the editor reuses:
    kvObj, kvVal, kvIdx, rowsOf, getSheet, getCell, setCell, suggestAlt,
    esc, list, bool, money, uimg, fmtDate, deepEqual,
    OPTIONAL_CONFIG, OPTIONAL_META
  };
})(window);
