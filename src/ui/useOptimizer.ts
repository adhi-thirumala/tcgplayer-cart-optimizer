import { useCallback, useEffect, useReducer, useRef } from 'react';
import { buildRequirements } from '@/catalog';
import { connectTcgApi, type TcgConnection } from '@/core/rpc';
import type {
  CartAddResult,
  CartLine,
  Listing,
  Plan,
  Product,
  ProductId,
  Progress,
  Requirement,
  SellerShipping,
  SolveOptions,
} from '@/core/types';
import { type CartCost as Cost, evaluateCart, planToCartAdds, solveInWorker } from '@/solver';
import { errorMessage } from './format';
import { loadSolveOptions, pinnedProducts, solveOptions } from './settings';

export interface OptimizerActions {
  connect(tabId: number, reload?: boolean): Promise<void>;
  findTabs(): Promise<Browser.tabs.Tab[]>;
  openCartTab(): Promise<void>;
  reloadCart(): Promise<void>;
  setPinned(productId: ProductId, pinned: boolean): Promise<void>;
  setQuantity(id: string, quantity: number): void;
  setOptions(options: SolveOptions): Promise<void>;
  optimize(): Promise<void>;
  cancel(): void;
  excludeSeller(sellerKey: string): Promise<void>;
  apply(plan: Plan): Promise<void>;
  showCart(): Promise<void>;
  dismissError(): void;
}

export type Stage =
  | { kind: 'connecting' }
  | { kind: 'needs-tab'; reason: string }
  | { kind: 'loading'; message: string }
  | { kind: 'ready' }
  | { kind: 'optimizing'; progress: Progress | null }
  | { kind: 'planned'; plan: Plan }
  | { kind: 'applying'; plan: Plan; progress: Progress | null }
  | { kind: 'applied'; plan: Plan; results: CartAddResult[]; cart: CartLine[]; cost: Cost | null };

export interface State {
  stage: Stage;
  error: string | null;
  cart: CartLine[];
  currentCost: Cost | null;
  requirements: Requirement[];
  /** Requirement id → quantity chosen by the user (0 = skip). */
  quantities: Record<string, number>;
  products: Map<ProductId, Product>;
  pins: ReadonlySet<ProductId>;
  options: SolveOptions | null;
  sellers: Map<number, SellerShipping>;
}

type Action =
  | { type: 'stage'; stage: Stage }
  | { type: 'error'; error: string | null; stage?: Stage }
  | { type: 'cart'; cart: CartLine[]; currentCost: Cost | null }
  | { type: 'requirements'; requirements: Requirement[]; products: Map<ProductId, Product> }
  | { type: 'quantity'; id: string; quantity: number }
  | { type: 'pins'; pins: ReadonlySet<ProductId> }
  | { type: 'options'; options: SolveOptions }
  | { type: 'sellers'; sellers: SellerShipping[] };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'stage':
      return { ...state, stage: action.stage, error: null };
    case 'error':
      return { ...state, error: action.error, stage: action.stage ?? state.stage };
    case 'cart':
      return { ...state, cart: action.cart, currentCost: action.currentCost };
    case 'requirements':
      return { ...state, requirements: action.requirements, products: action.products, quantities: {} };
    case 'quantity':
      return { ...state, quantities: { ...state.quantities, [action.id]: action.quantity } };
    case 'pins':
      return { ...state, pins: action.pins };
    case 'options':
      return { ...state, options: action.options };
    case 'sellers': {
      const sellers = new Map(state.sellers);
      for (const s of action.sellers) sellers.set(s.sellerId, s);
      return { ...state, sellers };
    }
  }
}

const initialState: State = {
  stage: { kind: 'connecting' },
  error: null,
  cart: [],
  currentCost: null,
  requirements: [],
  quantities: {},
  products: new Map(),
  pins: new Set(),
  options: null,
  sellers: new Map(),
};

export function requirementQuantity(state: State, r: Requirement): number {
  return state.quantities[r.id] ?? r.quantity;
}

const TCGPLAYER_TABS = '*://*.tcgplayer.com/*';

function waitForTabLoad(tabId: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const listener = (id: number, info: { status?: string }) => {
    if (id === tabId && info.status === 'complete') {
      browser.tabs.onUpdated.removeListener(listener);
      resolve();
    }
  };
  browser.tabs.onUpdated.addListener(listener);
  return promise;
}

