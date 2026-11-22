import type {
  CartAddRequest,
  CartAddResult,
  CartLine,
  Condition,
  Listing,
  Product,
  ProductId,
  ProgressFn,
  SellerShipping,
  TcgApi,
} from '@/core/types';
import { type Envelope, TcgHttpError, errorText, tcgFetch, unwrap } from './http';
import {
  type RawListing,
  type RawProduct,
  type RawSellerShipping,
  toCondition,
  toListing,
  toProduct,
  toSellerShipping,
} from './mappers';

const SEARCH = 'https://mp-search-api.tcgplayer.com/v1';
const MPAPI = 'https://mpapi.tcgplayer.com/v2';
const GATEWAY = 'https://mpgateway.tcgplayer.com/v1';
const COUNTRY = 'US';
const PAGE = 50;
const SELLER_BATCH = 100;

const liveListingFilters = {
  term: { sellerStatus: 'Live', channelId: 0 },
  range: { quantity: { gte: 1 } },
  exclude: { channelExclusion: 0 },
};

function cartKey(): string {
  const key = document.cookie.match(/(?:^|;\s*)StoreCart_PRODUCTION=[^;]*?CK=([0-9a-f]+)/i)?.[1];
  if (!key) throw new Error('No TCGplayer cart found. Open your TCGplayer cart page once, then try again.');
  return key;
}

interface RawCartItem {
  sku: number;
  quantity: number;
  currentPrice: number;
  sellerId: number;
  sellerKey: string;
}

interface RawSkuProduct {
  sku: number;
  productId: number;
  productName: string;
  setName: string;
  condition: string;
  printing: string;
  collectorNumber: string | null;
}

interface RawAddResult {
  itemQuantityInCart: number;
  currentPrice: number;
  status: number;
}

/** 200 products covers every printing of even heavily reprinted staples. */
const MAX_SEARCH_PAGES = 4;

async function searchProducts(query: string): Promise<Product[]> {
  const url = `${SEARCH}/search/request?q=${encodeURIComponent(query)}&isList=false`;
  const products: Product[] = [];
  for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
    const envelope = await tcgFetch<Envelope<{ totalResults: number; results: RawProduct[] }>>(url, {
      method: 'POST',
      body: {
        algorithm: 'sales_dismax',
        from: page * PAGE,
        size: PAGE,
        filters: { term: { productLineName: ['pokemon'] }, range: {}, match: {} },
        listingSearch: { context: { cart: {} }, filters: liveListingFilters },
        context: { cart: {}, shippingCountry: COUNTRY, userProfile: {} },
        settings: { useFuzzySearch: false, didYouMean: {} },
        sort: {},
      },
    });
    const result = unwrap('search', envelope);
    products.push(...result.results.map(toProduct));
    if (result.results.length < PAGE || products.length >= result.totalResults) break;
  }
  return products;
}

async function getProducts(productIds: ProductId[]): Promise<Product[]> {
  return Promise.all(
    [...new Set(productIds)].map(async (id) => toProduct(await tcgFetch<RawProduct>(`${SEARCH}/product/${id}/details`))),
  );
}

function listingPage(productId: ProductId, from: number, conditions: Condition[]) {
  return tcgFetch<Envelope<{ totalResults: number; results: RawListing[] }>>(`${SEARCH}/product/${productId}/listings`, {
    method: 'POST',
    body: {
      filters: { ...liveListingFilters, term: { ...liveListingFilters.term, language: ['English'], condition: conditions } },
      from,
      size: PAGE,
      sort: { field: 'price+shipping', order: 'asc' },
      context: { shippingCountry: COUNTRY, cart: {} },
      aggregations: ['listingType'],
    },
  }).then((envelope) => unwrap('listings', envelope));
}

/**
 * Every listing of the given products. The API caps pages at 50, and common
 * cards have thousands of listings, so after each product's first page (which
 * reveals its total) the remaining pages are requested concurrently.
 */
async function fetchListings(
  productIds: ProductId[],
  filter: { conditions: Condition[] },
  onProgress?: ProgressFn,
): Promise<Listing[]> {
  const ids = [...new Set(productIds)];
  let done = 0;
  let total = ids.length;
  const report = () => onProgress?.({ phase: 'listings', done, total });
  report();
  const perProduct = await Promise.all(
    ids.map(async (id) => {
      const first = await listingPage(id, 0, filter.conditions);
      const more = Math.max(0, Math.ceil(first.totalResults / PAGE) - 1);
      done++;
      total += more;
      report();
      const rest = await Promise.all(
        Array.from({ length: more }, async (_, i) => {
          const page = await listingPage(id, (i + 1) * PAGE, filter.conditions);
          done++;
          report();
          return page.results;
        }),
      );
      return [first.results, ...rest].flat();
    }),
  );
  // Listings can shift between pages while we read them; keep each once.
  const unique = new Map<number, RawListing>();
  for (const raw of perProduct.flat()) unique.set(raw.listingId, raw);
  return [...unique.values()].map(toListing);
}

