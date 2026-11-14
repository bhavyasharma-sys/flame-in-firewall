/**
 * Interactive Force-Directed NASA Knowledge Graph Canvas
 * Supports Zoom, Pan, Node Dragging, Type Filtering, Search & Subgraph Highlighting.
 */

import { api } from './api.js';
import { emit, esc, on, state } from './state.js';

const TYPE_COLORS = {
  experiment: '#f97316',
  material: '#06b6d4',
  finding: '#8b5cf6',
  safety_implication: '#ef4444',
  guideline: '#22c55e',
  paper: '#eab308',
};

const TYPE_LABELS = {
  experiment: 'Experiments',
  material: 'Materials',
  finding: 'Findings',
  safety_implication: 'Safety Impacts',
  guideline: 'Guidelines',
  paper: 'NASA Papers',
};

let rawGraph = null;
let simNodes = [];
let simEdges = [];
let activeTypes = new Set(['experiment', 'material', 'guideline', 'paper']);
let selectedNode = null;
let searchNeedle = '';

let canvas = null;
let ctx = null;
let zoom = 1.0;
let panX = 0;
let panY = 0;
let isPanning = false;
let dragNode = null;
let lastMouse = { x: 0, y: 0 };
let initialized = false;

export async function initGraph() {
  canvas = document.getElementById('kg-canvas');
  if (!canvas) return;
  ctx = canvas.getContext('2d');

  renderTypeFilters();
  bindGraphEvents();

  try {
    rawGraph = await api.graph();
    const statsEl = document.getElementById('kg-stats-badge');
    if (statsEl) {
      statsEl.textContent = `${rawGraph.stats.node_count} nodes · ${rawGraph.stats.edge_count} edges`;
    }
    rebuildLayout();
  } catch (err) {
    console.error('Graph load error:', err);
  }

  on('tab:changed', (tab) => {
    if (tab === 'graph') {
      resizeCanvas();
      drawGraph();
    }
  });
  on('theme:changed', () => drawGraph());
}

function renderTypeFilters() {
  const wrap = document.getElementById('kg-type-filters');
  if (!wrap) return;
  wrap.innerHTML = Object.entries(TYPE_LABELS)
    .map(
      ([type, label]) => `
      <button type="button" class="pill-btn ${activeTypes.has(type) ? 'active' : ''}" data-kg-type="${type}">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${TYPE_COLORS[type]};margin-right:5px;"></span>
        ${label}
      </button>
    `
    )
    .join('');

  wrap.querySelectorAll('[data-kg-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.kgType;
      if (activeTypes.has(t)) activeTypes.delete(t);
      else activeTypes.add(t);
      if (activeTypes.size === 0) activeTypes.add('experiment');
      renderTypeFilters();
      rebuildLayout();
    });
  });
}

function rebuildLayout() {
  if (!rawGraph) return;
  resizeCanvas();

  const w = canvas.clientWidth || 800;
  const h = canvas.clientHeight || 560;
  const cx = w / 2;
  const cy = h / 2;

  const filteredNodes = rawGraph.nodes.filter((n) => activeTypes.has(n.type));
  // Cap large node sets smoothly so canvas stays snappy & legible
  const capped = filteredNodes.slice(0, 120);
  const idSet = new Set(capped.map((n) => n.id));
  const edges = rawGraph.edges.filter((e) => idSet.has(e.source) && idSet.has(e.target));

  // Initial radial placement by node type
  const rings = {
    experiment: 95,
    paper: 175,
    material: 245,
    guideline: 300,
    finding: 345,
    safety_implication: 380,
  };
  const byType = {};
  for (const n of capped) {
    (byType[n.type] ||= []).push(n);
  }

  simNodes = capped.map((n) => {
    const group = byType[n.type];
    const idx = group.indexOf(n);
    const angle = (idx / Math.max(1, group.length)) * Math.PI * 2 + (n.type.length * 0.4);
    const r = (rings[n.type] || 220) * (0.88 + ((idx % 3) * 0.08));
    return {
      ...n,
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
      vx: 0,
      vy: 0,
      radius: n.type === 'experiment' ? 11 : n.type === 'paper' ? 9 : n.type === 'material' ? 8 : 6.5,
    };
  });

  const nodeMap = new Map(simNodes.map((n) => [n.id, n]));
  simEdges = edges
    .map((e) => ({ source: nodeMap.get(e.source), target: nodeMap.get(e.target), relation: e.relation }))
    .filter((e) => e.source && e.target);

  // Run fast deterministic force relaxation (85 ticks)
  for (let iter = 0; iter < 85; iter++) {
    for (let i = 0; i < simNodes.length; i++) {
      const a = simNodes[i];
      for (let j = i + 1; j < simNodes.length; j++) {
        const b = simNodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const d2 = dx * dx + dy * dy + 1;
        const f = 1400 / d2;
        const d = Math.sqrt(d2);
        dx /= d;
        dy /= d;
        a.vx -= dx * f;
        a.vy -= dy * f;
        b.vx += dx * f;
        b.vy += dy * f;
      }
    }
    for (const e of simEdges) {
      const dx = e.target.x - e.source.x;
      const dy = e.target.y - e.source.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const diff = (d - 95) * 0.018;
      const fx = (dx / d) * diff;
      const fy = (dy / d) * diff;
      e.source.vx += fx;
      e.source.vy += fy;
      e.target.vx -= fx;
      e.target.vy -= fy;
    }
    for (const n of simNodes) {
      n.vx += (cx - n.x) * 0.004;
      n.vy += (cy - n.y) * 0.004;
      n.vx *= 0.78;
      n.vy *= 0.78;
      n.x += n.vx;
      n.y += n.vy;
    }
  }

  zoom = 0.88;
  panX = 0;
  panY = 0;
  initialized = true;
  drawGraph();
}

