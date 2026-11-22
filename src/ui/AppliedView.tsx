import type { CartAddRequest, CartAddResult, Plan } from '@/core/domain';
import type { CartCost } from '@/solver';
import { money } from './format';
import type { Session } from './machine';
import type { Optimizer } from './optimizer';

const keyOf = (request: CartAddRequest) => `${request.sku}:${request.sellerKey}`;

export function AppliedView({
  plan,
  results,
  cost,
  session,
  optimizer,
}: {
  plan: Plan;
  results: readonly CartAddResult[];
  cost: CartCost | null;
  session: Session;
  optimizer: Optimizer;
}) {
  const short = results.filter((r) => r._tag === 'Rejected' || r.quantityInCart < r.request.quantity);
  const repriced = results.flatMap((r) => (r._tag === 'Added' && Math.abs(r.currentPrice - r.request.price) > 0.004 ? [r] : []));
  const labels = new Map(session.catalog.requirements.map((r) => [r.id, r.label]));
  const names = new Map(
    plan.orders.flatMap((o) => o.items.map((i) => [keyOf(i.listing), `${labels.get(i.requirementId) ?? 'Card'} from ${o.seller.name}`])),
  );
  const describe = (request: CartAddRequest) => names.get(keyOf(request)) ?? `SKU ${request.sku}`;

  return (
    <section className="panel" aria-labelledby="applied-title">
      <h2 id="applied-title">Cart updated</h2>
      <p role="status">
        {short.length === 0 ? 'Every item was added.' : `${short.length} of ${results.length} items could not be added in full.`}{' '}
        {cost && (
          <>
            Your cart now costs <strong>{money(cost.total)}</strong> (planned {money(plan.total)}).
          </>
        )}
      </p>
      {short.length > 0 && (
        <div className="notice warn">
          <ul>
            {short.map((r) => (
              <li key={keyOf(r.request)}>
                {describe(r.request)}:{' '}
                {r._tag === 'Added' ? `${r.quantityInCart}/${r.request.quantity} added` : `not added (${r.reason})`}
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
              <li key={keyOf(r.request)}>
                {describe(r.request)}: {money(r.request.price)} → {money(r.currentPrice)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="actions">
        <button type="button" className="primary" onClick={optimizer.showCart}>
          Open cart on TCGplayer
        </button>
        <button type="button" onClick={optimizer.reloadCart}>
          Optimize again
        </button>
      </div>
    </section>
  );
}
