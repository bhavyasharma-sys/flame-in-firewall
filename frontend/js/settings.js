/**
 * Ignis — Settings & Personalization View
 * Ready-made main themes, font themes, UI scale/radius/motion controls,
 * persistent multi-provider API key management, and live API model extraction/selection.
 */

import { api } from './api.js';
import { playGlassIntro } from './glass-intro.js';
import {
  applyPreferences,
  DEFAULT_PREFS,
  FONT_THEMES,
  getBrowserCachedKeys,
  getPreferences,
  loadFontThemeStylesheet,
  MAIN_THEMES,
  saveBrowserCachedKeys,
  updateEngineStatusBadge,
} from './preferences.js';
import { esc, on } from './state.js';

const PROVIDERS = [
  {
    id: 'openai',
    name: 'OpenAI',
    badge: 'Chat + Whisper Mic',
    placeholder: 'sk-...',
    defaultModel: 'gpt-4o-mini',
    hint: 'Powers FlameAI synthesis and server-side Whisper voice dictation.',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    badge: 'Fast Multimodal',
    placeholder: 'AIza...',
    defaultModel: 'gemini-2.5-flash',
    hint: 'Google AI Studio REST key for Gemini 2.5 Flash / Pro.',
  },
  {
    id: 'groq',
    name: 'Groq',
    badge: 'Ultra-Fast + Whisper',
    placeholder: 'gsk_...',
    defaultModel: 'llama-3.3-70b-versatile',
    hint: 'Ultra-low-latency Llama 3.3 + Whisper Large v3 Turbo voice transcription.',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    badge: 'Multi-Model',
    placeholder: 'sk-or-...',
    defaultModel: 'google/gemini-2.5-flash',
    hint: 'Route across Claude, GPT, Gemini, and Llama models with one key.',
  },
];

let serverState = null;
let initialized = false;
let toastTimer = null;

// Cache of extracted models per provider during this session: { [provider]: Array<{id, label, context_length, category}> }
const discoveredModels = new Map();
const modelFilterQueries = new Map();

function showSettingsToast(msg, variant = 'ok') {
  const el = document.getElementById('settings-toast');
  if (!el) return;
  if (toastTimer) clearTimeout(toastTimer);
  el.textContent = msg;
  el.dataset.variant = variant;
  el.classList.add('is-visible');
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 3200);
}

