# editor-renderer-v2

> v2 of the TSV-driven coach-site engine (duplicated from `site-editor-renderer`).
> Three new features are being added on top of the v1 baseline.

A TSV-driven coaching website with **two pages that share one engine**:

- **`/index.html`** — the live renderer. 100% TSV-driven: every word, colour,
  font, icon, image, and `<head>` value comes from `coach-data.tsv`.
- **`/editor.html`** — a visual editor that edits that same TSV in place and
  round-trips it perfectly.

Both load the same **`core.js`**, so the editor's Preview is byte-for-byte what
the live site renders ("preview === live"). No framework, no build step, no
dependencies (Node is only used for the optional `build.js` and the tests).

```
public/
  index.html      # renderer — load core.js, render(state, root, {editable:false}) + applyHead
  editor.html     # editor   — load core.js, render(..., {editable:true}) + toolbar/modals
  core.js         # shared engine: parseTSV / serializeTSV / render / applyHead
  coach-data.tsv  # the ONLY content file (multi-sheet TSV)
  _headers        # Cloudflare Pages: serves the .tsv with the right MIME type
functions/
  upload.js       # OPTIONAL R2 image upload (graceful if unconfigured)
scripts/
  serve.js        # zero-dep static dev server (mirrors the .tsv MIME)
  add-tsv-keys.js # one-off used during hardening (kept for reference)
test/
  roundtrip.js    # parse/serialize inverse + format-preservation self-test
  compat.js       # proves exported TSV loads in the ORIGINAL renderer
build.js          # re-embeds the offline fallback TSV into index.html
wrangler.jsonc    # Cloudflare config (+ documented optional R2 binding)
AUDIT.md          # Part 2 report: what was hardcoded and where it moved
```

## Architecture — the shared core (`core.js`)

`core.js` is a classic script (works under `file://`) exposing `window.Core`:

| Export | Purpose |
|---|---|
| `parseTSV(text)` | TSV → state object `{ order, sheets:{ name:{headers,rows} } }`. Pure & lossless. |
| `serializeTSV(state)` | state → TSV string. **Exact inverse** of `parseTSV`. |
| `render(state, mount, {editable})` | Builds the whole site into `mount`. `editable:false` = live; `editable:true` adds inline edit affordances in the same layout. |
| `applyHead(state)` | Injects `<title>`, description, canonical, favicon, robots, theme-color, Open Graph, Twitter cards, and JSON-LD (Person/Organization/Service/FAQPage/Review). |
| `ensureSchema(state)` | Editor-only: adds known optional keys (empty) so they're always bindable. Not used by `parseTSV`, so the round-trip stays pure. |
| `selfTest(text)` | Round-trip assertion helper. |

All field rendering goes through small helpers (`f.text`, `f.html`, `f.img`,
`f.icon`, `f.list`, `f.toggle`, `f.chip`) that emit plain content in preview and
editable controls in edit mode — **one code path, same DOM positions**.

## The TSV format (preserved exactly)

Multi-sheet TSV. Each sheet starts with `#sheetname`, then a tab-separated
header row, then tab-separated data rows; the next `#sheet` (or EOF) ends it.

- **List cells** use `|` to separate items (`Monthly call|Email support`).
- **HTML cells** hold single-line inline HTML (`<p>`, `<h2>`, `<ul>`, `<blockquote>`).
- **Booleans** are `true`/`false` (e.g. `config → show_blog`).
- **Images** pair with a matching `*_alt` cell.

Sheets: `config · nav · meta · hero · about · services · testimonials ·
pricing · faq · blog · cta_final · footer`. Branding, colours, fonts, SEO, the
Cal.com link, and socials live in `config`.

> **Compatibility contract:** a TSV exported from the editor pastes into the
> *unmodified original renderer* and loads identically — same sheets, `#sheet`
> markers, tab delimiters, `|` lists, single-line HTML cells, and `*_alt`
> pairings. Enforced by `test/compat.js`.

