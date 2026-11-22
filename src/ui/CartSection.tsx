import type { Product, ProductId, Requirement } from '@/core/domain';
import { money, productUrl } from './format';
import { type Session, requirementQuantity } from './machine';
import type { Optimizer } from './optimizer';

function printingLabel(p: Product | undefined, id: ProductId): string {
  return p ? [p.setName, p.number, p.rarity].filter(Boolean).join(' · ') : `Product ${id}`;
}

function RequirementRow({
  requirement,
  session,
  optimizer,
  disabled,
}: {
  requirement: Requirement;
  session: Session;
  optimizer: Optimizer;
  disabled: boolean;
}) {
  const { products } = session.catalog;
  const quantity = requirementQuantity(session, requirement);
  const inCart = Map.groupBy(
    session.cart.filter((line) => requirement.candidates.includes(line.productId)),
    (line) => line.productId,
  );
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
                In cart: {printingLabel(products.get(productId), productId)} · {lines.map((l) => `${l.quantity}× ${l.printing}`).join(', ')}
              </span>
              <label className="lock">
                <input
                  type="checkbox"
                  checked={session.pins.has(productId)}
                  disabled={disabled}
                  onChange={(e) => optimizer.setPinned(productId, e.currentTarget.checked)}
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
          onChange={(e) => optimizer.setQuantity(requirement.id, Math.max(0, Math.min(99, Math.trunc(e.currentTarget.valueAsNumber || 0))))}
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
                const p = products.get(id);
                return (
                  <li key={id}>
                    <a href={productUrl(id)} target="_blank" rel="noreferrer">
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

export function CartSection({ session, optimizer, busy }: { session: Session; optimizer: Optimizer; busy: boolean }) {
  const { cart, cost } = session;
  const copies = cart.reduce((n, l) => n + l.quantity, 0);
  const sellerCount = new Set(cart.map((l) => l.sellerId)).size;
  return (
    <section className="panel" aria-labelledby="cart-title">
      <div className="panel-head">
        <h2 id="cart-title">Your cart</h2>
        <button type="button" onClick={optimizer.reloadCart} disabled={busy}>
          Reload cart
        </button>
      </div>
      {cart.length === 0 ? (
        <p>Your TCGplayer cart is empty. Add the cards you want, then reload.</p>
      ) : (
        <>
          <p className="muted">
            {copies} {copies === 1 ? 'card' : 'cards'} from {sellerCount} {sellerCount === 1 ? 'seller' : 'sellers'}
            {cost && (
              <>
                {' '}
                · currently <strong>{money(cost.total)}</strong> ({money(cost.itemTotal)} + {money(cost.shippingTotal)} shipping)
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
              {session.catalog.requirements.map((r) => (
                <RequirementRow key={r.id} requirement={r} session={session} optimizer={optimizer} disabled={busy} />
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
