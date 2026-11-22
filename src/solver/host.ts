import { Effect } from 'effect';
import type { Plan, SolveInput } from '@/core/domain';
import { SolverError } from './solve';
import type { WorkerResponse } from './solver.worker';

/**
 * The background cannot start the solver worker itself: Chrome's service
 * worker has no `Worker`, and bundling the worker into the background script
 * would inline the 4 MB WebAssembly. It solves in the solver host page instead:
 * an offscreen document in Chrome, a hidden iframe in Firefox's background page.
 */
export const SOLVER_PORT = 'solver';
const SOLVER_PAGE = '/solver-host.html';

/** Undefined in Firefox, whose typings are Chrome's. */
const offscreen: typeof browser.offscreen | undefined = browser.offscreen;

const openHost = Effect.promise(async () => {
  if (offscreen) {
    if (await offscreen.hasDocument()) return;
    await offscreen.createDocument({
      url: SOLVER_PAGE,
      reasons: ['WORKERS'],
      justification: 'Runs the HiGHS WebAssembly solver in a Web Worker.',
    });
  } else if (!document.querySelector('iframe.solver-host')) {
    const frame = document.createElement('iframe');
    frame.className = 'solver-host';
    frame.src = browser.runtime.getURL(SOLVER_PAGE);
    const { promise, resolve } = Promise.withResolvers<void>();
    frame.onload = () => resolve();
    document.body.append(frame);
    await promise;
  }
});

const closeHost = Effect.tryPromise(async () => {
  if (offscreen) await offscreen.closeDocument();
  else document.querySelector('iframe.solver-host')?.remove();
}).pipe(Effect.ignore);

/** Background side. Interruption disconnects the port, which stops the solve, and closes the host. */
export const solveInHost = (input: SolveInput) =>
  Effect.acquireUseRelease(
    openHost.pipe(Effect.map(() => browser.runtime.connect({ name: SOLVER_PORT }))),
    (port) =>
      Effect.callback<Plan, SolverError>((resume) => {
        port.onMessage.addListener((response: WorkerResponse) =>
          resume(response._tag === 'Solved' ? Effect.succeed(response.plan) : Effect.fail(new SolverError({ message: response.message }))),
        );
        port.onDisconnect.addListener(() => resume(Effect.fail(new SolverError({ message: 'The solver page closed before it finished.' }))));
        port.postMessage(input);
      }),
    (port) => Effect.sync(() => port.disconnect()).pipe(Effect.andThen(closeHost)),
  );
