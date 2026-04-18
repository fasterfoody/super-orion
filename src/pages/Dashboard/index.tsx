/**
 * Dashboard — Orion Overview
 */
import { useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useAgentsStore } from '@/stores/agents';
import { useCronStore } from '@/stores/cron';
import { useProviderStore } from '@/stores/providers';
import { useSkillsStore } from '@/stores/skills';
import { useChannelsStore } from '@/stores/channels';
import { useNavigate } from 'react-router-dom';
import type { Channel, ChannelType } from '@/types/channel';
import { CHANNEL_NAMES } from '@/types/channel';
import { Clock } from 'lucide-react';

function StatusDot({ online }: { online: boolean }) {
  return (
    <span
      className="inline-block w-2 h-2 rounded-full"
      style={{ backgroundColor: online ? '#22c55e' : '#6b7280' }}
      title={online ? 'Online' : 'Offline'}
    />
  );
}

function AgentCard({ agent }: { agent: { id: string; name: string; channelTypes: string[]; modelRef: string | null } }) {
  const navigate = useNavigate();
  return (
    <Card className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => navigate('/agents')}>
      <CardContent className="pt-4">
        <p className="text-sm font-medium">{agent.name}</p>
        <p className="text-xs text-muted-foreground truncate">{agent.modelRef || 'default'}</p>
        <div className="flex flex-wrap gap-1 mt-2">
          {(!agent.channelTypes || agent.channelTypes.length === 0) ? (
            <Badge variant="outline" className="text-xs">no channel</Badge>
          ) : (
            (agent.channelTypes || []).map((ch) => (
              <Badge key={ch} variant="secondary" className="text-xs capitalize">{ch}</Badge>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function StatCard({ title, value, sub, onClick }: { title: string; value: string | number; sub?: string; onClick?: () => void }) {
  return (
    <Card className={onClick ? 'cursor-pointer hover:border-primary/50 transition-colors' : ''} onClick={onClick}>
      <CardContent className="pt-4">
        <p className="text-xs text-muted-foreground uppercase tracking-wide">{title}</p>
        <p className="text-2xl font-bold mt-1">{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function ChannelStatusRow({ channel }: { channel: Channel | null | undefined }) {
  const navigate = useNavigate();
  if (!channel) return null;
  const isRunning = channel.status === 'connected';
  const statusLabel = channel.status === 'connected' ? 'Connected' :
    channel.status === 'connecting' ? 'Connecting' :
    channel.status === 'error' ? `Error: ${channel.error || 'Unknown'}` :
    'Disconnected';
  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/50 cursor-pointer transition-colors" onClick={() => navigate('/channels')}>
      <div className="flex items-center gap-2">
        <StatusDot online={isRunning} />
        <span className="text-sm font-medium">{CHANNEL_NAMES[channel.type as ChannelType] || channel.type || 'Unknown'}</span>
      </div>
      <Badge variant={isRunning ? 'default' : 'outline'} className="text-xs">{statusLabel}</Badge>
    </div>
  );
}

export default function Dashboard() {
  // Only read from stores - no local fetch
  const agents = useAgentsStore((s) => s.agents);
  const jobs = useCronStore((s) => s.jobs);
  const accounts = useProviderStore((s) => s.accounts);
  const skills = useSkillsStore((s) => s.skills);
  const channels = useChannelsStore((s) => s.channels);
  const navigate = useNavigate();

  const safeAgents = agents || [];
  const safeJobs = jobs || [];
  const safeAccounts = accounts || [];
  const safeSkills = skills || [];
  const safeChannels = channels || [];

  const activeCrons = safeJobs.filter((j) => j && j.enabled).length;
  const installedSkills = safeSkills.filter((s) => s && !s.isBundled).length;
  const configuredProviders = safeAccounts.filter((a) => a && a.enabled).length;
  const agentsWithChannels = safeAgents.filter((a) => a && (a.channelTypes || []).length > 0).length;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">猎户座 · 控制台</h1>
          <p className="text-sm text-muted-foreground">System overview</p>
        </div>
        <Badge variant="outline" className="text-sm">{safeAgents.length} agents</Badge>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard title="Agents" value={safeAgents.length} sub={`${agentsWithChannels} with channels`} onClick={() => navigate('/agents')} />
        <StatCard title="Cron Jobs" value={activeCrons} sub={`${safeJobs.length} total`} onClick={() => navigate('/cron')} />
        <StatCard title="Skills" value={installedSkills} sub={`${safeSkills.length} total`} onClick={() => navigate('/skills')} />
        <StatCard title="Providers" value={configuredProviders} sub={`${safeAccounts.length} accounts`} onClick={() => navigate('/settings/providers')} />
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Agents</h2>
          <button className="text-xs text-primary hover:underline" onClick={() => navigate('/agents')}>Manage →</button>
        </div>
        {safeAgents.length === 0 ? (
          <Card><CardContent className="pt-4"><p className="text-sm text-muted-foreground">No agents yet.</p></CardContent></Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {safeAgents.map((agent) => agent ? <AgentCard key={agent.id} agent={{ id: agent.id, name: agent.name, channelTypes: (agent.channelTypes || []), modelRef: agent.modelRef }} /> : null)}
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Channels</h2>
          <button className="text-xs text-primary hover:underline" onClick={() => navigate('/channels')}>Manage →</button>
        </div>
        <Card>
          <CardContent className="pt-4">
            {safeChannels.length === 0 ? <p className="text-sm text-muted-foreground py-2">No channels configured</p> : safeChannels.map((channel) => channel ? <ChannelStatusRow key={channel.id} channel={channel} /> : null)}
          </CardContent>
        </Card>
      </div>

      {safeJobs.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold">Cron Jobs</h2>
            <button className="text-xs text-primary hover:underline" onClick={() => navigate('/cron')}>Manage →</button>
          </div>
          <Card>
            <CardContent className="pt-4 space-y-1">
              {safeJobs.slice(0, 5).map((job) => job ? (
                <div key={job.id} className="flex items-center justify-between py-1.5">
                  <div className="flex items-center gap-2"><StatusDot online={!!job.enabled} /><span className="text-sm">{job.name}</span></div>
                  <Badge variant={job.enabled ? 'default' : 'outline'} className="text-xs">{job.enabled ? 'Active' : 'Paused'}</Badge>
                </div>
              ) : null)}
            </CardContent>
          </Card>
        </div>
      )}

      <div>
        <h2 className="text-lg font-semibold mb-3">Quick Actions</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <button className="flex flex-col items-center gap-1 p-4 rounded-lg border hover:bg-muted/50 transition-colors text-sm" onClick={() => navigate('/agents')}><span className="text-lg">👥</span><span>Agents</span></button>
          <button className="flex flex-col items-center gap-1 p-4 rounded-lg border hover:bg-muted/50 transition-colors text-sm" onClick={() => navigate('/channels')}><span className="text-lg">📡</span><span>Channels</span></button>
          <button className="flex flex-col items-center gap-1 p-4 rounded-lg border hover:bg-muted/50 transition-colors text-sm" onClick={() => navigate('/remote')}><span className="text-lg">🖥️</span><span>Remote</span></button>
          <button className="flex flex-col items-center gap-1 p-4 rounded-lg border hover:bg-muted/50 transition-colors text-sm" onClick={() => navigate('/sessions')}><span className="text-lg">💬</span><span>所有会话</span></button>
          <button className="flex flex-col items-center gap-1 p-4 rounded-lg border hover:bg-muted/50 transition-colors text-sm" onClick={() => navigate('/cron')}><span className="text-lg"><Clock className="w-5 h-5" /></span><span>Cron</span></button>
        </div>
      </div>
    </div>
  );
}
