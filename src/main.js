import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

/**
 * A floating marble head, alone in a dark gallery.
 *
 * The model ships as bare geometry (tools/process-model.mjs strips the Meshy
 * textures); the marble is entirely procedural — object-space fbm noise
 * carves Carrara-style veins into a MeshPhysicalMaterial via onBeforeCompile,
 * so it survives any lighting change and costs no texture memory.
 *
 * Behaviour follows the older point-cloud portrait this replaces: the head
 * watches the cursor, eases back to facing forward when left alone, wobbles
 * on incommensurate sines so the idle never visibly loops, and can be
 * grabbed and spun — releasing it lets it swing back home.
 */

/* Dev A/B hook: ?m=original.glb loads the raw Meshy export with its own
   materials untouched, to compare against what external viewers show. */
const DEV_MODEL = import.meta.env.DEV ? new URLSearchParams(location.search).get("m") : null;
const MODEL_URL =
  import.meta.env.BASE_URL +
  (DEV_MODEL || "simon.glb") +
  (import.meta.env.DEV ? `?v=${Date.now()}` : "");
const HEAD_HEIGHT = 2.3; // world units the head is normalised to
const CAMERA_FOV = 38;

/* How far the head turns to follow the cursor, in radians at screen edge. */
const GAZE_X = 0.32; // pitch (up/down)
const GAZE_Y = 0.55; // yaw (left/right)
const RETURN = 0.9; // how firmly a released spin eases back to forward

const canvas = document.getElementById("stage");
const loadingEl = document.getElementById("loading");
const loadLabel = document.getElementById("load-label");
const loadBarFill = document.querySelector("#load-bar i");

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
/* Cavity shading comes from the baked (raytraced) per-vertex AO; the shadow
   map is an optional extra depth pass, toggleable because it re-renders the
   whole sculpture per frame — on by default only where GPUs can afford it. */
renderer.shadowMap.enabled = false;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 100);

/* Soft studio reflections for the polish; the directionals shape the form. */
/* Synthetic room immediately (so the first frames aren't black), then swap
   in the real studio HDRI — photographed softboxes over an infinity cove —
   the moment it arrives. Reflections of real lights are most of what makes
   polished marble read as photographed rather than rendered. */
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
pmrem.dispose();
scene.environmentIntensity = 0.85;

new RGBELoader().load(import.meta.env.BASE_URL + "studio_small_08_2k.hdr", (tex) => {
  tex.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = tex;
  scene.environmentIntensity = 1.0;
  /* aim the big softbox so its highlight sheet sits on the brow/cheek */
  scene.environmentRotation.set(0, -0.6, 0);
});

/* Classic sculpture lighting (no shadow casters — AO carries the cavities):
   a dim warm key from the front, and TWO rims from behind — one warm, one
   cool — so both silhouette edges catch light against the dark page. */
const key = new THREE.DirectionalLight(0xfff4e6, 1.1);
key.position.set(1.8, 2.2, 3.2);
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 12;
key.shadow.camera.left = -1.9;
key.shadow.camera.right = 1.9;
key.shadow.camera.top = 1.9;
key.shadow.camera.bottom = -1.9;
key.shadow.bias = -0.0002;
key.shadow.normalBias = 0.03;
scene.add(key);

function setShadows(on) {
  renderer.shadowMap.enabled = on;
  key.castShadow = on;
  for (const mesh of viewer.meshes) {
    mesh.castShadow = on;
    mesh.receiveShadow = on;
  }
  /* toggling the shadow pipeline requires shader recompiles */
  const mats = [viewer.marbleMaterial, ...Object.values(viewer.textured).map((e) => e.material)];
  for (const m of mats) if (m) m.needsUpdate = true;
  viewer.shadowsOn = on;
  const btn = document.getElementById("shadow-toggle");
  if (btn) btn.classList.toggle("on", on);
}
document.getElementById("shadow-toggle").addEventListener("click", () => {
  setShadows(!viewer.shadowsOn);
});

