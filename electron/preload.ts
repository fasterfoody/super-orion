/**
 * Orion UI - Preload Script
 * Exposes safe IPC methods to renderer process
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
    on: (channel: string, callback: (...args: unknown[]) => void) => {
      ipcRenderer.on(channel, (_, ...rest) => callback(...rest));
    },
    send: (channel: string, ...args: unknown[]) => ipcRenderer.send(channel, ...args),
    off: (channel: string) => ipcRenderer.removeAllListeners(channel),
  },
  os: {
    type: () => process.platform,
    platform: () => process.platform,
    release: () => process.release.name,
  },
  app: {
    getPath: (name: string) => '',
    getName: () => '猎户座',
    getVersion: () => '0.0.1',
  },
});
