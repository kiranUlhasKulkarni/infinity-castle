import { BoxGeometry, InstancedMesh, Matrix4, MeshBasicMaterial, Raycaster, Vector3 } from 'three';
import { buildBuckets, GRID } from './buckets.js';

/**
 * Collision for the periodic castle.
 *
 *  Broad phase: a spatial hash over every collidable box of the layout
 *  (~35k AABBs), queried with periodic wrap.
 *
 *  Narrow phase: the boxes near Tanjiro are copied into a small proxy
 *  InstancedMesh each frame (positioned at the copy of the period nearest
 *  him), and a THREE.Raycaster is cast against that proxy — downward for the
 *  floor, backward for the camera. Raycasting the full 60k-instance castle
 *  would cost milliseconds; the proxy holds ~100–300 boxes.
 *
 *  Walls: capsule-vs-AABB push-out on the same nearby set.
 */
const MAX_PROXIES = 512;

export class Collision {
  constructor() {
    this.proxy = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), MAX_PROXIES);
    this.proxy.count = 0;
    this.proxy.matrixAutoUpdate = false;
    this.proxy.updateMatrixWorld(true);
    this.raycaster = new Raycaster();
    this.raycaster.firstHitOnly = true;
    this.near = new Float32Array(MAX_PROXIES * 6); // wrapped centre + half extents
    this.nearCount = 0;
    this.enabled = true;
    this._m = new Matrix4();
    this._hits = [];
    this._stamp = null;
    this._stampId = 1;
  }

  setLayout(layout) {
    this.P = layout.period;
    this.data = layout.colliders;
    this.count = layout.colliderCount;
    // broad phase: built in the layout worker when possible (flat arrays, transferred)
    const b = layout.buckets ?? (layout.buckets = buildBuckets(this.P, this.data, this.count));
    this.n = b.n;
    this.bStart = b.start;
    this.bItems = b.items;
    this._stamp = new Uint32Array(this.count);
    this._stampId = 1;
  }

  /** Calls fn(i, cx, cy, cz, hx, hy, hz) for colliders overlapping the world box (wrapped near qx,qy,qz). */
  query(minX, minY, minZ, maxX, maxY, maxZ, fn) {
    if (!this.bStart) return;
    const [nx, ny, nz] = this.n;
    const [Px, Py, Pz] = this.P;
    const qx = (minX + maxX) / 2, qy = (minY + maxY) / 2, qz = (minZ + maxZ) / 2;
    const stamp = this._stamp;
    const id = ++this._stampId;
    if (id > 4e9) {
      stamp.fill(0);
      this._stampId = 1;
    }
    const d = this.data;
    const i0 = Math.floor(minX / GRID), i1 = Math.floor(maxX / GRID);
    const j0 = Math.floor(minY / GRID), j1 = Math.floor(maxY / GRID);
    const k0 = Math.floor(minZ / GRID), k1 = Math.floor(maxZ / GRID);
    for (let a = i0; a <= i1; a++)
      for (let b = j0; b <= j1; b++)
        for (let c = k0; c <= k1; c++) {
          const key = (((a % nx) + nx) % nx) + nx * ((((b % ny) + ny) % ny) + ny * (((c % nz) + nz) % nz));
          const items = this.bItems;
          for (let n = this.bStart[key], e = this.bStart[key + 1]; n < e; n++) {
            const i = items[n];
            if (stamp[i] === id) continue;
            stamp[i] = id;
            const o = i * 6;
            const cx = d[o] + Px * Math.round((qx - d[o]) / Px);
            const cy = d[o + 1] + Py * Math.round((qy - d[o + 1]) / Py);
            const cz = d[o + 2] + Pz * Math.round((qz - d[o + 2]) / Pz);
            const hx = d[o + 3], hy = d[o + 4], hz = d[o + 5];
            if (cx + hx < minX || cx - hx > maxX || cy + hy < minY || cy - hy > maxY || cz + hz < minZ || cz - hz > maxZ) continue;
            fn(i, cx, cy, cz, hx, hy, hz);
          }
        }
  }

  /** Refresh the proxy mesh with boxes around `p` (and a tall column beneath for void detection). */
  updateNear(p, radius = 9, below = 6, above = 7) {
    let n = 0;
    const near = this.near;
    const m = this._m;
    const arr = this.proxy.instanceMatrix.array;
    const add = (i, cx, cy, cz, hx, hy, hz) => {
      if (n >= MAX_PROXIES) return;
      const o = n * 6;
      near[o] = cx; near[o + 1] = cy; near[o + 2] = cz;
      near[o + 3] = hx; near[o + 4] = hy; near[o + 5] = hz;
      m.makeScale(hx * 2, hy * 2, hz * 2).setPosition(cx, cy, cz);
      m.toArray(arr, n * 16);
      n++;
    };
    this.query(p.x - radius, p.y - below, p.z - radius, p.x + radius, p.y + above, p.z + radius, add);
    this.nearCount = n;
    // the column under his feet, far down (does the void have a floor?)
    const seen = n;
    this.query(p.x - 0.4, p.y - 70, p.z - 0.4, p.x + 0.4, p.y - below, p.z + 0.4, (i, cx, cy, cz, hx, hy, hz) => {
      // skip ones already added by the first query
      for (let k = 0; k < seen; k++) {
        const o = k * 6;
        if (near[o] === cx && near[o + 1] === cy && near[o + 2] === cz && near[o + 3] === hx) return;
      }
      add(i, cx, cy, cz, hx, hy, hz);
    });
    this.proxy.count = n;
    this.proxy.instanceMatrix.needsUpdate = true;
    this.proxy.boundingSphere = null; // recomputed lazily by the raycast
  }

  /** Raycast against the proxy. Returns the nearest hit with an upward face if `floorOnly`. */
  raycast(origin, dir, far, floorOnly = false) {
    if (!this.proxy.count) return null;
    this.raycaster.set(origin, dir);
    this.raycaster.far = far;
    this._hits.length = 0;
    this.raycaster.intersectObject(this.proxy, false, this._hits);
    for (const h of this._hits) {
      if (floorOnly && (!h.face || h.face.normal.y < 0.5)) continue;
      return h;
    }
    return null;
  }

  /**
   * Pushes a vertical capsule (feet at p, radius r, blocking band [yLo, yHi] above the feet) out of
   * nearby boxes in XZ. Returns true if it hit something.
   */
  pushOut(p, r, yLo, yHi) {
    let hit = false;
    const near = this.near;
    for (let k = 0; k < this.nearCount; k++) {
      const o = k * 6;
      const cy = near[o + 1], hy = near[o + 4];
      if (cy + hy <= p.y + yLo || cy - hy >= p.y + yHi) continue;
      const cx = near[o], cz = near[o + 2], hx = near[o + 3], hz = near[o + 5];
      const qx = Math.max(cx - hx, Math.min(p.x, cx + hx));
      const qz = Math.max(cz - hz, Math.min(p.z, cz + hz));
      let dx = p.x - qx, dz = p.z - qz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        p.x += (dx / d) * (r - d);
        p.z += (dz / d) * (r - d);
      } else {
        // centre inside the box: leave along the shallowest axis
        const px = hx - Math.abs(p.x - cx), pz = hz - Math.abs(p.z - cz);
        if (px < pz) p.x = cx + Math.sign(p.x - cx || 1) * (hx + r);
        else p.z = cz + Math.sign(p.z - cz || 1) * (hz + r);
      }
      hit = true;
    }
    return hit;
  }

  /** Lowest box bottom above the feet that the head would hit (for jumping into ceilings). */
  ceiling(p, r, from, to) {
    let best = Infinity;
    const near = this.near;
    for (let k = 0; k < this.nearCount; k++) {
      const o = k * 6;
      const bottom = near[o + 1] - near[o + 4];
      if (bottom < p.y + from || bottom > p.y + to) continue;
      if (Math.abs(p.x - near[o]) > near[o + 3] + r * 0.5 || Math.abs(p.z - near[o + 2]) > near[o + 5] + r * 0.5) continue;
      best = Math.min(best, bottom);
    }
    return best;
  }
}

export const _tmpV = new Vector3();
