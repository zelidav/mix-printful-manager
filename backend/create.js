// Create + publish products to the native store from a browser-composited design.
// Flow: host the print PNG at a short-lived public URL -> Printful ingests it (file_id)
// -> create one sync product per chosen catalog product (all variants, design centered) -> publish.
const { Storage } = require('@google-cloud/storage');
const { request, getStoresLive } = require('./printful');

// Printful's /files validator rejects *.run.app URLs but accepts storage.googleapis.com,
// so we host the print file on a public GCS bucket (Cloud Run SA has access).
const BUCKET = process.env.UPLOAD_BUCKET || 'jb-printful-creator-uploads';
const bucket = new Storage().bucket(BUCKET);
async function hostOnGcs(buf, mime = 'image/png') {
  const key = `mix/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  await bucket.file(key).save(buf, { contentType: mime, resumable: false, metadata: { cacheControl: 'public, max-age=31536000, immutable' } });
  return `https://storage.googleapis.com/${BUCKET}/${key}`;
}

// retail = blank cost doubled, rounded UP to the whole dollar
function retailFrom(blank, markup) {
  return String(Math.max(1, Math.ceil((blank || 0) * (markup || 2))));
}

// On-brand product copy: hype, industry-only / insider-only merch (trademark-clean).
const HOOKS = [
  "If you're holding one, you're on the list.",
  "IYKYK. Not for the tourists.",
  "Insider issue — never stocked for the public.",
  "Earned, not bought off a shelf.",
  "Back-room certified. Public-store denied.",
];
function genDescription(title, typeName, storeName, i = 0) {
  const who = storeName ? `Made in Xiaolin × ${storeName}` : 'Made in Xiaolin';
  const item = (typeName || title || 'piece');
  return `Industry-only heat from ${who}. This ${title} is insider merch — cut for the people who actually move in this world, not the tourists. ${HOOKS[i % HOOKS.length]} Built clean, worn loud, and kept off every public shelf. Cannabis-industry insiders only.`;
}

async function nativeStoreId(token) {
  const stores = await getStoresLive(token);
  const n = stores.find(s => s.platform === 'native') || stores[0];
  return n && n.id;
}
async function pollFile(token, fileId, maxSec = 60) {
  const start = Date.now();
  while (Date.now() - start < maxSec * 1000) {
    await new Promise(r => setTimeout(r, 2500));
    try {
      const r = await request('GET', `/files/${fileId}`, token, null);
      const st = r.result && r.result.status;
      if (st === 'ok') return r.result;
      if (st === 'failed') return null;
    } catch { /* keep polling */ }
  }
  return null;
}

