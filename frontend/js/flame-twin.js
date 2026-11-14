/**
 * 3D WebGL2 EMBER Volumetric Flame Twin View + BASS-II Ventilation Paradox Curve.
 * Includes coalesced slider updates, viewport/tab visibility pausing, Play/Pause control,
 * prefers-reduced-motion support, and live FPS/engine HUD telemetry.
 */

import { api } from './api.js';
import { FLAME_SCENES, FUEL_MODES, computeFlameVisuals } from './flame-physics.js';
import { FlameRenderer } from './flame-shader.js';
import { bindEditableSliderValue, chartThemeColors, emit, esc, on, setActiveCabin, state } from './state.js';

let renderer = null;
let ventChart = null;
let ventCurveData = null;
let isTwinTabActive = false;
let isCanvasVisible = true;
let userPaused = false;
let pendingPhysicsRaf = null;
let lastChartVEff = null;

const twinState = {
  gravityG: 0.0,
  oxygenPct: 21.0,
  flowCmS: 8.0,
  pressureKpa: 101.3,
  fuelMode: 'droplet',
  speed: 1.0,
  sceneId: 'iss-0g',
};

function syncPlaybackState() {
  if (!renderer) return;
  const shouldRun = isTwinTabActive && isCanvasVisible && !document.hidden && !userPaused;
  if (shouldRun) {
    renderer.paused = false;
    renderer.start();
  } else {
    renderer.stop();
    if (isTwinTabActive && userPaused) {
      renderer.paused = true;
      renderer.renderFrame();
    }
  }
  updatePauseButton();
}

function updatePauseButton() {
  const btn = document.getElementById('twin-pause-btn');
  if (!btn) return;
  btn.textContent = userPaused ? '▶ Play' : '⏸ Pause';
  btn.setAttribute('aria-pressed', String(userPaused));
}

function updateEngineBadge(stats) {
  const badge = document.getElementById('twin-engine-badge');
  if (!badge || !stats) return;
  if (stats.mode === 'webgl2') {
    const label = stats.paused
      ? 'WebGL2 EMBER · Paused'
      : stats.scale < 0.99
        ? `WebGL2 EMBER · ${stats.fps} FPS (${Math.round(stats.scale * 100)}%)`
        : `WebGL2 EMBER · ${stats.fps} FPS`;
    badge.textContent = label;
  } else {
    badge.textContent = stats.paused ? 'Canvas2D · Paused' : `Canvas2D · ${stats.fps} FPS`;
  }
}

export async function initFlameTwin() {
  const canvas = document.getElementById('flame-canvas');
  if (!canvas) return;

  // Respect prefers-reduced-motion cleanly
  if (typeof window.matchMedia === 'function') {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mq.matches) userPaused = true;
  }

  renderer = new FlameRenderer(canvas, {
    onStats: (stats) => updateEngineBadge(stats),
  });
  renderer.setTheme(state.theme);
  updateEngineBadge(renderer.getStats());

  renderScenePills();
  renderFuelPills();
  bindControls();

  try {
    ventCurveData = await api.ventilationCurve();
    renderVentilationChart();
  } catch (err) {
    console.warn('Ventilation curve load error:', err);
  }

  applyTwinPhysics();

  // Pause automatically when scrolled out of viewport while Twin tab is active
  if (typeof IntersectionObserver !== 'undefined') {
    const io = new IntersectionObserver(
      (entries) => {
        if (!isTwinTabActive) return;
        for (const entry of entries) {
          isCanvasVisible = entry.isIntersecting;
        }
        syncPlaybackState();
      },
      { threshold: 0.05 }
    );
    io.observe(canvas);
  }

  // Pause automatically when browser tab is backgrounded
  document.addEventListener('visibilitychange', () => {
    syncPlaybackState();
  });

  on('tab:changed', (tab) => {
    isTwinTabActive = tab === 'twin';
    if (isTwinTabActive) isCanvasVisible = true;
    syncPlaybackState();
    if (isTwinTabActive) {
      requestAnimationFrame(() => {
        if (ventChart) ventChart.resize();
        if (userPaused) renderer?.renderFrame();
      });
    }
  });

  on('theme:changed', (theme) => {
    renderer?.setTheme(theme);
    if (ventCurveData) renderVentilationChart();
  });

  on('cabin:changed', (cabin) => {
    const hint = document.getElementById('twin-sync-hint');
    if (hint) {
      hint.textContent = `Cabin: ${cabin.oxygen_pct}% O₂ · ${cabin.gravity_g}g · ${cabin.flow_velocity_cm_s} cm/s`;
    }
  });
}

