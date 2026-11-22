import type { Progress, TcgApi } from './types';

/**
 * `TcgApi` across the extension-page ↔ content-script boundary. Each call is a
 * request on a long-lived port; a function argument (the progress callback) is
 * replaced by a marker and its invocations stream back as `progress` messages.
 */

const PORT_NAME = 'tcg-api';

type Method = keyof TcgApi;

interface CallMessage {
  id: number;
  method: Method;
  args: unknown[];
  /** Index of the argument that was a progress callback, if any. */
  progressArg: number | null;
}

type ReplyMessage =
  | { id: number; type: 'progress'; progress: Progress }
  | { id: number; type: 'result'; value: unknown }
  | { id: number; type: 'error'; name: string; message: string };

const METHODS: readonly Method[] = [
  'readCart',
  'searchProducts',
  'getProducts',
  'fetchListings',
  'fetchSellerShipping',
  'clearCart',
  'addToCart',
];

/** Content-script side: answer calls from extension pages with `impl`. */
export function serveTcgApi(impl: TcgApi): void {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;
    let open = true;
    port.onDisconnect.addListener(() => {
      open = false;
    });
    const reply = (message: ReplyMessage) => {
      if (open) port.postMessage(message);
    };
    port.onMessage.addListener(async (message: CallMessage) => {
      const { id, method, args, progressArg } = message;
      try {
        if (!METHODS.includes(method)) throw new Error(`Unknown method ${String(method)}`);
        if (progressArg !== null) {
          args[progressArg] = (progress: Progress) => reply({ id, type: 'progress', progress });
        }
        const fn = impl[method] as (...a: unknown[]) => Promise<unknown>;
        reply({ id, type: 'result', value: await fn(...args) });
      } catch (error) {
        const e = error instanceof Error ? error : new Error(String(error));
        reply({ id, type: 'error', name: e.name, message: e.message });
      }
    });
  });
}

export type TcgConnection = TcgApi & {
  dispose(): void;
  /** True once the port is gone (tab navigated, reloaded or closed); make a new connection. */
  readonly closed: boolean;
};

/** Extension-page side: a `TcgApi` whose calls run in the content script of `tabId`. */
export function connectTcgApi(tabId: number): TcgConnection {
  const port = browser.tabs.connect(tabId, { name: PORT_NAME });
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; onProgress?: (p: Progress) => void }
  >();
  let nextId = 1;
  let closed: Error | null = null;

  port.onMessage.addListener((message: ReplyMessage) => {
    const call = pending.get(message.id);
    if (!call) return;
    if (message.type === 'progress') {
      call.onProgress?.(message.progress);
      return;
    }
    pending.delete(message.id);
    if (message.type === 'result') call.resolve(message.value);
    else call.reject(Object.assign(new Error(message.message), { name: message.name }));
  });

  port.onDisconnect.addListener(() => {
    const cause = browser.runtime.lastError?.message;
    closed = new Error(
      'Lost the connection to the TCGplayer tab. It was closed or reloaded, or it was opened before the extension ' +
        `was installed; reload it and try again.${cause ? ` (${cause})` : ''}`,
    );
    for (const call of pending.values()) call.reject(closed);
    pending.clear();
  });

  const call = (method: Method, args: unknown[]): Promise<unknown> => {
    if (closed) return Promise.reject(closed);
    const progressArg = args.findIndex((a) => typeof a === 'function');
    const onProgress = progressArg >= 0 ? (args[progressArg] as (p: Progress) => void) : undefined;
    const id = nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    pending.set(id, { resolve, reject, onProgress });
    const message: CallMessage = {
      id,
      method,
      args: args.map((a) => (typeof a === 'function' ? null : a)),
      progressArg: progressArg >= 0 ? progressArg : null,
    };
    port.postMessage(message);
    return promise;
  };

  const api = Object.fromEntries(
    METHODS.map((method) => [method, (...args: unknown[]) => call(method, args)]),
  ) as unknown as TcgApi;
  return {
    ...api,
    dispose: () => port.disconnect(),
    get closed() {
      return closed !== null;
    },
  };
}