const rimWarm = new THREE.DirectionalLight(0xffd9b0, 2.4);
rimWarm.position.set(-3.2, 1.2, -2.2);
scene.add(rimWarm);

const rimCool = new THREE.DirectionalLight(0xa8c8ff, 2.8);
rimCool.position.set(3.0, 1.8, -2.6);
scene.add(rimCool);

/* faint warm bounce from below, standing in for light returned by a floor */
const bounce = new THREE.HemisphereLight(0x1c1e24, 0x3a2f22, 0.5);
scene.add(bounce);

/* ---------- procedural marble ---------- */

const MARBLE_GLSL = /* glsl */ `
varying vec3 vMarblePos;
uniform vec3 uMarbleBase;
uniform vec3 uMarbleGrey;
uniform vec3 uMarbleVein;
uniform float uVeinGain;

float marbleHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float marbleNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(marbleHash(i), marbleHash(i + vec3(1, 0, 0)), f.x),
        mix(marbleHash(i + vec3(0, 1, 0)), marbleHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(marbleHash(i + vec3(0, 0, 1)), marbleHash(i + vec3(1, 0, 1)), f.x),
        mix(marbleHash(i + vec3(0, 1, 1)), marbleHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float marbleFbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * marbleNoise(p);
    p = p * 2.02 + vec3(13.7);
    a *= 0.5;
  }
  return v;
}
`;

/* Veins are carved in OBJECT space (the model is baked to world scale at
   load), so the pattern is glued to the stone and never swims as the head
   turns. Classic marble formula: sine bands warped hard by turbulence, then
   sharpened; a second, thinner, more broken family crosses the first. */
const MARBLE_COLOR_CHUNK = /* glsl */ `
#include <color_fragment>
{
  vec3 q = vMarblePos;
  float turb = marbleFbm(q * 1.6);
  float band = sin(q.x * 1.1 + q.y * 2.2 + q.z * 0.7 + turb * 7.0);
  marbleVein = pow(1.0 - abs(band), 6.0);
  float micro = marbleFbm(q * 5.5 + 11.7);
  float gate = smoothstep(0.32, 0.62, marbleFbm(q * 2.4 + 4.2));
  float thin = pow(1.0 - abs(sin(q.y * 4.6 + q.x * 1.8 + micro * 9.0)), 24.0) * gate;
  marbleCloud = marbleFbm(q * 1.2 + 7.0);

  /* two deliberate accent seams, placed to cross the face: one diagonal
     over the brow and cheek, one along the jaw toward the chin — warped
     planes, so they wander like real mineral seams */
  float acc1 = dot(q, vec3(0.752, 0.621, 0.220)) - 0.357 + (marbleFbm(q * 2.2 + 3.1) - 0.5) * 0.5;
  float acc2 = dot(q, vec3(0.745, -0.585, 0.319)) - 0.274 + (marbleFbm(q * 2.0 + 9.4) - 0.5) * 0.5;
  float accent =
    pow(max(0.0, 1.0 - abs(acc1) * 14.0), 3.0) * 0.8 +
    pow(max(0.0, 1.0 - abs(acc2) * 16.0), 3.0) * 0.65;
  marbleVein = clamp(marbleVein + accent, 0.0, 1.0);

  /* stone palette comes from uniforms so marble variants can be switched
     live; albedos top out ~0.9 — pure white clips under ACES */
  vec3 marble = mix(uMarbleBase, uMarbleGrey, marbleCloud * 0.45);
  marble = mix(
    marble,
    uMarbleVein,
    clamp((marbleVein * 0.85 + thin * 0.55) * uVeinGain, 0.0, 1.0)
  );
  /* any glimpse of the hollow interior reads as shadowed stone */
  if (!gl_FrontFacing) marble *= 0.35;
  diffuseColor.rgb *= marble;
}
`;

/* Veined stone is slightly rougher where the mineral runs — the polish
   breaks up over the veins, which is most of what makes it read as stone
   rather than painted plastic. */
const MARBLE_ROUGHNESS_CHUNK = /* glsl */ `
float roughnessFactor = clamp(roughness + marbleVein * 0.22 + marbleCloud * 0.08, 0.05, 1.0);
`;

