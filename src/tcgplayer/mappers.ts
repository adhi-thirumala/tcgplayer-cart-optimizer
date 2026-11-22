import type { CardText, Condition, Listing, Product, SellerShipping } from '@/core/types';
import { CONDITIONS } from '@/core/types';

/** Raw product as returned by search results and `/v1/product/{id}/details`. */
export interface RawProduct {
  productId: number;
  productName: string;
  setName: string;
  setCode?: string | null;
  rarityName?: string | null;
  sealed?: boolean;
  marketPrice?: number | null;
  lowestPrice?: number | null;
  totalListings?: number;
  listings?: number;
  productLineUrlName?: string;
  customAttributes?: Record<string, unknown> | null;
}

export interface RawListing {
  listingId: number;
  productId: number;
  productConditionId: number;
  sellerId: string | number;
  sellerKey: string;
  sellerName: string;
  price: number;
  quantity: number;
  condition: string;
  printing: string;
  language: string;
  directSeller?: boolean;
}

export interface RawShippingOption {
  shippingMethodCode: string;
  thresholdPrice: number | null;
  shippingPriceUnderThreshold: number;
  shippingPriceOverThreshold: number | null;
}

export interface RawSellerShipping {
  sellerId: number;
  sellerKey: string;
  displayName: string;
  rating: number | null;
  completedSalesRank: string | null;
  sellerShippingOptions: RawShippingOption[] | null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** HTML fragment → plain text with normalized whitespace. */
export function plainText(html: string): string {
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
 * "(Cosmos Holo)", "[Professor Rowan]"). Distinct cards that share the stripped
 * name still differ in gameplay text, which is what decides interchangeability.
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

function str(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.replace(/\s+/g, ' ').trim();
    return trimmed === '' ? null : trimmed;
  }
  return typeof value === 'number' ? String(value) : null;
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((v) => str(v) ?? []) : [];
}

export function cardTextOf(attributes: Record<string, unknown> | null | undefined): CardText {
  const a = attributes ?? {};
  return {
    cardType: strList(a.cardType),
    stage: str(a.stage),
    hp: str(a.hp),
    energyType: strList(a.energyType),
    rulesText: typeof a.description === 'string' ? plainText(a.description) : '',
    attacks: [a.attack1, a.attack2, a.attack3, a.attack4].flatMap((v) => str(v) ?? []),
    weakness: str(a.weakness),
    resistance: str(a.resistance),
    retreatCost: str(a.retreatCost),
  };
}

export function toProduct(raw: RawProduct): Product {
  return {
    productId: raw.productId,
    name: raw.productName,
    cardName: cardNameOf(raw.productName),
    setName: raw.setName,
    setCode: raw.setCode ?? null,
    number: str(raw.customAttributes?.number),
    rarity: raw.rarityName ?? null,
    sealed: raw.sealed ?? false,
    text: cardTextOf(raw.customAttributes),
    marketPrice: raw.marketPrice ?? null,
    lowestPrice: raw.lowestPrice ?? null,
    totalListings: raw.totalListings ?? raw.listings ?? 0,
    imageUrl: `https://tcgplayer-cdn.tcgplayer.com/product/${raw.productId}_in_200x200.jpg`,
    url: `https://www.tcgplayer.com/product/${raw.productId}`,
  };
}

/** TCGplayer condition label → domain condition ("Near Mint Foil" style suffixes tolerated). */
export function toCondition(label: string): Condition {
  const match = CONDITIONS.find((c) => label === c || label.startsWith(`${c} `));
  if (!match) throw new Error(`Unknown card condition "${label}"`);
  return match;
}

export function toListing(raw: RawListing): Listing {
  return {
    listingId: raw.listingId,
    productId: raw.productId,
    sku: raw.productConditionId,
    sellerId: Number(raw.sellerId),
    sellerKey: raw.sellerKey,
    sellerName: raw.sellerName,
    price: raw.price,
    quantity: raw.quantity,
    condition: toCondition(raw.condition),
    printing: raw.printing,
    language: raw.language,
    directSeller: raw.directSeller ?? false,
  };
}

/**
 * Standard shipping rule; falls back to the cheapest option when a seller has
 * no TCGFIRSTCLASS. Sellers with no options at all yield null (the solver
 * cannot price them, so their listings are skipped).
 */
export function toSellerShipping(raw: RawSellerShipping): SellerShipping | null {
  const options = raw.sellerShippingOptions ?? [];
  const option =
    options.find((o) => o.shippingMethodCode === 'TCGFIRSTCLASS') ??
    [...options].sort((a, b) => a.shippingPriceUnderThreshold - b.shippingPriceUnderThreshold)[0];
  if (!option) return null;
  return {
    sellerId: raw.sellerId,
    sellerKey: raw.sellerKey,
    name: raw.displayName,
    rating: raw.rating,
    sales: raw.completedSalesRank ?? '0',
    thresholdPrice: option.thresholdPrice,
    priceUnder: option.shippingPriceUnderThreshold,
    priceOver: option.shippingPriceOverThreshold ?? option.shippingPriceUnderThreshold,
  };
}
