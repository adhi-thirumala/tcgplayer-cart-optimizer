import type {
  CartAddRequest,
  CartLine,
  Listing,
  Plan,
  PlanItem,
  PlanOrder,
  ProductId,
  Requirement,
  Seller,
  SellerId,
  ShippingRule,
  SolveInput,
} from '@/core/domain';

/**
 * MILP: choose listing quantities covering every requirement while minimising
 * item cost plus each used seller's shipping, where shipping drops from
 * `under` to `over` once that seller's subtotal reaches its threshold.
 *
 *   x_i ∈ ℤ, 0 ≤ x_i ≤ min(listing qty, requirement qty)   units bought from listing i
 *   y_s ∈ {0,1}                                             seller s ships a package
 *   z_s ∈ {0,1}                                             seller s subtotal ≥ threshold
 *   m_r ∈ ℤ ≥ 0                                             copies of r we could not source
 *
 *   min Σ p_i x_i + Σ_s (under_s y_s − (under_s − over_s) z_s) + M Σ m_r
 *   s.t. Σ_{i∈r} x_i + m_r = q_r          ∀ r
 *        x_i ≤ q_{r(i)} · y_{s(i)}         ∀ i
 *        Σ_{i∈s} p_i x_i ≥ T_s · z_s       ∀ s with a threshold
 *        z_s ≤ y_s
 *        Σ y_s ≤ maxPackages               (optional)
 *
 * The shortfall penalty M exceeds any achievable purchase cost, so m_r is
 * non-zero only when supply runs out.
 */

export interface BuiltModel {
  readonly lp: string;
  /** Column `x{i}` buys `listings[i]` for requirement `listingReq[i]`. */
  readonly listings: readonly Listing[];
  readonly listingReq: readonly number[];
  /** Columns `y{j}` / `z{j}` belong to `sellers[j]`. */
  readonly sellers: readonly Seller[];
  /** Column `m{k}` is the shortfall of `requirements[k]`. */
  readonly requirements: readonly Requirement[];
}

const EPS = 1e-6;

const cents = (amount: number) => Math.round(amount * 100);
const money = (amount: number) => cents(amount) / 100;

/** Shipping a seller charges for an order with this item subtotal. */
export function shippingFor(rule: ShippingRule, subtotal: number): number {
  switch (rule._tag) {
    case 'Flat':
      return rule.price;
    case 'Threshold':
      return cents(subtotal) >= cents(rule.threshold) ? rule.over : rule.under;
  }
}

/** Shipping below any threshold: the price of a package. */
function packagePrice(rule: ShippingRule): number {
  return rule._tag === 'Flat' ? rule.price : rule.under;
}

function discount(rule: ShippingRule): number {
  return rule._tag === 'Flat' ? 0 : rule.under - rule.over;
}

interface Group {
  readonly k: number;
  seller: Seller;
  /** Ascending by price. */
  readonly listings: Listing[];
}

/** Cheapest total for `units` copies from price-sorted listings; null when stock runs out. */
function cheapestUnits(listings: readonly Listing[], units: number): number | null {
  let total = 0;
  let left = units;
  for (const l of listings) {
    const take = Math.min(left, l.quantity);
    total += take * l.price;
    left -= take;
    if (left === 0) return total;
  }
  return null;
}

/**
 * Exact reductions that leave the optimum unchanged but shrink the model from
 * thousands of sellers to far fewer:
 *
 * 1. A seller whose whole relevant stock cannot reach its threshold never gets
 *    the discount, so it is modelled as flat-rate.
 * 2. Among sellers offering a single requirement r (needed q times): for each
 *    unit count u ≤ q, let UB be what u copies cost there (cheapest copies plus
 *    shipping) and LB a lower bound (overpaying to the threshold included). A
 *    seller whose LB exceeds the q-th smallest UB for every u is dominated: the
 *    optimum uses at most q sellers for r, so one of the q cheaper ones is idle
 *    and taking the u copies there instead costs no more and affects nothing
 *    else (the seller sells nothing other than r; the package count is equal).
 * 3. A flat-rate seller s is dominated by seller t when t charges no more
 *    for a package and, for every requirement s offers and every unit count,
 *    t sells those copies for no more. Whatever the optimum buys from s, t
 *    could supply for no more. A solution has at most P packages (P = total
 *    copies needed, or maxPackages), so if s has ≥ P dominators one of them is
 *    idle and can take over s's order. Ties are broken by seller id so the
 *    relation is acyclic and a chain of such swaps always ends at a seller
 *    that is kept.
 */