## Using the editor

Open `/editor.html`. It loads the live `coach-data.tsv` (or a pasted TSV).

- **Edit mode is the default.** The upper-right **Exit Edit Mode** button flips
  to Preview, which calls the exact `render(..., {editable:false})` path.
- **Text & headings** are inline-editable. **HTML cells** open a small editor
  that keeps the cell single-line on save. **Images** open a modal with Photo
  URL + Alt (pre-filled with a smart, contextual suggestion) + optional file
  upload. **Icons/SVG** are editable (Tabler name, inline `<svg>`, or URL).
  **List fields** get add/remove. Every **card** section has ✕ / ＋ controls.
- **SEO** button → a modal for all meta + structured JSON-LD; saving re-runs
  `applyHead`.
- **Copy TSV** / **Download** export the current state; **Load** pastes a TSV
  back (the "revert to a version" path). **Snapshots** save named versions to
  this browser's `localStorage`; edits also autosave there.

State is the single source of truth — edits write into the in-memory state, and
export is just `serializeTSV(state)`. Nothing is ever scraped back out of the DOM.

### Brand logo

The mark next to the name (header + footer) is the `config.logo_svg` cell. Leave
it empty for the default coloured dot, or set it to **inline `<svg>…</svg>`**, an
**image/SVG URL**, or a **`data:` URI**. In the editor, click the dot/mark next
to the logo name to open the icon modal and paste it in; the colour follows your
`primary_color`. (The logo text itself is the `config.logo_text` cell.)

## Edit → deploy workflow

```
1. Open /editor.html, make changes, click "Copy TSV" (or Download).
2. Replace public/coach-data.tsv with the exported TSV.
3. node build.js   # regenerates the static SEO <head> + offline fallback from the TSV
4. git add -A && git commit && git push
5. Cloudflare Pages redeploys automatically.
```

`/editor.html` deploys as just another page in the same Pages project.

> **⚠️ Gate the editor before client use.** `/editor.html` is unauthenticated by
> default — anyone with the URL can use it (it only produces a TSV string; it
> can't write back to your repo, but you still don't want it public). Put it
> behind **Cloudflare Access** (Zero Trust → Access → add an application for
> `/editor.html`) before using on a real project. It's also `noindex`.

## Optional: image upload via R2

`functions/upload.js` is a Cloudflare Pages Function that stores an uploaded
file in R2 and returns its public URL. It's **disabled until configured** and
the editor only calls it when `UPLOAD_ENDPOINT` (in `editor.html`) is set.

To enable (in your own deploy — never commit bucket names/secrets):

1. Create an R2 bucket with a public custom domain.
2. In `wrangler.jsonc` (or the Pages dashboard) add the binding + base URL:
   ```jsonc
   "r2_buckets": [{ "binding": "UPLOADS", "bucket_name": "<your-bucket>" }],
   "vars": { "R2_PUBLIC_BASE": "https://assets.example.com" }
   ```
3. Set `UPLOAD_ENDPOINT = "/upload"` in `public/editor.html`.

If the binding is missing the function returns a clear 501 and URL paste keeps
working.

## Deploy: GitHub → Cloudflare Pages

1. Push this repo to GitHub.
2. Cloudflare **Workers & Pages → Create → Pages → Connect to Git** → pick it.
3. Build settings: **Framework preset = None**, **Build command = empty**,
   **Build output directory = `public`** (this repo serves from `public/`).
4. Deploy. Site at `https://<project>.pages.dev`, editor at `/editor.html`.

## Local preview & tests

```bash
npm run serve     # static server on http://localhost:8123 (serves ./public)
npm test          # round-trip + original-renderer compatibility self-tests
npm run build     # regenerate the static SEO <head> + offline fallback in index.html
```

(`npm` is only a task runner here — there are no dependencies to install.)
