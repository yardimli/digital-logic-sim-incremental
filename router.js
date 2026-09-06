const directionVector = side => ({ left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] })[side] || [1, 0];

function bezierControls(start, end) {
  const startDirection = directionVector(start.side);
  const endDirection = directionVector(end.side || 'left');
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const reach = Math.max(48, Math.min(180, distance * 0.42));
  return {
    first: { x: start.x + startDirection[0] * reach, y: start.y + startDirection[1] * reach },
    second: { x: end.x + endDirection[0] * reach, y: end.y + endDirection[1] * reach },
  };
}

function cubicPoint(start, first, second, end, progress) {
  const inverse = 1 - progress;
  return {
    x: inverse ** 3 * start.x + 3 * inverse ** 2 * progress * first.x + 3 * inverse * progress ** 2 * second.x + progress ** 3 * end.x,
    y: inverse ** 3 * start.y + 3 * inverse ** 2 * progress * first.y + 3 * inverse * progress ** 2 * second.y + progress ** 3 * end.y,
  };
}

function compress(points) {
  const unique = points.filter((point, index) => !index || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
  return unique.filter((point, index) => {
    if (!index || index === unique.length - 1) return true;
    const before = unique[index - 1]; const after = unique[index + 1];
    return !((before.x === point.x && point.x === after.x) || (before.y === point.y && point.y === after.y));
  });
}

export function orthogonalizePoints(points) {
  const aligned = [];
  for (const point of points) {
    const previous = aligned[aligned.length - 1];
    if (previous && previous.x !== point.x && previous.y !== point.y) {
      const horizontalFirst = previous.side === 'left' || previous.side === 'right' || point.side === 'left' || point.side === 'right';
      aligned.push(horizontalFirst ? { x: point.x, y: previous.y } : { x: previous.x, y: point.y });
    }
    aligned.push({ ...point });
  }
  return compress(aligned);
}

function segmentClear(a, b, obstacles) {
  return !obstacles.some(rect => {
    if (a.y === b.y) return a.y > rect.top && a.y < rect.bottom && Math.max(Math.min(a.x, b.x), rect.left) < Math.min(Math.max(a.x, b.x), rect.right);
    return a.x > rect.left && a.x < rect.right && Math.max(Math.min(a.y, b.y), rect.top) < Math.min(Math.max(a.y, b.y), rect.bottom);
  });
}

function parallelOverlap(a, b, segments) {
  const horizontal = a.y === b.y;
  return segments.reduce((total, segment) => {
    if (horizontal !== (segment.a.y === segment.b.y)) return total;
    if (horizontal ? a.y !== segment.a.y : a.x !== segment.a.x) return total;
    const firstStart = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y); const firstEnd = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
    const secondStart = horizontal ? Math.min(segment.a.x, segment.b.x) : Math.min(segment.a.y, segment.b.y); const secondEnd = horizontal ? Math.max(segment.a.x, segment.b.x) : Math.max(segment.a.y, segment.b.y);
    return total + Math.max(0, Math.min(firstEnd, secondEnd) - Math.max(firstStart, secondStart));
  }, 0);
}

function fallbackRoute(start, leadStart, leadEnd, end, obstacles, clearance, occupiedSegments) {
  const candidates = [
    [leadStart, { x: leadEnd.x, y: leadStart.y }, leadEnd],
    [leadStart, { x: leadStart.x, y: leadEnd.y }, leadEnd],
  ];
  const horizontalLanes = new Set([leadStart.y, leadEnd.y]); const verticalLanes = new Set([leadStart.x, leadEnd.x]);
  for (const rect of obstacles) { horizontalLanes.add(rect.top); horizontalLanes.add(rect.bottom); verticalLanes.add(rect.left); verticalLanes.add(rect.right); }
  if (obstacles.length) {
    horizontalLanes.add(Math.min(...obstacles.map(rect => rect.top)) - clearance); horizontalLanes.add(Math.max(...obstacles.map(rect => rect.bottom)) + clearance);
    verticalLanes.add(Math.min(...obstacles.map(rect => rect.left)) - clearance); verticalLanes.add(Math.max(...obstacles.map(rect => rect.right)) + clearance);
  }
  for (const y of horizontalLanes) candidates.push([leadStart, { x: leadStart.x, y }, { x: leadEnd.x, y }, leadEnd]);
  for (const x of verticalLanes) candidates.push([leadStart, { x, y: leadStart.y }, { x, y: leadEnd.y }, leadEnd]);
  let best = null; let bestCost = Infinity;
  for (const candidate of candidates.map(compress)) {
    if (candidate.some((point, index) => index && !segmentClear(candidate[index - 1], point, obstacles))) continue;
    let cost = (candidate.length - 2) * 20;
    for (let index = 1; index < candidate.length; index++) cost += Math.abs(candidate[index].x - candidate[index - 1].x) + Math.abs(candidate[index].y - candidate[index - 1].y) + parallelOverlap(candidate[index - 1], candidate[index], occupiedSegments) * 8;
    if (cost < bestCost) { best = candidate; bestCost = cost; }
  }
  return orthogonalizePoints([start, ...(best || [leadStart, { x: leadEnd.x, y: leadStart.y }, leadEnd]), end]);
}

