import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, simulate, executionBatches, propagatingViaIds, makeExample } from './engine.js';

test('logic gates evaluate their truth tables', () => {
  assert.deepEqual(evaluate('AND', [true, true]), [true]);
  assert.deepEqual(evaluate('AND', [true, false]), [false]);
  assert.deepEqual(evaluate('XOR', [true, false]), [true]);
  assert.deepEqual(evaluate('NAND', [true, true]), [false]);
  assert.deepEqual(evaluate('NOR', [false, false]), [true]);
  assert.deepEqual(evaluate('NOR', [false, true]), [false]);
  assert.deepEqual(evaluate('NOT', [false]), [true]);
  assert.deepEqual(evaluate('VIA', [false, true, false, false]), [true, true, true, true]);
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

test('via combines its four connectors and fans the signal out', () => {
  const nodes = [
    { id: 'source', type: 'INPUT', value: true },
    { id: 'via', type: 'VIA', value: false },
    { id: 'first', type: 'LED', value: false },
    { id: 'second', type: 'LED', value: false },
  ];
  const wires = [
    { id: 'in', from: { node: 'source', pin: 0 }, to: { node: 'via', pin: 0 } },
    { id: 'out-1', from: { node: 'via', pin: 1 }, to: { node: 'first', pin: 0 } },
    { id: 'out-2', from: { node: 'via', pin: 3 }, to: { node: 'second', pin: 0 } },
  ];
  simulate(nodes, wires);
  assert.deepEqual(nodes.find(node => node.id === 'via').outputs, [true, true, true, true]);
  assert.equal(nodes.find(node => node.id === 'first').outputs[0], true);
  assert.equal(nodes.find(node => node.id === 'second').outputs[0], true);
});

test('odd inverter feedback advances instead of settling on a false stable state', () => {
  const nodes = [
    { id: 'not-1', type: 'NOT', value: false, inputs: [false], outputs: [false] },
    { id: 'not-2', type: 'NOT', value: false, inputs: [false], outputs: [false] },
    { id: 'not-3', type: 'NOT', value: false, inputs: [false], outputs: [false] },
  ];
  const wires = [
    { id: 'w1', from: { node: 'not-1', pin: 0 }, to: { node: 'not-2', pin: 0 } },
    { id: 'w2', from: { node: 'not-2', pin: 0 }, to: { node: 'not-3', pin: 0 } },
    { id: 'w3', from: { node: 'not-3', pin: 0 }, to: { node: 'not-1', pin: 0 } },
  ];
  simulate(nodes, wires);
  assert.deepEqual(nodes.map(node => node.outputs[0]), [true, true, true]);
  simulate(nodes, wires);
  assert.deepEqual(nodes.map(node => node.outputs[0]), [false, false, false]);
});

test('fan-out destinations execute together in the same simulation interval', () => {
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
  assert.deepEqual(executionBatches(nodes, wires), [
    ['source'],
    ['left', 'right'],
    ['left-led', 'right-led'],
  ]);
});

test('4 by 4 LED matrix lights active row and column intersections', () => {
  assert.deepEqual(evaluate('LED_MATRIX', [true, false, true, false, false, true, false, true]), [
    false, true, false, true,
    false, false, false, false,
    false, true, false, true,
    false, false, false, false,
  ]);
});

test('an animated signal activates every connected via junction', () => {
  const nodes = [
    { id: 'source', type: 'INPUT', outputs: [true] },
    { id: 'via-1', type: 'VIA', outputs: [true, true, true, true] },
    { id: 'via-2', type: 'VIA', outputs: [true, true, true, true] },
    { id: 'led', type: 'LED', outputs: [true] },
  ];
  const wires = [
    { from: { node: 'source', pin: 0 }, to: { node: 'via-1', pin: 0 } },
    { from: { node: 'via-1', pin: 1 }, to: { node: 'via-2', pin: 0 } },
    { from: { node: 'via-2', pin: 1 }, to: { node: 'led', pin: 0 } },
  ];
  assert.deepEqual([...propagatingViaIds(nodes, wires, new Set(['source']))], ['via-1', 'via-2']);
});
