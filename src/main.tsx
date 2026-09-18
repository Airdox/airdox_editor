import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary';
import { logger } from './utils/logger';
import './index.css';

// Initialize global error interception and the desktop persistence sink before
// React renders. In browser/Vite mode this remains console + ring-buffer only.
void logger;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
