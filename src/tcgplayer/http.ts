import { Context, Effect, Layer, Predicate, Schedule, Schema, Semaphore } from 'effect';
import { FetchHttpClient, HttpClient, type HttpClientRequest, HttpClientResponse } from 'effect/http';

export class TcgError extends Schema.TaggedError<TcgError>()('TcgError', { message: Schema.String }) {}

/**
 * TCGplayer's APIs answer only requests that carry the www.tcgplayer.com origin
 * and cookies, so they run in the content script. Firefox gives content scripts
 * an extension-principal `fetch`; `content.fetch` sends the request as the page.
 */
declare const content: { fetch?: typeof fetch } | undefined;
const pageFetch: typeof fetch =
  typeof content !== 'undefined' && typeof content?.fetch === 'function' ? content.fetch.bind(content) : fetch.bind(globalThis);

/** 16 in flight fetched ~780 listing pages in 25s with no 429s; fewer were proportionally slower. */
const MAX_IN_FLIGHT = 16;

const Envelope = <S extends Schema.Top>(result: S) =>
  Schema.Struct({
    errors: Schema.optional(Schema.NullOr(Schema.Union([Schema.Array(Schema.Unknown), Schema.Record(Schema.String, Schema.Unknown)]))),
    results: Schema.optional(Schema.NullOr(Schema.Array(result))),
  });
interface Envelope<A> {
  readonly errors?: ReadonlyArray<unknown> | { readonly [key: string]: unknown } | null | undefined;
  readonly results?: ReadonlyArray<A> | null | undefined;
}

/** TCGplayer reports some failures with a 200 and a non-empty `errors`. */
export function envelopeErrors(errors: Envelope<unknown>['errors']): string | null {
  if (!errors) return null;
  const list = Array.isArray(errors) ? errors : Object.values(errors);
  if (list.length === 0) return null;
  return list.map((e) => (Predicate.hasProperty(e, 'message') ? String(e.message) : JSON.stringify(e))).join('; ');
}

export class TcgHttp extends Context.Service<
  TcgHttp,
  {
    /** Runs `request` and decodes its JSON body; `endpoint` names it in errors. */
    json<S extends Schema.Top>(endpoint: string, request: HttpClientRequest.HttpClientRequest, schema: S): Effect.Effect<S['Type'], TcgError, S['DecodingServices']>;
    /** The envelope as decoded, for callers that read `errors` themselves. */
    envelope<S extends Schema.Top>(
      endpoint: string,
      request: HttpClientRequest.HttpClientRequest,
      result: S,
    ): Effect.Effect<Envelope<S['Type']>, TcgError, S['DecodingServices']>;
    /** The first result of an enveloped response; fails on reported errors or no result. */
    first<S extends Schema.Top>(endpoint: string, request: HttpClientRequest.HttpClientRequest, result: S): Effect.Effect<S['Type'], TcgError, S['DecodingServices']>;
    /** Runs `request` for its effect and ignores the body. */
    send(endpoint: string, request: HttpClientRequest.HttpClientRequest): Effect.Effect<void, TcgError>;
  }
>()('tcgplayer/TcgHttp') {
  static readonly layer = Layer.effect(
    TcgHttp,
    Effect.gen(function* () {
      const slots = yield* Semaphore.make(MAX_IN_FLIGHT);
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.filterStatusOk,
        HttpClient.retryTransient({ schedule: Schedule.exponential('500 millis'), times: 3 }),
        HttpClient.transformResponse(slots.withPermits(1)),
        // TCGplayer's CORS policy rejects the `b3` and `traceparent` headers.
        HttpClient.transformResponse(Effect.provideService(HttpClient.TracerPropagationEnabled, false)),
      );
      const failed = (endpoint: string) => (cause: { readonly message: string }) =>
        new TcgError({ message: `TCGplayer ${endpoint} failed: ${cause.message}` });

      const json = <S extends Schema.Top>(endpoint: string, request: HttpClientRequest.HttpClientRequest, schema: S) =>
        client.execute(request).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)), Effect.mapError(failed(endpoint)));

      const envelope = <S extends Schema.Top>(endpoint: string, request: HttpClientRequest.HttpClientRequest, result: S) =>
        json(endpoint, request, Envelope(result));

      const first = <S extends Schema.Top>(endpoint: string, request: HttpClientRequest.HttpClientRequest, result: S) =>
        envelope(endpoint, request, result).pipe(
          Effect.flatMap(({ errors, results }) => {
            const reported = envelopeErrors(errors);
            if (reported) return Effect.fail(failed(endpoint)({ message: reported }));
            const value = results?.[0];
            return value === undefined ? Effect.fail(failed(endpoint)({ message: 'response had no results' })) : Effect.succeed(value);
          }),
        );

      const send = (endpoint: string, request: HttpClientRequest.HttpClientRequest) =>
        client.execute(request).pipe(Effect.asVoid, Effect.mapError(failed(endpoint)));

      return TcgHttp.of({ json, envelope, first, send });
    }),
  ).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, pageFetch)),
    Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { credentials: 'include' })),
  );
}