function fmtCtx(n) {
  if (!n || typeof n !== 'number') return '';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M ctx`;
  if (n >= 1000) return `${Math.round(n / 1000)}k ctx`;
  return `${n} ctx`;
}

function renderThemeCards() {
  const grid = document.getElementById('settings-theme-grid');
  if (!grid) return;
  const prefs = getPreferences();

  grid.innerHTML = MAIN_THEMES.map((t) => {
    const active = prefs.palette === t.id;
    const [bg, card, accent, text] = t.swatches;
    return `
      <button type="button" class="settings-theme-card${active ? ' is-active' : ''}" data-select-palette="${esc(t.id)}" aria-pressed="${active}">
        <div class="settings-theme-preview" style="background:${bg};">
          <div class="stp-top">
            <span class="stp-dot" style="background:${accent};"></span>
            <span class="stp-bar" style="background:${text};opacity:0.22;"></span>
          </div>
          <div class="stp-card" style="background:${card};border-color:${accent}33;">
            <span class="stp-accent-line" style="background:${accent};"></span>
            <span class="stp-text-line" style="background:${text};opacity:0.85;"></span>
            <span class="stp-text-line short" style="background:${text};opacity:0.35;"></span>
          </div>
          <div class="stp-horizon" style="background:linear-gradient(90deg, transparent, ${accent}, transparent);"></div>
        </div>
        <div class="settings-theme-meta">
          <div class="flex items-center justify-between gap-2">
            <strong>${esc(t.name)}</strong>
            <span class="settings-chip">${esc(t.tag)}</span>
          </div>
          <p>${esc(t.desc)}</p>
        </div>
      </button>
    `;
  }).join('');

  grid.querySelectorAll('[data-select-palette]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.selectPalette;
      applyPreferences({ palette: id }, { persistLocal: true, persistServer: true });
      renderThemeCards();
      const found = MAIN_THEMES.find((m) => m.id === id);
      showSettingsToast(`Theme switched to ${found?.name || id} & saved`);
    });
  });
}

function renderFontCards() {
  const grid = document.getElementById('settings-font-grid');
  if (!grid) return;
  const prefs = getPreferences();

  FONT_THEMES.forEach((f) => loadFontThemeStylesheet(f.id));

  grid.innerHTML = FONT_THEMES.map((f) => {
    const active = prefs.font === f.id;
    return `
      <button type="button" class="settings-font-card${active ? ' is-active' : ''}" data-select-font="${esc(f.id)}" aria-pressed="${active}">
        <div class="flex items-center justify-between gap-2 mb-1">
          <strong>${esc(f.name)}</strong>
          <span class="settings-chip">${esc(f.tag)}</span>
        </div>
        <div class="settings-font-sample" style="font-family:${f.previewFont};">${esc(f.sample)}</div>
        <div class="settings-font-desc">${esc(f.desc)}</div>
      </button>
    `;
  }).join('');

  grid.querySelectorAll('[data-select-font]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.selectFont;
      applyPreferences({ font: id }, { persistLocal: true, persistServer: true });
      renderFontCards();
      const found = FONT_THEMES.find((f) => f.id === id);
      showSettingsToast(`Font theme set to ${found?.name || id} & saved`);
    });
  });
}

function syncControlsFromPrefs() {
  const prefs = getPreferences();

  document.querySelectorAll('[data-pref-scale]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.prefScale === prefs.scale);
  });
  document.querySelectorAll('[data-pref-radius]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.prefRadius === prefs.radius);
  });

  const introToggle = document.getElementById('pref-show-intro');
  const scrollToggle = document.getElementById('pref-scroll-anim');
  const glowToggle = document.getElementById('pref-ambient-glow');
  const rememberToggle = document.getElementById('pref-remember-keys');
  const voiceSelect = document.getElementById('pref-voice-lang');

  if (introToggle) introToggle.checked = prefs.showIntro !== false;
  if (scrollToggle) scrollToggle.checked = prefs.scrollAnim !== false;
  if (glowToggle) glowToggle.checked = prefs.ambientGlow !== false;
  if (rememberToggle) rememberToggle.checked = prefs.rememberKeysInBrowser !== false;
  if (voiceSelect) voiceSelect.value = prefs.voiceLang || 'auto';
}

async function persistSelectedModel(providerId, modelId) {
  const modelInput = document.getElementById(`api-model-${providerId}`);
  const keyInput = document.getElementById(`api-key-${providerId}`);
  if (modelInput) modelInput.value = modelId;

  const typedKey = keyInput?.value?.trim() || '';
  const payload = { models: { [providerId]: modelId } };
  if (typedKey) payload.api_keys = { [providerId]: typedKey };

  try {
    const updated = await api.saveSettings(payload);
    serverState = updated;

    const rememberToggle = document.getElementById('pref-remember-keys');
    if (rememberToggle?.checked) {
      const prev = getBrowserCachedKeys() || { api_keys: {}, models: {} };
      saveBrowserCachedKeys({
        preferred_provider: updated.ai?.preferred_provider || prev.preferred_provider || 'auto',
        api_keys: typedKey ? { ...(prev.api_keys || {}), [providerId]: typedKey } : prev.api_keys || {},
        models: { ...(prev.models || {}), [providerId]: modelId },
      });
    }

    const activeBadge = document.getElementById('settings-active-engine');
    if (activeBadge && updated.ai?.display_label) {
      activeBadge.textContent = updated.ai.display_label;
    }
    updateEngineStatusBadge(updated.ai?.display_label);

    // Update saved badge if a new key was persisted alongside model choice
    if (typedKey) {
      const statusEl = document.getElementById(`key-status-${providerId}`);
      const pInfo = updated.ai?.providers?.[providerId];
      if (statusEl && pInfo?.configured) {
        statusEl.textContent = `Saved · ${pInfo.masked_key}`;
        statusEl.classList.add('is-set');
      }
      if (keyInput) keyInput.value = '';
    }

    showSettingsToast(`Selected ${modelId} for ${providerId.toUpperCase()}`);
  } catch (err) {
    showSettingsToast(`Model selected locally (save failed: ${err.message})`, 'warn');
  }
}

function renderModelPicker(providerId, { errorMsg = null, loading = false } = {}) {
  const slot = document.getElementById(`model-picker-${providerId}`);
  const modelInput = document.getElementById(`api-model-${providerId}`);
  if (!slot) return;

  if (loading) {
    slot.innerHTML = `<div class="settings-model-status">Extracting available models from ${esc(providerId.toUpperCase())} API key…</div>`;
    slot.classList.add('is-open');
    return;
  }

  if (errorMsg) {
    slot.innerHTML = `<div class="settings-model-status is-error">${esc(errorMsg)}</div>`;
    slot.classList.add('is-open');
    return;
  }

  const allModels = discoveredModels.get(providerId);
  if (!allModels || !allModels.length) {
    slot.innerHTML = '';
    slot.classList.remove('is-open');
    return;
  }

  const currentVal = (modelInput?.value || '').trim();
  const filterQ = (modelFilterQueries.get(providerId) || '').trim().toLowerCase();
  const filtered = filterQ
    ? allModels.filter(
        (m) =>
          m.id.toLowerCase().includes(filterQ) ||
          (m.label && m.label.toLowerCase().includes(filterQ))
      )
    : allModels;

  const hasCurrentInList = filtered.some((m) => m.id === currentVal);

  slot.innerHTML = `
    <div class="settings-model-picker-head">
      <span class="settings-model-count">${allModels.length} models extracted from API key</span>
      ${
        allModels.length > 10
          ? `<input type="text" class="input settings-model-filter" id="model-filter-${esc(providerId)}" value="${esc(modelFilterQueries.get(providerId) || '')}" placeholder="Filter ${allModels.length} models..." aria-label="Filter ${esc(providerId)} models" />`
          : ''
      }
    </div>
    <select class="select settings-model-select" id="model-select-${esc(providerId)}" aria-label="Choose ${esc(providerId)} model">
      ${
        !hasCurrentInList && currentVal
          ? `<option value="${esc(currentVal)}" selected>${esc(currentVal)} (current)</option>`
          : ''
      }
      ${
        filtered.length
          ? filtered
              .map((m) => {
                const ctx = fmtCtx(m.context_length);
                const cat = m.category && m.category !== 'chat' ? ` [${m.category}]` : '';
                const text = `${m.label || m.id}${ctx ? ` · ${ctx}` : ''}${cat}`;
                return `<option value="${esc(m.id)}"${m.id === currentVal ? ' selected' : ''}>${esc(text)}</option>`;
              })
              .join('')
          : `<option value="" disabled>No models match "${esc(filterQ)}"</option>`
      }
    </select>
    <div class="settings-model-pills" aria-label="Quick select top models">
      ${filtered
        .slice(0, 6)
        .map(
          (m) => `
          <button type="button" class="settings-model-pill${m.id === currentVal ? ' is-selected' : ''}" data-pick-model="${esc(m.id)}">
            ${esc(m.id)}
          </button>
        `
        )
        .join('')}
    </div>
  `;
  slot.classList.add('is-open');

  const filterInput = document.getElementById(`model-filter-${providerId}`);
  filterInput?.addEventListener('input', () => {
    const pos = filterInput.selectionStart || filterInput.value.length;
    modelFilterQueries.set(providerId, filterInput.value);
    renderModelPicker(providerId);
    const nextFilter = document.getElementById(`model-filter-${providerId}`);
    if (nextFilter) {
      nextFilter.focus();
      try {
        nextFilter.setSelectionRange(pos, pos);
      } catch {
        // ignore
      }
    }
  });

  const selectEl = document.getElementById(`model-select-${providerId}`);
  selectEl?.addEventListener('change', () => {
    const chosen = selectEl.value;
    if (!chosen) return;
    void persistSelectedModel(providerId, chosen).then(() => renderModelPicker(providerId));
  });

  slot.querySelectorAll('[data-pick-model]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const chosen = btn.dataset.pickModel;
      if (!chosen) return;
      void persistSelectedModel(providerId, chosen).then(() => renderModelPicker(providerId));
    });
  });
}

const OPENAI_NON_CHAT_RE = /^(text-embedding|embedding|whisper|tts-|dall-e|text-moderation|omni-moderation|babbage-|davinci-|gpt-image|sora)/i;

async function fetchModelsDirectlyFromBrowser(providerId, apiKey) {
  if (!apiKey) return null;

  if (providerId === 'openai') {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`OPENAI rejected key or returned HTTP ${res.status}`);
    const data = (await res.json()).data || [];
    const seen = new Set();
    return data
      .map((m) => String(m.id || '').trim())
      .filter((id) => id && !seen.has(id) && seen.add(id))
      .map((id) => ({
        id,
        label: id,
        owned_by: 'openai',
        category: OPENAI_NON_CHAT_RE.test(id) ? 'media/embed' : 'chat',
      }))
      .sort((a, b) => {
        const rank = (x) =>
          /^(gpt-5|gpt-4\.1|gpt-4o|o4-|o3-|o1-)/i.test(x.id)
            ? 0
            : /^(gpt-4|chatgpt-)/i.test(x.id)
              ? 1
              : x.category === 'chat'
                ? 2
                : 9;
        return rank(a) - rank(b) || a.id.localeCompare(b.id);
      });
  }

  if (providerId === 'gemini') {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=200`
    );
    if (!res.ok) throw new Error(`GEMINI rejected key or returned HTTP ${res.status}`);
    const data = (await res.json()).models || [];
    const seen = new Set();
    return data
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => {
        const rawName = String(m.name || '').trim();
        const id = rawName.includes('models/') ? rawName.split('models/')[1] : rawName;
        const display = String(m.displayName || id).trim();
        return {
          id,
          label: display.toLowerCase() !== id.toLowerCase() ? `${display} (${id})` : id,
          owned_by: 'google',
          context_length: typeof m.inputTokenLimit === 'number' ? m.inputTokenLimit : null,
          category: 'chat',
        };
      })
      .filter((m) => m.id && !seen.has(m.id) && seen.add(m.id))
      .sort((a, b) => {
        const rank = (id) =>
          id.startsWith('gemini-2.5') ? 0 : id.startsWith('gemini-2.0') ? 1 : id.startsWith('gemini-1.5') ? 2 : 4;
        return rank(a.id) - rank(b.id) || a.id.localeCompare(b.id);
      });
  }

  if (providerId === 'groq') {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`GROQ rejected key or returned HTTP ${res.status}`);
    const data = (await res.json()).data || [];
    const seen = new Set();
    return data
      .filter((m) => m.active !== false)
      .map((m) => {
        const id = String(m.id || '').trim();
        const isAudio = /whisper|tts|guard/i.test(id);
        return {
          id,
          label: id,
          owned_by: String(m.owned_by || 'groq'),
          context_length: typeof m.context_window === 'number' ? m.context_window : null,
          category: isAudio ? 'audio/guard' : 'chat',
        };
      })
      .filter((m) => m.id && !seen.has(m.id) && seen.add(m.id))
      .sort((a, b) => (a.category === 'chat' ? 0 : 1) - (b.category === 'chat' ? 0 : 1) || a.id.localeCompare(b.id));
  }

  if (providerId === 'openrouter') {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`OPENROUTER rejected key or returned HTTP ${res.status}`);
    const data = (await res.json()).data || [];
    const seen = new Set();
    return data
      .map((m) => {
        const id = String(m.id || '').trim();
        const name = String(m.name || id).trim();
        return {
          id,
          label: name.toLowerCase() !== id.toLowerCase() ? `${name} — ${id}` : id,
          owned_by: id.includes('/') ? id.split('/')[0] : 'openrouter',
          context_length: typeof m.context_length === 'number' ? m.context_length : null,
          category: 'chat',
        };
      })
      .filter((m) => m.id && !seen.has(m.id) && seen.add(m.id))
      .sort((a, b) => (a.id.includes(':free') ? 0 : 1) - (b.id.includes(':free') ? 0 : 1) || a.id.localeCompare(b.id));
  }

  return null;
}

