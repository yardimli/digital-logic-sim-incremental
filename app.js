import { COMPONENTS, initializeNodeState, propagationSeeds, propagateBatch, makeExample } from './engine.js';
import { routeWire, orthogonalPath, curvedPath, directBezierPath, directBezierIsClear, moveOrthogonalSegment } from './router.js';

const $ = selector => document.querySelector(selector);
const workspace = $('#workspace');
const nodesLayer = $('#nodes');
const wireLayer = $('#wire-layer');
const draftWire = $('#draft-wire');
const inspector = $('#inspector');
const STORAGE_KEY = 'digital-logic-sim.workspace.v1';
const NODE_WIDTH = 142;
const NODE_HEIGHT = 100;
const GATE_TYPES = new Set(['AND', 'OR', 'NOT', 'NAND', 'NOR', 'XOR', 'XNOR']);
const restoredWorkspace = readStoredWorkspace();
const starter = makeExample();
const initialTabs = restoredWorkspace?.tabs?.length ? restoredWorkspace.tabs : [{ id: uid('tab'), ...starter, panX: 0, panY: 0, zoom: 1 }];
for (const tab of initialTabs) initializeNodeState(tab.nodes);
const initialTab = initialTabs.find(tab => tab.id === restoredWorkspace?.activeTabId) || initialTabs[0];
const state = { name: initialTab.name, nodes: initialTab.nodes, wires: initialTab.wires, tabs: initialTabs, activeTabId: initialTab.id, selectedNode: null, selectedWire: null, pending: null, propagationQueue: [], evaluatedNodes: new Set(), clock: false, clockHz: restoredWorkspace?.clockHz || 5, wireStyle: restoredWorkspace?.wireStyle === 'curved' ? 'curved' : 'orthogonal', isPlaying: true, simulationError: null, zoom: initialTab.zoom || 1, panX: initialTab.panX || 0, panY: initialTab.panY || 0, history: [], future: [] };
let toastTimer;
const objectTokens = new WeakMap();
let nextObjectToken = 1;
let lastPersistedWorkspace = '';
let wireDragCleanup = null;
let rewiringWireId = null;
let wireRouteLayout = '';
const wireRouteCache = new Map();

