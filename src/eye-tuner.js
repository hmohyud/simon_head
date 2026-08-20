/**
 * Opt-in tuning overlay: append ?tune=1 to any build, including the
 * deployed site, so the look can be judged on the real thing instead of
 * guessed at. Two modes:
 *
 *   GLOW  — live sliders for the eye glow. Settings persist in
 *           localStorage, and COPY yields a snippet to paste into the
 *           EYES defaults in main.js.
 *   MARK  — click the sculpture to label anatomy (upper lid, lower lid,
 *           lashes, iris). The scan has no rig, so a believable blink has
 *           to be built from a hand-marked region; this collects those
 *           points in the model's local space and exports them as JSON.
 *
 * Nothing here loads unless ?tune is present.
 */

const STORE_GLOW = "simon-eyes";
const STORE_MARKS = "simon-marks";

const SLIDERS = [
  { key: "x", label: "spread", min: 0.05, max: 0.32, step: 0.005 },
  { key: "y", label: "height", min: 0.15, max: 0.65, step: 0.005 },
  { key: "z", label: "depth", min: 0.3, max: 0.8, step: 0.005 },
  { key: "radius", label: "size", min: 0.01, max: 0.2, step: 0.002 },
  { key: "intensity", label: "intensity", min: 0, max: 10, step: 0.1 },
  { key: "void", label: "socket", min: 0, max: 1, step: 0.02 },
  { key: "halo", label: "halo", min: 0, max: 1, step: 0.02 },
  { key: "haloSize", label: "halo size", min: 0.05, max: 0.9, step: 0.01 },
];

const LABELS = [
  { key: "upperLid", name: "upper lid", color: 0x4fd2ff },
  { key: "lowerLid", name: "lower lid", color: 0x6bff8f },
  { key: "lashes", name: "lashes", color: 0xffd24f },
  { key: "iris", name: "iris", color: 0xff5fa8 },
];

const CSS = `
#tuner {
  position: fixed; top: 12px; left: 12px; z-index: 20; width: 232px;
  background: rgba(12, 14, 18, 0.9); border: 1px solid rgba(255,255,255,0.14);
  border-radius: 12px; padding: 10px 12px 12px; color: #d9dee7;
  font: 400 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  user-select: none; -webkit-user-select: none;
}
#tuner.min > *:not(#tuner-head) { display: none; }
#tuner-head { display: flex; justify-content: space-between; align-items: center;
  letter-spacing: 0.16em; text-transform: uppercase; color: #8b93a1; margin-bottom: 8px; }
#tuner-head button { background: none; border: none; color: #8b93a1; cursor: pointer;
  font: inherit; padding: 0 2px; }
#tuner-head button:hover { color: #fff; }
#tuner-tabs { display: flex; gap: 4px; margin-bottom: 9px; }
#tuner-tabs button { flex: 1; background: rgba(255,255,255,0.05); border: 1px solid transparent;
  border-radius: 6px; color: #98a1b0; font: inherit; padding: 4px 0; cursor: pointer;
  letter-spacing: 0.1em; text-transform: uppercase; }
#tuner-tabs button.on { background: rgba(255,255,255,0.14); color: #fff; border-color: rgba(255,255,255,0.25); }
.tuner-row { display: grid; grid-template-columns: 62px 1fr 40px; align-items: center; gap: 6px; margin: 5px 0; }
.tuner-row span { color: #8b93a1; }
.tuner-row input[type=range] { width: 100%; accent-color: #cfd8e6; }
.tuner-row b { font-weight: 400; color: #e6ebf3; text-align: right; }
.tuner-line { display: flex; align-items: center; justify-content: space-between; margin: 7px 0; gap: 8px; }
.tuner-btns { display: flex; gap: 5px; margin-top: 9px; }
.tuner-btns button { flex: 1; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.16);
  border-radius: 6px; color: #d9dee7; font: inherit; padding: 5px 0; cursor: pointer;
  letter-spacing: 0.08em; text-transform: uppercase; }
.tuner-btns button:hover { background: rgba(255,255,255,0.18); }
.tuner-note { color: #6f7787; margin-top: 8px; line-height: 1.45; }
.tuner-swatch { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 5px; vertical-align: -1px; }
#tuner select, #tuner input[type=color] { background: rgba(255,255,255,0.08); color: #d9dee7;
  border: 1px solid rgba(255,255,255,0.16); border-radius: 6px; font: inherit; padding: 3px; }
`;

