/**
 * Editorial Mission Dashboard: Hero Prompt Bar, Operational KPIs,
 * AI Mission Brief, Interactive Feature Panels, Charts & Empirical Findings Feed.
 */

import { api } from './api.js';
import { refreshScrollReveals } from './scroll-reveal.js';
import { chartThemeColors, emit, esc, on, renderRichMarkdown, state } from './state.js';

let categoryChart = null;
let regimeChart = null;
let cachedStats = null;

function bindHeroAndPanels() {
  document.querySelectorAll('#view-dashboard [data-hero-prompt]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const q = btn.dataset.heroPrompt;
      if (q) emit('chat:ask', q);
    });
  });

  document.querySelectorAll('#view-dashboard [data-jump-tab]').forEach((btn) => {
    const go = () => {
      const tab = btn.dataset.jumpTab;
      if (tab) emit('navigate', tab);
    };
    btn.addEventListener('click', go);
    if (btn.tagName !== 'BUTTON' && btn.tagName !== 'A') {
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          go();
        }
      });
    }
  });
}

export async function initDashboard() {
  bindHeroAndPanels();

  try {
    const [stats, summary, findingsRes] = await Promise.all([
      api.stats(),
      api.summary(),
      api.findings(),
    ]);
    cachedStats = stats;
    state.stats = stats;
    state.findings = findingsRes.findings || [];

    const runsBadge = document.getElementById('showcase-runs-badge');
    if (runsBadge && stats.total_test_runs) {
      runsBadge.textContent = `+${stats.total_test_runs} NASA Runs`;
    }

    renderKPIs(stats);
    renderMissionBrief(summary);
    renderDashboardCharts(stats);
    renderFindingsFeed(state.findings);

    const dashPanel = document.getElementById('view-dashboard');
    if (dashPanel) refreshScrollReveals(dashPanel);
  } catch (err) {
    console.error('Dashboard load error:', err);
  }

  on('theme:changed', () => {
    if (cachedStats) renderDashboardCharts(cachedStats);
  });
}

function renderKPIs(s) {
  const grid = document.getElementById('dashboard-kpis');
  if (!grid) return;

  const cards = [
    {
      label: 'NASA Experiments & Runs',
      value: `${s.total_experiments} + ${s.total_test_runs}`,
      sub: 'BASS, ACME, SAFFIRE, FLEX & SoFIE runs',
      accent: 'var(--accent-flame)',
      iconBg: 'var(--accent-flame-soft)',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 3h6"/><path d="M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3"/></svg>',
      tab: 'ranking',
    },
    {
      label: 'Materials & Findings',
      value: `${s.materials_tested} · ${s.key_findings}`,
      sub: 'Calibrated LOI polymers & flight milestones',
      accent: 'var(--accent-cyan)',
      iconBg: 'var(--accent-cyan-soft)',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
      tab: 'cabin',
    },
    {
      label: 'Knowledge Graph',
      value: `${s.graph_nodes}`,
      sub: `${s.graph_edges} linked NASA safety relations`,
      accent: 'var(--accent-violet)',
      iconBg: 'var(--accent-violet-soft)',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><line x1="8.5" y1="7.5" x2="15.5" y2="7.5"/><line x1="7.5" y1="8.5" x2="10.8" y2="15.4"/><line x1="16.5" y1="8.5" x2="13.2" y2="15.4"/></svg>',
      tab: 'graph',
    },
    {
      label: 'NASA Papers & PDFs',
      value: `${s.nasa_documents}`,
      sub: 'Indexed NTRS reports + 9 official NASA PDFs',
      accent: 'var(--accent-sage)',
      iconBg: 'var(--accent-sage-bg)',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
      tab: 'resources',
    },
  ];

  grid.innerHTML = cards
    .map(
      (c) => `
      <div class="kpi-card" style="cursor:pointer;" data-jump-tab="${c.tab}">
        <div class="kpi-head">
          <div class="kpi-label">${esc(c.label)}</div>
          <div class="kpi-icon-circle" style="background:${c.iconBg};color:${c.accent};">${c.icon}</div>
        </div>
        <div class="kpi-value" style="color:${c.accent};">${esc(c.value)}</div>
        <div class="kpi-sub">${esc(c.sub)}</div>
      </div>
    `
    )
    .join('');

  grid.querySelectorAll('[data-jump-tab]').forEach((card) => {
    card.addEventListener('click', () => emit('navigate', card.dataset.jumpTab));
  });
}

