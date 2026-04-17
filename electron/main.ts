/**
 * Orion UI - Electron Main Process
 * Minimal Electron shell that connects to system OpenClaw Gateway.
 * Does NOT manage OpenClaw itself - just provides IPC bridge.
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { join } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import { existsSync, appendFileSync, readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

let mainWindow: BrowserWindow | null = null;
const log = (msg: string) => appendFileSync('/tmp/orion-main.log', `${new Date().toISOString()} ${msg}\n`);

// Orion settings file (separate from OpenClaw config)
const getOrionSettingsPath = () => join(app.getPath('userData'), 'orion-settings.json');

const readOrionSettings = (): Record<string, unknown> => {
  try {
    const path = getOrionSettingsPath();
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch {}
  return {};
};

const writeOrionSettings = (settings: Record<string, unknown>) => {
  try {
    writeFileSync(getOrionSettingsPath(), JSON.stringify(settings, null, 2), 'utf-8');
  } catch (e) {
    log(`settings write error: ${e}`);
  }
};

// Shared WebSocket client for gateway RPC — persists across IPC calls
// Key insight from OpenClaw control UI: uses clientId='openclaw-control-ui', mode='webchat',
// and just needs the gateway token (no deviceToken needed).
const gatewayWsClient = (() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ws: any = null;
  let pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  let requestId = 0;
  let handshakeDone = false;
  let isConnecting = false;
  let connectResolve: Array<(v: void) => void> = [];
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const GATEWAY_TOKEN = 'clawx-91e9e41c47c7e91d5dc4561598df899a';

  function genId() { return ++requestId; }

  function connect(): Promise<void> {
    if (ws && ws.readyState === 1 && handshakeDone) return Promise.resolve();

    // If already connecting, wait for that connection to complete
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } // Cancel any pending auto-reconnect
    if (isConnecting) {
      return new Promise((resolve) => {
        connectResolve.push(resolve);
      });
    }

    isConnecting = true;
    return new Promise((resolve, reject) => {
      // Use Node.js built-in WebSocket (Node 22) with Origin header for loopback
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wsOptions = { headers: { 'Origin': 'http://127.0.0.1:18789' } } as any;
      ws = new globalThis.WebSocket('ws://127.0.0.1:18789', wsOptions) as any;

      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('WS connect timeout')); }, 8000);

      // Wait for WebSocket to be truly OPEN before considering the connection ready.
      // This fires when the HTTP upgrade completes and the socket can send.
      ws.onopen = () => {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } // Cancel auto-reconnect since we're connected
      };

      ws.onmessage = (event: { data: string }) => {
        try {
          const msg = JSON.parse(event.data.toString());

          if (msg.type === 'event' && msg.event === 'connect.challenge') {
            const nonce = msg.payload?.nonce;
            if (!nonce) { ws.close(); reject(new Error('no nonce in challenge')); return; }

            // Correct params: clientId='openclaw-control-ui', mode='webchat', all 3 scopes
            // No deviceToken needed - just the gateway token
            ws.send(JSON.stringify({
              type: 'req',
              id: `c-${Date.now()}`,
              method: 'connect',
              params: {
                minProtocol: 3,
                maxProtocol: 3,
                client: {
                  id: 'openclaw-control-ui',
                  displayName: '猎户座',
                  version: '1.0.0',
                  platform: process.platform,
                  mode: 'webchat',
                },
                auth: { token: GATEWAY_TOKEN },
                caps: ['tool-events'],
                role: 'operator',
                scopes: ['operator.admin', 'operator.read', 'operator.write'],
                userAgent: '猎户座/1.0',
                locale: 'zh-CN',
              },
            }));
          }

          if (msg.type === 'res' && msg.id && msg.id.toString().startsWith('c-')) {
            clearTimeout(timer);
            if (!msg.ok) {
              log('Connect failed: ' + JSON.stringify(msg.error));
              ws.close();
              handshakeDone = false;
              isConnecting = false;
              connectResolve.forEach((r) => r());
              connectResolve = [];
              reject(new Error('WS auth failed: ' + (msg.error?.message || 'unknown')));
              return;
            }
            log('Connect OK, methods: ' + (msg.payload?.features?.methods?.length || 0));
            handshakeDone = true;
            ws.onmessage = onMessage;
            isConnecting = false;
            resolve();
            connectResolve.forEach((r) => r());
            connectResolve = [];
          }
        } catch (e) {
          log('WS message error: ' + String(e));
        }
      };

      ws.onerror = (e: unknown) => {
        clearTimeout(timer);
        log('WS error: ' + String(e));
        isConnecting = false;
        connectResolve.forEach((r) => r());
        connectResolve = [];
        reject(new Error('WS error'));
      };

      ws.onclose = () => {
        handshakeDone = false;
        isConnecting = false;
        ws = null;
        // Wake up any callers waiting on this (failed) connection —
        // they will retry connect() and get a fresh socket.
        connectResolve.forEach((r) => r());
        connectResolve = [];
        // Auto-reconnect after 3 seconds
        if (reconnectTimer) { clearTimeout(reconnectTimer); }
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          log('[WS] Auto-reconnecting...');
          connect().catch(() => {});
        }, 3000);
      };
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function onMessage(event: { data: string }) {
    try {
      const msg = JSON.parse(event.data.toString());
      if (msg.type !== 'res' || typeof msg.id !== 'string') return;
      const id = parseInt(msg.id, 10);
      if (isNaN(id)) { log(`onMessage: non-numeric res id=${msg.id} method=${msg.method}`); return; }
      const handler = pending.get(id);
      if (!handler) { log(`onMessage: no handler for id=${id}`); return; }
      pending.delete(id);
      log(`onMessage resolved: id=${id} method=${msg.method} error=${!!msg.error}`);
      if (msg.error) handler.reject(msg.error);
      else handler.resolve(msg.payload);
    } catch (e) { log(`onMessage error: ${e}`); }
  }

  function invoke(method: string, params?: unknown): Promise<unknown> {
    return connect().then(() => doSend());

    function doSend(): Promise<unknown> {
      return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== 1) {
          log(`invoke: ws not ready ws=${!!ws} state=${ws?.readyState} for ${method} — retrying`);
          connect().then(() => doSend()).catch(reject);
          return;
        }
        const id = genId();
        const start = Date.now();
        pending.set(id, { resolve, reject });
        log(`invoke send: ${method} id=${id} state=${ws.readyState}`);
        ws.send(JSON.stringify({ type: 'req', id: String(id), method, params }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            log(`invoke timeout: ${method} id=${id} after ${Date.now() - start}ms`);
            reject(new Error(`WS call timeout: ${method}`));
          }
        }, 30000);
      });
    }
  }

  return { invoke, connect };
})();

// FORCE no dev server - always load from asar
const isDev = false;
log(`Starting, isDev=${isDev}, NODE_ENV=${process.env.NODE_ENV}`);

function createWindow() {
  log('createWindow called');
  try {
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      title: '猎户座',
      icon: join(__dirname, '../build/icon.png'),
      show: true,
      webPreferences: {
        preload: join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    log(`BrowserWindow created, isDev=${isDev}`);

    mainWindow.webContents.on('render-process-gone', (_, details) => {
      log(`RENDER PROCESS GONE: reason=${details.reason}, exitCode=${details.exitCode}`);
    });
    mainWindow.webContents.on('did-fail-load', (_, errorCode, errorDesc) => {
      log(`PAGE FAILED TO LOAD: ${errorCode} ${errorDesc}`);
    });
    mainWindow.webContents.on('console-message', (_, level, message) => {
      if (level >= 2) {
        log(`CONSOLE[${level}]: ${message}`);
      }
    });

    const loadTarget = isDev
      ? 'http://localhost:5173'
      : join(__dirname, '../dist/index.html');
    log(`Loading: ${loadTarget}`);

    if (isDev) {
      mainWindow.loadURL(loadTarget);
      mainWindow.webContents.openDevTools();
    } else {
      mainWindow.loadFile(loadTarget);
    }

    mainWindow.webContents.on('did-finish-load', () => {
      log('Page finished loading');
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
      log('Window closed');
    });

    log('Window setup complete');
  } catch (err) {
    log(`Error in createWindow: ${err}`);
  }
}

// ==================== OAuth Helpers ====================

// Pending OpenAI OAuth state (for manual code submission flow)
let pendingOpenAICodes: { verifier: string; state: string } | null = null;

// Parse authorization code from callback URL or raw code
function parseOAuthCode(input: string): { code?: string; state?: string } {
  const trimmed = input.trim();
  if (!trimmed) return {};
  try {
    const url = new URL(trimmed);
    return {
      code: url.searchParams.get('code') ?? void 0,
      state: url.searchParams.get('state') ?? void 0,
    };
  } catch {}
  if (trimmed.includes('code=')) {
    try {
      const params = new URLSearchParams(trimmed);
      return {
        code: params.get('code') ?? void 0,
        state: params.get('state') ?? void 0,
      };
    } catch {}
  }
  return { code: trimmed };
}

// ── MiniMax Device Code OAuth (RFC 8628) ──────────────────────────────────────
async function handleMiniMaxOAuth(
  providerId: string,
  _accountId: string,
  _label: string,
): Promise<{ ok: boolean; data: { status: number; json: Record<string, unknown> }; success: boolean }> {
  const region = providerId.includes('cn') ? 'cn' : 'global';
  const MINIMAX_ENDPOINTS = {
    cn: { baseUrl: 'https://api.minimaxi.com', clientId: '78257093-7e40-4613-99e0-527b14b39113' },
    global: { baseUrl: 'https://api.minimax.io', clientId: '78257093-7e40-4613-99e0-527b14b39113' },
  };
  const SCOPE = 'group_id profile model.completion';
  const USER_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:user_code';
  const ep = MINIMAX_ENDPOINTS[region];

  const { randomBytes, createHash } = await import('crypto');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');
  const codeEndpoint = `${ep.baseUrl}/oauth/code`;
  const tokenEndpoint = `${ep.baseUrl}/oauth/token`;

  const authResponse = await fetch(codeEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'x-request-id': randomBytes(16).toString('hex') },
    body: new URLSearchParams({ response_type: 'code', client_id: ep.clientId, scope: SCOPE, code_challenge: challenge, code_challenge_method: 'S256', state }).toString(),
  });

  if (!authResponse.ok) {
    return { ok: true, data: { status: 200, json: { success: false, error: `OAuth failed: ${await authResponse.text()}` } }, success: true };
  }

  const authData = await authResponse.json();
  if (!authData.user_code || !authData.verification_uri) {
    return { ok: true, data: { status: 200, json: { success: false, error: 'Incomplete OAuth response' } }, success: true };
  }

  const verificationUri = authData.verification_uri;
  const userCode = authData.user_code;
  const intervalMs = authData.interval || 5; // already in milliseconds
  const expiredInMs = authData.expired_in;
  const expiresAt = expiredInMs && expiredInMs > 1e12 ? expiredInMs : Date.now() + (expiredInMs || 300) * 1000;

  log(`[OAuth] MiniMax ${region}: verification_uri=${verificationUri}, user_code=${userCode}`);

  // Open browser immediately
  shell.openExternal(verificationUri).catch((e: unknown) => log(`[OAuth] Failed to open browser: ${e}`));

  // Notify renderer via IPC (backup for dev mode)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('oauth:code', { provider: providerId, verificationUri, userCode, expiresIn: Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)) });
  }

  // Start async polling
  (async () => {
    try {
      while (Date.now() < expiresAt) {
        await new Promise((r) => setTimeout(r, intervalMs));
        const pollResponse = await fetch(tokenEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
          body: new URLSearchParams({ grant_type: USER_CODE_GRANT, client_id: ep.clientId, user_code: userCode, code_verifier: verifier }).toString(),
        });
        const pollData = await pollResponse.json();
        if (pollData.status === 'success') {
          log(`[OAuth] MiniMax ${region}: Authorization succeeded!`);
          saveOAuthTokens('minimax-portal', pollData.access_token, pollData.refresh_token, pollData.expired_in);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('oauth:success', { provider: providerId, accountId: providerId, success: true });
          }
          return;
        } else if (pollData.status === 'error') {
          log(`[OAuth] MiniMax ${region}: Authorization error: ${pollData.base_resp?.status_msg || pollData.message}`);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('oauth:error', { provider: providerId, message: pollData.base_resp?.status_msg || 'Authorization failed' });
          }
          return;
        }
      }
      log(`[OAuth] MiniMax ${region}: Authorization timed out`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('oauth:error', { provider: providerId, message: 'Authorization timed out. Please try again.' });
      }
    } catch (e) {
      log(`[OAuth] MiniMax polling error: ${e}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('oauth:error', { provider: providerId, message: String(e) });
      }
    }
  })();

  return {
    ok: true,
    data: {
      status: 200,
      json: {
        success: true,
        provider: providerId,
        oauthData: { provider: providerId, verificationUri, userCode, expiresIn: Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)) },
      },
    },
    success: true,
  };
}

// ── OpenAI Browser OAuth ──────────────────────────────────────────────────────
async function handleOpenAIOAuth(
  providerId: string,
  _accountId: string,
  _label: string,
): Promise<{ ok: boolean; data: { status: number; json: Record<string, unknown> }; success: boolean }> {
  const { randomBytes, createHash } = await import('crypto');

  const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
  const AUTH_URL = 'https://auth.openai.com/oauth/authorize';
  const TOKEN_URL = 'https://auth.openai.com/oauth/token';
  const CALLBACK_URI = 'http://localhost:1455/auth/callback';
  const SCOPE = 'openid profile email offline_access';

  // Generate PKCE
  const base64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(16));

  // Build authorization URL
  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', CALLBACK_URI);
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('id_token_add_organizations', 'true');
  authUrl.searchParams.set('codex_cli_simplified_flow', 'true');
  authUrl.searchParams.set('originator', 'codex_cli_rs');

  const authorizationUrl = authUrl.toString();
  log(`[OAuth] OpenAI: opening ${authorizationUrl}`);

  // Open browser immediately
  shell.openExternal(authorizationUrl).catch((e: unknown) => log(`[OAuth] Failed to open browser: ${e}`));

  // Notify renderer via IPC (backup) - mode=manual since we need callback URL
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('oauth:code', {
      provider: providerId,
      mode: 'manual',
      authorizationUrl,
      message: 'Complete sign-in in the browser, then paste the final callback URL or code here.',
    });
  }

  // Store pending state for submit handler
  pendingOpenAICodes = { verifier, state };

  return {
    ok: true,
    data: {
      status: 200,
      json: {
        success: true,
        provider: providerId,
        oauthData: {
          provider: providerId,
          mode: 'manual',
          authorizationUrl,
          message: 'Complete sign-in in the browser, then paste the final callback URL or code here.',
        },
      },
    },
    success: true,
  };
}

async function exchangeOpenAIAuthCode(
  code: string,
  verifier: string,
  providerId: string,
  _accountId: string,
): Promise<{ ok: boolean; data: { status: number; json: Record<string, unknown> }; success: boolean }> {
  const TOKEN_URL = 'https://auth.openai.com/oauth/token';
  const CALLBACK_URI = 'http://localhost:1455/auth/callback';

  try {
    const tokenResponse = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
        code,
        code_verifier: verifier,
        redirect_uri: CALLBACK_URI,
      }).toString(),
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      return { ok: true, data: { status: 200, json: { success: false, error: `Token exchange failed: ${errText}` } }, success: true };
    }

    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token || !tokenData.refresh_token || typeof tokenData.expires_in !== 'number') {
      return { ok: true, data: { status: 200, json: { success: false, error: 'Token response missing required fields' } }, success: true };
    }

    const expiresAt = Date.now() + tokenData.expires_in * 1000;
    log(`[OAuth] OpenAI: Authorization succeeded!`);

    // Save tokens
    saveOAuthTokens('openai', tokenData.access_token, tokenData.refresh_token, expiresAt);

    // Notify renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('oauth:success', { provider: providerId, accountId: providerId, success: true });
    }

    pendingOpenAICodes = null;
    return { ok: true, data: { status: 200, json: { success: true, provider: providerId } }, success: true };
  } catch (e) {
    log(`[OAuth] OpenAI token exchange error: ${e}`);
    return { ok: true, data: { status: 200, json: { success: false, error: String(e) } }, success: true };
  }
}

// ── Google Browser OAuth ───────────────────────────────────────────────────────
async function handleGoogleOAuth(
  providerId: string,
  _accountId: string,
  _label: string,
): Promise<{ ok: boolean; data: { status: number; json: Record<string, unknown> }; success: boolean }> {
  // Google OAuth in ClawX uses Gemini CLI helper; for now return not-implemented
  return {
    ok: true,
    data: {
      status: 200,
      json: {
        success: false,
        error: 'Google OAuth is not yet implemented. Use API key authentication instead.',
      },
    },
    success: true,
  };
}

// ── Shared: Save OAuth Tokens ─────────────────────────────────────────────────
function saveOAuthTokens(provider: string, accessToken: string, refreshToken: string, expiresAt: number | undefined) {
  try {
    const authProfilesPath = '/home/enbro/.openclaw/agents/main/agent/auth-profiles.json';
    const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('fs');
    const dir = authProfilesPath.substring(0, authProfilesPath.lastIndexOf('/'));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    let authData = { version: 1, profiles: {} as Record<string, unknown> };
    if (existsSync(authProfilesPath)) {
      try { authData = JSON.parse(readFileSync(authProfilesPath, 'utf8')); } catch {}
    }
    if (!authData.profiles) authData.profiles = {};

    const profileId = `${provider}:default`;
    authData.profiles[profileId] = {
      type: 'oauth',
      provider,
      access: accessToken,
      refresh: refreshToken,
      expires: expiresAt,
    };
    writeFileSync(authProfilesPath, JSON.stringify(authData, null, 2), 'utf8');
    log(`[OAuth] Saved tokens to auth-profiles.json: ${profileId}`);
  } catch (e) {
    log(`[OAuth] Failed to save tokens: ${e}`);
  }
}

// ==================== IPC Handlers ====================

// Host API proxy — routes /api/* calls to system OpenClaw CLI
ipcMain.handle('hostapi:fetch', async (_, request: {
  path: string;
  method: string;
  headers?: Record<string, string>;
  body?: string | null;
}) => {
  const { path, method, headers = {}, body } = request;
  log(`hostapi:fetch ${method} ${path}`);

  // Map hostapi paths to openclaw CLI commands
  try {
    if (path === '/api/gateway/status') {
      return await gatewayStatus();
    }
    if (path === '/api/gateway/start') {
      return await gatewayStart();
    }
    if (path === '/api/gateway/stop') {
      return await gatewayStop();
    }
    if (path === '/api/gateway/restart') {
      return await gatewayRestart();
    }
    if (path === '/api/gateway/health') {
      return await gatewayHealth();
    }
    if (path === '/api/gateway/version') {
      return await gatewayVersion();
    }
    if (path === '/api/logs?tailLines=100' || path.startsWith('/api/logs')) {
      return await gatewayLogs(path);
    }

    // Provider API — read from running openclaw config
    if (path === '/api/provider-accounts') {
      if (method === 'POST') {
        // Create new provider account
        const { existsSync, readFileSync, writeFileSync } = require('fs') as typeof import('fs');
        try {
          const body = JSON.parse(request.body as string || '{}');
          const { account, apiKey } = body as {
            account: {
              id: string;
              vendorId: string;
              label?: string;
              baseUrl?: string;
              model?: string;
              apiProtocol?: string;
              enabled?: boolean;
              isDefault?: boolean;
            };
            apiKey?: string;
          };

          if (!account?.id) {
            return { ok: true, data: { status: 400, json: { success: false, error: 'account.id is required' } }, success: true };
          }

          const authProfilesPath = '/home/enbro/.openclaw/agents/main/agent/auth-profiles.json';
          let authData: Record<string, unknown> = { version: 1, profiles: {} as Record<string, unknown> };
          if (existsSync(authProfilesPath)) {
            try { authData = JSON.parse(readFileSync(authProfilesPath, 'utf8')); } catch {}
          }
          const profiles = (authData['profiles'] as Record<string, Record<string, unknown>>) || {};

          // Add auth profile
          profiles[account.id] = {
            type: 'api_key',
            provider: account.vendorId,
            mode: 'api_key',
            ...(apiKey ? { key: apiKey } : {}),
          };
          authData['profiles'] = profiles;
          writeFileSync(authProfilesPath, JSON.stringify(authData, null, 2), 'utf8');

          // Also add provider to models.json if it doesn't exist
          const agentModelsPath = '/home/enbro/.openclaw/agents/main/agent/models.json';
          let modelsData: Record<string, unknown> = { providers: {} as Record<string, unknown> };
          if (existsSync(agentModelsPath)) {
            try { modelsData = JSON.parse(readFileSync(agentModelsPath, 'utf8')); } catch {}
          }
          const providers = (modelsData['providers'] as Record<string, Record<string, unknown>>) || {};

          if (!providers[account.id]) {
            // New provider — create minimal entry
            const effectiveBaseUrl = account.baseUrl || getDefaultBaseUrl(account.vendorId);
            const effectiveApi = account.apiProtocol || 'anthropic-messages';
            const modelEntry: Record<string, unknown> = {
              id: account.model || 'default',
              name: account.model || 'Default Model',
              input: ['text'],
              reasoning: false,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 8192,
              api: effectiveApi,
            };
            providers[account.id] = {
              baseUrl: effectiveBaseUrl,
              api: effectiveApi,
              authHeader: true,
              models: [modelEntry],
              ...(apiKey ? { apiKey } : {}),
            };
            modelsData['providers'] = providers;
            writeFileSync(agentModelsPath, JSON.stringify(modelsData, null, 2), 'utf8');
          } else if (apiKey) {
            // Provider exists — update apiKey if provided
            const prov = providers[account.id] as Record<string, unknown>;
            prov['apiKey'] = apiKey;
            writeFileSync(agentModelsPath, JSON.stringify(modelsData, null, 2), 'utf8');
          }

          return { ok: true, data: { status: 200, json: { success: true } }, success: true };
        } catch (e) {
          return { ok: true, data: { status: 500, json: { success: false, error: String(e) } }, success: true };
        }
      }

      // GET — list accounts
      const accounts = await getProviderAccounts();
      return { ok: true, data: { status: 200, json: accounts }, success: true };
    }
    if (path === '/api/provider-accounts/default') {
      const defaultId = await getDefaultProviderAccountId();
      return { ok: true, data: { status: 200, json: { accountId: defaultId } }, success: true };
    }
    if (path === '/api/providers') {
      const providers = await getProviders();
      return { ok: true, data: { status: 200, json: providers }, success: true };
    }
    if (path === '/api/provider-vendors') {
      const vendors = getProviderVendors();
      return { ok: true, data: { status: 200, json: vendors }, success: true };
    }
    // GET /api/providers/:id
    const providerMatch = path.match(/^\/api\/providers\/([^\/]+)$/);
    if (providerMatch && method === 'GET') {
      const id = decodeURIComponent(providerMatch[1]);
      const provider = await getProviderById(id);
      return { ok: true, data: { status: 200, json: provider }, success: true };
    }
    // GET /api/providers/:id/api-key
    const keyMatch = path.match(/^\/api\/providers\/([^\/]+)\/api-key$/);
    if (keyMatch && method === 'GET') {
      const id = decodeURIComponent(keyMatch[1]);
      const keyInfo = await getProviderApiKey(id);
      return { ok: true, data: { status: 200, json: keyInfo }, success: true };
    }

    // Skills configs — read skill API keys/env from gateway store
    if (path === '/api/skills/configs' && method === 'GET') {
      try {
        const configs = await gatewayWsClient.invoke('skills.configs') as Record<string, { apiKey?: string; env?: Record<string, string> }>;
        return { ok: true, data: { status: 200, json: configs || {} }, success: true };
      } catch {
        return { ok: true, data: { status: 200, json: {} }, success: true };
      }
    }

    // ClawHub — list installed skills (gateway skills.catalog)
    if (path === '/api/clawhub/list' && method === 'GET') {
      try {
        const catalog = await gatewayWsClient.invoke('skills.catalog');
        // Transform catalog to ClawHubListResult[] format
        const results = [] as Array<{ slug: string; name: string; description: string; version: string }>;
        if (catalog && typeof catalog === 'object') {
          for (const [slug, data] of Object.entries(catalog as Record<string, unknown>)) {
            const d = data as Record<string, unknown>;
            results.push({
              slug,
              name: String(d.name || slug),
              description: String(d.description || ''),
              version: String(d.version || '1.0.0'),
            });
          }
        }
        return { ok: true, data: { status: 200, json: { success: true, results } }, success: true };
      } catch {
        return { ok: true, data: { status: 200, json: { success: true, results: [] } }, success: true };
      }
    }

    // ClawHub — open skill readme (read README and return content)
    if (path === '/api/clawhub/open-readme' && method === 'POST') {
      try {
        const { slug, skillKey, baseDir } = JSON.parse(request.body || '{}');
        const skillSlug = slug || skillKey;
        const skillBaseDir = baseDir || skillSlug;
        // If baseDir is provided, use it directly
        const readmePath = skillBaseDir
          ? join(skillBaseDir, 'README.md')
          : join(homedir(), '.openclaw', 'workspace', 'skills', skillSlug, 'README.md');
        const content = (await import('node:fs/promises')).readFile(readmePath, 'utf8').catch(() => '');
        // Also try to open in editor
        const dirPath = skillBaseDir || join(homedir(), '.openclaw', 'workspace', 'skills', skillSlug);
        spawn('sh', ['-c', `code "${dirPath}" 2>/dev/null || code-insiders "${dirPath}" 2>/dev/null || xdg-open "${dirPath}" 2>/dev/null || true`]);
        return { ok: true, data: { status: 200, json: { success: true, content } }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 200, json: { success: false, error: String(e) } }, success: true };
      }
    }

    // ClawHub — open skill path (reveal folder in file manager)
    if (path === '/api/clawhub/open-path' && method === 'POST') {
      try {
        const { slug, skillKey, baseDir } = JSON.parse(request.body || '{}');
        const skillSlug = slug || skillKey;
        const skillBaseDir = baseDir || (skillSlug ? join(homedir(), '.openclaw', 'workspace', 'skills', skillSlug) : '');
        if (skillBaseDir) shell.showItemInFolder(skillBaseDir);
        return { ok: true, data: { status: 200, json: { success: true } }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 200, json: { success: false, error: String(e) } }, success: true };
      }
    }

    // Gateway WS-backed API calls
    // GET /api/agents → agents.list (transformed to AgentsSnapshot UI format)
    if (path === '/api/agents' && method === 'GET') {
      try {

        const snapshot = await buildAgentsSnapshot();

        return { ok: true, data: { status: 200, json: snapshot }, success: true };
      } catch (e) {
        return { ok: false, error: { message: String(e) }, success: false };
      }
    }
    // GET /api/agents/bindings → openclaw agents bindings --json
    if (path === '/api/agents/bindings' && method === 'GET') {
      try {
        const { execSync: exec } = require('child_process');
        const stdout = exec('node /usr/lib/node_modules/openclaw/openclaw.mjs agents bindings --json 2>/dev/null', { timeout: 10000, encoding: 'utf8' });
        const bindings = JSON.parse(stdout || '[]');
        return { ok: true, data: { status: 200, json: bindings }, success: true };
      } catch (e) {
        return { ok: false, error: { message: String(e) }, success: false };
      }
    }
    // GET /api/channels/accounts → channels.status (transform to UI format)
    if (path === '/api/channels/accounts' && method === 'GET') {
      try {
        // Race WS call against a 5-second timeout. If WS is not ready, fail fast
        // rather than hanging the Channels page. The renderer already has a
        // separate WS connection to the Gateway and calls channels.status directly.
        const raw = await Promise.race([
          gatewayWsClient.invoke('channels.status'),
          new Promise((_, reject) => setTimeout(() => reject(new Error('WS channels timeout')), 5000)),
        ]) as {
          channelOrder?: string[];
          channelLabels?: Record<string, string>;
          channelMeta?: Array<{ id: string; label: string; detailLabel?: string }>;
          channels?: Record<string, { configured?: boolean; running?: boolean; lastError?: string | null }>;
          channelAccounts?: Record<string, Array<{
            accountId: string; enabled?: boolean; configured?: boolean; running?: boolean;
            lastError?: string | null; lastInboundAt?: number | null; lastOutboundAt?: number | null;
          }>>;
          channelDefaultAccountId?: Record<string, string>;
        };

        // Fetch channel->agent bindings for agentId mapping
        let channelAccountOwners: Record<string, string> = {};
        try {
          const { execSync: exec } = require('child_process');
          const bindingsRaw = exec('node /usr/lib/node_modules/openclaw/openclaw.mjs agents bindings --json 2>/dev/null', { timeout: 10000, encoding: 'utf8' });
          const bindings = JSON.parse(bindingsRaw || '[]') as Array<{agentId: string; match?: {channel?: string}; description?: string}>;
          for (const b of bindings) {
            const channel = b.match?.channel || b.description || '';
            if (channel) channelAccountOwners[channel] = b.agentId;
          }
        } catch { /* bindings unavailable */ }

        const channelOrder = raw?.channelOrder || [];
        const channelLabels = raw?.channelLabels || {};
        const channels = raw?.channels || {};
        const channelAccounts = raw?.channelAccounts || {};
        const channelDefaultAccountId = raw?.channelDefaultAccountId || {};

        // Transform gateway response to UI's ChannelGroupItem[] format
        const groups = channelOrder.map((channelType: string) => {
          const info = channels[channelType] || {};
          const accounts = (channelAccounts[channelType] || []).map((acc: {
            accountId: string; enabled?: boolean; configured?: boolean; running?: boolean;
            lastError?: string | null; lastInboundAt?: number | null; lastOutboundAt?: number | null;
          }) => {
            // Look up agentId from channelAccountOwners (key: 'channelType:accountId' or just 'channelType')
            const ownerKey = `${channelType}:${acc.accountId}`;
            const agentId = channelAccountOwners[ownerKey] || channelAccountOwners[channelType] || undefined;
            return {
              accountId: acc.accountId,
              label: channelLabels[channelType] || channelType,
              status: (info.running ? 'connected' : info.configured ? 'disconnected' : 'error') as
                | 'connected' | 'connecting' | 'disconnected' | 'error',
              lastError: acc.lastError || undefined,
              isDefault: acc.accountId === (channelDefaultAccountId[channelType] || 'default'),
              agentId,
            };
          });

          return {
            channelType,
            defaultAccountId: channelDefaultAccountId[channelType] || 'default',
            status: (info.running ? 'connected' : info.configured ? 'disconnected' : 'error') as
              | 'connected' | 'connecting' | 'disconnected' | 'error',
            accounts,
          };
        });

        return { ok: true, success: true, data: { status: 200, json: { success: true, channels: groups } } };
      } catch (e) {
        return { ok: false, error: { message: String(e) }, success: false };
      }
    }
    // ── Channel binding (agent ↔ channel) ──────────────────────────────────────
    // PUT /api/channels/binding → openclaw agents bind
    if (path === '/api/channels/binding' && method === 'PUT') {
      try {
        const { channelType, accountId, agentId } = JSON.parse(request.body || '{}');
        const bindTarget = accountId ? `${channelType}:${accountId}` : channelType;
        const { execSync: exec } = require('child_process');
        exec(`node /usr/lib/node_modules/openclaw/openclaw.mjs agents bind --agent ${agentId} --bind ${bindTarget} --json`, { encoding: 'utf8', timeout: 15000 });
        return { ok: true, data: { status: 200, json: { success: true } }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 500, json: { success: false, error: String(e) } }, success: true };
      }
    }
    // DELETE /api/channels/binding → openclaw agents unbind
    if (path === '/api/channels/binding' && method === 'DELETE') {
      try {
        const { channelType, accountId, agentId } = JSON.parse(request.body || '{}');
        const bindTarget = accountId ? `${channelType}:${accountId}` : channelType;
        const { execSync: exec } = require('child_process');
        exec(`node /usr/lib/node_modules/openclaw/openclaw.mjs agents unbind --agent ${agentId} --bind ${bindTarget} --json`, { encoding: 'utf8', timeout: 15000 });
        return { ok: true, data: { status: 200, json: { success: true } }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 500, json: { success: false, error: String(e) } }, success: true };
      }
    }

    // ── Channel config CRUD ──────────────────────────────────────────────────
    // GET /api/channels/config/:channelType → read from openclaw.json
    const channelConfigMatch = path.match(/^\/api\/channels\/config\/([^?]+)(\?.*)?$/);
    if (channelConfigMatch && method === 'GET') {
      try {
        const channelType = decodeURIComponent(channelConfigMatch[1]);
        const config = readOpenClawConfig();
        const channelData = (config['channels'] as Record<string, unknown>)?.[channelType];
        const values: Record<string, string> = {};
        if (channelData && typeof channelData === 'object') {
          for (const [k, v] of Object.entries(channelData as Record<string, unknown>)) {
            if (typeof v === 'string') values[k] = v;
            else if (typeof v === 'number' || typeof v === 'boolean') values[k] = String(v);
          }
        }
        return { ok: true, data: { status: 200, json: { success: true, values } }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 200, json: { success: false, error: String(e) } }, success: true };
      }
    }
    // POST /api/channels/config → openclaw channels add
    if (path === '/api/channels/config' && method === 'POST') {
      try {
        const { channelType, config, accountId } = JSON.parse(request.body || '{}');
        const { execSync: exec } = require('child_process');
        const tokenArg = config?.token ? `--token ${config.token}` : '';
        const accountArg = accountId ? `--account ${accountId}` : '';
        const cmd = `node /usr/lib/node_modules/openclaw/openclaw.mjs channels add --channel ${channelType} ${tokenArg} ${accountArg} --json`;
        exec(cmd, { encoding: 'utf8', timeout: 15000 });
        return { ok: true, data: { status: 200, json: { success: true } }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 500, json: { success: false, error: String(e) } }, success: true };
      }
    }
    // DELETE /api/channels/config/:channelType → openclaw channels remove
    if (path.startsWith('/api/channels/config/') && method === 'DELETE') {
      try {
        const channelType = decodeURIComponent(path.replace('/api/channels/config/', '').replace(/\?.*$/, ''));
        const accountId = new URLSearchParams(path.split('?')[1] || '').get('accountId');
        const accountArg = accountId ? `--account ${accountId}` : '';
        const { execSync: exec } = require('child_process');
        exec(`node /usr/lib/node_modules/openclaw/openclaw.mjs channels remove --channel ${channelType} ${accountArg} --json`, { encoding: 'utf8', timeout: 15000 });
        return { ok: true, data: { status: 200, json: { success: true } }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 500, json: { success: false, error: String(e) } }, success: true };
      }
    }
    // POST /api/channels/credentials/validate → channels.status probe
    if (path === '/api/channels/credentials/validate' && method === 'POST') {
      try {
        const { channelType, config } = JSON.parse(request.body || '{}');
        const result = await gatewayWsClient.invoke('channels.status', { probe: true });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const channelData = ((result as any)?.channels as Record<string, any>)?.[channelType as string];
        const running = channelData?.running === true;
        const error: string | null = channelData?.lastError || null;
        return { ok: true, data: { status: 200, json: { success: true, valid: !error, errors: error ? [error] : [], warnings: [] } }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 200, json: { success: false, valid: false, errors: [String(e)], warnings: [] } }, success: true };
      }
    }

    // POST /api/channels/:channelType/start → openclaw channels login
    const channelStartMatch = path.match(/^\/api\/channels\/([^\/]+)\/start$/);
    if (channelStartMatch && method === 'POST') {
      try {
        const channelType = decodeURIComponent(channelStartMatch[1]);
        const { accountId } = JSON.parse(request.body || '{}');
        const accountArg = accountId ? `--account ${accountId}` : '';
        await openclawSpawn(['channels', 'login', '--channel', channelType, ...accountArg.split(' ').filter(Boolean)]);
        return { ok: true, data: { status: 200, json: { success: true } }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 200, json: { success: false, error: String(e) } }, success: true };
      }
    }

    // POST /api/channels/:channelType/cancel → openclaw channels logout
    const channelCancelMatch = path.match(/^\/api\/channels\/([^\/]+)\/cancel$/);
    if (channelCancelMatch && method === 'POST') {
      try {
        const channelType = decodeURIComponent(channelCancelMatch[1]);
        const { accountId } = JSON.parse(request.body || '{}');
        const accountArg = accountId ? `--account ${accountId}` : '';
        await openclawSpawn(['channels', 'logout', '--channel', channelType, ...accountArg.split(' ').filter(Boolean)]);
        return { ok: true, data: { status: 200, json: { success: true } }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 200, json: { success: false, error: String(e) } }, success: true };
      }
    }

    // ── Providers OAuth (MiniMax device code flow) ───────────────────────────
    if (path === '/api/providers/oauth/start' && method === 'POST') {
      const { provider: providerId = 'minimax-portal', accountId, label } = JSON.parse(request.body || '{}');

      // Route to the correct OAuth implementation based on provider type
      if (providerId === 'openai') {
        return await handleOpenAIOAuth(providerId, accountId, label);
      }

      if (providerId === 'google') {
        return await handleGoogleOAuth(providerId, accountId, label);
      }

      if (providerId === 'minimax-portal' || providerId === 'minimax-portal-cn') {
        return await handleMiniMaxOAuth(providerId, accountId, label);
      }

      // Other providers don't support OAuth
      return {
        ok: true,
        data: { status: 200, json: { success: false, error: `Provider "${providerId}" does not support OAuth authorization` } },
        success: true,
      };
    }

    if (path === '/api/providers/oauth/submit' && method === 'POST') {
      const { code, provider: providerId, accountId } = JSON.parse(request.body || '{}');

      // Handle OpenAI manual code submission
      if (providerId === 'openai' && pendingOpenAICodes) {
        const { verifier, state: expectedState } = pendingOpenAICodes;
        const parsed = parseOAuthCode(code);
        if (parsed.state && parsed.state !== expectedState) {
          return { ok: true, data: { status: 200, json: { success: false, error: 'State mismatch. Please try again.' } }, success: true };
        }
        const authCode = parsed.code || code.trim();
        if (!authCode) {
          return { ok: true, data: { status: 200, json: { success: false, error: 'No authorization code provided' } }, success: true };
        }
        return await exchangeOpenAIAuthCode(authCode, verifier, providerId, accountId || providerId);
      }

      return { ok: true, data: { status: 200, json: { success: false, error: 'Invalid OAuth submission' } }, success: true };
    }

    if (path === '/api/providers/oauth/cancel' && method === 'POST') {
      // Cancel is handled by the frontend closing the OAuth window
      return { ok: true, data: { status: 200, json: { success: true } }, success: true };
    }

    // ── Agents CRUD ─────────────────────────────────────────────────────────
    // POST /api/agents → agents.create
    if (path === '/api/agents' && method === 'POST') {
      try {
        const { name, inheritWorkspace } = JSON.parse(request.body || '{}');
        const { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, copyFileSync } = require('fs');
        const mainWorkspace = '/home/enbro/.openclaw/workspace';
        const newWorkspace = `/home/enbro/.openclaw/agents/${name.toLowerCase().replace(/\s+/g, '-')}`;
        if (!existsSync(newWorkspace)) {
          mkdirSync(newWorkspace, { recursive: true });
          if (inheritWorkspace && existsSync(mainWorkspace)) {
            try {
              for (const file of readdirSync(mainWorkspace)) {
                if (file.startsWith('.')) continue;
                copyFileSync(`${mainWorkspace}/${file}`, `${newWorkspace}/${file}`);
              }
            } catch {}
            try { mkdirSync(`${newWorkspace}/memory`, { recursive: true }); } catch {}
          }
        }
        const result = await gatewayWsClient.invoke('agents.create', { name, workspace: newWorkspace });
        const snapshot = await buildAgentsSnapshot();
        return { ok: true, data: { status: 200, json: snapshot }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 500, json: { success: false, error: String(e) } }, success: true };
      }
    }
    // PUT /api/agents/:id/model → update agent model in openclaw.json
    const agentModelMatch = path.match(/^\/api\/agents\/([^/]+)\/model$/);
    if (agentModelMatch && method === 'PUT') {
      try {
        const agentId = decodeURIComponent(agentModelMatch[1]);
        const { modelRef } = JSON.parse(request.body || '{}');
        // Read current openclaw.json
        const configPath = '/home/enbro/.openclaw/openclaw.json';
        const { readFileSync, writeFileSync, existsSync } = require('fs');
        if (!existsSync(configPath)) {
          return { ok: true, data: { status: 500, json: { success: false, error: 'Config not found' } }, success: true };
        }
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        const agentList = config?.agents?.list || [];
        const agentIdx = agentList.findIndex((a: Record<string, unknown>) => a.id === agentId);
        if (agentIdx === -1) {
          return { ok: true, data: { status: 404, json: { success: false, error: 'Agent not found' } }, success: true };
        }
        // Update model: if modelRef is null/empty, remove the model field (use defaults)
        if (modelRef) {
          agentList[agentIdx].model = modelRef;
        } else {
          delete agentList[agentIdx].model;
        }
        writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        // Return updated agents list
        const agentsResult = await gatewayWsClient.invoke('agents.list');
        return { ok: true, data: { status: 200, json: agentsResult }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 500, json: { success: false, error: String(e) } }, success: true };
      }
    }
    // PUT /api/agents/:id → agents.update
    const agentsIdMatch = path.match(/^\/api\/agents\/([^/]+)$/);
    if (agentsIdMatch && method === 'PUT') {
      try {
        const agentId = decodeURIComponent(agentsIdMatch[1]);
        const { name } = JSON.parse(request.body || '{}');
        const result = await gatewayWsClient.invoke('agents.update', { agentId, name });
        const snapshot = await buildAgentsSnapshot();
        return { ok: true, data: { status: 200, json: snapshot }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 500, json: { success: false, error: String(e) } }, success: true };
      }
    }
    // DELETE /api/agents/:id → agents.delete
    if (agentsIdMatch && method === 'DELETE') {
      try {
        const agentId = decodeURIComponent(agentsIdMatch[1]);
        const result = await gatewayWsClient.invoke('agents.delete', { agentId });
        const snapshot = await buildAgentsSnapshot();
        return { ok: true, data: { status: 200, json: snapshot }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 500, json: { success: false, error: String(e) } }, success: true };
      }
    }
    // PUT /api/agents/:id/channels/:channelType → agents bind
    const agentChannelMatch = path.match(/^\/api\/agents\/([^/]+)\/channels\/([^/]+)$/);
    if (agentChannelMatch && method === 'PUT') {
      try {
        const agentId = decodeURIComponent(agentChannelMatch[1]);
        const channelType = decodeURIComponent(agentChannelMatch[2]);
        const { execSync: exec } = require('child_process');
        exec(`node /usr/lib/node_modules/openclaw/openclaw.mjs agents bind --agent ${agentId} --bind ${channelType} --json`, { encoding: 'utf8', timeout: 15000 });
        const snapshot = await buildAgentsSnapshot();
        return { ok: true, data: { status: 200, json: snapshot }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 500, json: { success: false, error: String(e) } }, success: true };
      }
    }
    // DELETE /api/agents/:id/channels/:channelType → agents unbind
    if (agentChannelMatch && method === 'DELETE') {
      try {
        const agentId = decodeURIComponent(agentChannelMatch[1]);
        const channelType = decodeURIComponent(agentChannelMatch[2]);
        const { execSync: exec } = require('child_process');
        exec(`node /usr/lib/node_modules/openclaw/openclaw.mjs agents unbind --agent ${agentId} --bind ${channelType} --json`, { encoding: 'utf8', timeout: 15000 });
        const snapshot = await buildAgentsSnapshot();
        return { ok: true, data: { status: 200, json: snapshot }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 500, json: { success: false, error: String(e) } }, success: true };
      }
    }

    // ── Cron jobs ────────────────────────────────────────────────────────────
    // POST /api/cron/jobs → cron.add
    if (path === '/api/cron/jobs' && method === 'POST') {
      try {
        const jobInput = JSON.parse(request.body || '{}');
        // Build cron.add params from CronJobCreateInput
        const job: Record<string, unknown> = {
          name: jobInput.name,
          schedule: jobInput.schedule,
          payload: jobInput.payload,
          enabled: jobInput.enabled !== false,
        };
        if (jobInput.delivery) job.delivery = jobInput.delivery;
        if (jobInput.description) job.description = jobInput.description;
        if (jobInput.timeoutSeconds) job.timeoutSeconds = jobInput.timeoutSeconds;
        const result = await gatewayWsClient.invoke('cron.add', { job }) as Record<string, unknown>;
        // Transform the created job to UI format
        const state = result?.['state'] as Record<string, unknown> | undefined;
        const transformed = {
          id: result?.['id'],
          name: result?.['name'],
          enabled: result?.['enabled'],
          createdAt: result?.['createdAtMs'] ? new Date(Number(result['createdAtMs'])).toISOString() : new Date().toISOString(),
          updatedAt: result?.['updatedAtMs'] ? new Date(Number(result['updatedAtMs'])).toISOString() : new Date().toISOString(),
          schedule: result?.['schedule'],
          message: (result?.['payload'] as Record<string, unknown>)?.['message'] || '',
          delivery: result?.['delivery'],
          sessionTarget: result?.['sessionTarget'],
          wakeMode: result?.['wakeMode'],
          lastRun: state?.['lastRunMs']
            ? { time: new Date(Number(state['lastRunMs'])).toISOString(), success: !state['lastError'], error: state['lastError'] || undefined }
            : undefined,
          nextRun: state?.['nextRunMs'] ? new Date(Number(state['nextRunMs'])).toISOString() : undefined,
        };
        return { ok: true, data: { status: 200, json: transformed }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 500, json: { success: false, error: String(e) } }, success: true };
      }
    }
    // PUT /api/cron/jobs/:id → cron.update
    const cronJobMatch = path.match(/^\/api\/cron\/jobs\/([^/]+)$/);
    if (cronJobMatch && method === 'PUT') {
      try {
        const jobId = decodeURIComponent(cronJobMatch[1]);
        const patch = JSON.parse(request.body || '{}');
        const result = await gatewayWsClient.invoke('cron.update', { id: jobId, patch });
        return { ok: true, data: { status: 200, json: result }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 500, json: { success: false, error: String(e) } }, success: true };
      }
    }
    // DELETE /api/cron/jobs/:id → cron.remove
    if (cronJobMatch && method === 'DELETE') {
      try {
        const jobId = decodeURIComponent(cronJobMatch[1]);
        const result = await gatewayWsClient.invoke('cron.remove', { id: jobId });
        return { ok: true, data: { status: 200, json: result }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 500, json: { success: false, error: String(e) } }, success: true };
      }
    }
    // POST /api/cron/toggle → cron.enable/disable
    if (path === '/api/cron/toggle' && method === 'POST') {
      try {
        const { id, enabled } = JSON.parse(request.body || '{}');
        const result = await gatewayWsClient.invoke('cron.update', { id, patch: { enabled } });
        return { ok: true, data: { status: 200, json: { success: true, result } }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 500, json: { success: false, error: String(e) } }, success: true };
      }
    }
    // POST /api/cron/trigger → cron.run
    if (path === '/api/cron/trigger' && method === 'POST') {
      try {
        const { id } = JSON.parse(request.body || '{}');
        const result = await gatewayWsClient.invoke('cron.run', { id });
        return { ok: true, data: { status: 200, json: { success: true, result } }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 500, json: { success: false, error: String(e) } }, success: true };
      }
    }

    // GET /api/cron/jobs → cron.list
    if (path === '/api/cron/jobs' && method === 'GET') {
      try {
        const result = await gatewayWsClient.invoke('cron.list') as { jobs?: Array<Record<string, unknown>> };
        const rawJobs = result?.jobs || [];
        // Transform gateway CronJob format to UI CronJob format
        const jobs = rawJobs.map((j) => {
          const state = j['state'] as Record<string, unknown> | undefined;
          return {
            id: j['id'],
            name: j['name'],
            enabled: j['enabled'],
            createdAt: new Date(Number(j['createdAtMs'])).toISOString(),
            updatedAt: new Date(Number(j['updatedAtMs'])).toISOString(),
            schedule: j['schedule'],
            message: (j['payload'] as Record<string, unknown>)?.['message'] || '',
            delivery: j['delivery'],
            sessionTarget: j['sessionTarget'],
            wakeMode: j['wakeMode'],
            lastRun: state?.['lastRunMs']
              ? { time: new Date(Number(state['lastRunMs'])).toISOString(), success: !state['lastError'], error: state['lastError'] || undefined }
              : undefined,
            nextRun: state?.['nextRunMs'] ? new Date(Number(state['nextRunMs'])).toISOString() : undefined,
          };
        });
        return { ok: true, data: { status: 200, json: jobs }, success: true };
      } catch (e) {
        return { ok: false, error: { message: String(e) }, success: false };
      }
    }
    // GET /api/usage/recent-token-history → usage.cost
    if (path === '/api/usage/recent-token-history' && method === 'GET') {
      try {
        const result = await gatewayWsClient.invoke('usage.cost', { days: 7 });
        return { ok: true, data: { status: 200, json: result }, success: true };
      } catch (e) {
        return { ok: false, error: { message: String(e) }, success: false };
      }
    }
    // GET /api/settings → return persisted Orion settings
    if (path === '/api/settings' && method === 'GET') {
      const persisted = readOrionSettings();
      return {
        ok: true,
        data: {
          status: 200,
          json: {
            theme: 'system',
            language: 'zh',
            startMinimized: false,
            launchAtStartup: false,
            telemetryEnabled: true,
            gatewayAutoStart: false,
            gatewayPort: 18789,
            proxyEnabled: false,
            proxyServer: '',
            proxyHttpServer: '',
            proxyHttpsServer: '',
            proxyAllServer: '',
            proxyBypassRules: '<local>;localhost;127.0.0.1;::1',
            updateChannel: 'stable',
            autoCheckUpdate: true,
            autoDownloadUpdate: false,
            sidebarCollapsed: false,
            devModeUnlocked: false,
            setupComplete: false,
            ...persisted,
          },
        },
        success: true,
      };
    }

    // PUT /api/settings/<key> → persist to JSON file
    if (path.startsWith('/api/settings/') && method === 'PUT') {
      try {
        const key = path.replace('/api/settings/', '');
        const body = JSON.parse(request.body as string || '{}');
        const current = readOrionSettings();
        current[key] = body.value;
        writeOrionSettings(current);
      } catch {}
      return { ok: true, data: { status: 200, json: { ok: true } }, success: true };
    }

    // POST /api/files/thumbnails → proxy to gateway RPC
    if (path === '/api/files/thumbnails' && method === 'POST') {
      try {
        const body = JSON.parse(request.body as string || '{}');
        const result = await gatewayWsClient.invoke('files.thumbnails', body);
        return { ok: true, data: { status: 200, json: result }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 500, json: { error: String(e) } }, success: true };
      }
    }

    // GET /api/logs → return gateway logs
    if (path === '/api/logs' && method === 'GET') {
      try {
        const logResult = await openclawJson(['logs', '--json', '--lines', '100']);
        return { ok: true, data: { status: 200, json: { content: JSON.stringify(logResult) } }, success: true };
      } catch {
        return { ok: true, data: { status: 200, json: { content: '(Failed to load logs)' } }, success: true };
      }
    }

    // GET /api/logs/dir → return log directory
    if (path === '/api/logs/dir' && method === 'GET') {
      try {
        const openclawDir = await openclawJson(['dir', '--json']);
        const logDir = (openclawDir as Record<string, string>)?.logs || '/tmp';
        return { ok: true, data: { status: 200, json: { dir: logDir } }, success: true };
      } catch {
        return { ok: true, data: { status: 200, json: { dir: '/tmp' } }, success: true };
      }
    }

    // GET /api/sessions/transcript → return session transcript messages
    if (path.startsWith('/api/sessions/transcript') && method === 'GET') {
      const url = new URL(`http://localhost${path}`);
      const agentId = url.searchParams.get('agentId')?.trim() || '';
      const sessionId = url.searchParams.get('sessionId')?.trim() || '';
      if (!agentId || !sessionId) {
        return { ok: false, error: { message: 'agentId and sessionId are required' }, success: false };
      }
      try {
        const openclawDir = await openclawJson(['dir', '--json']);
        const configDir = (openclawDir as Record<string, string>)?.config || join(homedir(), '.openclaw');
        const transcriptPath = join(configDir, 'agents', agentId, 'sessions', `${sessionId}.jsonl`);
        const fsPromises = await import('node:fs/promises');
        const raw = await fsPromises.readFile(transcriptPath, 'utf8');
        const lines = raw.split(/\r?\n/).filter(Boolean);
        const messages = lines.flatMap((line) => {
          try {
            const entry = JSON.parse(line) as { type?: string; message?: unknown };
            return entry.type === 'message' && entry.message ? [entry.message] : [];
          } catch {
            return [];
          }
        });
        return { ok: true, data: { status: 200, json: { success: true, messages } }, success: true };
      } catch (e) {
        if (String(e).includes('ENOENT')) {
          return { ok: true, data: { status: 404, json: { success: false, error: 'Transcript not found' } }, success: true };
        }
        return { ok: false, error: { message: String(e) }, success: false };
      }
    }

    // ── ClawHub / Skills marketplace ───────────────────────────────────────────
    // GET /api/clawhub/list → skills.catalog (already handled above, deduplicated)
    // POST /api/clawhub/search → openclaw skills search --json
    if (path === '/api/clawhub/search' && method === 'POST') {
      try {
        const { query } = JSON.parse(request.body || '{}');
        const args = ['skills', 'search', ...(query ? [query] : []), '--json', '--limit', '20'];
        const output = await openclawSpawn(args);
        let results = [];
        try { results = JSON.parse(output); } catch { results = []; }
        return { ok: true, data: { status: 200, json: { success: true, results } }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 200, json: { success: false, error: String(e), results: [] } }, success: true };
      }
    }
    // POST /api/clawhub/install → openclaw skills install <slug>
    if (path === '/api/clawhub/install' && method === 'POST') {
      try {
        const { slug, version, force } = JSON.parse(request.body || '{}');
        const args = ['skills', 'install', slug];
        if (version) args.push('--version', version);
        if (force) args.push('--force');
        const output = await openclawSpawn(args);
        return { ok: true, data: { status: 200, json: { success: true, output } }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 200, json: { success: false, error: String(e) } }, success: true };
      }
    }
    // POST /api/clawhub/uninstall → remove skill folder from workspace
    if (path === '/api/clawhub/uninstall' && method === 'POST') {
      try {
        const { slug } = JSON.parse(request.body || '{}');
        if (!slug) return { ok: true, data: { status: 400, json: { success: false, error: 'slug required' } }, success: true };
        const { execSync: exec } = require('child_process');
        const openclawDir = await openclawJson(['dir', '--json']) as Record<string, string>;
        const workspace = openclawDir?.workspace || join(homedir(), '.openclaw', 'workspace');
        const skillPath = join(workspace, 'skills', slug);
        if (existsSync(skillPath)) {
          exec(`rm -rf "${skillPath}"`);
        }
        return { ok: true, data: { status: 200, json: { success: true } }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 200, json: { success: false, error: String(e) } }, success: true };
      }
    }

    // ── App / Gateway info ────────────────────────────────────────────────────
    // GET /api/app/gateway-info → return gateway URL, token, port
    if (path === '/api/app/gateway-info' && method === 'GET') {
      return {
        ok: true,
        data: {
          status: 200,
          json: { success: true, url: 'http://127.0.0.1:18789', token: '89064df8b54ad85a7f1728be9417a13eee25de73121a9b15', port: 18789 },
        },
        success: true,
      };
    }
    // POST /api/app/openclaw-doctor → openclaw doctor --diagnose/--fix
    if (path === '/api/app/openclaw-doctor' && method === 'POST') {
      return new Promise((resolve) => {
        try {
          const { mode } = JSON.parse(request.body || '{}');
          const args = mode === 'fix' ? ['doctor', '--fix'] : ['doctor', '--diagnose'];
          const startTime = Date.now();
          const child = spawn('openclaw', args, { shell: true });
          let stdout = '', stderr = '';
          child.stdout.on('data', (d) => { stdout += d.toString(); });
          child.stderr.on('data', (d) => { stderr += d.toString(); });
          child.on('close', (code) => {
            resolve({
              ok: true,
              data: {
                status: 200,
                json: {
                  mode,
                  success: code === 0,
                  exitCode: code,
                  stdout,
                  stderr,
                  command: `openclaw ${args.join(' ')}`,
                  cwd: homedir(),
                  durationMs: Date.now() - startTime,
                },
              },
              success: true,
            });
          });
          child.on('error', (e) => {
            resolve({
              ok: true,
              data: {
                status: 200,
                json: { mode, success: false, exitCode: null, stdout: '', stderr: String(e), command: `openclaw ${args.join(' ')}`, cwd: homedir(), durationMs: Date.now() - startTime, error: String(e) },
              },
              success: true,
            });
          });
        } catch (e) {
          resolve({ ok: true, data: { status: 500, json: { mode: 'diagnose', success: false, exitCode: null, stdout: '', stderr: String(e), error: String(e) } }, success: true });
        }
      });
    }

    // ── Sessions ───────────────────────────────────────────────────────────────
    // POST /api/sessions/delete → gateway RPC sessions.delete
    if (path === '/api/sessions/delete' && method === 'POST') {
      try {
        const { sessionKey } = JSON.parse(request.body || '{}');
        await gatewayWsClient.invoke('sessions.delete', { sessionKey });
        return { ok: true, data: { status: 200, json: { success: true } }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 200, json: { success: false, error: String(e) } }, success: true };
      }
    }

    // ── Chat with media ────────────────────────────────────────────────────────
    // POST /api/chat/send-with-media → stage files + gateway RPC chat.send
    if (path === '/api/chat/send-with-media' && method === 'POST') {
      try {
        const { sessionKey, message, deliver, idempotencyKey, media } = JSON.parse(request.body || '{}');
        // Stage each media file and get paths
        const stagedMedia = [];
        for (const m of (media || [])) {
          const { filePath, mimeType, fileName } = m;
          if (!filePath) continue;
          // Copy to gateway's staging dir if it's a local path
          let stagedPath = filePath;
          try {
            const { basename, extname } = require('path') as typeof import('path');
            const tmpDir = '/tmp/orion-media';
            require('fs').mkdirSync(tmpDir, { recursive: true });
            const destPath = join(tmpDir, `${Date.now()}-${basename(filePath)}`);
            require('fs').copyFileSync(filePath, destPath);
            stagedPath = destPath;
          } catch { /* use original path */ }
          stagedMedia.push({ filePath: stagedPath, mimeType, fileName });
        }
        // Call chat.send with media attachments
        const result = await gatewayWsClient.invoke('chat.send', {
          sessionKey,
          message,
          deliver: deliver !== false,
          idempotencyKey,
          attachments: stagedMedia.map(m => ({ path: m.filePath, mimeType: m.mimeType, name: m.fileName })),
        });
        return { ok: true, data: { status: 200, json: { success: true, result } }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 200, json: { success: false, error: String(e) } }, success: true };
      }
    }

    // ── File staging ───────────────────────────────────────────────────────────
    // POST /api/files/stage-paths → copy local files to temp, return staged info
    if (path === '/api/files/stage-paths' && method === 'POST') {
      try {
        const { filePaths } = JSON.parse(request.body || '{}');
        const { basename } = require('path') as typeof import('path');
        const { mkdirSync, copyFileSync, readdirSync } = require('fs');
        const tmpDir = '/tmp/orion-media';
        mkdirSync(tmpDir, { recursive: true });
        const results = [] as Array<{ id: string; fileName: string; mimeType: string; fileSize: number; stagedPath: string; preview: string | null }>;
        for (const filePath of (filePaths || [])) {
          try {
            const fileName = basename(filePath);
            const destPath = join(tmpDir, `${Date.now()}-${Math.random().toString(36).slice(2)}-${fileName}`);
            copyFileSync(filePath, destPath);
            const stat = require('fs').statSync(destPath);
            results.push({
              id: `staged-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              fileName,
              mimeType: getMimeType(fileName),
              fileSize: stat.size,
              stagedPath: destPath,
              preview: null,
            });
          } catch { /* skip failed files */ }
        }
        return { ok: true, data: { status: 200, json: results }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 200, json: { success: false, error: String(e) } }, success: true };
      }
    }
    // POST /api/files/stage-buffer → decode base64, write to temp, return staged info
    if (path === '/api/files/stage-buffer' && method === 'POST') {
      try {
        const { base64, fileName, mimeType } = JSON.parse(request.body || '{}');
        const { mkdirSync, writeFileSync } = require('fs');
        const tmpDir = '/tmp/orion-media';
        mkdirSync(tmpDir, { recursive: true });
        const buf = Buffer.from(base64 || '', 'base64');
        const ext = mimeType ? `.${mimeType.split('/')[1]}` : '';
        const destPath = join(tmpDir, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
        writeFileSync(destPath, buf);
        const result = {
          id: `staged-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          fileName: fileName || 'upload',
          mimeType: mimeType || 'application/octet-stream',
          fileSize: buf.length,
          stagedPath: destPath,
          preview: null as string | null,
        };
        return { ok: true, data: { status: 200, json: result }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 200, json: { success: false, error: String(e) } }, success: true };
      }
    }

    // ── Cron session history ──────────────────────────────────────────────────
    // GET /api/cron/session-history → return JSONL session history as messages
    if (path.startsWith('/api/cron/session-history') && method === 'GET') {
      const url = new URL(`http://localhost${path}`);
      const sessionKey = url.searchParams.get('sessionKey') || '';
      const limit = parseInt(url.searchParams.get('limit') || '200', 10);
      try {
        const cronRunsDir = '/home/enbro/.openclaw/cron/runs';
        const entries = (require('fs') as typeof import('fs')).readdirSync(cronRunsDir).filter(f => f.endsWith('.jsonl')).slice(-10);
        const messages = [];
        for (const entry of entries.slice(-1)) {
          const lines = (require('fs') as typeof import('fs')).readFileSync(join(cronRunsDir, entry), 'utf8').split(/\r?\n/).filter(Boolean).slice(-limit);
          for (const line of lines) {
            try {
              const entry_1 = JSON.parse(line) as { type?: string; message?: unknown };
              if (entry_1.type === 'message' && entry_1.message) messages.push(entry_1.message);
            } catch {}
          }
        }
        return { ok: true, data: { status: 200, json: { messages } }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 200, json: { messages: [] } }, success: true };
      }
    }

    // ── Provider default account ───────────────────────────────────────────────
    // PUT /api/provider-accounts/default → save default provider account
    if (path === '/api/provider-accounts/default' && method === 'PUT') {
      try {
        const { accountId } = JSON.parse(request.body || '{}');
        const current = readOrionSettings();
        current.defaultProviderAccountId = accountId;
        writeOrionSettings(current);
        return { ok: true, data: { status: 200, json: { success: true } }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 200, json: { success: false, error: String(e) } }, success: true };
      }
    }

    // ── Provider validation ───────────────────────────────────────────────────
    // POST /api/providers/validate → validate provider credentials via gateway RPC
    if (path === '/api/providers/validate' && method === 'POST') {
      try {
        const { vendorId, apiKey, baseUrl } = JSON.parse(request.body || '{}');
        // Try a simple models.list call to validate the credentials
        const testResult = await gatewayWsClient.invoke('models.list', { provider: vendorId });
        return { ok: true, data: { status: 200, json: { success: true, valid: true, models: testResult } }, success: true };
      } catch (e) {
        return { ok: true, data: { status: 200, json: { success: false, valid: false, errors: [String(e)] } }, success: true };
      }
    }

    // Generic: try openclaw <path-segment> status --json
    const match = path.match(/^\/api\/([^\/]+)\/status$/);
    if (match && method === 'GET') {
      const result = await openclawJson(['status', '--json']);
      return { ok: true, data: { status: 200, json: result } };
    }

    // Not handled
    return { ok: false, error: { message: `Unknown path: ${path}` }, success: false };
  } catch (err) {
    log(`hostapi:fetch error: ${err}`);
    return { ok: false, error: { message: String(err) }, success: false };
  }
});