function reduceGroups(groups: Group[], requirements: readonly Requirement[], maxPackages: number | null): Group[] {
  const bySeller = Map.groupBy(groups, (g) => g.seller.sellerId);

  for (const list of bySeller.values()) {
    const { shipping } = list[0]!.seller;
    if (shipping._tag === 'Flat') continue;
    const reachable = list.reduce((sum, g) => {
      const q = requirements[g.k]!.quantity;
      return sum + (cheapestUnits(g.listings.toReversed(), q) ?? g.listings.reduce((s, l) => s + l.price * l.quantity, 0));
    }, 0);
    if (cents(reachable) < cents(shipping.threshold)) {
      const flat: Seller = { ...list[0]!.seller, shipping: { _tag: 'Flat', price: shipping.under } };
      for (const g of list) g.seller = flat;
    }
  }

  const kept: Group[] = [];
  const singles = new Map<number, Group[]>();
  for (const list of bySeller.values()) {
    if (list.length > 1) kept.push(...list);
    else {
      const g = list[0]!;
      singles.set(g.k, [...(singles.get(g.k) ?? []), g]);
    }
  }

  for (const [k, candidates] of singles) {
    const q = requirements[k]!.quantity;
    const keep = new Set<Group>();
    for (let units = 1; units <= q; units++) {
      const bounds = candidates.flatMap((g) => {
        const cost = cheapestUnits(g.listings, units);
        if (cost === null) return [];
        const rule = g.seller.shipping;
        const ub = cost + shippingFor(rule, cost);
        const lb = rule._tag === 'Threshold' ? Math.min(ub, Math.max(cost, rule.threshold) + rule.over) : ub;
        return [{ g, ub, lb }];
      });
      const qthBest = bounds.map((b) => b.ub).sort((a, b) => a - b)[q - 1] ?? Infinity;
      for (const b of bounds) if (b.lb <= qthBest + EPS) keep.add(b.g);
    }
    kept.push(...keep);
  }

  return dropDominatedFlatSellers(kept, requirements, packageBound(kept, requirements, maxPackages));
}

/**
 * Most packages an optimal plan can contain: every package costs at least the
 * cheapest conceivable package, and the optimum costs no more than a greedy
 * plan, so packages ≤ greedy / cheapest. Also ≤ copies needed and maxPackages.
 */
function packageBound(groups: readonly Group[], requirements: readonly Requirement[], maxPackages: number | null): number {
  let bound = Math.min(
    requirements.reduce((sum, r) => sum + r.quantity, 0),
    maxPackages ?? Infinity,
  );
  let cheapestPackage = Infinity;
  for (const g of groups) {
    const rule = g.seller.shipping;
    const viaThreshold = rule._tag === 'Threshold' ? rule.threshold + rule.over : Infinity;
    cheapestPackage = Math.min(cheapestPackage, g.listings[0]!.price + packagePrice(rule), viaThreshold);
  }
  const greedy = greedyCost(groups, requirements);
  if (cheapestPackage > EPS && Number.isFinite(greedy)) {
    bound = Math.min(bound, Math.floor(greedy / cheapestPackage + EPS));
  }
  return Math.max(1, bound);
}

/** Cost of a greedy plan: fill each requirement from the best marginal cost per copy. Infinity if infeasible. */
function greedyCost(groups: readonly Group[], requirements: readonly Requirement[]): number {
  const byReq = Map.groupBy(groups, (g) => g.k);
  const used = new Map<Group, number>();
  const orders = new Map<SellerId, { rule: ShippingRule; subtotal: number }>();

  for (const [k, requirement] of requirements.entries()) {
    let left = requirement.quantity;
    while (left > 0) {
      let best: { g: Group; units: number; cost: number; perUnit: number } | null = null;
      for (const g of byReq.get(k) ?? []) {
        let skip = used.get(g) ?? 0;
        let units = 0;
        let cost = 0;
        for (const l of g.listings) {
          const free = Math.max(0, l.quantity - skip);
          skip = Math.max(0, skip - l.quantity);
          const take = Math.min(free, left - units);
          units += take;
          cost += take * l.price;
          if (units === left) break;
        }
        if (units === 0) continue;
        const before = orders.get(g.seller.sellerId)?.subtotal;
        const rule = g.seller.shipping;
        const marginal = cost + shippingFor(rule, (before ?? 0) + cost) - (before === undefined ? 0 : shippingFor(rule, before));
        if (!best || marginal / units < best.perUnit) best = { g, units, cost, perUnit: marginal / units };
      }
      if (!best) return Infinity;
      used.set(best.g, (used.get(best.g) ?? 0) + best.units);
      const order = orders.get(best.g.seller.sellerId);
      orders.set(best.g.seller.sellerId, { rule: best.g.seller.shipping, subtotal: (order?.subtotal ?? 0) + best.cost });
      left -= best.units;
    }
  }
  let total = 0;
  for (const { rule, subtotal } of orders.values()) total += subtotal + shippingFor(rule, subtotal);
  return total;
}

