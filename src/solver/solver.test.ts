import highsLoader, { type Highs } from 'highs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CartLine, Listing, Requirement, SellerShipping, SolveOptions } from '@/core/types';
import { DEFAULT_SOLVE_OPTIONS } from '@/core/types';
import { evaluateCart, planToCartAdds } from './model';
import { solveWith } from './solve';

let highs: Highs;
beforeAll(async () => {
  highs = await highsLoader();
});

let nextListingId = 1;
function listing(sellerId: number, productId: number, price: number, quantity = 1, extra: Partial<Listing> = {}): Listing {
  const id = nextListingId++;
  return {
    listingId: id, productId, sku: productId * 10, sellerId, sellerKey: `k${sellerId}`, sellerName: `Seller ${sellerId}`,
    price, quantity, condition: 'Near Mint', printing: 'Normal', language: 'English', directSeller: false, ...extra,
  };
}
function seller(sellerId: number, extra: Partial<SellerShipping> = {}): SellerShipping {
  return {
    sellerId, sellerKey: `k${sellerId}`, name: `Seller ${sellerId}`, rating: 100, sales: '1000+',
    thresholdPrice: 5, priceUnder: 1.49, priceOver: 0, ...extra,
  };
}
function req(id: string, quantity: number, candidates: number[]): Requirement {
  return { id, label: id, quantity, candidates, pinned: false };
}
function solve(requirements: Requirement[], listings: Listing[], sellers: SellerShipping[], options: Partial<SolveOptions> = {}) {
  return solveWith(highs, { requirements, listings, sellers, options: { ...DEFAULT_SOLVE_OPTIONS, ...options } });
}

