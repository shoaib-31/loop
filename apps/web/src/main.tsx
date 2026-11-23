import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/App';
import { registerServiceWorker } from '@/lib/push';
import { captureTokenFromUrl } from '@/lib/token';
import '@/index.css';

// BEFORE the first render, and before the user can reach Add to Home Screen: strip
// any ?token= out of the URL bar. The daemon normally redirects it away first, so
// this only fires on the dev-server path — but iOS bakes the CURRENT url into the
// installed app, so a leftover token would become permanent.
captureTokenFromUrl();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// Register early and unconditionally: the worker must be ACTIVE before the user
// taps "Enable notifications", and registering it on demand inside that handler
// adds a race for no benefit. Failure is non-fatal — the app still works as a
// viewer, and the settings screen reports why push is unavailable.
registerServiceWorker();
