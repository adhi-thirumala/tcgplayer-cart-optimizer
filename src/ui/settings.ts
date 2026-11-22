import { Effect, Option, Schema } from 'effect';
import { storage } from '#imports';
import { DEFAULT_SOLVE_OPTIONS, ProductId, SolveOptions } from '@/core/domain';

/** Products the user locked to the exact printing in their cart. */
const pinnedProducts = storage.defineItem<unknown>('local:pinnedProducts');
const solveOptions = storage.defineItem<unknown>('local:solveOptions');

const Pins = Schema.Array(ProductId);

/** Stored values from an older version that no longer decode fall back to the defaults. */
export const loadPins = Effect.promise(() => pinnedProducts.getValue()).pipe(
  Effect.map((stored) => new Set(Schema.decodeUnknownOption(Pins)(stored).pipe(Option.getOrElse(() => [])))),
);

export const loadOptions = Effect.promise(() => solveOptions.getValue()).pipe(
  Effect.map((stored) => Schema.decodeUnknownOption(SolveOptions)(stored).pipe(Option.getOrElse(() => DEFAULT_SOLVE_OPTIONS))),
);

export const savePins = (pins: ReadonlySet<ProductId>) => Effect.promise(() => pinnedProducts.setValue([...pins]));

export const saveOptions = (options: SolveOptions) => Effect.promise(() => solveOptions.setValue(options));
