/**
 * Ignis v3.0 — Main Application Bootstrapper
 * Fast lazy-hydrated shell: loads ONLY Dashboard on initial entry and dynamically
 * imports heavier tabs (3D Flame Twin, Cabin & Shapley, Run Ranker, Explorer,
 * FlameAI Chat, Knowledge Graph, NASA Library, and Chart.js) on demand.
 */

import { api } from './api.js';
import { initDashboard } from './dashboard.js';
import { hasGlassIntroStarted, playGlassIntro } from './glass-intro.js';
import { initMorphingDock } from './morphing-dock.js';
import {
  applyPreferences,
  getPreferences,
  syncSettingsOnStartup,
  updateEngineStatusBadge,
} from './preferences.js';
import { initScrollReveal, refreshScrollReveals } from './scroll-reveal.js';
import { emit, esc, on, riskColor, setActiveCabin, setTheme, state } from './state.js';

let chartJsPromise = null;
function ensureChartJs() {
  if (typeof window.Chart !== 'undefined') return Promise.resolve(window.Chart);
  if (!chartJsPromise) {
    chartJsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/js/vendor/chart.umd.min.js';
      s.async = true;
      s.onload = () => resolve(window.Chart);
      s.onerror = () => {
        chartJsPromise = null;
        reject(new Error('Failed to load Chart.js'));
      };
      document.head.appendChild(s);
    });
  }
  return chartJsPromise;
}

const moduleCache = new Map();
const moduleInitPromises = new Map();

const TAB_LOADERS = {
  twin: async () => {
    const mod = await import('./flame-twin.js');
    await mod.initFlameTwin();
    return mod;
  },
  cabin: async () => {
    const [, mod] = await Promise.all([ensureChartJs(), import('./cabin.js')]);
    await mod.initCabin();
    return mod;
  },
  ranking: async () => {
    const [, mod] = await Promise.all([ensureChartJs(), import('./ranking.js')]);
    await mod.initRanking();
    return mod;
  },
  explorer: async () => {
    const [, mod] = await Promise.all([ensureChartJs(), import('./explorer.js')]);
    await mod.initExplorer();
    return mod;
  },
  chat: async () => {
    const mod = await import('./chat.js');
    mod.initChat();
    return mod;
  },
  graph: async () => {
    const mod = await import('./graph.js');
    await mod.initGraph();
    return mod;
  },
  resources: async () => {
    const mod = await import('./resources.js');
    await mod.initResources();
    return mod;
  },
  settings: async () => {
    const mod = await import('./settings.js');
    await mod.initSettings();
    return mod;
  },
};

function ensureTabModule(tab) {
  if (!TAB_LOADERS[tab]) return Promise.resolve(null);
  if (moduleCache.has(tab)) return Promise.resolve(moduleCache.get(tab));
  if (!moduleInitPromises.has(tab)) {
    const job = TAB_LOADERS[tab]()
      .then((mod) => {
        moduleCache.set(tab, mod);
        return mod;
      })
      .catch((err) => {
        moduleInitPromises.delete(tab);
        console.error(`Failed to initialize module "${tab}":`, err);
        return null;
      });
    moduleInitPromises.set(tab, job);
  }
  return moduleInitPromises.get(tab);
}

