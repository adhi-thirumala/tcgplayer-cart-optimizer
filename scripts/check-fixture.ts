/**
 * Re-solves a captured market snapshot (gitignored `.local-fixtures/`) and
 * compares the totals with an independent PuLP/CBC model. That model pruned
 * each seller to its cheapest copies, so it could not overpay to reach free
 * shipping; this solver must match or beat it. Run: `bun scripts/check-fixture.ts [--plans]`
 */
import { Console, Effect, Schema } from 'effect';
import highsLoader from 'highs';
import { readFileSync } from 'node:fs';
import { Condition, DEFAULT_SOLVE_OPTIONS, type Listing, ProductId, type Requirement, type Seller, SellerId, SellerKey, Sku } from '../src/core/domain';
import { solveWith } from '../src/solver/solve';

const fixture = <S extends Schema.Top & { readonly DecodingServices: never }>(name: string, schema: S) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(schema))(readFileSync(new URL(`../.local-fixtures/${name}`, import.meta.url), 'utf8'));

const listings: Listing[] = Object.values(
  fixture(
    'tcg_listings.json',
    Schema.Record(
      Schema.String,
      Schema.Array(
        Schema.Struct({
          id: ProductId, lid: Schema.Number, seller: Schema.String, sellerId: SellerId, key: SellerKey, price: Schema.Number,
          qty: Schema.Int, printing: Schema.String, cond: Condition, pcid: Sku,
        }),
      ),
    ),
  ),
)
  .flat()
  .map((l) => ({
    listingId: l.lid, productId: l.id, sku: l.pcid, sellerId: l.sellerId, sellerKey: l.key,
    sellerName: l.seller, price: l.price, quantity: l.qty, condition: l.cond, printing: l.printing,
  }));

const keyOf = new Map(listings.map((l) => [l.sellerId, l.sellerKey]));
const sellers: Seller[] = fixture(
  'tcg_ship.json',
  Schema.Array(
    Schema.Struct({
      id: SellerId, name: Schema.String, rating: Schema.NullOr(Schema.Number), sales: Schema.String,
      th: Schema.optional(Schema.NullOr(Schema.Number)), under: Schema.optional(Schema.NullOr(Schema.Number)), over: Schema.optional(Schema.NullOr(Schema.Number)),
    }),
  ),
).flatMap((s) => {
  if (s.under == null) return [];
  const over = s.over ?? s.under;
  return [{
    sellerId: s.id, sellerKey: keyOf.get(s.id) ?? SellerKey.make(''), name: s.name, rating: s.rating, sales: s.sales,
    shipping: s.th != null && over < s.under ? { _tag: 'Threshold', under: s.under, over, threshold: s.th } : { _tag: 'Flat', price: s.under },
  }];
});

const need = fixture('tcg_need.json', Schema.Record(Schema.String, Schema.Struct({ qty: Schema.Int, ids: Schema.NonEmptyArray(ProductId) })));
const requirements = (skip: readonly string[]): Requirement[] =>
  Object.entries(need)
    .filter(([label]) => !skip.includes(label))
    .map(([label, { qty, ids }]) => ({ id: label, label, quantity: qty, candidates: ids, pinned: false }));

const CASES: ReadonlyArray<readonly [skip: readonly string[], reference: number]> = [
  [[], 14.14],
  [['Dudunsparce ex (JTG)'], 12.65],
];

const program = Effect.gen(function* () {
  const highs = yield* Effect.promise(() => highsLoader());
  let failed = false;
  for (const [skip, reference] of CASES) {
    const started = performance.now();
    const plan = yield* solveWith(highs, {
      requirements: requirements(skip),
      listings,
      sellers,
      options: DEFAULT_SOLVE_OPTIONS,
      timeLimitSec: 120,
    });
    const ms = Math.round(performance.now() - started);
    const ok = plan.status === 'optimal' && plan.total <= reference && plan.shortfall.length === 0;
    failed ||= !ok;
    yield* Console.log(`${ok ? 'ok  ' : 'FAIL'} ${plan.status} total=${plan.total} reference=${reference} packages=${plan.orders.length} ${ms}ms`);
    if (process.argv.includes('--plans')) {
      for (const o of plan.orders) {
        yield* Console.log(`  ${o.seller.name}: ${o.subtotal} + ${o.shipping}`);
        for (const it of o.items) yield* Console.log(`    ${it.quantity}x ${it.requirementId} @ ${it.listing.price} (${it.listing.productId})`);
      }
    }
  }
  return failed;
});

process.exit((await Effect.runPromise(program)) ? 1 : 0);
