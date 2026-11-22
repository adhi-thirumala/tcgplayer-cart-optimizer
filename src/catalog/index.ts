import { Array as Arr, Effect } from 'effect';
import type { CartLine, Product, ProductId, Requirement } from '@/core/domain';

/** Oversized cards and World Championship deck replicas, which are not tournament legal. */
const UNPLAYABLE_SETS: Record<string, true> = { 'Jumbo Cards': true, 'World Championship Decks': true };

export function isPlayableSingle(p: Product): boolean {
  return !p.sealed && !UNPLAYABLE_SETS[p.setName] && !/\bcode card\b/i.test(p.name);
}

/** Reminder text that some printings include and others omit; it must not stop two printings from matching. */
const REMINDERS = [
  /you may play only 1 supporter card during your turn\.?/g,
  /you may play any number of item cards during your turn\.?/g,
  /you may play only 1 stadium card during your turn\.[^.]*\.?([^.]*can't be played\.)?/g,
  /attach a pok[eé]mon tool to 1 of your pok[eé]mon that doesn't already have a pok[eé]mon tool attached\.?/g,
  /you can't have more than 1 ace spec card in your deck\.?/g,
  /pok[eé]mon (ex|v|vmax|vstar|gx) rule:[^.]*\.?/g,
];

const stripAccents = (text: string) => text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Lowercase with accents and punctuation removed, so "Pokémon" matches "Pokemon". */
function canonical(text: string): string {
  return stripAccents(text).replace(/[^a-z0-9]+/g, '');
}

function canonicalRules(text: string): string {
  return canonical(REMINDERS.reduce((t, reminder) => t.replace(reminder, ' '), stripAccents(text).replace(/[’‘]/g, "'")));
}

/** Products with equal keys are the same card for deck building. A product without gameplay text matches only itself. */
export function gameplayKey(p: Product): string {
  const t = p.text;
  if (t.cardType.length === 0 && t.attacks.length === 0 && t.rulesText === '') return `product:${p.productId}`;
  return JSON.stringify([
    canonical(p.cardName),
    t.cardType.map(canonical).sort(),
    canonical(t.stage ?? ''),
    canonical(t.hp ?? ''),
    t.energyType.map(canonical).sort(),
    canonicalRules(t.rulesText),
    t.attacks.map(canonical),
    canonical(t.weakness ?? ''),
    canonical(t.resistance ?? ''),
    canonical(t.retreatCost ?? ''),
  ]);
}

export interface CatalogSource<E> {
  readonly getProducts: (productIds: readonly ProductId[]) => Effect.Effect<readonly Product[], E>;
  readonly searchProducts: (query: string) => Effect.Effect<readonly Product[], E>;
}

export interface Catalog {
  readonly requirements: readonly Requirement[];
  readonly products: ReadonlyMap<ProductId, Product>;
}

interface Group {
  readonly id: string;
  readonly first: Product;
  readonly pinned: boolean;
  quantity: number;
  readonly inCart: Set<ProductId>;
}

/**
 * Turns the cart into requirements: copies needed of a card, satisfied by any
 * playable printing with identical gameplay text. A pinned product keeps
 * exactly its cart printing. A failed search falls back to the cart printings.
 */
export const buildRequirements = Effect.fn('buildRequirements')(function* <E>(
  cart: readonly CartLine[],
  source: CatalogSource<E>,
  pinned: ReadonlySet<ProductId>,
) {
  const quantities = new Map<ProductId, number>();
  for (const line of cart) quantities.set(line.productId, (quantities.get(line.productId) ?? 0) + line.quantity);
  const products = new Map((yield* source.getProducts([...quantities.keys()])).map((p) => [p.productId, p]));

  const groups = new Map<string, Group>();
  for (const [productId, quantity] of quantities) {
    const product = products.get(productId);
    if (!product) return yield* Effect.die(`TCGplayer returned no details for product ${productId}`);
    const id = pinned.has(productId) ? `pin:${productId}` : gameplayKey(product);
    const group = groups.get(id);
    if (group) {
      group.quantity += quantity;
      group.inCart.add(productId);
    } else {
      groups.set(id, { id, first: product, pinned: pinned.has(productId), quantity, inCart: new Set([productId]) });
    }
  }

  const searchable = [...groups.values()].filter((g) => !g.pinned && g.id !== `product:${g.first.productId}`);
  const names = [...new Set(searchable.map((g) => g.first.cardName))];
  const found = new Map(
    yield* Effect.forEach(
      names,
      (name) =>
        source.searchProducts(name).pipe(
          Effect.orElseSucceed((): readonly Product[] => []),
          Effect.map((results) => [name, results] as const),
        ),
      { concurrency: 'unbounded' },
    ),
  );

  const pinnedIds = new Set([...groups.values()].filter((g) => g.pinned).flatMap((g) => [...g.inCart]));
  const requirements = [...groups.values()].flatMap((g): Requirement[] => {
    const candidates = new Set(g.inCart);
    if (!g.pinned) {
      for (const p of found.get(g.first.cardName) ?? []) {
        if (isPlayableSingle(p) && gameplayKey(p) === g.id) {
          candidates.add(p.productId);
          if (!products.has(p.productId)) products.set(p.productId, p);
        }
      }
    }
    // A pinned product is never also a substitute inside another requirement.
    const allowed = g.pinned ? [...candidates] : [...candidates].filter((id) => !pinnedIds.has(id));
    if (!Arr.isArrayNonEmpty(allowed)) return [];
    const label = g.pinned ? `${g.first.cardName} ${g.first.number ?? ''} (${g.first.setName})`.replace(/\s+/g, ' ') : g.first.cardName;
    return [{ id: g.id, label, quantity: g.quantity, candidates: allowed, pinned: g.pinned }];
  });
  return { requirements, products } satisfies Catalog;
});
