import { Effect, Queue, Schema } from 'effect';
import { RpcClient, RpcClientError, type RpcMessage, type RpcSerialization, RpcServer } from 'effect/rpc';

/**
 * effect/rpc transports over `browser.runtime` ports. Chrome serializes port
 * messages as JSON, so both sides use the JSON codec.
 */
const codecFor = Schema.toCodecJson as RpcSerialization.CodecFor;

/** Content-script side: one RPC client per port named `name`. */
export const portServerProtocol = (name: string) =>
  RpcServer.Protocol.make(
    Effect.fnUntraced(function* (writeRequest) {
      const runFork = Effect.runForkWith(yield* Effect.context<never>());
      const disconnects = yield* Queue.make<number>();
      const ports = new Map<number, Browser.runtime.Port>();
      let nextId = 0;

      const onConnect = (port: Browser.runtime.Port) => {
        if (port.name !== name) return;
        const id = nextId++;
        ports.set(id, port);
        port.onMessage.addListener((message: RpcMessage.FromClientEncoded) => void runFork(writeRequest(id, message)));
        port.onDisconnect.addListener(() => {
          ports.delete(id);
          runFork(Queue.offer(disconnects, id));
        });
      };
      browser.runtime.onConnect.addListener(onConnect);
      yield* Effect.addFinalizer(() => Effect.sync(() => browser.runtime.onConnect.removeListener(onConnect)));

      return {
        disconnects,
        send: (clientId, response) => Effect.sync(() => ports.get(clientId)?.postMessage(response)),
        end: (clientId) =>
          Effect.sync(() => {
            ports.get(clientId)?.disconnect();
            ports.delete(clientId);
          }),
        clientIds: Effect.sync(() => new Set(ports.keys())),
        initialMessage: Effect.succeedNone,
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: false,
        supportsNotifications: false,
        codecFor,
      };
    }),
  );

/** Extension-page side, over an open port. Once the port closes, every call fails with an `RpcClientError`. */
export const portClientProtocol = (port: Browser.runtime.Port, lostMessage: string) =>
  RpcClient.Protocol.make(
    Effect.fnUntraced(function* (writeResponse, clientIds) {
      const runFork = Effect.runForkWith(yield* Effect.context<never>());
      let lost: RpcClientError.RpcClientError | null = null;
      const broadcast = (message: RpcMessage.FromServerEncoded) => {
        for (const clientId of clientIds) runFork(writeResponse(clientId, message));
      };

      port.onMessage.addListener(broadcast);
      port.onDisconnect.addListener(() => {
        const cause = browser.runtime.lastError?.message;
        lost = new RpcClientError.RpcClientError({
          reason: new RpcClientError.RpcClientDefect({ message: cause ? `${lostMessage} (${cause})` : lostMessage, cause }),
        });
        broadcast({ _tag: 'ClientProtocolError', error: lost });
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => port.disconnect()));

      return {
        send: (_clientId, request) => (lost ? Effect.fail(lost) : Effect.sync(() => port.postMessage(request))),
        supportsAck: true,
        supportsTransferables: false,
        codecFor,
      };
    }),
  );
