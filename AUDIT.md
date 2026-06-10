# AUDIT — making the renderer provably 100% TSV-driven (Part 2)

This audits the **source** renderer (`ohshtnvm/spiritual-coach-site`,
`public/index.html`) for any content baked into HTML/JS instead of coming from
the TSV, and records what was done about each item in this repo.

**Result:** every piece of *content* and *head metadata* now comes from
`coach-data.tsv`. `index.html` contains only structure + boot logic; all
rendering lives in `core.js`. Deleting/replacing the TSV changes 100% of the
visible content and `<head>`.

Legend for "Action":
- **Moved** — value was hardcoded; it now lives in a TSV cell and the renderer
  reads it from there. (Existing TSV lines were preserved byte-for-byte; new
  keys were *appended* — see `scripts/add-tsv-keys.js` and the diff.)
- **Already TSV** — was already sourced from the TSV in the source repo.
- **Structure/logic** — intentionally stays in code (not content); see
  "Things that stay in code" at the bottom for the rationale.

---

## 1. `<head>` / SEO / metadata

| Item (source) | Source state | Action | TSV location |
|---|---|---|---|
| `<title>` | placeholder, overwritten at runtime | Already TSV | `config.meta_title` (falls back to `coach_name`) |
| `meta description` | placeholder | Already TSV | `config.meta_description` |
| `meta keywords` | — | Already TSV | `config.meta_keywords` |
| `meta robots` = `index, follow` | **hardcoded** | **Moved** | `config.robots` |
| `link canonical` = `/` | hardcoded default | **Moved** | `config.site_domain` |
| favicon | **absent entirely** | **Added** (TSV-driven, empty default) | `config.favicon` |
| `theme-color` = `#1D9E75` | hardcoded, then overwritten by `primary_color` | **Moved** | `config.theme_color` (falls back to `primary_color`) |
| `og:type` = `website` | **hardcoded** | **Moved** | `config.og_type` |
| `og:title` / `og:description` | placeholder | Already TSV | `config.meta_title` / `meta_description` |
| `og:image` | empty placeholder | Already TSV | `config.og_image` |
| `og:image:alt` | **absent** | **Added** (auto-suggested if empty) | `config.og_image_alt` |
| `og:url` | — | Already TSV | `config.site_domain` |
| `og:site_name` | **absent** | **Added** | `config.og_site_name` (falls back to `coach_name`) |
| `twitter:card` = `summary_large_image` | **hardcoded** | **Moved** | `config.twitter_card` |
| `twitter:title`/`description`/`image` | placeholder | Already TSV | `config.*` (image falls back to `og_image`) |
| `twitter:site` | **absent** | **Added** | `config.twitter_site` |

## 2. JSON-LD (structured data)

| Item (source) | Source state | Action | TSV location |
|---|---|---|---|
| `@type` Person | **hardcoded** `"Person"` | **Moved** | `config.schema_type` |
| Person/Org `sameAs` | partial (omitted `facebook`) | **Moved + fixed** | `config.linkedin/twitter/instagram/facebook` |
| Organization `logo` | hardcoded to `og_image` | **Moved** | `config.schema_logo` (falls back to `og_image`) |
| Organization `telephone` | hardcoded to `phone` | **Moved** | `config.schema_telephone` (falls back to `phone`) |
| Organization `address` | **absent** | **Added** | `config.schema_address` |
| `aggregateRating.ratingValue` = `"5"` | **hardcoded** | **Moved** | `config.aggregate_rating` (else computed from reviews) |
| Service / FAQPage / Review nodes | generated from rows | Already TSV | `services` / `faq` / `testimonials` sheets |

## 3. Icons / SVG

The source used the **Tabler webfont** (`<i class="ti ti-…">`). Some icon names
were already TSV-driven; one meaningful one was hardcoded.

| Item (source) | Source state | Action | TSV location |
|---|---|---|---|
| Service card icon | already from TSV | Already TSV | `services.icon` |
| Hero floating-badge icon | already from TSV | Already TSV | `hero.float_icon` |
| Hero **badge** icon = `ti ti-sparkles` | **hardcoded** | **Moved** | `hero.badge_icon` |
| Footer social platform→icon map | hardcoded mapping | Structure/logic (platform is implied by the `config.linkedin/…` key) |

