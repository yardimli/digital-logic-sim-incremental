import { COMPONENTS, initializeNodeState, propagationSeeds, propagateBatch, wireIdsInNet, removeJunction, makeExample, makeCounterExample } from './engine.js';
import { routeWire, orthogonalizePoints, orthogonalPath, curvedPath, directBezierPath, directBezierIsClear, moveOrthogonalSegment } from './router.js';

const $ = selector => document.querySelector(selector);
const appShell = $('.app-shell');
const workspace = $('#workspace');
const nodesLayer = $('#nodes');
const wireLayer = $('#wire-layer');
const junctionLayer = $('#junction-layer');
const draftWire = $('#draft-wire');
const inspector = $('#inspector');
const STORAGE_KEY = 'digital-logic-sim.workspace.v1';
const NODE_WIDTH = 142;
const NODE_HEIGHT = 100;
const GATE_TYPES = new Set(['AND', 'OR', 'NOT', 'NAND', 'NOR', 'XOR', 'XNOR']);
const GATE_SHAPE_TYPES = new Set([...GATE_TYPES, 'BUFFER']);
const COMPACT_TYPES = new Set([...GATE_SHAPE_TYPES, 'INPUT', 'CLOCK', 'D_FLIP_FLOP', 'LED']);
const BARE_TYPES = new Set([...GATE_SHAPE_TYPES, 'INPUT', 'CLOCK', 'LED', 'LED_MATRIX']);
const restoredWorkspace = readStoredWorkspace();
const starter = makeExample();
const initialTabs = restoredWorkspace?.tabs?.length ? restoredWorkspace.tabs : [{ id: uid('tab'), name: starter.name, ...sanitizeCircuitData(starter.nodes, starter.wires, starter.junctions), panX: 0, panY: 0, zoom: 1 }];
for (const tab of initialTabs) initializeNodeState(tab.nodes);
const initialTab = initialTabs.find(tab => tab.id === restoredWorkspace?.activeTabId) || initialTabs[0];
const state = { name: initialTab.name, nodes: initialTab.nodes, wires: initialTab.wires, junctions: initialTab.junctions || [], tabs: initialTabs, activeTabId: initialTab.id, selectedNode: null, selectedWire: null, selectedJunction: null, pending: null, propagationQueue: [], evaluatedNodes: new Set(), clock: false, clockHz: restoredWorkspace?.clockHz || 5, wireStyle: restoredWorkspace?.wireStyle === 'curved' ? 'curved' : 'orthogonal', showLabels: restoredWorkspace?.showLabels !== false, isPlaying: true, simulationError: null, zoom: initialTab.zoom || 1, panX: initialTab.panX || 0, panY: initialTab.panY || 0, history: [], future: [] };
let toastTimer;
const objectTokens = new WeakMap();
let nextObjectToken = 1;
let lastPersistedWorkspace = '';
let wireDragCleanup = null;
let rewiringWireId = null;
let wireRouteLayout = '';
const wireRouteCache = new Map();

