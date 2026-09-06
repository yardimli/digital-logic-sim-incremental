export const COMPONENTS = {
  INPUT:  { category: 'Sources', label: 'Input',  symbol: 'IN',  detail: 'Toggle switch', hint: 'Click the switch to set a steady LOW (0) or HIGH (1) signal.', inputs: 0, outputs: 1 },
  CLOCK:  { category: 'Sources', label: 'Clock',  symbol: 'CLK', detail: 'Pulse source', hint: 'Alternates between LOW and HIGH once per complete simulation cycle.', inputs: 0, outputs: 1 },
  AND:    { category: 'Logic gates', label: 'AND',  symbol: '&',  detail: 'Both inputs high', hint: 'Outputs HIGH only when A and B are both HIGH.', inputs: 2, outputs: 1 },
  OR:     { category: 'Logic gates', label: 'OR',   symbol: '≥1', detail: 'Either input high', hint: 'Outputs HIGH when A, B, or both inputs are HIGH.', inputs: 2, outputs: 1 },
  NOT:    { category: 'Logic gates', label: 'NOT',  symbol: '¬',  detail: 'Invert signal', hint: 'Outputs the opposite of A: LOW becomes HIGH and HIGH becomes LOW.', inputs: 1, outputs: 1 },
  NAND:   { category: 'Logic gates', label: 'NAND', symbol: '¬&', detail: 'Inverted AND', hint: 'Outputs LOW only when A and B are both HIGH.', inputs: 2, outputs: 1 },
  NOR:    { category: 'Logic gates', label: 'NOR',  symbol: '¬≥1', detail: 'Inverted OR', hint: 'Outputs HIGH only when A and B are both LOW.', inputs: 2, outputs: 1 },
  XOR:    { category: 'Logic gates', label: 'XOR',  symbol: '=1', detail: 'Inputs differ', hint: 'Outputs HIGH when exactly one input is HIGH.', inputs: 2, outputs: 1 },
  XNOR:   { category: 'Logic gates', label: 'XNOR', symbol: '≡',  detail: 'Inputs match', hint: 'Outputs HIGH when A and B have the same value.', inputs: 2, outputs: 1 },
  BUFFER: { category: 'Routing', label: 'Buffer', symbol: '▷', detail: 'Pass signal', hint: 'Passes the input signal through without changing it.', inputs: 1, outputs: 1 },
  D_FLIP_FLOP: { category: 'Memory', label: 'D Flip-Flop', symbol: 'DFF', detail: 'Rising-edge memory', hint: 'Copies D to Q on each rising clock edge. Q̅ always carries the opposite value.', inputs: 2, outputs: 2, inputLabels: ['D', 'CLK'], outputLabels: ['Q', 'Q̅'] },
  LED:    { category: 'Outputs', label: 'LED',    symbol: '●', detail: 'Light indicator', hint: 'Lights when its input signal is HIGH.', inputs: 1, outputs: 0 },
  LED_MATRIX: { category: 'Displays', label: '4×4 LED Matrix', symbol: '▦', detail: 'Row and column display', hint: 'The four left inputs select rows and the four bottom inputs select columns. An LED lights where a HIGH row and HIGH column meet.', inputs: 8, outputs: 0, stateSize: 16, width: 190, height: 192, inputSides: ['left', 'left', 'left', 'left', 'bottom', 'bottom', 'bottom', 'bottom'] },
};

export function evaluate(type, inputs, sourceValue = false, previousOutputs = [], previousInputs = []) {
  switch (type) {
    case 'INPUT': return [Boolean(sourceValue)];
    case 'CLOCK': return [Boolean(sourceValue)];
    case 'AND': return [Boolean(inputs[0] && inputs[1])];
    case 'OR': return [Boolean(inputs[0] || inputs[1])];
    case 'XOR': return [Boolean(inputs[0]) !== Boolean(inputs[1])];
    case 'NOT': return [!inputs[0]];
    case 'NAND': return [!(inputs[0] && inputs[1])];
    case 'NOR': return [!(inputs[0] || inputs[1])];
    case 'XNOR': return [Boolean(inputs[0]) === Boolean(inputs[1])];
    case 'BUFFER': return [Boolean(inputs[0])];
    case 'D_FLIP_FLOP': {
      const previousQ = Boolean(previousOutputs[0]);
      const risingEdge = !Boolean(previousInputs[1]) && Boolean(inputs[1]);
      const q = risingEdge ? Boolean(inputs[0]) : previousQ;
      return [q, !q];
    }
    case 'LED': return [Boolean(inputs[0])];
    case 'LED_MATRIX': return Array.from({ length: 16 }, (_, index) => Boolean(inputs[Math.floor(index / 4)] && inputs[4 + (index % 4)]));
    default: return [false];
  }
}

