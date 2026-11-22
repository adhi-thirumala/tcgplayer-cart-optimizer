import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import highsLoader from 'highs';
import {
  type CartLine,
  DEFAULT_SOLVE_OPTIONS,
  type Listing,
  ProductId,
  type Requirement,
  type Seller,
  SellerId,
  SellerKey,
  Sku,
  type SolveOptions,
} from '@/core/domain';
import { evaluateCart, planToCartAdds } from './model';
import { solveWith } from './solve';

const highs = await highsLoader();

let nextListingId = 1;
function listing(sellerId: number, productId: number, price: number, quantity = 1, extra: Partial<Listing> = {}): Listing {
  return {
    listingId: nextListingId++,
    productId: ProductId.make(productId),
    sku: Sku.make(productId * 10),
    sellerId: SellerId.make(sellerId),
    sellerKey: SellerKey.make(`k${sellerId}`),
    sellerName: `Seller ${sellerId}`,
    price,
    quantity,
    condition: 'Near Mint',
    printing: 'Normal',
    ...extra,
  };
}
function seller(sellerId: number, extra: Partial<Seller> = {}): Seller {
  return {
    sellerId: SellerId.make(sellerId),
    sellerKey: SellerKey.make(`k${sellerId}`),
    name: `Seller ${sellerId}`,
    rating: 100,
    sales: '1000+',
    shipping: { _tag: 'Threshold', under: 1.49, over: 0, threshold: 5 },
    ...extra,
  };
}
function req(id: string, quantity: number, [first, ...rest]: [number, ...number[]]): Requirement {
  return { id, label: id, quantity, candidates: [ProductId.make(first), ...rest.map((p) => ProductId.make(p))], pinned: false };
}
function solve(requirements: Requirement[], listings: Listing[], sellers: Seller[], options: Partial<SolveOptions> = {}) {
  return solveWith(highs, { requirements, listings, sellers, options: { ...DEFAULT_SOLVE_OPTIONS, ...options }, timeLimitSec: 30 });
}

