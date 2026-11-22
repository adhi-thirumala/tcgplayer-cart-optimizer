import type { CartAddResult, Plan, Requirement } from '@/core/types';
import type { CartCost } from '@/solver';
import { money } from './format';
import type { OptimizerActions } from './useOptimizer';

export function AppliedView({
  plan,
  results,
  cost,
  requirements,
  actions,
}: {
  plan: Plan;
  results: CartAddResult[];
  cost: CartCost | null;
  requirements: Requirement[];
  actions: OptimizerActions;
}) {
  const failed = results.filter((r) => !r.ok || r.quantityInCart < r.request.quantity);
  const repriced = results.filter((r) => r.ok && r.currentPrice !== null && Math.abs(r.currentPrice - r.request.price) > 0.004);
  const labels = new Map(requirements.map((r) => [r.id, r.label]));
  const names = new Map(
    plan.orders.flatMap((o) =>
      o.items.map((i) => [`${i.listing.sku}:${i.listing.sellerKey}`, `${labels.get(i.requirementId) ?? 'Card'} from ${o.sellerName}`]),
    ),
  );
  const describe = (r: CartAddResult) => names.get(`${r.request.sku}:${r.request.sellerKey}`) ?? `SKU ${r.request.sku}`;

  return (
    <section className="panel" aria-labelledby="applied-title">
      <h2 id="applied-title">Cart updated</h2>
      <p role="status">
        {failed.length === 0 ? 'Every item was added.' : `${failed.length} of ${results.length} items could not be added in full.`}{' '}
        {cost && (
          <>
            Your cart now costs <strong>{money(cost.total)}</strong> (planned {money(plan.total)}).
          </>
        )}
      </p>
      {failed.length > 0 && (
        <div className="notice warn">
          <ul>
            {failed.map((r) => (
              <li key={`${r.request.sku}:${r.request.sellerKey}`}>
                {describe(r)}: {r.quantityInCart}/{r.request.quantity} added{r.error ? ` (${r.error})` : ''}
              </li>
            ))}
          </ul>
          A listing sold or changed since prices were fetched. Optimize again to fill the gap.
        </div>
      )}
      {repriced.length > 0 && (
        <div className="notice">
          Prices changed:
          <ul>
            {repriced.map((r) => (
              <li key={`${r.request.sku}:${r.request.sellerKey}`}>
                {describe(r)}: {money(r.request.price)} → {money(r.currentPrice!)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="actions">
        <button type="button" className="primary" onClick={() => void actions.showCart()}>
          Open cart on TCGplayer
        </button>
        <button type="button" onClick={() => void actions.reloadCart()}>
          Optimize again
        </button>
      </div>
    </section>
  );
}
