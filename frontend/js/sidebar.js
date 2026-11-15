/**
 * Gemini-Style Collapsible Sidebar UI:
 * - Two sections: Notebooks & Recent Chats
 * - Strict two-line item architecture (bold truncated title + quantifiable metadata)
 * - Per-Notebook dropdown menu against the notebook name to add, delete, or open its isolated chats
 * - Sleek Create Notebook name modal dialog when adding a new notebook
 * - Context menu on Recent Chats ("Add to Notebook" migration + Delete)
 */

import {
  createNotebook,
  createNotebookChat,
  createRecentChat,
  deleteNotebook,
  deleteNotebookChat,
  deleteRecentChat,
  formatChatMeta,
  formatNotebookMeta,
  getActiveTarget,
  getNotebooks,
  getRecentChats,
  isNotebookExpanded,
  isSidebarOpen,
  moveChatToNotebook,
  selectNotebook,
  selectNotebookChat,
  selectRecentChat,
  setSidebarOpen,
  toggleNotebookExpanded,
  toggleSidebar,
} from './notebooks.js';
import { emit, esc, on, state } from './state.js';

let contextMenuChatId = null;
let showNotebookSubmenu = false;
let pendingMigrationChatId = null;

function syncDrawerDOM(open) {
  const sidebar = document.getElementById('ignis-sidebar');
  const shell = document.querySelector('.workspace-frame');
  const navToggle = document.getElementById('sidebar-toggle-btn');

  if (sidebar) {
    sidebar.classList.toggle('is-collapsed', !open);
    sidebar.setAttribute('aria-hidden', String(!open));
  }
  if (shell) {
    shell.classList.toggle('sidebar-collapsed', !open);
  }
  if (navToggle) {
    navToggle.setAttribute('aria-expanded', String(open));
  }
}

function closeContextMenu() {
  contextMenuChatId = null;
  showNotebookSubmenu = false;
  const menu = document.getElementById('sidebar-context-menu');
  if (menu) {
    menu.classList.remove('open');
    menu.innerHTML = '';
  }
}

function openCreateNotebookModal({ prefill = '', migrateFromChatId = null } = {}) {
  const modal = document.getElementById('nb-create-modal');
  const input = document.getElementById('nb-create-input');
  const snapshotEl = document.getElementById('nb-create-snapshot');
  const errorEl = document.getElementById('nb-create-error');
  const submitBtn = document.getElementById('nb-create-submit');
  if (!modal || !input) return;

  pendingMigrationChatId = migrateFromChatId || null;
  input.value = prefill;
  if (errorEl) errorEl.style.display = 'none';
  if (submitBtn) {
    submitBtn.textContent = migrateFromChatId ? 'Create & Move Chat' : 'Create Notebook';
  }
  if (snapshotEl) {
    const c = state.activeCabin;
    snapshotEl.textContent = `${c.oxygen_pct}% O₂ · ${c.pressure_kpa} kPa · ${c.flow_velocity_cm_s} cm/s · ${c.gravity_g}g · ${c.fuel_material}`;
  }

  modal.classList.add('open');
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function closeCreateNotebookModal() {
  const modal = document.getElementById('nb-create-modal');
  pendingMigrationChatId = null;
  if (modal) modal.classList.remove('open');
}

function renderContextMenu(x, y) {
  const menu = document.getElementById('sidebar-context-menu');
  if (!menu || !contextMenuChatId) return;

  const notebooks = getNotebooks();
  const nbButtons = notebooks
    .map(
      (nb) => `
      <button type="button" class="sb-menu-subitem" data-migrate-nb="${esc(nb.id)}">
        <span class="sb-menu-sub-title">${esc(nb.title)}</span>
        <span class="sb-menu-sub-count mono">${(nb.chats || []).length}c</span>
      </button>
    `
    )
    .join('');

  menu.innerHTML = `
    <button type="button" class="sb-menu-item" id="sb-menu-add-nb">
      <span class="sb-menu-item-left">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
        <span>Add to Notebook</span>
      </span>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
    </button>
    ${
      showNotebookSubmenu
        ? `<div class="sb-menu-submenu">
            ${nbButtons}
            <button type="button" class="sb-menu-subitem is-new" data-migrate-nb="new">+ New Notebook</button>
           </div>`
        : ''
    }
    <button type="button" class="sb-menu-item is-danger" id="sb-menu-delete-chat">
      <span class="sb-menu-item-left">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        <span>Delete Thread</span>
      </span>
    </button>
  `;

  const clampedX = Math.min(Math.max(12, x), window.innerWidth - 236);
  const clampedY = Math.min(Math.max(12, y), window.innerHeight - 240);
  menu.style.left = `${clampedX}px`;
  menu.style.top = `${clampedY}px`;
  menu.classList.add('open');

  menu.querySelector('#sb-menu-add-nb')?.addEventListener('click', (e) => {
    e.stopPropagation();
    showNotebookSubmenu = !showNotebookSubmenu;
    renderContextMenu(clampedX, clampedY);
  });

  menu.querySelectorAll('[data-migrate-nb]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetId = btn.dataset.migrateNb;
      const chatId = contextMenuChatId;
      closeContextMenu();
      if (targetId === 'new') {
        const chatObj = getRecentChats().find((c) => c.id === chatId);
        openCreateNotebookModal({
          prefill: chatObj?.title || '',
          migrateFromChatId: chatId,
        });
        return;
      }
      const moved = moveChatToNotebook(chatId, targetId);
      if (moved) {
        emit('navigate', 'chat');
      }
    });
  });

  menu.querySelector('#sb-menu-delete-chat')?.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteRecentChat(contextMenuChatId);
    closeContextMenu();
  });
}

