import { storage } from '#imports';
import { CONDITIONS, DEFAULT_SOLVE_OPTIONS, type ProductId, type SolveOptions } from '@/core/types';

/** Products the user locked to the exact printing in their cart. */
export const pinnedProducts = storage.defineItem<ProductId[]>('local:pinnedProducts', { fallback: [] });

/** Solver options, minus the time limit (not user-facing). */
export const solveOptions = storage.defineItem<SolveOptions>('local:solveOptions', {
  fallback: DEFAULT_SOLVE_OPTIONS,
});

/** Stored options merged over defaults so options added in later versions get sane values. */
export async function loadSolveOptions(): Promise<SolveOptions> {
  const stored = { ...DEFAULT_SOLVE_OPTIONS, ...(await solveOptions.getValue()) };
  const conditions = stored.conditions.filter((c) => CONDITIONS.includes(c));
  return { ...stored, conditions: conditions.length > 0 ? conditions : DEFAULT_SOLVE_OPTIONS.conditions };
}
