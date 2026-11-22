import type { Progress } from '@/core/types';
import { AppliedView } from './AppliedView';
import { CartSection } from './CartSection';
import { OptionsPanel } from './OptionsPanel';
import { PlanView } from './PlanView';
import { TabPicker } from './TabPicker';
import { useOptimizer } from './useOptimizer';

const PHASES: Record<Progress['phase'], string> = {
  listings: 'Fetching listings',
  sellers: 'Fetching seller shipping rules',
  cart: 'Adding items to your cart',
};

function ProgressPanel({ title, progress, onCancel }: { title: string; progress: Progress | null; onCancel?: () => void }) {
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

export function App() {
  const { state, actions } = useOptimizer();
  const { stage } = state;
  const busy = stage.kind === 'loading' || stage.kind === 'optimizing' || stage.kind === 'applying' || stage.kind === 'connecting';
  const sellerNames = new Map([...state.sellers.values()].map((s) => [s.sellerKey, s.name]));
  const canOptimize = state.requirements.some((r) => (state.quantities[r.id] ?? r.quantity) > 0);

  return (
    <main>
      <header className="page-head">
        <h1>TCGplayer Cart Optimizer</h1>
        <p className="muted">Cheapest way to buy your cart, counting each seller’s shipping and free-shipping threshold.</p>
      </header>

      {state.error && (
        <div className="notice error" role="alert">
          <p>{state.error}</p>
          <button type="button" className="link" onClick={actions.dismissError}>
            Dismiss
          </button>
        </div>
      )}

      {stage.kind === 'connecting' && <p aria-live="polite">Connecting to TCGplayer…</p>}
      {stage.kind === 'loading' && <p aria-live="polite">{stage.message}</p>}
      {stage.kind === 'needs-tab' && <TabPicker reason={stage.reason} actions={actions} />}

      {stage.kind === 'applied' ? (
        <AppliedView plan={stage.plan} results={stage.results} cost={stage.cost} requirements={state.requirements} actions={actions} />
      ) : (
        stage.kind !== 'needs-tab' &&
        stage.kind !== 'connecting' && (
          <>
            <CartSection state={state} actions={actions} busy={busy} />
            {state.options && state.cart.length > 0 && (
              <>
                <OptionsPanel options={state.options} sellerNames={sellerNames} actions={actions} disabled={busy} />
                <div className="actions">
                  <button type="button" className="primary" disabled={busy || !canOptimize} onClick={() => void actions.optimize()}>
                    {stage.kind === 'planned' ? 'Optimize again' : 'Optimize'}
                  </button>
                </div>
              </>
            )}
            {stage.kind === 'optimizing' && <ProgressPanel title="Optimizing" progress={stage.progress} onCancel={actions.cancel} />}
            {stage.kind === 'applying' && <ProgressPanel title="Updating your cart" progress={stage.progress} />}
            {(stage.kind === 'planned' || stage.kind === 'applying') && (
              <PlanView
                plan={stage.plan}
                current={state.currentCost}
                requirements={state.requirements}
                sellers={state.sellers}
                actions={actions}
                busy={busy}
              />
            )}
          </>
        )
      )}
    </main>
  );
}
