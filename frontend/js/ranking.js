/**
 * 50-Run Scenario Ranker & Telemetry Comparator (EMBER Extra)
 * + Explainable Entity Rankings (Experiments, Materials, Findings, Guidelines).
 */

import { api } from './api.js';
import { bindEditableSliderValue, chartThemeColors, esc, on, state } from './state.js';

let weights = { similarity: 0.5, completeness: 0.2, criticality: 0.3 };
let rankedRuns = [];
let primaryRunId = null;
let compareRunId = null;
let telemetryChart = null;
let primaryTelemetry = null;
let compareTelemetry = null;
let telemetryMetric = 'flame_radius_mm';
let entitySubtab = 'experiments';

export async function initRanking() {
  bindSubtabs();
  bindRunControls();
  bindEntityControls();

  await refreshRunRanking();
  await loadEntityRanking('experiments');

  on('cabin:changed', () => {
    refreshRunRanking();
  });

  on('theme:changed', () => {
    if (primaryTelemetry) renderTelemetryChart();
  });
}

function bindSubtabs() {
  document.querySelectorAll('[data-rank-subtab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setRankingSubtab(btn.dataset.rankSubtab);
    });
  });
}

function setRankingSubtab(target) {
  document.querySelectorAll('[data-rank-subtab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.rankSubtab === target);
  });
  const runsPanel = document.getElementById('rank-panel-runs');
  const entPanel = document.getElementById('rank-panel-entities');
  if (runsPanel) runsPanel.style.display = target === 'runs' ? 'block' : 'none';
  if (entPanel) entPanel.style.display = target === 'entities' ? 'block' : 'none';
}

export async function openEntityRankingTab(tabName = 'guidelines') {
  setRankingSubtab('entities');
  entitySubtab = tabName;
  document.querySelectorAll('[data-entity-tab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.entityTab === tabName);
  });
  const envWrap = document.getElementById('entity-env-wrap');
  if (envWrap) envWrap.style.display = tabName === 'materials' ? 'flex' : 'none';
  await loadEntityRanking(tabName);
}

function bindRunControls() {
  const bindW = (id, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    const applyWeight = (val) => {
      weights[key] = val;
      const v = document.getElementById(`${id}-val`);
      if (v) v.textContent = weights[key].toFixed(2);
      refreshRunRanking();
    };
    el.addEventListener('input', () => applyWeight(parseFloat(el.value)));
    bindEditableSliderValue({
      sliderId: id,
      min: 0,
      max: null,
      getValue: () => weights[key],
      formatValue: (v) => v.toFixed(2),
      onCommit: applyWeight,
    });
  };
  bindW('w-similarity', 'similarity');
  bindW('w-completeness', 'completeness');
  bindW('w-criticality', 'criticality');

  document.getElementById('run-program-filter')?.addEventListener('change', renderRunsTable);
  document.getElementById('run-regime-filter')?.addEventListener('change', renderRunsTable);
  document.getElementById('telemetry-metric-select')?.addEventListener('change', (e) => {
    telemetryMetric = e.target.value;
    renderTelemetryChart();
  });
  document.getElementById('telemetry-compare-select')?.addEventListener('change', async (e) => {
    compareRunId = e.target.value || null;
    if (compareRunId) {
      try {
        compareTelemetry = await api.telemetry(compareRunId);
      } catch {
        compareTelemetry = null;
      }
    } else {
      compareTelemetry = null;
    }
    renderTelemetryChart();
  });
}

export async function refreshRunRanking() {
  const c = state.activeCabin;
  const ctxBanner = document.getElementById('rank-active-scenario-label');
  if (ctxBanner) {
    ctxBanner.textContent = `Target Scenario: ${c.oxygen_pct}% O₂ · ${c.pressure_kpa} kPa · ${c.flow_velocity_cm_s} cm/s · ${c.gravity_g}g · ${c.fuel_material}`;
  }
  try {
    const res = await api.rankRuns(c, weights, 50);
    rankedRuns = (res.results || []).map((r) => ({ ...r, ...(r.record || {}) }));
    populateRunFilters(rankedRuns);
    renderRunsTable();
    if (!primaryRunId && rankedRuns.length) {
      await selectRunForTelemetry(rankedRuns[0].experiment_id);
    }
  } catch (err) {
    console.error('Rank runs error:', err);
  }
}

