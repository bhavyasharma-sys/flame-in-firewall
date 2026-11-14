/**
 * Shared reactive application state & common UI helpers.
 */

const listeners = new Map();

export const state = {
  theme: localStorage.getItem('fif_theme') || 'dark',
  activeTab: 'dashboard',
  stats: null,
  presets: [],
  documents: [],
  experiments: [],
  materials: [],
  findings: [],
  guidelines: [],
  activeCabin: {
    oxygen_pct: 21.0,
    pressure_kpa: 101.3,
    flow_velocity_cm_s: 10.0,
    gravity_g: 0.0,
    fuel_material: 'PMMA',
    diluent_gas: 'N2',
  },
  activeCabinEval: null,
};

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}

export function emit(event, payload) {
  const fns = listeners.get(event);
  if (!fns) return;
  for (const fn of fns) {
    try {
      fn(payload);
    } catch (err) {
      console.error(`[state:${event}]`, err);
    }
  }
}

export function setActiveCabin(partial, { silent = false } = {}) {
  state.activeCabin = { ...state.activeCabin, ...partial };
  if (!silent) emit('cabin:changed', state.activeCabin);
}

export function setTheme(theme) {
  state.theme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', state.theme);
  localStorage.setItem('fif_theme', state.theme);
  emit('theme:changed', state.theme);
}

export function chartThemeColors() {
  const isLight = state.theme === 'light';
  return {
    text: isLight ? '#334155' : '#94a3b8',
    textStrong: isLight ? '#0f172a' : '#f1f5f9',
    grid: isLight ? 'rgba(15, 23, 42, 0.09)' : 'rgba(148, 163, 184, 0.14)',
    tooltipBg: isLight ? 'rgba(255, 255, 255, 0.96)' : 'rgba(13, 20, 36, 0.96)',
    tooltipBorder: isLight ? 'rgba(15, 23, 42, 0.16)' : 'rgba(148, 163, 184, 0.28)',
  };
}

export function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function riskColor(band) {
  const b = String(band || '').toUpperCase();
  if (b === 'CRITICAL') return '#ef4444';
  if (b === 'HIGH') return '#f97316';
  if (b === 'MODERATE') return '#eab308';
  return '#22c55e';
}

export function renderRichMarkdown(rawText) {
  const safe = esc(rawText || '');
  const lines = safe.split('\n');
  let html = '';
  let inList = false;

  const formatInline = (line) => {
    let s = line;
    // Bold & italic
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/`([^`]+)`/g, '<code class="mono" style="background:var(--bg-surface-3);padding:1px 5px;border-radius:4px;font-size:12px;">$1</code>');
    // Inline clickable citations [DOC-01 p.3], [DOC-BRIEF p.1], or [ISS-BASS-II p.1]
    s = s.replace(
      /\[((?:DOC|ISS)-[A-Z0-9-]+)(?:\s+p\.(\d+))?\]/g,
      (_, docId, page) => {
        const p = page ? Number(page) : 1;
        const label = page ? `${docId} p.${page}` : docId;
        return `<button type="button" class="cite-chip" data-doc-id="${docId}" data-doc-page="${p}">${label}</button>`;
      }
    );
    // Inline clickable experiment IDs [EXP-0023]
    s = s.replace(
      /\[(EXP-\d{4})\]/g,
      (_, expId) =>
        `<button type="button" class="cite-chip exp-chip" data-exp-id="${expId}">${expId}</button>`
    );
    return s;
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (inList) {
        html += '</ul>';
        inList = false;
      }
      continue;
    }
    if (trimmed.startsWith('### ')) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<h3>${formatInline(trimmed.slice(4))}</h3>`;
    } else if (trimmed.startsWith('## ')) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<h2>${formatInline(trimmed.slice(3))}</h2>`;
    } else if (trimmed.startsWith('# ')) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<h1>${formatInline(trimmed.slice(2))}</h1>`;
    } else if (trimmed.startsWith('&gt; ')) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<blockquote>${formatInline(trimmed.slice(5))}</blockquote>`;
    } else if (/^[-*•]\s+/.test(trimmed)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${formatInline(trimmed.replace(/^[-*•]\s+/, ''))}</li>`;
    } else if (/^\d+\.\s+/.test(trimmed)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${formatInline(trimmed.replace(/^\d+\.\s+/, ''))}</li>`;
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<p>${formatInline(trimmed)}</p>`;
    }
  }
  if (inList) html += '</ul>';
  return html;
}
