import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { initChat } from "./chat.js";
import { initEyeTuner } from "./eye-tuner.js";

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
/* Mobile devices get a lighter everything: a 300k-triangle LOD model, a
   pixel-ratio cap, a 3-octave marble shader and a smaller shadow map. The
   look survives; the frame time doesn't notice the screen is retina. */
const IS_MOBILE = window.matchMedia("(pointer: coarse)").matches;

const MODEL_URL =
  import.meta.env.BASE_URL +
  (DEV_MODEL || (IS_MOBILE ? "simon_mobile.glb" : "simon.glb")) +
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
const MAX_DPR = IS_MOBILE ? 1.5 : 2;
renderer.setPixelRatio(Math.min(MAX_DPR, window.devicePixelRatio || 1));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
/* Cavity shading comes from the baked (raytraced) per-vertex AO; the shadow
   map adds direct-light depth (brow onto eyes, nose onto lip) on top. */
renderer.shadowMap.enabled = true;
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
key.shadow.mapSize.set(IS_MOBILE ? 1024 : 2048, IS_MOBILE ? 1024 : 2048);
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 12;
key.shadow.camera.left = -1.9;
key.shadow.camera.right = 1.9;
key.shadow.camera.top = 1.9;
key.shadow.camera.bottom = -1.9;
key.shadow.bias = -0.0002;
key.shadow.normalBias = 0.03;
key.castShadow = true;
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
  for (int i = 0; i < ${IS_MOBILE ? 3 : 5}; i++) {
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
${
  IS_MOBILE
    ? "  float thin = 0.0; /* mobile: skip the fine vein family (2 fbm chains) */"
    : `  float micro = marbleFbm(q * 5.5 + 11.7);
  float gate = smoothstep(0.32, 0.62, marbleFbm(q * 2.4 + 4.2));
  float thin = pow(1.0 - abs(sin(q.y * 4.6 + q.x * 1.8 + micro * 9.0)), 24.0) * gate;`
}
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
  blinkMeshes: [],
  hasEyeMask: false,
  hasAO: false,
  marbleMaterial: null,
  textured: {}, // slug -> { material, ready, wanted }
  pendingVariant: null,
  currentVariant: "carrara",
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
    Object.assign(shader.uniforms, eyeUniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vTriPos;\nvarying vec3 vObjNormal;\nvarying float vEyeMask;" +
          (hasAO ? "\nvarying float vAO;\nattribute vec3 color;" : "")
      )
      .replace(
        "#include <beginnormal_vertex>",
        "#include <beginnormal_vertex>\nvObjNormal = objectNormal;"
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvTriPos = transformed;" +
          (hasAO ? "\nvAO = color.r;\nvEyeMask = color.g;" : "\nvEyeMask = 0.0;")
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\n" + (hasAO ? "varying float vAO;\n" : "") + EYE_VARYINGS + TRIPLANAR_GLSL
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
      .replace("#include <emissivemap_fragment>", EYE_FRAGMENT_CHUNK)
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
  viewer.currentVariant = name;
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
    clearcoat: IS_MOBILE ? 0.0 : 0.4, // second specular lobe is desktop-only
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
    Object.assign(shader.uniforms, eyeUniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vMarblePos;\nvarying float vEyeMask;" +
          (hasAO ? "\nvarying float vAO;\nattribute vec3 color;" : "")
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvMarblePos = transformed;" +
          (hasAO ? "\nvAO = color.r;\nvEyeMask = color.g;" : "\nvEyeMask = 0.0;")
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\n" + (hasAO ? "varying float vAO;\n" : "") + EYE_VARYINGS + MARBLE_GLSL
      )
      .replace(
        "void main() {",
        "void main() {\n  float marbleVein = 0.0;\n  float marbleCloud = 0.0;"
      )
      .replace("#include <color_fragment>", MARBLE_COLOR_CHUNK)
      .replace("float roughnessFactor = roughness;", MARBLE_ROUGHNESS_CHUNK)
      .replace("#include <emissivemap_fragment>", EYE_FRAGMENT_CHUNK)
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

/* ---------- eyes: light and blink ---------- */

/* The eye area is painted in paint.html and baked into COLOR_0's green
   channel (red still carries the ambient occlusion), so the light fills
   exactly the shape that was painted, feathered at its edge. */
const EYES = {
  colour: "#fecc81",
  intensity: 8, // how brightly the eye itself burns
  socket: 0, // no darkening behind it — the burn alone carries the effect
  lamp: 0.7, // how much light it throws onto the face
  lampRange: 0.35, // short, so the two beams do not meet on the nose bridge
  lampStandoff: 0.01, // sit the lamp just clear of the surface
  lampAngle: 1.4, // beam width: light leaving an eye is a beam, not a bulb
  lampShadows: !IS_MOBILE, // so the beam is blocked by the nose rather than passing through it
};

const eyeUniforms = {
  uEyeColour: { value: new THREE.Color(EYES.colour) },
  uEyeIntensity: { value: EYES.intensity },
  uEyeSocket: { value: EYES.socket },
  uEyeGlow: { value: 1 },
};

/* Hollow the socket first, then burn the light out of it: white marble is
   already near-white at the eyes, so an additive glow alone reads as
   nothing. */
const EYE_FRAGMENT_CHUNK = /* glsl */ `#include <emissivemap_fragment>
{
  float mask = clamp(vEyeMask, 0.0, 1.0);
  diffuseColor.rgb *= mix(1.0, 0.08, mask * uEyeSocket);
  totalEmissiveRadiance += uEyeColour * pow(mask, 1.4) * uEyeIntensity * uEyeGlow;
}`;

const EYE_VARYINGS = /* glsl */ `
varying float vEyeMask;
uniform vec3 uEyeColour;
uniform float uEyeIntensity;
uniform float uEyeSocket;
uniform float uEyeGlow;
`;

/* Lamps inside the sockets. Without them the eyes glow but throw nothing
   onto the nose and brow, which is the difference between a light source
   and a bright patch of paint. */
/* Spot lights, not point lights. A point light radiates in every direction,
   so it lit the inside of the nose and the bridge between the eyes as
   readily as the face — it read as a bulb buried in the skull. A spot aimed
   outward is both closer to what light leaving an eye does and cheap enough
   to cast a real shadow, which is what stops it shining through the nose. */
const eyeLamps = [-1, 1].map((side) => {
  const lamp = new THREE.SpotLight(
    new THREE.Color(EYES.colour), 0, EYES.lampRange, EYES.lampAngle, 0.7, 2
  );
  lamp.visible = false; // until the mask says where the eyes are
  lamp.castShadow = EYES.lampShadows;
  lamp.shadow.mapSize.set(512, 512);
  lamp.shadow.camera.near = 0.02;
  lamp.shadow.camera.far = 2;
  lamp.shadow.bias = -0.0015;
  lamp.shadow.normalBias = 0.02;
  lamp.target.position.set(side * 0.5, 0.2, 2); // out, forward and a little wide
  return lamp;
});

/* push the (possibly tuned) eye settings into the uniforms and lamps */
function applyEyeSettings() {
  eyeUniforms.uEyeColour.value.set(EYES.colour);
  eyeUniforms.uEyeIntensity.value = EYES.intensity;
  eyeUniforms.uEyeSocket.value = EYES.socket;
  for (const lamp of eyeLamps) {
    lamp.color.set(EYES.colour);
    lamp.distance = EYES.lampRange;
    lamp.angle = EYES.lampAngle;
    lamp.castShadow = EYES.lampShadows;
    if (lamp.userData.restZ !== undefined) {
      lamp.position.z = lamp.userData.restZ + EYES.lampStandoff;
    }
  }
}

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
  excite: 0, // chat reaction: momentarily livelier wobble
};

initChat({
  onThinking: () => {
    state.excite = 0.6;
  },
  onReply: () => {
    state.excite = 1.6;
  },
  /* so Simon knows what he's currently rendered as */
  getMaterial: () => viewer.currentVariant,
});

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
        /* Morph deltas are quantised too, and applyMatrix4 leaves them
           alone — convert them by hand, or the blink arrives at the wrong
           size and wraps, exactly as the positions once did. */
        for (const key of ["position", "normal"]) {
          const targets = geometry.morphAttributes[key];
          if (!targets) continue;
          geometry.morphAttributes[key] = targets.map((attr) => {
            const out = new THREE.BufferAttribute(new Float32Array(attr.count * 3), 3);
            for (let i = 0; i < attr.count; i++) out.setXYZ(i, attr.getX(i), attr.getY(i), attr.getZ(i));
            return out;
          });
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
      /* the positions were just scaled, so the blink offsets must be too;
         normal deltas are directions and are left as they are */
      for (const attr of geometry.morphAttributes.position ?? []) {
        const arr = attr.array;
        for (let i = 0; i < arr.length; i++) arr[i] *= scale;
      }
      if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, origMaterial ?? material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      head.add(mesh);
      viewer.meshes.push(mesh);
    }

    state.loaded = true;
    loadingEl.classList.add("done");
    document.body.classList.add("ready");
    /* A lamp in each socket, at the centroid of the painted eye mask,
       nudged forward so its light spills onto the face rather than being
       trapped inside the head. */
    const maskAttr = geometries[0]?.getAttribute("color");
    if (maskAttr) {
      const posAttr = geometries[0].getAttribute("position");
      const sums = [
        { x: 0, y: 0, z: 0, w: 0 },
        { x: 0, y: 0, z: 0, w: 0 },
      ];
      for (let i = 0; i < maskAttr.count; i++) {
        const m = maskAttr.getY(i); // green channel = eye mask
        if (m < 0.5) continue;
        const side = posAttr.getX(i) < 0 ? 0 : 1;
        sums[side].x += posAttr.getX(i) * m;
        sums[side].y += posAttr.getY(i) * m;
        sums[side].z += posAttr.getZ(i) * m;
        sums[side].w += m;
      }
      sums.forEach((sum, i) => {
        if (sum.w <= 0) return;
        /* Out in front of the eye, not level with it: a lamp sunk into the
           surface throws half its light into the closed shell of the head and
           lights the nose bridge from behind, which reads as a source buried
           in the skull rather than light leaving the eyes. */
        eyeLamps[i].userData.restZ = sum.z / sum.w;
        eyeLamps[i].position.set(
          sum.x / sum.w,
          sum.y / sum.w,
          sum.z / sum.w + EYES.lampStandoff
        );
        eyeLamps[i].visible = true;
        head.add(eyeLamps[i]);
        head.add(eyeLamps[i].target); // a spot aims at its target object
        viewer.hasEyeMask = true;
      });
    }
    viewer.blinkMeshes = viewer.meshes.filter((m) => m.morphTargetInfluences?.length);
    initEyeTuner(EYES, applyEyeSettings);

    if (viewer.pendingVariant) selectVariant(viewer.pendingVariant);
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

/* ---------- eyes: blink rhythm and light ---------- */

/* A blink is quick — around a tenth of a second to close, a little longer
   to open — and comes every few seconds, occasionally twice in a row. The
   light dips with the lid rather than shining on through it. */
const blinkState = { next: 2.5, at: -10, amount: 0, double: false };

function updateEyes(now, dt, excite) {
  if (reduced) {
    eyeUniforms.uEyeGlow.value = 1;
    for (const lamp of eyeLamps) lamp.intensity = EYES.lamp;
    return;
  }

  if (now > blinkState.next) {
    blinkState.at = now;
    if (blinkState.double) {
      blinkState.double = false;
      blinkState.next = now + 0.34; // second half of a double blink
    } else {
      blinkState.double = Math.random() < 0.18;
      blinkState.next = now + (blinkState.double ? 0.34 : 2.6 + Math.random() * 4.5);
    }
  }

  const CLOSE = 0.09, OPEN = 0.17;
  const since = now - blinkState.at;
  let amount = 0;
  if (since >= 0 && since < CLOSE) amount = since / CLOSE;
  else if (since < CLOSE + OPEN) amount = 1 - (since - CLOSE) / OPEN;
  amount = amount * amount * (3 - 2 * amount); // ease, so the lid never snaps

  blinkState.amount += (amount - blinkState.amount) * (1 - Math.exp(-40 * dt));
  for (const mesh of viewer.blinkMeshes) mesh.morphTargetInfluences[0] = blinkState.amount;

  /* the glow follows the lid, and flares while he is answering */
  const open = 1 - blinkState.amount * 0.92;
  const flare = 1 + excite * 0.7;
  eyeUniforms.uEyeGlow.value = open * flare * (0.94 + 0.06 * Math.sin(now * 1.7));
  for (const lamp of eyeLamps) lamp.intensity = EYES.lamp * open * flare;
}

/* ---------- render loop ---------- */

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
let last = 0;

/* Adaptive resolution governor: when the smoothed frame time sags, step the
   render resolution down a notch (down to a floor); when there's headroom,
   step back up toward the device cap. Resolution is the knob users notice
   least and GPUs notice most. */
const perf = {
  ema: 16,
  dpr: Math.min(MAX_DPR, window.devicePixelRatio || 1),
  cooldown: 0,
};
function governor(dtMs) {
  perf.ema += (dtMs - perf.ema) * 0.05;
  if (perf.cooldown > 0) {
    perf.cooldown--;
    return;
  }
  if (perf.ema > 24 && perf.dpr > 1.0) {
    perf.dpr = Math.max(1.0, perf.dpr - 0.25);
    renderer.setPixelRatio(perf.dpr);
    layout();
    perf.cooldown = 120; // ~2s before judging again
  } else if (perf.ema < 12.5 && perf.dpr < Math.min(MAX_DPR, window.devicePixelRatio || 1)) {
    perf.dpr = Math.min(MAX_DPR, perf.dpr + 0.25);
    renderer.setPixelRatio(perf.dpr);
    layout();
    perf.cooldown = 300; // climb back cautiously
  }
}

renderer.setAnimationLoop((t) => {
  const rawDt = last ? t - last : 16;
  const dt = last ? Math.min(0.05, rawDt / 1000) : 0.016;
  last = t;
  if (state.loaded) governor(rawDt);

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
       layered on top of wherever the head is looking. Chat activity makes
       him momentarily livelier. */
    s.excite *= Math.exp(-1.1 * dt);
    const amp = 1 + s.excite;
    const w = t / 1000;
    head.rotation.x = s.rotX + (Math.cos(w * 0.61) * 0.038 + Math.sin(w * 1.13) * 0.016) * amp;
    head.rotation.y = s.rotY + (Math.sin(w * 0.47) * 0.045 + Math.cos(w * 0.91) * 0.018) * amp;
    head.rotation.z = Math.sin(w * 0.53) * 0.02 + Math.cos(w * 1.27) * 0.008;
    head.position.y = Math.sin(w * 0.79) * 0.045 + Math.sin(w * 1.41) * 0.015;
    head.position.x = Math.cos(w * 0.67) * 0.018;
  }

  /* entrance offset stacks under the wobble */
  head.position.y += (1 - inE) * -0.9;
  const sc = 0.86 + 0.14 * inE;
  head.scale.setScalar(sc);

  updateEyes(t / 1000, dt, s.excite);

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
