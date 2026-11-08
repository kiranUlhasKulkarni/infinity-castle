import { generateLayout } from './layout.js';
import { buildBuckets } from './buckets.js';

/**
 * Generates the next castle off the main thread (≈200 ms) while the floor
 * opens, including the collision broad phase, so committing it costs nothing.
 */
self.onmessage = (e) => {
  const L = generateLayout(e.data);
  L.buckets = buildBuckets(L.period, L.colliders, L.colliderCount);
  const buffers = [L.colliders.buffer, L.lamps.buffer, L.buckets.start.buffer, L.buckets.items.buffer];
  for (const k of ['wood', 'house', 'lantern']) buffers.push(L[k].pos.buffer, L[k].quat.buffer, L[k].scl.buffer, L[k].info.buffer);
  self.postMessage({ id: e.data.id, layout: L }, buffers);
};
