import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { connectOptimizer } from '@/ui/remote';
import { Popup } from '@/ui/Popup';
import '@/ui/styles.css';

const TCGPLAYER_PAGE = /^https:\/\/([a-z0-9-]+\.)*tcgplayer\.com\//;

// The popup works on the tab it was opened over when that is a TCGplayer page.
const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
const optimizer = connectOptimizer(tab?.id !== undefined && tab.url && TCGPLAYER_PAGE.test(tab.url) ? tab.id : null);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Popup optimizer={optimizer} />
  </StrictMode>,
);
