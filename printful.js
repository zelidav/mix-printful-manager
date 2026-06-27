const https = require('https');

const API_BASE = 'api.printful.com';

// MiX stores are discovered live per account (each account = its own PAT). No static list.
const STORES = [];

// Platform cache (storeId -> 'native' | 'woocommerce' | 'shopify'), populated from live /stores fetches.
const _platformById = {};

function isNative(storeId) {
  const p = _platformById[Number(storeId)];
  if (p) return p === 'native';
  return false;
}

function platformOf(storeId) { return _platformById[Number(storeId)]; }

// Fetch the live store list for a given token/PAT (works for any Printful account).
async function getStoresLive(token) {
  const res = await request('GET', '/stores', token, null);
  const stores = (res.result || []).map(s => ({ id: s.id, name: s.name, platform: s.type }));
  for (const s of stores) _platformById[s.id] = s.platform;
  return stores;
}

function request(method, path, token, storeId, body = null) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (storeId) headers['X-PF-Store-Id'] = storeId;

    const opts = { hostname: API_BASE, path, method, headers };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.code >= 400) reject(new Error(parsed.result || parsed.error?.message || data));
          else resolve(parsed);
        } catch { reject(new Error(data)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Fetch all products for a store (paginated)
// Native stores use /store/products, platform stores use /sync/products
async function getProducts(token, storeId) {
  const prefix = isNative(storeId) ? '/store' : '/sync';
  const products = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const res = await request('GET', `${prefix}/products?offset=${offset}&limit=${limit}`, token, storeId);
    products.push(...res.result);
    if (offset + limit >= res.paging.total) break;
    offset += limit;
  }
  return products;
}

// Fetch single product with variants
async function getProduct(token, storeId, productId) {
  const prefix = isNative(storeId) ? '/store' : '/sync';
  const res = await request('GET', `${prefix}/products/${productId}`, token, storeId);
  return res.result;
}

// Update product (name/description) — only works on Native stores
async function updateProduct(token, storeId, productId, data) {
  if (!isNative(storeId)) {
    throw new Error('Product name/description can only be updated on Native/API stores. Update via Shopify or WooCommerce directly.');
  }
  const res = await request('PUT', `/store/products/${productId}`, token, storeId, data);
  return res.result;
}

// Update variant (retail price)
async function updateVariant(token, storeId, variantId, data) {
  const prefix = isNative(storeId) ? '/store' : '/sync';
  const res = await request('PUT', `${prefix}/variants/${variantId}`, token, storeId, data);
  return res.result;
}

// Fetch catalog product to get wholesale prices per variant
const catalogCache = {};
async function getCatalogProduct(token, catalogProductId) {
  if (catalogCache[catalogProductId]) return catalogCache[catalogProductId];
  const res = await request('GET', `/products/${catalogProductId}`, token, null);
  catalogCache[catalogProductId] = res.result;
  return res.result;
}

// Enrich sync variants with wholesale_price from catalog
async function enrichWithWholesale(token, syncVariants) {
  const catalogIds = [...new Set(syncVariants.map(v => v.product?.product_id).filter(Boolean))];
  const catalogs = {};
  await Promise.all(catalogIds.map(async id => {
    catalogs[id] = await getCatalogProduct(token, id);
  }));
  for (const sv of syncVariants) {
    const catProduct = catalogs[sv.product?.product_id];
    if (catProduct) {
      const catVariant = catProduct.variants.find(cv => cv.id === sv.variant_id);
      sv.wholesale_price = catVariant?.price || null;
    }
  }
  return syncVariants;
}

module.exports = { STORES, isNative, platformOf, getStoresLive, getProducts, getProduct, updateProduct, updateVariant, enrichWithWholesale, request };
