export interface AgentSummary {
  id: string;
  name: string;
  isDefault: boolean;
  modelDisplay: string;
  modelRef?: string | null;
  overrideModelRef?: string | null;
  inheritedModel: boolean;
  workspace: string;
  agentDir: string;
  mainSessionKey: string;
  channelTypes: string[];
  // Enriched fields
  provider?: string;        // e.g. 'minimax', 'openai', 'anthropic'
  modelId?: string;         // e.g. 'MiniMax-M2.7-highspeed'
  sessionCount?: number;    // number of sessions in sessions/ dir
  skillCount?: number;     // number of skills in workspace/skills/
  skills?: string[];       // skill names from workspace/skills/
  tools?: string[];         // configured tool names
  remoteNodeIp?: string;   // remote execution node IP (from node.json)
  description?: string;    // first line of SOUL.md or IDENTITY.md
  identityEmoji?: string;  // emoji from IDENTITY.md
  identityVibe?: string;   // vibe from IDENTITY.md
}

export interface AgentsSnapshot {
  agents: AgentSummary[];
  defaultAgentId: string;
  defaultModelRef?: string | null;
  configuredChannelTypes: string[];
  channelOwners: Record<string, string>;
  channelAccountOwners: Record<string, string>;
}
