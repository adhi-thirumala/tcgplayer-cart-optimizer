import { useRef } from 'react';
import type { Plan } from '@/core/domain';
import type { CartCost } from '@/solver';
import { money, productUrl, sellerUrl, shippingRule } from './format';
import type { Session } from './machine';
import type { Optimizer } from './optimizer';

function PlanSummary({ plan, current }: { plan: Plan; current: CartCost | null }) {
  const savings = current ? current.total - plan.total : null;
  return (
    <dl className="summary">
      {current && (
        <div>
          <dt>Current cart</dt>
          <dd>{money(current.total)}</dd>
        </div>
      )}
      <div>
        <dt>Optimized</dt>
        <dd>{money(plan.total)}</dd>
      </div>
      {savings !== null && (
        <div className={savings > 0.004 ? 'good' : undefined}>
          <dt>{savings >= -0.004 ? 'You save' : 'Costs more by'}</dt>
          <dd>{money(Math.abs(savings))}</dd>
        </div>
      )}
      <div>
        <dt>Packages</dt>
        <dd>{plan.orders.length}</dd>
      </div>
    </dl>
  );
}

export function PlanView({ plan, session, optimizer, busy }: { plan: Plan; session: Session; optimizer: Optimizer; busy: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const labels = new Map(session.catalog.requirements.map((r) => [r.id, r.label]));

  return (
    <section className="panel" aria-labelledby="plan-title">
      <div className="panel-head">
        <h2 id="plan-title">Optimized cart</h2>
        <button type="button" className="primary" disabled={busy || plan.orders.length === 0} onClick={() => dialog.current?.showModal()}>
          Replace my cart with this
        </button>
      </div>
      <PlanSummary plan={plan} current={session.cost} />
      {plan.status === 'feasible' && (
        <p className="notice" role="status">
          The solver ran out of time; this is the best plan it found, not a proven optimum.
        </p>
      )}
      {plan.shortfall.length > 0 && (
        <div className="notice warn" role="alert">
          Not enough stock under your options for:
          <ul>
            {plan.shortfall.map((s) => (
              <li key={s.requirementId}>
                {s.missing}× {labels.get(s.requirementId) ?? s.requirementId}
              </li>
            ))}
          </ul>
          Loosen the seller rating or conditions to cover them.
        </div>
      )}
      <ol className="orders">
        {plan.orders.map(({ seller, items, subtotal, shipping }) => (
          <li key={seller.sellerId} className="order">
            <header>
              <a href={sellerUrl(seller.sellerKey)} target="_blank" rel="noreferrer" className="seller">
                {seller.name}
              </a>
              <span className="muted">
                {seller.rating === null ? 'unrated' : `${seller.rating}%`} · {seller.sales} sales · {shippingRule(seller.shipping)}
              </span>
              <button type="button" className="link" disabled={busy} onClick={() => optimizer.excludeSeller(seller)}>
                Exclude seller
              </button>
            </header>
            <table>
              <tbody>
                {items.map((item) => (
                  <tr key={item.listing.listingId}>
                    <td className="num">{item.quantity}×</td>
                    <td>
                      <a href={productUrl(item.listing.productId)} target="_blank" rel="noreferrer">
                        {labels.get(item.requirementId) ?? item.requirementId}
                      </a>
                      <span className="muted">
                        {' '}
                        · {item.listing.printing} · {item.listing.condition}
                      </span>
                    </td>
                    <td className="num">{money(item.listing.price)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td />
                  <td>Subtotal + shipping</td>
                  <td className="num">
                    {money(subtotal)} + {shipping === 0 ? 'free' : money(shipping)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </li>
        ))}
      </ol>
      <dialog ref={dialog} className="confirm" aria-labelledby="confirm-title">
        <form method="dialog">
          <h3 id="confirm-title">Replace your cart?</h3>
          <p>
            Every item in your TCGplayer cart will be removed and replaced with{' '}
            {plan.orders.length === 1 ? 'this package' : `these ${plan.orders.length} packages`} ({money(plan.total)}). Saved-for-later items stay.
          </p>
          <div className="actions">
            <button value="cancel" autoFocus>
              Cancel
            </button>
            <button value="apply" className="primary" onClick={() => optimizer.apply(plan)}>
              Replace cart
            </button>
          </div>
        </form>
      </dialog>
    </section>
  );
}