function renderScenePills() {
  const wrap = document.getElementById('twin-scene-pills');
  if (!wrap) return;
  wrap.innerHTML = FLAME_SCENES.map(
    (s) => `
      <button type="button" class="pill-btn ${twinState.sceneId === s.id ? 'active' : ''}" data-scene="${esc(s.id)}">
        <div>${esc(s.label)}</div>
        <div class="mono text-muted" style="font-size:10px;">${esc(s.tag)}</div>
      </button>
    `
  ).join('');

  wrap.querySelectorAll('[data-scene]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sc = FLAME_SCENES.find((x) => x.id === btn.dataset.scene);
      if (!sc) return;
      twinState.sceneId = sc.id;
      twinState.gravityG = sc.gravityG;
      twinState.oxygenPct = sc.oxygenPct;
      twinState.flowCmS = sc.flowCmS;
      twinState.pressureKpa = sc.pressureKpa;
      twinState.fuelMode = sc.fuelMode;
      syncInputsFromState();
      renderScenePills();
      renderFuelPills();
      renderer?.triggerIgnite();
      schedulePhysicsUpdate();
    });
  });
}

function renderFuelPills() {
  const wrap = document.getElementById('twin-fuel-pills');
  if (!wrap) return;
  wrap.innerHTML = FUEL_MODES.map(
    (f) => `
      <button type="button" class="pill-btn ${twinState.fuelMode === f.id ? 'active' : ''}" data-fuel="${esc(f.id)}">
        ${esc(f.label)}
      </button>
    `
  ).join('');

  wrap.querySelectorAll('[data-fuel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      twinState.fuelMode = btn.dataset.fuel;
      renderFuelPills();
      schedulePhysicsUpdate();
    });
  });
}

function schedulePhysicsUpdate() {
  if (pendingPhysicsRaf !== null) return;
  pendingPhysicsRaf = requestAnimationFrame(() => {
    pendingPhysicsRaf = null;
    applyTwinPhysics();
  });
}

function bindControls() {
  const bindSlider = (id, key, suffix, minVal, maxVal, parseFn = parseFloat) => {
    const el = document.getElementById(id);
    if (!el) return;
    const applyValue = (num) => {
      twinState[key] = num;
      if (key !== 'speed') twinState.sceneId = 'custom';
      const valEl = document.getElementById(`${id}-val`);
      if (valEl) valEl.textContent = `${twinState[key]}${suffix}`;
      if (key === 'speed') {
        renderer?.setSpeed(twinState.speed);
      } else {
        schedulePhysicsUpdate();
      }
    };
    el.addEventListener('input', () => applyValue(parseFn(el.value)));
    bindEditableSliderValue({
      sliderId: id,
      min: minVal,
      max: maxVal,
      getValue: () => twinState[key],
      formatValue: (v) => `${v}${suffix}`,
      onCommit: applyValue,
    });
  };

  bindSlider('twin-gravity', 'gravityG', ' g', 0, null);
  bindSlider('twin-o2', 'oxygenPct', '%', 0, null);
  bindSlider('twin-flow', 'flowCmS', ' cm/s', null, null);
  bindSlider('twin-pressure', 'pressureKpa', ' kPa', 0, null);
  bindSlider('twin-speed', 'speed', 'x', 0, null);

  document.getElementById('twin-ignite-btn')?.addEventListener('click', () => {
    renderer?.triggerIgnite();
    if (userPaused) {
      userPaused = false;
      syncPlaybackState();
    }
  });

  document.getElementById('twin-pause-btn')?.addEventListener('click', () => {
    userPaused = !userPaused;
    syncPlaybackState();
    if (renderer) updateEngineBadge(renderer.getStats());
  });

  document.getElementById('twin-pull-cabin-btn')?.addEventListener('click', () => {
    const c = state.activeCabin;
    twinState.gravityG = c.gravity_g;
    twinState.oxygenPct = c.oxygen_pct;
    twinState.flowCmS = c.flow_velocity_cm_s;
    twinState.pressureKpa = c.pressure_kpa;
    twinState.sceneId = 'custom';
    syncInputsFromState();
    renderer?.triggerIgnite();
    schedulePhysicsUpdate();
  });

  document.getElementById('twin-push-cabin-btn')?.addEventListener('click', () => {
    setActiveCabin({
      gravity_g: Math.max(0, twinState.gravityG),
      oxygen_pct: Math.max(0, twinState.oxygenPct),
      flow_velocity_cm_s: Math.abs(twinState.flowCmS),
      pressure_kpa: Math.max(0, twinState.pressureKpa),
    });
    emit('navigate', 'cabin');
  });

  document.getElementById('twin-ask-ai-btn')?.addEventListener('click', () => {
    const vis = computeFlameVisuals(twinState);
    const q = `Explain the flame physics and NASA safety implications for a ${twinState.gravityG}g environment at ${twinState.oxygenPct}% O2, ${twinState.pressureKpa} kPa, and ${twinState.flowCmS} cm/s forced ventilation (${vis.regime}).`;
    emit('chat:ask', q);
  });

  updatePauseButton();
}

