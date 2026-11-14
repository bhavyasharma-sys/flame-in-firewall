/**
 * Cabin Safety Configurator, Exact 2^5 Shapley Attributions,
 * Interactive 2D (O2 %, Pressure kPa) Combustion Phase Diagram,
 * and Cross-Habitat Material Safety Matrix.
 */

import { api } from './api.js';
import { chartThemeColors, emit, esc, on, riskColor, setActiveCabin, state } from './state.js';

let shapleyChart = null;
let phaseCells = [];
let evalTimer = null;

const MATERIALS = [
  'PMMA',
  'Cotton-Fiberglass',
  'Nomex',
  'Heptane',
  'Methanol',
  'Polyethylene',
  'Nylon-6',
  'Epoxy Composite',
  'Silicone Composite',
  'Velcro Strips',
  'Kapton Film',
  'Teflon (PTFE)',
];

const DILUENTS = ['N2', 'CO2', 'He', 'Ar'];

export async function initCabin() {
  populateSelects();

  try {
    const presetsRes = await api.presets();
    state.presets = presetsRes.presets || [];
    renderPresetButtons();
  } catch (err) {
    console.warn('Presets load failed:', err);
  }

  bindCabinControls();
  syncControlsFromState();
  await evaluateAndRender();

  on('cabin:changed', () => {
    syncControlsFromState();
    scheduleEvaluate();
  });

  on('theme:changed', () => {
    if (state.activeCabinEval) renderShapleyChart(state.activeCabinEval);
    if (phaseCells.length) drawPhaseGrid();
  });
}

function populateSelects() {
  const matSel = document.getElementById('cabin-material');
  if (matSel) {
    matSel.innerHTML = MATERIALS.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  }
  const dilSel = document.getElementById('cabin-diluent');
  if (dilSel) {
    dilSel.innerHTML = DILUENTS.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
  }
}

function renderPresetButtons() {
  const wrap = document.getElementById('cabin-preset-pills');
  if (!wrap) return;
  wrap.innerHTML = state.presets
    .map(
      (p) => `
      <button type="button" class="pill-btn" data-preset-id="${esc(p.id)}" title="${esc(p.description)}">
        <div>${esc(p.label)}</div>
        <div class="mono text-muted" style="font-size:10px;">${p.oxygen_pct}% O₂ · ${p.pressure_kpa} kPa · ${p.gravity_g}g</div>
      </button>
    `
    )
    .join('');

  wrap.querySelectorAll('[data-preset-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = state.presets.find((x) => x.id === btn.dataset.presetId);
      if (!p) return;
      wrap.querySelectorAll('.pill-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      setActiveCabin({
        oxygen_pct: p.oxygen_pct,
        pressure_kpa: p.pressure_kpa,
        flow_velocity_cm_s: p.flow_velocity_cm_s,
        gravity_g: p.gravity_g,
        fuel_material: p.fuel_material,
        diluent_gas: p.diluent_gas,
      });
    });
  });
}

