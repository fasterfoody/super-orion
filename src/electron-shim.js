// Browser shim for Electron IPC - for development testing only
// In production (Electron), this file is not used

const MOCK_OPENCLAW_STATUS = {
  packageExists: true,
  isBuilt: true,
  dir: '/usr/lib/node_modules/openclaw',
  version: '2026.4.9'
};

// Shared state for IPC channels - allows invoke handlers to fire on() listeners
const ipcState = {
  listeners: {
    'gateway:status': [],
    'oauth:success': [],
    'oauth:code': [],
    'oauth:error': [],
  },
  pendingOAuth: null,
};

function createIpcHandler() {
  const handlers = {
    'hostapi:token': () => Promise.resolve('dev-mock-token'),

    'hostapi:fetch': (opts) => {
      const { path, method = 'GET' } = opts || {};
      // Mock Host API responses for dev mode
      // Response format: { ok: true, data: { json: <actual-response> } }
      // This matches what parseUnifiedProxyResponse expects: data.json or data.text
      if (path === '/api/gateway/status') {
        return Promise.resolve({ ok: true, data: { json: { state: 'running', port: 18789, methods: 125 } } });
      }
      if (path === '/api/providers') {
        return Promise.resolve({ ok: true, data: { json: [] } });
      }
      if (path === '/api/provider-accounts') {
        return Promise.resolve({ ok: true, data: { json: [] } });
      }
      if (path === '/api/provider-accounts/default') {
        return Promise.resolve({ ok: true, data: { json: { accountId: null } } });
      }
      if (path === '/api/provider-vendors') {
        return Promise.resolve({ ok: true, data: { json: [] } });
      }
      if (path === '/api/providers/oauth/start') {
        // Simulate OAuth success synchronously in dev mode
        setTimeout(() => {
          ipcState.listeners['oauth:success'].forEach(cb =>
            cb({ accountId: 'minimax-portal-cn-dev', label: 'MiniMax (CN)' })
          );
        }, 0);
        return Promise.resolve({ success: true });
      }
      if (path === '/api/logs') {
        return Promise.resolve({ ok: true, data: { json: { content: '[dev mode] No logs available' } } });
      }
      if (path === '/api/logs/dir') {
        return Promise.resolve({ ok: true, data: { json: { dir: '/tmp/openclaw' } } });
      }
      if (path === '/api/openclaw/status') {
        return Promise.resolve({ ok: true, data: { json: MOCK_OPENCLAW_STATUS } });
      }
      if (path.startsWith('/api/providers/') && path.endsWith('/api-key')) {
        return Promise.resolve({ ok: true, data: { json: { apiKey: null } } });
      }
      if (path.startsWith('/api/providers/')) {
        return Promise.resolve({ ok: true, data: { json: null } });
      }
      return Promise.resolve({ ok: true, data: { json: null } });
    },

    'gateway:status': () => ({ state: 'running', port: 18789 }),
    'gateway:health': () => ({ ok: true, uptime: 3600 }),
    'gateway:getControlUiUrl': () => ({ success: true, token: 'mock-token' }),
    'openclaw:status': () => MOCK_OPENCLAW_STATUS,
    'settings:getAll': () => ({
      theme: 'dark',
      language: 'zh',
      setupComplete: false,
      hasHydrated: true,
      settingsLoaded: true,
    }),
    'settings:get': () => null,
    'settings:setMany': () => ({ success: true }),
    'provider:list': () => [],
    'provider:getDefault': () => null,
    'provider:validateKey': () => ({ valid: true }),
    'oauth:start': () => {
      // Fire synchronously so the event is processed before invoke returns
      setTimeout(() => {
        ipcState.listeners['oauth:success'].forEach(cb =>
          cb({ accountId: 'minimax-portal-cn-dev', label: 'MiniMax (CN)' })
        );
      }, 0);
      return { success: true };
    },
    'uv:install-all': () => ({ success: true }),
    'oauth:submit': () => ({ success: true }),
    'oauth:cancel': () => {
      if (ipcState.pendingOAuth) clearTimeout(ipcState.pendingOAuth);
      return { success: true };
    },
    'agent:list': () => [{ id: 'main', name: 'main', model: 'minimax/MiniMax-M2.7' }],
    'agent:bindings:list': () => [],
    'channel:list': () => [],
    'channel:status': () => ({}),
    'cron:list': () => [],
    'skill:list': () => [],
    'app:version': () => '0.0.1',
    'app:name': () => 'orion-ui',
    'app:platform': () => 'linux',
  };

  return function ipcHandler(channel, ...args) {
    console.warn('[electron-shim] invoke:', channel, args?.length ? args : '');

    if (handlers[channel]) {
      return Promise.resolve(handlers[channel](args[0]));
    }

    return Promise.resolve({ ok: false, error: `Not implemented: ${channel}` });
  };
}

const navCallbacks = new Map();
let navCounter = 0;

if (typeof window !== 'undefined' && !window.electron) {
  window.electron = {
    platform: 'linux',
    ipcRenderer: {
      invoke: createIpcHandler(),
      on: (channel, cb) => {
        if (channel === 'navigate') {
          const id = navCounter++;
          navCallbacks.set(id, cb);
          return () => navCallbacks.delete(id);
        }
        if (channel === 'gateway:status') {
          setTimeout(() => cb({ state: 'running', port: 18789 }), 100);
          return () => {};
        }
        // Register OAuth event listeners so invoke handlers can fire them
        if (ipcState.listeners[channel]) {
          ipcState.listeners[channel].push(cb);
          return () => {
            ipcState.listeners[channel] = ipcState.listeners[channel].filter(h => h !== cb);
          };
        }
        console.warn('[electron-shim] on:', channel);
        return () => {};
      },
      off: (channel, cb) => {
        if (ipcState.listeners[channel]) {
          ipcState.listeners[channel] = ipcState.listeners[channel].filter(h => h !== cb);
        }
      },
      send: () => {},
      sendSync: () => null,
    },
    os: {
      type: () => 'Linux',
      platform: () => 'linux',
      release: () => '6.17.0',
    },
    app: {
      getPath: () => '',
      getName: () => 'orion-ui',
      getVersion: () => '0.0.1',
    },
  };

  window.__electronNavigate = (path) => {
    navCallbacks.forEach((cb) => cb(path));
  };
}
