/**
 * Converts an extracted 3MF object model (XML) into a bare GLB so the rest
 * of the tooling (histogram, component inspection, process pipeline) can
 * work with it. Streams the XML line-wise — the file is ~150MB.
 *
 * 3MF is Z-up millimetres; glTF is Y-up: (x, y, z) -> (x, z, -y).
 *
 * Usage: node tools/from-3mf.mjs <object.model.xml> <out.glb>
 */
import { Accessor, Document, NodeIO } from "@gltf-transform/core";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const input = process.argv[2];
const output = process.argv[3];
if (!input || !output) {
  console.error("usage: node tools/from-3mf.mjs <object.model.xml> <out.glb>");
  process.exit(1);
}

const px = [], py = [], pz = [];
const idx = [];

const num = (line, attr) => {
  const k = line.indexOf(attr + '="');
  if (k < 0) return NaN;
  const s = k + attr.length + 2;
  return parseFloat(line.slice(s, line.indexOf('"', s)));
};

const rl = createInterface({ input: createReadStream(input, { encoding: "utf8" }) });
for await (const line of rl) {
  if (line.includes("<vertex ")) {
    // Z-up mm -> Y-up: (x, z, -y)
    px.push(num(line, "x"));
    py.push(num(line, "z"));
    pz.push(-num(line, "y"));
  } else if (line.includes("<triangle ")) {
    idx.push(num(line, "v1"), num(line, "v2"), num(line, "v3"));
  }
}

console.log(`parsed: ${px.length.toLocaleString()} verts, ${(idx.length / 3).toLocaleString()} tris`);

const positions = new Float32Array(px.length * 3);
for (let i = 0; i < px.length; i++) {
  positions[i * 3] = px[i];
  positions[i * 3 + 1] = py[i];
  positions[i * 3 + 2] = pz[i];
}
const indices = Uint32Array.from(idx);

const doc = new Document();
const buffer = doc.createBuffer();
const prim = doc
  .createPrimitive()
  .setAttribute(
    "POSITION",
    doc.createAccessor().setType(Accessor.Type.VEC3).setArray(positions).setBuffer(buffer)
  )
  .setIndices(doc.createAccessor().setType(Accessor.Type.SCALAR).setArray(indices).setBuffer(buffer));
const mesh = doc.createMesh("mesh").addPrimitive(prim);
const node = doc.createNode("mesh_node").setMesh(mesh);
doc.createScene("scene").addChild(node);

await new NodeIO().write(output, doc);
console.log(`wrote ${output}`);
