/**
 * Flame in Freefall v3.0 — Main Application Bootstrapper
 * Coordinates routing, Dark/Light mode slider, Global Search, Shared Cabin Scenario Pill,
 * Global Modal / Document Reader, and delegated citation chip navigation.
 */

import { api } from './api.js';
import { initCabin } from './cabin.js';
import { initChat } from './chat.js';
import { initDashboard } from './dashboard.js';
import { initExplorer, openExperimentModal } from './explorer.js';
import { initFlameTwin } from './flame-twin.js';
import { initGraph } from './graph.js';
import { initRanking, openEntityRankingTab, selectRunForTelemetry } from './ranking.js';
import { initResources, openDocumentReader } from './resources.js';
import { emit, esc, on, riskColor, setActiveCabin, setTheme, state } from './state.js';

function navigate(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.view-panel').forEach((p) => {
    p.classList.toggle('active', p.id === `view-${tab}`);
  });
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  // Close mobile drawer if open
  document.getElementById('mobile-drawer')?.classList.remove('open');
  window.scrollTo({ top: 0, behavior: 'instant' });
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
            row.addEventListener('click', async () => {
              dropdown.classList.remove('open');
              input.value = '';
              const type = row.dataset.srType;
              const id = row.dataset.srId;
              if (type === 'paper') {
                openDocumentReader(id, 1);
              } else if (type === 'test_run') {
                navigate('ranking');
                selectRunForTelemetry(id);
              } else if (type === 'material') {
                navigate('cabin');
                let targetMat = id;
                try {
                  const res = await fetch(`/api/materials/${encodeURIComponent(id)}`);
                  if (res.ok) {
                    const data = await res.json();
                    if (data.canonical_name) targetMat = data.canonical_name;
                  }
                } catch {
                  // fall back to id
                }
                setActiveCabin({ fuel_material: targetMat });
              } else if (type === 'guideline') {
                navigate('ranking');
                openEntityRankingTab('guidelines');
              } else if (type === 'experiment') {
                navigate('explorer');
                openExperimentModal(id);
              } else if (type === 'finding') {
                await openFindingModal(id);
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

async function openFindingModal(findingId) {
  try {
    const data = await api.findingDetail(findingId);
    const f = data.finding;
    const similar = data.similar || [];
    const html = `
      <div class="flex flex-wrap gap-2 mb-3">
        <span class="badge badge-cyan">${esc(f.source_experiment || 'NASA')}</span>
        <span class="badge badge-flame">${esc(f.safety_relevance || 'High')}</span>
        ${f.category ? `<span class="badge">${esc(f.category)}</span>` : ''}
      </div>
      <p style="margin-top:0;">${esc(f.description || '')}</p>
      ${
        f.quantitative_result
          ? `<h4 style="font-family:var(--font-display);margin:14px 0 6px;">Quantitative Result</h4>
             <div class="mono" style="font-size:12.5px;color:var(--accent-cyan);padding:9px 12px;background:var(--bg-surface-2);border-radius:8px;">${esc(f.quantitative_result)}</div>`
          : ''
      }
      ${
        f.implications_for_spacecraft
          ? `<h4 style="font-family:var(--font-display);margin:14px 0 6px;">Spacecraft Fire-Safety Implications</h4>
             <p class="text-sec" style="margin:0;">${esc(f.implications_for_spacecraft)}</p>`
          : ''
      }
      ${
        similar.length
          ? `<h4 style="font-family:var(--font-display);margin:14px 0 6px;">Related Empirical Findings</h4>
             <ul style="padding-left:18px;margin:0;">
               ${similar.slice(0, 4).map((s) => `<li style="margin-bottom:5px;"><strong>${esc(s.title)}</strong> <span class="text-muted">(${esc(s.source_experiment || '')})</span></li>`).join('')}
             </ul>`
          : ''
      }
    `;
    openModal({
      title: f.title || findingId,
      subtitle: `${f.source_experiment || 'NASA'} · Empirical Finding`,
      bodyHtml: html,
    });
  } catch (err) {
    console.error('Finding detail error:', err);
  }
}

function closeModal() {
  document.getElementById('global-modal')?.classList.remove('open');
}

async function bootstrap() {
  // Apply saved theme immediately
  setTheme(state.theme);

  // Register PWA service worker for offline shell caching (always check for fresh updates)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .then((reg) => reg.update().catch(() => {}))
      .catch((err) => {
        console.warn('Service worker registration failed:', err);
      });
  }

  // Theme slider toggle
  document.getElementById('theme-toggle-btn')?.addEventListener('click', () => {
    setTheme(state.theme === 'dark' ? 'light' : 'dark');
  });

  // Brand emblem & Ask CTA
  document.getElementById('brand-home-link')?.addEventListener('click', () => navigate('dashboard'));
  document.getElementById('nav-ask-cta')?.addEventListener('click', () => navigate('chat'));

  // Navigation items (top pill bar + mobile drawer)
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => navigate(btn.dataset.tab));
  });

  // Mobile menu button
  document.getElementById('mobile-menu-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('mobile-drawer')?.classList.toggle('open');
  });

  document.addEventListener('click', (e) => {
    const drawer = document.getElementById('mobile-drawer');
    if (drawer?.classList.contains('open') && !e.target.closest('#mobile-drawer') && !e.target.closest('#mobile-menu-btn')) {
      drawer.classList.remove('open');
    }
  });

  // Subtle rAF-throttled ambient cursor glow (skipped under prefers-reduced-motion)
  const reduceMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduceMotion) {
    let glowRaf = null;
    let mx = 0;
    let my = 0;
    window.addEventListener(
      'pointermove',
      (e) => {
        mx = e.clientX;
        my = e.clientY;
        if (glowRaf !== null) return;
        glowRaf = requestAnimationFrame(() => {
          glowRaf = null;
          document.body.style.setProperty('--mouse-x', `${mx}px`);
          document.body.style.setProperty('--mouse-y', `${my}px`);
        });
      },
      { passive: true }
    );
  }

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
