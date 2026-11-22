import { describe, expect, it } from 'vitest';
import { cardNameOf, toCondition, toSellerShipping, type RawSellerShipping } from './mappers';

describe('cardNameOf', () => {
  it.each([
    ['Dhelmise - 091/084', 'Dhelmise'],
    ["Black Belt's Training - 097/131 (Poke Ball Pattern)", "Black Belt's Training"],
    ['Bloodmoon Ursaluna ex - 141/167 - 2024 (Jesse Parker)', 'Bloodmoon Ursaluna ex'],
    ["Professor's Research [Professor Kukui] - 222", "Professor's Research"],
    ['Banette (31)', 'Banette'],
    ['Porygon-Z', 'Porygon-Z'],
  ])('%s → %s', (name, expected) => {
    expect(cardNameOf(name)).toBe(expected);
  });
});

describe('toCondition', () => {
  it('accepts suffixed labels and rejects unknown ones', () => {
    expect(toCondition('Near Mint Foil')).toBe('Near Mint');
    expect(() => toCondition('Mint')).toThrow(/Unknown card condition/);
  });
});

describe('toSellerShipping', () => {
  const raw = (options: RawSellerShipping['sellerShippingOptions']): RawSellerShipping => ({
    sellerId: 1, sellerKey: 'k', displayName: 'S', rating: 99.5, completedSalesRank: '1000+', sellerShippingOptions: options,
  });

  it('uses the standard option even when an expedited one is listed first', () => {
    const rule = toSellerShipping(
      raw([
        { shippingMethodCode: 'TCGEXPEDITED', thresholdPrice: null, shippingPriceUnderThreshold: 6.99, shippingPriceOverThreshold: null },
        { shippingMethodCode: 'TCGFIRSTCLASS', thresholdPrice: 5, shippingPriceUnderThreshold: 1.49, shippingPriceOverThreshold: 0 },
      ]),
    );
    expect(rule).toMatchObject({ thresholdPrice: 5, priceUnder: 1.49, priceOver: 0 });
  });

  it('treats a missing over-threshold price as no discount', () => {
    const rule = toSellerShipping(
      raw([{ shippingMethodCode: 'TCGFIRSTCLASS', thresholdPrice: 5, shippingPriceUnderThreshold: 1.49, shippingPriceOverThreshold: null }]),
    );
    expect(rule?.priceOver).toBe(1.49);
  });

  it('returns null for sellers without shipping options', () => {
    expect(toSellerShipping(raw(null))).toBeNull();
  });
});
