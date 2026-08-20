/**
 * Locates the eye sockets in the processed bust so the eye-glow shader can
 * be anchored to them. Renders two ASCII maps of the face as seen head-on —
 * surface depth and baked AO — from BVH raycasts, then reports the darkest
 * AO cluster on each side of the centreline (eye sockets are both recessed
 * and the most occluded points on the front of the face).
 *
 * Coordinates are printed in the SITE's local space: the same centre-and-
 * scale normalisation main.js applies after load, so the numbers can be
 * pasted straight into the shader.
 *
 * Usage: node tools/find-eyes.mjs [model.glb]
 */
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";

const HEAD_HEIGHT = 2.3; // must match main.js

await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder });

const doc = await io.read(process.argv[2] ?? "public/simon.glb");
const root = doc.getRoot();

/* find the mesh node and compose its transform (quantised models carry the
   dequantisation in the node TRS) */
let meshNode = null;
for (const node of root.listNodes()) if (node.getMesh()) meshNode = node;
const t = meshNode.getTranslation();
const r = meshNode.getRotation();
const s = meshNode.getScale();
const nodeMatrix = new THREE.Matrix4().compose(
  new THREE.Vector3(...t),
  new THREE.Quaternion(...r),
  new THREE.Vector3(...s)
);

const prim = meshNode.getMesh().listPrimitives()[0];
const posAcc = prim.getAttribute("POSITION");
const colAcc = prim.getAttribute("COLOR_0");
const idx = prim.getIndices().getArray();
const vCount = posAcc.getCount();

const positions = new Float32Array(vCount * 3);
const el = [0, 0, 0];
const v = new THREE.Vector3();
for (let i = 0; i < vCount; i++) {
  posAcc.getElement(i, el);
  v.set(el[0], el[1], el[2]).applyMatrix4(nodeMatrix);
  positions[i * 3] = v.x;
  positions[i * 3 + 1] = v.y;
  positions[i * 3 + 2] = v.z;
}

/* replicate main.js normalisation: centre the bbox, scale to HEAD_HEIGHT */
const box = new THREE.Box3();
const p = new THREE.Vector3();
for (let i = 0; i < vCount; i++) box.expandByPoint(p.fromArray(positions, i * 3));
const centre = box.getCenter(new THREE.Vector3());
const size = box.getSize(new THREE.Vector3());
const scale = HEAD_HEIGHT / size.y;
for (let i = 0; i < vCount; i++) {
  positions[i * 3] = (positions[i * 3] - centre.x) * scale;
  positions[i * 3 + 1] = (positions[i * 3 + 1] - centre.y) * scale;
  positions[i * 3 + 2] = (positions[i * 3 + 2] - centre.z) * scale;
}
console.log(
  `model: ${vCount.toLocaleString()} verts, AO ${colAcc ? "present" : "MISSING"}, ` +
    `normalised bbox y ${(-HEAD_HEIGHT / 2).toFixed(2)}..${(HEAD_HEIGHT / 2).toFixed(2)}`
);

const ao = new Float32Array(vCount);
if (colAcc) for (let i = 0; i < vCount; i++) { colAcc.getElement(i, el); ao[i] = el[0]; }

const geometry = new THREE.BufferGeometry();
geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
geometry.setIndex(new THREE.BufferAttribute(idx instanceof Uint32Array ? idx : Uint32Array.from(idx), 1));
const bvh = new MeshBVH(geometry);
const mesh = new THREE.Mesh(geometry);
mesh.geometry.boundsTree = bvh;

/* head-on raycast grid */
const X0 = -0.55, X1 = 0.55, STEP = 0.05;
const Y0 = 0.95, Y1 = -0.35;
const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, 0, -1));
const cols = Math.round((X1 - X0) / STEP) + 1;
const samples = [];
for (let y = Y0; y >= Y1 - 1e-9; y -= STEP) {
  const row = [];
  for (let c = 0; c < cols; c++) {
    const x = X0 + c * STEP;
    ray.origin.set(x, y, 4);
    const hit = bvh.raycastFirst(ray, THREE.FrontSide);
    if (!hit) { row.push(null); continue; }
    let a = 1;
    if (colAcc && hit.faceIndex != null) {
      const f = hit.faceIndex * 3;
      a = (ao[idx[f]] + ao[idx[f + 1]] + ao[idx[f + 2]]) / 3;
    }
    row.push({ x: +x.toFixed(3), y: +y.toFixed(3), z: hit.point.z, ao: a });
  }
  samples.push(row);
}

const flat = samples.flat().filter(Boolean);
const zLo = Math.min(...flat.map((h) => h.z)), zHi = Math.max(...flat.map((h) => h.z));
const aLo = Math.min(...flat.map((h) => h.ao)), aHi = Math.max(...flat.map((h) => h.ao));
const RAMP = " .:-=+*#%@";
const chr = (t) => RAMP[Math.min(9, Math.max(0, Math.round(t * 9)))];

const header = "      " + Array.from({ length: cols }, (_, c) => (Math.abs((X0 + c * STEP) % 0.25) < 1e-6 ? "|" : " ")).join("");
console.log(`\nDEPTH  (near=@ far=' ')   x ${X0}..${X1} step ${STEP}   z ${zLo.toFixed(2)}..${zHi.toFixed(2)}`);
console.log(header);
for (const row of samples) {
  const y = row.find(Boolean)?.y ?? 0;
  console.log(String(y.toFixed(2)).padStart(5) + " " + row.map((h) => (h ? chr((h.z - zLo) / (zHi - zLo)) : " ")).join(""));
}
console.log(`\nAO  (dark=' ' bright=@)   ao ${aLo.toFixed(2)}..${aHi.toFixed(2)}`);
console.log(header);
for (const row of samples) {
  const y = row.find(Boolean)?.y ?? 0;
  console.log(String(y.toFixed(2)).padStart(5) + " " + row.map((h) => (h ? chr((h.ao - aLo) / (aHi - aLo)) : " ")).join(""));
}

/* darkest-AO point per side within a plausible eye band */
for (const [label, lo, hi] of [["LEFT (x<0)", -0.45, -0.05], ["RIGHT (x>0)", 0.05, 0.45]]) {
  let best = null;
  for (const h of flat) {
    if (h.x < lo || h.x > hi) continue;
    if (h.y < 0.05 || h.y > 0.55) continue; // upper face band
    if (h.z < 0.2) continue; // front surface only
    if (!best || h.ao < best.ao) best = h;
  }
  console.log(`${label} darkest AO in eye band: x=${best.x} y=${best.y} z=${best.z.toFixed(3)} ao=${best.ao.toFixed(3)}`);
}
