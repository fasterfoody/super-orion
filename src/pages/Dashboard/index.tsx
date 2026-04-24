/**
 * Dashboard — Orion Overview
 */
import { useState, useMemo, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAgentsStore } from '@/stores/agents';
import { useCronStore } from '@/stores/cron';
import { useProviderStore } from '@/stores/providers';
import { useSkillsStore } from '@/stores/skills';
import { useChannelsStore } from '@/stores/channels';
import { useNavigate } from 'react-router-dom';
import type { Channel, ChannelType } from '@/types/channel';
import { CHANNEL_NAMES } from '@/types/channel';
import type { AgentSummary } from '@/types/agent';
import { getProviderIconUrl } from '@/lib/providers';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  rectSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { toast } from 'sonner';
import {
  Bot, Check, ChevronDown, Clock, FolderOpen, GripVertical,
  Hash, MessageSquare, Monitor, RefreshCw, Save, Server, Settings2, Sparkles, Wrench, X,
} from 'lucide-react';

// ── Avatar helpers ─────────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e',
  '#f97316', '#eab308', '#22c55e', '#14b8a6',
  '#06b6d4', '#3b82f6', '#a855f7', '#64748b',
];
function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function AgentAvatar({ name, size = 40 }: { name: string; size?: number }) {
  const displayName = name || '?';
  const initial = displayName.charAt(0).toUpperCase();
  const bg = getAvatarColor(displayName);
  const fontSize = Math.round(size * 0.4);
  return (
    <div
      className="rounded-xl shrink-0 flex items-center justify-center font-bold text-white select-none"
      style={{ width: size, height: size, backgroundColor: bg, fontSize }}
      title={displayName}
    >
      {initial}
    </div>
  );
}

// ── StatCard ─────────────────────────────────────────────────────────────────

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

// ── StatusDot ────────────────────────────────────────────────────────────────

function StatusDot({ online }: { online: boolean }) {
  return (
    <span
      className="inline-block w-2 h-2 rounded-full"
      style={{ backgroundColor: online ? '#22c55e' : '#6b7280' }}
      title={online ? 'Online' : 'Offline'}
    />
  );
}

// ── ChannelStatusRow ─────────────────────────────────────────────────────────

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

// ── AgentDetailModal ─────────────────────────────────────────────────────────