export function initializeNodeState(nodes) {
  for (const node of nodes) {
    const def = COMPONENTS[node.type];
    if (!Array.isArray(node.inputs) || node.inputs.length !== def.inputs) node.inputs = Array(def.inputs).fill(false);
    const outputCount = def.stateSize ?? Math.max(1, def.outputs);
    if (!Array.isArray(node.outputs) || node.outputs.length !== outputCount) node.outputs = node.type === 'D_FLIP_FLOP' ? [false, true] : Array(outputCount).fill(false);
  }
  return nodes;
}

export function resolveWireConnections(wires, junctions = []) {
  const parent = new Map(); const endpoints = new Map();
  const endpointKey = (endpoint, fallbackSide) => endpoint?.junction ? `j:${endpoint.junction}` : `p:${endpoint?.side || fallbackSide}:${endpoint?.node}:${endpoint?.pin || 0}`;
  const add = (endpoint, fallbackSide) => { const key = endpointKey(endpoint, fallbackSide); if (!parent.has(key)) parent.set(key, key); if (!endpoints.has(key)) endpoints.set(key, { ...endpoint, side: endpoint?.side || fallbackSide }); return key; };
  const find = id => { let root = id; while (parent.get(root) !== root) root = parent.get(root); while (parent.get(id) !== id) { const next = parent.get(id); parent.set(id, root); id = next; } return root; };
  const join = (a, b) => { const rootA = find(a); const rootB = find(b); if (rootA !== rootB) parent.set(rootB, rootA); };
  for (const wire of wires) join(add(wire.from, 'output'), add(wire.to, 'input'));
  const nets = new Map();
  for (const [key, endpoint] of endpoints) (nets.get(find(key)) || (nets.set(find(key), []), nets.get(find(key)))).push(endpoint);
  const connections = [];
  for (const endpointsInNet of nets.values()) {
    const ports = endpointsInNet.filter(endpoint => endpoint.node);
    const sources = ports.filter(endpoint => endpoint.side === 'output');
    const targets = ports.filter(endpoint => endpoint.side === 'input');
    for (const from of sources) for (const to of targets) connections.push({ from, to });
  }
  return connections;
}

export function wireIdsInNet(wires, originEndpoint) {
  const endpointKey = (endpoint, fallbackSide = '') => endpoint?.junction ? `j:${endpoint.junction}` : `p:${endpoint?.side || fallbackSide}:${endpoint?.node}:${endpoint?.pin || 0}`;
  const endpointKeys = new Set([endpointKey(originEndpoint)]); const wireIds = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const wire of wires) {
      const fromKey = endpointKey(wire.from, 'output'); const toKey = endpointKey(wire.to, 'input');
      if (wireIds.has(wire.id) || (!endpointKeys.has(fromKey) && !endpointKeys.has(toKey))) continue;
      wireIds.add(wire.id); endpointKeys.add(fromKey); endpointKeys.add(toKey); changed = true;
    }
  }
  return wireIds;
}

export function removeJunction(wires, junctions, junctionId, replacementWireId) {
  const touchesJunction = wire => wire.from.junction === junctionId || wire.to.junction === junctionId;
  const incident = wires.filter(touchesJunction);
  const remaining = wires.filter(wire => !touchesJunction(wire));
  if (incident.length === 2) {
    const opposite = incident.map(wire => wire.from.junction === junctionId ? wire.to : wire.from).map(endpoint => ({ ...endpoint }));
    const endpointKey = endpoint => endpoint.junction ? `j:${endpoint.junction}` : `p:${endpoint.side || ''}:${endpoint.node}:${endpoint.pin || 0}`;
    const valid = opposite.every(endpoint => endpoint.node || (endpoint.junction && endpoint.junction !== junctionId)) && endpointKey(opposite[0]) !== endpointKey(opposite[1]);
    const duplicate = valid && remaining.some(wire => {
      const from = endpointKey(wire.from); const to = endpointKey(wire.to); const first = endpointKey(opposite[0]); const second = endpointKey(opposite[1]);
      return (from === first && to === second) || (from === second && to === first);
    });
    if (valid && !duplicate) {
      const [first, second] = opposite[0].side === 'input' || opposite[1].side === 'output' ? [opposite[1], opposite[0]] : opposite;
      remaining.push({ id: replacementWireId, from: first, to: second });
    }
  }
  return { wires: remaining, junctions: junctions.filter(junction => junction.id !== junctionId) };
}