function uid(prefix) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`; }
function sanitizeCircuitData(nodes, wires, junctions = []) {
  const cleanNodes = nodes.filter(node => node && COMPONENTS[node.type]).map(node => ({ ...node, x: Number(node.x) || 0, y: Number(node.y) || 0, value: node.type === 'INPUT' || node.type === 'CLOCK' ? Boolean(node.value) : false }));
  const nodeIds = new Set(cleanNodes.map(node => node.id));
  const cleanJunctions = junctions.filter(junction => junction?.id && Number.isFinite(Number(junction.x)) && Number.isFinite(Number(junction.y)) && !Array.isArray(junction.wireIds)).map(junction => ({ id: String(junction.id), x: Number(junction.x), y: Number(junction.y) }));
  const junctionIds = new Set(cleanJunctions.map(junction => junction.id));
  const cleanEndpoint = (endpoint, fallbackSide) => {
    if (endpoint?.junction && junctionIds.has(String(endpoint.junction))) return { junction: String(endpoint.junction) };
    if (!endpoint?.node || !nodeIds.has(endpoint.node)) return null;
    return { node: endpoint.node, pin: Number(endpoint.pin) || 0, side: endpoint.side === 'input' || endpoint.side === 'output' ? endpoint.side : fallbackSide };
  };
  const cleanWires = wires.map(wire => ({ ...wire, id: String(wire?.id || uid('wire')), from: cleanEndpoint(wire?.from, 'output'), to: cleanEndpoint(wire?.to, 'input') })).filter(wire => wire.from && wire.to);
  return { nodes: cleanNodes, wires: cleanWires, junctions: cleanJunctions };
}
function readStoredWorkspace() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!value || !Array.isArray(value.tabs)) return null;
    const tabs = value.tabs.filter(tab => tab && Array.isArray(tab.nodes) && Array.isArray(tab.wires)).map((tab, index) => ({ id: String(tab.id || uid('tab')), name: String(tab.name || `Circuit ${index + 1}`), ...sanitizeCircuitData(tab.nodes, tab.wires, tab.junctions), panX: Number(tab.panX) || 0, panY: Number(tab.panY) || 0, zoom: Number(tab.zoom) || 1 }));
    return tabs.length ? { tabs, activeTabId: value.activeTabId, clockHz: Math.min(100, Math.max(1, Number(value.clockHz) || 5)), wireStyle: value.wireStyle === 'curved' ? 'curved' : 'orthogonal', showLabels: value.showLabels !== false } : null;
  } catch { return null; }
}
function activeTab() { return state.tabs.find(tab => tab.id === state.activeTabId); }
function syncActiveTab() { const tab = activeTab(); if (tab) Object.assign(tab, { name: state.name, nodes: state.nodes, wires: state.wires, junctions: state.junctions, panX: state.panX, panY: state.panY, zoom: state.zoom }); }
function serializableTab(tab) { return { id: tab.id, name: tab.name, panX: tab.panX || 0, panY: tab.panY || 0, zoom: tab.zoom || 1, nodes: tab.nodes.map(node => ({ id: node.id, type: node.type, label: node.label, x: node.x, y: node.y, value: node.type === 'INPUT' || node.type === 'CLOCK' ? Boolean(node.value) : false })), wires: tab.wires, junctions: tab.junctions || [] }; }
function persistWorkspace() {
  try {
    syncActiveTab();
    const serialized = JSON.stringify({ version: 1, activeTabId: state.activeTabId, clockHz: state.clockHz, wireStyle: state.wireStyle, showLabels: state.showLabels, tabs: state.tabs.map(serializableTab) });
    if (serialized !== lastPersistedWorkspace) { localStorage.setItem(STORAGE_KEY, serialized); lastPersistedWorkspace = serialized; }
  } catch { /* Storage can be unavailable in privacy-restricted contexts. */ }
}
function cloneCircuit() { return structuredClone({ name: state.name, nodes: state.nodes, wires: state.wires, junctions: state.junctions }); }
function checkpoint() { state.history.push(cloneCircuit()); if (state.history.length > 50) state.history.shift(); state.future = []; updateUndoButtons(); }
function restore(snapshot) { state.name = snapshot.name; state.nodes = snapshot.nodes; state.wires = snapshot.wires; state.junctions = snapshot.junctions || []; state.selectedNode = null; state.selectedWire = null; state.selectedJunction = null; simulateAndRender(); }
function undo() { if (!state.history.length) return; state.future.push(cloneCircuit()); restore(state.history.pop()); updateUndoButtons(); }
function redo() { if (!state.future.length) return; state.history.push(cloneCircuit()); restore(state.future.pop()); updateUndoButtons(); }
function updateUndoButtons() { $('#undo').disabled = !state.history.length; $('#redo').disabled = !state.future.length; }
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 1800); }

function switchTab(id) {
  if (id === state.activeTabId) return;
  syncActiveTab();
  const tab = state.tabs.find(item => item.id === id); if (!tab) return;
  cancelWire(); state.activeTabId = id; state.name = tab.name; state.nodes = tab.nodes; state.wires = tab.wires; state.junctions = tab.junctions || []; state.panX = tab.panX || 0; state.panY = tab.panY || 0; state.zoom = tab.zoom || 1; state.selectedNode = null; state.selectedWire = null; state.selectedJunction = null; state.propagationQueue = []; state.evaluatedNodes = new Set(); state.history = []; state.future = []; simulateAndRender();
}
function addCircuitTab(circuit = null) {
  syncActiveTab();
  const number = state.tabs.length + 1;
  const cleanCircuit = sanitizeCircuitData(circuit?.nodes || [], circuit?.wires || [], circuit?.junctions || []);
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
  const bufferGate = type === 'BUFFER';
  const body = notGate || bufferGate
    ? '<path class="gate-body" d="M25 8 L94 32 L25 56 Z" />'
    : andFamily
      ? '<path class="gate-body" d="M18 8 H57 C82 8 98 18 98 32 C98 46 82 56 57 56 H18 Z" />'
      : '<path class="gate-body" d="M18 8 C48 8 77 10 99 32 C77 54 48 56 18 56 C31 43 31 21 18 8 Z" />';
  const leads = notGate || bufferGate
    ? `<path class="gate-lead" d="M0 32 H25 M${notGate ? 107 : 94} 32 H120" />`
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
      button.innerHTML = `<span class="component-icon${GATE_SHAPE_TYPES.has(type) ? ' gate-preview' : ''}">${GATE_SHAPE_TYPES.has(type) ? gateSvg(type) : def.symbol}</span><span class="component-copy"><strong>${def.label}</strong><small>${def.detail}</small></span>`;
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
  if (COMPACT_TYPES.has(type)) return { width: 120, height: 88 };
  return { width: def.width || NODE_WIDTH, height: def.height || NODE_HEIGHT };
}

function addNode(type, position = null) {
  if (!COMPONENTS[type]) return;
  checkpoint();
  const centerX = (workspace.clientWidth / 2 - state.panX) / state.zoom;
  const centerY = (workspace.clientHeight / 2 - state.panY) / state.zoom;
  const dimensions = nodeDimensions(type);
  const node = { id: uid('node'), type, label: COMPONENTS[type].label, x: Math.round(position?.x ?? centerX - dimensions.width / 2), y: Math.round(position?.y ?? centerY - dimensions.height / 2), value: false };
  state.nodes.push(node); state.selectedNode = node.id; state.selectedWire = null; state.selectedJunction = null; simulateAndRender();
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
  if (COMPACT_TYPES.has(node.type) && (physicalSide === 'left' || physicalSide === 'right')) {
    if (peers.length === 2) return [45 / 88 * 100, 67 / 88 * 100][position];
    return 56 / 88 * 100;
  }
  if (node.type === 'LED_MATRIX') {
    if (physicalSide === 'left') return [48, 80, 112, 144][position] / 192 * 100;
    if (physicalSide === 'bottom') return [48, 80, 112, 144][position] / 190 * 100;
  }
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
function wireEndpointPosition(endpoint, fallbackSide) {
  if (endpoint?.junction) { const junction = state.junctions.find(item => item.id === endpoint.junction); return junction ? { x: junction.x, y: junction.y, side: null } : null; }
  const node = state.nodes.find(item => item.id === endpoint?.node); if (!node) return null;
  return nodePortPosition(node, endpoint.side || fallbackSide, endpoint.pin || 0);
}
function directionSide(point, other) {
  if (Math.abs(other.x - point.x) >= Math.abs(other.y - point.y)) return other.x >= point.x ? 'right' : 'left';
  return other.y >= point.y ? 'bottom' : 'top';
}
function wireRoute(a, b, endpointNodeIds = []) {
  const endpoints = new Set(endpointNodeIds);
  const nodeObstacles = state.nodes.map(node => { const dimensions = nodeDimensions(node.type); return { id: node.id, left: node.x, top: node.y, right: node.x + dimensions.width, bottom: node.y + dimensions.height }; });
  const obstacles = nodeObstacles.map(({ left, top, right, bottom }) => ({ left, top, right, bottom }));
  const directObstacles = nodeObstacles.filter(obstacle => !endpoints.has(obstacle.id)).map(({ left, top, right, bottom }) => ({ left, top, right, bottom }));
  if (state.wireStyle === 'curved' && directBezierIsClear(a, b, directObstacles, 20)) return { points: [a, b], path: directBezierPath(a, b) };
  const clearance = state.wireStyle === 'curved' ? 30 : 20;
  const points = routeWire(a, b, obstacles, clearance, clearance);
  return { points, path: state.wireStyle === 'curved' ? curvedPath(points) : orthogonalPath(points) };
}
function routeForWire(wire) {
  const start = wireEndpointPosition(wire.from, 'output'); const end = wireEndpointPosition(wire.to, 'input'); if (!start || !end) return null;
  if (!start.side) start.side = directionSide(start, end); if (!end.side) end.side = directionSide(end, start);
  const manual = wire.manualRoutes?.[state.wireStyle];
  if (state.wireStyle === 'curved' && Array.isArray(manual?.points) && manual.points.length >= 2) {
    const points = manual.points.map(point => ({ ...point })); points[0] = start; points[points.length - 1] = end;
    return { points, path: curvedPath(points) };
  }
  if (state.wireStyle === 'curved' && manual?.bend) {
    const points = [start, manual.bend, end]; return { points, path: curvedPath(points) };
  }
  if (state.wireStyle === 'orthogonal' && Array.isArray(manual?.points) && manual.points.length >= 2) {
    const restored = manual.points.map(point => ({ ...point })); restored[0] = start; restored[restored.length - 1] = end;
    const points = orthogonalizePoints(restored);
    return { points, path: orthogonalPath(points) };
  }
  return wireRoute(start, end, [wire.from.node, wire.to.node].filter(Boolean));
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
function nearestPointOnRoute(points, point) {
  const index = nearestSegmentIndex(points, point); const first = points[index]; const second = points[index + 1];
  if (first.x === second.x) return { x: first.x, y: Math.max(Math.min(point.y, Math.max(first.y, second.y)), Math.min(first.y, second.y)) };
  return { x: Math.max(Math.min(point.x, Math.max(first.x, second.x)), Math.min(first.x, second.x)), y: first.y };
}
function splitWireAtPoint(wire, point) {
  const junction = { id: uid('junction'), x: Math.round(point.x), y: Math.round(point.y) };
  const index = state.wires.indexOf(wire); if (index < 0) return null;
  const first = { id: uid('wire'), from: { ...wire.from }, to: { junction: junction.id } };
  const second = { id: uid('wire'), from: { junction: junction.id }, to: { ...wire.to } };
  state.junctions.push(junction);
  state.wires.splice(index, 1, first, second);
  return { junction: junction.id };
}
function objectToken(value) { if (!objectTokens.has(value)) objectTokens.set(value, nextObjectToken++); return objectTokens.get(value); }

function connectedWireIds(wireId) {
  const endpointKey = (endpoint, fallbackSide) => endpoint?.junction ? `j:${endpoint.junction}` : `p:${endpoint?.side || fallbackSide}:${endpoint?.node}:${endpoint?.pin || 0}`;
  const connected = new Set([wireId]); const endpointKeys = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const wire of state.wires) if (connected.has(wire.id)) { endpointKeys.add(endpointKey(wire.from, 'output')); endpointKeys.add(endpointKey(wire.to, 'input')); }
    for (const wire of state.wires) {
      if (connected.has(wire.id) || (!endpointKeys.has(endpointKey(wire.from, 'output')) && !endpointKeys.has(endpointKey(wire.to, 'input')))) continue;
      connected.add(wire.id); changed = true;
    }
  }
  return connected;
}
function wireIsActive(wire) {
  for (const id of connectedWireIds(wire.id)) {
    const member = state.wires.find(item => item.id === id);
    for (const [endpoint, fallbackSide] of [[member?.from, 'output'], [member?.to, 'input']]) {
      if (!endpoint?.node || (endpoint.side || fallbackSide) !== 'output') continue;
      const source = state.nodes.find(node => node.id === endpoint.node); if (source?.outputs?.[endpoint.pin || 0]) return true;
    }
  }
  return false;
}
function pruneJunctions() {
  const used = new Set(state.wires.flatMap(wire => [wire.from.junction, wire.to.junction]).filter(Boolean));
  state.junctions = state.junctions.filter(junction => used.has(junction.id));
}
function renderWireJunctions() {
  const liveIds = new Set(state.junctions.map(junction => junction.id)); const rendered = new Map([...junctionLayer.children].map(circle => [circle.dataset.id, circle]));
  for (const junction of state.junctions) {
    let circle = rendered.get(junction.id);
    if (!circle) {
      circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); circle.dataset.id = junction.id;
      circle.setAttribute('cx', junction.x); circle.setAttribute('cy', junction.y); circle.setAttribute('r', '5'); circle.setAttribute('tabindex', '0'); circle.setAttribute('role', 'button'); circle.setAttribute('aria-label', 'Wire junction'); circle.setAttribute('class', 'wire-junction connected');
      circle.addEventListener('pointerdown', event => { state.selectedJunction = junction.id; state.selectedNode = null; state.selectedWire = null; startWireDrag(event, { junction: junction.id }); });
      junctionLayer.append(circle);
    }
    circle.classList.toggle('selected', state.selectedJunction === junction.id);
    circle.classList.toggle('on', state.wires.some(wire => (wire.from.junction === junction.id || wire.to.junction === junction.id) && wireIsActive(wire)));
  }
  for (const circle of [...junctionLayer.children]) if (!liveIds.has(circle.dataset.id)) circle.remove();
}

function renderWires() {
  const routeLayout = `${state.wireStyle}|${state.nodes.map(node => `${node.id}:${node.type}:${node.x}:${node.y}`).join('|')}|${state.junctions.map(junction => `${junction.id}:${junction.x}:${junction.y}`).join('|')}|${state.wires.map(wire => `${wire.id}:${JSON.stringify(wire.from)}:${JSON.stringify(wire.to)}:${JSON.stringify(wire.manualRoutes || {})}`).join('|')}`;
  if (routeLayout !== wireRouteLayout) { wireRouteLayout = routeLayout; wireRouteCache.clear(); }
  const visibleWires = state.wires.filter(wire => wire.id !== rewiringWireId);
  const liveIds = new Set(visibleWires.map(wire => wire.id));
  for (const child of [...wireLayer.children]) if (!liveIds.has(child.dataset.id)) child.remove();
  const rendered = new Map([...wireLayer.children].map(child => [child.dataset.id, child]));
  for (const wire of visibleWires) {
    const routeKey = `${wire.id}:${JSON.stringify(wire.from)}:${JSON.stringify(wire.to)}`;
    let route = wireRouteCache.get(routeKey);
    if (!route) { route = routeForWire(wire); if (!route) continue; wireRouteCache.set(routeKey, route); }
    const path = route.path;
    const active = wireIsActive(wire);
    let group = rendered.get(wire.id);
    if (!group) {
      group = document.createElementNS('http://www.w3.org/2000/svg', 'g'); group.dataset.id = wire.id;
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path'); hit.setAttribute('class', 'wire-hit');
      hit.addEventListener('pointerdown', event => event.shiftKey ? startJunctionWireDrag(event, wire, group._route) : startWireShapeDrag(event, wire, group._route));
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'path'); line.setAttribute('class', 'wire'); group.append(hit, line); wireLayer.append(group);
    }
    const [hit, line] = group.children;
    if (group.dataset.path !== path) { hit.setAttribute('d', path); line.setAttribute('d', path); group.dataset.path = path; }
    line.classList.toggle('on', active); line.classList.toggle('selected', state.selectedWire === wire.id);
    group._route = route;
  }
  renderWireJunctions();
}

function makePin(node, side, index) {
  const physicalSide = connectorSide(node, side, index);
  const pin = document.createElement('button'); pin.className = `pin ${side} side-${physicalSide}`;
  const label = COMPONENTS[node.type][`${side}Labels`]?.[index] || `${side} ${index + 1}`;
  pin.style.setProperty('--pin-offset', connectorOffset(node, side, index)); pin.setAttribute('aria-label', label); pin.title = label; pin.dataset.side = side; pin.dataset.pin = index;
  if (state.pending?.node === node.id && state.pending?.pin === index && state.pending?.side === side) pin.classList.add('pending');
  pin.addEventListener('pointerdown', event => {
    event.stopPropagation();
    startWireDrag(event, { node: node.id, pin: index, side });
  });
  return pin;
}

function nodeStructuralKey(node) { return [objectToken(node), node.type, node.label].join('|'); }
function nodeIsActive(node) { return node.type === 'INPUT' || node.type === 'CLOCK' ? Boolean(node.value) : node.type === 'LED_MATRIX' ? node.outputs?.some(Boolean) : Boolean(node.outputs?.[0]); }
function setStyleIfChanged(element, property, value) { if (element.style[property] !== value) element.style[property] = value; }
function updateNodeElement(element, node) {
  const active = nodeIsActive(node); const dimensions = nodeDimensions(node.type);
  element.classList.toggle('selected', state.selectedNode === node.id); element.classList.toggle('active', active);
  setStyleIfChanged(element, 'left', `${node.x}px`); setStyleIfChanged(element, 'top', `${node.y}px`); setStyleIfChanged(element, 'width', `${dimensions.width}px`); setStyleIfChanged(element, 'height', `${dimensions.height}px`);
  const value = element.querySelector('.node-value'); if (value) setTextIfChanged(value, active ? 'HIGH · 1' : 'LOW · 0');
  const led = element.querySelector('.led'); const ledLabel = active ? 'On' : 'Off'; if (led && led.getAttribute('aria-label') !== ledLabel) led.setAttribute('aria-label', ledLabel);
  const matrixLeds = element.querySelectorAll('.matrix-led'); for (let index = 0; index < matrixLeds.length; index++) matrixLeds[index].classList.toggle('on', Boolean(node.outputs?.[index]));
  for (const pin of element.querySelectorAll('.pin')) pin.classList.toggle('pending', state.pending?.node === node.id && state.pending?.side === pin.dataset.side && state.pending?.pin === Number(pin.dataset.pin));
}

function createNodeElement(node, structuralKey) {
  const def = COMPONENTS[node.type]; const active = nodeIsActive(node);
  const dimensions = nodeDimensions(node.type);
  const el = document.createElement('article'); el.className = `logic-node${BARE_TYPES.has(node.type) ? ' bare-node' : ''}${COMPACT_TYPES.has(node.type) ? ' compact-node' : ''}${GATE_SHAPE_TYPES.has(node.type) ? ' gate-node' : ''}${node.type === 'LED_MATRIX' ? ' matrix-node' : ''}`; el.style.left = `${node.x}px`; el.style.top = `${node.y}px`; el.style.width = `${dimensions.width}px`; el.style.height = `${dimensions.height}px`; el.dataset.id = node.id; el.dataset.type = node.type; el.dataset.structuralKey = structuralKey;
  let center = `<span class="node-value">${active ? 'HIGH · 1' : 'LOW · 0'}</span>`;
  if (GATE_SHAPE_TYPES.has(node.type)) center = gateSvg(node.type);
  if (node.type === 'INPUT') center = `<div class="source-symbol"><button class="input-toggle" aria-label="Toggle ${escapeHtml(node.label)}" title="Toggle input"></button><span class="component-lead"></span></div>`;
  if (node.type === 'CLOCK') center = '<svg class="clock-symbol" viewBox="0 0 120 64" aria-hidden="true"><path class="clock-wave" d="M20 42 H34 V22 H48 V42 H62 V22 H76 V42 H100 V32"/><path class="component-lead" d="M100 32 H120"/></svg>';
  if (node.type === 'D_FLIP_FLOP') center = '<div class="flip-flop-symbol" aria-hidden="true"><span class="d">D</span><span class="clock-mark">›</span><span class="q">Q</span><span class="qbar">Q</span></div>';
  if (node.type === 'LED') center = `<div class="led-symbol"><span class="component-lead"></span><span class="led" aria-label="${active ? 'On' : 'Off'}"></span></div>`;
  if (node.type === 'LED_MATRIX') center = `<div class="matrix-symbol" role="img" aria-label="4 by 4 LED matrix"><svg class="matrix-leads" viewBox="0 0 190 168" aria-hidden="true"><path d="M0 24 H24 M0 56 H24 M0 88 H24 M0 120 H24 M48 144 V168 M80 144 V168 M112 144 V168 M144 144 V168"/></svg><div class="led-matrix">${Array.from({ length: 16 }, (_, index) => `<span class="matrix-led${node.outputs?.[index] ? ' on' : ''}"></span>`).join('')}</div></div>`;
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
  updateNodeElement(el, node);
  return el;
}

function renderNodes() {
  const liveIds = new Set(state.nodes.map(node => node.id));
  for (const child of [...nodesLayer.children]) if (!liveIds.has(child.dataset.id)) child.remove();
  const rendered = new Map([...nodesLayer.children].map(child => [child.dataset.id, child]));
  for (const node of state.nodes) {
    const structuralKey = nodeStructuralKey(node);
    const current = rendered.get(node.id);
    if (!current) nodesLayer.append(createNodeElement(node, structuralKey));
    else if (current.dataset.structuralKey !== structuralKey) current.replaceWith(createNodeElement(node, structuralKey));
    else updateNodeElement(current, node);
  }
}

function escapeHtml(value) { const span = document.createElement('span'); span.textContent = value; return span.innerHTML; }
function startNodeDrag(event, node) {
  if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); checkpoint(); state.selectedNode = node.id; state.selectedWire = null; state.selectedJunction = null; render();
  const start = { x: event.clientX, y: event.clientY, nx: node.x, ny: node.y };
  let routesCleared = false;
  const move = e => { if (!routesCleared) { for (const wire of state.wires) if (wire.from.node === node.id || wire.to.node === node.id) delete wire.manualRoutes; routesCleared = true; } node.x = Math.round((start.nx + (e.clientX - start.x) / state.zoom) / 6) * 6; node.y = Math.round((start.ny + (e.clientY - start.y) / state.zoom) / 6) * 6; renderNodes(); renderWires(); };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); renderInspector(); persistWorkspace(); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
}

function endpointKey(endpoint, fallbackSide = '') { return endpoint.junction ? `j:${endpoint.junction}` : `p:${endpoint.side || fallbackSide}:${endpoint.node}:${endpoint.pin || 0}`; }
function wireTouchesJunction(wire, junctionId) { return wire.from.junction === junctionId || wire.to.junction === junctionId; }
function startWireShapeDrag(event, wire, route) {
  if (event.button !== 0) return;
  event.preventDefault(); event.stopPropagation();
  const dragHandle = event.currentTarget; dragHandle.setPointerCapture?.(event.pointerId);
  state.selectedWire = wire.id; state.selectedNode = null; state.selectedJunction = null; workspace.classList.add('wire-moving'); renderInspector(); renderWires();
  const origin = workspacePoint(event); const segmentIndex = state.wireStyle === 'orthogonal' ? nearestSegmentIndex(route.points, origin) : -1;
  const originalPoints = route.points.map(point => ({ ...point })); let dragging = false;
  const move = current => {
    current.preventDefault();
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
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
    workspace.classList.remove('wire-moving');
    if (dragHandle.hasPointerCapture?.(event.pointerId)) dragHandle.releasePointerCapture(event.pointerId);
    if (dragging) persistWorkspace();
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
}
function startJunctionWireDrag(event, originWire, route) {
  if (event.button !== 0) return;
  event.preventDefault(); event.stopPropagation(); cancelWire();
  const originPoint = nearestPointOnRoute(route.points, workspacePoint(event));
  state.selectedWire = originWire.id; state.selectedNode = null; state.selectedJunction = null; workspace.classList.add('connecting'); renderInspector(); renderWires();
  let targetElement = null; let targetEndpoint = null; let targetPoint = originPoint;
  const move = current => {
    const pointer = workspacePoint(current); const hit = document.elementFromPoint(current.clientX, current.clientY); const candidate = hit?.closest('.pin, .wire-junction, .wire-hit');
    targetEndpoint = null; targetPoint = pointer;
    if (candidate?.classList.contains('pin')) { const owner = candidate.closest('.logic-node'); targetEndpoint = { node: owner.dataset.id, pin: Number(candidate.dataset.pin), side: candidate.dataset.side }; targetPoint = wireEndpointPosition(targetEndpoint, targetEndpoint.side); }
    else if (candidate?.classList.contains('wire-junction')) { targetEndpoint = { junction: candidate.dataset.id }; targetPoint = wireEndpointPosition(targetEndpoint, 'input'); }
    else if (candidate?.classList.contains('wire-hit')) { const group = candidate.closest('g'); targetPoint = nearestPointOnRoute(group._route.points, pointer); }
    const sameOriginWire = candidate?.classList.contains('wire-hit') && candidate.closest('g').dataset.id === originWire.id;
    const originJunction = targetEndpoint?.junction && wireTouchesJunction(originWire, targetEndpoint.junction);
    const originPin = targetEndpoint?.node && [originWire.from, originWire.to].some(endpoint => endpoint.node && endpointKey(endpoint) === endpointKey(targetEndpoint));
    if (sameOriginWire || originJunction || originPin) { targetEndpoint = null; targetPoint = pointer; }
    const previewStart = { ...originPoint, side: directionSide(originPoint, targetPoint) }; const previewEnd = { ...targetPoint, side: targetPoint.side || directionSide(targetPoint, originPoint) };
    draftWire.setAttribute('d', wireRoute(previewStart, previewEnd, [targetEndpoint?.node].filter(Boolean)).path);
    const validTarget = candidate && !sameOriginWire && !originJunction && !originPin ? candidate : null;
    if (validTarget !== targetElement) { targetElement?.classList.remove('drop-target'); targetElement = validTarget; targetElement?.classList.add('drop-target'); }
  };
  const up = current => {
    move(current); const destination = targetElement; wireDragCleanup?.(); wireDragCleanup = null;
    if (!destination || (!targetEndpoint && !destination.classList.contains('wire-hit'))) { cancelWire(); return; }
    const destinationWire = destination.classList.contains('wire-hit') ? state.wires.find(item => item.id === destination.closest('g').dataset.id) : null;
    if (destinationWire?.id === originWire.id) { cancelWire(); return; }
    checkpoint();
    const originEndpoint = splitWireAtPoint(originWire, originPoint);
    if (destinationWire) targetEndpoint = splitWireAtPoint(destinationWire, targetPoint);
    if (!originEndpoint || !targetEndpoint) { cancelWire(); return; }
    state.wires.push({ id: uid('wire'), from: { ...originEndpoint }, to: { ...targetEndpoint } });
    state.selectedWire = null; state.selectedJunction = originEndpoint.junction; cancelWire(); simulateAndRender();
  };
  wireDragCleanup = () => { targetElement?.classList.remove('drop-target'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancelWire); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancelWire);
}
function startWireDrag(event, originEndpoint) {
  if (event.button !== 0) return;
  event.preventDefault(); event.stopPropagation(); cancelWire(); state.pending = { ...originEndpoint }; state.selectedWire = null;
  if (originEndpoint.junction) { state.selectedJunction = originEndpoint.junction; state.selectedNode = null; }
  else { state.selectedJunction = null; state.selectedNode = originEndpoint.node; }
  workspace.classList.add('connecting'); renderNodes(); renderWires(); renderInspector();
  const origin = wireEndpointPosition(originEndpoint, originEndpoint.side || 'output'); if (!origin) { cancelWire(); return; }
  const excludedWireIds = originEndpoint.junction ? wireIdsInNet(state.wires, originEndpoint) : new Set();
  const excludedJunctionIds = new Set(); const excludedPinKeys = new Set();
  for (const wire of state.wires) if (excludedWireIds.has(wire.id)) for (const endpoint of [wire.from, wire.to]) {
    if (endpoint.junction) excludedJunctionIds.add(endpoint.junction); else excludedPinKeys.add(endpointKey(endpoint));
  }
  let targetElement = null; let targetEndpoint = null; let targetPoint = null;
  const move = current => {
    const rect = workspace.getBoundingClientRect(); const pointer = { x: (current.clientX - rect.left - state.panX) / state.zoom, y: (current.clientY - rect.top - state.panY) / state.zoom };
    const hit = document.elementFromPoint(current.clientX, current.clientY); const candidate = hit?.closest('.pin, .wire-junction, .wire-hit');
    targetEndpoint = null; targetPoint = pointer;
    if (candidate?.classList.contains('pin')) { const owner = candidate.closest('.logic-node'); targetEndpoint = { node: owner.dataset.id, pin: Number(candidate.dataset.pin), side: candidate.dataset.side }; targetPoint = wireEndpointPosition(targetEndpoint, targetEndpoint.side); }
    else if (candidate?.classList.contains('wire-junction')) { targetEndpoint = { junction: candidate.dataset.id }; targetPoint = wireEndpointPosition(targetEndpoint, 'input'); }
    else if (candidate?.classList.contains('wire-hit')) { const group = candidate.closest('g'); targetPoint = nearestPointOnRoute(group._route.points, pointer); }
    const candidateWireId = candidate?.classList.contains('wire-hit') ? candidate.closest('g').dataset.id : null;
    const sameNetWire = candidateWireId && excludedWireIds.has(candidateWireId);
    const sameNetJunction = targetEndpoint?.junction && excludedJunctionIds.has(targetEndpoint.junction);
    const sameNetPin = targetEndpoint?.node && excludedPinKeys.has(endpointKey(targetEndpoint));
    const invalidTarget = sameNetWire || sameNetJunction || sameNetPin || (targetEndpoint && endpointKey(targetEndpoint) === endpointKey(originEndpoint));
    if (invalidTarget) { targetEndpoint = null; targetPoint = pointer; }
    const previewStart = { ...origin, side: origin.side || directionSide(origin, targetPoint) }; const previewEnd = { ...targetPoint, side: targetPoint.side || directionSide(targetPoint, origin) };
    draftWire.setAttribute('d', wireRoute(previewStart, previewEnd, [originEndpoint.node, targetEndpoint?.node].filter(Boolean)).path);
    const validTarget = invalidTarget ? null : candidate;
    if (validTarget !== targetElement) { targetElement?.classList.remove('drop-target'); targetElement = validTarget; targetElement?.classList.add('drop-target'); }
  };
  const up = current => {
    move(current); const destination = targetElement;
    wireDragCleanup?.(); wireDragCleanup = null;
    if (!destination || (!targetEndpoint && !destination.classList.contains('wire-hit'))) { cancelWire(); return; }
    const destinationWireId = destination.classList.contains('wire-hit') ? destination.closest('g').dataset.id : null;
    if (destinationWireId && excludedWireIds.has(destinationWireId)) { cancelWire(); return; }
    checkpoint();
    if (destination.classList.contains('wire-hit')) { const wire = state.wires.find(item => item.id === destinationWireId); targetEndpoint = wire && splitWireAtPoint(wire, targetPoint); }
    if (!targetEndpoint || endpointKey(targetEndpoint) === endpointKey(originEndpoint)) { cancelWire(); return; }
    const duplicate = state.wires.some(wire => (endpointKey(wire.from, 'output') === endpointKey(originEndpoint) && endpointKey(wire.to, 'input') === endpointKey(targetEndpoint)) || (endpointKey(wire.to, 'input') === endpointKey(originEndpoint) && endpointKey(wire.from, 'output') === endpointKey(targetEndpoint)));
    if (!duplicate) state.wires.push({ id: uid('wire'), from: { ...originEndpoint }, to: { ...targetEndpoint } });
    cancelWire(); simulateAndRender();
  };
  wireDragCleanup = () => { targetElement?.classList.remove('drop-target'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancelWire); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancelWire);
}
function cancelWire() { wireDragCleanup?.(); wireDragCleanup = null; rewiringWireId = null; state.pending = null; draftWire.setAttribute('d', ''); workspace.classList.remove('connecting'); renderNodes(); renderWires(); }

function renderInspector() {
  const node = state.nodes.find(n => n.id === state.selectedNode);
  if (!node) {
    const junctionHint = `<div class="inspector-hint"><kbd>Shift</kbd><span>Drag from a wire to create a junction</span></div>`;
    const emptyKey = state.selectedJunction ? `junction:${state.selectedJunction}` : state.selectedWire ? `wire:${state.selectedWire}` : `empty:${state.wireStyle}:${state.showLabels}`;
    if (inspector.dataset.renderKey !== emptyKey) {
      inspector.innerHTML = state.selectedJunction
        ? `<div class="inspector-content"><p class="eyebrow">Inspector</p><h2>Junction</h2><p>Connection point between wires or component pins.</p>${junctionHint}<button class="delete-selection">Delete junction</button></div>`
        : state.selectedWire
        ? `<div class="inspector-content"><p class="eyebrow">Inspector</p><h2>Connection</h2><p>Signal wire between two components.</p>${junctionHint}<button class="delete-selection">Delete connection</button></div>`
        : `<div class="inspector-empty"><span class="selection-glyph">◇</span><strong>Workspace settings</strong><p>Select a component or connection to see its details.</p>${junctionHint}<fieldset class="wire-style-control"><legend>Wire style</legend><label><input type="radio" name="wire-style" value="orthogonal"${state.wireStyle === 'orthogonal' ? ' checked' : ''}><span>Orthogonal</span></label><label><input type="radio" name="wire-style" value="curved"${state.wireStyle === 'curved' ? ' checked' : ''}><span>Curved</span></label></fieldset><label class="workspace-toggle"><span class="workspace-toggle-copy"><b>Component labels</b><small>Show labels on the workspace</small></span><input id="show-labels" type="checkbox"${state.showLabels ? ' checked' : ''}><i aria-hidden="true"></i></label><button id="beautify-workspace" class="beautify-workspace">Beautify</button></div>`;
      inspector.querySelector('.delete-selection')?.addEventListener('click', removeSelection);
      inspector.querySelector('#beautify-workspace')?.addEventListener('click', beautifyCircuit);
      inspector.querySelector('#show-labels')?.addEventListener('change', event => { state.showLabels = event.target.checked; workspace.classList.toggle('labels-hidden', !state.showLabels); inspector.dataset.renderKey = `empty:${state.wireStyle}:${state.showLabels}`; persistWorkspace(); });
      for (const input of inspector.querySelectorAll('input[name="wire-style"]')) input.addEventListener('change', event => { if (!event.target.checked) return; state.wireStyle = event.target.value; inspector.dataset.renderKey = ''; renderWires(); renderInspector(); persistWorkspace(); });
    }
    inspector.dataset.renderKey = emptyKey; return;
  }
  const def = COMPONENTS[node.type];
  const structuralKey = `${objectToken(node)}|${node.type}|${node.label}`;
  if (inspector.dataset.renderKey !== structuralKey) {
    const connectionDescription = `${def.inputs} input${def.inputs === 1 ? '' : 's'}, ${def.outputs} output${def.outputs === 1 ? '' : 's'}.`;
    const statusControl = node.type === 'CLOCK'
      ? `<label class="field"><span>Clock speed</span><span class="clock-input inspector-clock-input"><input id="inspector-clock-speed" type="number" min="1" max="100" step="1" value="${state.clockHz}" aria-label="Clock speed in hertz"><b>Hz</b></span></label>`
      : `<div class="signal-readout"><span>Output signal</span><b></b></div>`;
    inspector.innerHTML = `<div class="inspector-content"><p class="eyebrow">Inspector</p><h2>${def.label}</h2><p>${def.detail}. ${connectionDescription}</p><label class="field"><span>Label</span><input id="node-label" value="${escapeHtml(node.label)}" /></label>${statusControl}<button class="delete-node">Remove component</button></div>`;
    inspector.querySelector('#node-label').addEventListener('change', event => { checkpoint(); node.label = event.target.value.trim() || def.label; simulateAndRender(); });
    const clockSpeed = inspector.querySelector('#inspector-clock-speed');
    clockSpeed?.addEventListener('input', event => updateClockSpeed(event));
    clockSpeed?.addEventListener('change', event => updateClockSpeed(event, true));
    inspector.querySelector('.delete-node').addEventListener('click', removeSelection);
    inspector.dataset.renderKey = structuralKey;
  }
  const readout = inspector.querySelector('.signal-readout b');
  if (readout) { readout.classList.toggle('on', Boolean(node.outputs?.[0])); readout.textContent = node.outputs?.[0] ? 'HIGH · 1' : 'LOW · 0'; }
}

function preparePropagation() {
  try {
    initializeNodeState(state.nodes);
    state.evaluatedNodes = new Set();
    const seeds = propagationSeeds(state.nodes, state.wires, state.junctions);
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
  if (nodesLayer.style.transform !== transform) nodesLayer.style.transform = transform;
  const wires = $('#wires'); if (wires.style.transform !== transform) wires.style.transform = transform;
  const backgroundPosition = `${state.panX}px ${state.panY}px`; if (workspace.style.backgroundPosition !== backgroundPosition) workspace.style.backgroundPosition = backgroundPosition;
}
function render() {
  applyViewportTransform();
  workspace.classList.toggle('labels-hidden', !state.showLabels);
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
  if (!state.selectedNode && !state.selectedWire && !state.selectedJunction) return; checkpoint();
  if (state.selectedNode) { state.nodes = state.nodes.filter(n => n.id !== state.selectedNode); state.wires = state.wires.filter(w => w.from.node !== state.selectedNode && w.to.node !== state.selectedNode); }
  if (state.selectedWire) state.wires = state.wires.filter(w => w.id !== state.selectedWire);
  if (state.selectedJunction) {
    const collapsed = removeJunction(state.wires, state.junctions, state.selectedJunction, uid('wire'));
    state.wires = collapsed.wires; state.junctions = collapsed.junctions;
  }
  pruneJunctions();
  state.selectedNode = null; state.selectedWire = null; state.selectedJunction = null; simulateAndRender();
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
function beautifyRoutes() {
  const obstacles = state.nodes.map(node => { const dimensions = nodeDimensions(node.type); return { left: node.x, top: node.y, right: node.x + dimensions.width, bottom: node.y + dimensions.height }; });
  const occupied = []; const routes = new Map();
  for (const wire of state.wires) {
    const start = wireEndpointPosition(wire.from, 'output'); const end = wireEndpointPosition(wire.to, 'input'); if (!start || !end) continue;
    if (!start.side) start.side = directionSide(start, end); if (!end.side) end.side = directionSide(end, start);
    const clearance = state.wireStyle === 'curved' ? 30 : 20; const points = routeWire(start, end, obstacles, clearance, clearance, occupied);
    routes.set(wire.id, points);
    for (let index = 1; index < points.length; index++) occupied.push({ a: points[index - 1], b: points[index] });
  }
  return routes;
}
function parallelSegmentOverlap(firstStart, firstEnd, secondStart, secondEnd) {
  const firstHorizontal = firstStart.y === firstEnd.y; const secondHorizontal = secondStart.y === secondEnd.y;
  if (firstHorizontal !== secondHorizontal || (firstHorizontal ? firstStart.y !== secondStart.y : firstStart.x !== secondStart.x)) return 0;
  const firstMin = firstHorizontal ? Math.min(firstStart.x, firstEnd.x) : Math.min(firstStart.y, firstEnd.y);
  const firstMax = firstHorizontal ? Math.max(firstStart.x, firstEnd.x) : Math.max(firstStart.y, firstEnd.y);
  const secondMin = secondHorizontal ? Math.min(secondStart.x, secondEnd.x) : Math.min(secondStart.y, secondEnd.y);
  const secondMax = secondHorizontal ? Math.max(secondStart.x, secondEnd.x) : Math.max(secondStart.y, secondEnd.y);
  return Math.max(0, Math.min(firstMax, secondMax) - Math.max(firstMin, secondMin));
}
function routeOverlapReport(routes) {
  let score = 0; const nodeIds = new Set();
  for (let firstIndex = 0; firstIndex < state.wires.length; firstIndex++) {
    const firstWire = state.wires[firstIndex]; const firstRoute = routes.get(firstWire.id); if (!firstRoute) continue;
    for (let secondIndex = firstIndex + 1; secondIndex < state.wires.length; secondIndex++) {
      const secondWire = state.wires[secondIndex]; const secondRoute = routes.get(secondWire.id); if (!secondRoute) continue;
      const sharedEndpoint = [firstWire.from, firstWire.to].some(firstEndpoint => [secondWire.from, secondWire.to].some(secondEndpoint => endpointKey(firstEndpoint) === endpointKey(secondEndpoint)));
      if (sharedEndpoint) continue;
      let pairOverlap = 0;
      for (let firstSegment = 1; firstSegment < firstRoute.length; firstSegment++) for (let secondSegment = 1; secondSegment < secondRoute.length; secondSegment++) pairOverlap += parallelSegmentOverlap(firstRoute[firstSegment - 1], firstRoute[firstSegment], secondRoute[secondSegment - 1], secondRoute[secondSegment]);
      if (!pairOverlap) continue;
      score += pairOverlap;
      for (const endpoint of [firstWire.from, firstWire.to, secondWire.from, secondWire.to]) if (endpoint.node) nodeIds.add(endpoint.node);
    }
  }
  return { score, nodeIds };
}
function nodePositionIsClear(candidate) {
  const dimensions = nodeDimensions(candidate.type); const bounds = { left: candidate.x - 8, top: candidate.y - 8, right: candidate.x + dimensions.width + 8, bottom: candidate.y + dimensions.height + 8 };
  return state.nodes.every(node => {
    if (node === candidate) return true;
    const other = nodeDimensions(node.type);
    return bounds.right <= node.x || bounds.left >= node.x + other.width || bounds.bottom <= node.y || bounds.top >= node.y + other.height;
  });
}
function beautifyCircuit() {
  if (!state.nodes.length) { toast('Add components before beautifying'); return; }
  checkpoint();
  const originalPositions = new Map(state.nodes.map(node => [node.id, { x: node.x, y: node.y }]));
  let routes = beautifyRoutes(); let report = routeOverlapReport(routes); let componentsMoved = false;
  const shifts = [{ x: 0, y: -12 }, { x: 0, y: 12 }, { x: -12, y: 0 }, { x: 12, y: 0 }, { x: 0, y: -24 }, { x: 0, y: 24 }, { x: -24, y: 0 }, { x: 24, y: 0 }];
  for (let attempt = 0; attempt < 4 && report.score > 0; attempt++) {
    let best = null;
    for (const nodeId of report.nodeIds) {
      const node = state.nodes.find(item => item.id === nodeId); const original = originalPositions.get(nodeId); if (!node || !original) continue;
      const current = { x: node.x, y: node.y };
      for (const shift of shifts) {
        const nextX = current.x + shift.x; const nextY = current.y + shift.y;
        if (Math.abs(nextX - original.x) > 24 || Math.abs(nextY - original.y) > 24) continue;
        node.x = nextX; node.y = nextY;
        if (nodePositionIsClear(node)) {
          const candidateRoutes = beautifyRoutes(); const candidateReport = routeOverlapReport(candidateRoutes);
          if (candidateReport.score < report.score && (!best || candidateReport.score < best.report.score)) best = { node, x: nextX, y: nextY, routes: candidateRoutes, report: candidateReport };
        }
        node.x = current.x; node.y = current.y;
      }
    }
    if (!best) break;
    best.node.x = best.x; best.node.y = best.y; routes = best.routes; report = best.report; componentsMoved = true;
  }
  for (const wire of state.wires) { delete wire.manualRoutes; const points = routes.get(wire.id); if (points) wire.manualRoutes = { [state.wireStyle]: { points } }; }
  wireRouteLayout = ''; preparePropagation(); render(); toast(componentsMoved ? 'Wires beautified with small component adjustments' : 'Wires beautified');
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
    const result = propagateBatch(state.nodes, state.wires, batch, state.evaluatedNodes, state.junctions);
    if (result.nextNodeIds.length) state.propagationQueue.push(result.nextNodeIds);
    render();
  } catch (error) {
    state.propagationQueue = []; state.simulationError = error instanceof Error ? error.message : 'The circuit could not be simulated.'; render();
  }
}
function toggleSimulation() { state.isPlaying = !state.isPlaying; render(); }
function restartSimulation() {
  state.clock = false; state.propagationQueue = []; state.evaluatedNodes = new Set();
  for (const node of state.nodes) { const def = COMPONENTS[node.type]; node.inputs = Array(def.inputs).fill(false); node.outputs = node.type === 'D_FLIP_FLOP' ? [false, true] : Array(def.stateSize ?? Math.max(1, def.outputs)).fill(false); if (node.type === 'CLOCK') node.value = false; }
  state.isPlaying = true; preparePropagation(); render();
}
function scheduleClock() { setTimeout(() => { if (state.isPlaying && !state.simulationError) advanceSimulation(); scheduleClock(); }, 1000 / state.clockHz); }
function updateClockSpeed(event, clamp = false) {
  const value = Number(event.target.value);
  if (!Number.isFinite(value) || (!clamp && value < 1)) return;
  state.clockHz = Math.min(100, Math.max(1, value));
  for (const input of document.querySelectorAll('#clock-speed, #inspector-clock-speed')) if (input !== event.target || clamp) input.value = state.clockHz;
  persistWorkspace();
}

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
    execute(input) { const updated = setNamedInputs(input?.values); return { updated, outputs: state.nodes.filter(node => node.type === 'LED').map(node => ({ label: node.label, signal: Boolean(node.outputs?.[0]) })) }; },
  });
}

function saveCircuit() {
  const payload = cloneCircuit(); payload.version = 1;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${state.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'circuit'}.json`; a.click(); URL.revokeObjectURL(url); toast('Circuit saved');
}
async function openCircuit(file) {
  try { const data = JSON.parse(await file.text()); if (!Array.isArray(data.nodes) || !Array.isArray(data.wires)) throw new Error(); addCircuitTab({ name: data.name || 'Imported circuit', nodes: data.nodes, wires: data.wires, junctions: data.junctions || [] }); toast('Circuit opened in a new tab'); }
  catch { toast('That file is not a valid circuit'); }
}

