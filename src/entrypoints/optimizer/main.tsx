import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/ui/App';
import { connectOptimizer } from '@/ui/remote';
import '@/ui/styles.css';

const optimizer = connectOptimizer(null);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App optimizer={optimizer} />
  </StrictMode>,
);
