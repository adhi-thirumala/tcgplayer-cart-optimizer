import { Effect, Schema } from 'effect';
import { HttpClientRequest } from 'effect/http';
import {
  type CartAddRequest,
  type CartAddResult,
  type CartLine,
  type Condition,
  type Listing,
  type Product,
  ProductId,
  type Progress,
  type Seller,
  SellerId,
  SellerKey,
  Sku,
} from '@/core/domain';
import { TcgError, TcgHttp, envelopeErrors } from './http';
import { RawListing, RawProduct, RawSeller, toListing, toProduct, toSeller } from './mappers';

const SEARCH = 'https://mp-search-api.tcgplayer.com/v1';
const MPAPI = 'https://mpapi.tcgplayer.com/v2';
const GATEWAY = 'https://mpgateway.tcgplayer.com/v1';
const COUNTRY = 'US';
const PAGE = 50;
const SELLER_BATCH = 100;
/** 200 products covers every printing of even heavily reprinted staples. */
const MAX_SEARCH_PAGES = 4;

type Report = (progress: Progress) => Effect.Effect<void>;

const liveListingFilters = {
  term: { sellerStatus: 'Live', channelId: 0 },
  range: { quantity: { gte: 1 } },
  exclude: { channelExclusion: 0 },
};

const post = (url: string, body: unknown) => HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body));

const cartKey = Effect.suspend(() => {
  const key = document.cookie.match(/(?:^|;\s*)StoreCart_PRODUCTION=[^;]*?CK=([0-9a-f]+)/i)?.[1];
  return key
    ? Effect.succeed(key)
    : Effect.fail(new TcgError({ message: 'No TCGplayer cart found. Open your TCGplayer cart page once, then try again.' }));
});

const SearchPage = Schema.Struct({ totalResults: Schema.Int, results: Schema.Array(RawProduct) });
const ListingPage = Schema.Struct({ totalResults: Schema.Int, results: Schema.Array(RawListing) });

export const searchProducts = Effect.fn('searchProducts')(function* (query: string) {
  const http = yield* TcgHttp;
  const url = `${SEARCH}/search/request?q=${encodeURIComponent(query)}&isList=false`;
  const products: Product[] = [];
  for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
    const result = yield* http.first(
      'search',
      post(url, {
        algorithm: 'sales_dismax',
        from: page * PAGE,
        size: PAGE,
        filters: { term: { productLineName: ['pokemon'] }, range: {}, match: {} },
        listingSearch: { context: { cart: {} }, filters: liveListingFilters },
        context: { cart: {}, shippingCountry: COUNTRY, userProfile: {} },
        settings: { useFuzzySearch: false, didYouMean: {} },
        sort: {},
      }),
      SearchPage,
    );
    products.push(...result.results.map(toProduct));
    if (result.results.length < PAGE || products.length >= result.totalResults) break;
  }
  return products;
});

export const getProducts = Effect.fn('getProducts')(function* (productIds: readonly ProductId[]) {
  const http = yield* TcgHttp;
  return yield* Effect.forEach(
    new Set(productIds),
    (id) => http.json('product details', HttpClientRequest.get(`${SEARCH}/product/${id}/details`), RawProduct).pipe(Effect.map(toProduct)),
    { concurrency: 'unbounded' },
  );
});

/**
 * Every listing of the given products. Pages hold at most 50 listings and
 * common cards have thousands, so the first page of each product reveals its
 * total and the remaining pages are then requested concurrently.
 */
export const fetchListings = Effect.fn('fetchListings')(function* (
  productIds: readonly ProductId[],
  conditions: readonly Condition[],
  report: Report,
) {
  const http = yield* TcgHttp;
  const listingPage = (productId: ProductId, from: number) =>
    http.first(
      'listings',
      post(`${SEARCH}/product/${productId}/listings`, {
        filters: { ...liveListingFilters, term: { ...liveListingFilters.term, language: ['English'], condition: conditions } },
        from,
        size: PAGE,
        sort: { field: 'price+shipping', order: 'asc' },
        context: { shippingCountry: COUNTRY, cart: {} },
        aggregations: ['listingType'],
      }),
      ListingPage,
    );

  const ids = [...new Set(productIds)];
  let done = 0;
  let total = ids.length;
  const advance = (pages: number) =>
    Effect.suspend(() => {
      done++;
      total += pages;
      return report({ _tag: 'Progress', phase: 'listings', done, total });
    });

  yield* report({ _tag: 'Progress', phase: 'listings', done, total });
  const perProduct = yield* Effect.forEach(
    ids,
    (id) =>
      Effect.gen(function* () {
        const first = yield* listingPage(id, 0);
        const more = Math.max(0, Math.ceil(first.totalResults / PAGE) - 1);
        yield* advance(more);
        const rest = yield* Effect.forEach(
          Array.from({ length: more }, (_, i) => (i + 1) * PAGE),
          (from) => listingPage(id, from).pipe(Effect.tap(() => advance(0))),
          { concurrency: 'unbounded' },
        );
        return [first, ...rest].flatMap((page) => page.results);
      }),
    { concurrency: 'unbounded' },
  );
  // Listings shift between pages while they are read; keep each once.
  const unique = new Map(perProduct.flat().map((raw) => [raw.listingId, raw]));
  return [...unique.values()].map(toListing) satisfies Listing[];
});

