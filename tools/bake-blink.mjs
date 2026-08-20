/**
 * Bakes the blink into the shipped models.
 *
 * The deformation itself is not recomputed here — it is exported straight
 * from the region painter (window.bakeForSite, saved to regions/bake-*.json),
 * so what ends up in the model is exactly what was approved on screen rather
 * than a second implementation that would have to be kept in step.
 *
 * Two things get written into each GLB:
 *   - a morph target named "blink": the closed-eye offsets, which the site
 *     animates from 0 to 1 and back
 *   - the painted regions, folded into the spare channels of COLOR_0, whose
 *     red channel already carries baked AO. Green becomes a feathered eye
 *     mask (the shader lights exactly the area that was painted) and blue a
 *     lash mask.
 *
 * Usage: node tools/bake-blink.mjs
 */
import { Accessor, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshoptCompression } from "@gltf-transform/extensions";
import { quantize } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import * as THREE from "three";
import { readFileSync, statSync } from "node:fs";

const HEAD_HEIGHT = 2.3; // must match src/main.js
const FEATHER_RINGS = 3; // how far the eye mask fades past what was painted

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });

for (const model of ["simon.glb", "simon_mobile.glb"]) {
  const bakePath = `regions/bake-${model}.json`;
  const bake = JSON.parse(readFileSync(bakePath, "utf8"));
  const path = `public/${model}`;
  const before = statSync(path).size;

  const doc = await io.read(path);
  const root = doc.getRoot();
  let node = null;
  for (const n of root.listNodes()) if (n.getMesh()) node = n;
  const prim = node.getMesh().listPrimitives()[0];
  const pos = prim.getAttribute("POSITION");
  const nrm = prim.getAttribute("NORMAL");
  const col = prim.getAttribute("COLOR_0");
  const idx = prim.getIndices().getArray();
  const count = pos.getCount();

  if (count !== bake.vertexCount) {
    console.error(`${model}: bake has ${bake.vertexCount} verts, model has ${count} — re-bake this model`);
    continue;
  }

  /* Fold the node's dequantisation transform into the vertices so everything
     below works in one plain space; the node goes back to identity and the
     re-quantise at the end rebuilds its own. */
  const t = node.getTranslation();
  const s = node.getScale();
  const positions = new Float32Array(count * 3);
  const el = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    pos.getElement(i, el);
    positions[i * 3] = el[0] * s[0] + t[0];
    positions[i * 3 + 1] = el[1] * s[1] + t[1];
    positions[i * 3 + 2] = el[2] * s[2] + t[2];
  }
  const normals = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    nrm.getElement(i, el);
    normals.set(el, i * 3);
  }

  /* the painter works in the site's normalised frame, so its offsets come
     back scaled — undo that to land in model units */
  const box = new THREE.Box3();
  const p = new THREE.Vector3();
  for (let i = 0; i < count; i++) box.expandByPoint(p.fromArray(positions, i * 3));
  const scale = HEAD_HEIGHT / box.getSize(new THREE.Vector3()).y;

  const deltas = new Float32Array(count * 3);
  for (const [i, dx, dy, dz] of bake.deltas) {
    deltas[i * 3] = dx / scale;
    deltas[i * 3 + 1] = dy / scale;
    deltas[i * 3 + 2] = dz / scale;
  }

  /* normals for the closed pose, so the lid shades correctly mid-blink */
  const closed = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) closed[i] = positions[i] + deltas[i];
  const closedNrm = new Float32Array(count * 3);
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f] * 3, b = idx[f + 1] * 3, c = idx[f + 2] * 3;
    const ux = closed[b] - closed[a], uy = closed[b + 1] - closed[a + 1], uz = closed[b + 2] - closed[a + 2];
    const vx = closed[c] - closed[a], vy = closed[c + 1] - closed[a + 1], vz = closed[c + 2] - closed[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) {
      closedNrm[o] += nx;
      closedNrm[o + 1] += ny;
      closedNrm[o + 2] += nz;
    }
  }
  const nrmDeltas = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const len = Math.hypot(closedNrm[i * 3], closedNrm[i * 3 + 1], closedNrm[i * 3 + 2]) || 1;
    nrmDeltas[i * 3] = closedNrm[i * 3] / len - normals[i * 3];
    nrmDeltas[i * 3 + 1] = closedNrm[i * 3 + 1] / len - normals[i * 3 + 1];
    nrmDeltas[i * 3 + 2] = closedNrm[i * 3 + 2] / len - normals[i * 3 + 2];
  }

  /* masks: eye in green, lashes in blue, feathered a few rings so the glow
     has a soft edge rather than a polygonal one */
  const eyeMask = new Float32Array(count);
  const lashMask = new Float32Array(count);
  for (const [i, label] of bake.labels) {
    if (label === 1) eyeMask[i] = 1;
    if (label === 4) lashMask[i] = 1;
  }
  const neighbours = buildAdjacency(idx, count);
  feather(eyeMask, neighbours, count, FEATHER_RINGS);

  const colours = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    col.getElement(i, el);
    colours[i * 3] = el[0]; // baked AO stays put
    colours[i * 3 + 1] = eyeMask[i];
    colours[i * 3 + 2] = lashMask[i];
  }

  /* write everything back */
  const buffer = root.listBuffers()[0];
  pos.setArray(positions).setNormalized(false);
  nrm.setArray(normals).setNormalized(false);
  col.setArray(colours).setNormalized(false);
  node.setTranslation([0, 0, 0]).setScale([1, 1, 1]);

  const target = doc.createPrimitiveTarget("blink");
  target.setAttribute(
    "POSITION",
    doc.createAccessor().setType(Accessor.Type.VEC3).setArray(deltas).setBuffer(buffer)
  );
  target.setAttribute(
    "NORMAL",
    doc.createAccessor().setType(Accessor.Type.VEC3).setArray(nrmDeltas).setBuffer(buffer)
  );
  prim.addTarget(target);
  node.getMesh().setWeights([0]).setExtras({ targetNames: ["blink"] });

  await doc.transform(quantize({ quantizePosition: 16, quantizeNormal: 12 }));
  doc
    .createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  await io.write(path, doc);

  const moved = bake.deltas.length;
  const eyeVerts = bake.labels.filter(([, l]) => l === 1).length;
  console.log(
    `${model}: blink morph on ${moved.toLocaleString()} verts, eye mask ${eyeVerts.toLocaleString()} verts ` +
      `(feathered ${FEATHER_RINGS} rings), ${(before / 1e6).toFixed(2)} -> ${(statSync(path).size / 1e6).toFixed(2)} MB`
  );
}

