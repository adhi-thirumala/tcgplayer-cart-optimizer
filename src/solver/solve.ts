import { Effect, Schema } from 'effect';
import type { Highs } from 'highs';
import type { Plan, SolveInput } from '@/core/domain';
import { EMPTY_PLAN, buildModel, decodePlan } from './model';

export class SolverError extends Schema.TaggedError<SolverError>()('SolverError', { message: Schema.String }) {}

const solverError = (cause: unknown) => new SolverError({ message: cause instanceof Error ? cause.message : String(cause) });

export const solveWith = Effect.fn('solveWith')(function* (highs: Highs, input: SolveInput) {
  const model = yield* Effect.try({ try: () => buildModel(input), catch: solverError });
  if (!model) return EMPTY_PLAN;

  const solution = yield* Effect.try({
    try: () =>
      highs.solve(model.lp, {
        time_limit: input.timeLimitSec,
        mip_rel_gap: 0,
        // On captured carts presolve cost more than it saved (30s vs 59s, 8s vs 10s).
        presolve: 'off',
        output_flag: false,
      }),
    catch: solverError,
  });

  let status: Plan['status'];
  switch (solution.Status) {
    case 'Optimal':
      status = 'optimal';
      break;
    case 'Time limit reached':
      status = 'feasible';
      break;
    default:
      return yield* new SolverError({ message: `Solver failed: ${solution.Status}` });
  }

  const columns: Partial<Record<string, { Primal?: number }>> = solution.Columns;
  // A time-limited solve without an incumbent reports no primal values.
  if (columns['m0']?.Primal === undefined) {
    return yield* new SolverError({ message: 'Solver hit the time limit before finding any plan.' });
  }
  return decodePlan(model, (name) => columns[name]?.Primal ?? 0, status);
});
