import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type {
  ActiveWorkspace,
  CabinSnapshot,
  ChatMessage,
  Notebook,
  NotebookChat,
  RecentChat,
} from '../types/notebook';

const STORAGE_KEY = 'ignis_notebook_workspace_v1';

const DEFAULT_SNAPSHOT: CabinSnapshot = {
  oxygenPct: 21.0,
  pressureKpa: 101.3,
  flowVelocityCmS: 10.0,
  gravityG: 0.0,
  fuelMaterial: 'PMMA',
  diluentGas: 'N2',
  riskIndex: 42,
};

function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function formatRelativeTime(timestampMs: number, nowMs = Date.now()): string {
  const diffSec = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export function formatNotebookMeta(nb: Notebook, nowMs = Date.now()): string {
  const rel = formatRelativeTime(nb.updatedAt, nowMs);
  const chatCount = nb.chats.length;
  const chatLabel = chatCount === 1 ? '1 chat' : `${chatCount} chats`;
  const runLabel = nb.runCount === 1 ? '1 run' : `${nb.runCount} runs`;
  return `${chatLabel} • ${runLabel} • ${rel}`;
}

export function formatChatMeta(
  chat: Pick<RecentChat | NotebookChat, 'messages' | 'updatedAt'>,
  nowMs = Date.now()
): string {
  const rel = formatRelativeTime(chat.updatedAt, nowMs);
  const msgCount = chat.messages.length;
  const msgLabel = msgCount === 1 ? '1 msg' : `${msgCount} msgs`;
  return `${msgLabel} • ${rel}`;
}

function buildSeedState(): { notebooks: Notebook[]; recentChats: RecentChat[] } {
  const now = Date.now();
  return {
    notebooks: [
      {
        id: 'nb-artemis-pmma',
        title: 'Artemis 34% O₂ PMMA Ignition',
        runCount: 4,
        createdAt: now - 1000 * 60 * 90,
        updatedAt: now - 1000 * 60 * 12,
        snapshot: {
          oxygenPct: 34.0,
          pressureKpa: 56.5,
          flowVelocityCmS: 5.0,
          gravityG: 0.16,
          fuelMaterial: 'PMMA',
          diluentGas: 'N2',
          riskIndex: 88,
        },
        activeChatId: 'nbc-artemis-1',
        chats: [
          {
            id: 'nbc-artemis-1',
            title: 'PMMA LOI Margin Analysis',
            sessionId: 'nb:nb-artemis-pmma:nbc-artemis-1',
            createdAt: now - 1000 * 60 * 90,
            updatedAt: now - 1000 * 60 * 12,
            messages: [
              {
                id: 'msg-nb-1',
                role: 'user',
                content: 'Evaluate PMMA LOI shift at 34% O2, 56.5 kPa, 0.16g.',
                timestamp: now - 1000 * 60 * 14,
              },
              {
                id: 'msg-nb-2',
                role: 'assistant',
                content:
                  'PMMA Risk Index: 88/100 (CRITICAL). O2 margin +16.4% above LOI (17.6%). Recommend Nomex/PTFE barrier substitution.',
                timestamp: now - 1000 * 60 * 12,
                citations: [{ id: 'DOC-02', label: 'DOC-02 p.2', page: 2 }],
                groundingPct: 100,
              },
            ],
          },
          {
            id: 'nbc-artemis-2',
            title: 'Nomex / PTFE Barrier Substitution',
            sessionId: 'nb:nb-artemis-pmma:nbc-artemis-2',
            createdAt: now - 1000 * 60 * 60,
            updatedAt: now - 1000 * 60 * 35,
            messages: [],
          },
        ],
      },
      {
        id: 'nb-bass-paradox',
        title: 'BASS-II 8 cm/s Flow Paradox',
        runCount: 6,
        createdAt: now - 1000 * 60 * 240,
        updatedAt: now - 1000 * 60 * 48,
        snapshot: {
          oxygenPct: 21.0,
          pressureKpa: 101.3,
          flowVelocityCmS: 8.0,
          gravityG: 0.0,
          fuelMaterial: 'Cotton-Fiberglass',
          diluentGas: 'N2',
          riskIndex: 67,
        },
        activeChatId: 'nbc-bass-1',
        chats: [
          {
            id: 'nbc-bass-1',
            title: 'Opposed-Flow Extinction Curve',
            sessionId: 'nb:nb-bass-paradox:nbc-bass-1',
            createdAt: now - 1000 * 60 * 240,
            updatedAt: now - 1000 * 60 * 48,
            messages: [],
          },
        ],
      },
    ],
    recentChats: [
      {
        id: 'chat-flex-cool',
        title: 'FLEX-2 Heptane Cool-Flame Threshold',
        sessionId: 'chat:chat-flex-cool',
        createdAt: now - 1000 * 60 * 40,
        updatedAt: now - 1000 * 60 * 18,
        messages: [
          {
            id: 'msg-rc-1',
            role: 'user',
            content: 'Peak temperature and extinction diameter for FLEX-2 cool flames?',
            timestamp: now - 1000 * 60 * 19,
          },
          {
            id: 'msg-rc-2',
            role: 'assistant',
            content:
              'FLEX-2 cool flames stabilize at 650–800 K post-radiative extinction with sub-visible OH* emission.',
            timestamp: now - 1000 * 60 * 18,
            citations: [{ id: 'DOC-03', label: 'DOC-03 p.1', page: 1 }],
            groundingPct: 100,
          },
        ],
      },
      {
        id: 'chat-saffire-spread',
        title: 'SAFFIRE-IV Cygnus Duct Spread Rate',
        sessionId: 'chat:chat-saffire-spread',
        createdAt: now - 1000 * 60 * 130,
        updatedAt: now - 1000 * 60 * 75,
        messages: [
          {
            id: 'msg-rc-3',
            role: 'user',
            content: 'Compare SAFFIRE-IV vs BASS-II opposed flow flame spread.',
            timestamp: now - 1000 * 60 * 75,
          },
        ],
      },
    ],
  };
}

function normalizeNotebook(raw: Partial<Notebook> & { messages?: ChatMessage[] }): Notebook {
  const now = Date.now();
  const id = raw.id || createId('nb');
  let chats: NotebookChat[] = Array.isArray(raw.chats) ? raw.chats : [];
  if (chats.length === 0) {
    const cid = createId('nbc');
    chats = [
      {
        id: cid,
        title: 'Main Research Chat',
        sessionId: `nb:${id}:${cid}`,
        createdAt: raw.createdAt ?? now,
        updatedAt: raw.updatedAt ?? now,
        messages: Array.isArray(raw.messages) ? raw.messages : [],
      },
    ];
  }
  const activeChatId =
    raw.activeChatId && chats.some((c) => c.id === raw.activeChatId)
      ? raw.activeChatId
      : chats[0].id;
  return {
    id,
    title: raw.title || 'Untitled Notebook',
    runCount: typeof raw.runCount === 'number' ? raw.runCount : 0,
    createdAt: raw.createdAt ?? now,
    updatedAt: raw.updatedAt ?? now,
    snapshot: { ...DEFAULT_SNAPSHOT, ...(raw.snapshot ?? {}) },
    activeChatId,
    chats,
  };
}

interface PersistedWorkspace {
  notebooks: Notebook[];
  recentChats: RecentChat[];
  isSidebarOpen?: boolean;
  expandedNotebookIds?: string[];
}

function loadInitialState(): PersistedWorkspace {
  if (typeof window === 'undefined') {
    return { ...buildSeedState(), isSidebarOpen: true, expandedNotebookIds: [] };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...buildSeedState(), isSidebarOpen: true, expandedNotebookIds: [] };
    const parsed = JSON.parse(raw) as Partial<PersistedWorkspace>;
    if (Array.isArray(parsed.notebooks) && Array.isArray(parsed.recentChats)) {
      return {
        notebooks: parsed.notebooks.map(normalizeNotebook),
        recentChats: parsed.recentChats,
        isSidebarOpen: parsed.isSidebarOpen ?? true,
        expandedNotebookIds: Array.isArray(parsed.expandedNotebookIds)
          ? parsed.expandedNotebookIds
          : [],
      };
    }
  } catch {
    // Fallback cleanly to seed state on corrupt storage
  }
  return { ...buildSeedState(), isSidebarOpen: true, expandedNotebookIds: [] };
}

