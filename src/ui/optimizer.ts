import { Cause, Effect, Exit, FiberHandle, Predicate, Scope } from 'effect';
import { RpcClient, RpcClientError, type RpcGroup } from 'effect/rpc';
import { buildRequirements } from '@/catalog';
import type { Listing, Plan, ProductId, Progress, Requirement, Seller, SellerId, SolveInput, SolveOptions } from '@/core/domain';
import { portClientProtocol } from '@/core/port-rpc';
// Not '@/solver': its index starts the solver worker, which would pull the worker (and its inlined WebAssembly) into the background bundle.
import { evaluateCart, planToCartAdds } from '@/solver/model';
import type { SolverError } from '@/solver/solve';
import { TCG_PORT, TcgRpcs, collectProgress } from '@/tcgplayer/rpcs';
import { type Event, type Session, type State, initialState, requirementQuantity, transition } from './machine';
import { loadOptions, loadPins, saveOptions, savePins } from './settings';

const CART_URL = 'https://www.tcgplayer.com/cart';
const SOLVE_TIME_LIMIT_SEC = 30;
const LOST_CONNECTION =
  'Lost the connection to the TCGplayer tab. It was closed or reloaded, or it was opened before the extension was installed; reload it and try again.';

type TcgClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof TcgRpcs>, RpcClientError.RpcClientError>;

interface Connection {
  readonly tabId: number;
  readonly client: TcgClient;
  readonly isClosed: () => boolean;
  readonly close: Effect.Effect<void>;
}

const openConnection = (tabId: number) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const port = browser.tabs.connect(tabId, { name: TCG_PORT });
    let closed = false;
    port.onDisconnect.addListener(() => {
      closed = true;
    });
    const client = yield* RpcClient.make(TcgRpcs).pipe(
      Effect.provideServiceEffect(RpcClient.Protocol, portClientProtocol(port, LOST_CONNECTION)),
      Scope.provide(scope),
    );
    return { tabId, client, isClosed: () => closed, close: Scope.close(scope, Exit.void) } satisfies Connection;
  });

const waitForTabLoad = (tabId: number) =>
  Effect.callback<void>((resume) => {
    const listener = (id: number, info: { status?: string }) => {
      if (id !== tabId || info.status !== 'complete') return;
      browser.tabs.onUpdated.removeListener(listener);
      resume(Effect.void);
    };
    browser.tabs.onUpdated.addListener(listener);
    return Effect.sync(() => browser.tabs.onUpdated.removeListener(listener));
  });

/** A lost tab sends the user to the tab picker, because reloading the cart cannot reach it. Any other failure is shown as an error. */
function failureEvent(cause: Cause.Cause<unknown>, note = ''): Event {
  const error = Cause.squash(cause);
  if (error instanceof RpcClientError.RpcClientError) return { _tag: 'TabNeeded', reason: error.reason.message + note };
  return { _tag: 'Failed', error: (Predicate.hasProperty(error, 'message') ? String(error.message) : String(error)) + note };
}

/** What the UI pages drive. They hold a remote copy; the engine itself runs in the background. */
export interface Optimizer {
  readonly getState: () => State;
  readonly subscribe: (listener: () => void) => () => void;
  readonly findTabs: () => Promise<Browser.tabs.Tab[]>;
  /** `reload` first reloads the tab, which injects the content script into tabs opened before install. */
  readonly connect: (tabId: number, reload: boolean) => void;
  readonly openCartTab: () => void;
  readonly reloadCart: () => void;
  readonly setPinned: (productId: ProductId, pinned: boolean) => void;
  readonly setQuantity: (requirementId: string, quantity: number) => void;
  readonly setOptions: (options: SolveOptions) => void;
  readonly excludeSeller: (seller: Seller) => void;
  readonly optimize: () => void;
  readonly cancel: () => void;
  readonly apply: (plan: Plan) => void;
  readonly showCart: () => void;
  readonly dismissError: () => void;
}

export interface Engine extends Omit<Optimizer, 'findTabs'> {
  /** A page opened. `tabId` is the TCGplayer tab it was opened over; it connects the engine if nothing is connected yet. */
  readonly attach: (tabId: number | null) => void;
  /** A job is running, so the background must stay alive. */
  readonly busy: () => boolean;
}

export type Solve = (input: SolveInput) => Effect.Effect<Plan, SolverError>;

/**
 * The optimizer, run in the background so work survives closing the popup.
 * Each command starts at most one job; a new job interrupts the one before
 * it. Jobs report what happens as machine events.
 */
