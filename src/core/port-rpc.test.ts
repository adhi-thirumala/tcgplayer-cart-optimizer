import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from 'effect';
import { Rpc, RpcClient, RpcGroup, RpcServer } from 'effect/rpc';
import { portClientProtocol, portServerProtocol } from './port-rpc';

class Boom extends Schema.TaggedError<Boom>()('Boom', { message: Schema.String }) {}

const Rpcs = RpcGroup.make(
  Rpc.make('Echo', { payload: { text: Schema.String }, success: Schema.String }),
  Rpc.make('Fail', { error: Boom }),
  Rpc.make('Count', { success: Schema.Int, stream: true }),
  Rpc.make('Hang'),
);

interface FakePort {
  readonly port: Browser.runtime.Port;
  readonly deliver: (message: unknown) => void;
  readonly drop: () => void;
}

/** A connected pair of ports that, like Chrome, deliver JSON copies asynchronously. */
function portPair(name: string): [FakePort, FakePort] {
  const make = (): FakePort & { peer?: FakePort } => {
    const onMessage = new Set<(message: unknown) => void>();
    const onDisconnect = new Set<() => void>();
    let open = true;
    const self: FakePort & { peer?: FakePort } = {
      port: {
        name,
        postMessage: (message: unknown) => {
          const copy = JSON.parse(JSON.stringify(message));
          queueMicrotask(() => open && self.peer?.deliver(copy));
        },
        disconnect: () => {
          open = false;
          self.peer?.drop();
        },
        onMessage: { addListener: (fn: (message: unknown) => void) => onMessage.add(fn) },
        onDisconnect: { addListener: (fn: () => void) => onDisconnect.add(fn) },
      } as unknown as Browser.runtime.Port,
      deliver: (message) => {
        for (const fn of onMessage) fn(message);
      },
      drop: () => {
        if (!open) return;
        open = false;
        for (const fn of onDisconnect) fn();
      },
    };
    return self;
  };
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

const setup = Effect.gen(function* () {
  const connectListeners = new Set<(port: Browser.runtime.Port) => void>();
  Object.assign(browser.runtime, {
    onConnect: { addListener: (fn: (port: Browser.runtime.Port) => void) => connectListeners.add(fn), removeListener: () => {} },
  });
  const started = yield* Deferred.make<void>();
  const interrupted = yield* Deferred.make<void>();
  yield* Layer.build(
    RpcServer.layer(Rpcs).pipe(
      Layer.provide(
        Rpcs.toLayer({
          Echo: ({ text }) => Effect.succeed(text.toUpperCase()),
          Fail: () => Effect.fail(new Boom({ message: 'boom' })),
          Count: () => Stream.make(1, 2, 3),
          Hang: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
            ),
        }),
      ),
      Layer.provide(Layer.effect(RpcServer.Protocol)(portServerProtocol('test'))),
    ),
  );
  const [client, server] = portPair('test');
  for (const fn of connectListeners) fn(server.port);
  const rpc = yield* RpcClient.make(Rpcs).pipe(Effect.provideServiceEffect(RpcClient.Protocol, portClientProtocol(client.port, 'connection lost')));
  return { rpc, client, started, interrupted };
});

describe('port RPC', () => {
  it.live('round-trips calls, streams and typed errors', () =>
    Effect.gen(function* () {
      const { rpc } = yield* setup;
      expect(yield* rpc.Echo({ text: 'hi' })).toBe('HI');
      expect(yield* Stream.runCollect(rpc.Count())).toEqual([1, 2, 3]);
      expect(yield* Effect.flip(rpc.Fail())).toMatchObject({ _tag: 'Boom', message: 'boom' });
    }).pipe(Effect.scoped),
  );

  it.live('interrupting a call interrupts its handler', () =>
    Effect.gen(function* () {
      const { rpc, started, interrupted } = yield* setup;
      const call = yield* Effect.forkChild(rpc.Hang());
      yield* Deferred.await(started);
      yield* Fiber.interrupt(call);
      yield* Deferred.await(interrupted);
    }).pipe(Effect.scoped),
  );

  it.live('fails pending and later calls once the port closes', () =>
    Effect.gen(function* () {
      const { rpc, client, started } = yield* setup;
      const pending = yield* Effect.forkChild(Effect.flip(rpc.Hang()));
      yield* Deferred.await(started);
      client.drop();
      expect(yield* Fiber.join(pending)).toMatchObject({ _tag: 'RpcClientError', reason: { message: 'connection lost' } });
      expect(yield* Effect.flip(rpc.Echo({ text: 'x' }))).toMatchObject({ _tag: 'RpcClientError' });
    }).pipe(Effect.scoped),
  );
});
