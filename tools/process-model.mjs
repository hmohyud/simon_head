/**
 * Extracts the bust from the raw Meshy GLB and packs it for the web.
 *
 * The export contains two very different kinds of geometry:
 *   - the bust itself: ~2M uniformly dense triangles (edge ~0.003 units)
 *   - a generation scaffold: a few thousand GIANT triangles (edges 10x+
 *     larger) forming box walls / curtain sheets around and through the
 *     scene. It is wound inward, so every normal renderer culls it — the
 *     file "looks clean" in viewers — but any geometry processing that
 *     ignores visibility (voxelizing, measuring, printing) trips over it.
 *
 * Since density separates the two populations by an order of magnitude,
 * extraction is a triangle-size filter plus a connectivity sweep — the
 * original sculpted surface survives untouched at full fidelity:
 *
 *   1. drop triangles with any long edge        (the scaffold)
 *   2. keep the largest connected component     (orphaned fragments)
 *   3. cap boundary loops                        (scaffold attachment scars)
 *   4. simplify to a web budget, bake per-vertex AO into COLOR_0,
 *      quantise + meshopt-compress
 *
 * Usage: npm run model -- <input.glb> [output.glb]
 */
import { Accessor, Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshoptCompression } from "@gltf-transform/extensions";
import { dedup, prune, weld, simplify, quantize } from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const input = process.argv[2];
const output = resolve(process.argv[3] ?? "public/simon.glb");
if (!input) {
  console.error("usage: npm run model -- <input.glb> [output.glb]");
  process.exit(1);
}

// Triangle budget after the re-solidify: the voxel resolution — not this —
// is the detail ceiling, so decimating the remesh output to this level is
// visually lossless while keeping the file lean.
const TARGET_TRIANGLES = 1_200_000;

/* Watertight recast: after visibility extraction the bust is clean but has
   small genuine holes (nostrils, ear canals, scan gaps). Voxelising the
   sealed mesh, flood-filling the outside, and re-extracting the isosurface
   recasts it as ONE solid piece — holes close with the natural continuation
   of the surrounding form instead of visible patches. RES is the fidelity
   knob: 704 keeps beard stubble and hair-strand grooves while erasing only
   sub-millimetre pore noise (which polished marble shouldn't have anyway). */
const RES = 704;
const ISO = 0.5;
const SURFACE_VALUE = 0.55; // surface cells count as solid so no erosion occurs

/* Visibility extraction: a triangle belongs to the sculpture iff it can be
   seen from outside — the scaffold's defining property is that renderers
   never show it. Each triangle fires an escape ray along each side of its
   face normal; if either reaches open space, it is visible. The visible
   set is then dilated a few adjacency rings so crevice triangles (nostril
   interiors, under hair locks) that no ray reaches stay with the head. */
const DILATE_RINGS = 8;

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.encoder": MeshoptEncoder });

const doc = await io.read(input);
const root = doc.getRoot();

console.log(`input: ${(statSync(input).size / 1e6).toFixed(1)} MB`);

for (const material of root.listMaterials()) material.dispose();
for (const texture of root.listTextures()) texture.dispose();
for (const mesh of root.listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    prim.setMaterial(null);
    for (const name of prim.listSemantics()) {
      if (name.startsWith("TEXCOORD") || name.startsWith("COLOR") || name === "TANGENT") {
        prim.setAttribute(name, null);
      }
    }
  }
}
await doc.transform(dedup(), prune(), weld());

/* ---------------- 1. scaffold filter ---------------- */

const prim = root.listMeshes()[0].listPrimitives()[0];
const pos = prim.getAttribute("POSITION");
const srcIdx = prim.getIndices();
const indices = srcIdx.getArray();
const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];

const bmin = [Infinity, Infinity, Infinity];
const bmax = [-Infinity, -Infinity, -Infinity];
for (let v = 0; v < pos.getCount(); v++) {
  pos.getElement(v, a);
  for (let k = 0; k < 3; k++) {
    if (a[k] < bmin[k]) bmin[k] = a[k];
    if (a[k] > bmax[k]) bmax[k] = a[k];
  }
}
const half = Math.max(...bmin.map((v, k) => (bmax[k] - v) / 2));
const triCount = indices.length / 3;

