/**
 * Notebook & Recent-Chat Isolated State Store for Ignis.
 *
 * Guarantees strict thread isolation:
 * - Each Notebook holds its own isolated `chats` array (`nb:<nbId>:<chatId>`).
 * - Messages inside any Notebook chat are stored exclusively inside that Notebook
 *   and never appear in or mutate the global Recent Chats list.
 * - Global standalone threads live in `recentChats` (`chat:<id>`).
 * - "Add to Notebook" transfers a Recent Chat into a target/new Notebook as an
 *   isolated Notebook chat and removes it from Recent Chats.
 */

import { emit, setActiveCabin, state } from './state.js';

const STORAGE_KEY = 'ignis_notebooks_state_v1';

function createId(prefix) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function formatRelativeTime(tsMs, nowMs = Date.now()) {
  const sec = Math.max(0, Math.floor((nowMs - Number(tsMs || nowMs)) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export function formatNotebookMeta(nb) {
  const chatCount = Array.isArray(nb.chats) ? nb.chats.length : 0;
  const runs = Number(nb.runCount || 0);
  const chatLabel = chatCount === 1 ? '1 chat' : `${chatCount} chats`;
  const runLabel = runs === 1 ? '1 run' : `${runs} runs`;
  return `${chatLabel} • ${runLabel} • ${formatRelativeTime(nb.updatedAt)}`;
}

export function formatChatMeta(chat) {
  const count = Array.isArray(chat.messages) ? chat.messages.length : 0;
  const msgLabel = count === 1 ? '1 msg' : `${count} msgs`;
  return `${msgLabel} • ${formatRelativeTime(chat.updatedAt)}`;
}

function normalizeNotebook(nb) {
  const now = Date.now();
  let chats = Array.isArray(nb.chats) ? nb.chats : null;
  if (!chats) {
    const legacyMsgs = Array.isArray(nb.messages) ? nb.messages : [];
    const cid = createId('nchat');
    chats = [
      {
        id: cid,
        title: 'Primary Analysis',
        sessionId: `nb:${nb.id}:${cid}`,
        createdAt: nb.createdAt || now,
        updatedAt: nb.updatedAt || now,
        messages: legacyMsgs,
      },
    ];
  } else {
    chats = chats.map((c) => ({
      ...c,
      sessionId: c.sessionId || `nb:${nb.id}:${c.id}`,
      messages: Array.isArray(c.messages) ? c.messages : [],
    }));
  }

  const validActive = chats.some((c) => c.id === nb.activeChatId)
    ? nb.activeChatId
    : chats[0]?.id || null;

  return {
    id: nb.id,
    title: nb.title || 'Untitled Notebook',
    runCount: Number(nb.runCount || 0),
    createdAt: nb.createdAt || now,
    updatedAt: nb.updatedAt || now,
    snapshot: nb.snapshot || { ...state.activeCabin },
    activeChatId: validActive,
    chats,
  };
}

function defaultSeedState() {
  const now = Date.now();
  return {
    sidebarOpen: true,
    activeTarget: { kind: 'none', id: null, chatId: null },
    expandedNotebooks: { 'nb-artemis-pmma': true },
    notebooks: [
      {
        id: 'nb-artemis-pmma',
        title: 'Artemis 34% O₂ PMMA',
        runCount: 4,
        createdAt: now - 1000 * 60 * 95,
        updatedAt: now - 1000 * 60 * 12,
        activeChatId: 'nc-artemis-1',
        snapshot: {
          oxygen_pct: 34.0,
          pressure_kpa: 56.5,
          flow_velocity_cm_s: 5.0,
          gravity_g: 0.16,
          fuel_material: 'PMMA',
          diluent_gas: 'N2',
        },
        chats: [
          {
            id: 'nc-artemis-1',
            title: 'PMMA LOI Margin Audit',
            sessionId: 'nb:nb-artemis-pmma:nc-artemis-1',
            createdAt: now - 1000 * 60 * 14,
            updatedAt: now - 1000 * 60 * 12,
            messages: [
              {
                id: 'seed-nb-1',
                role: 'user',
                content: 'Evaluate PMMA LOI shift at 34% O2, 56.5 kPa, 0.16g Lunar habitat.',
                timestamp: now - 1000 * 60 * 14,
              },
              {
                id: 'seed-nb-2',
                role: 'assistant',
                content:
                  'Under **SoFIE Artemis exploration conditions (34% O₂ / 56.5 kPa / 0.16g)**, PMMA exhibits a critical flammability margin above its calibrated LOI (~17.6% O₂) [DOC-02 p.1]. Replace exposed PMMA panels with **PTFE (Teflon)** or **Nomex** barriers [DOC-05 p.1].',
                timestamp: now - 1000 * 60 * 12,
                audit: {
                  citations: {
                    grounding_pct: 100,
                    cited_sentences: 2,
                    checked_sentences: 2,
                    verified_doc_citations: [
                      { doc_id: 'DOC-02', page: 1 },
                      { doc_id: 'DOC-05', page: 1 },
                    ],
                    verified_exp_citations: [],
                    dropped_claims: [],
                  },
                  provider: 'Notebook Snapshot',
                },
              },
            ],
          },
          {
            id: 'nc-artemis-2',
            title: 'Nomex Barrier Comparison',
            sessionId: 'nb:nb-artemis-pmma:nc-artemis-2',
            createdAt: now - 1000 * 60 * 40,
            updatedAt: now - 1000 * 60 * 32,
            messages: [],
          },
        ],
      },
      {
        id: 'nb-bass-paradox',
        title: 'BASS-II 8 cm/s Flow Paradox',
        runCount: 6,
        createdAt: now - 1000 * 60 * 210,
        updatedAt: now - 1000 * 60 * 48,
        activeChatId: 'nc-bass-1',
        snapshot: {
          oxygen_pct: 21.0,
          pressure_kpa: 101.3,
          flow_velocity_cm_s: 8.0,
          gravity_g: 0.0,
          fuel_material: 'Cotton-Fiberglass',
          diluent_gas: 'N2',
        },
        chats: [
          {
            id: 'nc-bass-1',
            title: '8 cm/s Minimum LOI Check',
            sessionId: 'nb:nb-bass-paradox:nc-bass-1',
            createdAt: now - 1000 * 60 * 50,
            updatedAt: now - 1000 * 60 * 48,
            messages: [],
          },
        ],
      },
    ],
    recentChats: [
      {
        id: 'chat-flex-cool',
        title: 'FLEX-2 Cool-Flame Extinction',
        sessionId: 'chat:chat-flex-cool',
        createdAt: now - 1000 * 60 * 40,
        updatedAt: now - 1000 * 60 * 18,
        messages: [
          {
            id: 'seed-rc-1',
            role: 'user',
            content: 'What temperature regime defines FLEX-2 cool flames?',
            timestamp: now - 1000 * 60 * 19,
          },
          {
            id: 'seed-rc-2',
            role: 'assistant',
            content:
              'FLEX-2 n-heptane droplets transition after radiative extinction into low-temperature **cool flames (~650–800 K)** with minimal visible emission [DOC-03 p.1].',
            timestamp: now - 1000 * 60 * 18,
            audit: {
              citations: {
                grounding_pct: 100,
                cited_sentences: 1,
                checked_sentences: 1,
                verified_doc_citations: [{ doc_id: 'DOC-03', page: 1 }],
                verified_exp_citations: [],
                dropped_claims: [],
              },
              provider: 'NASA Grounded Cache',
            },
          },
        ],
      },
      {
        id: 'chat-saffire-spread',
        title: 'SAFFIRE-IV Cygnus Duct Spread',
        sessionId: 'chat:chat-saffire-spread',
        createdAt: now - 1000 * 60 * 130,
        updatedAt: now - 1000 * 60 * 75,
        messages: [
          {
            id: 'seed-rc-3',
            role: 'user',
            content: 'Compare SAFFIRE-IV and BASS-II opposed flow flame spread rates.',
            timestamp: now - 1000 * 60 * 75,
          },
        ],
      },
    ],
  };
}

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultSeedState();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.notebooks) && Array.isArray(parsed?.recentChats)) {
      return {
        sidebarOpen: parsed.sidebarOpen !== false,
        activeTarget: parsed.activeTarget || { kind: 'none', id: null, chatId: null },
        expandedNotebooks: parsed.expandedNotebooks || {},
        notebooks: parsed.notebooks.map(normalizeNotebook),
        recentChats: parsed.recentChats,
      };
    }
  } catch {
    // ignore invalid storage
  }
  return defaultSeedState();
}

