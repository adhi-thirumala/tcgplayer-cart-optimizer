import { CONDITIONS, type SolveOptions } from '@/core/types';
import type { OptimizerActions } from './useOptimizer';

export function OptionsPanel({
  options,
  sellerNames,
  actions,
  disabled,
}: {
  options: SolveOptions;
  sellerNames: Map<string, string>;
  actions: OptimizerActions;
  disabled: boolean;
}) {
  const update = (patch: Partial<SolveOptions>) => void actions.setOptions({ ...options, ...patch });

  return (
    <section className="panel" aria-labelledby="options-title">
      <h2 id="options-title">Options</h2>
      <fieldset disabled={disabled} className="options">
        <label>
          Minimum seller rating (%)
          <input
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={options.minSellerRating}
            onChange={(e) => update({ minSellerRating: Math.max(0, Math.min(100, e.currentTarget.valueAsNumber || 0)) })}
          />
        </label>
        <label>
          Maximum packages
          <input
            type="number"
            min={1}
            placeholder="Any"
            value={options.maxPackages ?? ''}
            onChange={(e) => {
              const value = Math.trunc(e.currentTarget.valueAsNumber);
              update({ maxPackages: Number.isFinite(value) && value > 0 ? value : null });
            }}
          />
        </label>
        <fieldset className="conditions">
          <legend>Conditions</legend>
          {CONDITIONS.map((condition) => (
            <label key={condition}>
              <input
                type="checkbox"
                checked={options.conditions.includes(condition)}
                onChange={(e) => {
                  const next = e.currentTarget.checked
                    ? CONDITIONS.filter((c) => c === condition || options.conditions.includes(c))
                    : options.conditions.filter((c) => c !== condition);
                  if (next.length > 0) update({ conditions: next });
                }}
              />
              {condition}
            </label>
          ))}
        </fieldset>
        {options.excludeSellerKeys.length > 0 && (
          <div className="excluded">
            <span>Excluded sellers:</span>
            {options.excludeSellerKeys.map((key) => (
              <button
                key={key}
                type="button"
                className="chip"
                aria-label={`Allow ${sellerNames.get(key) ?? key} again`}
                onClick={() => update({ excludeSellerKeys: options.excludeSellerKeys.filter((k) => k !== key) })}
              >
                {sellerNames.get(key) ?? key} ×
              </button>
            ))}
          </div>
        )}
      </fieldset>
    </section>
  );
}