/* --- escape-ray visibility test --- */
const visible = new Uint8Array(triCount);
{
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos.getArray().slice(), 3));
  geometry.setIndex(new THREE.BufferAttribute(indices.slice(), 1));
  console.log("building BVH…");
  const bvh = new MeshBVH(geometry);

  const eps = half * 1e-3;
  const ray = new THREE.Ray();
  let seen = 0;
  const t0 = Date.now();
  for (let t = 0; t < triCount; t++) {
    const i0 = indices[t * 3] * 3, i1 = indices[t * 3 + 1] * 3, i2 = indices[t * 3 + 2] * 3;
    const arr = pos.getArray();
    const cx = (arr[i0] + arr[i1] + arr[i2]) / 3;
    const cy = (arr[i0 + 1] + arr[i1 + 1] + arr[i2 + 1]) / 3;
    const cz = (arr[i0 + 2] + arr[i1 + 2] + arr[i2 + 2]) / 3;
    const ux = arr[i1] - arr[i0], uy = arr[i1 + 1] - arr[i0 + 1], uz = arr[i1 + 2] - arr[i0 + 2];
    const vx = arr[i2] - arr[i0], vy = arr[i2 + 1] - arr[i0 + 1], vz = arr[i2 + 2] - arr[i0 + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz);
    if (!nl) continue;
    nx /= nl; ny /= nl; nz /= nl;

    ray.direction.set(nx, ny, nz);
    ray.origin.set(cx + nx * eps, cy + ny * eps, cz + nz * eps);
    if (!bvh.raycastFirst(ray, THREE.DoubleSide)) {
      visible[t] = 1;
      seen++;
      continue;
    }
    ray.direction.set(-nx, -ny, -nz);
    ray.origin.set(cx - nx * eps, cy - ny * eps, cz - nz * eps);
    if (!bvh.raycastFirst(ray, THREE.DoubleSide)) {
      visible[t] = 1;
      seen++;
    }
    if (t % 100000 === 0) {
      console.log(`visibility: ${t}/${triCount} (${seen} visible, ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
  }
  console.log(`visibility: ${seen} of ${triCount} tris directly visible`);
}

/* --- dilate the visible set across edge adjacency --- */
{
  const M = pos.getCount() + 1;
  const edgeTri = new Map(); // edge key -> first tri seen
  const adj = new Int32Array(triCount * 3).fill(-1);
  const adjCount = new Uint8Array(triCount);
  const link = (t1, t2) => {
    if (adjCount[t1] < 3) adj[t1 * 3 + adjCount[t1]++] = t2;
    if (adjCount[t2] < 3) adj[t2 * 3 + adjCount[t2]++] = t1;
  };
  for (let t = 0; t < triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const p = indices[t * 3 + e], q = indices[t * 3 + ((e + 1) % 3)];
      const k = p < q ? p * M + q : q * M + p;
      const other = edgeTri.get(k);
      if (other === undefined) edgeTri.set(k, t);
      else link(other, t);
    }
  }
  let frontier = [];
  for (let t = 0; t < triCount; t++) if (visible[t]) frontier.push(t);
  for (let ring = 0; ring < DILATE_RINGS; ring++) {
    const next = [];
    for (const t of frontier) {
      for (let e = 0; e < 3; e++) {
        const o = adj[t * 3 + e];
        if (o >= 0 && !visible[o]) {
          visible[o] = 1;
          next.push(o);
        }
      }
    }
    frontier = next;
    if (!next.length) break;
  }
}

let kept = [];
for (let t = 0; t < triCount; t++) {
  if (visible[t]) kept.push(indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]);
}
console.log(
  `visibility filter: ${triCount} -> ${kept.length / 3} tris (dropped ${triCount - kept.length / 3} hidden)`
);

/* ---------------- 2. largest connected component ---------------- */

{
  const vCount = pos.getCount();
  const parent = new Uint32Array(vCount).map((_, i) => i);
  const find = (v) => {
    while (parent[v] !== v) {
      parent[v] = parent[parent[v]];
      v = parent[v];
    }
    return v;
  };
  for (let i = 0; i < kept.length; i += 3) {
    const r = find(kept[i]);
    parent[find(kept[i + 1])] = r;
    parent[find(kept[i + 2])] = r;
  }
  const size = new Map();
  for (let i = 0; i < kept.length; i += 3) {
    const r = find(kept[i]);
    size.set(r, (size.get(r) ?? 0) + 1);
  }
  let best = -1, bestN = 0;
  for (const [r, n] of size) if (n > bestN) { best = r; bestN = n; }
  const main = [];
  for (let i = 0; i < kept.length; i += 3) {
    if (find(kept[i]) === best) main.push(kept[i], kept[i + 1], kept[i + 2]);
  }
  console.log(`components: ${size.size}, kept ${main.length / 3} tris`);
  kept = main;
}

/* ---------------- 3. cap boundary loops ---------------- */

{
  const vCount = pos.getCount();
  const M = vCount + 1;
  const edgeCount = new Map();
  for (let i = 0; i < kept.length; i += 3) {
    for (let e = 0; e < 3; e++) {
      const p = kept[i + e], q = kept[i + ((e + 1) % 3)];
      const k = p < q ? p * M + q : q * M + p;
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
    }
  }
  const outEdges = new Map();
  for (let i = 0; i < kept.length; i += 3) {
    for (let e = 0; e < 3; e++) {
      const p = kept[i + e], q = kept[i + ((e + 1) % 3)];
      const k = p < q ? p * M + q : q * M + p;
      if (edgeCount.get(k) === 1) {
        let lst = outEdges.get(p);
        if (!lst) outEdges.set(p, (lst = []));
        lst.push(q);
      }
    }
  }

  const el = [0, 0, 0];
  const extraPos = [];
  let loops = 0, capped = 0, skipped = 0;
  for (const start of outEdges.keys()) {
    let lst;
    while ((lst = outEdges.get(start)) && lst.length) {
      const loop = [start];
      let v = lst.pop();
      let guard = 0;
      while (v !== start && guard++ < 1_000_000) {
        loop.push(v);
        const nxt = outEdges.get(v);
        if (!nxt || !nxt.length) { v = -1; break; }
        v = nxt.pop();
      }
      loops++;
      if (v !== start || loop.length < 3) { skipped++; continue; }

      const arr = pos.getArray();
      const n = loop.length;
      let sx = 0, sy = 0, sz = 0;
      for (const vi of loop) {
        sx += arr[vi * 3];
        sy += arr[vi * 3 + 1];
        sz += arr[vi * 3 + 2];
      }
      const cx = sx / n, cy = sy / n, cz = sz / n;

      if (n > 60) {
        /* big jagged rims (from the visibility cuts) are never visible —
           a flat fan is enough to seal them */
        const ci = vCount + extraPos.length / 3;
        extraPos.push(cx, cy, cz);
        for (let i = 0; i < n; i++) {
          kept.push(loop[i], loop[(i + 1) % n], ci);
        }
      } else {
        /* Small loops are the VISIBLE holes (nostrils, ear canals, scan
           gaps). A flat fan there reads as a black plug once AO shades it,
           so instead build a two-ring patch and Laplacian-relax it into a
           smooth continuation of the surrounding surface — the hole simply
           becomes marble. */
        const ring = [];
        for (let i = 0; i < n; i++) {
          const a2 = loop[i] * 3, b2 = loop[(i + 1) % n] * 3;
          ring.push([
            (arr[a2] + arr[b2]) / 4 + cx / 2,
            (arr[a2 + 1] + arr[b2 + 1]) / 4 + cy / 2,
            (arr[a2 + 2] + arr[b2 + 2]) / 4 + cz / 2,
          ]);
        }
        let ctr = [cx, cy, cz];
        for (let it = 0; it < 30; it++) {
          const next = ring.map((_, i) => {
            const p0 = loop[i] * 3, p1 = loop[(i + 1) % n] * 3;
            const rm = ring[(i - 1 + n) % n], rp = ring[(i + 1) % n];
            return [
              (arr[p0] + arr[p1] + rm[0] + rp[0] + ctr[0]) / 5,
              (arr[p0 + 1] + arr[p1 + 1] + rm[1] + rp[1] + ctr[1]) / 5,
              (arr[p0 + 2] + arr[p1 + 2] + rm[2] + rp[2] + ctr[2]) / 5,
            ];
          });
          ctr = next
            .reduce((s2, r) => [s2[0] + r[0], s2[1] + r[1], s2[2] + r[2]], [0, 0, 0])
            .map((v2) => v2 / n);
          for (let i = 0; i < n; i++) ring[i] = next[i];
        }
        const ringBase = vCount + extraPos.length / 3;
        for (const r of ring) extraPos.push(r[0], r[1], r[2]);
        const ci = vCount + extraPos.length / 3;
        extraPos.push(ctr[0], ctr[1], ctr[2]);
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          kept.push(loop[i], loop[j], ringBase + i);
          kept.push(loop[j], ringBase + j, ringBase + i);
          kept.push(ringBase + i, ringBase + j, ci);
        }
      }
      capped++;
    }
  }
  console.log(`cap: ${loops} boundary loops, ${capped} capped, ${skipped} skipped`);

  if (extraPos.length) {
    const oldArr = pos.getArray();
    const merged = new Float32Array(oldArr.length + extraPos.length);
    merged.set(oldArr);
    merged.set(extraPos, oldArr.length);
    pos.setArray(merged);
  }
}

srcIdx.setArray(Uint32Array.from(kept));

await doc.transform(prune());

/* ---------------- 4. watertight recast (voxel re-solidify) ---------------- */

function voxelRemesh(positions, indices) {
  const rbmin = [Infinity, Infinity, Infinity];
  const rbmax = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < rbmin[k]) rbmin[k] = v;
      if (v > rbmax[k]) rbmax[k] = v;
    }
  }
  const span = rbmax.map((v, k) => v - rbmin[k]);
  const h = Math.max(...span) / RES;
  const pad = 4;
  const nx = Math.ceil(span[0] / h) + pad * 2;
  const ny = Math.ceil(span[1] / h) + pad * 2;
  const nz = Math.ceil(span[2] / h) + pad * 2;
  const ox = rbmin[0] - pad * h;
  const oy = rbmin[1] - pad * h;
  const oz = rbmin[2] - pad * h;
  const cells = nx * ny * nz;
  const sxy = nx * ny;
  console.log(`voxel grid: ${nx} x ${ny} x ${nz} (${(cells / 1e6).toFixed(0)}M cells)`);

  const state = new Uint8Array(cells); // 0 unknown, 1 surface, 2 outside
  const ci = (x, y, z) => (z * ny + y) * nx + x;

  /* stamp surface cells, subdividing triangles bigger than a voxel */
  const stack = [];
  const mark = (px, py, pz) => {
    state[ci(Math.floor((px - ox) / h), Math.floor((py - oy) / h), Math.floor((pz - oz) / h))] = 1;
  };
  const lim = 0.7 * h;
  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i] * 3, i1 = indices[i + 1] * 3, i2 = indices[i + 2] * 3;
    stack.push(
      positions[i0], positions[i0 + 1], positions[i0 + 2],
      positions[i1], positions[i1 + 1], positions[i1 + 2],
      positions[i2], positions[i2 + 1], positions[i2 + 2]
    );
    while (stack.length) {
      const cz2 = stack.pop(), cy2 = stack.pop(), cx2 = stack.pop();
      const bz = stack.pop(), by = stack.pop(), bx = stack.pop();
      const az = stack.pop(), ay = stack.pop(), ax = stack.pop();
      const e0 = Math.hypot(bx - ax, by - ay, bz - az);
      const e1 = Math.hypot(cx2 - bx, cy2 - by, cz2 - bz);
      const e2 = Math.hypot(ax - cx2, ay - cy2, az - cz2);
      if (Math.max(e0, e1, e2) > lim) {
        const m01 = [(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2];
        const m12 = [(bx + cx2) / 2, (by + cy2) / 2, (bz + cz2) / 2];
        const m20 = [(cx2 + ax) / 2, (cy2 + ay) / 2, (cz2 + az) / 2];
        stack.push(ax, ay, az, ...m01, ...m20);
        stack.push(...m01, bx, by, bz, ...m12);
        stack.push(...m20, ...m12, cx2, cy2, cz2);
        stack.push(...m01, ...m12, ...m20);
      } else {
        mark(ax, ay, az);
        mark(bx, by, bz);
        mark(cx2, cy2, cz2);
        mark((ax + bx + cx2) / 3, (ay + by + cy2) / 3, (az + bz + cz2) / 3);
      }
    }
  }

  /* flood-fill OUTSIDE from the border */
  const queue = new Int32Array(cells);
  let qh = 0, qt = 0;
  const seed = (x, y, z) => {
    const i = ci(x, y, z);
    if (state[i] === 0) {
      state[i] = 2;
      queue[qt++] = i;
    }
  };
  for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) { seed(x, y, 0); seed(x, y, nz - 1); }
  for (let x = 0; x < nx; x++) for (let z = 0; z < nz; z++) { seed(x, 0, z); seed(x, ny - 1, z); }
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) { seed(0, y, z); seed(nx - 1, y, z); }
  while (qh < qt) {
    const i = queue[qh++];
    const x = i % nx;
    const y = ((i / nx) | 0) % ny;
    if (x > 0 && state[i - 1] === 0) { state[i - 1] = 2; queue[qt++] = i - 1; }
    if (x < nx - 1 && state[i + 1] === 0) { state[i + 1] = 2; queue[qt++] = i + 1; }
    if (y > 0 && state[i - nx] === 0) { state[i - nx] = 2; queue[qt++] = i - nx; }
    if (y < ny - 1 && state[i + nx] === 0) { state[i + nx] = 2; queue[qt++] = i + nx; }
    if (i - sxy >= 0 && state[i - sxy] === 0) { state[i - sxy] = 2; queue[qt++] = i - sxy; }
    if (i + sxy < cells && state[i + sxy] === 0) { state[i + sxy] = 2; queue[qt++] = i + sxy; }
  }
  let inside = 0;
  for (let i = 0; i < cells; i++) if (state[i] === 0) inside++;
  console.log(`flood: inside ${(inside / 1e6).toFixed(1)}M cells (${((inside / cells) * 100).toFixed(1)}%)`);
  if (inside < cells * 0.02) {
    throw new Error("flood leaked — an unsealed hole let the outside into the bust interior");
  }

  /* field + one gentle blur pass (radius 1) — just enough to antialias the
     voxel steps without eating sculpt detail */
  let field = new Float32Array(cells);
  for (let i = 0; i < cells; i++) {
    field[i] = state[i] === 0 ? 1 : state[i] === 1 ? SURFACE_VALUE : 0;
  }
  let tmp = new Float32Array(cells);
  const blurAxis = (src, dst, stride, count, lineStride, lines) => {
    for (let L = 0; L < lines; L++) {
      const base = lineStride(L);
      let prev = 0, cur = src[base];
      for (let i = 0; i < count; i++) {
        const nxt = i + 1 < count ? src[base + (i + 1) * stride] : 0;
        dst[base + i * stride] = (prev + cur + nxt) / 3;
        prev = cur;
        cur = nxt;
      }
    }
  };
  blurAxis(field, tmp, 1, nx, (L) => L * nx, ny * nz);
  blurAxis(tmp, field, nx, ny, (L) => ((L / nx) | 0) * sxy + (L % nx), nx * nz);
  blurAxis(field, tmp, sxy, nz, (L) => L, sxy);
  [field, tmp] = [tmp, field];
  tmp = null;

  /* surface nets */
  const vertMap = new Int32Array(cells).fill(-1);
  const outPos = [];
  const outNrm = [];
  const outIdx = [];
  const F = (x, y, z) => field[(z * ny + y) * nx + x];
  let vCount = 0;

  for (let z = 0; z < nz - 1; z++) {
    for (let y = 0; y < ny - 1; y++) {
      for (let x = 0; x < nx - 1; x++) {
        const f000 = F(x, y, z), f100 = F(x + 1, y, z);
        const f010 = F(x, y + 1, z), f110 = F(x + 1, y + 1, z);
        const f001 = F(x, y, z + 1), f101 = F(x + 1, y, z + 1);
        const f011 = F(x, y + 1, z + 1), f111 = F(x + 1, y + 1, z + 1);
        let mask = 0;
        if (f000 >= ISO) mask |= 1;
        if (f100 >= ISO) mask |= 2;
        if (f010 >= ISO) mask |= 4;
        if (f110 >= ISO) mask |= 8;
        if (f001 >= ISO) mask |= 16;
        if (f101 >= ISO) mask |= 32;
        if (f011 >= ISO) mask |= 64;
        if (f111 >= ISO) mask |= 128;
        if (mask === 0 || mask === 255) continue;

        let px = 0, py = 0, pz = 0, ecount = 0;
        const edge = (fa, fb, ax2, ay2, az2, bx2, by2, bz2) => {
          if ((fa >= ISO) === (fb >= ISO)) return;
          const t = (ISO - fa) / (fb - fa);
          px += ax2 + (bx2 - ax2) * t;
          py += ay2 + (by2 - ay2) * t;
          pz += az2 + (bz2 - az2) * t;
          ecount++;
        };
        edge(f000, f100, 0, 0, 0, 1, 0, 0);
        edge(f010, f110, 0, 1, 0, 1, 1, 0);
        edge(f001, f101, 0, 0, 1, 1, 0, 1);
        edge(f011, f111, 0, 1, 1, 1, 1, 1);
        edge(f000, f010, 0, 0, 0, 0, 1, 0);
        edge(f100, f110, 1, 0, 0, 1, 1, 0);
        edge(f001, f011, 0, 0, 1, 0, 1, 1);
        edge(f101, f111, 1, 0, 1, 1, 1, 1);
        edge(f000, f001, 0, 0, 0, 0, 0, 1);
        edge(f100, f101, 1, 0, 0, 1, 0, 1);
        edge(f010, f011, 0, 1, 0, 0, 1, 1);
        edge(f110, f111, 1, 1, 0, 1, 1, 1);

        vertMap[ci(x, y, z)] = vCount++;
        outPos.push(ox + (x + px / ecount) * h, oy + (y + py / ecount) * h, oz + (z + pz / ecount) * h);
        const gx = (f100 + f110 + f101 + f111 - f000 - f010 - f001 - f011) / 4;
        const gy = (f010 + f110 + f011 + f111 - f000 - f100 - f001 - f101) / 4;
        const gz = (f001 + f101 + f011 + f111 - f000 - f100 - f010 - f110) / 4;
        const gl = Math.hypot(gx, gy, gz) || 1;
        outNrm.push(-gx / gl, -gy / gl, -gz / gl);
      }
    }
  }

  const quad = (v0, v1, v2, v3, flip) => {
    if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) return;
    if (flip) {
      outIdx.push(v0, v1, v2, v0, v2, v3);
    } else {
      outIdx.push(v0, v3, v2, v0, v2, v1);
    }
  };
  for (let z = 1; z < nz - 1; z++) {
    for (let y = 1; y < ny - 1; y++) {
      for (let x = 1; x < nx - 1; x++) {
        const inside0 = F(x, y, z) >= ISO;
        if ((F(x + 1, y, z) >= ISO) !== inside0) {
          quad(
            vertMap[ci(x, y - 1, z - 1)], vertMap[ci(x, y, z - 1)],
            vertMap[ci(x, y, z)], vertMap[ci(x, y - 1, z)],
            inside0
          );
        }
        if ((F(x, y + 1, z) >= ISO) !== inside0) {
          quad(
            vertMap[ci(x - 1, y, z - 1)], vertMap[ci(x - 1, y, z)],
            vertMap[ci(x, y, z)], vertMap[ci(x, y, z - 1)],
            inside0
          );
        }
        if ((F(x, y, z + 1) >= ISO) !== inside0) {
          quad(
            vertMap[ci(x - 1, y - 1, z)], vertMap[ci(x, y - 1, z)],
            vertMap[ci(x, y, z)], vertMap[ci(x - 1, y, z)],
            inside0
          );
        }
      }
    }
  }

  console.log(`surface nets: ${vCount.toLocaleString()} verts, ${(outIdx.length / 3).toLocaleString()} tris`);
  return {
    positions: Float32Array.from(outPos),
    normals: Float32Array.from(outNrm),
    indices: Uint32Array.from(outIdx),
  };
}

const remesh = voxelRemesh(pos.getArray(), srcIdx.getArray());

/* Reprojection: snap every recast vertex back onto the ORIGINAL scan
   surface wherever one exists nearby. The skin becomes bit-identical to
   the source sculpt — no voxel fingerprint at all — and only the sealed
   hole patches (no original surface to snap to) keep the synthetic
   continuation, blended by the light smoothing pass below. */
{
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos.getArray().slice(), 3));
  geometry.setIndex(new THREE.BufferAttribute(srcIdx.getArray().slice(), 1));
  const bvh = new MeshBVH(geometry);
  const bspan = Math.max(bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2]);
  const maxD = (bspan / RES) * 1.8; // ~2 voxels
  const p = new THREE.Vector3();
  const res = {};
  const rp = remesh.positions;
  let snapped = 0;
  for (let v = 0; v < rp.length / 3; v++) {
    p.set(rp[v * 3], rp[v * 3 + 1], rp[v * 3 + 2]);
    const hit = bvh.closestPointToPoint(p, res, 0, maxD);
    if (hit) {
      rp[v * 3] = hit.point.x;
      rp[v * 3 + 1] = hit.point.y;
      rp[v * 3 + 2] = hit.point.z;
      snapped++;
    }
  }
  console.log(
    `reproject: ${snapped.toLocaleString()} of ${(rp.length / 3).toLocaleString()} verts snapped to the original surface`
  );
}

/* Gentle Taubin blend (shrink-free λ|μ pairs): fuses the snapped surface
   with the sealed hole patches and relaxes reprojection jitter without
   measurably moving the sculpt. */
{
  const positions = remesh.positions;
  const indices = remesh.indices;
  const vc = positions.length / 3;
  const acc = new Float32Array(positions.length);
  const deg = new Float32Array(vc);
  const step = (lambda) => {
    acc.fill(0);
    deg.fill(0);
    for (let i = 0; i < indices.length; i += 3) {
      for (let e = 0; e < 3; e++) {
        const a2 = indices[i + e], b2 = indices[i + ((e + 1) % 3)];
        acc[a2 * 3] += positions[b2 * 3];
        acc[a2 * 3 + 1] += positions[b2 * 3 + 1];
        acc[a2 * 3 + 2] += positions[b2 * 3 + 2];
        acc[b2 * 3] += positions[a2 * 3];
        acc[b2 * 3 + 1] += positions[a2 * 3 + 1];
        acc[b2 * 3 + 2] += positions[a2 * 3 + 2];
        deg[a2]++;
        deg[b2]++;
      }
    }
    for (let v = 0; v < vc; v++) {
      const d = deg[v];
      if (!d) continue;
      positions[v * 3] += lambda * (acc[v * 3] / d - positions[v * 3]);
      positions[v * 3 + 1] += lambda * (acc[v * 3 + 1] / d - positions[v * 3 + 1]);
      positions[v * 3 + 2] += lambda * (acc[v * 3 + 2] / d - positions[v * 3 + 2]);
    }
  };
  for (let it = 0; it < 2; it++) {
    step(0.5);
    step(-0.53);
  }
  console.log("taubin: 2 blend iterations");

  /* recompute normals for the smoothed surface */
  const nrm = remesh.normals;
  nrm.fill(0);
  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i] * 3, i1 = indices[i + 1] * 3, i2 = indices[i + 2] * 3;
    const ux = positions[i1] - positions[i0], uy = positions[i1 + 1] - positions[i0 + 1], uz = positions[i1 + 2] - positions[i0 + 2];
    const vx = positions[i2] - positions[i0], vy = positions[i2 + 1] - positions[i0 + 1], vz = positions[i2 + 2] - positions[i0 + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    nrm[i0] += cx; nrm[i0 + 1] += cy; nrm[i0 + 2] += cz;
    nrm[i1] += cx; nrm[i1 + 1] += cy; nrm[i1 + 2] += cz;
    nrm[i2] += cx; nrm[i2 + 1] += cy; nrm[i2 + 2] += cz;
  }
  for (let v = 0; v < vc; v++) {
    const len = Math.hypot(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]) || 1;
    nrm[v * 3] /= len;
    nrm[v * 3 + 1] /= len;
    nrm[v * 3 + 2] /= len;
  }
}

/* fresh document for the recast mesh */
const out = new Document();
const outBuffer = out.createBuffer();
const outPrim = out
  .createPrimitive()
  .setAttribute(
    "POSITION",
    out.createAccessor().setType(Accessor.Type.VEC3).setArray(remesh.positions).setBuffer(outBuffer)
  )
  .setAttribute(
    "NORMAL",
    out.createAccessor().setType(Accessor.Type.VEC3).setArray(remesh.normals).setBuffer(outBuffer)
  )
  .setIndices(
    out.createAccessor().setType(Accessor.Type.SCALAR).setArray(remesh.indices).setBuffer(outBuffer)
  );
out.createScene("scene").addChild(out.createNode("head").setMesh(out.createMesh("head").addPrimitive(outPrim)));

/* ---------------- 5. simplify ---------------- */

const trisNow = remesh.indices.length / 3;
if (trisNow > TARGET_TRIANGLES) {
  await out.transform(
    simplify({ simplifier: MeshoptSimplifier, ratio: TARGET_TRIANGLES / trisNow, error: 0.0003 })
  );
}
const finalPrim = out.getRoot().listMeshes()[0].listPrimitives()[0];
console.log(`final: ${(finalPrim.getIndices().getCount() / 3).toLocaleString()} tris`);

/* ---------------- 5. bake ambient occlusion ---------------- */

/* SKIP_AO=1 skips the slow bake (minutes on ~1M verts) for fast geometry
   iterations; the site's plain material doesn't read AO. */
if (process.env.SKIP_AO !== "1") {
  const fpos = finalPrim.getAttribute("POSITION");
  const fidx = finalPrim.getIndices();
  const vCount = fpos.getCount();

  /* The Meshy export ships no NORMAL attribute (viewers compute one on the
     fly) — compute smooth area-weighted vertex normals here so the AO bake
     has directions and the client gets them for free. */
  let fnrm = finalPrim.getAttribute("NORMAL");
  if (!fnrm) {
    const p = fpos.getArray();
    const idxArr = fidx.getArray();
    const nrmArr = new Float32Array(vCount * 3);
    for (let i = 0; i < idxArr.length; i += 3) {
      const i0 = idxArr[i] * 3, i1 = idxArr[i + 1] * 3, i2 = idxArr[i + 2] * 3;
      const ux = p[i1] - p[i0], uy = p[i1 + 1] - p[i0 + 1], uz = p[i1 + 2] - p[i0 + 2];
      const vx = p[i2] - p[i0], vy = p[i2 + 1] - p[i0 + 1], vz = p[i2 + 2] - p[i0 + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      nrmArr[i0] += cx; nrmArr[i0 + 1] += cy; nrmArr[i0 + 2] += cz;
      nrmArr[i1] += cx; nrmArr[i1 + 1] += cy; nrmArr[i1 + 2] += cz;
      nrmArr[i2] += cx; nrmArr[i2 + 1] += cy; nrmArr[i2 + 2] += cz;
    }
    for (let v = 0; v < vCount; v++) {
      const len = Math.hypot(nrmArr[v * 3], nrmArr[v * 3 + 1], nrmArr[v * 3 + 2]) || 1;
      nrmArr[v * 3] /= len;
      nrmArr[v * 3 + 1] /= len;
      nrmArr[v * 3 + 2] /= len;
    }
    fnrm = out
      .createAccessor()
      .setType(Accessor.Type.VEC3)
      .setArray(nrmArr)
      .setBuffer(out.getRoot().listBuffers()[0]);
    finalPrim.setAttribute("NORMAL", fnrm);
    console.log("normals: computed (export had none)");
  }

  /* AO only needs coarse occlusion, so the rays are cast against a
     decimated proxy of the mesh — ~5x smaller BVH, same shadows. */
  const fullIdx = fidx.getArray();
  const [proxyIdx] = MeshoptSimplifier.simplify(
    fullIdx instanceof Uint32Array ? fullIdx : Uint32Array.from(fullIdx),
    fpos.getArray(),
    3,
    350_000 * 3,
    0.01,
    []
  );
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(fpos.getArray().slice(), 3));
  geometry.setIndex(new THREE.BufferAttribute(proxyIdx, 1));
  const bvh = new MeshBVH(geometry);

  const SAMPLES = 14;
  const dirs = [];
  const GA = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < SAMPLES; i++) {
    const u = (i + 0.5) / SAMPLES;
    const cosT = Math.sqrt(1 - u);
    const sinT = Math.sqrt(u);
    dirs.push([Math.cos(GA * i) * sinT, Math.sin(GA * i) * sinT, cosT]);
  }

  const bb = new THREE.Box3().setFromBufferAttribute(geometry.getAttribute("position"));
  const maxDist = bb.getSize(new THREE.Vector3()).length() * 0.22;
  const ray = new THREE.Ray();
  const n = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3();
  const colors = new Float32Array(vCount * 3);
  const el = [0, 0, 0];

  for (let v = 0; v < vCount; v++) {
    fpos.getElement(v, el);
    const px = el[0], py = el[1], pz = el[2];
    fnrm.getElement(v, el);
    n.set(el[0], el[1], el[2]).normalize();
    t1.set(1, 0, 0);
    if (Math.abs(n.x) > 0.9) t1.set(0, 1, 0);
    t1.cross(n).normalize();
    t2.crossVectors(n, t1);

    let occ = 0;
    for (const [dx, dy, dz] of dirs) {
      ray.direction
        .copy(t1).multiplyScalar(dx)
        .addScaledVector(t2, dy)
        .addScaledVector(n, dz);
      ray.origin.set(
        px + n.x * 0.002 + ray.direction.x * 0.001,
        py + n.y * 0.002 + ray.direction.y * 0.001,
        pz + n.z * 0.002 + ray.direction.z * 0.001
      );
      const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
      if (hit) {
        const d = hit.distance ?? ray.origin.distanceTo(hit.point);
        if (d < maxDist) occ += 1 - d / maxDist;
      }
    }
    const ao = Math.max(0.12, 1 - occ / SAMPLES);
    colors[v * 3] = ao;
    colors[v * 3 + 1] = ao;
    colors[v * 3 + 2] = ao;
    if (v % 20000 === 0) process.stdout.write(`\rAO: ${v}/${vCount}`);
  }
  console.log(`\rAO: ${vCount}/${vCount} verts baked`);

  finalPrim.setAttribute(
    "COLOR_0",
    out
      .createAccessor()
      .setType(Accessor.Type.VEC3)
      .setArray(colors)
      .setBuffer(out.getRoot().listBuffers()[0])
  );
}

/* ---------------- 6. compress + write ---------------- */

await out.transform(quantize({ quantizePosition: 16, quantizeNormal: 12 }));
out
  .createExtension(EXTMeshoptCompression)
  .setRequired(true)
  .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });

mkdirSync(dirname(output), { recursive: true });
await io.write(output, out);
console.log(`output: ${output} (${(statSync(output).size / 1e6).toFixed(2)} MB)`);
