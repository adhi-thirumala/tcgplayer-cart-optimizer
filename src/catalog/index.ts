import type { CartLine, Product, ProductId, Requirement, TcgApi } from '@/core/types';

/**
 * Printings that are never acceptable substitutes for a playable single:
 * oversized cards, World Championship deck replicas (gold borders, different
 * backs; not tournament legal) and online code cards.
 */
const UNPLAYABLE_SETS: Record<string, true> = { 'Jumbo Cards': true, 'World Championship Decks': true };

export function isPlayableSingle(p: Product): boolean {
  return !p.sealed && !UNPLAYABLE_SETS[p.setName] && !/\bcode card\b/i.test(p.name);
}

/**
 * Reminder text some printings include and others omit; it has no effect on
 * play, so it must not stop two printings from matching.
 */
const REMINDERS = [
  /you may play only 1 supporter card during your turn\.?/g,
  /you may play any number of item cards during your turn\.?/g,
  /you may play only 1 stadium card during your turn\.[^.]*\.?([^.]*can't be played\.)?/g,
  /attach a pok[eé]mon tool to 1 of your pok[eé]mon that doesn't already have a pok[eé]mon tool attached\.?/g,
  /you can't have more than 1 ace spec card in your deck\.?/g,
  /pok[eé]mon (ex|v|vmax|vstar|gx) rule:[^.]*\.?/g,
];

/** Lowercase, accents and punctuation removed: "Pokémon" ≡ "Pokemon", ’ ≡ '. */
function canonical(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function canonicalRules(text: string): string {
  let lowered = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’‘]/g, "'");
  for (const reminder of REMINDERS) lowered = lowered.replace(reminder, ' ');
  return canonical(lowered);
}

/**
 * Two products with the same key are the same card for deck building. Products
 * without gameplay text only match themselves.
 */
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

function label(p: Product, pinned: boolean): string {
  if (!pinned) return p.cardName;
  return `${p.cardName} ${p.number ?? ''} (${p.setName})`.replace(/\s+/g, ' ');
}

/**
 * Turn the cart into requirements: copies needed of a card, satisfiable by any
 * playable printing with identical gameplay text. Pinned products keep exactly
 * the cart printing. A failed candidate search degrades to the cart printings.
 */
export async function buildRequirements(
  cart: CartLine[],
  api: Pick<TcgApi, 'searchProducts' | 'getProducts'>,
  opts: { pinnedProductIds: ReadonlySet<ProductId> },
): Promise<{ requirements: Requirement[]; products: Map<ProductId, Product> }> {
  const quantities = new Map<ProductId, number>();
  for (const line of cart) quantities.set(line.productId, (quantities.get(line.productId) ?? 0) + line.quantity);

  const products = new Map<ProductId, Product>();
  for (const p of await api.getProducts([...quantities.keys()])) products.set(p.productId, p);

  const queries = new Map<string, Promise<Product[] | null>>();
  const search = (name: string) => {
    let pending = queries.get(name);
    if (!pending) {
      pending = api.searchProducts(name).catch(() => null);
      queries.set(name, pending);
    }
    return pending;
  };

  const requirements = new Map<string, Requirement>();
  for (const [productId, quantity] of quantities) {
    const product = products.get(productId);
    if (!product) throw new Error(`TCGplayer returned no details for product ${productId}`);

    if (opts.pinnedProductIds.has(productId)) {
      requirements.set(`pin:${productId}`, {
        id: `pin:${productId}`,
        label: label(product, true),
        quantity,
        candidates: [productId],
        pinned: true,
      });
      continue;
    }

    const key = gameplayKey(product);
    const existing = requirements.get(key);
    if (existing) {
      existing.quantity += quantity;
      if (!existing.candidates.includes(productId)) existing.candidates.push(productId);
      continue;
    }

    const candidates = new Set<ProductId>([productId]);
    if (key !== `product:${productId}`) {
      for (const found of (await search(product.cardName)) ?? []) {
        if (isPlayableSingle(found) && gameplayKey(found) === key) {
          candidates.add(found.productId);
          if (!products.has(found.productId)) products.set(found.productId, found);
        }
      }
    }
    requirements.set(key, { id: key, label: label(product, false), quantity, candidates: [...candidates], pinned: false });
  }

  // A pinned product must not also be a substitute inside another requirement.
  const pinned = new Set([...requirements.values()].filter((r) => r.pinned).flatMap((r) => r.candidates));
  const result = [...requirements.values()].map((r) =>
    r.pinned ? r : { ...r, candidates: r.candidates.filter((id) => !pinned.has(id)) },
  );
  return { requirements: result.filter((r) => r.candidates.length > 0), products };
}