export function createOptimizer(solve: Solve): Engine {
  let state = initialState;
  const listeners = new Set<() => void>();
  const dispatch = (event: Event) =>
    Effect.sync(() => {
      const next = transition(state, event);
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    });

  const jobs = Effect.runSync(FiberHandle.make<void, never>().pipe(Scope.provide(Effect.runSync(Scope.make()))));
  /** Before the first job, `Connecting` means no page has attached yet. */
  let started = false;
  const run = (job: Effect.Effect<void, unknown>) => {
    started = true;
    return Effect.runFork(
      FiberHandle.run(
        jobs,
        job.pipe(Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : dispatch(failureEvent(cause))))),
      ),
    );
  };

  let connection: Connection | null = null;
  /** The live client. Any tcgplayer.com page serves the API, so a tab that navigated gets a fresh connection. */
  const tcg: Effect.Effect<TcgClient> = Effect.suspend(() => {
    if (!connection) return Effect.die('Not connected to a TCGplayer tab.');
    if (!connection.isClosed()) return Effect.succeed(connection.client);
    const { tabId } = connection;
    return connection.close.pipe(
      Effect.andThen(openConnection(tabId)),
      Effect.map((fresh) => {
        connection = fresh;
        return fresh.client;
      }),
    );
  });

  const sellers = new Map<SellerId, Seller>();
  /** Listings per product for one condition set, so a re-solve fetches only products not seen yet. */
  let listingCache = { conditions: '', byProduct: new Map<ProductId, Listing[]>() };
  const reportProgress = (progress: Progress) => dispatch({ _tag: 'ProgressMade', progress });

  const ensureSellers = (sellerIds: readonly SellerId[], onProgress: (progress: Progress) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      const missing = [...new Set(sellerIds)].filter((id) => !sellers.has(id));
      if (missing.length === 0) return;
      const client = yield* tcg;
      for (const seller of yield* collectProgress(client.FetchSellers({ sellerIds: missing }), onProgress)) sellers.set(seller.sellerId, seller);
    });

  const catalogFor = (session: Pick<Session, 'cart' | 'pins'>) =>
    Effect.gen(function* () {
      const client = yield* tcg;
      return yield* buildRequirements(
        session.cart,
        { getProducts: (productIds) => client.GetProducts({ productIds }), searchProducts: (query) => client.SearchProducts({ query }) },
        session.pins,
      );
    });

  const loadCart = Effect.gen(function* () {
    yield* dispatch({ _tag: 'LoadStarted', message: 'Reading your cart…' });
    const client = yield* tcg;
    const [cart, pins, options] = yield* Effect.all([client.ReadCart(), loadPins, loadOptions], { concurrency: 'unbounded' });
    yield* ensureSellers(
      cart.map((l) => l.sellerId),
      () => Effect.void,
    );
    yield* dispatch({ _tag: 'LoadStarted', message: 'Finding interchangeable printings…' });
    const catalog = yield* catalogFor({ cart, pins });
    yield* dispatch({
      _tag: 'Loaded',
      session: { cart, cost: cart.length > 0 ? evaluateCart(cart, sellers) : null, catalog, quantities: new Map(), pins, options },
    });
  });

  const connect = (tabId: number, reload: boolean) =>
    Effect.gen(function* () {
      yield* dispatch({ _tag: 'ConnectStarted' });
      if (connection) yield* connection.close;
      connection = null;
      if (reload) yield* Effect.all([waitForTabLoad(tabId), Effect.promise(() => browser.tabs.reload(tabId))], { concurrency: 'unbounded' });
      connection = yield* openConnection(tabId);
      yield* loadCart;
    });

  const sessionOf = (s: State) => (s._tag === 'Editing' || s._tag === 'Planned' ? s.session : null);

  const optimize = (session: Session) =>
    Effect.gen(function* () {
      const { options } = session;
      const requirements = session.catalog.requirements.flatMap((r): Requirement[] => {
        const quantity = requirementQuantity(session, r);
        return quantity > 0 ? [{ ...r, quantity }] : [];
      });
      yield* dispatch({ _tag: 'OptimizeStarted' });

      const conditions = options.conditions.toSorted().join('|');
      if (listingCache.conditions !== conditions) listingCache = { conditions, byProduct: new Map() };
      const { byProduct } = listingCache;
      const productIds = [...new Set(requirements.flatMap((r) => r.candidates))];
      const missing = productIds.filter((id) => !byProduct.has(id));
      if (missing.length > 0) {
        const client = yield* tcg;
        const fetched = yield* collectProgress(client.FetchListings({ productIds: missing, conditions: options.conditions }), reportProgress);
        for (const id of missing) byProduct.set(id, []);
        for (const listing of fetched) byProduct.get(listing.productId)?.push(listing);
      }
      const listings = productIds.flatMap((id) => byProduct.get(id) ?? []);
      yield* ensureSellers(
        listings.map((l) => l.sellerId),
        reportProgress,
      );

      yield* dispatch({ _tag: 'ProgressMade', progress: null });
      const plan = yield* solve({ requirements, listings, sellers: [...sellers.values()], options, timeLimitSec: SOLVE_TIME_LIMIT_SEC });
      yield* dispatch({ _tag: 'PlanReady', plan });
    });

  const setOptions = (options: SolveOptions) => {
    Effect.runSync(dispatch({ _tag: 'OptionsChanged', options }));
    Effect.runFork(saveOptions(options));
  };

  const optimizer: Engine = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    attach: (tabId) => {
      if (state._tag === 'Connecting' ? started : state._tag !== 'ChoosingTab') return;
      if (tabId !== null) optimizer.connect(tabId, false);
      else if (state._tag === 'Connecting')
        Effect.runSync(dispatch({ _tag: 'TabNeeded', reason: 'Choose the TCGplayer tab whose cart to optimize.' }));
    },
    busy: () =>
      state._tag === 'Loading' || state._tag === 'Optimizing' || state._tag === 'Applying' || (state._tag === 'Connecting' && started),
    connect: (tabId, reload) => run(connect(tabId, reload)),
    openCartTab: () =>
      run(
        Effect.gen(function* () {
          const tab = yield* Effect.promise(() => browser.tabs.create({ url: CART_URL, active: false }));
          if (tab.id === undefined) return;
          yield* waitForTabLoad(tab.id);
          yield* connect(tab.id, false);
        }),
      ),
    reloadCart: () => run(loadCart),
    setPinned: (productId, pinned) => {
      const session = sessionOf(state);
      if (!session) return;
      const pins = new Set(session.pins);
      if (pinned) pins.add(productId);
      else pins.delete(productId);
      run(
        Effect.gen(function* () {
          yield* dispatch({ _tag: 'PinsChanged', pins });
          yield* savePins(pins);
          const catalog = yield* catalogFor({ cart: session.cart, pins });
          yield* dispatch({ _tag: 'Loaded', session: { ...session, pins, catalog, quantities: new Map() } });
        }),
      );
    },
    setQuantity: (requirementId, quantity) => Effect.runSync(dispatch({ _tag: 'QuantityChanged', requirementId, quantity })),
    setOptions,
    excludeSeller: (seller) => {
      const session = sessionOf(state);
      if (!session || session.options.excludedSellers.some((s) => s.key === seller.sellerKey)) return;
      setOptions({ ...session.options, excludedSellers: [...session.options.excludedSellers, { key: seller.sellerKey, name: seller.name }] });
      optimizer.optimize();
    },
    optimize: () => {
      const session = sessionOf(state);
      if (session) run(optimize(session));
    },
    cancel: () => Effect.runFork(FiberHandle.clear(jobs).pipe(Effect.andThen(dispatch({ _tag: 'Cancelled' })))),
    apply: (plan) =>
      run(
        Effect.gen(function* () {
          yield* dispatch({ _tag: 'ApplyStarted', plan });
          const client = yield* tcg;
          yield* client.ClearCart();
          const results = yield* collectProgress(client.AddToCart({ items: planToCartAdds(plan) }), reportProgress);
          const cart = yield* client.ReadCart();
          yield* ensureSellers(
            cart.map((l) => l.sellerId),
            () => Effect.void,
          );
          // The cart now holds those listings, so their quantities and prices have moved.
          listingCache = { conditions: '', byProduct: new Map() };
          yield* dispatch({ _tag: 'CartReplaced', results, cost: cart.length > 0 ? evaluateCart(cart, sellers) : null });
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : dispatch(failureEvent(cause, ' Your cart may be partially updated; reload it on TCGplayer to check.')),
          ),
        ),
      ),
    showCart: () => {
      if (connection) void browser.tabs.update(connection.tabId, { active: true, url: CART_URL });
    },
    dismissError: () => Effect.runSync(dispatch({ _tag: 'ErrorDismissed' })),
  };
  return optimizer;
}