ipcMain.handle('hostapi:token', () => {
  // Return the gateway auth token for API calls
  return '89064df8b54ad85a7f1728be9417a13eee25de73121a9b15';
});

async function gatewayStatus(): Promise<{ ok: boolean; data?: unknown; error?: unknown; success: boolean }> {
  // Fast path: use HTTP /health endpoint instead of spawning openclaw CLI
  return new Promise((resolve) => {
    const http = require('http') as typeof import('http');
    const req = http.request(
      { host: '127.0.0.1', port: 18789, path: '/health', method: 'GET', timeout: 3000 },
      (res: import('http').IncomingMessage) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(data);
              resolve({ ok: true, data: { status: 200, json: { state: 'running', port: 18789, health: parsed } }, success: true });
            } catch {
              resolve({ ok: true, data: { status: 200, json: { state: 'running', port: 18789 } }, success: true });
            }
          } else {
            resolve({ ok: true, data: { status: res.statusCode || 503, json: { state: 'stopped' } }, success: false });
          }
        });
      },
    );
    req.on('error', () => resolve({ ok: true, data: { status: 503, json: { state: 'stopped' } }, success: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: true, data: { status: 503, json: { state: 'stopped' } }, success: false }); });
    req.end();
  });
}

async function gatewayStart(): Promise<{ ok: boolean; success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn('openclaw', ['gateway', 'start'], { shell: true });
    child.on('close', (code) => resolve({ ok: true, success: code === 0, error: code !== 0 ? 'Failed to start' : undefined }));
    child.on('error', () => resolve({ ok: true, success: false, error: 'IPC error' }));
  });
}