interface Offer {
  readonly sellerId: SellerId;
  readonly packagePrice: number;
  readonly flat: boolean;
  /** requirement index → cost[u-1] of the cheapest u copies, u ≤ min(need, stock). */
  readonly costs: Map<number, number[]>;
  readonly groups: Group[];
}

function dropDominatedFlatSellers(groups: readonly Group[], requirements: readonly Requirement[], packages: number): Group[] {
  const offers = new Map<SellerId, Offer>();
  for (const g of groups) {
    let offer = offers.get(g.seller.sellerId);
    if (!offer) {
      const rule = g.seller.shipping;
      offer = { sellerId: g.seller.sellerId, packagePrice: packagePrice(rule), flat: rule._tag === 'Flat', costs: new Map(), groups: [] };
      offers.set(g.seller.sellerId, offer);
    }
    const costs: number[] = [];
    for (let u = 1; u <= requirements[g.k]!.quantity; u++) {
      const cost = cheapestUnits(g.listings, u);
      if (cost === null) break;
      costs.push(cost);
    }
    offer.costs.set(g.k, costs);
    offer.groups.push(g);
  }

  const byReq = new Map<number, Offer[]>();
  for (const offer of offers.values()) {
    for (const k of offer.costs.keys()) byReq.set(k, [...(byReq.get(k) ?? []), offer]);
  }

  const dominates = (t: Offer, s: Offer): boolean => {
    if (t === s || t.packagePrice > s.packagePrice + EPS) return false;
    let strictly = t.packagePrice < s.packagePrice - EPS;
    for (const [k, sCosts] of s.costs) {
      const tCosts = t.costs.get(k);
      if (!tCosts || tCosts.length < sCosts.length) return false;
      for (const [u, sCost] of sCosts.entries()) {
        const tCost = tCosts[u]!;
        if (tCost > sCost + EPS) return false;
        if (tCost < sCost - EPS) strictly = true;
      }
    }
    return strictly || t.sellerId < s.sellerId;
  };

  const kept: Group[] = [];
  for (const s of offers.values()) {
    let dominators = 0;
    if (s.flat) {
      // Any dominator must stock every requirement s does; scan the rarest one's sellers.
      const scan = [...s.costs.keys()].map((k) => byReq.get(k)!).reduce((a, b) => (b.length < a.length ? b : a));
      for (const t of scan) {
        if (dominates(t, s) && ++dominators >= packages) break;
      }
    }
    if (dominators < packages) kept.push(...s.groups);
  }
  return kept;
}

/**
 * Listings the optimum could use within one (seller, requirement) group. Keep
 * the cheapest listings covering the requirement, plus any listing priced
 * below the dearest kept one by less than the seller's shipping discount (it
 * might be worth overpaying slightly to reach free shipping). Anything dearer
 * is dominated: moving that unit onto a kept listing with spare capacity
 * lowers the subtotal by at least the discount, all the shipping it could cost.
 */
function prune({ listings, seller }: Group, quantity: number): Listing[] {
  const kept: Listing[] = [];
  let covered = 0;
  for (const listing of listings) {
    if (covered < quantity) {
      kept.push(listing);
      covered += listing.quantity;
      continue;
    }
    const ceiling = kept[kept.length - 1]!.price + discount(seller.shipping);
    if (listing.price < ceiling - EPS) kept.push(listing);
    else break;
  }
  return kept;
}

/** LP-format linear expression, wrapped so no line gets unreasonably long. */
function expr(terms: ReadonlyArray<readonly [number, string]>): string {
  const parts = terms
    .filter(([c]) => Math.abs(c) > EPS)
    .map(([c, v], i) => {
      const sign = c < 0 ? '- ' : i === 0 ? '' : '+ ';
      return `${sign}${Number(Math.abs(c).toFixed(6))} ${v}`;
    });
  const lines: string[] = [];
  for (let i = 0; i < parts.length; i += 8) lines.push(parts.slice(i, i + 8).join(' '));
  return lines.join('\n   ');
}