/* View-dependent rim halo: the silhouette-per-millisecond trick for a pale
   object on a dark page — a cool fresnel lift added after lighting. */
const MARBLE_RIM_CHUNK = /* glsl */ `
{
  float rimF = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 3.0);
  outgoingLight += vec3(0.62, 0.72, 0.88) * rimF * 0.22;
}
#include <opaque_fragment>
`;

/* Baked per-vertex AO (COLOR_0 from tools/process-model.mjs) stands in for
   the aoMap: full strength on ambient/env light, squared falloff on env
   reflections so crevices don't mirror the room. */
const MARBLE_AO_CHUNK = /* glsl */ `
{
  float marbleAO = pow(clamp(vAO, 0.0, 1.0), 1.4);
  reflectedLight.indirectDiffuse *= marbleAO;
  reflectedLight.indirectSpecular *= mix(0.15, 1.0, marbleAO * marbleAO);
  #ifdef USE_CLEARCOAT
    clearcoatSpecularIndirect *= marbleAO;
  #endif
}
`;

/* Shape-first iteration switch: plain neutral stone-grey while the geometry
   is being dialled in; true renders the procedural marble. */
const USE_MARBLE = true;

/* Procedural stone palette — the signature Carrara marble. */
const MARBLES = {
  carrara: { base: [0.9, 0.888, 0.868], grey: [0.71, 0.73, 0.752], vein: [0.4, 0.445, 0.505], gain: 1.0 },
};

/* Texture-based variants (A23D 2K JPG sets in public/textures/<slug>/,
   triplanar-projected — the mesh has no UVs). scale = tiles per world unit;
   the bust is ~2.3 units tall. */
const TEXTURE_VARIANTS = {
  tiles: { scale: 0.55, metalness: 0.0, clearcoat: 0.35, relief: 0.6 },
  metal: { scale: 0.6, metalness: 1.0, clearcoat: 0.0, relief: 0.7 },
  stucco: { scale: 0.8, metalness: 0.0, clearcoat: 0.0, relief: 0.8 },
};

/* The museum rig (dim key, two loud coloured rims, fresnel glow) is a
   white-marble costume — mid-tone textured materials under it look oddly
   edge-lit. Each variant type gets its own light profile, eased to. */
const LIGHT_PROFILES = {
  marble: { key: 1.1, rimWarm: 2.4, rimCool: 2.8, env: 1.0, bounce: 0.5 },
  textured: { key: 2.1, rimWarm: 0.9, rimCool: 1.1, env: 1.15, bounce: 0.7 },
};
const lightTarget = { ...LIGHT_PROFILES.marble };

/* current selection + live uniform handles (set when the shader compiles);
   the render loop eases the palette toward the target so switches pour in
   rather than snapping */
const marbleState = {
  current: "carrara",
  uniforms: null,
  target: {
    base: new THREE.Color(...MARBLES.carrara.base),
    grey: new THREE.Color(...MARBLES.carrara.grey),
    vein: new THREE.Color(...MARBLES.carrara.vein),
    gain: MARBLES.carrara.gain,
  },
};

function setMarble(name) {
  const m = MARBLES[name];
  if (!m) return;
  marbleState.current = name;
  marbleState.target.base.setRGB(...m.base);
  marbleState.target.grey.setRGB(...m.grey);
  marbleState.target.vein.setRGB(...m.vein);
  marbleState.target.gain = m.gain;
}

/* ---------- variant switching (procedural marbles + textured) ---------- */

const viewer = {
  meshes: [],
  hasAO: false,
  marbleMaterial: null,
  textured: {}, // slug -> { material, ready, wanted }
  pendingVariant: null,
};