async function gatewayStop(): Promise<{ ok: boolean; success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn('openclaw', ['gateway', 'stop'], { shell: true });
    child.on('close', (code) => resolve({ ok: true, success: code === 0, error: code !== 0 ? 'Failed to stop' : undefined }));
    child.on('error', () => resolve({ ok: true, success: false, error: 'IPC error' }));
  });
}

async function gatewayRestart(): Promise<{ ok: boolean; success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn('openclaw', ['gateway', 'restart'], { shell: true });
    child.on('close', (code) => resolve({ ok: true, success: code === 0, error: code !== 0 ? 'Failed to restart' : undefined }));
    child.on('error', () => resolve({ ok: true, success: false, error: 'IPC error' }));
  });
}

async function gatewayHealth(): Promise<{ ok: boolean; data?: unknown; success: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('openclaw', ['gateway', 'health'], { shell: true });
    let output = '';
    child.stdout.on('data', (data) => { output += data.toString(); });
    child.on('close', (code) => {
      if (code === 0) {
        try {
          resolve({ ok: true, data: { status: 200, json: JSON.parse(output) }, success: true });
        } catch {
          resolve({ ok: true, data: { status: 200, json: {} }, success: true });
        }
      } else {
        resolve({ ok: true, data: { status: 503, json: { error: 'not healthy' } }, success: false });
      }
    });
    child.on('error', () => resolve({ ok: true, data: { status: 503, json: { error: 'IPC error' } }, success: false }));
  });
}

