/**
 * 50-Run Scenario Ranker & Telemetry Comparator (EMBER Extra)
 * + Interactive Cursor-Following GlowCard Bento Console
 * + Explainable Entity Rankings (Experiments, Materials, Findings, Guidelines).
 */

import { api } from './api.js';
import { bindEditableSliderValue, esc, on, state } from './state.js';

let weights = { similarity: 0.5, completeness: 0.2, criticality: 0.3 };
let rankedRuns = [];
let primaryRunId = null;
let compareRunId = null;
let telemetryChart = null;
let primaryTelemetry = null;
let compareTelemetry = null;
let telemetryMetric = 'flame_radius_mm';
let entitySubtab = 'experiments';

// Bento interactive state
let curvePoints = [];
let curveRawSeries = [];
let curveTimeSeries = [];
let curveHoverIdx = null;
let activeProgramFilter = 'all';

const METRIC_INFO = {
  flame_radius_mm: { label: 'Flame Radius', unit: 'mm', decimals: 1 },
  d_squared_mm2: { label: 'Droplet d²', unit: 'mm²', decimals: 2 },
  radiative_heat_flux_kw_m2: { label: 'Radiative Heat Flux', unit: 'kW/m²', decimals: 2 },
  flame_temp_k: { label: 'Flame Temperature', unit: 'K', decimals: 0 },
};

const NASA_PROGRAMS = [
  {
    id: 'BASS',
    label: 'BASS',
    meta: 'ISS · MSG',
    rgb: '255, 94, 58',
    desc: 'BASS (Burning and Suppression of Solids) · ISS Microgravity Science Glovebox solid-fuel spread & nitrogen extinction tests.',
    icon: '<path d="M16 4c2 6 9 9 9 16a9 9 0 1 1-18 0c0-5 3-8 5-11-1 3 1 5 2 4 0-4 1-7 2-9Z"/><circle cx="16" cy="21" r="3"/>',
  },
  {
    id: 'BASS-II',
    label: 'BASS-II',
    meta: 'ISS · Opposed',
    rgb: '249, 115, 22',
    desc: 'BASS-II · Opposed & concurrent low-speed ventilation flame spread over PMMA, Nomex, and cotton-fiberglass sheets.',
    icon: '<path d="M4 16h24"/><path d="M10 10c2-3 4-4 6-4 3 0 6 4 6 10s-3 10-6 10c-2 0-4-1-6-4"/><circle cx="16" cy="16" r="2.2" fill="currentColor"/>',
  },
  {
    id: 'SAFFIRE',
    label: 'SAFFIRE',
    meta: 'Cygnus · Full',
    rgb: '244, 63, 94',
    desc: 'SAFFIRE I–VI · Full-scale spacecraft fire growth, smoke transport, and post-fire scrubber diagnostics aboard Cygnus cargo vehicles.',
    icon: '<rect x="5" y="7" width="22" height="18" rx="4"/><path d="M10 16h12M16 11v10"/><circle cx="10" cy="12" r="1" fill="currentColor"/><circle cx="22" cy="20" r="1" fill="currentColor"/>',
  },
  {
    id: 'FLEX',
    label: 'FLEX',
    meta: 'CIR · Droplet',
    rgb: '34, 211, 238',
    desc: 'FLEX (Flame Extinguishment Experiment) · Isolated heptane & methanol droplet burning and radiative extinction in microgravity.',
    icon: '<circle cx="16" cy="16" r="10"/><circle cx="16" cy="16" r="4.5"/><path d="M16 2v4M16 26v4M2 16h4M26 16h4"/>',
  },
  {
    id: 'FLEX-2',
    label: 'FLEX-2',
    meta: 'Cool Flames',
    rgb: '56, 189, 248',
    desc: 'FLEX-2 · Discovered sustained low-temperature cool-flame droplet combustion continuing after visible hot flame extinction.',
    icon: '<ellipse cx="16" cy="16" rx="11" ry="5"/><ellipse cx="16" cy="16" rx="11" ry="5" transform="rotate(60 16 16)"/><ellipse cx="16" cy="16" rx="11" ry="5" transform="rotate(120 16 16)"/><circle cx="16" cy="16" r="2" fill="currentColor"/>',
  },
  {
    id: 'SLICE',
    label: 'SLICE',
    meta: 'ISS · Coflow',
    rgb: '52, 211, 153',
    desc: 'SLICE (Structure & Liftoff in Combustion Experiment) · Laminar gas-jet diffusion flame liftoff, soot, and stability in 0g.',
    icon: '<path d="M6 25h20"/><path d="M16 25V12"/><path d="M11 17c1-5 3-9 5-12 2 3 4 7 5 12"/>',
  },
  {
    id: 'SoFIE',
    label: 'SoFIE',
    meta: 'CIR · 2022–26',
    rgb: '251, 191, 36',
    desc: 'SoFIE (Solid Fuel Ignition and Extinction) · Active ISS investigations mapping Lunar & Mars 34% O₂ cabin flammability limits.',
    icon: '<polygon points="16,4 27,10 27,22 16,28 5,22 5,10"/><circle cx="16" cy="16" r="3.5"/>',
  },
  {
    id: 'ACME',
    label: 'ACME',
    meta: 'ISS · Gaseous',
    rgb: '20, 184, 166',
    desc: 'ACME (Advanced Combustion via Microgravity Experiments) · Six gaseous-flame studies testing electric fields, coflow, and soot extinction.',
    icon: '<path d="M5 12c3-5 7-5 11 0s8 5 11 0"/><path d="M5 20c3-5 7-5 11 0s8 5 11 0"/>',
  },
];