workspace.addEventListener('pointerdown', event => {
  const isEmptySpace = event.target === workspace || event.target === nodesLayer || event.target.id === 'wires';
  if (!isEmptySpace || event.button !== 0 || state.pending) return;
  event.preventDefault();
  state.selectedNode = null; state.selectedWire = null; state.selectedJunction = null; renderInspector();
  const start = { x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY };
  workspace.classList.add('panning');
  const move = current => { state.panX = start.panX + current.clientX - start.x; state.panY = start.panY + current.clientY - start.y; applyViewportTransform(); };
  const up = () => { workspace.classList.remove('panning'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); persistWorkspace(); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
});
workspace.addEventListener('dblclick', event => {
  if (innerWidth <= 650 || event.target.closest('.logic-node, .wire, .wire-junction, .canvas-actions, button, input, select')) return;
  event.preventDefault();
  appShell.classList.toggle('panels-collapsed');
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
$('#examples').addEventListener('change', event => {
  const factories = { 'half-adder': makeExample, '4-bit-counter': makeCounterExample };
  const factory = factories[event.target.value]; event.target.value = '';
  if (!factory) return;
  addCircuitTab(factory()); fitCircuit(); toast('Example opened in a new tab');
});
$('#undo').addEventListener('click', undo); $('#redo').addEventListener('click', redo); $('#save').addEventListener('click', saveCircuit);
$('#open-file').addEventListener('change', event => { if (event.target.files[0]) openCircuit(event.target.files[0]); event.target.value = ''; });
$('#clear').addEventListener('click', () => { if (!state.nodes.length || confirm('Clear this circuit?')) { checkpoint(); state.nodes = []; state.wires = []; state.junctions = []; state.selectedNode = null; state.selectedWire = null; state.selectedJunction = null; state.propagationQueue = []; state.evaluatedNodes = new Set(); render(); } });
$('#zoom-in').addEventListener('click', () => setZoom(state.zoom + .1)); $('#zoom-out').addEventListener('click', () => setZoom(state.zoom - .1)); $('#zoom-label').addEventListener('click', resetZoom); $('#fit').addEventListener('click', fitCircuit);
$('#clock-speed').addEventListener('input', event => updateClockSpeed(event));
$('#clock-speed').addEventListener('change', event => updateClockSpeed(event, true));
$('#toggle-simulation').addEventListener('click', toggleSimulation);
$('#restart-simulation').addEventListener('click', restartSimulation);
$('.brand').addEventListener('click', () => { if (innerWidth <= 650) $('.library-panel').classList.toggle('open'); });

$('#clock-speed').value = state.clockHz;
buildLibrary(); simulateAndRender(); registerWebMcpTools(); scheduleClock();