async function gatewayVersion(): Promise<{ ok: boolean; data?: unknown; success: boolean }> {
  // Try HTTP first (fast path)
  return new Promise((resolve) => {
    const http = require('http') as typeof import('http');
    const req = http.request(
      { host: '127.0.0.1', port: 18789, path: '/health', method: 'GET', timeout: 3000 },
      (res: import('http').IncomingMessage) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(data);
              resolve({ ok: true, data: { status: 200, json: { version: parsed.version || parsed.tag || '' } }, success: true });
            } catch {
              resolve({ ok: true, data: { status: 200, json: { version: '' } }, success: true });
            }
          } else {
            // Fall back to CLI
            resolve({ ok: false, data: { status: res.statusCode || 503 }, success: false });
          }
        });
      },
    );
    req.on('error', () => resolve({ ok: true, data: { status: 503, json: { version: '' } }, success: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: true, data: { status: 503, json: { version: '' } }, success: false }); });
    req.end();
  });
}

async function gatewayLogs(path: string): Promise<{ ok: boolean; data?: unknown; error?: unknown; success: boolean }> {
  // Parse tailLines from path like /api/logs?tailLines=100
  const url = new URL(`http://localhost${path}`);
  const tailLines = url.searchParams.get('tailLines') || '100';

  return new Promise((resolve) => {
    // Try openclaw logs command
    const child = spawn('openclaw', ['logs', `--tail=${tailLines}`, '--json'], { shell: true });
    let output = '';
    child.stdout.on('data', (data) => { output += data.toString(); });
    child.on('close', (code) => {
      resolve({ ok: true, data: { status: 200, text: output }, success: true });
    });
    child.on('error', () => resolve({ ok: true, data: { status: 200, text: '(no logs available)' }, success: true }));
  });
}