function renderLists() {
  const nbList = document.getElementById('sidebar-notebooks-list');
  const chatList = document.getElementById('sidebar-chats-list');
  const nbCount = document.getElementById('sidebar-notebooks-count');
  const chatCount = document.getElementById('sidebar-chats-count');
  if (!nbList || !chatList) return;

  const notebooks = getNotebooks();
  const recentChats = getRecentChats();
  const active = getActiveTarget();

  if (nbCount) nbCount.textContent = String(notebooks.length);
  if (chatCount) chatCount.textContent = String(recentChats.length);

  nbList.innerHTML = notebooks.length
    ? notebooks
        .map((nb) => {
          const isNbActive = active?.kind === 'notebook' && active?.id === nb.id;
          const isExpanded = isNotebookExpanded(nb.id);
          const chats = nb.chats || [];

          const chatsHtml = chats.length
            ? chats
                .map((nc) => {
                  const isChatActive =
                    isNbActive && (active?.chatId || nb.activeChatId) === nc.id;
                  return `
                    <li class="sb-nb-chat-item">
                      <button type="button" class="sb-nb-chat-btn ${isChatActive ? 'active' : ''}" data-open-nb="${esc(nb.id)}" data-open-nb-chat="${esc(nc.id)}">
                        <span class="sb-nb-chat-dot" aria-hidden="true"></span>
                        <span class="sb-nb-chat-lines">
                          <span class="sb-nb-chat-title">${esc(nc.title)}</span>
                          <span class="sb-nb-chat-meta">${esc(formatChatMeta(nc))}</span>
                        </span>
                      </button>
                      <button type="button" class="sb-nb-chat-del" data-del-nb="${esc(nb.id)}" data-del-nb-chat="${esc(nc.id)}" aria-label="Delete chat ${esc(nc.title)}">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                      </button>
                    </li>
                  `;
                })
                .join('')
            : '<li class="sb-nb-empty mono">0 chats</li>';

          return `
            <li class="sb-nb-group ${isExpanded ? 'is-open' : ''}">
              <div class="sb-item-wrap">
                <button type="button" class="sb-item sb-item-nb ${isNbActive ? 'active' : ''}" data-select-nb="${esc(nb.id)}">
                  <span class="sb-item-icon" aria-hidden="true">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                  </span>
                  <span class="sb-item-lines">
                    <span class="sb-item-title">${esc(nb.title)}</span>
                    <span class="sb-item-meta">${esc(formatNotebookMeta(nb))}</span>
                  </span>
                </button>
                <button type="button" class="sb-nb-drop-btn ${isExpanded ? 'is-open' : ''}" data-toggle-nb="${esc(nb.id)}" aria-expanded="${isExpanded}" aria-label="Toggle ${esc(nb.title)} chats menu">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                </button>
              </div>

              ${
                isExpanded
                  ? `<div class="sb-nb-dropdown" role="region" aria-label="${esc(nb.title)} chats">
                      <div class="sb-nb-drop-actions">
                        <button type="button" class="sb-nb-add-chat-btn" data-add-nb-chat="${esc(nb.id)}">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                          <span>Add Chat</span>
                        </button>
                        <button type="button" class="sb-nb-del-nb-btn" data-del-nb="${esc(nb.id)}" aria-label="Delete notebook ${esc(nb.title)}">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                          <span>Delete</span>
                        </button>
                      </div>
                      <ul class="sb-nb-chat-list">${chatsHtml}</ul>
                    </div>`
                  : ''
              }
            </li>
          `;
        })
        .join('')
    : '<li class="sb-empty mono">0 notebooks</li>';

  chatList.innerHTML = recentChats.length
    ? recentChats
        .map((chat) => {
          const isActive = active?.kind === 'chat' && active?.id === chat.id;
          return `
            <li class="sb-item-wrap">
              <button type="button" class="sb-item ${isActive ? 'active' : ''}" data-select-chat="${esc(chat.id)}">
                <span class="sb-item-icon" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                </span>
                <span class="sb-item-lines">
                  <span class="sb-item-title">${esc(chat.title)}</span>
                  <span class="sb-item-meta">${esc(formatChatMeta(chat))}</span>
                </span>
              </button>
              <button type="button" class="sb-item-more" data-menu-chat="${esc(chat.id)}" aria-label="Chat options">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>
              </button>
            </li>
          `;
        })
        .join('')
    : '<li class="sb-empty mono">0 recent chats</li>';

  // Bind Notebook selection
  nbList.querySelectorAll('[data-select-nb]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const nb = selectNotebook(btn.dataset.selectNb);
      if (nb) {
        emit('navigate', 'chat');
        if (window.innerWidth <= 980) setSidebarOpen(false);
      }
    });
  });

  // Bind Notebook dropdown toggle against name
  nbList.querySelectorAll('[data-toggle-nb]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleNotebookExpanded(btn.dataset.toggleNb);
    });
  });

  // Bind "+ Add Chat" inside notebook dropdown
  nbList.querySelectorAll('[data-add-nb-chat]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const created = createNotebookChat(btn.dataset.addNbChat);
      if (created) {
        emit('navigate', 'chat');
        if (window.innerWidth <= 980) setSidebarOpen(false);
      }
    });
  });

  // Bind "Go into chat" inside notebook dropdown
  nbList.querySelectorAll('[data-open-nb-chat]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const nb = selectNotebookChat(btn.dataset.openNb, btn.dataset.openNbChat);
      if (nb) {
        emit('navigate', 'chat');
        if (window.innerWidth <= 980) setSidebarOpen(false);
      }
    });
  });

  // Bind "Delete chat" inside notebook dropdown
  nbList.querySelectorAll('[data-del-nb-chat]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteNotebookChat(btn.dataset.delNb, btn.dataset.delNbChat);
    });
  });

  // Bind "Delete notebook" inside dropdown
  nbList.querySelectorAll('.sb-nb-del-nb-btn[data-del-nb]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteNotebook(btn.dataset.delNb);
    });
  });

  // Bind Recent Chats
  chatList.querySelectorAll('[data-select-chat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const chat = selectRecentChat(btn.dataset.selectChat);
      if (chat) {
        emit('navigate', 'chat');
        if (window.innerWidth <= 980) setSidebarOpen(false);
      }
    });

    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      contextMenuChatId = btn.dataset.selectChat;
      showNotebookSubmenu = true;
      renderContextMenu(e.clientX, e.clientY);
    });
  });

  chatList.querySelectorAll('[data-menu-chat]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const chatId = btn.dataset.menuChat;
      if (contextMenuChatId === chatId) {
        closeContextMenu();
        return;
      }
      contextMenuChatId = chatId;
      showNotebookSubmenu = false;
      const rect = btn.getBoundingClientRect();
      renderContextMenu(rect.right + 6, rect.top);
    });
  });
}

