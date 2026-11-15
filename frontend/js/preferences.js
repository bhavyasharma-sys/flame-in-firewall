/**
 * Ignis — Appearance & Preference Engine (Ready-Made Main Themes, Font Themes,
 * Typography Scale, Corner Radius, Motion Toggles, Voice Language & Key Persistence)
 */

import { api } from './api.js';
import { emit, setTheme } from './state.js';

export const PREFS_STORAGE_KEY = 'ignis_prefs_v1';
export const KEYS_STORAGE_KEY = 'ignis_saved_keys_v1';

export const MAIN_THEMES = [
  {
    id: 'obsidian-ember',
    name: 'Obsidian Horizon',
    tag: 'Default',
    mode: 'dark',
    desc: 'Deep charcoal obsidian with molten-orange planetary glow.',
    swatches: ['#060504', '#0d0b0a', '#ff4d12', '#faf8f6'],
  },
  {
    id: 'warm-paper',
    name: 'Warm Paper',
    tag: 'Light',
    mode: 'light',
    desc: 'Editorial off-white paper canvas with soft glass and coral accents.',
    swatches: ['#faf8f5', '#ffffff', '#ff5e3a', '#111827'],
  },
  {
    id: 'orbital-gold',
    name: 'Lunar Gold',
    tag: 'Dark',
    mode: 'dark',
    desc: 'Deep space carbon paired with Artemis solar-gold instruments.',
    swatches: ['#050506', '#0e0c09', '#f59e0b', '#fef3c7'],
  },
  {
    id: 'cryo-cyan',
    name: 'Cryo Telemetry',
    tag: 'Dark',
    mode: 'dark',
    desc: 'Pitch flight-deck carbon with crisp cyan mission-control telemetry.',
    swatches: ['#04070a', '#0a1117', '#06b6d4', '#e0f2fe'],
  },
  {
    id: 'crimson-solar',
    name: 'Solar Flare',
    tag: 'Dark',
    mode: 'dark',
    desc: 'Charred obsidian void with radiant crimson combustion highlights.',
    swatches: ['#070405', '#110a0c', '#ef4444', '#fee2e2'],
  },
  {
    id: 'forest-mission',
    name: 'Biosphere Emerald',
    tag: 'Dark',
    mode: 'dark',
    desc: 'Dark habitat slate with calm life-support emerald readouts.',
    swatches: ['#040706', '#0a100d', '#10b981', '#d1fae5'],
  },
];

export const FONT_THEMES = [
  {
    id: 'jakarta',
    name: 'Ignis Geometric',
    tag: 'Default',
    desc: 'Plus Jakarta Sans display + JetBrains Mono telemetry',
    sample: 'Microgravity Flame Safety · 0.00g',
    previewFont: "'Plus Jakarta Sans', system-ui, sans-serif",
    googleUrl: null,
  },
  {
    id: 'space-grotesk',
    name: 'Aerospace Technical',
    tag: 'Precision',
    desc: 'Space Grotesk headlines + Inter UI + JetBrains Mono',
    sample: 'NASA ISS Combustion Chamber · 34% O₂',
    previewFont: "'Space Grotesk', 'Plus Jakarta Sans', sans-serif",
    googleUrl:
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap',
  },
  {
    id: 'editorial-serif',
    name: 'Mission Journal',
    tag: 'Editorial',
    desc: 'Newsreader serif headings + Plus Jakarta Sans body',
    sample: 'Orbital Fire Dynamics & Spherical Shells',
    previewFont: "'Newsreader', Georgia, serif",
    googleUrl:
      'https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,500;0,6..72,600;0,6..72,700;1,6..72,500&display=swap',
  },
  {
    id: 'outfit-clean',
    name: 'Modern Studio',
    tag: 'Clean',
    desc: 'Outfit display + DM Sans interface + JetBrains Mono',
    sample: 'Transform Space Fire Data Into Safety',
    previewFont: "'Outfit', 'Plus Jakarta Sans', sans-serif",
    googleUrl:
      'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Outfit:wght@500;600;700;800&display=swap',
  },
  {
    id: 'mono-terminal',
    name: 'NASA Console Mono',
    tag: 'Flight Deck',
    desc: 'JetBrains Mono instrumentation across all headings and data',
    sample: 'LOI: 19.3% | RISK: 84.2 | FLOW: 10 CM/S',
    previewFont: "'JetBrains Mono', ui-monospace, monospace",
    googleUrl: null,
  },
];