async function fetchModelsForProvider(providerId, { silent = false } = {}) {
  const btn = document.getElementById(`btn-fetch-models-${providerId}`);
  const keyInput = document.getElementById(`api-key-${providerId}`);
  const typedKey = keyInput?.value?.trim() || '';
  const cachedKey = getBrowserCachedKeys()?.api_keys?.[providerId] || '';
  const candidateKey = typedKey || cachedKey;

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Extracting…';
  }
  if (!silent) renderModelPicker(providerId, { loading: true });

  try {
    let list = null;
    try {
      const res = await api.discoverModels(providerId, typedKey);
      list = Array.isArray(res.models) ? res.models : [];
    } catch (serverErr) {
      // If the backend server is in a network-restricted preview sandbox (HTTP 502),
      // transparently fall back to fetching models directly via the user's browser CORS API!
      const isServerNetworkErr = /API 50[234]/.test(serverErr?.message || '');
      if (isServerNetworkErr && candidateKey) {
        list = await fetchModelsDirectlyFromBrowser(providerId, candidateKey);
      } else {
        throw serverErr;
      }
    }

    list = Array.isArray(list) ? list : [];
    discoveredModels.set(providerId, list);
    renderModelPicker(providerId);
    if (!silent) {
      showSettingsToast(`Extracted ${list.length} models from ${providerId.toUpperCase()} API key`);
    }
  } catch (err) {
    let msg = err.message || 'Could not extract models';
    const jsonIdx = msg.indexOf('{');
    if (jsonIdx !== -1) {
      try {
        const parsed = JSON.parse(msg.slice(jsonIdx));
        if (parsed.detail) msg = parsed.detail;
      } catch {
        // keep original
      }
    }
    if (!silent) {
      renderModelPicker(providerId, { errorMsg: msg });
      showSettingsToast(msg, 'warn');
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Fetch Models';
    }
  }
}

