import type { Catalog } from '@/catalog';
import type { CartAddResult, CartLine, Plan, ProductId, Progress, Requirement, SolveOptions } from '@/core/domain';
import type { CartCost } from '@/solver';

/** A loaded cart and what the user has chosen for it. */
export interface Session {
  readonly cart: readonly CartLine[];
  readonly cost: CartCost | null;
  readonly catalog: Catalog;
  /** Requirement id → copies the user wants, when changed from the cart's count (0 skips it). */
  readonly quantities: ReadonlyMap<string, number>;
  readonly pins: ReadonlySet<ProductId>;
  readonly options: SolveOptions;
}

export type State =
  | { readonly _tag: 'Connecting' }
  | { readonly _tag: 'ChoosingTab'; readonly reason: string }
  | { readonly _tag: 'Loading'; readonly message: string; readonly session: Session | null }
  | { readonly _tag: 'LoadFailed'; readonly error: string }
  | { readonly _tag: 'Editing'; readonly session: Session; readonly error: string | null }
  | { readonly _tag: 'Optimizing'; readonly session: Session; readonly progress: Progress | null }
  | { readonly _tag: 'Planned'; readonly session: Session; readonly plan: Plan; readonly error: string | null }
  | { readonly _tag: 'Applying'; readonly session: Session; readonly plan: Plan; readonly progress: Progress | null }
  | { readonly _tag: 'Applied'; readonly session: Session; readonly plan: Plan; readonly results: readonly CartAddResult[]; readonly cost: CartCost | null };

export type Event =
  | { readonly _tag: 'ConnectStarted' }
  | { readonly _tag: 'TabNeeded'; readonly reason: string }
  | { readonly _tag: 'LoadStarted'; readonly message: string }
  | { readonly _tag: 'PinsChanged'; readonly pins: ReadonlySet<ProductId> }
  | { readonly _tag: 'Loaded'; readonly session: Session }
  | { readonly _tag: 'QuantityChanged'; readonly requirementId: string; readonly quantity: number }
  | { readonly _tag: 'OptionsChanged'; readonly options: SolveOptions }
  | { readonly _tag: 'OptimizeStarted' }
  | { readonly _tag: 'ProgressMade'; readonly progress: Progress | null }
  | { readonly _tag: 'PlanReady'; readonly plan: Plan }
  | { readonly _tag: 'Cancelled' }
  | { readonly _tag: 'ApplyStarted'; readonly plan: Plan }
  | { readonly _tag: 'CartReplaced'; readonly results: readonly CartAddResult[]; readonly cost: CartCost | null }
  | { readonly _tag: 'Failed'; readonly error: string }
  | { readonly _tag: 'ErrorDismissed' };

export const initialState: State = { _tag: 'Connecting' };

/** The only way the optimizer page changes state. An event the current state does not accept leaves it unchanged. */
export function transition(state: State, event: Event): State {
  switch (event._tag) {
    case 'ConnectStarted':
      return { _tag: 'Connecting' };
    case 'TabNeeded':
      return { _tag: 'ChoosingTab', reason: event.reason };
    case 'LoadStarted':
      switch (state._tag) {
        case 'Connecting':
        case 'LoadFailed':
          return { _tag: 'Loading', message: event.message, session: null };
        case 'Loading':
          return { ...state, message: event.message };
        case 'Editing':
        case 'Planned':
        case 'Applied':
          return { _tag: 'Loading', message: event.message, session: state.session };
        default:
          return state;
      }
    case 'PinsChanged':
      return state._tag === 'Editing' || state._tag === 'Planned'
        ? { _tag: 'Loading', message: 'Updating printings…', session: { ...state.session, pins: event.pins } }
        : state;
    case 'Loaded':
      return state._tag === 'Loading' ? { _tag: 'Editing', session: event.session, error: null } : state;
    case 'QuantityChanged':
      return state._tag === 'Editing' || state._tag === 'Planned'
        ? {
            _tag: 'Editing',
            session: { ...state.session, quantities: new Map(state.session.quantities).set(event.requirementId, event.quantity) },
            error: null,
          }
        : state;
    case 'OptionsChanged':
      return state._tag === 'Editing' || state._tag === 'Planned' ? { ...state, session: { ...state.session, options: event.options } } : state;
    case 'OptimizeStarted':
      return state._tag === 'Editing' || state._tag === 'Planned' ? { _tag: 'Optimizing', session: state.session, progress: null } : state;
    case 'ProgressMade':
      return state._tag === 'Optimizing' || state._tag === 'Applying' ? { ...state, progress: event.progress } : state;
    case 'PlanReady':
      return state._tag === 'Optimizing' ? { _tag: 'Planned', session: state.session, plan: event.plan, error: null } : state;
    case 'Cancelled':
      return state._tag === 'Optimizing' ? { _tag: 'Editing', session: state.session, error: null } : state;
    case 'ApplyStarted':
      return state._tag === 'Planned' ? { _tag: 'Applying', session: state.session, plan: event.plan, progress: null } : state;
    case 'CartReplaced':
      return state._tag === 'Applying'
        ? { _tag: 'Applied', session: state.session, plan: state.plan, results: event.results, cost: event.cost }
        : state;
    case 'Failed':
      switch (state._tag) {
        case 'Connecting':
          return { _tag: 'LoadFailed', error: event.error };
        case 'Loading':
          return state.session ? { _tag: 'Editing', session: state.session, error: event.error } : { _tag: 'LoadFailed', error: event.error };
        case 'Optimizing':
          return { _tag: 'Editing', session: state.session, error: event.error };
        case 'Applying':
          return { _tag: 'Planned', session: state.session, plan: state.plan, error: event.error };
        default:
          return state;
      }
    case 'ErrorDismissed':
      return state._tag === 'Editing' || state._tag === 'Planned' ? { ...state, error: null } : state;
  }
}

export function requirementQuantity(session: Session, requirement: Requirement): number {
  return session.quantities.get(requirement.id) ?? requirement.quantity;
}
