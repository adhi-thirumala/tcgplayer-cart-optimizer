import { solveInHost } from '@/solver/host';
import { createOptimizer } from '@/ui/optimizer';
import { serveOptimizer } from '@/ui/remote';

/** Hosts the optimizer so a run keeps going after the popup closes. */
export default defineBackground(() => {
  serveOptimizer(createOptimizer(solveInHost));
});