function heapPush(heap, item) {
  heap.push(item); let index = heap.length - 1;
  while (index) { const parent = Math.floor((index - 1) / 2); if (heap[parent].cost <= item.cost) break; heap[index] = heap[parent]; index = parent; }
  heap[index] = item;
}
function heapPop(heap) {
  const root = heap[0]; const tail = heap.pop(); if (!heap.length) return root;
  let index = 0;
  while (true) { let child = index * 2 + 1; if (child >= heap.length) break; if (child + 1 < heap.length && heap[child + 1].cost < heap[child].cost) child++; if (heap[child].cost >= tail.cost) break; heap[index] = heap[child]; index = child; }
  heap[index] = tail; return root;
}

export function routeWire(start, end, rectangles, clearance = 20, leadLength = 20, occupiedSegments = []) {
  const startDirection = directionVector(start.side); const endDirection = directionVector(end.side || 'left');
  const leadStart = { x: start.x + startDirection[0] * leadLength, y: start.y + startDirection[1] * leadLength };
  const leadEnd = { x: end.x + endDirection[0] * leadLength, y: end.y + endDirection[1] * leadLength };
  const obstacles = rectangles.map(rect => ({ left: rect.left - clearance, right: rect.right + clearance, top: rect.top - clearance, bottom: rect.bottom + clearance }));
  const xs = new Set([leadStart.x, leadEnd.x]); const ys = new Set([leadStart.y, leadEnd.y]);
  for (const rect of obstacles) { xs.add(rect.left); xs.add(rect.right); ys.add(rect.top); ys.add(rect.bottom); }
  for (const segment of occupiedSegments) {
    if (segment.a.y === segment.b.y) { ys.add(segment.a.y - 10); ys.add(segment.a.y + 10); }
    else { xs.add(segment.a.x - 10); xs.add(segment.a.x + 10); }
  }
  if (obstacles.length) {
    xs.add(Math.min(...obstacles.map(rect => rect.left)) - clearance); xs.add(Math.max(...obstacles.map(rect => rect.right)) + clearance);
    ys.add(Math.min(...obstacles.map(rect => rect.top)) - clearance); ys.add(Math.max(...obstacles.map(rect => rect.bottom)) + clearance);
  }
  const xValues = [...xs].sort((a, b) => a - b); const yValues = [...ys].sort((a, b) => a - b);
  const points = []; const pointIndex = new Map();
  for (const y of yValues) for (const x of xValues) {
    if (obstacles.some(rect => x > rect.left && x < rect.right && y > rect.top && y < rect.bottom)) continue;
    pointIndex.set(`${x},${y}`, points.length); points.push({ x, y, neighbors: [] });
  }
  const connect = (first, second, direction) => {
    if (first == null || second == null || !segmentClear(points[first], points[second], obstacles)) return;
    const distance = Math.abs(points[first].x - points[second].x) + Math.abs(points[first].y - points[second].y);
    points[first].neighbors.push({ index: second, distance, direction }); points[second].neighbors.push({ index: first, distance, direction });
  };
  for (const y of yValues) { let previous = null; for (const x of xValues) { const current = pointIndex.get(`${x},${y}`); if (current != null) { connect(previous, current, 'h'); previous = current; } } }
  for (const x of xValues) { let previous = null; for (const y of yValues) { const current = pointIndex.get(`${x},${y}`); if (current != null) { connect(previous, current, 'v'); previous = current; } } }
  const startIndex = pointIndex.get(`${leadStart.x},${leadStart.y}`); const endIndex = pointIndex.get(`${leadEnd.x},${leadEnd.y}`);
  if (startIndex == null || endIndex == null) return fallbackRoute(start, leadStart, leadEnd, end, obstacles, clearance, occupiedSegments);

  const initialDirection = startDirection[0] ? 'h' : 'v'; const heap = []; const costs = new Map(); const previous = new Map();
  const initialKey = `${startIndex}:${initialDirection}`; costs.set(initialKey, 0); heapPush(heap, { index: startIndex, direction: initialDirection, cost: 0 });
  let finalKey = null;
  while (heap.length) {
    const current = heapPop(heap); const key = `${current.index}:${current.direction}`;
    if (current.cost !== costs.get(key)) continue;
    if (current.index === endIndex) { finalKey = key; break; }
    for (const neighbor of points[current.index].neighbors) {
      const bendPenalty = neighbor.direction === current.direction ? 0 : 20;
      const overlap = parallelOverlap(points[current.index], points[neighbor.index], occupiedSegments);
      const nextCost = current.cost + neighbor.distance + bendPenalty + (overlap ? 600 + overlap * 8 : 0); const nextKey = `${neighbor.index}:${neighbor.direction}`;
      if (nextCost >= (costs.get(nextKey) ?? Infinity)) continue;
      costs.set(nextKey, nextCost); previous.set(nextKey, key); heapPush(heap, { index: neighbor.index, direction: neighbor.direction, cost: nextCost });
    }
  }
  if (!finalKey) return fallbackRoute(start, leadStart, leadEnd, end, obstacles, clearance, occupiedSegments);
  const routed = [];
  for (let key = finalKey; key; key = previous.get(key)) routed.push(points[Number(key.split(':')[0])]);
  routed.reverse();
  return orthogonalizePoints([start, ...routed, end]);
}

