import highsLoader from 'highs';
import wasmUrl from 'highs/runtime?url';
import type { Plan, SolveInput } from '@/core/types';
import { solveWith } from './solve';

export type WorkerResponse = { ok: true; plan: Plan } | { ok: false; error: string };

const highs = highsLoader({ locateFile: () => wasmUrl });

self.onmessage = async (event: MessageEvent<SolveInput>) => {
  let response: WorkerResponse;
  try {
    response = { ok: true, plan: solveWith(await highs, event.data) };
  } catch (error) {
    response = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  self.postMessage(response);
};