export const DEFAULT_PREFS = {
  palette: 'obsidian-ember',
  font: 'jakarta',
  scale: 'default',       // 'compact' | 'default' | 'comfortable'
  radius: 'balanced',     // 'sharp' | 'balanced' | 'soft'
  showIntro: true,
  scrollAnim: true,
  ambientGlow: true,
  voiceLang: 'auto',
  rememberKeysInBrowser: true,
};

const loadedFontUrls = new Set();

export function loadFontThemeStylesheet(fontId) {
  const def = FONT_THEMES.find((f) => f.id === fontId);
  if (!def || !def.googleUrl || loadedFontUrls.has(def.googleUrl)) return;
  loadedFontUrls.add(def.googleUrl);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = def.googleUrl;
  document.head.appendChild(link);
}

export function getPreferences() {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_PREFS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function applyPreferences(partial = null, { persistLocal = true, persistServer = false } = {}) {
  const current = getPreferences();
  const next = partial ? { ...current, ...partial } : current;

  const themeObj = MAIN_THEMES.find((t) => t.id === next.palette) || MAIN_THEMES[0];
  const fontObj = FONT_THEMES.find((f) => f.id === next.font) || FONT_THEMES[0];
  next.palette = themeObj.id;
  next.font = fontObj.id;

  const root = document.documentElement;
  root.setAttribute('data-palette', next.palette);
  root.setAttribute('data-font', next.font);
  root.setAttribute('data-scale', next.scale || 'default');
  root.setAttribute('data-radius', next.radius || 'balanced');
  root.setAttribute('data-glow', next.ambientGlow === false ? 'off' : 'on');
  root.setAttribute('data-scroll-anim', next.scrollAnim === false ? 'off' : 'on');

  loadFontThemeStylesheet(next.font);

  // Keep Light/Dark state & charts synced with the selected palette mode
  setTheme(themeObj.mode);

  if (persistLocal) {
    try {
      localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore storage quota errors
    }
  }

  emit('preferences:changed', next);

  if (persistServer) {
    void api.saveSettings({ preferences: next }).catch(() => {});
  }

  return next;
}

export function getBrowserCachedKeys() {
  try {
    const raw = localStorage.getItem(KEYS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function saveBrowserCachedKeys(payload) {
  try {
    if (!payload) {
      localStorage.removeItem(KEYS_STORAGE_KEY);
      return;
    }
    localStorage.setItem(KEYS_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore storage restrictions
  }
}

export function updateEngineStatusBadge(displayLabel) {
  const label = document.getElementById('sidebar-ai-engine');
  if (label && displayLabel) {
    label.textContent = displayLabel;
  }
}

/**
 * Syncs persisted preferences & browser-saved API keys with the backend on login/startup
 * so user settings and API keys survive both browser refreshes and server restarts.
 */
export async function syncSettingsOnStartup() {
  try {
    const serverData = await api.getSettings();
    const localPrefs = getPreferences();
    const serverPrefs = serverData?.preferences || {};
    const hasLocalPrefs = Boolean(localStorage.getItem(PREFS_STORAGE_KEY));

    // If first visit on a browser but server already has saved preferences, apply server preferences
    if (!hasLocalPrefs && Object.keys(serverPrefs).length > 0) {
      applyPreferences(serverPrefs, { persistLocal: true, persistServer: false });
    }

    // If browser remembered keys and backend lost them after a cold restart, restore automatically
    const cachedCreds = getBrowserCachedKeys();
    const serverHasAnyKey = Object.values(serverData?.ai?.providers || {}).some((p) => p?.configured);
    if (localPrefs.rememberKeysInBrowser !== false && cachedCreds && !serverHasAnyKey) {
      const hasCachedKeys = Object.values(cachedCreds.api_keys || {}).some((v) => String(v || '').trim());
      if (hasCachedKeys || cachedCreds.preferred_provider) {
        const synced = await api.saveSettings({
          preferred_provider: cachedCreds.preferred_provider,
          api_keys: cachedCreds.api_keys,
          models: cachedCreds.models,
        });
        updateEngineStatusBadge(synced?.ai?.display_label);
        return synced;
      }
    }

    updateEngineStatusBadge(serverData?.ai?.display_label);
    return serverData;
  } catch {
    return null;
  }
}
