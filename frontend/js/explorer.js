/**
 * Flagship NASA Experiment Explorer + 5-Axis Radar Comparison Studio.
 */

import { api } from './api.js';
import { chartThemeColors, emit, esc, on, state } from './state.js';

let radarChart = null;
let lastCompare = null;

export async function initExplorer() {
  try {
    const [expRes, filters] = await Promise.all([api.experiments(), api.filters()]);
    state.experiments = expRes.experiments || [];
    populateExplorerFilters(filters);
    populateCompareSelects(state.experiments);
    renderExperimentCards(state.experiments);
    await runComparison();
  } catch (err) {
    console.error('Explorer load error:', err);
  }

  document.getElementById('exp-search-input')?.addEventListener('input', filterExperiments);
  document.getElementById('exp-cat-select')?.addEventListener('change', filterExperiments);
  document.getElementById('exp-plat-select')?.addEventListener('change', filterExperiments);
  document.getElementById('compare-e1')?.addEventListener('change', runComparison);
  document.getElementById('compare-e2')?.addEventListener('change', runComparison);

  on('theme:changed', () => {
    if (lastCompare) renderRadarChart(lastCompare);
  });
}

function populateExplorerFilters(f) {
  const catSel = document.getElementById('exp-cat-select');
  const platSel = document.getElementById('exp-plat-select');
  if (catSel) {
    catSel.innerHTML = `<option value="All Categories">All Categories</option>` +
      (f.experiment_categories || []).map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  }
  if (platSel) {
    platSel.innerHTML = `<option value="All Platforms">All Platforms</option>` +
      (f.experiment_platforms || []).map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  }
}

function populateCompareSelects(exps) {
  const s1 = document.getElementById('compare-e1');
  const s2 = document.getElementById('compare-e2');
  if (!s1 || !s2) return;
  const opts = exps
    .map((e) => `<option value="${esc(e.acronym || e.name)}">${esc(e.acronym || e.name)} — ${esc(e.name)}</option>`)
    .join('');
  s1.innerHTML = opts;
  s2.innerHTML = opts;
  if (exps.length >= 2) {
    s1.value = exps[0].acronym || exps[0].name;
    s2.value = exps[1].acronym || exps[1].name;
  }
}

function filterExperiments() {
  const q = (document.getElementById('exp-search-input')?.value || '').trim().toLowerCase();
  const cat = document.getElementById('exp-cat-select')?.value || 'All Categories';
  const plat = document.getElementById('exp-plat-select')?.value || 'All Platforms';

  const list = state.experiments.filter((e) => {
    if (cat !== 'All Categories' && e.category !== cat) return false;
    if (plat !== 'All Platforms' && e.platform !== plat) return false;
    if (q) {
      const hay = `${e.name} ${e.acronym} ${e.description} ${(e.materials_tested || []).join(' ')} ${(e.key_findings || []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  renderExperimentCards(list);
}

function renderExperimentCards(exps) {
  const grid = document.getElementById('explorer-cards-grid');
  if (!grid) return;
  if (!exps.length) {
    grid.innerHTML = `<div class="card text-muted">No matching NASA experiments found.</div>`;
    return;
  }

  grid.innerHTML = exps
    .map(
      (e) => `
      <div class="card" style="display:flex;flex-direction:column;justify-content:space-between;gap:12px;">
        <div>
          <div class="flex items-center justify-between gap-2 mb-3">
            <span class="badge badge-flame">${esc(e.acronym || e.id)}</span>
            <span class="badge badge-cyan">${esc(e.category || 'Combustion')}</span>
          </div>
          <h3 style="font-family:var(--font-display);font-size:16px;margin:0 0 6px;">${esc(e.name)}</h3>
          <div class="mono text-muted" style="font-size:11px;margin-bottom:8px;">${esc(e.platform || 'ISS')} · ${esc(e.years || '')}</div>
          <p class="text-sec" style="font-size:12.8px;margin:0 0 10px;">${esc(e.description)}</p>
          <div class="flex flex-wrap gap-2">
            ${(e.materials_tested || []).slice(0, 4).map((m) => `<span class="badge">${esc(m)}</span>`).join('')}
          </div>
        </div>
        <div class="flex items-center justify-between gap-2 pt-2" style="border-top:1px solid var(--border-subtle);padding-top:10px;">
          <button type="button" class="btn btn-sm" data-exp-inspect="${esc(e.id || e.acronym)}">Inspect Findings</button>
          <button type="button" class="btn btn-cyan btn-sm" data-exp-ask="${esc(e.name)}">Ask FlameAI</button>
        </div>
      </div>
    `
    )
    .join('');

  grid.querySelectorAll('[data-exp-inspect]').forEach((btn) => {
    btn.addEventListener('click', () => openExperimentModal(btn.dataset.expInspect));
  });
  grid.querySelectorAll('[data-exp-ask]').forEach((btn) => {
    btn.addEventListener('click', () =>
      emit('chat:ask', `Summarize the objectives, key empirical findings, and spacecraft fire safety implications of NASA's ${btn.dataset.expAsk} experiment.`)
    );
  });
}