export function propagationSeeds(nodes, wires, junctions = []) {
  const connections = resolveWireConnections(wires, junctions);
  const nodeIds = new Set(nodes.map(node => node.id));
  const incoming = new Map(nodes.map(node => [node.id, 0]));
  const outgoing = new Map(nodes.map(node => [node.id, []]));
  for (const wire of connections) {
    if (!nodeIds.has(wire.from.node) || !nodeIds.has(wire.to.node)) continue;
    incoming.set(wire.to.node, incoming.get(wire.to.node) + 1);
    outgoing.get(wire.from.node).push(wire.to.node);
  }
  const seeds = nodes.filter(node => incoming.get(node.id) === 0).map(node => node.id);
  const reached = new Set();
  const visit = start => {
    const queue = [start];
    while (queue.length) {
      const id = queue.shift(); if (reached.has(id)) continue; reached.add(id);
      queue.push(...outgoing.get(id));
    }
  };
  for (const id of seeds) visit(id);
  for (const node of nodes) if (!reached.has(node.id)) { seeds.push(node.id); visit(node.id); }
  return seeds;
}

export function propagateBatch(nodes, wires, nodeIds, evaluatedNodeIds = new Set(), junctions = []) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const connections = resolveWireConnections(wires, junctions);
  initializeNodeState(nodes);
  const outputs = new Map(nodes.map(node => [node.id, [...node.outputs]]));
  const results = nodeIds.map(id => byId.get(id)).filter(Boolean).map(node => {
    const def = COMPONENTS[node.type];
    const inputs = Array(def.inputs).fill(false);
    for (const wire of connections) {
      if (wire.to.node !== node.id) continue;
      const source = byId.get(wire.from.node);
      if (source) inputs[wire.to.pin] = inputs[wire.to.pin] || Boolean(outputs.get(source.id)?.[wire.from.pin]);
    }
    return { node, inputs, outputs: evaluate(node.type, inputs, node.value, node.outputs, node.inputs) };
  });
  const nextNodeIds = new Set(); const changedNodeIds = [];
  for (const result of results) {
    const firstEvaluation = !evaluatedNodeIds.has(result.node.id);
    const changed = result.outputs.some((value, index) => value !== result.node.outputs[index]);
    result.node.inputs = result.inputs; result.node.outputs = result.outputs; evaluatedNodeIds.add(result.node.id);
    if (changed) changedNodeIds.push(result.node.id);
    if (firstEvaluation || changed) for (const wire of connections) if (wire.from.node === result.node.id) nextNodeIds.add(wire.to.node);
  }
  return { nextNodeIds: [...nextNodeIds], changedNodeIds };
}

export function simulate(nodes, wires, iterations = 32, junctions = []) {
  initializeNodeState(nodes);
  const evaluated = new Set(); const queue = [propagationSeeds(nodes, wires, junctions)];
  for (let pass = 0; pass < iterations && queue.length; pass++) {
    const batch = queue.shift(); if (!batch.length) break;
    const result = propagateBatch(nodes, wires, batch, evaluated, junctions);
    if (result.nextNodeIds.length) queue.push(result.nextNodeIds);
  }
  return nodes;
}

