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
  OUTPUT: { category: 'Outputs', label: 'Output', symbol: 'OUT', detail: 'Signal probe', hint: 'Displays the signal received at its input.', inputs: 1, outputs: 0 },
  LED:    { category: 'Outputs', label: 'LED',    symbol: '●', detail: 'Light indicator', hint: 'Lights when its input signal is HIGH.', inputs: 1, outputs: 0 },
  LED_MATRIX: { category: 'Displays', label: '4×4 LED Matrix', symbol: '▦', detail: 'Row and column display', hint: 'The four left inputs select rows and the four bottom inputs select columns. An LED lights where a HIGH row and HIGH column meet.', inputs: 8, outputs: 0, stateSize: 16, width: 190, height: 190, inputSides: ['left', 'left', 'left', 'left', 'bottom', 'bottom', 'bottom', 'bottom'] },
};

export function evaluate(type, inputs, sourceValue = false) {
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
    case 'OUTPUT':
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
    if (!Array.isArray(node.outputs) || node.outputs.length !== outputCount) node.outputs = Array(outputCount).fill(false);
  }
  return nodes;
}

export function propagationSeeds(nodes, wires) {
  const nodeIds = new Set(nodes.map(node => node.id));
  const incoming = new Map(nodes.map(node => [node.id, 0]));
  const outgoing = new Map(nodes.map(node => [node.id, []]));
  for (const wire of wires) {
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

export function propagateBatch(nodes, wires, nodeIds, evaluatedNodeIds = new Set()) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  initializeNodeState(nodes);
  const outputs = new Map(nodes.map(node => [node.id, [...node.outputs]]));
  const results = nodeIds.map(id => byId.get(id)).filter(Boolean).map(node => {
    const def = COMPONENTS[node.type];
    const inputs = Array(def.inputs).fill(false);
    for (const wire of wires) {
      if (wire.to.node !== node.id) continue;
      const source = byId.get(wire.from.node);
      if (source) inputs[wire.to.pin] = inputs[wire.to.pin] || Boolean(outputs.get(source.id)?.[wire.from.pin]);
    }
    return { node, inputs, outputs: evaluate(node.type, inputs, node.value) };
  });
  const nextNodeIds = new Set(); const changedNodeIds = [];
  for (const result of results) {
    const firstEvaluation = !evaluatedNodeIds.has(result.node.id);
    const changed = result.outputs.some((value, index) => value !== result.node.outputs[index]);
    result.node.inputs = result.inputs; result.node.outputs = result.outputs; evaluatedNodeIds.add(result.node.id);
    if (changed) changedNodeIds.push(result.node.id);
    if (firstEvaluation || changed) for (const wire of wires) if (wire.from.node === result.node.id) nextNodeIds.add(wire.to.node);
  }
  return { nextNodeIds: [...nextNodeIds], changedNodeIds };
}

export function simulate(nodes, wires, iterations = 32) {
  initializeNodeState(nodes);
  const evaluated = new Set(); const queue = [propagationSeeds(nodes, wires)];
  for (let pass = 0; pass < iterations && queue.length; pass++) {
    const batch = queue.shift(); if (!batch.length) break;
    const result = propagateBatch(nodes, wires, batch, evaluated);
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