describe('solveWith', () => {
  it.effect('consolidates at one seller when crossing the free-shipping threshold beats cheaper splits', () =>
    Effect.gen(function* () {
      // Seller 1 has both cards for 2.60 + 2.50 = 5.10 (free shipping).
      // Splitting the cheapest copies costs 2.00 + 2.00 + 1.49 + 1.49 = 6.98.
      const plan = yield* solve(
        [req('a', 1, [1]), req('b', 1, [2])],
        [listing(1, 1, 2.6), listing(1, 2, 2.5), listing(2, 1, 2.0), listing(3, 2, 2.0)],
        [seller(1), seller(2), seller(3)],
      );
      expect(plan.status).toBe('optimal');
      expect(plan.total).toBe(5.1);
      expect(plan.orders.map((o) => o.seller.sellerId)).toEqual([1]);
    }),
  );

  it.effect('overpays for a pricier copy from the same seller when that reaches free shipping', () =>
    Effect.gen(function* () {
      // Seller 1: card a at 4.00 or 4.60, card b at 0.50. 4.60 + 0.50 = 5.10 free beats 4.50 + 1.49.
      const plan = yield* solve([req('a', 1, [1]), req('b', 1, [2])], [listing(1, 1, 4.0), listing(1, 1, 4.6), listing(1, 2, 0.5)], [seller(1)]);
      expect(plan.total).toBe(5.1);
      expect(plan.shippingTotal).toBe(0);
    }),
  );

  it.effect('never grants free shipping to a flat-rate seller', () =>
    Effect.gen(function* () {
      const plan = yield* solve([req('a', 1, [1])], [listing(1, 1, 6)], [seller(1, { shipping: { _tag: 'Flat', price: 1.49 } })]);
      expect(plan.shippingTotal).toBe(1.49);
      expect(plan.total).toBe(7.49);
    }),
  );

  it.effect('respects listing quantity caps and splits across sellers when one runs out', () =>
    Effect.gen(function* () {
      const plan = yield* solve([req('a', 3, [1])], [listing(1, 1, 2, 2), listing(2, 1, 2.5, 1)], [seller(1), seller(2)]);
      const units = plan.orders.flatMap((o) => o.items.map((i) => [o.seller.sellerId, i.quantity]));
      expect(units.sort()).toEqual([
        [1, 2],
        [2, 1],
      ]);
      expect(plan.total).toBe(2 * 2 + 1.49 + 2.5 + 1.49);
    }),
  );

  it.effect('mixes interchangeable printings within one requirement', () =>
    Effect.gen(function* () {
      const plan = yield* solve([req('a', 2, [1, 2])], [listing(1, 1, 3), listing(1, 2, 3)], [seller(1)]);
      expect(plan.total).toBe(6);
      expect(plan.orders[0]!.items.map((i) => i.listing.productId).sort()).toEqual([1, 2]);
    }),
  );

  it.effect('filters sellers by rating, exclusion and listing condition', () =>
    Effect.gen(function* () {
      const listings = [
        listing(1, 1, 0.1),
        listing(2, 1, 0.2),
        listing(3, 1, 0.3, 1, { condition: 'Lightly Played' }),
        listing(4, 1, 0.4),
        listing(5, 1, 0.5),
      ];
      const sellers = [seller(1, { rating: 97 }), seller(2, { rating: null }), seller(3), seller(4), seller(5)];
      const plan = yield* solve([req('a', 1, [1])], listings, sellers, {
        minSellerRating: 98,
        excludedSellers: [{ key: SellerKey.make('k4'), name: 'Seller 4' }],
      });
      expect(plan.orders.map((o) => o.seller.sellerId)).toEqual([5]);
    }),
  );

  it.effect('honours maxPackages even when more packages would be cheaper', () =>
    Effect.gen(function* () {
      const listings = [listing(1, 1, 1), listing(2, 2, 1), listing(3, 1, 3), listing(3, 2, 3)];
      const sellers = [seller(1), seller(2), seller(3)];
      const free = yield* solve([req('a', 1, [1]), req('b', 1, [2])], listings, sellers);
      expect(free.orders).toHaveLength(2);
      const capped = yield* solve([req('a', 1, [1]), req('b', 1, [2])], listings, sellers, { maxPackages: 1 });
      expect(capped.orders.map((o) => o.seller.sellerId)).toEqual([3]);
      expect(capped.total).toBe(6);
    }),
  );

  it.effect('reports a shortfall and still buys what exists', () =>
    Effect.gen(function* () {
      const plan = yield* solve([req('a', 4, [1]), req('b', 1, [2])], [listing(1, 1, 1, 3), listing(1, 2, 1)], [seller(1)]);
      expect(plan.shortfall).toEqual([{ requirementId: 'a', missing: 1 }]);
      expect(plan.itemTotal).toBe(4);
    }),
  );

  it.effect('skips sellers it has no shipping rule for', () =>
    Effect.gen(function* () {
      const plan = yield* solve([req('a', 1, [1])], [listing(1, 1, 0.1), listing(2, 1, 1)], [seller(2)]);
      expect(plan.orders.map((o) => o.seller.sellerId)).toEqual([2]);
    }),
  );

  it.effect('returns an empty plan when nothing is needed', () =>
    Effect.gen(function* () {
      const plan = yield* solve([req('a', 0, [1])], [listing(1, 1, 1)], [seller(1)]);
      expect(plan).toMatchObject({ status: 'optimal', orders: [], total: 0 });
    }),
  );

  it.effect('rejects requirements that share a product', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(solve([req('a', 1, [1]), req('b', 1, [1])], [listing(1, 1, 1)], [seller(1)]));
      expect(error.message).toMatch(/more than one/);
    }),
  );
});

describe('evaluateCart', () => {
  const line = (sellerId: number, price: number, quantity: number): CartLine => ({
    productId: ProductId.make(1),
    sellerId: SellerId.make(sellerId),
    printing: 'Normal',
    quantity,
    price,
  });
  const sellers = (...list: Seller[]) => new Map(list.map((s) => [s.sellerId, s]));

  it('applies each seller’s threshold to that seller’s subtotal, at exactly the threshold too', () => {
    const cost = evaluateCart([line(1, 2.5, 2), line(2, 1.1, 1)], sellers(seller(1), seller(2)));
    expect(cost).toEqual({ itemTotal: 6.1, shippingTotal: 1.49, total: 7.59 });
  });

  it('handles float subtotals that land on the threshold', () => {
    // 0.1 * 50 accumulates to 5.000000000000002 / 4.999999999999 depending on order.
    const lines = Array.from({ length: 50 }, () => line(1, 0.1, 1));
    expect(evaluateCart(lines, sellers(seller(1)))?.shippingTotal).toBe(0);
  });

  it('cannot price a cart with a seller that has no shipping rule', () => {
    expect(evaluateCart([line(9, 1, 1)], sellers())).toBeNull();
  });
});

describe('planToCartAdds', () => {
  it.effect('merges units of the same SKU from the same seller', () =>
    Effect.gen(function* () {
      const plan = yield* solve([req('a', 3, [1])], [listing(1, 1, 2, 2), listing(1, 1, 2.1, 2)], [seller(1)]);
      expect(planToCartAdds(plan)).toEqual([{ sku: 10, sellerKey: 'k1', price: 2, quantity: 3 }]);
    }),
  );
});
