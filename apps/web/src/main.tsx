import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DYNAMIC_ENABLED } from './config';
import type { DynamicModule } from './wallet/wallet';
import './styles.css';

const root = createRoot(document.getElementById('root')!);

async function boot() {
  if (DYNAMIC_ENABLED) {
    // Code-split: the Dynamic SDK (~1.4 MB gzip) only loads when an environment id is configured.
    try {
      const mod = await import('./wallet/dynamic');
      root.render(
        <StrictMode>
          <mod.DynamicRoot>
            <App dynamic={mod.dynamicModule as DynamicModule} />
          </mod.DynamicRoot>
        </StrictMode>,
      );
      return;
    } catch (e) {
      console.warn('[isotherm] Dynamic failed to load; dev wallet only', e);
    }
  }
  root.render(
    <StrictMode>
      <App dynamic={null} />
    </StrictMode>,
  );
}

boot();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('sw register failed', e));
  });
}