export interface NotebookStateContextValue {
  notebooks: Notebook[];
  recentChats: RecentChat[];
  activeWorkspace: ActiveWorkspace;
  activeNotebook: Notebook | null;
  activeNotebookChat: NotebookChat | null;
  activeRecentChat: RecentChat | null;
  activeSessionId: string;
  isSidebarOpen: boolean;
  expandedNotebookIds: string[];
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  toggleNotebookExpanded: (notebookId: string) => void;
  openDashboard: () => void;
  selectNotebook: (notebookId: string) => void;
  selectNotebookChat: (notebookId: string, chatId: string) => void;
  selectRecentChat: (chatId: string) => void;
  createNotebook: (title: string, snapshot?: Partial<CabinSnapshot>) => Notebook;
  createNotebookChat: (notebookId: string, title?: string) => NotebookChat | null;
  deleteNotebookChat: (notebookId: string, chatId: string) => void;
  createRecentChat: (title?: string) => RecentChat;
  appendMessageToActiveSession: (
    message: Omit<ChatMessage, 'id' | 'timestamp'>
  ) => void;
  updateNotebookSnapshot: (
    notebookId: string,
    snapshot: Partial<CabinSnapshot>,
    incrementRuns?: number
  ) => void;
  moveChatToNotebook: (
    chatId: string,
    targetNotebookId: string | 'new',
    newNotebookTitle?: string
  ) => string | null;
  deleteNotebook: (notebookId: string) => void;
  deleteRecentChat: (chatId: string) => void;
}

