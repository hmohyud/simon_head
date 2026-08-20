/**
 * Opt-in panel for dialling in the eye light: add ?tune=1 to the URL, on
 * localhost or on the deployed site. Values persist in this browser, and
 * COPY hands back a snippet to paste into the EYES defaults in main.js.
 *
 * Nothing here loads without ?tune, so visitors never see it.
 */
const STORE = "simon-eye-light";

const SLIDERS = [
  { key: "intensity", label: "eye burn", min: 0, max: 8, step: 0.1 },
  { key: "socket", label: "socket", min: 0, max: 1, step: 0.02 },
  { key: "lamp", label: "spill", min: 0, max: 3, step: 0.05 },
  { key: "lampRange", label: "spill reach", min: 0.15, max: 2, step: 0.05 },
  { key: "lampStandoff", label: "stand off", min: -0.05, max: 0.3, step: 0.01 },
  { key: "lampAngle", label: "beam width", min: 0.2, max: 1.4, step: 0.05 },
];

const CSS = `
#eyetune { position: fixed; top: 14px; left: 14px; z-index: 20; width: 226px;
  background: rgba(12,14,18,0.92); border: 1px solid rgba(255,255,255,0.14);
  border-radius: 12px; padding: 11px 12px; color: #d9dee7;
  font: 400 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  backdrop-filter: blur(10px); user-select: none; -webkit-user-select: none; }
#eyetune h2 { font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase;
  color: #8b93a1; margin: 0 0 9px; font-weight: 400; }
#eyetune .r { display: grid; grid-template-columns: 62px 1fr 38px; align-items: center;
  gap: 6px; margin: 6px 0; }
#eyetune .r span { color: #8b93a1; }
#eyetune .r b { font-weight: 400; text-align: right; color: #e6ebf3; }
#eyetune input[type=range] { width: 100%; accent-color: #cfd8e6; }
#eyetune .l { display: flex; justify-content: space-between; align-items: center; margin: 7px 0; }
#eyetune button { width: 100%; margin-top: 8px; background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.16); border-radius: 7px; color: #d9dee7;
  font: inherit; padding: 5px; cursor: pointer; letter-spacing: 0.08em; text-transform: uppercase; }
#eyetune button:hover { background: rgba(255,255,255,0.18); }
#eyetune input[type=color] { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.16);
  border-radius: 6px; padding: 2px; }
`;

export function initEyeTuner(settings, apply) {
  if (!new URLSearchParams(location.search).has("tune")) return;

  try {
    Object.assign(settings, JSON.parse(localStorage.getItem(STORE) || "{}"));
  } catch {
    /* unreadable settings: keep the defaults */
  }
  apply();

  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  const panel = document.createElement("div");
  panel.id = "eyetune";
  panel.innerHTML = "<h2>eye light</h2>";
  document.body.appendChild(panel);

  const save = () => {
    try {
      localStorage.setItem(STORE, JSON.stringify(settings));
    } catch {
      /* storage blocked — the tuning still applies for this session */
    }
    apply();
  };

  for (const f of SLIDERS) {
    const row = document.createElement("div");
    row.className = "r";
    const name = document.createElement("span");
    name.textContent = f.label;
    const range = document.createElement("input");
    Object.assign(range, { type: "range", min: f.min, max: f.max, step: f.step, value: settings[f.key] });
    const value = document.createElement("b");
    value.textContent = (+settings[f.key]).toFixed(2);
    range.oninput = () => {
      settings[f.key] = +range.value;
      value.textContent = (+range.value).toFixed(2);
      save();
    };
    row.append(name, range, value);
    panel.appendChild(row);
  }

  const line = document.createElement("div");
  line.className = "l";
  line.innerHTML = "<span>colour</span>";
  const colour = document.createElement("input");
  colour.type = "color";
  colour.value = settings.colour;
  colour.oninput = () => {
    settings.colour = colour.value;
    save();
  };
  line.appendChild(colour);
  panel.appendChild(line);

  const copy = document.createElement("button");
  copy.textContent = "copy values";
  copy.onclick = () => {
    const text = JSON.stringify(settings, null, 2);
    navigator.clipboard?.writeText(text).catch(() => {});
    console.log("EYES =", text);
    copy.textContent = "copied";
    setTimeout(() => (copy.textContent = "copy values"), 1200);
  };
  panel.appendChild(copy);
}
