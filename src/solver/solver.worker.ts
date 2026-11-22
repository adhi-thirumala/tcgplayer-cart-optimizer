import { Cause, Effect } from 'effect';
import highsLoader from 'highs';
import wasmUrl from 'highs/runtime?url';
import type { Plan, SolveInput } from '@/core/domain';
import { solveWith } from './solve';

export type WorkerResponse = { readonly _tag: 'Solved'; readonly plan: Plan } | { readonly _tag: 'Failed'; readonly message: string };

const highs = highsLoader({ locateFile: () => wasmUrl });

self.onmessage = (event: MessageEvent<SolveInput>) =>
  Effect.promise(() => highs).pipe(
    Effect.flatMap((h) => solveWith(h, event.data)),
    Effect.matchCause({
      onSuccess: (plan): WorkerResponse => ({ _tag: 'Solved', plan }),
      onFailure: (cause): WorkerResponse => ({ _tag: 'Failed', message: Cause.pretty(cause) }),
    }),
    Effect.map((response) => self.postMessage(response)),
    Effect.runFork,
  );