function buildAdjacency(idx, count) {
  const deg = new Uint32Array(count);
  for (let i = 0; i < idx.length; i += 3) {
    deg[idx[i]] += 2;
    deg[idx[i + 1]] += 2;
    deg[idx[i + 2]] += 2;
  }
  const start = new Uint32Array(count + 1);
  for (let i = 0; i < count; i++) start[i + 1] = start[i] + deg[i];
  const list = new Uint32Array(start[count]);
  const cur = start.slice(0, count);
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    list[cur[a]++] = b; list[cur[a]++] = c;
    list[cur[b]++] = a; list[cur[b]++] = c;
    list[cur[c]++] = a; list[cur[c]++] = b;
  }
  return { start, list };
}

/* spread the mask outward with a decay, so its edge fades instead of
   following triangle boundaries */
function feather(mask, { start, list }, count, rings) {
  for (let ring = 0; ring < rings; ring++) {
    const next = mask.slice();
    const falloff = 1 - (ring + 1) / (rings + 1);
    for (let i = 0; i < count; i++) {
      if (mask[i] > 0) continue;
      let best = 0;
      for (let k = start[i]; k < start[i + 1]; k++) best = Math.max(best, mask[list[k]]);
      if (best > 0) next[i] = Math.min(best, falloff);
    }
    mask.set(next);
  }
}