function chunk(names: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < names.length; i += 16) out.push(` ${names.slice(i, i + 16).join(' ')}`);
  return out;
}

/** Null when nothing is needed. Throws when two requirements share a product. */
export function buildModel(input: SolveInput): BuiltModel | null {
  const { options } = input;
  const requirements = input.requirements.filter((r) => r.quantity > 0);
  if (requirements.length === 0) return null;

  const reqOfProduct = new Map<ProductId, number>();
  for (const [k, r] of requirements.entries()) {
    for (const productId of r.candidates) {
      if (reqOfProduct.has(productId)) throw new Error(`Product ${productId} belongs to more than one requirement`);
      reqOfProduct.set(productId, k);
    }
  }

  const sellersById = new Map(input.sellers.map((s) => [s.sellerId, s]));
  const excluded = new Set(options.excludedSellers.map((s) => s.key));
  const conditions = new Set(options.conditions);
  const groups = new Map<string, Group>();
  for (const listing of input.listings) {
    const k = reqOfProduct.get(listing.productId);
    const seller = sellersById.get(listing.sellerId);
    if (
      k === undefined ||
      seller === undefined ||
      listing.quantity <= 0 ||
      !conditions.has(listing.condition) ||
      excluded.has(seller.sellerKey) ||
      (options.minSellerRating > 0 && (seller.rating ?? -1) < options.minSellerRating)
    ) {
      continue;
    }
    const key = `${listing.sellerId}:${k}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { k, seller, listings: [] }));
    group.listings.push(listing);
  }
  for (const g of groups.values()) g.listings.sort((a, b) => a.price - b.price || a.listingId - b.listingId);

  const listings: Listing[] = [];
  const listingReq: number[] = [];
  const sellerIndex = new Map<SellerId, number>();
  const sellers: Seller[] = [];
  for (const group of reduceGroups([...groups.values()], requirements, options.maxPackages)) {
    if (!sellerIndex.has(group.seller.sellerId)) {
      sellerIndex.set(group.seller.sellerId, sellers.length);
      sellers.push(group.seller);
    }
    for (const listing of prune(group, requirements[group.k]!.quantity)) {
      listings.push(listing);
      listingReq.push(group.k);
    }
  }

  const maxPrice = listings.reduce((m, l) => Math.max(m, l.price), 0);
  const penalty = 1000 + 1000 * maxPrice;

  const objective: Array<[number, string]> = listings.map((l, i) => [l.price, `x${i}`]);
  for (const [j, s] of sellers.entries()) {
    objective.push([packagePrice(s.shipping), `y${j}`]);
    if (s.shipping._tag === 'Threshold') objective.push([-discount(s.shipping), `z${j}`]);
  }
  for (const k of requirements.keys()) objective.push([penalty, `m${k}`]);

  // x_i ≤ cap_i · y_s with cap_i = min(listing qty, need) rather than a loose big-M:
  // most listings hold one or two copies, so the LP relaxation pays (nearly) full
  // shipping for every seller it touches, which keeps branch-and-bound small.
  const cap = listings.map((l, i) => Math.min(l.quantity, requirements[listingReq[i]!]!.quantity));
  const rows: string[] = [];
  const byReq: Array<Array<[number, string]>> = requirements.map(() => []);
  const bySeller: Array<Array<[number, string]>> = sellers.map(() => []);
  for (const [i, l] of listings.entries()) {
    const j = sellerIndex.get(l.sellerId)!;
    byReq[listingReq[i]!]!.push([1, `x${i}`]);
    bySeller[j]!.push([l.price, `x${i}`]);
    rows.push(` link${i}: ${expr([[1, `x${i}`], [-cap[i]!, `y${j}`]])} <= 0`);
  }
  for (const [k, r] of requirements.entries()) {
    rows.push(` need${k}: ${expr([...byReq[k]!, [1, `m${k}`]])} = ${r.quantity}`);
  }
  for (const [j, s] of sellers.entries()) {
    if (s.shipping._tag === 'Flat') continue;
    rows.push(` free${j}: ${expr([...bySeller[j]!, [-s.shipping.threshold, `z${j}`]])} >= 0`);
    rows.push(` ship${j}: ${expr([[1, `z${j}`], [-1, `y${j}`]])} <= 0`);
  }
  if (options.maxPackages !== null && sellers.length > 0) {
    rows.push(` packages: ${expr(sellers.map((_, j) => [1, `y${j}`]))} <= ${options.maxPackages}`);
  }

  const bounds = listings.map((_, i) => ` 0 <= x${i} <= ${cap[i]}`);
  const binaries = sellers.flatMap((s, j) => (s.shipping._tag === 'Threshold' ? [`y${j}`, `z${j}`] : [`y${j}`]));
  const generals = [...listings.map((_, i) => `x${i}`), ...requirements.map((_, k) => `m${k}`)];

  const lp = [
    'Minimize',
    ` obj: ${expr(objective)}`,
    'Subject To',
    ...rows,
    'Bounds',
    ...bounds,
    'General',
    ...chunk(generals),
    ...(binaries.length > 0 ? ['Binary', ...chunk(binaries)] : []),
    'End',
    '',
  ].join('\n');

  return { lp, listings, listingReq, sellers, requirements };
}

/** Turns column values into a self-consistent plan, with shipping recomputed from subtotals. */
export function decodePlan(model: BuiltModel, value: (column: string) => number, status: Plan['status']): Plan {
  const items = new Map<SellerId, PlanItem[]>();
  for (const [i, listing] of model.listings.entries()) {
    const quantity = Math.round(value(`x${i}`));
    if (quantity <= 0) continue;
    const item = { requirementId: model.requirements[model.listingReq[i]!]!.id, listing, quantity };
    items.set(listing.sellerId, [...(items.get(listing.sellerId) ?? []), item]);
  }

  const orders = model.sellers
    .flatMap((seller): PlanOrder[] => {
      const sellerItems = items.get(seller.sellerId);
      if (!sellerItems) return [];
      const subtotal = money(sellerItems.reduce((sum, it) => sum + it.listing.price * it.quantity, 0));
      return [{ seller, items: sellerItems, subtotal, shipping: shippingFor(seller.shipping, subtotal) }];
    })
    .sort((a, b) => b.subtotal - a.subtotal);

  const shortfall = model.requirements.flatMap((r, k) => {
    const missing = Math.round(value(`m${k}`));
    return missing > 0 ? [{ requirementId: r.id, missing }] : [];
  });

  const itemTotal = money(orders.reduce((s, o) => s + o.subtotal, 0));
  const shippingTotal = money(orders.reduce((s, o) => s + o.shipping, 0));
  return { status, orders, itemTotal, shippingTotal, total: money(itemTotal + shippingTotal), shortfall };
}

export const EMPTY_PLAN: Plan = { status: 'optimal', orders: [], itemTotal: 0, shippingTotal: 0, total: 0, shortfall: [] };

export interface CartCost {
  readonly itemTotal: number;
  readonly shippingTotal: number;
  readonly total: number;
}

/** What the cart costs under each seller's live shipping rule; null when a cart seller has no rule. */
export function evaluateCart(lines: readonly CartLine[], sellers: ReadonlyMap<SellerId, Seller>): CartCost | null {
  const subtotals = new Map<SellerId, number>();
  for (const line of lines) subtotals.set(line.sellerId, (subtotals.get(line.sellerId) ?? 0) + line.price * line.quantity);
  let itemTotal = 0;
  let shippingTotal = 0;
  for (const [sellerId, subtotal] of subtotals) {
    const seller = sellers.get(sellerId);
    if (!seller) return null;
    itemTotal += subtotal;
    shippingTotal += shippingFor(seller.shipping, money(subtotal));
  }
  return { itemTotal: money(itemTotal), shippingTotal: money(shippingTotal), total: money(itemTotal + shippingTotal) };
}

/** Cart additions for a plan, merging units of one SKU from one seller. */
export function planToCartAdds(plan: Plan): CartAddRequest[] {
  const adds = new Map<string, CartAddRequest>();
  for (const order of plan.orders) {
    for (const { listing, quantity } of order.items) {
      const key = `${listing.sku}:${listing.sellerKey}`;
      const existing = adds.get(key);
      adds.set(key, existing ? { ...existing, quantity: existing.quantity + quantity } : { sku: listing.sku, sellerKey: listing.sellerKey, price: listing.price, quantity });
    }
  }
  return [...adds.values()];
}
