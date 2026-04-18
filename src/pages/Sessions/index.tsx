/**
 * Sessions — God View: All sessions from all gateways
 */
import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useMultiGatewaySessions, groupSessionsByTime, getSessionDisplayLabel, formatSessionAge } from '@/hooks/useMultiGatewaySessions';
import { invokeIpc } from '@/lib/api-client';
import { RefreshCw, Server, Monitor, Clock } from 'lucide-react';

function RemoteCard({ remote }: { remote: ReturnType<typeof useMultiGatewaySessions>['remotes'][0] }) {
  const [expanded, setExpanded] = useState(false);
  const sessions = remote.sessions || [];
  const grouped = groupSessionsByTime(sessions);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server className="w-4 h-4 text-muted-foreground" />
            <CardTitle className="text-sm">{remote.label}</CardTitle>
            <Badge variant="outline" className="text-xs">{remote.host}</Badge>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={sessions.length > 0 ? 'default' : 'outline'} className="text-xs">
              {sessions.length} session{sessions.length !== 1 ? 's' : ''}
            </Badge>
            {remote.lastUpdated && (
              <span className="text-xs text-muted-foreground">
                {formatSessionAge(remote.lastUpdated.getTime())}
              </span>
            )}
            <button
              className="p-1 hover:bg-muted rounded transition-colors"
              onClick={() => setExpanded(!expanded)}
            >
              <span className="text-xs">{expanded ? '▲' : '▼'}</span>
            </button>
          </div>
        </div>
      </CardHeader>
      {expanded && (
        <CardContent className="pt-2">
          {sessions.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">No sessions</p>
          ) : (
            <div className="space-y-3">
              {Object.entries(grouped).map(([group, groupSessions]) => (
                <div key={group}>
                  <p className="text-xs font-medium text-muted-foreground mb-1">{group}</p>
                  <div className="space-y-1">
                    {groupSessions.map((session) => (
                      <SessionRow key={session.key} session={session} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function SessionRow({ session }: { session: ReturnType<typeof useMultiGatewaySessions>['sessions'][0] }) {
  const label = getSessionDisplayLabel(session);
  const age = formatSessionAge(session.updatedAt);

  return (
    <div className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/50 transition-colors">
      <div className="flex items-center gap-2 min-w-0">
        <Monitor className="w-3 h-3 text-muted-foreground shrink-0" />
        <span className="text-sm truncate">{label}</span>
        <Badge variant="secondary" className="text-xs shrink-0">{session.agentId}</Badge>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {session.model && (
          <span className="text-xs text-muted-foreground hidden sm:inline">{session.model}</span>
        )}
        <span className="text-xs text-muted-foreground">{age}</span>
      </div>
    </div>
  );
}

export default function Sessions() {
  const { sessions, remotes, loading, error, lastUpdated, refetch } = useMultiGatewaySessions();
  const grouped = groupSessionsByTime(sessions);
  const totalCount = sessions.length;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">所有会话 · God View</h1>
          <p className="text-sm text-muted-foreground">
            {totalCount} 个会话 across {remotes.length} 个节点
            {lastUpdated && (
              <span className="ml-2">· 上次更新 {formatSessionAge(lastUpdated.getTime())}</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border hover:bg-muted/50 transition-colors disabled:opacity-50"
            onClick={refetch}
            disabled={loading}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </button>
        </div>
      </div>

      {error && (
        <Card className="border-red-500/50">
          <CardContent className="pt-4">
            <p className="text-sm text-red-500">Error: {error}</p>
          </CardContent>
        </Card>
      )}

      {/* Remote gateways */}
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">远程节点</h2>
        {remotes.length === 0 ? (
          <Card><CardContent className="pt-4"><p className="text-sm text-muted-foreground">No remote gateways configured</p></CardContent></Card>
        ) : (
          remotes.map((remote, i) => (
            <RemoteCard key={i} remote={remote} />
          ))
        )}
      </div>

      {/* All sessions grouped by time */}
      {sessions.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">所有会话（按时间）</h2>
          <Card>
            <CardContent className="pt-4 space-y-4">
              {Object.entries(grouped).map(([group, groupSessions]) => (
                <div key={group}>
                  <p className="text-xs font-medium text-muted-foreground mb-2">{group} · {groupSessions.length}</p>
                  <div className="space-y-0.5">
                    {groupSessions.map((session) => (
                      <SessionRow key={session.key} session={session} />
                    ))}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Empty state */}
      {!loading && sessions.length === 0 && !error && (
        <Card>
          <CardContent className="pt-8 pb-8 text-center">
            <Monitor className="w-12 h-12 mx-auto text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No sessions found</p>
            <p className="text-xs text-muted-foreground mt-1">Remote sessions will appear here</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