function AgentDetailModal({
  agent,
  onClose,
  allAgents,
}: {
  agent: AgentSummary;
  onClose: () => void;
  allAgents: AgentSummary[];
}) {
  const navigate = useNavigate();
  const { updateAgent, updateAgentModel } = useAgentsStore();
  const accounts = useProviderStore((s) => s.accounts);
  const vendors = useProviderStore((s) => s.vendors);

  // Name editing
  const [name, setName] = useState(agent.name || '');
  const [savingName, setSavingName] = useState(false);
  const hasNameChanges = name.trim() !== (agent.name || '');
  const canSaveName = name.trim() && hasNameChanges;

  // Model editing
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [selectedModel, setSelectedModel] = useState(agent.modelRef || '');
  const [savingModel, setSavingModel] = useState(false);
  const hasModelChanges = selectedModel !== (agent.modelRef || '');

  // Build model options from configured accounts
  const modelOptions = useMemo(() => {
    const options: { label: string; value: string; vendor: string; }[] = [];
    const added = new Set<string>();
    for (const acc of accounts) {
      if (!acc.enabled) continue;
      const m = acc.model;
      if (!m) continue;
      const vendor = vendors.find((v) => v.id === acc.vendorId);
      const vendorName = vendor?.name || acc.vendorId;
      const label = `${acc.label} · ${m.split('/').pop()}`;
      if (!added.has(m)) { added.add(m); options.push({ label, value: m, vendor: vendorName }); }
    }
    return options;
  }, [accounts, vendors]);

  const handleSaveName = async () => {
    if (!canSaveName) return;
    setSavingName(true);
    try {
      await updateAgent(agent.id, name.trim());
      toast.success('Agent name updated');
    } catch (e) {
      toast.error(`Failed: ${e}`);
      setName(agent.name || '');
    } finally {
      setSavingName(false);
    }
  };

  const handleSaveModel = async () => {
    if (!hasModelChanges) return;
    setSavingModel(true);
    try {
      await updateAgentModel(agent.id, selectedModel || null);
      toast.success('Model updated');
      setShowModelPicker(false);
    } catch (e) {
      toast.error(`Failed: ${e}`);
    } finally {
      setSavingModel(false);
    }
  };

  const providerIconUrl = agent.provider ? getProviderIconUrl(agent.provider) : undefined;
  const hasChannels = (agent.channelTypes || []).length > 0;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <Card
        className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-3xl border-0 shadow-2xl bg-[#f3f1e9] dark:bg-card overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-5 pb-4 shrink-0">
          <div className="flex items-center gap-3">
            <AgentAvatar name={agent.name} size={48} />
            <div>
              <h2 className="text-xl font-semibold text-foreground">{agent.name}</h2>
              {agent.isDefault && (
                <div className="flex items-center gap-1 mt-0.5">
                  <Check className="h-3 w-3 text-green-600" />
                  <span className="text-xs text-muted-foreground">默认 Agent</span>
                </div>
              )}
            </div>
          </div>
          <Button variant="ghost" size="icon" className="rounded-full h-8 w-8 -mr-2 -mt-1" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Scrollable content */}
        <div className="overflow-y-auto flex-1 px-5 pb-2 space-y-5">

          {/* Name + ID row */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">名称</Label>
              {!agent.isDefault ? (
                <div className="flex gap-2">
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="h-[36px] text-[13px] rounded-xl bg-white dark:bg-black/5"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleSaveName()}
                    disabled={!canSaveName || savingName}
                    className="h-[36px] px-3 rounded-xl shrink-0"
                  >
                    {savingName ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                  </Button>
                </div>
              ) : (
                <p className="text-[13px] font-medium text-foreground pt-0.5">{agent.name}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">Agent ID</Label>
              <div className="flex items-center gap-1.5 pt-0.5">
                <Hash className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="font-mono text-[12px] text-muted-foreground truncate">{agent.id}</span>
              </div>
            </div>
          </div>

          {/* Model row */}
          <div className="space-y-2">
            <Label className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">模型</Label>
            {showModelPicker ? (
              <div className="space-y-2">
                <div className="relative">
                  <select
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    className="w-full h-[36px] text-[13px] rounded-xl border border-input bg-white dark:bg-black/5 px-3 pr-8 appearance-none text-foreground"
                  >
                    <option value="">— 继承默认 —</option>
                    {modelOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => void handleSaveModel()}
                    disabled={!hasModelChanges || savingModel}
                    className="h-[32px] px-3 rounded-xl text-[12px]"
                  >
                    {savingModel ? <RefreshCw className="h-3 w-3 animate-spin" /> : '保存模型'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => { setShowModelPicker(false); setSelectedModel(agent.modelRef || ''); }}
                    className="h-[32px] px-3 rounded-xl text-[12px]"
                  >
                    取消
                  </Button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowModelPicker(true)}
                className="flex items-center gap-2.5 w-full text-left rounded-xl bg-black/5 dark:bg-white/5 p-3 hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
              >
                {providerIconUrl ? (
                  <img src={providerIconUrl} alt={agent.provider} className="h-5 w-5 rounded-sm object-contain shrink-0" />
                ) : (
                  <Bot className="h-5 w-5 text-muted-foreground shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-medium text-foreground truncate">
                    {agent.modelDisplay || agent.modelRef?.split('/').pop() || '-'}
                  </p>
                  {agent.modelRef && (
                    <p className="text-[11px] text-muted-foreground font-mono truncate">{agent.modelRef}</p>
                  )}
                </div>
                <Settings2 className="h-4 w-4 text-muted-foreground shrink-0" />
              </button>
            )}
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl bg-black/5 dark:bg-white/5 p-3 text-center">
              <MessageSquare className="h-4 w-4 mx-auto text-muted-foreground mb-1" />
              <p className="text-[18px] font-bold">{agent.sessionCount ?? 0}</p>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">会话</p>
            </div>
            <div className="rounded-xl bg-black/5 dark:bg-white/5 p-3 text-center">
              <Sparkles className="h-4 w-4 mx-auto text-muted-foreground mb-1" />
              <p className="text-[18px] font-bold">{agent.skillCount ?? 0}</p>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">技能</p>
            </div>
            <div className="rounded-xl bg-black/5 dark:bg-white/5 p-3 text-center">
              <Bot className="h-4 w-4 mx-auto text-muted-foreground mb-1" />
              <p className="text-[18px] font-bold">{agent.channelTypes?.length ?? 0}</p>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">频道</p>
            </div>
          </div>

          {/* Workspace */}
          {agent.workspace && (
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">工作区</Label>
              <div className="flex items-center gap-2 text-[12px] text-muted-foreground/70 rounded-xl bg-black/5 dark:bg-white/5 p-2.5 font-mono truncate">
                <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{agent.workspace}</span>
              </div>
            </div>
          )}

          {/* Channels */}
          {hasChannels && (
            <div className="space-y-2">
              <Label className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">已绑定频道</Label>
              <div className="flex flex-wrap gap-1.5">
                {(agent.channelTypes || []).map((ch) => (
                  <Badge key={ch} variant="secondary" className="text-xs capitalize px-2.5 py-0.5 rounded-full">
                    {CHANNEL_NAMES[ch as ChannelType] || ch}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Skills */}
          {(agent.skills || []).length > 0 && (
            <div className="space-y-2">
              <Label className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">技能</Label>
              <div className="flex flex-wrap gap-1.5">
                {(agent.skills || []).map((skill) => (
                  <Badge key={skill} variant="outline" className="text-xs px-2 py-0.5 rounded-full bg-primary/5 border-primary/20 text-primary">
                    <Sparkles className="h-3 w-3 mr-1" />
                    {skill}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Tools */}
          {(agent.tools || []).length > 0 && (
            <div className="space-y-2">
              <Label className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">工具</Label>
              <div className="flex flex-wrap gap-1.5">
                {(agent.tools || []).map((tool) => (
                  <Badge key={tool} variant="outline" className="text-xs px-2 py-0.5 rounded-full">
                    <Wrench className="h-3 w-3 mr-1" />
                    {tool}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Remote Node */}
          {agent.remoteNodeIp && (
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">执行机</Label>
              <div className="flex items-center gap-2 text-[12px] text-muted-foreground/70 rounded-xl bg-black/5 dark:bg-white/5 p-2.5">
                <Server className="h-3.5 w-3.5 shrink-0" />
                <span className="font-mono">{agent.remoteNodeIp}</span>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 p-4 pt-2 shrink-0 border-t border-black/5 dark:border-white/5">
          <Button variant="outline" size="sm" className="rounded-full" onClick={onClose}>关闭</Button>
          <Button size="sm" className="rounded-full gap-1.5" onClick={() => { onClose(); navigate('/agents'); }}>
            <Settings2 className="h-4 w-4" />
            完整配置
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ── SortableAgentCard ────────────────────────────────────────────────────────

function SortableAgentCard({ agent, onClick }: { agent: AgentSummary; onClick: () => void }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: agent.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 999 : 'auto',
  };

  const providerIconUrl = agent.provider ? getProviderIconUrl(agent.provider) : undefined;

  return (
    <div ref={setNodeRef} style={style}>
      <Card
        className="cursor-pointer hover:border-primary/40 hover:shadow-md transition-all select-none"
        onClick={onClick}
      >
        <CardContent className="pt-4 flex flex-col gap-2 relative">
          {/* Drag handle */}
          <div
            {...attributes}
            {...listeners}
            className="absolute top-2 right-2 text-muted-foreground/30 hover:text-muted-foreground cursor-grab active:cursor-grabbing p-1 rounded"
          >
            <GripVertical className="h-4 w-4" />
          </div>

          <div className="flex items-center gap-3 pr-6">
            <AgentAvatar name={agent.name} size={40} />
            <div className="flex flex-col min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-semibold text-foreground truncate">{agent.name}</span>
                {agent.isDefault && (
                  <Badge variant="secondary" className="text-[10px] px-1 py-0 rounded-full shrink-0">默认</Badge>
                )}
              </div>
              <div className="flex items-center gap-1.5 mt-0.5">
                {providerIconUrl ? (
                  <img src={providerIconUrl} alt={agent.provider} className="h-3.5 w-3.5 rounded-sm object-contain" />
                ) : null}
                <span className="text-[12px] text-muted-foreground truncate">{agent.modelDisplay || '-'}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 text-[12px] text-muted-foreground/80">
            {(agent.sessionCount ?? 0) > 0 && (
              <div className="flex items-center gap-1">
                <MessageSquare className="h-3 w-3" />
                <span>{agent.sessionCount}</span>
              </div>
            )}
            {(agent.skillCount ?? 0) > 0 && (
              <div className="flex items-center gap-1">
                <Sparkles className="h-3 w-3" />
                <span>{agent.skillCount}</span>
              </div>
            )}
            {(agent.channelTypes || []).length === 0 ? (
              <span className="text-[11px] text-muted-foreground/50">未绑定频道</span>
            ) : (
              <div className="flex flex-wrap gap-1">
                {(agent.channelTypes || []).map((ch) => (
                  <Badge key={ch} variant="outline" className="text-[10px] px-1 py-0 capitalize">{ch}</Badge>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Dashboard ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const agents = useAgentsStore((s) => s.agents);
  const jobs = useCronStore((s) => s.jobs);
  const accounts = useProviderStore((s) => s.accounts);
  const skills = useSkillsStore((s) => s.skills);
  const channels = useChannelsStore((s) => s.channels);
  const navigate = useNavigate();

  const [selectedAgent, setSelectedAgent] = useState<AgentSummary | null>(null);
  const [orderedIds, setOrderedIds] = useState<string[] | null>(null);

  // Load persisted agent order on mount
  useEffect(() => {
    window.electron.ipcRenderer.invoke('dashboard:loadAgentOrder').then((saved: string[] | null) => {
      if (saved && saved.length > 0) setOrderedIds(saved);
    });
  }, []);

  const orderedAgents = useMemo(() => {
    if (!orderedIds) return agents;
    const agentMap = new Map(agents.map((a) => [a.id, a]));
    const ordered = orderedIds.map((id) => agentMap.get(id)).filter(Boolean) as AgentSummary[];
    const extra = agents.filter((a) => !orderedIds.includes(a.id));
    return ordered.length > 0 ? [...ordered, ...extra] : agents;
  }, [agents, orderedIds]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setOrderedIds((ids) => {
        const currentIds = ids || orderedAgents.map((a) => a.id);
        const oldIndex = currentIds.indexOf(String(active.id));
        const newIndex = currentIds.indexOf(String(over.id));
        const newIds = [...currentIds];
        newIds.splice(oldIndex, 1);
        newIds.splice(newIndex, 0, String(active.id));
        // Persist the new order
        window.electron.ipcRenderer.invoke('dashboard:saveAgentOrder', newIds);
        return newIds;
      });
    }
  }

  const safeAgents = orderedAgents || [];
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
      {selectedAgent && (
        <AgentDetailModal
          agent={selectedAgent}
          onClose={() => setSelectedAgent(null)}
          allAgents={safeAgents}
        />
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">猎户座 · 员工间</h1>
          <p className="text-sm text-muted-foreground">System overview</p>
        </div>
        <Badge variant="outline" className="text-sm">{safeAgents.length} 个智能星</Badge>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard title="智能星" value={safeAgents.length} sub={`${agentsWithChannels} 个已绑定频道`} onClick={() => navigate('/agents')} />
        <StatCard title="Cron Jobs" value={activeCrons} sub={`${safeJobs.length} total`} onClick={() => navigate('/cron')} />
        <StatCard title="Skills" value={installedSkills} sub={`${safeSkills.length} total`} onClick={() => navigate('/skills')} />
        <StatCard title="Providers" value={configuredProviders} sub={`${safeAccounts.length} accounts`} onClick={() => navigate('/settings/providers')} />
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">智能星</h2>
          <button className="text-xs text-primary hover:underline" onClick={() => navigate('/agents')}>Manage →</button>
        </div>
        {safeAgents.length === 0 ? (
          <Card><CardContent className="pt-4"><p className="text-sm text-muted-foreground">No agents yet.</p></CardContent></Card>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={safeAgents.map((a) => a.id)} strategy={rectSortingStrategy}>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {safeAgents.map((agent) => agent ? (
                  <SortableAgentCard
                    key={agent.id}
                    agent={agent}
                    onClick={() => setSelectedAgent(agent)}
                  />
                ) : null)}
              </div>
            </SortableContext>
          </DndContext>
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