function populateRunFilters(runs) {
  const progSel = document.getElementById('run-program-filter');
  const regSel = document.getElementById('run-regime-filter');
  const compSel = document.getElementById('telemetry-compare-select');

  if (progSel) {
    const curProg = progSel.value || 'all';
    const progs = [...new Set(runs.map((r) => r.program).filter(Boolean))].sort();
    progSel.innerHTML = `<option value="all">All Programs (${progs.length})</option>` +
      progs.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    progSel.value = progs.includes(curProg) ? curProg : 'all';
  }
  if (regSel) {
    const curReg = regSel.value || 'all';
    const regs = [...new Set(runs.map((r) => r.combustion_regime).filter(Boolean))].sort();
    regSel.innerHTML = `<option value="all">All Regimes (${regs.length})</option>` +
      regs.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('');
    regSel.value = regs.includes(curReg) ? curReg : 'all';
  }
  if (compSel) {
    const cur = compSel.value;
    compSel.innerHTML = `<option value="">Compare overlay: None</option>` +
      runs
        .slice(0, 25)
        .map((r) => `<option value="${esc(r.experiment_id)}">${esc(r.experiment_id)} · ${esc(r.program)} (${r.oxygen_pct}% O₂)</option>`)
        .join('');
    if (cur) compSel.value = cur;
  }
}

