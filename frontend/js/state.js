/**
 * Shared reactive application state & common UI helpers.
 */

const listeners = new Map();

export const state = {
  theme: (() => {
    try {
      return localStorage.getItem('ignis_theme_v3') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  })(),
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
  try {
    localStorage.setItem('ignis_theme_v3', state.theme);
  } catch {
    // ignore storage restrictions
  }
  const toggleBtn = document.getElementById('theme-toggle-btn');
  if (toggleBtn) toggleBtn.setAttribute('aria-checked', String(state.theme === 'dark'));
  emit('theme:changed', state.theme);
}

export function chartThemeColors() {
  const isLight = state.theme === 'light';
  return {
    text: isLight ? '#52525b' : '#a1a1aa',
    textStrong: isLight ? '#111827' : '#fafafa',
    grid: isLight ? 'rgba(15, 23, 42, 0.07)' : 'rgba(255, 255, 255, 0.08)',
    tooltipBg: isLight ? 'rgba(255, 255, 255, 0.96)' : 'rgba(10, 10, 13, 0.96)',
    tooltipBorder: isLight ? 'rgba(15, 23, 42, 0.12)' : 'rgba(255, 255, 255, 0.14)',
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
  // Strip redundant leading "FlameAI Grounded Synthesis — [query]" title clutter
  // and trailing "Cited NASA Sources:" footer (rendered inline as clickable chips)
  const stripped = String(rawText || '')
    .replace(/^(?:#{1,4}\s*|\*\*)?FlameAI\s+Grounded\s+Synthesis(?:\s*[—–-]\s*.*)?\*?\*?\s*\n+/i, '')
    .replace(/\n*(?:\*\*|#{1,4}\s*)?Cited NASA Sources:\*?\*?\s*[\s\S]*$/i, '');
  const safe = esc(stripped);
  const lines = safe.split('\n');
  let html = '';
  let inList = false;

  const formatInline = (line) => {
    let s = line;
    // Safe Markdown links: [Label](https://...) or [Label](/papers/...)
    s = s.replace(
      /\[([^\]]+)\]\(((?:https?:\/\/|\/papers\/)[^\s)]+)\)/g,
      (_, label, href) =>
        `<a class="md-link" href="${href}" target="_blank" rel="noopener noreferrer">${label} ↗</a>`
    );
    // Bold, italic & inline code
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
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
    if (trimmed.startsWith('#### ')) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<h4>${formatInline(trimmed.slice(5))}</h4>`;
    } else if (trimmed.startsWith('### ')) {
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

/**
 * Turns a slider's value readout span (`#${sliderId}-val`) into a click-to-edit
 * numeric input so users can either drag the slider OR click the number to type
 * any custom value. Pass `min: null` / `max: null` for no lower/upper limit.
 */
export function bindEditableSliderValue({
  sliderId,
  valueId = `${sliderId}-val`,
  min = null,
  max = null,
  getValue,
  formatValue,
  onCommit,
}) {
  const slider = document.getElementById(sliderId);
  const valEl = document.getElementById(valueId);
  if (!valEl) return;

  valEl.classList.add('editable');
  valEl.tabIndex = 0;
  valEl.setAttribute('role', 'button');
  if (min !== null && max !== null) {
    valEl.title = `Click to enter a custom value (${min}–${max})`;
  } else if (min !== null) {
    valEl.title = `Click to enter any custom value (≥ ${min})`;
  } else {
    valEl.title = 'Click to enter any custom value';
  }

  let editing = false;

  const openEditor = () => {
    if (editing) return;
    editing = true;
    const current = Number(getValue());
    const input = document.createElement('input');
    input.type = 'number';
    input.step = 'any';
    if (min !== null) input.min = String(min);
    if (max !== null) input.max = String(max);
    input.value = Number.isFinite(current) ? String(current) : '';
    input.className = 'slider-val-input';
    input.setAttribute('aria-label', valEl.title);

    valEl.style.display = 'none';
    valEl.insertAdjacentElement('afterend', input);
    input.focus();
    input.select();

    let finished = false;
    const close = (commit) => {
      if (finished) return;
      finished = true;
      editing = false;
      const raw = input.value.trim();
      input.remove();
      valEl.style.display = '';

      if (commit && raw !== '') {
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) {
          let val = parsed;
          if (min !== null) val = Math.max(min, val);
          if (max !== null) val = Math.min(max, val);
          const clean = Math.round(val * 10000) / 10000;
          if (slider) {
            const sMin = Number(slider.min);
            const sMax = Number(slider.max);
            if (Number.isFinite(sMin) && Number.isFinite(sMax)) {
              slider.value = String(Math.min(sMax, Math.max(sMin, clean)));
            }
          }
          valEl.textContent = formatValue(clean);
          onCommit(clean);
          return;
        }
      }
      valEl.textContent = formatValue(Number(getValue()));
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        close(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
      }
    });
    input.addEventListener('blur', () => close(true));
  };

  valEl.addEventListener('click', openEditor);
  valEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openEditor();
    }
  });
}