export async function openExperimentModal(expId) {
  try {
    const data = await api.experimentDetail(expId);
    const e = data.experiment;
    const links = data.graph_links || {};
    const outbound = links.outbound ?? links.outgoing ?? [];
    const html = `
      <div class="flex flex-wrap gap-2 mb-3">
        <span class="badge badge-flame">${esc(e.acronym || e.id)}</span>
        <span class="badge badge-cyan">${esc(e.category)}</span>
        <span class="badge">${esc(e.platform)}</span>
        <span class="badge">${esc(e.years)}</span>
      </div>
      <p style="margin-top:0;">${esc(e.description)}</p>
      <h4 style="font-family:var(--font-display);margin:14px 0 6px;">Materials Tested</h4>
      <div class="flex flex-wrap gap-2 mb-3">
        ${(e.materials_tested || []).map((m) => `<span class="badge">${esc(m)}</span>`).join('')}
      </div>
      <h4 style="font-family:var(--font-display);margin:14px 0 6px;">Key Empirical Findings</h4>
      <ul style="padding-left:18px;margin:0 0 12px;">
        ${(e.key_findings || []).map((f) => `<li style="margin-bottom:5px;">${esc(f)}</li>`).join('')}
      </ul>
      <h4 style="font-family:var(--font-display);margin:14px 0 6px;">Spacecraft Safety Implications</h4>
      <ul style="padding-left:18px;margin:0 0 12px;">
        ${(e.safety_implications || []).map((s) => `<li style="margin-bottom:5px;">${esc(s)}</li>`).join('')}
      </ul>
      ${
        outbound.length
          ? `<h4 style="font-family:var(--font-display);margin:14px 0 6px;">Knowledge Graph Connections (${outbound.length})</h4>
             <div class="flex flex-wrap gap-2">${outbound.slice(0, 12).map((o) => `<span class="badge">${esc(o.relationship ?? o.relation ?? 'related')} → ${esc(o.target)}</span>`).join('')}</div>`
          : ''
      }
    `;
    emit('modal:open', { title: e.name, subtitle: `${e.platform} · ${e.years}`, bodyHtml: html });
  } catch (err) {
    console.error('Experiment detail error:', err);
  }
}

async function runComparison() {
  const e1 = document.getElementById('compare-e1')?.value;
  const e2 = document.getElementById('compare-e2')?.value;
  if (!e1 || !e2) return;
  try {
    lastCompare = await api.compare(e1, e2);
    renderRadarChart(lastCompare);
    renderCompareDeltas(lastCompare);
  } catch (err) {
    console.error('Compare error:', err);
  }
}

function renderRadarChart(data) {
  const canvas = document.getElementById('compare-radar-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (radarChart) radarChart.destroy();

  const colors = chartThemeColors();
  const labels = ['Flame Spread', 'Extinction Time', 'Soot Yield', 'Heat Release', 'Safety Score'];
  const keys = ['flame_spread', 'extinction_time', 'soot_yield', 'heat_release', 'safety_score'];

  radarChart = new Chart(canvas, {
    type: 'radar',
    data: {
      labels,
      datasets: [
        {
          label: data.exp1.acronym || data.exp1.name,
          data: keys.map((k) => data.exp1.metrics[k]),
          borderColor: '#f97316',
          backgroundColor: 'rgba(249, 115, 22, 0.22)',
          borderWidth: 2.2,
          pointBackgroundColor: '#f97316',
        },
        {
          label: data.exp2.acronym || data.exp2.name,
          data: keys.map((k) => data.exp2.metrics[k]),
          borderColor: '#06b6d4',
          backgroundColor: 'rgba(6, 182, 212, 0.22)',
          borderWidth: 2.2,
          pointBackgroundColor: '#06b6d4',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        r: {
          min: 0,
          max: 10,
          ticks: { stepSize: 2, color: colors.text, backdropColor: 'transparent' },
          grid: { color: colors.grid },
          angleLines: { color: colors.grid },
          pointLabels: { color: colors.textStrong, font: { size: 11.5 } },
        },
      },
      plugins: {
        legend: { labels: { color: colors.textStrong, font: { size: 12 } } },
      },
    },
  });
}

function renderCompareDeltas(data) {
  const wrap = document.getElementById('compare-deltas');
  if (!wrap) return;
  const labels = {
    flame_spread: 'Flame Spread',
    extinction_time: 'Extinction Time',
    soot_yield: 'Soot Yield',
    heat_release: 'Heat Release',
    safety_score: 'Safety Score',
  };
  wrap.innerHTML = Object.entries(labels)
    .map(([k, label]) => {
      const v1 = data.exp1.metrics[k];
      const v2 = data.exp2.metrics[k];
      const d = data.deltas[k];
      const sign = d > 0 ? '+' : '';
      return `
        <div class="flex items-center justify-between" style="padding:8px 10px;background:var(--bg-surface-2);border-radius:8px;margin-bottom:6px;font-size:12.5px;">
          <span>${label}</span>
          <span class="mono">
            <strong style="color:#f97316;">${v1}</strong> vs <strong style="color:#06b6d4;">${v2}</strong>
            <span class="badge" style="margin-left:6px;">Δ ${sign}${d}</span>
          </span>
        </div>
      `;
    })
    .join('');
}
