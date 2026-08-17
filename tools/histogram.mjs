/**
 * Where does the junk live? Bins triangle AREA by centroid along each axis,
 * split into "flat wall" triangles (normal aligned to that axis) vs the rest.
 * Walls and curtain-sheet artifacts show up as sharp area spikes.
 * Run: node tools/histogram.mjs public/simon.glb
 */
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
const doc = await io.read(process.argv[2] ?? "public/simon.glb");

const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
const pos = prim.getAttribute("POSITION");
const idx = prim.getIndices().getArray();

const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];
const BINS = 40;
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
const el = [0, 0, 0];
for (let v = 0; v < pos.getCount(); v++) {
  pos.getElement(v, el);
  for (let k = 0; k < 3; k++) {
    if (el[k] < min[k]) min[k] = el[k];
    if (el[k] > max[k]) max[k] = el[k];
  }
}
console.log("bbox min", min.map((v) => v.toFixed(3)).join(", "), " max", max.map((v) => v.toFixed(3)).join(", "));

// [axis][bin] -> {flat, other} area
const hist = [0, 1, 2].map(() => Array.from({ length: BINS }, () => ({ flat: 0, other: 0 })));

for (let i = 0; i < idx.length; i += 3) {
  pos.getElement(idx[i], a);
  pos.getElement(idx[i + 1], b);
  pos.getElement(idx[i + 2], c);
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (!len) continue;
  const area = len / 2;
  const n = [nx / len, ny / len, nz / len];
  const centroid = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  for (let axis = 0; axis < 3; axis++) {
    const t = (centroid[axis] - min[axis]) / (max[axis] - min[axis]);
    const bin = Math.min(BINS - 1, Math.floor(t * BINS));
    const slot = hist[axis][bin];
    if (Math.abs(n[axis]) > 0.9) slot.flat += area;
    else slot.other += area;
  }
}

const names = ["x", "y", "z"];
for (let axis = 0; axis < 3; axis++) {
  console.log(`\n--- ${names[axis]} axis ---  (flat = |n.${names[axis]}| > 0.9)`);
  for (let i = 0; i < BINS; i++) {
    const lo = min[axis] + ((max[axis] - min[axis]) * i) / BINS;
    const { flat, other } = hist[axis][i];
    const bar = (v) => "#".repeat(Math.min(60, Math.round(v * 300)));
    console.log(
      `${lo.toFixed(2).padStart(6)}  flat ${flat.toFixed(3)} ${bar(flat).padEnd(20)} other ${other.toFixed(3)} ${bar(other)}`
    );
  }
}
