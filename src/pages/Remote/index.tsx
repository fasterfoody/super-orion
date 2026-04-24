/**
 * 星穹 (Starfield) - Remote Node Management Page
 * Monitor and manage remote execution nodes
 * Reads node config from ~/.config/orion-ui/orion-settings.json
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { invokeIpc } from '@/lib/api-client';
import { hostApiFetch } from '@/lib/host-api';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Terminal, RefreshCw, Server, Cpu, HardDrive, Zap, Eye, RotateCw, Monitor, Activity, Plus, Scan } from 'lucide-react';

interface NodeConfig {
  id: string;
  name: string;
  host: string;
  user: string;
  controlAgent: string;
  description: string;
}

interface NodeStatus {
  online: boolean;
  hostname: string;
  uptime: string;
  cpuUser: number;
  cpuSys: number;
  cpuIdle: number;
  memoryPercent: number;
  memoryUsed: string;
  memoryTotal: string;
  diskPercent: number;
  diskUsed: string;
  diskTotal: string;
  gpu: string;
  gpuMemoryPercent: number;
  gpuMemoryUsed: string;
  gpuMemoryTotal: string;
  gateway: 'running' | 'stopped' | 'unknown';
  agent: 'running' | 'stopped' | 'unknown';
  browser: 'running' | 'stopped' | 'unknown';
  geckodriver: 'running' | 'stopped' | 'unknown';
  error?: string;
}

const STATUS_COLORS = {
  running: '#10b981',
  stopped: '#ef4444',
  unknown: '#6b7280',
};

const STATUS_TEXT = {
  running: '运行中',
  stopped: '已停止',
  unknown: '未知',
};

// Nice looking progress bar
function Bar({ value, color }: { value: number; color: string }) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div style={{ background: 'rgba(255,255,255,0.07)', borderRadius: 4, height: 6, overflow: 'hidden' }}>
      <div style={{
        width: `${pct}%`,
        height: '100%',
        background: pct > 85 ? '#ef4444' : pct > 60 ? '#f59e0b' : color,
        borderRadius: 4,
        transition: 'width 0.5s ease',
      }} />
    </div>
  );
}

// Metric tile
function Metric({ icon, label, value, sub, color }: {
  icon: React.ReactNode; label: string; value: string; sub?: string; color: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {icon}
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
      </div>
      <span style={{ fontSize: 18, fontWeight: 700, color: '#fff', lineHeight: 1 }}>{value}</span>
      {sub && <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>{sub}</span>}
    </div>
  );
}

function NodeCard({ node, status, onRefresh, onAction, loading }: {
  node: NodeConfig;
  status: NodeStatus | null;
  onRefresh: () => void;
  onAction: (action: string) => void;
  loading: boolean;
}) {
  const services = status ? [
    { key: 'gateway', label: 'Gateway', process: 'openclaw-gateway' },
    { key: 'agent', label: node.controlAgent, process: `openclaw-${node.controlAgent}` },
    { key: 'browser', label: 'Firefox', process: 'firefox' },
    { key: 'geckodriver', label: 'Geckodriver', process: 'geckodriver' },
  ] : [];

  return (
    <div style={{
      background: 'linear-gradient(135deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 16,
      padding: 20,
      backdropFilter: 'blur(10px)',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: status?.online ? 'linear-gradient(135deg, #10b981, #059669)' : 'linear-gradient(135deg, #6b7280, #4b5563)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Server size={18} color="#fff" />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>{node.name}</span>
              <span style={{
                fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
                background: status?.online ? 'rgba(16,185,129,0.2)' : 'rgba(107,114,128,0.2)',
                color: status?.online ? '#10b981' : '#9ca3af',
              }}>
                {status?.online ? '在线' : '离线'}
              </span>
            </div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 3 }}>
              {node.user}@{node.host}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
            主控 <strong style={{ color: '#fff' }}>{node.controlAgent}</strong>
          </span>
          <Button size="sm" variant="ghost" onClick={onRefresh} disabled={loading} style={{ padding: '4px 8px' }}>
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </Button>
        </div>
      </div>

      {!status ? (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'rgba(255,255,255,0.4)', fontSize: 13 }}>
          {loading ? '正在连接...' : '点击刷新获取状态'}
        </div>
      ) : !status.online ? (
        <div style={{ textAlign: 'center', padding: '32px 0', color: '#ef4444', fontSize: 13 }}>
          连接失败：{status.error || '无法连接到此节点'}
        </div>
      ) : (
        <>
          {/* Metrics Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
            {/* CPU */}
            <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 8 }}>
                <Cpu size={11} color="rgba(255,255,255,0.4)" />
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>CPU</span>
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#fff' }}>
                {(100 - status.cpuIdle).toFixed(0)}%
              </div>
              <div style={{ marginTop: 6 }}>
                <Bar value={100 - status.cpuIdle} color="#3b82f6" />
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 4, fontSize: 9, color: 'rgba(255,255,255,0.35)' }}>
                <span>U {status.cpuUser.toFixed(0)}%</span>
                <span>S {status.cpuSys.toFixed(0)}%</span>
                <span>I {status.cpuIdle.toFixed(0)}%</span>
              </div>
            </div>

            {/* Memory */}
            <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 8 }}>
                <Zap size={11} color="rgba(255,255,255,0.4)" />
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>内存</span>
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#fff' }}>
                {status.memoryPercent.toFixed(0)}%
              </div>
              <div style={{ marginTop: 6 }}>
                <Bar value={status.memoryPercent} color="#8b5cf6" />
              </div>
              <div style={{ marginTop: 4, fontSize: 9, color: 'rgba(255,255,255,0.35)' }}>
                {status.memoryUsed} / {status.memoryTotal}
              </div>
            </div>

            {/* Disk */}
            <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 8 }}>
                <HardDrive size={11} color="rgba(255,255,255,0.4)" />
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>磁盘</span>
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#fff' }}>
                {status.diskPercent.toFixed(0)}%
              </div>
              <div style={{ marginTop: 6 }}>
                <Bar value={status.diskPercent} color="#f59e0b" />
              </div>
              <div style={{ marginTop: 4, fontSize: 9, color: 'rgba(255,255,255,0.35)' }}>
                {status.diskUsed} / {status.diskTotal}
              </div>
            </div>
          </div>

          {/* GPU */}
          {(status.gpu && !status.gpu.includes('未检测')) && (
            <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: '10px 14px', marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Monitor size={11} color="rgba(255,255,255,0.4)" />
                  <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>GPU · {status.gpu}</span>
                </div>
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>{status.gpuMemoryUsed} / {status.gpuMemoryTotal}</span>
              </div>
              <Bar value={status.gpuMemoryPercent} color="#10b981" />
            </div>
          )}

          {/* Services */}
          <div style={{ marginBottom: 16 }}>
            <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>服务</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
              {services.map((svc) => {
                const svcStatus = status[svc.key as keyof NodeStatus] as 'running' | 'stopped' | 'unknown';
                return (
                  <div key={svc.key} style={{
                    background: 'rgba(255,255,255,0.04)',
                    borderRadius: 8,
                    padding: '8px 10px',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 4,
                  }}>
                    <div style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_COLORS[svcStatus] }} />
                    <span style={{ fontSize: 11, color: '#fff', fontWeight: 500 }}>{svc.label}</span>
                    <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)' }}>{STATUS_TEXT[svcStatus]}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 6 }}>
            <Button size="sm" variant="outline" onClick={() => onAction('gateway-restart')} disabled={loading}
              style={{ flex: 1, fontSize: 11, borderColor: 'rgba(255,255,255,0.1)', color: '#fff', background: 'rgba(255,255,255,0.04)' }}>
              <RotateCw size={11} style={{ marginRight: 4 }} />Gateway
            </Button>
            <Button size="sm" variant="outline" onClick={() => onAction('agent-restart')} disabled={loading}
              style={{ flex: 1, fontSize: 11, borderColor: 'rgba(255,255,255,0.1)', color: '#fff', background: 'rgba(255,255,255,0.04)' }}>
              <RotateCw size={11} style={{ marginRight: 4 }} />Agent
            </Button>
            <Button size="sm" variant="outline" onClick={() => onAction('tail-log')} disabled={loading}
              style={{ flex: 1, fontSize: 11, borderColor: 'rgba(255,255,255,0.1)', color: '#fff', background: 'rgba(255,255,255,0.04)' }}>
              <Eye size={11} style={{ marginRight: 4 }} />日志
            </Button>
          </div>

          {/* Uptime */}
          <div style={{ marginTop: 10, fontSize: 10, color: 'rgba(255,255,255,0.25)', textAlign: 'center' }}>
            {status.hostname} · 运行 {status.uptime}
          </div>
        </>
      )}
    </div>
  );
}