function syncInputsFromState() {
  const setPair = (id, val, suffix) => {
    const el = document.getElementById(id);
    if (el) {
      const sMin = Number(el.min);
      const sMax = Number(el.max);
      el.value = String(Math.min(sMax, Math.max(sMin, Number(val))));
    }
    const valEl = document.getElementById(`${id}-val`);
    if (valEl) valEl.textContent = `${val}${suffix}`;
  };
  setPair('twin-gravity', twinState.gravityG, ' g');
  setPair('twin-o2', twinState.oxygenPct, '%');
  setPair('twin-flow', twinState.flowCmS, ' cm/s');
  setPair('twin-pressure', twinState.pressureKpa, ' kPa');
}

function applyTwinPhysics() {
  const vis = computeFlameVisuals(twinState);
  renderer?.setPhysics(vis);

  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el && el.textContent !== text) el.textContent = text;
  };
  setText('hud-regime', vis.regime);
  setText('hud-temp', `${vis.tempK} K`);
  setText('hud-height', `${vis.heightMm} mm`);
  setText('hud-veff', `${vis.vEff} cm/s`);
  setText('hud-soot', `${vis.sootYield}%`);

  const regimeBadge = document.getElementById('hud-regime-badge');
  if (regimeBadge) {
    const cls = `badge risk-${vis.regimeBadge}`;
    if (regimeBadge.className !== cls) regimeBadge.className = cls;
    if (regimeBadge.textContent !== vis.regime) regimeBadge.textContent = vis.regime;
  }

  const desc = document.getElementById('twin-scene-desc');
  if (desc) {
    const sc = FLAME_SCENES.find((x) => x.id === twinState.sceneId);
    const nextDesc = sc
      ? sc.description
      : `Custom state: v_buoyant = ${vis.vBuoyant} cm/s, v_forced = ${twinState.flowCmS} cm/s → v_eff = ${vis.vEff} cm/s.`;
    if (desc.textContent !== nextDesc) desc.textContent = nextDesc;
  }

  updateVentilationMarker(vis.vEff);
}

function renderVentilationChart() {
  const canvas = document.getElementById('twin-vent-chart');
  if (!canvas || !ventCurveData || typeof Chart === 'undefined') return;
  if (ventChart) ventChart.destroy();

  const colors = chartThemeColors();
  const pts = ventCurveData.points || [];
  const vis = computeFlameVisuals(twinState);
  lastChartVEff = vis.vEff;

  const nearest = pts.reduce(
    (best, p) =>
      Math.abs(p.velocity_cm_s - vis.vEff) < Math.abs(best.velocity_cm_s - vis.vEff) ? p : best,
    pts[0] || { velocity_cm_s: 8, loi_shift_pct: -2.0 }
  );

  ventChart = new Chart(canvas, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'BASS-II LOI Shift (% O₂)',
          data: pts.map((p) => ({ x: p.velocity_cm_s, y: p.loi_shift_pct })),
          borderColor: '#06b6d4',
          backgroundColor: 'rgba(6, 182, 212, 0.14)',
          borderWidth: 2.5,
          fill: true,
          tension: 0.35,
          pointRadius: 0,
        },
        {
          label: 'Current Effective Velocity',
          data: [{ x: Math.min(40, vis.vEff), y: nearest.loi_shift_pct }],
          borderColor: '#f97316',
          backgroundColor: '#f97316',
          pointRadius: 7,
          pointHoverRadius: 9,
          showLine: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: {
          type: 'linear',
          min: 0,
          max: 40,
          title: { display: true, text: 'Effective Flow Velocity (cm/s)', color: colors.text },
          ticks: { color: colors.text },
          grid: { color: colors.grid },
        },
        y: {
          title: { display: true, text: 'LOI Shift (% O₂)', color: colors.text },
          ticks: { color: colors.text },
          grid: { color: colors.grid },
        },
      },
      plugins: {
        legend: { labels: { color: colors.text, boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          backgroundColor: colors.tooltipBg,
          titleColor: colors.textStrong,
          bodyColor: colors.text,
          borderColor: colors.tooltipBorder,
          borderWidth: 1,
        },
      },
    },
  });
}

function updateVentilationMarker(vEff) {
  if (!ventChart || !ventCurveData || vEff === lastChartVEff) return;
  lastChartVEff = vEff;
  const pts = ventCurveData.points || [];
  if (!pts.length) return;
  const clamped = Math.min(40, vEff);
  const nearest = pts.reduce(
    (best, p) =>
      Math.abs(p.velocity_cm_s - clamped) < Math.abs(best.velocity_cm_s - clamped) ? p : best,
    pts[0]
  );
  ventChart.data.datasets[1].data = [{ x: clamped, y: nearest.loi_shift_pct }];
  ventChart.update('none');
}
