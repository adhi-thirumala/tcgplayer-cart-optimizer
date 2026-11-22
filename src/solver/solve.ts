import type { Highs } from 'highs';
import type { Plan, SolveInput } from '@/core/types';
import { buildModel, decodePlan, emptyPlan } from './model';

export function solveWith(highs: Highs, input: SolveInput): Plan {
  const model = buildModel(input);
  if (!model) return emptyPlan();

  const solution = highs.solve(model.lp, {
    time_limit: input.options.timeLimitSec,
    mip_rel_gap: 0,
    // On captured carts presolve cost more than it saved (30s vs 59s, 8s vs 10s).
    presolve: 'off',
    output_flag: false,
  });

  let status: Plan['status'];
  switch (solution.Status) {
    case 'Optimal':
      status = 'optimal';
      break;
    case 'Time limit reached':
      status = 'feasible';
      break;
    case 'Infeasible':
      return { ...emptyPlan(), status: 'infeasible' };
    default:
      throw new Error(`Solver failed: ${solution.Status}`);
  }

  const columns = solution.Columns as Record<string, { Primal?: number } | undefined>;
  // A time-limited solve without an incumbent reports no primal values.
  if (status === 'feasible' && columns['m0']?.Primal === undefined) {
    throw new Error('Solver hit the time limit before finding any plan; raise the time limit.');
  }
  return decodePlan(model, (name) => columns[name]?.Primal ?? 0, status);
}