function bindCabinControls() {
  const bindNum = (id, key, suffix) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      const valEl = document.getElementById(`${id}-val`);
      if (valEl) valEl.textContent = `${v}${suffix}`;
      setActiveCabin({ [key]: v }, { silent: true });
      emit('cabin:pill-refresh', state.activeCabin);
      scheduleEvaluate();
    });
  };

  bindNum('cabin-o2', 'oxygen_pct', '%');
  bindNum('cabin-pressure', 'pressure_kpa', ' kPa');
  bindNum('cabin-flow', 'flow_velocity_cm_s', ' cm/s');
  bindNum('cabin-gravity', 'gravity_g', ' g');

  document.getElementById('cabin-material')?.addEventListener('change', (e) => {
    setActiveCabin({ fuel_material: e.target.value }, { silent: true });
    emit('cabin:pill-refresh', state.activeCabin);
    scheduleEvaluate();
  });

  document.getElementById('cabin-diluent')?.addEventListener('change', (e) => {
    setActiveCabin({ diluent_gas: e.target.value }, { silent: true });
    emit('cabin:pill-refresh', state.activeCabin);
    scheduleEvaluate();
  });

  document.getElementById('cabin-ask-ai-btn')?.addEventListener('click', () => {
    const c = state.activeCabin;
    emit(
      'chat:ask',
      `Evaluate my active spacecraft cabin configuration (${c.oxygen_pct}% O2, ${c.pressure_kpa} kPa, ${c.flow_velocity_cm_s} cm/s flow, ${c.gravity_g}g, ${c.fuel_material}, ${c.diluent_gas}) and recommend NASA-backed fire safety mitigations.`
    );
  });

  document.getElementById('cabin-rank-runs-btn')?.addEventListener('click', () => {
    emit('cabin:changed', state.activeCabin);
    emit('navigate', 'ranking');
  });

  // Clickable 2D phase grid -> jump directly to (O2, Pressure) point!
  const canvas = document.getElementById('phase-grid-canvas');
  canvas?.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const padL = 48;
    const padR = 16;
    const padT = 18;
    const padB = 34;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const plotW = rect.width - padL - padR;
    const plotH = rect.height - padT - padB;
    if (x < padL || x > rect.width - padR || y < padT || y > rect.height - padB) return;
    const o2 = Math.round((15 + ((x - padL) / plotW) * 25) * 2) / 2;
    const pressure = Math.round(115 - ((y - padT) / plotH) * 65);
    setActiveCabin({
      oxygen_pct: Math.max(15, Math.min(40, o2)),
      pressure_kpa: Math.max(50, Math.min(115, pressure)),
    });
  });
}

function syncControlsFromState() {
  const c = state.activeCabin;
  const setPair = (id, val, suffix) => {
    const el = document.getElementById(id);
    if (el) el.value = String(val);
    const v = document.getElementById(`${id}-val`);
    if (v) v.textContent = `${val}${suffix}`;
  };
  setPair('cabin-o2', c.oxygen_pct, '%');
  setPair('cabin-pressure', c.pressure_kpa, ' kPa');
  setPair('cabin-flow', c.flow_velocity_cm_s, ' cm/s');
  setPair('cabin-gravity', c.gravity_g, ' g');

  const matSel = document.getElementById('cabin-material');
  if (matSel) matSel.value = c.fuel_material;
  const dilSel = document.getElementById('cabin-diluent');
  if (dilSel) dilSel.value = c.diluent_gas;
}

function scheduleEvaluate() {
  if (evalTimer) clearTimeout(evalTimer);
  evalTimer = setTimeout(() => evaluateAndRender(), 90);
}

async function evaluateAndRender() {
  const c = state.activeCabin;
  try {
    const [evalRes, gridRes] = await Promise.all([
      api.evaluateCabin(c),
      api.phaseGrid({
        material: c.fuel_material,
        gravity_g: c.gravity_g,
        flow_cm_s: c.flow_velocity_cm_s,
        diluent: c.diluent_gas,
      }),
    ]);
    state.activeCabinEval = evalRes;
    phaseCells = gridRes.cells || [];
    emit('cabin:evaluated', evalRes);

    renderRiskMetrics(evalRes);
    renderShapleyChart(evalRes);
    drawPhaseGrid();
    renderGuidance(evalRes);
    renderHabitatMatrix(evalRes.ranked_table || []);
  } catch (err) {
    console.error('Cabin evaluate error:', err);
  }
}

