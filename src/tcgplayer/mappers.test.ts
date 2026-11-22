import { describe, expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import { SellerId, SellerKey } from '@/core/domain';
import { RawListing, type RawSeller, cardNameOf, toSeller } from './mappers';

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

describe('RawListing', () => {
  const raw = (condition: string) => ({
    listingId: 1,
    productId: 2,
    productConditionId: 3,
    sellerId: '4',
    sellerKey: 'k',
    sellerName: 'S',
    price: 1,
    quantity: 1,
    condition,
    printing: 'Normal',
  });

  it('accepts suffixed condition labels and rejects unknown ones', () => {
    expect(Schema.decodeUnknownSync(RawListing)(raw('Near Mint Foil'))).toMatchObject({ condition: 'Near Mint', sellerId: 4 });
    expect(() => Schema.decodeUnknownSync(RawListing)(raw('Mint'))).toThrow();
  });
});

describe('toSeller', () => {
  const raw = (options: RawSeller['sellerShippingOptions']): RawSeller => ({
    sellerId: SellerId.make(1),
    sellerKey: SellerKey.make('k'),
    displayName: 'S',
    rating: 99.5,
    completedSalesRank: '1000+',
    sellerShippingOptions: options,
  });

  it('uses the standard option even when an expedited one is listed first', () => {
    const seller = toSeller(
      raw([
        { shippingMethodCode: 'TCGEXPEDITED', thresholdPrice: null, shippingPriceUnderThreshold: 6.99, shippingPriceOverThreshold: null },
        { shippingMethodCode: 'TCGFIRSTCLASS', thresholdPrice: 5, shippingPriceUnderThreshold: 1.49, shippingPriceOverThreshold: 0 },
      ]),
    );
    expect(seller?.shipping).toEqual({ _tag: 'Threshold', under: 1.49, over: 0, threshold: 5 });
  });

  it('treats a missing over-threshold price as flat-rate', () => {
    const seller = toSeller(
      raw([{ shippingMethodCode: 'TCGFIRSTCLASS', thresholdPrice: 5, shippingPriceUnderThreshold: 1.49, shippingPriceOverThreshold: null }]),
    );
    expect(seller?.shipping).toEqual({ _tag: 'Flat', price: 1.49 });
  });

  it('returns null for sellers without shipping options', () => {
    expect(toSeller(raw(null))).toBeNull();
  });
});