async function fetchSellerShipping(sellerIds: number[], onProgress?: ProgressFn): Promise<SellerShipping[]> {
  const ids = [...new Set(sellerIds)];
  const batches: number[][] = [];
  for (let i = 0; i < ids.length; i += SELLER_BATCH) batches.push(ids.slice(i, i + SELLER_BATCH));
  let done = 0;
  onProgress?.({ phase: 'sellers', done, total: ids.length });
  const results = await Promise.all(
    batches.map(async (batch) => {
      const envelope = await tcgFetch<Envelope<RawSellerShipping[]>>(
        `${MPAPI}/seller/shippinginfo?countryCode=${COUNTRY}`,
        { method: 'POST', body: batch.map((sellerId) => ({ sellerId, largestShippingCategoryId: 1 })) },
      );
      const rules = unwrap('seller shipping', envelope).flatMap((raw) => toSellerShipping(raw) ?? []);
      done += batch.length;
      onProgress?.({ phase: 'sellers', done, total: ids.length });
      return rules;
    }),
  );
  return results.flat();
}

async function readCart(): Promise<CartLine[]> {
  const key = cartKey();
  const envelope = await tcgFetch<Envelope<{ cartItems: RawCartItem[] }>>(
    `${GATEWAY}/cart/${key}/validatecart?validateForCheckout=false&countryCode=${COUNTRY}`,
    { method: 'POST' },
  );
  const items = unwrap('cart', envelope).cartItems;
  if (items.length === 0) return [];

  const [skuEnvelope, sellers] = await Promise.all([
    tcgFetch<Envelope<RawSkuProduct[]>>(`${SEARCH}/product/getProductForSkus`, {
      method: 'POST',
      body: [...new Set(items.map((i) => i.sku))],
    }),
    fetchSellerShipping(items.map((i) => i.sellerId)),
  ]);
  const products = new Map(unwrap('cart products', skuEnvelope).map((p) => [p.sku, p]));
  const sellerNames = new Map(sellers.map((s) => [s.sellerId, s.name]));

  return items.map((item) => {
    const product = products.get(item.sku);
    if (!product) throw new TcgHttpError('cart products', 200, `no product for SKU ${item.sku}`);
    return {
      sku: item.sku,
      productId: product.productId,
      sellerId: item.sellerId,
      sellerKey: item.sellerKey,
      sellerName: sellerNames.get(item.sellerId) ?? item.sellerKey,
      name: product.productName,
      setName: product.setName,
      number: product.collectorNumber,
      condition: toCondition(product.condition),
      printing: product.printing,
      quantity: item.quantity,
      price: item.currentPrice,
    };
  });
}

async function clearCart(): Promise<void> {
  await tcgFetch(`${GATEWAY}/cart/${cartKey()}/items/all`, { method: 'DELETE' });
}

async function addToCart(items: CartAddRequest[], onProgress?: ProgressFn): Promise<CartAddResult[]> {
  const key = cartKey();
  const results: CartAddResult[] = [];
  onProgress?.({ phase: 'cart', done: 0, total: items.length });
  // Sequential: concurrent adds to one cart race on TCGplayer's side.
  for (const request of items) {
    try {
      const envelope = await tcgFetch<Envelope<RawAddResult>>(`${GATEWAY}/cart/${key}/item/add`, {
        method: 'POST',
        body: {
          sku: request.sku,
          sellerKey: request.sellerKey,
          channelId: 0,
          requestedQuantity: request.quantity,
          price: request.price,
          isDirect: false,
          countryCode: COUNTRY,
        },
      });
      const result = envelope.results?.[0];
      const error = errorText(envelope.errors);
      results.push({
        request,
        ok: !error && result?.status === 0,
        quantityInCart: result?.itemQuantityInCart ?? 0,
        currentPrice: result && result.currentPrice > 0 ? result.currentPrice : null,
        error: error ?? (result?.status === 0 ? null : `status ${result?.status ?? 'missing'}`),
      });
    } catch (error) {
      results.push({
        request,
        ok: false,
        quantityInCart: 0,
        currentPrice: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    onProgress?.({ phase: 'cart', done: results.length, total: items.length });
  }
  return results;
}

export function createTcgApi(): TcgApi {
  return { readCart, searchProducts, getProducts, fetchListings, fetchSellerShipping, clearCart, addToCart };
}