export const fetchSellers = Effect.fn('fetchSellers')(function* (sellerIds: readonly SellerId[], report: Report) {
  const http = yield* TcgHttp;
  const ids = [...new Set(sellerIds)];
  const batches = Array.from({ length: Math.ceil(ids.length / SELLER_BATCH) }, (_, i) => ids.slice(i * SELLER_BATCH, (i + 1) * SELLER_BATCH));
  let done = 0;
  yield* report({ _tag: 'Progress', phase: 'sellers', done, total: ids.length });
  const perBatch = yield* Effect.forEach(
    batches,
    (batch) =>
      http
        .first(
          'seller shipping',
          post(
            `${MPAPI}/seller/shippinginfo?countryCode=${COUNTRY}`,
            batch.map((sellerId) => ({ sellerId, largestShippingCategoryId: 1 })),
          ),
          Schema.Array(RawSeller),
        )
        .pipe(
          Effect.tap(() => {
            done += batch.length;
            return report({ _tag: 'Progress', phase: 'sellers', done, total: ids.length });
          }),
        ),
    { concurrency: 'unbounded' },
  );
  return perBatch.flat().flatMap((raw): Seller[] => {
    const seller = toSeller(raw);
    return seller ? [seller] : [];
  });
});

const RawCart = Schema.Struct({
  cartItems: Schema.Array(
    Schema.Struct({ sku: Sku, quantity: Schema.Int, currentPrice: Schema.Number, sellerId: SellerId, sellerKey: SellerKey }),
  ),
});
const RawSkuProduct = Schema.Struct({ sku: Sku, productId: ProductId, printing: Schema.String });

export const readCart = Effect.gen(function* () {
  const http = yield* TcgHttp;
  const key = yield* cartKey;
  const { cartItems } = yield* http.first(
    'cart',
    HttpClientRequest.post(`${GATEWAY}/cart/${key}/validatecart?validateForCheckout=false&countryCode=${COUNTRY}`),
    RawCart,
  );
  if (cartItems.length === 0) return [];
  const skus = yield* http.first(
    'cart products',
    post(`${SEARCH}/product/getProductForSkus`, [...new Set(cartItems.map((i) => i.sku))]),
    Schema.Array(RawSkuProduct),
  );
  const bySku = new Map(skus.map((p) => [p.sku, p]));
  return yield* Effect.forEach(cartItems, (item) => {
    const product = bySku.get(item.sku);
    return product
      ? Effect.succeed<CartLine>({
          productId: product.productId,
          sellerId: item.sellerId,
          printing: product.printing,
          quantity: item.quantity,
          price: item.currentPrice,
        })
      : Effect.fail(new TcgError({ message: `TCGplayer cart products failed: no product for SKU ${item.sku}` }));
  });
}).pipe(Effect.withSpan('readCart'));

export const clearCart = Effect.gen(function* () {
  const http = yield* TcgHttp;
  const key = yield* cartKey;
  yield* http.send('clear cart', HttpClientRequest.delete(`${GATEWAY}/cart/${key}/items/all`));
}).pipe(Effect.withSpan('clearCart'));

const RawAddResult = Schema.Struct({ itemQuantityInCart: Schema.Int, currentPrice: Schema.Number, status: Schema.Int });

export const addToCart = Effect.fn('addToCart')(function* (items: readonly CartAddRequest[], report: Report) {
  const http = yield* TcgHttp;
  const key = yield* cartKey;
  const addOne = (request: CartAddRequest) =>
    http
      .envelope(
        'add to cart',
        post(`${GATEWAY}/cart/${key}/item/add`, {
          sku: request.sku,
          sellerKey: request.sellerKey,
          channelId: 0,
          requestedQuantity: request.quantity,
          price: request.price,
          isDirect: false,
          countryCode: COUNTRY,
        }),
        RawAddResult,
      )
      .pipe(
        Effect.map(({ errors, results }): CartAddResult => {
          const result = results?.[0];
          const reason = envelopeErrors(errors) ?? (result?.status === 0 ? null : `status ${result?.status ?? 'missing'}`);
          return reason === null && result
            ? {
                _tag: 'Added',
                request,
                quantityInCart: result.itemQuantityInCart,
                currentPrice: result.currentPrice > 0 ? result.currentPrice : request.price,
              }
            : { _tag: 'Rejected', request, reason: reason ?? 'no result' };
        }),
        Effect.catch((error) => Effect.succeed<CartAddResult>({ _tag: 'Rejected', request, reason: error.message })),
      );

  yield* report({ _tag: 'Progress', phase: 'cart', done: 0, total: items.length });
  // One at a time: concurrent adds to one cart race on TCGplayer's side.
  return yield* Effect.forEach(items, (request, i) =>
    addOne(request).pipe(Effect.tap(() => report({ _tag: 'Progress', phase: 'cart', done: i + 1, total: items.length }))),
  );
});
