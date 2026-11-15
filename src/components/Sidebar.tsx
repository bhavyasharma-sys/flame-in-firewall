import React, { useEffect, useRef, useState } from 'react';
import {
  formatChatMeta,
  formatNotebookMeta,
  useNotebookState,
} from '../context/NotebookStateContext';

interface ContextMenuState {
  chatId: string;
  x: number;
  y: number;
  showNotebookPicker: boolean;
}

export const Sidebar: React.FC = () => {
  const {
    notebooks,
    recentChats,
    activeWorkspace,
    isSidebarOpen,
    expandedNotebookIds,
    toggleSidebar,
    toggleNotebookExpanded,
    openDashboard,
    selectNotebook,
    selectNotebookChat,
    selectRecentChat,
    createNotebook,
    createNotebookChat,
    deleteNotebookChat,
    createRecentChat,
    moveChatToNotebook,
    deleteNotebook,
    deleteRecentChat,
  } = useNotebookState();

  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [creatingNotebook, setCreatingNotebook] = useState(false);
  const [newNotebookTitle, setNewNotebookTitle] = useState('');
  const [nameError, setNameError] = useState('');
  const menuRef = useRef<HTMLDivElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleSidebar();
      } else if (e.key === 'Escape') {
        setMenu(null);
        setCreatingNotebook(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleSidebar]);

  useEffect(() => {
    if (!menu) return;
    const handleOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu(null);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [menu]);

  useEffect(() => {
    if (creatingNotebook) {
      setNameError('');
      setTimeout(() => titleInputRef.current?.focus(), 0);
    }
  }, [creatingNotebook]);

  const handleCreateNotebookSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newNotebookTitle.trim();
    if (!trimmed) {
      setNameError('Enter a notebook name.');
      titleInputRef.current?.focus();
      return;
    }
    createNotebook(trimmed);
    setNewNotebookTitle('');
    setNameError('');
    setCreatingNotebook(false);
  };

  const openChatContextMenu = (e: React.MouseEvent, chatId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = Math.min(rect.right + 6, window.innerWidth - 236);
    const y = Math.min(rect.top, window.innerHeight - 240);
    setMenu({ chatId, x, y, showNotebookPicker: false });
  };

  return (
    <>
      {!isSidebarOpen && (
        <div className="fixed left-3 top-3 z-40">
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label="Expand sidebar"
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-950/90 text-zinc-300 shadow-lg backdrop-blur-md transition hover:border-zinc-700 hover:bg-zinc-900 hover:text-white"
          >
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M9 3v18" />
            </svg>
          </button>
        </div>
      )}

      {/* Gemini-Style Collapsible Drawer */}
      <aside
        aria-label="Research library sidebar"
        className={`relative flex h-screen shrink-0 flex-col border-r border-zinc-800/80 bg-[#0b0a09] text-zinc-100 transition-all duration-200 ease-out overflow-hidden ${
          isSidebarOpen
            ? 'w-72 opacity-100'
            : 'w-0 border-r-0 opacity-0 pointer-events-none'
        }`}
      >
        <div className="flex h-full w-72 flex-col">
          {/* Top Control Bar */}
          <div className="flex items-center justify-between px-3.5 pt-3.5 pb-2">
            <button
              type="button"
              onClick={openDashboard}
              className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-left transition hover:bg-zinc-900"
            >
              <span className="h-2 w-2 rounded-full bg-orange-500 shadow-[0_0_8px_rgba(249,115,22,0.8)]" />
              <span className="text-[13px] font-bold tracking-tight text-zinc-100">
                Ignis Lab
              </span>
              <span className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                v1.0.0
              </span>
            </button>

            <button
              type="button"
              onClick={toggleSidebar}
              aria-label="Collapse sidebar"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-zinc-900 hover:text-zinc-100"
            >
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M9 3v18" />
              </svg>
            </button>
          </div>

          {/* Primary Creation Actions */}
          <div className="grid grid-cols-2 gap-1.5 px-3 pb-3">
            <button
              type="button"
              onClick={() => createRecentChat()}
              className="flex items-center justify-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-900/70 px-2.5 py-2 text-[12px] font-semibold text-zinc-100 transition hover:border-zinc-700 hover:bg-zinc-800/80"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
                <path d="M12 5v14M5 12h14" />
              </svg>
              New Chat
            </button>

            <button
              type="button"
              onClick={() => setCreatingNotebook(true)}
              className="flex items-center justify-center gap-1.5 rounded-xl border border-orange-500/30 bg-orange-500/10 px-2.5 py-2 text-[12px] font-semibold text-orange-300 transition hover:border-orange-500/50 hover:bg-orange-500/15"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
              Notebook
            </button>
          </div>

          {/* Scrollable Library: Notebooks + Recent Chats */}
          <div className="flex-1 overflow-y-auto px-2.5 pb-4 space-y-5">
            {/* Section 1: Notebooks with Per-Notebook Dropdown Menu */}
            <section aria-labelledby="sidebar-notebooks-heading">
              <div className="flex items-center justify-between px-2 pb-1.5">
                <h2
                  id="sidebar-notebooks-heading"
                  className="font-mono text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500"
                >
                  Notebooks
                </h2>
                <span className="font-mono text-[10.5px] tabular-nums text-zinc-500">
                  {notebooks.length}
                </span>
              </div>

              <ul className="space-y-1">
                {notebooks.map((nb) => {
                  const isActive =
                    activeWorkspace.kind === 'notebook' &&
                    activeWorkspace.notebookId === nb.id;
                  const isExpanded = expandedNotebookIds.includes(nb.id);

                  return (
                    <li key={nb.id} className="flex flex-col">
                      <div className="group relative">
                        <button
                          type="button"
                          onClick={() => selectNotebook(nb.id)}
                          className={`flex w-full items-center gap-2.5 rounded-xl py-2 pl-2.5 pr-12 text-left transition ${
                            isActive
                              ? 'bg-zinc-800/90 text-white ring-1 ring-orange-500/40'
                              : 'text-zinc-200 hover:bg-zinc-900/90'
                          }`}
                        >
                          <span
                            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border text-[11px] font-mono ${
                              isActive
                                ? 'border-orange-500/50 bg-orange-500/15 text-orange-300'
                                : 'border-zinc-800 bg-zinc-900 text-zinc-400'
                            }`}
                          >
                            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                            </svg>
                          </span>

                          {/* Strict Two-Line Item Architecture */}
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[13px] font-semibold leading-tight text-zinc-100">
                              {nb.title}
                            </div>
                            <div className="mt-0.5 truncate font-mono text-[11px] tabular-nums text-zinc-400">
                              {formatNotebookMeta(nb)}
                            </div>
                          </div>
                        </button>

                        {/* Small Dropdown Toggle Against Notebook Name */}
                        <button
                          type="button"
                          aria-label={`Toggle chats menu for ${nb.title}`}
                          aria-expanded={isExpanded}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleNotebookExpanded(nb.id);
                          }}
                          className={`absolute right-7 top-1/2 -translate-y-1/2 rounded-md p-1 transition ${
                            isExpanded
                              ? 'bg-orange-500/15 text-orange-300'
                              : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'
                          }`}
                        >
                          <svg
                            className={`h-3.5 w-3.5 transition-transform ${
                              isExpanded ? 'rotate-180' : ''
                            }`}
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2.2}
                          >
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>

                        <button
                          type="button"
                          aria-label={`Delete ${nb.title}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteNotebook(nb.id);
                          }}
                          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-zinc-500 opacity-0 transition hover:bg-zinc-800 hover:text-red-400 group-hover:opacity-100"
                        >
                          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                            <path d="M18 6 6 18M6 6l12 12" />
                          </svg>
                        </button>
                      </div>

                      {/* Nested Notebook Dropdown Menu: Add Chat, Delete Chat, Enter Specific Chat */}
                      {isExpanded && (
                        <div className="ml-3.5 mt-1 space-y-1.5 rounded-xl border-l-2 border-orange-500/30 bg-zinc-900/60 p-1.5">
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => createNotebookChat(nb.id)}
                              className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-zinc-800 bg-zinc-950/90 px-2 py-1 text-[11px] font-semibold text-zinc-200 transition hover:border-orange-500/40 hover:text-orange-300"
                            >
                              <span>+ New Chat</span>
                            </button>
                            <button
                              type="button"
                              aria-label={`Delete notebook ${nb.title}`}
                              onClick={() => deleteNotebook(nb.id)}
                              className="rounded-lg border border-zinc-800 bg-zinc-950/90 px-2 py-1 text-[11px] text-zinc-400 transition hover:border-red-500/40 hover:text-red-400"
                            >
                              Delete
                            </button>
                          </div>

                          <ul className="space-y-0.5">
                            {nb.chats.map((nc) => {
                              const isChatActive =
                                isActive && activeWorkspace.chatId === nc.id;
                              return (
                                <li key={nc.id} className="group/nc relative">
                                  <button
                                    type="button"
                                    onClick={() => selectNotebookChat(nb.id, nc.id)}
                                    className={`flex w-full flex-col rounded-lg py-1.5 pl-2 pr-6 text-left transition ${
                                      isChatActive
                                        ? 'bg-zinc-800 text-white ring-1 ring-orange-500/40'
                                        : 'text-zinc-300 hover:bg-zinc-800/70'
                                    }`}
                                  >
                                    <span className="truncate text-[12px] font-medium">
                                      {nc.title}
                                    </span>
                                    <span className="truncate font-mono text-[10px] tabular-nums text-zinc-500">
                                      {formatChatMeta(nc)}
                                    </span>
                                  </button>
                                  <button
                                    type="button"
                                    aria-label={`Delete ${nc.title}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      deleteNotebookChat(nb.id, nc.id);
                                    }}
                                    className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-500 opacity-0 transition hover:bg-red-500/15 hover:text-red-400 group-hover/nc:opacity-100"
                                  >
                                    <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                                      <path d="M18 6 6 18M6 6l12 12" />
                                    </svg>
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>

            {/* Section 2: Recent Chats (Standalone Global Threads) */}
            <section aria-labelledby="sidebar-chats-heading">
              <div className="flex items-center justify-between px-2 pb-1.5">
                <h2
                  id="sidebar-chats-heading"
                  className="font-mono text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500"
                >
                  Recent Chats
                </h2>
                <span className="font-mono text-[10.5px] tabular-nums text-zinc-500">
                  {recentChats.length}
                </span>
              </div>

              <ul className="space-y-1">
                {recentChats.map((chat) => {
                  const isActive =
                    activeWorkspace.kind === 'chat' &&
                    activeWorkspace.chatId === chat.id;
                  return (
                    <li key={chat.id} className="group relative">
                      <button
                        type="button"
                        onClick={() => selectRecentChat(chat.id)}
                        onContextMenu={(e) => openChatContextMenu(e, chat.id)}
                        className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition ${
                          isActive
                            ? 'bg-zinc-800/90 text-white ring-1 ring-zinc-700'
                            : 'text-zinc-200 hover:bg-zinc-900/90'
                        }`}
                      >
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400">
                          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                          </svg>
                        </span>

                        <div className="min-w-0 flex-1 pr-6">
                          <div className="truncate text-[13px] font-semibold leading-tight text-zinc-100">
                            {chat.title}
                          </div>
                          <div className="mt-0.5 truncate font-mono text-[11px] tabular-nums text-zinc-400">
                            {formatChatMeta(chat)}
                          </div>
                        </div>
                      </button>

                      <button
                        type="button"
                        aria-label={`Options for ${chat.title}`}
                        onClick={(e) => openChatContextMenu(e, chat.id)}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-zinc-400 opacity-0 transition hover:bg-zinc-800 hover:text-white group-hover:opacity-100 focus:opacity-100"
                      >
                        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
                          <circle cx="12" cy="5" r="1.75" />
                          <circle cx="12" cy="12" r="1.75" />
                          <circle cx="12" cy="19" r="1.75" />
                        </svg>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          </div>
        </div>
      </aside>

      {/* Clean Modal for Notebook Name Entry */}
      {creatingNotebook && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="nb-modal-heading"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={() => setCreatingNotebook(false)}
        >
          <form
            onSubmit={handleCreateNotebookSubmit}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl"
          >
            <div className="flex items-center justify-between pb-3">
              <h2
                id="nb-modal-heading"
                className="text-[15px] font-bold tracking-tight text-zinc-100"
              >
                New Research Notebook
              </h2>
              <button
                type="button"
                aria-label="Close modal"
                onClick={() => setCreatingNotebook(false)}
                className="rounded-lg p-1 text-zinc-400 transition hover:bg-zinc-900 hover:text-zinc-100"
              >
                ✕
              </button>
            </div>

            <label
              htmlFor="nb-name-input"
              className="block font-mono text-[10.5px] font-semibold uppercase tracking-wider text-zinc-400"
            >
              Notebook Name
            </label>
            <input
              id="nb-name-input"
              ref={titleInputRef}
              type="text"
              value={newNotebookTitle}
              onChange={(e) => {
                setNewNotebookTitle(e.target.value);
                if (nameError) setNameError('');
              }}
              placeholder="e.g. Artemis 34% O₂ PMMA Study"
              maxLength={64}
              className="mt-1.5 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-[13.5px] text-zinc-100 placeholder:text-zinc-500 focus:border-orange-500/60 focus:outline-none"
            />
            {nameError && (
              <p className="mt-1.5 text-[12px] text-red-400">{nameError}</p>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCreatingNotebook(false)}
                className="rounded-xl border border-zinc-800 bg-zinc-900 px-3.5 py-1.5 text-[12.5px] font-medium text-zinc-300 transition hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-xl bg-orange-500 px-4 py-1.5 text-[12.5px] font-semibold text-white transition hover:bg-orange-400"
              >
                Create Notebook
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Floating Context Menu for Recent Chats ("Add to Notebook" migration) */}
      {menu && (
        <div
          ref={menuRef}
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          className="fixed z-50 w-56 rounded-xl border border-zinc-800 bg-zinc-950/95 p-1.5 shadow-2xl backdrop-blur-xl"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              setMenu((prev) =>
                prev ? { ...prev, showNotebookPicker: !prev.showNotebookPicker } : null
              )
            }
            className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-[12.5px] font-medium text-zinc-100 transition hover:bg-zinc-800"
          >
            <span className="flex items-center gap-2">
              <svg className="h-3.5 w-3.5 text-orange-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
              Add to Notebook
            </span>
            <svg className="h-3.5 w-3.5 text-zinc-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>

          {menu.showNotebookPicker && (
            <div className="mt-1 space-y-0.5 border-t border-zinc-800/80 pt-1">
              {notebooks.map((nb) => (
                <button
                  key={nb.id}
                  type="button"
                  onClick={() => {
                    moveChatToNotebook(menu.chatId, nb.id);
                    setMenu(null);
                  }}
                  className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12px] text-zinc-300 transition hover:bg-orange-500/15 hover:text-orange-200"
                >
                  <span className="truncate">{nb.title}</span>
                  <span className="ml-2 shrink-0 font-mono text-[10px] text-zinc-500">
                    {nb.chats.length}c
                  </span>
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  moveChatToNotebook(menu.chatId, 'new');
                  setMenu(null);
                }}
                className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-semibold text-orange-300 transition hover:bg-orange-500/15"
              >
                <span>+ New Notebook</span>
              </button>
            </div>
          )}

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              deleteRecentChat(menu.chatId);
              setMenu(null);
            }}
            className="mt-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] font-medium text-red-400 transition hover:bg-red-500/10"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            </svg>
            Delete Thread
          </button>
        </div>
      )}
    </>
  );
};
