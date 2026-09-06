import test from 'node:test';
import assert from 'node:assert/strict';
import { routeWire, orthogonalizePoints, orthogonalPath, curvedPath, directBezierPath, directBezierIsClear, moveOrthogonalSegment } from './router.js';

test('wire routing keeps a 20px safe margin around components', () => {
  const obstacle = { left: 80, right: 140, top: 30, bottom: 90 };
  const safeArea = { left: 60, right: 160, top: 10, bottom: 110 };
  const points = routeWire({ x: 0, y: 60, side: 'right' }, { x: 220, y: 60, side: 'left' }, [obstacle]);
  assert.ok(points.some(point => point.y <= safeArea.top || point.y >= safeArea.bottom));
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]; const b = points[index];
    assert.ok(a.x === b.x || a.y === b.y, 'every orthogonal segment must be horizontal or vertical');
    const crosses = a.y === b.y
      ? a.y > safeArea.top && a.y < safeArea.bottom && Math.max(Math.min(a.x, b.x), safeArea.left) < Math.min(Math.max(a.x, b.x), safeArea.right)
      : a.x > safeArea.left && a.x < safeArea.right && Math.max(Math.min(a.y, b.y), safeArea.top) < Math.min(Math.max(a.y, b.y), safeArea.bottom);
    assert.equal(crosses, false);
  }
  assert.match(orthogonalPath(points), /^M /);
  assert.match(curvedPath(points), / C /);
  assert.doesNotMatch(curvedPath(points), / L | Q /);
});

test('orthogonal paths repair diagonal points into right-angle segments', () => {
  const points = orthogonalizePoints([{ x: 0, y: 10, side: 'right' }, { x: 60, y: 45 }, { x: 100, y: 80, side: 'left' }]);
  for (let index = 1; index < points.length; index++) assert.ok(points[index - 1].x === points[index].x || points[index - 1].y === points[index].y);
  assert.equal(orthogonalPath([{ x: 0, y: 10, side: 'right' }, { x: 60, y: 45 }]), 'M 0 10 L 60 10 L 60 45');
});

test('curved wires use a single sweeping cubic Bezier when unobstructed', () => {
  const start = { x: 0, y: 20, side: 'right' };
  const end = { x: 220, y: 120, side: 'left' };
  const path = directBezierPath(start, end);
  assert.match(path, /^M .* C /);
  assert.doesNotMatch(path, / L | Q /);
  assert.equal(directBezierIsClear(start, end, []), true);
  assert.equal(directBezierIsClear(start, end, [{ left: 90, right: 130, top: 50, bottom: 90 }]), false);
});

test('unobstructed wires use the direct lane even when routes overlap', () => {
  const start = { x: 0, y: 50, side: 'right' }; const end = { x: 220, y: 50, side: 'left' };
  const points = routeWire(start, end, []);
  assert.ok(points.every(point => point.y === 50));
});

test('beautify routing can assign a separate lane around an occupied wire', () => {
  const start = { x: 0, y: 50, side: 'right' }; const end = { x: 220, y: 50, side: 'left' };
  const occupied = [{ a: start, b: end }];
  const points = routeWire(start, end, [], 20, 20, occupied);
  assert.ok(points.some(point => point.y !== 50));
});

test('orthogonal segments only move perpendicular to their direction', () => {
  const horizontal = moveOrthogonalSegment([{ x: 0, y: 20 }, { x: 100, y: 20 }], 0, 55);
  assert.deepEqual(horizontal, [{ x: 0, y: 20 }, { x: 0, y: 55 }, { x: 100, y: 55 }, { x: 100, y: 20 }]);
  const vertical = moveOrthogonalSegment([{ x: 30, y: 0 }, { x: 30, y: 100 }], 0, 72);
  assert.deepEqual(vertical, [{ x: 30, y: 0 }, { x: 72, y: 0 }, { x: 72, y: 100 }, { x: 30, y: 100 }]);
});
