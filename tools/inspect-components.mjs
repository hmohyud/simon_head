/**
 * Prints connected-component stats for a (welded) GLB so we can tell the head
 * apart from the Meshy backdrop shell and scan streaks. Run on the processed
 * model: node tools/inspect-components.mjs public/simon.glb
 */
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
const doc = await io.read(process.argv[2] ?? "public/simon.glb");
const root = doc.getRoot();

for (const mesh of root.listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute("POSITION");
    const idx = prim.getIndices();
    const vCount = pos.getCount();
    const indices = idx ? idx.getArray() : Uint32Array.from({ length: vCount }, (_, i) => i);

    // union-find over vertices
    const parent = new Uint32Array(vCount).map((_, i) => i);
    const find = (a) => {
      while (parent[a] !== a) {
        parent[a] = parent[parent[a]];
        a = parent[a];
      }
      return a;
    };
    for (let i = 0; i < indices.length; i += 3) {
      const a = find(indices[i]);
      const b = find(indices[i + 1]);
      const c = find(indices[i + 2]);
      parent[b] = a;
      parent[c] = a;
    }

    const compTris = new Map();
    for (let i = 0; i < indices.length; i += 3) {
      const r = find(indices[i]);
      compTris.set(r, (compTris.get(r) ?? 0) + 1);
    }

    // bbox per component (over vertices)
    const boxes = new Map();
    const el = [0, 0, 0];
    for (let v = 0; v < vCount; v++) {
      const r = find(v);
      if (!compTris.has(r)) continue;
      pos.getElement(v, el);
      let b = boxes.get(r);
      if (!b) {
        b = { min: [...el], max: [...el] };
        boxes.set(r, b);
      } else {
        for (let k = 0; k < 3; k++) {
          if (el[k] < b.min[k]) b.min[k] = el[k];
          if (el[k] > b.max[k]) b.max[k] = el[k];
        }
      }
    }

    const comps = [...compTris.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`prim: ${vCount} verts, ${indices.length / 3} tris, ${comps.length} components`);
    for (const [r, tris] of comps.slice(0, 20)) {
      const b = boxes.get(r);
      const size = b.max.map((v, k) => (v - b.min[k]).toFixed(2)).join(" x ");
      const ctr = b.min.map((v, k) => ((v + b.max[k]) / 2).toFixed(2)).join(", ");
      console.log(`  comp ${r}: ${tris} tris, size ${size}, center (${ctr})`);
    }
    if (comps.length > 20) console.log(`  ... and ${comps.length - 20} smaller components`);
  }
}
