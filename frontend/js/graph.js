/**
 * NASA Fire-Safety Knowledge Graph — Infinite Blueprint Workspace
 *
 * Floating interactive Blueprint node widgets on a truly infinite, smoothly
 * zoomable & pannable dot-grid workspace with:
 *   - Pointer-centered wheel & pinch zoom (22% – 225%) + Fit All + Reset
 *   - Drag-to-move floating cards with 10px grid snap and zero artificial walls
 *   - Animated pulsing cubic Bezier edges + port-to-port drag wiring (cycle-safe)
 *   - Full 227-node NASA Connection Stack sidebar + 1-click Expand Neighbors
 *   - Inline widget editor, custom steps, undo stack, JSON export & FlameAI bridge
 */

import { api } from './api.js';
import { emit, esc, on, state } from './state.js';

const TYPE_META = {
  experiment: {
    label: 'Experiments',
    singular: 'Experiment',
    color: '#ff5e3a',
    glyph: 'M13 3 5 13h5l-1 8 9-12h-5z',
  },
  material: {
    label: 'Materials',
    singular: 'Material',
    color: '#0284c7',
    glyph: 'M12 2 2 7l10 5 10-5-10-5z M2 17l10 5 10-5 M2 12l10 5 10-5',
  },
  paper: {
    label: 'NASA Papers',
    singular: 'NASA Paper',
    color: '#d97706',
    glyph: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20 M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
  },
  guideline: {
    label: 'Guidelines',
    singular: 'Guideline',
    color: '#15803d',
    glyph: 'M12 3 4 7v5c0 5 3.4 8.2 8 9 4.6-.8 8-4 8-9V7z M9 12l2 2 4-5',
  },
  finding: {
    label: 'Key Findings',
    singular: 'Key Finding',
    color: '#0f766e',
    glyph: 'M12 3l2.2 5.5L20 10l-5.8 1.5L12 17l-2.2-5.5L4 10l5.8-1.5z',
  },
  safety_implication: {
    label: 'Safety Impacts',
    singular: 'Safety Impact',
    color: '#dc2626',
    glyph: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z M12 9v4 M12 17h.01',
  },
  custom: {
    label: 'Custom Steps',
    singular: 'Custom Step',
    color: '#ff5e3a',
    glyph: 'M12 5v14 M5 12h14',
  },
};

const NODE_WIDTH = 224;
const DEFAULT_NODE_HEIGHT = 152;
const SNAP = 10;
const MIN_ZOOM = 0.22;
const MAX_ZOOM = 2.25;

let rawGraph = null;
let rawNodeMap = new Map();
let rawAdj = new Map(); // id -> Array<{ neighborId, relationship, direction }>

// Live placed workspace graph
let nodes = []; // Array<{ id, kind, label, detail, tag, x, y, docId?, nasaId? }>
let edges = []; // Array<{ id, source, target, relationship }>
let history = [];
let selectedId = '';
let editingId = null;
let activeTypes = new Set(['experiment', 'material', 'paper', 'guideline', 'finding', 'safety_implication']);
let searchQuery = '';
let motionPaused = false;
let seq = 0;

// Infinite viewport transform state
const viewport = { x: 40, y: 40, zoom: 0.9 };
let initialFitDone = false;

// Interaction state
let panState = null;
let dragState = null;
let connectState = null;
const activePointers = new Map();
let pinchState = null;

// Cached DOM references
let rootEl = null;
let canvasEl = null;
let viewportEl = null;
let edgesLayerEl = null;
let draftEdgeEl = null;
let nodesLayerEl = null;
const nodeElMap = new Map();
const edgeElMap = new Map();

const getRawType = (n) => n?.node_type ?? n?.type ?? 'finding';
const getRawEdgeRel = (e) => e?.relationship ?? e?.relation ?? 'related';
const snap = (v) => Math.round(v / SNAP) * SNAP;

function extractNodeFields(raw) {
  const kind = getRawType(raw);
  const deg = raw.degree ? `${raw.degree} links` : '';
  if (kind === 'experiment') {
    return {
      kind,
      label: String(raw.id || raw.full_name || 'NASA Experiment'),
      detail: String(raw.description || raw.full_name || `${raw.category || 'Combustion'} investigation on ${raw.platform || 'ISS'}.`).slice(0, 150),
      tag: [raw.platform, raw.years].filter(Boolean).join(' · ') || raw.category || deg,
      docId: null,
    };
  }
  if (kind === 'material') {
    const bits = [];
    if (raw.extinction_o2_threshold != null) bits.push(`LOI ${raw.extinction_o2_threshold}%`);
    if (raw.flammability_rating != null) bits.push(`Flamm ${raw.flammability_rating}/10`);
    if (raw.smoke_production) bits.push(`Smoke: ${raw.smoke_production}`);
    return {
      kind,
      label: String(raw.display_name || raw.id || 'Material'),
      detail: bits.join(' · ') || String(raw.category || 'Spacecraft habitat material'),
      tag: raw.category || deg || 'Material',
      docId: null,
    };
  }
  if (kind === 'paper') {
    const docId = String(raw.doc_id || raw.id || '').split(':')[0].trim();
    return {
      kind,
      label: String(raw.title || raw.id || docId).slice(0, 68),
      detail: `Peer-reviewed NASA research document (${docId}). Click to inspect pages and citations.`,
      tag: docId || 'NASA Paper',
      docId,
    };
  }
  if (kind === 'guideline') {
    return {
      kind,
      label: String(raw.title || raw.category || raw.id || 'Safety Guideline').slice(0, 64),
      detail: String(raw.recommendation || raw.description || 'NASA spacecraft fire safety directive.').slice(0, 150),
      tag: [raw.environment, raw.risk_level].filter(Boolean).join(' · ') || 'Guideline',
      docId: null,
    };
  }
  const text = String(raw.full_text || raw.description || raw.id || '');
  const shortTitle = text.length > 48 ? `${text.slice(0, 46).trim()}…` : text;
  return {
    kind,
    label: shortTitle || String(raw.id),
    detail: text.slice(0, 155),
    tag: deg || TYPE_META[kind]?.singular || kind,
    docId: null,
  };
}

function setMessage(text) {
  const el = document.getElementById('wb-message');
  if (el) el.textContent = text;
}

function pushHistory() {
  history.push({
    nodes: nodes.map((n) => ({ ...n })),
    edges: edges.map((e) => ({ ...e })),
  });
  if (history.length > 25) history.shift();
  const undoBtn = document.getElementById('wb-undo-btn');
  if (undoBtn) undoBtn.disabled = history.length === 0;
}

function canConnect(source, target) {
  if (!source || !target || source === target) return false;
  if (!nodes.some((n) => n.id === source) || !nodes.some((n) => n.id === target)) return false;
  if (edges.some((e) => e.source === source && e.target === target)) return false;
  const visited = new Set();
  const reachesSource = (id) => {
    if (id === source) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    return edges.filter((e) => e.source === id).some((e) => reachesSource(e.target));
  };
  return !reachesSource(target);
}

/* ------------------------------------------------------------------ *
 * Infinite Viewport Transform & Dot Grid Synchronization
 * ------------------------------------------------------------------ */
