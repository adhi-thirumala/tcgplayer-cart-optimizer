import { describe, expect, it } from 'vitest';
import type { CardText, CartLine, Product, TcgApi } from '@/core/types';
import { cardTextOf, toProduct } from '@/tcgplayer/mappers';
import { buildRequirements, gameplayKey, isPlayableSingle } from './index';

// Shapes and text below are real TCGplayer search results (trimmed), including
// the formatting differences between printings that matching must survive.
const BBT_TEXT =
  "During this turn, attacks used by your Pokemon do 40 more damage to your opponent's Active Pokemon ex <em>(before applying Weakness and Resistance)</em>.";
const BBT_TEXT_ACCENTED =
  "During this turn, attacks used by your Pokémon do 40 more damage to your opponent's Active Pokémon ex (before applying Weakness and Resistance).";

function product(productId: number, productName: string, setName: string, attributes: Record<string, unknown>, extra: Partial<Product> = {}): Product {
  return { ...toProduct({ productId, productName, setName, customAttributes: attributes }), ...extra };
}

const supporter = (description: string) => ({ cardType: ['Supporter'], description });
const banettePBL = {
  cardType: ['Pokemon'], stage: 'Stage 1', hp: '100', energyType: ['Psychic'],
  description: "<strong>Ability: Hide 'n' Sneak</strong> Prevent all effects of your opponent's Pokémon's attacks and Abilities done to this Pokémon.",
  attack1: '[2P] Shadow Claw (60)', weakness: 'Dx2', retreatCost: '1',
};
const banetteVIV = {
  cardType: ['Pokemon'], stage: 'Stage 1', hp: '90', energyType: ['Psychic'],
  description: '<strong>Ability — Curse of Devolution</strong><br>When you play this Pokémon from your hand to evolve 1 of your Pokémon during your turn, you may devolve 1 of your opponent\'s Benched Evolution Pokémon.',
  attack1: '[1P] Spooky Shot (40)', weakness: 'Dx2', resistance: 'F-30', retreatCost: '1',
};
const prismTower = { cardType: ['Stadium'], description: "Once during each player's turn, that player may discard 2 cards from their hand in order to draw a card." };

const catalog: Product[] = [
  product(623571, "Black Belt's Training - 144/159", 'SV09: Journey Together', supporter(BBT_TEXT_ACCENTED)),
  product(623570, "Black Belt's Training - 143/159", 'SV09: Journey Together', supporter(BBT_TEXT_ACCENTED)),
  product(610452, "Black Belt's Training - 097/131", 'SV: Prismatic Evolutions', supporter(BBT_TEXT)),
  product(610608, "Black Belt's Training - 097/131 (Poke Ball Pattern)", 'SV: Prismatic Evolutions', supporter(BBT_TEXT)),
  product(664825, "Black Belt's Training - 219", 'SV: Scarlet & Violet Promo Cards', supporter(BBT_TEXT)),
  product(637599, "Black Belt's Training - 2025 (Someone)", 'World Championship Decks', supporter(BBT_TEXT)),
  product(704791, 'Banette', 'ME05: Pitch Black', banettePBL),
  product(226472, 'Banette', 'SWSH04: Vivid Voltage', banetteVIV),
  product(564470, 'Banette', 'Jumbo Cards', banettePBL),
  product(693534, 'Prism Tower - 080/086', 'ME04: Chaos Rising', prismTower),
  product(693535, 'Prism Tower - 111/086', 'ME04: Chaos Rising', prismTower),
  product(704848, 'Dhelmise - 091/084', 'ME05: Pitch Black', { cardType: ['Pokemon'], hp: '120', attack1: '[G] Anchor Shot (50)', number: '091/084' }),
  product(704796, 'Dhelmise - 039/084', 'ME05: Pitch Black', { cardType: ['Pokemon'], hp: '120', attack1: '[G] Anchor Shot (50)', number: '039/084' }),
  product(900001, 'Mystery Promo', 'Miscellaneous Cards & Products', {}),
  product(900002, 'Mystery Promo (Stamped)', 'Miscellaneous Cards & Products', {}),
];
const byId = new Map(catalog.map((p) => [p.productId, p]));

function fakeApi(failSearchFor: string[] = []): Pick<TcgApi, 'searchProducts' | 'getProducts'> & { searches: string[] } {
  const searches: string[] = [];
  return {
    searches,
    async getProducts(ids) {
      return ids.map((id) => byId.get(id)!);
    },
    async searchProducts(query) {
      searches.push(query);
      if (failSearchFor.includes(query)) throw new Error('search down');
      return catalog.filter((p) => p.cardName.toLowerCase().includes(query.toLowerCase()));
    },
  };
}