// PNG intrinsic size from the IHDR header (no image lib needed)
function pngSize(buf) {
  if (!buf || buf.length < 24) return { w: 0, h: 0 };
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
// First print placement + print-area size for a catalog product (for centered mockup placement)
async function placementArea(token, catalogId) {
  try {
    const r = await request('GET', `/mockup-generator/printfiles/${catalogId}`, token, null);
    const res = r.result || {};
    const placement = res.available_placements ? Object.keys(res.available_placements)[0] : 'default';
    const pf = (res.printfiles || [])[0] || {};
    return { placement: placement || 'default', area_w: pf.width || 1800, area_h: pf.height || 2400 };
  } catch { return { placement: 'default', area_w: 1800, area_h: 2400 }; }
}
// Generate a real product mockup (design centered + fit), return its URL. Best-effort.
async function generateMockup(token, catalogId, variantId, placement, imageUrl, dW, dH, area_w, area_h) {
  const scale = Math.min(area_w / (dW || area_w), area_h / (dH || area_h)) * 0.92;
  const w = Math.max(1, Math.round((dW || area_w) * scale));
  const h = Math.max(1, Math.round((dH || area_h) * scale));
  const left = Math.round((area_w - w) / 2), top = Math.round((area_h - h) / 2);
  const task = await request('POST', `/mockup-generator/create-task/${catalogId}`, token, null, {
    variant_ids: [variantId], format: 'jpg',
    files: [{ placement, image_url: imageUrl, position: { area_width: area_w, area_height: area_h, width: w, height: h, top, left } }],
  });
  const key = task.result && task.result.task_key;
  if (!key) return null;
  const start = Date.now();
  while (Date.now() - start < 70000) {
    await new Promise(r => setTimeout(r, 3000));
    const t = await request('GET', `/mockup-generator/task?task_key=${key}`, token, null);
    const st = t.result && t.result.status;
    if (st === 'completed') { const m = (t.result.mockups || [])[0]; return m && m.mockup_url; }
    if (st === 'failed') return null;
  }
  return null;
}

function registerPublic(_app) { /* design files now hosted on GCS; no public route needed */ }

// Authed create endpoint
function register(app, resolveAccount) {
  app.post('/api/create', async (req, res) => {
    const token = resolveAccount(req).token;
    const { design, productIds, markup = 2, name_suffix = '', storeName = '', placement = 'default' } = req.body || {};
    if (!design || !Array.isArray(productIds) || !productIds.length) {
      return res.status(400).json({ error: 'design (data URL) + productIds[] required' });
    }
    try {
      const storeId = await nativeStoreId(token);
      if (!storeId) return res.status(400).json({ error: 'No native store for this account' });

      // 1) host the print file on GCS, 2) Printful ingests -> file_id
      const buf = Buffer.from(String(design).replace(/^data:image\/\w+;base64,/, ''), 'base64');
      let publicUrl;
      try { publicUrl = await hostOnGcs(buf); }
      catch (e) { return res.status(500).json({ error: 'GCS host failed: ' + String(e.message || e) }); }
      let ing;
      try {
        ing = await request('POST', '/files', token, null, { type: 'default', url: publicUrl, filename: 'mix-design.png', visible: true });
      } catch (e) {
        return res.status(500).json({ error: 'Printful file ingest failed: ' + String(e.message || e), publicUrl });
      }
      const fileId = ing.result && ing.result.id;
      if (!fileId) return res.status(500).json({ error: 'Printful file ingest failed', detail: ing, publicUrl });
      await pollFile(token, fileId);
      const { w: dW, h: dH } = pngSize(buf);

      // 3) create one sync product per chosen catalog product
      const results = [];
      const descAdds = {};
      let idx = 0;
      for (const pid of productIds) {
        try {
          const pr = await request('GET', `/products/${pid}`, token, null);
          const d = pr.result || {};
          const variants = (d.variants || []).slice(0, 100); // Printful caps sync products at 100 variants
          const prices = variants.map(v => parseFloat(v.price)).filter(n => n > 0);
          const retail = retailFrom(prices.length ? Math.min(...prices) : 0, markup);
          const title = (d.product && d.product.title) || `Product ${pid}`;
          const description = genDescription(title, d.product && d.product.type_name, storeName, idx++);
          const sync_variants = variants.map(v => ({
            variant_id: v.id,
            retail_price: retail,
            files: [{ type: placement, id: fileId }],
          }));
          const name = title + (name_suffix ? ` - ${name_suffix}` : '');
          const cr = await request('POST', '/store/products', token, storeId, {
            sync_product: { name, is_ignored: false },
            sync_variants,
          });
          const syncId = cr.result && cr.result.id;
          // Best-effort: real product mockup (design centered) -> set as thumbnail
          let mockup = null;
          try {
            const { placement: pl, area_w, area_h } = await placementArea(token, pid);
            mockup = await generateMockup(token, pid, variants[0].id, pl, publicUrl, dW, dH, area_w, area_h);
            if (mockup) await request('PUT', `/sync/products/${syncId}`, token, storeId, { sync_product: { thumbnail: mockup } });
          } catch (e) { /* keep product even if mockup fails */ }
          descAdds[syncId] = { pid, name, retail, description, design_url: publicUrl, mockup };
          results.push({ pid, ok: true, sync_id: syncId, name, retail, variants: sync_variants.length, description, mockup });
        } catch (e) {
          results.push({ pid, ok: false, error: String(e.message || e) });
        }
      }
      // persist descriptions/prices for the internal store/app (Printful native has no description field)
      try { await saveDescriptions(storeId, descAdds); } catch (e) { console.error('desc persist failed', e.message); }
      res.json({ ok: true, created: results.filter(r => r.ok).length, results });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Delete a published product from the store (management / cleanup)
  app.delete('/api/products/:id', async (req, res) => {
    const token = resolveAccount(req).token;
    try {
      const storeId = await nativeStoreId(token);
      await request('DELETE', `/sync/products/${req.params.id}`, token, storeId); // /store/ 500s on native; /sync/ works
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Internal catalog (our descriptions/prices keyed by sync_id) for the future internal store
  app.get('/api/listings', async (req, res) => {
    try {
      const storeId = await nativeStoreId(resolveAccount(req).token);
      res.json(await loadDescriptions(storeId));
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Shared catalog selection (server-side, per store) — the curated set everyone sees
  app.get('/api/selection', async (req, res) => {
    try {
      const storeId = await nativeStoreId(resolveAccount(req).token);
      res.json({ ids: await loadSelection(storeId) });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  app.post('/api/selection', async (req, res) => {
    try {
      const storeId = await nativeStoreId(resolveAccount(req).token);
      const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
      await bucket.file(`mix/selection-${storeId}.json`).save(JSON.stringify(ids), { contentType: 'application/json' });
      res.json({ ok: true, ids });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
}

async function loadSelection(storeId) {
  try { const [buf] = await bucket.file(`mix/selection-${storeId}.json`).download(); return JSON.parse(buf.toString()); }
  catch { return []; }
}

// Descriptions/prices persisted to GCS (our internal catalog; Printful native stores no description).
async function loadDescriptions(storeId) {
  try { const [buf] = await bucket.file(`mix/listings-${storeId}.json`).download(); return JSON.parse(buf.toString()); }
  catch { return {}; }
}
async function saveDescriptions(storeId, adds) {
  const cur = await loadDescriptions(storeId);
  Object.assign(cur, adds);
  await bucket.file(`mix/listings-${storeId}.json`).save(JSON.stringify(cur), { contentType: 'application/json' });
  return cur;
}

module.exports = { registerPublic, register };
