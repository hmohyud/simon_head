/**
 * Writes a rigging-friendly copy of the bust: no meshopt compression, no
 * quantisation, no vertex colours, decimated to a poly count auto-riggers
 * accept. The shipped models are compressed and quantised for the web,
 * which most rigging tools refuse to open.
 *
 * Usage: node tools/export-rig.mjs [targetTris]   (default 120000)
 */
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, prune, simplify, weld } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptSimplifier } from "meshoptimizer";
import { mkdirSync, statSync } from "node:fs";

const TARGET = parseInt(process.argv[2] ?? "120000", 10);
await MeshoptDecoder.ready;
await MeshoptSimplifier.ready;

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder });

const doc = await io.read("public/simon.glb");
const root = doc.getRoot();
const prim = root.listMeshes()[0].listPrimitives()[0];
const tris = prim.getIndices().getCount() / 3;

/* bake the dequantisation transform into the vertices so the mesh stands
   alone at true scale, then drop the node transform */
for (const scene of root.listScenes()) {
  for (const node of scene.listChildren()) {
    if (!node.getMesh()) continue;
    const [tx, ty, tz] = node.getTranslation();
    const [sx, sy, sz] = node.getScale();
    const pos = node.getMesh().listPrimitives()[0].getAttribute("POSITION");
    const el = [0, 0, 0];
    const out = new Float32Array(pos.getCount() * 3);
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, el);
      out[i * 3] = el[0] * sx + tx;
      out[i * 3 + 1] = el[1] * sy + ty;
      out[i * 3 + 2] = el[2] * sz + tz;
    }
    pos.setArray(out).setNormalized(false);
    node.setTranslation([0, 0, 0]).setScale([1, 1, 1]);
  }
}

/* vertex colours carry the baked AO — meaningless to a rigger, and they
   confuse some importers */
prim.setAttribute("COLOR_0", null);
doc.getRoot().listExtensionsUsed().forEach((ext) => ext.dispose());

await doc.transform(dedup(), weld(), prune());
if (tris > TARGET) {
  await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: TARGET / tris, error: 0.001 }));
}

mkdirSync("exports", { recursive: true });
const finalPrim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
await io.write("exports/simon_rig.glb", doc);
console.log(
  `exports/simon_rig.glb — ${(finalPrim.getIndices().getCount() / 3).toLocaleString()} tris, ` +
    `${(statSync("exports/simon_rig.glb").size / 1e6).toFixed(1)} MB, uncompressed`
);