export function makeExample() {
  return {
    name: 'Half Adder',
    nodes: [
      { id: 'a', type: 'INPUT', label: 'Input A', x: 85, y: 135, value: false },
      { id: 'b', type: 'INPUT', label: 'Input B', x: 85, y: 285, value: false },
      { id: 'xor', type: 'XOR', label: 'Sum', x: 350, y: 115, value: false },
      { id: 'and', type: 'AND', label: 'Carry', x: 350, y: 305, value: false },
      { id: 'sum', type: 'LED', label: 'SUM', x: 610, y: 115, value: false },
      { id: 'carry', type: 'LED', label: 'CARRY', x: 610, y: 305, value: false },
    ],
    wires: [
      { id: 'w1', from: { node: 'a', pin: 0 }, to: { node: 'xor', pin: 0 } },
      { id: 'w2', from: { node: 'b', pin: 0 }, to: { node: 'xor', pin: 1 } },
      { id: 'w3', from: { node: 'a', pin: 0 }, to: { node: 'and', pin: 0 } },
      { id: 'w4', from: { node: 'b', pin: 0 }, to: { node: 'and', pin: 1 } },
      { id: 'w5', from: { node: 'xor', pin: 0 }, to: { node: 'sum', pin: 0 } },
      { id: 'w6', from: { node: 'and', pin: 0 }, to: { node: 'carry', pin: 0 } },
    ],
  };
}

export function makeCounterExample() {
  const nodes = [
    { id: 'clock', type: 'CLOCK', label: 'Clock', x: 35, y: 120, value: false },
    { id: 'invert0', type: 'NOT', label: 'Next bit 0', x: 220, y: 250, value: false },
    { id: 'xor1', type: 'XOR', label: 'Next bit 1', x: 450, y: 250, value: false },
    { id: 'and01', type: 'AND', label: 'Carry 0–1', x: 565, y: 385, value: false },
    { id: 'xor2', type: 'XOR', label: 'Next bit 2', x: 680, y: 250, value: false },
    { id: 'and012', type: 'AND', label: 'Carry 0–2', x: 795, y: 385, value: false },
    { id: 'xor3', type: 'XOR', label: 'Next bit 3', x: 910, y: 250, value: false },
  ];
  const wires = [
    { id: 'q0-invert', from: { node: 'ff0', pin: 0 }, to: { node: 'invert0', pin: 0 } },
    { id: 'invert-d0', from: { node: 'invert0', pin: 0 }, to: { node: 'ff0', pin: 0 } },
    { id: 'q1-xor1', from: { node: 'ff1', pin: 0 }, to: { node: 'xor1', pin: 0 } },
    { id: 'q0-xor1', from: { node: 'ff0', pin: 0 }, to: { node: 'xor1', pin: 1 } },
    { id: 'xor1-d1', from: { node: 'xor1', pin: 0 }, to: { node: 'ff1', pin: 0 } },
    { id: 'q0-and01', from: { node: 'ff0', pin: 0 }, to: { node: 'and01', pin: 0 } },
    { id: 'q1-and01', from: { node: 'ff1', pin: 0 }, to: { node: 'and01', pin: 1 } },
    { id: 'q2-xor2', from: { node: 'ff2', pin: 0 }, to: { node: 'xor2', pin: 0 } },
    { id: 'and01-xor2', from: { node: 'and01', pin: 0 }, to: { node: 'xor2', pin: 1 } },
    { id: 'xor2-d2', from: { node: 'xor2', pin: 0 }, to: { node: 'ff2', pin: 0 } },
    { id: 'and01-and012', from: { node: 'and01', pin: 0 }, to: { node: 'and012', pin: 0 } },
    { id: 'q2-and012', from: { node: 'ff2', pin: 0 }, to: { node: 'and012', pin: 1 } },
    { id: 'q3-xor3', from: { node: 'ff3', pin: 0 }, to: { node: 'xor3', pin: 0 } },
    { id: 'and012-xor3', from: { node: 'and012', pin: 0 }, to: { node: 'xor3', pin: 1 } },
    { id: 'xor3-d3', from: { node: 'xor3', pin: 0 }, to: { node: 'ff3', pin: 0 } },
  ];
  for (let bit = 0; bit < 4; bit++) {
    const x = 230 + bit * 210;
    nodes.push(
      { id: `ff${bit}`, type: 'D_FLIP_FLOP', label: `Bit ${bit}`, x, y: 80, value: false },
      { id: `led${bit}`, type: 'LED', label: `Q${bit}`, x, y: 520, value: false },
    );
    wires.push(
      { id: `q-led-${bit}`, from: { node: `ff${bit}`, pin: 0 }, to: { node: `led${bit}`, pin: 0 } },
      { id: `clock-ff${bit}`, from: { node: 'clock', pin: 0 }, to: { node: `ff${bit}`, pin: 1 } },
    );
  }
  return { name: '4-bit Counter', nodes, wires, junctions: [] };
}