export function initEyeTuner(settings, apply, ctx = {}) {
  if (!new URLSearchParams(location.search).has("tune")) return;

  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  const panel = document.createElement("div");
  panel.id = "tuner";
  document.body.appendChild(panel);

  const head = document.createElement("div");
  head.id = "tuner-head";
  head.innerHTML = "<span>eyes</span>";
  const min = document.createElement("button");
  min.textContent = "–";
  min.title = "collapse";
  min.onclick = () => panel.classList.toggle("min");
  head.appendChild(min);
  panel.appendChild(head);

  const tabs = document.createElement("div");
  tabs.id = "tuner-tabs";
  panel.appendChild(tabs);
  const glowPane = document.createElement("div");
  const markPane = document.createElement("div");
  panel.append(glowPane, markPane);

  const showTab = (which) => {
    glowPane.style.display = which === "glow" ? "" : "none";
    markPane.style.display = which === "mark" ? "" : "none";
    for (const b of tabs.children) b.classList.toggle("on", b.dataset.tab === which);
    marking = which === "mark";
    if (ctx.canvas) ctx.canvas.style.cursor = marking ? "crosshair" : "";
  };
  for (const [key, name] of [["glow", "glow"], ["mark", "mark"]]) {
    const b = document.createElement("button");
    b.dataset.tab = key;
    b.textContent = name;
    b.onclick = () => showTab(key);
    tabs.appendChild(b);
  }

  /* ---------- glow pane ---------- */

  const saveGlow = () => {
    try {
      localStorage.setItem(STORE_GLOW, JSON.stringify(settings));
    } catch {
      /* storage blocked — tuning still applies for this session */
    }
    apply();
  };

  for (const f of SLIDERS) {
    const row = document.createElement("div");
    row.className = "tuner-row";
    const value = document.createElement("b");
    value.textContent = (+settings[f.key]).toFixed(3);
    const range = document.createElement("input");
    Object.assign(range, { type: "range", min: f.min, max: f.max, step: f.step, value: settings[f.key] });
    range.oninput = () => {
      settings[f.key] = +range.value;
      value.textContent = (+range.value).toFixed(3);
      saveGlow();
    };
    const name = document.createElement("span");
    name.textContent = f.label;
    row.append(name, range, value);
    glowPane.appendChild(row);
  }

  const colourLine = document.createElement("div");
  colourLine.className = "tuner-line";
  colourLine.innerHTML = "<span>colour</span>";
  const colour = document.createElement("input");
  colour.type = "color";
  colour.value = settings.color;
  colour.oninput = () => {
    settings.color = colour.value;
    saveGlow();
  };
  colourLine.appendChild(colour);
  glowPane.appendChild(colourLine);

  const blinkLine = document.createElement("div");
  blinkLine.className = "tuner-line";
  blinkLine.innerHTML = "<span>blink</span>";
  const blink = document.createElement("input");
  blink.type = "checkbox";
  blink.checked = settings.blink !== false;
  blink.onchange = () => {
    settings.blink = blink.checked;
    saveGlow();
  };
  blinkLine.appendChild(blink);
  glowPane.appendChild(blinkLine);

  const glowBtns = document.createElement("div");
  glowBtns.className = "tuner-btns";
  const copyBtn = document.createElement("button");
  copyBtn.textContent = "copy";
  copyBtn.onclick = () => {
    const snippet = JSON.stringify(settings, null, 2);
    navigator.clipboard?.writeText(snippet).catch(() => {});
    console.log("EYES =", snippet);
    copyBtn.textContent = "copied";
    setTimeout(() => (copyBtn.textContent = "copy"), 1200);
  };
  const resetBtn = document.createElement("button");
  resetBtn.textContent = "reset";
  resetBtn.onclick = () => {
    try {
      localStorage.removeItem(STORE_GLOW);
    } catch {
      /* nothing to clear */
    }
    location.reload();
  };
  glowBtns.append(copyBtn, resetBtn);
  glowPane.appendChild(glowBtns);

  /* ---------- mark pane ---------- */

  let marking = false;
  let marks = [];
  try {
    marks = JSON.parse(localStorage.getItem(STORE_MARKS) || "[]");
  } catch {
    marks = [];
  }

  const pickLine = document.createElement("div");
  pickLine.className = "tuner-line";
  pickLine.innerHTML = "<span>part</span>";
  const picker = document.createElement("select");
  for (const l of LABELS) {
    const o = document.createElement("option");
    o.value = l.key;
    o.textContent = l.name;
    picker.appendChild(o);
  }
  pickLine.appendChild(picker);
  markPane.appendChild(pickLine);

  const brushRow = document.createElement("div");
  brushRow.className = "tuner-row";
  const brushVal = document.createElement("b");
  brushVal.textContent = "0.030";
  const brush = document.createElement("input");
  Object.assign(brush, { type: "range", min: 0.005, max: 0.12, step: 0.005, value: 0.03 });
  brush.oninput = () => (brushVal.textContent = (+brush.value).toFixed(3));
  const brushName = document.createElement("span");
  brushName.textContent = "brush";
  brushRow.append(brushName, brush, brushVal);
  markPane.appendChild(brushRow);

  const freezeLine = document.createElement("div");
  freezeLine.className = "tuner-line";
  freezeLine.innerHTML = "<span>hold still</span>";
  const freeze = document.createElement("input");
  freeze.type = "checkbox";
  freeze.checked = true;
  freeze.onchange = () => applyFreeze();
  freezeLine.appendChild(freeze);
  markPane.appendChild(freezeLine);

  const applyFreeze = () => {
    if (!ctx.state) return;
    ctx.state.freeze = marking && freeze.checked;
    if (ctx.state.freeze) {
      ctx.state.fx = 0;
      ctx.state.fy = 0;
      ctx.state.py = 0;
    }
  };

  const tally = document.createElement("div");
  tally.className = "tuner-note";
  markPane.appendChild(tally);

  const markBtns = document.createElement("div");
  markBtns.className = "tuner-btns";
  const undoBtn = document.createElement("button");
  undoBtn.textContent = "undo";
  const clearBtn = document.createElement("button");
  clearBtn.textContent = "clear";
  const exportBtn = document.createElement("button");
  exportBtn.textContent = "export";
  markBtns.append(undoBtn, clearBtn, exportBtn);
  markPane.appendChild(markBtns);

  const note = document.createElement("div");
  note.className = "tuner-note";
  note.textContent = "click the face to tag points. mark the upper lid first — that is the part a blink has to move.";
  markPane.appendChild(note);

  /* dots showing what has been marked, parented to the head so they ride
     along with it */
  const { THREE, headGroup, viewer, camera, canvas } = ctx;
  const dots = THREE ? new THREE.Group() : null;
  if (dots && headGroup) headGroup.add(dots);

  const colourOf = (key) => LABELS.find((l) => l.key === key)?.color ?? 0xffffff;

  const drawMarks = () => {
    if (!dots) return;
    for (const child of [...dots.children]) {
      child.geometry.dispose();
      child.material.dispose();
      dots.remove(child);
    }
    for (const m of marks) {
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(m.r, 10, 8),
        new THREE.MeshBasicMaterial({ color: colourOf(m.label), transparent: true, opacity: 0.55 })
      );
      dot.position.set(m.x, m.y, m.z);
      dots.add(dot);
    }
    const counts = LABELS.map((l) => {
      const n = marks.filter((m) => m.label === l.key).length;
      return n
        ? `<span class="tuner-swatch" style="background:#${l.color.toString(16).padStart(6, "0")}"></span>${l.name} ${n}`
        : "";
    }).filter(Boolean);
    tally.innerHTML = counts.length ? counts.join("<br>") : "no points yet";
  };

  const saveMarks = () => {
    try {
      localStorage.setItem(STORE_MARKS, JSON.stringify(marks));
    } catch {
      /* storage blocked — marks live for this session only */
    }
    drawMarks();
  };

  undoBtn.onclick = () => {
    marks.pop();
    saveMarks();
  };
  clearBtn.onclick = () => {
    marks = [];
    saveMarks();
  };
  exportBtn.onclick = () => {
    const json = JSON.stringify(marks, null, 1);
    navigator.clipboard?.writeText(json).catch(() => {});
    console.log("MARKS =", json);
    exportBtn.textContent = "copied";
    setTimeout(() => (exportBtn.textContent = "export"), 1200);
  };

  /* Capture-phase so a marking click never also starts a drag-spin. The
     raycast walks the full mesh (no BVH on the client), which costs tens of
     milliseconds — fine for a click, too slow for a hover. */
  if (canvas && THREE && camera && viewer) {
    const ray = new THREE.Raycaster();
    canvas.addEventListener(
      "pointerdown",
      (e) => {
        if (!marking) return;
        e.stopPropagation();
        const rect = canvas.getBoundingClientRect();
        ray.setFromCamera(
          new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -(((e.clientY - rect.top) / rect.height) * 2 - 1)
          ),
          camera
        );
        const hit = ray.intersectObjects(viewer.meshes, false)[0];
        if (!hit) return;
        const local = headGroup.worldToLocal(hit.point.clone());
        marks.push({
          label: picker.value,
          x: +local.x.toFixed(4),
          y: +local.y.toFixed(4),
          z: +local.z.toFixed(4),
          r: +brush.value,
        });
        saveMarks();
      },
      true
    );
  }

  drawMarks();
  showTab("glow");
}
