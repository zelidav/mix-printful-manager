// Printful catalog: full list + min/max blank pricing + categories. Ported from jb-printful-creator.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { request } = require('./printful');

const cache = new Map();
function memo(key, ttl, fn) {
  const h = cache.get(key), now = Date.now();
  if (h && h.exp > now) return Promise.resolve(h.v);
  return Promise.resolve(fn()).then(v => { cache.set(key, { v, exp: now + ttl }); return v; });
}

// Techniques that accept a raster design. Embroidery/knitwear-only blanks can't take our art → hide.
const PRINTABLE = new Set(['SUBLIMATION', 'DTFILM', 'UV', 'CUT-SEW', 'DIRECT-TO-FABRIC', 'DTG', 'DIGITAL']);
function embroideryOnly(p) {
  const arr = Array.isArray(p.techniques) ? p.techniques : [];
  const t = arr.map(x => String((x && (x.key || x.display_name)) || x || '').toUpperCase());
  return t.length > 0 && !t.some(x => PRINTABLE.has(x));
}

async function getList(token) {
  return memo('catalog:list', 24 * 3600e3, async () => (await request('GET', '/products', token, null)).result || []);
}
async function getCategories(token) {
  return memo('catalog:cats', 24 * 3600e3, async () => {
    const r = await request('GET', '/categories', token, null);
    return (r.result && r.result.categories) || r.result || [];
  });
}
async function mapLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  }));
}
async function getRetry(token, p, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { return await request('GET', p, token, null); }
    catch (e) {
      const msg = String(e.message || e);
      if (/429|rate limit/i.test(msg)) {
        const m = msg.match(/(\d+)\s*seconds?/);
        await new Promise(r => setTimeout(r, ((m ? +m[1] : 30) + 3) * 1000));
        continue;
      }
      throw e;
    }
  }
  return request('GET', p, token, null);
}

const PRICES_FILE = path.join(os.tmpdir(), 'mix_catalog_prices.json');
let pricesCache = null;
async function computePrices(token) {
  const list = (await getList(token)).filter(p => !embroideryOnly(p));
  const prices = {};
  await mapLimit(list, 6, async (p) => {
    try {
      const vmap = await memo(`price:${p.id}`, 6 * 3600e3, async () => {
        const r = await getRetry(token, `/products/${p.id}`);
        const out = {};
        for (const v of (r.result && r.result.variants || [])) { const n = parseFloat(v.price); if (n > 0) out[v.id] = n; }
        return out;
      });
      const vals = Object.values(vmap);
      if (vals.length) prices[p.id] = { min: Math.min(...vals), max: Math.max(...vals) };
    } catch { /* skip products that error */ }
  });
  return prices;
}

function register(app, resolveAccount) {
  app.get('/api/categories', async (req, res) => {
    try { res.json(await getCategories(resolveAccount(req).token)); }
    catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  app.get('/api/catalog', async (req, res) => {
    try {
      const list = await getList(resolveAccount(req).token);
      const items = list.filter(p => !embroideryOnly(p)).map(p => ({
        id: p.id, title: p.title, brand: p.brand, type: p.type, type_name: p.type_name,
        category: p.main_category_id, variants: p.variant_count, image: p.image,
        discontinued: !!p.is_discontinued,
      }));
      res.json({ count: items.length, items });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Min/max blank price per catalog product. First call is slow (one detail call per product),
  // then cached in-memory + /tmp. ?refresh=1 to recompute.
  app.get('/api/catalog/prices', async (req, res) => {
    try {
      const token = resolveAccount(req).token;
      if (req.query.refresh) pricesCache = null;
      if (!pricesCache) { try { pricesCache = JSON.parse(fs.readFileSync(PRICES_FILE, 'utf8')); } catch {} }
      if (!pricesCache) {
        pricesCache = await computePrices(token);
        try { fs.writeFileSync(PRICES_FILE, JSON.stringify(pricesCache)); } catch {}
      }
      res.json({ count: Object.keys(pricesCache).length, prices: pricesCache });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
}

module.exports = { register };
