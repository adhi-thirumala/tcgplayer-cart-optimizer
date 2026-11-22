/**
 * HTTP plumbing for TCGplayer's internal APIs. They only answer requests that
 * carry the www.tcgplayer.com origin and cookies, so this runs in the content
 * script. Firefox gives content scripts an extension-principal `fetch`; its
 * `content.fetch` issues the request as the page instead.
 */

declare const content: { fetch?: typeof fetch } | undefined;

const pageFetch: typeof fetch =
  typeof content !== 'undefined' && typeof content?.fetch === 'function' ? content.fetch.bind(content) : fetch.bind(globalThis);

export class TcgHttpError extends Error {
  override name = 'TcgHttpError';
  constructor(
    readonly endpoint: string,
    readonly status: number,
    detail: string,
  ) {
    super(`TCGplayer ${endpoint} failed (${status}): ${detail}`);
  }
}

/** 16 in flight fetched ~780 listing pages in 25s with no 429s; lower values were proportionally slower. */
const MAX_IN_FLIGHT = 16;
const RETRIES = 3;
let inFlight = 0;
const waiting: Array<() => void> = [];

/** Run `task` once one of MAX_IN_FLIGHT slots is free; a finishing task hands its slot to the next waiter. */
async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (inFlight < MAX_IN_FLIGHT) inFlight++;
  else {
    const { promise, resolve } = Promise.withResolvers<void>();
    waiting.push(resolve);
    await promise;
  }
  try {
    return await task();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else inFlight--;
  }
}

function retryable(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
}

/** JSON request with a concurrency cap and backoff on rate limiting / gateway errors. */
export async function tcgFetch<T>(url: string, { method = 'GET', body }: RequestOptions = {}): Promise<T> {
  const endpoint = new URL(url).pathname;
  return withSlot(async () => {
    for (let attempt = 0; ; attempt++) {
      const response = await pageFetch(url, {
        method,
        credentials: 'include',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (retryable(response.status) && attempt < RETRIES) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      const text = await response.text();
      if (!response.ok) throw new TcgHttpError(endpoint, response.status, text.slice(0, 200) || response.statusText);
      if (text === '') return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new TcgHttpError(endpoint, response.status, 'response was not JSON');
      }
    }
  });
}

/** TCGplayer's `{ errors, results }` envelope. */
export interface Envelope<T> {
  errors: unknown[] | Record<string, unknown> | null;
  results: T[];
}

export function errorText(errors: Envelope<unknown>['errors']): string | null {
  if (!errors) return null;
  const list = Array.isArray(errors) ? errors : Object.values(errors);
  if (list.length === 0) return null;
  return list
    .map((e) => (typeof e === 'object' && e !== null && 'message' in e ? String(e.message) : JSON.stringify(e)))
    .join('; ');
}

/** First result of an envelope; throws on reported errors or a missing result. */
export function unwrap<T>(endpoint: string, envelope: Envelope<T>): T {
  const error = errorText(envelope.errors);
  if (error) throw new TcgHttpError(endpoint, 200, error);
  const first = envelope.results?.[0];
  if (first === undefined) throw new TcgHttpError(endpoint, 200, 'response had no results');
  return first;
}
