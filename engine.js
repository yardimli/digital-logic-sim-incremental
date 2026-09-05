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
  VIA:    { category: 'Routing', label: 'Via', symbol: '◉', detail: 'Four-way junction', hint: 'All four connectors accept or send the same combined signal.', inputs: 4, outputs: 4 },
  BUFFER: { category: 'Routing', label: 'Buffer', symbol: '▷', detail: 'Pass signal', hint: 'Passes the input signal through without changing it.', inputs: 1, outputs: 1 },
  OUTPUT: { category: 'Outputs', label: 'Output', symbol: 'OUT', detail: 'Signal probe', hint: 'Displays the signal received at its input.', inputs: 1, outputs: 0 },
  LED:    { category: 'Outputs', label: 'LED',    symbol: '●', detail: 'Light indicator', hint: 'Lights when its input signal is HIGH.', inputs: 1, outputs: 0 },
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
    case 'VIA': return Array(4).fill(inputs.some(Boolean));
    case 'BUFFER': return [Boolean(inputs[0])];
    case 'OUTPUT':
    case 'LED': return [Boolean(inputs[0])];
    default: return [false];
  }
}

export function simulate(nodes, wires, iterations = 32) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const node of nodes) {
    const def = COMPONENTS[node.type];
    if (!Array.isArray(node.inputs) || node.inputs.length !== def.inputs) node.inputs = Array(def.inputs).fill(false);
    if (!Array.isArray(node.outputs) || !node.outputs.length) node.outputs = evaluate(node.type, node.inputs, node.value);
  }

  const signature = outputs => nodes.map(node => outputs.get(node.id).map(Number).join('')).join('|');
  const takeStep = outputs => nodes.map(node => {
    const def = COMPONENTS[node.type];
    const inputs = Array(def.inputs).fill(false);
    for (const wire of wires) {
      if (wire.to.node !== node.id) continue;
      const source = byId.get(wire.from.node);
      if (source) inputs[wire.to.pin] = inputs[wire.to.pin] || Boolean(outputs.get(source.id)?.[wire.from.pin]);
    }
    return { node, inputs, outputs: evaluate(node.type, inputs, node.value) };
  });
  const applyStep = step => { for (const result of step) { result.node.inputs = result.inputs; result.node.outputs = result.outputs; } };

  let current = new Map(nodes.map(node => [node.id, [...node.outputs]]));
  let currentSignature = signature(current);
  const seen = new Set([currentSignature]);
  let firstStep = null;
  let latestStep = null;
  for (let pass = 0; pass < iterations; pass++) {
    latestStep = takeStep(current);
    if (!firstStep) firstStep = latestStep.map(result => ({ ...result, inputs: [...result.inputs], outputs: [...result.outputs] }));
    const next = new Map(latestStep.map(result => [result.node.id, result.outputs]));
    const nextSignature = signature(next);
    if (nextSignature === currentSignature) { applyStep(latestStep); return nodes; }
    if (seen.has(nextSignature)) { applyStep(firstStep); return nodes; }
    seen.add(nextSignature); current = next; currentSignature = nextSignature;
  }
  if (latestStep) applyStep(latestStep);
  return nodes;
}

export function executionBatches(nodes, wires) {
  const nodeIds = new Set(nodes.map(node => node.id));
  const indegree = new Map(nodes.map(node => [node.id, 0]));
  const outgoing = new Map(nodes.map(node => [node.id, []]));
  for (const wire of wires) {
    if (!nodeIds.has(wire.from.node) || !nodeIds.has(wire.to.node)) continue;
    outgoing.get(wire.from.node).push(wire.to.node);
    indegree.set(wire.to.node, indegree.get(wire.to.node) + 1);
  }

  let wave = nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id);
  const batches = [];
  const scheduled = new Set();
  while (wave.length) {
    batches.push(wave);
    const nextWave = [];
    for (const id of wave) {
      scheduled.add(id);
      for (const target of outgoing.get(id)) {
        indegree.set(target, indegree.get(target) - 1);
        if (indegree.get(target) === 0) nextWave.push(target);
      }
    }
    wave = nextWave;
  }

  const feedbackNodes = nodes.filter(node => !scheduled.has(node.id)).map(node => node.id);
  if (feedbackNodes.length) batches.push(feedbackNodes);
  return batches;
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
