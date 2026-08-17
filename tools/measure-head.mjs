/**
 * Measures the head's real extents in the normalised carve frame so the
 * CARVE box in process-model.mjs can be tightened with data instead of
 * guesses. Uses the central column (|x| < 0.15), which the curtain sheets
 * (|x| > 0.28) never enter, to find the skull's true back and front per
 * y band; and reports max |x| of geometry per y band forward of the skull
 * mid-plane for head width.
 */
import { NodeIO } from "@gltf-transform/core";

const io = new NodeIO();
const doc = await io.read(process.argv[2]);
const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
const pos = prim.getAttribute("POSITION");

const el = [0, 0, 0];
const n = pos.getCount();
const bmin = [Infinity, Infinity, Infinity];
const bmax = [-Infinity, -Infinity, -Infinity];
for (let v = 0; v < n; v++) {
  pos.getElement(v, el);
  for (let k = 0; k < 3; k++) {
    if (el[k] < bmin[k]) bmin[k] = el[k];
    if (el[k] > bmax[k]) bmax[k] = el[k];
  }
}
const ctr = bmin.map((v, k) => (v + bmax[k]) / 2);
const h = Math.max(...bmin.map((v, k) => (bmax[k] - v) / 2));

const BANDS = 16; // y from -1 to 1
const zMin = Array(BANDS).fill(Infinity);
const zMax = Array(BANDS).fill(-Infinity);
const xMax = Array(BANDS).fill(0);
for (let v = 0; v < n; v++) {
  pos.getElement(v, el);
  const x = (el[0] - ctr[0]) / h;
  const y = (el[1] - ctr[1]) / h;
  const z = (el[2] - ctr[2]) / h;
  const band = Math.min(BANDS - 1, Math.max(0, Math.floor(((y + 1) / 2) * BANDS)));
  if (Math.abs(x) < 0.15) {
    if (z < zMin[band]) zMin[band] = z;
    if (z > zMax[band]) zMax[band] = z;
  }
  // head width: only count geometry in the skull's z range, away from the
  // back wall and the front curtain plane
  if (z > -0.35 && z < 0.2 && Math.abs(x) > xMax[band]) xMax[band] = Math.abs(x);
}
console.log("y band      zMin(center)  zMax(center)  max|x| (z in -0.35..0.2)");
for (let i = 0; i < BANDS; i++) {
  const y0 = -1 + (2 * i) / BANDS;
  console.log(
    `${y0.toFixed(2).padStart(6)}..${(y0 + 2 / BANDS).toFixed(2)}  ${zMin[i] === Infinity ? "   -  " : zMin[i].toFixed(2).padStart(6)}       ${zMax[i] === -Infinity ? "   -  " : zMax[i].toFixed(2).padStart(6)}       ${xMax[i].toFixed(2)}`
  );
}