function renderRiskMetrics(r) {
  const setText = (id, txt) => {
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
  };
  const col = riskColor(r.risk_band);
  const riskEl = document.getElementById('cabin-risk-index');
  if (riskEl) {
    riskEl.textContent = r.risk_index.toFixed(1);
    riskEl.style.color = col;
  }
  const bandEl = document.getElementById('cabin-risk-band');
  if (bandEl) {
    bandEl.className = `badge risk-${r.risk_band}`;
    bandEl.textContent = r.risk_band;
  }
  setText('cabin-safety-score', `${r.safety_score.toFixed(1)}/100`);
  setText('cabin-loi', `${r.estimated_loi_pct.toFixed(1)}%`);
  setText('cabin-margin', `${r.oxygen_margin_pct > 0 ? '+' : ''}${r.oxygen_margin_pct.toFixed(1)}%`);
  setText('cabin-regime', r.predicted_regime);
  setText('cabin-veff', `${r.effective_velocity_cm_s} cm/s`);

  const sumVal = (r.contributions || []).reduce((acc, x) => acc + x.value, 0);
  const delta = r.risk_index - r.baseline_risk;
  setText(
    'cabin-shapley-identity',
    `ISS Baseline ${r.baseline_risk.toFixed(1)} + Σφ (${sumVal >= 0 ? '+' : ''}${sumVal.toFixed(2)}) = ${r.risk_index.toFixed(2)} (Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(2)})`
  );
}

function renderShapleyChart(r) {
  const canvas = document.getElementById('cabin-shapley-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (shapleyChart) shapleyChart.destroy();

  const colors = chartThemeColors();
  const items = r.contributions || [];
  shapleyChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: items.map((c) => c.label),
      datasets: [
        {
          label: 'Shapley Δ Risk (pts)',
          data: items.map((c) => c.value),
          backgroundColor: items.map((c) => (c.value >= 0 ? 'rgba(239, 68, 68, 0.82)' : 'rgba(34, 197, 94, 0.82)')),
          borderColor: items.map((c) => (c.value >= 0 ? '#ef4444' : '#22c55e')),
          borderWidth: 1,
          borderRadius: 6,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      scales: {
        x: {
          title: { display: true, text: 'Risk Contribution vs ISS Baseline (Exact 2⁵ Shapley)', color: colors.text },
          ticks: { color: colors.text },
          grid: { color: colors.grid },
        },
        y: {
          ticks: { color: colors.textStrong, font: { size: 12, weight: '500' } },
          grid: { display: false },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: colors.tooltipBg,
          titleColor: colors.textStrong,
          bodyColor: colors.text,
          callbacks: {
            label: (ctx) => `${ctx.parsed.x >= 0 ? '+' : ''}${ctx.parsed.x.toFixed(2)} risk pts`,
          },
        },
      },
    },
  });
}

