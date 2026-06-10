/* functions/upload.js — OPTIONAL Cloudflare Pages Function for image uploads.
 *
 * Wires the editor's image-modal "Add file" button to an R2 bucket: it accepts
 * a multipart file POST, stores it in R2, and returns { url } pointing at the
 * bucket's public base. The editor calls this only if its UPLOAD_ENDPOINT is
 * set (default ""), so the whole feature is opt-in and URL paste always works.
 *
 * Enable it (in your own deploy — do NOT commit bucket names/secrets):
 *   1. Create an R2 bucket and give it a public custom domain.
 *   2. In wrangler.jsonc add:
 *        "r2_buckets": [{ "binding": "UPLOADS", "bucket_name": "<your-bucket>" }]
 *        "vars": { "R2_PUBLIC_BASE": "https://assets.example.com" }
 *      (or set these as Pages bindings / environment variables in the dashboard)
 *   3. Set UPLOAD_ENDPOINT = "/upload" in public/editor.html.
 *
 * If the binding or public base is missing it returns 501 with a clear hint —
 * nothing crashes, the editor just shows the "paste a URL" message.
 */

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/svg+xml', 'image/avif']);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export function onRequestOptions() {
  return json({}, 204);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.UPLOADS || !env.R2_PUBLIC_BASE) {
    return json({
      error: 'Upload endpoint not configured.',
      hint: 'Add an R2 bucket binding "UPLOADS" and a "R2_PUBLIC_BASE" var, then redeploy. Until then, paste an image URL in the editor.',
    }, 501);
  }

  let form;
  try { form = await request.formData(); }
  catch (e) { return json({ error: 'Expected multipart/form-data with a "file" field.' }, 400); }

  const file = form.get('file');
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
    return json({ error: 'No file provided.' }, 400);
  }
  if (file.type && !ALLOWED.has(file.type.toLowerCase())) {
    return json({ error: 'Unsupported file type: ' + file.type }, 415);
  }

  const buf = await file.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) {
    return json({ error: 'File too large (max ' + (MAX_BYTES / 1024 / 1024) + ' MB).' }, 413);
  }

  const safeName = String(file.name || 'image').toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
  const ext = safeName.includes('.') ? safeName.split('.').pop() : 'bin';
  const key = 'uploads/' + Date.now() + '-' + crypto.randomUUID() + '.' + ext;

  try {
    await env.UPLOADS.put(key, buf, {
      httpMetadata: { contentType: file.type || 'application/octet-stream' },
    });
  } catch (e) {
    return json({ error: 'Storage write failed: ' + (e && e.message ? e.message : 'unknown') }, 502);
  }

  const base = String(env.R2_PUBLIC_BASE).replace(/\/+$/, '');
  return json({ url: base + '/' + key, key });
}
