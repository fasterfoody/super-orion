/**
 * Gateway RPC Bridge for Electron Renderer
 * 
 * Since the renderer cannot set proper Origin headers for WebSocket connections,
 * we route all gateway calls through the main process via IPC.
 * The main process has a working WebSocket connection to the gateway.
 */

import { invokeIpc } from '@/lib/api-client';

type PendingHandler = {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
};

let requestId = 0;
const pending = new Map<string, PendingHandler>();

// Gateway invoke via IPC bridge
function invoke<T>(method: string, params?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = `req-${++requestId}`;
    
    // Register pending handler
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    
    // Send via IPC to main process, which forwards to gateway
    invokeIpc('gateway:rpc', method, params)
      .then((response: { success: boolean; result?: T; error?: string }) => {
        const handler = pending.get(id);
        pending.delete(id);
        if (!handler) return;
        
        if (response.success && response.result !== undefined) {
          handler.resolve(response.result);
        } else {
          handler.reject(new Error(response.error || 'Unknown error'));
        }
      })
      .catch((err: Error) => {
        pending.delete(id);
        const handler = pending.get(id);
        if (handler) {
          handler.reject(err);
        } else {
          reject(err);
        }
      });
  });
}

// For compatibility with existing code
const isConnected = true;
const isConnecting = false;
const handshakeDone = true;

function connect(): Promise<void> {
  return Promise.resolve();
}

function disconnect(): void {
  pending.clear();
}

// Export as module
export const gatewayInvoke = invoke;
export { connect, disconnect, isConnected, isConnecting, handshakeDone };