const TRIPLANAR_GLSL = /* glsl */ `
varying vec3 vTriPos;
varying vec3 vObjNormal;
uniform sampler2D uTexAlbedo;
uniform sampler2D uTexRough;
uniform sampler2D uTexNormal;
uniform float uTexScale;
uniform float uRelief;
uniform mat3 normalMatrix;

vec3 triWeights() {
  vec3 w = pow(abs(normalize(vObjNormal)), vec3(4.0));
  return w / (w.x + w.y + w.z);
}
vec3 triSample(sampler2D map, vec3 w) {
  vec3 p = vTriPos * uTexScale;
  return texture2D(map, p.zy).rgb * w.x +
         texture2D(map, p.xz).rgb * w.y +
         texture2D(map, p.xy).rgb * w.z;
}
`;

function makeTexturedMaterial(slug, cfg, hasAO, onReady) {
  const dir = import.meta.env.BASE_URL + "textures/" + slug + "/";
  const manager = new THREE.LoadingManager(onReady);
  const loader = new THREE.TextureLoader(manager);
  const tex = (file, srgb) => {
    const t = loader.load(dir + file);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const albedo = tex("albedo.jpg", true);
  const rough = tex("roughness.jpg", false);
  const normalMap = tex("normal.jpg", false);

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 1.0, // acts as a multiplier on the roughness map
    metalness: cfg.metalness,
    clearcoat: cfg.clearcoat,
    clearcoatRoughness: 0.15,
    envMapIntensity: 1.0,
    side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTexAlbedo = { value: albedo };
    shader.uniforms.uTexRough = { value: rough };
    shader.uniforms.uTexNormal = { value: normalMap };
    shader.uniforms.uTexScale = { value: cfg.scale };
    shader.uniforms.uRelief = { value: cfg.relief };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vTriPos;\nvarying vec3 vObjNormal;" +
          (hasAO ? "\nvarying float vAO;\nattribute vec3 color;" : "")
      )
      .replace(
        "#include <beginnormal_vertex>",
        "#include <beginnormal_vertex>\nvObjNormal = objectNormal;"
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvTriPos = transformed;" + (hasAO ? "\nvAO = color.r;" : "")
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\n" + (hasAO ? "varying float vAO;\n" : "") + TRIPLANAR_GLSL
      )
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
{
  vec3 twc = triWeights();
  vec3 alb = triSample(uTexAlbedo, twc);
  if (!gl_FrontFacing) alb *= 0.35;
  diffuseColor.rgb *= alb;
}`
      )
      .replace(
        "float roughnessFactor = roughness;",
        /* glsl */ `float roughnessFactor = clamp(triSample(uTexRough, triWeights()).r * roughness, 0.04, 1.0);`
      )
      .replace(
        "#include <normal_fragment_maps>",
        /* glsl */ `{
  vec3 gn = normalize(vObjNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  vec3 twn = pow(abs(gn), vec3(4.0));
  twn /= (twn.x + twn.y + twn.z);
  vec3 tpn = vTriPos * uTexScale;
  vec3 tnx = texture2D(uTexNormal, tpn.zy).xyz * 2.0 - 1.0;
  vec3 tny = texture2D(uTexNormal, tpn.xz).xyz * 2.0 - 1.0;
  vec3 tnz = texture2D(uTexNormal, tpn.xy).xyz * 2.0 - 1.0;
  /* whiteout blend (Golus): keep each plane's tangent detail, swizzle into
     object space, weight by facing */
  tnx = vec3(tnx.xy + gn.zy, abs(tnx.z) * gn.x);
  tny = vec3(tny.xy + gn.xz, abs(tny.z) * gn.y);
  tnz = vec3(tnz.xy + gn.xy, abs(tnz.z) * gn.z);
  vec3 objN = normalize(tnx.zyx * twn.x + tny.xzy * twn.y + tnz.xyz * twn.z);
  objN = normalize(mix(gn, objN, uRelief));
  normal = normalize(normalMatrix * objN);
}`
      );
    if (hasAO) {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <aomap_fragment>",
        MARBLE_AO_CHUNK
      );
    }
  };
  return material;
}

function applyMaterial(material) {
  for (const mesh of viewer.meshes) mesh.material = material;
}

function selectVariant(name) {
  document.querySelectorAll(".swatch").forEach((b) => {
    b.classList.toggle("active", b.dataset.variant === name);
  });
  Object.assign(lightTarget, LIGHT_PROFILES[MARBLES[name] ? "marble" : "textured"]);
  if (!viewer.meshes.length) {
    viewer.pendingVariant = name;
    if (MARBLES[name]) setMarble(name);
    return;
  }
  if (MARBLES[name]) {
    setMarble(name);
    applyMaterial(viewer.marbleMaterial);
    return;
  }
  const cfg = TEXTURE_VARIANTS[name];
  if (!cfg) return;
  let entry = viewer.textured[name];
  if (!entry) {
    entry = viewer.textured[name] = { material: null, ready: false, wanted: true };
    entry.material = makeTexturedMaterial(name, cfg, viewer.hasAO, () => {
      entry.ready = true;
      if (entry.wanted) applyMaterial(entry.material);
    });
  } else {
    entry.wanted = true;
    if (entry.ready) applyMaterial(entry.material);
  }
  /* deselect interest from other pending texture loads */
  for (const [k, e] of Object.entries(viewer.textured)) if (k !== name) e.wanted = false;
}

document.querySelectorAll(".swatch").forEach((b) => {
  b.addEventListener("click", () => selectVariant(b.dataset.variant));
});

function makeMarbleMaterial(hasAO) {
  if (!USE_MARBLE) {
    return new THREE.MeshStandardMaterial({
      color: 0xc9cdd4,
      roughness: 0.55,
      metalness: 0,
    });
  }
  /* Polished-stone recipe (researched values): tight base lobe with the
     vein/cloud noise breaking the highlight up, a modest clearcoat as the
     "wet polish" second lobe, calcite-correct default ior of 1.5. */
  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, // real albedo lives in the marble shader (~0.9 ivory)
    roughness: 0.14,
    metalness: 0.0,
    clearcoat: 0.4,
    clearcoatRoughness: 0.08,
    envMapIntensity: 1.0,
    /* the scan's few natural holes (nostrils, ears) should show shadowed
       interior stone — not a window through the head; the shader darkens
       back-facing surfaces to sell the cavity */
    side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    const start = MARBLES[marbleState.current];
    shader.uniforms.uMarbleBase = { value: new THREE.Color(...start.base) };
    shader.uniforms.uMarbleGrey = { value: new THREE.Color(...start.grey) };
    shader.uniforms.uMarbleVein = { value: new THREE.Color(...start.vein) };
    shader.uniforms.uVeinGain = { value: start.gain };
    marbleState.uniforms = shader.uniforms;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vMarblePos;" +
          (hasAO ? "\nvarying float vAO;\nattribute vec3 color;" : "")
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvMarblePos = transformed;" + (hasAO ? "\nvAO = color.r;" : "")
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\n" + (hasAO ? "varying float vAO;\n" : "") + MARBLE_GLSL
      )
      .replace(
        "void main() {",
        "void main() {\n  float marbleVein = 0.0;\n  float marbleCloud = 0.0;"
      )
      .replace("#include <color_fragment>", MARBLE_COLOR_CHUNK)
      .replace("float roughnessFactor = roughness;", MARBLE_ROUGHNESS_CHUNK)
      .replace("#include <opaque_fragment>", MARBLE_RIM_CHUNK);
    if (hasAO) {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <aomap_fragment>",
        MARBLE_AO_CHUNK
      );
    }
  };
  return material;
}

/* ---------- head ---------- */

const head = new THREE.Group();
scene.add(head);

const state = {
  targetX: 0,
  targetY: 0,
  rotX: 0,
  rotY: 0,
  spin: 0,
  tilt: 0,
  dragging: false,
  lastX: 0,
  lastY: 0,
  entrance: 0, // 0 → 1 over the reveal
  loaded: false,
};

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
loader.load(
  MODEL_URL,
  (gltf) => {
    /* Bake every node transform into the geometry, then normalise the whole
       thing to a known height centred on the origin. Baking (rather than
       scaling a group) keeps object space == world scale, which the marble
       shader relies on for its vein frequency. */
    gltf.scene.updateMatrixWorld(true);
    /* The shipped model uses quantised (int16-normalised) attributes.
       Transforming those in place would write scaled floats back into
       integer storage, where anything past ±1.0 WRAPS — the crown of the
       head would overflow to the bottom as torn streaks. Convert to float32
       BEFORE any transform. */
    const toFloat = (attr) => {
      const out = new THREE.BufferAttribute(new Float32Array(attr.count * 3), 3);
      for (let i = 0; i < attr.count; i++) out.setXYZ(i, attr.getX(i), attr.getY(i), attr.getZ(i));
      return out;
    };
    const geometries = [];
    gltf.scene.traverse((node) => {
      if (node.isMesh) {
        const geometry = node.geometry.clone();
        geometry.setAttribute("position", toFloat(geometry.getAttribute("position")));
        if (geometry.getAttribute("normal")) {
          geometry.setAttribute("normal", toFloat(geometry.getAttribute("normal")));
        }
        geometry.applyMatrix4(node.matrixWorld);
        geometries.push(geometry);
      }
    });

    const box = new THREE.Box3();
    for (const geometry of geometries) {
      geometry.computeBoundingBox();
      box.union(geometry.boundingBox);
    }
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const scale = HEAD_HEIGHT / size.y;

    viewer.hasAO = geometries.length > 0 && !!geometries[0].getAttribute("color");
    const material = makeMarbleMaterial(viewer.hasAO);
    viewer.marbleMaterial = material;
    /* viewer-parity mode: keep the export's own material */
    let origMaterial = null;
    if (DEV_MODEL) {
      gltf.scene.traverse((node) => {
        if (node.isMesh && !origMaterial) origMaterial = node.material;
      });
    }
    for (const geometry of geometries) {
      geometry.translate(-center.x, -center.y, -center.z);
      geometry.scale(scale, scale, scale);
      if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, origMaterial ?? material);
      head.add(mesh);
      viewer.meshes.push(mesh);
    }

    state.loaded = true;
    loadingEl.classList.add("done");
    document.body.classList.add("ready");
    if (viewer.pendingVariant) selectVariant(viewer.pendingVariant);
    /* shadows on by default where a discrete-GPU-class device is likely */
    if (window.matchMedia("(pointer: fine)").matches) setShadows(true);
    if (import.meta.env.DEV)
      window.__d = { renderer, scene, camera, head, state, material, THREE, fit: { center, scale } };
  },
  (ev) => {
    /* staged loading: the bar tracks the download; the label narrates */
    const p = ev.total ? Math.min(1, ev.loaded / ev.total) : 0;
    loadBarFill.style.width = `${(p * 100).toFixed(1)}%`;
    loadLabel.textContent =
      p >= 1 ? "polishing…" : p > 0.55 ? "carving the details…" : "quarrying the marble…";
  },
  (err) => {
    console.error("model failed to load", err);
    loadLabel.textContent = "the marble failed to arrive";
  }
);

/* ---------- interaction ---------- */

window.addEventListener("pointermove", (e) => {
  if (state.dragging) {
    state.spin += (e.clientX - state.lastX) * 0.006;
    state.tilt += (e.clientY - state.lastY) * 0.003;
    state.tilt = Math.max(-0.5, Math.min(0.5, state.tilt));
    state.lastX = e.clientX;
    state.lastY = e.clientY;
    return;
  }
  const nx = (e.clientX / window.innerWidth) * 2 - 1;
  const ny = (e.clientY / window.innerHeight) * 2 - 1;
  state.targetY = nx * GAZE_Y;
  state.targetX = ny * GAZE_X;
});

canvas.addEventListener("pointerdown", (e) => {
  state.dragging = true;
  state.lastX = e.clientX;
  state.lastY = e.clientY;
  canvas.classList.add("dragging");
  canvas.setPointerCapture(e.pointerId);
});
window.addEventListener("pointerup", () => {
  state.dragging = false;
  canvas.classList.remove("dragging");
});
window.addEventListener("pointerleave", () => {
  state.targetX = 0;
  state.targetY = 0;
});
document.addEventListener("mouseleave", () => {
  state.targetX = 0;
  state.targetY = 0;
});

/* ---------- layout ---------- */

/* Fit box the camera must always contain: the normalised head plus margin
   for the idle bob and wobble, so no window shape ever crops the crown. */
const FIT = { h: HEAD_HEIGHT * 1.16, w: HEAD_HEIGHT * 0.82 };

function layout() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  const t = Math.tan((camera.fov * Math.PI) / 360);
  const zForHeight = FIT.h / 2 / t;
  const zForWidth = FIT.w / 2 / (t * camera.aspect);
  camera.position.set(0, 0, Math.max(zForHeight, zForWidth));
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", layout);
layout();

/* ---------- render loop ---------- */

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
let last = 0;

renderer.setAnimationLoop((t) => {
  const dt = last ? Math.min(0.05, (t - last) / 1000) : 0.016;
  last = t;

  const s = state;

  /* dev hook: freeze all motion so screenshots are deterministic */
  if (s.freeze) {
    head.rotation.set(s.fx || 0, s.fy || 0, 0);
    head.position.set(0, s.py || 0, 0);
    head.scale.setScalar(1);
    head.visible = s.loaded;
    renderer.render(scene, camera);
    return;
  }

  /* entrance: the head rises into the light over ~1.4s once loaded */
  if (s.loaded && s.entrance < 1) {
    s.entrance = Math.min(1, s.entrance + dt / 1.4);
  }
  const inE = easeOutCubic(s.entrance);
  head.visible = s.loaded;

  if (!s.dragging) {
    s.spin += (0 - s.spin) * (1 - Math.exp(-RETURN * dt));
    s.tilt += (0 - s.tilt) * (1 - Math.exp(-RETURN * dt));
  }
  const k = 1 - Math.exp(-6 * dt);
  s.rotY += (s.spin + s.targetY - s.rotY) * k;
  s.rotX += (s.tilt + s.targetX - s.rotX) * k;

  if (reduced) {
    head.rotation.set(s.rotX, s.rotY, 0);
    head.position.set(0, 0, 0);
  } else {
    /* Idle wobble on incommensurate frequencies so it never visibly loops;
       layered on top of wherever the head is looking. */
    const w = t / 1000;
    head.rotation.x = s.rotX + Math.cos(w * 0.61) * 0.038 + Math.sin(w * 1.13) * 0.016;
    head.rotation.y = s.rotY + Math.sin(w * 0.47) * 0.045 + Math.cos(w * 0.91) * 0.018;
    head.rotation.z = Math.sin(w * 0.53) * 0.02 + Math.cos(w * 1.27) * 0.008;
    head.position.y = Math.sin(w * 0.79) * 0.045 + Math.sin(w * 1.41) * 0.015;
    head.position.x = Math.cos(w * 0.67) * 0.018;
  }

  /* entrance offset stacks under the wobble */
  head.position.y += (1 - inE) * -0.9;
  const sc = 0.86 + 0.14 * inE;
  head.scale.setScalar(sc);

  /* ease the marble palette toward the selected stone */
  if (marbleState.uniforms) {
    const mk = 1 - Math.exp(-5 * dt);
    const u = marbleState.uniforms;
    u.uMarbleBase.value.lerp(marbleState.target.base, mk);
    u.uMarbleGrey.value.lerp(marbleState.target.grey, mk);
    u.uMarbleVein.value.lerp(marbleState.target.vein, mk);
    u.uVeinGain.value += (marbleState.target.gain - u.uVeinGain.value) * mk;
  }

  /* ease the lights toward the active variant's profile */
  {
    const lk = 1 - Math.exp(-4 * dt);
    key.intensity += (lightTarget.key - key.intensity) * lk;
    rimWarm.intensity += (lightTarget.rimWarm - rimWarm.intensity) * lk;
    rimCool.intensity += (lightTarget.rimCool - rimCool.intensity) * lk;
    bounce.intensity += (lightTarget.bounce - bounce.intensity) * lk;
    scene.environmentIntensity += (lightTarget.env - scene.environmentIntensity) * lk;
  }

  renderer.render(scene, camera);
});
