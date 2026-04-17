/**
 * Remote Control Page
 * SSH-based remote control for remote ClawX on Ubuntu
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { invokeIpc } from '@/lib/api-client';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

const REMOTE_HOST = '192.168.5.163';
const REMOTE_USER = 'erbro001';

interface SshResult {
  stdout: string;
  stderr: string;
  code: number;
  error?: string;
}

interface ScreenshotResult {
  ok: boolean;
  path?: string;
  error?: string;
}

function OutputBlock({ text }: { text: string }) {
  return (
    <pre style={{
      background: '#1a1a1a',
      color: '#0f0',
      padding: 12,
      borderRadius: 6,
      fontSize: 12,
      maxHeight: 250,
      overflow: 'auto',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-all',
      fontFamily: 'monospace',
    }}>
      {text}
    </pre>
  );
}

export function Remote() {
  const { t } = useTranslation();
  const [cmd, setCmd] = useState('');
  const [output, setOutput] = useState('');
  const [loading, setLoading] = useState(false);
  const [screenshots, setScreenshots] = useState<string[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const autoRefreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const exec = useCallback(async (command: string, silent = false) => {
    if (!silent) setLoading(true);
    setOutput('');
    try {
      const result = await invokeIpc<SshResult>('ssh:exec', REMOTE_HOST, REMOTE_USER, command);
      const out = result.stdout + (result.stderr ? `\nSTDERR: ${result.stderr}` : '');
      if (!silent) setOutput(out || `(exit ${result.code})`);
      return out;
    } catch (e) {
      const errorMsg = `Error: ${e}`;
      if (!silent) {
        setOutput(errorMsg);
        toast.error(errorMsg);
      }
      return errorMsg;
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const handleExec = () => {
    if (!cmd.trim()) return;
    exec(cmd);
  };

  const takeScreenshot = async () => {
    setLoading(true);
    try {
      const result = await invokeIpc<ScreenshotResult>('ssh:screenshot', REMOTE_HOST, REMOTE_USER);
      if (result.ok && result.path) {
        setScreenshots((prev) => [result.path!, ...prev.filter((p) => p !== result.path)]);
        toast.success('Screenshot captured');
      } else {
        toast.error(result.error || 'Screenshot failed');
      }
    } catch (e) {
      toast.error(`${e}`);
    } finally {
      setLoading(false);
    }
  };

  const execQuick = (command: string, silent = false) => exec(command, silent);

  // Auto-refresh: take screenshot every 5s when enabled
  useEffect(() => {
    if (autoRefresh) {
      autoRefreshTimer.current = setInterval(() => {
        takeScreenshot();
      }, 5000);
    } else {
      if (autoRefreshTimer.current) {
        clearInterval(autoRefreshTimer.current);
        autoRefreshTimer.current = null;
      }
    }
    return () => {
      if (autoRefreshTimer.current) clearInterval(autoRefreshTimer.current);
    };
  }, [autoRefresh]);

  // Keyboard shortcut: Ctrl+Enter to exec
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleExec();
    }
  };

  const quickCommands = [
    { label: 'Hostname', cmd: 'hostname' },
    { label: 'Uptime', cmd: 'uptime' },
    { label: 'Remote ClawX Process', cmd: 'ps aux | grep -i clawx | grep -v grep || echo "no ClawX"' },
    { label: 'Window List', cmd: 'wmctrl -l || echo "wmctrl not available"' },
    { label: 'Active Window', cmd: 'xdotool getwindowname $(xdotool search --class ClawX 2>/dev/null | head -1) 2>/dev/null || echo "no window"' },
    { label: 'Memory', cmd: 'free -h' },
    { label: 'Disk', cmd: 'df -h /' },
    { label: 'Network', cmd: 'ip addr show | grep inet' },
  ];

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>Remote Control</h1>
          <p style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>
            {REMOTE_USER}@{REMOTE_HOST}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Auto-refresh (5s)
          </label>
          <Button size="sm" variant="outline" onClick={takeScreenshot} disabled={loading}>
            📸 Screenshot
          </Button>
        </div>
      </div>

      {/* Quick Actions */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Quick Commands</CardTitle>
        </CardHeader>
        <CardContent>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {quickCommands.map((q) => (
              <Button
                key={q.cmd}
                size="sm"
                variant="outline"
                onClick={() => execQuick(q.cmd)}
                disabled={loading}
                title={q.cmd}
              >
                {q.label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* SSH Command Input */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Execute Command</CardTitle>
        </CardHeader>
        <CardContent>
          <div style={{ display: 'flex', gap: 8 }}>
            <Input
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              placeholder={`ssh ${REMOTE_USER}@${REMOTE_HOST} ...`}
              onKeyDown={handleKeyDown}
              disabled={loading}
              style={{ flex: 1, fontFamily: 'monospace', fontSize: 13 }}
            />
            <Button onClick={handleExec} disabled={loading || !cmd.trim()}>
              {loading ? '...' : 'Exec'}
            </Button>
          </div>
          <p style={{ fontSize: 11, color: 'var(--muted-foreground)', marginTop: 6 }}>
            Tip: Ctrl+Enter to execute
          </p>
        </CardContent>
      </Card>

      {/* Output */}
      {output && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Output</CardTitle>
          </CardHeader>
          <CardContent>
            <OutputBlock text={output} />
          </CardContent>
        </Card>
      )}

      {/* Screenshots */}
      {screenshots.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <CardTitle className="text-sm">Screenshots ({screenshots.length})</CardTitle>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setScreenshots([])}
              >
                Clear
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8 }}>
              {screenshots.map((path, i) => (
                <div key={path + i} style={{ flexShrink: 0 }}>
                  <img
                    src={`file://${path}`}
                    alt={`Screenshot ${i + 1}`}
                    title={path}
                    style={{
                      maxHeight: 300,
                      maxWidth: '100%',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      cursor: 'pointer',
                    }}
                    onClick={() => window.open(`file://${path}`, '_blank')}
                  />
                  <p style={{ fontSize: 10, color: 'var(--muted-foreground)', marginTop: 4, textAlign: 'center' }}>
                    #{i + 1}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
