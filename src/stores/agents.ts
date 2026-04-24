import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import { invokeIpc } from '@/lib/api-client';
import type { ChannelType } from '@/types/channel';
import type { AgentSummary, AgentsSnapshot } from '@/types/agent';

interface AgentsState {
  agents: AgentSummary[];
  defaultAgentId: string;
  defaultModelRef: string | null;
  configuredChannelTypes: string[];
  channelOwners: Record<string, string>;
  channelAccountOwners: Record<string, string>;
  loading: boolean;
  error: string | null;
  fetchAgents: () => Promise<void>;
  startAutoRefresh: () => void;
  stopAutoRefresh: () => void;
  createAgent: (name: string, options?: { inheritWorkspace?: boolean }) => Promise<void>;
  updateAgent: (agentId: string, name: string) => Promise<void>;
  updateAgentModel: (agentId: string, modelRef: string | null) => Promise<void>;
  deleteAgent: (agentId: string) => Promise<void>;
  assignChannel: (agentId: string, channelType: ChannelType) => Promise<void>;
  removeChannel: (agentId: string, channelType: ChannelType) => Promise<void>;
  clearError: () => void;
}

let _agentsRefreshTimer: ReturnType<typeof setInterval> | null = null;

function applySnapshot(snapshot: AgentsSnapshot | undefined) {
  return snapshot ? {
    agents: snapshot.agents ?? [],
    defaultAgentId: snapshot.defaultAgentId ?? 'main',
    defaultModelRef: snapshot.defaultModelRef ?? null,
    configuredChannelTypes: snapshot.configuredChannelTypes ?? [],
    channelOwners: snapshot.channelOwners ?? {},
    channelAccountOwners: snapshot.channelAccountOwners ?? {},
  } : {};
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
  agents: [],
  defaultAgentId: 'main',
  defaultModelRef: null,
  configuredChannelTypes: [],
  channelOwners: {},
  channelAccountOwners: {},
  loading: false,
  error: null,

  startAutoRefresh: () => {
    if (_agentsRefreshTimer) return;
    _agentsRefreshTimer = setInterval(() => {
      get().fetchAgents();
    }, 30_000);
  },

  stopAutoRefresh: () => {
    if (_agentsRefreshTimer) {
      clearInterval(_agentsRefreshTimer);
      _agentsRefreshTimer = null;
    }
  },

  fetchAgents: async () => {
    set({ loading: true, error: null });
    try {
      // Query all independent agent gateways in parallel via IPC
      const rawAgents = await invokeIpc<Array<{
        id?: string; name?: string; workspace?: string;
        model?: { primary?: string }; _gatewayLabel?: string; _gatewayPort?: number;
      }>>('agents:list-all');

      const agents: AgentSummary[] = (rawAgents || []).map((a) => ({
        id: a.id || a._gatewayLabel || 'unknown',
        name: a.name || a.id || a._gatewayLabel || 'Unknown',
        isDefault: a.id === 'main' || a._gatewayLabel === 'main',
        modelDisplay: a.model?.primary?.split('/').pop() || '',
        modelRef: a.model?.primary || null,
        overrideModelRef: null,
        inheritedModel: false,
        workspace: a.workspace || '',
        agentDir: '',
        mainSessionKey: '',
        channelTypes: [],
        provider: a.model?.primary?.split('/')[0] || '',
        modelId: a.model?.primary?.split('/').pop() || '',
        sessionCount: 0,
        skillCount: 0,
        skills: [],
        tools: [],
        remoteNodeIp: '',
        description: '',
        identityEmoji: '⚡',
        identityVibe: '',
      }));

      const snapshot: AgentsSnapshot = {
        agents,
        defaultAgentId: 'main',
        defaultModelRef: null,
        configuredChannelTypes: [],
        channelOwners: {},
        channelAccountOwners: {},
      };

      set({
        ...applySnapshot(snapshot),
        loading: false,
      });
    } catch (error) {
      set({ loading: false, error: String(error) });
    }
  },

  createAgent: async (name: string, options?: { inheritWorkspace?: boolean }) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>('/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name, inheritWorkspace: options?.inheritWorkspace }),
      });
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  updateAgent: async (agentId: string, name: string) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>(
        `/api/agents/${encodeURIComponent(agentId)}`,
        {
          method: 'PUT',
          body: JSON.stringify({ name }),
        }
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  updateAgentModel: async (agentId: string, modelRef: string | null) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>(
        `/api/agents/${encodeURIComponent(agentId)}/model`,
        {
          method: 'PUT',
          body: JSON.stringify({ modelRef }),
        }
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  deleteAgent: async (agentId: string) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>(
        `/api/agents/${encodeURIComponent(agentId)}`,
        { method: 'DELETE' }
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  assignChannel: async (agentId: string, channelType: ChannelType) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>(
        `/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(channelType)}`,
        { method: 'PUT' }
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  removeChannel: async (agentId: string, channelType: ChannelType) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>(
        `/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(channelType)}`,
        { method: 'DELETE' }
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  clearError: () => set({ error: null }),
}));
