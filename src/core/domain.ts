import { Schema } from 'effect';

export const ProductId = Schema.Int.pipe(Schema.brand('ProductId'));
export type ProductId = typeof ProductId.Type;

/** TCGplayer "productConditionId": product × condition × printing × language. */
export const Sku = Schema.Int.pipe(Schema.brand('Sku'));
export type Sku = typeof Sku.Type;

export const SellerId = Schema.Int.pipe(Schema.brand('SellerId'));
export type SellerId = typeof SellerId.Type;

export const SellerKey = Schema.String.pipe(Schema.brand('SellerKey'));
export type SellerKey = typeof SellerKey.Type;

export const Condition = Schema.Literals(['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged']);
export type Condition = typeof Condition.Type;
export const CONDITIONS = Condition.literals;

/** The card text that decides whether two printings play the same. */
export const CardText = Schema.Struct({
  cardType: Schema.Array(Schema.String),
  stage: Schema.NullOr(Schema.String),
  hp: Schema.NullOr(Schema.String),
  energyType: Schema.Array(Schema.String),
  rulesText: Schema.String,
  attacks: Schema.Array(Schema.String),
  weakness: Schema.NullOr(Schema.String),
  resistance: Schema.NullOr(Schema.String),
  retreatCost: Schema.NullOr(Schema.String),
});
export type CardText = typeof CardText.Type;

export const Product = Schema.Struct({
  productId: ProductId,
  /** As TCGplayer lists it, e.g. "Prism Tower - 080/086". */
  name: Schema.String,
  /** `name` without the collector number and variant suffixes, e.g. "Prism Tower". */
  cardName: Schema.String,
  setName: Schema.String,
  number: Schema.NullOr(Schema.String),
  rarity: Schema.NullOr(Schema.String),
  sealed: Schema.Boolean,
  text: CardText,
  lowestPrice: Schema.NullOr(Schema.Number),
});
export type Product = typeof Product.Type;

export const Listing = Schema.Struct({
  listingId: Schema.Int,
  productId: ProductId,
  sku: Sku,
  sellerId: SellerId,
  sellerKey: SellerKey,
  sellerName: Schema.String,
  price: Schema.Number,
  quantity: Schema.Int,
  condition: Condition,
  printing: Schema.String,
});
export type Listing = typeof Listing.Type;

/** A seller's standard shipping for single cards to the US. A threshold rule always has `over < under`. */
export const ShippingRule = Schema.Union([
  Schema.TaggedStruct('Flat', { price: Schema.Number }),
  Schema.TaggedStruct('Threshold', { under: Schema.Number, over: Schema.Number, threshold: Schema.Number }),
]);
export type ShippingRule = typeof ShippingRule.Type;

export const Seller = Schema.Struct({
  sellerId: SellerId,
  sellerKey: SellerKey,
  name: Schema.String,
  /** Feedback percentage, 0 to 100. */
  rating: Schema.NullOr(Schema.Number),
  /** TCGplayer's bucketed sales count, e.g. "50000+". */
  sales: Schema.String,
  shipping: ShippingRule,
});
export type Seller = typeof Seller.Type;

export const CartLine = Schema.Struct({
  productId: ProductId,
  sellerId: SellerId,
  printing: Schema.String,
  quantity: Schema.Int,
  price: Schema.Number,
});
export type CartLine = typeof CartLine.Type;

/** `quantity` copies of any of `candidates`, which play identically. */
export interface Requirement {
  /** The gameplay key, or `pin:<productId>` for a pinned printing. */
  readonly id: string;
  readonly label: string;
  readonly quantity: number;
  readonly candidates: readonly [ProductId, ...ProductId[]];
  readonly pinned: boolean;
}

export const SolveOptions = Schema.Struct({
  /** Sellers below this feedback percentage, and unrated sellers, are skipped. */
  minSellerRating: Schema.Number,
  conditions: Schema.NonEmptyArray(Condition),
  excludedSellers: Schema.Array(Schema.Struct({ key: SellerKey, name: Schema.String })),
  maxPackages: Schema.NullOr(Schema.Int),
});
export type SolveOptions = typeof SolveOptions.Type;

export const DEFAULT_SOLVE_OPTIONS: SolveOptions = {
  minSellerRating: 98,
  conditions: ['Near Mint'],
  excludedSellers: [],
  maxPackages: null,
};

export interface SolveInput {
  readonly requirements: readonly Requirement[];
  readonly listings: readonly Listing[];
  readonly sellers: readonly Seller[];
  readonly options: SolveOptions;
  readonly timeLimitSec: number;
}

export interface PlanItem {
  readonly requirementId: string;
  readonly listing: Listing;
  readonly quantity: number;
}

export interface PlanOrder {
  readonly seller: Seller;
  readonly items: readonly PlanItem[];
  readonly subtotal: number;
  readonly shipping: number;
}

export interface Shortfall {
  readonly requirementId: string;
  /** Copies no allowed listing could supply. */
  readonly missing: number;
}

export interface Plan {
  /** `feasible`: the best plan found before the time limit, not a proven optimum. */
  readonly status: 'optimal' | 'feasible';
  readonly orders: readonly PlanOrder[];
  readonly itemTotal: number;
  readonly shippingTotal: number;
  readonly total: number;
  readonly shortfall: readonly Shortfall[];
}

export const CartAddRequest = Schema.Struct({
  sku: Sku,
  sellerKey: SellerKey,
  price: Schema.Number,
  quantity: Schema.Int,
});
export type CartAddRequest = typeof CartAddRequest.Type;

export const CartAddResult = Schema.Union([
  Schema.TaggedStruct('Added', {
    request: CartAddRequest,
    quantityInCart: Schema.Int,
    /** The price TCGplayer charges now, which can differ from `request.price`. */
    currentPrice: Schema.Number,
  }),
  Schema.TaggedStruct('Rejected', { request: CartAddRequest, reason: Schema.String }),
]);
export type CartAddResult = typeof CartAddResult.Type;

export const Progress = Schema.TaggedStruct('Progress', {
  phase: Schema.Literals(['listings', 'sellers', 'cart']),
  done: Schema.Int,
  total: Schema.Int,
});
export type Progress = typeof Progress.Type;
