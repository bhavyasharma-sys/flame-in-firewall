/**
 * Visual Flame Physics & NASA Mission Presets for the 3D WebGL2 Flame Twin.
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
  { id: 'droplet', label: 'Droplet (FLEX)', index: 0 },
  { id: 'gaseous', label: 'Gas Jet (ACME)', index: 1 },
  { id: 'rod', label: 'PMMA Rod (BASS-II)', index: 2 },
  { id: 'sheet', label: 'Flat Sheet (SAFFIRE)', index: 3 },
];

export function computeFlameVisuals(params) {
  const g = Math.max(0, Math.min(2.0, Number(params.gravityG ?? 0)));
  const o2 = Math.max(10, Math.min(50, Number(params.oxygenPct ?? 21)));
  const flow = Math.max(0, Math.min(40, Number(params.flowCmS ?? 8)));
  const pressure = Math.max(30, Math.min(150, Number(params.pressureKpa ?? 101.3)));
  const fuelMode = params.fuelMode || 'droplet';

  const buoyancy = Math.min(1.0, Math.pow(g / 1.0, 0.58));
  const vBuoyant = 18.0 * Math.sqrt(g);
  const vEff = Math.hypot(vBuoyant, flow);

  // Oxygen vigor factor
  const o2Factor = Math.max(0.15, Math.min(1.85, (o2 - 12.5) / 11.5));
  const pFactor = Math.max(0.55, Math.min(1.35, Math.pow(pressure / 101.3, 0.35)));

  // Cool flame transition in microgravity + low O2 + low flow
  const isCool = g < 0.08 && o2 <= 18.2 && flow <= 5.5;
  const isExtinguished = o2 < 13.5 || (g < 0.05 && flow > 32 && o2 < 20);

  let regime = 'Sustained Diffusion Flame';
  let regimeBadge = 'HIGH';
  if (isExtinguished) {
    regime = 'Extinguished / Blow-Off';
    regimeBadge = 'LOW';
  } else if (isCool) {
    regime = 'Cool Flame (FLEX-2 ~650 K)';
    regimeBadge = 'MODERATE';
  } else if (g < 0.05 && flow < 1.5 && o2 < 22) {
    regime = 'Quiescent Radiative Decay';
    regimeBadge = 'LOW';
  } else if (o2 >= 30) {
    regime = 'Enriched-O₂ Rapid Spread';
    regimeBadge = 'CRITICAL';
  } else if (g < 0.05 && flow >= 3 && flow <= 16) {
    regime = 'Ventilation-Paradox Zone';
    regimeBadge = 'HIGH';
  }

  // Soot luminance (higher in 1g and higher O2, suppressed in 0g blue flame & cool flame)
  const soot = isExtinguished
    ? 0.0
    : isCool
      ? 0.04
      : Math.max(0.05, Math.min(1.0, (0.14 + 0.72 * buoyancy) * Math.min(1.35, o2Factor) * pFactor));

  const intensity = isExtinguished
    ? 0.05
    : isCool
      ? 0.52
      : Math.max(0.25, Math.min(1.45, o2Factor * (0.72 + 0.28 * pFactor)));

  const heightMm = isExtinguished
    ? 0
    : isCool
      ? 14 + flow * 0.4
      : Math.round((24 + 54 * buoyancy + 14 * Math.max(0, o2Factor - 0.6)) * pFactor);

  const tempK = isExtinguished
    ? 300
    : isCool
      ? Math.round(620 + (o2 - 14) * 28)
      : Math.round(1380 + 480 * Math.min(1.3, o2Factor) + 140 * buoyancy);

  const sootYield = isExtinguished
    ? 0.0
    : Number((soot * 100).toFixed(0));

  const windNorm = Math.min(1.0, flow / 26.0);
  const fuelIndex = FUEL_MODES.find((f) => f.id === fuelMode)?.index ?? 0;

  return {
    buoyancy,
    vBuoyant: Number(vBuoyant.toFixed(1)),
    vEff: Number(vEff.toFixed(1)),
    soot,
    intensity,
    isCool: isCool ? 1.0 : 0.0,
    isExtinguished,
    windNorm,
    fuelIndex,
    regime,
    regimeBadge,
    heightMm,
    tempK,
    sootYield,
  };
}
