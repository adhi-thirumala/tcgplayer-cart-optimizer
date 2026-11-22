import { Effect, Option, Queue, Schema, Stream } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import { CartAddRequest, CartAddResult, CartLine, Condition, Listing, Product, ProductId, Progress, Seller, SellerId } from '@/core/domain';
import { TcgError } from './http';

/** A long-running call streams progress, then its result. */
const WithProgress = <S extends Schema.Top>(value: S) => Schema.Union([Progress, Schema.TaggedStruct('Done', { value })]);
type WithProgress<A> = Progress | { readonly _tag: 'Done'; readonly value: A };

/** Everything the extension asks of TCGplayer, served by the content script to extension pages. */
export class TcgRpcs extends RpcGroup.make(
  Rpc.make('ReadCart', { success: Schema.Array(CartLine), error: TcgError }),
  Rpc.make('SearchProducts', { payload: { query: Schema.String }, success: Schema.Array(Product), error: TcgError }),
  Rpc.make('GetProducts', { payload: { productIds: Schema.Array(ProductId) }, success: Schema.Array(Product), error: TcgError }),
  Rpc.make('FetchListings', {
    payload: { productIds: Schema.Array(ProductId), conditions: Schema.Array(Condition) },
    success: WithProgress(Schema.Array(Listing)),
    error: TcgError,
    stream: true,
  }),
  Rpc.make('FetchSellers', {
    payload: { sellerIds: Schema.Array(SellerId) },
    success: WithProgress(Schema.Array(Seller)),
    error: TcgError,
    stream: true,
  }),
  /** Empties the cart; saved-for-later items stay. */
  Rpc.make('ClearCart', { error: TcgError }),
  Rpc.make('AddToCart', {
    payload: { items: Schema.Array(CartAddRequest) },
    success: WithProgress(Schema.Array(CartAddResult)),
    error: TcgError,
    stream: true,
  }),
) {}

/** Server side: run `task`, streaming each progress report and then its result. */
export const streamProgress = <A, E, R>(task: (report: (progress: Progress) => Effect.Effect<void>) => Effect.Effect<A, E, R>) =>
  Stream.callback<WithProgress<A>, E, R>((queue) =>
    task((progress) => Queue.offer(queue, progress).pipe(Effect.asVoid)).pipe(
      Effect.flatMap((value) => Queue.offer(queue, { _tag: 'Done', value })),
      Effect.andThen(Queue.end(queue)),
      Effect.catch((error) => Queue.fail(queue, error)),
    ),
  );

/** Client side: pass progress to `onProgress` and return the result. */
export const collectProgress = <A, E, R>(
  stream: Stream.Stream<WithProgress<A>, E, R>,
  onProgress: (progress: Progress) => Effect.Effect<void>,
) =>
  stream.pipe(
    Stream.tap((event) => (event._tag === 'Progress' ? onProgress(event) : Effect.void)),
    Stream.filter((event) => event._tag === 'Done'),
    Stream.runHead,
    Effect.flatMap(Option.match({ onNone: () => Effect.die('stream ended without a result'), onSome: (done) => Effect.succeed(done.value) })),
  );

export const TCG_PORT = 'tcg-api';
