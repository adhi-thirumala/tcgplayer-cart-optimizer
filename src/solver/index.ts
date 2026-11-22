import { Effect } from 'effect';
import type { Plan, SolveInput } from '@/core/domain';
import { SolverError } from './solve';
import type { WorkerResponse } from './solver.worker';

export { type CartCost, evaluateCart, planToCartAdds } from './model';

/** Solves off the main thread. HiGHS runs synchronously, so interruption terminates the worker. */
export const solveInWorker = (input: SolveInput) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' })),
    (worker) =>
      Effect.callback<Plan, SolverError>((resume) => {
        worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) =>
          resume(data._tag === 'Solved' ? Effect.succeed(data.plan) : Effect.fail(new SolverError({ message: data.message })));
        worker.onerror = (event) => resume(Effect.fail(new SolverError({ message: `Solver worker crashed: ${event.message || 'unknown error'}` })));
        worker.postMessage(input);
      }),
    (worker) => Effect.sync(() => worker.terminate()),
  );
