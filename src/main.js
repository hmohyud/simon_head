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
/* No shadow maps: cavity shading comes from the baked per-vertex AO, and a
   shadow pass would re-render the 2M-triangle mesh every frame. */

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
scene.add(key);

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

  /* albedo tops out ~0.9 — pure white is non-physical and clips under ACES */
  vec3 base = vec3(0.900, 0.888, 0.868);   /* warm ivory */
  vec3 grey = vec3(0.710, 0.730, 0.752);   /* soft clouding */
  vec3 veinC = vec3(0.400, 0.445, 0.505);  /* slate blue-grey */
  vec3 marble = mix(base, grey, marbleCloud * 0.45);
  marble = mix(marble, veinC, clamp(marbleVein * 0.85 + thin * 0.55, 0.0, 1.0));
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

    const material = makeMarbleMaterial(
      geometries.length > 0 && !!geometries[0].getAttribute("color")
    );
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
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      head.add(mesh);
    }

    state.loaded = true;
    loadingEl.classList.add("done");
    document.body.classList.add("ready");
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

  renderer.render(scene, camera);
});
