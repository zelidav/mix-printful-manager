require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const { getProducts, getProduct, updateProduct, updateVariant, enrichWithWholesale, platformOf, getStoresLive } = require('./printful');
const { getAccount, publicList } = require('./accounts');

const app = express();
const upload = multer({ dest: require('os').tmpdir() }); // Cloud Run: only /tmp is writable
const APP_PASSWORD = process.env.APP_PASSWORD || 'MIXxiaolin!';
// Frontend (GitHub Pages) origin allowed to call this API. Comma-separated; '*' allows all.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://zelidav.github.io';

function getPlatform(storeId) { return platformOf(storeId); }

// --- Per-store routing: each MiX store is a separate Printful account with its own PAT ---
function resolveAccount(req) { return getAccount(req.headers['x-pf-account'] || req.query.account); }
async function accountStores(acct) { return await getStoresLive(acct.token); } // also seeds platform cache

// CORS for the static frontend on GitHub Pages
app.use((req, res, next) => {
  const allow = ALLOWED_ORIGIN.split(',').map(s => s.trim());
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', allow.includes('*') ? '*' : (allow.includes(origin) ? origin : allow[0]));
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Token, X-PF-Account');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

// Health check (Cloud Run root)
app.get('/', (req, res) => res.json({ ok: true, service: 'mix-printful-api' }));

// Password gate (API only — frontend is served by GitHub Pages)
function requireAuth(req, res, next) {
  if (req.path === '/api/login') return next();
  const token = req.headers['x-auth-token'] || req.query.token;
  if (token === APP_PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorized' });
}
app.post('/api/login', (req, res) => {
  if ((req.body || {}).password === APP_PASSWORD) return res.json({ success: true, token: APP_PASSWORD });
  res.status(401).json({ error: 'Wrong password' });
});

app.use(requireAuth);

// Printful catalog browser (full list + pricing + categories)
require('./catalog').register(app, resolveAccount);

// List the MiX stores (each backed by its own PAT) — no tokens exposed
app.get('/api/accounts', (req, res) => res.json(publicList()));

// Printful stores for the selected MiX store/account (live)
app.get('/api/stores', async (req, res) => {
  try {
    const acct = resolveAccount(req);
    if (!acct) return res.status(400).json({ error: 'No MiX stores configured' });
    res.json(await accountStores(acct));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List products for a store
app.get('/api/stores/:storeId/products', async (req, res) => {
  try {
    const acct = resolveAccount(req);
    const TOKEN = acct.token;
    await accountStores(acct); // ensure platform cache is populated for this PAT
    const products = await getProducts(TOKEN, req.params.storeId);
    const detailed = await Promise.all(products.map((p) => getProduct(TOKEN, req.params.storeId, p.id)));
    await Promise.all(detailed.map(d => enrichWithWholesale(TOKEN, d.sync_variants)));
    res.json(detailed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save a single product (native stores → Printful API)
app.post('/api/stores/:storeId/save/:productIndex', async (req, res) => {
  const { storeId } = req.params;
  const { name, description, retail_price, sync_product_id, variants } = req.body;
  const acct = resolveAccount(req);
  const TOKEN = acct.token;
  try {
    await accountStores(acct);
    const platform = getPlatform(storeId);
    if (platform === 'native') {
      if (name || description) {
        await updateProduct(TOKEN, storeId, sync_product_id, { sync_product: { name, description } });
      }
      if (retail_price && variants) {
        for (const v of variants) {
          await updateVariant(TOKEN, storeId, v.id, { retail_price: parseFloat(retail_price).toFixed(2) });
        }
      }
      res.json({ success: true, platform: 'native' });
    } else {
      res.status(400).json({ error: `Saving not supported for ${platform || 'this'} store type in MiX yet.` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Push updates from CSV/table — native stores, match by external_id then name
app.post('/api/push-all', async (req, res) => {
  const { updates, storeId } = req.body;
  const acct = resolveAccount(req);
  const TOKEN = acct.token;
  const results = { success: [], errors: [] };
  try {
    const allStores = await accountStores(acct);
    const targetStores = storeId ? allStores.filter(s => s.id === Number(storeId)) : allStores;
    for (const store of targetStores) {
      const platform = getPlatform(store.id);
      if (platform !== 'native') {
        results.errors.push({ store: store.name, error: `MiX push supports native stores only (got ${platform})` });
        continue;
      }
      try {
        const products = await getProducts(TOKEN, store.id);
        for (const update of updates) {
          const match = update.external_id
            ? products.find(p => String(p.external_id) === String(update.external_id))
            : products.find(p => p.name.trim().toLowerCase() === (update.product_name || '').trim().toLowerCase());
          if (!match) continue;
          try {
            if (update.description || update.product_name) {
              await updateProduct(TOKEN, store.id, match.id, {
                sync_product: { name: update.product_name || match.name, description: update.description || '' },
              });
            }
            const price = update.retail_price || update.printful_retail;
            if (price) {
              const full = await getProduct(TOKEN, store.id, match.id);
              for (const variant of full.sync_variants) {
                await updateVariant(TOKEN, store.id, variant.id, { retail_price: parseFloat(price).toFixed(2) });
              }
            }
            results.success.push({ store: store.name, product: match.name });
          } catch (err) {
            results.errors.push({ store: store.name, product: match.name, error: err.message });
          }
        }
      } catch (err) {
        results.errors.push({ store: store.name, error: err.message });
      }
    }
  } catch (err) {
    results.errors.push({ error: err.message });
  }
  res.json(results);
});

// CSV upload — parse and return data for preview
app.post('/api/csv/upload', upload.single('file'), (req, res) => {
  try {
    const content = require('fs').readFileSync(req.file.path, 'utf-8');
    require('fs').unlinkSync(req.file.path);
    const records = parse(content, { columns: true, skip_empty_lines: true, trim: true });
    const cleaned = records.map(row => {
      const out = {};
      for (let [key, val] of Object.entries(row)) {
        key = key.trim();
        if (!key) continue;
        val = (val || '').trim();
        if (val.startsWith('$')) val = val.slice(1);
        out[key] = val;
      }
      return out;
    });
    res.json(cleaned);
  } catch (err) {
    res.status(400).json({ error: 'Failed to parse CSV: ' + err.message });
  }
});

// CSV export — pull current products from a store
app.get('/api/stores/:storeId/export', async (req, res) => {
  try {
    const acct = resolveAccount(req);
    const TOKEN = acct.token;
    await accountStores(acct);
    const products = await getProducts(TOKEN, req.params.storeId);
    const detailed = await Promise.all(products.map((p) => getProduct(TOKEN, req.params.storeId, p.id)));
    await Promise.all(detailed.map(d => enrichWithWholesale(TOKEN, d.sync_variants)));
    const rows = [];
    for (const d of detailed) {
      for (const v of d.sync_variants) {
        rows.push({
          product_name: d.sync_product.name,
          variant_name: v.name,
          size: v.size || '',
          color: v.color || '',
          sku: v.sku || '',
          wholesale_price: v.wholesale_price || '',
          printful_retail: v.retail_price || '',
          description: d.sync_product.description || '',
          external_id: d.sync_product.external_id || '',
          variant_id: v.id,
        });
      }
    }
    const csv = stringify(rows, { header: true, bom: true });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=mix_products_${req.params.storeId}.csv`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`MiX Printful API running on :${PORT}`));