const store = loadStore();

function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sidebarOpen: store.sidebarOpen,
        activeTarget: store.activeTarget,
        expandedNotebooks: store.expandedNotebooks,
        notebooks: store.notebooks,
        recentChats: store.recentChats,
      })
    );
  } catch {
    // ignore quota errors
  }
}

export function getNotebooks() {
  return store.notebooks;
}

export function getRecentChats() {
  return store.recentChats;
}

export function isSidebarOpen() {
  return Boolean(store.sidebarOpen);
}

export function setSidebarOpen(open) {
  store.sidebarOpen = Boolean(open);
  persist();
  emit('sidebar:toggled', store.sidebarOpen);
}

export function toggleSidebar() {
  setSidebarOpen(!store.sidebarOpen);
}

export function isNotebookExpanded(notebookId) {
  return Boolean(store.expandedNotebooks?.[notebookId]);
}

export function toggleNotebookExpanded(notebookId, force = null) {
  const next = force !== null ? Boolean(force) : !isNotebookExpanded(notebookId);
  store.expandedNotebooks = { ...store.expandedNotebooks, [notebookId]: next };
  persist();
  emit('notebooks:changed', store);
  return next;
}

export function getActiveTarget() {
  return store.activeTarget;
}

export function getActiveNotebook() {
  if (store.activeTarget?.kind !== 'notebook') return null;
  return store.notebooks.find((n) => n.id === store.activeTarget.id) || null;
}