function uid(prefix) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`; }
function sanitizeCircuitData(nodes, wires) {
  const cleanNodes = nodes.filter(node => node && COMPONENTS[node.type]).map(node => ({ ...node, x: Number(node.x) || 0, y: Number(node.y) || 0, value: node.type === 'INPUT' || node.type === 'CLOCK' ? Boolean(node.value) : false }));
  const nodeIds = new Set(cleanNodes.map(node => node.id));
  const cleanWires = wires.filter(wire => wire?.from && wire?.to && nodeIds.has(wire.from.node) && nodeIds.has(wire.to.node));
  return { nodes: cleanNodes, wires: cleanWires };
}
function readStoredWorkspace() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!value || !Array.isArray(value.tabs)) return null;
    const tabs = value.tabs.filter(tab => tab && Array.isArray(tab.nodes) && Array.isArray(tab.wires)).map((tab, index) => ({ id: String(tab.id || uid('tab')), name: String(tab.name || `Circuit ${index + 1}`), ...sanitizeCircuitData(tab.nodes, tab.wires), panX: Number(tab.panX) || 0, panY: Number(tab.panY) || 0, zoom: Number(tab.zoom) || 1 }));
    return tabs.length ? { tabs, activeTabId: value.activeTabId, clockHz: Math.min(100, Math.max(1, Number(value.clockHz) || 5)), wireStyle: value.wireStyle === 'curved' ? 'curved' : 'orthogonal' } : null;
  } catch { return null; }
}
function activeTab() { return state.tabs.find(tab => tab.id === state.activeTabId); }
function syncActiveTab() { const tab = activeTab(); if (tab) Object.assign(tab, { name: state.name, nodes: state.nodes, wires: state.wires, panX: state.panX, panY: state.panY, zoom: state.zoom }); }
function serializableTab(tab) { return { id: tab.id, name: tab.name, panX: tab.panX || 0, panY: tab.panY || 0, zoom: tab.zoom || 1, nodes: tab.nodes.map(node => ({ id: node.id, type: node.type, label: node.label, x: node.x, y: node.y, value: node.type === 'INPUT' || node.type === 'CLOCK' ? Boolean(node.value) : false, inputs: [...(node.inputs || [])], outputs: [...(node.outputs || [])] })), wires: tab.wires }; }
function persistWorkspace() {
  try {
    syncActiveTab();
    const serialized = JSON.stringify({ version: 1, activeTabId: state.activeTabId, clockHz: state.clockHz, wireStyle: state.wireStyle, tabs: state.tabs.map(serializableTab) });
    if (serialized !== lastPersistedWorkspace) { localStorage.setItem(STORAGE_KEY, serialized); lastPersistedWorkspace = serialized; }
  } catch { /* Storage can be unavailable in privacy-restricted contexts. */ }
}
function cloneCircuit() { return structuredClone({ name: state.name, nodes: state.nodes, wires: state.wires }); }
function checkpoint() { state.history.push(cloneCircuit()); if (state.history.length > 50) state.history.shift(); state.future = []; updateUndoButtons(); }
function restore(snapshot) { state.name = snapshot.name; state.nodes = snapshot.nodes; state.wires = snapshot.wires; state.selectedNode = null; state.selectedWire = null; simulateAndRender(); }
function undo() { if (!state.history.length) return; state.future.push(cloneCircuit()); restore(state.history.pop()); updateUndoButtons(); }
function redo() { if (!state.future.length) return; state.history.push(cloneCircuit()); restore(state.future.pop()); updateUndoButtons(); }
function updateUndoButtons() { $('#undo').disabled = !state.history.length; $('#redo').disabled = !state.future.length; }
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 1800); }

function switchTab(id) {
  if (id === state.activeTabId) return;
  syncActiveTab();
  const tab = state.tabs.find(item => item.id === id); if (!tab) return;
  cancelWire(); state.activeTabId = id; state.name = tab.name; state.nodes = tab.nodes; state.wires = tab.wires; state.panX = tab.panX || 0; state.panY = tab.panY || 0; state.zoom = tab.zoom || 1; state.selectedNode = null; state.selectedWire = null; state.propagationQueue = []; state.evaluatedNodes = new Set(); state.history = []; state.future = []; simulateAndRender();
}
function addCircuitTab(circuit = null) {
  syncActiveTab();
  const number = state.tabs.length + 1;
  const cleanCircuit = sanitizeCircuitData(circuit?.nodes || [], circuit?.wires || []);
  const tab = { id: uid('tab'), name: circuit?.name || `Circuit ${number}`, ...cleanCircuit, panX: 0, panY: 0, zoom: 1 };
  state.tabs.push(tab); state.activeTabId = '';
  switchTab(tab.id);
}
function closeCircuitTab(id) {
  if (state.tabs.length === 1) return;
  const index = state.tabs.findIndex(tab => tab.id === id); if (index < 0) return;
  const tab = state.tabs[index]; if (tab.nodes.length && !confirm(`Close “${tab.name}”?`)) return;
  const wasActive = id === state.activeTabId; state.tabs.splice(index, 1);
  if (wasActive) { state.activeTabId = ''; switchTab(state.tabs[Math.min(index, state.tabs.length - 1)].id); }
  else { renderTabs(true); persistWorkspace(); }
}
function tabsRenderKey() { return `${state.activeTabId}|${state.tabs.map(tab => `${tab.id}:${tab.name}`).join('|')}`; }
function renderTabs(force = false) {
  syncActiveTab();
  const root = $('#circuit-tabs'); const renderKey = tabsRenderKey();
  if (!force && root.dataset.renderKey === renderKey) return;
  root.replaceChildren();
  for (const tab of state.tabs) {
    const item = document.createElement('div'); item.className = `circuit-tab${tab.id === state.activeTabId ? ' active' : ''}`;
    if (tab.id === state.activeTabId) {
      const input = document.createElement('input'); input.id = 'project-name'; input.className = 'tab-name'; input.value = tab.name; input.setAttribute('aria-label', 'Circuit name');
      input.addEventListener('input', event => { state.name = event.target.value; tab.name = state.name; root.dataset.renderKey = tabsRenderKey(); persistWorkspace(); });
      input.addEventListener('change', event => { state.name = event.target.value.trim() || 'Untitled circuit'; tab.name = state.name; event.target.value = state.name; root.dataset.renderKey = ''; renderTabs(); }); item.append(input);
    } else {
      const select = document.createElement('button'); select.className = 'tab-select'; select.textContent = tab.name; select.title = tab.name; select.addEventListener('click', () => switchTab(tab.id)); item.append(select);
    }
    if (state.tabs.length > 1) { const close = document.createElement('button'); close.className = 'tab-close'; close.textContent = '×'; close.setAttribute('aria-label', `Close ${tab.name}`); close.addEventListener('click', () => closeCircuitTab(tab.id)); item.append(close); }
    root.append(item);
  }
  const add = document.createElement('button'); add.className = 'tab-add'; add.textContent = '+'; add.title = 'New circuit'; add.setAttribute('aria-label', 'New circuit'); add.addEventListener('click', () => addCircuitTab()); root.append(add); root.dataset.renderKey = renderKey;
}

function gateSvg(type) {
  const inverted = type === 'NAND' || type === 'NOR' || type === 'XNOR';
  const exclusive = type === 'XOR' || type === 'XNOR';
  const andFamily = type === 'AND' || type === 'NAND';
  const notGate = type === 'NOT';
  const body = notGate
    ? '<path class="gate-body" d="M25 8 L94 32 L25 56 Z" />'
    : andFamily
      ? '<path class="gate-body" d="M18 8 H57 C82 8 98 18 98 32 C98 46 82 56 57 56 H18 Z" />'
      : '<path class="gate-body" d="M18 8 C48 8 77 10 99 32 C77 54 48 56 18 56 C31 43 31 21 18 8 Z" />';
  const leads = notGate
    ? '<path class="gate-lead" d="M0 32 H25 M107 32 H120" />'
    : `<path class="gate-lead" d="M0 21 H${andFamily ? 18 : 25} M0 43 H${andFamily ? 18 : 25} M${inverted ? 107 : 99} 32 H120" />`;
  const bubble = (inverted || notGate) ? '<circle class="gate-bubble" cx="104" cy="32" r="3" />' : '';
  const extra = exclusive ? '<path class="gate-lead" d="M10 8 C24 22 24 42 10 56" />' : '';
  return `<svg class="gate-symbol" viewBox="0 0 120 64" aria-hidden="true">${leads}${extra}${body}${bubble}</svg>`;
}

function buildLibrary(filter = '') {
  const root = $('#component-library');
  root.replaceChildren();
  const groups = Object.entries(COMPONENTS).filter(([, d]) => `${d.label} ${d.detail}`.toLowerCase().includes(filter.toLowerCase())).reduce((map, [type, def]) => {
    (map[def.category] ??= []).push([type, def]); return map;
  }, {});
  for (const [category, items] of Object.entries(groups)) {
    const title = document.createElement('div'); title.className = 'category-title'; title.textContent = category; root.append(title);
    for (const [type, def] of items) {
      const entry = document.createElement('div'); entry.className = 'component-entry';
      const button = document.createElement('button'); button.className = 'component-item'; button.draggable = true;
      button.innerHTML = `<span class="component-icon${GATE_TYPES.has(type) ? ' gate-preview' : ''}">${GATE_TYPES.has(type) ? gateSvg(type) : def.symbol}</span><span class="component-copy"><strong>${def.label}</strong><small>${def.detail}</small></span>`;
      button.addEventListener('dragstart', event => { event.dataTransfer.setData('application/x-dls-component', type); event.dataTransfer.setData('text/plain', type); event.dataTransfer.effectAllowed = 'copy'; button.classList.add('dragging'); });
      button.addEventListener('dragend', () => { button.classList.remove('dragging'); workspace.classList.remove('drop-ready'); });
      const help = document.createElement('button'); help.className = 'library-help'; help.textContent = '?'; help.setAttribute('aria-label', `How ${def.label} works`); help.setAttribute('aria-expanded', 'false');
      const hint = document.createElement('div'); hint.className = 'library-hint'; hint.textContent = def.hint; hint.hidden = true;
      help.addEventListener('click', () => {
        const show = hint.hidden;
        for (const openHint of root.querySelectorAll('.library-hint:not([hidden])')) { openHint.hidden = true; openHint.previousElementSibling?.setAttribute('aria-expanded', 'false'); }
        hint.hidden = !show; help.setAttribute('aria-expanded', String(show));
      });
      entry.append(button, help, hint); root.append(entry);
    }
  }
}

function nodeDimensions(type) {
  const def = COMPONENTS[type];
  return { width: def.width || NODE_WIDTH, height: def.height || NODE_HEIGHT };
}

function addNode(type, position = null) {
  if (!COMPONENTS[type]) return;
  checkpoint();
  const centerX = (workspace.clientWidth / 2 - state.panX) / state.zoom;
  const centerY = (workspace.clientHeight / 2 - state.panY) / state.zoom;
  const dimensions = nodeDimensions(type);
  const node = { id: uid('node'), type, label: COMPONENTS[type].label, x: Math.round(position?.x ?? centerX - dimensions.width / 2), y: Math.round(position?.y ?? centerY - dimensions.height / 2), value: false };
  state.nodes.push(node); state.selectedNode = node.id; state.selectedWire = null; simulateAndRender();
  if (innerWidth <= 650) $('.library-panel').classList.remove('open');
}

function connectorSide(node, kind, pin) {
  return COMPONENTS[node.type][`${kind}Sides`]?.[pin] || (kind === 'input' ? 'left' : 'right');
}
function connectorOffset(node, kind, pin) {
  const def = COMPONENTS[node.type];
  const count = kind === 'input' ? def.inputs : def.outputs;
  const physicalSide = connectorSide(node, kind, pin);
  const peers = Array.from({ length: count }, (_, index) => index).filter(index => connectorSide(node, kind, index) === physicalSide);
  const position = peers.indexOf(pin);
  if (physicalSide === 'left' || physicalSide === 'right') return peers.length === 1 ? 65 : 44 + position * (44 / Math.max(1, peers.length - 1));
  return peers.length === 1 ? 50 : 22 + position * (56 / Math.max(1, peers.length - 1));
}
function nodePortPosition(node, kind, pin) {
  const dimensions = nodeDimensions(node.type);
  const side = connectorSide(node, kind, pin);
  const offset = connectorOffset(node, kind, pin) / 100;
  if (side === 'top') return { x: node.x + dimensions.width * offset, y: node.y, side };
  if (side === 'bottom') return { x: node.x + dimensions.width * offset, y: node.y + dimensions.height, side };
  return { x: node.x + (side === 'left' ? 0 : dimensions.width), y: node.y + dimensions.height * offset, side };
}
function wireRoute(a, b, excludedNodeIds = [], occupiedSegments = []) {
  const excluded = new Set(excludedNodeIds);
  const obstacles = state.nodes.filter(node => !excluded.has(node.id)).map(node => { const dimensions = nodeDimensions(node.type); return { left: node.x, top: node.y, right: node.x + dimensions.width, bottom: node.y + dimensions.height }; });
  if (state.wireStyle === 'curved' && directBezierIsClear(a, b, obstacles, 18)) return { points: [a, b], path: directBezierPath(a, b) };
  const points = routeWire(a, b, obstacles, state.wireStyle === 'curved' ? 30 : 14, 18, occupiedSegments);
  return { points, path: state.wireStyle === 'curved' ? curvedPath(points) : orthogonalPath(points) };
}
function routeForWire(wire, source, target, occupiedSegments = []) {
  const start = nodePortPosition(source, 'output', wire.from.pin);
  const end = nodePortPosition(target, 'input', wire.to.pin);
  const manual = wire.manualRoutes?.[state.wireStyle];
  if (state.wireStyle === 'curved' && manual?.bend) {
    const points = [start, manual.bend, end]; return { points, path: curvedPath(points) };
  }
  if (state.wireStyle === 'orthogonal' && Array.isArray(manual?.points) && manual.points.length >= 2) {
    const points = manual.points.map(point => ({ ...point })); points[0] = start; points[points.length - 1] = end;
    return { points, path: orthogonalPath(points) };
  }
  return wireRoute(start, end, [source.id, target.id], occupiedSegments);
}
function workspacePoint(event) {
  const rect = workspace.getBoundingClientRect();
  return { x: (event.clientX - rect.left - state.panX) / state.zoom, y: (event.clientY - rect.top - state.panY) / state.zoom };
}
function nearestSegmentIndex(points, point) {
  let nearest = 0; let nearestDistance = Infinity;
  for (let index = 0; index < points.length - 1; index++) {
    const first = points[index]; const second = points[index + 1];
    const horizontal = first.y === second.y;
    const along = horizontal ? Math.max(Math.min(point.x, Math.max(first.x, second.x)), Math.min(first.x, second.x)) : Math.max(Math.min(point.y, Math.max(first.y, second.y)), Math.min(first.y, second.y));
    const dx = point.x - (horizontal ? along : first.x); const dy = point.y - (horizontal ? first.y : along);
    const distance = dx * dx + dy * dy;
    if (distance < nearestDistance) { nearestDistance = distance; nearest = index; }
  }
  return nearest;
}
function startWireShapeDrag(event, wire, route) {
  if (event.button !== 0) return;
  event.preventDefault(); event.stopPropagation(); state.selectedWire = wire.id; state.selectedNode = null; renderInspector(); renderWires();
  const origin = workspacePoint(event); const segmentIndex = state.wireStyle === 'orthogonal' ? nearestSegmentIndex(route.points, origin) : -1;
  const originalPoints = route.points.map(point => ({ ...point })); let dragging = false;
  const move = current => {
    const point = workspacePoint(current);
    if (!dragging && Math.hypot(current.clientX - event.clientX, current.clientY - event.clientY) < 3) return;
    if (!dragging) { checkpoint(); dragging = true; wire.manualRoutes ||= {}; }
    if (state.wireStyle === 'curved') wire.manualRoutes.curved = { bend: { x: Math.round(point.x / 6) * 6, y: Math.round(point.y / 6) * 6 } };
    else {
      const horizontal = originalPoints[segmentIndex].y === originalPoints[segmentIndex + 1].y;
      const coordinate = Math.round((horizontal ? point.y : point.x) / 6) * 6;
      wire.manualRoutes.orthogonal = { points: moveOrthogonalSegment(originalPoints, segmentIndex, coordinate) };
    }
    renderWires();
  };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); if (dragging) persistWorkspace(); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
}
function objectToken(value) { if (!objectTokens.has(value)) objectTokens.set(value, nextObjectToken++); return objectTokens.get(value); }

function renderWires() {
  const routeLayout = `${state.wireStyle}|${state.nodes.map(node => `${node.id}:${node.type}:${node.x}:${node.y}`).join('|')}|${state.wires.map(wire => `${wire.id}:${wire.from.node}:${wire.from.pin}:${wire.to.node}:${wire.to.pin}:${JSON.stringify(wire.manualRoutes || {})}`).join('|')}`;
  if (routeLayout !== wireRouteLayout) { wireRouteLayout = routeLayout; wireRouteCache.clear(); }
  const visibleWires = state.wires.filter(wire => wire.id !== rewiringWireId);
  const liveIds = new Set(visibleWires.map(wire => wire.id));
  for (const child of [...wireLayer.children]) if (!liveIds.has(child.dataset.id)) child.remove();
  const rendered = new Map([...wireLayer.children].map(child => [child.dataset.id, child]));
  const occupiedSegments = [];
  for (const wire of visibleWires) {
    const source = state.nodes.find(n => n.id === wire.from.node); const target = state.nodes.find(n => n.id === wire.to.node);
    if (!source || !target) continue;
    const routeKey = `${wire.id}:${wire.from.node}:${wire.from.pin}:${wire.to.node}:${wire.to.pin}`;
    let route = wireRouteCache.get(routeKey);
    if (!route) { route = routeForWire(wire, source, target, state.wireStyle === 'orthogonal' ? occupiedSegments : []); wireRouteCache.set(routeKey, route); }
    if (state.wireStyle === 'orthogonal') for (let index = 1; index < route.points.length; index++) occupiedSegments.push({ a: route.points[index - 1], b: route.points[index] });
    const path = route.path;
    const active = Boolean(source.outputs?.[wire.from.pin]);
    const renderKey = `${path}|${active}|${state.selectedWire === wire.id}`;
    let group = rendered.get(wire.id);
    if (!group) {
      group = document.createElementNS('http://www.w3.org/2000/svg', 'g'); group.dataset.id = wire.id;
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path'); hit.setAttribute('class', 'wire-hit');
      hit.addEventListener('pointerdown', event => startWireShapeDrag(event, wire, group._route));
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'path'); group.append(hit, line); wireLayer.append(group);
    }
    if (group.dataset.renderKey !== renderKey) {
      const [hit, line] = group.children; hit.setAttribute('d', path); line.setAttribute('d', path); line.setAttribute('class', `wire${active ? ' on' : ''}${state.selectedWire === wire.id ? ' selected' : ''}`); group.dataset.renderKey = renderKey;
    }
    group._route = route;
  }
}

function makePin(node, side, index) {
  const physicalSide = connectorSide(node, side, index);
  const pin = document.createElement('button'); pin.className = `pin ${side} side-${physicalSide}`;
  pin.style.setProperty('--pin-offset', connectorOffset(node, side, index)); pin.setAttribute('aria-label', `${side} ${index + 1}`); pin.dataset.side = side; pin.dataset.pin = index;
  if (state.pending?.node === node.id && state.pending?.pin === index) pin.classList.add('pending');
  pin.addEventListener('pointerdown', event => {
    event.stopPropagation();
    if (side === 'output') { startWireDrag(event, node, index); return; }
    const connected = state.wires.filter(wire => wire.to.node === node.id && wire.to.pin === index);
    if (connected.length !== 1) return;
    const wire = connected[0]; const source = state.nodes.find(item => item.id === wire.from.node);
    if (source) startWireDrag(event, source, wire.from.pin, wire);
  });
  return pin;
}

function nodeRenderKey(node) {
  return [objectToken(node), node.type, node.label, node.x, node.y, node.value, state.selectedNode === node.id, node.inputs?.map(Number).join(''), node.outputs?.map(Number).join(''), state.pending?.node === node.id ? state.pending.pin : ''].join('|');
}

function createNodeElement(node, renderKey) {
  const def = COMPONENTS[node.type]; const active = node.type === 'INPUT' || node.type === 'CLOCK' ? Boolean(node.value) : node.type === 'LED_MATRIX' ? node.outputs?.some(Boolean) : Boolean(node.outputs?.[0]);
  const dimensions = nodeDimensions(node.type);
  const el = document.createElement('article'); el.className = `logic-node${GATE_TYPES.has(node.type) ? ' gate-node' : ''}${node.type === 'LED_MATRIX' ? ' matrix-node' : ''}${state.selectedNode === node.id ? ' selected' : ''}${active ? ' active' : ''}`; el.style.left = `${node.x}px`; el.style.top = `${node.y}px`; el.style.width = `${dimensions.width}px`; el.style.height = `${dimensions.height}px`; el.dataset.id = node.id; el.dataset.renderKey = renderKey;
  let center = `<span class="node-value">${active ? 'HIGH · 1' : 'LOW · 0'}</span>`;
  if (GATE_TYPES.has(node.type)) center = gateSvg(node.type);
  if (node.type === 'INPUT') center = `<button class="input-toggle" aria-label="Toggle ${escapeHtml(node.label)}" title="Toggle input"></button>`;
  if (node.type === 'LED') center = `<span class="led" aria-label="${active ? 'On' : 'Off'}"></span>`;
  if (node.type === 'OUTPUT') center = `<span class="node-value">${node.inputs?.[0] ? 'HIGH · 1' : 'LOW · 0'}</span>`;
  if (node.type === 'LED_MATRIX') center = `<div class="led-matrix" role="img" aria-label="4 by 4 LED matrix">${Array.from({ length: 16 }, (_, index) => `<span class="matrix-led${node.outputs?.[index] ? ' on' : ''}"></span>`).join('')}</div>`;
  el.innerHTML = `<div class="node-head"><strong>${escapeHtml(node.label)}</strong><span class="node-symbol">${def.symbol}</span></div><div class="node-body">${center}</div>`;
  el.addEventListener('pointerdown', event => {
    if (event.target.closest('button, input, select, .pin')) return;
    startNodeDrag(event, node);
  });
  const inputToggle = el.querySelector('.input-toggle');
  inputToggle?.addEventListener('pointerdown', event => event.stopPropagation());
  inputToggle?.addEventListener('click', event => { event.stopPropagation(); checkpoint(); node.value = !node.value; simulateAndRender(); });
  for (let i = 0; i < def.inputs; i++) el.append(makePin(node, 'input', i));
  for (let i = 0; i < def.outputs; i++) el.append(makePin(node, 'output', i));
  return el;
}

function renderNodes() {
  const liveIds = new Set(state.nodes.map(node => node.id));
  for (const child of [...nodesLayer.children]) if (!liveIds.has(child.dataset.id)) child.remove();
  const rendered = new Map([...nodesLayer.children].map(child => [child.dataset.id, child]));
  for (const node of state.nodes) {
    const renderKey = nodeRenderKey(node);
    const current = rendered.get(node.id);
    if (!current) nodesLayer.append(createNodeElement(node, renderKey));
    else if (current.dataset.renderKey !== renderKey) current.replaceWith(createNodeElement(node, renderKey));
  }
}

function escapeHtml(value) { const span = document.createElement('span'); span.textContent = value; return span.innerHTML; }
function startNodeDrag(event, node) {
  if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); checkpoint(); state.selectedNode = node.id; state.selectedWire = null; render();
  const start = { x: event.clientX, y: event.clientY, nx: node.x, ny: node.y };
  let routesCleared = false;
  const move = e => { if (!routesCleared) { for (const wire of state.wires) if (wire.from.node === node.id || wire.to.node === node.id) delete wire.manualRoutes; routesCleared = true; } node.x = Math.round((start.nx + (e.clientX - start.x) / state.zoom) / 6) * 6; node.y = Math.round((start.ny + (e.clientY - start.y) / state.zoom) / 6) * 6; renderNodes(); renderWires(); };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); renderInspector(); persistWorkspace(); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
}

function startWireDrag(event, node, pin, rewiringWire = null) {
  if (event.button !== 0) return;
  event.preventDefault(); cancelWire(); rewiringWireId = rewiringWire?.id || null; state.pending = { node: node.id, pin }; state.selectedWire = null; workspace.classList.add('connecting'); renderNodes(); renderWires(); renderInspector();
  const source = nodePortPosition(node, 'output', pin); let targetPin = null;
  const move = current => {
    const rect = workspace.getBoundingClientRect(); const target = { x: (current.clientX - rect.left - state.panX) / state.zoom, y: (current.clientY - rect.top - state.panY) / state.zoom };
    const candidate = document.elementFromPoint(current.clientX, current.clientY)?.closest('.pin.input');
    const targetNodeId = candidate?.closest('.logic-node')?.dataset.id;
    draftWire.setAttribute('d', wireRoute(source, target, [node.id, targetNodeId].filter(Boolean)).path);
    if (candidate !== targetPin) { targetPin?.classList.remove('drop-target'); targetPin = candidate; targetPin?.classList.add('drop-target'); }
  };
  const up = current => {
    move(current); const destination = targetPin; const targetNode = destination?.closest('.logic-node'); const targetNodeId = targetNode?.dataset.id; const targetPinIndex = Number(destination?.dataset.pin);
    wireDragCleanup?.(); wireDragCleanup = null;
    if (!destination || !targetNodeId || !Number.isInteger(targetPinIndex)) {
      if (rewiringWire) { checkpoint(); state.wires = state.wires.filter(wire => wire.id !== rewiringWire.id); cancelWire(); simulateAndRender(); }
      else cancelWire();
      return;
    }
    if (targetNodeId === node.id) { cancelWire(); return; }
    const duplicate = state.wires.some(wire => wire.from.node === node.id && wire.from.pin === pin && wire.to.node === targetNodeId && wire.to.pin === targetPinIndex);
    if (duplicate) { cancelWire(); return; }
    checkpoint();
    if (rewiringWire) { rewiringWire.to = { node: targetNodeId, pin: targetPinIndex }; delete rewiringWire.manualRoutes; }
    else state.wires.push({ id: uid('wire'), from: { node: node.id, pin }, to: { node: targetNodeId, pin: targetPinIndex } });
    cancelWire(); simulateAndRender();
  };
  wireDragCleanup = () => { targetPin?.classList.remove('drop-target'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancelWire); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancelWire);
}
function cancelWire() { wireDragCleanup?.(); wireDragCleanup = null; rewiringWireId = null; state.pending = null; draftWire.setAttribute('d', ''); workspace.classList.remove('connecting'); renderNodes(); renderWires(); }

function renderInspector() {
  const node = state.nodes.find(n => n.id === state.selectedNode);
  if (!node) {
    const emptyKey = state.selectedWire ? `wire:${state.selectedWire}` : `empty:${state.wireStyle}`;
    if (inspector.dataset.renderKey !== emptyKey) {
      inspector.innerHTML = state.selectedWire
        ? `<div class="inspector-content"><p class="eyebrow">Inspector</p><div class="inspector-icon">⌁</div><h2>Connection</h2><p>Signal wire between two components.</p><button class="delete-selection">Delete connection</button></div>`
        : `<div class="inspector-empty"><span class="selection-glyph">◇</span><strong>Workspace settings</strong><p>Select a component or connection to see its details.</p><fieldset class="wire-style-control"><legend>Wire style</legend><label><input type="radio" name="wire-style" value="orthogonal"${state.wireStyle === 'orthogonal' ? ' checked' : ''}><span>Orthogonal</span></label><label><input type="radio" name="wire-style" value="curved"${state.wireStyle === 'curved' ? ' checked' : ''}><span>Curved</span></label></fieldset></div>`;
      inspector.querySelector('.delete-selection')?.addEventListener('click', removeSelection);
      for (const input of inspector.querySelectorAll('input[name="wire-style"]')) input.addEventListener('change', event => { if (!event.target.checked) return; state.wireStyle = event.target.value; inspector.dataset.renderKey = ''; renderWires(); renderInspector(); persistWorkspace(); });
    }
    inspector.dataset.renderKey = emptyKey; return;
  }
  const def = COMPONENTS[node.type];
  const structuralKey = `${objectToken(node)}|${node.type}|${node.label}`;
  if (inspector.dataset.renderKey !== structuralKey) {
    const connectionDescription = `${def.inputs} input${def.inputs === 1 ? '' : 's'}, ${def.outputs} output${def.outputs === 1 ? '' : 's'}.`;
    inspector.innerHTML = `<div class="inspector-content"><p class="eyebrow">Inspector</p><div class="inspector-icon">${def.symbol}</div><h2>${def.label}</h2><p>${def.detail}. ${connectionDescription}</p><label class="field"><span>Label</span><input id="node-label" value="${escapeHtml(node.label)}" /></label><div class="signal-readout"><span>Output signal</span><b></b></div><button class="delete-node">Remove component</button></div>`;
    inspector.querySelector('#node-label').addEventListener('change', event => { checkpoint(); node.label = event.target.value.trim() || def.label; simulateAndRender(); });
    inspector.querySelector('.delete-node').addEventListener('click', removeSelection);
    inspector.dataset.renderKey = structuralKey;
  }
  const readout = inspector.querySelector('.signal-readout b'); readout.classList.toggle('on', Boolean(node.outputs?.[0])); readout.textContent = node.outputs?.[0] ? 'HIGH · 1' : 'LOW · 0';
}

function preparePropagation() {
  try {
    initializeNodeState(state.nodes);
    state.evaluatedNodes = new Set();
    const seeds = propagationSeeds(state.nodes, state.wires);
    state.propagationQueue = seeds.length ? [seeds] : [];
    state.simulationError = null;
  } catch (error) {
    state.propagationQueue = [];
    state.simulationError = error instanceof Error ? error.message : 'The circuit could not be simulated.';
  }
}

function simulateAndRender() {
  preparePropagation();
  render();
}
function applyViewportTransform() {
  const transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  nodesLayer.style.transform = transform;
  $('#wires').style.transform = transform;
  workspace.style.backgroundPosition = `${state.panX}px ${state.panY}px`;
}
function render() {
  applyViewportTransform();
  renderNodes(); renderWires(); renderInspector(); renderTabs(); $('#empty-state').hidden = state.nodes.length > 0;
  setTextIfChanged($('#node-count'), `${state.nodes.length} component${state.nodes.length === 1 ? '' : 's'}`); setTextIfChanged($('#wire-count'), `${state.wires.length} wire${state.wires.length === 1 ? '' : 's'}`); setTextIfChanged($('#zoom-label'), `${Math.round(state.zoom * 100)}%`);
  const errorTip = $('#simulation-error'); errorTip.hidden = !state.simulationError; errorTip.textContent = state.simulationError ? `Simulation paused: ${state.simulationError}` : '';
  const stats = $('.sim-stats'); stats.classList.toggle('error', Boolean(state.simulationError)); stats.classList.toggle('paused', !state.isPlaying && !state.simulationError);
  setTextIfChanged($('#simulation-status'), state.simulationError ? 'Simulation error' : state.isPlaying ? 'Simulation running' : 'Simulation paused');
  const toggle = $('#toggle-simulation'); const toggleText = state.isPlaying ? 'Ⅱ' : '▶'; const toggleLabel = state.isPlaying ? 'Pause simulation' : 'Play simulation';
  setTextIfChanged(toggle, toggleText); if (toggle.getAttribute('aria-label') !== toggleLabel) toggle.setAttribute('aria-label', toggleLabel); if (toggle.title !== toggleLabel) toggle.title = toggleLabel;
  updateUndoButtons(); persistWorkspace();
}

function setTextIfChanged(element, value) { if (element.textContent !== value) element.textContent = value; }

function removeSelection() {
  if (!state.selectedNode && !state.selectedWire) return; checkpoint();
  if (state.selectedNode) { state.nodes = state.nodes.filter(n => n.id !== state.selectedNode); state.wires = state.wires.filter(w => w.from.node !== state.selectedNode && w.to.node !== state.selectedNode); }
  if (state.selectedWire) state.wires = state.wires.filter(w => w.id !== state.selectedWire);
  state.selectedNode = null; state.selectedWire = null; simulateAndRender();
}

function setZoom(next) { state.zoom = Math.min(1.6, Math.max(.55, next)); render(); }
function resetZoom() {
  const centerX = (workspace.clientWidth / 2 - state.panX) / state.zoom;
  const centerY = (workspace.clientHeight / 2 - state.panY) / state.zoom;
  state.zoom = 1; state.panX = workspace.clientWidth / 2 - centerX; state.panY = workspace.clientHeight / 2 - centerY; render();
}
function fitCircuit() {
  if (!state.nodes.length) { state.zoom = 1; state.panX = 0; state.panY = 0; render(); return; }
  const bounds = state.nodes.reduce((box, node) => {
    const dimensions = nodeDimensions(node.type);
    return { left: Math.min(box.left, node.x), top: Math.min(box.top, node.y), right: Math.max(box.right, node.x + dimensions.width), bottom: Math.max(box.bottom, node.y + dimensions.height) };
  }, { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
  const padding = 72;
  const width = Math.max(1, bounds.right - bounds.left); const height = Math.max(1, bounds.bottom - bounds.top);
  state.zoom = Math.min(1.6, Math.max(.1, Math.min((workspace.clientWidth - padding * 2) / width, (workspace.clientHeight - padding * 2) / height)));
  state.panX = workspace.clientWidth / 2 - (bounds.left + width / 2) * state.zoom;
  state.panY = workspace.clientHeight / 2 - (bounds.top + height / 2) * state.zoom;
  render();
}
function advanceSimulation() {
  if (!state.nodes.length || state.simulationError) return;
  if (!state.propagationQueue.length) {
    const clocks = state.nodes.filter(node => node.type === 'CLOCK');
    if (!clocks.length) return;
    state.clock = !state.clock; for (const node of clocks) node.value = state.clock;
    state.propagationQueue.push(clocks.map(node => node.id));
  }
  const batch = state.propagationQueue.shift();
  try {
    const result = propagateBatch(state.nodes, state.wires, batch, state.evaluatedNodes);
    if (result.nextNodeIds.length) state.propagationQueue.push(result.nextNodeIds);
    render();
  } catch (error) {
    state.propagationQueue = []; state.simulationError = error instanceof Error ? error.message : 'The circuit could not be simulated.'; render();
  }
}
function toggleSimulation() { state.isPlaying = !state.isPlaying; render(); }
function restartSimulation() {
  state.clock = false; state.propagationQueue = []; state.evaluatedNodes = new Set();
  for (const node of state.nodes) { const def = COMPONENTS[node.type]; node.inputs = Array(def.inputs).fill(false); node.outputs = Array(def.stateSize ?? Math.max(1, def.outputs)).fill(false); if (node.type === 'CLOCK') node.value = false; }
  state.isPlaying = true; preparePropagation(); render();
}
function scheduleClock() { setTimeout(() => { if (state.isPlaying && !state.simulationError) advanceSimulation(); scheduleClock(); }, 1000 / state.clockHz); }
function updateClockSpeed(event, clamp = false) { const value = Number(event.target.value); if (!Number.isFinite(value) || (!clamp && value < 1)) return; state.clockHz = Math.min(100, Math.max(1, value)); if (clamp) event.target.value = state.clockHz; persistWorkspace(); }

function setNamedInputs(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new TypeError('values must be an object keyed by input label');
  const inputs = state.nodes.filter(node => node.type === 'INPUT');
  const changes = Object.entries(values).map(([label, value]) => {
    if (typeof value !== 'boolean') throw new TypeError(`Input ${label} must be true or false`);
    const node = inputs.find(item => item.label.toLowerCase() === label.toLowerCase());
    if (!node) throw new Error(`Unknown input: ${label}`);
    return { node, value };
  });
  checkpoint();
  for (const change of changes) change.node.value = change.value;
  simulateAndRender();
  return changes.map(change => change.node.label);
}

function registerWebMcpTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const register = tool => Promise.resolve(context.registerTool(tool)).catch(() => {});
  register({
    name: 'read_circuit_state', title: 'Read circuit state',
    description: 'Read the visible circuit components, input values, output signals, and wire count.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    execute() { return { name: state.name, components: state.nodes.map(node => ({ label: node.label, type: node.type, signal: Boolean(node.outputs?.[0]), inputValue: node.type === 'INPUT' ? Boolean(node.value) : undefined })), wires: state.wires.length }; },
  });
  register({
    name: 'set_circuit_inputs', title: 'Set circuit inputs',
    description: 'Set one or more visible input switches by their labels and immediately simulate the circuit.',
    inputSchema: { type: 'object', properties: { values: { type: 'object', additionalProperties: { type: 'boolean' } } }, required: ['values'], additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute(input) { const updated = setNamedInputs(input?.values); return { updated, outputs: state.nodes.filter(node => node.type === 'OUTPUT' || node.type === 'LED').map(node => ({ label: node.label, signal: Boolean(node.outputs?.[0]) })) }; },
  });
}

function saveCircuit() {
  const payload = cloneCircuit(); payload.version = 1;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${state.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'circuit'}.json`; a.click(); URL.revokeObjectURL(url); toast('Circuit saved');
}
async function openCircuit(file) {
  try { const data = JSON.parse(await file.text()); if (!Array.isArray(data.nodes) || !Array.isArray(data.wires)) throw new Error(); addCircuitTab({ name: data.name || 'Imported circuit', nodes: data.nodes, wires: data.wires }); toast('Circuit opened in a new tab'); }
  catch { toast('That file is not a valid circuit'); }
}