function resizeCanvas() {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
}

function screenToWorld(sx, sy) {
  const rect = canvas.getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  return {
    x: (sx - cx - panX) / zoom + cx,
    y: (sy - cy - panY) / zoom + cy,
  };
}

function findNodeAt(wx, wy) {
  for (let i = simNodes.length - 1; i >= 0; i--) {
    const n = simNodes[i];
    const dx = wx - n.x;
    const dy = wy - n.y;
    if (dx * dx + dy * dy <= (n.radius + 6) * (n.radius + 6)) return n;
  }
  return null;
}

function bindGraphEvents() {
  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const w = screenToWorld(sx, sy);
    const hit = findNodeAt(w.x, w.y);
    lastMouse = { x: sx, y: sy };
    if (hit) {
      dragNode = hit;
      selectNode(hit);
    } else {
      isPanning = true;
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragNode && !isPanning) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    if (dragNode) {
      const w = screenToWorld(sx, sy);
      dragNode.x = w.x;
      dragNode.y = w.y;
      drawGraph();
    } else if (isPanning) {
      panX += sx - lastMouse.x;
      panY += sy - lastMouse.y;
      lastMouse = { x: sx, y: sy };
      drawGraph();
    }
  });

  window.addEventListener('mouseup', () => {
    dragNode = null;
    isPanning = false;
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      zoom = Math.max(0.35, Math.min(2.8, zoom * factor));
      drawGraph();
    },
    { passive: false }
  );

  document.getElementById('kg-zoom-in')?.addEventListener('click', () => {
    zoom = Math.min(2.8, zoom * 1.2);
    drawGraph();
  });
  document.getElementById('kg-zoom-out')?.addEventListener('click', () => {
    zoom = Math.max(0.35, zoom / 1.2);
    drawGraph();
  });
  document.getElementById('kg-reset')?.addEventListener('click', () => {
    zoom = 0.88;
    panX = 0;
    panY = 0;
    selectedNode = null;
    drawGraph();
  });

  document.getElementById('kg-search-input')?.addEventListener('input', (e) => {
    searchNeedle = e.target.value.trim().toLowerCase();
    if (searchNeedle) {
      const match = simNodes.find((n) => (n.label || n.id).toLowerCase().includes(searchNeedle));
      if (match) selectNode(match);
    }
    drawGraph();
  });

  window.addEventListener('resize', () => {
    if (state.activeTab === 'graph' && initialized) {
      resizeCanvas();
      drawGraph();
    }
  });
}