function renderMissionBrief(summary) {
  const el = document.getElementById('dashboard-mission-brief');
  if (!el || !summary) return;

  const actionsHtml = (summary.recommended_actions || [])
    .map((a) => `<li style="margin-bottom:6px;">${renderRichMarkdown(a)}</li>`)
    .join('');

  el.innerHTML = `
    <div class="flex items-center justify-between flex-wrap gap-3 mb-3">
      <div>
        <div class="card-kicker">AI MISSION BRIEF</div>
        <h2 style="font-family:var(--font-display);font-size:21px;font-weight:800;letter-spacing:-0.025em;margin:0;">Fire Safety Intelligence Summary</h2>
      </div>
      <div class="flex gap-2 flex-wrap">
        <button type="button" class="btn btn-primary btn-sm" id="brief-launch-twin">Launch 3D Flame Twin</button>
        <button type="button" class="btn btn-sm" id="brief-launch-cabin">Open Cabin Shapley Lab</button>
        <button type="button" class="btn btn-sm" id="brief-launch-chat">Ask FlameAI</button>
      </div>
    </div>

    <p style="font-size:14px;margin:0 0 16px;color:var(--text-secondary);line-height:1.6;">${esc(summary.headline)}</p>

    <div class="grid-3 mb-3">
      <div style="background:var(--bg-surface-solid);border:1px solid var(--border-subtle);border-radius:14px;padding:14px 16px;">
        <div style="font-size:10.5px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:var(--text-muted);">Top-Ranked Experiment</div>
        <div style="font-weight:800;font-size:15.5px;margin:5px 0 3px;color:var(--text-primary);">${esc(summary.top_ranked_experiment?.name)}</div>
        <div class="text-sec" style="font-size:12px;">Score <span class="mono" style="font-weight:600;color:var(--accent-flame);">${esc(summary.top_ranked_experiment?.score)}</span> · ${esc(summary.top_ranked_experiment?.reason)}</div>
      </div>

      <div style="background:var(--bg-surface-solid);border:1px solid var(--border-subtle);border-radius:14px;padding:14px 16px;">
        <div style="font-size:10.5px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:var(--text-muted);">Highest Risk in 34% O₂ (Artemis)</div>
        <div style="font-weight:800;font-size:15.5px;margin:5px 0 3px;color:var(--risk-crit);">${esc(summary.highest_risk_material_34_o2?.name)}</div>
        <div class="text-sec" style="font-size:12px;">PMMA Artemis Risk: <span class="mono" style="font-weight:600;">${esc(summary.highest_risk_material_34_o2?.pmma_artemis_risk_index)}/100</span> (LOI ${esc(summary.highest_risk_material_34_o2?.pmma_artemis_loi)}%)</div>
      </div>

      <div style="background:var(--bg-surface-solid);border:1px solid var(--border-subtle);border-radius:14px;padding:14px 16px;">
        <div style="font-size:10.5px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:var(--text-muted);">Priority Safety Directive</div>
        <div style="font-weight:800;font-size:15.5px;margin:5px 0 3px;color:var(--accent-cyan);">${esc(summary.priority_safety_directive?.title)}</div>
        <div class="text-sec" style="font-size:12px;">${esc(summary.priority_safety_directive?.recommendation)}</div>
      </div>
    </div>

    <div style="font-size:12.5px;color:var(--text-secondary);padding-top:10px;border-top:1px solid var(--border-subtle);">
      <strong style="color:var(--text-primary);">Priority Engineering Actions</strong> <span class="text-muted">(click inline citations to inspect NASA papers)</span>
      <ul style="margin:7px 0 0;padding-left:18px;">${actionsHtml}</ul>
    </div>
  `;

  el.querySelector('#brief-launch-twin')?.addEventListener('click', () => emit('navigate', 'twin'));
  el.querySelector('#brief-launch-cabin')?.addEventListener('click', () => emit('navigate', 'cabin'));
  el.querySelector('#brief-launch-chat')?.addEventListener('click', () => emit('navigate', 'chat'));
}

