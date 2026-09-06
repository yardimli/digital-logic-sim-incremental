import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, simulate, initializeNodeState, propagationSeeds, propagateBatch, makeExample } from './engine.js';

test('logic gates evaluate their truth tables', () => {
  assert.deepEqual(evaluate('AND', [true, true]), [true]);
  assert.deepEqual(evaluate('AND', [true, false]), [false]);
  assert.deepEqual(evaluate('XOR', [true, false]), [true]);
  assert.deepEqual(evaluate('NAND', [true, true]), [false]);
  assert.deepEqual(evaluate('NOR', [false, false]), [true]);
  assert.deepEqual(evaluate('NOR', [false, true]), [false]);
  assert.deepEqual(evaluate('NOT', [false]), [true]);
});

test('half adder propagates sum and carry', () => {
  const circuit = makeExample();
  circuit.nodes.find(n => n.id === 'a').value = true;
  simulate(circuit.nodes, circuit.wires);
  assert.equal(circuit.nodes.find(n => n.id === 'sum').outputs[0], true);
  assert.equal(circuit.nodes.find(n => n.id === 'carry').outputs[0], false);
  circuit.nodes.find(n => n.id === 'b').value = true;
  simulate(circuit.nodes, circuit.wires);
  assert.equal(circuit.nodes.find(n => n.id === 'sum').outputs[0], false);
  assert.equal(circuit.nodes.find(n => n.id === 'carry').outputs[0], true);
});

test('one input accepts signals from multiple outputs', () => {
  const nodes = [
    { id: 'low', type: 'INPUT', value: false },
    { id: 'high', type: 'INPUT', value: true },
    { id: 'buffer', type: 'BUFFER', value: false },
  ];
  const wires = [
    { id: 'w1', from: { node: 'low', pin: 0 }, to: { node: 'buffer', pin: 0 } },
    { id: 'w2', from: { node: 'high', pin: 0 }, to: { node: 'buffer', pin: 0 } },
  ];
  simulate(nodes, wires);
  assert.equal(nodes.find(node => node.id === 'buffer').outputs[0], true);
});

test('odd inverter feedback propagates one gate delay at a time', () => {
  const nodes = [
    { id: 'not-1', type: 'NOT', value: false, inputs: [false], outputs: [false] },
    { id: 'not-2', type: 'NOT', value: false, inputs: [false], outputs: [false] },
    { id: 'not-3', type: 'NOT', value: false, inputs: [false], outputs: [false] },
    { id: 'led-1', type: 'LED', value: false, inputs: [false], outputs: [false] },
    { id: 'led-2', type: 'LED', value: false, inputs: [false], outputs: [false] },
    { id: 'led-3', type: 'LED', value: false, inputs: [false], outputs: [false] },
  ];
  const wires = [
    { id: 'w1', from: { node: 'not-1', pin: 0 }, to: { node: 'not-2', pin: 0 } },
    { id: 'w2', from: { node: 'not-2', pin: 0 }, to: { node: 'not-3', pin: 0 } },
    { id: 'w3', from: { node: 'not-3', pin: 0 }, to: { node: 'not-1', pin: 0 } },
    { id: 'w4', from: { node: 'not-1', pin: 0 }, to: { node: 'led-1', pin: 0 } },
    { id: 'w5', from: { node: 'not-2', pin: 0 }, to: { node: 'led-2', pin: 0 } },
    { id: 'w6', from: { node: 'not-3', pin: 0 }, to: { node: 'led-3', pin: 0 } },
  ];
  initializeNodeState(nodes); const evaluated = new Set(); let batch = propagationSeeds(nodes, wires);
  assert.deepEqual(batch, ['not-1']);
  batch = propagateBatch(nodes, wires, batch, evaluated).nextNodeIds;
  assert.deepEqual(nodes.slice(0, 3).map(node => node.outputs[0]), [true, false, false]);
  batch = propagateBatch(nodes, wires, batch, evaluated).nextNodeIds;
  batch = propagateBatch(nodes, wires, batch, evaluated).nextNodeIds;
  assert.deepEqual(nodes.slice(0, 3).map(node => node.outputs[0]), [true, false, true]);
  batch = propagateBatch(nodes, wires, batch, evaluated).nextNodeIds;
  assert.deepEqual(nodes.slice(0, 3).map(node => node.outputs[0]), [false, false, true]);
  assert.deepEqual(nodes.slice(3).map(node => node.outputs[0]), [true, false, true]);
});

test('fan-out destinations are scheduled together in the next interval', () => {
  const nodes = [
    { id: 'source', type: 'INPUT' },
    { id: 'left', type: 'BUFFER' },
    { id: 'right', type: 'NOT' },
    { id: 'left-led', type: 'LED' },
    { id: 'right-led', type: 'LED' },
  ];
  const wires = [
    { from: { node: 'source' }, to: { node: 'left' } },
    { from: { node: 'source' }, to: { node: 'right' } },
    { from: { node: 'left' }, to: { node: 'left-led' } },
    { from: { node: 'right' }, to: { node: 'right-led' } },
  ];
  initializeNodeState(nodes); const evaluated = new Set();
  const first = propagateBatch(nodes, wires, propagationSeeds(nodes, wires), evaluated);
  assert.deepEqual(first.nextNodeIds, ['left', 'right']);
  const second = propagateBatch(nodes, wires, first.nextNodeIds, evaluated);
  assert.deepEqual(second.nextNodeIds, ['left-led', 'right-led']);
});

test('4 by 4 LED matrix lights active row and column intersections', () => {
  assert.deepEqual(evaluate('LED_MATRIX', [true, false, true, false, false, true, false, true]), [
    false, true, false, true,
    false, false, false, false,
    false, true, false, true,
    false, false, false, false,
  ]);
});