async function openclawJson(args: string[]): Promise<unknown> {
  return new Promise((resolve) => {
    const child = spawn('openclaw', args, { shell: true });
    let output = '';
    child.stdout.on('data', (data) => { output += data.toString(); });
    child.on('close', (code) => {
      if (code === 0) {
        try { resolve(JSON.parse(output)); }
        catch { resolve({}); }
      } else {
        resolve({});
      }
    });
    child.on('error', () => resolve({}));
  });
}

async function openclawSpawn(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('openclaw', args, { shell: true });
    let output = '';
    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { output += data.toString(); });
    child.on('close', () => { resolve(output); });
    child.on('error', () => resolve(''));
  });
}
// Cache bindings CLI result for 30s to avoid 6-second startup penalty on every call
let _bindingsCache: { owners: Record<string, string>; expiresAt: number } | null = null;


// Shared helper: build AgentsSnapshot from gateway + CLI data
async function buildAgentsSnapshot(): Promise<Record<string, unknown>> {
  const { execSync: exec } = require('child_process');
  const result = await gatewayWsClient.invoke('agents.list') as {
    defaultId?: string; mainKey?: string; scope?: string;
    agents?: Array<{id?: string; name?: string; workspace?: string; model?: {primary?: string; [key:string]: unknown}; [key:string]: unknown}>;
  };
  // Fetch bindings from CLI (cached for 30s to avoid 6s CLI startup penalty)
  let channelOwners: Record<string, string> = {};
  const now = Date.now();
  if (_bindingsCache && _bindingsCache.expiresAt > now) {
    channelOwners = _bindingsCache.owners;
  } else {
    try {
      const bindingsRaw = exec('node /usr/lib/node_modules/openclaw/openclaw.mjs agents bindings --json 2>/dev/null', { timeout: 10000, encoding: 'utf8' });
      const bindings = JSON.parse(bindingsRaw || '[]') as Array<{agentId: string; match?: {channel?: string}; description?: string}>;
      for (const b of bindings) {
        const channel = b.match?.channel || b.description || '';
        if (channel) channelOwners[channel] = b.agentId;
      }
      _bindingsCache = { owners: channelOwners, expiresAt: now + 600000 };
    } catch {
      _bindingsCache = { owners: {}, expiresAt: now + 600000 };
    }
  }
  // Fetch channel status for configured types + account owners
  let configuredChannelTypes: string[] = [];
  let channelAccountOwners: Record<string, string> = {};
  try {
    const chanResult = await gatewayWsClient.invoke('channels.status') as {
      channelOrder?: string[]; channels?: Record<string, {configured?: boolean; accountId?: string}>;
    };
    configuredChannelTypes = chanResult?.channelOrder || [];
    for (const [ct, info] of Object.entries(chanResult?.channels || {})) {
      if (info?.accountId) channelAccountOwners[`${ct}:${info.accountId}`] = '';
    }
  } catch {}
  // Transform gateway agents to AgentSummary format
  const agents = (result?.agents || []).map((a) => {
    const primaryModel = a.model?.primary || '';
    const agentChannels = Object.entries(channelOwners).filter(([, agId]) => agId === a.id).map(([ch]) => ch);
    return {
      id: a.id || '', name: a.name || '',
      isDefault: a.id === result?.defaultId,
      modelDisplay: primaryModel.split('/').pop() || primaryModel || '-',
      modelRef: primaryModel || null,
      overrideModelRef: null,
      inheritedModel: false,
      workspace: a.workspace || '',
      agentDir: '', mainSessionKey: '',
      channelTypes: agentChannels,
    };
  });
  return {
    agents,
    defaultAgentId: result?.defaultId || 'main',
    defaultModelRef: agents[0]?.modelRef || null,
    configuredChannelTypes,
    channelOwners,
    channelAccountOwners,
  };
}

function getMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
    mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo', webm: 'video/webm',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
    pdf: 'application/pdf', zip: 'application/zip', tar: 'application/x-tar',
    gz: 'application/gzip', json: 'application/json', xml: 'application/xml',
    html: 'text/html', htm: 'text/html', txt: 'text/plain', css: 'text/css',
    js: 'application/javascript', ts: 'text/typescript', py: 'text/python',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return map[ext] || 'application/octet-stream';
}

// ==================== Provider API Helpers ====================

const OPENCLAW_CONFIG_PATH = '/home/enbro/.openclaw/openclaw.json';

function readOpenClawConfig(): Record<string, unknown> {
  try {
    const { readFileSync } = require('fs') as typeof import('fs');
    const content = readFileSync(OPENCLAW_CONFIG_PATH, 'utf8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

// Map openclaw provider names to UI provider types
function resolveProviderType(openclawProvider: string): string {
  const map: Record<string, string> = {
    'minimax': 'minimax-portal-cn',
    'anthropic': 'anthropic',
    'openai': 'openai',
    'google': 'google',
    'openrouter': 'openrouter',
    'ark': 'ark',
    'moonshot': 'moonshot',
    'siliconflow': 'siliconflow',
    'ollama': 'ollama',
  };
  return map[openclawProvider] || openclawProvider;
}

async function getProviderAccounts(): Promise<Record<string, unknown>[]> {
  const config = readOpenClawConfig();
  const { existsSync, readFileSync } = require('fs');

  // Read from agent's models.json and auth-profiles.json (not openclaw.json)
  const agentModelsPath = '/home/enbro/.openclaw/agents/main/agent/models.json';
  const authProfilesPath = '/home/enbro/.openclaw/agents/main/agent/auth-profiles.json';

  let modelsConfig: Record<string, unknown> = {};
  if (existsSync(agentModelsPath)) {
    try {
      modelsConfig = JSON.parse(readFileSync(agentModelsPath, 'utf8'));
    } catch {}
  }

  let authData: Record<string, unknown> = { profiles: {} };
  if (existsSync(authProfilesPath)) {
    try {
      authData = JSON.parse(readFileSync(authProfilesPath, 'utf8'));
    } catch {}
  }

  const providers = (modelsConfig['providers'] as Record<string, unknown>) || {};
  const profiles = (authData['profiles'] as Record<string, Record<string, unknown>>) || {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agentsDefaults = (config['agents'] as any)?.defaults || {};
  const defaultModel = (agentsDefaults['model'] as Record<string, unknown>) || {};
  const primaryModel = (defaultModel?.primary as string) || '';

  const accounts: Record<string, unknown>[] = [];
  const addedVendors = new Set<string>();

  // Check each provider in openclaw config
  for (const [providerName, providerData] of Object.entries(providers)) {
    const pData = providerData as Record<string, unknown>;
    const models = (pData['models'] as Record<string, unknown>[]) || [];
    const baseUrl = pData['baseUrl'] as string || '';

    // Find the default model for this provider
    const defaultModelForProvider = primaryModel.startsWith(providerName + '/')
      ? primaryModel.split('/')[1]
      : null;

    // Find auth profile for this provider
    for (const [profileId, profileData] of Object.entries(profiles)) {
      const pf = profileData as Record<string, unknown>;
      if (pf['provider'] === providerName) {
        const isDefault = primaryModel.startsWith(providerName + '/');
        accounts.push({
          id: profileId,
          vendorId: resolveProviderType(providerName),
          label: `${providerName}${pf['region'] ? ' (' + pf['region'] + ')' : ''}`,
          authMode: pf['mode'] || 'api_key',
          baseUrl,
          model: defaultModelForProvider || (models[0] as Record<string, unknown>)?.['id'] || '',
          enabled: true,
          isDefault,
          hasKey: true, // auth profile exists = API key is configured
          metadata: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        addedVendors.add(providerName);
      }
    }

    // If no auth profile but provider exists, add a generic account
    if (!addedVendors.has(providerName) && models.length > 0) {
      const profileId = providerName;
      accounts.push({
        id: profileId,
        vendorId: resolveProviderType(providerName),
        label: providerName,
        authMode: 'api_key',
        baseUrl,
        model: defaultModelForProvider || (models[0] as Record<string, unknown>)?.['id'] || '',
        enabled: true,
        isDefault: primaryModel.startsWith(providerName + '/'),
        hasKey: !!(pData['apiKey']),
        metadata: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
  }

  return accounts;
}

async function getDefaultProviderAccountId(): Promise<string | null> {
  const config = readOpenClawConfig();
  const { existsSync, readFileSync } = require('fs');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agentsDefaults = (config['agents'] as any)?.defaults || {};
  const defaultModel = (agentsDefaults['model'] as Record<string, unknown>) || {};
  const primaryModel = (defaultModel?.primary as string) || '';

  if (!primaryModel) return null;

  const [providerName] = primaryModel.split('/');

  // Read from agent's auth-profiles.json
  const authProfilesPath = '/home/enbro/.openclaw/agents/main/agent/auth-profiles.json';
  let profiles: Record<string, Record<string, unknown>> = {};
  if (existsSync(authProfilesPath)) {
    try {
      const authData = JSON.parse(readFileSync(authProfilesPath, 'utf8'));
      profiles = (authData['profiles'] as Record<string, Record<string, unknown>>) || {};
    } catch {}
  }

  for (const [profileId, profileData] of Object.entries(profiles)) {
    const pf = profileData as Record<string, unknown>;
    if (pf['provider'] === providerName) {
      return profileId;
    }
  }
  return providerName; // fallback to provider name as account id
}

async function getProviders(): Promise<Record<string, unknown>[]> {
  const config = readOpenClawConfig();
  const { existsSync, readFileSync } = require('fs');

  // Read from agent's models.json
  const agentModelsPath = '/home/enbro/.openclaw/agents/main/agent/models.json';
  let modelsConfig: Record<string, unknown> = {};
  if (existsSync(agentModelsPath)) {
    try {
      modelsConfig = JSON.parse(readFileSync(agentModelsPath, 'utf8'));
    } catch {}
  }
  const providers = (modelsConfig['providers'] as Record<string, unknown>) || {};

  return Object.entries(providers).map(([name, data]) => {
    const pData = data as Record<string, unknown>;
    const models = (pData['models'] as Record<string, unknown>[]) || [];
    return {
      id: name,
      name: name.charAt(0).toUpperCase() + name.slice(1),
      type: resolveProviderType(name),
      baseUrl: pData['baseUrl'] || '',
      apiProtocol: pData['api'] || 'openai-completions',
      headers: pData['headers'] || {},
      model: models[0]?.['id'] || '',
      enabled: true,
      hasKey: true, // if provider is configured, it has key
      keyMasked: '****',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  });
}

function getProviderVendors(): Record<string, unknown>[] {
  // Return static vendor info for supported providers
  return [
    { id: 'minimax-portal-cn', name: 'MiniMax (CN)', icon: '☁️', category: 'official', requiresApiKey: false, supportedAuthModes: ['api_key', 'oauth_device'], defaultAuthMode: 'api_key', supportsMultipleAccounts: false },
    { id: 'minimax-portal', name: 'MiniMax (Global)', icon: '☁️', category: 'official', requiresApiKey: false, supportedAuthModes: ['api_key', 'oauth_device'], defaultAuthMode: 'api_key', supportsMultipleAccounts: false },
    { id: 'anthropic', name: 'Anthropic', icon: '🤖', category: 'official', requiresApiKey: true, supportedAuthModes: ['api_key'], defaultAuthMode: 'api_key', supportsMultipleAccounts: false },
    { id: 'openai', name: 'OpenAI', icon: '💚', category: 'official', requiresApiKey: true, supportedAuthModes: ['api_key', 'oauth_browser'], defaultAuthMode: 'oauth_browser', supportsMultipleAccounts: false },
    { id: 'google', name: 'Google', icon: '🔷', category: 'official', requiresApiKey: true, supportedAuthModes: ['api_key', 'oauth_browser'], defaultAuthMode: 'oauth_browser', supportsMultipleAccounts: false },
    { id: 'openrouter', name: 'OpenRouter', icon: '🌐', category: 'compatible', requiresApiKey: true, supportedAuthModes: ['api_key'], defaultAuthMode: 'api_key', supportsMultipleAccounts: false },
    { id: 'ark', name: 'ByteDance Ark', icon: 'A', category: 'official', requiresApiKey: true, supportedAuthModes: ['api_key'], defaultAuthMode: 'api_key', supportsMultipleAccounts: false },
    { id: 'moonshot', name: 'Moonshot (CN)', icon: '🌙', category: 'official', requiresApiKey: true, supportedAuthModes: ['api_key'], defaultAuthMode: 'api_key', supportsMultipleAccounts: false },
    { id: 'siliconflow', name: 'SiliconFlow (CN)', icon: '🌊', category: 'compatible', requiresApiKey: true, supportedAuthModes: ['api_key'], defaultAuthMode: 'api_key', supportsMultipleAccounts: false },
    { id: 'ollama', name: 'Ollama', icon: '🦙', category: 'local', requiresApiKey: false, supportedAuthModes: ['local'], defaultAuthMode: 'local', supportsMultipleAccounts: false },
  ];
}

async function getProviderById(id: string): Promise<Record<string, unknown> | null> {
  const providers = await getProviders();
  return providers.find(p => p['id'] === id || p['type'] === id) || null;
}

async function getProviderApiKey(id: string): Promise<{ apiKey: string | null }> {
  // The actual API key is stored in auth-profiles.json which is not readable
  // Return masked key to indicate key exists
  const config = readOpenClawConfig();
  const auth = (config['auth'] as Record<string, unknown>) || {};
  const profiles = (auth['profiles'] as Record<string, Record<string, unknown>>) || {};

  for (const [, profileData] of Object.entries(profiles)) {
    const pf = profileData as Record<string, unknown>;
    if (pf['provider'] === id || id === 'minimax:cn' || id === 'minimax') {
      // If auth profile exists with api_key mode, key is configured
      if (pf['mode'] === 'api_key') {
        return { apiKey: '****' };
      }
    }
  }

  // Check if provider config exists (means it's configured)
  const modelsConfig = (config['models'] as Record<string, unknown>) || {};
  const providers = (modelsConfig['providers'] as Record<string, unknown>) || {};
  if (providers[id] || providers['minimax']) {
    return { apiKey: '****' };
  }

  return { apiKey: null };
}

function getDefaultBaseUrl(providerId: string): string {
  switch (providerId) {
    case 'openai': return 'https://api.openai.com';
    case 'anthropic': return 'https://api.anthropic.com';
    case 'minimax': return 'https://api.minimax.chat';
    case 'minimax-portal': return 'https://api.minimax.chat';
    case 'minimax-portal-cn': return 'https://api.minimax.cn';
    case 'siliconflow': return 'https://api.siliconflow.cn';
    case 'ollama': return 'http://localhost:11434';
    case 'ark': return 'https://ark.cn-beijing.volces.com/api/v3';
    default: return 'https://api.openai.com/v1';
  }
}

// Legacy openclaw:status handler (used by RuntimeContent)
ipcMain.handle('openclaw:status', async () => {
  return new Promise((resolve) => {
    const openclawPath = '/usr/bin/openclaw';
    if (!existsSync(openclawPath)) {
      resolve({ packageExists: false, isBuilt: false, dir: '', version: undefined });
      return;
    }
    const child = spawn(openclawPath, ['--version'], { shell: true });
    let version = '';
    child.stdout.on('data', (data) => { version += data.toString(); });
    child.on('close', () => {
      resolve({
        packageExists: true,
        isBuilt: true,
        dir: '/usr/bin/openclaw',
        version: version.trim(),
      });
    });
    child.on('error', () => {
      resolve({ packageExists: false, isBuilt: false, dir: '', version: undefined });
    });
  });
});

// Legacy gateway:status (used by RuntimeContent) — fast HTTP check
ipcMain.handle('gateway:status', async () => {
  return new Promise((resolve) => {
    const http = require('http') as typeof import('http');
    const req = http.request(
      { host: '127.0.0.1', port: 18789, path: '/health', method: 'GET', timeout: 3000 },
      (res: import('http').IncomingMessage) => {
        res.on('data', () => {});
        res.on('end', () => {
          resolve({ state: res.statusCode === 200 ? 'running' : 'stopped', port: 18789 });
        });
      },
    );
    req.on('error', () => resolve({ state: 'stopped', port: 18789 }));
    req.on('timeout', () => { req.destroy(); resolve({ state: 'stopped', port: 18789 }); });
    req.end();
  });
});

// Legacy gateway:start (used by RuntimeContent)
ipcMain.handle('gateway:start', async () => {
  return new Promise((resolve) => {
    const child = spawn('openclaw', ['gateway', 'start'], { shell: true });
    child.on('close', (code) => resolve({ success: code === 0 }));
    child.on('error', () => resolve({ success: false, error: 'Failed to start gateway' }));
  });
});

// Gateway RPC handler — forwards JSON-RPC calls to OpenClaw Gateway WebSocket
// Transforms gateway response to expected { success, result, error } format
ipcMain.handle('gateway:rpc', async (_, method: string, params?: unknown) => {
  try {
    const result = await gatewayWsClient.invoke(method, params);
    return { success: true, result };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { success: false, error };
  }
});

// Shell: show item in folder
ipcMain.handle('shell:showItemInFolder', async (_, path: string) => {
  shell.showItemInFolder(path);
  return { success: true };
});

// Shell: open path (for Skills page "Open Folder" button)
ipcMain.handle('shell:openPath', async (_, path: string) => {
  try {
    shell.openPath(path);
    return '';
  } catch (err) {
    return String(err);
  }
});

// Shell: open external URL
ipcMain.handle('shell:openExternal', async (_, url: string) => {
  try {
    shell.openExternal(url);
    return '';
  } catch (err) {
    return String(err);
  }
});

// ── Runtime Auto-Install IPC Handlers ──────────────────────────────────────────

type ProgressCallback = (phase: string, message: string) => void;

// Detect platform and return Node.js download URL
function getNodeDownloadInfo() {
  const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'x64' ? 'x64' : process.arch;
  const nodeVersion = '22.14.0'; // latest stable as of this build
  const ext = platform === 'win' ? 'zip' : 'tar.gz';
  const basename = platform === 'darwin' ? 'node' : `node-v${nodeVersion}-${platform}-${arch}`;
  const url = `https://nodejs.org/dist/v${nodeVersion}/${basename}.${ext}`;
  return { platform, arch, nodeVersion, ext, url, basename };
}

// Detect available package manager (npm > pnpm > bun)
async function detectPackageManager(): Promise<'npm' | 'pnpm' | 'bun' | null> {
  const tryCmd = (cmd: string): Promise<boolean> => {
    return new Promise((resolve) => {
      const child = spawn(cmd, ['--version'], { shell: true, timeout: 3000 });
      child.on('close', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
    });
  };
  if (await tryCmd('npm')) return 'npm';
  if (await tryCmd('pnpm')) return 'pnpm';
  if (await tryCmd('bun')) return 'bun';
  return null;
}

// Check if Node.js is available (either system node or in ~/.local/node)
async function getNodeVersion(): Promise<string | null> {
  const tryNode = (cmd: string): Promise<string | null> => {
    return new Promise((resolve) => {
      const child = spawn(cmd, ['-p', 'process.versions.node'], { shell: true, timeout: 5000 });
      let out = '';
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.on('close', () => resolve(out.trim() || null));
      child.on('error', () => resolve(null));
    });
  };
  // Try system node first, then ~/.local/node/bin
  const homeDir = homedir();
  const localNode = `${homeDir}/.local/node/bin/node`;
  for (const cmd of ['node', localNode]) {
    const v = await tryNode(cmd);
    if (v) return v;
  }
  return null;
}

// runtime:check — comprehensive status of all runtime components
ipcMain.handle('runtime:check', async () => {
  const nodeVersion = await getNodeVersion();
  const pm = await detectPackageManager();

  // Check openclaw CLI (including ~/.local/node/bin where we install it)
  const openclawExists = existsSync('/usr/bin/openclaw') || existsSync(`${homedir()}/.npm-global/bin/openclaw`) || existsSync(`${homedir()}/.local/node/bin/openclaw`);
  let openclawVersion: string | null = null;
  if (openclawExists) {
    try {
      const child = spawn('openclaw', ['--version'], { shell: true, timeout: 5000 });
      await new Promise<void>((resolve) => {
        let out = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.on('close', () => { openclawVersion = out.trim() || null; resolve(); });
        child.on('error', () => resolve());
      });
    } catch {}
  }

  // Check gateway (HTTP health check)
  let gatewayRunning = false;
  let gatewayPort = 18789;
  try {
    const http = require('http') as typeof import('http');
    await new Promise<void>((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: gatewayPort, path: '/health', method: 'GET', timeout: 3000 },
        (res: import('http').IncomingMessage) => {
          gatewayRunning = res.statusCode === 200;
          res.on('data', () => {});
          res.on('end', resolve);
        },
      );
      req.on('error', () => { gatewayRunning = false; resolve(); });
      req.on('timeout', () => { req.destroy(); gatewayRunning = false; resolve(); });
      req.end();
    });
  } catch {}

  return {
    node: { exists: !!nodeVersion, version: nodeVersion },
    openclaw: { exists: openclawExists, version: openclawVersion },
    gateway: { running: gatewayRunning, port: gatewayPort },
    packageManager: pm,
  };
});

// runtime:installNode — download and install Node.js to ~/.local/node/
ipcMain.handle('runtime:installNode', async () => {
  const onProgress = (msg: string) => {
    mainWindow?.webContents?.send('runtime:progress', { phase: 'node', message: msg });
  };

  try {
    // Check if already installed in ~/.local/node
    const localNodeBin = `${homedir()}/.local/node/bin/node`;
    if (existsSync(localNodeBin)) {
      onProgress('Node.js already installed at ~/.local/node');
      return { success: true };
    }

    const { platform, nodeVersion, ext, url, basename } = getNodeDownloadInfo();
    onProgress(`Preparing Node.js ${nodeVersion} download...`);

    const localNodeDir = `${homedir()}/.local/node`;

    // Download to a temp file
    const tempFile = `/tmp/node-${nodeVersion}.${ext}`;

    onProgress(`Downloading Node.js ${nodeVersion} from nodejs.org...`);

    // Use curl for reliable download with redirects
    const dl = spawn('curl', ['-L', '-f', '--progress-bar', `-o${tempFile}`, url], { shell: true });
    await new Promise<void>((resolve, reject) => {
      dl.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Download failed with code ${code}`));
      });
      dl.on('error', reject);
    });

    onProgress('Extracting Node.js...');

    // Create ~/.local directory
    spawn('mkdir', ['-p', localNodeDir], { shell: true });

    if (ext === 'tar.gz') {
      // Linux/macOS: extract tar.gz
      await new Promise<void>((resolve, reject) => {
        const ex = spawn('tar', ['-xzf', tempFile, '-C', localNodeDir, '--strip-components=1'], { shell: true });
        ex.on('close', (code) => code === 0 ? resolve() : reject(new Error(`tar failed: ${code}`)));
        ex.on('error', reject);
      });
    } else {
      // Windows: unzip
      await new Promise<void>((resolve, reject) => {
        const ex = spawn('unzip', ['-o', tempFile, '-d', localNodeDir], { shell: true });
        ex.on('close', (code) => code === 0 ? resolve() : reject(new Error(`unzip failed: ${code}`)));
        ex.on('error', reject);
      });
    }

    // Cleanup
    spawn('rm', ['-f', tempFile], { shell: true });

    // Verify
    const verify = spawn(`${localNodeBin}`, ['--version'], { shell: true });
    let verOut = '';
    verify.stdout.on('data', (d) => { verOut += d.toString(); });
    await new Promise<void>((resolve) => {
      verify.on('close', () => resolve());
    });

    onProgress(`Node.js ${verOut.trim()} installed to ~/.local/node`);
    return { success: true, version: verOut.trim() };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    onProgress(`Node.js installation failed: ${error}`);
    return { success: false, error };
  }
});

// runtime:installOpenClaw — install openclaw CLI via npm/pnpm/bun
ipcMain.handle('runtime:installOpenClaw', async () => {
  const onProgress = (msg: string) => {
    mainWindow?.webContents?.send('runtime:progress', { phase: 'openclaw', message: msg });
  };

  try {
    // Check if already installed (including ~/.local/node/bin where we install it)
    const openclawPaths = [
      '/usr/bin/openclaw',
      `${homedir()}/.npm-global/bin/openclaw`,
      `${homedir()}/.local/node/bin/openclaw`,
    ];
    const existingOpenClaw = openclawPaths.find((p) => existsSync(p));
    if (existingOpenClaw) {
      onProgress('OpenClaw CLI already installed');
      // Get version
      try {
        const child = spawn(existingOpenClaw, ['--version'], { shell: true, timeout: 5000 });
        let verOut = '';
        child.stdout.on('data', (d) => { verOut += d.toString(); });
        await new Promise<void>((res) => { child.on('close', () => res()); });
        return { success: true, version: verOut.trim() || undefined };
      } catch {
        return { success: true };
      }
    }

    const pm = await detectPackageManager();
    if (!pm) {
      return { success: false, error: 'No package manager found (npm/pnpm/bun)' };
    }

    onProgress(`Installing OpenClaw CLI via ${pm}...`);

    // Use npm from ~/.local/node if available (Node 22), otherwise system npm
    const localNpm = `${homedir()}/.local/node/bin/npm`;
    const npmCmd = existsSync(localNpm) ? localNpm : pm;

    // Install globally with the detected package manager
    const installCmd = pm === 'bun'
      ? 'bun add -g openclaw'
      : `${npmCmd} install -g openclaw`;

    await new Promise<void>((resolve, reject) => {
      const child = spawn(installCmd, [], {
        shell: true,
        env: { ...process.env, npm_config_global: 'true' },
      });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Install failed: ${stderr || `exit code ${code}`}`));
      });
      child.on('error', (e) => reject(e));
    });

    // Find the installed binary
    let verOut = '';
    const binPaths = [
      '/usr/bin/openclaw',
      `${homedir()}/.npm-global/bin/openclaw`,
      `${homedir()}/.local/share/npm-global/bin/openclaw`,
      `${homedir()}/.local/node/bin/openclaw`,
    ];
    for (const p of binPaths) {
      if (existsSync(p)) {
        try {
          const child = spawn(p, ['--version'], { shell: true, timeout: 5000 });
          await new Promise<void>((res) => {
            child.stdout.on('data', (d) => { verOut += d.toString(); });
            child.on('close', () => res());
          });
          break;
        } catch {}
      }
    }

    onProgress(`OpenClaw ${verOut.trim() || 'CLI'} installed successfully`);
    return { success: true, version: verOut.trim() || undefined };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    onProgress(`OpenClaw installation failed: ${error}`);
    return { success: false, error };
  }
});

// runtime:installGateway — install and start gateway service
ipcMain.handle('runtime:installGateway', async () => {
  const onProgress = (msg: string) => {
    mainWindow?.webContents?.send('runtime:progress', { phase: 'gateway', message: msg });
  };

  try {
    // Find openclaw binary
    const binPaths = [
      '/usr/bin/openclaw',
      `${homedir()}/.npm-global/bin/openclaw`,
      `${homedir()}/.local/share/npm-global/bin/openclaw`,
      `${homedir()}/.local/node/bin/openclaw`,
    ];
    const openclawCmd = binPaths.find((p) => existsSync(p)) || 'openclaw';

    onProgress('Installing gateway service...');

    // Run: openclaw gateway install
    await new Promise<void>((resolve, reject) => {
      const child = spawn(openclawCmd, ['gateway', 'install'], { shell: true });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('close', (code) => {
        if (code === 0 || stderr.includes('already')) resolve();
        else reject(new Error(`gateway install failed: ${stderr || code}`));
      });
      child.on('error', reject);
    });

    onProgress('Starting gateway...');

    // Run: openclaw gateway start
    await new Promise<void>((resolve, reject) => {
      const child = spawn(openclawCmd, ['gateway', 'start'], { shell: true });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('close', (code) => {
        if (code === 0 || stderr.includes('already running') || stderr.includes('started')) resolve();
        else reject(new Error(`gateway start failed: ${stderr || code}`));
      });
      child.on('error', reject);
    });

    // Wait a moment for gateway to initialize
    await new Promise((r) => setTimeout(r, 3000));

    // Verify gateway is running
    let gatewayRunning = false;
    try {
      const http = require('http') as typeof import('http');
      await new Promise<void>((resolve) => {
        const req = http.request(
          { host: '127.0.0.1', port: 18789, path: '/health', method: 'GET', timeout: 5000 },
          (res: import('http').IncomingMessage) => {
            gatewayRunning = res.statusCode === 200;
            res.on('data', () => {});
            res.on('end', resolve);
          },
        );
        req.on('error', () => { gatewayRunning = false; resolve(); });
        req.on('timeout', () => { req.destroy(); gatewayRunning = false; resolve(); });
        req.end();
      });
    } catch {}

    if (gatewayRunning) {
      onProgress('Gateway is running on port 18789');
      return { success: true, running: true, port: 18789 };
    } else {
      onProgress('Gateway service installed (may take a moment to fully start)');
      return { success: true, running: false, port: 18789 };
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    onProgress(`Gateway installation failed: ${error}`);
    return { success: false, error };
  }
});

// Dialog: open file picker
ipcMain.handle('dialog:open', async (_, options: { filters?: { name: string; extensions: string[] }[]; properties?: string[] }) => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    filters: options.filters,
    properties: (options.properties as Electron.OpenDialogOptions['properties']) || ['openFile'],
  });
  return result;
});

// Session delete → no-op (read-only UI)
ipcMain.handle('session:delete', async () => {
  return { success: true };
});

// Settings setMany → no-op (read-only UI)
ipcMain.handle('settings:setMany', async (_, settings: Record<string, unknown>) => {
  if (settings && typeof settings === 'object') {
    const current = readOrionSettings();
    writeOrionSettings({ ...current, ...settings });
  }
  return { success: true };
});

ipcMain.handle('settings:getMany', async () => {
  return readOrionSettings();
});

// Update handlers → no-op (read-only UI, no auto-update)
ipcMain.handle('update:version', () => null);
ipcMain.handle('update:check', async () => ({ updateAvailable: false }));
ipcMain.handle('update:install', () => {});
ipcMain.handle('update:status', () => ({ status: 'idle', info: null, progress: null, error: null }));
ipcMain.handle('update:setAutoDownload', () => {});
ipcMain.handle('update:cancelAutoInstall', () => {});

// OpenClaw: get skills directory
ipcMain.handle('openclaw:getSkillsDir', () => {
  return join(homedir(), '.openclaw', 'skills');
});

// Provider: validate API key
ipcMain.handle('provider:validateKey', async (_, providerId: string, apiKey: string, options?: { baseUrl?: string; apiProtocol?: string }) => {
  try {
    const modelId = 'test'; // dummy model for validation
    const baseUrl = options?.baseUrl || getDefaultBaseUrl(providerId);
    const protocol = options?.apiProtocol || 'openai-completions';

    let testUrl = '';
    let headers: Record<string, string> = { 'Authorization': `Bearer ${apiKey}` };
    let body: string | undefined;

    if (providerId === 'openai' || providerId === 'siliconflow' || providerId === 'custom') {
      testUrl = `${baseUrl}/chat/completions`;
      body = JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 });
      headers['Content-Type'] = 'application/json';
    } else if (providerId === 'anthropic') {
      testUrl = `${baseUrl}/messages`;
      body = JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 });
      headers['Content-Type'] = 'application/json';
      headers['x-api-key'] = apiKey;
      delete headers['Authorization'];
    } else if (providerId === 'minimax' || providerId === 'minimax-portal' || providerId === 'minimax-portal-cn') {
      testUrl = `${baseUrl}/v1/text/chatcompletion_v2`;
      body = JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }] });
      headers['Content-Type'] = 'application/json';
    } else if (providerId === 'ark') {
      testUrl = `${baseUrl}/chat/completions`;
      body = JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 });
      headers['Content-Type'] = 'application/json';
    } else if (providerId === 'ollama') {
      testUrl = `${baseUrl}/api/chat`;
      body = JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }] });
      headers['Content-Type'] = 'application/json';
    } else {
      // Default: try OpenAI-compatible endpoint
      testUrl = `${baseUrl}/chat/completions`;
      body = JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 });
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(testUrl, {
      method: 'POST',
      headers,
      body,
    });

    if (response.ok) {
      return { valid: true };
    } else {
      const errorText = await response.text().catch(() => '');
      let errorMsg = `HTTP ${response.status}`;
      try {
        const errJson = JSON.parse(errorText);
        errorMsg = errJson.error?.message || errJson.error?.type || errorMsg;
      } catch {}
      return { valid: false, error: errorMsg };
    }
  } catch (err) {
    return { valid: false, error: String(err) };
  }
});