const NotebookStateContext = createContext<NotebookStateContextValue | null>(null);

export const NotebookStateProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const initial = useMemo(() => loadInitialState(), []);
  const [notebooks, setNotebooks] = useState<Notebook[]>(initial.notebooks);
  const [recentChats, setRecentChats] = useState<RecentChat[]>(initial.recentChats);
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(
    initial.isSidebarOpen ?? true
  );
  const [expandedNotebookIds, setExpandedNotebookIds] = useState<string[]>(
    initial.expandedNotebookIds ?? []
  );
  const [activeWorkspace, setActiveWorkspace] = useState<ActiveWorkspace>({
    kind: 'dashboard',
  });

  useEffect(() => {
    try {
      const payload: PersistedWorkspace = {
        notebooks,
        recentChats,
        isSidebarOpen,
        expandedNotebookIds,
      };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore storage quota restrictions
    }
  }, [notebooks, recentChats, isSidebarOpen, expandedNotebookIds]);

  const toggleSidebar = useCallback(() => {
    setIsSidebarOpen((prev) => !prev);
  }, []);

  const setSidebarOpen = useCallback((open: boolean) => {
    setIsSidebarOpen(open);
  }, []);

  const toggleNotebookExpanded = useCallback((notebookId: string) => {
    setExpandedNotebookIds((prev) =>
      prev.includes(notebookId)
        ? prev.filter((id) => id !== notebookId)
        : [...prev, notebookId]
    );
  }, []);

  const openDashboard = useCallback(() => {
    setActiveWorkspace({ kind: 'dashboard' });
  }, []);

  const selectNotebook = useCallback(
    (notebookId: string) => {
      const target = notebooks.find((n) => n.id === notebookId);
      const chatId = target?.activeChatId || target?.chats[0]?.id || '';
      setActiveWorkspace({ kind: 'notebook', notebookId, chatId });
    },
    [notebooks]
  );

  const selectNotebookChat = useCallback((notebookId: string, chatId: string) => {
    setNotebooks((prev) =>
      prev.map((nb) => (nb.id === notebookId ? { ...nb, activeChatId: chatId } : nb))
    );
    setActiveWorkspace({ kind: 'notebook', notebookId, chatId });
  }, []);

  const selectRecentChat = useCallback((chatId: string) => {
    setActiveWorkspace({ kind: 'chat', chatId });
  }, []);

  const createNotebook = useCallback(
    (title: string, snapshot?: Partial<CabinSnapshot>): Notebook => {
      const now = Date.now();
      const id = createId('nb');
      const chatId = createId('nbc');
      const firstChat: NotebookChat = {
        id: chatId,
        title: 'Main Research Chat',
        sessionId: `nb:${id}:${chatId}`,
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      const notebook: Notebook = {
        id,
        title: title.trim() || 'Untitled Notebook',
        runCount: 0,
        createdAt: now,
        updatedAt: now,
        snapshot: { ...DEFAULT_SNAPSHOT, ...snapshot },
        activeChatId: chatId,
        chats: [firstChat],
      };
      setNotebooks((prev) => [notebook, ...prev]);
      setExpandedNotebookIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
      setActiveWorkspace({ kind: 'notebook', notebookId: id, chatId });
      return notebook;
    },
    []
  );

  const createNotebookChat = useCallback(
    (notebookId: string, title?: string): NotebookChat | null => {
      const now = Date.now();
      const target = notebooks.find((n) => n.id === notebookId);
      if (!target) return null;
      const chatId = createId('nbc');
      const chat: NotebookChat = {
        id: chatId,
        title: title?.trim() || `Chat ${target.chats.length + 1}`,
        sessionId: `nb:${notebookId}:${chatId}`,
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      setNotebooks((prev) =>
        prev.map((nb) =>
          nb.id === notebookId
            ? {
                ...nb,
                updatedAt: now,
                activeChatId: chatId,
                chats: [chat, ...nb.chats],
              }
            : nb
        )
      );
      setExpandedNotebookIds((prev) =>
        prev.includes(notebookId) ? prev : [...prev, notebookId]
      );
      setActiveWorkspace({ kind: 'notebook', notebookId, chatId });
      return chat;
    },
    [notebooks]
  );

  const deleteNotebookChat = useCallback(
    (notebookId: string, chatId: string) => {
      const now = Date.now();
      let nextChatId = '';
      setNotebooks((prev) =>
        prev.map((nb) => {
          if (nb.id !== notebookId) return nb;
          let remaining = nb.chats.filter((c) => c.id !== chatId);
          if (remaining.length === 0) {
            const freshId = createId('nbc');
            remaining = [
              {
                id: freshId,
                title: 'Main Research Chat',
                sessionId: `nb:${notebookId}:${freshId}`,
                createdAt: now,
                updatedAt: now,
                messages: [],
              },
            ];
          }
          nextChatId =
            nb.activeChatId === chatId ? remaining[0].id : nb.activeChatId;
          return {
            ...nb,
            updatedAt: now,
            activeChatId: nextChatId,
            chats: remaining,
          };
        })
      );
      setActiveWorkspace((curr) =>
        curr.kind === 'notebook' &&
        curr.notebookId === notebookId &&
        curr.chatId === chatId
          ? { kind: 'notebook', notebookId, chatId: nextChatId }
          : curr
      );
    },
    []
  );

  const createRecentChat = useCallback((title = 'New Research Thread'): RecentChat => {
    const now = Date.now();
    const id = createId('chat');
    const chat: RecentChat = {
      id,
      title: title.trim() || 'New Research Thread',
      sessionId: `chat:${id}`,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    setRecentChats((prev) => [chat, ...prev]);
    setActiveWorkspace({ kind: 'chat', chatId: id });
    return chat;
  }, []);

  /**
   * Strict Thread Isolation:
   * - If activeWorkspace is a Notebook chat, messages write EXCLUSIVELY to that Notebook chat.
   *   `recentChats` is never mutated or polluted.
   */
  const appendMessageToActiveSession = useCallback(
    (message: Omit<ChatMessage, 'id' | 'timestamp'>) => {
      const now = Date.now();
      const entry: ChatMessage = {
        ...message,
        id: createId('msg'),
        timestamp: now,
      };

      if (activeWorkspace.kind === 'notebook') {
        const { notebookId, chatId } = activeWorkspace;
        setNotebooks((prev) =>
          prev.map((nb) => {
            if (nb.id !== notebookId) return nb;
            const targetChatId = chatId || nb.activeChatId || nb.chats[0]?.id;
            return {
              ...nb,
              updatedAt: now,
              chats: nb.chats.map((c) => {
                if (c.id !== targetChatId) return c;
                const autoTitle =
                  c.messages.length === 0 &&
                  entry.role === 'user' &&
                  (c.title === 'Main Research Chat' || /^Chat \d+$/.test(c.title))
                    ? entry.content.slice(0, 40).trim()
                    : c.title;
                return {
                  ...c,
                  title: autoTitle || c.title,
                  updatedAt: now,
                  messages: [...c.messages, entry],
                };
              }),
            };
          })
        );
        return;
      }

      if (activeWorkspace.kind === 'chat') {
        const targetChatId = activeWorkspace.chatId;
        setRecentChats((prev) =>
          prev.map((chat) => {
            if (chat.id !== targetChatId) return chat;
            const autoTitle =
              chat.messages.length === 0 && entry.role === 'user'
                ? entry.content.slice(0, 48).trim()
                : chat.title;
            return {
              ...chat,
              title: autoTitle || chat.title,
              updatedAt: now,
              messages: [...chat.messages, entry],
            };
          })
        );
        return;
      }

      const newId = createId('chat');
      const created: RecentChat = {
        id: newId,
        title:
          entry.role === 'user'
            ? entry.content.slice(0, 48).trim() || 'Research Query'
            : 'Research Query',
        sessionId: `chat:${newId}`,
        createdAt: now,
        updatedAt: now,
        messages: [entry],
      };
      setRecentChats((prev) => [created, ...prev]);
      setActiveWorkspace({ kind: 'chat', chatId: newId });
    },
    [activeWorkspace]
  );

  const updateNotebookSnapshot = useCallback(
    (notebookId: string, snapshot: Partial<CabinSnapshot>, incrementRuns = 1) => {
      const now = Date.now();
      setNotebooks((prev) =>
        prev.map((nb) =>
          nb.id === notebookId
            ? {
                ...nb,
                updatedAt: now,
                runCount: nb.runCount + incrementRuns,
                snapshot: { ...nb.snapshot, ...snapshot },
              }
            : nb
        )
      );
    },
    []
  );

  const moveChatToNotebook = useCallback(
    (
      chatId: string,
      targetNotebookId: string | 'new',
      newNotebookTitle?: string
    ): string | null => {
      const sourceChat = recentChats.find((c) => c.id === chatId);
      if (!sourceChat) return null;

      const now = Date.now();
      let destinationId = targetNotebookId;
      let destinationChatId = createId('nbc');

      if (targetNotebookId === 'new') {
        const createdId = createId('nb');
        destinationId = createdId;
        const importedChat: NotebookChat = {
          id: destinationChatId,
          title: sourceChat.title || 'Imported Chat',
          sessionId: `nb:${createdId}:${destinationChatId}`,
          createdAt: sourceChat.createdAt || now,
          updatedAt: now,
          messages: [...sourceChat.messages],
        };
        const createdNotebook: Notebook = {
          id: createdId,
          title: (newNotebookTitle || sourceChat.title).trim() || 'Migrated Notebook',
          runCount: Math.max(1, Math.ceil(sourceChat.messages.length / 2)),
          createdAt: now,
          updatedAt: now,
          snapshot: { ...DEFAULT_SNAPSHOT },
          activeChatId: destinationChatId,
          chats: [importedChat],
        };
        setNotebooks((prev) => [createdNotebook, ...prev]);
      } else {
        const importedChat: NotebookChat = {
          id: destinationChatId,
          title: sourceChat.title || 'Imported Chat',
          sessionId: `nb:${targetNotebookId}:${destinationChatId}`,
          createdAt: sourceChat.createdAt || now,
          updatedAt: now,
          messages: [...sourceChat.messages],
        };
        setNotebooks((prev) =>
          prev.map((nb) =>
            nb.id === targetNotebookId
              ? {
                  ...nb,
                  updatedAt: now,
                  runCount: nb.runCount + Math.max(1, Math.ceil(sourceChat.messages.length / 2)),
                  activeChatId: destinationChatId,
                  chats: [importedChat, ...nb.chats],
                }
              : nb
          )
        );
      }

      setExpandedNotebookIds((prev) =>
        prev.includes(destinationId) ? prev : [...prev, destinationId]
      );
      setRecentChats((prev) => prev.filter((c) => c.id !== chatId));
      setActiveWorkspace({
        kind: 'notebook',
        notebookId: destinationId,
        chatId: destinationChatId,
      });
      return destinationId;
    },
    [recentChats]
  );

  const deleteNotebook = useCallback((notebookId: string) => {
    setNotebooks((prev) => prev.filter((n) => n.id !== notebookId));
    setExpandedNotebookIds((prev) => prev.filter((id) => id !== notebookId));
    setActiveWorkspace((curr) =>
      curr.kind === 'notebook' && curr.notebookId === notebookId
        ? { kind: 'dashboard' }
        : curr
    );
  }, []);

  const deleteRecentChat = useCallback((chatId: string) => {
    setRecentChats((prev) => prev.filter((c) => c.id !== chatId));
    setActiveWorkspace((curr) =>
      curr.kind === 'chat' && curr.chatId === chatId ? { kind: 'dashboard' } : curr
    );
  }, []);

  const activeNotebook = useMemo(() => {
    if (activeWorkspace.kind !== 'notebook') return null;
    return notebooks.find((n) => n.id === activeWorkspace.notebookId) ?? null;
  }, [activeWorkspace, notebooks]);

  const activeNotebookChat = useMemo(() => {
    if (!activeNotebook) return null;
    const cid =
      activeWorkspace.kind === 'notebook' && activeWorkspace.chatId
        ? activeWorkspace.chatId
        : activeNotebook.activeChatId;
    return (
      activeNotebook.chats.find((c) => c.id === cid) ??
      activeNotebook.chats[0] ??
      null
    );
  }, [activeNotebook, activeWorkspace]);

  const activeRecentChat = useMemo(() => {
    if (activeWorkspace.kind !== 'chat') return null;
    return recentChats.find((c) => c.id === activeWorkspace.chatId) ?? null;
  }, [activeWorkspace, recentChats]);

  const activeSessionId = useMemo(() => {
    if (activeNotebookChat) return activeNotebookChat.sessionId;
    if (activeRecentChat) return activeRecentChat.sessionId;
    return 'global:default';
  }, [activeNotebookChat, activeRecentChat]);

  const value: NotebookStateContextValue = {
    notebooks,
    recentChats,
    activeWorkspace,
    activeNotebook,
    activeNotebookChat,
    activeRecentChat,
    activeSessionId,
    isSidebarOpen,
    expandedNotebookIds,
    toggleSidebar,
    setSidebarOpen,
    toggleNotebookExpanded,
    openDashboard,
    selectNotebook,
    selectNotebookChat,
    selectRecentChat,
    createNotebook,
    createNotebookChat,
    deleteNotebookChat,
    createRecentChat,
    appendMessageToActiveSession,
    updateNotebookSnapshot,
    moveChatToNotebook,
    deleteNotebook,
    deleteRecentChat,
  };

  return (
    <NotebookStateContext.Provider value={value}>
      {children}
    </NotebookStateContext.Provider>
  );
};

export function useNotebookState(): NotebookStateContextValue {
  const ctx = useContext(NotebookStateContext);
  if (!ctx) {
    throw new Error('useNotebookState must be used inside NotebookStateProvider');
  }
  return ctx;
}