function renderRunsTable() {
  const tbody = document.getElementById('runs-rank-tbody');
  if (!tbody) return;
  const progF = document.getElementById('run-program-filter')?.value || 'all';
  const regF = document.getElementById('run-regime-filter')?.value || 'all';

  const filtered = rankedRuns.filter((r) => {
    if (progF !== 'all' && r.program !== progF) return false;
    if (regF !== 'all' && r.combustion_regime !== regF) return false;
    return true;
  });

  const regimeBadge = (reg) => {
    if (reg === 'Sustained Burn') return 'risk-CRITICAL';
    if (reg === 'Cool Flame') return 'badge-cyan';
    if (reg === 'Self-Extinguished') return 'risk-MODERATE';
    return 'risk-LOW';
  };

  tbody.innerHTML = filtered
    .slice(0, 30)
    .map((r, idx) => {
      const wSum = Math.max(0.01, weights.similarity + weights.completeness + weights.criticality);
      const pSim = ((r.similarity_score * (weights.similarity / wSum))).toFixed(1);
      const pComp = ((r.completeness_score * (weights.completeness / wSum))).toFixed(1);
      const pCrit = ((r.criticality_score * (weights.criticality / wSum))).toFixed(1);
      return `
        <tr class="${r.experiment_id === primaryRunId ? 'selected-row' : ''}" data-run-id="${esc(r.experiment_id)}" style="cursor:pointer;">
          <td class="mono text-muted">#${idx + 1}</td>
          <td><span class="cite-chip exp-chip" style="pointer-events:none;">${esc(r.experiment_id)}</span></td>
          <td style="font-weight:600;">${esc(r.program)}</td>
          <td>${esc(r.fuel_material)}</td>
          <td class="mono">${r.oxygen_pct}% · ${r.pressure_kpa}kPa</td>
          <td class="mono">${r.flow_velocity_cm_s} cm/s · ${r.gravity_g}g</td>
          <td><span class="badge ${regimeBadge(r.combustion_regime)}">${esc(r.combustion_regime)}</span></td>
          <td>
            <div class="flex items-center gap-2">
              <strong class="mono">${r.total_score.toFixed(1)}</strong>
              <div class="score-bar" title="Sim ${r.similarity_score} | Comp ${r.completeness_score} | Crit ${r.criticality_score}">
                <div style="width:${pSim}%;background:#06b6d4;"></div>
                <div style="width:${pComp}%;background:#8b5cf6;"></div>
                <div style="width:${pCrit}%;background:#f97316;"></div>
              </div>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');

  tbody.querySelectorAll('[data-run-id]').forEach((tr) => {
    tr.addEventListener('click', () => selectRunForTelemetry(tr.dataset.runId));
  });
}

export async function selectRunForTelemetry(expId) {
  primaryRunId = expId;
  renderRunsTable();
  try {
    primaryTelemetry = await api.telemetry(expId);
    const meta = document.getElementById('telemetry-run-meta');
    const r = primaryTelemetry.run || rankedRuns.find((x) => x.experiment_id === expId);
    if (meta && r) {
      meta.innerHTML = `
        <div class="flex items-center gap-2 flex-wrap">
          <span class="badge badge-flame">${esc(r.experiment_id)}</span>
          <span class="badge badge-cyan">${esc(r.program)}</span>
          <span class="badge">${esc(r.fuel_material)}</span>
          <span class="badge">${r.oxygen_pct}% O₂ · ${r.pressure_kpa} kPa · ${r.flow_velocity_cm_s} cm/s · ${r.gravity_g}g</span>
          <span class="badge">${esc(r.combustion_regime)}</span>
        </div>
      `;
    }
    renderTelemetryChart();
  } catch (err) {
    console.warn('Telemetry fetch failed:', err);
  }
}

function renderTelemetryChart() {
  const canvas = document.getElementById('run-telemetry-chart');
  if (!canvas || !primaryTelemetry || typeof Chart === 'undefined') return;
  if (telemetryChart) telemetryChart.destroy();

  const colors = chartThemeColors();
  const metricLabels = {
    flame_radius_mm: 'Flame Radius (mm)',
    d_squared_mm2: 'Droplet d² (mm²)',
    radiative_heat_flux_kw_m2: 'Radiative Heat Flux (kW/m²)',
    flame_temp_k: 'Flame Temperature (K)',
  };

  const datasets = [
    {
      label: `${primaryTelemetry.experiment_id} — ${metricLabels[telemetryMetric]}`,
      data: (primaryTelemetry.time_s || []).map((t, i) => ({
        x: t,
        y: (primaryTelemetry[telemetryMetric] || [])[i],
      })),
      borderColor: '#f97316',
      backgroundColor: 'rgba(249, 115, 22, 0.14)',
      borderWidth: 2.5,
      fill: true,
      tension: 0.3,
      pointRadius: 2,
    },
  ];

  if (compareTelemetry && compareTelemetry.time_s) {
    datasets.push({
      label: `${compareTelemetry.experiment_id} — ${metricLabels[telemetryMetric]}`,
      data: compareTelemetry.time_s.map((t, i) => ({
        x: t,
        y: (compareTelemetry[telemetryMetric] || [])[i],
      })),
      borderColor: '#06b6d4',
      backgroundColor: 'rgba(6, 182, 212, 0.10)',
      borderWidth: 2.2,
      borderDash: [5, 4],
      fill: false,
      tension: 0.3,
      pointRadius: 2,
    });
  }

  telemetryChart = new Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Time After Ignition (s)', color: colors.text },
          ticks: { color: colors.text },
          grid: { color: colors.grid },
        },
        y: {
          title: { display: true, text: metricLabels[telemetryMetric], color: colors.text },
          ticks: { color: colors.text },
          grid: { color: colors.grid },
        },
      },
      plugins: {
        legend: { labels: { color: colors.textStrong, font: { size: 11.5 } } },
      },
    },
  });
}

// ── Explainable Entity Rankings (Experiments / Materials / Findings / Guidelines) ─
function bindEntityControls() {
  document.querySelectorAll('[data-entity-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      entitySubtab = btn.dataset.entityTab;
      document.querySelectorAll('[data-entity-tab]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const envWrap = document.getElementById('entity-env-wrap');
      if (envWrap) envWrap.style.display = entitySubtab === 'materials' ? 'flex' : 'none';
      loadEntityRanking(entitySubtab);
    });
  });

  document.getElementById('entity-env-select')?.addEventListener('change', () => {
    if (entitySubtab === 'materials') loadEntityRanking('materials');
  });
}

async function loadEntityRanking(type) {
  const container = document.getElementById('entity-ranking-list');
  const ruleEl = document.getElementById('entity-ranking-rule');
  if (!container) return;

  try {
    let data;
    if (type === 'experiments') data = await api.rankExperiments('safety');
    else if (type === 'materials') {
      const env = document.getElementById('entity-env-select')?.value || 'Lunar 34% O2';
      data = await api.rankMaterials(env);
    } else if (type === 'findings') data = await api.rankFindings();
    else data = await api.rankGuidelines();

    if (ruleEl) ruleEl.textContent = `Scoring Rule: ${data.rule || ''}`;
    const items = data.results || [];

    container.innerHTML = items
      .map((item) => {
        const title = item.name || item.title;
        const score = item.score ?? item.risk_score ?? 0;
        const badge = item.risk_tier
          ? `<span class="badge risk-${esc(item.risk_tier)}">${esc(item.risk_tier)}</span>`
          : item.risk_level
            ? `<span class="badge risk-${esc(String(item.risk_level).toUpperCase())}">${esc(item.risk_level)}</span>`
            : `<span class="badge badge-cyan">${esc(item.category || item.source_experiment || 'NASA')}</span>`;
        const reasons = (item.reasons || [])
          .map((r) => `<span class="badge" style="font-weight:400;">${esc(r)}</span>`)
          .join('');
        return `
          <div class="card" style="padding:14px 16px;margin-bottom:10px;">
            <div class="flex items-center justify-between flex-wrap gap-2">
              <div class="flex items-center gap-2">
                <span class="mono" style="font-size:15px;font-weight:700;color:var(--accent-flame);">#${item.rank}</span>
                <strong style="font-size:15px;">${esc(title)}</strong>
                ${badge}
              </div>
              <div class="mono" style="font-size:15px;font-weight:700;color:var(--accent-cyan);">Score ${score}</div>
            </div>
            <div class="flex flex-wrap gap-2 mt-2">${reasons}</div>
            ${
              item.recommendation || item.safety_recommendation || item.implications_for_spacecraft
                ? `<p class="text-sec mt-2" style="margin-bottom:0;font-size:12.5px;">${esc(item.recommendation || item.safety_recommendation || item.implications_for_spacecraft)}</p>`
                : ''
            }
          </div>
        `;
      })
      .join('');
  } catch (err) {
    container.innerHTML = `<div class="text-muted">Failed to load ranking: ${esc(err.message)}</div>`;
  }
}