describe('solveWith', () => {
  it('consolidates at one seller when crossing the free-shipping threshold beats cheaper splits', () => {
    // Seller 1 has both cards for 2.60 + 2.50 = 5.10 (free shipping).
    // Splitting the cheapest copies costs 2.00 + 2.00 + 1.49 + 1.49 = 6.98.
    const plan = solve(
      [req('a', 1, [1]), req('b', 1, [2])],
      [listing(1, 1, 2.6), listing(1, 2, 2.5), listing(2, 1, 2.0), listing(3, 2, 2.0)],
      [seller(1), seller(2), seller(3)],
    );
    expect(plan.status).toBe('optimal');
    expect(plan.total).toBe(5.1);
    expect(plan.orders.map((o) => o.sellerId)).toEqual([1]);
  });

  it('overpays for a pricier copy from the same seller when that reaches free shipping', () => {
    // Seller 1: card a at 4.00 or 4.60, card b at 0.50. 4.60 + 0.50 = 5.10 free beats 4.50 + 1.49.
    const plan = solve(
      [req('a', 1, [1]), req('b', 1, [2])],
      [listing(1, 1, 4.0), listing(1, 1, 4.6), listing(1, 2, 0.5)],
      [seller(1)],
    );
    expect(plan.total).toBe(5.1);
    expect(plan.shippingTotal).toBe(0);
  });

  it('never grants free shipping to a flat-rate seller', () => {
    const plan = solve([req('a', 1, [1])], [listing(1, 1, 6)], [seller(1, { priceOver: 1.49 })]);
    expect(plan.shippingTotal).toBe(1.49);
    expect(plan.total).toBe(7.49);
  });

  it('respects listing quantity caps and splits across sellers when one runs out', () => {
    const plan = solve(
      [req('a', 3, [1])],
      [listing(1, 1, 2, 2), listing(2, 1, 2.5, 1)],
      [seller(1), seller(2)],
    );
    const units = plan.orders.flatMap((o) => o.items.map((i) => [o.sellerId, i.quantity]));
    expect(units.sort()).toEqual([[1, 2], [2, 1]]);
    expect(plan.total).toBe(2 * 2 + 1.49 + 2.5 + 1.49);
  });

  it('mixes interchangeable printings within one requirement', () => {
    const plan = solve([req('a', 2, [1, 2])], [listing(1, 1, 3), listing(1, 2, 3)], [seller(1)]);
    expect(plan.total).toBe(6);
    expect(plan.orders[0]!.items.map((i) => i.listing.productId).sort()).toEqual([1, 2]);
  });

  it('filters sellers by rating, exclusion and listing condition', () => {
    const listings = [
      listing(1, 1, 0.1),
      listing(2, 1, 0.2),
      listing(3, 1, 0.3, 1, { condition: 'Lightly Played' }),
      listing(4, 1, 0.4),
      listing(5, 1, 0.5),
    ];
    const sellers = [seller(1, { rating: 97 }), seller(2, { rating: null }), seller(3), seller(4), seller(5)];
    const plan = solve([req('a', 1, [1])], listings, sellers, { minSellerRating: 98, excludeSellerKeys: ['k4'] });
    expect(plan.orders.map((o) => o.sellerId)).toEqual([5]);
  });

  it('honours maxPackages even when more packages would be cheaper', () => {
    const listings = [listing(1, 1, 1), listing(2, 2, 1), listing(3, 1, 3), listing(3, 2, 3)];
    const sellers = [seller(1), seller(2), seller(3)];
    const free = solve([req('a', 1, [1]), req('b', 1, [2])], listings, sellers);
    expect(free.orders).toHaveLength(2);
    const capped = solve([req('a', 1, [1]), req('b', 1, [2])], listings, sellers, { maxPackages: 1 });
    expect(capped.orders.map((o) => o.sellerId)).toEqual([3]);
    expect(capped.total).toBe(6);
  });

  it('reports a shortfall and still buys what exists', () => {
    const plan = solve([req('a', 4, [1]), req('b', 1, [2])], [listing(1, 1, 1, 3), listing(1, 2, 1)], [seller(1)]);
    expect(plan.shortfall).toEqual([{ requirementId: 'a', missing: 1 }]);
    expect(plan.itemTotal).toBe(4);
  });

  it('skips sellers it has no shipping rule for', () => {
    const plan = solve([req('a', 1, [1])], [listing(1, 1, 0.1), listing(2, 1, 1)], [seller(2)]);
    expect(plan.orders.map((o) => o.sellerId)).toEqual([2]);
  });

  it('returns an empty plan when nothing is needed', () => {
    const plan = solve([req('a', 0, [1])], [listing(1, 1, 1)], [seller(1)]);
    expect(plan).toMatchObject({ status: 'optimal', orders: [], total: 0 });
  });

  it('rejects requirements that share a product', () => {
    expect(() => solve([req('a', 1, [1]), req('b', 1, [1])], [listing(1, 1, 1)], [seller(1)])).toThrow(/more than one/);
  });
});

describe('evaluateCart', () => {
  const line = (sellerId: number, price: number, quantity: number): CartLine => ({
    sku: 1, productId: 1, sellerId, sellerKey: `k${sellerId}`, sellerName: `Seller ${sellerId}`, name: 'Card',
    setName: 'Set', number: null, condition: 'Near Mint', printing: 'Normal', quantity, price,
  });

  it('applies each seller’s threshold to that seller’s subtotal, at exactly the threshold too', () => {
    const cost = evaluateCart([line(1, 2.5, 2), line(2, 1.1, 1)], [seller(1), seller(2)]);
    expect(cost).toEqual({ itemTotal: 6.1, shippingTotal: 1.49, total: 7.59 });
  });

  it('handles float subtotals that land on the threshold', () => {
    // 0.1 * 50 accumulates to 5.000000000000002 / 4.999999999999 depending on order.
    const lines = Array.from({ length: 50 }, () => line(1, 0.1, 1));
    expect(evaluateCart(lines, [seller(1)]).shippingTotal).toBe(0);
  });

  it('throws when a seller has no shipping rule', () => {
    expect(() => evaluateCart([line(9, 1, 1)], [])).toThrow(/Seller 9/);
  });
});

describe('planToCartAdds', () => {
  it('merges units of the same SKU from the same seller', () => {
    const plan = solve([req('a', 3, [1])], [listing(1, 1, 2, 2), listing(1, 1, 2.1, 2)], [seller(1)]);
    expect(planToCartAdds(plan)).toEqual([{ sku: 10, sellerKey: 'k1', price: 2, quantity: 3 }]);
  });
});