All three editable icon fields (`services.icon`, `hero.float_icon`,
`hero.badge_icon`) accept a **Tabler name**, an **inline `<svg>…</svg>`**, or an
**image/SVG URL** (`core.js → iconMarkup`), and are editable via the editor's
icon modal — satisfying "convert icons to a TSV-driven field."

## 4. UI copy that was hardcoded in markup

| Item (source) | Source state | Action | TSV location |
|---|---|---|---|
| Footer column heading "Explore" | **hardcoded** | **Moved** | `meta.footer_explore_heading` |
| Footer column heading "Contact" | **hardcoded** | **Moved** | `meta.footer_contact_heading` |
| Footer column heading "Get started" | **hardcoded** | **Moved** | `meta.footer_getstarted_heading` |
| Pricing "Most popular" tag | **hardcoded** | **Moved** | `meta.pricing_popular_label` |
| Blog card "Read article" | **hardcoded** | **Moved** | `meta.blog_readmore_text` |
| Blog overlay "Back" button | **hardcoded** | **Moved** | `meta.blog_back_text` |
| "Loading site…" | **hardcoded** | **Moved** | `meta.loading_text` |
| Copyright text | partly TSV | Already TSV | `footer.copyright` (year is `new Date()` — logic) |

## 5. Branding, colours, fonts, contact, socials, booking

All already TSV-driven in the source and remain so:
`config.primary_color/secondary_color/accent_color/text_dark/bg_light`,
`config.font_heading/font_body`, `config.coach_name/logo_text/coach_title`,
`config.email/phone/location`, `config.linkedin/twitter/instagram/facebook`,
`config.calcom_link`, every `hero`/`about`/`services`/`testimonials`/`pricing`/
`faq`/`blog`/`cta_final`/`footer` cell, and the `show_*` section toggles.

---

## Confirmation: "replace the TSV changes everything"

- The live page (`index.html`) is just: `parseTSV → render(state, root,
  {editable:false}) → applyHead(state)`. No content literals remain in it.
- Verified in a browser (see README "Verify" notes): `<title>`, description,
  canonical, robots, OG/Twitter, JSON-LD (4.4 KB), footer headings, the
  "Most popular" tag, brand colour (`--primary` = `#A38AB0`), fonts, nav, and
  every section's cards all derive from the TSV.
- Swap `coach-data.tsv` for a different coach's TSV and 100% of the visible
  content + head metadata changes, with **zero** code edits.

## Things that stay in code (and why)

These are **structure/logic**, not content, so they are intentionally not in
the TSV. None of them carry brand/marketing copy:

- **Layout & CSS** — `core.js → SITE_CSS`. Colours/fonts within it are CSS
  *variables* fed from the TSV; the rules themselves are structure.
- **Functional UI glyphs** — the calendar icon on "Book" buttons, the check
  marks in feature lists, the clock/calendar-repeat icons on service meta, the FAQ
  `+`, the blog arrow, the burger menu, modal close/back arrows. These are
  fixed affordances of the template, equivalent to button chrome. (The editor
  still lets you change every *content* icon — hero/service/float.)
- **The `*highlight*` syntax** in `hero.headline` — a tiny markup convention
  (asterisks wrap the highlighted words); the words themselves are TSV content.
- **Date formatting** and the **copyright year** — computed from `Date`.
- **Cal.com embed URL assembly** — `https://cal.com/{calcom_link}?embed=…`; the
  handle is `config.calcom_link` (content), the embed scaffolding is logic.
- **Unsplash auto-sizing** (`uimg`) — appends `w/q/auto` params to image URLs;
  the URLs themselves are TSV content.

> Note: `uimg` reproduces the source's exact behaviour, including appending a
> second `&w=…` when a URL already has `?w=…`. This is kept identical on purpose
> so the renderer's output matches the original site byte-for-byte.
