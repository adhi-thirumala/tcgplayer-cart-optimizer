import { useSyncExternalStore } from 'react';
import type { Progress } from '@/core/domain';
import { AppliedView } from './AppliedView';
import { CartSection } from './CartSection';
import { type Session, type State, requirementQuantity } from './machine';
import type { Optimizer } from './optimizer';
import { OptionsPanel } from './OptionsPanel';
import { PlanView } from './PlanView';
import { TabPicker } from './TabPicker';

const PHASES: Record<Progress['phase'], string> = {
  listings: 'Fetching listings',
  sellers: 'Fetching seller shipping rules',
  cart: 'Adding items to your cart',
};

export function ProgressPanel({ title, progress, onCancel }: { title: string; progress: Progress | null; onCancel?: () => void }) {
  return (
    <section className="panel progress" aria-live="polite" aria-busy="true">
      <div className="panel-head">
        <h2>{title}</h2>
        {onCancel && (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {progress ? (
        <>
          <p>
            {PHASES[progress.phase]}: {progress.done} / {progress.total}
          </p>
          <progress max={Math.max(progress.total, 1)} value={progress.done} />
        </>
      ) : (
        <>
          <p>Solving…</p>
          <progress />
        </>
      )}
    </section>
  );
}

export function ErrorNotice({ error, onDismiss }: { error: string; onDismiss?: () => void }) {
  return (
    <div className="notice error" role="alert">
      <p>{error}</p>
      {onDismiss && (
        <button type="button" className="link" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  );
}

/** The cart, the options and the plan, for every state that has a loaded cart. */
function Workspace({ state, session, optimizer }: { state: State; session: Session; optimizer: Optimizer }) {
  const busy = state._tag !== 'Editing' && state._tag !== 'Planned';
  const canOptimize = session.catalog.requirements.some((r) => requirementQuantity(session, r) > 0);
  return (
    <>
      <CartSection session={session} optimizer={optimizer} busy={busy} />
      {session.cart.length > 0 && (
        <>
          <OptionsPanel options={session.options} optimizer={optimizer} disabled={busy} />
          <div className="actions">
            <button type="button" className="primary" disabled={busy || !canOptimize} onClick={optimizer.optimize}>
              {state._tag === 'Planned' ? 'Optimize again' : 'Optimize'}
            </button>
          </div>
        </>
      )}
      {state._tag === 'Optimizing' && <ProgressPanel title="Optimizing" progress={state.progress} onCancel={optimizer.cancel} />}
      {state._tag === 'Applying' && <ProgressPanel title="Updating your cart" progress={state.progress} />}
      {(state._tag === 'Planned' || state._tag === 'Applying') && (
        <PlanView plan={state.plan} session={session} optimizer={optimizer} busy={busy} />
      )}
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
          <div className="actions">
            <button type="button" className="primary" onClick={optimizer.reloadCart}>
              Reload cart
            </button>
          </div>
        </>
      );
    case 'Loading':
      return (
        <>
          <p aria-live="polite">{state.message}</p>
          {state.session && <Workspace state={state} session={state.session} optimizer={optimizer} />}
        </>
      );
    case 'Editing':
    case 'Planned':
      return (
        <>
          {state.error && <ErrorNotice error={state.error} onDismiss={optimizer.dismissError} />}
          <Workspace state={state} session={state.session} optimizer={optimizer} />
        </>
      );
    case 'Optimizing':
    case 'Applying':
      return <Workspace state={state} session={state.session} optimizer={optimizer} />;
    case 'Applied':
      return <AppliedView plan={state.plan} results={state.results} cost={state.cost} session={state.session} optimizer={optimizer} />;
  }
}

export function App({ optimizer }: { optimizer: Optimizer }) {
  const state = useSyncExternalStore(optimizer.subscribe, optimizer.getState);
  return (
    <main>
      <header className="page-head">
        <h1>TCGplayer Cart Optimizer</h1>
        <p className="muted">The cheapest way to buy your cart, counting each seller’s shipping and free-shipping threshold.</p>
      </header>
      <Body state={state} optimizer={optimizer} />
    </main>
  );
}
