/**
 * React Application Entry Point
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import './i18n';
import './styles/globals.css';
import './electron-shim'; // Browser shim - no-op in Electron (preload provides real IPC)
import { initializeDefaultTransports, configureApiClient } from './lib/api-client';

// Enable transports: IPC first (Electron), then WS fallback (browser dev)
configureApiClient({
  enabled: {
    ws: true,
    http: true,
  },
  rules: [
    { matcher: /.*/, order: ['ipc', 'ws', 'http'] },
  ],
});

initializeDefaultTransports();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