function renderProviderFields(aiStatus) {
  const wrap = document.getElementById('settings-api-providers');
  const activeBadge = document.getElementById('settings-active-engine');
  const prefSelect = document.getElementById('settings-preferred-provider');
  if (!wrap) return;

  if (activeBadge && aiStatus?.display_label) {
    activeBadge.textContent = aiStatus.display_label;
  }
  if (prefSelect && aiStatus?.preferred_provider) {
    prefSelect.value = aiStatus.preferred_provider;
  }

  const providersMap = aiStatus?.providers || {};

  wrap.innerHTML = PROVIDERS.map((p) => {
    const info = providersMap[p.id] || {};
    const configured = Boolean(info.configured);
    const masked = info.masked_key || '';
    const modelVal = info.model || p.defaultModel;
    return `
      <div class="settings-provider-card" data-provider-card="${esc(p.id)}">
        <div class="settings-provider-head">
          <div class="flex items-center gap-2 flex-wrap">
            <strong>${esc(p.name)}</strong>
            <span class="settings-chip">${esc(p.badge)}</span>
          </div>
          <span class="settings-key-status${configured ? ' is-set' : ''}" id="key-status-${esc(p.id)}">
            ${configured ? `Saved · ${esc(masked)}` : 'Not Configured'}
          </span>
        </div>
        <p class="settings-provider-hint">${esc(p.hint)}</p>
        <div class="settings-provider-inputs">
          <div class="settings-key-input-wrap">
            <input
              type="password"
              class="input settings-key-input"
              id="api-key-${esc(p.id)}"
              data-provider-key="${esc(p.id)}"
              autocomplete="off"
              spellcheck="false"
              placeholder="${configured ? `Leave blank to keep ${esc(masked)}, or paste new key` : `Paste ${esc(p.name)} API key (${esc(p.placeholder)})`}"
            />
            <button type="button" class="settings-eye-btn" data-toggle-eye="api-key-${esc(p.id)}" aria-label="Toggle API key visibility" title="Show / Hide">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
          <div class="settings-model-row">
            <input
              type="text"
              class="input settings-model-input"
              id="api-model-${esc(p.id)}"
              value="${esc(modelVal)}"
              placeholder="Model name"
              aria-label="${esc(p.name)} model name"
            />
            <button type="button" class="btn btn-sm settings-fetch-models-btn" id="btn-fetch-models-${esc(p.id)}" data-fetch-models="${esc(p.id)}" title="Extract all models available on this API key">
              Fetch Models
            </button>
            ${
              configured
                ? `<button type="button" class="btn btn-sm settings-clear-key-btn" data-clear-key="${esc(p.id)}">Clear</button>`
                : ''
            }
          </div>
          <div class="settings-model-picker" id="model-picker-${esc(p.id)}"></div>
        </div>
      </div>
    `;
  }).join('');

  // Re-hydrate any already-extracted model dropdowns cleanly
  PROVIDERS.forEach((p) => {
    if (discoveredModels.has(p.id)) {
      renderModelPicker(p.id);
    }
  });

  wrap.querySelectorAll('[data-toggle-eye]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.toggleEye);
      if (!target) return;
      target.type = target.type === 'password' ? 'text' : 'password';
      btn.classList.toggle('is-revealed', target.type === 'text');
    });
  });

  wrap.querySelectorAll('[data-fetch-models]').forEach((btn) => {
    btn.addEventListener('click', () => {
      void fetchModelsForProvider(btn.dataset.fetchModels, { silent: false });
    });
  });

  // Auto-extract models smoothly when the user pastes an API key
  wrap.querySelectorAll('[data-provider-key]').forEach((input) => {
    const pid = input.dataset.providerKey;
    input.addEventListener('paste', () => {
      setTimeout(() => {
        if ((input.value || '').trim().length >= 12) {
          void fetchModelsForProvider(pid, { silent: false });
        }
      }, 60);
    });
  });

  wrap.querySelectorAll('[data-clear-key]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const pid = btn.dataset.clearKey;
      try {
        const updated = await api.saveSettings({ api_keys: { [pid]: '' } });
        serverState = updated;
        discoveredModels.delete(pid);
        modelFilterQueries.delete(pid);
        const cached = getBrowserCachedKeys();
        if (cached?.api_keys) {
          delete cached.api_keys[pid];
          saveBrowserCachedKeys(cached);
        }
        renderProviderFields(updated.ai);
        updateEngineStatusBadge(updated.ai?.display_label);
        showSettingsToast(`Removed ${pid.toUpperCase()} API key`);
      } catch (err) {
        showSettingsToast(`Could not clear key: ${err.message}`, 'warn');
      }
    });
  });
}