export function useOptimizer() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const apiRef = useRef<TcgConnection | null>(null);
  const tabRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Listings per product for one condition set, so re-solving only fetches products not seen yet. */
  const listingCache = useRef<{ conditions: string; byProduct: Map<ProductId, Listing[]> }>({
    conditions: '',
    byProduct: new Map(),
  });

  /** The live connection; reconnects after the TCGplayer tab navigated (any tcgplayer.com page serves the API). */
  const api = () => {
    if (apiRef.current?.closed && tabRef.current !== null) apiRef.current = connectTcgApi(tabRef.current);
    if (!apiRef.current) throw new Error('Not connected to a TCGplayer tab.');
    return apiRef.current;
  };

  const ensureSellers = useCallback(async (sellerIds: number[], onProgress?: (p: Progress) => void) => {
    const known = stateRef.current.sellers;
    const missing = [...new Set(sellerIds)].filter((id) => !known.has(id));
    const fetched = missing.length > 0 ? await api().fetchSellerShipping(missing, onProgress) : [];
    dispatch({ type: 'sellers', sellers: fetched });
    const all = new Map(known);
    for (const s of fetched) all.set(s.sellerId, s);
    return all;
  }, []);

  const rebuildRequirements = useCallback(async (cart: CartLine[], pins: ReadonlySet<ProductId>) => {
    const { requirements, products } = await buildRequirements(cart, api(), { pinnedProductIds: pins });
    dispatch({ type: 'requirements', requirements, products });
  }, []);

  const fetchCart = useCallback(async () => {
    dispatch({ type: 'stage', stage: { kind: 'loading', message: 'Reading your cart…' } });
    const [cart, pins, options] = await Promise.all([api().readCart(), pinnedProducts.getValue(), loadSolveOptions()]);
    const pinSet = new Set(pins);
    dispatch({ type: 'pins', pins: pinSet });
    dispatch({ type: 'options', options });
    let currentCost: Cost | null = null;
    if (cart.length > 0) {
      const sellers = await ensureSellers(cart.map((l) => l.sellerId));
      currentCost = evaluateCart(cart, [...sellers.values()]);
      dispatch({ type: 'stage', stage: { kind: 'loading', message: 'Finding interchangeable printings…' } });
      await rebuildRequirements(cart, pinSet);
    }
    dispatch({ type: 'cart', cart, currentCost });
    dispatch({ type: 'stage', stage: { kind: 'ready' } });
  }, [ensureSellers, rebuildRequirements]);

  const reloadCart = useCallback(async () => {
    try {
      await fetchCart();
    } catch (error) {
      dispatch({ type: 'error', error: errorMessage(error), stage: { kind: 'ready' } });
    }
  }, [fetchCart]);

  const connect = useCallback(
    async (tabId: number, reload = false) => {
      apiRef.current?.dispose();
      apiRef.current = null;
      tabRef.current = tabId;
      dispatch({ type: 'stage', stage: { kind: 'connecting' } });
      try {
        if (reload) {
          const loaded = waitForTabLoad(tabId);
          await browser.tabs.reload(tabId);
          await loaded;
        }
        apiRef.current = connectTcgApi(tabId);
        await fetchCart();
      } catch (error) {
        // No content script answering means the tab predates the install or isn't TCGplayer: pick again.
        const stage: Stage = apiRef.current?.closed !== false ? { kind: 'needs-tab', reason: errorMessage(error) } : { kind: 'ready' };
        dispatch({ type: 'error', error: stage.kind === 'ready' ? errorMessage(error) : null, stage });
      }
    },
    [fetchCart],
  );

  // Initial connection: the tab the toolbar button was clicked on, else ask.
  useEffect(() => {
    const tabId = Number(new URLSearchParams(location.search).get('tabId'));
    if (Number.isInteger(tabId) && tabId > 0) void connect(tabId);
    else dispatch({ type: 'stage', stage: { kind: 'needs-tab', reason: 'Choose the TCGplayer tab whose cart to optimize.' } });
    return () => {
      abortRef.current?.abort();
      apiRef.current?.dispose();
    };
  }, [connect]);

  const findTabs = useCallback(() => browser.tabs.query({ url: TCGPLAYER_TABS }), []);

  const openCartTab = useCallback(async () => {
    const tab = await browser.tabs.create({ url: 'https://www.tcgplayer.com/cart', active: false });
    if (tab.id === undefined) return;
    await waitForTabLoad(tab.id);
    await connect(tab.id);
  }, [connect]);

  const setPinned = useCallback(
    async (productId: ProductId, pinned: boolean) => {
      const pins = new Set(stateRef.current.pins);
      if (pinned) pins.add(productId);
      else pins.delete(productId);
      dispatch({ type: 'pins', pins });
      dispatch({ type: 'stage', stage: { kind: 'loading', message: 'Updating printings…' } });
      try {
        await pinnedProducts.setValue([...pins]);
        await rebuildRequirements(stateRef.current.cart, pins);
        dispatch({ type: 'stage', stage: { kind: 'ready' } });
      } catch (error) {
        dispatch({ type: 'error', error: errorMessage(error), stage: { kind: 'ready' } });
      }
    },
    [rebuildRequirements],
  );

  const setQuantity = useCallback((id: string, quantity: number) => {
    dispatch({ type: 'quantity', id, quantity });
    if (stateRef.current.stage.kind === 'planned') dispatch({ type: 'stage', stage: { kind: 'ready' } });
  }, []);

  const setOptions = useCallback(async (options: SolveOptions) => {
    dispatch({ type: 'options', options });
    await solveOptions.setValue(options);
  }, []);

  const optimize = useCallback(async () => {
    const current = stateRef.current;
    const options = current.options;
    if (!options) return;
    const requirements = current.requirements
      .map((r) => ({ ...r, quantity: requirementQuantity(current, r) }))
      .filter((r) => r.quantity > 0);
    const controller = new AbortController();
    abortRef.current = controller;
    const onProgress = (progress: Progress) => {
      if (!controller.signal.aborted) dispatch({ type: 'stage', stage: { kind: 'optimizing', progress } });
    };
    dispatch({ type: 'stage', stage: { kind: 'optimizing', progress: null } });
    try {
      const productIds = [...new Set(requirements.flatMap((r) => r.candidates))];
      const conditions = [...options.conditions].sort().join('|');
      const cache = listingCache.current;
      if (cache.conditions !== conditions) listingCache.current = { conditions, byProduct: new Map() };
      const { byProduct } = listingCache.current;
      const missing = productIds.filter((id) => !byProduct.has(id));
      if (missing.length > 0) {
        const fetched = await api().fetchListings(missing, { conditions: options.conditions }, onProgress);
        for (const id of missing) byProduct.set(id, []);
        for (const listing of fetched) byProduct.get(listing.productId)?.push(listing);
      }
      const listings = productIds.flatMap((id) => byProduct.get(id) ?? []);
      controller.signal.throwIfAborted();
      const sellers = await ensureSellers(
        listings.map((l) => l.sellerId),
        onProgress,
      );
      controller.signal.throwIfAborted();
      dispatch({ type: 'stage', stage: { kind: 'optimizing', progress: null } });
      const plan = await solveInWorker({ requirements, listings, sellers: [...sellers.values()], options }, controller.signal);
      dispatch({ type: 'stage', stage: { kind: 'planned', plan } });
    } catch (error) {
      if (controller.signal.aborted) dispatch({ type: 'stage', stage: { kind: 'ready' } });
      else dispatch({ type: 'error', error: errorMessage(error), stage: { kind: 'ready' } });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [ensureSellers]);

  const cancel = useCallback(() => abortRef.current?.abort(new DOMException('Cancelled', 'AbortError')), []);

  const excludeSeller = useCallback(
    async (sellerKey: string) => {
      const options = stateRef.current.options;
      if (!options || options.excludeSellerKeys.includes(sellerKey)) return;
      await setOptions({ ...options, excludeSellerKeys: [...options.excludeSellerKeys, sellerKey] });
      await optimize();
    },
    [optimize, setOptions],
  );

  const apply = useCallback(async (plan: Plan) => {
    const onProgress = (progress: Progress) => dispatch({ type: 'stage', stage: { kind: 'applying', plan, progress } });
    dispatch({ type: 'stage', stage: { kind: 'applying', plan, progress: null } });
    try {
      await api().clearCart();
      const results = await api().addToCart(planToCartAdds(plan), onProgress);
      const cart = await api().readCart();
      let cost: Cost | null = null;
      if (cart.length > 0) cost = evaluateCart(cart, [...(await ensureSellers(cart.map((l) => l.sellerId))).values()]);
      // The cart now holds those listings; quantities and prices have moved.
      listingCache.current = { conditions: '', byProduct: new Map() };
      dispatch({ type: 'cart', cart, currentCost: cost });
      dispatch({ type: 'stage', stage: { kind: 'applied', plan, results, cart, cost } });
    } catch (error) {
      dispatch({
        type: 'error',
        error: `${errorMessage(error)} Your cart may be partially updated; reload it on TCGplayer to check.`,
        stage: { kind: 'planned', plan },
      });
    }
  }, [ensureSellers]);

  const showCart = useCallback(async () => {
    const tabId = tabRef.current;
    if (tabId === null) return;
    await browser.tabs.update(tabId, { active: true, url: 'https://www.tcgplayer.com/cart' });
  }, []);

  const dismissError = useCallback(() => dispatch({ type: 'error', error: null }), []);

  const actions: OptimizerActions = {
    connect,
    findTabs,
    openCartTab,
    reloadCart,
    setPinned,
    setQuantity,
    setOptions,
    optimize,
    cancel,
    excludeSeller,
    apply,
    showCart,
    dismissError,
  };
  return { state, actions };
}
