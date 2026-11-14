/**
 * Flame in Freefall v3.0 — Main Application Bootstrapper
 * Coordinates routing, Dark/Light mode slider, Global Search, Shared Cabin Scenario Pill,
 * Global Modal / Document Reader, and delegated citation chip navigation.
 */

import { api } from './api.js';
import { initCabin } from './cabin.js';
import { initChat } from './chat.js';
import { initDashboard } from './dashboard.js';
import { initExplorer } from './explorer.js';
import { initFlameTwin } from './flame-twin.js';
import { initGraph } from './graph.js';
import { initRanking, selectRunForTelemetry } from './ranking.js';
import { initResources, openDocumentReader } from './resources.js';
import { emit, esc, on, riskColor, setTheme, state } from './state.js';

function navigate(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.view-panel').forEach((p) => {
    p.classList.toggle('active', p.id === `view-${tab}`);
  });
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  // Close mobile drawer if open
  document.getElementById('sidebar')?.classList.remove('mobile-open');
  emit('tab:changed', tab);
}

function updateScenarioPill() {
  const pill = document.getElementById('active-scenario-pill');
  const dot = document.getElementById('scenario-risk-dot');
  const text = document.getElementById('scenario-pill-text');
  if (!pill || !text) return;
  const c = state.activeCabin;
  const ev = state.activeCabinEval;
  const band = ev?.risk_band || 'MODERATE';
  if (dot) dot.style.background = riskColor(band);
  text.textContent = `${c.oxygen_pct}% O₂ · ${c.pressure_kpa} kPa · ${c.flow_velocity_cm_s} cm/s · ${c.gravity_g}g · ${c.fuel_material}${ev ? ` · Risk ${ev.risk_index.toFixed(0)}` : ''}`;
}

function initGlobalSearch() {
  const input = document.getElementById('global-search-input');
  const dropdown = document.getElementById('global-search-dropdown');
  if (!input || !dropdown) return;
  let timer = null;

  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (timer) clearTimeout(timer);
    if (!q) {
      dropdown.classList.remove('open');
      dropdown.innerHTML = '';
      return;
    }
    timer = setTimeout(async () => {
      try {
        const res = await api.search(q);
        const items = res.results || [];
        if (!items.length) {
          dropdown.innerHTML = `<div class="search-result-row text-muted">No results for "${esc(q)}"</div>`;
        } else {
          dropdown.innerHTML = items
            .slice(0, 12)
            .map(
              (item) => `
              <div class="search-result-row" data-sr-tab="${esc(item.tab)}" data-sr-type="${esc(item.type)}" data-sr-id="${esc(item.id)}">
                <div class="flex items-center justify-between gap-2">
                  <strong style="font-size:13px;">${esc(item.title)}</strong>
                  <span class="badge">${esc(item.type)} · ${esc(item.badge || '')}</span>
                </div>
                <div class="text-muted" style="font-size:11.5px;margin-top:2px;">${esc(item.snippet)}</div>
              </div>
            `
            )
            .join('');
          dropdown.querySelectorAll('[data-sr-tab]').forEach((row) => {
            row.addEventListener('click', () => {
              dropdown.classList.remove('open');
              input.value = '';
              const type = row.dataset.srType;
              const id = row.dataset.srId;
              if (type === 'paper') {
                openDocumentReader(id, 1);
              } else if (type === 'test_run') {
                navigate('ranking');
                selectRunForTelemetry(id);
              } else {
                navigate(row.dataset.srTab);
              }
            });
          });
        }
        dropdown.classList.add('open');
      } catch (err) {
        console.warn('Global search error:', err);
      }
    }, 180);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.global-search-wrap')) {
      dropdown.classList.remove('open');
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      input.focus();
    } else if (e.key === 'Escape') {
      dropdown.classList.remove('open');
      closeModal();
    }
  });
}

function openModal({ title, subtitle = '', bodyHtml = '', scrollToId = null }) {
  const backdrop = document.getElementById('global-modal');
  const titleEl = document.getElementById('global-modal-title');
  const subEl = document.getElementById('global-modal-subtitle');
  const bodyEl = document.getElementById('global-modal-body');
  if (!backdrop || !bodyEl) return;

  if (titleEl) titleEl.textContent = title;
  if (subEl) subEl.textContent = subtitle;
  bodyEl.innerHTML = bodyHtml;
  backdrop.classList.add('open');

  if (scrollToId) {
    setTimeout(() => {
      document.getElementById(scrollToId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  }
}

function closeModal() {
  document.getElementById('global-modal')?.classList.remove('open');
}

async function bootstrap() {
  // Apply saved theme immediately
  setTheme(state.theme);

  // Theme slider toggle
  document.getElementById('theme-toggle-btn')?.addEventListener('click', () => {
    setTheme(state.theme === 'dark' ? 'light' : 'dark');
  });

  // Navigation items
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => navigate(btn.dataset.tab));
  });

  // Mobile menu button
  document.getElementById('mobile-menu-btn')?.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.toggle('mobile-open');
  });

  // Active scenario pill -> Cabin Lab
  document.getElementById('active-scenario-pill')?.addEventListener('click', () => navigate('cabin'));

  // Modal close handlers
  document.getElementById('global-modal-close')?.addEventListener('click', closeModal);
  document.getElementById('global-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'global-modal') closeModal();
  });

  // Global delegated clicks for clickable [DOC-XX p.Y] and [EXP-XXXX] badges ANYWHERE
  document.addEventListener('click', (e) => {
    const docBtn = e.target.closest('[data-doc-id]');
    if (docBtn) {
      e.preventDefault();
      openDocumentReader(docBtn.dataset.docId, Number(docBtn.dataset.docPage || 1));
      return;
    }
    const expBtn = e.target.closest('[data-exp-id]');
    if (expBtn) {
      e.preventDefault();
      closeModal();
      navigate('ranking');
      selectRunForTelemetry(expBtn.dataset.expId);
    }
  });

  on('navigate', navigate);
  on('modal:open', openModal);
  on('cabin:changed', updateScenarioPill);
  on('cabin:pill-refresh', updateScenarioPill);
  on('cabin:evaluated', updateScenarioPill);

  initGlobalSearch();

  // Check backend health & label AI engine
  try {
    const h = await api.health();
    const label = document.getElementById('sidebar-ai-engine');
    if (label) label.textContent = h.ai_engine || 'NASA Grounded Engine';
  } catch (err) {
    console.warn('Health check failed:', err);
  }

  // Initialize all 8 mission modules in parallel
  await Promise.allSettled([
    initDashboard(),
    initFlameTwin(),
    initCabin(),
    initRanking(),
    initExplorer(),
    initResources(),
    initGraph(),
  ]);
  initChat();
  updateScenarioPill();
  navigate('dashboard');
}

document.addEventListener('DOMContentLoaded', bootstrap);