export function initSidebar() {
  if (window.innerWidth <= 980 && isSidebarOpen()) {
    setSidebarOpen(false);
  }
  syncDrawerDOM(isSidebarOpen());
  renderLists();

  document.getElementById('sidebar-toggle-btn')?.addEventListener('click', () => {
    toggleSidebar();
  });

  document.getElementById('sidebar-collapse-btn')?.addEventListener('click', () => {
    setSidebarOpen(false);
  });

  document.getElementById('sb-new-chat-btn')?.addEventListener('click', () => {
    createRecentChat();
    emit('navigate', 'chat');
    if (window.innerWidth <= 980) setSidebarOpen(false);
  });

  // Ask the user to enter the Notebook name in a clean modal dialog
  document.getElementById('sb-new-nb-btn')?.addEventListener('click', () => {
    openCreateNotebookModal();
  });

  const nbForm = document.getElementById('nb-create-form');
  const nbInput = document.getElementById('nb-create-input');
  const nbError = document.getElementById('nb-create-error');

  nbForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = nbInput?.value.trim() || '';
    if (!title) {
      if (nbError) {
        nbError.textContent = 'Enter a notebook name to continue.';
        nbError.style.display = 'block';
      }
      nbInput?.focus();
      return;
    }

    if (pendingMigrationChatId) {
      const migrated = moveChatToNotebook(pendingMigrationChatId, 'new', title);
      closeCreateNotebookModal();
      if (migrated) {
        emit('navigate', 'chat');
        if (window.innerWidth <= 980) setSidebarOpen(false);
      }
      return;
    }

    createNotebook(title);
    closeCreateNotebookModal();
    emit('navigate', 'chat');
    if (window.innerWidth <= 980) setSidebarOpen(false);
  });

  document.getElementById('nb-create-cancel')?.addEventListener('click', closeCreateNotebookModal);
  document.getElementById('nb-create-close')?.addEventListener('click', closeCreateNotebookModal);
  document.getElementById('nb-create-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'nb-create-modal') closeCreateNotebookModal();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#sidebar-context-menu') && !e.target.closest('[data-menu-chat]')) {
      closeContextMenu();
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      toggleSidebar();
    } else if (e.key === 'Escape') {
      closeContextMenu();
      closeCreateNotebookModal();
    }
  });

  on('sidebar:toggled', syncDrawerDOM);
  on('notebooks:changed', renderLists);
}