function applyViewport() {
  if (!viewportEl || !canvasEl) return;
  viewportEl.style.transform = `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.zoom})`;

  const gridStep = Math.max(8, 22 * viewport.zoom);
  canvasEl.style.backgroundSize = `${gridStep}px ${gridStep}px, 100% 100%`;
  canvasEl.style.backgroundPosition = `${viewport.x}px ${viewport.y}px, 0 0`;

  const zoomBtn = document.getElementById('wb-zoom-readout');
  if (zoomBtn) zoomBtn.textContent = `${Math.round(viewport.zoom * 100)}%`;

  const coordsEl = document.getElementById('wb-status-coords');
  if (coordsEl) {
    coordsEl.textContent = `Pan (${Math.round(viewport.x)}, ${Math.round(viewport.y)}) · Zoom ${Math.round(viewport.zoom * 100)}%`;
  }
}

function screenToWorld(clientX, clientY) {
  const rect = canvasEl.getBoundingClientRect();
  return {
    x: (clientX - rect.left - viewport.x) / viewport.zoom,
    y: (clientY - rect.top - viewport.y) / viewport.zoom,
  };
}

function zoomAtClientPoint(newZoom, clientX, clientY) {
  if (!canvasEl) return;
  const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
  const rect = canvasEl.getBoundingClientRect();
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const wx = (px - viewport.x) / viewport.zoom;
  const wy = (py - viewport.y) / viewport.zoom;
  viewport.zoom = clamped;
  viewport.x = px - wx * clamped;
  viewport.y = py - wy * clamped;
  applyViewport();
}