function drawPhaseGrid() {
  const canvas = document.getElementById('phase-grid-canvas');
  if (!canvas || !phaseCells.length) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;
  const isLight = state.theme === 'light';
  ctx.fillStyle = isLight ? '#f8fafc' : '#0a1020';
  ctx.fillRect(0, 0, w, h);

  const padL = 48;
  const padR = 16;
  const padT = 18;
  const padB = 34;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const o2Vals = [...new Set(phaseCells.map((c) => c.oxygen_pct))].sort((a, b) => a - b);
  const pVals = [...new Set(phaseCells.map((c) => c.pressure_kpa))].sort((a, b) => a - b);
  const cw = plotW / o2Vals.length;
  const ch = plotH / pVals.length;

  const regimeColors = {
    'No Ignition': isLight ? '#bbf7d0' : 'rgba(34, 197, 94, 0.35)',
    'Self-Extinguished': isLight ? '#fef08a' : 'rgba(234, 179, 8, 0.40)',
    'Cool Flame': isLight ? '#bae6fd' : 'rgba(6, 182, 212, 0.48)',
    'Sustained Burn': isLight ? '#fecaca' : 'rgba(239, 68, 68, 0.56)',
  };

  for (const cell of phaseCells) {
    const ix = o2Vals.indexOf(cell.oxygen_pct);
    const iy = pVals.length - 1 - pVals.indexOf(cell.pressure_kpa);
    const x = padL + ix * cw;
    const y = padT + iy * ch;
    ctx.fillStyle = regimeColors[cell.regime] || 'rgba(148,163,184,0.3)';
    ctx.fillRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
  }

  // Axes labels
  ctx.fillStyle = isLight ? '#334155' : '#94a3b8';
  ctx.font = '10.5px JetBrains Mono, monospace';
  ctx.textAlign = 'center';
  for (let o = 15; o <= 40; o += 5) {
    const px = padL + ((o - 15) / 25) * plotW;
    ctx.fillText(`${o}%`, px, h - 14);
  }
  ctx.fillText('Oxygen Concentration (% O₂) — Click anywhere to set', padL + plotW / 2, h - 2);

  ctx.textAlign = 'right';
  for (const p of [50, 70, 90, 110]) {
    const py = padT + (1 - (p - 50) / 65) * plotH;
    ctx.fillText(`${p}`, padL - 6, py + 3);
  }

  // Active Cabin Point Crosshair
  const curO2 = Math.max(15, Math.min(40, state.activeCabin.oxygen_pct));
  const curP = Math.max(50, Math.min(115, state.activeCabin.pressure_kpa));
  const cx = padL + ((curO2 - 15) / 25) * plotW;
  const cy = padT + (1 - (curP - 50) / 65) * plotH;

  ctx.strokeStyle = isLight ? '#0f172a' : '#ffffff';
  ctx.lineWidth = 1.2;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(cx, padT);
  ctx.lineTo(cx, padT + plotH);
  ctx.moveTo(padL, cy);
  ctx.lineTo(padL + plotW, cy);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#f97316';
  ctx.beginPath();
  ctx.arc(cx, cy, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function renderGuidance(r) {
  const factorsEl = document.getElementById('cabin-factors');
  const recsEl = document.getElementById('cabin-recommendations');
  if (factorsEl) {
    factorsEl.innerHTML = (r.factors || [])
      .map((f) => `<div style="padding:7px 10px;background:var(--bg-surface-2);border-radius:8px;font-size:12.5px;margin-bottom:6px;">${esc(f)}</div>`)
      .join('');
  }
  if (recsEl) {
    recsEl.innerHTML = (r.recommendation_items || [])
      .map(
        (item) => `
        <div style="padding:9px 11px;background:var(--bg-surface-2);border-left:3px solid var(--accent-flame);border-radius:8px;font-size:12.5px;margin-bottom:8px;">
          <div>${esc(item.text)}</div>
          <div class="mt-2">
            <button type="button" class="cite-chip" data-doc-id="${esc(item.doc_id)}" data-doc-page="${esc(item.page)}">${esc(item.citation)}</button>
          </div>
        </div>
      `
      )
      .join('');
  }
}

function renderHabitatMatrix(rows) {
  const tbody = document.getElementById('cabin-matrix-tbody');
  if (!tbody) return;
  const scoreBadge = (val) => {
    const band = val < 30 ? 'CRITICAL' : val < 55 ? 'HIGH' : val < 78 ? 'MODERATE' : 'LOW';
    return `<span class="badge risk-${band}">${val.toFixed(0)}</span>`;
  };
  tbody.innerHTML = rows
    .map(
      (r) => `
      <tr style="cursor:pointer;" data-select-mat="${esc(r.material)}">
        <td style="font-weight:600;">${esc(r.material)}</td>
        <td class="mono">${r.base_loi_pct}%</td>
        <td>${scoreBadge(r.iss_21)}</td>
        <td>${scoreBadge(r.lunar_34)}</td>
        <td>${scoreBadge(r.mars_34)}</td>
        <td>${scoreBadge(r.transit_30)}</td>
        <td class="mono" style="font-weight:700;">${r.avg_safety_score}</td>
      </tr>
    `
    )
    .join('');

  tbody.querySelectorAll('[data-select-mat]').forEach((tr) => {
    tr.addEventListener('click', () => {
      setActiveCabin({ fuel_material: tr.dataset.selectMat });
    });
  });
}