function renderDashboardCharts(s) {
  if (typeof Chart === 'undefined') return;
  const colors = chartThemeColors();

  // 1. Flagship Experiments by Category
  const catCanvas = document.getElementById('dash-cat-chart');
  if (catCanvas) {
    if (categoryChart) categoryChart.destroy();
    const entries = Object.entries(s.categories || {});
    categoryChart = new Chart(catCanvas, {
      type: 'bar',
      data: {
        labels: entries.map(([k]) => k),
        datasets: [
          {
            label: 'Missions',
            data: entries.map(([, v]) => v),
            backgroundColor: ['#ff5e3a', '#0284c7', '#7c3aed', '#16a34a', '#d97706', '#e11d48'],
            borderRadius: 8,
            barThickness: 22,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y',
        scales: {
          x: { ticks: { color: colors.text, stepSize: 1 }, grid: { color: colors.grid } },
          y: { ticks: { color: colors.text, font: { size: 11.5 } }, grid: { display: false } },
        },
        plugins: { legend: { display: false } },
      },
    });
  }

  // 2. 50 NASA Test Runs by Combustion Regime
  const regCanvas = document.getElementById('dash-regime-chart');
  if (regCanvas) {
    if (regimeChart) regimeChart.destroy();
    const entries = Object.entries(s.run_regimes || {});
    const palette = {
      'Sustained Burn': '#ff5e3a',
      'Cool Flame': '#0284c7',
      'Self-Extinguished': '#eab308',
      'No Ignition': '#16a34a',
    };
    regimeChart = new Chart(regCanvas, {
      type: 'doughnut',
      data: {
        labels: entries.map(([k]) => k),
        datasets: [
          {
            data: entries.map(([, v]) => v),
            backgroundColor: entries.map(([k]) => palette[k] || '#7c3aed'),
            borderWidth: 3,
            borderColor: state.theme === 'light' ? '#ffffff' : '#0b0b0e',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '64%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: colors.text, padding: 14, boxWidth: 11, font: { size: 12 } },
          },
        },
      },
    });
  }
}

function renderFindingsFeed(findings) {
  const wrap = document.getElementById('dash-findings-grid');
  if (!wrap) return;
  const top = findings.slice(0, 6);
  wrap.innerHTML = top
    .map(
      (f) => `
      <div style="background:var(--bg-surface-solid);border:1px solid var(--border-subtle);border-radius:16px;padding:16px 18px;display:flex;flex-direction:column;justify-content:space-between;gap:10px;">
        <div>
          <div class="flex items-center justify-between gap-2 mb-3">
            <span class="badge badge-cyan">${esc(f.source_experiment)}</span>
            <span class="badge ${String(f.safety_relevance).toUpperCase().includes('CRIT') ? 'risk-CRITICAL' : 'badge-flame'}">${esc(f.safety_relevance || 'High')}</span>
          </div>
          <h4 style="margin:0 0 6px;font-family:var(--font-display);font-size:14.5px;font-weight:700;line-height:1.35;">${esc(f.title)}</h4>
          <p class="text-sec" style="font-size:12.5px;margin:0;line-height:1.55;">${esc(f.description)}</p>
        </div>
        ${
          f.quantitative_result
            ? `<div class="mono" style="font-size:11.5px;color:var(--accent-cyan);padding:7px 10px;background:var(--bg-surface-2);border-radius:9px;">${esc(f.quantitative_result)}</div>`
            : ''
        }
      </div>
    `
    )
    .join('');
}