export function getActiveNotebookChat() {
  const nb = getActiveNotebook();
  if (!nb) return null;
  const targetChatId = store.activeTarget.chatId || nb.activeChatId;
  return nb.chats.find((c) => c.id === targetChatId) || nb.chats[0] || null;
}

export function getActiveRecentChat() {
  if (store.activeTarget?.kind !== 'chat') return null;
  return store.recentChats.find((c) => c.id === store.activeTarget.id) || null;
}

export function getActiveSessionId() {
  const nb = getActiveNotebook();
  if (nb) {
    const nChat = getActiveNotebookChat();
    return nChat ? nChat.sessionId : `nb:${nb.id}`;
  }
  const chat = getActiveRecentChat();
  if (chat) return chat.sessionId;
  return 'chat:default';
}

export function getActiveMessages() {
  const nb = getActiveNotebook();
  if (nb) {
    const nChat = getActiveNotebookChat();
    return nChat?.messages || [];
  }
  const chat = getActiveRecentChat();
  if (chat) return chat.messages || [];
  return [];
}

export function selectNotebook(notebookId, { applySnapshot = true, chatId = null } = {}) {
  const nb = store.notebooks.find((n) => n.id === notebookId);
  if (!nb) return null;

  let chosenChatId = chatId || nb.activeChatId || nb.chats[0]?.id || null;
  if (!chosenChatId) {
    const cid = createId('nchat');
    const now = Date.now();
    nb.chats.push({
      id: cid,
      title: 'Research Session 1',
      sessionId: `nb:${nb.id}:${cid}`,
      createdAt: now,
      updatedAt: now,
      messages: [],
    });
    chosenChatId = cid;
  }

  nb.activeChatId = chosenChatId;
  store.activeTarget = { kind: 'notebook', id: nb.id, chatId: chosenChatId };
  store.expandedNotebooks = { ...store.expandedNotebooks, [nb.id]: true };

  if (applySnapshot && nb.snapshot) {
    setActiveCabin(nb.snapshot);
  }
  persist();
  emit('notebooks:changed', store);
  emit('thread:changed', { kind: 'notebook', item: nb, chat: getActiveNotebookChat() });
  return nb;
}