function zoomByFactor(factor) {
  if (!canvasEl) return;
  const rect = canvasEl.getBoundingClientRect();
  zoomAtClientPoint(viewport.zoom * factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
}

function getNodeBox(node) {
  const el = nodeElMap.get(node.id);
  const w = el?.offsetWidth || NODE_WIDTH;
  const h = el?.offsetHeight || DEFAULT_NODE_HEIGHT;
  return { x: node.x, y: node.y, w, h };
}

function fitView(padding = 58) {
  if (!canvasEl || !nodes.length) return;
  const rect = canvasEl.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const b = getNodeBox(n);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const z = Math.max(
    MIN_ZOOM,
    Math.min(1.02, Math.min((rect.width - padding * 2) / bw, (rect.height - padding * 2) / bh))
  );
  viewport.zoom = z;
  viewport.x = (rect.width - bw * z) / 2 - minX * z;
  viewport.y = (rect.height - bh * z) / 2 - minY * z;
  applyViewport();
  initialFitDone = true;
}

function centerOnNode(node) {
  if (!canvasEl || !node) return;
  const rect = canvasEl.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const b = getNodeBox(node);
  const targetZoom = Math.max(viewport.zoom, 0.85);
  viewport.zoom = Math.min(1.15, targetZoom);
  viewport.x = rect.width / 2 - (b.x + b.w / 2) * viewport.zoom;
  viewport.y = rect.height / 2 - (b.y + b.h / 2) * viewport.zoom;
  applyViewport();
}

/* ------------------------------------------------------------------ *
 * Starter Blueprint & Layered Auto-Arrange
 * ------------------------------------------------------------------ */
function buildStarterBlueprint() {
  if (!rawGraph) return;
  const all = rawGraph.nodes || [];
  const pickedIds = [];
  const pickedSet = new Set();

  const tryPick = (predicate, limit = 1) => {
    let added = 0;
    for (const n of all) {
      if (added >= limit) break;
      if (!pickedSet.has(n.id) && predicate(n)) {
        pickedSet.add(n.id);
        pickedIds.push(n.id);
        added++;
      }
    }
  };

  // Pick a balanced cross-section of flagship NASA missions, materials, papers, and guidelines
  for (const preferred of ['BASS', 'BASS-II', 'SAFFIRE', 'FLEX-2']) {
    tryPick((n) => getRawType(n) === 'experiment' && String(n.id).toUpperCase() === preferred.toUpperCase(), 1);
  }
  tryPick((n) => getRawType(n) === 'experiment', 3 - Math.min(3, pickedIds.length));

  for (const preferred of ['PMMA', 'Nomex', 'Cotton-Fiberglass']) {
    tryPick((n) => getRawType(n) === 'material' && String(n.id).toLowerCase().includes(preferred.toLowerCase()), 1);
  }
  tryPick((n) => getRawType(n) === 'paper' && String(n.doc_id || '').toUpperCase() === 'DOC-01', 1);
  tryPick((n) => getRawType(n) === 'paper' && String(n.doc_id || '').toUpperCase() === 'DOC-02', 1);
  tryPick((n) => getRawType(n) === 'paper' && String(n.doc_id || '').toUpperCase() === 'DOC-03', 1);
  tryPick((n) => getRawType(n) === 'guideline', 2);

  nodes = pickedIds.map((id) => {
    const raw = rawNodeMap.get(id);
    const fields = extractNodeFields(raw);
    return { id, nasaId: id, ...fields, x: 0, y: 0 };
  });

  // Wire all real NASA Knowledge Graph edges connecting the starter nodes (avoiding cycles)
  edges = [];
  for (const e of rawGraph.edges || []) {
    if (pickedSet.has(e.source) && pickedSet.has(e.target) && canConnect(e.source, e.target)) {
      edges.push({
        id: `wb-e-${++seq}`,
        source: e.source,
        target: e.target,
        relationship: getRawEdgeRel(e),
      });
    }
  }

  autoArrangeNodes(false);
  selectedId = nodes[0]?.id || '';
  editingId = null;
  history = [];
  renderAll();
  if (selectedId) inspectNode(selectedId);
  requestAnimationFrame(() => {
    renderEdges();
    fitView();
  });
}

function autoArrangeNodes(saveUndo = true) {
  if (!nodes.length) return;
  if (saveUndo) pushHistory();

  // Order columns logically by domain tier so NASA relationships flow left -> right
  const tierOrder = {
    experiment: 0,
    custom: 0,
    material: 1,
    finding: 2,
    safety_implication: 2,
    paper: 2,
    guideline: 3,
  };

  const buckets = new Map();
  for (const n of nodes) {
    const col = tierOrder[n.kind] ?? 2;
    if (!buckets.has(col)) buckets.set(col, []);
    buckets.get(col).push(n);
  }

  const colKeys = [...buckets.keys()].sort((a, b) => a - b);
  const colSpacing = 310;
  const rowSpacing = 200;

  colKeys.forEach((colKey, colIdx) => {
    const group = buckets.get(colKey);
    const totalH = (group.length - 1) * rowSpacing;
    group.forEach((node, rowIdx) => {
      node.x = snap(colIdx * colSpacing);
      node.y = snap(rowIdx * rowSpacing - totalH / 2);
    });
  });

  if (saveUndo) {
    renderAll();
    requestAnimationFrame(() => {
      renderEdges();
      fitView();
    });
    setMessage('Workspace neatly arranged across domain columns.');
  }
}

/* ------------------------------------------------------------------ *
 * Placing, Expanding, Editing, Connecting & Removing Floating Widgets
 * ------------------------------------------------------------------ */
function findFreePosition(baseX, baseY) {
  let x = snap(baseX);
  let y = snap(baseY);
  let guard = 0;
  while (
    guard < 40 &&
    nodes.some((n) => Math.abs(n.x - x) < 236 && Math.abs(n.y - y) < 174)
  ) {
    y = snap(y + 188);
    if (guard > 0 && guard % 5 === 0) {
      x = snap(x + 260);
      y = snap(baseY);
    }
    guard++;
  }
  return { x, y };
}

function placeNasaNode(nasaId, { focus = true, connectToSelected = false } = {}) {
  const existing = nodes.find((n) => n.id === nasaId);
  if (existing) {
    selectedId = existing.id;
    editingId = null;
    renderSelectionState();
    inspectNode(existing.id);
    if (focus) centerOnNode(existing);
    setMessage(`Focused "${existing.label}" on the workspace.`);
    return existing;
  }

  const raw = rawNodeMap.get(nasaId);
  if (!raw) return null;

  pushHistory();
  const anchor = nodes.find((n) => n.id === selectedId);
  const pos = anchor
    ? findFreePosition(anchor.x + 300, anchor.y)
    : findFreePosition(-viewport.x / viewport.zoom + 120, -viewport.y / viewport.zoom + 120);

  const fields = extractNodeFields(raw);
  const newNode = { id: nasaId, nasaId, ...fields, x: pos.x, y: pos.y };
  nodes.push(newNode);

  // Automatically wire any real NASA Knowledge Graph edges touching nodes already on canvas
  const placedSet = new Set(nodes.map((n) => n.id));
  let linkedCount = 0;
  for (const e of rawGraph?.edges || []) {
    if (
      (e.source === nasaId && placedSet.has(e.target)) ||
      (e.target === nasaId && placedSet.has(e.source))
    ) {
      if (canConnect(e.source, e.target)) {
        edges.push({
          id: `wb-e-${++seq}`,
          source: e.source,
          target: e.target,
          relationship: getRawEdgeRel(e),
        });
        linkedCount++;
      }
    }
  }

  if (connectToSelected && anchor && linkedCount === 0 && canConnect(anchor.id, newNode.id)) {
    edges.push({
      id: `wb-e-${++seq}`,
      source: anchor.id,
      target: newNode.id,
      relationship: 'linked_to',
    });
    linkedCount++;
  }

  selectedId = newNode.id;
  editingId = null;
  renderAll();
  inspectNode(newNode.id);
  requestAnimationFrame(() => {
    renderEdges();
    if (focus) centerOnNode(newNode);
  });
  setMessage(
    `Placed "${newNode.label}"${linkedCount ? ` with ${linkedCount} live NASA connection${linkedCount > 1 ? 's' : ''}` : ''}.`
  );
  return newNode;
}

function expandNodeNeighbors(nodeId, limit = 5) {
  const anchor = nodes.find((n) => n.id === nodeId);
  if (!anchor) return;
  const rels = rawAdj.get(nodeId) || [];
  const placedSet = new Set(nodes.map((n) => n.id));
  const candidates = rels
    .filter((r) => !placedSet.has(r.neighborId) && rawNodeMap.has(r.neighborId))
    .slice(0, limit);

  if (!candidates.length) {
    setMessage(`All direct NASA neighbors of "${anchor.label}" are already on the workspace.`);
    return;
  }

  pushHistory();
  const baseOffset = -((candidates.length - 1) * 190) / 2;
  candidates.forEach((rel, idx) => {
    const raw = rawNodeMap.get(rel.neighborId);
    const fields = extractNodeFields(raw);
    const dirX = rel.direction === 'in' ? -300 : 300;
    const pos = findFreePosition(anchor.x + dirX, anchor.y + baseOffset + idx * 190);
    nodes.push({ id: rel.neighborId, nasaId: rel.neighborId, ...fields, x: pos.x, y: pos.y });
    placedSet.add(rel.neighborId);
  });

  // Wire all real NASA edges among the expanded set
  for (const e of rawGraph?.edges || []) {
    if (placedSet.has(e.source) && placedSet.has(e.target) && canConnect(e.source, e.target)) {
      edges.push({
        id: `wb-e-${++seq}`,
        source: e.source,
        target: e.target,
        relationship: getRawEdgeRel(e),
      });
    }
  }

  renderAll();
  requestAnimationFrame(() => {
    renderEdges();
    fitView();
  });
  setMessage(`Expanded ${candidates.length} connected NASA node${candidates.length > 1 ? 's' : ''} around "${anchor.label}".`);
}

function addCustomStep() {
  pushHistory();
  const anchor = nodes.find((n) => n.id === selectedId);
  const pos = anchor
    ? findFreePosition(anchor.x + 290, anchor.y)
    : findFreePosition(-viewport.x / viewport.zoom + 120, -viewport.y / viewport.zoom + 120);
  const id = `custom-step-${++seq}`;
  const newNode = {
    id,
    nasaId: null,
    kind: 'custom',
    label: 'New safety hypothesis',
    detail: 'Describe a habitat fire-safety step, test condition, or engineering check.',
    tag: 'Custom',
    docId: null,
    x: pos.x,
    y: pos.y,
  };
  nodes.push(newNode);
  if (anchor && canConnect(anchor.id, id)) {
    edges.push({ id: `wb-e-${++seq}`, source: anchor.id, target: id, relationship: 'leads_to' });
  }
  selectedId = id;
  editingId = id;
  renderAll();
  openEditForm(newNode);
  requestAnimationFrame(() => {
    renderEdges();
    centerOnNode(newNode);
  });
  setMessage('Added custom blueprint widget — edit its title and details below.');
}

function removeSelectedNode() {
  const target = nodes.find((n) => n.id === selectedId);
  if (!target) return;
  pushHistory();

  const incoming = edges.filter((e) => e.target === selectedId);
  const outgoing = edges.filter((e) => e.source === selectedId);
  nodes = nodes.filter((n) => n.id !== selectedId);
  edges = edges.filter((e) => e.source !== selectedId && e.target !== selectedId);

  let bridged = false;
  if (incoming.length === 1 && outgoing.length === 1 && canConnect(incoming[0].source, outgoing[0].target)) {
    edges.push({
      id: `wb-e-${++seq}`,
      source: incoming[0].source,
      target: outgoing[0].target,
      relationship: outgoing[0].relationship || 'connected',
    });
    bridged = true;
  }

  selectedId = '';
  editingId = null;
  closeEditForm();
  renderAll();
  setMessage(
    bridged
      ? `Removed "${target.label}" and reconnected its surrounding nodes.`
      : `Removed "${target.label}" from the workspace.`
  );
}

function addConnection(source, target, relationship = 'linked_to') {
  if (!canConnect(source, target)) {
    setMessage('Choose two different nodes without an existing link or a cycle.');
    return false;
  }
  pushHistory();
  edges.push({ id: `wb-e-${++seq}`, source, target, relationship });
  renderAll();
  const sLabel = nodes.find((n) => n.id === source)?.label || source;
  const tLabel = nodes.find((n) => n.id === target)?.label || target;
  setMessage(`Connected "${sLabel}" → "${tLabel}".`);
  return true;
}

function removeEdge(edgeId) {
  pushHistory();
  edges = edges.filter((e) => e.id !== edgeId);
  renderAll();
  setMessage('Connection removed.');
}

function undoLast() {
  const prev = history.pop();
  if (!prev) return;
  nodes = prev.nodes;
  edges = prev.edges;
  if (!nodes.some((n) => n.id === selectedId)) selectedId = nodes[0]?.id || '';
  editingId = null;
  closeEditForm();
  renderAll();
  if (selectedId) inspectNode(selectedId);
  setMessage('Undid last workspace edit.');
}

function exportBlueprintJson() {
  const payload = {
    title: 'Ignis — NASA Fire-Safety Knowledge Blueprint',
    exported_at: new Date().toISOString(),
    viewport: { ...viewport },
    nodes: nodes.map(({ id, kind, label, detail, tag, x, y, docId }) => ({
      id,
      kind,
      label,
      detail,
      tag,
      position: { x, y },
      doc_id: docId || null,
    })),
    edges: edges.map(({ id, source, target, relationship }) => ({
      id,
      source,
      target,
      relationship,
    })),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'nasa-knowledge-blueprint.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setMessage('Exported workspace blueprint as nasa-knowledge-blueprint.json.');
}

/* ------------------------------------------------------------------ *
 * Rendering: Floating Node Cards, Pulsing Bezier Edges, Stack & Controls
 * ------------------------------------------------------------------ */
function computeBezierPath(sx, sy, tx, ty) {
  const dx = Math.abs(tx - sx);
  const c = Math.max(58, Math.min(220, dx * 0.48));
  return {
    d: `M ${sx} ${sy} C ${sx + c} ${sy}, ${tx - c} ${ty}, ${tx} ${ty}`,
    mx: (sx + tx) / 2,
    my: (sy + ty) / 2,
  };
}

function getEdgeEndpoints(edge) {
  const src = nodes.find((n) => n.id === edge.source);
  const tgt = nodes.find((n) => n.id === edge.target);
  if (!src || !tgt) return null;
  const sb = getNodeBox(src);
  const tb = getNodeBox(tgt);
  return {
    sx: sb.x + sb.w,
    sy: sb.y + sb.h / 2,
    tx: tb.x,
    ty: tb.y + tb.h / 2,
  };
}

function updateSingleEdgeSvg(edge) {
  const g = edgeElMap.get(edge.id);
  if (!g) return;
  const pts = getEdgeEndpoints(edge);
  if (!pts) return;
  const { d, mx, my } = computeBezierPath(pts.sx, pts.sy, pts.tx, pts.ty);
  g.querySelector('.wb-edge-halo')?.setAttribute('d', d);
  g.querySelector('.wb-edge')?.setAttribute('d', d);
  g.querySelector('.wb-edge-pulse')?.setAttribute('d', d);
  const ports = g.querySelectorAll('.wb-port');
  if (ports[0]) {
    ports[0].setAttribute('cx', String(pts.sx));
    ports[0].setAttribute('cy', String(pts.sy));
  }
  if (ports[1]) {
    ports[1].setAttribute('cx', String(pts.tx));
    ports[1].setAttribute('cy', String(pts.ty));
  }
  const labelG = g.querySelector('.wb-edge-label');
  if (labelG) {
    labelG.setAttribute('transform', `translate(${mx}, ${my})`);
  }
}

function renderEdges() {
  if (!edgesLayerEl) return;
  edgesLayerEl.innerHTML = '';
  edgeElMap.clear();

  const svgNS = 'http://www.w3.org/2000/svg';
  for (const edge of edges) {
    const pts = getEdgeEndpoints(edge);
    if (!pts) continue;
    const { d, mx, my } = computeBezierPath(pts.sx, pts.sy, pts.tx, pts.ty);
    const touchesSelected = selectedId && (edge.source === selectedId || edge.target === selectedId);
    const dimmed = Boolean(selectedId && !touchesSelected);

    const g = document.createElementNS(svgNS, 'g');
    g.setAttribute(
      'class',
      `wb-edge-group${touchesSelected ? ' is-highlighted' : ''}${dimmed ? ' is-dimmed' : ''}`
    );
    g.dataset.edgeId = edge.id;

    const halo = document.createElementNS(svgNS, 'path');
    halo.setAttribute('class', 'wb-edge-halo');
    halo.setAttribute('d', d);

    const main = document.createElementNS(svgNS, 'path');
    main.setAttribute('class', 'wb-edge');
    main.setAttribute('d', d);

    const pulse = document.createElementNS(svgNS, 'path');
    pulse.setAttribute('class', 'wb-edge-pulse');
    pulse.setAttribute('d', d);

    const p1 = document.createElementNS(svgNS, 'circle');
    p1.setAttribute('class', 'wb-port');
    p1.setAttribute('cx', String(pts.sx));
    p1.setAttribute('cy', String(pts.sy));
    p1.setAttribute('r', '4');

    const p2 = document.createElementNS(svgNS, 'circle');
    p2.setAttribute('class', 'wb-port');
    p2.setAttribute('cx', String(pts.tx));
    p2.setAttribute('cy', String(pts.ty));
    p2.setAttribute('r', '4');

    g.append(halo, main, pulse, p1, p2);

    if (touchesSelected && edge.relationship) {
      const relText = String(edge.relationship).replace(/_/g, ' ');
      const boxW = Math.max(58, relText.length * 6.2 + 16);
      const labelG = document.createElementNS(svgNS, 'g');
      labelG.setAttribute('class', 'wb-edge-label');
      labelG.setAttribute('transform', `translate(${mx}, ${my})`);

      const rect = document.createElementNS(svgNS, 'rect');
      rect.setAttribute('class', 'wb-edge-label-bg');
      rect.setAttribute('x', String(-boxW / 2));
      rect.setAttribute('y', '-10');
      rect.setAttribute('width', String(boxW));
      rect.setAttribute('height', '20');
      rect.setAttribute('rx', '10');

      const txt = document.createElementNS(svgNS, 'text');
      txt.setAttribute('class', 'wb-edge-label-text');
      txt.textContent = relText;

      labelG.append(rect, txt);
      g.appendChild(labelG);
    }

    edgesLayerEl.appendChild(g);
    edgeElMap.set(edge.id, g);
  }
}

function renderNodes() {
  if (!nodesLayerEl) return;
  nodesLayerEl.innerHTML = '';
  nodeElMap.clear();

  const connectedToSelected = new Set();
  if (selectedId) {
    connectedToSelected.add(selectedId);
    for (const e of edges) {
      if (e.source === selectedId) connectedToSelected.add(e.target);
      if (e.target === selectedId) connectedToSelected.add(e.source);
    }
  }

  for (const node of nodes) {
    const meta = TYPE_META[node.kind] || TYPE_META.finding;
    const isSel = node.id === selectedId;
    const dimmed = Boolean(selectedId && !connectedToSelected.has(node.id));
    const unplacedNeighbors = (rawAdj.get(node.id) || []).filter(
      (r) => !nodes.some((n) => n.id === r.neighborId)
    ).length;

    const el = document.createElement('article');
    el.className = `wb-node${dimmed ? ' is-dimmed' : ''}`;
    el.dataset.nodeId = node.id;
    el.dataset.kind = node.kind;
    el.dataset.selected = String(isSel);
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', `${node.label}. ${meta.singular}. ${node.detail}`);
    el.style.transform = `translate3d(${node.x}px, ${node.y}px, 0)`;

    el.innerHTML = `
      <span class="wb-handle wb-handle-target" data-handle="target" data-node-id="${esc(node.id)}" title="Drop wire here to connect into ${esc(node.label)}" aria-label="Input port for ${esc(node.label)}"></span>
      <div class="wb-node-head">
        <span class="wb-glyph" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="${meta.glyph}"/></svg>
        </span>
        <div style="min-width:0;flex:1;">
          <strong>${esc(node.label)}</strong>
          <small>${esc(meta.singular)}</small>
        </div>
      </div>
      <div class="wb-node-body">
        <p>${esc(node.detail)}</p>
        <div class="wb-node-foot">
          <span class="wb-node-tag" title="${esc(node.tag || '')}">${esc(node.tag || meta.singular)}</span>
          ${
            unplacedNeighbors > 0
              ? `<button type="button" class="wb-node-expand-btn" data-expand-node="${esc(node.id)}" title="Place connected NASA nodes on canvas">+${Math.min(unplacedNeighbors, 5)} links</button>`
              : node.docId
                ? `<button type="button" class="wb-node-expand-btn" data-doc-id="${esc(node.docId)}" data-doc-page="1">Read</button>`
                : ''
          }
        </div>
      </div>
      <span class="wb-handle wb-handle-source" data-handle="source" data-node-id="${esc(node.id)}" title="Drag from this port to connect to another widget" aria-label="Output port for ${esc(node.label)}"></span>
    `;

    bindNodeElementEvents(el, node);
    nodesLayerEl.appendChild(el);
    nodeElMap.set(node.id, el);
  }

  const emptyEl = document.getElementById('wb-empty-state');
  if (emptyEl) emptyEl.style.display = nodes.length === 0 ? 'block' : 'none';
}

function renderSelectionState() {
  const connected = new Set();
  if (selectedId) {
    connected.add(selectedId);
    for (const e of edges) {
      if (e.source === selectedId) connected.add(e.target);
      if (e.target === selectedId) connected.add(e.source);
    }
  }
  for (const [id, el] of nodeElMap.entries()) {
    el.dataset.selected = String(id === selectedId);
    el.classList.toggle('is-dimmed', Boolean(selectedId && !connected.has(id)));
  }
  renderEdges();
  syncEditorControls();
}

function syncEditorControls() {
  const selEl = document.getElementById('wb-selected-select');
  const srcEl = document.getElementById('wb-connect-source');
  const tgtEl = document.getElementById('wb-connect-target');
  const expandBtn = document.getElementById('wb-expand-btn');
  const editBtn = document.getElementById('wb-edit-btn');
  const removeBtn = document.getElementById('wb-remove-btn');
  const undoBtn = document.getElementById('wb-undo-btn');
  const connectSubmit = document.getElementById('wb-connect-submit');

  const optionsHtml = nodes
    .map((n) => `<option value="${esc(n.id)}">${esc(n.label)}</option>`)
    .join('');

  if (selEl) {
    selEl.innerHTML = `<option value="">Unconnected new placement</option>${optionsHtml}`;
    selEl.value = nodes.some((n) => n.id === selectedId) ? selectedId : '';
  }
  if (srcEl) {
    const prevSrc = srcEl.value;
    srcEl.innerHTML = `<option value="">Choose source</option>${optionsHtml}`;
    srcEl.value = nodes.some((n) => n.id === prevSrc) ? prevSrc : '';
  }
  if (tgtEl) {
    const prevTgt = tgtEl.value;
    tgtEl.innerHTML = `<option value="">Choose destination</option>${optionsHtml}`;
    tgtEl.value = nodes.some((n) => n.id === prevTgt) ? prevTgt : '';
  }

  const hasSel = nodes.some((n) => n.id === selectedId);
  const selNode = nodes.find((n) => n.id === selectedId);
  if (expandBtn) expandBtn.disabled = !hasSel || !selNode?.nasaId;
  if (editBtn) editBtn.disabled = !hasSel;
  if (removeBtn) removeBtn.disabled = !hasSel;
  if (undoBtn) undoBtn.disabled = history.length === 0;
  if (connectSubmit && srcEl && tgtEl) {
    connectSubmit.disabled = !srcEl.value || !tgtEl.value;
  }

  const countsEl = document.getElementById('wb-status-counts');
  if (countsEl) {
    const totalIndexed = rawGraph?.stats?.node_count || nodes.length;
    countsEl.innerHTML = `<i aria-hidden="true"></i> ${nodes.length} widgets · ${edges.length} links · ${totalIndexed} NASA entities indexed`;
  }

  const summaryEl = document.getElementById('wb-connections-summary');
  if (summaryEl) summaryEl.textContent = `Connections (${edges.length}) and keyboard shortcuts`;

  const listEl = document.getElementById('wb-connections-list');
  if (listEl) {
    if (!edges.length) {
      listEl.innerHTML = '<li class="text-muted">No connections on canvas yet. Drag from a right port to a left port or use the form above.</li>';
    } else {
      listEl.innerHTML = edges
        .map((edge) => {
          const s = nodes.find((n) => n.id === edge.source)?.label || edge.source;
          const t = nodes.find((n) => n.id === edge.target)?.label || edge.target;
          const rel = edge.relationship ? ` (${edge.relationship.replace(/_/g, ' ')})` : '';
          return `
            <li>
              <span><strong>${esc(s)}</strong> → <strong>${esc(t)}</strong><span class="mono text-muted" style="font-size:10.5px;">${esc(rel)}</span></span>
              <button type="button" data-remove-edge="${esc(edge.id)}">Remove</button>
            </li>
          `;
        })
        .join('');
      listEl.querySelectorAll('[data-remove-edge]').forEach((btn) => {
        btn.addEventListener('click', () => removeEdge(btn.dataset.removeEdge));
      });
    }
  }
}

function renderConnectionStack() {
  const wrap = document.getElementById('wb-stack-groups');
  const totalEl = document.getElementById('wb-stack-total');
  if (!wrap || !rawGraph) return;

  const placedIds = new Set(nodes.map((n) => n.id));
  const needle = searchQuery.toLowerCase();
  const order = ['experiment', 'material', 'paper', 'guideline', 'finding', 'safety_implication'];

  let matchedTotal = 0;
  const sectionsHtml = [];

  for (const kind of order) {
    if (!activeTypes.has(kind)) continue;
    const meta = TYPE_META[kind];
    const items = (rawGraph.nodes || []).filter((n) => {
      if (getRawType(n) !== kind) return false;
      if (!needle) return true;
      const fields = extractNodeFields(n);
      const hay = `${n.id} ${fields.label} ${fields.detail} ${fields.tag}`.toLowerCase();
      return hay.includes(needle);
    });
    if (!items.length) continue;
    matchedTotal += items.length;

    const openAttr = needle || kind === 'experiment' || kind === 'material' ? ' open' : '';
    const buttonsHtml = items
      .slice(0, needle ? 40 : 28)
      .map((raw) => {
        const fields = extractNodeFields(raw);
        const isPlaced = placedIds.has(raw.id);
        return `
          <button type="button" class="${isPlaced ? 'is-placed' : ''}" data-stack-node="${esc(raw.id)}" title="${esc(fields.detail)}">
            <span>
              ${esc(fields.label)}
              <small>${esc(fields.tag || meta.singular)}</small>
            </span>
            <b aria-hidden="true">${isPlaced ? 'Focus' : '+'}</b>
          </button>
        `;
      })
      .join('');

    sectionsHtml.push(`
      <details class="wb-app"${openAttr}>
        <summary>
          <span class="wb-app-mark" style="color:${meta.color};background:${meta.color}18;border-color:${meta.color}44;" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${meta.glyph}"/></svg>
          </span>
          <strong>${esc(meta.label)}</strong>
          <small>${items.length}</small>
        </summary>
        <div class="wb-actions">${buttonsHtml}</div>
      </details>
    `);
  }

  wrap.innerHTML = sectionsHtml.length
    ? sectionsHtml.join('')
    : '<div class="text-muted" style="font-size:12px;padding:8px 2px;">No NASA nodes match this filter.</div>';

  if (totalEl) totalEl.textContent = `${matchedTotal} ready`;

  wrap.querySelectorAll('[data-stack-node]').forEach((btn) => {
    btn.addEventListener('click', () => {
      placeNasaNode(btn.dataset.stackNode, { focus: true, connectToSelected: false });
    });
  });
}

function renderAll() {
  renderNodes();
  renderEdges();
  syncEditorControls();
  renderConnectionStack();
}

/* ------------------------------------------------------------------ *
 * Node Inspector (Live /api/graph/node/{id} Details)
 * ------------------------------------------------------------------ */
async function inspectNode(nodeId) {
  const panel = document.getElementById('kg-inspector');
  const node = nodes.find((n) => n.id === nodeId);
  if (!panel || !node) return;

  const meta = TYPE_META[node.kind] || TYPE_META.custom;
  if (!node.nasaId) {
    panel.innerHTML = `
      <div class="flex items-center gap-2 mb-2">
        <span class="badge badge-flame">${esc(meta.singular)}</span>
      </div>
      <h4 style="font-family:var(--font-display);font-size:15px;margin:0 0 6px;">${esc(node.label)}</h4>
      <p class="text-sec" style="font-size:12px;margin:0 0 10px;">${esc(node.detail)}</p>
      <div class="flex gap-2 flex-wrap">
        <button type="button" class="btn btn-primary btn-sm" id="kg-ask-node-btn">Ask FlameAI</button>
      </div>
    `;
    panel.querySelector('#kg-ask-node-btn')?.addEventListener('click', () => {
      emit('chat:ask', `Evaluate this spacecraft fire-safety consideration: "${node.label} — ${node.detail}"`);
    });
    return;
  }

  try {
    const detail = await api.graphNode(node.nasaId);
    const outgoing = detail.outbound ?? detail.outgoing ?? [];
    const incoming = detail.inbound ?? detail.incoming ?? [];
    const docId = node.docId || detail.attributes?.doc_id || null;

    panel.innerHTML = `
      <div class="flex items-center justify-between gap-2 mb-2">
        <span class="badge" style="background:${meta.color}1c;color:${meta.color};border-color:${meta.color}55;">${esc(meta.singular)}</span>
        <span class="mono text-muted" style="font-size:10.5px;">${outgoing.length + incoming.length} NASA links</span>
      </div>
      <h4 style="font-family:var(--font-display);font-size:15px;margin:0 0 6px;">${esc(node.label)}</h4>
      <p class="text-sec" style="font-size:12px;margin:0 0 10px;line-height:1.5;">${esc(node.detail)}</p>

      <div class="flex gap-2 flex-wrap mb-3">
        <button type="button" class="btn btn-primary btn-sm" id="kg-ask-node-btn">Ask FlameAI</button>
        <button type="button" class="btn btn-sm" id="kg-inspector-expand-btn">+ Expand Links</button>
        ${docId ? `<button type="button" class="btn btn-cyan btn-sm" data-doc-id="${esc(docId)}" data-doc-page="1">Open Paper</button>` : ''}
      </div>

      <div style="font-size:11.5px;">
        <div class="mono text-muted" style="font-size:10px;margin-bottom:6px;">OUTGOING (${outgoing.length})</div>
        ${
          outgoing.length
            ? outgoing
                .slice(0, 6)
                .map(
                  (o) => `
                  <button type="button" data-jump-neighbor="${esc(o.target)}" style="display:block;width:100%;text-align:left;padding:6px 8px;background:var(--bg-surface-2);border:1px solid var(--border-subtle);border-radius:8px;margin-bottom:5px;cursor:pointer;">
                    <span class="mono" style="color:var(--accent-cyan);font-size:10px;">${esc((o.relationship ?? o.relation ?? 'related').replace(/_/g, ' '))}</span>
                    → <strong style="color:var(--text-primary);">${esc(String(o.target).slice(0, 44))}</strong>
                  </button>`
                )
                .join('')
            : '<div class="text-muted mb-2">None</div>'
        }

        <div class="mono text-muted" style="font-size:10px;margin:10px 0 6px;">INCOMING (${incoming.length})</div>
        ${
          incoming.length
            ? incoming
                .slice(0, 6)
                .map(
                  (i) => `
                  <button type="button" data-jump-neighbor="${esc(i.source)}" style="display:block;width:100%;text-align:left;padding:6px 8px;background:var(--bg-surface-2);border:1px solid var(--border-subtle);border-radius:8px;margin-bottom:5px;cursor:pointer;">
                    <strong style="color:var(--text-primary);">${esc(String(i.source).slice(0, 44))}</strong>
                    → <span class="mono" style="color:var(--accent-flame);font-size:10px;">${esc((i.relationship ?? i.relation ?? 'related').replace(/_/g, ' '))}</span>
                  </button>`
                )
                .join('')
            : '<div class="text-muted">None</div>'
        }
      </div>
    `;

    panel.querySelector('#kg-ask-node-btn')?.addEventListener('click', () => {
      emit('chat:ask', `Explain how "${node.label}" connects to NASA microgravity fire safety experiments, material flammability, and spacecraft design guidelines.`);
    });
    panel.querySelector('#kg-inspector-expand-btn')?.addEventListener('click', () => {
      expandNodeNeighbors(node.id, 5);
    });
    panel.querySelectorAll('[data-jump-neighbor]').forEach((btn) => {
      btn.addEventListener('click', () => placeNasaNode(btn.dataset.jumpNeighbor, { focus: true }));
    });
  } catch (err) {
    panel.innerHTML = `<div class="text-muted" style="font-size:12px;">Could not inspect node: ${esc(err.message)}</div>`;
  }
}

/* ------------------------------------------------------------------ *
 * Inline Edit Form
 * ------------------------------------------------------------------ */
function openEditForm(node) {
  const form = document.getElementById('wb-step-form');
  const labelInput = document.getElementById('wb-edit-label');
  const detailInput = document.getElementById('wb-edit-detail');
  const toolInput = document.getElementById('wb-edit-tool');
  if (!form || !node) return;
  editingId = node.id;
  if (labelInput) labelInput.value = node.label;
  if (detailInput) detailInput.value = node.detail;
  if (toolInput) toolInput.value = node.tag || '';
  form.style.display = 'grid';
  labelInput?.focus();
}

function closeEditForm() {
  const form = document.getElementById('wb-step-form');
  if (form) form.style.display = 'none';
  editingId = null;
}

/* ------------------------------------------------------------------ *
 * Pointer, Wheel, Pinch, Drag & Port-Wiring Events
 * ------------------------------------------------------------------ */
function bindNodeElementEvents(el, node) {
  // Expand quick button on card
  el.querySelector('[data-expand-node]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    selectedId = node.id;
    expandNodeNeighbors(node.id, 5);
  });

  // Output port drag-to-connect
  const sourcePort = el.querySelector('.wb-handle-source');
  sourcePort?.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const b = getNodeBox(node);
    connectState = {
      sourceId: node.id,
      sx: b.x + b.w,
      sy: b.y + b.h / 2,
      pointerId: e.pointerId,
      hoverTargetId: null,
    };
    canvasEl?.classList.add('is-connecting');
    sourcePort.setPointerCapture?.(e.pointerId);
  });

  // Dragging floating widget on infinite workspace
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button') || e.target.closest('.wb-handle')) return;
    e.stopPropagation();
    const worldStart = screenToWorld(e.clientX, e.clientY);
    dragState = {
      node,
      el,
      pointerId: e.pointerId,
      startX: node.x,
      startY: node.y,
      offsetX: worldStart.x - node.x,
      offsetY: worldStart.y - node.y,
      moved: false,
    };
    el.setPointerCapture?.(e.pointerId);
    if (selectedId !== node.id) {
      selectedId = node.id;
      closeEditForm();
      renderSelectionState();
      inspectNode(node.id);
    }
  });

  // Keyboard navigation for accessibility
  el.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 60 : 20;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectedId = node.id;
      renderSelectionState();
      inspectNode(node.id);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      pushHistory();
      if (e.key === 'ArrowRight') node.x = snap(node.x + step);
      if (e.key === 'ArrowLeft') node.x = snap(node.x - step);
      if (e.key === 'ArrowDown') node.y = snap(node.y + step);
      if (e.key === 'ArrowUp') node.y = snap(node.y - step);
      el.style.transform = `translate3d(${node.x}px, ${node.y}px, 0)`;
      edges
        .filter((edge) => edge.source === node.id || edge.target === node.id)
        .forEach(updateSingleEdgeSvg);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      selectedId = node.id;
      removeSelectedNode();
    }
  });
}

