import { useState, useEffect, useCallback } from 'react';
import { invokeIpc } from '@/lib/api-client';

export interface AgentSession {
  key: string;          // e.g. "agent:main:main"
  agentId: string;     // e.g. "main"
  sessionId: string;    // UUID
  updatedAt: number;    // Unix ms
  model?: string;
  modelProvider?: string;
  kind?: string;
  // enriched fields
  label?: string;
  gatewayHost?: string;
  gatewayPort?: number;
}

export interface RemoteGateway {
  host: string;
  sshUser: string;
  label: string;
  // sessions from last fetch
  sessions?: AgentSession[];
  error?: string;
  lastUpdated?: Date;
}

// Known remote gateways — poll these for sessions
const KNOWN_REMOTES: RemoteGateway[] = [
  { host: '192.168.5.163', sshUser: 'erbro001', label: '远程 (erbro001)' },
];

async function fetchRemoteSessions(gateway: RemoteGateway): Promise<AgentSession[]> {
  try {
    const result = await invokeIpc<{ ok: boolean; sessions: AgentSession[]; error?: string }>(
      'sessions:remote',
      gateway.host,
      gateway.sshUser
    );
    if (!result.ok || !result.sessions) {
      console.warn(`[sessions:remote] ${gateway.host}: ${result.error}`);
      return [];
    }
    return result.sessions.map(s => ({
      ...s,
      gatewayHost: gateway.host,
    }));
  } catch (e: any) {
    console.warn(`[sessions:remote] ${gateway.host}: ${e.message}`);
    return [];
  }
}

export function useMultiGatewaySessions(enabled = true) {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [remotes, setRemotes] = useState<RemoteGateway[]>(KNOWN_REMOTES);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchAll = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);

    try {
      const remoteResults = await Promise.all(
        KNOWN_REMOTES.map(gw => fetchRemoteSessions(gw))
      );

      // Tag remote sessions with gateway info
      const allRemote = remoteResults.flat();
      const tagged = allRemote.map(s => ({
        ...s,
        gatewayHost: s.gatewayHost,
      }));

      // For local sessions, we read directly from the gateway via WS
      // The gatewayClient in lib/gateway-client.ts handles local sessions
      // For now, just show remote sessions (local gateway sessions come through the normal flow)
      setSessions(tagged);
      setLastUpdated(new Date());

      // Update remote status
      setRemotes(prev => prev.map((gw, i) => ({
        ...gw,
        sessions: remoteResults[i] || [],
        lastUpdated: new Date(),
      })));
    } catch (e: any) {
      setError(e.message || 'Failed to fetch sessions');
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    fetchAll();
    // Refresh every 30 seconds
    const interval = setInterval(fetchAll, 30_000);
    return () => clearInterval(interval);
  }, [enabled, fetchAll]);

  return { sessions, remotes, loading, error, lastUpdated, refetch: fetchAll };
}

// Group sessions by time period (like ClawX sidebar)
export function groupSessionsByTime(sessions: AgentSession[]): Record<string, AgentSession[]> {
  const now = Date.now();
  const groups: Record<string, AgentSession[]> = {
    'Today': [],
    'Yesterday': [],
    'This Week': [],
    'Older': [],
  };

  for (const session of sessions) {
    const age = now - session.updatedAt;
    const seconds = Math.floor(age / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days < 1) {
      groups['Today'].push(session);
    } else if (days < 2) {
      groups['Yesterday'].push(session);
    } else if (days < 7) {
      groups['This Week'].push(session);
    } else {
      groups['Older'].push(session);
    }
  }

  return Object.fromEntries(
    Object.entries(groups).filter(([, s]) => s.length > 0)
  );
}

// Build a display label for a session
export function getSessionDisplayLabel(session: AgentSession): string {
  if (session.label) return session.label;
  const parts = session.key.split(':');
  if (parts.length >= 3) {
    const [, agentId, ...rest] = parts;
    return rest.join(':') || agentId;
  }
  return session.key;
}

// Format relative time
export function formatSessionAge(updatedAt: number): string {
  const age = Date.now() - updatedAt;
  const seconds = Math.floor(age / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}
