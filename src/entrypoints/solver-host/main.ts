import { Effect, Fiber } from 'effect';
import type { SolveInput } from '@/core/domain';
import { solveInWorker } from '@/solver';
import { SOLVER_PORT } from '@/solver/host';
import type { WorkerResponse } from '@/solver/solver.worker';

// One solve per port; the background disconnecting the port interrupts it, which terminates the worker.
browser.runtime.onConnect.addListener((port) => {
  if (port.name !== SOLVER_PORT || port.sender?.id !== browser.runtime.id) return;
  port.onMessage.addListener((input: SolveInput) => {
    const fiber = Effect.runFork(
      solveInWorker(input).pipe(
        Effect.match({
          onSuccess: (plan): WorkerResponse => ({ _tag: 'Solved', plan }),
          onFailure: (error): WorkerResponse => ({ _tag: 'Failed', message: error.message }),
        }),
        Effect.map((response) => port.postMessage(response)),
      ),
    );
    port.onDisconnect.addListener(() => Effect.runFork(Fiber.interrupt(fiber)));
  });
});
