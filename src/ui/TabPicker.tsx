import { useEffect, useState } from 'react';
import type { OptimizerActions } from './useOptimizer';

export function TabPicker({ reason, actions }: { reason: string; actions: OptimizerActions }) {
  const [tabs, setTabs] = useState<Browser.tabs.Tab[] | null>(null);

  useEffect(() => {
    let live = true;
    void actions.findTabs().then((found) => live && setTabs(found));
    return () => {
      live = false;
    };
  }, [actions]);

  return (
    <section className="panel" aria-labelledby="tab-picker-title">
      <h2 id="tab-picker-title">Connect to TCGplayer</h2>
      <p className="muted">{reason}</p>
      {tabs === null ? (
        <p className="muted">Looking for open TCGplayer tabs…</p>
      ) : tabs.length === 0 ? (
        <p>No TCGplayer tab is open.</p>
      ) : (
        <ul className="tab-list">
          {tabs.map((tab) => (
            <li key={tab.id}>
              <span className="tab-title">{tab.title || tab.url}</span>
              {/* Reloading injects the content script into tabs opened before install. */}
              <button type="button" onClick={() => tab.id !== undefined && void actions.connect(tab.id, true)}>
                Use this tab
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="primary" onClick={() => void actions.openCartTab()}>
        Open TCGplayer cart
      </button>
    </section>
  );
}