workspace.addEventListener('pointerdown', event => {
  const isEmptySpace = event.target === workspace || event.target === nodesLayer || event.target.id === 'wires';
  if (!isEmptySpace || event.button !== 0 || state.pending) return;
  event.preventDefault();
  state.selectedNode = null; state.selectedWire = null; renderInspector();
  const start = { x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY };
  workspace.classList.add('panning');
  const move = current => { state.panX = start.panX + current.clientX - start.x; state.panY = start.panY + current.clientY - start.y; applyViewportTransform(); };
  const up = () => { workspace.classList.remove('panning'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); persistWorkspace(); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
});
workspace.addEventListener('dragover', event => { if (!event.dataTransfer.types.includes('application/x-dls-component')) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; workspace.classList.add('drop-ready'); });
workspace.addEventListener('dragleave', event => { if (!workspace.contains(event.relatedTarget)) workspace.classList.remove('drop-ready'); });
workspace.addEventListener('drop', event => {
  event.preventDefault(); workspace.classList.remove('drop-ready');
  const type = event.dataTransfer.getData('application/x-dls-component') || event.dataTransfer.getData('text/plain');
  if (!COMPONENTS[type]) return;
  const rect = workspace.getBoundingClientRect();
  const dimensions = nodeDimensions(type);
  addNode(type, { x: (event.clientX - rect.left - state.panX) / state.zoom - dimensions.width / 2, y: (event.clientY - rect.top - state.panY) / state.zoom - dimensions.height / 2 });
});
workspace.addEventListener('wheel', event => { event.preventDefault(); setZoom(state.zoom + (event.deltaY < 0 ? .08 : -.08)); }, { passive: false });
document.addEventListener('keydown', event => {
  if (event.target.matches('input')) return;
  if (event.key === 'Delete' || event.key === 'Backspace') removeSelection();
  if (event.key === 'Escape') cancelWire();
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
});

$('#search').addEventListener('input', event => buildLibrary(event.target.value));
$('#undo').addEventListener('click', undo); $('#redo').addEventListener('click', redo); $('#save').addEventListener('click', saveCircuit);
$('#open-file').addEventListener('change', event => { if (event.target.files[0]) openCircuit(event.target.files[0]); event.target.value = ''; });
$('#clear').addEventListener('click', () => { if (!state.nodes.length || confirm('Clear this circuit?')) { checkpoint(); state.nodes = []; state.wires = []; state.selectedNode = null; state.selectedWire = null; state.propagationQueue = []; state.evaluatedNodes = new Set(); render(); } });
$('#zoom-in').addEventListener('click', () => setZoom(state.zoom + .1)); $('#zoom-out').addEventListener('click', () => setZoom(state.zoom - .1)); $('#zoom-label').addEventListener('click', resetZoom); $('#fit').addEventListener('click', fitCircuit);
$('#clock-speed').addEventListener('input', event => updateClockSpeed(event));
$('#clock-speed').addEventListener('change', event => updateClockSpeed(event, true));
$('#toggle-simulation').addEventListener('click', toggleSimulation);
$('#restart-simulation').addEventListener('click', restartSimulation);
$('.brand').addEventListener('click', () => { if (innerWidth <= 650) $('.library-panel').classList.toggle('open'); });

$('#clock-speed').value = state.clockHz;
buildLibrary(); simulateAndRender(); registerWebMcpTools(); scheduleClock();
