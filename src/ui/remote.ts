import type { Engine, Optimizer } from './optimizer';
import { type State, initialState } from './machine';

const OPTIMIZER_PORT = 'optimizer';
const TCGPLAYER_TABS = '*://*.tcgplayer.com/*';
/** How long finished results stay in the background after the last page closes. */
const RETAIN_MS = 10 * 60_000;
/** Chrome stops an idle service worker after 30 s; any extension API call resets that timer. */
const HEARTBEAT_MS = 20_000;

/** Engine methods a page may call. Every one returns nothing, so calls are one-way messages. */
const COMMANDS = [
  'attach',
  'connect',
  'openCartTab',
  'reloadCart',
  'setPinned',
  'setQuantity',
  'setOptions',
  'excludeSeller',
  'optimize',
  'cancel',
  'apply',
  'showCart',
  'dismissError',
] as const satisfies readonly (keyof Engine)[];
type CommandName = (typeof COMMANDS)[number];
type Command = { [K in CommandName]: { readonly method: K; readonly args: Parameters<Engine[K]> } }[CommandName];

/** Ports carry JSON; the state holds Maps and Sets, so they are tagged on the way through. */
const encode = (value: unknown) =>
  JSON.stringify(value, (_, v: unknown) => (v instanceof Map ? { $map: [...v] } : v instanceof Set ? { $set: [...v] } : v));
const decode = <A>(text: string): A =>
  JSON.parse(text, (_, v: unknown) =>
    v !== null && typeof v === 'object' && '$map' in v ? new Map(v.$map as []) : v !== null && typeof v === 'object' && '$set' in v ? new Set(v.$set as []) : v,
  );

/** Background side: mirrors the engine's state to every open page and runs their commands. */
export function serveOptimizer(engine: Engine) {
  const ports = new Set<Browser.runtime.Port>();
  let lastActive = Date.now();
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const beat = () => {
    if (ports.size > 0 || engine.busy()) lastActive = Date.now();
    else if (Date.now() - lastActive > RETAIN_MS) {
      clearInterval(heartbeat);
      heartbeat = undefined;
      return;
    }
    void browser.runtime.getPlatformInfo();
  };
  const touch = () => {
    lastActive = Date.now();
    heartbeat ??= setInterval(beat, HEARTBEAT_MS);
  };

  engine.subscribe(() => {
    const message = encode(engine.getState());
    for (const port of ports) port.postMessage(message);
    touch();
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== OPTIMIZER_PORT || port.sender?.id !== browser.runtime.id) return;
    ports.add(port);
    touch();
    port.onMessage.addListener((message: string) => {
      const { method, args } = decode<Command>(message);
      if (!COMMANDS.includes(method)) return;
      (engine[method] as (...args: unknown[]) => void)(...args);
    });
    port.onDisconnect.addListener(() => {
      ports.delete(port);
      touch();
    });
    port.postMessage(encode(engine.getState()));
  });
}

/**
 * Page side: an `Optimizer` backed by the background engine. `tabId` is the
 * TCGplayer tab the page was opened over, if any.
 */
export function connectOptimizer(tabId: number | null): Optimizer {
  let state: State = initialState;
  const listeners = new Set<() => void>();
  let port: Browser.runtime.Port;

  const send = (command: Command) => port.postMessage(encode(command));
  const open = () => {
    port = browser.runtime.connect({ name: OPTIMIZER_PORT });
    let live = false;
    port.onMessage.addListener((message: string) => {
      live = true;
      state = decode<State>(message);
      for (const listener of listeners) listener();
    });
    // A Firefox extension reload or a crashed service worker drops the port; reconnect unless it never worked.
    port.onDisconnect.addListener(() => live && open());
    send({ method: 'attach', args: [tabId] });
  };
  open();

  const command =
    <K extends CommandName>(method: K) =>
    (...args: Parameters<Engine[K]>) =>
      send({ method, args } as Command);

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    findTabs: () => browser.tabs.query({ url: TCGPLAYER_TABS }),
    connect: command('connect'),
    openCartTab: command('openCartTab'),
    reloadCart: command('reloadCart'),
    setPinned: command('setPinned'),
    setQuantity: command('setQuantity'),
    setOptions: command('setOptions'),
    excludeSeller: command('excludeSeller'),
    optimize: command('optimize'),
    cancel: command('cancel'),
    apply: command('apply'),
    showCart: command('showCart'),
    dismissError: command('dismissError'),
  };
}
