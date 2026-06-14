/**
 * RATTIB Auto-Import Script
 * Pulls products from CJ Dropshipping, filters by lowest shipping to Saudi Arabia,
 * calculates SAR prices, and creates products in Shopify.
 *
 * Usage:
 *   node import-catalog.js                        # import all categories
 *   node import-catalog.js --category=kitchen     # import one category
 *   node import-catalog.js --max=5                # limit products per keyword
 *   node import-catalog.js --dry-run              # preview only, no Shopify writes
 *
 * Setup:
 *   1. Copy .env.example to .env and fill in credentials
 *   2. npm install
 *   3. node import-catalog.js --dry-run
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createWriteStream } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env manually (avoid requiring dotenv if not installed yet)
function loadEnv() {
  const envPath = join(__dirname, '.env');
  if (!existsSync(envPath)) {
    console.error('❌  Missing tools/.env file. Copy .env.example → .env and fill in credentials.');
    process.exit(1);
  }
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  }
}

// ── Config ────────────────────────────────────────────────────────────────────
loadEnv();

const CJ_BASE      = 'https://developers.cjdropshipping.com';
const SHOPIFY_BASE = `https://${process.env.SHOPIFY_SHOP}/admin/api/2024-01`;
const MARKUP       = parseFloat(process.env.MARKUP       || '2.5');
const USD_TO_SAR   = parseFloat(process.env.USD_TO_SAR   || '3.75');
const MAX_SHIP_USD = parseFloat(process.env.MAX_SHIPPING_USD || '8');

const args         = process.argv.slice(2);
const DRY_RUN      = args.includes('--dry-run');
const MAX_PER_KW   = parseInt(args.find(a => a.startsWith('--max='))?.split('=')[1] || '10');
const ONLY_CAT     = args.find(a => a.startsWith('--category='))?.split('=')[1];

const CATEGORIES   = JSON.parse(readFileSync(join(__dirname, 'categories.json'), 'utf8'));
const IMPORTED_FILE = join(__dirname, 'imported.json');
const LOG_FILE      = join(__dirname, 'import-log.csv');

// ── State ─────────────────────────────────────────────────────────────────────
let cjToken = null;
let imported = existsSync(IMPORTED_FILE) ? JSON.parse(readFileSync(IMPORTED_FILE, 'utf8')) : {};
const logRows = [];

// ── Helpers ───────────────────────────────────────────────────────────────────
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sarPrice(productUsd, shippingUsd) {
  const total = (productUsd + shippingUsd) * MARKUP * USD_TO_SAR;
  return Math.ceil(total);
}

function sarCompare(price) { return Math.ceil(price * 1.3); }

// ── CJ Auth ───────────────────────────────────────────────────────────────────
async function cjAuth() {
  const res = await fetch(`${CJ_BASE}/api2.0/v1/authentication/getAccessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.CJ_EMAIL, password: process.env.CJ_API_KEY }),
  });
  const data = await res.json();
  if (!data.data?.accessToken) {
    console.error('❌  CJ auth failed:', JSON.stringify(data));
    process.exit(1);
  }
  cjToken = data.data.accessToken;
  console.log('✅  CJ Dropshipping authenticated');
}

async function cjGet(path, params = {}) {
  const url = new URL(`${CJ_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { 'CJ-Access-Token': cjToken } });
  if (res.status === 401) { await cjAuth(); return cjGet(path, params); }
  return res.json();
}

async function cjPost(path, body) {
  const res = await fetch(`${CJ_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CJ-Access-Token': cjToken },
    body: JSON.stringify(body),
  });
  if (res.status === 401) { await cjAuth(); return cjPost(path, body); }
  return res.json();
}

// ── Shipping ──────────────────────────────────────────────────────────────────
async function getMinShipping(productWeight) {
  const weight = productWeight || 0.3; // kg default
  const data = await cjPost('/api2.0/v1/logistic/freightCalculate', {
    startCountryCode: 'CN',
    endCountryCode: 'SA',
    quantity: 1,
    weight,
  });
  if (!data.data?.length) return null;
  // Sort by logisticPrice ascending, pick cheapest
  const options = data.data
    .filter(o => o.logisticPrice != null)
    .sort((a, b) => a.logisticPrice - b.logisticPrice);
  if (!options.length) return null;
  return {
    method: options[0].logisticName,
    costUsd: options[0].logisticPrice,
    days: options[0].logisticTime || '7-15',
  };
}

// ── Product Search ────────────────────────────────────────────────────────────
async function searchProducts(keyword) {
  const results = [];
  let page = 1;
  while (results.length < MAX_PER_KW) {
    const data = await cjGet('/api2.0/v1/product/list', {
      productNameEn: keyword,
      countryCode: 'SA',
      pageNum: page,
      pageSize: 20,
    });
    const list = data.data?.list || [];
    if (!list.length) break;
    results.push(...list);
    if (list.length < 20) break;
    page++;
    await sleep(300); // rate limiting
  }
  return results.slice(0, MAX_PER_KW);
}

// ── Product Detail ────────────────────────────────────────────────────────────
async function getProductDetail(pid) {
  const data = await cjGet('/api2.0/v1/product/query', { pid });
  return data.data;
}

// ── Shopify Create ────────────────────────────────────────────────────────────
async function shopifyCreate(product) {
  const res = await fetch(`${SHOPIFY_BASE}/products.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
    },
    body: JSON.stringify({ product }),
  });
  const data = await res.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data.product;
}

// ── Build Shopify Payload ──────────────────────────────────────────────────────
function buildShopifyProduct(detail, shipping, categoryTag) {
  const variants = (detail.variants || []).map(v => {
    const price = sarPrice(v.variantSellPrice || detail.sellPrice || 0, shipping.costUsd);
    return {
      sku: v.vid,
      option1: v.variantProperty || null,
      price: price.toFixed(2),
      compare_at_price: sarCompare(price).toFixed(2),
      inventory_management: null, // no inventory tracking for dropship
    };
  });

  if (!variants.length) {
    const price = sarPrice(detail.sellPrice || 0, shipping.costUsd);
    variants.push({
      sku: detail.pid,
      price: price.toFixed(2),
      compare_at_price: sarCompare(price).toFixed(2),
      inventory_management: null,
    });
  }

  const images = (detail.productImageSet || '').split(',')
    .filter(Boolean)
    .map(src => ({ src: src.trim() }));

  const deliveryNote = `\n<p>🚚 يصلك خلال ${shipping.days} يوم · شحن متتبع</p>`;

  return {
    title: detail.productNameEn,
    body_html: (detail.description || '') + deliveryNote,
    vendor: 'CJ Dropshipping',
    product_type: categoryTag,
    tags: categoryTag,
    status: 'draft', // publish manually after review
    variants,
    images,
    options: variants[0]?.option1
      ? [{ name: 'النوع', values: variants.map(v => v.option1).filter(Boolean) }]
      : [],
  };
}

// ── Process One Category ───────────────────────────────────────────────────────
async function processCategory(cat) {
  console.log(`\n📦  Category: ${cat.labelAr} (${cat.id})`);
  const seen = new Set();

  for (const keyword of cat.keywords) {
    console.log(`  🔍  Searching: "${keyword}"`);
    let products;
    try { products = await searchProducts(keyword); }
    catch (e) { console.warn('    ⚠️  Search failed:', e.message); continue; }

    for (const p of products) {
      if (seen.has(p.pid) || imported[p.pid]) { continue; }
      seen.add(p.pid);

      // Get shipping estimate
      let shipping;
      try { shipping = await getMinShipping(p.productWeight); }
      catch (e) { shipping = null; }

      if (!shipping) {
        console.log(`    ⏩  ${p.productNameEn?.slice(0, 50)} — no shipping data, skipping`);
        logRows.push([cat.id, p.productNameEn, p.pid, 'N/A', 'N/A', '', 'no_shipping']);
        continue;
      }

      if (shipping.costUsd > MAX_SHIP_USD) {
        console.log(`    ⏩  ${p.productNameEn?.slice(0, 50)} — shipping $${shipping.costUsd} > $${MAX_SHIP_USD}, skip`);
        logRows.push([cat.id, p.productNameEn, p.pid, shipping.costUsd, 'N/A', '', 'too_expensive']);
        continue;
      }

      const price = sarPrice(p.sellPrice || 0, shipping.costUsd);
      console.log(`    ✅  ${p.productNameEn?.slice(0, 50)}`);
      console.log(`        CJ: $${p.sellPrice} + ship $${shipping.costUsd} (${shipping.method}) → ${price} ر.س`);

      if (!DRY_RUN) {
        try {
          const detail = await getProductDetail(p.pid);
          await sleep(500);
          const payload = buildShopifyProduct(detail, shipping, cat.labelAr);
          const created = await shopifyCreate(payload);
          imported[p.pid] = { shopifyId: created.id, createdAt: new Date().toISOString() };
          writeFileSync(IMPORTED_FILE, JSON.stringify(imported, null, 2));
          logRows.push([cat.id, p.productNameEn, p.pid, shipping.costUsd, price, created.id, 'created']);
          console.log(`        → Shopify product #${created.id} created (draft)`);
          await sleep(500); // Shopify rate limit
        } catch (e) {
          console.error(`        ❌  Shopify error: ${e.message}`);
          logRows.push([cat.id, p.productNameEn, p.pid, shipping.costUsd, price, '', 'error']);
        }
      } else {
        logRows.push([cat.id, p.productNameEn, p.pid, shipping.costUsd, price, '', 'dry_run']);
      }

      await sleep(300);
    }
  }
}

// ── CSV Log ───────────────────────────────────────────────────────────────────
function writeLog() {
  const header = 'category,title,cj_id,shipping_usd,sar_price,shopify_id,status\n';
  const rows = logRows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  writeFileSync(LOG_FILE, header + rows);
  console.log(`\n📄  Log written to tools/import-log.csv`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  RATTIB Auto-Import — CJ → Shopify');
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (no Shopify writes)' : 'LIVE'}`);
  console.log(`  Max per keyword: ${MAX_PER_KW}`);
  console.log(`  Max shipping: $${MAX_SHIP_USD}`);
  console.log(`  Markup: ${MARKUP}× | 1 USD = ${USD_TO_SAR} SAR`);
  console.log('═══════════════════════════════════════════\n');

  if (!process.env.CJ_EMAIL || !process.env.CJ_API_KEY) {
    console.error('❌  Missing CJ_EMAIL or CJ_API_KEY in .env');
    process.exit(1);
  }
  if (!DRY_RUN && (!process.env.SHOPIFY_SHOP || !process.env.SHOPIFY_ACCESS_TOKEN)) {
    console.error('❌  Missing SHOPIFY_SHOP or SHOPIFY_ACCESS_TOKEN in .env');
    process.exit(1);
  }

  await cjAuth();

  const cats = ONLY_CAT
    ? CATEGORIES.filter(c => c.id === ONLY_CAT)
    : CATEGORIES;

  if (!cats.length) {
    console.error(`❌  Unknown category: ${ONLY_CAT}. Valid: ${CATEGORIES.map(c => c.id).join(', ')}`);
    process.exit(1);
  }

  for (const cat of cats) {
    await processCategory(cat);
  }

  writeLog();

  const created = logRows.filter(r => r[6] === 'created' || r[6] === 'dry_run').length;
  const skipped = logRows.filter(r => r[6] === 'too_expensive').length;
  console.log(`\n✅  Done! ${created} products ${DRY_RUN ? 'found' : 'imported'}, ${skipped} skipped (expensive shipping)`);
  if (DRY_RUN) console.log('   Run without --dry-run to actually import to Shopify.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