async function navigate(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.view-panel').forEach((p) => {
    p.classList.toggle('active', p.id === `view-${tab}`);
  });
  document.querySelectorAll('.nav-item, #nav-settings-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.getElementById('mobile-drawer')?.classList.remove('open');
  window.scrollTo({ top: 0, behavior: 'instant' });

  // Lazily hydrate the target tab's module on first visit
  if (TAB_LOADERS[tab] && !moduleCache.has(tab)) {
    await ensureTabModule(tab);
  }
  const activePanel = document.getElementById(`view-${tab}`);
  if (activePanel) refreshScrollReveals(activePanel);
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

async function openSearchItem(item) {
  if (!item) return;
  const type = item.type;
  const id = item.id;
  if (type === 'paper') {
    const mod = await ensureTabModule('resources');
    mod?.openDocumentReader(id, 1);
  } else if (type === 'test_run') {
    await navigate('ranking');
    const mod = await ensureTabModule('ranking');
    mod?.selectRunForTelemetry(id);
  } else if (type === 'material') {
    await navigate('cabin');
    let targetMat = id;
    try {
      const mRes = await fetch(`/api/materials/${encodeURIComponent(id)}`);
      if (mRes.ok) {
        const data = await mRes.json();
        if (data.canonical_name) targetMat = data.canonical_name;
      }
    } catch {
      // fall back to id
    }
    setActiveCabin({ fuel_material: targetMat });
  } else if (type === 'guideline') {
    await navigate('ranking');
    const mod = await ensureTabModule('ranking');
    mod?.openEntityRankingTab('guidelines');
  } else if (type === 'experiment') {
    await navigate('explorer');
    const mod = await ensureTabModule('explorer');
    mod?.openExperimentModal(id);
  } else if (type === 'finding') {
    await openFindingModal(id);
  } else if (item.tab) {
    navigate(item.tab);
  }
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
              await openSearchItem({
                type: row.dataset.srType,
                id: row.dataset.srId,
                tab: row.dataset.srTab,
              });
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
  const initialPrefs = applyPreferences(null, { persistLocal: false, persistServer: false });

  if (initialPrefs.showIntro !== false && !hasGlassIntroStarted()) {
    playGlassIntro({ theme: state.theme });
  } else if (initialPrefs.showIntro === false) {
    document.getElementById('intro-splash')?.remove();
    document.body.classList.remove('intro-active');
    document.querySelector('.hero-section[data-enter]')?.classList.add('is-entered');
  }
  window.replayFlameIntro = () => playGlassIntro({ theme: state.theme });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .then((reg) => reg.update().catch(() => {}))
      .catch((err) => {
        console.warn('Service worker registration failed:', err);
      });
  }

  let lastDarkPalette =
    initialPrefs.palette && initialPrefs.palette !== 'warm-paper'
      ? initialPrefs.palette
      : 'obsidian-ember';

  document.getElementById('theme-toggle-btn')?.addEventListener('click', () => {
    const prefs = getPreferences();
    if (state.theme === 'dark') {
      if (prefs.palette && prefs.palette !== 'warm-paper') lastDarkPalette = prefs.palette;
      applyPreferences({ palette: 'warm-paper' }, { persistLocal: true, persistServer: true });
    } else {
      applyPreferences({ palette: lastDarkPalette || 'obsidian-ember' }, { persistLocal: true, persistServer: true });
    }
  });

  document.getElementById('nav-settings-btn')?.addEventListener('click', () => navigate('settings'));
  document.querySelector('.engine-status-pill')?.addEventListener('click', () => navigate('settings'));

  document.getElementById('brand-home-link')?.addEventListener('click', (e) => {
    if (e.shiftKey) {
      playGlassIntro({ theme: state.theme });
      return;
    }
    navigate('dashboard');
  });
  document.getElementById('nav-ask-cta')?.addEventListener('click', () => navigate('chat'));

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => navigate(btn.dataset.tab));
  });

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

  document.getElementById('active-scenario-pill')?.addEventListener('click', () => navigate('cabin'));
  document.getElementById('global-modal-close')?.addEventListener('click', closeModal);
  document.getElementById('global-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'global-modal') closeModal();
  });

  // Delegated citation & run clicks lazily load their backing view module on demand
  document.addEventListener('click', async (e) => {
    const docBtn = e.target.closest('[data-doc-id]');
    if (docBtn) {
      e.preventDefault();
      const mod = await ensureTabModule('resources');
      mod?.openDocumentReader(docBtn.dataset.docId, Number(docBtn.dataset.docPage || 1));
      return;
    }
    const expBtn = e.target.closest('[data-exp-id]');
    if (expBtn) {
      e.preventDefault();
      closeModal();
      await navigate('ranking');
      const mod = await ensureTabModule('ranking');
      mod?.selectRunForTelemetry(expBtn.dataset.expId);
    }
  });

  on('navigate', (tab) => {
    navigate(tab);
  });
  on('modal:open', openModal);
  on('cabin:changed', updateScenarioPill);
  on('cabin:pill-refresh', updateScenarioPill);
  on('cabin:evaluated', updateScenarioPill);

  // Lazy bridge for FlameAI questions triggered from any tab
  on('chat:ask', async (question) => {
    await navigate('chat');
    const mod = await ensureTabModule('chat');
    mod?.askChatQuestion(question);
  });

  on('doc:open', async ({ docId, page }) => {
    const mod = await ensureTabModule('resources');
    mod?.openDocumentReader(docId, page || 1);
  });

  on('search:open-item', (item) => {
    openSearchItem(item);
  });

  initGlobalSearch();
  initMorphingDock();
  initScrollReveal();
  updateScenarioPill();

  // Only hydrate the visible Dashboard + lightweight health & persisted settings sync on initial load!
  await Promise.allSettled([
    api.health().then((h) => {
      updateEngineStatusBadge(h.ai_engine || 'NASA Grounded Engine');
    }).catch(() => {}),
    syncSettingsOnStartup(),
    initDashboard(),
  ]);

  navigate('dashboard');
}

document.addEventListener('DOMContentLoaded', bootstrap);
