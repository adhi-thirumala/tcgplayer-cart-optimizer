import type { CartLine, Product, ProductId, Requirement } from '@/core/types';
import { money } from './format';
import { requirementQuantity, type OptimizerActions, type State } from './useOptimizer';

function printingLabel(p: Product | undefined, id: ProductId): string {
  if (!p) return `Product ${id}`;
  return [p.setName, p.number, p.rarity].filter(Boolean).join(' · ');
}

function RequirementRow({
  requirement,
  state,
  actions,
  disabled,
}: {
  requirement: Requirement;
  state: State;
  actions: OptimizerActions;
  disabled: boolean;
}) {
  const quantity = requirementQuantity(state, requirement);
  const inCart = new Map<ProductId, CartLine[]>();
  for (const line of state.cart) {
    if (requirement.candidates.includes(line.productId)) {
      inCart.set(line.productId, [...(inCart.get(line.productId) ?? []), line]);
    }
  }
  const inputId = `qty-${requirement.id}`;

  return (
    <tr className={quantity === 0 ? 'skipped' : undefined}>
      <td>
        <label htmlFor={inputId} className="card-name">
          {requirement.label}
        </label>
        <ul className="cart-printings">
          {[...inCart].map(([productId, lines]) => (
            <li key={productId}>
              <span className="muted">
                In cart: {printingLabel(state.products.get(productId), productId)} ·{' '}
                {lines.map((l) => `${l.quantity}× ${l.printing}`).join(', ')}
              </span>
              <label className="lock">
                <input
                  type="checkbox"
                  checked={state.pins.has(productId)}
                  disabled={disabled}
                  onChange={(e) => void actions.setPinned(productId, e.currentTarget.checked)}
                />
                Exact printing only
              </label>
            </li>
          ))}
        </ul>
      </td>
      <td className="num">
        <input
          id={inputId}
          type="number"
          min={0}
          max={99}
          value={quantity}
          disabled={disabled}
          onChange={(e) => {
            const value = Math.max(0, Math.min(99, Math.trunc(e.currentTarget.valueAsNumber || 0)));
            actions.setQuantity(requirement.id, value);
          }}
        />
      </td>
      <td>
        {requirement.candidates.length === 1 ? (
          <span className="muted">{requirement.pinned ? 'Locked' : 'Only this printing'}</span>
        ) : (
          <details>
            <summary>{requirement.candidates.length} printings</summary>
            <ul className="printings">
              {requirement.candidates.map((id) => {
                const p = state.products.get(id);
                return (
                  <li key={id}>
                    <a href={p?.url ?? `https://www.tcgplayer.com/product/${id}`} target="_blank" rel="noreferrer">
                      {printingLabel(p, id)}
                    </a>
                    {p?.lowestPrice != null && <span className="muted"> from {money(p.lowestPrice)}</span>}
                  </li>
                );
              })}
            </ul>
          </details>
        )}
      </td>
    </tr>
  );
}

export function CartSection({ state, actions, busy }: { state: State; actions: OptimizerActions; busy: boolean }) {
  const copies = state.cart.reduce((n, l) => n + l.quantity, 0);
  const sellerCount = new Set(state.cart.map((l) => l.sellerId)).size;
  return (
    <section className="panel" aria-labelledby="cart-title">
      <div className="panel-head">
        <h2 id="cart-title">Your cart</h2>
        <button type="button" onClick={() => void actions.reloadCart()} disabled={busy}>
          Reload cart
        </button>
      </div>
      {state.cart.length === 0 ? (
        <p>Your TCGplayer cart is empty. Add the cards you want, then reload.</p>
      ) : (
        <>
          <p className="muted">
            {copies} {copies === 1 ? 'card' : 'cards'} from {sellerCount} {sellerCount === 1 ? 'seller' : 'sellers'}
            {state.currentCost && (
              <>
                {' '}
                · currently <strong>{money(state.currentCost.total)}</strong> ({money(state.currentCost.itemTotal)} +{' '}
                {money(state.currentCost.shippingTotal)} shipping)
              </>
            )}
          </p>
          <table className="requirements">
            <thead>
              <tr>
                <th scope="col">Card</th>
                <th scope="col" className="num">
                  Qty
                </th>
                <th scope="col">Accepted printings</th>
              </tr>
            </thead>
            <tbody>
              {state.requirements.map((r) => (
                <RequirementRow key={r.id} requirement={r} state={state} actions={actions} disabled={busy} />
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
