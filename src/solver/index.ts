import type { Plan, SolveInput } from '@/core/types';
import type { WorkerResponse } from './solver.worker';

export { evaluateCart, planToCartAdds, shippingFor, type CartCost } from './model';

/** Solve off the main thread; aborting terminates the worker (HiGHS solves synchronously). */
export function solveInWorker(input: SolveInput, signal?: AbortSignal): Promise<Plan> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const { promise, resolve, reject } = Promise.withResolvers<Plan>();
  const worker = new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' });
  const onAbort = () => reject(signal!.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    if (event.data.ok) resolve(event.data.plan);
    else reject(new Error(event.data.error));
  };
  worker.onerror = (event) => reject(new Error(`Solver worker crashed: ${event.message || 'unknown error'}`));
  worker.postMessage(input);
  return promise.finally(() => {
    worker.terminate();
    signal?.removeEventListener('abort', onAbort);
  });
}
