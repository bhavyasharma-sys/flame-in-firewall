/**
 * Visual Flame Physics & NASA Mission Presets for the 3D WebGL2 EMBER Flame Twin.
 * Calibrated from NASA BASS-II, FLEX-2, SAFFIRE, and ACME microgravity research.
 */

export const FLAME_SCENES = [
  {
    id: 'iss-0g',
    label: 'ISS Microgravity (0g)',
    tag: '0.00 g · 21% O₂',
    description: 'Spherical blue diffusion shell sustained solely by forced cabin ventilation (BASS-II).',
    gravityG: 0.0,
    oxygenPct: 21.0,
    flowCmS: 8.0,
    pressureKpa: 101.3,
    fuelMode: 'droplet',
  },
  {
    id: 'cool-flame',
    label: 'FLEX-2 Cool Flame',
    tag: '0.00 g · ~650 K',
    description: 'Low-temperature (~650 K) invisible-to-eye cool flame persisting after hot flame radiative extinction.',
    gravityG: 0.0,
    oxygenPct: 16.5,
    flowCmS: 2.0,
    pressureKpa: 101.3,
    fuelMode: 'droplet',
  },
  {
    id: 'lunar-artemis',
    label: 'Artemis Lunar (0.16g)',
    tag: '0.16 g · 34% O₂',
    description: 'Exploration atmosphere (34% O₂, 56.5 kPa) under lunar gravity — elongated high-risk plume.',
    gravityG: 0.16,
    oxygenPct: 34.0,
    flowCmS: 5.0,
    pressureKpa: 56.5,
    fuelMode: 'rod',
  },
  {
    id: 'mars-surface',
    label: 'Mars Habitat (0.38g)',
    tag: '0.38 g · 34% O₂',
    description: 'Martian partial gravity with enriched exploration O₂ — buoyant convection begins dominating.',
    gravityG: 0.38,
    oxygenPct: 34.0,
    flowCmS: 5.0,
    pressureKpa: 70.3,
    fuelMode: 'sheet',
  },
  {
    id: 'earth-1g',
    label: 'Earth Baseline (1g)',
    tag: '1.00 g · 21% O₂',
    description: 'Classic teardrop buoyant candle/plume with luminous yellow-orange soot incandescence.',
    gravityG: 1.0,
    oxygenPct: 21.0,
    flowCmS: 0.0,
    pressureKpa: 101.3,
    fuelMode: 'gaseous',
  },
];

