/**
 * Typed REST + SSE API client (relative URLs for seamless live-preview proxying).
 */

async function jsonFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status} ${url}: ${text || res.statusText}`);
  }
  return res.json();
}

export const api = {
  health: () => jsonFetch('/api/health'),
  stats: () => jsonFetch('/api/stats'),
  filters: () => jsonFetch('/api/filters'),
  summary: () => jsonFetch('/api/summary'),
  search: (q) => jsonFetch(`/api/search?q=${encodeURIComponent(q)}`),
  presets: () => jsonFetch('/api/presets'),

  evaluateCabin: (config) =>
    jsonFetch('/api/evaluate-cabin', { method: 'POST', body: JSON.stringify(config) }),

  ventilationCurve: () => jsonFetch('/api/physics/ventilation-curve'),

  phaseGrid: ({ material, gravity_g, flow_cm_s, diluent }) => {
    const p = new URLSearchParams({
      material,
      gravity_g: String(gravity_g),
      flow_cm_s: String(flow_cm_s),
      diluent,
    });
    return jsonFetch(`/api/physics/phase-grid?${p.toString()}`);
  },

  rankRuns: (config, weights, limit = 50) =>
    jsonFetch('/api/runs/rank', {
      method: 'POST',
      body: JSON.stringify({ config, weights, limit }),
    }),

  telemetry: (expId) => jsonFetch(`/api/telemetry/${encodeURIComponent(expId)}`),

  rankExperiments: (focus = 'safety') =>
    jsonFetch(`/api/rank/experiments?focus=${encodeURIComponent(focus)}`),
  rankMaterials: (environment = 'Lunar 34% O2') =>
    jsonFetch(`/api/rank/materials?environment=${encodeURIComponent(environment)}`),
  rankFindings: () => jsonFetch('/api/rank/findings'),
  rankGuidelines: (environment = '') =>
    jsonFetch(`/api/rank/guidelines${environment ? `?environment=${encodeURIComponent(environment)}` : ''}`),

  experiments: (params = {}) => {
    const p = new URLSearchParams();
    if (params.query) p.set('query', params.query);
    if (params.category) p.set('category', params.category);
    if (params.platform) p.set('platform', params.platform);
    const qs = p.toString();
    return jsonFetch(`/api/experiments${qs ? `?${qs}` : ''}`);
  },
  experimentDetail: (id) => jsonFetch(`/api/experiments/${encodeURIComponent(id)}`),

  materials: () => jsonFetch('/api/materials'),
  findings: () => jsonFetch('/api/findings'),
  guidelines: () => jsonFetch('/api/guidelines'),

  compare: (e1, e2) =>
    jsonFetch(`/api/compare?e1=${encodeURIComponent(e1)}&e2=${encodeURIComponent(e2)}`),

  documents: () => jsonFetch('/api/documents'),
  documentDetail: (docId) => jsonFetch(`/api/documents/${encodeURIComponent(docId)}`),

  graph: () => jsonFetch('/api/graph'),
  graphNode: (nodeId) => jsonFetch(`/api/graph/node/${encodeURIComponent(nodeId)}`),

  clearMemory: () => jsonFetch('/api/chat/memory', { method: 'DELETE' }),

  async streamChat({ message, scenario = null }, handlers = {}) {
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, scenario }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`Chat stream failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() || '';
      for (const block of blocks) {
        if (!block.trim()) continue;
        let eventName = 'message';
        const dataLines = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trim());
          }
        }
        if (!dataLines.length) continue;
        let parsed = null;
        try {
          parsed = JSON.parse(dataLines.join('\n'));
        } catch {
          parsed = dataLines.join('\n');
        }
        handlers[eventName]?.(parsed);
      }
    }
  },
};
