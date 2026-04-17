/**
 * Chat Toolbar
 * Session selector, new session, rename, delete, refresh, and thinking toggle.
 */
import { useMemo, useState, useRef, useEffect } from 'react';
import { RefreshCw, Brain, Bot, ChevronDown, Plus, Trash2, Pencil, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useChatStore } from '@/stores/chat';
import { useAgentsStore } from '@/stores/agents';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';

export function ChatToolbar() {
  const refresh = useChatStore((s) => s.refresh);
  const loading = useChatStore((s) => s.loading);
  const showThinking = useChatStore((s) => s.showThinking);
  const toggleThinking = useChatStore((s) => s.toggleThinking);
  const currentAgentId = useChatStore((s) => s.currentAgentId);
  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const sessions = useChatStore((s) => s.sessions);
  const sessionLabels = useChatStore((s) => s.sessionLabels);
  const switchSession = useChatStore((s) => s.switchSession);
  const newSession = useChatStore((s) => s.newSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const renameSession = useChatStore((s) => s.renameSession);
  const agents = useAgentsStore((s) => s.agents);
  const { t } = useTranslation('chat');

  const [sessionOpen, setSessionOpen] = useState(false);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const currentAgentName = useMemo(
    () => (agents ?? []).find((agent) => agent.id === currentAgentId)?.name ?? currentAgentId,
    [agents, currentAgentId],
  );

  const currentLabel = sessionLabels[currentSessionKey] ?? currentSessionKey;

  // Sort sessions: current first, then by key
  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => {
      if (a.key === currentSessionKey) return -1;
      if (b.key === currentSessionKey) return 1;
      return a.key.localeCompare(b.key);
    });
  }, [sessions, currentSessionKey]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!sessionOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setSessionOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [sessionOpen]);

  // Focus rename input when renaming starts
  useEffect(() => {
    if (renamingKey !== null) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingKey]);

  const handleStartRename = (key: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setRenamingKey(key);
    setRenameValue(sessionLabels[key] ?? key);
    setSessionOpen(true);
  };

  const handleConfirmRename = () => {
    if (renamingKey && renameValue.trim()) {
      renameSession(renamingKey, renameValue.trim());
    }
    setRenamingKey(null);
    setRenameValue('');
  };

  const handleCancelRename = () => {
    setRenamingKey(null);
    setRenameValue('');
  };

  const handleSessionSelect = (key: string) => {
    if (key !== currentSessionKey) {
      switchSession(key);
    }
    setSessionOpen(false);
  };

  const handleNewSession = () => {
    newSession();
    setSessionOpen(false);
  };

  const handleDeleteSession = async (key: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(t('toolbar.confirmDelete', { session: sessionLabels[key] ?? key }))) return;
    await deleteSession(key);
  };

  return (
    <div className="flex items-center gap-2">
      {/* Agent badge */}
      <div className="hidden sm:flex items-center gap-1.5 rounded-full border border-black/10 bg-white/70 px-3 py-1.5 text-[12px] font-medium text-foreground/80 dark:border-white/10 dark:bg-white/5">
        <Bot className="h-3.5 w-3.5 text-primary" />
        <span>{t('toolbar.currentAgent', { agent: currentAgentName })}</span>
      </div>

      {/* Session Dropdown */}
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setSessionOpen((v) => !v)}
          className={cn(
            'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-all',
            'border-black/10 bg-white/70 dark:border-white/10 dark:bg-white/5',
            'hover:bg-black/5 dark:hover:bg-white/10 text-foreground/80 hover:text-foreground',
            sessionOpen && 'bg-black/5 dark:bg-white/10',
          )}
        >
          <span className="max-w-[120px] truncate">{currentLabel}</span>
          <ChevronDown className={cn('h-3 w-3 shrink-0 transition-transform', sessionOpen && 'rotate-180')} />
        </button>

        {sessionOpen && (
          <div className="absolute right-0 top-full mt-1.5 z-50 w-64 rounded-xl border border-black/10 bg-white shadow-lg dark:border-white/10 dark:bg-[#1c1c1c]">
            {/* Session list */}
            <div className="max-h-64 overflow-y-auto py-1">
              {sortedSessions.map((session) => {
                const isCurrent = session.key === currentSessionKey;
                const isRenaming = renamingKey === session.key;
                return (
                  <div key={session.key} className="group flex items-center gap-1 px-2 py-1.5">
                    {/* Radio / active indicator */}
                    <div className={cn('h-1.5 w-1.5 rounded-full shrink-0 mr-1.5', isCurrent ? 'bg-primary' : 'bg-transparent')} />

                    {isRenaming ? (
                      // Rename input
                      <input
                        ref={renameInputRef}
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleConfirmRename();
                          if (e.key === 'Escape') handleCancelRename();
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="flex-1 rounded-md border border-primary/50 bg-transparent px-2 py-0.5 text-[12px] font-medium outline-none"
                      />
                    ) : (
                      <button
                        onClick={() => handleSessionSelect(session.key)}
                        className="flex-1 min-w-0 text-left rounded-md px-2 py-0.5 text-[12px] font-medium truncate hover:bg-black/5 dark:hover:bg-white/10"
                      >
                        {sessionLabels[session.key] ?? session.key}
                      </button>
                    )}

                    {/* Rename button */}
                    {renamingKey !== session.key && (
                      <button
                        onClick={(e) => handleStartRename(session.key, e)}
                        className="hidden group-hover:flex h-6 w-6 items-center justify-center rounded-md hover:bg-black/5 dark:hover:bg-white/10 text-foreground/40 hover:text-foreground"
                        title={t('toolbar.rename')}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                    )}

                    {/* Delete button (not for current session) */}
                    {!isCurrent && renamingKey !== session.key && (
                      <button
                        onClick={(e) => handleDeleteSession(session.key, e)}
                        className="hidden group-hover:flex h-6 w-6 items-center justify-center rounded-md hover:bg-red-500/10 text-foreground/40 hover:text-red-500"
                        title={t('toolbar.delete')}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}

                    {/* Confirm/Cancel rename */}
                    {isRenaming && (
                      <>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleConfirmRename(); }}
                          className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-green-500/10 text-green-600"
                        >
                          <Check className="h-3 w-3" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleCancelRename(); }}
                          className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-red-500/10 text-red-500"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            {/* New Chat */}
            <div className="border-t border-black/5 dark:border-white/5 py-1">
              <button
                onClick={handleNewSession}
                className="flex w-full items-center gap-2 px-3 py-2 text-[12px] font-medium text-primary hover:bg-primary/5 rounded-b-xl"
              >
                <Plus className="h-3.5 w-3.5" />
                {t('toolbar.newChat')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Refresh */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => refresh()}
            disabled={loading}
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t('toolbar.refresh')}</p>
        </TooltipContent>
      </Tooltip>

      {/* Thinking Toggle */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'h-8 w-8',
              showThinking && 'bg-primary/10 text-primary',
            )}
            onClick={toggleThinking}
          >
            <Brain className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{showThinking ? t('toolbar.hideThinking') : t('toolbar.showThinking')}</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