function drawGraph() {
  if (!ctx || !canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  const isLight = state.theme === 'light';

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.fillStyle = isLight ? '#f8fafc' : '#090f1d';
  ctx.fillRect(0, 0, w, h);

  ctx.translate(w / 2 + panX, h / 2 + panY);
  ctx.scale(zoom, zoom);
  ctx.translate(-w / 2, -h / 2);

  // Neighbor highlight set
  const connected = new Set();
  if (selectedNode) {
    connected.add(selectedNode.id);
    for (const e of simEdges) {
      if (e.source.id === selectedNode.id) connected.add(e.target.id);
      if (e.target.id === selectedNode.id) connected.add(e.source.id);
    }
  }

  // Edges
  for (const e of simEdges) {
    const active = !selectedNode || (e.source.id === selectedNode.id || e.target.id === selectedNode.id);
    ctx.strokeStyle = active
      ? (isLight ? 'rgba(15, 23, 42, 0.28)' : 'rgba(148, 163, 184, 0.34)')
      : (isLight ? 'rgba(15, 23, 42, 0.05)' : 'rgba(148, 163, 184, 0.06)');
    ctx.lineWidth = active && selectedNode ? 1.6 : 1;
    ctx.beginPath();
    ctx.moveTo(e.source.x, e.source.y);
    ctx.lineTo(e.target.x, e.target.y);
    ctx.stroke();
  }

  // Nodes
  for (const n of simNodes) {
    const col = TYPE_COLORS[n.type] || '#94a3b8';
    const isMatch = searchNeedle && (n.label || n.id).toLowerCase().includes(searchNeedle);
    const dim = selectedNode && !connected.has(n.id);

    ctx.globalAlpha = dim ? 0.2 : 1.0;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.radius + (isMatch ? 3 : 0), 0, Math.PI * 2);
    ctx.fill();

    if (selectedNode?.id === n.id || isMatch) {
      ctx.strokeStyle = isLight ? '#0f172a' : '#ffffff';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    if (n.type === 'experiment' || n.type === 'paper' || selectedNode?.id === n.id || isMatch || zoom > 1.25) {
      ctx.font = `${n.type === 'experiment' ? '600 ' : ''}10.5px Inter, sans-serif`;
      ctx.fillStyle = isLight ? '#0f172a' : '#e2e8f0';
      ctx.textAlign = 'center';
      const label = (n.label || n.id).slice(0, 26);
      ctx.fillText(label, n.x, n.y - n.radius - 5);
    }
  }

  ctx.globalAlpha = 1.0;
  ctx.restore();
}

async function selectNode(node) {
  selectedNode = node;
  drawGraph();
  const panel = document.getElementById('kg-inspector');
  if (!panel) return;
  try {
    const detail = await api.graphNode(node.id);
    const outgoing = detail.outgoing || [];
    const incoming = detail.incoming || [];

    panel.innerHTML = `
      <div class="flex items-center gap-2 mb-3">
        <span class="badge" style="background:${TYPE_COLORS[node.type]}22;color:${TYPE_COLORS[node.type]};border-color:${TYPE_COLORS[node.type]}55;">
          ${esc(TYPE_LABELS[node.type] || node.type)}
        </span>
      </div>
      <h3 style="font-family:var(--font-display);font-size:17px;margin:0 0 8px;">${esc(node.label || node.id)}</h3>
      <div class="flex gap-2 flex-wrap mb-3">
        <button type="button" class="btn btn-primary btn-sm" id="kg-ask-node-btn">Ask FlameAI</button>
        ${node.type === 'paper' ? `<button type="button" class="btn btn-cyan btn-sm" data-doc-id="${esc(node.id)}" data-doc-page="1">Open NASA Paper</button>` : ''}
      </div>

      <div style="font-size:12px;">
        <div class="mono text-muted mb-3">OUTGOING LINKS (${outgoing.length})</div>
        ${
          outgoing.length
            ? outgoing
                .slice(0, 14)
                .map(
                  (o) =>
                    `<div style="padding:6px 8px;background:var(--bg-surface-2);border-radius:7px;margin-bottom:5px;">
                      <span class="mono" style="color:var(--accent-cyan);font-size:10.5px;">${esc(o.relation)}</span>
                      → <strong>${esc(o.target)}</strong>
                    </div>`
                )
                .join('')
            : '<div class="text-muted mb-3">None</div>'
        }

        <div class="mono text-muted mt-3 mb-3">INCOMING LINKS (${incoming.length})</div>
        ${
          incoming.length
            ? incoming
                .slice(0, 14)
                .map(
                  (i) =>
                    `<div style="padding:6px 8px;background:var(--bg-surface-2);border-radius:7px;margin-bottom:5px;">
                      <strong>${esc(i.source)}</strong>
                      → <span class="mono" style="color:var(--accent-flame);font-size:10.5px;">${esc(i.relation)}</span>
                    </div>`
                )
                .join('')
            : '<div class="text-muted">None</div>'
        }
      </div>
    `;

    panel.querySelector('#kg-ask-node-btn')?.addEventListener('click', () => {
      emit('chat:ask', `Explain how "${node.label || node.id}" connects to NASA microgravity fire safety experiments, material flammability, and spacecraft design guidelines.`);
    });
  } catch (err) {
    panel.innerHTML = `<div class="text-muted">Could not inspect node: ${esc(err.message)}</div>`;
  }
}