export function selectNotebookChat(notebookId, chatId) {
  const nb = store.notebooks.find((n) => n.id === notebookId);
  if (!nb) return null;
  const chat = nb.chats.find((c) => c.id === chatId);
  if (!chat) return null;
  return selectNotebook(notebookId, { applySnapshot: true, chatId: chat.id });
}

export function createNotebookChat(notebookId, title = '') {
  const nb = store.notebooks.find((n) => n.id === notebookId);
  if (!nb) return null;
  const now = Date.now();
  const cid = createId('nchat');
  const nextNum = (nb.chats?.length || 0) + 1;
  const chat = {
    id: cid,
    title: String(title || '').trim() || `Research Thread ${nextNum}`,
    sessionId: `nb:${nb.id}:${cid}`,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  nb.chats = [chat, ...(nb.chats || [])];
  nb.activeChatId = chat.id;
  nb.updatedAt = now;
  store.expandedNotebooks = { ...store.expandedNotebooks, [nb.id]: true };
  store.activeTarget = { kind: 'notebook', id: nb.id, chatId: chat.id };
  persist();
  emit('notebooks:changed', store);
  emit('thread:changed', { kind: 'notebook', item: nb, chat });
  return chat;
}

export function deleteNotebookChat(notebookId, chatId) {
  const nb = store.notebooks.find((n) => n.id === notebookId);
  if (!nb) return;
  nb.chats = (nb.chats || []).filter((c) => c.id !== chatId);
  nb.updatedAt = Date.now();

  if (nb.activeChatId === chatId) {
    nb.activeChatId = nb.chats[0]?.id || null;
  }

  const wasActive =
    store.activeTarget?.kind === 'notebook' &&
    store.activeTarget.id === notebookId &&
    store.activeTarget.chatId === chatId;

  if (wasActive) {
    store.activeTarget = { kind: 'notebook', id: nb.id, chatId: nb.activeChatId };
  }

  persist();
  emit('notebooks:changed', store);
  if (wasActive) {
    emit('thread:changed', { kind: 'notebook', item: nb, chat: getActiveNotebookChat() });
  }
}

export function selectRecentChat(chatId) {
  const chat = store.recentChats.find((c) => c.id === chatId);
  if (!chat) return null;
  store.activeTarget = { kind: 'chat', id: chat.id, chatId: chat.id };
  persist();
  emit('notebooks:changed', store);
  emit('thread:changed', { kind: 'chat', item: chat });
  return chat;
}

export function createNotebook(title, snapshot = null) {
  const now = Date.now();
  const id = createId('nb');
  const cid = createId('nchat');
  const nb = {
    id,
    title: String(title || '').trim() || 'Untitled Notebook',
    runCount: 1,
    createdAt: now,
    updatedAt: now,
    snapshot: snapshot ? { ...snapshot } : { ...state.activeCabin },
    activeChatId: cid,
    chats: [
      {
        id: cid,
        title: 'Initial Analysis',
        sessionId: `nb:${id}:${cid}`,
        createdAt: now,
        updatedAt: now,
        messages: [],
      },
    ],
  };
  store.notebooks = [nb, ...store.notebooks];
  store.expandedNotebooks = { ...store.expandedNotebooks, [nb.id]: true };
  store.activeTarget = { kind: 'notebook', id: nb.id, chatId: cid };
  persist();
  emit('notebooks:changed', store);
  emit('thread:changed', { kind: 'notebook', item: nb, chat: nb.chats[0] });
  return nb;
}

export function createRecentChat(title = 'New Research Thread') {
  const now = Date.now();
  const id = createId('chat');
  const chat = {
    id,
    title: String(title || '').trim() || 'New Research Thread',
    sessionId: `chat:${id}`,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  store.recentChats = [chat, ...store.recentChats];
  store.activeTarget = { kind: 'chat', id: chat.id, chatId: chat.id };
  persist();
  emit('notebooks:changed', store);
  emit('thread:changed', { kind: 'chat', item: chat });
  return chat;
}

/**
 * Ensures there is a valid active target before sending a message.
 * - If currently inside a Notebook: stays strictly inside that Notebook (and creates a chat inside it if empty).
 * - If currently inside a Recent Chat: stays inside that Recent Chat.
 * - Otherwise: creates a fresh standalone Recent Chat thread.
 */
export function ensureActiveThreadForSend(promptText) {
  const nb = getActiveNotebook();
  if (nb) {
    let nChat = getActiveNotebookChat();
    if (!nChat) {
      nChat = createNotebookChat(
        nb.id,
        String(promptText || '').slice(0, 44).trim() || 'Research Thread'
      );
    }
    return { kind: 'notebook', item: nb, chat: nChat };
  }
  const chat = getActiveRecentChat();
  if (chat) return { kind: 'chat', item: chat };
  const created = createRecentChat(String(promptText || '').slice(0, 48).trim() || 'Research Query');
  return { kind: 'chat', item: created };
}

/**
 * Strictly isolated append:
 * Messages inside a Notebook ONLY write to that Notebook's active chat and never touch `recentChats`.
 */
export function appendMessageToActiveThread(entry) {
  const now = Date.now();
  const msg = {
    id: createId('msg'),
    timestamp: now,
    ...entry,
  };

  const nb = getActiveNotebook();
  if (nb) {
    let nChat = getActiveNotebookChat();
    if (!nChat) {
      nChat = createNotebookChat(
        nb.id,
        entry.role === 'user' ? String(entry.content || '').slice(0, 44).trim() : 'Research Thread'
      );
    }
    if (
      entry.role === 'user' &&
      (!nChat.messages || nChat.messages.length === 0) &&
      /^(Initial Analysis|Research (Session|Thread))/.test(nChat.title)
    ) {
      nChat.title = String(entry.content || '').slice(0, 44).trim() || nChat.title;
    }
    nChat.messages = [...(nChat.messages || []), msg];
    nChat.updatedAt = now;
    nb.updatedAt = now;
    if (entry.role === 'user') {
      nb.runCount = Number(nb.runCount || 0) + 1;
    }
    persist();
    emit('notebooks:changed', store);
    return msg;
  }

  let chat = getActiveRecentChat();
  if (!chat) {
    chat = createRecentChat(
      entry.role === 'user' ? String(entry.content || '').slice(0, 48).trim() : 'Research Query'
    );
  }
  if (
    entry.role === 'user' &&
    (!chat.messages || chat.messages.length === 0 || chat.title === 'New Research Thread')
  ) {
    chat.title = String(entry.content || '').slice(0, 48).trim() || chat.title;
  }
  chat.messages = [...(chat.messages || []), msg];
  chat.updatedAt = now;
  persist();
  emit('notebooks:changed', store);
  return msg;
}

export function clearActiveThreadMessages() {
  const nb = getActiveNotebook();
  if (nb) {
    const nChat = getActiveNotebookChat();
    if (nChat) {
      nChat.messages = [];
      nChat.updatedAt = Date.now();
    }
    nb.updatedAt = Date.now();
    persist();
    emit('notebooks:changed', store);
    emit('thread:changed', { kind: 'notebook', item: nb, chat: nChat });
    return;
  }
  const chat = getActiveRecentChat();
  if (chat) {
    chat.messages = [];
    chat.updatedAt = Date.now();
    persist();
    emit('notebooks:changed', store);
    emit('thread:changed', { kind: 'chat', item: chat });
  }
}

export function syncActiveCabinToNotebook() {
  const nb = getActiveNotebook();
  if (!nb) return null;
  nb.snapshot = { ...state.activeCabin };
  nb.runCount = Number(nb.runCount || 0) + 1;
  nb.updatedAt = Date.now();
  persist();
  emit('notebooks:changed', store);
  emit('thread:changed', { kind: 'notebook', item: nb, chat: getActiveNotebookChat() });
  return nb;
}

/**
 * Chat Migration ("Add to Notebook"):
 * Transfers a standalone Recent Chat into an existing or new Notebook as an isolated
 * Notebook chat entry, updates quantifiable run counts, and removes it from Recent Chats.
 */
export function moveChatToNotebook(chatId, targetNotebookId = 'new', newTitle = '') {
  const idx = store.recentChats.findIndex((c) => c.id === chatId);
  if (idx === -1) return null;
  const sourceChat = store.recentChats[idx];
  const now = Date.now();
  const migratedMessages = [...(sourceChat.messages || [])];
  const addedRuns = Math.max(1, Math.ceil(migratedMessages.length / 2));

  let destNotebook = null;
  let migratedChatId = null;

  if (targetNotebookId === 'new') {
    const id = createId('nb');
    migratedChatId = createId('nchat');
    destNotebook = {
      id,
      title: String(newTitle || sourceChat.title || 'Migrated Notebook').trim(),
      runCount: addedRuns,
      createdAt: now,
      updatedAt: now,
      snapshot: { ...state.activeCabin },
      activeChatId: migratedChatId,
      chats: [
        {
          id: migratedChatId,
          title: sourceChat.title || 'Migrated Thread',
          sessionId: `nb:${id}:${migratedChatId}`,
          createdAt: sourceChat.createdAt || now,
          updatedAt: now,
          messages: migratedMessages,
        },
      ],
    };
    store.notebooks = [destNotebook, ...store.notebooks];
  } else {
    destNotebook = store.notebooks.find((n) => n.id === targetNotebookId) || null;
    if (!destNotebook) return null;
    migratedChatId = createId('nchat');
    destNotebook.chats = [
      {
        id: migratedChatId,
        title: sourceChat.title || 'Migrated Thread',
        sessionId: `nb:${destNotebook.id}:${migratedChatId}`,
        createdAt: sourceChat.createdAt || now,
        updatedAt: now,
        messages: migratedMessages,
      },
      ...(destNotebook.chats || []),
    ];
    destNotebook.activeChatId = migratedChatId;
    destNotebook.runCount = Number(destNotebook.runCount || 0) + addedRuns;
    destNotebook.updatedAt = now;
  }

  store.recentChats = store.recentChats.filter((c) => c.id !== chatId);
  store.expandedNotebooks = { ...store.expandedNotebooks, [destNotebook.id]: true };
  store.activeTarget = { kind: 'notebook', id: destNotebook.id, chatId: migratedChatId };
  persist();
  emit('notebooks:changed', store);
  emit('thread:changed', {
    kind: 'notebook',
    item: destNotebook,
    chat: getActiveNotebookChat(),
  });
  return destNotebook;
}

export function deleteNotebook(notebookId) {
  store.notebooks = store.notebooks.filter((n) => n.id !== notebookId);
  if (store.activeTarget?.kind === 'notebook' && store.activeTarget.id === notebookId) {
    store.activeTarget = { kind: 'none', id: null, chatId: null };
  }
  persist();
  emit('notebooks:changed', store);
  emit('thread:changed', { kind: 'none', item: null });
}

export function deleteRecentChat(chatId) {
  store.recentChats = store.recentChats.filter((c) => c.id !== chatId);
  if (store.activeTarget?.kind === 'chat' && store.activeTarget.id === chatId) {
    store.activeTarget = { kind: 'none', id: null, chatId: null };
  }
  persist();
  emit('notebooks:changed', store);
  emit('thread:changed', { kind: 'none', item: null });
}