function bindCanvasAndToolbarEvents() {
  // Infinite background pan & two-finger pinch zoom
  canvasEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.wb-node') || e.target.closest('.wb-tools')) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size === 2) {
      panState = null;
      const pts = [...activePointers.values()];
      pinchState = {
        dist: Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1,
        zoom: viewport.zoom,
      };
      return;
    }

    if (e.button !== 0 && e.button !== 1) return;
    panState = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPanX: viewport.x,
      startPanY: viewport.y,
      moved: false,
    };
    canvasEl.classList.add('is-panning');
    canvasEl.setPointerCapture?.(e.pointerId);
  });

  window.addEventListener('pointermove', (e) => {
    // 1. Two-finger pinch zoom
    if (activePointers.has(e.pointerId)) {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinchState && activePointers.size === 2) {
        const pts = [...activePointers.values()];
        const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1;
        const midX = (pts[0].x + pts[1].x) / 2;
        const midY = (pts[0].y + pts[1].y) / 2;
        zoomAtClientPoint(pinchState.zoom * (dist / pinchState.dist), midX, midY);
        return;
      }
    }

    // 2. Port-to-port live Bezier wiring
    if (connectState && e.pointerId === connectState.pointerId) {
      const wpt = screenToWorld(e.clientX, e.clientY);
      const { d } = computeBezierPath(connectState.sx, connectState.sy, wpt.x, wpt.y);
      draftEdgeEl?.setAttribute('d', d);

      const under = document.elementFromPoint(e.clientX, e.clientY)?.closest('.wb-node');
      const targetId = under?.dataset?.nodeId || null;
      if (connectState.hoverTargetId && connectState.hoverTargetId !== targetId) {
        nodeElMap.get(connectState.hoverTargetId)?.classList.remove('is-drop-target');
      }
      if (targetId && targetId !== connectState.sourceId && canConnect(connectState.sourceId, targetId)) {
        connectState.hoverTargetId = targetId;
        nodeElMap.get(targetId)?.classList.add('is-drop-target');
      } else {
        connectState.hoverTargetId = null;
      }
      return;
    }

    // 3. Dragging floating node widget across infinite workspace
    if (dragState && e.pointerId === dragState.pointerId) {
      const wpt = screenToWorld(e.clientX, e.clientY);
      const nx = snap(wpt.x - dragState.offsetX);
      const ny = snap(wpt.y - dragState.offsetY);
      if (nx !== dragState.node.x || ny !== dragState.node.y) {
        if (!dragState.moved) {
          dragState.moved = true;
          dragState.el.classList.add('is-dragging');
        }
        dragState.node.x = nx;
        dragState.node.y = ny;
        dragState.el.style.transform = `translate3d(${nx}px, ${ny}px, 0)`;
        for (const edge of edges) {
          if (edge.source === dragState.node.id || edge.target === dragState.node.id) {
            updateSingleEdgeSvg(edge);
          }
        }
      }
      return;
    }

    // 4. Panning infinite canvas
    if (panState && e.pointerId === panState.pointerId) {
      const dx = e.clientX - panState.startClientX;
      const dy = e.clientY - panState.startClientY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panState.moved = true;
      viewport.x = panState.startPanX + dx;
      viewport.y = panState.startPanY + dy;
      applyViewport();
    }
  });

  const endPointer = (e) => {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) pinchState = null;

    if (connectState && e.pointerId === connectState.pointerId) {
      if (connectState.hoverTargetId) {
        nodeElMap.get(connectState.hoverTargetId)?.classList.remove('is-drop-target');
        addConnection(connectState.sourceId, connectState.hoverTargetId, 'linked_to');
      }
      draftEdgeEl?.setAttribute('d', '');
      canvasEl?.classList.remove('is-connecting');
      connectState = null;
    }

    if (dragState && e.pointerId === dragState.pointerId) {
      dragState.el.classList.remove('is-dragging');
      if (dragState.moved) {
        // Record pre-drag position onto undo stack cleanly
        const curX = dragState.node.x;
        const curY = dragState.node.y;
        dragState.node.x = dragState.startX;
        dragState.node.y = dragState.startY;
        pushHistory();
        dragState.node.x = curX;
        dragState.node.y = curY;
        setMessage(`Moved "${dragState.node.label}" to (${curX}, ${curY}).`);
      }
      dragState = null;
    }

    if (panState && e.pointerId === panState.pointerId) {
      canvasEl?.classList.remove('is-panning');
      if (!panState.moved && selectedId) {
        selectedId = '';
        closeEditForm();
        renderSelectionState();
      }
      panState = null;
    }
  };

  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);

  // Smooth pointer-centered wheel / trackpad zoom
  canvasEl.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const delta = e.deltaMode === 1 ? e.deltaY * 18 : e.deltaY;
      const factor = Math.exp(-delta * 0.0018);
      zoomAtClientPoint(viewport.zoom * factor, e.clientX, e.clientY);
    },
    { passive: false }
  );

  // Double-click empty infinite space to zoom in right at the cursor
  canvasEl.addEventListener('dblclick', (e) => {
    if (e.target.closest('.wb-node') || e.target.closest('.wb-tools')) return;
    zoomAtClientPoint(viewport.zoom * 1.28, e.clientX, e.clientY);
  });

  // Keyboard zoom shortcuts when infinite canvas is focused
  canvasEl.addEventListener('keydown', (e) => {
    if (e.target !== canvasEl) return;
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomByFactor(1.18);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoomByFactor(1 / 1.18);
    } else if (e.key === '0') {
      e.preventDefault();
      fitView();
    }
  });

  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      if (canvasEl.clientWidth > 0 && nodes.length) {
        renderEdges();
        if (!initialFitDone) fitView();
      }
    });
    ro.observe(canvasEl);
  }

  // Floating canvas controls
  document.getElementById('kg-zoom-in')?.addEventListener('click', () => zoomByFactor(1.2));
  document.getElementById('kg-zoom-out')?.addEventListener('click', () => zoomByFactor(1 / 1.2));
  document.getElementById('wb-zoom-readout')?.addEventListener('click', () => {
    const rect = canvasEl.getBoundingClientRect();
    zoomAtClientPoint(1.0, rect.left + rect.width / 2, rect.top + rect.height / 2);
  });
  document.getElementById('wb-fit-view')?.addEventListener('click', () => fitView());
  document.getElementById('kg-reset')?.addEventListener('click', () => {
    buildStarterBlueprint();
    setMessage('Restored starter NASA fire-safety blueprint.');
  });

  const motionBtn = document.getElementById('wb-motion-toggle');
  motionBtn?.addEventListener('click', () => {
    motionPaused = !motionPaused;
    rootEl?.setAttribute('data-animated', String(!motionPaused));
    motionBtn.setAttribute('aria-pressed', String(motionPaused));
    motionBtn.textContent = motionPaused ? 'Resume motion' : 'Pause motion';
  });

  // Header toolbar controls
  document.getElementById('wb-add-custom-btn')?.addEventListener('click', addCustomStep);
  document.getElementById('wb-auto-layout-btn')?.addEventListener('click', () => autoArrangeNodes(true));
  document.getElementById('wb-undo-btn')?.addEventListener('click', undoLast);
  document.getElementById('wb-export-btn')?.addEventListener('click', exportBlueprintJson);
  document.getElementById('kg-load-preset-btn')?.addEventListener('click', () => {
    buildStarterBlueprint();
    setMessage('Loaded starter NASA fire-safety blueprint.');
  });
  document.getElementById('kg-clear-canvas-btn')?.addEventListener('click', () => {
    if (!nodes.length) return;
    pushHistory();
    nodes = [];
    edges = [];
    selectedId = '';
    closeEditForm();
    renderAll();
    setMessage('Workspace cleared. Pick any NASA entity from the Connection Stack to place it.');
  });

  // Bottom editor controls
  document.getElementById('wb-selected-select')?.addEventListener('change', (e) => {
    selectedId = e.target.value;
    closeEditForm();
    renderSelectionState();
    if (selectedId) {
      const node = nodes.find((n) => n.id === selectedId);
      if (node) {
        centerOnNode(node);
        inspectNode(node.id);
      }
    }
  });
  document.getElementById('wb-expand-btn')?.addEventListener('click', () => {
    if (selectedId) expandNodeNeighbors(selectedId, 5);
  });
  document.getElementById('wb-edit-btn')?.addEventListener('click', () => {
    const node = nodes.find((n) => n.id === selectedId);
    if (node) openEditForm(node);
  });
  document.getElementById('wb-remove-btn')?.addEventListener('click', removeSelectedNode);

  document.getElementById('wb-step-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const target = nodes.find((n) => n.id === editingId);
    if (!target) return;
    const label = (document.getElementById('wb-edit-label')?.value || '').trim();
    if (!label) return;
    pushHistory();
    target.label = label;
    target.detail = (document.getElementById('wb-edit-detail')?.value || '').trim() || target.detail;
    target.tag = (document.getElementById('wb-edit-tool')?.value || '').trim();
    closeEditForm();
    renderAll();
    inspectNode(target.id);
    setMessage(`Updated "${target.label}".`);
  });
  document.getElementById('wb-edit-cancel')?.addEventListener('click', closeEditForm);

  const srcSel = document.getElementById('wb-connect-source');
  const tgtSel = document.getElementById('wb-connect-target');
  const connBtn = document.getElementById('wb-connect-submit');
  const syncConnectBtn = () => {
    if (connBtn && srcSel && tgtSel) connBtn.disabled = !srcSel.value || !tgtSel.value;
  };
  srcSel?.addEventListener('change', syncConnectBtn);
  tgtSel?.addEventListener('change', syncConnectBtn);
  document.getElementById('wb-connect-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (srcSel?.value && tgtSel?.value) {
      addConnection(srcSel.value, tgtSel.value, 'linked_to');
    }
  });

  // Search box inside Connection Stack
  document.getElementById('kg-search-input')?.addEventListener('input', (e) => {
    searchQuery = e.target.value.trim();
    renderConnectionStack();
  });
}