// Install OpenClaw and start gateway service
ipcMain.handle('uv:install-all', async () => {
  const { execSync, spawn } = require('child_process');
  const { homedir } = require('os');

  const log = (msg: string) => console.log(`[uv:install] ${msg}`);
  const error = (msg: string) => console.error(`[uv:install] ERROR: ${msg}`);
  const progress = (step: number, total: number, message: string) => {
    mainWindow?.webContents.send('install:progress', { step, total, message, percent: Math.round((step / total) * 100) });
  };

  const TOTAL_STEPS = 8;

  try {
    // Step 1: Check if OpenClaw CLI is installed
    progress(1, TOTAL_STEPS, 'Checking OpenClaw installation...');
    log('Checking OpenClaw installation...');
    // Check multiple possible locations including ~/.local/node/bin
    const openclawPaths = [
      `${homedir()}/.local/node/bin/openclaw`,
      '/usr/bin/openclaw',
      `${homedir()}/.npm-global/bin/openclaw`,
    ];
    let openclawInstalled = openclawPaths.some((p) => {
      try {
        execSync(`test -f "${p}" && test -x "${p}"`, { encoding: 'utf8', timeout: 5000 });
        log(`OpenClaw CLI found at ${p}`);
        return true;
      } catch {
        return false;
      }
    });
    if (!openclawInstalled) {
      try {
        execSync('which openclaw', { encoding: 'utf8', timeout: 5000 });
        openclawInstalled = true;
        log('OpenClaw CLI found in PATH');
      } catch {
        log('OpenClaw CLI not found, will install via npm');
      }
    }

    // Step 2: Install OpenClaw if not present
    if (!openclawInstalled) {
      progress(2, TOTAL_STEPS, 'Installing OpenClaw via npm...');
      log('Installing OpenClaw via npm...');
      // Use Node 22 npm if available, otherwise system npm
      const localNpm = `${homedir()}/.local/node/bin/npm`;
      const npmBin = require('fs').existsSync(localNpm) ? localNpm : 'npm';
      try {
        execSync(`${npmBin} install -g openclaw`, {
          encoding: 'utf8',
          timeout: 120000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        log('OpenClaw installed successfully');
      } catch (e: unknown) {
        const emsg = e instanceof Error ? (e as Error).message : String(e);
        const errMsg = (e as { stderr?: string }).stderr || emsg || 'Unknown npm error';
        error(`npm install failed: ${errMsg}`);
        return { success: false, error: `Failed to install OpenClaw: ${errMsg}` };
      }
    }

    // Build env with correct PATH (Node 22 first)
    const localNodeBin = `${homedir()}/.local/node/bin`;
    const correctEnv = {
      ...process.env,
      PATH: `${localNodeBin}:${process.env.PATH || '/usr/bin:/bin'}`,
    };

    // Step 3: Verify openclaw CLI works
    progress(3, TOTAL_STEPS, 'Verifying OpenClaw CLI...');
    try {
      const version = execSync('openclaw --version', { encoding: 'utf8', timeout: 10000, env: correctEnv }).trim();
      log(`OpenClaw version: ${version}`);
    } catch (e: unknown) {
      const emsg = e instanceof Error ? e.message : String(e);
      error(`OpenClaw CLI not working: ${emsg}`);
      return { success: false, error: 'OpenClaw CLI installed but not functional' };
    }

    // Step 4: Check if gateway service is installed
    progress(4, TOTAL_STEPS, 'Checking gateway service...');
    log('Checking gateway service status...');
    let serviceInstalled = false;
    try {
      const status = execSync('openclaw daemon status', { encoding: 'utf8', timeout: 15000, env: correctEnv });
      serviceInstalled = status.includes('installed') || status.includes('running') || status.includes('active');
      log(`Gateway service status: ${status.substring(0, 100)}`);
    } catch {
      log('Gateway service not installed');
    }

    // Step 5: Install gateway service if not present
    if (!serviceInstalled) {
      progress(5, TOTAL_STEPS, 'Installing gateway service...');
      log('Installing gateway service...');
      try {
        // Try to install as system service (may need sudo)
        execSync('openclaw daemon install', { encoding: 'utf8', timeout: 60000, env: correctEnv });
        log('Gateway service installed');
      } catch (e) {
        // Fallback: try user-level service
        log('System install failed, trying user-level...');
        try {
          execSync('openclaw daemon install --user', { encoding: 'utf8', timeout: 60000, env: correctEnv });
          log('Gateway service installed (user level)');
        } catch (e2: unknown) {
          const e2msg = e2 instanceof Error ? e2.message : String(e2);
          error(`Failed to install gateway service: ${e2msg}`);
          return { success: false, error: `Gateway service installation failed: ${e2msg}` };
        }
      }
    }

    // Step 6: Start the gateway service
    progress(6, TOTAL_STEPS, 'Starting gateway service...');
    log('Starting gateway service...');
    try {
      execSync('openclaw daemon start', { encoding: 'utf8', timeout: 30000, env: correctEnv });
      log('Gateway started');
    } catch (e: unknown) {
      const emsg = e instanceof Error ? e.message : String(e);
      log(`Start returned: ${emsg}`);
    }

    // Step 7: Wait for gateway to be ready and verify
    progress(7, TOTAL_STEPS, 'Verifying gateway...');
    log('Verifying gateway is running...');
    const maxWait = 30;
    let gatewayReady = false;
    for (let i = 0; i < maxWait; i++) {
      try {
        const status = execSync('openclaw daemon status', { encoding: 'utf8', timeout: 5000 });
        if (status.includes('running') || status.includes('active')) {
          gatewayReady = true;
          log(`Gateway is running (waited ${i}s)`);
          break;
        }
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!gatewayReady) {
      error('Gateway did not become ready in time');
      return { success: false, error: 'Gateway service failed to start within 30 seconds' };
    }

    // Step 8: Final verification
    progress(8, TOTAL_STEPS, 'Finalizing...');
    log('Final verification...');
    try {
      const probe = execSync('openclaw config get gateway.port 2>/dev/null || echo 19001', { encoding: 'utf8', timeout: 5000 }).trim();
      log(`Gateway configured on port: ${probe}`);
    } catch {
      // Non-fatal
    }

    log('Installation complete');
    return { success: true };
  } catch (e: unknown) {
    const errmsg = e instanceof Error ? e.message : String(e);
    error(`Unexpected error: ${errmsg}`);
    return { success: false, error: errmsg };
  }
});

// Window management
ipcMain.handle('window:minimize', () => {
  mainWindow?.minimize();
});
ipcMain.handle('window:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.handle('window:close', () => {
  mainWindow?.close();
});
ipcMain.handle('window:isMaximized', () => {
  return mainWindow?.isMaximized() ?? false;
});

// App info
ipcMain.handle('app:name', () => '猎户座');
ipcMain.handle('app:version', () => '0.0.1');
ipcMain.handle('app:platform', () => process.platform);

// Remote SSH command execution (for remote ClawX control)
ipcMain.handle('ssh:exec', async (_, host: string, user: string, cmd: string) => {
  return new Promise((resolve) => {
    const keyPath = join(homedir(), '.ssh', 'id_ed25519');
    const sshCmd = `ssh -o StrictHostKeyChecking=no -o BatchMode=yes -i "${keyPath}" ${user}@${host} ${JSON.stringify(cmd)}`;
    const proc = spawn('sh', ['-c', sshCmd], { timeout: 30000 });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ stdout, stderr, code }));
    proc.on('error', (err) => resolve({ stdout, stderr, code: -1, error: err.message }));
  });
});