export function orthogonalPath(points) {
  return orthogonalizePoints(points).reduce((path, point, index) => `${path}${index ? ` L ${point.x} ${point.y}` : `M ${point.x} ${point.y}`}`, '');
}

export function moveOrthogonalSegment(points, segmentIndex, coordinate) {
  const moved = points.map(point => ({ ...point }));
  const horizontal = moved[segmentIndex].y === moved[segmentIndex + 1].y;
  if (segmentIndex === 0) { moved.splice(1, 0, { ...moved[0] }); segmentIndex++; }
  if (segmentIndex + 1 === moved.length - 1) moved.splice(segmentIndex + 1, 0, { ...moved[moved.length - 1] });
  const first = moved[segmentIndex]; const second = moved[segmentIndex + 1];
  if (horizontal) first.y = second.y = coordinate;
  else first.x = second.x = coordinate;
  return moved;
}

export function directBezierPath(start, end) {
  const controls = bezierControls(start, end);
  return `M ${start.x} ${start.y} C ${controls.first.x} ${controls.first.y} ${controls.second.x} ${controls.second.y} ${end.x} ${end.y}`;
}

export function directBezierIsClear(start, end, rectangles, clearance = 14) {
  const controls = bezierControls(start, end);
  const obstacles = rectangles.map(rect => ({ left: rect.left - clearance, right: rect.right + clearance, top: rect.top - clearance, bottom: rect.bottom + clearance }));
  for (let step = 1; step < 48; step++) {
    const point = cubicPoint(start, controls.first, controls.second, end, step / 48);
    if (obstacles.some(rect => point.x > rect.left && point.x < rect.right && point.y > rect.top && point.y < rect.bottom)) return false;
  }
  return true;
}

export function curvedPath(points) {
  if (points.length < 2) return '';
  if (points.length === 2) return directBezierPath(points[0], points[1]);
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 0; index < points.length - 1; index++) {
    const before = points[index - 1] || points[index];
    const start = points[index];
    const end = points[index + 1];
    const after = points[index + 2] || end;
    const first = { x: start.x + (end.x - before.x) / 6, y: start.y + (end.y - before.y) / 6 };
    const second = { x: end.x - (after.x - start.x) / 6, y: end.y - (after.y - start.y) / 6 };
    path += ` C ${first.x} ${first.y} ${second.x} ${second.y} ${end.x} ${end.y}`;
  }
  return path;
}