function renderTypeFilters() {
  const wrap = document.getElementById('kg-type-filters');
  if (!wrap) return;
  const order = ['experiment', 'material', 'paper', 'guideline', 'finding', 'safety_implication'];
  wrap.innerHTML = order
    .map((type) => {
      const meta = TYPE_META[type];
      return `
        <button type="button" class="pill-btn ${activeTypes.has(type) ? 'active' : ''}" data-kg-type="${type}">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${meta.color};margin-right:5px;"></span>
          ${esc(meta.label)}
        </button>
      `;
    })
    .join('');

  wrap.querySelectorAll('[data-kg-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.kgType;
      if (activeTypes.has(t)) activeTypes.delete(t);
      else activeTypes.add(t);
      if (activeTypes.size === 0) activeTypes.add('experiment');
      renderTypeFilters();
      renderConnectionStack();
    });
  });
}

/* ------------------------------------------------------------------ *
 * Public Bootstrap
 * ------------------------------------------------------------------ */
export async function initGraph() {
  rootEl = document.getElementById('wb-root');
  canvasEl = document.getElementById('wb-canvas');
  viewportEl = document.getElementById('wb-viewport');
  edgesLayerEl = document.getElementById('wb-edges-layer');
  draftEdgeEl = document.getElementById('wb-draft-edge');
  nodesLayerEl = document.getElementById('wb-nodes-layer');
  if (!canvasEl || !viewportEl || !nodesLayerEl) return;

  if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    motionPaused = true;
    rootEl?.setAttribute('data-animated', 'false');
    const motionBtn = document.getElementById('wb-motion-toggle');
    if (motionBtn) {
      motionBtn.setAttribute('aria-pressed', 'true');
      motionBtn.textContent = 'Resume motion';
    }
  }

  renderTypeFilters();
  bindCanvasAndToolbarEvents();
  applyViewport();

  try {
    rawGraph = await api.graph();
    rawNodeMap = new Map((rawGraph.nodes || []).map((n) => [n.id, n]));
    rawAdj = new Map();
    for (const e of rawGraph.edges || []) {
      const rel = getRawEdgeRel(e);
      if (!rawAdj.has(e.source)) rawAdj.set(e.source, []);
      if (!rawAdj.has(e.target)) rawAdj.set(e.target, []);
      rawAdj.get(e.source).push({ neighborId: e.target, relationship: rel, direction: 'out' });
      rawAdj.get(e.target).push({ neighborId: e.source, relationship: rel, direction: 'in' });
    }

    const statsEl = document.getElementById('kg-stats-badge');
    if (statsEl) {
      statsEl.textContent = `${rawGraph.stats.node_count} NASA nodes · ${rawGraph.stats.edge_count} edges`;
    }
    buildStarterBlueprint();
  } catch (err) {
    console.error('Graph load error:', err);
  }

  on('tab:changed', (tab) => {
    if (tab === 'graph') {
      requestAnimationFrame(() => {
        renderEdges();
        if (!initialFitDone && nodes.length) {
          fitView();
        } else {
          applyViewport();
        }
      });
    }
  });

  on('theme:changed', () => {
    applyViewport();
    renderEdges();
  });
}