const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

function toSmoothPath(points) {
  return points.reduce((d, p, i) => {
    if (i === 0) return `M ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
    const prev = points[i - 1];
    const mid = ((prev.x + p.x) / 2).toFixed(2);
    return `${d} C ${mid} ${prev.y.toFixed(2)}, ${mid} ${p.y.toFixed(2)}, ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  }, '');
}

const activeAnims = new WeakMap();
function animateNumber(el, target, decimals = 1, duration = 560) {
  if (!el || !Number.isFinite(target)) return;
  const prevRaf = activeAnims.get(el);
  if (prevRaf) cancelAnimationFrame(prevRaf);

  const reduceMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const from = parseFloat(el.dataset.numVal || '0');
  el.dataset.numVal = String(target);

  if (reduceMotion || !Number.isFinite(from)) {
    el.textContent = target.toFixed(decimals);
    return;
  }

  const start = performance.now();
  const tick = (now) => {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    const val = from + (target - from) * eased;
    el.textContent = val.toFixed(decimals);
    if (t < 1) {
      activeAnims.set(el, requestAnimationFrame(tick));
    } else {
      activeAnims.delete(el);
    }
  };
  activeAnims.set(el, requestAnimationFrame(tick));
}

function bindGlowCards() {
  const shell = document.getElementById('tb-bento-shell');
  if (!shell) return;

  shell.querySelectorAll('.tb-glow-card').forEach((card) => {
    const moveTo = (clientX, clientY) => {
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${clientX - rect.left}px`);
      card.style.setProperty('--my', `${clientY - rect.top}px`);
    };

    card.addEventListener('mousemove', (e) => moveTo(e.clientX, e.clientY));
    card.addEventListener('mouseenter', () => card.classList.add('is-active'));
    card.addEventListener('mouseleave', () => card.classList.remove('is-active'));
    card.addEventListener(
      'touchstart',
      (e) => {
        const touch = e.touches[0];
        if (touch) {
          moveTo(touch.clientX, touch.clientY);
          card.classList.add('is-active');
        }
      },
      { passive: true }
    );
    card.addEventListener(
      'touchmove',
      (e) => {
        const touch = e.touches[0];
        if (touch) moveTo(touch.clientX, touch.clientY);
      },
      { passive: true }
    );
    card.addEventListener('touchend', () => card.classList.remove('is-active'));
  });
}

function bindCurveScrub() {
  const stage = document.getElementById('tb-curve-stage');
  if (!stage) return;

  const showHoverAt = (clientX) => {
    if (!curvePoints.length) return;
    const rect = stage.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    curveHoverIdx = Math.round(ratio * (curvePoints.length - 1));
    updateCurveOverlayCursor();
  };

  stage.addEventListener('mousemove', (e) => showHoverAt(e.clientX));
  stage.addEventListener('mouseleave', () => {
    curveHoverIdx = null;
    updateCurveOverlayCursor();
  });
  stage.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches[0]) showHoverAt(e.touches[0].clientX);
    },
    { passive: true }
  );
  stage.addEventListener('touchend', () => {
    curveHoverIdx = null;
    updateCurveOverlayCursor();
  });
}

function updateCurveOverlayCursor() {
  const dot = document.getElementById('tb-curve-dot');
  const tip = document.getElementById('tb-curve-tooltip');
  const cross = document.getElementById('tb-curve-crosshair');
  if (!dot || !tip || !cross || !curvePoints.length) return;

  const idx = curveHoverIdx ?? curvePoints.length - 1;
  const pt = curvePoints[idx];
  const info = METRIC_INFO[telemetryMetric] || METRIC_INFO.flame_radius_mm;

  dot.style.display = 'block';
  dot.style.left = `${pt.x}%`;
  dot.style.top = `${pt.y}%`;

  if (curveHoverIdx !== null) {
    cross.style.display = 'block';
    cross.setAttribute('x1', pt.x.toFixed(2));
    cross.setAttribute('x2', pt.x.toFixed(2));

    const tVal = curveTimeSeries[idx] ?? idx;
    const vVal = curveRawSeries[idx] ?? 0;
    tip.style.display = 'block';
    tip.style.left = `clamp(52px, ${pt.x}%, calc(100% - 52px))`;
    tip.style.top = `calc(${pt.y}% - 14px)`;
    tip.innerHTML = `<div style="color:#94a3b8;font-size:10.5px;">t = ${Number(tVal).toFixed(1)}s</div><div style="font-weight:600;color:#fff;">${Number(vVal).toFixed(info.decimals)} ${esc(info.unit)}</div>`;
  } else {
    cross.style.display = 'none';
    tip.style.display = 'none';
  }
}

/* ------------------------------------------------------------------ *
 * Bento Cards Rendering (Synced Live to Active NASA Telemetry Run)
 * ------------------------------------------------------------------ */
function renderBentoCurve() {
  if (!primaryTelemetry) return;
  const info = METRIC_INFO[telemetryMetric] || METRIC_INFO.flame_radius_mm;
  const raw = (primaryTelemetry[telemetryMetric] || []).map(Number).filter((v) => Number.isFinite(v));
  const times = (primaryTelemetry.time_s || []).map(Number);
  const run = primaryTelemetry.run || rankedRuns.find((x) => x.experiment_id === primaryRunId) || {};

  const titleEl = document.getElementById('tb-curve-title');
  if (titleEl) {
    titleEl.textContent = `${primaryTelemetry.experiment_id} · ${run.program || 'NASA'} — ${info.label}`;
  }
  const unitEl = document.getElementById('tb-curve-unit');
  if (unitEl) unitEl.textContent = info.unit;

  if (!raw.length) return;
  curveRawSeries = raw;
  curveTimeSeries = times;

  const peak = Math.max(...raw);
  const minVal = Math.min(...raw);
  const avg = raw.reduce((a, b) => a + b, 0) / raw.length;
  const latest = raw[raw.length - 1];

  animateNumber(document.getElementById('tb-curve-latest'), peak, info.decimals, 520);
  const avgEl = document.getElementById('tb-curve-avg');
  const peakEl = document.getElementById('tb-curve-peak');
  if (avgEl) avgEl.textContent = `${avg.toFixed(info.decimals)} ${info.unit}`;
  if (peakEl) peakEl.textContent = `${latest.toFixed(info.decimals)} ${info.unit} end`;

  // Combine bounds with compare overlay if active
  let compRaw = [];
  if (compareTelemetry && Array.isArray(compareTelemetry[telemetryMetric])) {
    compRaw = compareTelemetry[telemetryMetric].map(Number).filter((v) => Number.isFinite(v));
  }
  const allVals = [...raw, ...compRaw];
  const hi = Math.max(...allVals, 0.001);
  const lo = Math.min(...allVals, 0);
  const span = Math.max(hi - lo, 0.001);

  curvePoints = raw.map((v, i) => ({
    x: raw.length > 1 ? (i / (raw.length - 1)) * 100 : 50,
    y: 94 - ((v - lo) / span) * 84,
  }));

  const line = toSmoothPath(curvePoints);
  const area = `${line} L 100 100 L 0 100 Z`;
  document.getElementById('tb-curve-line')?.setAttribute('d', line);
  document.getElementById('tb-curve-area')?.setAttribute('d', area);

  const compLineEl = document.getElementById('tb-curve-compare-line');
  if (compLineEl) {
    if (compRaw.length > 1) {
      const compPts = compRaw.map((v, i) => ({
        x: (i / (compRaw.length - 1)) * 100,
        y: 94 - ((v - lo) / span) * 84,
      }));
      compLineEl.setAttribute('d', toSmoothPath(compPts));
    } else {
      compLineEl.setAttribute('d', '');
    }
  }

  const startEl = document.getElementById('tb-axis-start');
  const endEl = document.getElementById('tb-axis-end');
  if (startEl) startEl.textContent = `t = ${(times[0] ?? 0).toFixed(1)}s`;
  if (endEl) endEl.textContent = `t = ${(times[times.length - 1] ?? raw.length).toFixed(1)}s`;

  curveHoverIdx = null;
  updateCurveOverlayCursor();

  // Environment readings strip (exact 2x2 status-dot pattern)
  const envEl = document.getElementById('tb-env-list');
  if (envEl) {
    const o2 = Number(run.oxygen_pct ?? 21);
    const o2Col = o2 >= 30 ? '#fb7185' : o2 >= 22 ? '#fbbf24' : '#34d399';
    const flow = Number(run.flow_velocity_cm_s ?? 10);
    const flowCol = flow >= 5 && flow <= 20 ? '#fbbf24' : '#34d399';
    const grav = Number(run.gravity_g ?? 0);
    const gravCol = grav < 0.05 ? '#38bdf8' : '#34d399';
    const reg = run.combustion_regime || 'Measured';
    const regCol = reg === 'Sustained Burn' ? '#fb7185' : reg === 'Cool Flame' ? '#38bdf8' : '#34d399';

    envEl.innerHTML = `
      <li>
        <span class="tb-env-dot" style="background:${o2Col};"></span>
        <span class="tb-env-name">O₂ Concentration</span>
        <span class="tb-env-val" style="color:${o2Col};">${o2.toFixed(1)}%</span>
      </li>
      <li>
        <span class="tb-env-dot" style="background:#38bdf8;"></span>
        <span class="tb-env-name">Cabin Pressure</span>
        <span class="tb-env-val" style="color:#7dd3fc;">${Number(run.pressure_kpa ?? 101.3).toFixed(1)} kPa</span>
      </li>
      <li>
        <span class="tb-env-dot" style="background:${flowCol};"></span>
        <span class="tb-env-name">Ventilation Flow</span>
        <span class="tb-env-val" style="color:${flowCol};">${flow.toFixed(1)} cm/s</span>
      </li>
      <li>
        <span class="tb-env-dot" style="background:${gravCol};"></span>
        <span class="tb-env-name">${esc(run.fuel_material || 'Fuel')} · ${grav}g</span>
        <span class="tb-env-val" style="color:${regCol};">${esc(reg)}</span>
      </li>
    `;
  }
}

function renderScoreRings() {
  const wrap = document.getElementById('tb-score-rings');
  if (!wrap) return;
  const run = rankedRuns.find((r) => r.experiment_id === primaryRunId) || rankedRuns[0];
  if (!run) return;

  const items = [
    { label: 'Total', score: Math.round(clamp(Number(run.total_score ?? 0), 0, 100)) },
    { label: 'Sim', score: Math.round(clamp(Number(run.similarity_score ?? 0), 0, 100)) },
    { label: 'Comp', score: Math.round(clamp(Number(run.completeness_score ?? 0), 0, 100)) },
    { label: 'Crit', score: Math.round(clamp(Number(run.criticality_score ?? 0), 0, 100)) },
  ];

  const radius = 20;
  const circumference = 2 * Math.PI * radius;

  wrap.innerHTML = items
    .map((item) => {
      const to = circumference * (1 - item.score / 100);
      return `
        <div class="tb-ring-item">
          <div class="tb-ring-wrap">
            <svg viewBox="0 0 50 50" class="tb-ring-svg" aria-hidden="true">
              <circle cx="25" cy="25" r="${radius}" class="tb-ring-track" />
              <circle
                cx="25"
                cy="25"
                r="${radius}"
                class="tb-ring-fill"
                stroke-dasharray="${circumference.toFixed(2)}"
                style="--from:${circumference.toFixed(2)};--to:${to.toFixed(2)};"
              />
            </svg>
            <span class="tb-ring-num">${item.score}</span>
          </div>
          <span class="tb-ring-label">${esc(item.label)}</span>
        </div>
      `;
    })
    .join('');
}

function renderFluxSparkline() {
  const valEl = document.getElementById('tb-flux-value');
  const barsEl = document.getElementById('tb-flux-bars');
  if (!valEl || !barsEl || !primaryTelemetry) return;

  const flux = (primaryTelemetry.radiative_heat_flux_kw_m2 || []).map(Number).filter((v) => Number.isFinite(v));
  const peak = flux.length ? Math.max(...flux) : Number(primaryTelemetry.run?.peak_radiative_flux_kw_m2 ?? 0);
  animateNumber(valEl, peak, 2, 540);

  // Sample 16 evenly spaced bars from the real flux time series
  const sampleCount = 16;
  const bars = [];
  if (flux.length >= sampleCount) {
    for (let i = 0; i < sampleCount; i++) {
      const idx = Math.min(flux.length - 1, Math.round((i / (sampleCount - 1)) * (flux.length - 1)));
      bars.push(flux[idx]);
    }
  } else if (flux.length > 0) {
    for (let i = 0; i < sampleCount; i++) {
      bars.push(flux[i % flux.length]);
    }
  } else {
    for (let i = 0; i < sampleCount; i++) bars.push(0.4);
  }

  const maxB = Math.max(...bars, 0.01);
  let peakIdx = 0;
  bars.forEach((v, i) => {
    if (v >= bars[peakIdx]) peakIdx = i;
  });

  barsEl.innerHTML = bars
    .map((v, i) => {
      const h = Math.max(10, Math.round((v / maxB) * 100));
      return `<span class="tb-bar${i === peakIdx ? ' is-peak' : ''}" style="height:${h}%;"></span>`;
    })
    .join('');
}

function renderProgramStack() {
  const wrap = document.getElementById('tb-program-stack');
  const descEl = document.getElementById('tb-program-desc');
  if (!wrap) return;

  // Count how many runs exist per program in the 50-run archive
  const counts = {};
  for (const r of rankedRuns) {
    if (r.program) counts[r.program] = (counts[r.program] || 0) + 1;
  }

  const defaultDesc =
    activeProgramFilter !== 'all'
      ? `Filtered 50-run table to ${activeProgramFilter} (${counts[activeProgramFilter] || 0} runs). Click the highlighted badge again to show all programs.`
      : 'Hover or focus any NASA mission badge to inspect its instrumentation, or click to filter the 50 runs below.';

  wrap.innerHTML = NASA_PROGRAMS.map((prog) => {
    const count = counts[prog.id] || 0;
    const selected = activeProgramFilter === prog.id;
    return `
      <li>
        <button
          type="button"
          class="tb-prog-btn${selected ? ' is-selected' : ''}"
          data-tb-prog="${esc(prog.id)}"
          style="--prog-rgb:${prog.rgb};"
          aria-pressed="${selected}"
          aria-label="${esc(prog.label)} (${count ? `${count} runs` : prog.meta})"
        >
          <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${prog.icon}</svg>
          <span class="tb-prog-name">${esc(prog.label)}</span>
          <span class="tb-prog-meta">${count ? `${count} runs` : esc(prog.meta)}</span>
        </button>
      </li>
    `;
  }).join('');

  if (descEl) descEl.textContent = defaultDesc;

  wrap.querySelectorAll('[data-tb-prog]').forEach((btn) => {
    const prog = NASA_PROGRAMS.find((p) => p.id === btn.dataset.tbProg);
    if (!prog) return;

    const showDesc = () => {
      if (descEl) descEl.innerHTML = `<span class="tb-fade">${esc(prog.desc)}</span>`;
    };
    const restoreDesc = () => {
      if (descEl) descEl.textContent = defaultDesc;
    };

    btn.addEventListener('mouseenter', showDesc);
    btn.addEventListener('focus', showDesc);
    btn.addEventListener('mouseleave', restoreDesc);
    btn.addEventListener('blur', restoreDesc);

    btn.addEventListener('click', () => {
      const progSel = document.getElementById('run-program-filter');
      const hasOption = progSel && [...progSel.options].some((o) => o.value === prog.id);
      if (activeProgramFilter === prog.id || !hasOption) {
        activeProgramFilter = 'all';
        if (progSel) progSel.value = 'all';
      } else {
        activeProgramFilter = prog.id;
        if (progSel) progSel.value = prog.id;
      }
      renderProgramStack();
      renderRunsTable();
    });
  });
}

/* ------------------------------------------------------------------ *
 * Existing 50-Run Scenario Ranker & Entity Rankings Logic
 * ------------------------------------------------------------------ */
export async function initRanking() {
  bindSubtabs();
  bindRunControls();
  bindEntityControls();
  bindGlowCards();
  bindCurveScrub();

  await refreshRunRanking();
  await loadEntityRanking('experiments');

  on('cabin:changed', () => {
    refreshRunRanking();
  });

  on('theme:changed', () => {
    if (primaryTelemetry) renderTelemetryChart();
  });

  on('tab:changed', (tab) => {
    if (tab === 'ranking') {
      renderScoreRings();
      if (primaryTelemetry) {
        renderBentoCurve();
        renderFluxSparkline();
      }
    }
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
  let weightTimer = null;
  const bindW = (id, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    const applyWeight = (val, immediate = false) => {
      weights[key] = val;
      const v = document.getElementById(`${id}-val`);
      if (v) v.textContent = weights[key].toFixed(2);
      if (weightTimer) clearTimeout(weightTimer);
      if (immediate) {
        refreshRunRanking();
      } else {
        weightTimer = setTimeout(() => refreshRunRanking(), 90);
      }
    };
    el.addEventListener('input', () => applyWeight(parseFloat(el.value), false));
    bindEditableSliderValue({
      sliderId: id,
      min: 0,
      max: null,
      getValue: () => weights[key],
      formatValue: (v) => v.toFixed(2),
      onCommit: (val) => applyWeight(val, true),
    });
  };
  bindW('w-similarity', 'similarity');
  bindW('w-completeness', 'completeness');
  bindW('w-criticality', 'criticality');

  document.getElementById('run-program-filter')?.addEventListener('change', (e) => {
    activeProgramFilter = e.target.value || 'all';
    renderProgramStack();
    renderRunsTable();
  });
  document.getElementById('run-regime-filter')?.addEventListener('change', renderRunsTable);
  document.getElementById('telemetry-metric-select')?.addEventListener('change', (e) => {
    telemetryMetric = e.target.value;
    renderBentoCurve();
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
    renderBentoCurve();
    renderTelemetryChart();
  });
}

export async function refreshRunRanking() {
  const c = state.activeCabin;
  const ctxBanner = document.getElementById('rank-active-scenario-label');
  if (ctxBanner) {
    ctxBanner.textContent = `Target: ${c.oxygen_pct}% O₂ · ${c.pressure_kpa} kPa · ${c.flow_velocity_cm_s} cm/s · ${c.gravity_g}g · ${c.fuel_material}`;
  }
  try {
    const res = await api.rankRuns(c, weights, 50);
    rankedRuns = (res.results || []).map((r) => ({ ...r, ...(r.record || {}) }));
    populateRunFilters(rankedRuns);
    renderProgramStack();
    renderRunsTable();
    renderScoreRings();
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
    progSel.innerHTML =
      `<option value="all">All Programs (${progs.length})</option>` +
      progs.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    progSel.value = progs.includes(curProg) ? curProg : 'all';
    activeProgramFilter = progSel.value;
  }
  if (regSel) {
    const curReg = regSel.value || 'all';
    const regs = [...new Set(runs.map((r) => r.combustion_regime).filter(Boolean))].sort();
    regSel.innerHTML =
      `<option value="all">All Regimes (${regs.length})</option>` +
      regs.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('');
    regSel.value = regs.includes(curReg) ? curReg : 'all';
  }
  if (compSel) {
    const cur = compSel.value;
    compSel.innerHTML =
      `<option value="">Compare overlay: None</option>` +
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
      const pSim = (r.similarity_score * (weights.similarity / wSum)).toFixed(1);
      const pComp = (r.completeness_score * (weights.completeness / wSum)).toFixed(1);
      const pCrit = (r.criticality_score * (weights.criticality / wSum)).toFixed(1);
      return `
        <tr class="${r.experiment_id === primaryRunId ? 'selected-row' : ''}" data-run-id="${esc(r.experiment_id)}" style="cursor:pointer;">
          <td class="mono" style="color:#64748b;">#${idx + 1}</td>
          <td><span class="cite-chip exp-chip" style="pointer-events:none;">${esc(r.experiment_id)}</span></td>
          <td style="font-weight:600;color:#ffffff;">${esc(r.program)}</td>
          <td>${esc(r.fuel_material)}</td>
          <td class="mono">${r.oxygen_pct}% · ${r.pressure_kpa}kPa</td>
          <td class="mono">${r.flow_velocity_cm_s} cm/s · ${r.gravity_g}g</td>
          <td><span class="badge ${regimeBadge(r.combustion_regime)}">${esc(r.combustion_regime)}</span></td>
          <td>
            <div class="flex items-center gap-2">
              <strong class="mono" style="color:#ffffff;">${r.total_score.toFixed(1)}</strong>
              <div class="score-bar" title="Sim ${r.similarity_score} | Comp ${r.completeness_score} | Crit ${r.criticality_score}">
                <div style="width:${pSim}%;background:#06b6d4;"></div>
                <div style="width:${pComp}%;background:#0f766e;"></div>
                <div style="width:${pCrit}%;background:#ff5e3a;"></div>
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
  renderScoreRings();
  try {
    primaryTelemetry = await api.telemetry(expId);
    const meta = document.getElementById('telemetry-run-meta');
    const r = primaryTelemetry.run || rankedRuns.find((x) => x.experiment_id === expId);
    if (meta && r) {
      meta.innerHTML = `
        <div class="flex items-center gap-2 flex-wrap">
          <span class="badge badge-flame">${esc(r.experiment_id)}</span>
          <span class="badge badge-cyan">${esc(r.program)}</span>
          <span class="badge" style="color:#e2e8f0;background:rgba(255,255,255,0.06);border-color:rgba(255,255,255,0.12);">${esc(r.fuel_material)}</span>
          <span class="badge" style="color:#cbd5e1;background:rgba(255,255,255,0.05);border-color:rgba(255,255,255,0.1);">${r.oxygen_pct}% O₂ · ${r.pressure_kpa} kPa · ${r.flow_velocity_cm_s} cm/s · ${r.gravity_g}g</span>
          <span class="badge" style="color:#fde68a;background:rgba(251,191,36,0.12);border-color:rgba(251,191,36,0.3);">${esc(r.combustion_regime)}</span>
        </div>
      `;
    }
    renderBentoCurve();
    renderFluxSparkline();
    renderTelemetryChart();
  } catch (err) {
    console.warn('Telemetry fetch failed:', err);
  }
}

function renderTelemetryChart() {
  const canvas = document.getElementById('run-telemetry-chart');
  if (!canvas || !primaryTelemetry || typeof Chart === 'undefined') return;
  if (telemetryChart) telemetryChart.destroy();

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
      borderColor: '#ff7452',
      backgroundColor: 'rgba(255, 94, 58, 0.16)',
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
      borderColor: '#38bdf8',
      backgroundColor: 'rgba(56, 189, 248, 0.10)',
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
          title: { display: true, text: 'Time After Ignition (s)', color: '#94a3b8' },
          ticks: { color: '#94a3b8' },
          grid: { color: 'rgba(255, 255, 255, 0.06)' },
        },
        y: {
          title: { display: true, text: metricLabels[telemetryMetric], color: '#94a3b8' },
          ticks: { color: '#94a3b8' },
          grid: { color: 'rgba(255, 255, 255, 0.06)' },
        },
      },
      plugins: {
        legend: { labels: { color: '#e2e8f0', font: { size: 11.5 } } },
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
