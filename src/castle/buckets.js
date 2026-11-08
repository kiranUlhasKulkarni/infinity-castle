/**
 * Broad-phase spatial hash for the collision boxes, as flat typed arrays (CSR:
 * per-cell start offsets into one index list). Pure data, so the layout
 * worker builds it off the main thread and it transfers for free — no 40 ms
 * rebuild on the frame a new castle is committed.
 */
export const GRID = 8;

export function buildBuckets(period, colliders, count) {
  const n = period.map((p) => Math.ceil(p / GRID));
  const [nx, ny, nz] = n;
  const cells = nx * ny * nz;
  const wrap = (a, m) => ((a % m) + m) % m;
  const counts = new Int32Array(cells + 1);
  const d = colliders;
  const forCells = (i, fn) => {
    const o = i * 6;
    const i0 = Math.floor((d[o] - d[o + 3]) / GRID), i1 = Math.floor((d[o] + d[o + 3]) / GRID);
    const j0 = Math.floor((d[o + 1] - d[o + 4]) / GRID), j1 = Math.floor((d[o + 1] + d[o + 4]) / GRID);
    const k0 = Math.floor((d[o + 2] - d[o + 5]) / GRID), k1 = Math.floor((d[o + 2] + d[o + 5]) / GRID);
    for (let a = i0; a <= i1; a++) for (let b = j0; b <= j1; b++) for (let c = k0; c <= k1; c++) fn(wrap(a, nx) + nx * (wrap(b, ny) + ny * wrap(c, nz)));
  };
  for (let i = 0; i < count; i++) forCells(i, (key) => counts[key + 1]++);
  for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
  const start = counts; // start[key] .. start[key + 1]
  const fill = start.slice(0, cells);
  const items = new Int32Array(start[cells]);
  for (let i = 0; i < count; i++) forCells(i, (key) => (items[fill[key]++] = i));
  return { n, start, items };
}