function line(productId: number, quantity: number): CartLine {
  const p = byId.get(productId)!;
  return {
    sku: productId * 10, productId, sellerId: 1, sellerKey: 'k', sellerName: 'S', name: p.name, setName: p.setName,
    number: p.number, condition: 'Near Mint', printing: 'Normal', quantity, price: 1,
  };
}

const noPins = { pinnedProductIds: new Set<number>() };

describe('gameplayKey', () => {
  it('matches printings whose text differs only in accents and markup', () => {
    expect(gameplayKey(byId.get(623571)!)).toBe(gameplayKey(byId.get(610452)!));
  });

  it('ignores reminder text present on only some printings', () => {
    const withReminder = product(1, "Black Belt's Training", 'X', supporter(`${BBT_TEXT}<br><br>You may play only 1 Supporter card during your turn.`));
    expect(gameplayKey(withReminder)).toBe(gameplayKey(byId.get(610452)!));
  });

  it('separates same-named Pokémon with different attacks', () => {
    expect(gameplayKey(byId.get(704791)!)).not.toBe(gameplayKey(byId.get(226472)!));
  });

  it('never merges products without gameplay text on name alone', () => {
    expect(gameplayKey(byId.get(900001)!)).not.toBe(gameplayKey(byId.get(900002)!));
  });
});

describe('isPlayableSingle', () => {
  it('rejects jumbo, world-championship, code-card and sealed products', () => {
    expect(isPlayableSingle(byId.get(564470)!)).toBe(false);
    expect(isPlayableSingle(byId.get(637599)!)).toBe(false);
    expect(isPlayableSingle(product(2, 'Code Card - Journey Together Booster Pack', 'SV09: Journey Together', {}))).toBe(false);
    expect(isPlayableSingle(product(3, 'Journey Together Booster Box', 'SV09: Journey Together', {}, { sealed: true }))).toBe(false);
    expect(isPlayableSingle(byId.get(704791)!)).toBe(true);
  });
});

describe('buildRequirements', () => {
  it('merges cart printings of the same card into one requirement', async () => {
    const { requirements } = await buildRequirements([line(693534, 1), line(693535, 1)], fakeApi(), noPins);
    expect(requirements).toHaveLength(1);
    expect(requirements[0]).toMatchObject({ label: 'Prism Tower', quantity: 2, pinned: false });
    expect(requirements[0]!.candidates.sort()).toEqual([693534, 693535]);
  });

  it('finds substitutes across sets and excludes unplayable printings', async () => {
    const { requirements, products } = await buildRequirements([line(623571, 1)], fakeApi(), noPins);
    expect(requirements[0]!.candidates.sort()).toEqual([610452, 610608, 623570, 623571, 664825]);
    expect(products.has(664825)).toBe(true);
  });

  it('keeps different cards that share a name apart', async () => {
    const { requirements } = await buildRequirements([line(704791, 4)], fakeApi(), noPins);
    expect(requirements[0]!.candidates).toEqual([704791]);
  });

  it('splits a pinned printing into its own exact requirement', async () => {
    const api = fakeApi();
    const { requirements } = await buildRequirements(
      [line(704848, 4), line(704796, 2)],
      api,
      { pinnedProductIds: new Set([704848]) },
    );
    const pinned = requirements.find((r) => r.pinned)!;
    const loose = requirements.find((r) => !r.pinned)!;
    expect(pinned).toMatchObject({ id: 'pin:704848', quantity: 4, candidates: [704848] });
    expect(pinned.label).toContain('091/084');
    expect(loose.quantity).toBe(2);
    expect(loose.candidates).toEqual([704796]);
  });

  it('degrades to the cart printing when search fails', async () => {
    const { requirements } = await buildRequirements([line(693534, 2)], fakeApi(['Prism Tower']), noPins);
    expect(requirements[0]).toMatchObject({ quantity: 2, candidates: [693534] });
  });

  it('searches each card name once', async () => {
    const api = fakeApi();
    await buildRequirements([line(693534, 1), line(693535, 1), line(623571, 1)], api, noPins);
    expect(api.searches.sort()).toEqual(["Black Belt's Training", 'Prism Tower']);
  });
});

describe('cardTextOf', () => {
  it('strips markup and drops empty attacks', () => {
    const text: CardText = cardTextOf({ description: 'A<br>B &amp; C', attack1: '[C] Hit (10)', attack2: null });
    expect(text.rulesText).toBe('A B & C');
    expect(text.attacks).toEqual(['[C] Hit (10)']);
  });
});
