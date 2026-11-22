import { useState, useSyncExternalStore } from 'react';
import type { Plan } from '@/core/domain';
import type { CartCost } from '@/solver';
import { ErrorNotice, ProgressPanel } from './App';
import { money } from './format';
import { type Session, type State, requirementQuantity } from './machine';
import type { Optimizer } from './optimizer';
import { TabPicker } from './TabPicker';

/** The full page attaches to the same background run, so it opens on the current plan. */
async function openFullPage() {
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  await browser.tabs.create({ url: browser.runtime.getURL('/optimizer.html'), index: active ? active.index + 1 : undefined });
  window.close();
}

function CartLine({ session, onReload }: { session: Session; onReload?: () => void }) {
  const copies = session.cart.reduce((n, l) => n + l.quantity, 0);
  const sellers = new Set(session.cart.map((l) => l.sellerId)).size;
  return (
    <p className="muted cart-line">
      {copies} {copies === 1 ? 'card' : 'cards'} · {sellers} {sellers === 1 ? 'seller' : 'sellers'}
      {session.cost && (
        <>
          {' '}
          · <strong>{money(session.cost.total)}</strong> now
        </>
      )}
      {onReload && (
        <>
          {' '}
          ·{' '}
          <button type="button" className="link" onClick={onReload}>
            Reload
          </button>
        </>
      )}
    </p>
  );
}

function Savings({ plan, current, sellers }: { plan: Plan; current: CartCost | null; sellers: number }) {
  const savings = current ? current.total - plan.total : null;
  return (
    <section className="savings" aria-live="polite">
      {savings === null ? (
        <p className="savings-amount">{money(plan.total)}</p>
      ) : savings > 0.004 ? (
        <>
          <p className="savings-label">You save</p>
          <p className="savings-amount good">{money(savings)}</p>
        </>
      ) : savings >= -0.004 ? (
        <p className="savings-label">Your cart is already the cheapest option.</p>
      ) : (
        <>
          <p className="savings-label">Costs more by</p>
          <p className="savings-amount">{money(-savings)}</p>
        </>
      )}
      <p className="muted">
        {current && (
          <>
            {money(current.total)} → <strong>{money(plan.total)}</strong> ·{' '}
          </>
        )}
        {sellers} {sellers === 1 ? 'seller' : 'sellers'} → {plan.orders.length} {plan.orders.length === 1 ? 'package' : 'packages'}
      </p>
    </section>
  );
}

function PlanResult({ plan, session, optimizer }: { plan: Plan; session: Session; optimizer: Optimizer }) {
  const [confirming, setConfirming] = useState(false);
  const missing = plan.shortfall.reduce((n, s) => n + s.missing, 0);
  return (
    <>
      <Savings plan={plan} current={session.cost} sellers={new Set(session.cart.map((l) => l.sellerId)).size} />
      {plan.status === 'feasible' && <p className="notice">Solver timed out; best plan found, not a proven optimum.</p>}
      {missing > 0 && (
        <p className="notice warn" role="alert">
          {missing} {missing === 1 ? 'card is' : 'cards are'} out of stock under your options. See the full page.
        </p>
      )}
      {confirming ? (
        <div className="notice confirm-inline" role="alertdialog" aria-labelledby="confirm-text">
          <p id="confirm-text">Remove everything in your TCGplayer cart and add these packages? Saved-for-later items stay.</p>
          <div className="actions">
            <button type="button" autoFocus onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={() => optimizer.apply(plan)}>
              Replace cart
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="primary big" disabled={plan.orders.length === 0} onClick={() => setConfirming(true)}>
          Replace my cart with this
        </button>
      )}
      <button type="button" onClick={optimizer.optimize}>
        Optimize again
      </button>
    </>
  );
}

function Body({ state, optimizer }: { state: State; optimizer: Optimizer }) {
  switch (state._tag) {
    case 'Connecting':
      return <p aria-live="polite">Connecting to TCGplayer…</p>;
    case 'ChoosingTab':
      return <TabPicker reason={state.reason} optimizer={optimizer} />;
    case 'LoadFailed':
      return (
        <>
          <ErrorNotice error={state.error} />
          <button type="button" className="primary big" onClick={optimizer.reloadCart}>
            Reload cart
          </button>
        </>
      );
    case 'Loading':
      return <p aria-live="polite">{state.message}</p>;
    case 'Editing':
    case 'Planned': {
      const { session } = state;
      if (session.cart.length === 0) {
        return (
          <>
            <p>Your TCGplayer cart is empty. Add the cards you want, then reload.</p>
            <button type="button" onClick={optimizer.reloadCart}>
              Reload cart
            </button>
          </>
        );
      }
      const canOptimize = session.catalog.requirements.some((r) => requirementQuantity(session, r) > 0);
      return (
        <>
          {state.error && <ErrorNotice error={state.error} onDismiss={optimizer.dismissError} />}
          <CartLine session={session} onReload={optimizer.reloadCart} />
          {state._tag === 'Planned' ? (
            <PlanResult plan={state.plan} session={session} optimizer={optimizer} />
          ) : (
            <button type="button" className="primary big" disabled={!canOptimize} onClick={optimizer.optimize}>
              Optimize cart
            </button>
          )}
        </>
      );
    }
    case 'Optimizing':
      return (
        <>
          <CartLine session={state.session} />
          <ProgressPanel title="Optimizing" progress={state.progress} onCancel={optimizer.cancel} />
          <p className="muted">You can close this popup; the result will be here when you reopen it.</p>
        </>
      );
    case 'Applying':
      return (
        <>
          <ProgressPanel title="Updating your cart" progress={state.progress} />
          <p className="muted">You can close this popup; the update keeps running.</p>
        </>
      );
    case 'Applied': {
      const failed = state.results.filter((r) => r._tag === 'Rejected' || r.quantityInCart < r.request.quantity).length;
      return (
        <>
          <section className="savings" role="status">
            <p className="savings-label">Cart updated</p>
            {state.cost && <p className="savings-amount">{money(state.cost.total)}</p>}
            <p className="muted">Planned {money(state.plan.total)}</p>
          </section>
          {failed > 0 && (
            <p className="notice warn">
              {failed} of {state.results.length} items could not be added in full; a listing sold or changed. Optimize again to fill the gap.
            </p>
          )}
          <button type="button" className="primary big" onClick={optimizer.showCart}>
            Open cart on TCGplayer
          </button>
          <button type="button" onClick={optimizer.reloadCart}>
            Optimize again
          </button>
        </>
      );
    }
  }
}

export function Popup({ optimizer }: { optimizer: Optimizer }) {
  const state = useSyncExternalStore(optimizer.subscribe, optimizer.getState);
  return (
    <main className="popup">
      <header className="popup-head">
        <h1>Cart Optimizer</h1>
        <button type="button" className="link" onClick={() => void openFullPage()}>
          Full page ↗
        </button>
      </header>
      <Body state={state} optimizer={optimizer} />
      {state._tag !== 'ChoosingTab' && state._tag !== 'Connecting' && (
        <p className="muted popup-foot">Quantities, printings, seller filters and the per-seller breakdown are on the full page.</p>
      )}
    </main>
  );
}