export const FUEL_MODES = [
  { id: 'droplet', label: 'Droplet (FLEX)', index: 0, geomScale: [1.0, 1.0, 1.0] },
  { id: 'gaseous', label: 'Gas Jet (ACME)', index: 1, geomScale: [0.80, 1.20, 0.80] },
  { id: 'rod', label: 'PMMA Rod (BASS-II)', index: 2, geomScale: [0.78, 1.25, 0.86] },
  { id: 'sheet', label: 'Flat Sheet (SAFFIRE)', index: 3, geomScale: [1.40, 0.86, 0.65] },
];

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function computeFlameVisuals(params) {
  // Unbounded non-negative physical parameters (flow can also be negative for reverse wind)
  const rawG = Number(params.gravityG ?? 0);
  const rawO2 = Number(params.oxygenPct ?? 21);
  const rawFlow = Number(params.flowCmS ?? 8);
  const rawP = Number(params.pressureKpa ?? 101.3);

  const g = Number.isFinite(rawG) ? Math.max(0, rawG) : 0;
  const o2 = Number.isFinite(rawO2) ? Math.max(0, rawO2) : 21;
  const flowSigned = Number.isFinite(rawFlow) ? rawFlow : 8;
  const flow = Math.abs(flowSigned);
  const pressure = Number.isFinite(rawP) ? Math.max(0, rawP) : 101.3;
  const fuelMode = params.fuelMode || 'droplet';

  // Buoyancy velocity scales with sqrt(g) and density term (pressure / P0)^0.25
  const pRatio = pressure / 101.3;
  const vBuoyant = pressure > 0 ? 18.0 * Math.sqrt(g) * Math.pow(pRatio, 0.25) : 0;
  const vEff = Math.hypot(vBuoyant, flow);
  const buoyancy = clamp(Math.pow(g / 1.0, 0.58), 0, 1);
  const shapeBf = clamp(vBuoyant / 22.0, 0, 1);

  // Hypergravity (g > 1): buoyant acceleration elongates and thins the plume
  const hyperG = g > 1.0 ? Math.log2(g) : 0;
  const stretchY = 1.0 + 0.14 * Math.min(hyperG, 5.0);
  const pinchXZ = 1.0 / (1.0 + 0.12 * Math.min(hyperG, 5.0));

  // Unbounded oxygen vigor & pressure scaling
  const o2Excess = Math.max(0, o2 - 12.5);
  const o2Vigor = o2Excess / 11.5;
  // Smooth saturating visual drive so extreme O2 gets brighter/larger without breaking shader
  const o2Visual = o2Vigor <= 1.6 ? o2Vigor : 1.6 + Math.log1p((o2Vigor - 1.6) * 1.4) * 0.65;
  const pFactor = pressure > 0 ? Math.pow(pRatio, 0.35) : 0;
  const pFactorVisual = clamp(pFactor, 0.45, 2.2);
  // Higher pressure compresses reaction zone thickness (delta_f ~ p^-0.5); low pressure expands it
  const pressureSizeScale =
    pressure > 0 ? clamp(Math.pow(101.3 / Math.max(pressure, 8), 0.18), 0.48, 1.38) : 0.45;

  // Damkohler blow-off velocity limit: v_blowoff ~ (O2 - 12)^1.45 * (P / P0)^0.5
  const vBlowoff =
    o2 > 12.0 && pressure > 0
      ? 42.0 * Math.pow((o2 - 12.0) / 9.0, 1.45) * Math.pow(pRatio, 0.5)
      : 0;
  // Forced cross-flow + base buoyant strain compete against chemical reaction speed
  const strainVel = flow + 0.35 * vBuoyant;

  // Physical combustion regimes & real extinction boundaries
  const isVacuumExt = pressure < 8.0;
  const isCool = !isVacuumExt && g < 0.08 && o2 >= 11.5 && o2 <= 18.2 && flow <= 5.5 && pressure >= 20;
  const isHypoxicExt = !isVacuumExt && !isCool && o2 < 13.5;
  const isBlowoffExt = !isVacuumExt && !isHypoxicExt && !isCool && strainVel > vBlowoff;
  const isExtinguished = isVacuumExt || isHypoxicExt || isBlowoffExt;
  const isQuiescent = !isExtinguished && !isCool && g < 0.05 && flow < 1.5 && o2 < 22;

  let regime = 'Sustained Diffusion Flame';
  let regimeBadge = 'HIGH';
  let regimeKind = 'sustained';
  if (isVacuumExt) {
    regime = 'Extinguished (Vacuum)';
    regimeBadge = 'LOW';
    regimeKind = 'extinguished';
  } else if (isHypoxicExt) {
    regime = 'Extinguished (Hypoxic)';
    regimeBadge = 'LOW';
    regimeKind = 'extinguished';
  } else if (isBlowoffExt) {
    regime = 'Extinguished (Blow-Off)';
    regimeBadge = 'LOW';
    regimeKind = 'extinguished';
  } else if (isCool) {
    regime = 'Cool Flame (FLEX-2 ~650 K)';
    regimeBadge = 'MODERATE';
    regimeKind = 'cool';
  } else if (isQuiescent) {
    regime = 'Quiescent Radiative Decay';
    regimeBadge = 'LOW';
    regimeKind = 'quiescent';
  } else if (o2 >= 50) {
    regime = 'Hyperoxic Flash Flame';
    regimeBadge = 'CRITICAL';
  } else if (g >= 2.0) {
    regime = 'Hypergravity Buoyant Jet';
    regimeBadge = 'HIGH';
  } else if (pressure >= 200) {
    regime = 'Hyperbaric Intense Flame';
    regimeBadge = 'CRITICAL';
  } else if (o2 >= 30) {
    regime = 'Enriched-O₂ Rapid Spread';
    regimeBadge = 'CRITICAL';
  } else if (g < 0.05 && flow >= 3 && flow <= 16) {
    regime = 'Ventilation-Paradox Zone';
    regimeBadge = 'HIGH';
  }

  // Soot dominance: suppressed in 0g blue shell, cool flame, & low pressure; surges with buoyancy, O2, & high pressure
  const soot = isExtinguished
    ? 0.0
    : isCool
      ? 0.02
      : clamp((0.12 + 0.78 * shapeBf) * Math.min(1.6, Math.max(0.25, o2Visual)) * pFactorVisual, 0.03, 1.0);

  const intensity = isExtinguished
    ? 0.05
    : isCool
      ? 0.62
      : clamp(Math.max(0.28, o2Visual) * (0.74 + 0.26 * pFactorVisual), 0.28, 2.15);

  // Flame visual scale responds smoothly to O2, pressure compression, and quiescent decay
  let scale = clamp(0.76 + (o2Visual - 0.55) * 0.32, 0.55, 1.62) * pressureSizeScale;
  if (isCool) scale *= 1.08;
  if (isQuiescent) scale = Math.min(scale, 0.84);
  if (isExtinguished) scale = 0.62;

  // Plume height (mm): grows with buoyancy, hypergravity elongation, and O2; compresses at hyperbaric pressures
  const pHeightFactor = pressure > 0 ? Math.pow(pRatio, pRatio > 1 ? -0.14 : 0.22) : 0;
  const heightMm = isExtinguished
    ? 0
    : isCool
      ? Math.round(14 + flow * 0.4)
      : Math.round(
          (24 + 54 * buoyancy + 28 * hyperG + 18 * Math.max(0, o2Visual - 0.6)) *
            clamp(pHeightFactor, 0.45, 1.45)
        );

  // Adiabatic-calibrated peak temperature (K): ~1880 K at 21% O2, ~2300 K at 34%, ~3050 K at 100%, higher under pressure
  const pTempBoost = pressure > 8 ? Math.log10(Math.max(pRatio, 0.1)) * 120 : 0;
  const tempK = isExtinguished
    ? 300
    : isCool
      ? Math.round(620 + (o2 - 14) * 28)
      : Math.round(
          Math.max(
            900,
            1380 + 480 * Math.min(1.4, o2Visual) + 460 * Math.max(0, o2Visual - 1.4) + 140 * buoyancy + pTempBoost
          )
        );

  const sootYield = isExtinguished ? 0 : Number((soot * 100).toFixed(0));

  // Signed wind deflection (supports negative reverse flow & extreme gusts smoothly via tanh)
  const windSigned = Math.tanh(flowSigned / 28.0) * 1.45;
  const windNorm = Math.min(1.0, Math.abs(windSigned));
  const windX = windSigned * 0.36;
  const windY = 0.0;
  const flowDirX = flowSigned > 0.25 ? 1.0 : flowSigned < -0.25 ? -1.0 : 0.0;

  // Dynamic turbulence/advection boost so high-G & high-wind flames visibly roar faster
  const timeBoost = isExtinguished
    ? 1.0
    : 1.0 + 0.35 * Math.min(hyperG, 6.0) + 0.012 * Math.min(flow, 150.0);

  const fuelDef = FUEL_MODES.find((f) => f.id === fuelMode) || FUEL_MODES[0];
  const geomScale = [
    fuelDef.geomScale[0] * pinchXZ,
    fuelDef.geomScale[1] * stretchY,
    fuelDef.geomScale[2] * pinchXZ,
  ];

  return {
    buoyancy,
    shapeBf,
    vBuoyant: Number(vBuoyant.toFixed(1)),
    vEff: Number(vEff.toFixed(1)),
    soot,
    sootDom: soot,
    intensity,
    scale,
    timeBoost,
    isCool: isCool ? 1.0 : 0.0,
    isExtinguished,
    regimeKind,
    windNorm,
    windX,
    windY,
    flowDirX,
    fuelIndex: fuelDef.index,
    geomScale,
    regime,
    regimeBadge,
    heightMm,
    tempK,
    sootYield,
  };
}