function LogModal({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }} onClick={onClose}>
      <div style={{
        background: '#1a1a2e', borderRadius: 12, padding: 24,
        maxWidth: 800, width: '100%', maxHeight: '80vh', overflow: 'auto',
        border: '1px solid rgba(255,255,255,0.1)',
      }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3 style={{ fontWeight: 600, color: '#fff' }}>日志输出</h3>
          <Button size="sm" variant="ghost" onClick={onClose} style={{ color: '#fff' }}>关闭</Button>
        </div>
        <pre style={{
          background: '#0d0d1a', color: '#10b981', padding: 16, borderRadius: 8,
          fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 400,
          overflow: 'auto',
        }}>
          {text}
        </pre>
      </div>
    </div>
  );
}

export function Remote() {
  const { t } = useTranslation();
  const [nodes, setNodes] = useState<NodeConfig[]>([]);
  const [nodeStatuses, setNodeStatuses] = useState<Record<string, NodeStatus>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [modalText, setModalText] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);

  // Add node / scan state
  const [scanRange, setScanRange] = useState('192.168.5');
  const [scanResults, setScanResults] = useState<Array<{ ip: string; online: boolean; selected: boolean }>>([]);
  const [scanning, setScanning] = useState(false);
  const [selectedIPs, setSelectedIPs] = useState<Set<string>>(new Set());
  const scanResultsRef = useRef(scanResults);

  useEffect(() => { scanResultsRef.current = scanResults; }, [scanResults]);

  const loadNodes = useCallback(async () => {
    try {
      const settings = await hostApiFetch<Record<string, unknown>>('/api/settings');
      const nodeList = (settings?.nodes as NodeConfig[] | undefined) || [];
      setNodes(nodeList);
      if (nodeList.length === 0) setInitError('未配置节点。请在 ~/.config/orion-ui/orion-settings.json 中添加 nodes 字段。');
      else setInitError(null);
    } catch (e) {
      setInitError(`加载节点配置失败: ${e}`);
    }
  }, []);

  const exec = useCallback(async (host: string, user: string, command: string) => {
    try {
      return await invokeIpc<{ stdout: string; stderr: string; code: number }>('ssh:exec', host, user, command);
    } catch (e) {
      return { stdout: '', stderr: String(e), code: -1 };
    }
  }, []);

  const getNodeStatus = useCallback(async (node: NodeConfig, silent = false) => {
    if (!silent) setLoading((prev) => ({ ...prev, [node.id]: true }));
    try {
      const [uptimeRes, cpuRes, memRes, diskRes, gpuRes, procRes] = await Promise.all([
        exec(node.host, node.user, 'uptime'),
        exec(node.host, node.user, "top -bn1 | grep 'Cpu(s)'"),
        exec(node.host, node.user, "free | grep Mem"),
        exec(node.host, node.user, "df -h / | tail -1"),
        exec(node.host, node.user, "nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null || echo 'no gpu'"),
        exec(node.host, node.user, `ps aux | grep -E 'openclaw-gateway|openclaw-${node.controlAgent}|firefox|geckodriver' | grep -v grep | awk '{print $11}'`),
      ]);

      const isOnline = uptimeRes.code === 0;
      const procs = isOnline ? (procRes.stdout || '') : '';

      const cpuLine = cpuRes.stdout.trim();
      const cpuUser = parseFloat(cpuLine.match(/([\d.]+)\s*us/)?.[1]) || 0;
      const cpuSys = parseFloat(cpuLine.match(/([\d.]+)\s*sy/)?.[1]) || 0;
      const cpuIdle = parseFloat(cpuLine.match(/([\d.]+)\s*id/)?.[1]) || 0;

      const memParts = memRes.stdout.trim().split(/\s+/);
      const memTotal = parseInt(memParts[1]) || 0;
      const memUsed = parseInt(memParts[2]) || 0;
      const memPercent = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;

      const diskParts = diskRes.stdout.trim().split(/\s+/);
      const diskUsed = diskParts[1] || '-';
      const diskTotal = diskParts[2] || '-';
      const diskPercent = parseInt(diskParts[4]?.replace('%', '')) || 0;

      const gpuLine = gpuRes.stdout.trim();
      let gpuName = '';
      let gpuMemPct = 0;
      let gpuMemUsedStr = '';
      let gpuMemTotalStr = '';
      if (gpuLine && !gpuLine.includes('no gpu')) {
        const parts = gpuLine.split(',');
        gpuName = parts[0]?.trim() || gpuLine;
        const gmu = parseInt(parts[1]?.trim() || '0');
        const gmt = parseInt(parts[2]?.trim() || '0');
        gpuMemPct = gmt > 0 ? (gmu / gmt) * 100 : 0;
        gpuMemUsedStr = `${(gmu / 1024).toFixed(0)}G`;
        gpuMemTotalStr = `${(gmt / 1024).toFixed(0)}G`;
      }

      const uptimeLine = uptimeRes.stdout;
      const uptimeMatch = uptimeLine.match(/up\s+(.+?)\s+load/);
      const hostname = uptimeLine.split('\n')[0]?.trim() || '-';

      setNodeStatuses((prev) => ({
        ...prev,
        [node.id]: {
          online: isOnline,
          hostname,
          uptime: uptimeMatch ? uptimeMatch[1] : '-',
          cpuUser, cpuSys, cpuIdle,
          memoryPercent: memPercent,
          memoryUsed: `${(memUsed / 1024 / 1024 / 1024).toFixed(1)}G`,
          memoryTotal: `${(memTotal / 1024 / 1024 / 1024).toFixed(1)}G`,
          diskPercent,
          diskUsed,
          diskTotal,
          gpu: gpuName || '未检测到GPU',
          gpuMemoryPercent: gpuMemPct,
          gpuMemoryUsed: gpuMemUsedStr,
          gpuMemoryTotal: gpuMemTotalStr,
          gateway: procs.includes('openclaw-gateway') ? 'running' : 'stopped',
          agent: procs.includes(`openclaw-${node.controlAgent}`) ? 'running' : 'stopped',
          browser: procs.includes('firefox') ? 'running' : 'stopped',
          geckodriver: procs.includes('geckodriver') ? 'running' : 'stopped',
          error: !isOnline ? (uptimeRes.stderr || 'connection failed') : undefined,
        },
      }));
    } catch (e) {
      setNodeStatuses((prev) => ({
        ...prev,
        [node.id]: {
          online: false, hostname: '-', uptime: '-',
          cpuUser: 0, cpuSys: 0, cpuIdle: 0,
          memoryPercent: 0, memoryUsed: '-', memoryTotal: '-',
          diskPercent: 0, diskUsed: '-', diskTotal: '-',
          gpu: '错误', gpuMemoryPercent: 0, gpuMemoryUsed: '', gpuMemoryTotal: '',
          gateway: 'unknown', agent: 'unknown', browser: 'unknown', geckodriver: 'unknown',
          error: String(e),
        },
      }));
    } finally {
      if (!silent) setLoading((prev) => ({ ...prev, [node.id]: false }));
    }
  }, [exec]);

  const refreshAll = useCallback(async () => {
    await Promise.all(nodes.map((node) => getNodeStatus(node)));
  }, [nodes, getNodeStatus]);

  const handleAction = useCallback(async (node: NodeConfig, action: string) => {
    const commands: Record<string, { label: string; cmd: string }> = {
      'gateway-restart': {
        label: '重启 Gateway',
        cmd: `pkill -f openclaw-gateway; sleep 1; nohup openclaw gateway --port 18789 --auth none > /tmp/gw.log 2>&1 & echo "done"`,
      },
      'agent-restart': {
        label: '重启 Agent',
        cmd: `pkill -f "openclaw-${node.controlAgent}"; sleep 1; nohup openclaw start --name ${node.controlAgent} > /tmp/agent.log 2>&1 & echo "done"`,
      },
      'tail-log': {
        label: '查看日志',
        cmd: 'tail -50 /tmp/gw.log 2>/dev/null || tail -50 ~/.orion-main.log 2>/dev/null || echo "no log"',
      },
    };

    const actionDef = commands[action];
    if (!actionDef) return;

    toast.info(`正在${actionDef.label}...`);
    const result = await exec(node.host, node.user, actionDef.cmd);

    if (action === 'tail-log') {
      setModalText(result.stdout || result.stderr || '(empty)');
      setShowModal(true);
      return;
    }

    if (result.code === 0) {
      toast.success(actionDef.label + '成功');
      setTimeout(() => getNodeStatus(node, true), 2000);
    } else {
      toast.error(actionDef.label + '失败: ' + result.stderr);
    }
  }, [exec, getNodeStatus]);

  const handleScan = useCallback(async () => {
    setScanning(true);
    setScanResults([]);
    setSelectedIPs(new Set());
    const base = scanRange.trim();
    if (!base) { setScanning(false); return; }

    const batchSize = 50;
    const ips = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`);
    const checkOne = (ip: string) => exec(ip, 'root', 'echo ok');

    for (let b = 0; b < ips.length; b += batchSize) {
      const batch = ips.slice(b, b + batchSize);
      const results = await Promise.all(batch.map(checkOne));
      const partial = results.map((r, idx) => ({ ip: batch[idx], online: r.code === 0, selected: false }));
      setScanResults((prev) => [...prev, ...partial]);
    }
    setScanning(false);
  }, [scanRange, exec]);

  const handleAddSelected = useCallback(async () => {
    if (selectedIPs.size === 0) { toast.error('请先选择要添加的节点'); return; }
    try {
      const settings = await hostApiFetch<Record<string, unknown>>('/api/settings');
      const existingNodes = (settings?.nodes as NodeConfig[] | undefined) || [];
      const newNodes = Array.from(selectedIPs).map((ip) => ({
        id: ip,
        name: ip,
        host: ip,
        user: 'root',
        controlAgent: '',
        description: '',
      }));
      await invokeIpc('settings:setMany', { nodes: [...existingNodes, ...newNodes] });
      toast.success(`已添加 ${selectedIPs.size} 个节点`);
      setShowAddModal(false);
      setSelectedIPs(new Set());
      setScanResults([]);
      loadNodes();
    } catch (e) {
      toast.error(`添加失败: ${e}`);
    }
  }, [selectedIPs, loadNodes]);

  useEffect(() => { loadNodes(); }, [loadNodes]);

  useEffect(() => {
    if (nodes.length === 0) return;
    refreshAll();
    const interval = setInterval(refreshAll, 30000);
    return () => clearInterval(interval);
  }, [nodes, refreshAll]);

  const onlineCount = Object.values(nodeStatuses).filter((s) => s?.online).length;

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(180deg, #0f0f1a 0%, #1a1a2e 100%)',
      padding: 32,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: '#fff', display: 'flex', alignItems: 'center', gap: 10 }}>
            <Terminal size={22} />
            星穹
          </h1>
          <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>
            {nodes.length} 个节点 · {onlineCount} 在线
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button size="sm" variant="outline" onClick={() => setShowAddModal(true)}
            style={{ borderColor: 'rgba(255,255,255,0.1)', color: '#fff', background: 'rgba(255,255,255,0.04)' }}>
            <Plus size={13} style={{ marginRight: 6 }} />添加节点
          </Button>
          <Button size="sm" variant="outline" onClick={refreshAll} disabled={Object.values(loading).some(Boolean)}
            style={{ borderColor: 'rgba(255,255,255,0.1)', color: '#fff', background: 'rgba(255,255,255,0.04)' }}>
            <RefreshCw size={13} className={Object.values(loading).some(Boolean) ? 'animate-spin' : ''} style={{ marginRight: 6 }} />
            刷新全部
          </Button>
        </div>
      </div>

      {initError && (
        <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 12, padding: '14px 18px', marginBottom: 20 }}>
          <p style={{ color: '#ef4444', fontSize: 13 }}>{initError}</p>
        </div>
      )}

      {/* Node Cards Grid */}
      {nodes.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 16 }}>
          {nodes.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              status={nodeStatuses[node.id] || null}
              onRefresh={() => getNodeStatus(node)}
              onAction={(action) => handleAction(node, action)}
              loading={!!loading[node.id]}
            />
          ))}
        </div>
      )}

      <div style={{ marginTop: 24, fontSize: 11, color: 'rgba(255,255,255,0.2)', textAlign: 'center' }}>
        每 30 秒自动刷新 · 配置：~/.config/orion-ui/orion-settings.json
      </div>

      {showModal && <LogModal text={modalText} onClose={() => setShowModal(false)} />}

      {/* Add Node Modal */}
      {showAddModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 100,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }} onClick={() => { setShowAddModal(false); setScanResults([]); }}>
          <div style={{
            background: '#1a1a2e', borderRadius: 16, padding: 28,
            maxWidth: 480, width: '100%',
            border: '1px solid rgba(255,255,255,0.1)',
          }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ color: '#fff', fontWeight: 700, fontSize: 16, marginBottom: 20 }}>添加节点</h3>

            {/* Scan input */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <div style={{ flex: 1, position: 'relative' }}>
                <span style={{
                  position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
                  fontSize: 12, color: 'rgba(255,255,255,0.3)', fontFamily: 'monospace',
                }}>IP 前缀</span>
                <input
                  value={scanRange}
                  onChange={(e) => setScanRange(e.target.value)}
                  placeholder="192.168.5"
                  disabled={scanning}
                  style={{
                    width: '100%', padding: '10px 10px 10px 75px',
                    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 8, color: '#fff', fontSize: 13, fontFamily: 'monospace', outline: 'none',
                  }}
                />
              </div>
              <Button onClick={handleScan} disabled={scanning} style={{ background: '#3b82f6', color: '#fff', whiteSpace: 'nowrap' }}>
                {scanning ? '扫描中...' : 'Ping 扫描'}
              </Button>
            </div>

            {/* Scan results */}
            {scanResults.length > 0 && (
              <div style={{ maxHeight: 280, overflow: 'auto', marginBottom: 16 }}>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8, fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
                  <span>在线 {scanResults.filter((r) => r.online).length} · 已选 {selectedIPs.size}</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
                  {scanResults.filter((r) => r.online).map((r) => (
                    <div
                      key={r.ip}
                      onClick={() => {
                        const next = new Set(selectedIPs);
                        if (next.has(r.ip)) next.delete(r.ip);
                        else next.add(r.ip);
                        setSelectedIPs(next);
                      }}
                      style={{
                        padding: '8px 12px',
                        borderRadius: 8,
                        background: selectedIPs.has(r.ip) ? 'rgba(59,130,246,0.2)' : 'rgba(255,255,255,0.04)',
                        border: selectedIPs.has(r.ip) ? '1px solid rgba(59,130,246,0.5)' : '1px solid rgba(255,255,255,0.08)',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      <div style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: selectedIPs.has(r.ip) ? '#3b82f6' : '#10b981',
                      }} />
                      <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#fff' }}>{r.ip}</span>
                      {selectedIPs.has(r.ip) && <span style={{ marginLeft: 'auto', fontSize: 10, color: '#3b82f6' }}>✓</span>}
                    </div>
                  ))}
                </div>
                {scanResults.filter((r) => r.online).length === 0 && (
                  <div style={{ textAlign: 'center', padding: '20px 0', color: 'rgba(255,255,255,0.3)', fontSize: 13 }}>
                    未扫描到在线设备
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <Button onClick={handleAddSelected} disabled={selectedIPs.size === 0}
                style={{ flex: 1, background: '#3b82f6', color: '#fff', opacity: selectedIPs.size === 0 ? 0.5 : 1 }}>
                添加 {selectedIPs.size > 0 ? `${selectedIPs.size} 个` : ''}节点
              </Button>
              <Button variant="outline" onClick={() => { setShowAddModal(false); setScanResults([]); setSelectedIPs(new Set()); }}
                style={{ borderColor: 'rgba(255,255,255,0.1)', color: '#fff' }}>
                取消
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