// Remote screenshot via SSH
ipcMain.handle('ssh:screenshot', async (_, host: string, user: string) => {
  return new Promise((resolve) => {
    const keyPath = join(homedir(), '.ssh', 'id_ed25519');
    const sshCmd = `ssh -o StrictHostKeyChecking=no -o BatchMode=yes -i "${keyPath}" ${user}@${host} DISPLAY=:0 import -window root /tmp/orion_screen.png 2>/dev/null && echo OK || echo FAIL`;
    const proc = spawn('sh', ['-c', sshCmd], { timeout: 15000 });
    let output = '';
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.on('close', (code) => {
      if (output.includes('OK')) {
        // SCP the screenshot back
        const scpCmd = `scp -o StrictHostKeyChecking=no -i "${keyPath}" ${user}@${host}:/tmp/orion_screen.png /tmp/orion_remote_screen.png`;
        const scpProc = spawn('sh', ['-c', scpCmd], { timeout: 15000 });
        scpProc.on('close', (sc) => resolve({ ok: sc === 0, path: '/tmp/orion_remote_screen.png' }));
        scpProc.on('error', (e) => resolve({ ok: false, error: e.message }));
      } else {
        resolve({ ok: false, error: 'screenshot failed on remote' });
      }
    });
    proc.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
});

app.whenReady().then(async () => {
  log('app.whenReady fired');
  // Pre-warm the bindings cache synchronously so /api/agents is fast from the first call.
  // This adds ~6s to startup but eliminates "Failed to load agents" errors in the UI.
  try {
    await buildAgentsSnapshot();
    log('Bindings cache warmed');
  } catch (e) {
    log(`Bindings cache warmup failed: ${e}`);
  }
  createWindow();
});

app.on('window-all-closed', () => {
  log('window-all-closed');
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  log('activate event');
  if (mainWindow === null) {
    createWindow();
  }
});
