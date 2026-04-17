/**
 * Gateway Status Banner
 * Shows a non-intrusive banner when the gateway is disconnected or reconnecting.
 * Auto-dismisses when connection is restored.
 */
import { useEffect, useState } from 'react';
import { AlertCircle, Loader2, WifiOff } from 'lucide-react';
import { useGatewayStore } from '@/stores/gateway';

export function GatewayStatusBanner() {
  const status = useGatewayStore((s) => s.status);
  const [dismissed, setDismissed] = useState(false);

  // Re-show banner when status changes
  useEffect(() => {
    setDismissed(false);
  }, [status.state]);

  if (status.state === 'running' || dismissed) return null;

  const isReconnecting = status.state === 'reconnecting' || status.state === 'starting';
  const isError = status.state === 'error' || status.state === 'stopped';

  return (
    <div
      className="flex items-center justify-center gap-2 px-4 py-1.5 text-sm transition-all"
      style={{
        background: isReconnecting ? 'rgba(234, 179, 8, 0.15)' : 'rgba(239, 68, 68, 0.12)',
        borderBottom: `1px solid ${isReconnecting ? 'rgba(234, 179, 8, 0.3)' : 'rgba(239, 68, 68, 0.25)'}`,
        color: isReconnecting ? '#facc15' : '#f87171',
      }}
    >
      {isReconnecting ? (
        <>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>连接中断，正在恢复...</span>
        </>
      ) : (
        <>
          <WifiOff className="h-3.5 w-3.5" />
          <span>后端服务已断开</span>
          <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: '12px' }}>
            ({status.error || '请检查网络连接'})
          </span>
          <button
            onClick={() => setDismissed(true)}
            style={{
              marginLeft: '8px',
              padding: '1px 8px',
              borderRadius: '4px',
              border: '1px solid rgba(255,255,255,0.2)',
              background: 'transparent',
              color: 'rgba(255,255,255,0.6)',
              fontSize: '12px',
              cursor: 'pointer',
            }}
          >
            忽略
          </button>
        </>
      )}
    </div>
  );
}
