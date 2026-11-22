import { Schema, SchemaGetter } from 'effect';
import {
  type CardText,
  CONDITIONS,
  Condition,
  type Listing,
  type Product,
  ProductId,
  type Seller,
  SellerId,
  SellerKey,
  Sku,
} from '@/core/domain';

/** "Near Mint Foil" and similar suffixed labels decode to their base condition; anything else fails. */
const ConditionLabel = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((label: string) => CONDITIONS.find((c) => label === c || label.startsWith(`${c} `)) ?? label),
    encode: SchemaGetter.passthrough(),
  }),
  Schema.decodeTo(Condition),
);

/** Listings report seller ids as numeric strings. */
const SellerIdLoose = Schema.Union([Schema.Number, Schema.NumberFromString]).pipe(Schema.decodeTo(SellerId));

/** A search result, or the body of `/v1/product/{id}/details`. */
export const RawProduct = Schema.Struct({
  productId: ProductId,
  productName: Schema.String,
  setName: Schema.String,
  rarityName: Schema.optional(Schema.NullOr(Schema.String)),
  sealed: Schema.optional(Schema.Boolean),
  lowestPrice: Schema.optional(Schema.NullOr(Schema.Number)),
  customAttributes: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
});
export type RawProduct = typeof RawProduct.Encoded;

export const RawListing = Schema.Struct({
  listingId: Schema.Number,
  productId: ProductId,
  productConditionId: Sku,
  sellerId: SellerIdLoose,
  sellerKey: SellerKey,
  sellerName: Schema.String,
  price: Schema.Number,
  quantity: Schema.Int,
  condition: ConditionLabel,
  printing: Schema.String,
});

const RawShippingOption = Schema.Struct({
  shippingMethodCode: Schema.String,
  thresholdPrice: Schema.NullOr(Schema.Number),
  shippingPriceUnderThreshold: Schema.Number,
  shippingPriceOverThreshold: Schema.NullOr(Schema.Number),
});

export const RawSeller = Schema.Struct({
  sellerId: SellerId,
  sellerKey: SellerKey,
  displayName: Schema.String,
  rating: Schema.NullOr(Schema.Number),
  completedSalesRank: Schema.NullOr(Schema.String),
  sellerShippingOptions: Schema.NullOr(Schema.Array(RawShippingOption)),
});
export type RawSeller = typeof RawSeller.Type;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** HTML fragment to plain text with normalized whitespace. */
function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
      if (code[0] === '#') {
        const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : match;
      }
      return ENTITIES[code.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Card name without TCGplayer's disambiguation: everything from " - " (collector
 * number, deck, year) and trailing "(...)" / "[...]" groups ("(Poke Ball Pattern)",
 * "[Professor Rowan]"). Distinct cards that share the stripped name still differ
 * in gameplay text, which is what decides interchangeability.
 */
export function cardNameOf(productName: string): string {
  let name = productName.replace(/\s+-\s+.*$/, '');
  for (;;) {
    const stripped = name.replace(/\s*(\([^()]*\)|\[[^[\]]*\])\s*$/, '');
    if (stripped === name || stripped === '') break;
    name = stripped;
  }
  return name.trim();
}

function text(value: unknown): string | null {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed === '' ? null : trimmed;
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((v) => text(v) ?? []) : [];
}

/** TCGplayer's `customAttributes` are loosely typed and vary by card type, so each field is read leniently. */
export function cardTextOf(attributes: { readonly [key: string]: unknown } | null | undefined): CardText {
  const a = attributes ?? {};
  return {
    cardType: textList(a.cardType),
    stage: text(a.stage),
    hp: text(a.hp),
    energyType: textList(a.energyType),
    rulesText: typeof a.description === 'string' ? plainText(a.description) : '',
    attacks: [a.attack1, a.attack2, a.attack3, a.attack4].flatMap((v) => text(v) ?? []),
    weakness: text(a.weakness),
    resistance: text(a.resistance),
    retreatCost: text(a.retreatCost),
  };
}

export function toProduct(raw: typeof RawProduct.Type): Product {
  return {
    productId: raw.productId,
    name: raw.productName,
    cardName: cardNameOf(raw.productName),
    setName: raw.setName,
    number: text(raw.customAttributes?.number),
    rarity: raw.rarityName ?? null,
    sealed: raw.sealed ?? false,
    text: cardTextOf(raw.customAttributes),
    lowestPrice: raw.lowestPrice ?? null,
  };
}

export function toListing(raw: typeof RawListing.Type): Listing {
  return {
    listingId: raw.listingId,
    productId: raw.productId,
    sku: raw.productConditionId,
    sellerId: raw.sellerId,
    sellerKey: raw.sellerKey,
    sellerName: raw.sellerName,
    price: raw.price,
    quantity: raw.quantity,
    condition: raw.condition,
    printing: raw.printing,
  };
}

/**
 * The standard (TCGFIRSTCLASS) rule, else the cheapest option. A seller with no
 * options yields null: the solver cannot price their listings, so it skips them.
 */
export function toSeller(raw: RawSeller): Seller | null {
  const options = raw.sellerShippingOptions ?? [];
  const option =
    options.find((o) => o.shippingMethodCode === 'TCGFIRSTCLASS') ??
    options.toSorted((a, b) => a.shippingPriceUnderThreshold - b.shippingPriceUnderThreshold)[0];
  if (!option) return null;
  const under = option.shippingPriceUnderThreshold;
  const over = option.shippingPriceOverThreshold ?? under;
  return {
    sellerId: raw.sellerId,
    sellerKey: raw.sellerKey,
    name: raw.displayName,
    rating: raw.rating,
    sales: raw.completedSalesRank ?? '0',
    shipping:
      option.thresholdPrice !== null && over < under
        ? { _tag: 'Threshold', under, over, threshold: option.thresholdPrice }
        : { _tag: 'Flat', price: under },
  };
}
