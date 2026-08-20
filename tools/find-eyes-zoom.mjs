/* Fine scan of the eye region; prints depth + AO at 0.02 resolution and
   reports the AO-weighted centroid of each socket. */
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";

const HEAD_HEIGHT = 2.3;
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
const doc = await io.read("public/simon.glb");
const root = doc.getRoot();
let meshNode = null;
for (const n of root.listNodes()) if (n.getMesh()) meshNode = n;
const nodeMatrix = new THREE.Matrix4().compose(
  new THREE.Vector3(...meshNode.getTranslation()),
  new THREE.Quaternion(...meshNode.getRotation()),
  new THREE.Vector3(...meshNode.getScale())
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
  positions.set([v.x, v.y, v.z], i * 3);
}
const box = new THREE.Box3();
const p = new THREE.Vector3();
for (let i = 0; i < vCount; i++) box.expandByPoint(p.fromArray(positions, i * 3));
const c = box.getCenter(new THREE.Vector3());
const scale = HEAD_HEIGHT / box.getSize(new THREE.Vector3()).y;
for (let i = 0; i < vCount; i++) {
  positions[i * 3] = (positions[i * 3] - c.x) * scale;
  positions[i * 3 + 1] = (positions[i * 3 + 1] - c.y) * scale;
  positions[i * 3 + 2] = (positions[i * 3 + 2] - c.z) * scale;
}
const ao = new Float32Array(vCount);
for (let i = 0; i < vCount; i++) { colAcc.getElement(i, el); ao[i] = el[0]; }
const geometry = new THREE.BufferGeometry();
geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(idx), 1));
const bvh = new MeshBVH(geometry);

const STEP = 0.02, X0 = -0.34, X1 = 0.34, Y0 = 0.60, Y1 = 0.20;
const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, 0, -1));
const rows = [];
for (let y = Y0; y >= Y1 - 1e-9; y -= STEP) {
  const row = [];
  for (let x = X0; x <= X1 + 1e-9; x += STEP) {
    ray.origin.set(x, y, 4);
    const hit = bvh.raycastFirst(ray, THREE.FrontSide);
    if (!hit) { row.push(null); continue; }
    const f = hit.faceIndex * 3;
    row.push({ x: +x.toFixed(3), y: +y.toFixed(3), z: hit.point.z, ao: (ao[idx[f]] + ao[idx[f + 1]] + ao[idx[f + 2]]) / 3 });
  }
  rows.push(row);
}
const flat = rows.flat().filter(Boolean);
const zLo = Math.min(...flat.map((h) => h.z)), zHi = Math.max(...flat.map((h) => h.z));
const aLo = Math.min(...flat.map((h) => h.ao)), aHi = Math.max(...flat.map((h) => h.ao));
const RAMP = " .:-=+*#%@";
const chr = (t) => RAMP[Math.min(9, Math.max(0, Math.round(t * 9)))];
console.log(`x ${X0}..${X1} step ${STEP}  |  z ${zLo.toFixed(3)}..${zHi.toFixed(3)}  ao ${aLo.toFixed(3)}..${aHi.toFixed(3)}`);
console.log("\nDEPTH (near=@)          AO (dark=' ')");
rows.forEach((row, i) => {
  const y = Y0 - i * STEP;
  const dz = row.map((h) => (h ? chr((h.z - zLo) / (zHi - zLo)) : " ")).join("");
  const da = row.map((h) => (h ? chr((h.ao - aLo) / (aHi - aLo)) : " ")).join("");
  console.log(y.toFixed(2).padStart(5) + " " + dz + "   " + da);
});
for (const [label, lo, hi] of [["LEFT ", -0.30, -0.04], ["RIGHT", 0.04, 0.30]]) {
  const cand = flat.filter((h) => h.x >= lo && h.x <= hi && h.y >= 0.28 && h.y <= 0.52);
  const minAO = Math.min(...cand.map((h) => h.ao));
  const dark = cand.filter((h) => h.ao <= minAO + 0.06);
  const w = dark.reduce((s, h) => s + (1 - h.ao), 0);
  const cx = dark.reduce((s, h) => s + h.x * (1 - h.ao), 0) / w;
  const cy = dark.reduce((s, h) => s + h.y * (1 - h.ao), 0) / w;
  const cz = dark.reduce((s, h) => s + h.z * (1 - h.ao), 0) / w;
  console.log(`${label} socket centroid: x=${cx.toFixed(3)} y=${cy.toFixed(3)} z=${cz.toFixed(3)}  (${dark.length} samples, min ao ${minAO.toFixed(3)})`);
}
