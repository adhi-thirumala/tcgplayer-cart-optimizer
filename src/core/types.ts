/**
 * Shared domain types. Every module (tcgplayer client, catalog, solver, UI)
 * speaks these; change them only with every consumer updated in the same commit.
 */

export type ProductId = number;
/** TCGplayer "productConditionId": the purchasable SKU (product × condition × printing × language). */
export type Sku = number;

export type Condition =
  | 'Near Mint'
  | 'Lightly Played'
  | 'Moderately Played'
  | 'Heavily Played'
  | 'Damaged';

export const CONDITIONS: readonly Condition[] = [
  'Near Mint',
  'Lightly Played',
  'Moderately Played',
  'Heavily Played',
  'Damaged',
];

/** Gameplay-relevant card text, used to decide which printings are interchangeable. */
export interface CardText {
  /** e.g. ["Pokemon"], ["Trainer"], ["Energy"]; empty when TCGplayer has no data. */
  cardType: string[];
  stage: string | null;
  hp: string | null;
  energyType: string[];
  /** Abilities / trainer / energy rules text, HTML stripped and whitespace-normalized. */
  rulesText: string;
  /** attack1..attack4, nulls removed, whitespace-normalized. */
  attacks: string[];
  weakness: string | null;
  resistance: string | null;
  retreatCost: string | null;
}

export interface Product {
  productId: ProductId;
  /** Display name as TCGplayer lists it, e.g. "Prism Tower - 080/086". */
  name: string;
  /** Name with any " - 080/086" style number suffix removed, e.g. "Prism Tower". */
  cardName: string;
  setName: string;
  setCode: string | null;
  number: string | null;
  rarity: string | null;
  /** True for sealed product (boxes, packs); never a candidate for a single. */
  sealed: boolean;
  text: CardText;
  marketPrice: number | null;
  lowestPrice: number | null;
  totalListings: number;
  imageUrl: string;
  url: string;
}

export interface Listing {
  listingId: number;
  productId: ProductId;
  sku: Sku;
  sellerId: number;
  sellerKey: string;
  sellerName: string;
  price: number;
  /** Units available in this listing. */
  quantity: number;
  condition: Condition;
  printing: string;
  language: string;
  /** Seller is a TCGplayer Direct seller. We always buy seller-fulfilled (isDirect=false on add). */
  directSeller: boolean;
}

/** A seller's standard (TCGFIRSTCLASS) shipping rule for single cards, US destination. */
export interface SellerShipping {
  sellerId: number;
  sellerKey: string;
  name: string;
  /** Feedback percentage 0-100; null when the seller has no rating. */
  rating: number | null;
  /** TCGplayer's bucketed sales count string, e.g. "50000+". */
  sales: string;
  /** Subtotal at or above which `priceOver` applies; null = flat `priceUnder`. */
  thresholdPrice: number | null;
  priceUnder: number;
  priceOver: number;
}

/** One line in the user's live TCGplayer cart. */
export interface CartLine {
  sku: Sku;
  productId: ProductId;
  sellerId: number;
  sellerKey: string;
  sellerName: string;
  /** Product name as shown in the cart. */
  name: string;
  setName: string;
  number: string | null;
  condition: Condition;
  printing: string;
  quantity: number;
  price: number;
}

/** What the user needs: N copies of any of `candidates`. */
export interface Requirement {
  /** Stable id (e.g. the gameplay key, or `pin:<productId>`). */
  id: string;
  /** Human label, e.g. "Prism Tower" or "Dhelmise 091/084 (pinned)". */
  label: string;
  quantity: number;
  /** Interchangeable products; the solver may mix them freely. */
  candidates: ProductId[];
  /** True when the user locked this requirement to the exact cart printing(s). */
  pinned: boolean;
}

export interface SolveOptions {
  /** Sellers below this feedback % (or unrated) are excluded. */
  minSellerRating: number;
  /** Allowed conditions. */
  conditions: Condition[];
  /** Seller keys the user never wants to buy from. */
  excludeSellerKeys: string[];
  /** Optional cap on the number of packages (sellers). */
  maxPackages: number | null;
  /** Solver wall-clock limit in seconds. */
  timeLimitSec: number;
}

export const DEFAULT_SOLVE_OPTIONS: SolveOptions = {
  minSellerRating: 98,
  conditions: ['Near Mint'],
  excludeSellerKeys: [],
  maxPackages: null,
  timeLimitSec: 30,
};

export interface SolveInput {
  requirements: Requirement[];
  listings: Listing[];
  sellers: SellerShipping[];
  options: SolveOptions;
}

export interface PlanItem {
  requirementId: string;
  listing: Listing;
  quantity: number;
}

export interface PlanOrder {
  sellerId: number;
  sellerKey: string;
  sellerName: string;
  items: PlanItem[];
  subtotal: number;
  shipping: number;
}

export interface Shortfall {
  requirementId: string;
  /** Copies that could not be sourced under the current options. */
  missing: number;
}

export interface Plan {
  /** 'optimal' = proven optimum; 'feasible' = best found before the time limit. */
  status: 'optimal' | 'feasible' | 'infeasible';
  orders: PlanOrder[];
  itemTotal: number;
  shippingTotal: number;
  total: number;
  /** Non-empty when supply could not cover every requirement; the plan covers the rest. */
  shortfall: Shortfall[];
}

/** One item to put in the cart when applying a plan. */
export interface CartAddRequest {
  sku: Sku;
  sellerKey: string;
  price: number;
  quantity: number;
}

export interface CartAddResult {
  request: CartAddRequest;
  ok: boolean;
  /** Quantity actually in cart for this sku/seller after the add. */
  quantityInCart: number;
  /** Price TCGplayer reports now; may differ from the requested price. */
  currentPrice: number | null;
  error: string | null;
}

export interface Progress {
  phase: 'listings' | 'sellers' | 'cart';
  done: number;
  total: number;
}

export type ProgressFn = (p: Progress) => void;

/**
 * Everything the extension needs from TCGplayer. Implemented in the content
 * script (runs on tcgplayer.com so requests carry the site origin + cookies)
 * and proxied to extension pages over a runtime port.
 */
export interface TcgApi {
  readCart(): Promise<CartLine[]>;
  searchProducts(query: string): Promise<Product[]>;
  getProducts(productIds: ProductId[]): Promise<Product[]>;
  fetchListings(
    productIds: ProductId[],
    filter: { conditions: Condition[] },
    onProgress?: ProgressFn,
  ): Promise<Listing[]>;
  fetchSellerShipping(sellerIds: number[], onProgress?: ProgressFn): Promise<SellerShipping[]>;
  /** Empty the cart (does not touch saved-for-later). */
  clearCart(): Promise<void>;
  addToCart(items: CartAddRequest[], onProgress?: ProgressFn): Promise<CartAddResult[]>;
}