async function handleSaveApiKeys(e) {
  e?.preventDefault();
  const saveBtn = document.getElementById('settings-save-keys-btn');
  const prefSelect = document.getElementById('settings-preferred-provider');
  const rememberToggle = document.getElementById('pref-remember-keys');

  const preferredProvider = prefSelect?.value || 'auto';
  const apiKeys = {};
  const models = {};
  const newlyAddedProviders = [];

  PROVIDERS.forEach((p) => {
    const keyInput = document.getElementById(`api-key-${p.id}`);
    const modelInput = document.getElementById(`api-model-${p.id}`);
    const typedKey = keyInput?.value?.trim();
    if (typedKey) {
      apiKeys[p.id] = typedKey;
      newlyAddedProviders.push(p.id);
    }
    const typedModel = modelInput?.value?.trim();
    if (typedModel) models[p.id] = typedModel;
  });

  if (saveBtn) saveBtn.disabled = true;
  try {
    const updated = await api.saveSettings({
      preferred_provider: preferredProvider,
      api_keys: apiKeys,
      models,
      preferences: getPreferences(),
    });
    serverState = updated;

    if (rememberToggle?.checked) {
      const prev = getBrowserCachedKeys() || { api_keys: {}, models: {} };
      saveBrowserCachedKeys({
        preferred_provider: preferredProvider,
        api_keys: { ...(prev.api_keys || {}), ...apiKeys },
        models: { ...(prev.models || {}), ...models },
      });
    } else {
      saveBrowserCachedKeys(null);
    }

    renderProviderFields(updated.ai);
    updateEngineStatusBadge(updated.ai?.display_label);
    showSettingsToast(`Saved! Active engine: ${updated.ai?.display_label || 'Updated'}`);

    // Automatically extract available models for any newly added API key
    for (const pid of newlyAddedProviders) {
      void fetchModelsForProvider(pid, { silent: false });
    }
  } catch (err) {
    showSettingsToast(`Save failed: ${err.message}`, 'warn');
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function handleResetDefaults() {
  try {
    const resetRes = await api.resetSettings();
    serverState = resetRes;
    discoveredModels.clear();
    modelFilterQueries.clear();
    saveBrowserCachedKeys(null);
    applyPreferences(DEFAULT_PREFS, { persistLocal: true, persistServer: false });
    renderThemeCards();
    renderFontCards();
    syncControlsFromPrefs();
    renderProviderFields(resetRes.ai);
    updateEngineStatusBadge(resetRes.ai?.display_label);
    showSettingsToast('All themes, fonts, and keys reset to defaults');
  } catch (err) {
    showSettingsToast(`Reset failed: ${err.message}`, 'warn');
  }
}

export async function initSettings() {
  renderThemeCards();
  renderFontCards();
  syncControlsFromPrefs();

  if (!initialized) {
    initialized = true;

    document.querySelectorAll('[data-pref-scale]').forEach((btn) => {
      btn.addEventListener('click', () => {
        applyPreferences({ scale: btn.dataset.prefScale }, { persistLocal: true, persistServer: true });
        syncControlsFromPrefs();
        showSettingsToast(`Text scale updated (${btn.dataset.prefScale})`);
      });
    });

    document.querySelectorAll('[data-pref-radius]').forEach((btn) => {
      btn.addEventListener('click', () => {
        applyPreferences({ radius: btn.dataset.prefRadius }, { persistLocal: true, persistServer: true });
        syncControlsFromPrefs();
        showSettingsToast(`Corner style updated (${btn.dataset.prefRadius})`);
      });
    });

    document.getElementById('pref-show-intro')?.addEventListener('change', (e) => {
      applyPreferences({ showIntro: e.target.checked }, { persistLocal: true, persistServer: true });
      showSettingsToast(e.target.checked ? 'Entrance glass animation enabled' : 'Entrance splash skipped on next login');
    });

    document.getElementById('pref-scroll-anim')?.addEventListener('change', (e) => {
      applyPreferences({ scrollAnim: e.target.checked }, { persistLocal: true, persistServer: true });
      showSettingsToast(e.target.checked ? 'Scroll reveal animations enabled' : 'Scroll animations disabled');
    });

    document.getElementById('pref-ambient-glow')?.addEventListener('change', (e) => {
      applyPreferences({ ambientGlow: e.target.checked }, { persistLocal: true, persistServer: true });
      showSettingsToast(e.target.checked ? 'Ambient horizon glow enabled' : 'Minimal flat background enabled');
    });

    document.getElementById('pref-remember-keys')?.addEventListener('change', (e) => {
      applyPreferences({ rememberKeysInBrowser: e.target.checked }, { persistLocal: true, persistServer: true });
      if (!e.target.checked) saveBrowserCachedKeys(null);
      showSettingsToast(
        e.target.checked
          ? 'API keys will also be remembered in this browser'
          : 'Browser key cache cleared (server file only)'
      );
    });

    document.getElementById('pref-voice-lang')?.addEventListener('change', (e) => {
      applyPreferences({ voiceLang: e.target.value }, { persistLocal: true, persistServer: true });
      showSettingsToast(`Voice dictation language saved (${e.target.value})`);
    });

    document.getElementById('btn-replay-intro')?.addEventListener('click', () => {
      const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
      playGlassIntro({ theme });
    });

    document.getElementById('settings-api-form')?.addEventListener('submit', handleSaveApiKeys);
    document.getElementById('settings-reset-btn')?.addEventListener('click', handleResetDefaults);

    on('preferences:changed', () => {
      renderThemeCards();
      renderFontCards();
      syncControlsFromPrefs();
    });
  }

  try {
    serverState = await api.getSettings();
    renderProviderFields(serverState.ai);

    // Silently auto-populate model lists for any provider whose API key is already saved
    const pMap = serverState?.ai?.providers || {};
    for (const p of PROVIDERS) {
      if (pMap[p.id]?.configured && !discoveredModels.has(p.id)) {
        void fetchModelsForProvider(p.id, { silent: true });
      }
    }
  } catch (err) {
    console.warn('Settings fetch failed:', err);
  }
}
