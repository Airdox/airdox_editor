import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary';
import { APP_VERSION } from './utils/appVersion';
import './index.css';

// Window/taskbar title carries the version so the running build is
// identifiable at a glance (deviates from index.html on purpose).
document.title = `airdox_SMART_Editor v${APP_VERSION}`;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
