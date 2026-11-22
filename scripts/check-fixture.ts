/**
 * Dev check against a real captured market snapshot (gitignored `.local-fixtures/`).
 * Reference totals come from an independent PuLP/CBC model that pruned each
 * seller to its cheapest copies, so it could not overpay to reach free
 * shipping; this solver must match or beat them. Run: `bun scripts/check-fixture.ts`
 */
import highsLoader from 'highs';
import { readFileSync } from 'node:fs';
import type { Condition, Listing, Requirement, SellerShipping } from '../src/core/types';
import { DEFAULT_SOLVE_OPTIONS } from '../src/core/types';
import { solveWith } from '../src/solver/solve';

const dir = new URL('../.local-fixtures/', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));

type RawListing = {
  id: number; lid: number; seller: string; sellerId: number; key: string; price: number;
  qty: number; printing: string; cond: string; direct: boolean; pcid: number;
};
type RawSeller = { id: number; name: string; rating: number | null; sales: string; th: number | null; under: number | null; over: number | null };

const listings: Listing[] = Object.values(read('tcg_listings.json') as Record<string, RawListing[]>)
  .flat()
  .map((l) => ({
    listingId: l.lid, productId: l.id, sku: l.pcid, sellerId: l.sellerId, sellerKey: l.key,
    sellerName: l.seller, price: l.price, quantity: l.qty, condition: l.cond as Condition,
    printing: l.printing, language: 'English', directSeller: l.direct,
  }));
const keyOf = new Map(listings.map((l) => [l.sellerId, l.sellerKey]));
const sellers: SellerShipping[] = (read('tcg_ship.json') as RawSeller[])
  .filter((s) => s.under !== null)
  .map((s) => ({
    sellerId: s.id, sellerKey: keyOf.get(s.id) ?? '', name: s.name, rating: s.rating, sales: s.sales,
    thresholdPrice: s.th, priceUnder: s.under!, priceOver: s.over ?? s.under!,
  }));
const need = read('tcg_need.json') as Record<string, { qty: number; ids: number[] }>;
const requirements = (skip: string[]): Requirement[] =>
  Object.entries(need)
    .filter(([label]) => !skip.includes(label))
    .map(([label, { qty, ids }]) => ({ id: label, label, quantity: qty, candidates: ids, pinned: false }));

const highs = await highsLoader();
let failed = false;
for (const [skip, reference] of [[[], 14.14], [['Dudunsparce ex (JTG)'], 12.65]] as const) {
  const started = performance.now();
  const plan = solveWith(highs, {
    requirements: requirements([...skip]),
    listings,
    sellers,
    options: { ...DEFAULT_SOLVE_OPTIONS, timeLimitSec: 120 },
  });
  const ms = Math.round(performance.now() - started);
  const ok = plan.status === 'optimal' && plan.total <= reference && plan.shortfall.length === 0;
  failed ||= !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${plan.status} total=${plan.total} reference=${reference} packages=${plan.orders.length} ${ms}ms`);
  if (process.argv.includes('--plans')) {
    for (const o of plan.orders) {
      console.log(`  ${o.sellerName}: ${o.subtotal} + ${o.shipping}`);
      for (const it of o.items) console.log(`    ${it.quantity}x ${it.requirementId} @ ${it.listing.price} (${it.listing.productId})`);
    }
  }
}
process.exit(failed ? 1 : 0);
