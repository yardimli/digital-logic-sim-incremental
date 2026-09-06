import test from 'node:test';
import assert from 'node:assert/strict';
import { routeWire, orthogonalPath, curvedPath, directBezierPath, directBezierIsClear } from './router.js';

test('wire routing detours around component rectangles', () => {
  const obstacle = { left: 80, right: 140, top: 30, bottom: 90 };
  const points = routeWire({ x: 0, y: 60, side: 'right' }, { x: 220, y: 60, side: 'left' }, [obstacle], 10);
  assert.ok(points.some(point => point.y <= 20 || point.y >= 100));
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]; const b = points[index];
    const crosses = a.y === b.y
      ? a.y > obstacle.top && a.y < obstacle.bottom && Math.max(Math.min(a.x, b.x), obstacle.left) < Math.min(Math.max(a.x, b.x), obstacle.right)
      : a.x > obstacle.left && a.x < obstacle.right && Math.max(Math.min(a.y, b.y), obstacle.top) < Math.min(Math.max(a.y, b.y), obstacle.bottom);
    assert.equal(crosses, false);
  }
  assert.match(orthogonalPath(points), /^M /);
  assert.match(curvedPath(points), / C /);
  assert.doesNotMatch(curvedPath(points), / L | Q /);
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

test('parallel wires choose separate lanes while perpendicular crossings remain allowed', () => {
  const start = { x: 0, y: 50, side: 'right' }; const end = { x: 220, y: 50, side: 'left' };
  const first = routeWire(start, end, []);
  const occupied = first.slice(1).map((point, index) => ({ a: first[index], b: point }));
  const second = routeWire(start, end, [], 14, 18, occupied);
  assert.ok(second.some(point => point.y !== 50));
  const sharedLength = second.slice(1).reduce((total, point, index) => {
    const a = second[index]; const horizontal = a.y === point.y;
    return total + occupied.reduce((overlap, segment) => {
      if (horizontal !== (segment.a.y === segment.b.y)) return overlap;
      if (horizontal && a.y !== segment.a.y) return overlap;
      if (!horizontal && a.x !== segment.a.x) return overlap;
      const firstStart = horizontal ? Math.min(a.x, point.x) : Math.min(a.y, point.y);
      const firstEnd = horizontal ? Math.max(a.x, point.x) : Math.max(a.y, point.y);
      const secondStart = horizontal ? Math.min(segment.a.x, segment.b.x) : Math.min(segment.a.y, segment.b.y);
      const secondEnd = horizontal ? Math.max(segment.a.x, segment.b.x) : Math.max(segment.a.y, segment.b.y);
      return overlap + Math.max(0, Math.min(firstEnd, secondEnd) - Math.max(firstStart, secondStart));
    }, 0);
  }, 0);
  assert.ok(sharedLength <= 36);
});
