/**
 * Mission Control Dashboard: KPIs, AI Mission Brief, Distribution Charts & Findings.
 */

import { api } from './api.js';
import { chartThemeColors, emit, esc, on, renderRichMarkdown, state } from './state.js';

let categoryChart = null;
let regimeChart = null;
let cachedStats = null;

export async function initDashboard() {
  try {
    const [stats, summary, findingsRes] = await Promise.all([
      api.stats(),
      api.summary(),
      api.findings(),
    ]);
    cachedStats = stats;
    state.stats = stats;
    state.findings = findingsRes.findings || [];

    renderKPIs(stats);
    renderMissionBrief(summary);
    renderDashboardCharts(stats);
    renderFindingsFeed(state.findings);
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
      sub: 'Flagship ISS/Cygnus missions & telemetry runs',
      accent: '#f97316',
      tab: 'ranking',
    },
    {
      label: 'Materials & Findings',
      value: `${s.materials_tested} · ${s.key_findings}`,
      sub: 'Calibrated LOI polymers & empirical milestones',
      accent: '#06b6d4',
      tab: 'cabin',
    },
    {
      label: 'Knowledge Graph',
      value: `${s.graph_nodes}`,
      sub: `${s.graph_edges} semantic NASA links indexed`,
      accent: '#8b5cf6',
      tab: 'graph',
    },
    {
      label: 'NASA Corpus & PDFs',
      value: `${s.nasa_documents}`,
      sub: 'Full-text NTRS papers + 9 official NASA PDFs',
      accent: '#22c55e',
      tab: 'resources',
    },
  ];

  grid.innerHTML = cards
    .map(
      (c) => `
      <div class="kpi-card" style="cursor:pointer;border-top:2px solid ${c.accent};" data-jump-tab="${c.tab}">
        <div class="kpi-label">${esc(c.label)}</div>
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
    .map((a) => `<li style="margin-bottom:5px;">${renderRichMarkdown(a)}</li>`)
    .join('');

  el.innerHTML = `
    <div class="flex items-center justify-between flex-wrap gap-2 mb-3">
      <div>
        <div class="card-kicker">AI MISSION BRIEF · NASA SPACE APPS 2026</div>
        <h2 style="font-family:var(--font-display);font-size:19px;margin:0;">Executive Spacecraft Fire-Safety Synthesis</h2>
      </div>
      <div class="flex gap-2 flex-wrap">
        <button type="button" class="btn btn-primary btn-sm" id="brief-launch-twin">Launch 3D Flame Twin</button>
        <button type="button" class="btn btn-cyan btn-sm" id="brief-launch-cabin">Open Cabin Shapley Lab</button>
        <button type="button" class="btn btn-sm" id="brief-launch-chat">Ask FlameAI Co-Pilot</button>
      </div>
    </div>

    <p style="font-size:14px;margin:0 0 14px;color:var(--text-primary);">${esc(summary.headline)}</p>

    <div class="grid-3 mb-3">
      <div style="background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:11px;padding:12px 14px;">
        <div class="mono text-muted" style="font-size:10.5px;">TOP RANKED EXPERIMENT</div>
        <div style="font-weight:700;font-size:15px;margin:3px 0;color:var(--accent-flame);">${esc(summary.top_ranked_experiment?.name)}</div>
        <div class="text-sec" style="font-size:12px;">Score ${esc(summary.top_ranked_experiment?.score)} · ${esc(summary.top_ranked_experiment?.reason)}</div>
      </div>

      <div style="background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:11px;padding:12px 14px;">
        <div class="mono text-muted" style="font-size:10.5px;">HIGHEST RISK IN 34% O₂ (ARTEMIS)</div>
        <div style="font-weight:700;font-size:15px;margin:3px 0;color:var(--risk-crit);">${esc(summary.highest_risk_material_34_o2?.name)}</div>
        <div class="text-sec" style="font-size:12px;">PMMA Artemis Risk Index: <span class="mono">${esc(summary.highest_risk_material_34_o2?.pmma_artemis_risk_index)}/100</span> (LOI ${esc(summary.highest_risk_material_34_o2?.pmma_artemis_loi)}%)</div>
      </div>

      <div style="background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:11px;padding:12px 14px;">
        <div class="mono text-muted" style="font-size:10.5px;">PRIORITY SAFETY DIRECTIVE</div>
        <div style="font-weight:700;font-size:15px;margin:3px 0;color:var(--accent-cyan);">${esc(summary.priority_safety_directive?.title)}</div>
        <div class="text-sec" style="font-size:12px;">${esc(summary.priority_safety_directive?.recommendation)}</div>
      </div>
    </div>

    <div style="font-size:12.5px;color:var(--text-secondary);">
      <strong style="color:var(--text-primary);">Priority Engineering Actions (click citations to inspect NASA papers):</strong>
      <ul style="margin:6px 0 0;padding-left:18px;">${actionsHtml}</ul>
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
            backgroundColor: ['#f97316', '#06b6d4', '#8b5cf6', '#22c55e', '#eab308', '#ec4899'],
            borderRadius: 6,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y',
        scales: {
          x: { ticks: { color: colors.text, stepSize: 1 }, grid: { color: colors.grid } },
          y: { ticks: { color: colors.text, font: { size: 11 } }, grid: { display: false } },
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
      'Sustained Burn': '#ef4444',
      'Cool Flame': '#06b6d4',
      'Self-Extinguished': '#eab308',
      'No Ignition': '#22c55e',
    };
    regimeChart = new Chart(regCanvas, {
      type: 'doughnut',
      data: {
        labels: entries.map(([k]) => k),
        datasets: [
          {
            data: entries.map(([, v]) => v),
            backgroundColor: entries.map(([k]) => palette[k] || '#8b5cf6'),
            borderWidth: 2,
            borderColor: state.theme === 'light' ? '#ffffff' : '#0d1424',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: colors.text, padding: 12, boxWidth: 11, font: { size: 11.5 } },
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
      <div class="card" style="padding:14px 16px;">
        <div class="flex items-center justify-between gap-2 mb-3">
          <span class="badge badge-cyan">${esc(f.source_experiment)}</span>
          <span class="badge ${String(f.safety_relevance).toUpperCase().includes('CRIT') ? 'risk-CRITICAL' : 'badge-flame'}">${esc(f.safety_relevance || 'High')}</span>
        </div>
        <h4 style="margin:0 0 6px;font-family:var(--font-display);font-size:14.5px;">${esc(f.title)}</h4>
        <p class="text-sec" style="font-size:12.5px;margin:0 0 8px;">${esc(f.description)}</p>
        ${
          f.quantitative_result
            ? `<div class="mono" style="font-size:11.5px;color:var(--accent-cyan);padding:6px 9px;background:var(--bg-surface-2);border-radius:7px;">${esc(f.quantitative_result)}</div>`
            : ''
        }
      </div>
    `
    )
    .join('');
}
